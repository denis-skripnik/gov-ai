import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyBenchmarkFailure,
  evaluateBenchmarkOutputQuality,
  parseModelJsonOrNull,
  summarizeRuns,
} from './bench-helpers.js';

const validReport = {
  input: { url: 'https://example.com', fetched_at: '2026-04-29T00:00:00.000Z', source_type: 'snapshot' },
  extracted: {
    title: 'Proposal',
    body: 'Body',
    options: ['For', 'Against'],
    current_results: null,
    metadata: {},
  },
  analysis: {
    summary: 'Summary',
    key_changes: ['Change'],
    risks: ['Risk'],
    benefits: ['Benefit'],
    unknowns: ['Unknown'],
    evidence_quotes: ['Quote'],
  },
  recommendation: {
    suggested_option: 'For',
    confidence: 'medium',
    reasoning: 'Reasoning',
    conflicts_with_user_principles: [],
  },
  limitations: ['Limit'],
};

test('parseModelJsonOrNull accepts fenced JSON content', () => {
  const parsed = parseModelJsonOrNull('```json\n{"ok":true}\n```');
  assert.deepEqual(parsed, { ok: true });
});

test('evaluateBenchmarkOutputQuality reports full quality for schema-shaped output', () => {
  const quality = evaluateBenchmarkOutputQuality(validReport);
  assert.equal(quality.json_valid, true);
  assert.equal(quality.required_top_level_present, true);
  assert.equal(quality.required_nested_fields_present, true);
  assert.equal(quality.completeness_score, 1);
  assert.equal(quality.missing_fields.length, 0);
});

test('evaluateBenchmarkOutputQuality records missing fields and partial completeness', () => {
  const quality = evaluateBenchmarkOutputQuality({
    analysis: { summary: 'Only summary' },
    recommendation: { suggested_option: 'UNKNOWN' },
  });

  assert.equal(quality.json_valid, true);
  assert.equal(quality.required_top_level_present, false);
  assert.equal(quality.required_nested_fields_present, false);
  assert.ok(quality.completeness_score > 0 && quality.completeness_score < 1);
  assert.ok(quality.missing_fields.includes('input'));
  assert.ok(quality.missing_fields.includes('recommendation.reasoning'));
});

test('classifyBenchmarkFailure distinguishes retry-relevant and shape failures', () => {
  assert.equal(classifyBenchmarkFailure(new Error('provider: Invalid JSON response')).type, 'invalid_json_response');
  assert.equal(classifyBenchmarkFailure(new Error('provider: Empty content')).type, 'empty_content');
  assert.equal(classifyBenchmarkFailure(Object.assign(new Error('provider: HTTP 429'), { meta: { status: 429 } })).type, 'http_429');
  assert.equal(classifyBenchmarkFailure(new Error('AbortError: This operation was aborted')).type, 'timeout');
});

test('summarizeRuns aggregates Week 12 quality, latency, and failure modes', () => {
  const summary = summarizeRuns('ambient', [
    {
      ok: true,
      latency_ms: 100,
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      cost_estimate: { input_usd: 0.1, output_usd: 0.2, total_usd: 0.3 },
      attempts: [{ attempt: 1, ok: true }],
      quality: { json_valid: true, completeness_score: 1, required_top_level_present: true, required_nested_fields_present: true },
    },
    {
      ok: true,
      latency_ms: 300,
      usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
      cost_estimate: { input_usd: 0.05, output_usd: 0.05, total_usd: 0.1 },
      attempts: [{ attempt: 1, ok: true }, { attempt: 2, ok: true }],
      quality: { json_valid: true, completeness_score: 0.75, required_top_level_present: true, required_nested_fields_present: false },
    },
    {
      ok: false,
      latency_ms: null,
      usage: null,
      cost_estimate: null,
      attempts: [{ attempt: 1, ok: false }],
      failure_type: 'http_429',
      failure_message: 'provider: HTTP 429',
      quality: { json_valid: false, completeness_score: 0, required_top_level_present: false, required_nested_fields_present: false },
    },
  ]);

  assert.equal(summary.provider, 'ambient');
  assert.deepEqual(summary.latency_ms_ok, {
    min: 100,
    avg: 200,
    median: 100,
    p95: 300,
    max: 300,
  });
  assert.equal(summary.total_retries, 1);
  assert.deepEqual(summary.quality, {
    json_valid_ok_runs: 2,
    schema_shaped_ok_runs: 1,
    avg_completeness_score_ok_runs: 0.875,
  });
  assert.deepEqual(summary.failure_modes, {
    http_429: 1,
  });
});
