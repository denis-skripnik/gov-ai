import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  intakeAgent,
  longContextAgent,
  toolReliabilityAgent,
  runWeek20AgentPipeline,
  writePipelineArtifacts,
} from './week20-agent-pipeline.js';

const proposal = {
  title: 'Treasury grant renewal',
  body: 'Transfer 250,000 USDC to 0x1234567890abcdef1234567890abcdef12345678 for Q2 grants. The invoice, signer list, recipient-control proof, and budget breakdown are missing.',
  options: ['For', 'Against', 'Abstain'],
  metadata: {
    known_missing_evidence: ['invoice', 'multisig signer list', 'recipient-control proof', 'budget breakdown'],
  },
};

const report = {
  extracted: proposal,
  analysis: {
    summary: 'Treasury grant renewal with unresolved evidence.',
    key_changes: ['Transfer 250,000 USDC'],
    risks: ['Recipient control is not proven.'],
    unknowns: ['invoice missing', 'budget breakdown missing'],
  },
  recommendation: {
    suggested_option: 'Against',
    confidence: 'medium',
  },
  verification_hooks: {
    status: 'warn',
  },
};

test('intakeAgent keeps the workflow centered on a governance proposal', () => {
  const stage = intakeAgent({ proposal, report, source: { proposal_path: 'fixture.json' } });
  assert.equal(stage.role, 'intake_agent');
  assert.equal(stage.status, 'complete');
  assert.equal(stage.output.title, 'Treasury grant renewal');
  assert.equal(stage.output.voting_options_count, 3);
});

test('longContextAgent creates bounded evidence windows for long proposal work', () => {
  const stage = longContextAgent({ proposal, report, maxWords: 8 });
  assert.equal(stage.role, 'long_context_agent');
  assert.ok(stage.output.evidence_windows.length > 1);
  assert.ok(stage.output.evidence_windows.every((window) => window.word_count <= 8));
});

test('toolReliabilityAgent flags missing product artifacts', () => {
  const stage = toolReliabilityAgent({ proposal, report: { analysis: { summary: 'x', unknowns: [] }, recommendation: {} } });
  assert.equal(stage.status, 'needs_review');
  assert.ok(stage.output.failed.includes('recommendation_present'));
  assert.ok(stage.output.failed.includes('verification_hooks_present'));
});

test('runWeek20AgentPipeline chains five stages and preserves council decision', () => {
  const pipeline = runWeek20AgentPipeline({
    proposal,
    report,
    source: { proposal_path: 'proposal.json', report_path: 'report.json' },
    runtime: { now: () => '2026-07-15T00:00:00.000Z' },
    maxWords: 12,
  });
  assert.equal(pipeline.kind, 'gov-ai-week20-agent-architecture-pipeline');
  assert.equal(pipeline.stage_count, 5);
  assert.equal(pipeline.stages.map((stage) => stage.role).join(' -> '), 'intake_agent -> long_context_agent -> tool_reliability_agent -> council_agent -> handoff_agent');
  assert.equal(pipeline.stages[3].output.shared_memory.decision.suggested_option, 'Against');
  assert.match(pipeline.pipeline_sha256, /^[a-f0-9]{64}$/);
});

test('writePipelineArtifacts writes JSON and Markdown evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-ai-week20-'));
  const pipeline = runWeek20AgentPipeline({ proposal, report, runtime: { now: () => '2026-07-15T00:00:00.000Z' } });
  const artifacts = writePipelineArtifacts(pipeline, dir);
  assert.ok(fs.existsSync(artifacts.json));
  assert.ok(fs.existsSync(artifacts.markdown));
  const md = fs.readFileSync(artifacts.markdown, 'utf8');
  assert.match(md, /governance proposals/);
  assert.match(md, /Intake agent -> Long-context agent/);
});
