import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadRuntimeProfilesFromEnv } from './open-inference-runtimes.js';
import { runSingleRuntime, runWeek18OpenInferenceLoop, selectBestRuntime } from './week18-open-inference-loop.js';

const fixtureProposal = {
  title: 'Fixture proposal',
  body: 'Fund open inference reliability work.',
  options: ['For', 'Against', 'Abstain'],
};

function writeTempProposal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-ai-week18-'));
  const proposalPath = path.join(dir, 'proposal.json');
  fs.writeFileSync(proposalPath, JSON.stringify(fixtureProposal, null, 2));
  return { dir, proposalPath };
}

test('loadRuntimeProfilesFromEnv creates deterministic mock profile', () => {
  const profiles = loadRuntimeProfilesFromEnv({ WEEK18_MOCK: 'true', WEEK18_MAX_TOKENS: '2222' });

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].provider, 'mock');
  assert.equal(profiles[0].model, 'mock-governance-model');
  assert.equal(profiles[0].maxTokens, 2222);
});

test('loadRuntimeProfilesFromEnv supports OpenAI-compatible external profile and allow-list', () => {
  const profiles = loadRuntimeProfilesFromEnv({
    WEEK18_MOCK: 'true',
    WEEK18_INCLUDE_LIVE: 'true',
    OPEN_INFERENCE_API_URL: 'http://127.0.0.1:8000/v1/chat/completions',
    OPEN_INFERENCE_MODEL: 'local-model',
    OPEN_INFERENCE_PROFILE_NAME: 'local_runtime',
    WEEK18_RUNTIMES: 'local_runtime',
  });

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, 'local_runtime');
  assert.equal(profiles[0].provider, 'openai_compatible');
});

test('runSingleRuntime produces schema-valid report in mock mode', async () => {
  const profile = loadRuntimeProfilesFromEnv({ WEEK18_MOCK: 'true' })[0];
  const result = await runSingleRuntime({
    profile,
    messages: [],
    proposal: fixtureProposal,
  });

  assert.equal(result.ok, true);
  assert.equal(result.json_valid, true);
  assert.equal(result.schema_complete, true);
  assert.equal(result.report.extracted.title, 'Fixture proposal');
});

test('selectBestRuntime prefers verified successful runtime over unverified success', () => {
  const selected = selectBestRuntime([
    { name: 'fast_unverified', ok: true, json_valid: true, completeness_score: 1, latency_ms: 10, verification: null },
    { name: 'ambient_verified', ok: true, json_valid: true, completeness_score: 1, latency_ms: 50, verification: { verified: true } },
  ]);

  assert.equal(selected.name, 'ambient_verified');
});

test('runWeek18OpenInferenceLoop writes runtime-aware artifacts', async () => {
  const { dir, proposalPath } = writeTempProposal();
  const outputDir = path.join(dir, 'out');

  const result = await runWeek18OpenInferenceLoop({
    proposalPath,
    outputDir,
    env: { WEEK18_MOCK: 'true' },
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.selected_runtime, 'mock_open_inference_runtime');
  assert.equal(fs.existsSync(result.artifacts.json), true);
  assert.equal(fs.existsSync(result.artifacts.markdown), true);

  const saved = JSON.parse(fs.readFileSync(result.artifacts.json, 'utf8'));
  assert.equal(saved.runtimes_tested.length, 1);
  assert.equal(saved.runtimes_tested[0].json_valid, true);
});

test('runSingleRuntime classifies HTTP 429 as runtime failure', async () => {
  const profile = {
    name: 'rate_limited_runtime',
    provider: 'openai_compatible',
    apiUrl: 'http://example.invalid/v1/chat/completions',
    apiKey: null,
    model: 'test-model',
    stream: false,
    maxTokens: 100,
    timeoutMs: 1000,
    maxAttempts: 1,
    retryBackoffMs: 0,
    verification: false,
  };

  const result = await runSingleRuntime({
    profile,
    messages: [],
    proposal: fixtureProposal,
    fetchImpl: async () => ({ ok: false, status: 429 }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.type, 'http_429');
  assert.equal(result.recovery_action, 'retry_or_fallback');
  assert.equal(result.attempts.length, 1);
});

test('runSingleRuntime retries retryable runtime failures and then succeeds', async () => {
  const profile = {
    name: 'retry_runtime',
    provider: 'openai_compatible',
    apiUrl: 'http://example.invalid/v1/chat/completions',
    apiKey: null,
    model: 'test-model',
    stream: false,
    maxTokens: 100,
    timeoutMs: 1000,
    maxAttempts: 2,
    retryBackoffMs: 0,
    verification: false,
  };
  let calls = 0;
  const validReport = {
    input: {},
    extracted: { title: 'Retry proposal' },
    analysis: { summary: 'ok', key_changes: [], risks: [], benefits: [], unknowns: [], evidence_quotes: [] },
    recommendation: { suggested_option: 'Abstain', confidence: 'low', reasoning: 'test', conflicts_with_user_principles: [] },
    limitations: [],
  };

  const result = await runSingleRuntime({
    profile,
    messages: [],
    proposal: fixtureProposal,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 500 };
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(validReport) }, finish_reason: 'stop' }] }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].will_retry, true);
  assert.equal(result.recovery_action, 'none');
});

test('runSingleRuntime does not retry non-retryable 400 failures', async () => {
  const profile = {
    name: 'bad_request_runtime',
    provider: 'openai_compatible',
    apiUrl: 'http://example.invalid/v1/chat/completions',
    apiKey: null,
    model: 'test-model',
    stream: false,
    maxTokens: 100,
    timeoutMs: 1000,
    maxAttempts: 3,
    retryBackoffMs: 0,
    verification: false,
  };
  let calls = 0;

  const result = await runSingleRuntime({
    profile,
    messages: [],
    proposal: fixtureProposal,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 400 };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.equal(result.failure.type, 'http_400');
  assert.equal(result.recovery_action, 'stop');
});
