/**
 * DynamoDB Tracking — Manages the grace period lifecycle
 *
 * Workflow:
 * 1. SCAN (Monday): Flagged resources are written to DynamoDB with status="flagged"
 *    and a graceDeadline 3 days in the future
 * 2. CLEANUP (Thursday): Reads all records where graceDeadline has passed.
 *    If status is still "flagged" (not "excluded"), the resource is deleted.
 *
 * Users can mark a resource as "excluded" by updating its status in DynamoDB
 * or by adding the branch to the ExcludedBranches parameter.
 */
import {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { FlaggedResource, TrackingRecord, NukeConfig } from "./types";

const ddb = new DynamoDBClient({});

/** Save a flagged resource to the tracking table */
export async function trackFlaggedResource(
  resource: FlaggedResource,
  config: NukeConfig
): Promise<void> {
  const now = new Date();
  const deadline = new Date(now.getTime() + config.gracePeriodDays * 24 * 60 * 60 * 1000);
  const ttl = Math.floor(deadline.getTime() / 1000) + 30 * 24 * 60 * 60; // auto-delete after 30 days

  await ddb.send(
    new PutItemCommand({
      TableName: config.trackingTable,
      Item: {
        resourceId: { S: resource.resourceId },
        resourceType: { S: resource.resourceType },
        branchTag: { S: resource.branchTag },
        name: { S: resource.name },
        region: { S: resource.region },
        reason: { S: resource.reason },
        stackName: { S: resource.stackName || "" },
        status: { S: "flagged" },
        flaggedAt: { S: now.toISOString() },
        graceDeadline: { S: deadline.toISOString() },
        ttl: { N: String(ttl) },
      },
      // Don't overwrite if already exists (preserve original flaggedAt)
      ConditionExpression: "attribute_not_exists(resourceId)",
    })
  ).catch((err) => {
    if (err.name === "ConditionalCheckFailedException") {
      // Already tracked — that's fine
    } else {
      throw err;
    }
  });
}

/** Get all resources whose grace period has expired and are still flagged */
export async function getExpiredFlaggedResources(
  config: NukeConfig
): Promise<TrackingRecord[]> {
  const now = new Date().toISOString();
  const records: TrackingRecord[] = [];

  // Query using the status-index GSI
  const result = await ddb.send(
    new QueryCommand({
      TableName: config.trackingTable,
      IndexName: "status-index",
      KeyConditionExpression: "#status = :flagged AND flaggedAt <= :cutoff",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":flagged": { S: "flagged" },
        ":cutoff": { S: now },
      },
    })
  );

  for (const item of result.Items || []) {
    const deadline = item.graceDeadline?.S || "";
    if (deadline && deadline <= now) {
      records.push({
        resourceId: item.resourceId?.S || "",
        resourceType: item.resourceType?.S || "",
        branchTag: item.branchTag?.S || "",
        name: item.name?.S || "",
        region: item.region?.S || "",
        reason: item.reason?.S || "",
        stackName: item.stackName?.S,
        status: "flagged",
        flaggedAt: item.flaggedAt?.S || "",
        graceDeadline: deadline,
        ttl: parseInt(item.ttl?.N || "0", 10),
      });
    }
  }

  return records;
}

/** Mark a resource as deleted in the tracking table */
export async function markAsDeleted(
  resourceId: string,
  resourceType: string,
  config: NukeConfig
): Promise<void> {
  await ddb.send(
    new UpdateItemCommand({
      TableName: config.trackingTable,
      Key: {
        resourceId: { S: resourceId },
        resourceType: { S: resourceType },
      },
      UpdateExpression: "SET #status = :deleted, deletedAt = :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":deleted": { S: "deleted" },
        ":now": { S: new Date().toISOString() },
      },
    })
  );
}

/** Get all currently flagged resources (for reporting) */
export async function getAllFlaggedResources(
  config: NukeConfig
): Promise<TrackingRecord[]> {
  const records: TrackingRecord[] = [];

  const result = await ddb.send(
    new QueryCommand({
      TableName: config.trackingTable,
      IndexName: "status-index",
      KeyConditionExpression: "#status = :flagged",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":flagged": { S: "flagged" },
      },
    })
  );

  for (const item of result.Items || []) {
    records.push({
      resourceId: item.resourceId?.S || "",
      resourceType: item.resourceType?.S || "",
      branchTag: item.branchTag?.S || "",
      name: item.name?.S || "",
      region: item.region?.S || "",
      reason: item.reason?.S || "",
      stackName: item.stackName?.S,
      status: "flagged",
      flaggedAt: item.flaggedAt?.S || "",
      graceDeadline: item.graceDeadline?.S || "",
      ttl: parseInt(item.ttl?.N || "0", 10),
    });
  }

  return records;
}
