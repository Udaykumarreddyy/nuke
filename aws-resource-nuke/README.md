# AWS Resource Nuke — Lower Environment Cleanup Tool

An automated tool built with **AWS CDK (TypeScript)** that scans lower environments (dev/staging/QA) for stale resources deployed from feature branches, sends a warning report with a **3-day grace period**, and then automatically deletes them if no action is taken.

---

## The Problem This Solves

In any AWS team, this happens every day:

1. A developer creates a feature branch (`LAKE-1234-new-feature`)
2. They deploy a CloudFormation stack to **dev** for testing
3. The stack creates EC2 instances, Lambda functions, S3 buckets, etc.
4. Testing is done. The developer merges to main and moves on
5. **The dev stack is still running. Nobody deletes it.**
6. After a few months, the dev account has 50+ orphan stacks costing hundreds of dollars/month

This tool **automatically finds and cleans up** those forgotten resources.

---

## How It Works — The Complete Workflow

```
┌──────────────────────────────────────────────────────────────────┐
│                    WEEKLY LIFECYCLE                               │
│                                                                  │
│  MONDAY (Scan)                THURSDAY (Cleanup)                 │
│  ┌─────────────┐              ┌──────────────────┐               │
│  │ Scan all     │              │ Check DynamoDB    │               │
│  │ resources in │              │ for expired       │               │
│  │ dev env      │              │ grace periods     │               │
│  └──────┬──────┘              └────────┬─────────┘               │
│         │                              │                          │
│         ▼                              ▼                          │
│  ┌─────────────┐              ┌──────────────────┐               │
│  │ Check tags:  │              │ Re-check:         │               │
│  │ branch=?     │              │ branch excluded?  │               │
│  │ do-not-nuke? │              │ do-not-nuke?      │               │
│  └──────┬──────┘              └────────┬─────────┘               │
│         │                              │                          │
│         ▼                              ▼                          │
│  ┌─────────────┐              ┌──────────────────┐               │
│  │ Flag stale   │              │ DELETE stale      │               │
│  │ resources in │              │ resources (stacks │               │
│  │ DynamoDB     │              │ first, then       │               │
│  └──────┬──────┘              │ standalone)        │               │
│         │                     └────────┬─────────┘               │
│         ▼                              ▼                          │
│  ┌─────────────┐              ┌──────────────────┐               │
│  │ Send WARNING │              │ Send CLEANUP      │               │
│  │ email + S3   │              │ report email + S3 │               │
│  │ report       │              │                   │               │
│  └─────────────┘              └──────────────────┘               │
│                                                                  │
│  ◄── 3-DAY GRACE PERIOD ──►                                     │
│  Team reviews report and                                         │
│  saves resources if needed                                       │
└──────────────────────────────────────────────────────────────────┘
```

### Step-by-Step Breakdown

**Monday — SCAN (Warning Phase)**

1. Lambda function `resource-nuke-scanner` is triggered by EventBridge at 8:00 AM UTC
2. It scans ALL resources in the target environment (dev):
   - CloudFormation stacks (most important — deleting a stack deletes all its resources)
   - EC2 instances (not part of CloudFormation)
   - EBS volumes, Elastic IPs, EBS snapshots
   - Lambda functions, S3 buckets
3. For each resource, it reads the **tags** and checks:
   - Is the `branch` tag = main, master, develop, or release? → **SAFE, skip**
   - Is the `do-not-nuke` tag = true? → **PROTECTED, skip**
   - Is the branch in the ExcludedBranches list? → **EXCLUDED, skip**
   - Otherwise → **FLAG for deletion**
4. Flagged resources are saved to **DynamoDB** with a grace deadline (Monday + 3 days = Thursday)
5. An **HTML report** is generated showing every flagged resource, grouped by branch
6. The report is uploaded to **S3** and a summary is sent via **SNS email**

**Tuesday/Wednesday — GRACE PERIOD (Review Phase)**

- The team receives the email and reviews the report
- If a resource is still needed, they can:
  - Add `do-not-nuke = true` tag to the resource
  - Ask the admin to add the branch name to `ExcludedBranches`
  - Merge the branch to main/master and redeploy

**Thursday — CLEANUP (Deletion Phase)**

1. Lambda function `resource-nuke-cleanup` is triggered at 8:00 AM UTC
2. It reads DynamoDB for resources whose grace period has expired
3. **Before deleting**, it re-checks:
   - Is the branch now in ExcludedBranches? → **Skip** (user saved it)
   - Does it now have `do-not-nuke = true`? → **Skip** (user saved it)
