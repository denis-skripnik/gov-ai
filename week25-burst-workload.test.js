import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBurstStages, runWeek25BurstWorkload } from './week25-burst-workload.js';

test('builds bounded phases with mixed prompts', () => {
  const stages = buildBurstStages({ phase: { id: 'parallel_burst', prompt_size: 'mixed' }, count: 2 });
  assert.equal(stages.length, 2);
  assert.match(stages[0].prompt, /parallel_burst/);
});

test('runs phases with bounded concurrency and aggregates outcomes', async () => {
  let active = 0;
  let maxActive = 0;
  const calls = [];
  const result = await runWeek25BurstWorkload({
    outputDir: '/tmp/week25-burst-test',
    phases: [
      { id: 'quiet', concurrency: 1, requests: 1, prompt_size: 'short' },
      { id: 'burst', concurrency: 2, requests: 2, prompt_size: 'mixed' },
    ],
    attempts: 1,
    callStage: async ({ stage }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(stage.id);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return { ok: true, status: 200, request_id_present: true, first_byte_ms: 1, latency_ms: 2, model_returned: 'ambient-test' };
    },
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.metrics.requests_total, 3);
  assert.equal(result.metrics.successful_completions, 3);
  assert.equal(result.metrics.request_id_present, 3);
  assert.equal(maxActive, 2);
  assert.deepEqual(calls, ['quiet_1', 'burst_1', 'burst_2']);
});
