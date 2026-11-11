import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { ResourceNukeStack } from "../lib/resource-nuke-stack";

describe("ResourceNukeStack", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new ResourceNukeStack(app, "TestStack");
    template = Template.fromStack(stack);
  });

  test("Creates S3 bucket for reports", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: [{ ExpirationInDays: 90, Status: "Enabled" }],
      },
    });
  });

  test("Creates DynamoDB tracking table", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "resource-nuke-tracking",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "resourceId", KeyType: "HASH" },
        { AttributeName: "resourceType", KeyType: "RANGE" },
      ],
    });
  });

  test("Creates SNS topic for alerts", () => {
    template.hasResourceProperties("AWS::SNS::Topic", {
      DisplayName: "AWS Resource Nuke Alerts",
      TopicName: "resource-nuke-alerts",
    });
  });

  test("Creates scan Lambda function", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "resource-nuke-scanner",
      Runtime: "nodejs20.x",
      Handler: "handler.scanHandler",
      Timeout: 600,
    });
  });

  test("Creates cleanup Lambda function", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "resource-nuke-cleanup",
      Runtime: "nodejs20.x",
      Handler: "handler.cleanupHandler",
      Timeout: 600,
    });
  });

  test("Creates Monday scan schedule", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "cron(0 8 ? * MON *)",
    });
  });

  test("Creates Thursday cleanup schedule", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "cron(0 8 ? * THU *)",
    });
  });

  test("Creates two EventBridge rules total", () => {
    template.resourceCountIs("AWS::Events::Rule", 2);
  });

  test("Creates two Lambda functions total", () => {
    template.resourceCountIs("AWS::Lambda::Function", 2);
  });
});
