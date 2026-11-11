/**
 * Standalone Resource Scanner
 *
 * Scans for non-CloudFormation resources that aren't EC2 instances:
 * - EBS Volumes (unattached, feature-branch tagged)
 * - Elastic IPs (unattached, feature-branch tagged)
 * - EBS Snapshots (feature-branch tagged)
 * - Lambda Functions (feature-branch tagged)
 * - S3 Buckets (feature-branch tagged)
 *
 * These are resources created outside CloudFormation or left behind
 * after a stack was partially deleted.
 */
import { EC2Client, DescribeVolumesCommand, DescribeAddressesCommand, DescribeSnapshotsCommand } from "@aws-sdk/client-ec2";
import { LambdaClient, ListFunctionsCommand, ListTagsCommand } from "@aws-sdk/client-lambda";
import { S3Client, ListBucketsCommand, GetBucketTaggingCommand } from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  FlaggedResource,
  ScanCategoryResult,
  NukeConfig,
  isSafeBranch,
  isProtected,
} from "../utils/types";

const ec2 = new EC2Client({});
const lambdaClient = new LambdaClient({});
const s3 = new S3Client({});
const sts = new STSClient({});

const BRANCH_TAG_KEYS = [
  "branch", "Branch", "BRANCH", "git-branch", "git_branch",
  "source-branch", "source_branch", "SourceBranch", "GitBranch",
];

const ENV_TAG_KEYS = [
  "environment", "Environment", "env", "Env", "stage", "Stage",
];

function findTag(tags: Record<string, string>, keys: string[]): string | undefined {
  return keys.map((k) => tags[k]).find((v) => v !== undefined);
}

function buildTagsMap(tagList: Array<{ Key?: string; Value?: string }> | undefined): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const t of tagList || []) {
    if (t.Key && t.Value) tags[t.Key] = t.Value;
  }
  return tags;
}

function shouldFlag(
  tags: Record<string, string>,
  config: NukeConfig
): { flag: boolean; branchTag: string; reason: string } {
  if (isProtected(tags)) return { flag: false, branchTag: "", reason: "" };

  const envTag = findTag(tags, ENV_TAG_KEYS);
  if (envTag && envTag.toLowerCase() !== config.targetEnvironment.toLowerCase()) {
    return { flag: false, branchTag: "", reason: "" };
  }

  // Skip CloudFormation-managed resources
  if (tags["aws:cloudformation:stack-name"]) {
    return { flag: false, branchTag: "", reason: "" };
  }

  const branchTag = findTag(tags, BRANCH_TAG_KEYS);

  if (!branchTag) {
    return { flag: true, branchTag: "NONE", reason: "No branch tag — unknown origin" };
  }
  if (!isSafeBranch(branchTag, config)) {
    return { flag: true, branchTag, reason: `Feature branch: "${branchTag}"` };
  }
  return { flag: false, branchTag: branchTag, reason: "" };
}

// ─── EBS Volumes ─────────────────────────────────────────────
async function scanVolumes(config: NukeConfig): Promise<FlaggedResource[]> {
  const items: FlaggedResource[] = [];
  const result = await ec2.send(new DescribeVolumesCommand({}));

  for (const vol of result.Volumes || []) {
    const tags = buildTagsMap(vol.Tags);
    const { flag, branchTag, reason } = shouldFlag(tags, config);
    if (!flag) continue;

    items.push({
      resourceId: vol.VolumeId!,
      resourceType: "EBS Volume",
      branchTag,
      tags,
      region: process.env.AWS_REGION || "us-east-1",
      reason: `${reason} | ${vol.State === "available" ? "Unattached" : "Attached"}`,
      name: tags["Name"] || "No Name",
      createdAt: vol.CreateTime?.toISOString(),
    });
  }
  return items;
}

// ─── Elastic IPs ─────────────────────────────────────────────
async function scanEIPs(config: NukeConfig): Promise<FlaggedResource[]> {
  const items: FlaggedResource[] = [];
  const result = await ec2.send(new DescribeAddressesCommand({}));

  for (const addr of result.Addresses || []) {
    const tags = buildTagsMap(addr.Tags);
    const { flag, branchTag, reason } = shouldFlag(tags, config);
    if (!flag) continue;

    items.push({
      resourceId: addr.AllocationId || addr.PublicIp || "unknown",
      resourceType: "Elastic IP",
      branchTag,
      tags,
      region: process.env.AWS_REGION || "us-east-1",
      reason: `${reason} | IP: ${addr.PublicIp} | ${addr.AssociationId ? "Attached" : "Unattached"}`,
      name: tags["Name"] || addr.PublicIp || "No Name",
    });
  }
  return items;
}

