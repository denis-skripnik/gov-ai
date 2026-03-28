import test from 'node:test';
import assert from 'node:assert/strict';
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