4. CloudFormation **stacks are deleted first** — this auto-deletes all resources inside the stack
5. Remaining standalone resources are deleted individually
6. A **cleanup report** is generated with success/failure status for each resource
7. Report uploaded to S3, summary sent via SNS email

---

## How It Decides What to Delete

The tool checks resource tags to make its decision:

```
┌─────────────────────────────────────────────────────────┐
│                    TAG DECISION TREE                      │
│                                                          │
│  Resource Found in Dev Environment                       │
│         │                                                │
│         ▼                                                │
│  Has "do-not-nuke = true" tag? ──── YES ──→ SKIP        │
│         │ NO                                             │
│         ▼                                                │
│  Has "branch" tag? ──── NO ──→ FLAG (unknown origin)    │
│         │ YES                                            │
│         ▼                                                │
│  Branch = main/master/develop/release? ── YES ──→ SKIP  │
│         │ NO                                             │
│         ▼                                                │
│  Branch in ExcludedBranches list? ──── YES ──→ SKIP     │
│         │ NO                                             │
│         ▼                                                │
│  FLAG FOR DELETION                                       │
│  (3-day grace period starts)                             │
└─────────────────────────────────────────────────────────┘
```

### Tag Names It Looks For

The tool checks multiple variations of the branch tag because different teams use different naming conventions:

| Tag Key | Example Value | Notes |
|---------|---------------|-------|
| `branch` | `LAKE-1234-feature` | Most common |
| `Branch` | `main` | Title case |
| `git-branch` | `feature/login-page` | With prefix |
| `source-branch` | `hotfix/urgent-fix` | CI/CD pipelines |
| `environment` / `env` | `dev` | Identifies the environment |
| `do-not-nuke` | `true` | Protection tag |

### What Counts as a "Safe" Branch

These branches are **never deleted**:

| Branch | Why It's Safe |
|--------|---------------|
| `main` | Production code |
| `master` | Production code (older convention) |
| `develop` | Development integration branch |
| `release` or `release/*` | Release preparation |
| Any branch in `ExcludedBranches` parameter | User-specified exceptions |

Everything else (feature branches, bugfix branches, personal branches) is flagged.

---

## How It Helps Save Cost

### Real-World Example

Imagine your dev account has:

| Resource | Branch Tag | Monthly Cost | Action |
|----------|-----------|-------------|--------|
| Stack: `UserService-dev` | `main` | $45 | SAFE — production deploy |
| Stack: `LAKE-1234-login-test` | `LAKE-1234-login` | $32 | DELETE — merged 2 months ago |
| Stack: `LAKE-5678-api-test` | `LAKE-5678-new-api` | $58 | DELETE — abandoned branch |
| EC2: `i-0abc123` | (no branch tag) | $30 | DELETE — unknown origin |
| Stack: `PaymentService-dev` | `main` | $65 | SAFE — production deploy |
| Stack: `LAKE-9999-hotfix` | `LAKE-9999-hotfix` | $22 | Team adds to ExcludedBranches — SKIP |

**Before Resource Nuke:** $252/month
**After Resource Nuke:** $110/month (main stacks only)
**Monthly savings:** $142
**Annual savings:** $1,704

And this is just one environment. Multiply by staging, QA, etc.

