/**
 * CloudFormation Stack Scanner
 *
 * This is the MOST IMPORTANT scanner because:
 * - When developers deploy via CDK/CloudFormation, ALL resources are inside a stack
 * - If we delete the stack, ALL resources inside it are automatically cleaned up
 * - This is much safer and cleaner than deleting individual resources
 *
 * How it works:
 * 1. Lists all CloudFormation stacks (active, not deleted)
 * 2. Reads the tags on each stack
 * 3. Checks the "branch" tag (or "Branch", "BRANCH", "git-branch", "source-branch")
 * 4. If the branch is NOT main/master/protected → flag the entire stack
 * 5. Also flags stacks with NO branch tag at all (unknown origin)
 */
import {
  CloudFormationClient,
  ListStacksCommand,
  DescribeStacksCommand,
  StackStatus,
} from "@aws-sdk/client-cloudformation";
import {
  FlaggedResource,
  ScanCategoryResult,
  NukeConfig,
  isSafeBranch,
  isProtected,
} from "../utils/types";

const cf = new CloudFormationClient({});

// Stack statuses that mean the stack is alive and costing money
const ACTIVE_STATUSES: string[] = [
  StackStatus.CREATE_COMPLETE,
  StackStatus.UPDATE_COMPLETE,
  StackStatus.UPDATE_ROLLBACK_COMPLETE,
  StackStatus.IMPORT_COMPLETE,
  StackStatus.IMPORT_ROLLBACK_COMPLETE,
];

// Known branch tag keys (different teams use different names)
const BRANCH_TAG_KEYS = [
  "branch",
  "Branch",
  "BRANCH",
  "git-branch",
  "git_branch",
  "source-branch",
  "source_branch",
  "SourceBranch",
  "GitBranch",
  "feature-branch",
];

// Known environment tag keys
const ENV_TAG_KEYS = [
  "environment",
  "Environment",
  "ENVIRONMENT",
  "env",
  "Env",
  "ENV",
  "stage",
  "Stage",
];

export async function scanCloudFormationStacks(
  config: NukeConfig
): Promise<ScanCategoryResult> {
  const items: FlaggedResource[] = [];

  // List all active stacks
  const listResult = await cf.send(
    new ListStacksCommand({
      StackStatusFilter: ACTIVE_STATUSES,
    })
  );

  for (const stackSummary of listResult.StackSummaries || []) {
    const stackName = stackSummary.StackName!;

    // Skip our own nuke stack!
    if (
      stackName.includes("ResourceNuke") ||
      stackName.includes("resource-nuke") ||
      stackName === "CDKToolkit"
    ) {
      continue;
    }

    try {
      // Get full stack details including tags
      const describeResult = await cf.send(
        new DescribeStacksCommand({ StackName: stackName })
      );

      const stack = describeResult.Stacks?.[0];
      if (!stack) continue;

      // Convert tags array to a map
      const tags: Record<string, string> = {};
      for (const tag of stack.Tags || []) {
        if (tag.Key && tag.Value) {
          tags[tag.Key] = tag.Value;
        }
      }

      // Check do-not-nuke protection
      if (isProtected(tags)) {
        continue;
      }

      // Check if this stack belongs to the target environment
      const envTag = ENV_TAG_KEYS.map((k) => tags[k])
        .find((v) => v !== undefined);

      // If stack has an environment tag and it doesn't match target, skip
      if (envTag && envTag.toLowerCase() !== config.targetEnvironment.toLowerCase()) {
        continue;
      }

      // Find the branch tag
      const branchTag = BRANCH_TAG_KEYS.map((k) => tags[k])
        .find((v) => v !== undefined);

      // DECISION: Should this stack be flagged?
      let reason = "";

      if (!branchTag) {
        // No branch tag at all — unknown origin, flag it
        reason = "No branch tag found — unknown deployment origin";
      } else if (!isSafeBranch(branchTag, config)) {
        // Branch is not main/master/protected — it's a feature branch
        reason = `Deployed from feature branch: "${branchTag}" (not main/master)`;
      } else {
        // Safe branch — skip
        continue;
      }

      items.push({
        resourceId: stack.StackId || stackName,
        resourceType: "CloudFormation Stack",
        branchTag: branchTag || "NONE",
        tags,
        region: process.env.AWS_REGION || "us-east-1",
        reason,
        name: stackName,
        createdAt: stack.CreationTime?.toISOString(),
        stackName,
      });
    } catch (err) {
      console.warn(`Could not describe stack ${stackName}:`, err);
    }
  }

  return { category: "CloudFormation Stacks", items };
}
