import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgentRecovery } from './week30-agent-recovery.js';
import { spawnSync } from 'node:child_process';

const frame = x => `data: ${JSON.stringify(x)}\n\n`;
const headers = { 'content-type': 'Text/Event-Stream; charset=utf-8', 'x-request-id': 'req-public_123' };
async function probe(t, fetchImpl, timeoutMs = 1000) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'week30-diag-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const config = { enabled: true, dir, apiKey: 'public-fixture-key', timeoutMs, fetchImpl: async (...args) => { calls++; return fetchImpl(...args, dir); } };
  const state = await runAgentRecovery(config);
  await runAgentRecovery(config);
  assert.equal(calls, 1);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'agent-state.json')));
  assert.deepEqual(persisted.steps[0].diagnostics, state.steps[0].diagnostics);
  for (const name of ['agent-state.json', 'agent-events.jsonl']) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const forbidden of ['public-fixture-key', 'PRIVATE_BODY', 'PRIVATE_ERROR']) assert.ok(!text.includes(forbidden));
  }
  return state.steps[0];
}

const completion = (content = 'not model JSON', finish = 'stop', done = true) =>
  frame({ object: 'chat.completion.chunk', choices: [{ delta: { content }, finish_reason: null }] }) +
  frame({ object: 'chat.completion.usage', usage: { completion_tokens: 1 } }) +
  frame({ choices: [{ delta: {}, finish_reason: finish }] }) + (done ? 'data: [DONE]\n\n' : '');
for (const [mode, category, phase] of [
  ['fetch', 'transport', 'dispatch'], ['reset', 'transport', 'stream'],
  ['malformed', 'malformed_sse', 'stream'], ['error', 'sse_error', 'stream'],
  ['missing_done', 'missing_done', 'stream'], ['length', 'finish_length', 'stream'],
  ['model', 'model_parse', 'model_parse'], ['timeout', 'deadline', 'stream'],
  ['content_type', 'unexpected_content_type', 'headers'],
]) test(`diagnostics isolate ${mode} without replay or raw leakage`, async t => {
  const step = await probe(t, () => {
    if (mode === 'fetch') throw new Error('PRIVATE_ERROR public-fixture-key');
    if (mode === 'reset' || mode === 'timeout') {
      let reads = 0;
      return new Response(new ReadableStream({ pull(c) {
        if (!reads++) c.enqueue(new TextEncoder().encode(frame({ object: 'chat.completion.chunk', choices: [{ delta: { content: 'PRIVATE_BODY' } }] })));
        else if (mode === 'reset') c.error(new Error('PRIVATE_ERROR'));
        else return new Promise(() => {});
      } }), { headers });
    }
    if (mode === 'content_type') return new Response('PRIVATE_BODY', { headers: { 'content-type': 'application/json; PRIVATE_BODY' } });
    const body = mode === 'malformed' ? 'data: PRIVATE_BODY\n\n' : mode === 'error' ? frame({ error: { message: 'PRIVATE_ERROR' } }) : completion('not model JSON', mode === 'length' ? 'length' : 'stop', mode !== 'missing_done');
    return new Response(body, { headers });
  }, mode === 'timeout' ? 30 : 1000);
  assert.equal(step.failure_category, category);
  assert.equal(step.diagnostics.phase, phase);
  if (phase === 'stream' || phase === 'model_parse') {
    assert.ok(step.diagnostics.bytes > 0);
    assert.ok(step.diagnostics.ttft_ms >= 0);
    assert.equal(step.diagnostics.error_frames, mode === 'error' ? 1 : 0);
  }
  if (mode === 'model' || mode === 'length') {
    assert.equal(step.diagnostics.done_frames, 1);
    assert.equal(step.diagnostics.finish_frames, 1);
    assert.equal(step.diagnostics.usage_frames, 1);
    assert.equal(step.diagnostics.finish_reason, mode === 'length' ? 'length' : 'stop');
  }
});
for (const requestId of ['x'.repeat(129), 'Bearer PRIVATE_ERROR', 'public-fixture-key', '<unsafe>']) test('unsafe request ID omitted: ' + requestId.length, async t => {
  const step = await probe(t, () => new Response('', { status: 502, headers: { ...headers, 'x-request-id': requestId } }));
  assert.equal(step.diagnostics.request_id, null);
});

