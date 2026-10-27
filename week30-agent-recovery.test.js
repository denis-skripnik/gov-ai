import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const moduleUrl = new URL('./week30-agent-recovery.js', import.meta.url).href;
const temp = t => { const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'week30-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
// Only the HTTP boundary is synthetic: production analyzer builds/parses every request/report.
function responseFor(init, mutate = x => x) {
  const request = JSON.parse(init.body);
  assert.equal(request.stream, true);
  assert.equal(request.model, 'ambient/large');
  const prompt = request.messages[1].content;
  const extracted = JSON.parse(prompt.split('EXTRACTED_DATA (may be incomplete):\n')[1].split('\n\nUSER_PRINCIPLES:')[0]);
  const url = prompt.split('URL:\n')[1].split('\n')[0];
  const report = mutate({ version: 1, input: { url, source_type: 'generic' }, extracted,
    analysis: { summary: 'Public register pilot needs a named reviewer.', key_changes: ['Publish a public decision register.'], risks: ['Reviewer availability is unspecified.'], benefits: ['Publish a public decision register.'], unknowns: ['Voting options UNKNOWN.'], evidence_quotes: ['Publish a public decision register.'] },
    recommendation: { suggested_option: 'UNKNOWN', confidence: 'low', reasoning: 'Voting options UNKNOWN.', conflicts_with_user_principles: [] }, limitations: ['Synthetic proposal; missing voting options.'] });
  const frames = [{ object: 'chat.completion.chunk', choices: [{ delta: { content: JSON.stringify(report) }, finish_reason: null }] }, { object: 'chat.completion.chunk', choices: [{ delta: {}, finish_reason: 'stop' }] }];
  return new Response(frames.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

test('gated three-stage governance analysis persists continuity and replays no completed inference', async t => {
  const { runAgentRecovery } = await import(moduleUrl);
  const dir = temp(t); let calls = 0;
  const fetchImpl = async (url, init) => { calls++; assert.equal(url, 'https://api.ambient.xyz/v1/chat/completions'); return responseFor(init); };
  await assert.rejects(runAgentRecovery({ dir, apiKey: 'fixture-key', fetchImpl }), /gate/);
  assert.equal(calls, 0);
  const state = await runAgentRecovery({ enabled: true, dir, apiKey: 'fixture-key', fetchImpl });
  assert.equal(state.status, 'complete'); assert.equal(calls, 3);
  assert.equal(state.steps.length, 3);
  assert.ok(state.steps.every(s => s.status === 'complete' && s.oracle_checks.every(c => c.pass)));
  for (const step of state.steps) {
    assert.equal(step.diagnostics.phase, 'complete');
    assert.equal(step.diagnostics.done_frames, 1);
    assert.equal(step.diagnostics.finish_reason, 'stop');
    assert.ok(step.diagnostics.ttft_ms >= 0);
  }
  assert.equal(state.steps[1].input.metadata.previous.output_sha256, state.steps[0].output_sha256);
  assert.equal(state.steps[2].input.metadata.previous.output_sha256, state.steps[1].output_sha256);
  assert.equal(state.steps[2].ambient_proof.status, 'unavailable');
  await runAgentRecovery({ enabled: true, dir, apiKey: 'fixture-key', fetchImpl });
  assert.equal(calls, 3);
});

test('distinct incident scenario has a separate input and refuses reuse of an older state', async t => {
  const { runAgentRecovery } = await import(moduleUrl);
  const dir = temp(t); let calls = 0;
  const fetchImpl = async (_, init) => {
    calls++;
    return responseFor(init, r => {
      r.analysis.evidence_quotes = [r.extracted.body.split('.')[0] + '.'];
      return r;
    });
  };
  const config = { enabled: true, dir, apiKey: 'public-test-key', fetchImpl, interruptAfterStep: 1 };
  const incident = await runAgentRecovery({ ...config, scenario: 'incident' });
  assert.equal(incident.status, 'interrupted');
  assert.match(incident.steps[0].input.body, /incident register/i);
  assert.equal(calls, 1);
  await assert.rejects(runAgentRecovery(config), /state\/configuration/);
  assert.equal(calls, 1);
});

test('corrupted completed state is rejected before dispatch', async t => {
  const { runAgentRecovery } = await import(moduleUrl); const dir = temp(t);
  const config = { enabled: true, dir, apiKey: 'fixture-key', fetchImpl: async (_, init) => responseFor(init) };
  await runAgentRecovery(config);
  const file = path.join(dir, 'agent-state.json'); const state = JSON.parse(fs.readFileSync(file));
  state.steps[0].output.analysis.summary = 'tampered'; fs.writeFileSync(file, JSON.stringify(state));
  await assert.rejects(runAgentRecovery({ ...config, fetchImpl: () => assert.fail('no dispatch') }), /state/);
});

test('known pre-send analyzer failure is not retried and cannot dispatch dependencies', async t => {
  const { runAgentRecovery } = await import(moduleUrl); const dir = temp(t);
  const root = process.cwd(); const other = temp(t); t.after(() => process.chdir(root));
  process.chdir(other); // Analyzer cannot load report.schema.json: proven before fetch.
  const state = await runAgentRecovery({ enabled: true, dir, apiKey: 'fixture-key', fetchImpl: () => assert.fail('no POST') });
  process.chdir(root);
  assert.equal(state.steps[0].attempts, 0); assert.equal(state.steps[0].reason, 'pre_send_failure_no_retry');
});

for (const mode of ['disconnect', 'http_unknown_model', 'http_429', 'timeout', 'truncated', 'oversized']) {
  test(`${mode} holds after at most one POST and never replays on resume`, async t => {
    const { runAgentRecovery } = await import(moduleUrl); const dir = temp(t); let calls = 0;
    const config = { enabled: true, dir, apiKey: 'fixture-key', timeoutMs: mode === 'timeout' ? 15 : 3000,
      fetchImpl: async (_, init) => {
        calls++;
        if (mode === 'disconnect') throw new Error('Bearer private-error fixture-key');
        if (mode === 'http_unknown_model') return new Response('unknown model fixture-key', { status: 400 });
        if (mode === 'http_429') return new Response('fixture-key', { status: 429 });
        if (mode === 'timeout') return new Promise(() => {}); // Even transport ignoring abort is bounded.
        if (mode === 'oversized') return new Response('x'.repeat(1000001), { headers: { 'content-type': 'text/event-stream' } });
        const valid = responseFor(init); return new Response((await valid.text()).replace('data: [DONE]\n\n', ''), { headers: valid.headers });
      } };
    const state = await runAgentRecovery(config); assert.equal(state.status, 'needs_review');
    assert.equal(state.steps[0].status, 'ambiguous'); assert.equal(state.steps[1].status, 'pending');
    assert.equal(state.steps[0].failure_category, mode === 'http_429' ? 'http_429' : mode === 'http_unknown_model' ? 'http_400' : mode === 'timeout' ? 'deadline' : mode === 'truncated' ? 'missing_done' : mode === 'oversized' ? 'response_bound' : 'transport');
    await runAgentRecovery(config); assert.equal(calls, 1);
    for (const file of ['agent-state.json', 'agent-events.jsonl']) assert.ok(!fs.readFileSync(path.join(dir, file), 'utf8').includes('fixture-key'));
  });
}

for (const mode of ['invented_vote', 'invented_quote', 'invented_source', 'bad_schema']) {
  test(`oracle rejects ${mode} and blocks handoff`, async t => {
    const { runAgentRecovery } = await import(moduleUrl); let calls = 0;
    const state = await runAgentRecovery({ enabled: true, dir: temp(t), apiKey: 'fixture-key', fetchImpl: async (_, init) => {
      calls++; return responseFor(init, r => {
        if (mode === 'invented_vote') r.recommendation.suggested_option = 'YES';
        if (mode === 'invented_quote') r.analysis.evidence_quotes = ['Invented evidence.'];
        if (mode === 'invented_source') r.extracted.body = 'Invented source.';
        if (mode === 'bad_schema') r.analysis.risks = 'not an array';
        return r;
      });
    } });
    assert.equal(calls, 1); assert.equal(state.steps[0].status, 'failed'); assert.equal(state.steps[0].reason, 'oracle_rejected');
    assert.equal(state.steps[0].failure_category, 'oracle');
    assert.equal(state.steps[0].diagnostics.phase, 'oracle');
    assert.equal(state.steps[1].status, 'pending');
  });
}

test('exclusive lock and serial stage dispatch bound concurrency to one', async t => {
  const { runAgentRecovery } = await import(moduleUrl); const dir = temp(t); let active = 0; let peak = 0;
  const config = { enabled: true, dir, apiKey: 'fixture-key', fetchImpl: async (_, init) => {
    active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 20)); active--; return responseFor(init);
  } };
  const running = runAgentRecovery(config);
  await assert.rejects(runAgentRecovery(config), /locked/);
  assert.equal((await running).status, 'complete'); assert.equal(peak, 1);
});

test('safe output projection redacts credentials and drops untrusted extras', async t => {
  const { runAgentRecovery } = await import(moduleUrl); const dir = temp(t);
  const state = await runAgentRecovery({ enabled: true, dir, apiKey: 'fixture-key', fetchImpl: async (_, init) => responseFor(init, r => {
    r.analysis.summary = 'fixture-key Bearer credential-value'; r.analysis.extra = 'untrusted-extra'; return r;
  }) });
  assert.equal(state.status, 'complete');
  const serialized = fs.readFileSync(path.join(dir, 'agent-state.json'), 'utf8');
  for (const forbidden of ['fixture-key', 'credential-value', 'untrusted-extra']) assert.ok(!serialized.includes(forbidden));
});

test('provider proof is reported separately from oracle success and model-local verified', async t => {
  const { runAgentRecovery } = await import(moduleUrl);
  for (const provider of [false, true]) {
    const state = await runAgentRecovery({ enabled: true, dir: temp(t), apiKey: 'fixture-key', fetchImpl: async (_, init) => {
      const valid = responseFor(init, r => ({ ...r, verified: true }));
      const frames = provider ? `data: ${JSON.stringify({ verified: true })}\n\ndata: ${JSON.stringify({ object: 'chat.completion.usage', merkle_root: 'a'.repeat(64) })}\n\n` : '';
      return new Response((await valid.text()).replace('data: [DONE]', frames + 'data: [DONE]'), { headers: valid.headers });
    } });
    assert.equal(state.status, 'complete');
    assert.equal(state.steps[0].ambient_proof.status, provider ? 'provider_reported_verified' : 'unavailable');
    assert.equal(state.steps[0].ambient_proof.cryptographically_verified, false);
  }
});

test('stream body stall is bounded as ambiguous, not just connection establishment', async t => {
  const { runAgentRecovery } = await import(moduleUrl);
  const state = await runAgentRecovery({ enabled: true, dir: temp(t), apiKey: 'fixture-key', timeoutMs: 15,
    fetchImpl: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: ')); } }), { headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal(state.steps[0].reason, 'timeout_after_possible_acceptance');
});

test('invalid resource bounds are rejected before any POST', async t => {
  const { runAgentRecovery } = await import(moduleUrl);
  for (const limits of [{ timeoutMs: 0 }, { timeoutMs: 300001 }, { maxTokens: 4001 }, { interruptAfterStep: 0 }]) {
    await assert.rejects(runAgentRecovery({ enabled: true, dir: temp(t), apiKey: 'fixture-key', ...limits, fetchImpl: () => assert.fail('no POST') }), /configuration/);
  }
});

function childRun(dir, mode) {
  const code = `import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
    import { runAgentRecovery } from ${JSON.stringify(moduleUrl)};
    ${responseFor.toString()}
    const dir = ${JSON.stringify(dir)};
    let calls = 0;
    const state = await runAgentRecovery({ enabled: true, dir, ['api' + 'Key']: 'fixture-key',
      interruptAfterStep: ${mode === 'interrupt' ? 1 : 'undefined'},
      fetchImpl: async (_, init) => {
        calls++; fs.appendFileSync(path.join(dir, 'posts.txt'), 'POST\\n');
        if (${mode === 'crash' ? 'true' : 'false'} && calls === 2) process.kill(process.pid, 'SIGKILL');
        return responseFor(init);
      } });
    process.stdout.write('RESULT:' + JSON.stringify({ status: state.status, calls }));`;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', code], { cwd: path.dirname(new URL(moduleUrl).pathname), encoding: 'utf8', timeout: 15000 });
}

test('injected interruption after completed step resumes in a fresh process without duplicate POST', t => {
  const dir = temp(t);
  const first = childRun(dir, 'interrupt');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /RESULT:\{"status":"interrupted","calls":1\}/);
  const second = childRun(dir, 'resume');
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /RESULT:\{"status":"complete","calls":2\}/);
  assert.equal(fs.readFileSync(path.join(dir, 'posts.txt'), 'utf8').trim().split('\n').length, 3);
});

test('SIGKILL after possible acceptance preserves completed step and holds ambiguous step on fresh process', t => {
  const dir = temp(t);
  const first = childRun(dir, 'crash'); assert.equal(first.signal, 'SIGKILL', first.stderr);
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'agent-state.json')));
  assert.equal(before.steps[0].status, 'complete'); assert.equal(before.steps[1].status, 'dispatching');
  const second = childRun(dir, 'resume'); assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /RESULT:\{"status":"needs_review","calls":0\}/);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'agent-state.json')));
  assert.equal(after.steps[1].status, 'ambiguous'); assert.equal(after.steps[2].status, 'pending');
  assert.equal(fs.readFileSync(path.join(dir, 'posts.txt'), 'utf8').trim().split('\n').length, 2);
});