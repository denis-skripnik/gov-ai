#!/usr/bin/env node
import fs from "fs";
import "dotenv/config";
import { fetchAndExtract } from "./fetcher.js";

// -------- config --------
const AMBIENT_URL = "https://api.ambient.xyz/v1/chat/completions";
const NOUS_URL = "https://inference-api.nousresearch.com/v1/chat/completions";

const AMBIENT_API_KEY = process.env.AMBIENT_API_KEY;
const NOUS_API_KEY = process.env.NOUS_API_KEY;

// Models
const NOUS_MODEL = "Hermes-4-70B";
const NOUS_MAX_TOKENS = 100000;
const AMBIENT_MAX_TOKENS = 100000;

const RUNS = Number(process.env.BENCH_RUNS || 3);
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS || 3000000);
const RETRIES = Number(process.env.BENCH_RETRIES || 2);

// Same system prompt for both (keep identical constraints)
const SYSTEM_PROMPT =
  "You are a governance analysis assistant. You must output ONLY valid JSON.";

// -------- pricing (USD per 1M tokens) --------
// Ambient pricing from your billing screen (defaults here)
const AMBIENT_TIER = (process.env.AMBIENT_TIER || "standard").toLowerCase(); // standard | mini

const AMBIENT_STANDARD_IN_PER_M = Number(process.env.AMBIENT_STANDARD_IN_PER_M || 0.35);
const AMBIENT_STANDARD_OUT_PER_M = Number(process.env.AMBIENT_STANDARD_OUT_PER_M || 1.71);

const AMBIENT_MINI_IN_PER_M = Number(process.env.AMBIENT_MINI_IN_PER_M || 0.05);
const AMBIENT_MINI_OUT_PER_M = Number(process.env.AMBIENT_MINI_OUT_PER_M || 0.5);

// Nous pricing (defaults to what you provided)
const NOUS_IN_PER_M = Number(process.env.NOUS_IN_PER_M || 0.05);
const NOUS_OUT_PER_M = Number(process.env.NOUS_OUT_PER_M || 0.2);

// -------- helpers --------
function nowIsoSafe() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadJsonFile(path) {
  return JSON.parse(fs.readFileSync(path, "utf-8"));
}

function getProviderPricing(providerName) {
  if (providerName === "ambient") {
    if (AMBIENT_TIER === "mini") {
      return {
        tier: "mini",
        in_per_m: AMBIENT_MINI_IN_PER_M,
        out_per_m: AMBIENT_MINI_OUT_PER_M,
      };
    }
    return {
      tier: "standard",
      in_per_m: AMBIENT_STANDARD_IN_PER_M,
      out_per_m: AMBIENT_STANDARD_OUT_PER_M,
    };
  }
  if (providerName === "nous") {
    return { tier: "standard", in_per_m: NOUS_IN_PER_M, out_per_m: NOUS_OUT_PER_M };
  }
  return { tier: "unknown", in_per_m: null, out_per_m: null };
}

function estimateCostUsdFromUsage(usage, pricing) {
  if (!usage) return null;
  const prompt = Number(usage.prompt_tokens || 0);
  const completion = Number(usage.completion_tokens || 0);
  if (!Number.isFinite(pricing?.in_per_m) || !Number.isFinite(pricing?.out_per_m)) return null;

  // USD
  const inCost = (prompt / 1_000_000) * pricing.in_per_m;
  const outCost = (completion / 1_000_000) * pricing.out_per_m;
  const total = inCost + outCost;

  // If provider doesn't return either token count, treat as unknown
  if (prompt === 0 && completion === 0) return null;

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    input_usd: inCost,
    output_usd: outCost,
    total_usd: total,
  };
}

function buildPrompt(url, extracted, principles) {
  return `
You are given:

URL:
${url}

EXTRACTED_DATA (may be incomplete):
${JSON.stringify(extracted, null, 2)}

USER_PRINCIPLES:
${JSON.stringify(principles, null, 2)}

TASK:
Produce a JSON report with the following rules:

- If some fields (options, results, execution details) are missing or uncertain, you MUST explicitly say "UNKNOWN".
- Do NOT guess voting options or results.
- Base your analysis ONLY on provided data.
- Be conservative and honest.
- Output ONLY valid JSON, no comments, no markdown.

Follow this JSON structure exactly:
${fs.readFileSync("./report.schema.json", "utf-8")}
`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function callOpenAIStyle({
  providerName,
  apiUrl,
  apiKey,
  model,
  systemPrompt,
  userPrompt,
  maxTokens,
  timeoutMs,
}) {
  const body = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    stream: false,
  };

  if (model) body.model = model;
  if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;

  const t0 = Date.now();
  const res = await fetchWithTimeout(
    apiUrl,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    timeoutMs
  );
  const latencyMs = Date.now() - t0;

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    const err = new Error(`${providerName}: Invalid JSON response`);
    err.meta = { status: res.status, raw: text.slice(0, 500) };
    throw err;
  }

  if (!res.ok) {
    const err = new Error(`${providerName}: HTTP ${res.status}`);
    err.meta = { status: res.status, json };
    throw err;
  }

  const content = json?.choices?.[0]?.message?.content;
  if (!content) {
    const err = new Error(`${providerName}: Empty content`);
    err.meta = { status: res.status, json };
    throw err;
  }

  const usage = json?.usage || null;
  return { content, latencyMs, usage, raw: json };
}

