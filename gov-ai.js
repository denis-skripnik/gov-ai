#!/usr/bin/env node
import fs from "fs";
import { fetchAndExtract } from "./fetcher.js";
import { analyzeWithLLM } from "./analyzer.js";
import "dotenv/config";

const cmd = process.argv[2];

// ---------- INIT ----------
if (cmd === "init") {
  if (!fs.existsSync("principles.json")) {
    fs.copyFileSync("principles.example.json", "principles.json");
    console.log("Created principles.json");
  } else {
    console.log("principles.json already exists");
  }
  process.exit(0);
}

// ---------- RESOLVE URL ----------
let url = null;

if (cmd === "analyze") {
  url = process.argv[3];
  if (!url) {
    console.error("Usage: node gov-ai.js analyze <url>");
    process.exit(1);
  }
} else if (!cmd) {
  url = process.env.PROPOSAL_URL;

  if (!url) {
    console.error("PROPOSAL_URL is not set in .env");
    process.exit(1);
  }
} else {
  console.log("Usage:");
  console.log("  node gov-ai.js init");
  console.log("  node gov-ai.js analyze <url>");
  console.log("  node gov-ai.js");
  process.exit(0);
}

// ---------- CHECK ENV ----------
if (!process.env.AMBIENT_API_KEY) {
  console.error("AMBIENT_API_KEY is not set. Put it into .env file.");
  process.exit(1);
}

// ---------- CHECK PRINCIPLES ----------
if (!fs.existsSync("principles.json")) {
  console.error("principles.json not found. Run: node gov-ai.js init");
  process.exit(1);
}

// ---------- LOAD FILES ----------
const principles = JSON.parse(fs.readFileSync("principles.json", "utf-8"));

// ---------- RUN ----------
console.log("Analyzing:", url);

const extracted = await fetchAndExtract(url);

const report = await analyzeWithLLM(url, extracted, principles);

// Week 5: programmatically split into deterministic vs interpretive layers
addVerificationBoundary(report, extracted);

const filename = buildReportFilename(url, extracted);

// Ensure reports folder exists
if (!fs.existsSync("reports")) fs.mkdirSync("reports", { recursive: true });

fs.writeFileSync(`reports/${filename}`, JSON.stringify(report, null, 2));
console.log("Saved", filename);

// ---------------- helpers ----------------

