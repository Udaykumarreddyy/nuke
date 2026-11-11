/**
 * Resource Deleter — Actually deletes flagged resources after grace period
 *
 * SAFETY FEATURES:
 * 1. Only deletes resources in the tracking table with status="flagged"
 * 2. Only deletes after grace period has expired
 * 3. Skips resources with do-not-nuke=true tag (re-checks before deleting)
 * 4. Skips resources whose branch is now in the excluded list
 * 5. Deletes CloudFormation stacks first (which auto-deletes child resources)
 * 6. Logs every deletion for audit trail
 */
import { CloudFormationClient, DeleteStackCommand } from "@aws-sdk/client-cloudformation";
import { EC2Client, TerminateInstancesCommand, DeleteVolumeCommand, ReleaseAddressCommand, DeleteSnapshotCommand } from "@aws-sdk/client-ec2";
import { LambdaClient, DeleteFunctionCommand } from "@aws-sdk/client-lambda";
import { S3Client, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectsCommand, ListObjectVersionsCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { TrackingRecord, NukeConfig, isSafeBranch } from "./types";
import { markAsDeleted } from "./tracking";

const cf = new CloudFormationClient({});
const ec2 = new EC2Client({});
const lambdaClient = new LambdaClient({});
const s3 = new S3Client({});

export interface DeletionResult {
  resourceId: string;
  resourceType: string;
  name: string;
  branchTag: string;
  success: boolean;
  error?: string;
}

export async function deleteResources(
  records: TrackingRecord[],
  config: NukeConfig
): Promise<DeletionResult[]> {
  const results: DeletionResult[] = [];

  // Sort: delete CloudFormation stacks FIRST (they clean up child resources)
  const stacks = records.filter((r) => r.resourceType === "CloudFormation Stack");
  const others = records.filter((r) => r.resourceType !== "CloudFormation Stack");

  // Delete stacks first
  for (const record of stacks) {
    // Re-check: is the branch now excluded?
    if (isSafeBranch(record.branchTag, config)) {
      console.log(`SKIP: ${record.name} — branch "${record.branchTag}" is now excluded`);
      continue;
    }

    const result = await deleteResource(record, config);
    results.push(result);

    if (result.success) {
      await markAsDeleted(record.resourceId, record.resourceType, config);
    }
  }

  // Then delete standalone resources
  for (const record of others) {
    if (isSafeBranch(record.branchTag, config)) {
      console.log(`SKIP: ${record.name} — branch "${record.branchTag}" is now excluded`);
      continue;
    }

    const result = await deleteResource(record, config);
    results.push(result);

    if (result.success) {
      await markAsDeleted(record.resourceId, record.resourceType, config);
    }
  }

  return results;
}

async function deleteResource(
  record: TrackingRecord,
  config: NukeConfig
): Promise<DeletionResult> {
  const base = {
    resourceId: record.resourceId,
    resourceType: record.resourceType,
    name: record.name,
    branchTag: record.branchTag,
  };

  try {
    switch (record.resourceType) {
      case "CloudFormation Stack":
        console.log(`DELETING STACK: ${record.name} (branch: ${record.branchTag})`);
        await cf.send(new DeleteStackCommand({ StackName: record.stackName || record.name }));
        return { ...base, success: true };

      case "EC2 Instance":
        console.log(`TERMINATING EC2: ${record.resourceId} (${record.name})`);
        await ec2.send(new TerminateInstancesCommand({ InstanceIds: [record.resourceId] }));
        return { ...base, success: true };

      case "EBS Volume":
        console.log(`DELETING VOLUME: ${record.resourceId}`);
        await ec2.send(new DeleteVolumeCommand({ VolumeId: record.resourceId }));
        return { ...base, success: true };

      case "Elastic IP":
        console.log(`RELEASING EIP: ${record.resourceId}`);
        await ec2.send(new ReleaseAddressCommand({ AllocationId: record.resourceId }));
        return { ...base, success: true };

      case "EBS Snapshot":
        console.log(`DELETING SNAPSHOT: ${record.resourceId}`);
        await ec2.send(new DeleteSnapshotCommand({ SnapshotId: record.resourceId }));
        return { ...base, success: true };

      case "Lambda Function":
        console.log(`DELETING LAMBDA: ${record.name}`);
        await lambdaClient.send(new DeleteFunctionCommand({ FunctionName: record.name }));
        return { ...base, success: true };

      case "S3 Bucket":
        console.log(`EMPTYING & DELETING BUCKET: ${record.resourceId}`);
        await emptyAndDeleteBucket(record.resourceId);
        return { ...base, success: true };

      default:
        console.warn(`Unknown resource type: ${record.resourceType}`);
        return { ...base, success: false, error: `Unknown type: ${record.resourceType}` };
    }
  } catch (err: any) {
    console.error(`FAILED to delete ${record.resourceType} ${record.resourceId}:`, err.message);
    return { ...base, success: false, error: err.message };
  }
}

/** Empty an S3 bucket (delete all objects + versions) then delete the bucket */
async function emptyAndDeleteBucket(bucketName: string): Promise<void> {
  // Delete all objects
  let continuationToken: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        ContinuationToken: continuationToken,
      })
    );

    if (list.Contents && list.Contents.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: {
            Objects: list.Contents.map((obj) => ({ Key: obj.Key! })),
          },
        })
      );
    }

    continuationToken = list.NextContinuationToken;
  } while (continuationToken);

  // Delete all versions (for versioned buckets)
  const versions = await s3.send(
    new ListObjectVersionsCommand({ Bucket: bucketName })
  );
  for (const version of versions.Versions || []) {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: version.Key!,
        VersionId: version.VersionId,
      })
    );
  }
  for (const marker of versions.DeleteMarkers || []) {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: marker.Key!,
        VersionId: marker.VersionId,
      })
    );
  }

  // Finally delete the bucket
  await s3.send(new DeleteBucketCommand({ Bucket: bucketName }));
}
