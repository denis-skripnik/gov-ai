import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyOpenAiCompatibleEvent,
  buildWeek24BuilderStages,
  callAmbientForBuilderStage,
  classifyDeveloperWorkflowFailure,
  parseSseFrames,
  renderWeek24BuilderWorkflowReport,
  runWeek24BuilderWorkflow,
} from './week24-builder-workflow.js';

test('callAmbientForBuilderStage preserves request id and true content TTFT', async () => {
  const encoder = new TextEncoder();
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.temperature, 0);
    const stream = new ReadableStream({
      start(controller) {
        setTimeout(() => controller.enqueue(encoder.encode('data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":""}}]}\n\n')), 5);
        setTimeout(() => controller.enqueue(encoder.encode('data: {"object":"chat.completion.chunk","model":"z-ai/glm-5.2","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')), 20);
        setTimeout(() => controller.close(), 25);
      },
    });
    return new Response(stream, { status: 200, headers: { 'x-request-id': 'req-week26' } });
  };
  const result = await callAmbientForBuilderStage({
    stage: { id: 'telemetry', prompt: 'Return ok.' },
    apiKey: 'test-key',
    model: 'z-ai/glm-5.2',
    temperature: 0,
    fetchImpl,
  });
  assert.equal(result.request_id, 'req-week26');
  assert.equal(result.content_delta_count, 1);
  assert.equal(result.stream_observed, true);
  assert.ok(Number.isFinite(result.first_byte_ms));
  assert.ok(Number.isFinite(result.ttft_ms));
});

test('applyOpenAiCompatibleEvent sets TTFT only on first non-empty content delta', () => {
  const state = { output: '', event_types: new Set(), content_delta_count: 0, ttft_ms: null };
  applyOpenAiCompatibleEvent({ choices: [{ delta: { content: '' } }] }, state, 5);
  assert.equal(state.ttft_ms, null);
  applyOpenAiCompatibleEvent({ choices: [{ delta: { content: 'ok' } }] }, state, 20);
  applyOpenAiCompatibleEvent({ choices: [{ delta: { content: ' later' } }] }, state, 30);
  assert.equal(state.ttft_ms, 20);
  assert.equal(state.content_delta_count, 2);
});

test('buildWeek24BuilderStages creates a coding-agent-style sequence', () => {
  const stages = buildWeek24BuilderStages({ project: 'gov-ai', task: 'Add a reusable Ambient example.' });
  assert.deepEqual(stages.map((stage) => stage.id), ['plan', 'implementation_sketch', 'review']);
  assert.deepEqual(stages.map((stage) => stage.tool_role), ['planner', 'implementer', 'reviewer']);
  assert.ok(stages.every((stage) => stage.prompt.includes('gov-ai')));
  assert.ok(stages.every((stage) => stage.prompt.includes('Ambient')));
});

test('parseSseFrames handles OpenAI-compatible streaming frames', () => {
  const raw = 'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
    'data: [DONE]\n\npartial';
  const parsed = parseSseFrames(raw);
  assert.equal(parsed.data.length, 3);
  assert.equal(parsed.remainder, 'partial');
});

test('applyOpenAiCompatibleEvent collects streamed output and metadata', () => {
  const state = {
    output: '',
    event_types: new Set(),
    model_returned: null,
    usage: null,
    verified: null,
    merkle_root_present: false,
  };
  applyOpenAiCompatibleEvent({ object: 'chat.completion.chunk', model: 'ambient/large', choices: [{ delta: { content: 'Patch' } }] }, state);
  applyOpenAiCompatibleEvent({ choices: [{ delta: { content: ' ready' } }], verified: true, merkle_root: 'abc' }, state);
  assert.equal(state.output, 'Patch ready');
  assert.equal(state.model_returned, 'ambient/large');
  assert.equal(state.verified, true);
  assert.equal(state.merkle_root_present, true);
  assert.ok(state.event_types.has('chat.completion.chunk'));
});

test('classifyDeveloperWorkflowFailure identifies builder-workflow blockers', () => {
  assert.equal(classifyDeveloperWorkflowFailure(401, 'bad key'), 'auth');
  assert.equal(classifyDeveloperWorkflowFailure(429, 'no workers available'), 'capacity_or_rate_limit');
  assert.equal(classifyDeveloperWorkflowFailure(502, 'gateway'), 'server');
  assert.equal(classifyDeveloperWorkflowFailure(null, 'The operation was aborted'), 'timeout');
});

test('runWeek24BuilderWorkflow writes reusable artifacts with mocked Ambient calls', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-ai-week24-'));
  let calls = 0;
  const workflow = await runWeek24BuilderWorkflow({
    outputDir: path.join(dir, 'out'),
    now: () => '2026-08-27T00:00:00.000Z',
    callStage: async ({ stage }) => {
      calls += 1;
      return {
        stage_id: stage.id,
        tool_role: stage.tool_role,
        ok: true,
        status: 200,
        request_id_present: true,
        latency_ms: 10 + calls,
        first_byte_ms: 2,
        failure_type: null,
        model_requested: 'ambient/large',
        model_returned: 'z-ai/glm-5.2',
        output_chars: 30,
        output_sha256: `hash-${stage.id}`,
        output_preview: `Mock ${stage.id} output`,
        event_types: ['chat.completion.chunk'],
        verified: null,
        merkle_root_present: false,
        usage: null,
        memory_rss_delta_bytes: 0,
      };
    },
  });

  assert.equal(workflow.status, 'complete');
  assert.equal(workflow.metrics.stages_ok, 3);
  assert.equal(workflow.metrics.request_id_present, 3);
  assert.equal(workflow.metrics.streamed_stages, 3);
  assert.equal(workflow.metrics.retry_attempts_total, 3);
  assert.equal(fs.existsSync(workflow.artifacts.json), true);
  assert.equal(fs.existsSync(workflow.artifacts.markdown), true);
  const markdown = fs.readFileSync(workflow.artifacts.markdown, 'utf8');
  assert.match(markdown, /Week 24 builder workflow report/);
  assert.match(markdown, /coding-agent-style loop/);
});

test('renderWeek24BuilderWorkflowReport labels partial workflow as developer evidence', () => {
  const text = renderWeek24BuilderWorkflowReport({
    theme: 'Builders First',
    status: 'needs_review',
    project: 'gov-ai',
    workflow_type: 'ambient_backed_coding_agent_style',
    model_requested: 'ambient/large',
    metrics: { stages_ok: 1, stages_total: 3, request_id_present: 1, streamed_stages: 1, retry_attempts_total: 4 },
    stages: [
      { id: 'plan', tool_role: 'planner', final: { ok: false, status: 429, latency_ms: 100, first_byte_ms: null, request_id_present: true, failure_type: 'capacity_or_rate_limit' } },
    ],
    workflow_sha256: 'abc',
  });
  assert.match(text, /not a model leaderboard/i);
  assert.match(text, /capacity_or_rate_limit/);
});
