#!/usr/bin/env node
import fs from "fs";
import crypto from "crypto";
import "dotenv/config";
import { fetchAndExtract } from "./fetcher.js";
import { classifyVerificationHooks } from "./analyzer.js";

const API_URL = "https://api.ambient.xyz/v1/chat/completions";
const API_KEY = process.env.AMBIENT_API_KEY;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url || process.env.PROPOSAL_URL;
  const runs = toPositiveInt(args.runs, 10);
  const concurrency = toPositiveInt(args.concurrency, Math.min(runs, 10));
  const timeoutMs = toPositiveInt(args["timeout-ms"], 5400000);
  const outDir = args["out-dir"] || "load-reports";
  const model = args.model || "zai-org/GLM-5-FP8";
  const strictHooks = toBoolean(args["strict-hooks"]);

  if (!API_KEY) {
    console.error("AMBIENT_API_KEY is not set. Put it into .env file.");
    process.exit(1);
  }

  if (!url) {
    console.error("Usage: node week10-load.js --url <proposal_url> [--runs 10] [--concurrency 10]");
    process.exit(1);
  }

  if (!fs.existsSync("principles.json")) {
    console.error("principles.json not found. Run: node gov-ai.js init");
    process.exit(1);
  }

  const principles = JSON.parse(fs.readFileSync("principles.json", "utf-8"));
  fs.mkdirSync(outDir, { recursive: true });

  const batchStartedAt = new Date().toISOString();
  console.log("=".repeat(60));
  console.log(`Week10 Load Test - ${batchStartedAt}`);
  console.log(`URL: ${url}`);
  console.log(`Runs: ${runs} | Concurrency: ${concurrency} | Model: ${model}`);
  console.log("=".repeat(60));
  console.log("Fetching and extracting proposal data once...");

  const extracted = await fetchAndExtract(url);
  const prompt = buildLoadPrompt(url, extracted, principles);

  const workerResults = await runPool({
    items: Array.from({ length: runs }, (_, i) => i + 1),
    concurrency,
    worker: async (runNumber) => {
      console.log(`[run ${runNumber}/${runs}] started`);
      return await executeSingleRun({ runNumber, url, extracted, prompt, model, timeoutMs, strictHooks });
    },
  });

  const batchFinishedAt = new Date().toISOString();
  const totalBatchDurationMs = Date.parse(batchFinishedAt) - Date.parse(batchStartedAt);

  const aggregate = buildAggregate(workerResults);
  const evidenceSamples = buildEvidenceSamples(workerResults);
  const timestamp = isoSafeFileName();

  const result = {
    scenario: {
      name: "Ambient Week 10 load test for gov-ai",
      mode: "direct-runner",
      description:
        "Parallel inference stress test using the current gov-ai core prompt/extraction pipeline without the API-server layer, in controlled single-node mode.",
    },
    config: {
      url,
      runs,
      concurrency,
      model,
      timeout_ms: timeoutMs,
      strict_verification_hooks: strictHooks,
      stream: true,
      shared_extracted_input: true,
      extracted_source_type: extracted?.source_type || "unknown",
      week10_mode: "single-node-controlled",
      multi_node_bypassed: true,
    },
    timing: {
      started_at: batchStartedAt,
      finished_at: batchFinishedAt,
      total_batch_duration_ms: totalBatchDurationMs,
    },
    aggregate,
    evidence_samples: evidenceSamples,
    runs: workerResults,
  };

  const resultPath = `${outDir}/load-result-${runs}-${timestamp}.json`;
  const summaryPath = `${outDir}/load-summary-${runs}-${timestamp}.md`;

  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  fs.writeFileSync(summaryPath, buildMarkdownSummary(result), "utf-8");

  console.log(`Saved result: ${resultPath}`);
  console.log(`Saved summary: ${summaryPath}`);
}

