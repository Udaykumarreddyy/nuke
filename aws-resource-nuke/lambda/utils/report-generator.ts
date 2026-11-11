/**
 * HTML Report Generator for Resource Nuke
 *
 * Two report types:
 * 1. SCAN report (Monday) — "These resources will be deleted in 3 days"
 * 2. CLEANUP report (Thursday) — "These resources were deleted / failed"
 */
import { ScanCategoryResult, FlaggedResource, NukeConfig } from "./types";
import { DeletionResult } from "./resource-deleter";

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; padding: 20px; }
.container { max-width: 1200px; margin: 0 auto; }
.header { background: linear-gradient(135deg, #b71c1c, #d32f2f); color: white; padding: 30px; border-radius: 12px; margin-bottom: 20px; }
.header.cleanup { background: linear-gradient(135deg, #1b5e20, #2e7d32); }
.header h1 { font-size: 28px; margin-bottom: 8px; }
.header p { opacity: 0.85; font-size: 14px; }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
.card { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: center; }
.card .value { font-size: 32px; font-weight: 700; color: #b71c1c; }
.card .label { font-size: 13px; color: #666; margin-top: 4px; }
.warning { background: #fff3e0; border: 1px solid #ff9800; padding: 16px; border-radius: 8px; margin-bottom: 20px; font-size: 14px; }
.warning b { color: #e65100; }
.how-to-save { background: #e8f5e9; border: 1px solid #4caf50; padding: 16px; border-radius: 8px; margin-bottom: 20px; font-size: 13px; }
.how-to-save b { color: #2e7d32; }
.how-to-save code { background: #c8e6c9; padding: 2px 6px; border-radius: 3px; }
.category { background: white; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 20px; overflow: hidden; }
.category h2 { padding: 16px 20px; background: #fafafa; border-bottom: 1px solid #eee; font-size: 18px; display: flex; align-items: center; gap: 12px; }
.badge { padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 700; }
.badge.red { background: #ffebee; color: #c62828; }
.badge.green { background: #e8f5e9; color: #2e7d32; }
.badge.orange { background: #fff3e0; color: #e65100; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { background: #f5f5f5; padding: 10px 12px; text-align: left; font-weight: 600; border-bottom: 2px solid #e0e0e0; }
td { padding: 10px 12px; border-bottom: 1px solid #eee; vertical-align: top; }
td code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
.branch-tag { background: #ffebee; color: #c62828; padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 11px; }
.branch-tag.safe { background: #e8f5e9; color: #2e7d32; }
.clean { text-align: center; padding: 20px; color: #2e7d32; font-weight: 500; }
.footer { text-align: center; padding: 20px; color: #999; font-size: 12px; }
`;

/** Generate SCAN report (Monday — warning report) */
export function generateScanReport(
  results: ScanCategoryResult[],
  config: NukeConfig
): string {
  const totalFlagged = results.reduce((s, r) => s + r.items.length, 0);
  const deadline = new Date(Date.now() + config.gracePeriodDays * 24 * 60 * 60 * 1000);
  const deadlineStr = deadline.toISOString().split("T")[0];
  const scanDate = new Date().toISOString().split("T")[0];

  // Group all flagged resources by branch
  const branchMap = new Map<string, FlaggedResource[]>();
  for (const result of results) {
    for (const item of result.items) {
      const branch = item.branchTag;
      if (!branchMap.has(branch)) branchMap.set(branch, []);
      branchMap.get(branch)!.push(item);
    }
  }

  let categorySections = "";
  for (const result of results) {
    let rows = "";
    if (result.error) {
      rows = `<tr><td colspan="5" style="color:#c62828;text-align:center;padding:16px;">Scanner error: ${escapeHtml(result.error)}</td></tr>`;
    } else if (result.items.length === 0) {
      rows = `<tr><td colspan="5" class="clean">All clean — no stale resources found!</td></tr>`;
    } else {
      for (const item of result.items) {
        rows += `<tr>
          <td><code>${escapeHtml(item.name)}</code><br/><small>${escapeHtml(item.resourceId)}</small></td>
          <td><span class="branch-tag">${escapeHtml(item.branchTag)}</span></td>
          <td>${escapeHtml(item.reason)}</td>
          <td>${escapeHtml(item.region)}</td>
          <td>${item.createdAt ? escapeHtml(item.createdAt.split("T")[0]) : "Unknown"}</td>
        </tr>`;
      }
    }

    const badge = result.items.length === 0
      ? '<span class="badge green">CLEAN</span>'
      : `<span class="badge red">${result.items.length} FLAGGED</span>`;

    categorySections += `
      <div class="category">
        <h2>${escapeHtml(result.category)} ${badge}</h2>
        <table>
          <thead><tr><th>Resource</th><th>Branch</th><th>Reason</th><th>Region</th><th>Created</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // Branch summary
  let branchSummary = "";
  for (const [branch, items] of branchMap) {
    branchSummary += `<tr><td><span class="branch-tag">${escapeHtml(branch)}</span></td><td>${items.length}</td><td>${items.map(i => escapeHtml(i.name)).join(", ")}</td></tr>`;
  }

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Resource Nuke Scan — ${scanDate}</title><style>${CSS}</style></head><body>
<div class="container">
  <div class="header">
    <h1>Resource Nuke — Scan Report</h1>
    <p>Environment: ${config.targetEnvironment.toUpperCase()} | Scan Date: ${scanDate} | Grace Deadline: ${deadlineStr}</p>
  </div>

  <div class="warning">
    <b>WARNING:</b> The ${totalFlagged} resources below were deployed from <b>feature branches</b> (not main/master) in the <b>${config.targetEnvironment}</b> environment.
    They will be <b>automatically deleted on ${deadlineStr}</b> unless action is taken.<br/><br/>
    <b>You have ${config.gracePeriodDays} days to review.</b>
  </div>

  <div class="how-to-save">
    <b>How to save a resource from deletion:</b><br/>
    1. Add tag <code>do-not-nuke = true</code> to the resource<br/>
    2. OR ask the admin to add the branch name to <code>ExcludedBranches</code> parameter<br/>
    3. OR merge the branch to main/master and redeploy
  </div>

  <div class="summary">
    <div class="card"><div class="value">${totalFlagged}</div><div class="label">Resources Flagged</div></div>
    <div class="card"><div class="value">${branchMap.size}</div><div class="label">Feature Branches</div></div>
    <div class="card"><div class="value">${config.gracePeriodDays} days</div><div class="label">Grace Period</div></div>
    <div class="card"><div class="value">${deadlineStr}</div><div class="label">Deletion Date</div></div>
  </div>

  <div class="category">
    <h2>Branch Summary</h2>
    <table>
      <thead><tr><th>Branch</th><th>Resources</th><th>Resource Names</th></tr></thead>
      <tbody>${branchSummary}</tbody>
    </table>
  </div>

  ${categorySections}

  <div class="footer">Generated by AWS Resource Nuke | Account: ${process.env.AWS_ACCOUNT_ID || "N/A"} | Region: ${process.env.AWS_REGION || "N/A"}</div>
</div></body></html>`;
}

/** Generate CLEANUP report (Thursday — deletion report) */
export function generateCleanupReport(
  deletionResults: DeletionResult[],
  config: NukeConfig
): string {
  const scanDate = new Date().toISOString().split("T")[0];
  const succeeded = deletionResults.filter((r) => r.success);
  const failed = deletionResults.filter((r) => !r.success);

  let rows = "";
  for (const r of deletionResults) {
    const statusBadge = r.success
      ? '<span class="badge green">DELETED</span>'
      : `<span class="badge red">FAILED</span>`;
    rows += `<tr>
      <td><code>${escapeHtml(r.name)}</code><br/><small>${escapeHtml(r.resourceId)}</small></td>
      <td>${escapeHtml(r.resourceType)}</td>
      <td><span class="branch-tag">${escapeHtml(r.branchTag)}</span></td>
      <td>${statusBadge}</td>
      <td>${r.error ? escapeHtml(r.error) : "—"}</td>
    </tr>`;
  }

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Resource Nuke Cleanup — ${scanDate}</title><style>${CSS}</style></head><body>
<div class="container">
  <div class="header cleanup">
    <h1>Resource Nuke — Cleanup Report</h1>
    <p>Environment: ${config.targetEnvironment.toUpperCase()} | Cleanup Date: ${scanDate}</p>
  </div>

  <div class="summary">
    <div class="card"><div class="value">${deletionResults.length}</div><div class="label">Resources Processed</div></div>
    <div class="card"><div class="value" style="color:#2e7d32">${succeeded.length}</div><div class="label">Successfully Deleted</div></div>
    <div class="card"><div class="value">${failed.length}</div><div class="label">Failed</div></div>
  </div>

  <div class="category">
    <h2>Deletion Results</h2>
    <table>
      <thead><tr><th>Resource</th><th>Type</th><th>Branch</th><th>Status</th><th>Error</th></tr></thead>
      <tbody>${rows.length > 0 ? rows : '<tr><td colspan="5" class="clean">No resources were due for deletion!</td></tr>'}</tbody>
    </table>
  </div>

  <div class="footer">Generated by AWS Resource Nuke | Account: ${process.env.AWS_ACCOUNT_ID || "N/A"} | Region: ${process.env.AWS_REGION || "N/A"}</div>
</div></body></html>`;
}
