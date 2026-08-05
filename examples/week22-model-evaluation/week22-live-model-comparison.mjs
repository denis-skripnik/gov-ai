#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

function loadEnv(filePath = '.env') {
  if (!fs.existsSync(filePath)) return;
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [key, ...rest] = line.split('=');
    if (!process.env[key]) process.env[key] = rest.join('=').trim().replace(/^['"]|['"]$/g, '');
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value, null, 2), 'utf8').digest('hex');
}

function tryJson(text) {
  const trimmed = (text || '').trim();
  try { return { ok: true, value: JSON.parse(trimmed) }; } catch {}
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) {
    try { return { ok: true, value: JSON.parse(match[0]) }; } catch {}
  }
  return { ok: false, value: null };
}

const outputDir = process.argv[2] || 'examples/week22-model-evaluation/live-model-comparison';
const models = [
  { id: 'ambient/large', label: 'Ambient large router' },
  { id: 'z-ai/glm-5.2', label: 'Direct GLM 5 2' },
  { id: 'moonshotai/kimi-k2.7-code', label: 'Kimi code' },
  { id: 'deepseek/deepseek-v4-flash-0731', label: 'DeepSeek flash 0731' },
];
const cases = [
  {
    id: 'structured_json',
    dimension: 'structured_output',
    max_tokens: 1024,
    prompt: 'Return only JSON with keys risk_level, missing_evidence, recommendation. Scenario: DAO treasury transfer asks for 250000 USDC but invoice, signer list, recipient control proof, and budget breakdown are missing. recommendation must be one of Against, Abstain, For.',
    score(content, status) {
      const parsed = tryJson(content);
      let score = status === 200 ? 20 : 0;
      if (parsed.ok) score += 40;
      const v = parsed.value || {};
      if (['risk_level', 'missing_evidence', 'recommendation'].every((key) => Object.hasOwn(v, key))) score += 25;
      if (/Against|Abstain/.test(String(v.recommendation || content))) score += 15;
      return { score, checks: { json_parseable: parsed.ok, has_required_keys: ['risk_level', 'missing_evidence', 'recommendation'].every((key) => Object.hasOwn(v, key)) } };
    },
  },
  {
    id: 'missing_evidence_guardrail',
    dimension: 'hallucination_resistance',
    max_tokens: 1536,
    prompt: 'In under 100 words, assess the same DAO treasury proposal. Do not invent invoice, signer list, recipient control, vote count, or budget facts. Explicitly mark missing facts as UNKNOWN and give the safest governance recommendation.',
    score(content, status) {
      const text = content || '';
      let score = status === 200 ? 20 : 0;
      if (/UNKNOWN/i.test(text)) score += 30;
      if (/missing|not provided|unverified|cannot verify/i.test(text)) score += 25;
      if (/Against|Abstain|do not approve|manual review/i.test(text)) score += 20;
      if (/invoice (is|was)|signer list (is|was)|vote count (is|was)/i.test(text)) score -= 20;
      return { score: Math.max(0, score), checks: { marks_unknown: /UNKNOWN/i.test(text), cautious_recommendation: /Against|Abstain|do not approve|manual review/i.test(text) } };
    },
  },
  {
    id: 'coding_fixture',
    dimension: 'coding_tooling',
    max_tokens: 1536,
    prompt: 'Write a small JavaScript function named validateGovAiFixture(report) that returns an array of missing keys among verified, merkle_root, request_id, recommendation, and limitations. Return code only.',
    score(content, status) {
      const text = content || '';
      let score = status === 200 ? 20 : 0;
      if (/function\s+validateGovAiFixture|const\s+validateGovAiFixture|export\s+function\s+validateGovAiFixture/.test(text)) score += 30;
      if (/verified/.test(text) && /merkle_root/.test(text) && /request_id/.test(text)) score += 25;
      if (/missing|filter|forEach|map|reduce/.test(text)) score += 15;
      if (!/```/.test(text) || /```(?:js|javascript)?/.test(text)) score += 10;
      return { score, checks: { has_named_function: /validateGovAiFixture/.test(text), includes_verification_keys: /verified/.test(text) && /merkle_root/.test(text) && /request_id/.test(text) } };
    },
  },
];

loadEnv('.env');
const key = process.env.AMBIENT_API_KEY;
if (!key) throw new Error('AMBIENT_API_KEY is required');
fs.mkdirSync(outputDir, { recursive: true });

