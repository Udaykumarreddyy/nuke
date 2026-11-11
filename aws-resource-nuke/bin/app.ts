#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { ResourceNukeStack } from "../lib/resource-nuke-stack";

const app = new cdk.App();

new ResourceNukeStack(app, "AwsResourceNukeStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description:
    "AWS Resource Nuke — Scans lower environments for stale feature-branch resources, reports with 3-day grace, then auto-cleans",
});