// ─── Snapshots ───────────────────────────────────────────────
async function scanSnapshots(config: NukeConfig): Promise<FlaggedResource[]> {
  const items: FlaggedResource[] = [];
  const identity = await sts.send(new GetCallerIdentityCommand({}));

  const result = await ec2.send(
    new DescribeSnapshotsCommand({ OwnerIds: [identity.Account!] })
  );

  for (const snap of result.Snapshots || []) {
    const tags = buildTagsMap(snap.Tags);
    const { flag, branchTag, reason } = shouldFlag(tags, config);
    if (!flag) continue;

    items.push({
      resourceId: snap.SnapshotId!,
      resourceType: "EBS Snapshot",
      branchTag,
      tags,
      region: process.env.AWS_REGION || "us-east-1",
      reason: `${reason} | ${snap.VolumeSize}GB`,
      name: tags["Name"] || snap.Description || "No Name",
      createdAt: snap.StartTime?.toISOString(),
    });
  }
  return items;
}

// ─── Lambda Functions ────────────────────────────────────────
async function scanLambdas(config: NukeConfig): Promise<FlaggedResource[]> {
  const items: FlaggedResource[] = [];
  const result = await lambdaClient.send(new ListFunctionsCommand({}));

  for (const fn of result.Functions || []) {
    const fnName = fn.FunctionName!;
    // Skip our own nuke functions
    if (fnName.includes("resource-nuke")) continue;

    try {
      const tagsResult = await lambdaClient.send(
        new ListTagsCommand({ Resource: fn.FunctionArn! })
      );
      const tags = tagsResult.Tags || {};
      const { flag, branchTag, reason } = shouldFlag(tags, config);
      if (!flag) continue;

      items.push({
        resourceId: fn.FunctionArn!,
        resourceType: "Lambda Function",
        branchTag,
        tags,
        region: process.env.AWS_REGION || "us-east-1",
        reason,
        name: fnName,
        createdAt: fn.LastModified,
      });
    } catch {
      // Skip if can't read tags
    }
  }
  return items;
}

// ─── S3 Buckets ──────────────────────────────────────────────
async function scanS3Buckets(config: NukeConfig): Promise<FlaggedResource[]> {
  const items: FlaggedResource[] = [];
  const result = await s3.send(new ListBucketsCommand({}));

  for (const bucket of result.Buckets || []) {
    const bucketName = bucket.Name!;
    // Skip our own report bucket
    if (bucketName.includes("resource-nuke") || bucketName.includes("cost-optimizer")) continue;

    try {
      const tagsResult = await s3.send(
        new GetBucketTaggingCommand({ Bucket: bucketName })
      );
      const tags: Record<string, string> = {};
      for (const t of tagsResult.TagSet || []) {
        if (t.Key && t.Value) tags[t.Key] = t.Value;
      }
      const { flag, branchTag, reason } = shouldFlag(tags, config);
      if (!flag) continue;

      items.push({
        resourceId: bucketName,
        resourceType: "S3 Bucket",
        branchTag,
        tags,
        region: process.env.AWS_REGION || "us-east-1",
        reason,
        name: bucketName,
        createdAt: bucket.CreationDate?.toISOString(),
      });
    } catch {
      // Bucket may have no tags — skip (no tagging = can't determine branch)
    }
  }
  return items;
}

// ─── MAIN: Run all standalone scanners ───────────────────────
export async function scanStandaloneResources(
  config: NukeConfig
): Promise<ScanCategoryResult[]> {
  const results: ScanCategoryResult[] = [];

  const scanners = [
    { name: "EBS Volumes", fn: scanVolumes },
    { name: "Elastic IPs", fn: scanEIPs },
    { name: "EBS Snapshots", fn: scanSnapshots },
    { name: "Lambda Functions", fn: scanLambdas },
    { name: "S3 Buckets", fn: scanS3Buckets },
  ];

  for (const scanner of scanners) {
    try {
      const items = await scanner.fn(config);
      results.push({ category: scanner.name, items });
    } catch (err) {
      console.error(`${scanner.name} scan failed:`, err);
      results.push({ category: scanner.name, items: [], error: String(err) });
    }
  }

  return results;
}
