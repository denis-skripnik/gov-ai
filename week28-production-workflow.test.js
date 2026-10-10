import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWorkflow, makeTasks, oracle, injectPreSendOnce, PreSendFailure, runProductionFixture } from './week28-production-workflow.js';

const temp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'week28-'));
function sse(value, { finish = 'stop', done = true, verified, root, fenced = false } = {}) {
  const content = fenced ? '```json\n' + JSON.stringify(value) + '\n```' : JSON.stringify(value);
  const frames = [ { object: 'chat.completion.chunk', choices: [{ delta: { content }, finish_reason: null }] },
    { object: 'chat.completion.chunk', choices: [{ delta: {}, finish_reason: finish }] },
    { object: 'chat.completion.usage', usage: { prompt_tokens: 10, completion_tokens: 20 }, verified, merkle_root: root } ];
  return new Response(frames.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'test-request' } });
}
function transport(tasks, options = {}) {
  let calls = 0;
  const fetchImpl = async (_, init) => {
    const body = JSON.parse(init.body);
    const input = JSON.parse(body.messages[1].content);
    calls++;
    return sse(input.rows ? oracle(input.rows) : input.summaries.reduce((a, b) => ({ count: a.count + b.count, total_cents: a.total_cents + b.total_cents, by_category: Object.fromEntries(['infra','research','support'].map(k => [k, a.by_category[k] + b.by_category[k]])) }), { count: 0, total_cents: 0, by_category: { infra: 0, research: 0, support: 0 } }), options);
  };
  return { fetchImpl, count: () => calls };
}

test('real workflow orchestration: two shards feed consolidation, exact oracle, persistent replay', async () => {
  const dir = temp(); const tasks = makeTasks(); const t = transport(tasks);
  const result = await runWorkflow({ dir, apiKey: 'test-secret', fetchImpl: t.fetchImpl });
  assert.equal(result.status, 'complete');
  assert.equal(t.count(), 3);
  assert.deepEqual(result.jobs.consolidate.result.output, oracle(tasks.flatMap(t => t.rows)));
  assert.equal(result.jobs.consolidate.result.provenance.status, 'unavailable');
  await runWorkflow({ dir, apiKey: 'test-secret', fetchImpl: t.fetchImpl });
  assert.equal(t.count(), 3);
});