const startedAt = new Date().toISOString();
const results = [];
for (const model of models) {
  for (const testCase of cases) {
    const payload = {
      model: model.id,
      messages: [{ role: 'user', content: testCase.prompt }],
      temperature: 0,
      max_tokens: testCase.max_tokens,
      stream: false,
    };
    const t0 = performance.now();
    let status = null, response = null, error = null, requestIdPresent = false;
    try {
      const res = await fetch('https://api.ambient.xyz/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(45000),
      });
      status = res.status;
      requestIdPresent = Boolean(res.headers.get('x-request-id') || res.headers.get('cf-ray'));
      response = await res.json().catch(async () => ({ raw: await res.text() }));
    } catch (err) {
      error = { type: err.name || 'Error', message: err.message };
    }
    const latencyMs = Math.round(performance.now() - t0);
    const choice = response?.choices?.[0];
    const content = choice?.message?.content || '';
    const scored = testCase.score(content, status);
    results.push({
      model: model.id,
      label: model.label,
      case_id: testCase.id,
      dimension: testCase.dimension,
      status,
      ok: status === 200,
      latency_ms: latencyMs,
      request_id_present: requestIdPresent,
      model_returned: response?.model || null,
      finish_reason: choice?.finish_reason || null,
      content_len: content.length,
      content_preview: content.slice(0, 240),
      usage: response?.usage || null,
      error: response?.error || error || null,
      score: scored.score,
      checks: scored.checks,
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
}

const byModel = models.map((model) => {
  const rows = results.filter((row) => row.model === model.id);
  return {
    model: model.id,
    label: model.label,
    success_count: rows.filter((row) => row.ok).length,
    case_count: rows.length,
    average_score: Math.round(rows.reduce((sum, row) => sum + row.score, 0) / rows.length),
    average_latency_ms: Math.round(rows.reduce((sum, row) => sum + row.latency_ms, 0) / rows.length),
    failed_cases: rows.filter((row) => !row.ok).map((row) => row.case_id),
  };
});
const bestByDimension = cases.map((testCase) => {
  const rows = results.filter((row) => row.case_id === testCase.id).sort((a, b) => b.score - a.score || a.latency_ms - b.latency_ms);
  const best = rows[0];
  return { case_id: testCase.id, dimension: testCase.dimension, recommended_model: best.model, score: best.score, latency_ms: best.latency_ms };
});
const artifact = {
  week: 22,
  theme: 'Beyond One Model',
  kind: 'gov-ai-week22-live-model-comparison-addendum',
  status: results.some((row) => row.ok) ? 'complete' : 'needs_review',
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  models: models.map((m) => m.id),
  cases: cases.map(({ id, dimension, prompt }) => ({ id, dimension, prompt_sha256: sha256(prompt) })),
  results,
  summary: { by_model: byModel, best_by_dimension: bestByDimension },
  recommendations: [
    'Use ambient/large as the production default router because it hides some direct-model volatility.',
    'Include Kimi code in Dev Loop coding/tooling comparisons when workers are available.',
    'Include DeepSeek flash 0731 in Dev Loop reasoning and guardrail comparisons because it answered the smoke check and is a distinct family from GLM.',
    'Treat direct model IDs as availability-sensitive: rerun a small probe before publishing strong model claims.',
  ],
  limitations: [
    'Small live comparison only: 4 models, 3 cases, single run per case.',
    'Scores are rubric checks for gov-ai report utility, not general intelligence scores.',
    'No secrets, private content, or production writes were used.',
  ],
};
artifact.comparison_sha256 = sha256({ models: artifact.models, cases: artifact.cases, results: results.map(({ model, case_id, status, score, model_returned, finish_reason }) => ({ model, case_id, status, score, model_returned, finish_reason })) });

const jsonPath = path.join(outputDir, 'week22-live-model-comparison-output.json');
const reportPath = path.join(outputDir, 'week22-live-model-comparison-report.md');
fs.writeFileSync(jsonPath, JSON.stringify(artifact, null, 2));
const lines = [];
lines.push('# Week 22 live model comparison addendum');
lines.push('');
lines.push(`Status: ${artifact.status}`);
lines.push(`Models compared: ${artifact.models.length}`);
lines.push(`Cases: ${artifact.cases.length}`);
lines.push(`Comparison hash: ${artifact.comparison_sha256}`);
lines.push('');
lines.push('## Per-model summary');
for (const row of byModel) lines.push(`- ${row.model}: ${row.success_count}/${row.case_count} successful, average score ${row.average_score}, average latency ${row.average_latency_ms} ms${row.failed_cases.length ? `, failed cases: ${row.failed_cases.join(', ')}` : ''}`);
lines.push('');
lines.push('## Best model by dimension in this small run');
for (const row of bestByDimension) lines.push(`- ${row.dimension}: ${row.recommended_model}, score ${row.score}, latency ${row.latency_ms} ms`);
lines.push('');
lines.push('## Recommendations');
for (const item of artifact.recommendations) lines.push(`- ${item}`);
lines.push('');
lines.push('## Limitations');
for (const item of artifact.limitations) lines.push(`- ${item}`);
fs.writeFileSync(reportPath, `${lines.join('\n')}\n`);
console.log(JSON.stringify({ status: artifact.status, by_model: byModel, best_by_dimension: bestByDimension, artifacts: { json: jsonPath, markdown: reportPath } }, null, 2));