---

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│  EventBridge Rules                                         │
│  ┌─────────────────┐      ┌─────────────────────┐         │
│  │ Monday 8AM UTC  │      │ Thursday 8AM UTC     │         │
│  │ (weekly-scan)   │      │ (weekly-cleanup)     │         │
│  └────────┬────────┘      └──────────┬──────────┘         │
│           │                          │                     │
│           ▼                          ▼                     │
│  ┌─────────────────┐      ┌─────────────────────┐         │
│  │ Scanner Lambda  │      │ Cleanup Lambda       │         │
│  │ (scan + report) │      │ (delete + report)    │         │
│  └────────┬────────┘      └──────────┬──────────┘         │
│           │                          │                     │
│     ┌─────┼─────────┐         ┌─────┼──────┐              │
│     │     │         │         │     │      │              │
│     ▼     ▼         ▼         ▼     ▼      ▼              │
│  ┌─────┐┌─────┐┌────────┐ ┌─────┐┌─────┐┌────────┐       │
│  │ AWS ││ S3  ││DynamoDB│ │ S3  ││ SNS ││DynamoDB│       │
│  │ APIs││Rpt  ││Tracking│ │ Rpt ││Email││Tracking│       │
│  └─────┘└─────┘└────────┘ └─────┘└─────┘└────────┘       │
└───────────────────────────────────────────────────────────┘
```

### AWS Services Used

| Service | Purpose |
|---------|---------|
| **CDK (TypeScript)** | Infrastructure as Code for the entire project |
| **Lambda (x2)** | Scanner function + Cleanup function |
| **EventBridge (x2)** | Monday scan schedule + Thursday cleanup schedule |
| **DynamoDB** | Tracks flagged resources and grace period deadlines |
| **S3** | Stores HTML scan and cleanup reports (90-day retention) |
| **SNS** | Sends email notifications to the team |
| **IAM** | Scan (read-only) + Delete permissions for lower env |
| **CloudFormation** | Stack deployment via CDK |

---

## Project Structure

```
aws-resource-nuke/
├── bin/
│   └── app.ts                           # CDK app entry point
├── lib/
│   └── resource-nuke-stack.ts           # CDK stack — all AWS resources
├── lambda/
│   ├── handler.ts                       # Two handlers: scanHandler + cleanupHandler
│   ├── scanners/
│   │   ├── cloudformation-scanner.ts    # Scans CF stacks by branch tag
│   │   ├── ec2-scanner.ts              # Scans standalone EC2 by branch tag
│   │   └── standalone-scanner.ts        # Scans EBS, EIP, Snapshots, Lambda, S3
│   └── utils/
│       ├── types.ts                     # Shared types + tag-checking logic
│       ├── tracking.ts                  # DynamoDB grace period management
│       ├── resource-deleter.ts          # Actual resource deletion logic
│       ├── report-generator.ts          # HTML report builder (scan + cleanup)
│       ├── s3-uploader.ts              # Upload reports to S3
│       └── sns-notifier.ts             # Send email notifications
├── test/
│   └── resource-nuke-stack.test.ts      # CDK unit tests
├── package.json
├── tsconfig.json
├── cdk.json
├── jest.config.js
├── .gitignore
└── README.md
```

---

## Deployment

### Prerequisites

1. **Node.js 18+**: `node --version`
2. **AWS CLI** configured: `aws sts get-caller-identity`
3. **AWS CDK** installed: `npm install -g aws-cdk`
4. **CDK bootstrapped**: `cdk bootstrap`

### Deploy

```bash
cd aws-resource-nuke
npm install
npm run build

# Deploy with your email and target environment
cdk deploy \
  --parameters NotificationEmail=your-email@gmail.com \
  --parameters TargetEnvironment=dev \
  --parameters GracePeriodDays=3 \
  --parameters ExcludedBranches=""
```

After deploying, **confirm the SNS email subscription** by clicking the link in the confirmation email.

### Test Manually

```bash
# Run the scan (doesn't delete anything — just reports)
aws lambda invoke --function-name resource-nuke-scanner --payload '{}' /dev/stdout

# Run the cleanup (DELETES resources whose grace period expired!)
aws lambda invoke --function-name resource-nuke-cleanup --payload '{}' /dev/stdout
```

### View Reports

```bash
# List reports
aws s3 ls s3://resource-nuke-reports-YOUR_ACCOUNT_ID/reports/ --recursive

# Download and view
aws s3 cp s3://resource-nuke-reports-YOUR_ACCOUNT_ID/reports/2026-11-11/scan-report.html ./scan-report.html
open scan-report.html
```

---

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `NotificationEmail` | (required) | Email to receive weekly reports |
| `TargetEnvironment` | `dev` | Which environment to scan (dev, staging, qa, test) |
| `GracePeriodDays` | `3` | Days between scan warning and actual deletion |
| `ExcludedBranches` | (empty) | Comma-separated branch names to never delete |

### Example: Exclude Specific Branches

If the team says "don't delete resources from branch `LAKE-9999-important-test`":

```bash
cdk deploy --parameters ExcludedBranches="LAKE-9999-important-test,LAKE-8888-perf-test"
```

Now those branches are safe alongside main/master.

---

## How to Protect a Resource

Three ways to save a resource from deletion:

### 1. Add `do-not-nuke` Tag (Easiest)

```bash
# Protect a CloudFormation stack
aws cloudformation update-stack --stack-name MyStack \
  --tags Key=do-not-nuke,Value=true

# Protect an EC2 instance
aws ec2 create-tags --resources i-0abc123 \
  --tags Key=do-not-nuke,Value=true
```

### 2. Add Branch to ExcludedBranches

```bash
cdk deploy --parameters ExcludedBranches="branch-to-keep"
```

### 3. Redeploy from main/master

If the feature is merged, redeploy the stack from the main branch. The `branch` tag will update to `main` and the resource becomes safe.

---

## How the Report Looks

### Scan Report (Monday Email)

```
[Resource Nuke] DEV — 12 Resources Flagged for Deletion

Environment: DEV
Total Flagged: 12
Deletion Date: 2026-11-14 (3-day grace period)