test('INJECTED pre-send wrapper retries once, never adds provider POST', async () => {
  const dir = temp(); const t = transport(makeTasks());
  const r = await runWorkflow({ dir, apiKey: 'secret-test', fetchImpl: injectPreSendOnce(t.fetchImpl), retryDelayMs: 0 });
  assert.equal(r.status, 'complete'); assert.equal(t.count(), 3);
  assert.equal(r.jobs.shard_0.attempts, 2);
  assert.match(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'), /"injected":true/);
});

test('INJECTED ambiguous post-send disconnect is held on restart without redispatch', async () => {
  const dir = temp(); let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('INJECTED disconnect after possible server acceptance: secret-test'); };
  const r = await runWorkflow({ dir, apiKey: 'secret-test', fetchImpl });
  assert.equal(r.jobs.shard_0.status, 'ambiguous'); assert.equal(r.jobs.consolidate.status, 'blocked');
  await runWorkflow({ dir, apiKey: 'secret-test', fetchImpl }); assert.equal(calls, 2);
  assert.ok(!fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').includes('secret-test'));
});

test('restart marks persisted dispatch as ambiguous, no duplicate send', async () => {
  const dir = temp(); const t = transport(makeTasks());
  await runWorkflow({ dir, apiKey: 'test', fetchImpl: t.fetchImpl });
  const file = path.join(dir, 'state.json'); const s = JSON.parse(fs.readFileSync(file));
  s.jobs.shard_0.status = 'dispatching'; fs.writeFileSync(file, JSON.stringify(s));
  const r = await runWorkflow({ dir, apiKey: 'test', fetchImpl: t.fetchImpl });
  assert.equal(r.status, 'needs_review'); assert.equal(r.jobs.shard_0.status, 'ambiguous'); assert.equal(t.count(), 3);
});

for (const [name, opts] of [['truncated', { finish: 'length' }], ['missing_DONE', { done: false }]]) {
  test(`acceptance rejects ${name} even when JSON matches oracle`, async () => {
    const t = transport(makeTasks(), opts); const r = await runWorkflow({ dir: temp(), apiKey: 'test', fetchImpl: t.fetchImpl });
    assert.equal(r.status, 'needs_review'); assert.equal(r.jobs.shard_0.oracle_match, true); assert.equal(r.jobs.consolidate.status, 'blocked'); assert.equal(t.count(), 2);
  });
}

test('acceptance rejects wrong arithmetic and extra schema keys even with verified provenance', async () => {
  const r = await runWorkflow({ dir: temp(), apiKey: 'test', fetchImpl: async () => sse({ ...oracle(makeTasks()[0].rows), extra: true }, { verified: true, root: 'a'.repeat(64) }) });
  assert.equal(r.status, 'needs_review'); assert.equal(r.jobs.shard_0.oracle_match, false);
  assert.equal(r.jobs.shard_0.result.provenance.status, 'provider_reported_verified');
});

test('redaction does not persist arbitrary parsed model content or secret error strings', async () => {
  const dir = temp();
  await runWorkflow({ dir, apiKey: 'test-secret', fetchImpl: async () => sse({ malicious: 'Bearer test-secret' }) });
  for (const f of ['state.json','events.jsonl']) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes('test-secret'));
});

test('bounded parallel requests and exclusive lock reject competing worker', async () => {
  const dir = temp(); let active = 0; let peak = 0; const t = transport(makeTasks());
  const fetchImpl = async (...args) => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 30)); active--; return t.fetchImpl(...args); };
  const pending = runWorkflow({ dir, apiKey: 'test', fetchImpl });
  await assert.rejects(runWorkflow({ dir, apiKey: 'test', fetchImpl }), /locked/);
  const r = await pending; assert.equal(r.status, 'complete'); assert.equal(peak, 2);
});

test('pre-send retries exhausted are finite and block dependencies', async () => {
  let tries = 0;
  const r = await runWorkflow({ dir: temp(), apiKey: 'test', retryDelayMs: 0, fetchImpl: async () => { tries++; throw new PreSendFailure(); } });
  assert.equal(tries, 4); assert.equal(r.jobs.shard_0.status, 'failed'); assert.equal(r.jobs.consolidate.status, 'blocked');
});

test('timeout after dispatch stays ambiguous; long wait is permitted up to deadline', async () => {
  const r = await runWorkflow({ dir: temp(), apiKey: 'test', timeoutMs: 10, fetchImpl: async (_, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('abort')))) });
  assert.equal(r.jobs.shard_0.status, 'ambiguous'); assert.equal(r.jobs.shard_0.reason, 'timeout_after_dispatch');
});

for (const status of [401, 429, 503]) test(`HTTP ${status} never blindly retries completion POST`, async () => {
  let calls = 0;
  const r = await runWorkflow({ dir: temp(), apiKey: 'test', fetchImpl: async () => { calls++; return new Response('secret-body', { status }); } });
  assert.equal(calls, 2); assert.equal(r.jobs.shard_0.status, status === 503 ? 'ambiguous' : 'failed');
});

