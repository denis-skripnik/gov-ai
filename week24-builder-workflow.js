import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_BASE_URL = 'https://api.ambient.xyz/v1';
const DEFAULT_MODEL = 'ambient/large';

export function sha256Stable(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value, Object.keys(value || {}).sort()), 'utf8').digest('hex');
}

export function buildWeek24BuilderStages({ project = 'gov-ai', task = 'Add a small developer-facing integration example for Ambient-backed coding workflows.' } = {}) {
  return [
    {
      id: 'plan',
      tool_role: 'planner',
      prompt: [
        `Project: ${project}.`,
        'You are being used as the model inside a coding-agent-style workflow.',
        'Write a compact implementation plan for the task below.',
        'Keep it practical and mention files, tests, and risks.',
        `Task: ${task}`,
      ].join('\n'),
    },
    {
      id: 'implementation_sketch',
      tool_role: 'implementer',
      prompt: [
        `Project: ${project}.`,
        'Act like the implementation step of a coding agent.',
        'Return a concise patch sketch: file names, exported functions, CLI command, and test cases.',
        'Do not include secrets. Do not claim tests were run.',
        `Task: ${task}`,
      ].join('\n'),
    },
    {
      id: 'review',
      tool_role: 'reviewer',
      prompt: [
        `Project: ${project}.`,
        'Act like a code-review step for an Ambient-backed developer workflow.',
        'List acceptance checks, likely integration friction, and retry/streaming risks.',
        `Task: ${task}`,
      ].join('\n'),
    },
  ];
}

export function parseSseFrames(buffer) {
  const frames = buffer.split(/\r?\n\r?\n/);
  const remainder = frames.pop() ?? '';
  const data = [];
  for (const frame of frames) {
    const lines = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'));
    if (!lines.length) continue;
    data.push(lines.map((line) => line.slice(5).trimStart()).join('\n'));
  }
  return { data, remainder };
}

export function applyOpenAiCompatibleEvent(payload, state) {
  if (!payload || typeof payload !== 'object') return;
  const eventType = payload.type || payload.object || payload.event;
  if (eventType) state.event_types.add(eventType);
  if (payload.model) state.model_returned = payload.model;
  if (payload.usage) state.usage = payload.usage;
  if (payload.verified !== undefined) state.verified = payload.verified;
  if (payload.merkle_root || payload.merkleRoot) state.merkle_root_present = true;

  const delta = payload.choices?.[0]?.delta?.content;
  const message = payload.choices?.[0]?.message?.content;
  if (typeof delta === 'string') state.output += delta;
  if (typeof message === 'string') state.output += message;
}

export function classifyDeveloperWorkflowFailure(status, message = '') {
  const lower = String(message).toLowerCase();
  if (status === 401 || status === 403) return 'auth';
  if (status === 429 || lower.includes('too many') || lower.includes('no bidders') || lower.includes('no workers')) return 'capacity_or_rate_limit';
  if (lower.includes('timeout') || lower.includes('aborted')) return 'timeout';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'other';
}