async function runWithRetries(fn, { retries, baseDelayMs = 800 }) {
  const attempts = [];
  let lastErr = null;

  for (let i = 0; i <= retries; i++) {
    const attemptNo = i + 1;
    try {
      const res = await fn();
      attempts.push({ attempt: attemptNo, ok: true });
      return { ok: true, res, attempts };
    } catch (e) {
      lastErr = e;
      attempts.push({
        attempt: attemptNo,
        ok: false,
        error: e?.message || String(e),
        meta: e?.meta || null,
      });

      if (i < retries) {
        await sleep(baseDelayMs * attemptNo);
      }
    }
  }

  return { ok: false, err: lastErr, attempts };
}

function parseModelJsonOrNull(content) {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function summarizeRuns(provider, runs) {
  const okRuns = runs.filter((r) => r.ok);
  const failRuns = runs.filter((r) => !r.ok);

  const latencies = okRuns.map((r) => r.latency_ms);
  const avgLatency =
    latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;

  const totalAttempts = runs.reduce((sum, r) => sum + (r.attempts?.length || 0), 0);
  const totalRetries = runs.reduce((sum, r) => {
    const a = r.attempts?.length || 0;
    return sum + Math.max(0, a - 1);
  }, 0);

  // Usage aggregate
  const usageAgg = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    has_any: false,
  };

  for (const r of okRuns) {
    const u = r.usage;
    if (u && (u.prompt_tokens || u.completion_tokens || u.total_tokens)) {
      usageAgg.has_any = true;
      usageAgg.prompt_tokens += Number(u.prompt_tokens || 0);
      usageAgg.completion_tokens += Number(u.completion_tokens || 0);
      usageAgg.total_tokens += Number(u.total_tokens || 0);
    }
  }

  // Cost aggregate (if per-run cost exists)
  const costAgg = {
    total_usd: 0,
    input_usd: 0,
    output_usd: 0,
    has_any: false,
  };

  for (const r of okRuns) {
    const c = r.cost_estimate;
    if (c && Number.isFinite(c.total_usd)) {
      costAgg.has_any = true;
      costAgg.total_usd += c.total_usd;
      costAgg.input_usd += c.input_usd || 0;
      costAgg.output_usd += c.output_usd || 0;
    }
  }

  return {
    provider,
    runs_total: runs.length,
    runs_ok: okRuns.length,
    runs_fail: failRuns.length,
    avg_latency_ms_ok: avgLatency,
    total_attempts: totalAttempts,
    total_retries: totalRetries,
    usage_aggregate: usageAgg.has_any ? usageAgg : null,
    cost_aggregate_usd: costAgg.has_any
      ? {
          total_usd: costAgg.total_usd,
          input_usd: costAgg.input_usd,
          output_usd: costAgg.output_usd,
          avg_usd_per_ok_run: okRuns.length ? costAgg.total_usd / okRuns.length : null,
        }
      : null,
  };
}

// -------- main --------
const cmdUrl = process.argv[2];
const url = cmdUrl || process.env.PROPOSAL_URL;

if (!url) {
  console.error("Usage: node bench.js <proposal_url>");
  console.error("Or set PROPOSAL_URL in .env");
  process.exit(1);
}

if (!AMBIENT_API_KEY) {
  console.error("AMBIENT_API_KEY is not set in .env");
  process.exit(1);
}
if (!NOUS_API_KEY) {
  console.error("NOUS_API_KEY is not set in .env");
  process.exit(1);
}
if (!fs.existsSync("principles.json")) {
  console.error("principles.json not found. Run: node gov-ai.js init");
  process.exit(1);
}
if (!fs.existsSync("report.schema.json")) {
  console.error("report.schema.json not found (required for prompt)");
  process.exit(1);
}

if (!fs.existsSync("bench-results")) {
  fs.mkdirSync("bench-results", { recursive: true });
}

const principles = loadJsonFile("principles.json");

console.log("Bench URL:", url);
console.log("Fetching and extracting once...");
const extracted = await fetchAndExtract(url);

const userPrompt = buildPrompt(url, extracted, principles);

async function runProvider(provider) {
  const runs = [];
  const pricing = getProviderPricing(provider.name);

  for (let i = 0; i < RUNS; i++) {
    console.log(`[${provider.name}] run ${i + 1}/${RUNS}...`);

    const result = await runWithRetries(
      async () => {
        return await callOpenAIStyle({
          providerName: provider.name,
          apiUrl: provider.apiUrl,
          apiKey: provider.apiKey,
          model: provider.model,
          systemPrompt: SYSTEM_PROMPT,
          userPrompt,
          maxTokens: provider.maxTokens,
          timeoutMs: TIMEOUT_MS,
        });
      },
      { retries: RETRIES }
    );

    if (!result.ok) {
      runs.push({
        ok: false,
        latency_ms: null,
        usage: null,
        cost_estimate: null,
        attempts: result.attempts,
        json_valid: false,
      });
      continue;
    }

    const { content, latencyMs, usage } = result.res;
    const parsed = parseModelJsonOrNull(content);

    const costEstimate = estimateCostUsdFromUsage(usage, pricing);

    runs.push({
      ok: true,
      latency_ms: latencyMs,
      usage: usage || null,
      cost_estimate: costEstimate,
      attempts: result.attempts,
      json_valid: Boolean(parsed),
    });
  }

  return runs;
}

