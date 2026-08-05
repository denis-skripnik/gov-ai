import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildWeek22EvaluationCases,
  defaultWeek22ModelProfiles,
  evaluateModelOnCase,
  runWeek22ModelEvaluationBenchmark,
  writeModelEvaluationArtifacts,
} from './week22-model-evaluation.js';

const proposal = {
  title: 'Q2 grants treasury transfer',
  body: 'Transfer 250,000 USDC from the community treasury to a grants multisig. Missing invoice, signer list, recipient-control proof, and budget breakdown.',
  options: ['For', 'Against', 'Abstain'],
  metadata: {
    known_missing_evidence: ['invoice', 'multisig signer list', 'recipient-control proof', 'budget breakdown'],
  },
};

test('buildWeek22EvaluationCases covers product governance strengths without live calls', () => {
  const cases = buildWeek22EvaluationCases(proposal);
  assert.equal(cases.length, 5);
  assert.deepEqual(cases.map((item) => item.dimension), [
    'structured_output',
    'hallucination_resistance',
    'reasoning',
    'research_grounding',
    'coding_tooling',
  ]);
  assert.ok(cases.every((item) => item.requires_live_api === false));
  assert.ok(cases.find((item) => item.dimension === 'hallucination_resistance').expected_behaviors.includes('marks_missing_evidence_unknown'));
});

test('evaluateModelOnCase rewards matching strengths and penalizes weak dimensions', () => {
  const cases = buildWeek22EvaluationCases(proposal);
  const profiles = defaultWeek22ModelProfiles();
  const hallucinationCase = cases.find((item) => item.dimension === 'hallucination_resistance');

  const conservative = evaluateModelOnCase(profiles.find((item) => item.name === 'conservative_verifier'), hallucinationCase);
  const fast = evaluateModelOnCase(profiles.find((item) => item.name === 'fast_summarizer'), hallucinationCase);

  assert.equal(conservative.rating, 'strong_fit');
  assert.ok(conservative.score > fast.score);
  assert.ok(fast.caution_flags.includes('weak_on_hallucination_resistance'));
});

test('runWeek22ModelEvaluationBenchmark creates model-selection evidence with limitations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-ai-week22-'));
  const proposalPath = path.join(dir, 'proposal.json');
  fs.writeFileSync(proposalPath, JSON.stringify(proposal, null, 2));

  const result = runWeek22ModelEvaluationBenchmark({
    proposalPath,
    outputDir: path.join(dir, 'out'),
    now: () => '2026-08-05T00:00:00.000Z',
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.week, 22);
  assert.equal(result.theme, 'Beyond One Model');
  assert.equal(result.cases.length, 5);
  assert.equal(result.metrics.models_compared, 4);
  assert.equal(result.metrics.cases_evaluated, 5);
  assert.ok(result.recommendations.some((item) => item.dimension === 'coding_tooling' && item.best_profile === 'code_tool_specialist'));
  assert.ok(result.limitations.some((item) => /not a leaderboard/i.test(item)));
  assert.equal(fs.existsSync(result.artifacts.json), true);
  assert.equal(fs.existsSync(result.artifacts.markdown), true);
});

test('writeModelEvaluationArtifacts writes a cautious human-readable report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-ai-week22-artifacts-'));
  const artifact = {
    status: 'complete',
    week: 22,
    theme: 'Beyond One Model',
    metrics: { models_compared: 2, cases_evaluated: 2, strong_fit_count: 2 },
    recommendations: [
      { dimension: 'reasoning', best_profile: 'deep_governance_reasoner', rating: 'strong_fit', score: 86 },
    ],
    limitations: ['This is not a leaderboard-quality benchmark.'],
    benchmark_sha256: 'abc123',
  };
  const paths = writeModelEvaluationArtifacts(artifact, dir);
  const markdown = fs.readFileSync(paths.markdown, 'utf8');

  assert.match(markdown, /Week 22 model evaluation/);
  assert.match(markdown, /Beyond One Model/);
  assert.match(markdown, /not a leaderboard-quality benchmark/i);
  assert.match(markdown, /deep_governance_reasoner/);
});
