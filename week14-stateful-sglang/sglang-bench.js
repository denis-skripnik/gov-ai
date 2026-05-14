#!/usr/bin/env node
import fs from 'fs';
import crypto from 'crypto';
import { JsonMemoryStore } from './memory-store.js';
import { buildStatefulMessages } from './prompt-state.js';

const args = new Set(process.argv.slice(2));
const MOCK = args.has('--mock');

const SGLANG_API_URL = process.env.SGLANG_API_URL || 'http://127.0.0.1:30000/v1/chat/completions';
const SGLANG_API_KEY = process.env.SGLANG_API_KEY || '';
const SGLANG_MODEL = process.env.SGLANG_MODEL || undefined;
const RUNS = Number(process.env.WEEK14_RUNS || 6);
const PARALLEL = Number(process.env.WEEK14_PARALLEL || 3);
const RETRIES = Number(process.env.WEEK14_RETRIES || 1);
const TIMEOUT_MS = Number(process.env.WEEK14_TIMEOUT_MS || 120000);
const OUT_DIR = process.env.WEEK14_OUT_DIR || 'retrodrops/ambient/week14';
const MEMORY_PATH = process.env.WEEK14_MEMORY_PATH || `${OUT_DIR}/week14-memory.json`;

const SYSTEM_PROMPT = 'You are a governance analysis assistant. Output compact JSON only.';
const USER_PROMPT = `Analyze this governance proposal fixture. Return JSON with keys summary, recommendation, risks, unknowns.
Proposal: Increase protocol grants budget by 10% for security audits and accessibility improvements.
Known constraints: funding source is not specified; voter turnout is unknown.`;

