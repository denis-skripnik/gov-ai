import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseSseFrames } from './week24-builder-workflow.js';

const categories = ['infra', 'research', 'support'];
const hash = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const canonical = x => JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const system = 'You are an invoice reconciliation assistant. Return exactly one JSON object with keys count, total_cents, by_category (infra, research, support). No other keys, prose or markdown. For rows: accept only status paid with nonnegative integer amount_cents; exclude all other rows. Sum accepted rows and amounts per category. For summaries: add all counts, totals and categories. Use exact integer arithmetic.';

export function makeTasks(sizes = [16, 160]) {
  return sizes.map((n, shard) => ({ id: `shard_${shard}`, rows: Array.from({ length: n }, (_, i) => ({ id: `invoice-${shard}-${i}`, category: categories[i % 3], status: i % 7 === 0 ? 'void' : 'paid', amount_cents: i % 11 === 0 ? -5 : (i + 1) * 125 })) }));
}
export function oracle(rows) {
  const out = { count: 0, total_cents: 0, by_category: { infra: 0, research: 0, support: 0 } };
  for (const r of rows) if (r.status === 'paid' && Number.isSafeInteger(r.amount_cents) && r.amount_cents >= 0) {
    out.count++; out.total_cents += r.amount_cents; out.by_category[r.category] += r.amount_cents;
  }
  return out;
}
export class PreSendFailure extends Error {
  constructor() { super('INJECTED pre-send failure'); this.injected = true; }
}
// Only this wrapper knows that the underlying fetch was NOT called.
export function injectPreSendOnce(fetchImpl) {
  let pending = true;
  return async (...args) => { if (pending) { pending = false; throw new PreSendFailure(); } return fetchImpl(...args); };
}
function persist(file, value) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
// Allowlisted logging: never log key, prompt, arbitrary errors, headers or model prose.
function log(dir, job, event, details = {}) {
  const { attempt, status, latency_ms, injected } = details;
  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), job, event, attempt, status, latency_ms, injected }) + '\n', { mode: 0o600 });
}
function lock(dir) {
  const file = path.join(dir, 'workflow.lock');
  try { fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid lock; manual review required');
    try { process.kill(pid, 0); } catch (err) {
      if (err.code !== 'ESRCH') throw new Error('Workflow already locked');
      fs.unlinkSync(file); return lock(dir);
    }
    throw new Error('Workflow already locked');
  }
  return () => fs.unlinkSync(file);
}

export async function callAmbient({ input, apiKey, fetchImpl, model, maxTokens, timeoutMs }) {
  const started = Date.now(); const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const result = { output: null, output_sha256: null, request_id: null, model_returned: null, latency_ms: null, ttft_ms: null, usage: null, finish_reason: null, done: false, provenance: { status: 'unavailable', verified: null, merkle_root: null } };
  let text = ''; let first = null; let malformed = false;
  try {
    const res = await fetchImpl('https://api.ambient.xyz/v1/chat/completions', {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0, max_tokens: maxTokens, stream: true, emit_verified: true, emit_ambient_events: true, emit_usage: true, wait_for_verification: true, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }] }),
    });
    // Header identifiers are bounded and sanitized rather than copying raw headers.
    const id = res.headers.get('x-request-id');
    result.request_id = id && /^[a-zA-Z0-9._:-]{1,160}$/.test(id) ? id : null;
    result.http_status = res.status;
    if (!res.ok) {
      await res.body?.cancel();
      return { ...result, outcome: res.status >= 500 ? 'ambiguous' : 'rejected', reason: `http_${res.status}` };
    }
    if (!res.headers.get('content-type')?.includes('text/event-stream')) {
      await res.body?.cancel(); return { ...result, outcome: 'ambiguous', reason: 'unexpected_content_type' };
    }
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let bytes = 0;
    const frame = value => {
      if (value === '[DONE]') { result.done = true; return; }
      let obj; try { obj = JSON.parse(value); } catch { malformed = true; return; }
      if (obj.error) malformed = true;
      if (obj.model && /^[a-zA-Z0-9/._:-]{1,160}$/.test(obj.model)) result.model_returned = obj.model;
      if (obj.usage) result.usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].filter(k => Number.isFinite(obj.usage[k])).map(k => [k, obj.usage[k]]));
      if (typeof obj.verified === 'boolean') result.provenance.verified = obj.verified;
      if (typeof obj.merkle_root === 'string' && /^(0x)?[a-fA-F0-9]{64}$/.test(obj.merkle_root)) result.provenance.merkle_root = obj.merkle_root;
      for (const choice of obj.choices || []) {
        if (choice.index && choice.index !== 0) continue;
        if (typeof choice.delta?.content === 'string') { text += choice.delta.content; if (text && first === null) first = Date.now() - started; }
        if (choice.finish_reason != null) result.finish_reason = choice.finish_reason;
      }
    };
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > 2_000_000) { await reader.cancel(); throw new Error('stream_limit'); }
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseFrames(buffer); buffer = parsed.remainder; for (const f of parsed.data) frame(f);
    }
    buffer += decoder.decode(); if (buffer.trim()) for (const f of parseSseFrames(`${buffer}\n\n`).data) frame(f);
    result.output_sha256 = hash(text); result.ttft_ms = first;
    try { result.output = JSON.parse(text.trim()); } catch { /* no raw output persisted */ }
    const p = result.provenance;
    p.status = p.verified === true && p.merkle_root ? 'provider_reported_verified' : p.verified !== null || p.merkle_root ? 'partial' : 'unavailable';
    return { ...result, outcome: 'received', reason: malformed ? 'malformed_stream' : !result.done ? 'missing_done' : result.finish_reason !== 'stop' ? 'not_stop' : !result.output ? 'invalid_json' : null, latency_ms: Date.now() - started };
  } catch (error) {
    return { ...result, outcome: error instanceof PreSendFailure ? 'pre_send' : 'ambiguous', reason: error instanceof PreSendFailure ? 'INJECTED_pre_send' : controller.signal.aborted ? 'timeout_after_dispatch' : 'transport_after_dispatch', injected: error instanceof PreSendFailure, latency_ms: Date.now() - started };
  } finally { clearTimeout(timer); }
}

