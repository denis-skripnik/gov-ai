import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value, null, 2), 'utf8').digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function proposalMissingEvidence(proposal = {}) {
  const metadataMissing = proposal.metadata?.known_missing_evidence;
  if (Array.isArray(metadataMissing) && metadataMissing.length) return metadataMissing;
  const text = [proposal.title, proposal.body, proposal.description].filter(Boolean).join('\n').toLowerCase();
  const evidence = [];
  for (const item of ['invoice', 'signer list', 'recipient-control proof', 'budget breakdown']) {
    if (text.includes(item) || text.includes(item.replace('-', ' '))) evidence.push(item);
  }
  return evidence;
}

export function buildWeek22EvaluationCases(proposal = {}) {
  const missingEvidence = proposalMissingEvidence(proposal);
  return [
    {
      id: 'schema_governance_report',
      dimension: 'structured_output',
      title: 'Produce the gov-ai report schema exactly',
      prompt: 'Return only the structured governance report JSON with input, extracted, analysis, recommendation, and limitations.',
      expected_behaviors: ['valid_json_only', 'required_top_level_fields', 'required_nested_fields'],
      requires_live_api: false,
      product_use: 'Keeps reports machine-readable for the API, Telegram bot, and report viewer.',
    },
    {
      id: 'missing_evidence_guardrail',
      dimension: 'hallucination_resistance',
      title: 'Do not invent missing treasury evidence',
      prompt: `Assess the proposal while treating missing evidence as UNKNOWN: ${missingEvidence.join(', ') || 'none listed'}.`,
      expected_behaviors: ['marks_missing_evidence_unknown', 'does_not_invent_vote_results', 'cites_limitations'],
      requires_live_api: false,
      product_use: 'Protects conservative governance recommendations when extraction is incomplete.',
    },
    {
      id: 'treasury_reasoning_path',
      dimension: 'reasoning',
      title: 'Reason through treasury risk and voting options',
      prompt: 'Compare For, Against, and Abstain for a treasury transfer with missing controls and explain the conservative decision path.',
      expected_behaviors: ['weighs_options', 'separates_risk_from_benefit', 'explains_confidence'],
      requires_live_api: false,
      product_use: 'Helps route complex proposals to stronger deliberation models.',
    },
    {
      id: 'source_grounding_check',
      dimension: 'research_grounding',
      title: 'Ground claims in extracted source fields',
      prompt: 'List which claims are supported by extracted proposal fields and which require manual source review.',
      expected_behaviors: ['uses_extracted_fields_only', 'quotes_available_evidence', 'flags_manual_review'],
      requires_live_api: false,
      product_use: 'Makes source limitations visible before humans rely on a report.',
    },
    {
      id: 'fixture_regression_tooling',
      dimension: 'coding_tooling',
      title: 'Produce regression-ready fixture expectations',
      prompt: 'Turn this proposal into a deterministic regression fixture with expected unknowns and schema checks.',
      expected_behaviors: ['creates_testable_expectations', 'mentions_fixture_hash', 'keeps_secrets_out'],
      requires_live_api: false,
      product_use: 'Lets developers compare models and prompts without spending API calls.',
    },
  ];
}

export function defaultWeek22ModelProfiles() {
  return [
    {
      name: 'fast_summarizer',
      model: 'mock-fast-summary',
      strengths: ['structured_output'],
      weak_dimensions: ['hallucination_resistance', 'reasoning'],
      estimated_ttft_ms: 210,
      reliability: 0.9,
      cost_index: 1,
      notes: 'Useful for short schema-shaped summaries when risk is low.',
    },
    {
      name: 'conservative_verifier',
      model: 'mock-conservative-verifier',
      strengths: ['hallucination_resistance', 'research_grounding', 'structured_output'],
      weak_dimensions: ['coding_tooling'],
      estimated_ttft_ms: 520,
      reliability: 0.96,
      cost_index: 2,
      notes: 'Best fit for missing-evidence and source-grounding checks.',
    },
    {
      name: 'deep_governance_reasoner',
      model: 'mock-deep-governance',
      strengths: ['reasoning', 'hallucination_resistance'],
      weak_dimensions: [],
      estimated_ttft_ms: 820,
      reliability: 0.97,
      cost_index: 3,
      notes: 'Best fit for multi-step risk/recommendation tradeoffs.',
    },
    {
      name: 'code_tool_specialist',
      model: 'mock-code-tool-specialist',
      strengths: ['coding_tooling', 'structured_output'],
      weak_dimensions: ['research_grounding'],
      estimated_ttft_ms: 470,
      reliability: 0.94,
      cost_index: 2,
      notes: 'Best fit for fixture generation, regression checks, and artifact tooling.',
    },
  ];
}

function ratingForScore(score) {
  if (score >= 78) return 'strong_fit';
  if (score >= 60) return 'usable_with_review';
  return 'weak_fit';
}