function redactPreview(text) {
  return String(text || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[REDACTED]')
    .slice(0, 280);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readStreamResponse(response, state, started) {
  if (!response.body?.getReader) {
    const text = await response.text();
    try {
      applyOpenAiCompatibleEvent(JSON.parse(text), state);
    } catch {
      state.output += text;
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (state.first_byte_ms == null) state.first_byte_ms = Date.now() - started;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseFrames(buffer);
    buffer = parsed.remainder;
    for (const item of parsed.data) {
      if (!item || item === '[DONE]') continue;
      try {
        applyOpenAiCompatibleEvent(JSON.parse(item), state);
      } catch {
        state.event_types.add('unparseable_sse_json');
      }
    }
  }
  buffer += decoder.decode();
  const tail = parseSseFrames(`${buffer}\n\n`);
  for (const item of tail.data) {
    if (!item || item === '[DONE]') continue;
    try {
      applyOpenAiCompatibleEvent(JSON.parse(item), state);
    } catch {
      state.event_types.add('unparseable_sse_json');
    }
  }
}

export async function callAmbientForBuilderStage({
  stage,
  apiKey = process.env.AMBIENT_API_KEY,
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_MODEL,
  maxTokens = 500,
  timeoutMs = 90000,
  fetchImpl = globalThis.fetch,
  stream = true,
} = {}) {
  if (!stage?.id || !stage?.prompt) throw new Error('stage.id and stage.prompt are required');
  if (!apiKey) throw new Error('AMBIENT_API_KEY is required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

  const started = Date.now();
  const memBefore = process.memoryUsage().rss;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const state = {
    output: '',
    event_types: new Set(),
    model_returned: null,
    usage: null,
    verified: null,
    merkle_root_present: false,
    first_byte_ms: null,
  };

  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        stream,
        messages: [
          {
            role: 'system',
            content: 'You are the model inside a coding-agent workflow. Be concise, implementation-oriented, and do not invent executed test results.',
          },
          { role: 'user', content: stage.prompt },
        ],
        max_tokens: maxTokens,
        emit_usage: true,
        emit_ambient_events: true,
      }),
    });

    const requestIdPresent = Boolean(response.headers?.get?.('x-request-id'));
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        stage_id: stage.id,
        tool_role: stage.tool_role,
        ok: false,
        status: response.status,
        request_id_present: requestIdPresent,
        latency_ms: Date.now() - started,
        first_byte_ms: state.first_byte_ms,
        failure_type: classifyDeveloperWorkflowFailure(response.status, text),
        error_preview: redactPreview(text),
        memory_rss_delta_bytes: process.memoryUsage().rss - memBefore,
      };
    }

    await readStreamResponse(response, state, started);
    const output = state.output.trim();
    const reasoningTokens = Number(state.usage?.completion_tokens_details?.reasoning_tokens ?? 0);
    const failureType = output.length
      ? null
      : reasoningTokens >= maxTokens * 0.9
        ? 'reasoning_budget_exhausted'
        : 'empty_output';
    return {
      stage_id: stage.id,
      tool_role: stage.tool_role,
      ok: output.length > 0,
      status: response.status,
      request_id_present: requestIdPresent,
      latency_ms: Date.now() - started,
      first_byte_ms: state.first_byte_ms,
      failure_type: failureType,
      model_requested: model,
      model_returned: state.model_returned,
      output_chars: output.length,
      output_sha256: output ? crypto.createHash('sha256').update(output, 'utf8').digest('hex') : null,
      output_preview: output.slice(0, 700),
      event_types: [...state.event_types].sort(),
      verified: state.verified,
      merkle_root_present: state.merkle_root_present,
      usage: state.usage,
      memory_rss_delta_bytes: process.memoryUsage().rss - memBefore,
    };
  } catch (error) {
    return {
      stage_id: stage.id,
      tool_role: stage.tool_role,
      ok: false,
      status: null,
      request_id_present: false,
      latency_ms: Date.now() - started,
      first_byte_ms: state.first_byte_ms,
      failure_type: classifyDeveloperWorkflowFailure(null, error?.message || error),
      error_preview: redactPreview(error?.message || error),
      memory_rss_delta_bytes: process.memoryUsage().rss - memBefore,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function callWithRetries({ stage, attempts = 2, retryDelayMs = 1200, callStage = callAmbientForBuilderStage, ...options } = {}) {
  const tries = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await callStage({ stage, ...options });
    tries.push({ attempt, ...result });
    if (result.ok) return { final: result, attempts: tries };
    if (!['capacity_or_rate_limit', 'timeout', 'server'].includes(result.failure_type)) break;
    if (attempt < attempts) await sleep(retryDelayMs * attempt);
  }
  return { final: tries[tries.length - 1], attempts: tries };
}

export async function runWeek24BuilderWorkflow({
  project = 'gov-ai',
  task,
  outputDir = 'examples/week24-builder-workflow',
  model = DEFAULT_MODEL,
  baseUrl = DEFAULT_BASE_URL,
  maxTokens = 500,
  attempts = 2,
  stream = true,
  callStage,
  now = () => new Date().toISOString(),
} = {}) {
  const stages = buildWeek24BuilderStages({ project, task });
  const started_at = now();
  const results = [];
  for (const stage of stages) {
    const run = await callWithRetries({
      stage,
      attempts,
      callStage,
      model,
      baseUrl,
      maxTokens,
      stream,
    });
    results.push({ stage, ...run });
  }

  const okCount = results.filter((item) => item.final?.ok).length;
  const workflow = {
    status: okCount === stages.length ? 'complete' : 'needs_review',
    week: 24,
    theme: 'Builders First',
    started_at,
    completed_at: now(),
    project,
    model_requested: model,
    workflow_type: 'ambient_backed_coding_agent_style',
    metrics: {
      stages_total: stages.length,
      stages_ok: okCount,
      request_id_present: results.filter((item) => item.final?.request_id_present).length,
      streamed_stages: results.filter((item) => item.final?.first_byte_ms != null).length,
      retry_attempts_total: results.reduce((sum, item) => sum + item.attempts.length, 0),
      failures: results.filter((item) => !item.final?.ok).map((item) => ({ stage_id: item.stage.id, failure_type: item.final?.failure_type })),
    },
    stages: results.map((item) => ({
      id: item.stage.id,
      tool_role: item.stage.tool_role,
      final: item.final,
      attempts: item.attempts.map((attempt) => ({
        attempt: attempt.attempt,
        ok: attempt.ok,
        status: attempt.status,
        latency_ms: attempt.latency_ms,
        first_byte_ms: attempt.first_byte_ms,
        failure_type: attempt.failure_type,
        request_id_present: attempt.request_id_present,
      })),
    })),
  };
  workflow.workflow_sha256 = crypto.createHash('sha256').update(JSON.stringify(workflow), 'utf8').digest('hex');
  workflow.artifacts = writeWeek24BuilderWorkflowArtifacts(workflow, outputDir);
  return workflow;
}

export function writeWeek24BuilderWorkflowArtifacts(workflow, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, 'week24-builder-workflow-output.json');
  const markdownPath = path.join(outputDir, 'week24-builder-workflow-report.md');
  fs.writeFileSync(jsonPath, JSON.stringify(workflow, null, 2));
  fs.writeFileSync(markdownPath, renderWeek24BuilderWorkflowReport(workflow));
  return { json: jsonPath, markdown: markdownPath };
}

