#!/usr/bin/env node
import fs from 'node:fs';

function loadDotenv(filePath = '.env') {
  if (!fs.existsSync(filePath)) return;
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else if (value.startsWith('"') || value.startsWith("'")) value = value.slice(1);
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotenv();

const API_URL = process.env.AMBIENT_API_URL || 'https://api.ambient.xyz/v1/chat/completions';
const API_KEY = process.env.AMBIENT_API_KEY;
const models = process.argv.slice(2).length ? process.argv.slice(2) : ['ambient/large', 'zai-org/GLM-5.1-FP8'];

if (!API_KEY) {
  console.error('AMBIENT_API_KEY missing');
  process.exit(2);
}

const results = [];
for (const model of models) {
  const started = Date.now();
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Say OK.' }],
        stream: false,
        max_tokens: 64,
        temperature: 0,
        wait_for_verification: false,
      }),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    const message = data?.choices?.[0]?.message || {};
    const output = message.content || message.reasoning_content || '';
    results.push({
      model_requested: model,
      http_status: res.status,
      ok: res.ok,
      duration_ms: Date.now() - started,
      request_id_present: Boolean(res.headers.get('x-request-id')),
      model_returned: data?.model || null,
      output_field: message.content ? 'content' : (message.reasoning_content ? 'reasoning_content' : 'empty'),
      output_chars: String(output).length,
      finish_reason: data?.choices?.[0]?.finish_reason || null,
      error_preview: res.ok ? null : text.slice(0, 240),
    });
  } catch (error) {
    results.push({ model_requested: model, ok: false, http_status: null, duration_ms: Date.now() - started, error_preview: String(error?.message || error).slice(0, 240) });
  }
}

const outPath = 'examples/week21-routing-intelligence/model-smoke-results.json';
fs.mkdirSync('examples/week21-routing-intelligence', { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ live_api_used: true, api_url: API_URL, results }, null, 2));
console.log(JSON.stringify({ artifact: outPath, results }, null, 2));