function sanitize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildReportFilename(url, extracted) {
  if (extracted?.source_type === "snapshot" && extracted?.metadata?.proposal_id) {
    const id = sanitize(extracted.metadata.proposal_id);
    return `report-snapshot-${id}.json`;
  }

  if (extracted?.source_type === "tally") {
    const org =
      sanitize(extracted?.metadata?.organization_slug) ||
      sanitize(extracted?.metadata?.governor_slug) ||
      "unknown";

    const onchain = sanitize(extracted?.metadata?.onchain_id) || "unknown";

    return `report-tally-${org}-${onchain}.json`;
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `report-${ts}.json`;
}

/**
 * Week 5: "Split a response into verifiable and non-verifiable layers."
 * Stored in report.verification_boundary:
 * - deterministic: checkable vs extracted + evidence_quotes + hard literals
 * - interpretive: summaries, advice, risk/benefit framing, recommendations
 * - uncertainty_flags: missing data / low confidence / UNKNOWN markers
 */
function addVerificationBoundary(report, extracted) {
  if (!report || typeof report !== "object") return;
  if (report.verification_boundary && typeof report.verification_boundary === "object") return;

  const vb = {
    deterministic: [],
    interpretive: [],
    uncertainty_flags: [],
    method: {
      kind: "heuristic",
      version: 2,
      notes: [
        "Deterministic layer is based on direct matching to extracted fields and evidence_quotes, plus presence of hard literals (numbers, addresses, option strings).",
        "Interpretive layer includes summary, risks, benefits, and recommendation reasoning.",
        "This is a boundary labeling aid, not a proof of truth.",
      ],
    },
  };

  const evidenceQuotes = Array.isArray(report?.analysis?.evidence_quotes)
    ? report.analysis.evidence_quotes.filter((x) => typeof x === "string" && x.trim())
    : [];

  const extractedTitle = safeStr(extracted?.title);
  const extractedBody = safeStr(extracted?.body);
  const extractedOptions = Array.isArray(extracted?.options)
    ? extracted.options.map(safeStr).filter(Boolean)
    : [];

  const extractedSourceType = safeStr(extracted?.source_type || extracted?.metadata?.source_type);

  const candidates = [];

  if (typeof report?.analysis?.summary === "string" && report.analysis.summary.trim()) {
    candidates.push({ path: "analysis.summary", text: report.analysis.summary });
  }

  pushArrayStrings(candidates, report?.analysis?.key_changes, "analysis.key_changes");
  pushArrayStrings(candidates, report?.analysis?.risks, "analysis.risks");
  pushArrayStrings(candidates, report?.analysis?.benefits, "analysis.benefits");
  pushArrayStrings(candidates, report?.analysis?.unknowns, "analysis.unknowns");

  if (typeof report?.recommendation?.reasoning === "string" && report.recommendation.reasoning.trim()) {
    candidates.push({ path: "recommendation.reasoning", text: report.recommendation.reasoning });
  }
  pushArrayStrings(
    candidates,
    report?.recommendation?.conflicts_with_user_principles,
    "recommendation.conflicts_with_user_principles"
  );

  for (const c of candidates) {
    const t = safeStr(c.text);
    if (!t) continue;

    if (c.path.startsWith("analysis.unknowns")) {
      vb.uncertainty_flags.push(`unknowns:${shortKey(t)}`);
      vb.interpretive.push(makeLabeled(c.path, t, "uncertainty"));
      continue;
    }

    if (c.path.startsWith("analysis.risks") || c.path.startsWith("analysis.benefits")) {
      vb.interpretive.push(makeLabeled(c.path, t, "interpretive"));
      continue;
    }

    if (c.path.startsWith("recommendation.conflicts_with_user_principles")) {
      vb.interpretive.push(makeLabeled(c.path, t, "interpretive"));
      continue;
    }

    if (c.path === "recommendation.reasoning") {
      vb.interpretive.push(makeLabeled(c.path, t, "interpretive"));
      continue;
    }

    const detReasons = [];

    if (matchesAnyQuote(t, evidenceQuotes)) detReasons.push("matches_evidence_quotes");

    const titleMatch = matchesExtractedTitle(t, extractedTitle);
    if (titleMatch) detReasons.push("matches_extracted_title");

    const bodyFragMatch = matchesExtractedBodyFragment(t, extractedBody);
    if (bodyFragMatch) detReasons.push("matches_extracted_body_fragment");

    if (containsHardLiterals(t)) detReasons.push("contains_numbers_or_addresses");

    // options reason only if options exist AND text contains an option
    if (extractedOptions.length > 0 && containsAnyOption(t, extractedOptions)) {
      detReasons.push("mentions_extracted_options");
    }

    if (detReasons.length > 0) {
      vb.deterministic.push(makeLabeled(c.path, t, `deterministic:${detReasons.join(",")}`));
    } else {
      vb.interpretive.push(makeLabeled(c.path, t, "interpretive"));
    }

    if (looksUncertain(t)) vb.uncertainty_flags.push(`text_uncertain:${shortKey(t)}`);
  }

  const suggested = safeStr(report?.recommendation?.suggested_option);
  const conf = safeStr(report?.recommendation?.confidence);

  if (suggested && suggested.toUpperCase() === "UNKNOWN") vb.uncertainty_flags.push("suggested_option:UNKNOWN");
  if (conf && conf.toLowerCase() === "low") vb.uncertainty_flags.push("confidence:low");

  if (extractedSourceType && extractedSourceType.toLowerCase() === "generic") vb.uncertainty_flags.push("source_type:generic");
  if (!extractedOptions.length) vb.uncertainty_flags.push("missing:extracted.options");

  report.verification_boundary = vb;
}

function pushArrayStrings(out, arr, basePath) {
  if (!Array.isArray(arr)) return;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (typeof v === "string" && v.trim()) {
      out.push({ path: `${basePath}[${i}]`, text: v });
    }
  }
}

function safeStr(v) {
  return typeof v === "string" ? v.trim() : "";
}

function shortKey(s) {
  const t = safeStr(s);
  return t.length <= 48 ? t : `${t.slice(0, 48)}...`;
}

function makeLabeled(path, text, reason) {
  return { path, text, reason };
}

function matchesAnyQuote(text, quotes) {
  const t = safeStr(text).toLowerCase();
  if (!t || !quotes?.length) return false;
  return quotes.some((q) => {
    const qq = safeStr(q).toLowerCase();
    if (!qq) return false;
    return t.includes(qq) || qq.includes(t);
  });
}

function matchesExtractedTitle(text, title) {
  const t = safeStr(text).toLowerCase();
  const tt = safeStr(title).toLowerCase();
  if (!t || !tt) return false;
  if (tt.length < 8) return false;
  // small prefix match is enough to say "it is from the title"
  const frag = tt.slice(0, Math.min(24, tt.length));
  return t.includes(frag);
}

function matchesExtractedBodyFragment(text, body) {
  const t = safeStr(text).toLowerCase();
  const bb = safeStr(body).toLowerCase();
  if (!t || !bb) return false;
  if (bb.length < 60) return false;
  const frag = bb.slice(0, 60);
  return t.includes(frag);
}

function containsHardLiterals(text) {
  const t = safeStr(text);
  if (!t) return false;

  const hasNumber = /\b\d+([.,]\d+)?\b/.test(t);
  const hasHex = /\b0x[a-fA-F0-9]{8,}\b/.test(t);
  const hasTicker = /\b[A-Z]{2,6}\b/.test(t);

  return hasNumber || hasHex || hasTicker;
}

function containsAnyOption(text, options) {
  const t = safeStr(text).toLowerCase();
  if (!t || !options?.length) return false;
  return options.some((o) => {
    const oo = safeStr(o).toLowerCase();
    if (!oo) return false;
    return t.includes(oo);
  });
}

function looksUncertain(text) {
  const t = safeStr(text).toLowerCase();
  if (!t) return false;
  return (
    t.includes("unknown") ||
    t.includes("insufficient") ||
    t.includes("cannot determine") ||
    t.includes("can't determine") ||
    t.includes("not enough") ||
    t.includes("unclear") ||
    t.includes("missing information")
  );
}
