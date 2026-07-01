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
});