export async function runWorkflow({ dir, apiKey = process.env.AMBIENT_API_KEY, fetchImpl = globalThis.fetch, model = 'ambient/large', concurrency = 2, maxTokens = 2400, timeoutMs = 180000, retryDelayMs = 250 } = {}) {
  for (const [name, value, min, max] of [['concurrency', concurrency, 1, 2], ['maxTokens', maxTokens, 1, 4000], ['timeoutMs', timeoutMs, 1, 300000], ['retryDelayMs', retryDelayMs, 0, 60000]]) if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  if (!dir || !apiKey) throw new Error('dir and AMBIENT_API_KEY required');
  fs.mkdirSync(dir, { recursive: true }); const release = lock(dir);
  try {
    const tasks = makeTasks(); const file = path.join(dir, 'state.json');
    const fingerprint = hash({ tasks, system, model, maxTokens, timeoutMs });
    let state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { kind: 'week28-real-invoice-reconciliation', fingerprint, started_at: new Date().toISOString(), configuration: { model, concurrency, max_tokens: maxTokens, timeout_ms: timeoutMs, maximum_live_posts: 3, pre_send_attempts_max: 2 }, jobs: Object.fromEntries([...tasks.map(t => t.id), 'consolidate'].map(id => [id, { status: 'pending', attempts: 0 }])), limitations: ['Public synthetic invoice INPUT; outputs in live mode come from real Ambient API.', 'Provider-reported provenance is not cryptographically verified here and does not prove factual correctness.', 'No miner, wallet, slashing or settlement claims. No automatic ambiguous POST retries.', 'Single-host durable state and PID lock; not a distributed queue. Long request measured, never made slow by injected delay.'] };
    if (state.fingerprint !== fingerprint) throw new Error('State configuration mismatch');
    const save = () => persist(file, state);
    for (const [id, job] of Object.entries(state.jobs)) if (job.status === 'dispatching') { job.status = 'ambiguous'; job.reason = 'restart_inflight_requires_manual_reconciliation'; log(dir, id, 'restart_hold'); }
    save();
    async function execute(id, input, expected) {
      const job = state.jobs[id]; if (job.status !== 'pending') return;
      while (job.attempts < 2) {
        job.attempts++; job.status = 'dispatching'; save(); log(dir, id, 'dispatch', { attempt: job.attempts });
        const result = await callAmbient({ input, apiKey, fetchImpl, model, maxTokens, timeoutMs });
        log(dir, id, result.outcome, { attempt: job.attempts, status: result.http_status, latency_ms: result.latency_ms, injected: result.injected });
        if (result.outcome === 'pre_send') {
          job.status = job.attempts < 2 ? 'pending' : 'failed'; job.reason = result.reason; save();
          if (job.status === 'pending') { await new Promise(r => setTimeout(r, retryDelayMs)); continue; }
        } else {
          job.oracle_match = result.output !== null && canonical(result.output) === canonical(expected);
          // Persist only exact numeric oracle output; never retain arbitrary model prose/JSON.
          if (!job.oracle_match) result.output = null;
          job.result = result;
          job.status = result.outcome === 'ambiguous' ? 'ambiguous' : result.outcome === 'received' && !result.reason && job.oracle_match ? 'complete' : 'failed';
          job.reason = result.reason || (job.oracle_match ? null : 'oracle_mismatch'); save();
        }
        break;
      }
    }
    for (let i = 0; i < tasks.length; i += concurrency) await Promise.all(tasks.slice(i, i + concurrency).map(t => execute(t.id, { rows: t.rows }, oracle(t.rows))));
    if (tasks.every(t => state.jobs[t.id].status === 'complete')) await execute('consolidate', { summaries: tasks.map(t => state.jobs[t.id].result.output) }, oracle(tasks.flatMap(t => t.rows)));
    else if (state.jobs.consolidate.status === 'pending') { state.jobs.consolidate.status = 'blocked'; state.jobs.consolidate.reason = 'dependency_not_accepted'; }
    state.status = Object.values(state.jobs).every(j => j.status === 'complete') ? 'complete' : 'needs_review';
    state.updated_at = new Date().toISOString(); state.elapsed_ms = Date.now() - Date.parse(state.started_at); save(); return state;
  } finally { release(); }
}

