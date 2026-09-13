import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BENCHMARK_CASES,
  MODEL_MATRIX,
  buildBenchmarkSchedule,
  canonicalJson,
  runWeek26DeveloperBenchmark,
  scoreBenchmarkOutput,
  summarizeModelRuns,
  week26ExitCode,
} from './week26-developer-benchmark.js';

test('model matrix separates direct models from routed baseline', () => {
  assert.deepEqual(MODEL_MATRIX.map((item) => item.requested_model), [
    'z-ai/glm-5.2',
    'qwen/qwen3.6-27b',
    'qwen/qwen3.8-27b',
    'ambient/large',
  ]);
  assert.equal(MODEL_MATRIX.filter((item) => item.comparison_group === 'direct').length, 3);
  assert.equal(MODEL_MATRIX.at(-1).comparison_group, 'routed_baseline');
});

test('builds a deterministic 24-cell serial schedule', () => {
  const schedule = buildBenchmarkSchedule();
  assert.equal(schedule.length, 24);
  assert.deepEqual(schedule[0], {
    repetition: 1,
    case_id: 'js_retry_partition',
    requested_model: 'z-ai/glm-5.2',
    comparison_group: 'direct',
  });
  assert.deepEqual(schedule.at(-1), {
    repetition: 2,
    case_id: 'failure_classification',
    requested_model: 'ambient/large',
    comparison_group: 'routed_baseline',
  });
});

test('scores exact, extra-key, partial, and malformed JSON deterministically', () => {
  const item = BENCHMARK_CASES[0];
  const exact = JSON.stringify(item.expected);
  assert.deepEqual(scoreBenchmarkOutput(item, exact), {
    json_valid: true,
    schema_valid: true,
    score: 100,
    exact_match: true,
    parsed_output: item.expected,
    evaluation_failures: [],
  });
  const extra = scoreBenchmarkOutput(item, JSON.stringify({ ...item.expected, extra: true }));
  assert.equal(extra.score, 80);
  assert.equal(extra.schema_valid, false);
  assert.deepEqual(extra.evaluation_failures, ['schema_mismatch']);
  const partial = scoreBenchmarkOutput(item, JSON.stringify({ ...item.expected, count: 2 }));
  assert.equal(partial.score, 80);
  assert.deepEqual(partial.evaluation_failures, ['wrong_answer']);
  const malformed = scoreBenchmarkOutput(item, '```json\n{}\n```');
  assert.equal(malformed.score, 0);
  assert.equal(malformed.json_valid, false);
  assert.deepEqual(malformed.evaluation_failures, ['malformed_json']);
});

test('patch selection rewards correct behavior without hidden reason-code vocabulary', () => {
  const item = BENCHMARK_CASES.find((candidate) => candidate.id === 'patch_selection');
  const output = JSON.stringify({
    choice: 'B',
    reason_code: 'checks response.ok and throws on non-2xx before parsing JSON',
    success_behavior: 'returns parsed JSON from response.json() for 2xx responses',
    error_behavior: 'throws an Error with HTTP status for non-2xx responses',
  });
  assert.equal(scoreBenchmarkOutput(item, output).score, 100);
  const alternateOrder = JSON.stringify({
    choice: 'B',
    reason_code: 'B checks response.ok and throws on non-2xx before parsing',
    success_behavior: 'For 2xx responses, returns the parsed JSON from response.json()',
    error_behavior: 'For non-2xx responses, throws an Error with the HTTP status code',
  });
  assert.equal(scoreBenchmarkOutput(item, alternateOrder).score, 100);
});

test('patch selection rejects negated behavior descriptions', () => {
  const item = BENCHMARK_CASES.find((candidate) => candidate.id === 'patch_selection');
  const result = scoreBenchmarkOutput(item, JSON.stringify({
    choice: 'B',
    reason_code: 'does not check status',
    success_behavior: 'does not return json',
    error_behavior: 'does not throw error',
  }));
  assert.ok(result.score < 100);
  assert.equal(result.exact_match, false);
  for (const phrase of ['no status check', 'status is not checked', "status isn't checked", "status won't be checked"]) {
    const adversarial = scoreBenchmarkOutput(item, JSON.stringify({
      choice: 'B',
      reason_code: phrase,
      success_behavior: 'returns no parsed json',
      error_behavior: 'throws no error with status',
    }));
    assert.ok(adversarial.score < 100, phrase);
    assert.equal(adversarial.exact_match, false, phrase);
  }
});

test('canonical JSON ignores object key order but preserves array order', () => {
  assert.equal(canonicalJson({ b: 2, a: [1, 2] }), canonicalJson({ a: [1, 2], b: 2 }));
  assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
});

