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
function inputFor(index, previous) {
  return { title: 'Public governance decision register pilot', body, options: [], current_results: null, source_type: 'generic', metadata: {
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

function validateState(state, fingerprint) {
  if (state.kind !== 'week30-gov-ai-agent-recovery' || state.fingerprint !== fingerprint || !Array.isArray(state.steps) || state.steps.length !== 3) throw new Error('Invalid Week30 state/configuration');
  for (const [index, step] of state.steps.entries()) {
    if (step.id !== stages[index] || !['pending', 'dispatching', 'complete', 'ambiguous', 'failed'].includes(step.status) || ![0, 1].includes(step.attempts)) throw new Error('Invalid Week30 step state');
    if (step.status === 'complete' && (step.attempts !== 1 || !step.output || digest(step.output) !== step.output_sha256 || !step.oracle_checks?.every(c => c.pass))) throw new Error('Invalid completed state');
    if (step.input && digest(step.input) !== digest(inputFor(index, state.steps[index - 1]))) throw new Error('Invalid continuity state');
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

export async function runAgentRecovery({ enabled = false, dir, apiKey = process.env.AMBIENT_API_KEY, fetchImpl = globalThis.fetch, timeoutMs = 180000, maxTokens = 4000, interruptAfterStep } = {}) {
  if (enabled !== true) throw new Error('Week30 explicit gate required');
  if (interruptAfterStep !== undefined && ![1, 2].includes(interruptAfterStep)) throw new Error('Invalid interruption configuration');
  if (!dir || typeof apiKey !== 'string' || !apiKey || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4000) throw new Error('Invalid Week30 configuration');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const release = lock(dir);
  try {
    const file = path.join(dir, 'agent-state.json');
    const fingerprint = digest({ version: 1, stages, body, principles, timeoutMs, maxTokens });
    const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
      kind: 'week30-gov-ai-agent-recovery', fingerprint, status: 'pending',
      bounds: { steps: 3, concurrency: 1, maximum_possible_posts: 3, timeout_ms_per_step: timeoutMs, max_tokens: maxTokens, automatic_retries: 0 },
      steps: stages.map(id => ({ id, status: 'pending', attempts: 0 })),
      limitations: ['Synthetic public proposal; no URL extraction, bot, queue, vote or production writes.', 'Oracle checks source preservation and structure, not subjective analysis quality.', 'Ambient metadata is provider-reported, not cryptographically verified. Local council verified would not be Ambient proof.', 'Single-host exclusive PID lock, not a distributed queue. Stale recovery locks require operator review.', 'A dispatch marker is durable before fetch; restart or timeout after it is ambiguous, even if send may not have occurred. No automatic retries or model fallback.'],
    };
    validateState(state, fingerprint);
    const save = () => persist(file, state);
    const event = (step, status) => fs.appendFileSync(path.join(dir, 'agent-events.jsonl'), JSON.stringify({ step, status, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    for (const step of state.steps) if (step.status === 'dispatching') { step.status = 'ambiguous'; step.reason = 'restart_after_possible_acceptance'; }
    save();
    for (let index = 0; index < stages.length; index++) {
      const step = state.steps[index];
      if (step.status === 'complete') continue;
      if (step.status !== 'pending' || (index > 0 && state.steps[index - 1].status !== 'complete')) break;
      step.input = inputFor(index, state.steps[index - 1]);
      const url = `https://example.invalid/week30/${step.id}`;
      const controller = new AbortController(); let timer; let sent = false;
      const guardedFetch = async (target, init) => {
        if (sent || controller.signal.aborted || target !== 'https://api.ambient.xyz/v1/chat/completions' || init.method !== 'POST') throw new Error('Dispatch boundary held');
        sent = true; step.status = 'dispatching'; step.attempts++; save(); event(step.id, 'dispatching');
        const response = await fetchImpl(target, { ...init, signal: controller.signal });
        if (controller.signal.aborted) { response.body?.cancel().catch(() => {}); throw new Error('Deadline'); }
        // Never expose provider errors to analyzer fallback or log raw error bodies.
        if (!response.ok) { await response.body?.cancel(); const e = new Error('Provider HTTP hold'); e.category = `http_${response.status}`; throw e; }
        if (!response.headers.get('content-type')?.includes('text/event-stream')) { await response.body?.cancel(); const e = new Error('Protocol hold'); e.category = 'unexpected_content_type'; throw e; }
        const reader = response.body.getReader(); const chunks = []; let bytes = 0;
        const cancel = () => { reader.cancel().catch(() => {}); };
        controller.signal.addEventListener('abort', cancel, { once: true });
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            bytes += value.byteLength; if (bytes > 1000000 || controller.signal.aborted) throw new Error('Response bound');
            chunks.push(value);
          }
        } finally { controller.signal.removeEventListener('abort', cancel); cancel(); }
        if (controller.signal.aborted) throw new Error('Deadline');
        return new Response(new Blob(chunks), { headers: { 'content-type': 'text/event-stream' } });
      };
      const started = Date.now();
      try {
        const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Deadline')); }, timeoutMs); });
        const report = await Promise.race([analyzeWithLLM(url, step.input, principles, { apiKey, fetchImpl: guardedFetch, retry: false, skipFinancialCheck: true, stream: true, model: 'ambient/large', maxTokens }), deadline]);
        step.oracle_checks = checks(report, step.input, url);
        const p = report.__ambient;
        step.ambient_proof = { status: p?.verified === true && /^[a-fA-F0-9]{64}$/.test(p?.merkle_root || '') ? 'provider_reported_verified' : 'unavailable', cryptographically_verified: false };
        if (step.oracle_checks.every(c => c.pass)) {
          step.output = redact(project(report), apiKey);
          step.output_sha256 = digest(step.output); step.status = 'complete';
        } else { step.status = 'failed'; step.reason = 'oracle_rejected'; }
      } catch (error) {
        step.status = sent ? 'ambiguous' : 'failed';
        step.reason = sent ? (controller.signal.aborted ? 'timeout_after_possible_acceptance' : 'possible_acceptance_requires_reconciliation') : 'pre_send_failure_no_retry';
        // Retain only our own finite HTTP/protocol categories, never provider bodies or exception messages.
        step.failure_category = typeof error?.category === 'string' && (/^http_[1-5][0-9]{2}$/.test(error.category) || error.category === 'unexpected_content_type')
          ? error.category : controller.signal.aborted ? 'deadline' : 'transport_or_parse';
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
  const injection = process.argv[4];
  const enabled = process.argv[2] === '--live' && process.argv.length <= 5 && (injection === undefined || /^--interrupt-after=[12]$/.test(injection));
  runAgentRecovery({ enabled, dir: process.argv[3], interruptAfterStep: injection ? Number(injection.slice(-1)) : undefined }).then(state => {
    console.log(JSON.stringify({ status: state.status, steps: state.steps.map(({ id, status }) => ({ id, status })) }));
    process.exitCode = state.status === 'complete' ? 0 : state.status === 'interrupted' ? 75 : 2;
  }).catch(() => { console.error('Week30 held: check gate, configuration or sanitized state.'); process.exitCode = 2; });
}
