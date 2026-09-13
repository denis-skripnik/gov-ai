import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { callAmbientForBuilderStage, callWithRetries } from './week24-builder-workflow.js';

export const SYSTEM_PROMPT = 'You are completing a deterministic developer benchmark. Return exactly one JSON object and no markdown, prose, comments, or code fences. Preserve array order. Do not add keys.';

export const MODEL_MATRIX = [
  { requested_model: 'z-ai/glm-5.2', comparison_group: 'direct' },
  { requested_model: 'qwen/qwen3.6-27b', comparison_group: 'direct' },
  { requested_model: 'qwen/qwen3.8-27b', comparison_group: 'direct' },
  { requested_model: 'ambient/large', comparison_group: 'routed_baseline' },
];

export const BENCHMARK_CASES = [
  {
    id: 'js_retry_partition',
    prompt: `Analyze this JavaScript:\n\nfunction retryable(status) {\n  return status === 429 || status >= 500;\n}\n\nApply retryable to these statuses in this exact order:\n[200, 400, 429, 500, 503]\n\nReturn exactly these keys:\nretryable: the retryable statuses\nnon_retryable: the remaining statuses\ncount: the number of retryable statuses`,
    expected: { retryable: [429, 500, 503], non_retryable: [200, 400], count: 3 },
    weights: { retryable: 30, non_retryable: 30, count: 20 },
    schema_points: 20,
  },
  {
    id: 'patch_selection',
    prompt: `Current JavaScript:\n\nasync function fetchJson(url) {\n  const response = await fetch(url);\n  return response.json();\n}\n\nChoose the one patch that makes non-2xx responses throw while preserving parsed JSON on success.\n\nA:\nconst response = await fetch(url);\nreturn response.json();\n\nB:\nconst response = await fetch(url);\nif (!response.ok) throw new Error(\`HTTP \${response.status}\`);\nreturn response.json();\n\nC:\ntry {\n  const response = await fetch(url);\n  return await response.json();\n} catch {\n  return {};\n}\n\nReturn exactly these keys:\nchoice\nreason_code\nsuccess_behavior\nerror_behavior`,
    expected: { choice: 'B', reason_code: 'checks_response_ok', success_behavior: 'returns_parsed_json', error_behavior: 'throws_on_non_2xx' },
    weights: { choice: 20, reason_code: 20, success_behavior: 20, error_behavior: 20 },
    schema_points: 20,
  },
  {
    id: 'failure_classification',
    prompt: `Use this ordered classification policy:\n\n1. Status 401 or 403 => auth\n2. Status 429, or a message containing "no workers" => capacity_or_rate_limit\n3. A message containing "timeout" or "aborted" => timeout\n4. Status 500 or greater => server\n5. Status 400 or greater => client\n6. Otherwise => other\n\nClassify these inputs in their exact order:\n\n0. status=401, message="bad key"\n1. status=429, message="busy"\n2. status=null, message="operation aborted"\n3. status=502, message="gateway"\n4. status=404, message="missing"\n5. status=200, message="ok"\n\nRetries are allowed only for capacity_or_rate_limit, timeout, and server.\n\nReturn exactly these keys:\nlabels: one classification per input\nretryable_indices: zero-based indices of retryable inputs`,
    expected: { labels: ['auth', 'capacity_or_rate_limit', 'timeout', 'server', 'client', 'other'], retryable_indices: [1, 2, 3] },
    weights: { labels: 50, retryable_indices: 30 },
    schema_points: 20,
  },
];

function hash(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').digest('hex');
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

export function buildBenchmarkSchedule({ models = MODEL_MATRIX, cases = BENCHMARK_CASES, repetitions = 2 } = {}) {
  const schedule = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const item of cases) {
      for (const model of models) {
        schedule.push({ repetition, case_id: item.id, requested_model: model.requested_model, comparison_group: model.comparison_group });
      }
    }
  }
  return schedule;
}

