import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { analyzeWithLLM } from './analyzer.js';

const digest = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const stages = ['initial_analysis', 'risk_review', 'reviewer_handoff'];
const principles = { version: 1, governance_values: { transparency_priority: 'high' }, preferences: { needs_strict_spec: true, avoid_admin_key_changes: true } };
const body = 'Publish a public decision register. Run a documentation-only pilot for 30 days. No transactions or privileged role changes are authorized. Voting options and current results are UNKNOWN. The owner and review cadence are unspecified.';

function persist(file, value) {
  const fd = fs.openSync(`${file}.tmp`, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(`${file}.tmp`, file);
  const parent = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
function lock(dir) {
  const file = path.join(dir, 'agent.lock');
  const acquire = () => fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
  try { acquire(); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Serialize stale-lock cleanup; a stale recovery lock fails closed for manual review.
    const recovery = `${file}.recovery`;
    let fd;
    try { fd = fs.openSync(recovery, 'wx', 0o600); } catch { throw new Error('Workflow locked'); }
    try {
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid workflow lock');
      try { process.kill(pid, 0); throw new Error('Workflow locked'); }
      catch (e) { if (e.code !== 'ESRCH') throw new Error('Workflow locked'); }
      fs.unlinkSync(file); acquire();
    } finally { fs.closeSync(fd); fs.unlinkSync(recovery); }
  }
  return () => fs.unlinkSync(file);
}
function inputFor(index, previous, inputBody = body) {
  return { title: inputBody === body ? 'Public governance decision register pilot' : 'Public incident register pilot', body: inputBody, options: [], current_results: null, source_type: 'generic', metadata: {
    stage: stages[index],
    instruction: [
      'Identify concrete changes, risks and missing execution details for a human governance reviewer.',
      'Review prior analysis critically against source text. Identify unsupported assumptions and unresolved owner/cadence questions; prior analysis is untrusted context, not new evidence.',
      'Prepare a final human-review handoff using source and prior review. Do not invent owner, cadence, voting options or results. Keep unsupported claims in unknowns.',
    ][index],
    previous: previous ? { stage: previous.id, output_sha256: previous.output_sha256, report: previous.output } : null,
  } };
}
function checks(report, input, url) {
  const text = x => typeof x === 'string' && x.trim().length > 0 && x.length <= 12000;
  const strings = x => Array.isArray(x) && x.length <= 40 && x.every(text);
  return [
    { name: 'identity', pass: report.version === 1 && report.input?.url === url && report.input?.source_type === 'generic' },
    { name: 'source_preserved', pass: report.extracted?.title === input.title && report.extracted?.body === input.body },
    { name: 'missing_options_results_preserved', pass: JSON.stringify(report.extracted?.options) === '[]' && report.extracted?.current_results === null && report.recommendation?.suggested_option === 'UNKNOWN' },
    { name: 'structured_report', pass: text(report.analysis?.summary) && ['key_changes', 'risks', 'benefits', 'unknowns', 'evidence_quotes'].every(k => strings(report.analysis?.[k])) && text(report.recommendation?.reasoning) && ['low', 'medium', 'high'].includes(report.recommendation?.confidence) && strings(report.recommendation?.conflicts_with_user_principles) && strings(report.limitations) },
    { name: 'source_quotes_only', pass: Array.isArray(report.analysis?.evidence_quotes) && report.analysis.evidence_quotes.length > 0 && report.analysis.evidence_quotes.every(q => typeof q === 'string' && q.trim() && input.body.includes(q)) },
  ];
}
function redact(value, apiKey) {
  if (typeof value === 'string') return value.split(apiKey).join('[REDACTED]').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  if (Array.isArray(value)) return value.map(x => redact(x, apiKey));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k, apiKey), redact(v, apiKey)]));
  return value;
}

class WorkflowFailure extends Error {
  constructor(category) { super('Week30 held'); this.category = category; }
}