export function renderWeek24BuilderWorkflowReport(workflow) {
  const lines = [
    '# Week 24 builder workflow report',
    '',
    `Theme: ${workflow.theme}`,
    `Status: ${workflow.status}`,
    `Project: ${workflow.project}`,
    `Workflow type: ${workflow.workflow_type}`,
    `Model requested: ${workflow.model_requested}`,
    '',
    '## Metrics',
    `- stages ok: ${workflow.metrics.stages_ok}/${workflow.metrics.stages_total}`,
    `- request id present: ${workflow.metrics.request_id_present}/${workflow.metrics.stages_total}`,
    `- streamed stages: ${workflow.metrics.streamed_stages}/${workflow.metrics.stages_total}`,
    `- retry attempts total: ${workflow.metrics.retry_attempts_total}`,
    '',
    '## Stage results',
  ];
  for (const stage of workflow.stages) {
    lines.push(
      '',
      `### ${stage.id}`,
      `- role: ${stage.tool_role}`,
      `- ok: ${stage.final.ok}`,
      `- status: ${stage.final.status ?? 'null'}`,
      `- latency_ms: ${stage.final.latency_ms}`,
      `- first_byte_ms: ${stage.final.first_byte_ms ?? 'null'}`,
      `- request_id_present: ${stage.final.request_id_present}`,
      `- failure_type: ${stage.final.failure_type ?? 'null'}`,
    );
    if (stage.final.output_preview) {
      lines.push('', 'Output preview:', '', '```', stage.final.output_preview, '```');
    }
  }
  lines.push(
    '',
    '## Interpretation',
    '',
    'This is a developer-workflow probe, not a model leaderboard. It checks whether Ambient can sit behind a coding-agent-style loop with planning, implementation sketching, review, streaming, retries, auth, and report artifacts.',
    '',
    `Workflow sha256: ${workflow.workflow_sha256}`,
    '',
  );
  return lines.join('\n');
}