export function scoreBenchmarkOutput(item, outputText) {
  let parsed;
  try {
    parsed = JSON.parse(String(outputText).trim());
  } catch {
    return { json_valid: false, schema_valid: false, score: 0, exact_match: false, parsed_output: null, evaluation_failures: ['malformed_json'] };
  }
  const expectedKeys = Object.keys(item.expected);
  const actualKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [];
  const schemaValid = canonicalJson(actualKeys.sort()) === canonicalJson([...expectedKeys].sort());
  let score = schemaValid ? item.schema_points : 0;
  for (const key of expectedKeys) {
    let matches = canonicalJson(parsed?.[key]) === canonicalJson(item.expected[key]);
    if (item.id === 'patch_selection' && typeof parsed?.[key] === 'string') {
      const value = parsed[key].toLowerCase().replaceAll('_', ' ').replace(/\s+/g, ' ').trim();
      const negated = /\b(?:no|not|never|without|cannot|can't|doesn't|does not|isn't|is not|won't|will not|fails? to)\b/.test(value);
      if (negated) matches = false;
      else if (key === 'choice') matches = value === 'b';
      else if (key === 'reason_code') matches = value === 'checks response ok' || value === 'checks response.ok' || value.includes('checks response.ok') || value.includes('status check');
      else if (key === 'success_behavior') matches = value.includes('returns') && (value.includes('parsed json') || value.includes('json from response.json'));
      else if (key === 'error_behavior') matches = value === 'throws error' || (value.includes('throws') && (value.includes('non-2xx') || value.includes('status')));
    }
    if (matches) score += item.weights[key];
  }
  const exactMatch = schemaValid && score === 100;
  const failures = [];
  if (!schemaValid) failures.push('schema_mismatch');
  if (!exactMatch && schemaValid) failures.push('wrong_answer');
  return { json_valid: true, schema_valid: schemaValid, score, exact_match: exactMatch, parsed_output: parsed, evaluation_failures: failures };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { min: null, median: null, max: null };
  return { min: sorted[0], median: median(sorted), max: sorted.at(-1) };
}

export function summarizeModelRuns(runs, { models = MODEL_MATRIX, cases = BENCHMARK_CASES } = {}) {
  const modelSummaries = models.map((model) => {
    const subset = runs.filter((run) => run.model_requested === model.requested_model);
    const successful = subset.filter((run) => run.final_ok);
    const consistentCases = cases.filter((item) => {
      const pair = subset.filter((run) => run.case_id === item.id);
      return pair.length === 2 && pair.every((run) => run.final_ok && run.json_valid) && canonicalJson(pair[0].parsed_output) === canonicalJson(pair[1].parsed_output);
    }).length;
    const returned = {};
    for (const run of subset) {
      const key = run.model_returned || 'not_exposed';
      returned[key] = (returned[key] || 0) + 1;
    }
    const failureTypes = {};
    for (const run of subset.filter((item) => item.failure_type)) failureTypes[run.failure_type] = (failureTypes[run.failure_type] || 0) + 1;
    return {
      model_requested: model.requested_model,
      comparison_group: model.comparison_group,
      logical_requests: subset.length,
      attempts_total: subset.reduce((sum, run) => sum + run.attempt_count, 0),
      correctness_percent: subset.length ? subset.reduce((sum, run) => sum + run.score, 0) / subset.length : 0,
      exact_match_rate: subset.length ? subset.filter((run) => run.exact_match).length / subset.length : 0,
      completion_rate: subset.length ? successful.length / subset.length : 0,
      json_valid_rate: subset.length ? subset.filter((run) => run.json_valid).length / subset.length : 0,
      request_id_rate: subset.length ? subset.filter((run) => run.request_id_present).length / subset.length : 0,
      stream_observed_rate: subset.length ? subset.filter((run) => run.stream_observed).length / subset.length : 0,
      consistency_percent: cases.length ? 100 * consistentCases / cases.length : 0,
      retry_rate: subset.length ? subset.filter((run) => run.attempt_count > 1).length / subset.length : 0,
      returned_model_counts: returned,
      latency_ms: distribution(successful.map((run) => run.latency_ms)),
      ttft_ms: distribution(successful.map((run) => run.ttft_ms)),
      failure_type_counts: failureTypes,
    };
  });
  const directRanking = modelSummaries.filter((item) => item.comparison_group === 'direct').sort((a, b) =>
    b.correctness_percent - a.correctness_percent ||
    b.exact_match_rate - a.exact_match_rate ||
    b.completion_rate - a.completion_rate ||
    b.consistency_percent - a.consistency_percent ||
    (a.ttft_ms.median ?? Infinity) - (b.ttft_ms.median ?? Infinity) ||
    (a.latency_ms.median ?? Infinity) - (b.latency_ms.median ?? Infinity) ||
    a.model_requested.localeCompare(b.model_requested)
  ).map((item, index) => ({ rank: index + 1, model_requested: item.model_requested }));
  const routed = modelSummaries.find((item) => item.comparison_group === 'routed_baseline');
  return {
    model_summaries: modelSummaries,
    direct_ranking: directRanking,
    routed_baseline: routed ? { model_requested: routed.model_requested, summary_ref: routed.model_requested } : null,
  };
}