// Gated integration: this is the SAME analyzer used by gov-ai.js and bot/run-analysis.js.
// No fetcher, bot deployment, real queue store, routing folders or production reports are touched.
export async function runProductionFixture({ dir, apiKey = process.env.AMBIENT_API_KEY, fetchImpl = globalThis.fetch, inject = false, maxTokens = 4000, timeoutMs = 180000 } = {}) {
  if (!dir || !apiKey || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4000 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error('Invalid production fixture configuration');
  fs.mkdirSync(dir, { recursive: true }); const release = lock(dir);
  const file = path.join(dir, 'production-state.json');
  const extracted = { title: 'Documentation glossary correction', body: 'Replace the glossary spelling "goverance" with "governance". No other changes. Voting options and current results were not provided.', options: [], current_results: null, metadata: {}, source_type: 'generic' };
  const url = 'https://example.invalid/week28-public-fixture';
  const principles = { version: 1, user_profile: { risk_tolerance: 'low', time_horizon: 'years' }, governance_values: { transparency_priority: 'high' }, preferences: { needs_strict_spec: true, avoid_admin_key_changes: true } };
  const fingerprint = hash({ extracted, principles, maxTokens, timeoutMs });
  let timer;
  try {
    if (fs.existsSync(file)) {
      const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (prior.fingerprint !== fingerprint) throw new Error('Production fixture configuration mismatch');
      if (prior.status === 'dispatching') { prior.status = 'ambiguous'; prior.reason = 'restart_inflight_requires_manual_reconciliation'; persist(file, prior); }
      return prior;
    }
    const state = { kind: 'week28-gov-ai-core-analysis-fixture', fingerprint, started_at: new Date().toISOString(), status: 'pending', attempts: 0, live_posts: 0, fixture: { url, extracted, principles }, oracle_checks: [], provenance: { status: 'unavailable', verified: null, merkle_root: null }, transport: { finish_reason: null, done: false, latency_ms: null, ttft_ms: null, usage: null, request_id: null }, limitations: ['Real analyzeWithLLM, classifyVerificationHooks, runMultiAgentCouncil and buildTelegramSummary code; extraction fixture is synthetic public input.', 'No URL fetch, queue worker, Telegram send, bot deployment, report routing or production data writes.', 'Single live POST max. Explicitly disables analyzer legacy network retries and financial multi-node dispatch in this gated fixture.', 'Oracle verifies missing-data/input preservation, not subjective recommendation reasoning or cryptographic inference provenance.'] };
    const save = () => persist(file, state); save();
    const controller = new AbortController(); let text = ''; let buffer = ''; let bytes = 0; let started;
    const underlying = inject ? injectPreSendOnce(fetchImpl) : fetchImpl;
    const frame = f => {
      if (f === '[DONE]') { state.transport.done = true; return; }
      let obj; try { obj = JSON.parse(f); } catch { state.reason = 'malformed_stream'; throw new Error('Week28 incomplete stream'); }
      if (obj.error) { state.reason = 'stream_error'; throw new Error('Week28 stream error'); }
      if (typeof obj.verified === 'boolean') state.provenance.verified = obj.verified;
      if (typeof obj.merkle_root === 'string' && /^(0x)?[a-fA-F0-9]{64}$/.test(obj.merkle_root)) state.provenance.merkle_root = obj.merkle_root;
      if (obj.usage) state.transport.usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].filter(k => Number.isFinite(obj.usage[k])).map(k => [k, obj.usage[k]]));
      const c = obj.choices?.[0];
      if (typeof c?.delta?.content === 'string') { text += c.delta.content; if (text && state.transport.ttft_ms === null) state.transport.ttft_ms = Date.now() - started; }
      if (c?.finish_reason != null) state.transport.finish_reason = ['stop', 'length', 'content_filter', 'tool_calls'].includes(c.finish_reason) ? c.finish_reason : 'other';
    };
    const guardedFetch = async (target, init) => {
      if (target !== 'https://api.ambient.xyz/v1/chat/completions' || init.method !== 'POST' || state.live_posts >= 1) throw new Error('Week28 dispatch boundary blocked');
      for (let i = 0; i < 2; i++) {
        state.attempts++; state.status = 'dispatching'; save(); log(dir, 'production-analysis', 'dispatch', { attempt: state.attempts });
        try {
          started = Date.now(); timer = setTimeout(() => controller.abort(), timeoutMs);
          const response = await underlying(target, { ...init, signal: controller.signal });
          state.live_posts++; save();
          const id = response.headers.get('x-request-id'); state.transport.request_id = id && /^[a-zA-Z0-9._:-]{1,160}$/.test(id) ? id : null;
          state.transport.http_status = response.status;
          if (!response.ok) { state.reason = `http_${response.status}`; await response.body?.cancel(); throw new Error('Week28 provider rejected request'); }
          if (!response.headers.get('content-type')?.includes('text/event-stream')) { state.reason = 'unexpected_content_type'; await response.body?.cancel(); throw new Error('Week28 protocol mismatch'); }
          const decoder = new TextDecoder();
          return new Response(response.body.pipeThrough(new TransformStream({
            transform(chunk, sink) {
              bytes += chunk.byteLength;
              if (bytes > 2_000_000) { state.reason = 'stream_limit'; throw new Error('Week28 stream limit'); }
              buffer += decoder.decode(chunk, { stream: true });
              const parsed = parseSseFrames(buffer); buffer = parsed.remainder; for (const f of parsed.data) frame(f);
              sink.enqueue(chunk);
            },
            flush() {
              buffer += decoder.decode();
              // Unlike legacy sseDataLines, inspect the final frame too.
              if (buffer.trim()) for (const f of parseSseFrames(`${buffer}\n\n`).data) frame(f);
              state.transport.latency_ms = Date.now() - started;
              state.output_sha256 = hash(text);
              if (!state.transport.done || state.transport.finish_reason !== 'stop') { state.reason = !state.transport.done ? 'missing_done' : 'not_stop'; throw new Error('Week28 incomplete stream'); }
              // Match the production analyzer's supported whole-object JSON fence framing.
              const jsonText = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
              state.transport.json_fenced = text.trim().startsWith('```');
              try { const parsed = JSON.parse(jsonText); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); } catch { state.reason = 'invalid_json'; throw new Error('Week28 invalid JSON'); }
            },
          })), { status: response.status, headers: response.headers });
        } catch (e) {
          if (e instanceof PreSendFailure) {
            clearTimeout(timer); state.status = 'pending'; log(dir, 'production-analysis', 'INJECTED_pre_send', { attempt: state.attempts, injected: true }); save();
            if (i === 0) { await new Promise(r => setTimeout(r, 250)); continue; }
          } else if (!state.reason) { state.live_posts = Math.max(state.live_posts, 1); save(); }
          throw new Error('Week28 dispatch held');
        }
      }
    };
    try {
      const { analyzeWithLLM, classifyVerificationHooks } = await import('./analyzer.js');
      const { runMultiAgentCouncil } = await import('./week17-multi-agent.js');
      const { buildTelegramSummary } = await import('./bot/summary.js');
      const report = await analyzeWithLLM(url, extracted, principles, { apiKey, fetchImpl: guardedFetch, retry: false, skipFinancialCheck: true, stream: true, model: 'ambient/large', maxTokens });
      const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;
      const strings = value => Array.isArray(value) && value.every(nonEmpty);
      const shapeValid = report.version === 1 && report.input?.url === url && report.input?.source_type === extracted.source_type
        && nonEmpty(report.analysis?.summary) && strings(report.analysis?.key_changes)
        && strings(report.analysis?.risks) && strings(report.analysis?.benefits)
        && strings(report.analysis?.unknowns) && strings(report.analysis?.evidence_quotes)
        && nonEmpty(report.recommendation?.reasoning)
        && ['low', 'medium', 'high'].includes(report.recommendation?.confidence)
        && strings(report.recommendation?.conflicts_with_user_principles)
        && strings(report.limitations);
      state.oracle_checks = [
        { name: 'title_preserved', pass: report.extracted?.title === extracted.title },
        { name: 'body_preserved', pass: report.extracted?.body === extracted.body },
        { name: 'no_invented_options', pass: canonical(report.extracted?.options) === '[]' },
        { name: 'no_invented_results', pass: report.extracted?.current_results === null },
        { name: 'missing_options_recommendation_UNKNOWN', pass: report.recommendation?.suggested_option === 'UNKNOWN' },
        { name: 'report_shape_and_identity_valid', pass: shapeValid },
      ];
      if (state.oracle_checks.every(c => c.pass)) {
        const hooks = classifyVerificationHooks(report, extracted, { strictMode: true });
        const council = runMultiAgentCouncil({ proposal: extracted, report, source: { mode: 'week28-real-core-analysis' } });
        const summary = buildTelegramSummary({ ...report, verification_hooks: hooks }, path.join(dir, 'production-report.json'));
        state.pipeline = { verification_hooks: hooks, council: { status: council.shared_memory?.verification?.status || null, suggested_option: council.shared_memory?.decision?.suggested_option || null, agent_count: council.run?.agent_count || null }, bot_summary_built: typeof summary.text === 'string' && summary.text.includes('Recommendation:') };
        state.status = state.pipeline.bot_summary_built ? 'complete' : 'needs_review';
      } else {
        state.status = 'needs_review';
        state.pipeline = null;
      }
      // Fixture is public; still redact model strings and the exact key before saving.
      const clean = value => typeof value === 'string' ? value.split(apiKey).join('[REDACTED]').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]') : Array.isArray(value) ? value.map(clean) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)])) : value;
      persist(path.join(dir, 'production-report.json'), clean(report));
      state.pipeline = clean(state.pipeline);
    } catch {
      state.status = state.reason ? 'needs_review' : 'ambiguous'; state.reason ||= controller.signal.aborted ? 'timeout_after_dispatch' : 'transport_after_dispatch';
    }
    // Pipeline completion never overrides production's independent HUMAN_REVIEW routing.
    state.automation_ready = state.status === 'complete' && state.pipeline?.verification_hooks?.routing_action !== 'HUMAN_REVIEW';
    state.limitations.push('Analyzer prompt_used_files.principles hashes its default file, not this inline fixture; fixture/principles in this state are authoritative. Local council status verified is NOT Ambient provenance.');
    const p = state.provenance; p.status = p.verified === true && p.merkle_root ? 'provider_reported_verified' : p.verified !== null || p.merkle_root ? 'partial' : 'unavailable';
    state.transport.latency_ms ??= started ? Date.now() - started : null;
    state.updated_at = new Date().toISOString(); state.elapsed_ms = Date.now() - Date.parse(state.started_at);
    log(dir, 'production-analysis', state.status, { latency_ms: state.transport.latency_ms }); save(); return state;
  } finally { clearTimeout(timer); release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dir = process.argv[2];
  runWorkflow({ dir }).then(result => { console.log(JSON.stringify({ status: result.status, elapsed_ms: result.elapsed_ms, jobs: Object.fromEntries(Object.entries(result.jobs).map(([k, j]) => [k, { status: j.status, attempts: j.attempts, latency_ms: j.result?.latency_ms, oracle_match: j.oracle_match, provenance: j.result?.provenance?.status }])) }, null, 2)); process.exitCode = result.status === 'complete' ? 0 : 2; }).catch(() => { console.error('Week28 failed: inspect sanitized state or check configuration; no secrets logged'); process.exitCode = 2; });
}
