import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubs from "aws-cdk-lib/aws-sns-subscriptions";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as path from "path";
import { Construct } from "constructs";

export class ResourceNukeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── PARAMETERS ───────────────────────────────────────────────
    const emailParam = new cdk.CfnParameter(this, "NotificationEmail", {
      type: "String",
      description: "Email address to receive nuke scan reports",
      default: "your-email@example.com",
    });

    const targetEnvironmentParam = new cdk.CfnParameter(
      this,
      "TargetEnvironment",
      {
        type: "String",
        description:
          "Environment to scan (matches the 'environment' or 'env' tag on resources)",
        default: "dev",
        allowedValues: ["dev", "development", "staging", "qa", "test"],
      }
    );

    const gracePeriodDaysParam = new cdk.CfnParameter(
      this,
      "GracePeriodDays",
      {
        type: "Number",
        description:
          "Days to wait after first report before auto-deleting resources",
        default: 3,
      }
    );

    const excludedBranchesParam = new cdk.CfnParameter(
      this,
      "ExcludedBranches",
      {
        type: "String",
        description:
          "Comma-separated branch names to EXCLUDE from deletion (in addition to main/master)",
        default: "",
      }
    );

    // ─── S3 BUCKET — stores HTML reports ──────────────────────────
    const reportBucket = new s3.Bucket(this, "NukeReportBucket", {
      bucketName: `resource-nuke-reports-${cdk.Aws.ACCOUNT_ID}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // ─── DYNAMODB TABLE — tracks flagged resources & grace period ─
    const trackingTable = new dynamodb.Table(this, "NukeTrackingTable", {
      tableName: "resource-nuke-tracking",
      partitionKey: { name: "resourceId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "resourceType", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
    });

    // Add GSI to query by status
    trackingTable.addGlobalSecondaryIndex({
      indexName: "status-index",
      partitionKey: { name: "status", type: dynamodb.AttributeType.STRING },
      sortKey: {
        name: "flaggedAt",
        type: dynamodb.AttributeType.STRING,
      },
    });

    // ─── SNS TOPIC — sends email notifications ───────────────────
    const alertTopic = new sns.Topic(this, "NukeAlertTopic", {
      displayName: "AWS Resource Nuke Alerts",
      topicName: "resource-nuke-alerts",
    });

    alertTopic.addSubscription(
      new snsSubs.EmailSubscription(emailParam.valueAsString)
    );

    // ─── IAM ROLE — scan + delete permissions for lower env ──────
    const lambdaRole = new iam.Role(this, "NukeLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description:
        "Role for Resource Nuke Lambda — scan tags and delete stale resources",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    });

    // Read permissions — scanning all resource tags
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ScanResources",
        effect: iam.Effect.ALLOW,
        actions: [
          // EC2 resources
          "ec2:DescribeInstances",
          "ec2:DescribeVolumes",
          "ec2:DescribeAddresses",
          "ec2:DescribeSnapshots",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeNatGateways",
          "ec2:DescribeNetworkInterfaces",
          // Tags
          "tag:GetResources",
          "tag:GetTagKeys",
          "tag:GetTagValues",
          // CloudFormation stacks
          "cloudformation:ListStacks",
          "cloudformation:DescribeStacks",
          "cloudformation:ListStackResources",
          // Lambda
          "lambda:ListFunctions",
          "lambda:ListTags",
          // S3
          "s3:ListAllMyBuckets",
          "s3:GetBucketTagging",
          "s3:ListBucket",
          // RDS
          "rds:DescribeDBInstances",
          "rds:ListTagsForResource",
          // ELB
          "elasticloadbalancing:DescribeLoadBalancers",
          "elasticloadbalancing:DescribeTags",
          // SQS / SNS
          "sqs:ListQueues",
          "sqs:ListQueueTags",
          "sns:ListTopics",
          "sns:ListTagsForResource",
        ],
        resources: ["*"],
      })
    );

    // Delete permissions — only for cleanup mode
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "DeleteResources",
        effect: iam.Effect.ALLOW,
        actions: [
          "ec2:TerminateInstances",
          "ec2:DeleteVolume",
          "ec2:ReleaseAddress",
          "ec2:DeleteSnapshot",
          "ec2:DeleteSecurityGroup",
          "ec2:DeleteNatGateway",
          "cloudformation:DeleteStack",
          "lambda:DeleteFunction",
          "s3:DeleteBucket",
          "s3:DeleteObject",
          "s3:ListBucketVersions",
          "s3:DeleteObjectVersion",
          "rds:DeleteDBInstance",
          "elasticloadbalancing:DeleteLoadBalancer",
          "sqs:DeleteQueue",
          "sns:DeleteTopic",
        ],
        resources: ["*"],
      })
    );

    // DynamoDB permissions
    trackingTable.grantReadWriteData(lambdaRole);

    // S3 report bucket
    reportBucket.grantWrite(lambdaRole);

    // SNS publish
    alertTopic.grantPublish(lambdaRole);

    // ─── SCAN LAMBDA — runs weekly, scans & reports ──────────────
    const scanFn = new lambda.Function(this, "NukeScanFunction", {
      functionName: "resource-nuke-scanner",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "handler.scanHandler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda")),
      role: lambdaRole,
      timeout: cdk.Duration.minutes(10),
      memorySize: 512,
      environment: {
        REPORT_BUCKET: reportBucket.bucketName,
        SNS_TOPIC_ARN: alertTopic.topicArn,
        TRACKING_TABLE: trackingTable.tableName,
        TARGET_ENVIRONMENT: targetEnvironmentParam.valueAsString,
        GRACE_PERIOD_DAYS: gracePeriodDaysParam.valueAsString,
        EXCLUDED_BRANCHES: excludedBranchesParam.valueAsString,
      },
      description:
        "Scans lower environment for stale feature-branch resources and sends report",
    });

    // ─── CLEANUP LAMBDA — runs 3 days later, deletes stale resources ─
    const cleanupFn = new lambda.Function(this, "NukeCleanupFunction", {
      functionName: "resource-nuke-cleanup",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "handler.cleanupHandler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda")),
      role: lambdaRole,
      timeout: cdk.Duration.minutes(10),
      memorySize: 512,
      environment: {
        REPORT_BUCKET: reportBucket.bucketName,
        SNS_TOPIC_ARN: alertTopic.topicArn,
        TRACKING_TABLE: trackingTable.tableName,
        TARGET_ENVIRONMENT: targetEnvironmentParam.valueAsString,
        GRACE_PERIOD_DAYS: gracePeriodDaysParam.valueAsString,
        EXCLUDED_BRANCHES: excludedBranchesParam.valueAsString,
      },
      description:
        "Deletes stale feature-branch resources after grace period expires",
    });

    // ─── EVENTBRIDGE — Weekly scan (Monday) + Cleanup (Thursday) ─
    const scanRule = new events.Rule(this, "WeeklyScanRule", {
      ruleName: "resource-nuke-weekly-scan",
      description:
        "Triggers resource scan every Monday at 8:00 AM UTC — sends report",
      schedule: events.Schedule.cron({
        minute: "0",
        hour: "8",
        weekDay: "MON",
      }),
    });
    scanRule.addTarget(new targets.LambdaFunction(scanFn));

    const cleanupRule = new events.Rule(this, "WeeklyCleanupRule", {
      ruleName: "resource-nuke-weekly-cleanup",
      description:
        "Triggers resource cleanup every Thursday at 8:00 AM UTC — 3 days after scan",
      schedule: events.Schedule.cron({
        minute: "0",
        hour: "8",
        weekDay: "THU",
      }),
    });
    cleanupRule.addTarget(new targets.LambdaFunction(cleanupFn));

    // ─── OUTPUTS ─────────────────────────────────────────────────
    new cdk.CfnOutput(this, "ReportBucketName", {
      value: reportBucket.bucketName,
      description: "S3 bucket where HTML nuke reports are stored",
    });

    new cdk.CfnOutput(this, "TrackingTableName", {
      value: trackingTable.tableName,
      description: "DynamoDB table tracking flagged resources",
    });

    new cdk.CfnOutput(this, "ScanFunctionName", {
      value: scanFn.functionName,
      description: "Lambda that scans and reports (Monday)",
    });

    new cdk.CfnOutput(this, "CleanupFunctionName", {
      value: cleanupFn.functionName,
      description: "Lambda that deletes stale resources (Thursday)",
    });

    new cdk.CfnOutput(this, "SnsTopicArn", {
      value: alertTopic.topicArn,
      description: "SNS topic for email alerts",
    });
  }
}
