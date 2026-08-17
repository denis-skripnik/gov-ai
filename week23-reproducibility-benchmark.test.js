import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  renderVerificationRepeatabilityMarkdown,
  runVerificationRepeatabilityBenchmark,
  runWeek23VerificationBenchmark,
  writeVerificationRepeatabilityArtifacts,
} from './week23-reproducibility-benchmark.js';

const extracted = {
  title: 'Q2 grants treasury transfer',
  body: 'Transfer 250,000 USDC from the community treasury to 0x1234567890abcdef1234567890abcdef12345678 for Q2 grants funding. The recipient is described as the grants multisig, but no invoice or multisig signer list is included.',
  options: ['For', 'Against', 'Abstain'],
  current_results: null,
  metadata: {
    known_missing_evidence: ['invoice', 'multisig signer list', 'recipient-control proof', 'budget breakdown'],
  },
};

const report = {
  input: { url: 'fixture://treasury-transfer' },
  extracted,
  analysis: {
    summary: 'Transfer 250,000 USDC from the community treasury to 0x1234567890abcdef1234567890abcdef12345678.',
    risks: ['The transfer could increase treasury risk without a signer list.'],
    unknowns: ['Unclear whether the recipient address is controlled by the grants multisig.'],
    evidence_quotes: ['Transfer 250,000 USDC from the community treasury to 0x1234567890abcdef1234567890abcdef12345678 for Q2 grants funding.'],
  },
  recommendation: {
    suggested_option: 'Against',
    confidence: 'high',
    reasoning: 'Recommend Against until the missing invoice, signer list, recipient-control proof, and budget breakdown are verified.',
  },
  limitations: ['Local fixture only.'],
  __ambient: {
    verified: true,
    merkle_root: '88d6e16e438a8fcff1c02419aa290b7ea47c81b146b5f56ef7d36bce3cc105e4',
    request_id: '4b04aec58e2a4e8ab5dda4a09b70af00',
  },
};

function deterministicRuntime() {
  let tick = 0n;
  return {
    now: () => '2026-08-17T00:00:00.000Z',
    memoryUsage: () => ({ heapUsed: 1_000_000, rss: 2_000_000 }),
    hrtime: () => {
      tick += 1_000_000n;
      return tick;
    },
  };
}

test('runVerificationRepeatabilityBenchmark is stable across repeated strict/non-strict verification runs', () => {
  const result = runVerificationRepeatabilityBenchmark({
    report,
    extracted,
    repeatCount: 4,
    ...deterministicRuntime(),
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.week, 23);
  assert.equal(result.metrics.total_runs, 8);
  assert.equal(result.metrics.deterministic, true);
  assert.equal(result.groups.length, 2);
  assert.ok(result.groups.every((group) => group.unique_verification_hashes === 1));
  assert.ok(result.groups.every((group) => group.deterministic === true));
  assert.ok(result.runs.every((run) => run.ambient_proof_fields.verified === true));
  assert.ok(result.runs.every((run) => run.ambient_proof_fields.merkle_root === report.__ambient.merkle_root));
  assert.ok(result.runs.every((run) => run.ambient_proof_fields.request_id === report.__ambient.request_id));
  assert.equal(result.metrics.latency_ms.avg, 1);
});

test('benchmark hash excludes volatile timestamps and timing while preserving verification result drift', () => {
  const first = runVerificationRepeatabilityBenchmark({
    report,
    extracted,
    repeatCount: 3,
    ...deterministicRuntime(),
  });
  const second = runVerificationRepeatabilityBenchmark({
    report,
    extracted,
    repeatCount: 3,
    now: () => '2030-01-01T00:00:00.000Z',
    memoryUsage: () => ({ heapUsed: 5_000_000, rss: 8_000_000 }),
    hrtime: (() => {
      let tick = 0n;
      return () => {
        tick += 12_345_678n;
        return tick;
      };
    })(),
  });

  assert.equal(first.benchmark_sha256, second.benchmark_sha256);
});

test('runWeek23VerificationBenchmark writes product-visible JSON and Markdown artifacts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-ai-week23-'));
  const reportPath = path.join(dir, 'report.json');
  const proposalPath = path.join(dir, 'proposal.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(proposalPath, JSON.stringify(extracted, null, 2));

  const result = runWeek23VerificationBenchmark({
    reportPath,
    proposalPath,
    outputDir: path.join(dir, 'out'),
    repeatCount: 3,
    ...deterministicRuntime(),
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.sources.report_path, reportPath);
  assert.equal(fs.existsSync(result.artifacts.json), true);
  assert.equal(fs.existsSync(result.artifacts.markdown), true);
  const artifact = JSON.parse(fs.readFileSync(result.artifacts.json, 'utf8'));
  assert.equal(artifact.preserved_ambient_proof_fields.verified, true);
  assert.equal(artifact.preserved_ambient_proof_fields.merkle_root, report.__ambient.merkle_root);
  assert.equal(artifact.preserved_ambient_proof_fields.request_id, report.__ambient.request_id);
});

test('renderVerificationRepeatabilityMarkdown documents trust limits and preserved proof fields', () => {
  const result = runVerificationRepeatabilityBenchmark({
    report,
    extracted,
    repeatCount: 2,
    ...deterministicRuntime(),
  });
  const markdown = renderVerificationRepeatabilityMarkdown(result);

  assert.match(markdown, /Week 23 verification repeatability/);
  assert.match(markdown, /Verified Intelligence/);
  assert.match(markdown, /merkle_root/);
  assert.match(markdown, /request_id/);
  assert.match(markdown, /not live model accuracy/i);
});

test('writeVerificationRepeatabilityArtifacts omits recursive artifact pointers from JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-ai-week23-artifacts-'));
  const result = runVerificationRepeatabilityBenchmark({
    report,
    extracted,
    repeatCount: 2,
    ...deterministicRuntime(),
  });
  const paths = writeVerificationRepeatabilityArtifacts(result, dir);
  const artifact = JSON.parse(fs.readFileSync(paths.json, 'utf8'));

  assert.equal(artifact.artifacts, undefined);
  assert.equal(fs.readFileSync(paths.markdown, 'utf8').includes('Repeatability groups'), true);
});
