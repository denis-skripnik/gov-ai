export const DEFAULT_AMBIENT_API_URL = 'https://api.ambient.xyz/v1/chat/completions';

export function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadRuntimeProfilesFromEnv(env = process.env) {
  const profiles = [];

  const mockMode = parseBoolean(env.WEEK18_MOCK, false);
  const includeLiveWithMock = parseBoolean(env.WEEK18_INCLUDE_LIVE, false);

  if (mockMode) {
    profiles.push({
      name: env.WEEK18_MOCK_NAME || 'mock_open_inference_runtime',
      provider: 'mock',
      apiUrl: 'mock://open-inference',
      apiKey: env['WEEK18_MOCK' + '_KEY'] || null,
      model: env.WEEK18_MOCK_MODEL || 'mock-governance-model',
      stream: false,
      maxTokens: parseNumber(env.WEEK18_MAX_TOKENS, 16384),
      timeoutMs: parseNumber(env.WEEK18_TIMEOUT_MS, 120000),
      verification: false,
    });
  }

  if ((!mockMode || includeLiveWithMock) && env.AMBIENT_API_KEY) {
    profiles.push({
      name: env.WEEK18_AMBIENT_PROFILE_NAME || 'ambient_default_streaming',
      provider: 'ambient',
      apiUrl: env.AMBIENT_API_URL || DEFAULT_AMBIENT_API_URL,
      apiKey: env.AMBIENT_API_KEY,
      model: env.AMBIENT_MODEL || 'zai-org/GLM-5.1-FP8',
      stream: parseBoolean(env.AMBIENT_STREAM, true),
      maxTokens: parseNumber(env.AMBIENT_MAX_TOKENS || env.WEEK18_MAX_TOKENS, 16384),
      timeoutMs: parseNumber(env.WEEK18_TIMEOUT_MS, 120000),
      verification: true,
    });
  }

  if ((!mockMode || includeLiveWithMock) && env.OPEN_INFERENCE_API_URL && env.OPEN_INFERENCE_MODEL) {
    profiles.push({
      name: env.OPEN_INFERENCE_PROFILE_NAME || 'openai_compatible_external',
      provider: 'openai_compatible',
      apiUrl: env.OPEN_INFERENCE_API_URL,
      apiKey: env.OPEN_INFERENCE_API_KEY || null,
      model: env.OPEN_INFERENCE_MODEL,
      stream: parseBoolean(env.OPEN_INFERENCE_STREAM, false),
      maxTokens: parseNumber(env.OPEN_INFERENCE_MAX_TOKENS || env.WEEK18_MAX_TOKENS, 16384),
      timeoutMs: parseNumber(env.OPEN_INFERENCE_TIMEOUT_MS || env.WEEK18_TIMEOUT_MS, 120000),
      verification: false,
    });
  }

  const allowList = String(env.WEEK18_RUNTIMES || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return allowList.length > 0
    ? profiles.filter((profile) => allowList.includes(profile.name))
    : profiles;
}

export function publicRuntimeProfile(profile) {
  return {
    name: profile.name,
    provider: profile.provider,
    api_url_kind: classifyApiUrl(profile.apiUrl),
    model: profile.model,
    stream: Boolean(profile.stream),
    max_tokens: profile.maxTokens,
    timeout_ms: profile.timeoutMs,
    verification: Boolean(profile.verification),
  };
}

function classifyApiUrl(apiUrl) {
  const value = String(apiUrl || '');
  if (value.startsWith('mock://')) return 'mock';
  if (value.includes('ambient')) return 'ambient';
  if (!value) return 'missing';
  return 'openai_compatible';
}
