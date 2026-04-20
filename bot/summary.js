import { buildDetailLink } from "./page-link.js";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function list(items, max = 3) {
  return Array.isArray(items) ? items.filter(Boolean).slice(0, max) : [];
}

function shortId(value) {
  const s = String(value || "");
  if (!s) return null;
  if (s.length <= 14) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function shortProposalLabel(report) {
  const sourceType = report?.input?.source_type || report?.input?.metadata?.source_type || report?.input?.sourceType;
  const title = report?.input?.title;
  const inputUrl = String(report?.input?.url || "");
  const meta = report?.input?.metadata || report?.extracted?.metadata || {};

  if (sourceType === "snapshot") {
    const hashMatch = inputUrl.match(/#\/s:([^/]+)\/proposal\/(0x[a-f0-9]+)/i);
    const finalOrg = meta.space_id || meta.space || hashMatch?.[1] || null;
    const finalProposalId = meta.proposal_id || hashMatch?.[2] || null;

    if (finalOrg && finalProposalId) {
      return `Snapshot, ${finalOrg}, ${shortId(finalProposalId)}`;
    }
  }

  if (sourceType === "tally") {
    const pathMatch = inputUrl.match(/\/gov\/([^/]+)\/proposal\/([^/?#]+)/i);
    const finalOrg = meta.organization_slug || meta.organization_name || pathMatch?.[1] || null;
    const finalProposalId = meta.onchain_id || meta.proposal_id || pathMatch?.[2] || null;

    if (finalOrg && finalProposalId) {
      return `Tally, ${finalOrg}, ${shortId(finalProposalId)}`;
    }
  }

  if (sourceType === "daodao") {
    const pathMatch = inputUrl.match(/\/dao\/([^/]+)\/proposals\/([^/?#]+)/i);
    const finalOrg = meta.dao_slug || meta.organization_slug || pathMatch?.[1] || null;
    const finalProposalId = meta.proposal_id || meta.id || pathMatch?.[2] || null;

    if (finalOrg && finalProposalId) {
      return `DAO DAO, ${finalOrg}, ${shortId(finalProposalId)}`;
    }
  }

  if (title) return title;
  return report?.input?.url || "Untitled proposal";
}

export function buildTelegramSummary(report, reportPath, pageBaseUrl = null) {
  const title = shortProposalLabel(report);
  const recommended = report?.recommendation?.suggested_option || "UNKNOWN";
  const confidence = report?.recommendation?.confidence || "UNKNOWN";
  const keyChanges = list(report?.analysis?.key_changes, 3);
  const risks = list(report?.analysis?.risks, 2);
  const unknowns = list(report?.analysis?.unknowns, 2);
  const warnings = [];

  if (report?.refusal_handling?.refusal_detected) warnings.push("refusal detected");
  if (report?.verification_hooks?.mixed_categories_detected) warnings.push("mixed verification categories");
  if (report?.verification_hooks?.routing_action) warnings.push(`routing ${report.verification_hooks.routing_action}`);

  const lines = [];
  lines.push(`<b>Proposal:</b> ${escapeHtml(title)}`);
  lines.push(`<b>Recommendation:</b> ${escapeHtml(recommended)}`);
  lines.push(`<b>Confidence:</b> ${escapeHtml(confidence)}`);

  if (keyChanges.length) {
    lines.push(`<b>Key changes:</b>`);
    for (const item of keyChanges) lines.push(`- ${escapeHtml(item)}`);
  }

  if (risks.length) {
    lines.push(`<b>Risks:</b>`);
    for (const item of risks) lines.push(`- ${escapeHtml(item)}`);
  }

  if (unknowns.length) {
    lines.push(`<b>Unknowns:</b>`);
    for (const item of unknowns) lines.push(`- ${escapeHtml(item)}`);
  }

  if (warnings.length) {
    lines.push(`<b>Warnings:</b>`);
    for (const item of warnings) lines.push(`- ${escapeHtml(item)}`);
  }

  const detailUrl = buildDetailLink(reportPath, pageBaseUrl);
  if (detailUrl) {
    lines.push(`Review the full report and verification details:`);
    lines.push(`<a href="${escapeHtml(detailUrl)}">Details and verification</a>`);
  }

  return {
    text: lines.join("\n"),
    detailUrl,
    recommendation: recommended,
    confidence,
  };
}
