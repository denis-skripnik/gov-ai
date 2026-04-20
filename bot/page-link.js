export function buildDetailLink(reportPath, baseOverride = null, options = {}) {
  const base = baseOverride || process.env.PAGE_SERVER_BASE_URL;
  if (!base || !reportPath) return null;
  const fileName = reportPath.split(/[\\/]/).pop();
  if (!fileName) return null;

  const anchor = options.section ? `#${encodeURIComponent(options.section)}` : "";
  return `${base.replace(/\/$/, "")}/report/${encodeURIComponent(fileName)}${anchor}`;
}
