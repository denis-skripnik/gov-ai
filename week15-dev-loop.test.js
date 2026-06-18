import test from 'node:test';
import assert from 'node:assert/strict';

import { runAutonomousDevLoop } from './week15-dev-loop.js';

const validReport = (option = 'For', confidence = 'medium') => ({
  input: { url: 'fixture://proposal', fetched_at: '2026-06-18T00:00:00.000Z', source_type: 'fixture' },
  extracted: { title: 'Fixture', body: 'Body', options: ['For', 'Against'], current_results: null, metadata: {} },
  analysis: {
    summary: 'Summary',
    key_changes: ['Change'],
    risks: ['Risk'],
    benefits: ['Benefit'],
    unknowns: ['Unknown'],
    evidence_quotes: ['Quote'],
  },
  recommendation: {
    suggested_option: option,
    confidence,
    reasoning: 'Reasoning',
    conflicts_with_user_principles: [],
  },
  limitations: ['Limit'],
});

const goal = 'Produce a reliable Week 15 report under real conditions';
const plan = ['draft report', 'evaluate output quality', 'retry if quality or consistency fails'];

test('runAutonomousDevLoop completes on the first schema-valid output', async () => {
  let calls = 0;
  const result = await runAutonomousDevLoop({
    goal,
    plan,
    action: async () => {
      calls += 1;
      return validReport();
    },
  });

  assert.equal(result.status, 'complete');
  assert.equal(calls, 1);
  assert.equal(result.iterations.length, 1);
  assert.equal(result.iterations[0].evaluation.ok, true);
});

test('runAutonomousDevLoop retries bad structured output before completing', async () => {
  const outputs = [{ analysis: { summary: 'too little' } }, validReport()];
  const result = await runAutonomousDevLoop({
    goal,
    plan,
    action: async ({ iteration }) => outputs[iteration - 1],
    maxIterations: 3,
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.iterations.length, 2);
  assert.equal(result.iterations[0].evaluation.ok, false);
  assert.match(result.iterations[0].evaluation.reason, /missing fields/);
});

test('runAutonomousDevLoop retries inconsistent recommendation drift', async () => {
  const outputs = [validReport('For', 'medium'), validReport('Against', 'medium'), validReport('For', 'medium')];
  const result = await runAutonomousDevLoop({
    goal,
    plan,
    action: async ({ iteration }) => outputs[iteration - 1],
    evaluate: (report, context) => {
      if (context.iteration === 1) return { ok: false, reason: 'force second pass to check consistency' };
      const previousOptions = context.previous.map((item) => item.action_result.recommendation.suggested_option);
      const option = report.recommendation.suggested_option;
      const ok = previousOptions.includes(option);
      return { ok, reason: ok ? null : 'inconsistent recommendation compared with previous attempt' };
    },
    maxIterations: 3,
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.iterations.length, 3);
  assert.equal(result.iterations[1].evaluation.ok, false);
  assert.match(result.iterations[1].evaluation.reason, /inconsistent recommendation/);
});

test('runAutonomousDevLoop stops with needs_review after exhausted retries', async () => {
  const result = await runAutonomousDevLoop({
    goal,
    plan,
    action: async () => ({ recommendation: { suggested_option: 'For' } }),
    maxIterations: 2,
  });

  assert.equal(result.status, 'needs_review');
  assert.equal(result.iterations.length, 2);
  assert.equal(result.iterations.every((iteration) => iteration.evaluation.ok === false), true);
});