export function validateWeek26Config({ attempts, repetitions, maxTokens, timeoutMs, retryDelayMs }) {
  const requireInteger = (name, value, min, max) => {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  };
  requireInteger('attempts', attempts, 1, 2);
  requireInteger('repetitions', repetitions, 2, 2);
  requireInteger('maxTokens', maxTokens, 1, 10000);
  requireInteger('timeoutMs', timeoutMs, 1, 300000);
  requireInteger('retryDelayMs', retryDelayMs, 0, 60000);
}

export function week26ExitCode(status) {
  return status === 'complete' ? 0 : 2;
}

export async function runWeek26DeveloperBenchmark({
  outputDir = 'examples/week26-model-showdown',
  models = MODEL_MATRIX,
  cases = BENCHMARK_CASES,
  repetitions = 2,
  attempts = 2,
  retryDelayMs = 1200,
  maxTokens = 900,
  timeoutMs = 90000,
  baseUrl = 'https://api.ambient.xyz/v1',
  callStage = callAmbientForBuilderStage,
  now = () => new Date().toISOString(),
} = {}) {
  validateWeek26Config({ attempts, repetitions, maxTokens, timeoutMs, retryDelayMs });
  const startedMs = Date.now();
  const startedAt = now();
  const schedule = buildBenchmarkSchedule({ models, cases, repetitions });
  const runs = [];
  for (const cell of schedule) {
    const item = cases.find((candidate) => candidate.id === cell.case_id);
    const stage = { id: `week26-${cell.case_id}-r${cell.repetition}-${cell.requested_model.replace(/[^a-z0-9]+/gi, '_')}`, tool_role: 'model_benchmark', prompt: item.prompt };
    const result = await callWithRetries({
      stage, attempts, retryDelayMs, callStage, model: cell.requested_model, baseUrl,
      maxTokens, timeoutMs, stream: true, temperature: 0, systemPrompt: SYSTEM_PROMPT,
    });
    const final = result.final;
    const evaluation = final.ok ? scoreBenchmarkOutput(item, final.output_text ?? final.output_preview ?? '') : {
      json_valid: false, schema_valid: false, score: 0, exact_match: false, parsed_output: null, evaluation_failures: [],
    };
    runs.push({
      logical_run_id: `${cell.repetition}-${cell.case_id}-${cell.requested_model}`,
      repetition: cell.repetition,
      case_id: cell.case_id,
      comparison_group: cell.comparison_group,
      model_requested: cell.requested_model,
      model_returned: final.model_returned || null,
      returned_model_matches_request: final.model_returned ? final.model_returned === cell.requested_model : null,
      final_ok: Boolean(final.ok),
      attempt_count: result.attempts.length,
      request_id: final.request_id || null,
      request_id_present: Boolean(final.request_id_present),
      stream_observed: Boolean(final.stream_observed),
      status: final.status,
      latency_ms: final.latency_ms,
      first_byte_ms: final.first_byte_ms,
      ttft_ms: final.ttft_ms,
      failure_type: final.failure_type,
      output_text: final.output_text ?? final.output_preview ?? '',
      output_sha256: final.output_sha256 || null,
      usage: final.usage || null,
      ...evaluation,
      attempts: result.attempts.map((attempt) => ({
        attempt: attempt.attempt, ok: attempt.ok, status: attempt.status, request_id: attempt.request_id || null,
        model_returned: attempt.model_returned || null, latency_ms: attempt.latency_ms,
        first_byte_ms: attempt.first_byte_ms, ttft_ms: attempt.ttft_ms,
        stream_observed: Boolean(attempt.stream_observed), failure_type: attempt.failure_type,
      })),
    });
  }
  const summaries = summarizeModelRuns(runs, { models, cases });
  const evidenceComplete = runs.length === schedule.length && runs.every((run) =>
    run.final_ok && run.json_valid && run.request_id_present && run.stream_observed
  );
  if (!evidenceComplete) summaries.direct_ranking = [];
  const benchmark = {
    kind: 'gov-ai-week26-developer-benchmark',
    schema_version: 1,
    week: 26,
    theme: 'Model Showdown',
    status: evidenceComplete ? 'complete' : 'needs_review',
    window_started_at: startedAt,
    window_completed_at: now(),
    window_duration_ms: Date.now() - startedMs,
    configuration: {
      temperature: 0, max_tokens: maxTokens, stream: true, fast_mode: false,
      attempts_max: attempts, retry_delay_ms: retryDelayMs, timeout_ms: timeoutMs,
      concurrency: 1, repetitions,
      model_order: models.map((item) => item.requested_model),
      case_order: cases.map((item) => item.id),
      system_prompt: SYSTEM_PROMPT,
      system_prompt_sha256: hash(SYSTEM_PROMPT),
      cases_sha256: hash(cases.map(({ id, prompt, expected }) => ({ id, prompt, expected }))),
    },
    cases: cases.map(({ id, prompt, expected }) => ({ id, prompt, expected, max_score: 100 })),
    runs,
    ...summaries,
    human_review: { included_in_score: false, reviewer: null, notes: null },
    limitations: [
      'Small deterministic developer probe, not a general model leaderboard.',
      'API evidence only; no web-UI behavior was tested.',
      'Latency observations apply only to the recorded time window.',
    ],
  };
  benchmark.benchmark_sha256 = hash(benchmark);
  fs.mkdirSync(outputDir, { recursive: true });
  const json = path.join(outputDir, 'week26-model-showdown-output.json');
  const markdown = path.join(outputDir, 'week26-model-showdown-report.md');
  fs.writeFileSync(json, JSON.stringify(benchmark, null, 2));
  fs.writeFileSync(markdown, renderWeek26Report(benchmark));
  benchmark.artifacts = { json, markdown };
  return benchmark;
}

export function renderWeek26Report(benchmark) {
  const lines = [
    '# Week 26 model showdown report', '',
    `Status: ${benchmark.status}`,
    `Window: ${benchmark.window_started_at} — ${benchmark.window_completed_at}`,
    `Logical requests: ${benchmark.runs.length}`, '',
    '## Direct model ranking',
    ...benchmark.direct_ranking.map((item) => `${item.rank}. ${item.model_requested}`), '',
    '## Model summaries',
  ];
  for (const item of benchmark.model_summaries) {
    lines.push(`### ${item.model_requested}`, `- group: ${item.comparison_group}`, `- correctness: ${item.correctness_percent}/100`, `- exact matches: ${Math.round(item.exact_match_rate * item.logical_requests)}/${item.logical_requests}`, `- completion: ${Math.round(item.completion_rate * item.logical_requests)}/${item.logical_requests}`, `- consistency: ${item.consistency_percent}%`, `- latency median: ${item.latency_ms.median} ms`, `- TTFT median: ${item.ttft_ms.median} ms`, `- returned models: ${JSON.stringify(item.returned_model_counts)}`, '');
  }
  lines.push('## Scope', '', ...benchmark.limitations.map((item) => `- ${item}`));
  return lines.join('\n');
}
