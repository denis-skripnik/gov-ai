import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWithLLM } from './analyzer.js';

const input = { title: 'Local doc correction', body: 'Correct a typo only.', options: [], source_type: 'generic' };
const opts = { apiKey: 'FAKE-TEST-KEY', skipFinancialCheck: true, model: 'ambient/large', stream: true, maxTokens: 900 };
const frame = value => `data: ${JSON.stringify(value)}\n\n`;

// These exercise the default production analyzer, not the gated Week 28 wrapper.
test('default analyzer does not replay a POST after an ambiguous network failure', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    const error = new Error('fetch failed');
    error.code = 'ECONNRESET';
    throw error;
  };
  await assert.rejects(analyzeWithLLM('https://example.invalid/proposal', input, {}, { ...opts, fetchImpl }), /fetch failed/);
  assert.equal(calls, 1);
});

for (const [label, suffix] of [
  ['missing completion marker', ''],
  ['length-limited response', frame({ object: 'chat.completion.chunk', choices: [{ delta: {}, finish_reason: 'length' }] }) + 'data: [DONE]\n\n'],
  ['malformed stream event', 'data: {bad json}\n\n'],
]) {
  test(`default analyzer rejects ${label} after HTTP 200 without replay`, async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      const body = frame({ object: 'chat.completion.chunk', choices: [{ delta: { content: '{"version":1}' }, finish_reason: null }] }) + suffix;
      return new Response(body, { status: 200, headers: { 'x-request-id': 'test-request' } });
    };
    await assert.rejects(analyzeWithLLM('https://example.invalid/proposal', input, {}, { ...opts, fetchImpl }), /stream|completion/i);
    assert.equal(calls, 1);
  });
}

test('untrusted verification metadata and invalid model text never print a credential', async () => {
  const secret = 'FAKE-TEST-KEY';
  const captured = [];
  const originalLog = console.log, originalError = console.error;
  console.log = (...args) => captured.push(args);
  console.error = (...args) => captured.push(args);
  try {
    const body = frame({ object: 'chat.completion.chunk', choices: [{ delta: { content: secret + ' not-json' }, finish_reason: null }] })
      + frame({ object: 'chat.completion.chunk', choices: [{ delta: {}, finish_reason: 'stop' }] })
      + frame({ object: 'chat.completion.usage', merkle_root: secret, usage: {} }) + 'data: [DONE]\n\n';
    const fetchImpl = async () => new Response(body, { status: 200, headers: { 'x-request-id': secret } });
    await assert.rejects(analyzeWithLLM('https://example.invalid/proposal', input, {}, { ...opts, fetchImpl }), /Invalid JSON/);
  } finally { console.log = originalLog; console.error = originalError; }
  assert.equal(JSON.stringify(captured).includes(secret), false);
});