export function evaluateModelOnCase(profile, evaluationCase) {
  if (!profile) throw new Error('profile is required');
  if (!evaluationCase) throw new Error('evaluationCase is required');

  const dimension = evaluationCase.dimension;
  const isStrength = profile.strengths.includes(dimension);
  const isWeak = profile.weak_dimensions.includes(dimension);
  const behaviorCoverage = evaluationCase.expected_behaviors.length
    ? Math.min(1, (isStrength ? evaluationCase.expected_behaviors.length : 1) / evaluationCase.expected_behaviors.length)
    : 0;
  const latencyBonus = Math.max(0, 8 - Math.round(profile.estimated_ttft_ms / 180));
  const reliabilityScore = Math.round(profile.reliability * 18);
  let score = 30 + reliabilityScore + latencyBonus + Math.round(behaviorCoverage * 15);
  if (isStrength) score += 25;
  if (isWeak) score -= 24;
  score = Math.max(0, Math.min(100, score));

  const cautionFlags = [];
  if (isWeak) cautionFlags.push(`weak_on_${dimension}`);
  if (!isStrength) cautionFlags.push(`not_primary_strength_for_${dimension}`);
  if (profile.cost_index >= 3) cautionFlags.push('higher_cost_or_latency_profile');

  return {
    profile: profile.name,
    model: profile.model,
    case_id: evaluationCase.id,
    dimension,
    score,
    rating: ratingForScore(score),
    estimated_ttft_ms: profile.estimated_ttft_ms,
    reliability: profile.reliability,
    cost_index: profile.cost_index,
    expected_behavior_coverage: Number(behaviorCoverage.toFixed(2)),
    caution_flags: cautionFlags,
    interpretation: isStrength
      ? `${profile.name} is a primary fit for ${dimension}.`
      : `${profile.name} can be tested on ${dimension}, but should not be treated as the default without review.`,
  };
}

function bestPerCase(evaluations) {
  const byCase = new Map();
  for (const evaluation of evaluations) {
    const current = byCase.get(evaluation.case_id);
    if (!current || evaluation.score > current.score || (evaluation.score === current.score && evaluation.estimated_ttft_ms < current.estimated_ttft_ms)) {
      byCase.set(evaluation.case_id, evaluation);
    }
  }
  return [...byCase.values()].map((evaluation) => ({
    case_id: evaluation.case_id,
    dimension: evaluation.dimension,
    best_profile: evaluation.profile,
    rating: evaluation.rating,
    score: evaluation.score,
    caution_flags: evaluation.caution_flags,
  }));
}

export function runWeek22ModelEvaluationBenchmark({
  proposalPath,
  outputDir = 'examples/week22-model-evaluation',
  profiles = defaultWeek22ModelProfiles(),
  now = () => new Date().toISOString(),
} = {}) {
  if (!proposalPath) throw new Error('proposalPath is required');
  const proposal = readJson(proposalPath);
  const startedAt = now();
  const cases = buildWeek22EvaluationCases(proposal);
  const evaluations = cases.flatMap((evaluationCase) => profiles.map((profile) => evaluateModelOnCase(profile, evaluationCase)));
  const recommendations = bestPerCase(evaluations);
  const strongFitCount = evaluations.filter((evaluation) => evaluation.rating === 'strong_fit').length;
  const artifact = {
    week: 22,
    theme: 'Beyond One Model',
    kind: 'gov-ai-week22-model-evaluation-benchmark',
    status: recommendations.length === cases.length ? 'complete' : 'needs_review',
    started_at: startedAt,
    finished_at: now(),
    proposal_source: proposalPath,
    proposal_fingerprint: sha256Json({ title: proposal.title, body: proposal.body, options: proposal.options, metadata: proposal.metadata }),
    profiles: profiles.map(({ name, model, strengths, weak_dimensions, estimated_ttft_ms, reliability, cost_index, notes }) => ({
      name, model, strengths, weak_dimensions, estimated_ttft_ms, reliability, cost_index, notes,
    })),
    cases,
    evaluations,
    recommendations,
    metrics: {
      models_compared: profiles.length,
      cases_evaluated: cases.length,
      evaluations_total: evaluations.length,
      strong_fit_count: strongFitCount,
      dimensions: cases.map((item) => item.dimension),
    },
    limitations: [
      'This is not a leaderboard-quality benchmark; it is a deterministic product benchmark over a small governance fixture.',
      'Scores are policy-fit heuristics for gov-ai routing and prompt evaluation, not measured model intelligence.',
      'Use live API results only as an additional low-volume smoke check, and keep outputs sanitized.',
    ],
  };
  artifact.benchmark_sha256 = sha256Json({ cases, evaluations, recommendations, metrics: artifact.metrics });
  artifact.artifacts = writeModelEvaluationArtifacts(artifact, outputDir);
  return artifact;
}

export function renderModelEvaluationMarkdown(artifact) {
  return [
    '# Week 22 model evaluation',
    '',
    `Theme: ${artifact.theme || 'Beyond One Model'}`,
    '',
    '## Result',
    `- Status: ${artifact.status}`,
    `- Models/profiles compared: ${artifact.metrics?.models_compared ?? 'n/a'}`,
    `- Evaluation cases: ${artifact.metrics?.cases_evaluated ?? 'n/a'}`,
    `- Strong-fit evaluations: ${artifact.metrics?.strong_fit_count ?? 'n/a'}`,
    `- Benchmark hash: ${artifact.benchmark_sha256 || 'not computed'}`,
    '',
    '## Best profile by product dimension',
    ...((artifact.recommendations || []).map((item) => `- ${item.dimension}: ${item.best_profile} — ${item.rating} (${item.score}/100)`)),
    '',
    '## Limitations',
    ...((artifact.limitations || []).map((item) => `- ${item}`)),
    '',
    '## Product use',
    'Use this artifact to choose which model/profile to try for each gov-ai task type: schema output, missing-evidence guardrails, reasoning, source grounding, and fixture/tooling work. Treat it as model-selection evidence for this product, not as a broad benchmark of model quality.',
    '',
  ].join('\n');
}

export function writeModelEvaluationArtifacts(artifact, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, 'week22-model-evaluation-output.json');
  const mdPath = path.join(outputDir, 'week22-model-evaluation-report.md');
  const artifactForDisk = { ...artifact };
  delete artifactForDisk.artifacts;
  fs.writeFileSync(jsonPath, JSON.stringify(artifactForDisk, null, 2));
  fs.writeFileSync(mdPath, renderModelEvaluationMarkdown(artifact));
  return { json: jsonPath, markdown: mdPath };
}