function nowIsoSafe() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeContent(content) {
  return String(content || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function contentHash(content) {
  return crypto.createHash('sha256').update(normalizeContent(content)).digest('hex');
}

function parseJsonOrNull(content) {
  try {
    return JSON.parse(content);
  } catch {
    const text = String(content || '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function summarizeStability(runs) {
  const okRuns = runs.filter((run) => run.ok);
  const hashes = okRuns.map((run) => run.output_hash).filter(Boolean);
  const uniqueHashes = new Set(hashes);
  const firstHash = hashes[0] || null;
  const exactMatches = firstHash ? hashes.filter((hash) => hash === firstHash).length : 0;
  const recommendations = okRuns
    .map((run) => run.parsed?.recommendation)
    .filter((value) => value !== undefined && value !== null)
    .map((value) => normalizeContent(JSON.stringify(value)));
  const uniqueRecommendations = new Set(recommendations);

  return {
    ok_runs: okRuns.length,
    unique_output_hashes: uniqueHashes.size,
    exact_match_rate: hashes.length ? Number((exactMatches / hashes.length).toFixed(3)) : null,
    unique_recommendations: uniqueRecommendations.size || null,
    recommendation_consistency_rate: recommendations.length
      ? Number((Math.max(...[...uniqueRecommendations].map((rec) => recommendations.filter((item) => item === rec).length)) / recommendations.length).toFixed(3))
      : null,
  };
}

function classifyFailure(error) {
  const message = String(error?.message || error || 'unknown error');
  const status = Number(error?.status || error?.meta?.status || 0);
  const lower = message.toLowerCase();
  if (error?.name === 'AbortError' || lower.includes('abort') || lower.includes('timeout')) return { type: 'timeout', message };
  if (lower.includes('econnrefused') || lower.includes('fetch failed')) return { type: 'connection_failed', message };
  if (status === 429 || lower.includes('429')) return { type: 'http_429', message };
  if (status >= 500) return { type: `http_${status}`, message };
  if (status >= 400) return { type: `http_${status}`, message };
  return { type: 'other', message };
}

function summarizeLatency(runs) {
  const values = runs.filter((run) => run.ok && Number.isFinite(run.latency_ms)).map((run) => run.latency_ms).sort((a, b) => a - b);
  if (!values.length) return null;
  const avg = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  const percentile = (p) => values[Math.max(0, Math.min(values.length - 1, Math.ceil(values.length * p) - 1))];
  return { min: values[0], avg, median: percentile(0.5), p95: percentile(0.95), max: values[values.length - 1] };
}

function summarizeFailures(runs) {
  return runs.reduce((acc, run) => {
    if (!run.ok) acc[run.failure_type || 'other'] = (acc[run.failure_type || 'other'] || 0) + 1;
    return acc;
  }, {});
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function callSglang(messages, runIndex) {
  if (MOCK) {
    await sleep(35 + (runIndex % 3) * 10);
    return {
      content: JSON.stringify({
        summary: 'Budget increase supports audits and accessibility improvements.',
        recommendation: 'conditional_support',
        risks: ['Funding source is unknown', 'Turnout is unknown'],
        unknowns: ['funding source', 'voter turnout'],
      }),
      usage: { prompt_tokens: 220, completion_tokens: 42, total_tokens: 262 },
    };
  }

  const body = { messages, stream: false };
  if (SGLANG_MODEL) body.model = SGLANG_MODEL;

  const headers = { 'Content-Type': 'application/json' };
  if (SGLANG_API_KEY) headers.Authorization = `Bearer ${SGLANG_API_KEY}`;

  const res = await fetchWithTimeout(
    SGLANG_API_URL,
    { method: 'POST', headers, body: JSON.stringify(body) },
    TIMEOUT_MS
  );
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    const error = new Error(`invalid JSON response: ${text.slice(0, 180)}`);
    error.status = res.status;
    throw error;
  }
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 180)}`);
    error.status = res.status;
    throw error;
  }
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error('empty content');
  return { content, usage: json.usage || null };
}

async function withRetries(fn) {
  const attempts = [];
  let lastError = null;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      const result = await fn();
      attempts.push({ attempt: i + 1, ok: true });
      return { ok: true, result, attempts };
    } catch (error) {
      lastError = error;
      attempts.push({ attempt: i + 1, ok: false, failure: classifyFailure(error) });
      if (i < RETRIES) await sleep(250 * (i + 1));
    }
  }
  return { ok: false, error: lastError, attempts };
}

async function runOne({ mode, messages, index }) {
  const started = Date.now();
  const result = await withRetries(() => callSglang(messages, index));
  const latencyMs = Date.now() - started;

  if (!result.ok) {
    const failure = classifyFailure(result.error);
    return {
      mode,
      index,
      ok: false,
      latency_ms: null,
      attempts: result.attempts,
      retries: Math.max(0, result.attempts.length - 1),
      failure_type: failure.type,
      failure_message: failure.message,
    };
  }

  const content = result.result.content;
  const parsed = parseJsonOrNull(content);
  return {
    mode,
    index,
    ok: true,
    latency_ms: latencyMs,
    attempts: result.attempts,
    retries: Math.max(0, result.attempts.length - 1),
    usage: result.result.usage,
    output_hash: contentHash(content),
    parsed,
    json_valid: Boolean(parsed),
  };
}

async function runMode(mode, messages) {
  const runs = [];
  for (let i = 0; i < RUNS; i += PARALLEL) {
    const batch = Array.from({ length: Math.min(PARALLEL, RUNS - i) }, (_, offset) =>
      runOne({ mode, messages, index: i + offset + 1 })
    );
    runs.push(...(await Promise.all(batch)));
  }
  return runs;
}

function summarizeMode(mode, runs) {
  const okRuns = runs.filter((run) => run.ok);
  return {
    mode,
    runs_total: runs.length,
    runs_ok: okRuns.length,
    runs_fail: runs.length - okRuns.length,
    latency_ms: summarizeLatency(runs),
    total_retries: runs.reduce((sum, run) => sum + Number(run.retries || 0), 0),
    failure_modes: summarizeFailures(runs),
    json_valid_ok_runs: okRuns.filter((run) => run.json_valid).length,
    stability: summarizeStability(runs),
  };
}

function formatLatency(latency) {
  if (!latency) return 'n/a';
  return `min ${latency.min} / avg ${latency.avg} / median ${latency.median} / p95 ${latency.p95} / max ${latency.max} ms`;
}

export async function runBenchmark() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const memory = new JsonMemoryStore(MEMORY_PATH);
memory.upsertSession('week14-governance-fixture', {
  summary: 'Prior discussion favored security audits and accessibility work, but required clear funding source and turnout caveats.',
  facts: {
    domain: 'governance proposal analysis',
    known_unknowns: ['funding source', 'voter turnout'],
    user_preference: 'conservative recommendations when execution data is incomplete',
  },
});
memory.appendTurn('week14-governance-fixture', {
  role: 'assistant',
  content: 'Earlier report marked budget proposals as conditional when missing funding source details.',
});

const promptState = memory.getPromptState('week14-governance-fixture', { maxTurns: 4, maxChars: 2500 });
const noMemoryMessages = [
  { role: 'system', content: SYSTEM_PROMPT },
  { role: 'user', content: USER_PROMPT },
];
const withMemoryMessages = buildStatefulMessages({ systemPrompt: SYSTEM_PROMPT, userPrompt: USER_PROMPT, promptState });

const startedAt = new Date().toISOString();
const noMemoryRuns = await runMode('no_memory', noMemoryMessages);
const withMemoryRuns = await runMode('with_memory', withMemoryMessages);
const finishedAt = new Date().toISOString();

const summary = [summarizeMode('no_memory', noMemoryRuns), summarizeMode('with_memory', withMemoryRuns)];
const latencyDiff = (() => {
  const a = summary.find((item) => item.mode === 'no_memory')?.latency_ms?.avg;
  const b = summary.find((item) => item.mode === 'with_memory')?.latency_ms?.avg;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { with_memory_minus_no_memory_avg_ms: b - a, with_memory_vs_no_memory_ratio: Number((b / a).toFixed(3)) };
})();

const artifact = {
  bench_version: 1,
  week: 14,
  loop: 'developer',
  focus: 'stateful memory + SGLANG performance',
  mock: MOCK,
  started_at: startedAt,
  finished_at: finishedAt,
  endpoint: MOCK ? 'mock' : SGLANG_API_URL,
  model: SGLANG_MODEL || null,
  constraints: { runs: RUNS, parallel: PARALLEL, retries: RETRIES, timeout_ms: TIMEOUT_MS },
  platform_update_context: [
    'SGLANG rollout is live; performance improvements expected.',
    'Auth system now self-hosted; more control, fewer external dependencies.',
    'Memory without performance = unusable.',
    'Performance without memory = stateless tool.',
    'This week tests both together.',
  ],
  memory_state: promptState,
  prompt_lengths: {
    no_memory_chars: JSON.stringify(noMemoryMessages).length,
    with_memory_chars: JSON.stringify(withMemoryMessages).length,
  },
  results: { no_memory: noMemoryRuns, with_memory: withMemoryRuns },
  summary,
  latency_diff: latencyDiff,
};

const ts = nowIsoSafe();
const jsonPath = `${OUT_DIR}/week14-sglang-bench-${ts}.json`;
const txtPath = `${OUT_DIR}/week14-sglang-bench-${ts}.txt`;
fs.writeFileSync(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');

const lines = [];
lines.push('Week 14 Developer Loop — Stateful + SGLANG benchmark');
lines.push(`Mode: ${MOCK ? 'mock/local validation' : 'live SGLANG'}`);
lines.push(`Runs: ${RUNS}, parallel: ${PARALLEL}, retries: ${RETRIES}, timeout: ${TIMEOUT_MS}ms`);
lines.push('');
for (const item of summary) {
  lines.push(`${item.mode}:`);
  lines.push(`- ok/fail: ${item.runs_ok}/${item.runs_fail}`);
  lines.push(`- latency: ${formatLatency(item.latency_ms)}`);
  lines.push(`- retries: ${item.total_retries}`);
  lines.push(`- json-valid ok runs: ${item.json_valid_ok_runs}`);
  lines.push(`- stability exact-match rate: ${item.stability.exact_match_rate}`);
  lines.push(`- unique output hashes: ${item.stability.unique_output_hashes}`);
  lines.push(`- failure modes: ${JSON.stringify(item.failure_modes)}`);
  lines.push('');
}
lines.push(`Latency diff: ${latencyDiff ? JSON.stringify(latencyDiff) : 'n/a'}`);
lines.push(`JSON artifact: ${jsonPath}`);
fs.writeFileSync(txtPath, `${lines.join('\n')}\n`, 'utf-8');

  console.log(lines.join('\n'));
  console.log(`TXT artifact: ${txtPath}`);

  return { artifact, jsonPath, txtPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBenchmark().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
