/**
 * EC2 Instance Scanner
 *
 * Scans for EC2 instances deployed from feature branches.
 *
 * How it works:
 * 1. Lists all running/stopped EC2 instances
 * 2. Reads the "branch" tag on each instance
 * 3. If branch is NOT main/master → flag it
 * 4. Also flags instances with NO branch tag (unknown origin)
 *
 * Note: If the instance was deployed via CloudFormation, the
 * CloudFormation scanner will catch the whole stack. This scanner
 * catches instances created OUTSIDE of CloudFormation (manual or scripts).
 */
import {
  EC2Client,
  DescribeInstancesCommand,
  Instance,
} from "@aws-sdk/client-ec2";
import {
  FlaggedResource,
  ScanCategoryResult,
  NukeConfig,
  isSafeBranch,
  isProtected,
} from "../utils/types";

const ec2 = new EC2Client({});

const BRANCH_TAG_KEYS = [
  "branch", "Branch", "BRANCH", "git-branch", "git_branch",
  "source-branch", "source_branch", "SourceBranch", "GitBranch",
];

const ENV_TAG_KEYS = [
  "environment", "Environment", "env", "Env", "stage", "Stage",
];

export async function scanEC2Instances(
  config: NukeConfig
): Promise<ScanCategoryResult> {
  const items: FlaggedResource[] = [];

  const result = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        {
          Name: "instance-state-name",
          Values: ["running", "stopped"],
        },
      ],
    })
  );

  for (const reservation of result.Reservations || []) {
    for (const instance of reservation.Instances || []) {
      const instanceId = instance.InstanceId!;

      // Build tags map
      const tags: Record<string, string> = {};
      for (const tag of instance.Tags || []) {
        if (tag.Key && tag.Value) tags[tag.Key] = tag.Value;
      }

      // Skip protected
      if (isProtected(tags)) continue;

      // Check environment
      const envTag = ENV_TAG_KEYS.map((k) => tags[k]).find((v) => v);
      if (envTag && envTag.toLowerCase() !== config.targetEnvironment.toLowerCase()) {
        continue;
      }

      // Skip if part of a CloudFormation stack (handled by CF scanner)
      if (tags["aws:cloudformation:stack-name"]) continue;

      // Find branch tag
      const branchTag = BRANCH_TAG_KEYS.map((k) => tags[k]).find((v) => v);

      let reason = "";
      if (!branchTag) {
        reason = "No branch tag — unknown deployment origin";
      } else if (!isSafeBranch(branchTag, config)) {
        reason = `Deployed from feature branch: "${branchTag}"`;
      } else {
        continue; // Safe branch
      }

      const nameTag = tags["Name"] || "No Name";

      items.push({
        resourceId: instanceId,
        resourceType: "EC2 Instance",
        branchTag: branchTag || "NONE",
        tags,
        region: process.env.AWS_REGION || "us-east-1",
        reason,
        name: nameTag,
        createdAt: instance.LaunchTime?.toISOString(),
      });
    }
  }

  return { category: "EC2 Instances", items };
}