Branch Breakdown:
  "LAKE-1234-login" — 4 resource(s)
  "LAKE-5678-api" — 5 resource(s)
  "NONE" — 3 resource(s)

HOW TO SAVE A RESOURCE:
  1. Add tag "do-not-nuke = true" to the resource
  2. Ask admin to add the branch to ExcludedBranches
  3. Merge the branch to main/master and redeploy
```

### Cleanup Report (Thursday Email)

```
[Resource Nuke] DEV — Cleanup Complete: 10 deleted, 2 failed

Deleted: 10
Failed: 2

Details:
  DELETED: CloudFormation Stack — LAKE-1234-login-stack (branch: LAKE-1234-login)
  DELETED: CloudFormation Stack — LAKE-5678-api-stack (branch: LAKE-5678-api)
  FAILED: EC2 Instance — i-0abc123 (branch: NONE) [Error: TerminateInstances not permitted]
```

---

## Safety Features

| Feature | How It Protects |
|---------|----------------|
| **3-day grace period** | Nobody loses resources without warning |
| **do-not-nuke tag** | Individuals can protect their own resources |
| **ExcludedBranches** | Admin can globally protect specific branches |
| **Protected branches** | main, master, develop, release are NEVER deleted |
| **Self-exclusion** | The nuke tool skips its own stacks and resources |
| **Stack-first deletion** | Deletes CF stacks before standalone resources (cleaner) |
| **Re-check before delete** | Cleanup Lambda re-checks exclusions before every deletion |
| **DynamoDB tracking** | Full audit trail of what was flagged and when |
| **Dual reports** | Both scan (warning) and cleanup (results) reports |

---

## Cleanup / Teardown

```bash
cdk destroy
```

This removes all nuke infrastructure (Lambda, DynamoDB, S3, SNS, EventBridge).

---

## Cost of Running This Tool

| Resource | Cost |
|----------|------|
| Lambda (2 functions, ~1 min/week each) | ~$0.00 (free tier) |
| DynamoDB (on-demand, small table) | ~$0.01/month |
| S3 (small HTML reports) | ~$0.01/month |
| SNS (2 emails/week) | Free |
| EventBridge (2 rules) | Free |
| **Total** | **< $0.05/month** |

Typical savings: **$100–$500/month** per environment.

---

## Resume Bullet Points

- Built an automated lower-environment resource cleanup tool using CDK (TypeScript) that scans for stale feature-branch deployments and deletes them after a configurable grace period
- Implemented tag-based resource lifecycle management checking branch, environment, and do-not-nuke tags across CloudFormation stacks, EC2, EBS, EIP, Lambda, and S3 resources
- Designed a two-phase workflow with EventBridge: weekly scan with 3-day grace period for team review, then automated cleanup of expired resources
- Used DynamoDB for grace-period tracking with TTL-based auto-expiry, enabling a safe review window before any destructive action
- Reduced lower-environment cloud spend by identifying and removing orphan stacks deployed from merged or abandoned feature branches

---

## Interview Talking Points

**Q: Why did you build this tool?**
A: In our team, developers deploy stacks to dev for testing feature branches. After the branch is merged, the dev stack is often forgotten. Over months, we accumulated 50+ orphan stacks costing hundreds per month. This tool automates the cleanup with a safe grace period.

**Q: How do you decide which resources to delete?**
A: I check the `branch` tag on each resource. If it's main, master, develop, or release, it's safe. If it's a feature branch that's no longer active, it's flagged. Resources with a `do-not-nuke=true` tag are always protected. There's also an ExcludedBranches parameter for admin overrides.

**Q: What if someone's resources get deleted by mistake?**
A: Three safety layers prevent this: (1) A 3-day grace period with a warning email so teams can review, (2) The `do-not-nuke` tag lets individuals protect resources, (3) The admin can add branches to ExcludedBranches instantly. The tool also re-checks all exclusions right before deleting.

**Q: Why two separate Lambda functions instead of one?**
A: Separation of concerns. The scanner is read-only and safe to run anytime. The cleanup function has delete permissions and only runs after the grace period. This makes it easy to test scanning without any risk of accidental deletion.

**Q: How does it handle CloudFormation stacks vs standalone resources?**
A: CloudFormation stacks are deleted first because deleting a stack auto-deletes all resources inside it. Then standalone resources (created outside CF) are cleaned up individually. This prevents trying to delete a resource that's already gone because its stack was deleted.

**Q: What would you add next?**
A: Slack integration for real-time alerts instead of just email, a web dashboard showing cleanup history and savings over time, multi-region support, and integration with Jira to automatically check if the branch's ticket is closed before flagging.
