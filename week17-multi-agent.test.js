import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  renderCouncilMarkdown,
  runMultiAgentCouncil,
  writeCouncilArtifacts,
} from './week17-multi-agent.js';

const proposal = {
  title: 'Q2 grants treasury transfer',
  body: 'Transfer 250,000 USDC from the community treasury to 0x1234567890abcdef1234567890abcdef12345678 for Q2 grants funding. The recipient is described as the grants multisig, but no invoice or multisig signer list is included.',
  options: ['For', 'Against', 'Abstain'],
  metadata: {
    known_missing_evidence: ['invoice', 'multisig signer list', 'recipient-control proof', 'budget breakdown'],
  },
};

const report = {
  extracted: proposal,
  analysis: {
    key_changes: ['Transfer 250,000 USDC from community treasury to 0x1234567890abcdef1234567890abcdef12345678'],
    risks: ['No invoice is included to validate the legitimacy or amount of the funding request'],
    unknowns: [
      'Unclear: whether 0x1234567890abcdef1234567890abcdef12345678 is actually controlled by the grants multisig',
      'Unclear: how the 250,000 USDC will be allocated across specific grants (no budget breakdown provided)',
    ],
  },
  recommendation: {
    suggested_option: 'Against',
    confidence: 'high',
  },
};

test('week17 council runs specialized agents over shared memory in order', () => {
  const state = runMultiAgentCouncil({
    proposal,
    report,
    source: { test: true },
    runtime: { now: () => '2026-06-17T00:00:00.000Z' },
  });

  assert.deepEqual(state.agents.map((agent) => agent.role), [
    'research_agent',
    'risk_analysis_agent',
    'decision_agent',
    'verification_agent',
  ]);
  assert.equal(state.run.agent_count, 4);
  assert.equal(state.messages.length, 4);
  assert.ok(state.shared_memory.facts.find((fact) => fact.key === 'amount'));
  assert.ok(state.shared_memory.facts.find((fact) => fact.key === 'addresses'));
  assert.equal(state.shared_memory.decision.suggested_option, 'Against');
  assert.equal(state.shared_memory.verification.status, 'verified');
  assert.match(state.shared_memory.verification.shared_state_sha256, /^[a-f0-9]{64}$/);
});

test('week17 council propagates high-severity risks into decision blockers', () => {
  const state = runMultiAgentCouncil({ proposal, report });
  const highRisks = state.shared_memory.risks.filter((risk) => risk.severity === 'high');

  assert.ok(highRisks.length >= 1);
  for (const risk of highRisks) {
    assert.ok(state.shared_memory.decision.blockers.includes(risk.text));
  }
});

test('week17 council preserves primary report confidence when no high-severity blocker exists', () => {
  const oracleProposal = {
    title: 'Oracle feed update',
    body: 'Update 21 markets from Pyth Core to Pyth Pro. By voting yes you support it. By voting abstain you decline to vote.',
    options: ['YES', 'NO', 'NO_WITH_VETO', 'ABSTAIN'],
  };
  const oracleReport = {
    extracted: oracleProposal,
    analysis: {
      key_changes: ['Update 21 markets from Pyth Core to Pyth Pro'],
      risks: ['Oracle feed changes require caution'],
      unknowns: ['Current voting results are unavailable'],
    },
    recommendation: {
      suggested_option: 'ABSTAIN',
      confidence: 'low',
    },
  };

  const state = runMultiAgentCouncil({ proposal: oracleProposal, report: oracleReport });
  assert.equal(state.shared_memory.decision.suggested_option, 'ABSTAIN');
  assert.equal(state.shared_memory.decision.confidence, 'low');
  assert.deepEqual(state.shared_memory.decision.blockers, []);
});

test('week17 council writes reproducible review artifacts', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-ai-week17-'));
  const state = runMultiAgentCouncil({ proposal, report });

  try {
    const artifacts = writeCouncilArtifacts(state, tempDir);
    for (const artifactPath of Object.values(artifacts)) {
      assert.equal(fs.existsSync(artifactPath), true);
    }

    const savedState = JSON.parse(fs.readFileSync(artifacts.jsonPath, 'utf8'));
    assert.equal(savedState.shared_memory.decision.suggested_option, 'Against');
    assert.match(fs.readFileSync(artifacts.mdPath, 'utf8'), /Research agent -> Risk analysis agent -> Decision agent -> Verification agent/);
    assert.match(fs.readFileSync(artifacts.svgPath, 'utf8'), /shared JSON memory/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('week17 council markdown summarizes the workflow and hash', () => {
  const state = runMultiAgentCouncil({ proposal, report });
  const markdown = renderCouncilMarkdown(state);

  assert.match(markdown, /Week 17 multi-agent governance council/);
  assert.match(markdown, /Shared-state hash: [a-f0-9]{64}/);
  assert.match(markdown, /Why this improves gov-ai/);
});
