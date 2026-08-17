#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const DEFAULT_OUT_DIR = path.dirname(fileURLToPath(import.meta.url));

function getArg(name, fallback = null) {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function numberArg(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = getArg(name, null);
  const value = raw == null ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid --${name}: expected number in [${min}, ${max}], got ${raw}`);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const idx = Math.ceil(sortedValues.length * p) - 1;
  return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, idx))];
}

function summarizeNumbers(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const sum = clean.reduce((acc, value) => acc + value, 0);
  return {
    min: clean[0],
    avg: Math.round(sum / clean.length),
    median: percentile(clean, 0.5),
    p95: percentile(clean, 0.95),
    max: clean[clean.length - 1],
  };
}

function countBy(values) {
  return values.reduce((acc, value) => {
    const key = value || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function classifyFailure(status, message) {
  const lower = String(message || '').toLowerCase();
  if (lower.includes('timeout') || lower.includes('aborted')) return 'timeout';
  if (status === 429 || lower.includes('too many requests')) return 'http_429';
  if (status >= 500) return `http_${status}`;
  if (status >= 400) return `http_${status}`;
  return 'other';
}

function redactErrorPreview(text) {
  return String(text || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[REDACTED]')
    .slice(0, 220);
}

function parseSseFrames(buffer) {
  const frames = buffer.split(/\r?\n\r?\n/);
  const remainder = frames.pop() ?? '';
  const data = [];
  for (const frame of frames) {
    const lines = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'));
    if (!lines.length) continue;
    data.push(lines.map((line) => line.slice(5).trimStart()).join('\n'));
  }
  return { data, remainder };
}

function applyAmbientEvent(obj, state) {
  if (!obj || typeof obj !== 'object') return;
  if (obj.verified !== undefined) state.verified = obj.verified;
  if (obj.merkle_root) state.merkle_root_present = true;
  if (obj.output_sha256) state.output_sha256_present = true;
  if (obj.usage) state.usage = obj.usage;
  if (obj.model) state.model_returned = obj.model;

  const eventType = obj.type || obj.object || obj.event;
  if (eventType) state.event_types.add(eventType);
  if (eventType === 'ambient.lifecycle' || obj.type === 'ambient.lifecycle') {
    state.lifecycle_events += 1;
    const payload = obj.payload || obj.data || obj;
    const lifecycleType = payload.type || payload.event || payload.stage;
    if (lifecycleType) state.lifecycle_types.add(lifecycleType);
    const bidCount = payload.bid_count ?? payload.bids?.count ?? payload.auction?.bid_count;
    if (Number.isFinite(Number(bidCount))) state.max_bid_count = Math.max(state.max_bid_count ?? 0, Number(bidCount));
  }

  const delta = obj.choices?.[0]?.delta?.content;
  const message = obj.choices?.[0]?.message?.content;
  if (typeof delta === 'string') state.output += delta;
  if (typeof message === 'string') state.output += message;
}

async function callAmbient({ runId, lane, model, maxTokens, timeoutMs, baseUrl, prompt }) {
  const apiKey = process.env.AMBIENT_API_KEY;
  const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const started = Date.now();
  const memBefore = process.memoryUsage().rss;
  const state = {
    output: '',
    verified: null,
    merkle_root_present: false,
    output_sha256_present: false,
    usage: null,
    model_returned: null,
    event_types: new Set(),
    lifecycle_types: new Set(),
    lifecycle_events: 0,
    max_bid_count: null,
    first_byte_ms: null,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a concise verification probe. Return one short sentence.' },
          { role: 'user', content: prompt },
        ],
        stream: true,
        emit_verified: true,
        emit_ambient_events: true,
        wait_for_verification: true,
        emit_usage: true,
        max_tokens: maxTokens,
      }),
    });

    const requestIdPresent = Boolean(response.headers.get('x-request-id'));
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      const latency = Date.now() - started;
      return {
        run_id: runId,
        lane,
        ok: false,
        status: response.status,
        latency_ms: latency,
        first_byte_ms: state.first_byte_ms,
        request_id_present: requestIdPresent,
        failure_type: classifyFailure(response.status, bodyText),
        error_preview: redactErrorPreview(bodyText),
        memory_rss_before_bytes: memBefore,
        memory_rss_after_bytes: process.memoryUsage().rss,
      };
    }

    if (!response.body?.getReader) {
      throw new Error('Response body is not a readable stream');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (state.first_byte_ms == null) state.first_byte_ms = Date.now() - started;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseFrames(buffer);
      buffer = parsed.remainder;
      for (const payload of parsed.data) {
        if (!payload || payload === '[DONE]') continue;
        try {
          applyAmbientEvent(JSON.parse(payload), state);
        } catch {
          state.event_types.add('unparseable_sse_json');
        }
      }
    }
    buffer += decoder.decode();
    const tail = parseSseFrames(`${buffer}\n\n`);
    for (const payload of tail.data) {
      if (!payload || payload === '[DONE]') continue;
      try {
        applyAmbientEvent(JSON.parse(payload), state);
      } catch {
        state.event_types.add('unparseable_sse_json');
      }
    }

    const latency = Date.now() - started;
    const memAfter = process.memoryUsage().rss;
    const output = state.output.trim();
    return {
      run_id: runId,
      lane,
      ok: output.length > 0,
      status: response.status,
      latency_ms: latency,
      first_byte_ms: state.first_byte_ms,
      request_id_present: requestIdPresent,
      verified: state.verified,
      merkle_root_present: state.merkle_root_present,
      output_sha256_present: state.output_sha256_present,
      model_requested: model,
      model_returned: state.model_returned,
      output_chars: output.length,
      output_sha256_local: output ? sha256(output) : null,
      usage: state.usage,
      event_types: [...state.event_types].sort(),
      lifecycle_events: state.lifecycle_events,
      lifecycle_types: [...state.lifecycle_types].sort(),
      max_bid_count: state.max_bid_count,
      memory_rss_before_bytes: memBefore,
      memory_rss_after_bytes: memAfter,
      memory_rss_delta_bytes: memAfter - memBefore,
      failure_type: output.length > 0 ? null : 'empty_output',
    };
  } catch (error) {
    const latency = Date.now() - started;
    return {
      run_id: runId,
      lane,
      ok: false,
      status: null,
      latency_ms: latency,
      first_byte_ms: state.first_byte_ms,
      request_id_present: false,
      failure_type: classifyFailure(null, error?.message || error),
      error_preview: redactErrorPreview(error?.message || error),
      memory_rss_before_bytes: memBefore,
      memory_rss_after_bytes: process.memoryUsage().rss,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runPool(tasks, concurrency) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const idx = next++;
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

function buildSummary({ runs, startedAt, finishedAt, options, hardware }) {
  const okRuns = runs.filter((run) => run.ok);
  const failRuns = runs.filter((run) => !run.ok);
  const latencies = okRuns.map((run) => run.latency_ms).filter(Number.isFinite);
  const firstBytes = okRuns.map((run) => run.first_byte_ms).filter(Number.isFinite);
  const rssDeltas = runs.map((run) => run.memory_rss_delta_bytes).filter(Number.isFinite);
  const verifiedTrue = okRuns.filter((run) => run.verified === true).length;
  const verifiedFalse = okRuns.filter((run) => run.verified === false).length;
  const verifiedMissing = okRuns.filter((run) => run.verified !== true && run.verified !== false).length;
  const merkleRootPresent = okRuns.filter((run) => run.merkle_root_present).length;
  const requestIdPresent = runs.filter((run) => run.request_id_present).length;
  const modelReturns = countBy(okRuns.map((run) => run.model_returned || 'missing'));
  const laneSummary = Object.fromEntries(
    [...new Set(runs.map((run) => run.lane))].map((lane) => {
      const laneRuns = runs.filter((run) => run.lane === lane);
      const laneOk = laneRuns.filter((run) => run.ok);
      return [lane, {
        runs_total: laneRuns.length,
        runs_ok: laneOk.length,
        runs_fail: laneRuns.length - laneOk.length,
        latency_ms_ok: summarizeNumbers(laneOk.map((run) => run.latency_ms)),
      }];
    })
  );

  return {
    week: 23,
    kind: 'ambient-verification-at-scale-low-volume-probe',
    safety: {
      live_requests: runs.length,
      concurrency_max: options.concurrency,
      sustained_delay_ms: options.sustainedDelayMs,
      max_tokens_per_request: options.maxTokens,
      timeout_ms: options.timeoutMs,
      secret_handling: 'AMBIENT_API_KEY loaded from .env/process env; key is never printed or written',
      publication: 'local artifacts only; not published externally',
    },
    started_at: startedAt,
    finished_at: finishedAt,
    model_requested: options.model,
    base_url_host: new URL(options.baseUrl).host,
    hardware,
    metrics: {
      runs_total: runs.length,
      runs_ok: okRuns.length,
      runs_fail: failRuns.length,
      success_rate: runs.length ? Number((okRuns.length / runs.length).toFixed(3)) : null,
      verification_true_rate_ok_runs: okRuns.length ? Number((verifiedTrue / okRuns.length).toFixed(3)) : null,
      verified_true: verifiedTrue,
      verified_false: verifiedFalse,
      verified_missing: verifiedMissing,
      merkle_root_present_ok_runs: merkleRootPresent,
      request_id_present_runs: requestIdPresent,
      latency_ms_ok: summarizeNumbers(latencies),
      first_byte_ms_ok: summarizeNumbers(firstBytes),
      memory_rss_delta_bytes: summarizeNumbers(rssDeltas),
      failure_modes: countBy(failRuns.map((run) => run.failure_type)),
      model_returns: modelReturns,
      by_lane: laneSummary,
    },
  };
}

function renderMarkdown(artifact) {
  const m = artifact.summary.metrics;
  const latency = m.latency_ms_ok;
  const firstByte = m.first_byte_ms_ok;
  const mem = m.memory_rss_delta_bytes;
  const lines = [
    '# Week 23 Infra Loop — Ambient verification-at-scale low-volume probe',
    '',
    '## Scope and safety',
    `- Evidence window: ${artifact.summary.started_at} → ${artifact.summary.finished_at}`,
    `- Live requests: ${artifact.summary.safety.live_requests}`,
    `- Max concurrency: ${artifact.summary.safety.concurrency_max}`,
    `- Sustained-lane delay: ${artifact.summary.safety.sustained_delay_ms} ms`,
    `- Max tokens per request: ${artifact.summary.safety.max_tokens_per_request}`,
    '- No secrets, full model outputs, raw request ids, deployment changes, or external publication were used.',
    '',
    '## Metrics',
    `- Success rate: ${m.runs_ok}/${m.runs_total} (${m.success_rate})`,
    `- Verified true on OK runs: ${m.verified_true}/${m.runs_ok} (${m.verification_true_rate_ok_runs})`,
    `- Verified false / missing on OK runs: ${m.verified_false} / ${m.verified_missing}`,
    `- Merkle root present on OK runs: ${m.merkle_root_present_ok_runs}/${m.runs_ok}`,
    `- Request id header present: ${m.request_id_present_runs}/${m.runs_total}`,
    `- Latency OK runs: ${latency ? `min ${latency.min} / avg ${latency.avg} / median ${latency.median} / p95 ${latency.p95} / max ${latency.max} ms` : 'n/a'}`,
    `- First byte OK runs: ${firstByte ? `min ${firstByte.min} / avg ${firstByte.avg} / median ${firstByte.median} / p95 ${firstByte.p95} / max ${firstByte.max} ms` : 'n/a'}`,
    `- Local RSS delta per request: ${mem ? `min ${mem.min} / avg ${mem.avg} / median ${mem.median} / p95 ${mem.p95} / max ${mem.max} bytes` : 'n/a'}`,
    `- Failure modes: ${JSON.stringify(m.failure_modes)}`,
    `- Returned model labels: ${JSON.stringify(m.model_returns)}`,
    '',
    '## Lane breakdown',
    ...Object.entries(m.by_lane).map(([lane, s]) => `- ${lane}: ok/fail ${s.runs_ok}/${s.runs_fail}; latency ${s.latency_ms_ok ? `avg ${s.latency_ms_ok.avg} ms, max ${s.latency_ms_ok.max} ms` : 'n/a'}`),
    '',
    '## Per-run sanitized evidence',
    '| run | lane | ok | status | latency_ms | first_byte_ms | verified | merkle_root | request_id | output_chars | failure |',
    '|---:|---|---|---:|---:|---:|---|---|---|---:|---|',
    ...artifact.runs.map((run) => `| ${run.run_id} | ${run.lane} | ${run.ok} | ${run.status ?? ''} | ${run.latency_ms ?? ''} | ${run.first_byte_ms ?? ''} | ${run.verified ?? ''} | ${Boolean(run.merkle_root_present)} | ${Boolean(run.request_id_present)} | ${run.output_chars ?? ''} | ${run.failure_type || ''} |`),
    '',
    '## Interpretation',
    '- This is an operations smoke probe, not a load test or model-quality benchmark.',
    '- Low concurrency checks whether verification metadata remains visible under small sustained and concurrent workloads without stressing the API.',
    '- Local memory data describes the probe process RSS only; it is not Ambient server memory.',
    '',
    `JSON artifact: ${artifact.paths.json}`,
  ];
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = {
    outDir: getArg('out-dir', DEFAULT_OUT_DIR),
    model: getArg('model', process.env.AMBIENT_MODEL || 'ambient/large'),
    baseUrl: getArg('base-url', process.env.AMBIENT_BASE_URL || 'https://api.ambient.xyz/v1'),
    sustained: numberArg('sustained', 4, { min: 0, max: 12 }),
    concurrent: numberArg('concurrent', 4, { min: 0, max: 12 }),
    concurrency: numberArg('concurrency', 2, { min: 1, max: 3 }),
    sustainedDelayMs: numberArg('sustained-delay-ms', 1000, { min: 0, max: 10000 }),
    maxTokens: numberArg('max-tokens', 48, { min: 1, max: 128 }),
    timeoutMs: numberArg('timeout-ms', 90000, { min: 1000, max: 180000 }),
    dryRun: hasFlag('dry-run'),
  };

  const plannedRequests = options.sustained + options.concurrent;
  if (plannedRequests > 16) throw new Error('Safety guard: refusing to run more than 16 live requests');
  if (options.concurrency > 3) throw new Error('Safety guard: refusing concurrency above 3');

  fs.mkdirSync(options.outDir, { recursive: true });
  const startedAt = nowIso();
  const hardware = {
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus()?.length ?? null,
    totalmem_bytes: os.totalmem(),
    node: process.version,
  };

  if (!process.env.AMBIENT_API_KEY && !options.dryRun) {
    throw new Error('AMBIENT_API_KEY is not set in .env/process env; use --dry-run for local validation');
  }

  const prompts = Array.from({ length: plannedRequests }, (_, i) =>
    `Week 23 verification probe ${i + 1}: answer with exactly one short sentence about safe governance verification.`
  );

  const runs = [];
  if (options.dryRun) {
    for (let i = 0; i < plannedRequests; i += 1) {
      runs.push({
        run_id: i + 1,
        lane: i < options.sustained ? 'sustained' : 'concurrent',
        ok: true,
        status: 0,
        latency_ms: 0,
        first_byte_ms: 0,
        request_id_present: false,
        verified: null,
        merkle_root_present: false,
        output_chars: 0,
        memory_rss_before_bytes: process.memoryUsage().rss,
        memory_rss_after_bytes: process.memoryUsage().rss,
        memory_rss_delta_bytes: 0,
        failure_type: null,
      });
    }
  } else {
    for (let i = 0; i < options.sustained; i += 1) {
      runs.push(await callAmbient({
        runId: runs.length + 1,
        lane: 'sustained',
        model: options.model,
        maxTokens: options.maxTokens,
        timeoutMs: options.timeoutMs,
        baseUrl: options.baseUrl,
        prompt: prompts[i],
      }));
      if (i < options.sustained - 1 && options.sustainedDelayMs > 0) await sleep(options.sustainedDelayMs);
    }

    const concurrentTasks = Array.from({ length: options.concurrent }, (_, i) => () => callAmbient({
      runId: runs.length + i + 1,
      lane: 'concurrent',
      model: options.model,
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs,
      baseUrl: options.baseUrl,
      prompt: prompts[options.sustained + i],
    }));
    runs.push(...await runPool(concurrentTasks, options.concurrency));
  }

  const finishedAt = nowIso();
  const summary = buildSummary({ runs, startedAt, finishedAt, options, hardware });
  const artifact = {
    summary,
    runs,
    paths: {
      json: path.join(options.outDir, 'week23-ambient-verification-probe-output.json'),
      markdown: path.join(options.outDir, 'week23-ambient-verification-probe-report.md'),
    },
  };

  fs.writeFileSync(artifact.paths.json, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(artifact.paths.markdown, renderMarkdown(artifact));

  console.log(JSON.stringify({
    status: 'ok',
    dry_run: options.dryRun,
    json: artifact.paths.json,
    markdown: artifact.paths.markdown,
    metrics: summary.metrics,
  }, null, 2));
}

main().catch((error) => {
  console.error(redactErrorPreview(error?.stack || error?.message || error));
  process.exit(1);
});
