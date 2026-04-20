export function buildDetailLink(reportPath, baseOverride = null) {
  const base = baseOverride || process.env.PAGE_SERVER_BASE_URL;
  if (!base || !reportPath) return null;
  const fileName = reportPath.split(/[\\/]/).pop();
  if (!fileName) return null;
  return `${base.replace(/\/$/, "")}/report/${encodeURIComponent(fileName)}`;
}
