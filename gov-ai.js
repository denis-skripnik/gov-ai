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
  // no arguments: read from .env
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

const filename = buildReportFilename(url, extracted);

fs.writeFileSync(`reports/${filename}`, JSON.stringify(report, null, 2));
console.log("Saved", filename);

function sanitize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildReportFilename(url, extracted) {
  // Snapshot: report-snapshot-0x....json
  if (extracted?.source_type === "snapshot" && extracted?.metadata?.proposal_id) {
    const id = sanitize(extracted.metadata.proposal_id);
    return `report-snapshot-${id}.json`;
  }

  // Tally: report-tally-uniswap-83.json
  if (extracted?.source_type === "tally") {
    const org =
      sanitize(extracted?.metadata?.organization_slug) ||
      sanitize(extracted?.metadata?.governor_slug) ||
      "unknown";

    const onchain = sanitize(extracted?.metadata?.onchain_id) || "unknown";

    return `report-tally-${org}-${onchain}.json`;
  }

  // Fallback: timestamp
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `report-${ts}.json`;
}