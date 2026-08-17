import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { classifyVerificationHooks } from './analyzer.js';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Stable(value) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function ambientProofFields(report = {}) {
  const ambient = report.__ambient || report.ambient || {};
  return {
    verified: ambient.verified ?? null,
    merkle_root: ambient.merkle_root ?? ambient.merkleRoot ?? null,
    request_id: ambient.request_id ?? ambient.requestId ?? null,
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeRunForHash(run) {
  return {
    run_index: run.run_index,
    strict_mode: run.strict_mode,
    routing_action: run.routing_action,
    segment_counts: run.segment_counts,
    mixed_categories_detected: run.mixed_categories_detected,
    strict_rejection_triggered: run.strict_rejection_triggered,
    verification_sha256: run.verification_sha256,
    ambient_proof_fields: run.ambient_proof_fields,
  };
}

function countSegmentsByCategory(segments = []) {
  const out = { deterministic: 0, probabilistic: 0, unverifiable: 0 };
  for (const segment of segments) {
    if (Object.hasOwn(out, segment.category)) out[segment.category] += 1;
  }
  return out;
}

export function runVerificationRepeatabilityBenchmark({
  report,
  extracted,
  repeatCount = 5,
  strictModes = [false, true],
  now = () => new Date().toISOString(),
  memoryUsage = () => process.memoryUsage(),
  hrtime = () => process.hrtime.bigint(),
} = {}) {
  if (!report || typeof report !== 'object') throw new Error('report is required');
  if (!extracted || typeof extracted !== 'object') throw new Error('extracted is required');
  if (!Number.isInteger(repeatCount) || repeatCount < 2) throw new Error('repeatCount must be an integer >= 2');

  const startedAt = now();
  const reportFingerprint = sha256Stable({
    input: report.input ?? null,
    extracted: report.extracted ?? extracted,
    analysis: report.analysis ?? null,
    recommendation: report.recommendation ?? null,
    limitations: report.limitations ?? null,
    ambient_proof_fields: ambientProofFields(report),
  });
  const extractedFingerprint = sha256Stable(extracted);
  const proofFields = ambientProofFields(report);
  const runs = [];
  const memoryStart = memoryUsage();

  for (const strictMode of strictModes) {
    for (let i = 0; i < repeatCount; i += 1) {
      const before = hrtime();
      const hooks = classifyVerificationHooks(cloneJson(report), cloneJson(extracted), { strictMode });
      const after = hrtime();
      const stableResult = {
        strict_mode: strictMode,
        routing_action: hooks.routing_action,
        segments: hooks.segments,
        mixed_segments: hooks.mixed_segments,
        mixed_categories_detected: hooks.mixed_categories_detected,
        strict_rejection_triggered: hooks.strict_rejection_triggered,
        method: hooks.method,
        ambient_proof_fields: proofFields,
      };
      runs.push({
        run_index: runs.length + 1,
        strict_mode: strictMode,
        routing_action: hooks.routing_action,
        segment_counts: countSegmentsByCategory(hooks.segments),
        mixed_categories_detected: hooks.mixed_categories_detected,
        strict_rejection_triggered: hooks.strict_rejection_triggered,
        latency_ms: Number(after - before) / 1_000_000,
        verification_sha256: sha256Stable(stableResult),
        ambient_proof_fields: proofFields,
      });
    }
  }

  const memoryEnd = memoryUsage();
  const groups = [];
  let deterministic = true;
  for (const strictMode of strictModes) {
    const groupRuns = runs.filter((run) => run.strict_mode === strictMode);
    const hashes = [...new Set(groupRuns.map((run) => run.verification_sha256))];
    const routingActions = [...new Set(groupRuns.map((run) => run.routing_action))];
    if (hashes.length !== 1 || routingActions.length !== 1) deterministic = false;
    groups.push({
      strict_mode: strictMode,
      run_count: groupRuns.length,
      unique_verification_hashes: hashes.length,
      verification_sha256: hashes[0] || null,
      routing_actions: routingActions,
      deterministic: hashes.length === 1 && routingActions.length === 1,
    });
  }

  const latencies = runs.map((run) => run.latency_ms);
  const benchmark = {
    week: 23,
    theme: 'Verified Intelligence',
    kind: 'gov-ai-week23-verification-repeatability-benchmark',
    status: deterministic ? 'complete' : 'needs_review',
    started_at: startedAt,
    finished_at: now(),
    input_fingerprints: {
      report_sha256: reportFingerprint,
      extracted_sha256: extractedFingerprint,
    },
    preserved_ambient_proof_fields: proofFields,
    metrics: {
      total_runs: runs.length,
      repeat_count: repeatCount,
      strict_modes: strictModes,
      deterministic,
      latency_ms: {
        min: Number(Math.min(...latencies).toFixed(3)),
        max: Number(Math.max(...latencies).toFixed(3)),
        avg: Number((latencies.reduce((sum, item) => sum + item, 0) / latencies.length).toFixed(3)),
      },
      heap_used_delta_bytes: (memoryEnd.heapUsed ?? 0) - (memoryStart.heapUsed ?? 0),
      rss_delta_bytes: (memoryEnd.rss ?? 0) - (memoryStart.rss ?? 0),
    },
    groups,
    runs,
    benchmark_sha256: null,
    limitations: [
      'This benchmark verifies deterministic local verification-hook behavior, not live model accuracy.',
      'Latency and memory metrics are smoke-test signals and vary by hardware/runtime.',
      'Ambient verified, merkle_root, and request_id fields are preserved as proof metadata and are not recomputed locally.',
    ],
  };
  benchmark.benchmark_sha256 = sha256Stable({
    input_fingerprints: benchmark.input_fingerprints,
    preserved_ambient_proof_fields: benchmark.preserved_ambient_proof_fields,
    groups: benchmark.groups,
    runs: benchmark.runs.map(normalizeRunForHash),
  });
  return benchmark;
}

export function runWeek23VerificationBenchmark({
  reportPath,
  proposalPath,
  outputDir = 'examples/week23-verification-repeatability',
  repeatCount = 5,
  now,
  memoryUsage,
  hrtime,
} = {}) {
  if (!reportPath) throw new Error('reportPath is required');
  if (!proposalPath) throw new Error('proposalPath is required');
  const report = readJson(reportPath);
  const extracted = readJson(proposalPath);
  const benchmark = runVerificationRepeatabilityBenchmark({ report, extracted, repeatCount, now, memoryUsage, hrtime });
  benchmark.sources = {
    report_path: reportPath,
    proposal_path: proposalPath,
  };
  benchmark.artifacts = writeVerificationRepeatabilityArtifacts(benchmark, outputDir);
  return benchmark;
}

export function renderVerificationRepeatabilityMarkdown(benchmark) {
  return [
    '# Week 23 verification repeatability',
    '',
    `Theme: ${benchmark.theme || 'Verified Intelligence'}`,
    '',
    '## Result',
    `- Status: ${benchmark.status}`,
    `- Total runs: ${benchmark.metrics?.total_runs ?? 'n/a'}`,
    `- Deterministic: ${benchmark.metrics?.deterministic ?? 'n/a'}`,
    `- Latency ms min/avg/max: ${benchmark.metrics?.latency_ms?.min ?? 'n/a'} / ${benchmark.metrics?.latency_ms?.avg ?? 'n/a'} / ${benchmark.metrics?.latency_ms?.max ?? 'n/a'}`,
    `- Benchmark hash: ${benchmark.benchmark_sha256 || 'not computed'}`,
    '',
    '## Preserved proof fields',
    `- verified: ${benchmark.preserved_ambient_proof_fields?.verified ?? 'null'}`,
    `- merkle_root: ${benchmark.preserved_ambient_proof_fields?.merkle_root ?? 'null'}`,
    `- request_id: ${benchmark.preserved_ambient_proof_fields?.request_id ?? 'null'}`,
    '',
    '## Repeatability groups',
    ...((benchmark.groups || []).map((group) => `- strict_mode=${group.strict_mode}: deterministic=${group.deterministic}, unique_hashes=${group.unique_verification_hashes}, routing=${group.routing_actions.join(',')}`)),
    '',
    '## Limitations',
    ...((benchmark.limitations || []).map((item) => `- ${item}`)),
    '',
    '## Product use',
    'Use this artifact as a reproducibility gate for gov-ai verification hooks before trusting repeated reports or comparing live model outputs. It should fail review if repeated local verification produces drift for the same report/proposal fixture.',
    '',
  ].join('\n');
}

export function writeVerificationRepeatabilityArtifacts(benchmark, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, 'week23-verification-repeatability-output.json');
  const mdPath = path.join(outputDir, 'week23-verification-repeatability-report.md');
  const artifactForDisk = { ...benchmark };
  delete artifactForDisk.artifacts;
  fs.writeFileSync(jsonPath, JSON.stringify(artifactForDisk, null, 2));
  fs.writeFileSync(mdPath, renderVerificationRepeatabilityMarkdown(benchmark));
  return { json: jsonPath, markdown: mdPath };
}