async function executeSingleRun({ runNumber, url, extracted, prompt, model, timeoutMs, strictHooks }) {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  try {
    const analysis = await analyzeStreamingForLoadWithRetry({ url, extracted, prompt, model, timeoutMs });
    const finishedAtMs = Date.now();
    const finishedAt = new Date(finishedAtMs).toISOString();

    const report = analysis.report;
    report.verification_hooks = classifyVerificationHooks(report, extracted, { strictMode: strictHooks });
    const refusal = detectRefusal(report, extracted);

    const ambient = report.__ambient || {};
    const result = {
      run_id: runNumber,
      status: "ok",
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: finishedAtMs - startedAtMs,
      first_token_latency_ms: analysis.firstTokenLatencyMs,
      stream_completed_ms: analysis.streamCompletedMs,
      report_json_valid: true,
      refusal_detected: refusal.refusal_detected,
      refusal_signals: refusal.signals,
      strict_rejection_triggered: Boolean(report?.verification_hooks?.strict_rejection_triggered),
      routing_action: report?.verification_hooks?.routing_action || null,
      unknowns_count: Array.isArray(report?.analysis?.unknowns) ? report.analysis.unknowns.length : 0,
      ambient_verified: ambient.verified ?? null,
      ambient_merkle_root: ambient.merkle_root ?? null,
      ambient_request_id: ambient.request_id ?? analysis.requestId ?? null,
      ambient_model: ambient.model ?? model,
      ambient_verified_by_validators: ambient.verified_by_validators ?? null,
      ambient_auction_status: ambient?.auction?.status ?? null,
      ambient_auction_bids_placed: ambient?.auction?.bids?.placed ?? null,
      ambient_auction_bids_revealed: ambient?.auction?.bids?.revealed ?? null,
      ambient_auction_address: ambient?.auction?.address ?? null,
      ambient_bidder: ambient?.bidder ?? null,
    };

    console.log(
      `[run ${runNumber}] ok | first token: ${valueOrDash(result.first_token_latency_ms)} ms | total: ${result.duration_ms} ms`
    );
    return result;
  } catch (error) {
    const finishedAtMs = Date.now();
    const finishedAt = new Date(finishedAtMs).toISOString();
    const errorInfo = classifyError(error);
    console.log(`[run ${runNumber}] ${errorInfo.type} | ${errorInfo.message}`);

    return {
      run_id: runNumber,
      status: errorInfo.type === "timeout" ? "timeout" : "error",
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: finishedAtMs - startedAtMs,
      first_token_latency_ms: error.firstTokenLatencyMs ?? null,
      stream_completed_ms: null,
      report_json_valid: false,
      refusal_detected: false,
      refusal_signals: [],
      strict_rejection_triggered: false,
      routing_action: null,
      unknowns_count: null,
      ambient_verified: null,
      ambient_merkle_root: null,
      ambient_request_id: error.requestId || null,
      ambient_model: model,
      ambient_verified_by_validators: null,
      ambient_auction_status: null,
      ambient_auction_bids_placed: null,
      ambient_auction_bids_revealed: null,
      ambient_auction_address: null,
      ambient_bidder: null,
      error_type: errorInfo.type,
      error_message: errorInfo.message,
      http_status: error.httpStatus || null,
    };
  }
}

async function analyzeStreamingForLoadWithRetry({ url, extracted, prompt, model, timeoutMs }) {
  const backoffsMs = [2000, 5000, 10000];
  let lastError = null;

  for (let attempt = 0; attempt <= backoffsMs.length; attempt++) {
    try {
      return await analyzeStreamingForLoadOnce({ url, extracted, prompt, model, timeoutMs });
    } catch (error) {
      lastError = error;
      if (!isRetryableCapacityError(error) || attempt >= backoffsMs.length) {
        throw error;
      }
      await sleep(backoffsMs[attempt]);
    }
  }

  throw lastError || new Error("Unknown streaming retry failure");
}