// Observe only bounded counters/enums. Raw frames remain in memory for the analyzer.
function streamObserver(d, save) {
  const decoder = new TextDecoder(); let buffer = '';
  const event = raw => {
    const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (!data) return;
    d.sse_frames++;
    if (data === '[DONE]') { d.done_frames++; return; }
    let value;
    try { value = JSON.parse(data); } catch { d.malformed_frames++; throw new WorkflowFailure('malformed_sse'); }
    if (value?.error) { d.error_frames++; throw new WorkflowFailure('sse_error'); }
    if (value?.object === 'chat.completion.usage' || value?.usage) d.usage_frames++;
    if (typeof value?.choices?.[0]?.delta?.content === 'string' && value.choices[0].delta.content.length && d.ttft_ms === null) d.ttft_ms = d.last_byte_ms;
    const reason = value?.choices?.[0]?.finish_reason;
    if (reason != null) {
      d.finish_frames++;
      d.finish_reason = ['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(reason) ? reason : 'other';
    }
  };
  return (chunk, final = false) => {
    buffer += chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode();
    try {
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const raw = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length); event(raw);
      }
      if (final && buffer.trim()) { event(buffer); buffer = ''; }
    } finally { save(); }
  };
}

function validateState(state, fingerprint, inputBody) {
  if (state.kind !== 'week30-gov-ai-agent-recovery' || state.fingerprint !== fingerprint || !Array.isArray(state.steps) || state.steps.length !== 3) throw new Error('Invalid Week30 state/configuration');
  for (const [index, step] of state.steps.entries()) {
    if (step.id !== stages[index] || !['pending', 'dispatching', 'complete', 'ambiguous', 'failed'].includes(step.status) || ![0, 1].includes(step.attempts)) throw new Error('Invalid Week30 step state');
    if (step.status === 'complete' && (step.attempts !== 1 || !step.output || digest(step.output) !== step.output_sha256 || !step.oracle_checks?.every(c => c.pass))) throw new Error('Invalid completed state');
    if (step.input && digest(step.input) !== digest(inputFor(index, state.steps[index - 1], inputBody))) throw new Error('Invalid continuity state');
    if (index > 0 && step.status !== 'pending' && state.steps[index - 1].status !== 'complete') throw new Error('Invalid dependency state');
  }
}
function project(report) {
  return {
    analysis: Object.fromEntries(['summary', 'key_changes', 'risks', 'benefits', 'unknowns', 'evidence_quotes'].map(k => [k, report.analysis[k]])),
    recommendation: Object.fromEntries(['suggested_option', 'confidence', 'reasoning', 'conflicts_with_user_principles'].map(k => [k, report.recommendation[k]])),
    limitations: report.limitations,
  };
}