test('production fixture uses actual analyzer, verification hooks, council and bot summary; replay sends zero', async () => {
  const dir = temp(); let calls = 0;
  const fetchImpl = async (_, init) => {
    calls++; const body = JSON.parse(init.body);
    assert.match(body.messages[1].content, /RECOMMENDATION DISCIPLINE/);
    const extracted = { title: 'Documentation glossary correction', body: 'Replace the glossary spelling "goverance" with "governance". No other changes. Voting options and current results were not provided.', options: [], current_results: null, metadata: {}, source_type: 'generic' };
    return sse({ version: 1, input: { url: 'https://example.invalid/week28-public-fixture', source_type: 'generic' }, extracted, analysis: { summary: 'Corrects glossary spelling.', key_changes: ['Corrects spelling'], benefits: ['Corrects spelling'], risks: [], unknowns: ['Voting options UNKNOWN'], evidence_quotes: [] }, recommendation: { suggested_option: 'UNKNOWN', confidence: 'low', reasoning: 'Options were not provided.', conflicts_with_user_principles: [] }, limitations: ['Fixture only.'] }, { fenced: true });
  };
  const r = await runProductionFixture({ dir, apiKey: 'test-key', fetchImpl, inject: true });
  assert.equal(r.status, 'complete'); assert.equal(calls, 1);
  assert.equal(r.oracle_checks.every(c => c.pass), true);
  assert.ok(r.pipeline.verification_hooks); assert.ok(r.pipeline.council); assert.equal(r.pipeline.bot_summary_built, true);
  const replay = await runProductionFixture({ dir, apiKey: 'test-key', fetchImpl }); assert.equal(replay.status, 'complete'); assert.equal(calls, 1);
});

test('core production fixture rejects matching report in truncated stream and does not retry', async () => {
  let calls = 0; const dir = temp();
  const fetchImpl = async () => { calls++; return sse({ extracted: { options: [], current_results: null }, recommendation: { suggested_option: 'UNKNOWN' } }, { finish: 'length' }); };
  const r = await runProductionFixture({ dir, apiKey: 'test-key', fetchImpl });
  assert.notEqual(r.status, 'complete'); assert.equal(calls, 1);
  await runProductionFixture({ dir, apiKey: 'test-key', fetchImpl }); assert.equal(calls, 1);
});

test('core production fixture holds INJECTED socket error without legacy analyzer retry', async () => {
  let calls = 0; const dir = temp();
  const r = await runProductionFixture({ dir, apiKey: 'test-key', fetchImpl: async () => { calls++; const e = new Error('INJECTED fetch failed'); e.code = 'ECONNRESET'; throw e; } });
  assert.equal(r.status, 'ambiguous'); assert.equal(calls, 1);
  await runProductionFixture({ dir, apiKey: 'test-key', fetchImpl: async () => { calls++; } }); assert.equal(calls, 1);
});

test('core fixture blocks malformed model reports before council and bot summary', async () => {
  const dir = temp();
  const extracted = { title: 'Documentation glossary correction', body: 'Replace the glossary spelling "goverance" with "governance". No other changes. Voting options and current results were not provided.', options: [], current_results: null, metadata: {}, source_type: 'generic' };
  const malformed = {
    version: 999, input: { url: 'https://wrong.invalid/', source_type: 'generic' }, extracted,
    analysis: {}, recommendation: { suggested_option: 'UNKNOWN', confidence: 'certain' }, limitations: [],
  };
  const result = await runProductionFixture({ dir, apiKey: 'FAKE-TEST-KEY', fetchImpl: async () => sse(malformed) });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.oracle_checks.find(c => c.name === 'report_shape_and_identity_valid')?.pass, false);
  assert.equal(result.pipeline, null);
  assert.equal(result.automation_ready, false);
});


test('config bounds and fingerprint reject unsafe replay changes before dispatch', async () => {
  await assert.rejects(runWorkflow({ dir: temp(), apiKey: 'test', concurrency: 3 }), /concurrency/);
  const dir = temp(); const t = transport(makeTasks()); await runWorkflow({ dir, apiKey: 'test', fetchImpl: t.fetchImpl });
  await assert.rejects(runWorkflow({ dir, apiKey: 'test', model: 'changed', fetchImpl: t.fetchImpl }), /mismatch/); assert.equal(t.count(), 3);
});