async function analyzeStreamingForLoadOnce({ url, extracted, prompt, model, timeoutMs }) {
  const requestStartedAtMs = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are a governance analysis assistant. You must output ONLY valid JSON." },
          { role: "user", content: prompt },
        ],
        stream: true,
        emit_verified: true,
        emit_ambient_events: true,
        wait_for_verification: true,
        emit_usage: true,
      }),
      signal: controller.signal,
    });

    const requestId = response.headers.get("x-request-id") || null;
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const error = new Error(`Ambient API error HTTP ${response.status} (x-request-id: ${requestId || "UNKNOWN"}): ${shorten(bodyText, 800)}`);
      error.requestId = requestId;
      error.httpStatus = response.status;
      throw error;
    }

    let text = "";
    let verified = null;
    let merkleRoot = null;
    let firstTokenLatencyMs = null;

    const lifecycle = {
      bundled: null,
      auctionStarted: null,
      auctionEnded: null,
      winningBid: null,
    };

    for await (const dataLine of sseDataLines(response)) {
      if (dataLine === "[DONE]") continue;
      const obj = safeJsonParse(dataLine);
      if (!obj) continue;

      if (obj.object === "ambient.lifecycle") {
        const t = obj.type;
        if (t === "bundled") lifecycle.bundled = obj.content;
        else if (t === "auctionStarted") lifecycle.auctionStarted = obj.content;
        else if (t === "auctionEnded") lifecycle.auctionEnded = obj.content;
        else if (t === "winningBid") lifecycle.winningBid = obj.content;
        continue;
      }

      if (obj.object === "chat.completion.chunk") {
        const delta = obj.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          if (firstTokenLatencyMs == null) {
            firstTokenLatencyMs = Date.now() - requestStartedAtMs;
          }
          text += delta;
        }
        continue;
      }

      if (obj.object === "chat.completion.usage") {
        if (obj.merkle_root) merkleRoot = obj.merkle_root;
        continue;
      }

      if (typeof obj.verified === "boolean") {
        verified = obj.verified;
      }
    }

    const streamCompletedMs = Date.now() - requestStartedAtMs;
    if (!text) {
      const error = new Error(`No streamed content from Ambient (x-request-id: ${requestId || "UNKNOWN"})`);
      error.requestId = requestId;
      error.firstTokenLatencyMs = firstTokenLatencyMs;
      throw error;
    }

    const report = parseModelJson(text);
    if (!report) {
      const error = new Error("Invalid JSON from model");
      error.requestId = requestId;
      error.firstTokenLatencyMs = firstTokenLatencyMs;
      throw error;
    }

    const verificationUI = buildAmbientVerification({
      verified,
      merkleRoot,
      requestId,
      model,
      lifecycle,
    });

    report.__ambient = verificationUI;
    attachPromptUsed(report, {
      prompt,
      model,
      stream: true,
      files: {
        principles: "./principles.json",
        schema: "./report.schema.json",
      },
    });
    if (report && report.input) {
      report.input.isFinancialProposal = isFinancialProposal(extracted?.title || "", extracted?.body || "");
      report.input.week10Mode = "single-node-controlled";
      report.input.multiNodeBypassed = true;
    }

    return {
      report,
      requestId,
      firstTokenLatencyMs,
      streamCompletedMs,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(`Timed out after ${timeoutMs} ms`);
      timeoutError.isTimeout = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildAmbientVerification({ verified, merkleRoot, requestId, model, lifecycle }) {
  const verifiers = lifecycle?.bundled?.verifiers?.keys || null;
  const validatorsCount = Array.isArray(verifiers) ? verifiers.length : null;
  const auctionAddress = lifecycle?.bundled?.auction || lifecycle?.auctionStarted?.auction || lifecycle?.auctionEnded?.auction || null;
  const auctionStatusRaw = pickAuctionStatus(lifecycle);
  const auctionStatus = auctionStatusRaw ? (String(auctionStatusRaw).toLowerCase() === "ended" ? "Done" : auctionStatusRaw) : null;
  const bids = pickBidsCount(lifecycle);
  const bidder = pickBidder(lifecycle);

  return {
    verified,
    merkle_root: merkleRoot,
    request_id: requestId,
    model,
    verified_by_validators: validatorsCount != null ? `Verified by ${validatorsCount} validators` : null,
    auction: auctionAddress
      ? {
          status: auctionStatus,
          bids: bids.placed != null || bids.revealed != null ? { placed: bids.placed, revealed: bids.revealed } : null,
          address: ambientAddressUrl(auctionAddress),
        }
      : null,
    bidder: bidder ? ambientAddressUrl(bidder) : null,
  };
}

function buildAggregate(runs) {
  const okRuns = runs.filter((run) => run.status === "ok");
  const failedRuns = runs.filter((run) => run.status === "error");
  const timeoutRuns = runs.filter((run) => run.status === "timeout");

  return {
    runs_requested: runs.length,
    runs_completed_ok: okRuns.length,
    runs_failed: failedRuns.length,
    runs_timed_out: timeoutRuns.length,
    success_rate: runs.length ? okRuns.length / runs.length : 0,
    first_token_latency_ms: summarizeNumbers(okRuns.map((run) => run.first_token_latency_ms).filter(isFiniteNumber)),
    duration_ms: summarizeNumbers(runs.map((run) => run.duration_ms).filter(isFiniteNumber)),
    ambient_verified_count: okRuns.filter((run) => run.ambient_verified === true).length,
    ambient_metadata_present_count: okRuns.filter((run) => Boolean(run.ambient_request_id || run.ambient_merkle_root)).length,
    refusal_count: okRuns.filter((run) => run.refusal_detected).length,
    strict_rejection_count: okRuns.filter((run) => run.strict_rejection_triggered).length,
    failure_types: countBy(runs.filter((run) => run.error_type).map((run) => run.error_type)),
  };
}

function buildEvidenceSamples(runs) {
  const successRuns = runs
    .filter((run) => run.status === "ok")
    .slice(0, 3)
    .map((run) => ({
      run_id: run.run_id,
      first_token_latency_ms: run.first_token_latency_ms,
      duration_ms: run.duration_ms,
      ambient_request_id: run.ambient_request_id,
      ambient_verified: run.ambient_verified,
      ambient_model: run.ambient_model,
    }));

  const errorRuns = runs
    .filter((run) => run.status !== "ok")
    .slice(0, 3)
    .map((run) => ({
      run_id: run.run_id,
      status: run.status,
      error_type: run.error_type,
      error_message: run.error_message,
      ambient_request_id: run.ambient_request_id || null,
      http_status: run.http_status || null,
    }));

  const ambientSamples = runs
    .filter((run) => run.status === "ok" && (run.ambient_request_id || run.ambient_merkle_root))
    .slice(0, 3)
    .map((run) => ({
      run_id: run.run_id,
      verified: run.ambient_verified,
      request_id: run.ambient_request_id,
      merkle_root: run.ambient_merkle_root,
      verified_by_validators: run.ambient_verified_by_validators,
      auction: {
        status: run.ambient_auction_status,
        bids: {
          placed: run.ambient_auction_bids_placed,
          revealed: run.ambient_auction_bids_revealed,
        },
        address: run.ambient_auction_address,
      },
      bidder: run.ambient_bidder,
    }));

  return { success_runs: successRuns, error_runs: errorRuns, ambient_samples: ambientSamples };
}

function buildMarkdownSummary(result) {
  const aggregate = result.aggregate;
  const firstToken = aggregate.first_token_latency_ms || {};
  const duration = aggregate.duration_ms || {};

  return [
    `# Week 10 Load Summary — gov-ai`,
    ``,
    `## Scenario`,
    `- Tested \`gov-ai\` under parallel inference load using a standalone direct-runner script based on the current core pipeline.`,
    `- Used the real gov-ai prompt shape and real extracted proposal data, but intentionally stayed in controlled single-node mode for Week 10.`,
    `- Reused the same extracted proposal input across all runs to isolate inference behavior from extraction variance.`,
    `- Streaming mode was enabled to capture first-token latency and Ambient verification metadata.`,
    `- Financial multi-node orchestration was intentionally bypassed in this test mode.`,
    ``,
    `## Config`,
    `- URL: ${result.config.url}`,
    `- Runs: ${result.config.runs}`,
    `- Concurrency: ${result.config.concurrency}`,
    `- Model: ${result.config.model}`,
    `- Strict verification hooks: ${String(result.config.strict_verification_hooks)}`,
    `- Total batch duration: ${result.timing.total_batch_duration_ms} ms`,
    ``,
    `## Results`,
    `- Success rate: ${formatPercent(aggregate.success_rate)}`,
    `- Successful runs: ${aggregate.runs_completed_ok}/${aggregate.runs_requested}`,
    `- Failed runs: ${aggregate.runs_failed}`,
    `- Timed out runs: ${aggregate.runs_timed_out}`,
    `- First token latency: median ${valueOrDash(firstToken.median)} ms, p95 ${valueOrDash(firstToken.p95)} ms, max ${valueOrDash(firstToken.max)} ms`,
    `- Completion time: median ${valueOrDash(duration.median)} ms, p95 ${valueOrDash(duration.p95)} ms, max ${valueOrDash(duration.max)} ms`,
    `- Ambient metadata present in ${aggregate.ambient_metadata_present_count} successful runs`,
    `- Ambient verified=true in ${aggregate.ambient_verified_count} successful runs`,
    `- Refusal count: ${aggregate.refusal_count}`,
    `- Strict rejection count: ${aggregate.strict_rejection_count}`,
    ``,
    `## Failure modes`,
    ...formatCountMap(aggregate.failure_types),
    ``,
    `## Evidence`,
    `- Batch result JSON contains per-run timing, status, failure classification, and Ambient metadata fields.`,
    `- Completed runs include supporting \`__ambient\`-derived evidence such as request IDs, merkle roots, validator verification lines, and auction/bidder fields when present.`,
    `- This supports execution provenance for Ambient runs, but does not by itself prove throughput.`,
    ``,
    `## Notes for Week 10 write-up`,
    `- Focus the Discord report on failure modes, degradation patterns, trust threshold, and system limit under this workload.`,
    `- Use this summary together with the full JSON artifact to build the final submission.`,
    ``,
  ].join("\n");
}

function detectRefusal(report, extracted) {
  const signals = [];
  const suggested = safeStr(report?.recommendation?.suggested_option).toUpperCase();
  const confidence = safeStr(report?.recommendation?.confidence).toLowerCase();
  if (suggested === "UNKNOWN") signals.push("suggested_option_unknown");
  if (confidence === "low") signals.push("confidence_low");
  const unknownsCount = Array.isArray(report?.analysis?.unknowns) ? report.analysis.unknowns.length : 0;
  if (unknownsCount > 0) signals.push(`unknowns_present:${unknownsCount}`);
  const optionsCount = Array.isArray(extracted?.options) ? extracted.options.length : 0;
  if (optionsCount === 0) signals.push("missing_extracted_options");
  const sourceType = safeStr(extracted?.source_type).toLowerCase();
  if (sourceType === "generic") signals.push("source_type_generic");

  return {
    refusal_detected:
      signals.includes("suggested_option_unknown") ||
      signals.includes("confidence_low") ||
      signals.includes("missing_extracted_options") ||
      signals.some((signal) => signal.startsWith("unknowns_present:")),
    signals,
  };
}

function isFinancialProposal(title, body) {
  const text = `${title} ${body}`.toLowerCase();
  const patterns = [
    /\$\d+[.,]?\d*\s*(m|k|million|billion|thousand)?/i,
    /\d+\s*(dollar|usd|usdc|dai)\b/i,
    /\b(transfer|allocate|distribute|fund|pay|grant|budget|send|disperse|vest|stake|unlock|claim)\b/i,
    /\b(treasury|endowment|safe|timelock|budget|revenue|compensation|bounty|payment|rewards|allocation|vesting|distribution|disbursement)\b/i,
    /0x[a-fA-F0-9]{40}/,
    /\b(vote|proposal).*\d+\s*(yes|no|for|against)/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const part = argv[i];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

async function runPool({ items, concurrency, worker }) {
  const results = new Array(items.length);
  let index = 0;

  async function runner() {
    while (true) {
      const current = index;
      if (current >= items.length) return;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => runner());
  await Promise.all(workers);
  return results;
}

function summarizeNumbers(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    min: sorted[0],
    avg: Math.round(sum / sorted.length),
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function classifyError(error) {
  const message = String(error?.message || error || "Unknown error");
  if (error?.isTimeout || /timed out/i.test(message)) return { type: "timeout", message };
  if (/no bidders for this auction/i.test(message)) return { type: "no_bidders", message };
  if (error?.httpStatus === 429 || /http 429/i.test(message) || /too many requests/i.test(message)) {
    return { type: "http_429", message };
  }
  if (error?.httpStatus) return { type: `http_${error.httpStatus}`, message };
  if (/Invalid JSON from model/i.test(message)) return { type: "invalid_json", message };
  if (/No streamed content from Ambient/i.test(message)) return { type: "no_stream_content", message };
  return { type: "other", message };
}

function countBy(items) {
  return items.reduce((acc, item) => {
    acc[item] = (acc[item] || 0) + 1;
    return acc;
  }, {});
}

function formatCountMap(map) {
  const entries = Object.entries(map || {});
  if (!entries.length) return ["- None observed"]; 
  return entries.map(([key, value]) => `- ${key}: ${value}`);
}

function isRetryableCapacityError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    error?.httpStatus === 429 ||
    message.includes("too many requests") ||
    message.includes("no bidders for this auction") ||
    message.includes("upstream request failed")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function toBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function isFiniteNumber(value) {
  return Number.isFinite(value);
}

function isoSafeFileName(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, "-");
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function safeStr(value) {
  return typeof value === "string" ? value.trim() : "";
}

function shorten(str, max = 180) {
  if (typeof str !== "string") return str;
  const s = str.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

function valueOrDash(value) {
  return value == null ? "—" : value;
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256File(path) {
  const buf = fs.readFileSync(path);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function attachPromptUsed(report, { prompt, model, stream, files }) {
  if (!report || typeof report !== "object") return;
  if (!report.input || typeof report.input !== "object") report.input = {};

  const excerptMax = 800;
  const excerpt = prompt.length > excerptMax ? prompt.slice(0, excerptMax) : prompt;
  const promptMeta = {
    prompt_used_summary:
      "Structured governance analysis prompt. Must output ONLY valid JSON. Must not guess missing options/results; use UNKNOWN.",
    prompt_used_excerpt: excerpt,
    prompt_used_excerpt_truncated: prompt.length > excerptMax,
    prompt_used_sha256: sha256(prompt),
    model,
    stream: Boolean(stream),
  };

  if (files && typeof files === "object") {
    const out = {};
    for (const [key, path] of Object.entries(files)) {
      if (!path) continue;
      if (fs.existsSync(path)) out[key] = { path, sha256: sha256File(path) };
      else out[key] = { path, sha256: null, missing: true };
    }
    promptMeta.prompt_used_files = out;
  }

  report.input.prompt_used = promptMeta;
}

function buildLoadPrompt(url, extracted, principles) {
  return `
You are given a governance proposal input and must return ONLY valid JSON.

URL:
${url}

EXTRACTED_DATA:
${JSON.stringify(extracted, null, 2)}

USER_PRINCIPLES:
${JSON.stringify(principles, null, 2)}

Rules:
- Use ONLY the provided data.
- If data is missing or uncertain, write "UNKNOWN".
- Do NOT guess voting options or results.
- Keep benefits and risks concrete and evidence-based.
- Output English only.
- Output raw JSON only. No markdown fences. No commentary.

Return exactly this structure:
${fs.readFileSync("./report.schema.json", "utf-8")}
`;
}

function parseModelJson(text) {
  const direct = safeJsonParse(text);
  if (direct) return direct;

  const fenced = String(text || "").match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const parsed = safeJsonParse(fenced[1].trim());
    if (parsed) return parsed;
  }

  const start = String(text || "").indexOf("{");
  const end = String(text || "").lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return safeJsonParse(String(text).slice(start, end + 1));
  }

  return null;
}

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes) {
  if (!bytes || bytes.length === 0) return "";
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      const x = digits[j] * 256 + carry;
      digits[j] = x % 58;
      carry = (x / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let i = 0; i < zeros; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}

async function* sseDataLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const idx = buffer.indexOf("\n\n");
      if (idx === -1) break;
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = rawEvent.split("\n");
      for (const line of lines) {
        if (line.startsWith("data:")) yield line.slice("data:".length).trim();
      }
    }
  }
}

function ambientAddressUrl(address) {
  if (!address) return null;
  return `https://explorer.ambient.xyz/address/${address}`;
}

function pickAuctionStatus(lifecycle) {
  return lifecycle?.auctionEnded?.status || lifecycle?.auctionStarted?.status || null;
}

function pickBidsCount(lifecycle) {
  const placed = lifecycle?.auctionEnded?.bids_placed ?? lifecycle?.auctionStarted?.bids_placed ?? null;
  const revealed = lifecycle?.auctionEnded?.bids_revealed ?? lifecycle?.auctionStarted?.bids_revealed ?? null;
  return { placed, revealed };
}

function pickBidder(lifecycle) {
  const pkBytes = lifecycle?.winningBid?.public_key;
  if (Array.isArray(pkBytes) && pkBytes.length === 32) {
    return base58Encode(Uint8Array.from(pkBytes));
  }
  return lifecycle?.auctionEnded?.winning_bid || lifecycle?.auctionStarted?.winning_bid || null;
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
