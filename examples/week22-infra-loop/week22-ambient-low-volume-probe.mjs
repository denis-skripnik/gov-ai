#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_BASE_URL = 'https://api.ambient.xyz/v1';
const DEFAULT_CHAT_URL = `${DEFAULT_BASE_URL}/chat/completions`;
const DEFAULT_MODELS = [
  'ambient/large',
  'zai-org/GLM-5.1-FP8',
  'zai-org/GLM-5-FP8',
  'z-ai/glm-5.2',
];

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function loadDotEnv(filePath = '.env') {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [rawKey, ...rest] = trimmed.split('=');
    const key = rawKey.trim();
    let value = rest.join('=').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function parseModelsCsv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function timeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timeout) };
}

function safeErrorPreview(text, max = 220) {
  if (!text) return null;
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, '[redacted.jwt]')
    .slice(0, max);
}

async function probeModelsEndpoint({ baseUrl, apiKey, timeoutMs }) {
  const started = Date.now();
  const { signal, clear } = timeoutSignal(timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      signal,
    });
    const requestId = response.headers.get('x-request-id') || response.headers.get('x-amzn-requestid') || null;
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    const ids = Array.isArray(payload?.data) ? payload.data.map((item) => item?.id).filter(Boolean) : [];
    return {
      evidence_type: 'live_api',
      endpoint: '/models',
      http_status: response.status,
      ok: response.ok,
      latency_ms: Date.now() - started,
      request_id_present: Boolean(requestId),
      response_shape: payload ? Object.keys(payload).sort() : ['non_json_text'],
      model_ids_count: ids.length,
      model_ids_sample: ids.slice(0, 12),
      error_preview: response.ok ? null : safeErrorPreview(text),
    };
  } catch (error) {
    return {
      evidence_type: 'live_api',
      endpoint: '/models',
      http_status: null,
      ok: false,
      latency_ms: Date.now() - started,
      request_id_present: false,
      response_shape: [],
      model_ids_count: 0,
      model_ids_sample: [],
      error_preview: safeErrorPreview(error?.name === 'AbortError' ? 'timeout' : error?.message || String(error)),
    };
  } finally {
    clear();
  }
}

async function probeChatModel({ chatUrl, apiKey, model, timeoutMs, maxTokens }) {
  const started = Date.now();
  const { signal, clear } = timeoutSignal(timeoutMs);
  try {
    const response = await fetch(chatUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a low-volume operations probe. Reply with exactly OK.' },
          { role: 'user', content: 'Return exactly OK.' },
        ],
        stream: false,
        temperature: 0,
        max_tokens: maxTokens,
      }),
    });
    const requestId = response.headers.get('x-request-id') || response.headers.get('x-amzn-requestid') || null;
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    const choice = payload?.choices?.[0] || null;
    const message = choice?.message || null;
    const content = message?.content;
    const outputField = typeof content === 'string' ? 'choices[0].message.content' : (message ? Object.keys(message).sort().join(',') : null);
    return {
      evidence_type: 'live_api',
      endpoint: '/chat/completions',
      model_requested: model,
      http_status: response.status,
      ok: response.ok && typeof content === 'string' && content.length > 0,
      latency_ms: Date.now() - started,
      request_id_present: Boolean(requestId),
      response_shape: payload ? Object.keys(payload).sort() : ['non_json_text'],
      choices_shape: choice ? Object.keys(choice).sort() : [],
      output_field: outputField,
      output_chars: typeof content === 'string' ? content.length : 0,
      output_sha256: typeof content === 'string' ? sha256(content) : null,
      model_returned: payload?.model || null,
      finish_reason: choice?.finish_reason || null,
      usage_present: Boolean(payload?.usage),
      usage_shape: payload?.usage ? Object.keys(payload.usage).sort() : [],
      error_preview: response.ok ? null : safeErrorPreview(text),
    };
  } catch (error) {
    return {
      evidence_type: 'live_api',
      endpoint: '/chat/completions',
      model_requested: model,
      http_status: null,
      ok: false,
      latency_ms: Date.now() - started,
      request_id_present: false,
      response_shape: [],
      choices_shape: [],
      output_field: null,
      output_chars: 0,
      output_sha256: null,
      model_returned: null,
      finish_reason: null,
      usage_present: false,
      usage_shape: [],
      error_preview: safeErrorPreview(error?.name === 'AbortError' ? 'timeout' : error?.message || String(error)),
    };
  } finally {
    clear();
  }
}