test('summaries keep routed baseline outside deterministic direct ranking', () => {
  const runs = MODEL_MATRIX.flatMap((model, modelIndex) => BENCHMARK_CASES.flatMap((item) => [1, 2].map((repetition) => ({
    logical_run_id: `${modelIndex}-${item.id}-${repetition}`,
    repetition,
    case_id: item.id,
    comparison_group: model.comparison_group,
    model_requested: model.requested_model,
    model_returned: model.requested_model,
    final_ok: true,
    attempt_count: 1,
    request_id_present: true,
    stream_observed: true,
    latency_ms: 100 + modelIndex,
    ttft_ms: 10 + modelIndex,
    score: modelIndex === 1 ? 90 : 100,
    exact_match: modelIndex !== 1,
    json_valid: true,
    parsed_output: item.expected,
    failure_type: null,
  }))));
  const result = summarizeModelRuns(runs);
  assert.equal(result.model_summaries.length, 4);
  assert.equal(result.direct_ranking.length, 3);
  assert.equal(result.direct_ranking.some((item) => item.model_requested === 'ambient/large'), false);
  assert.equal(result.routed_baseline.model_requested, 'ambient/large');
});

test('summaries use the active custom model and case matrix', () => {
  const models = [{ requested_model: 'custom/direct', comparison_group: 'direct' }];
  const cases = [{ id: 'custom_case' }];
  const runs = [1, 2].map((repetition) => ({
    repetition,
    case_id: 'custom_case',
    model_requested: 'custom/direct',
    model_returned: 'custom/direct',
    final_ok: true,
    attempt_count: 1,
    request_id_present: true,
    stream_observed: true,
    latency_ms: 10,
    ttft_ms: 5,
    score: 100,
    exact_match: true,
    json_valid: true,
    parsed_output: { ok: true },
    failure_type: null,
  }));
  const result = summarizeModelRuns(runs, { models, cases });
  assert.deepEqual(result.model_summaries.map((item) => item.model_requested), ['custom/direct']);
  assert.equal(result.model_summaries[0].logical_requests, 2);
  assert.equal(result.routed_baseline, null);
});

test('runner executes serially, records outcomes, and writes reusable artifacts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-ai-week26-'));
  let active = 0;
  let maxActive = 0;
  const calls = [];
  const result = await runWeek26DeveloperBenchmark({
    outputDir: path.join(dir, 'out'),
    now: () => '2026-09-13T00:00:00.000Z',
    callStage: async ({ stage, model, temperature, systemPrompt }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push({ stage: stage.id, model, temperature, systemPrompt });
      const item = BENCHMARK_CASES.find((candidate) => stage.id.includes(candidate.id));
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return {
        ok: true,
        status: 200,
        request_id: `req-${calls.length}`,
        request_id_present: true,
        latency_ms: 20,
        first_byte_ms: 2,
        ttft_ms: 4,
        stream_observed: true,
        content_delta_count: 1,
        failure_type: null,
        model_requested: model,
        model_returned: model,
        output_text: JSON.stringify(item.expected),
        output_sha256: 'hash',
        usage: null,
      };
    },
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.runs.length, 24);
  assert.equal(maxActive, 1);
  assert.ok(calls.every((call) => call.temperature === 0));
  assert.ok(calls.every((call) => call.systemPrompt === result.configuration.system_prompt));
  assert.ok(result.model_summaries.every((summary) => summary.logical_requests === 6));
  assert.equal(result.direct_ranking.length, 3);
  assert.equal(fs.existsSync(result.artifacts.json), true);
  assert.equal(fs.existsSync(result.artifacts.markdown), true);
});

test('runner rejects unbounded or invalid numeric configuration', async () => {
  await assert.rejects(() => runWeek26DeveloperBenchmark({ attempts: 3 }), /attempts/);
  await assert.rejects(() => runWeek26DeveloperBenchmark({ attempts: Infinity }), /attempts/);
  await assert.rejects(() => runWeek26DeveloperBenchmark({ repetitions: 3 }), /repetitions/);
  await assert.rejects(() => runWeek26DeveloperBenchmark({ repetitions: 1 }), /repetitions/);
  await assert.rejects(() => runWeek26DeveloperBenchmark({ maxTokens: 0 }), /maxTokens/);
  await assert.rejects(() => runWeek26DeveloperBenchmark({ timeoutMs: NaN }), /timeoutMs/);
  await assert.rejects(() => runWeek26DeveloperBenchmark({ retryDelayMs: -1 }), /retryDelayMs/);
});

test('runner fails closed when request evidence is incomplete', async () => {
  const result = await runWeek26DeveloperBenchmark({
    outputDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gov-ai-week26-failed-')),
    callStage: async ({ model }) => ({
      ok: false,
      status: 500,
      request_id: null,
      request_id_present: false,
      latency_ms: 1,
      first_byte_ms: null,
      ttft_ms: null,
      stream_observed: false,
      failure_type: 'server',
      model_requested: model,
      model_returned: null,
    }),
    attempts: 1,
  });
  assert.equal(result.status, 'needs_review');
  assert.deepEqual(result.direct_ranking, []);
  assert.equal(week26ExitCode(result.status), 2);
  assert.equal(week26ExitCode('complete'), 0);
});