// Providers
const providers = [
  {
    name: "ambient",
    apiUrl: AMBIENT_URL,
    apiKey: AMBIENT_API_KEY,
    maxTokens: AMBIENT_MAX_TOKENS,
  },
  {
    name: "nous",
    apiUrl: NOUS_URL,
    apiKey: NOUS_API_KEY,
    model: NOUS_MODEL,
    maxTokens: NOUS_MAX_TOKENS,
  },
];

// Run
const startedAt = new Date().toISOString();
const allRuns = {};

for (const p of providers) {
  allRuns[p.name] = await runProvider(p);
}

const finishedAt = new Date().toISOString();
const summary = providers.map((p) => summarizeRuns(p.name, allRuns[p.name]));

// Save JSON report
const outTs = nowIsoSafe();
const outJson = {
  bench_version: 2,
  created_at: finishedAt,
  started_at: startedAt,
  finished_at: finishedAt,
  url,
  pricing: {
    ambient: {
      tier: AMBIENT_TIER,
      standard: { input_per_1m: AMBIENT_STANDARD_IN_PER_M, output_per_1m: AMBIENT_STANDARD_OUT_PER_M },
      mini: { input_per_1m: AMBIENT_MINI_IN_PER_M, output_per_1m: AMBIENT_MINI_OUT_PER_M },
    },
    nous: { input_per_1m: NOUS_IN_PER_M, output_per_1m: NOUS_OUT_PER_M },
  },
  constraints: {
    runs: RUNS,
    retries: RETRIES,
    timeout_ms: TIMEOUT_MS,
    system_prompt: SYSTEM_PROMPT,
    max_tokens: {
      ambient: AMBIENT_MAX_TOKENS,
      nous: NOUS_MAX_TOKENS,
    },
    models: {
      ambient: "not_set",
      nous: NOUS_MODEL || "not_set",
    },
  },
  extracted_meta: {
    source_type: extracted?.source_type || extracted?.metadata?.source_type || "unknown",
  },
  results: allRuns,
  summary,
  notes: [
    "Same proposal URL, same extracted data, same prompt structure for both providers.",
    "Cost is estimated from usage.prompt_tokens/completion_tokens when provided by the API. If usage is missing, cost is reported as null.",
  ],
};

const jsonPath = `bench-results/bench-result-${outTs}.json`;
fs.writeFileSync(jsonPath, JSON.stringify(outJson, null, 2), "utf-8");

// Save a Discord-friendly summary
function fmt(n) {
  return n === null || n === undefined ? "n/a" : String(n);
}
function fmtUsd(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  return `$${n.toFixed(6)}`;
}

const lines = [];
lines.push("Web2 Micro-Challenge #4 - cost + latency reality check");
lines.push(`URL: ${url}`);
lines.push(`Runs per provider: ${RUNS}, retries: ${RETRIES}, timeout: ${TIMEOUT_MS}ms`);
lines.push("");

for (const s of summary) {
  const pricing = getProviderPricing(s.provider);

  lines.push(`${s.provider}:`);
  lines.push(`- ok/fail: ${s.runs_ok}/${s.runs_fail}`);
  lines.push(`- avg latency (ok): ${fmt(s.avg_latency_ms_ok)} ms`);
  lines.push(`- total retries: ${s.total_retries}`);

  if (s.usage_aggregate) {
    lines.push(
      `- usage total_tokens: ${fmt(s.usage_aggregate.total_tokens)} (prompt ${fmt(
        s.usage_aggregate.prompt_tokens
      )}, completion ${fmt(s.usage_aggregate.completion_tokens)})`
    );
  } else {
    lines.push("- usage: n/a (provider did not return token usage)");
  }

  if (s.cost_aggregate_usd) {
    lines.push(`- pricing: ${pricing.tier} (in $${pricing.in_per_m}/1M, out $${pricing.out_per_m}/1M)`);
    lines.push(
      `- estimated cost (ok runs): total ${fmtUsd(s.cost_aggregate_usd.total_usd)}, avg ${fmtUsd(
        s.cost_aggregate_usd.avg_usd_per_ok_run
      )} per ok run`
    );
  } else {
    lines.push("- estimated cost: n/a (missing usage or pricing)");
  }

  lines.push("");
}

lines.push(`Full JSON saved: ${jsonPath}`);

const txtPath = `bench-results/bench-summary-${outTs}.txt`;
fs.writeFileSync(txtPath, lines.join("\n"), "utf-8");

console.log("");
console.log(lines.join("\n"));
console.log("");
console.log("Saved JSON:", jsonPath);
console.log("Saved TXT :", txtPath);