function buildSyntheticEvidence(liveChatResults) {
  const successful = liveChatResults.filter((item) => item.ok);
  const failed = liveChatResults.filter((item) => !item.ok);
  const fastest = [...successful].sort((a, b) => a.latency_ms - b.latency_ms)[0] || null;
  return {
    evidence_type: 'synthetic_local',
    source: 'deterministic local fallback design derived from Week 21 routing profiles; no extra live requests',
    simulated_request_count: 0,
    fallback_candidates: {
      primary_if_available: fastest?.model_requested || 'ambient/large',
      if_model_unavailable: successful.find((item) => item.model_requested !== fastest?.model_requested)?.model_requested || 'zai-org/GLM-5.1-FP8',
      if_all_live_models_fail: 'gov-ai local/mock routing profile only; do not synthesize live Ambient evidence',
    },
    routing_policy_notes: [
      'Use sequential probes for operations visibility; avoid concurrency unless explicitly testing capacity.',
      'Treat HTTP 429, 5xx, timeout, and no-bidders/unknown-model messages as fallback candidates, not quality failures.',
      'Do not infer model quality from this tiny OK prompt; it only checks availability, latency, field shape, and request-id presence.',
    ],
    observed_live_failures_used_for_design: failed.map((item) => ({
      model_requested: item.model_requested,
      http_status: item.http_status,
      latency_ms: item.latency_ms,
      error_preview: item.error_preview,
    })),
  };
}

function renderMarkdown(artifact) {
  const live = artifact.live_evidence;
  const chat = live.chat_completions;
  const metrics = artifact.metrics;
  const rows = chat.map((item) => `| ${item.model_requested} | ${item.http_status ?? 'n/a'} | ${item.ok} | ${item.latency_ms} | ${item.request_id_present} | ${item.model_returned || ''} | ${item.output_field || ''} | ${item.error_preview || ''} |`).join('\n');
  return [
    '# Week 22 Infra Loop — Ambient low-volume multi-model probe',
    '',
    '## Scope and safety',
    `- Evidence timestamp: ${artifact.started_at} → ${artifact.finished_at}`,
    `- Live chat requests: ${metrics.live_chat_requests}`,
    `- Concurrency: ${artifact.safety.concurrency}`,
    `- Max tokens per chat request: ${artifact.safety.max_tokens_per_chat_request}`,
    '- No API keys, prompts with sensitive data, deployment, commits, or aggressive load were used.',
    '',
    '## Live API evidence',
    `- /models status: ${live.models_endpoint.http_status ?? 'n/a'}; ok: ${live.models_endpoint.ok}; latency: ${live.models_endpoint.latency_ms} ms; request id present: ${live.models_endpoint.request_id_present}; ids observed: ${live.models_endpoint.model_ids_count}`,
    '',
    '| model_requested | status | ok | latency_ms | request_id_present | model_returned | output_field | error_preview |',
    '|---|---:|---|---:|---|---|---|---|',
    rows || '| none | n/a | false | n/a | false | | | no chat probes run |',
    '',
    '## Live metrics',
    `- Successful models: ${metrics.successful_models}/${metrics.live_chat_requests}`,
    `- Failed models: ${metrics.failed_models}/${metrics.live_chat_requests}`,
    `- Latency min / avg / max: ${metrics.latency_min_ms ?? 'n/a'} / ${metrics.latency_avg_ms ?? 'n/a'} / ${metrics.latency_max_ms ?? 'n/a'} ms`,
    `- Request-id presence: ${metrics.request_id_presence_count}/${metrics.live_chat_requests}`,
    `- Models returning content field: ${metrics.content_field_present_count}/${metrics.live_chat_requests}`,
    '',
    '## Synthetic/local evidence',
    `- Source: ${artifact.synthetic_local_evidence.source}`,
    `- Simulated request count: ${artifact.synthetic_local_evidence.simulated_request_count}`,
    `- Primary if available: ${artifact.synthetic_local_evidence.fallback_candidates.primary_if_available}`,
    `- Fallback if unavailable: ${artifact.synthetic_local_evidence.fallback_candidates.if_model_unavailable}`,
    `- All-live-fail behavior: ${artifact.synthetic_local_evidence.fallback_candidates.if_all_live_models_fail}`,
    '',
    '## Limitations',
    ...artifact.limitations.map((item) => `- ${item}`),
    '',
  ].join('\n');
}

function computeMetrics(chatResults) {
  const latencies = chatResults.map((item) => item.latency_ms).filter(Number.isFinite);
  const sum = latencies.reduce((a, b) => a + b, 0);
  return {
    live_chat_requests: chatResults.length,
    successful_models: chatResults.filter((item) => item.ok).length,
    failed_models: chatResults.filter((item) => !item.ok).length,
    request_id_presence_count: chatResults.filter((item) => item.request_id_present).length,
    content_field_present_count: chatResults.filter((item) => item.output_field === 'choices[0].message.content').length,
    latency_min_ms: latencies.length ? Math.min(...latencies) : null,
    latency_avg_ms: latencies.length ? Math.round(sum / latencies.length) : null,
    latency_max_ms: latencies.length ? Math.max(...latencies) : null,
  };
}