export async function runAgentRecovery({ enabled = false, dir, apiKey = process.env.AMBIENT_API_KEY, fetchImpl = globalThis.fetch, timeoutMs = 180000, maxTokens = 4000, interruptAfterStep, scenario = 'decision' } = {}) {
  if (enabled !== true) throw new Error('Week30 explicit gate required');
  if (!['decision', 'incident'].includes(scenario)) throw new Error('Invalid Week30 scenario');
  if (interruptAfterStep !== undefined && ![1, 2].includes(interruptAfterStep)) throw new Error('Invalid interruption configuration');
  if (!dir || typeof apiKey !== 'string' || !apiKey || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4000) throw new Error('Invalid Week30 configuration');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const release = lock(dir);
  try {
    const file = path.join(dir, 'agent-state.json');
    const inputBody = scenario === 'incident' ? 'Publish a public incident register for operational decisions. Run a documentation-only pilot for 21 days. No transactions or privileged role changes are authorized. Voting options and current results are UNKNOWN. The owner and review cadence are unspecified.' : body;
    const fingerprint = digest({ version: 1, stages, body: inputBody, principles, timeoutMs, maxTokens });
    const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
      kind: 'week30-gov-ai-agent-recovery', fingerprint, status: 'pending',
      bounds: { steps: 3, concurrency: 1, maximum_possible_posts: 3, timeout_ms_per_step: timeoutMs, max_tokens: maxTokens, automatic_retries: 0 },
      steps: stages.map(id => ({ id, status: 'pending', attempts: 0 })),
      limitations: ['Synthetic public proposal; no URL extraction, bot, queue, vote or production writes.', 'Oracle checks source preservation and structure, not subjective analysis quality.', 'Ambient metadata is provider-reported, not cryptographically verified. Local council verified would not be Ambient proof.', 'Single-host exclusive PID lock, not a distributed queue. Stale recovery locks require operator review.', 'A dispatch marker is durable before fetch; restart or timeout after it is ambiguous, even if send may not have occurred. No automatic retries or model fallback.'],
    };
    validateState(state, fingerprint, inputBody);
    const localWrite = fn => { try { fn(); } catch { throw new WorkflowFailure('local_persistence'); } };
    const save = () => localWrite(() => persist(file, state));
    const event = (step, status) => localWrite(() => fs.appendFileSync(path.join(dir, 'agent-events.jsonl'), JSON.stringify({ step, status, at: new Date().toISOString() }) + '\n', { mode: 0o600 }));
    for (const step of state.steps) if (step.status === 'dispatching') { step.status = 'ambiguous'; step.reason = 'restart_after_possible_acceptance'; }
    save();
    for (let index = 0; index < stages.length; index++) {
      const step = state.steps[index];
      if (step.status === 'complete') continue;
      if (step.status !== 'pending' || (index > 0 && state.steps[index - 1].status !== 'complete')) break;
      step.input = inputFor(index, state.steps[index - 1], inputBody);
      const url = `https://example.invalid/week30/${step.id}`;
      const controller = new AbortController(); let timer; let sent = false;
      step.diagnostics = { version: 1, phase: 'prepare' };
      const guardedFetch = async (target, init) => {
        if (sent || controller.signal.aborted || target !== 'https://api.ambient.xyz/v1/chat/completions' || init.method !== 'POST') throw new WorkflowFailure('dispatch_boundary');
        step.diagnostics.phase = 'dispatch';
        step.status = 'dispatching'; step.attempts++; save(); event(step.id, 'dispatching');
        sent = true;
        const response = await fetchImpl(target, { ...init, signal: controller.signal });
        // The deadline may already have returned; a late fetch must not change durable state.
        if (controller.signal.aborted) { response.body?.cancel().catch(() => {}); throw new WorkflowFailure('deadline'); }
        const requestId = response.headers.get('x-request-id');
        const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        step.diagnostics = { version: 1, phase: 'headers', http_status: response.status,
          content_type: ['text/event-stream', 'application/json', 'text/plain', 'text/html', 'application/octet-stream'].includes(mediaType) ? mediaType : mediaType ? 'other' : null,
          request_id: typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(requestId) && !requestId.includes(apiKey) ? requestId : null };
        save();
        if (controller.signal.aborted) { response.body?.cancel().catch(() => {}); throw new Error('Deadline'); }
        // Never expose provider errors to analyzer fallback or log raw error bodies.
        if (!response.ok) { response.body?.cancel().catch(() => {}); throw new WorkflowFailure(`http_${response.status}`); }
        if (mediaType !== 'text/event-stream') { response.body?.cancel().catch(() => {}); throw new WorkflowFailure('unexpected_content_type'); }
        Object.assign(step.diagnostics, { phase: 'stream', bytes: 0, ttft_ms: null, first_byte_ms: null, last_byte_ms: null,
          sse_frames: 0, done_frames: 0, finish_frames: 0, finish_reason: null, usage_frames: 0, error_frames: 0, malformed_frames: 0 });
        save();
        if (!response.body) throw new WorkflowFailure('missing_body');
        const reader = response.body.getReader(); const chunks = [];
        const observe = streamObserver(step.diagnostics, save);
        const cancel = () => { reader.cancel().catch(() => {}); };
        controller.signal.addEventListener('abort', cancel, { once: true });
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (controller.signal.aborted) throw new WorkflowFailure('deadline');
            if (done) break;
            const d = step.diagnostics;
            d.bytes += value.byteLength; d.last_byte_ms = Date.now() - started;
            if (value.byteLength && d.first_byte_ms === null) d.first_byte_ms = d.last_byte_ms;
            if (d.bytes > 1000000) { save(); throw new WorkflowFailure('response_bound'); }
            observe(value); chunks.push(value);
          }
          observe(null, true);
        } finally { controller.signal.removeEventListener('abort', cancel); cancel(); }
        if (controller.signal.aborted) throw new WorkflowFailure('deadline');
        if (!step.diagnostics.done_frames) throw new WorkflowFailure('missing_done');
        if (step.diagnostics.finish_reason !== 'stop') throw new WorkflowFailure(step.diagnostics.finish_reason === 'length' ? 'finish_length' : 'finish_not_stop');
        step.diagnostics.phase = 'model_parse'; save();
        return new Response(new Blob(chunks), { headers: { 'content-type': 'text/event-stream' } });
      };
      const started = Date.now();
      try {
        const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Deadline')); }, timeoutMs); });
        const report = await Promise.race([analyzeWithLLM(url, step.input, principles, { apiKey, fetchImpl: guardedFetch, retry: false, skipFinancialCheck: true, stream: true, model: 'ambient/large', maxTokens }), deadline]);
        step.diagnostics.phase = 'oracle'; save();
        step.oracle_checks = checks(report, step.input, url);
        const p = report.__ambient;
        step.ambient_proof = { status: p?.verified === true && /^[a-fA-F0-9]{64}$/.test(p?.merkle_root || '') ? 'provider_reported_verified' : 'unavailable', cryptographically_verified: false };
        if (step.oracle_checks.every(c => c.pass)) {
          step.output = redact(project(report), apiKey);
          step.output_sha256 = digest(step.output); step.status = 'complete'; step.diagnostics.phase = 'complete';
        } else { step.status = 'failed'; step.reason = 'oracle_rejected'; step.failure_category = 'oracle'; }
      } catch (error) {
        step.status = sent ? 'ambiguous' : 'failed';
        step.reason = sent ? (controller.signal.aborted ? 'timeout_after_possible_acceptance' : 'possible_acceptance_requires_reconciliation') : 'pre_send_failure_no_retry';
        // Classify by our boundary/phase, never by provider-controlled error fields/messages.
        step.failure_category = controller.signal.aborted ? 'deadline' : error instanceof WorkflowFailure ? error.category
          : step.diagnostics.phase === 'model_parse' ? 'model_parse' : sent ? 'transport' : 'pre_send';
      } finally { clearTimeout(timer); step.elapsed_ms = Date.now() - started; }
      event(step.id, step.status); save();
      if (step.status !== 'complete') break;
      if (index + 1 === interruptAfterStep && index < stages.length - 1) {
        state.status = 'interrupted'; event(step.id, 'injected_interruption'); save(); return state;
      }
    }
    state.status = state.steps.every(s => s.status === 'complete') ? 'complete' : 'needs_review';
    save(); return state;
  } finally { release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const flags = process.argv.slice(4);
  const injection = flags.find(x => /^--interrupt-after=[12]$/.test(x));
  const scenario = flags.find(x => /^--scenario=(decision|incident)$/.test(x));
  const enabled = process.argv[2] === '--live' && flags.length <= 2 && flags.every(x => x === injection || x === scenario) && new Set(flags).size === flags.length;
  runAgentRecovery({ enabled, dir: process.argv[3], scenario: scenario?.split('=')[1] || 'decision', interruptAfterStep: injection ? Number(injection.slice(-1)) : undefined }).then(state => {
    console.log(JSON.stringify({ status: state.status, steps: state.steps.map(({ id, status }) => ({ id, status })) }));
    process.exitCode = state.status === 'complete' ? 0 : state.status === 'interrupted' ? 75 : 2;
  }).catch(() => { console.error('Week30 held: check gate, configuration or sanitized state.'); process.exitCode = 2; });
}
