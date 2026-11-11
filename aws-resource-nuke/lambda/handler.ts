/**
 * AWS Resource Nuke — Main Lambda Handlers
 *
 * Two handlers, two schedules:
 *
 * 1. scanHandler (Monday)  — Scans all resources, flags stale ones, sends warning report
 * 2. cleanupHandler (Thursday) — Deletes resources whose grace period expired, sends cleanup report
 */
import { scanCloudFormationStacks } from "./scanners/cloudformation-scanner";
import { scanEC2Instances } from "./scanners/ec2-scanner";
import { scanStandaloneResources } from "./scanners/standalone-scanner";
import { trackFlaggedResource, getExpiredFlaggedResources } from "./utils/tracking";
import { deleteResources } from "./utils/resource-deleter";
import { generateScanReport, generateCleanupReport } from "./utils/report-generator";
import { uploadReport } from "./utils/s3-uploader";
import { sendScanNotification, sendCleanupNotification } from "./utils/sns-notifier";
import { loadConfig, ScanCategoryResult } from "./utils/types";

/**
 * SCAN HANDLER — Runs every Monday
 *
 * 1. Scans CloudFormation stacks for feature-branch deployments
 * 2. Scans standalone EC2 instances
 * 3. Scans standalone resources (EBS, EIP, Snapshots, Lambda, S3)
 * 4. Tracks all flagged resources in DynamoDB with grace deadline
 * 5. Generates HTML scan report → uploads to S3
 * 6. Sends warning email via SNS
 */
export const scanHandler = async (): Promise<void> => {
  console.log("=== Resource Nuke — SCAN MODE ===");
  const config = loadConfig();
  console.log(`Target environment: ${config.targetEnvironment}`);
  console.log(`Grace period: ${config.gracePeriodDays} days`);
  console.log(`Protected branches: ${config.protectedBranches.join(", ")}`);
  console.log(`Excluded branches: ${config.excludedBranches.join(", ") || "none"}`);

  const allResults: ScanCategoryResult[] = [];

  // 1. Scan CloudFormation stacks
  try {
    console.log("[1/3] Scanning CloudFormation stacks...");
    const cfResult = await scanCloudFormationStacks(config);
    allResults.push(cfResult);
    console.log(`  Found ${cfResult.items.length} stale stacks`);
  } catch (err) {
    console.error("CloudFormation scan failed:", err);
    allResults.push({ category: "CloudFormation Stacks", items: [], error: String(err) });
  }

  // 2. Scan EC2 instances (not in CloudFormation)
  try {
    console.log("[2/3] Scanning standalone EC2 instances...");
    const ec2Result = await scanEC2Instances(config);
    allResults.push(ec2Result);
    console.log(`  Found ${ec2Result.items.length} stale EC2 instances`);
  } catch (err) {
    console.error("EC2 scan failed:", err);
    allResults.push({ category: "EC2 Instances", items: [], error: String(err) });
  }

  // 3. Scan standalone resources
  try {
    console.log("[3/3] Scanning standalone resources...");
    const standaloneResults = await scanStandaloneResources(config);
    allResults.push(...standaloneResults);
    const standaloneTotal = standaloneResults.reduce((s, r) => s + r.items.length, 0);
    console.log(`  Found ${standaloneTotal} stale standalone resources`);
  } catch (err) {
    console.error("Standalone scan failed:", err);
  }

  // 4. Track all flagged resources in DynamoDB
  const totalFlagged = allResults.reduce((s, r) => s + r.items.length, 0);
  console.log(`\nTotal flagged: ${totalFlagged}`);

  for (const result of allResults) {
    for (const item of result.items) {
      try {
        await trackFlaggedResource(item, config);
      } catch (err) {
        console.error(`Failed to track ${item.resourceId}:`, err);
      }
    }
  }

  // 5. Generate and upload report
  const html = generateScanReport(allResults, config);
  const reportUrl = await uploadReport(html, "scan");
  console.log(`Scan report uploaded: ${reportUrl}`);

  // 6. Send SNS notification
  await sendScanNotification(allResults, config, reportUrl);
  console.log("Scan notification sent");

  console.log("=== Resource Nuke — SCAN COMPLETE ===");
};

/**
 * CLEANUP HANDLER — Runs every Thursday (3 days after Monday scan)
 *
 * 1. Reads DynamoDB for resources whose grace period has expired
 * 2. Re-checks excluded branches (user may have added exclusions)
 * 3. Deletes stale resources (CloudFormation stacks first, then standalone)
 * 4. Generates HTML cleanup report → uploads to S3
 * 5. Sends deletion summary email via SNS
 */
export const cleanupHandler = async (): Promise<void> => {
  console.log("=== Resource Nuke — CLEANUP MODE ===");
  const config = loadConfig();
  console.log(`Target environment: ${config.targetEnvironment}`);
  console.log(`Excluded branches: ${config.excludedBranches.join(", ") || "none"}`);

  // 1. Get resources whose grace period has expired
  const expiredResources = await getExpiredFlaggedResources(config);
  console.log(`Found ${expiredResources.length} resources past grace deadline`);

  if (expiredResources.length === 0) {
    console.log("No resources to clean up. Sending all-clear report.");
    const html = generateCleanupReport([], config);
    const reportUrl = await uploadReport(html, "cleanup");
    await sendCleanupNotification([], config, reportUrl);
    console.log("=== Resource Nuke — CLEANUP COMPLETE (nothing to delete) ===");
    return;
  }

  // 2. Delete resources
  console.log("Starting resource deletion...");
  const deletionResults = await deleteResources(expiredResources, config);

  const succeeded = deletionResults.filter((r) => r.success).length;
  const failed = deletionResults.filter((r) => !r.success).length;
  console.log(`\nDeletion complete: ${succeeded} deleted, ${failed} failed`);

  // 3. Generate and upload cleanup report
  const html = generateCleanupReport(deletionResults, config);
  const reportUrl = await uploadReport(html, "cleanup");
  console.log(`Cleanup report uploaded: ${reportUrl}`);

  // 4. Send notification
  await sendCleanupNotification(deletionResults, config, reportUrl);
  console.log("Cleanup notification sent");

  console.log("=== Resource Nuke — CLEANUP COMPLETE ===");
};