async function main() {
  const args = parseArgs();
  const envFile = args['env-file'] || '.env';
  const env = { ...loadDotEnv(envFile), ...process.env };
  const apiKey = env.AMBIENT_API_KEY;
  const outDir = args['out-dir'] || 'examples/week22-infra-loop';
  const maxModels = Math.max(1, Math.min(6, Number(args['max-models'] || 4)));
  const timeoutMs = Math.max(1000, Number(args['timeout-ms'] || 30000));
  const maxTokens = Math.max(8, Math.min(256, Number(args['max-tokens'] || 64)));
  const baseUrl = (env.AMBIENT_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const chatUrl = env.AMBIENT_API_URL || `${baseUrl}/chat/completions`;
  const started = new Date();

  fs.mkdirSync(outDir, { recursive: true });

  let liveModelsEndpoint;
  let chatResults = [];
  let modelsToProbe = unique([
    ...parseModelsCsv(args.models),
    env.AMBIENT_MODEL,
    ...DEFAULT_MODELS,
  ]).slice(0, maxModels);

  if (!apiKey) {
    liveModelsEndpoint = {
      evidence_type: 'live_api',
      endpoint: '/models',
      http_status: null,
      ok: false,
      latency_ms: 0,
      request_id_present: false,
      response_shape: [],
      model_ids_count: 0,
      model_ids_sample: [],
      error_preview: 'AMBIENT_API_KEY not available; live evidence unavailable',
    };
  } else {
    liveModelsEndpoint = await probeModelsEndpoint({ baseUrl, apiKey, timeoutMs });
    if (!args.models && liveModelsEndpoint.ok && liveModelsEndpoint.model_ids_sample.length) {
      const discovered = liveModelsEndpoint.model_ids_sample;
      modelsToProbe = unique([...modelsToProbe.filter((model) => discovered.includes(model)), ...discovered]).slice(0, maxModels);
    }
    for (const model of modelsToProbe) {
      // Deliberately sequential: low-volume availability probe, not load test.
      chatResults.push(await probeChatModel({ chatUrl, apiKey, model, timeoutMs, maxTokens }));
    }
  }

  const finished = new Date();
  const artifact = {
    week: 22,
    theme: 'Beyond One Model',
    kind: 'ambient-low-volume-multi-model-operation-probe',
    status: apiKey ? 'complete' : 'live_unavailable',
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    repo: 'denis-skripnik/gov-ai',
    git_head: args['git-head'] || null,
    safety: {
      concurrency: 1,
      max_models_requested: maxModels,
      timeout_ms: timeoutMs,
      max_tokens_per_chat_request: maxTokens,
      prompt_class: 'non-sensitive fixed OK smoke prompt',
      destructive_actions: false,
      commit_push_deploy: false,
    },
    live_evidence: {
      api_url_kind: chatUrl.includes('ambient') ? 'ambient' : 'openai_compatible',
      models_endpoint: liveModelsEndpoint,
      chat_completions: chatResults,
    },
    synthetic_local_evidence: buildSyntheticEvidence(chatResults),
    metrics: computeMetrics(chatResults),
    limitations: [
      'This is an operations smoke probe, not a quality benchmark.',
      'One tiny prompt per model cannot prove reliability, reasoning quality, or factual accuracy.',
      'Sequential low volume avoids capacity pressure, so it does not measure concurrent load behavior.',
      'Request-id presence is recorded as a boolean only; exact request IDs are intentionally not stored in the summary table.',
      'If /models is unavailable or partial, candidate models fall back to the conservative local allowlist.',
    ],
  };
  artifact.artifact_sha256 = sha256(JSON.stringify({ live_evidence: artifact.live_evidence, metrics: artifact.metrics, synthetic_local_evidence: artifact.synthetic_local_evidence }));

  const jsonPath = path.join(outDir, 'week22-ambient-low-volume-probe-result.json');
  const mdPath = path.join(outDir, 'week22-ambient-low-volume-probe-report.md');
  fs.writeFileSync(jsonPath, JSON.stringify(artifact, null, 2));
  fs.writeFileSync(mdPath, renderMarkdown(artifact));
  console.log(JSON.stringify({ status: artifact.status, json: jsonPath, markdown: mdPath, metrics: artifact.metrics, artifact_sha256: artifact.artifact_sha256 }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error?.message || String(error) }));
  process.exit(1);
});
