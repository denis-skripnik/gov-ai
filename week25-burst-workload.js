import fs from 'node:fs';
import path from 'node:path';
import { callWithRetries, callAmbientForBuilderStage } from './week24-builder-workflow.js';

const DEFAULT_MODEL = 'ambient/large';
const DEFAULT_BASE_URL = 'https://api.ambient.xyz/v1';

export const DEFAULT_BURST_PHASES = [
  { id: 'quiet_baseline', concurrency: 1, requests: 1, prompt_size: 'short' },
  { id: 'parallel_burst', concurrency: 2, requests: 2, prompt_size: 'mixed' },
  { id: 'sustained_low_volume', concurrency: 1, requests: 2, prompt_size: 'long' },
  { id: 'recovery', concurrency: 1, requests: 1, prompt_size: 'coding' },
];

const PROMPTS = {
  short: 'Give three concise facts about HTTP request retries. Do not invent live measurements.',
  long: 'Explain a bounded retry strategy for a streaming coding-agent request. Include timeout, backoff, and when to stop. Stay concise.',
  coding: 'Suggest one small JavaScript test for a workload runner that records latency and error class. Do not claim it was executed.',
  mixed: 'You are one request in a small burst test. Explain how a developer should distinguish latency, timeout, and server error in a report.',
};

export function buildBurstStages({ project = 'gov-ai', phase, count }) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${phase.id}_${index + 1}`,
    tool_role: 'burst_probe',
    prompt: [`Project: ${project}.`, `Workload phase: ${phase.id}.`, PROMPTS[phase.prompt_size] || PROMPTS.short].join('\n'),
  }));
}

async function runLimited(stages, concurrency, runStage) {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < stages.length) {
      const index = cursor++;
      results[index] = await runStage(stages[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, stages.length) }, worker));
  return results;
}

export async function runWeek25BurstWorkload({
  project = 'gov-ai',
  outputDir = 'examples/week25-burst-workload',
  phases = DEFAULT_BURST_PHASES,
  model = DEFAULT_MODEL,
  baseUrl = DEFAULT_BASE_URL,
  attempts = 2,
  maxTokens = 900,
  stream = true,
  callStage,
  now = () => new Date().toISOString(),
} = {}) {
  const started_at = now();
  const phaseResults = [];
  const runStage = async (stage) => callWithRetries({
    stage,
    attempts,
    callStage: callStage || callAmbientForBuilderStage,
    model,
    baseUrl,
    maxTokens,
    stream,
  });

  for (const phase of phases) {
    const phaseStarted = now();
    const stages = buildBurstStages({ project, phase, count: phase.requests });
    const runs = await runLimited(stages, phase.concurrency, runStage);
    phaseResults.push({
      id: phase.id,
      concurrency: phase.concurrency,
      requests: phase.requests,
      prompt_size: phase.prompt_size,
      started_at: phaseStarted,
      completed_at: now(),
      results: runs,
    });
  }

  const attemptsAll = phaseResults.flatMap((phase) => phase.results.flatMap((run) => run.attempts));
  const finals = phaseResults.flatMap((phase) => phase.results.map((run) => run.final));
  const workload = {
    status: finals.every((result) => result.ok) ? 'complete' : 'needs_review',
    week: 25,
    theme: 'Under Pressure',
    workflow_type: 'bounded_demand_shift_workload',
    project,
    model_requested: model,
    started_at,
    completed_at: now(),
    phases: phaseResults,
    metrics: {
      requests_total: finals.length,
      successful_completions: finals.filter((result) => result.ok).length,
      failed_requests: finals.filter((result) => !result.ok).length,
      request_id_present: finals.filter((result) => result.request_id_present).length,
      streamed_requests: finals.filter((result) => result.first_byte_ms != null).length,
      retry_attempts_total: attemptsAll.length,
      failure_types: finals.filter((result) => !result.ok).map((result) => result.failure_type),
      returned_models: [...new Set(finals.map((result) => result.model_returned).filter(Boolean))],
    },
  };
  fs.mkdirSync(outputDir, { recursive: true });
  const json = path.join(outputDir, 'week25-burst-workload-output.json');
  const report = path.join(outputDir, 'week25-burst-workload-report.md');
  fs.writeFileSync(json, JSON.stringify(workload, null, 2));
  fs.writeFileSync(report, renderWeek25BurstReport(workload));
  workload.artifacts = { json, report };
  return workload;
}

export function renderWeek25BurstReport(workload) {
  const lines = [
    '# Week 25 bounded burst workload report', '',
    `Theme: ${workload.theme}`,
    `Status: ${workload.status}`,
    `Model requested: ${workload.model_requested}`,
    '', '## Metrics',
    `- requests: ${workload.metrics.successful_completions}/${workload.metrics.requests_total} successful`,
    `- failed requests: ${workload.metrics.failed_requests}`,
    `- request id present: ${workload.metrics.request_id_present}/${workload.metrics.requests_total}`,
    `- streamed requests: ${workload.metrics.streamed_requests}/${workload.metrics.requests_total}`,
    `- retry attempts total: ${workload.metrics.retry_attempts_total}`,
    `- returned models: ${workload.metrics.returned_models.join(', ') || 'not exposed'}`,
    '', '## Phases',
  ];
  for (const phase of workload.phases) {
    const finals = phase.results.map((run) => run.final);
    lines.push(`- ${phase.id}: concurrency ${phase.concurrency}, requests ${phase.requests}, success ${finals.filter((result) => result.ok).length}/${finals.length}`);
  }
  lines.push('', '## Scope', '', 'This is a bounded low-volume demand-shift probe, not a stress test and not evidence of network-wide capacity. Compare reports only when timestamps, prompt mix, and concurrency are recorded.');
  return lines.join('\n');
}
