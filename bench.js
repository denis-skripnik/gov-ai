#!/usr/bin/env node
import fs from 'fs';
import 'dotenv/config';
import { fetchAndExtract } from './fetcher.js';
import {
  classifyBenchmarkFailure,
  evaluateBenchmarkOutputQuality,
  parseModelJsonOrNull,
  summarizeRuns,
} from './bench-helpers.js';

const AMBIENT_URL = 'https://api.ambient.xyz/v1/chat/completions';
const OPENROUTER_API_URL = process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1/chat/completions';

const AMBIENT_API_KEY = process.env.AMBIENT_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-5.4';
const OPENROUTER_MAX_TOKENS = Number(process.env.OPENROUTER_MAX_TOKENS || 100000);
const AMBIENT_MAX_TOKENS = 100000;
const CLOSED_BASELINE_PROVIDER = 'gpt5_4_closed_baseline';

const RUNS = Number(process.env.BENCH_RUNS || 3);
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS || 3000000);
const RETRIES = Number(process.env.BENCH_RETRIES || 2);

const SYSTEM_PROMPT = 'You are a governance analysis assistant. You must output ONLY valid JSON.';

const AMBIENT_TIER = (process.env.AMBIENT_TIER || 'standard').toLowerCase();
const AMBIENT_STANDARD_IN_PER_M = Number(process.env.AMBIENT_STANDARD_IN_PER_M || 0.35);
const AMBIENT_STANDARD_OUT_PER_M = Number(process.env.AMBIENT_STANDARD_OUT_PER_M || 1.71);
const AMBIENT_MINI_IN_PER_M = Number(process.env.AMBIENT_MINI_IN_PER_M || 0.05);
const AMBIENT_MINI_OUT_PER_M = Number(process.env.AMBIENT_MINI_OUT_PER_M || 0.5);
const OPENROUTER_IN_PER_M = Number(process.env.OPENROUTER_IN_PER_M || 2.5);
const OPENROUTER_OUT_PER_M = Number(process.env.OPENROUTER_OUT_PER_M || 15);

function nowIsoSafe() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadJsonFile(path) {
  return JSON.parse(fs.readFileSync(path, 'utf-8'));
}

function getProviderPricing(providerName) {
  if (providerName === 'ambient') {
    if (AMBIENT_TIER === 'mini') {
      return {
        tier: 'mini',
        in_per_m: AMBIENT_MINI_IN_PER_M,
        out_per_m: AMBIENT_MINI_OUT_PER_M,
      };
    }

    return {
      tier: 'standard',
      in_per_m: AMBIENT_STANDARD_IN_PER_M,
      out_per_m: AMBIENT_STANDARD_OUT_PER_M,
    };
  }

  if (providerName === CLOSED_BASELINE_PROVIDER) {
    return {
      tier: 'standard',
      in_per_m: OPENROUTER_IN_PER_M,
      out_per_m: OPENROUTER_OUT_PER_M,
    };
  }

  return { tier: 'unknown', in_per_m: null, out_per_m: null };
}

