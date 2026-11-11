/**
 * Shared types for the Resource Nuke tool.
 */

/** A resource flagged during scanning */
export interface FlaggedResource {
  /** AWS Resource ID (e.g., i-0abc123, vol-xyz, arn:aws:...) */
  resourceId: string;

  /** Resource type (EC2, EBS, EIP, CloudFormation, Lambda, S3, RDS, etc.) */
  resourceType: ResourceType;

  /** The branch tag value found on this resource */
  branchTag: string;

  /** All tags on this resource */
  tags: Record<string, string>;

  /** AWS region */
  region: string;

  /** Why it was flagged */
  reason: string;

  /** Resource name (from Name tag or resource identifier) */
  name: string;

  /** When the resource was created (if available) */
  createdAt?: string;

  /** CloudFormation stack name (if part of a stack) */
  stackName?: string;
}

/** Supported resource types for scanning */
export type ResourceType =
  | "CloudFormation Stack"
  | "EC2 Instance"
  | "EBS Volume"
  | "Elastic IP"
  | "EBS Snapshot"
  | "Security Group"
  | "NAT Gateway"
  | "Lambda Function"
  | "S3 Bucket"
  | "RDS Instance"
  | "Load Balancer"
  | "SQS Queue"
  | "SNS Topic";

/** Result from one scanner */
export interface ScanCategoryResult {
  category: string;
  items: FlaggedResource[];
  error?: string;
}

/** DynamoDB tracking record */
export interface TrackingRecord {
  resourceId: string;
  resourceType: string;
  branchTag: string;
  name: string;
  region: string;
  reason: string;
  stackName?: string;
  status: "flagged" | "excluded" | "deleted";
  flaggedAt: string;    // ISO date when first flagged
  graceDeadline: string; // ISO date when grace period expires
  deletedAt?: string;
  ttl: number;          // DynamoDB TTL (auto-delete record after 30 days)
}

/** Configuration loaded from environment variables */
export interface NukeConfig {
  targetEnvironment: string;
  gracePeriodDays: number;
  excludedBranches: string[];    // branches to never delete
  protectedBranches: string[];   // always protected: main, master
  reportBucket: string;
  snsTopicArn: string;
  trackingTable: string;
}

/** Load config from environment */
export function loadConfig(): NukeConfig {
  const excludedRaw = process.env.EXCLUDED_BRANCHES || "";
  const excludedBranches = excludedRaw
    .split(",")
    .map((b) => b.trim().toLowerCase())
    .filter((b) => b.length > 0);

  return {
    targetEnvironment: process.env.TARGET_ENVIRONMENT || "dev",
    gracePeriodDays: parseInt(process.env.GRACE_PERIOD_DAYS || "3", 10),
    excludedBranches,
    protectedBranches: ["main", "master", "develop", "release"],
    reportBucket: process.env.REPORT_BUCKET || "",
    snsTopicArn: process.env.SNS_TOPIC_ARN || "",
    trackingTable: process.env.TRACKING_TABLE || "",
  };
}

/** Check if a branch is safe (should NOT be deleted) */
export function isSafeBranch(
  branchTag: string,
  config: NukeConfig
): boolean {
  const branch = branchTag.toLowerCase().trim();
  if (!branch) return false; // No branch tag = not safe

  // Protected branches (main, master, develop, release)
  if (config.protectedBranches.some((p) => branch === p || branch.startsWith(`${p}/`))) {
    return true;
  }

  // User-excluded branches
  if (config.excludedBranches.some((e) => branch === e || branch.startsWith(`${e}/`))) {
    return true;
  }

  return false;
}

/** Check if a resource has a do-not-nuke protection tag */
export function isProtected(tags: Record<string, string>): boolean {
  const nukeTag = (
    tags["do-not-nuke"] ||
    tags["DoNotNuke"] ||
    tags["do_not_nuke"] ||
    tags["DO_NOT_NUKE"] ||
    ""
  ).toLowerCase();

  return nukeTag === "true" || nukeTag === "yes" || nukeTag === "1";
}
