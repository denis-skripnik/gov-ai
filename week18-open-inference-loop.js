import fs from 'node:fs';
import path from 'node:path';

import { classifyBenchmarkFailure, evaluateBenchmarkOutputQuality, parseModelJsonOrNull } from './bench-helpers.js';
import { loadRuntimeProfilesFromEnv, publicRuntimeProfile } from './open-inference-runtimes.js';

export function buildWeek18Messages(proposal) {
  const title = proposal?.title || proposal?.metadata?.title || 'Governance proposal';
  const body = proposal?.body || proposal?.description || proposal?.text || JSON.stringify(proposal, null, 2);
  const options = proposal?.options || proposal?.choices || ['For', 'Against'];

  return [
    {
      role: 'system',
      content: 'You are gov-ai. Return only valid JSON matching the governance report shape: input, extracted, analysis, recommendation, limitations.',
    },
    {
      role: 'user',
      content: [
        'Analyze this governance proposal for a voter.',
        `Title: ${title}`,
        `Options: ${JSON.stringify(options)}`,
        `Proposal body: ${body}`,
      ].join('\n\n'),
    },
  ];
}

export async function runWeek18OpenInferenceLoop({
  proposalPath,
  outputDir = 'examples/week18-open-inference',
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  if (!proposalPath) throw new Error('proposalPath is required');

  const proposal = JSON.parse(fs.readFileSync(proposalPath, 'utf8'));
  const profiles = loadRuntimeProfilesFromEnv(env);
  if (profiles.length === 0) {
    throw new Error('No Week 18 runtime profiles configured. Set WEEK18_MOCK=true or configure Ambient/OpenAI-compatible env.');
  }

  const messages = buildWeek18Messages(proposal);
  const startedAt = now().toISOString();
  const runtimes = [];

  for (const profile of profiles) {
    const result = await runSingleRuntime({ profile, messages, proposal, fetchImpl, now });
    runtimes.push(result);
  }

  const selected = selectBestRuntime(runtimes);
  const artifact = {
    week: 18,
    theme: 'Open Inference Economy',
    status: selected ? 'complete' : 'needs_review',
    started_at: startedAt,
    finished_at: now().toISOString(),
    proposal_source: proposalPath,
    selected_runtime: selected?.name || null,
    runtimes_tested: runtimes,
    report: selected?.report || null,
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, 'week18-open-inference-result.json');
  const mdPath = path.join(outputDir, 'week18-open-inference-summary.md');
  fs.writeFileSync(jsonPath, JSON.stringify(artifact, null, 2));
  fs.writeFileSync(mdPath, renderMarkdownSummary(artifact));

  return {
    ...artifact,
    artifacts: {
      json: jsonPath,
      markdown: mdPath,
    },
  };
}

export async function runSingleRuntime({ profile, messages, proposal, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  const started = Date.now();
  const publicProfile = publicRuntimeProfile(profile);

  try {
    const response = profile.provider === 'mock'
      ? await runMockRuntime({ profile, proposal })
      : await callOpenAICompatibleRuntime({ profile, messages, fetchImpl });

    const latencyMs = Date.now() - started;
    const content = response.content || '';
    if (!content.trim()) throw Object.assign(new Error('empty content from runtime'), { status: response.status });

    const parsed = parseModelJsonOrNull(content);
    const quality = evaluateBenchmarkOutputQuality(parsed);

    return {
      ...publicProfile,
      ok: quality.json_valid && quality.completeness_score >= 0.8,
      latency_ms: latencyMs,
      finished_at: now().toISOString(),
      failure: quality.json_valid ? null : { type: 'invalid_json', message: 'Runtime returned content without a valid JSON object' },
      json_valid: quality.json_valid,
      schema_complete: quality.required_top_level_present && quality.required_nested_fields_present,
      completeness_score: quality.completeness_score,
      missing_fields: quality.missing_fields,
      finish_reason: response.finish_reason || null,
      usage: response.usage || null,
      verification: response.verification || null,
      report: parsed,
    };
  } catch (error) {
    const failure = classifyBenchmarkFailure(error);
    return {
      ...publicProfile,
      ok: false,
      latency_ms: Date.now() - started,
      finished_at: now().toISOString(),
      failure,
      json_valid: false,
      schema_complete: false,
      completeness_score: 0,
      missing_fields: [],
      finish_reason: null,
      usage: null,
      verification: null,
      report: null,
    };
  }
}

export function selectBestRuntime(runtimes) {
  const successful = runtimes.filter((runtime) => runtime.ok && runtime.json_valid);
  if (!successful.length) return null;

  return [...successful].sort((a, b) => {
    const verificationDelta = Number(Boolean(b.verification?.verified)) - Number(Boolean(a.verification?.verified));
    if (verificationDelta !== 0) return verificationDelta;
    const completenessDelta = (b.completeness_score || 0) - (a.completeness_score || 0);
    if (completenessDelta !== 0) return completenessDelta;
    return (a.latency_ms || Infinity) - (b.latency_ms || Infinity);
  })[0];
}

async function callOpenAICompatibleRuntime({ profile, messages, fetchImpl }) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), profile.timeoutMs);
  try {
    const response = await fetchImpl(profile.apiUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(profile.apiKey ? { authorization: ['Bearer', profile.apiKey].join(' ') } : {}),
      },
      body: JSON.stringify({
        model: profile.model,
        messages,
        stream: false,
        temperature: 0.1,
        max_tokens: profile.maxTokens,
      }),
    });

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    const payload = await response.json();
    const choice = payload?.choices?.[0] || {};
    return {
      content: choice?.message?.content || '',
      finish_reason: choice?.finish_reason || null,
      usage: payload?.usage || null,
      verification: extractVerification(payload),
      status: response.status,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runMockRuntime({ profile, proposal }) {
  const title = proposal?.title || proposal?.metadata?.title || 'Mock proposal';
  const report = {
    input: {
      url: proposal?.url || 'fixture://week18-open-inference',
      fetched_at: '2026-07-01T00:00:00.000Z',
      source_type: 'fixture',
    },
    extracted: {
      title,
      body: proposal?.body || proposal?.description || '',
      options: proposal?.options || proposal?.choices || ['For', 'Against'],
      current_results: proposal?.current_results || null,
      metadata: proposal?.metadata || {},
    },
    analysis: {
      summary: `Runtime ${profile.name} produced a deterministic mock governance report for Week 18.`,
      key_changes: ['Open inference runtime switching is observable.'],
      risks: ['Mock mode does not prove live network availability.'],
      benefits: ['The same governance pipeline can compare runtime behavior.'],
      unknowns: ['Live latency and verification require a real Ambient run.'],
      evidence_quotes: [title],
    },
    recommendation: {
      suggested_option: 'Abstain',
      confidence: 'medium',
      reasoning: 'Mock mode validates orchestration and artifact shape, not proposal truth.',
      conflicts_with_user_principles: [],
    },
    limitations: ['Mock runtime is for local validation only.'],
  };

  return {
    content: JSON.stringify(report),
    finish_reason: 'stop',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    verification: null,
  };
}

function extractVerification(payload) {
  const verified = payload?.verified ?? payload?.ambient?.verified ?? payload?.metadata?.verified;
  const requestId = payload?.request_id ?? payload?.ambient?.request_id ?? payload?.metadata?.request_id;
  const merkleRoot = payload?.merkle_root ?? payload?.ambient?.merkle_root ?? payload?.metadata?.merkle_root;
  if (verified === undefined && !requestId && !merkleRoot) return null;
  return {
    verified: Boolean(verified),
    request_id: requestId || null,
    merkle_root: merkleRoot || null,
  };
}

function renderMarkdownSummary(artifact) {
  const lines = [
    '# Week 18 — Open Inference Runtime Matrix',
    '',
    `Status: ${artifact.status}`,
    `Selected runtime: ${artifact.selected_runtime || 'none'}`,
    '',
    '## Runtimes tested',
  ];

  for (const runtime of artifact.runtimes_tested) {
    lines.push(
      '',
      `- ${runtime.name}`,
      `  - provider: ${runtime.provider}`,
      `  - model: ${runtime.model}`,
      `  - ok: ${runtime.ok}`,
      `  - latency_ms: ${runtime.latency_ms}`,
      `  - json_valid: ${runtime.json_valid}`,
      `  - schema_complete: ${runtime.schema_complete}`,
      `  - failure: ${runtime.failure?.type || 'none'}`,
    );
  }

  return `${lines.join('\n')}\n`;
}