function estimateCostUsdFromUsage(usage, pricing) {
  if (!usage) return null;

  const prompt = Number(usage.prompt_tokens || 0);
  const completion = Number(usage.completion_tokens || 0);

  if (!Number.isFinite(pricing?.in_per_m) || !Number.isFinite(pricing?.out_per_m)) return null;
  if (prompt === 0 && completion === 0) return null;

  const inputUsd = (prompt / 1_000_000) * pricing.in_per_m;
  const outputUsd = (completion / 1_000_000) * pricing.out_per_m;

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    input_usd: inputUsd,
    output_usd: outputUsd,
    total_usd: inputUsd + outputUsd,
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
${fs.readFileSync('./report.schema.json', 'utf-8')}
`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
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
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
  };

  if (model) body.model = model;
  if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;

  const startedAtMs = Date.now();
  const res = await fetchWithTimeout(
    apiUrl,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    timeoutMs
  );
  const latencyMs = Date.now() - startedAtMs;

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const error = new Error(`${providerName}: Invalid JSON response`);
    error.meta = { status: res.status, raw: text.slice(0, 500) };
    throw error;
  }

  if (!res.ok) {
    const error = new Error(`${providerName}: HTTP ${res.status}`);
    error.meta = { status: res.status, json };
    throw error;
  }

  const content = json?.choices?.[0]?.message?.content;
  if (!content) {
    const error = new Error(`${providerName}: Empty content`);
    error.meta = { status: res.status, json };
    throw error;
  }

  return {
    content,
    latencyMs,
    usage: json?.usage || null,
    raw: json,
  };
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
    } catch (error) {
      lastErr = error;
      const failure = classifyBenchmarkFailure(error);
      attempts.push({
        attempt: attemptNo,
        ok: false,
        error: failure.message,
        failure_type: failure.type,
        meta: error?.meta || null,
      });

      if (i < retries) {
        await sleep(baseDelayMs * attemptNo);
      }
    }
  }

  return { ok: false, err: lastErr, attempts };
}

function fmt(value) {
  return value === null || value === undefined ? 'n/a' : String(value);
}

function fmtUsd(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return `$${value.toFixed(6)}`;
}

function formatFailureModes(failureModes) {
  const entries = Object.entries(failureModes || {});
  if (!entries.length) return ['- failure modes: none observed'];
  return entries.map(([type, count]) => `- failure mode ${type}: ${count}`);
}

function formatLatencySummary(latency) {
  if (!latency) return 'n/a';
  return `min ${fmt(latency.min)} / avg ${fmt(latency.avg)} / median ${fmt(latency.median)} / p95 ${fmt(latency.p95)} / max ${fmt(latency.max)} ms`;
}

const cmdUrl = process.argv[2];
const url = cmdUrl || process.env.PROPOSAL_URL;

if (!url) {
  console.error('Usage: node bench.js <proposal_url>');
  console.error('Or set PROPOSAL_URL in .env');
  process.exit(1);
}

if (!AMBIENT_API_KEY) {
  console.error('AMBIENT_API_KEY is not set in .env');
  process.exit(1);
}

if (!OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is not set in .env');
  process.exit(1);
}

if (!fs.existsSync('principles.json')) {
  console.error('principles.json not found. Run: node gov-ai.js init');
  process.exit(1);
}

if (!fs.existsSync('report.schema.json')) {
  console.error('report.schema.json not found (required for prompt)');
  process.exit(1);
}

if (!fs.existsSync('bench-results')) {
  fs.mkdirSync('bench-results', { recursive: true });
}

const principles = loadJsonFile('principles.json');

console.log('Bench URL:', url);
console.log('Fetching and extracting once...');
const extracted = await fetchAndExtract(url);
const userPrompt = buildPrompt(url, extracted, principles);

async function runProvider(provider) {
  const runs = [];
  const pricing = getProviderPricing(provider.name);

  for (let i = 0; i < RUNS; i++) {
    console.log(`[${provider.name}] run ${i + 1}/${RUNS}...`);

    const result = await runWithRetries(
      async () =>
        await callOpenAIStyle({
          providerName: provider.name,
          apiUrl: provider.apiUrl,
          apiKey: provider.apiKey,
          model: provider.model,
          systemPrompt: SYSTEM_PROMPT,
          userPrompt,
          maxTokens: provider.maxTokens,
          timeoutMs: TIMEOUT_MS,
        }),
      { retries: RETRIES }
    );

    if (!result.ok) {
      const failure = classifyBenchmarkFailure(result.err);
      runs.push({
        ok: false,
        latency_ms: null,
        usage: null,
        cost_estimate: null,
        attempts: result.attempts,
        json_valid: false,
        quality: evaluateBenchmarkOutputQuality(null),
        failure_type: failure.type,
        failure_message: failure.message,
      });
      continue;
    }

    const { content, latencyMs, usage } = result.res;
    const parsed = parseModelJsonOrNull(content);
    const quality = evaluateBenchmarkOutputQuality(parsed);

    runs.push({
      ok: true,
      latency_ms: latencyMs,
      usage: usage || null,
      cost_estimate: estimateCostUsdFromUsage(usage, pricing),
      attempts: result.attempts,
      json_valid: Boolean(parsed),
      quality,
      failure_type: null,
      failure_message: null,
    });
  }

  return runs;
}

const providers = [
  {
    name: 'ambient',
    apiUrl: AMBIENT_URL,
    apiKey: AMBIENT_API_KEY,
    maxTokens: AMBIENT_MAX_TOKENS,
  },
  {
    name: CLOSED_BASELINE_PROVIDER,
    apiUrl: OPENROUTER_API_URL,
    apiKey: OPENROUTER_API_KEY,
    model: OPENROUTER_MODEL,
    maxTokens: OPENROUTER_MAX_TOKENS,
  },
];

const startedAt = new Date().toISOString();
const allRuns = {};
for (const provider of providers) {
  allRuns[provider.name] = await runProvider(provider);
}

const finishedAt = new Date().toISOString();
const summary = providers.map((provider) => summarizeRuns(provider.name, allRuns[provider.name]));

const outTs = nowIsoSafe();
const outJson = {
  bench_version: 3,
  created_at: finishedAt,
  started_at: startedAt,
  finished_at: finishedAt,
  url,
  benchmark_focus: {
    week: 12,
    loop: 'developer',
    dimensions: ['output_quality', 'latency', 'failure_modes'],
  },
  pricing: {
    ambient: {
      tier: AMBIENT_TIER,
      standard: { input_per_1m: AMBIENT_STANDARD_IN_PER_M, output_per_1m: AMBIENT_STANDARD_OUT_PER_M },
      mini: { input_per_1m: AMBIENT_MINI_IN_PER_M, output_per_1m: AMBIENT_MINI_OUT_PER_M },
    },
    [CLOSED_BASELINE_PROVIDER]: {
      input_per_1m: OPENROUTER_IN_PER_M,
      output_per_1m: OPENROUTER_OUT_PER_M,
      model: OPENROUTER_MODEL,
      provider: 'openrouter',
    },
  },
  constraints: {
    runs: RUNS,
    retries: RETRIES,
    timeout_ms: TIMEOUT_MS,
    system_prompt: SYSTEM_PROMPT,
    max_tokens: {
      ambient: AMBIENT_MAX_TOKENS,
      [CLOSED_BASELINE_PROVIDER]: OPENROUTER_MAX_TOKENS,
    },
    models: {
      ambient: 'not_set',
      [CLOSED_BASELINE_PROVIDER]: OPENROUTER_MODEL || 'not_set',
    },
  },
  extracted_meta: {
    source_type: extracted?.source_type || extracted?.metadata?.source_type || 'unknown',
  },
  results: allRuns,
  summary,
  notes: [
    'Same proposal URL, same extracted data, same prompt structure for both providers.',
    'This Week 12 comparison is Ambient vs a closed GPT-5.4 baseline through OpenRouter.',
    'Week 12 benchmark summary emphasizes developer-loop output quality, latency distribution, and failure modes.',
    'Cost is estimated from usage.prompt_tokens/completion_tokens when provided by the API. If usage is missing, cost is reported as null.',
  ],
};

const jsonPath = `bench-results/bench-result-${outTs}.json`;
fs.writeFileSync(jsonPath, JSON.stringify(outJson, null, 2), 'utf-8');

const lines = [];
lines.push('Week 12 dev-loop benchmark - output quality + latency + failure modes');
lines.push(`URL: ${url}`);
lines.push(`Runs per provider: ${RUNS}, retries: ${RETRIES}, timeout: ${TIMEOUT_MS}ms`);
lines.push('');

for (const item of summary) {
  const pricing = getProviderPricing(item.provider);
  lines.push(`${item.provider}:`);
  lines.push(`- ok/fail: ${item.runs_ok}/${item.runs_fail}`);
  lines.push(`- latency (ok runs): ${formatLatencySummary(item.latency_ms_ok)}`);
  lines.push(`- total retries: ${item.total_retries}`);
  lines.push(
    `- quality: json-valid ok runs ${item.quality.json_valid_ok_runs}, schema-shaped ok runs ${item.quality.schema_shaped_ok_runs}, avg completeness ${fmt(
      item.quality.avg_completeness_score_ok_runs
    )}`
  );

  if (item.usage_aggregate) {
    lines.push(
      `- usage total_tokens: ${fmt(item.usage_aggregate.total_tokens)} (prompt ${fmt(
        item.usage_aggregate.prompt_tokens
      )}, completion ${fmt(item.usage_aggregate.completion_tokens)})`
    );
  } else {
    lines.push('- usage: n/a (provider did not return token usage)');
  }

  if (item.cost_aggregate_usd) {
    lines.push(`- pricing: ${pricing.tier} (in $${pricing.in_per_m}/1M, out $${pricing.out_per_m}/1M)`);
    lines.push(
      `- estimated cost (ok runs): total ${fmtUsd(item.cost_aggregate_usd.total_usd)}, avg ${fmtUsd(
        item.cost_aggregate_usd.avg_usd_per_ok_run
      )} per ok run`
    );
  } else {
    lines.push('- estimated cost: n/a (missing usage or pricing)');
  }

  lines.push(...formatFailureModes(item.failure_modes));
  lines.push('');
}

lines.push(`Full JSON saved: ${jsonPath}`);

const txtPath = `bench-results/bench-summary-${outTs}.txt`;
fs.writeFileSync(txtPath, lines.join('\n'), 'utf-8');

console.log('');
console.log(lines.join('\n'));
console.log('');
console.log('Saved JSON:', jsonPath);
console.log('Saved TXT :', txtPath);
