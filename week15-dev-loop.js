import { evaluateBenchmarkOutputQuality } from './bench-helpers.js';

function normalizeValue(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function recommendationKey(report) {
  const recommendation = report?.recommendation;
  if (!recommendation || typeof recommendation !== 'object') return null;
  const option = normalizeValue(recommendation.suggested_option);
  if (!option) return null;
  return `${option}|${normalizeValue(recommendation.confidence)}`;
}

export function defaultEvaluateDevLoopOutput(report, context = {}) {
  const quality = evaluateBenchmarkOutputQuality(report);
  const missingReason = quality.missing_fields?.length ? `missing fields: ${quality.missing_fields.join(', ')}` : null;

  const previousRecommendations = (context.previous || [])
    .map((iteration) => recommendationKey(iteration.action_result))
    .filter(Boolean);
  const currentRecommendation = recommendationKey(report);
  const inconsistentWithPrevious = Boolean(
    currentRecommendation && previousRecommendations.length && !previousRecommendations.includes(currentRecommendation)
  );

  return {
    ok: Boolean(
      quality.json_valid &&
        quality.required_top_level_present &&
        quality.required_nested_fields_present &&
        !inconsistentWithPrevious
    ),
    quality,
    reason: inconsistentWithPrevious ? 'inconsistent recommendation compared with previous attempt' : missingReason,
    recommendation_key: currentRecommendation,
  };
}

export async function runAutonomousDevLoop({
  goal,
  plan,
  action,
  evaluate = defaultEvaluateDevLoopOutput,
  maxIterations = 3,
} = {}) {
  if (!goal) throw new Error('goal is required');
  if (!Array.isArray(plan) || !plan.length) throw new Error('plan must be a non-empty array');
  if (typeof action !== 'function') throw new Error('action function is required');
  const iterationLimit = Math.max(1, Math.floor(Number(maxIterations) || 1));
  const iterations = [];

  for (let index = 0; index < iterationLimit; index += 1) {
    const iteration = index + 1;
    let actionResult;
    let evaluation;

    try {
      actionResult = await action({ goal, plan, iteration, previous: iterations });
      evaluation = await evaluate(actionResult, { goal, plan, iteration, previous: iterations });
    } catch (error) {
      actionResult = actionResult ?? null;
      evaluation = { ok: false, reason: String(error?.message || error || 'action failed') };
    }

    const record = {
      iteration,
      goal,
      plan,
      action_result: actionResult,
      evaluation,
    };
    iterations.push(record);

    if (evaluation?.ok) {
      return {
        status: 'complete',
        goal,
        plan,
        iterations,
        result: actionResult,
      };
    }
  }

  return {
    status: 'needs_review',
    goal,
    plan,
    iterations,
    result: iterations.at(-1)?.action_result ?? null,
  };
}
