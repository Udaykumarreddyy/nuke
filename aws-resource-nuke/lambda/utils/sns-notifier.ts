/**
 * SNS Notifier — Sends scan and cleanup summary emails
 */
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { ScanCategoryResult, NukeConfig, FlaggedResource } from "./types";
import { DeletionResult } from "./resource-deleter";

const sns = new SNSClient({});

/** Send scan notification (Monday — warning) */
export async function sendScanNotification(
  results: ScanCategoryResult[],
  config: NukeConfig,
  reportUrl: string
): Promise<void> {
  const totalFlagged = results.reduce((s, r) => s + r.items.length, 0);
  const deadline = new Date(Date.now() + config.gracePeriodDays * 24 * 60 * 60 * 1000);
  const deadlineStr = deadline.toISOString().split("T")[0];
  const scanDate = new Date().toISOString().split("T")[0];

  // Group by branch
  const branchMap = new Map<string, FlaggedResource[]>();
  for (const r of results) {
    for (const item of r.items) {
      if (!branchMap.has(item.branchTag)) branchMap.set(item.branchTag, []);
      branchMap.get(item.branchTag)!.push(item);
    }
  }

  const branchBreakdown = Array.from(branchMap.entries())
    .map(([branch, items]) => `  "${branch}" — ${items.length} resource(s)`)
    .join("\n");

  const categoryBreakdown = results
    .map((r) => `  ${r.category}: ${r.items.length === 0 ? "CLEAN" : `${r.items.length} flagged`}`)
    .join("\n");

  const subject = totalFlagged === 0
    ? `[Resource Nuke] ${config.targetEnvironment.toUpperCase()} — All Clean!`
    : `[Resource Nuke] ${config.targetEnvironment.toUpperCase()} — ${totalFlagged} Resources Flagged for Deletion`;

  const message = `
AWS Resource Nuke — Scan Report
======================================
Environment: ${config.targetEnvironment.toUpperCase()}
Scan Date: ${scanDate}
Total Flagged: ${totalFlagged}
Deletion Date: ${deadlineStr} (${config.gracePeriodDays}-day grace period)

Branch Breakdown:
${branchBreakdown || "  No feature branches found!"}

Category Breakdown:
${categoryBreakdown}

HOW TO SAVE A RESOURCE:
  1. Add tag "do-not-nuke = true" to the resource
  2. Ask admin to add the branch to ExcludedBranches parameter
  3. Merge the branch to main/master and redeploy

Full Report: ${reportUrl}

Download & view:
  aws s3 cp ${reportUrl} ./report.html && open report.html
`.trim();

  await sns.send(
    new PublishCommand({
      TopicArn: config.snsTopicArn,
      Subject: subject,
      Message: message,
    })
  );
}

/** Send cleanup notification (Thursday — deletion results) */
export async function sendCleanupNotification(
  deletionResults: DeletionResult[],
  config: NukeConfig,
  reportUrl: string
): Promise<void> {
  const succeeded = deletionResults.filter((r) => r.success).length;
  const failed = deletionResults.filter((r) => !r.success).length;
  const scanDate = new Date().toISOString().split("T")[0];

  const details = deletionResults
    .map((r) => `  ${r.success ? "DELETED" : "FAILED"}: ${r.resourceType} — ${r.name} (branch: ${r.branchTag})${r.error ? ` [Error: ${r.error}]` : ""}`)
    .join("\n");

  const subject = `[Resource Nuke] ${config.targetEnvironment.toUpperCase()} — Cleanup Complete: ${succeeded} deleted, ${failed} failed`;

  const message = `
AWS Resource Nuke — Cleanup Report
======================================
Environment: ${config.targetEnvironment.toUpperCase()}
Cleanup Date: ${scanDate}
Deleted: ${succeeded}
Failed: ${failed}

Details:
${details || "  No resources were due for deletion."}

Full Report: ${reportUrl}

Download & view:
  aws s3 cp ${reportUrl} ./report.html && open report.html
`.trim();

  await sns.send(
    new PublishCommand({
      TopicArn: config.snsTopicArn,
      Subject: subject,
      Message: message,
    })
  );
}
