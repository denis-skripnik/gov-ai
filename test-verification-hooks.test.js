import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyVerificationHooks, isAmbientMultiNodeCapacityError, multiNodeAnalysis } from './analyzer.js';

const extracted = {
  title: 'Treasury Transfer Proposal',
  body: 'Transfer 250000 USDC from treasury to 0x1234567890abcdef1234567890abcdef12345678 for grants funding in Q2.',
  options: ['For', 'Against'],
};

test('classifies anchored factual fragment as deterministic', () => {
  const report = {
    analysis: {
      summary: 'Transfer 250000 USDC from treasury to 0x1234567890abcdef1234567890abcdef12345678.',
      evidence_quotes: ['Transfer 250000 USDC from treasury to 0x1234567890abcdef1234567890abcdef12345678'],
    },
    recommendation: {},
  };

  const hooks = classifyVerificationHooks(report, extracted, { strictMode: false });
  assert.equal(hooks.segments[0].category, 'deterministic');
  assert.equal(hooks.mixed_categories_detected, false);
  assert.equal(hooks.routing_action, 'ALLOW');
});

test('classifies recommendation language as probabilistic', () => {
  const report = {
    analysis: {
      risks: ['This may improve runway but could increase treasury risk.'],
    },
    recommendation: {
      reasoning: 'I recommend For because it likely improves grants throughput.',
    },
  };

  const hooks = classifyVerificationHooks(report, extracted, { strictMode: false });
  assert.ok(hooks.segments.every((segment) => segment.category === 'probabilistic'));
  assert.equal(hooks.routing_action, 'ALLOW');
});

test('classifies vague unsupported fragment as unverifiable', () => {
  const report = {
    analysis: {
      summary: 'This is a good and important proposal.',
    },
    recommendation: {},
  };

  const hooks = classifyVerificationHooks(report, extracted, { strictMode: false });
  assert.equal(hooks.segments[0].category, 'unverifiable');
  assert.equal(hooks.routing_action, 'WARN');
});

test('detects mixed categories within one field and triggers strict mode routing', () => {
  const report = {
    analysis: {
      summary: 'Transfer 250000 USDC from treasury to 0x1234567890abcdef1234567890abcdef12345678. This is likely the best outcome for delegates.',
      evidence_quotes: ['Transfer 250000 USDC from treasury to 0x1234567890abcdef1234567890abcdef12345678'],
    },
    recommendation: {},
  };

  const hooks = classifyVerificationHooks(report, extracted, { strictMode: true });
  assert.equal(hooks.mixed_categories_detected, true);
  assert.equal(hooks.strict_rejection_triggered, true);
  assert.equal(hooks.routing_action, 'HUMAN_REVIEW');
  assert.deepEqual(hooks.mixed_segments[0].categories.sort(), ['deterministic', 'probabilistic']);
});

test('detects the specific Ambient multi-node capacity error signatures', () => {
  assert.equal(isAmbientMultiNodeCapacityError(new Error('Ambient API error HTTP 429 (x-request-id: abc): rate limited')), true);
  assert.equal(isAmbientMultiNodeCapacityError(new Error('There were no bidders for this auction. Please try again.')), true);
  assert.equal(isAmbientMultiNodeCapacityError(new Error('Ambient API error HTTP 500: internal error')), false);
});

test('returns the only successful result when multi-node gets one success', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-ai-multi-node-'));
  const reports = [
    { input: {}, recommendation: { suggested_option: 'For', confidence: 'high' } },
  ];
  let callIndex = 0;

  try {
    const report = await multiNodeAnalysis('https://example.com', extracted, {}, 3, false, {
      tempDir,
      runAnalysis: async () => {
        callIndex += 1;
        if (callIndex === 2) return reports[0];
        throw new Error(`attempt-${callIndex}-failed`);
      },
    });

    assert.equal(report, reports[0]);
    const files = fs.readdirSync(tempDir);
    assert.equal(files.filter((name) => name.includes('-attempt-')).length, 3);
    const chosenName = files.find((name) => name.endsWith('-chosen.json'));
    assert.ok(chosenName);
    const chosen = JSON.parse(fs.readFileSync(path.join(tempDir, chosenName), 'utf8'));
    assert.equal(chosen.reason, 'single-success');
    assert.equal(chosen.attempts.length, 3);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runs multi-node attempts in parallel, preserves artifacts, and keeps consensus selection for 2+ successes', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-ai-multi-node-'));
  const starts = [];
  const releases = [];
  const reports = [
    { input: {}, recommendation: { suggested_option: 'Against', confidence: 'medium' } },
    { input: {}, recommendation: { suggested_option: 'For', confidence: 'high' } },
    { input: {}, recommendation: { suggested_option: 'For', confidence: 'low' } },
  ];
  let callIndex = 0;

  try {
    const reportPromise = multiNodeAnalysis('https://example.com', extracted, {}, 3, false, {
      tempDir,
      runAnalysis: async () => {
        const current = callIndex;
        callIndex += 1;
        starts.push(current);
        await new Promise((resolve) => {
          releases[current] = resolve;
        });
        return reports[current];
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(callIndex, 3);
    assert.deepEqual(starts, [0, 1, 2]);

    releases[1]();
    releases[2]();
    releases[0]();

    const report = await reportPromise;
    assert.equal(report, reports[1]);

    const files = fs.readdirSync(tempDir);
    assert.equal(files.filter((name) => name.includes('-attempt-')).length, 3);
    const chosenName = files.find((name) => name.endsWith('-chosen.json'));
    assert.ok(chosenName);
    const chosen = JSON.parse(fs.readFileSync(path.join(tempDir, chosenName), 'utf8'));
    assert.equal(chosen.reason, 'consensus');
    assert.equal(chosen.attempts.length, 3);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('falls back to single-node after three backoff retries for Ambient capacity failures', async () => {
  const calls = [];
  const sleeps = [];
  const fallbackReport = {
    input: {},
    recommendation: { suggested_option: 'For', confidence: 'medium' },
  };
  const retryableError = new Error('Ambient API error HTTP 429 (x-request-id: abc): There were no bidders for this auction. Please try again.');

  const report = await multiNodeAnalysis('https://example.com', extracted, {}, 3, false, {
    tempDir: './temp/test-multi-node-fallback',
    multiNodeFallbackBackoffsMs: [10000, 30000, 60000],
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    runAnalysis: async (_url, _extracted, _principles, opts = {}) => {
      calls.push(opts);
      if (opts.multiNodeFallbackActive) return fallbackReport;
      throw retryableError;
    },
  });

  assert.equal(report, fallbackReport);
  assert.deepEqual(sleeps, [10000, 30000, 60000]);
  assert.equal(calls.length, 13);
  assert.ok(calls.slice(0, 12).every((opts) => opts.skipFinancialCheck === true && !opts.multiNodeFallbackActive));
  assert.equal(calls[12].multiNodeFallbackActive, true);
  assert.deepEqual(report.input.multiNodeFallback, {
    activated: true,
    reason: 'ambient_multi_node_capacity',
    retries: [10, 30, 60],
    fallback_mode: 'single-node',
  });
});