test('unrecognized MIME token cannot carry a secret into diagnostics', async t => {
  const step = await probe(t, () => new Response('PRIVATE_BODY', { headers: { 'content-type': 'application/public-fixture-key' } }));
  assert.equal(step.diagnostics.content_type, 'other');
});

test('SIGKILL during stream preserves header and stream diagnostics and never replays', async t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'week30-crash-diag-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const moduleUrl = new URL('./week30-agent-recovery.js', import.meta.url).href;
  const code = `import fs from 'node:fs'; import path from 'node:path'; import { runAgentRecovery } from ${JSON.stringify(moduleUrl)};
    const dir = ${JSON.stringify(dir)}; const original = fs.renameSync;
    fs.renameSync = (...args) => { original(...args); const state = JSON.parse(fs.readFileSync(args[1]));
      if (state.steps[0].diagnostics?.bytes > 0) process.kill(process.pid, 'SIGKILL'); };
    await runAgentRecovery({ enabled: true, dir, apiKey: 'public-fixture-key', fetchImpl: async () => {
      fs.appendFileSync(path.join(dir, 'posts.txt'), 'POST');
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(${JSON.stringify(frame({ choices: [{ delta: { content: 'public content' } }] }))})); } }), { headers: ${JSON.stringify(headers)} });
    } });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', code], { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'agent-state.json'))).steps[0];
  assert.equal(before.status, 'dispatching');
  assert.equal(before.diagnostics.http_status, 200);
  assert.equal(before.diagnostics.request_id, 'req-public_123');
  assert.ok(before.diagnostics.bytes > 0);
  const after = await runAgentRecovery({ enabled: true, dir, apiKey: 'public-fixture-key', fetchImpl: () => assert.fail('no replay') });
  assert.equal(after.steps[0].status, 'ambiguous');
  assert.deepEqual(after.steps[0].diagnostics, before.diagnostics);
  assert.equal(fs.readFileSync(path.join(dir, 'posts.txt'), 'utf8'), 'POST');
});

test('local header persistence failure is distinct and blocks all further POSTs', async t => {
  const original = fs.renameSync; let failed = false;
  t.after(() => { fs.renameSync = original; });
  const step = await probe(t, () => {
    fs.renameSync = (...args) => {
      if (!failed) { failed = true; throw new Error('PRIVATE_ERROR public-fixture-key'); }
      return original(...args);
    };
    return new Response('', { status: 502, headers });
  });
  assert.equal(step.failure_category, 'local_persistence');
  assert.equal(step.diagnostics.phase, 'headers');
  assert.equal(step.status, 'ambiguous');
});

test('unwritable initial state returns only a safe local persistence category before POST', async t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'week30-local-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = fs.renameSync;
  fs.renameSync = () => { throw new Error('PRIVATE_ERROR public-fixture-key'); };
  try {
    await assert.rejects(runAgentRecovery({ enabled: true, dir, apiKey: 'public-fixture-key', fetchImpl: () => assert.fail('no POST') }), e => e.category === 'local_persistence' && !e.message.includes('PRIVATE_ERROR'));
  } finally { fs.renameSync = original; }
});

for (const status of [429, 502]) test(`headers persisted before HTTP ${status} hold`, async t => {
  const step = await probe(t, () => new Response('PRIVATE_BODY public-fixture-key', { status, headers }));
  assert.equal(step.failure_category, `http_${status}`);
  assert.equal(step.diagnostics.phase, 'headers');
  assert.equal(step.diagnostics.http_status, status);
  assert.equal(step.diagnostics.content_type, 'text/event-stream');
  assert.equal(step.diagnostics.request_id, 'req-public_123');
});
