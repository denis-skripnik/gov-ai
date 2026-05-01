function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseModelJsonOrNull(content) {
  const direct = safeJsonParse(content);
  if (direct) return direct;

  const fenced = String(content || '').match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const parsed = safeJsonParse(fenced[1].trim());
    if (parsed) return parsed;
  }

  const text = String(content || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return safeJsonParse(text.slice(start, end + 1));
  }

  return null;
}

const REQUIRED_TOP_LEVEL_FIELDS = ['input', 'extracted', 'analysis', 'recommendation', 'limitations'];
const REQUIRED_NESTED_FIELDS = [
  'analysis.summary',
  'analysis.key_changes',
  'analysis.risks',
  'analysis.benefits',
  'analysis.unknowns',
  'analysis.evidence_quotes',
  'recommendation.suggested_option',
  'recommendation.confidence',
  'recommendation.reasoning',
  'recommendation.conflicts_with_user_principles',
];

function hasValue(obj, path) {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || !(part in current)) return false;
    current = current[part];
  }
  return current !== undefined && current !== null;
}

export function evaluateBenchmarkOutputQuality(report) {
  const jsonValid = Boolean(report && typeof report === 'object' && !Array.isArray(report));
  if (!jsonValid) {
    return {
      json_valid: false,
      required_top_level_present: false,
      required_nested_fields_present: false,
      completeness_score: 0,
      missing_fields: [...REQUIRED_TOP_LEVEL_FIELDS, ...REQUIRED_NESTED_FIELDS],
    };
  }

  const missingTopLevel = REQUIRED_TOP_LEVEL_FIELDS.filter((field) => !hasValue(report, field));
  const missingNested = REQUIRED_NESTED_FIELDS.filter((field) => !hasValue(report, field));
  const totalRequired = REQUIRED_TOP_LEVEL_FIELDS.length + REQUIRED_NESTED_FIELDS.length;
  const missingFields = [...missingTopLevel, ...missingNested];
  const completeness = (totalRequired - missingFields.length) / totalRequired;

  return {
    json_valid: true,
    required_top_level_present: missingTopLevel.length === 0,
    required_nested_fields_present: missingNested.length === 0,
    completeness_score: Number(completeness.toFixed(3)),
    missing_fields: missingFields,
  };
}

export function classifyBenchmarkFailure(error) {
  const message = String(error?.message || error || 'Unknown error');
  const status = Number(error?.meta?.status || error?.status || error?.httpStatus || 0);
  const lower = message.toLowerCase();

  if (error?.name === 'AbortError' || lower.includes('aborted') || lower.includes('timed out')) {
    return { type: 'timeout', message };
  }
  if (lower.includes('invalid json response')) {
    return { type: 'invalid_json_response', message };
  }
  if (lower.includes('empty content')) {
    return { type: 'empty_content', message };
  }
  if (status === 429 || lower.includes('http 429') || lower.includes('too many requests')) {
    return { type: 'http_429', message };
  }
  if (status >= 500 && status < 600) {
    return { type: `http_${status}`, message };
  }
  if (status >= 400 && status < 500) {
    return { type: `http_${status}`, message };
  }
  return { type: 'other', message };
}

function summarizeNumbers(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    min: sorted[0],
    avg: Math.round(sum / sorted.length),
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function countBy(items) {
  return items.reduce((acc, item) => {
    acc[item] = (acc[item] || 0) + 1;
    return acc;
  }, {});
}

export function summarizeRuns(provider, runs) {
  const okRuns = runs.filter((run) => run.ok);
  const failRuns = runs.filter((run) => !run.ok);
  const latencies = okRuns.map((run) => run.latency_ms).filter(Number.isFinite);
  const totalAttempts = runs.reduce((sum, run) => sum + (run.attempts?.length || 0), 0);
  const totalRetries = runs.reduce((sum, run) => sum + Math.max(0, (run.attempts?.length || 0) - 1), 0);

  const usageAggregate = okRuns.reduce(
    (acc, run) => {
      const usage = run.usage;
      if (!usage || (!usage.prompt_tokens && !usage.completion_tokens && !usage.total_tokens)) return acc;
      acc.prompt_tokens += Number(usage.prompt_tokens || 0);
      acc.completion_tokens += Number(usage.completion_tokens || 0);
      acc.total_tokens += Number(usage.total_tokens || 0);
      acc.has_any = true;
      return acc;
    },
    { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, has_any: false }
  );

  const costAggregate = okRuns.reduce(
    (acc, run) => {
      const cost = run.cost_estimate;
      if (!cost || !Number.isFinite(cost.total_usd)) return acc;
      acc.total_usd += Number(cost.total_usd || 0);
      acc.input_usd += Number(cost.input_usd || 0);
      acc.output_usd += Number(cost.output_usd || 0);
      acc.has_any = true;
      return acc;
    },
    { total_usd: 0, input_usd: 0, output_usd: 0, has_any: false }
  );

  const qualityOkRuns = okRuns.map((run) => run.quality).filter(Boolean);
  const avgCompleteness = qualityOkRuns.length
    ? Number((qualityOkRuns.reduce((sum, quality) => sum + Number(quality.completeness_score || 0), 0) / qualityOkRuns.length).toFixed(3))
    : null;

  return {
    provider,
    runs_total: runs.length,
    runs_ok: okRuns.length,
    runs_fail: failRuns.length,
    avg_latency_ms_ok: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    latency_ms_ok: summarizeNumbers(latencies),
    total_attempts: totalAttempts,
    total_retries: totalRetries,
    usage_aggregate: usageAggregate.has_any ? usageAggregate : null,
    cost_aggregate_usd: costAggregate.has_any
      ? {
          total_usd: costAggregate.total_usd,
          input_usd: costAggregate.input_usd,
          output_usd: costAggregate.output_usd,
          avg_usd_per_ok_run: okRuns.length ? costAggregate.total_usd / okRuns.length : null,
        }
      : null,
    quality: {
      json_valid_ok_runs: qualityOkRuns.filter((quality) => quality.json_valid).length,
      schema_shaped_ok_runs: qualityOkRuns.filter(
        (quality) => quality.required_top_level_present && quality.required_nested_fields_present
      ).length,
      avg_completeness_score_ok_runs: avgCompleteness,
    },
    failure_modes: countBy(failRuns.map((run) => run.failure_type || 'other')),
  };
}
