import fs from "fs";
import "dotenv/config";
import crypto from "crypto";

const API_URL = "https://api.ambient.xyz/v1/chat/completions";
const API_KEY = process.env.AMBIENT_API_KEY;
const STRICT_VERIFICATION_HOOKS = String(process.env.STRICT_VERIFICATION_HOOKS || "").toLowerCase() === "true";

// ========== Week 8: Dynamic Timeout ==========
class LatencyTracker {
  constructor(windowSize = 10) {
    this.windowSize = windowSize;
    this.latencies = [];
  }
  
  add(latencyMs) {
    this.latencies.push(latencyMs);
    if (this.latencies.length > this.windowSize) {
      this.latencies.shift();
    }
  }
  
  getDynamicTimeout() {
    if (this.latencies.length < 3) return 60000; // default 60s
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return median * 3; // 3x median as timeout
  }
}

// Global latency tracker instance
const latencyTracker = new LatencyTracker();

// ========== Week 8: Financial Proposal Detection ==========
function isFinancialProposal(title, body) {
  const text = `${title} ${body}`.toLowerCase();
  
  const patterns = [
    // Dollar/crypto amounts
    /\$\d+[.,]?\d*\s*(m|k|million|billion|thousand)?/i,
    /\d+\s*(dollar|usd|usdc|dai)\b/i,
    // Financial actions
    /\b(transfer|allocate|distribute|fund|pay|grant|budget|send|disperse|vest|stake|unlock|claim)\b/i,
    // Treasury/governance terms
    /\b(treasury|endowment|safe|timelock|budget|revenue|compensation|bounty|payment|rewards|allocation|vesting|distribution|disbursement)\b/i,
    // Addresses (contract interactions)
    /0x[a-fA-F0-9]{40}/,
    // Vote/governance with amounts
    /\b(vote|proposal).*\d+\s*(yes|no|for|against)/i,
  ];
  
  let matches = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) matches++;
  }
  
  return matches >= 1; // минимум 1 совпадение
}

// ========== Week 8: Multi-node Analysis ==========
function findConsensusIndex(results) {
  // Compare ONLY suggested_option - simpler and more reliable
  const keys = results.map(r => r.result.recommendation?.suggested_option || 'UNKNOWN');
  
  const counts = {};
  keys.forEach((key, idx) => {
    if (!counts[key]) counts[key] = [];
    counts[key].push(idx);
  });
  
  // Find most common option
  let bestCount = 0;
  let bestIndex = 0;
  
  for (const key in counts) {
    if (counts[key].length > bestCount) {
      bestCount = counts[key].length;
      bestIndex = counts[key][0];
    }
  }
  
  // Log details
  console.log(`[${new Date().toISOString()}] Consensus check: ${bestCount} identical out of ${keys.length}`);
  console.log(`[${new Date().toISOString()}] Recommendation options:`, keys);
  
  // Consensus = 2+ identical
  const hasConsensus = bestCount >= 2;
  const reason = hasConsensus ? 'consensus' : 'first-or-no-consensus';
  
  return { index: bestIndex, reason };
}

function isAmbientMultiNodeCapacityError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('http 429') ||
    message.includes('too many requests') ||
    message.includes('there were no bidders for this auction') ||
    message.includes('no bidders for this auction')
  );
}

async function multiNodeAnalysis(url, extracted, principles, maxAttempts = 3, isRecursive = false, runtime = {}) {
  const results = [];
  const tempDir = runtime.tempDir || './temp/multi-node';
  const runAnalysis = runtime.runAnalysis || analyzeWithLLM;
  const sleepFn = runtime.sleep || sleep;
  const fallbackBackoffsMs = runtime.multiNodeFallbackBackoffsMs || [10000, 30000, 60000];
  
  // Create temp directory if not exists
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const startTime = Date.now();
      const result = await runAnalysis(url, extracted, principles, { skipFinancialCheck: true });
      const latency = Date.now() - startTime;
      latencyTracker.add(latency);
      
      const filename = `${tempDir}/analysis-${Date.now()}-attempt-${i}.json`;
      fs.writeFileSync(filename, JSON.stringify(result, null, 2));
      results.push({ attempt: i, result, filename, success: true, latencyMs: latency });
    } catch (e) {
      const filename = `${tempDir}/analysis-${Date.now()}-attempt-${i}-error.json`;
      fs.writeFileSync(filename, JSON.stringify({ error: e.message }, null, 2));
      results.push({ attempt: i, error: e.message, filename, success: false });
    }
  }
  
  // Compare results
  const successful = results.filter(r => r.success);
  if (successful.length === 0) {
    const retryableErrors = results.filter((r) => !r.success && isAmbientMultiNodeCapacityError(r.error));
    if (retryableErrors.length === maxAttempts) {
      if (!isRecursive) {
        console.warn(`[${new Date().toISOString()}] Ambient multi-node capacity issue detected. Retrying multi-node stage with backoff...`);

        for (let retryIndex = 0; retryIndex < fallbackBackoffsMs.length; retryIndex++) {
          const delayMs = fallbackBackoffsMs[retryIndex];
          console.warn(`[${new Date().toISOString()}] Multi-node retry ${retryIndex + 1}/${fallbackBackoffsMs.length} in ${Math.round(delayMs / 1000)}s`);
          await sleepFn(delayMs);

          try {
            return await multiNodeAnalysis(url, extracted, principles, maxAttempts, true, runtime);
          } catch (retryError) {
            if (!isAmbientMultiNodeCapacityError(retryError)) throw retryError;
          }
        }

        console.warn(`[${new Date().toISOString()}] Multi-node retries exhausted due to Ambient capacity issue. Falling back to single-node analysis.`);
        const fallbackReport = await runAnalysis(url, extracted, principles, { skipFinancialCheck: true, multiNodeFallbackActive: true });
        if (fallbackReport && fallbackReport.input) {
          fallbackReport.input.multiNodeFallback = {
            activated: true,
            reason: 'ambient_multi_node_capacity',
            retries: fallbackBackoffsMs.map((delayMs) => Math.round(delayMs / 1000)),
            fallback_mode: 'single-node',
          };
        }
        return fallbackReport;
      }

      throw new Error(retryableErrors[retryableErrors.length - 1].error);
    }

    throw new Error('All attempts failed');
  }
  
  // Compare recommendations for consensus
  const consensusResult = findConsensusIndex(successful);
  const chosenIndex = consensusResult.index;
  const chosen = successful[chosenIndex].result;
  
  // For debugging: collect recommendation keys
  const recommendationKeys = successful.map(r => {
    const rec = r.result?.recommendation || {};
    return [rec.suggested_option || 'UNKNOWN', rec.confidence || 'unknown'].join('|');
  });
  
  // Log why this choice was made
  console.log(`[${new Date().toISOString()}] Multi-node comparison: ${successful.length} successful, consensus index: ${chosenIndex}, reason: ${consensusResult.reason}`);
  
  // Save final choice with reason
  const summaryFile = `${tempDir}/analysis-${Date.now()}-chosen.json`;
  fs.writeFileSync(summaryFile, JSON.stringify({ 
    chosenFrom: successful.map(r => r.filename),
    chosenIndex,
    recommendationKeys,
    final: chosen,
    reason: consensusResult.reason,
    attempts: results
  }, null, 2));
  
  return chosen;
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

function shorten(str, max = 180) {
  if (typeof str !== "string") return str;
  const s = str.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...`;
}

function isRetryableNetworkError(e) {
  const code = e?.code || e?.cause?.code;
  if (code === "UND_ERR_SOCKET" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN") {
    return true;
  }
  const msg = String(e?.message || e?.cause?.message || "").toLowerCase();
  return msg.includes("other side closed") || msg.includes("fetch failed");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, { tries = 3, baseDelayMs = 600 } = {}) {
  let retries = 0;
  while (true) {
    const startTime = Date.now();
    try {
      return await fn();
    } catch (e) {
      // Track latency even on failure (for timeout calculation)
      const latency = Date.now() - startTime;
      latencyTracker.add(latency);
      
      if (!isRetryableNetworkError(e) || retries >= tries - 1) throw e;
      const delay = baseDelayMs * 2 ** retries;
      retries += 1;
      await sleep(delay);
    }
  }
}

// Export for external use
export { latencyTracker, isFinancialProposal, isAmbientMultiNodeCapacityError, multiNodeAnalysis };

// Minimal base58 encoder (no deps)
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes) {
  if (!bytes || bytes.length === 0) return "";
  // Count leading zeros
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Convert base256 -> base58
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

  // Build string
  let out = "";
  for (let i = 0; i < zeros; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}

// SSE parser: yields strings after "data:"
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
      for (const l of lines) {
        if (l.startsWith("data:")) {
          yield l.slice("data:".length).trim();
        }
      }
    }
  }
}

function ambientAddressUrl(address) {
  if (!address) return null;
  return `https://explorer.ambient.xyz/address/${address}`;
}

function pickAuctionStatus(lifecycle) {
  // Prefer auctionEnded.status, else auctionStarted.status
  return lifecycle?.auctionEnded?.status || lifecycle?.auctionStarted?.status || null;
}

function pickBidsCount(lifecycle) {
  const placed = lifecycle?.auctionEnded?.bids_placed ?? lifecycle?.auctionStarted?.bids_placed ?? null;
  const revealed = lifecycle?.auctionEnded?.bids_revealed ?? lifecycle?.auctionStarted?.bids_revealed ?? null;
  return { placed, revealed };
}

function pickBidder(lifecycle) {
  // Best signal: winningBid.public_key (bytes array), convert to base58
  const pkBytes = lifecycle?.winningBid?.public_key;
  if (Array.isArray(pkBytes) && pkBytes.length === 32) {
    return base58Encode(Uint8Array.from(pkBytes));
  }
  // Fallback: auctionEnded.winning_bid (already base58)
  return lifecycle?.auctionEnded?.winning_bid || lifecycle?.auctionStarted?.winning_bid || null;
}

export function classifyVerificationHooks(report, extracted, opts = {}) {
  const strictMode = typeof opts.strictMode === "boolean" ? opts.strictMode : STRICT_VERIFICATION_HOOKS;
  const evidenceQuotes = Array.isArray(report?.analysis?.evidence_quotes)
    ? report.analysis.evidence_quotes.filter((x) => typeof x === "string" && x.trim())
    : [];
  const extractedTitle = normalizeText(extracted?.title);
  const extractedBody = normalizeText(extracted?.body);
  const extractedOptions = Array.isArray(extracted?.options)
    ? extracted.options.map((x) => normalizeText(x)).filter(Boolean)
    : [];

  const candidates = [];
  collectCandidateSegments(candidates, report?.analysis?.summary, "analysis.summary");
  collectCandidateArray(candidates, report?.analysis?.key_changes, "analysis.key_changes");
  collectCandidateArray(candidates, report?.analysis?.risks, "analysis.risks");
  collectCandidateArray(candidates, report?.analysis?.benefits, "analysis.benefits");
  collectCandidateArray(candidates, report?.analysis?.unknowns, "analysis.unknowns");
  collectCandidateSegments(candidates, report?.recommendation?.reasoning, "recommendation.reasoning");
  collectCandidateArray(candidates, report?.recommendation?.conflicts_with_user_principles, "recommendation.conflicts_with_user_principles");

  const segments = [];
  const pathCategories = new Map();

  for (const candidate of candidates) {
    const category = classifySegment(candidate.text, {
      path: candidate.path,
      evidenceQuotes,
      extractedTitle,
      extractedBody,
      extractedOptions,
    });
    segments.push({
      path: candidate.path,
      text: candidate.text,
      category: category.category,
      reasons: category.reasons,
    });

    if (!pathCategories.has(candidate.path)) pathCategories.set(candidate.path, new Set());
    pathCategories.get(candidate.path).add(category.category);
  }

  const mixedSegments = [];
  for (const [path, categories] of pathCategories.entries()) {
    if (categories.size > 1) mixedSegments.push({ path, categories: Array.from(categories) });
  }

  const mixedCategoriesDetected = mixedSegments.length > 0;
  const strictRejectionTriggered = strictMode && mixedCategoriesDetected;
  const hasUnverifiable = segments.some((segment) => segment.category === "unverifiable");
  const routingAction = strictRejectionTriggered
    ? "HUMAN_REVIEW"
    : mixedCategoriesDetected
      ? "WARN"
      : hasUnverifiable
        ? "WARN"
        : "ALLOW";

  return {
    segments,
    mixed_segments: mixedSegments,
    mixed_categories_detected: mixedCategoriesDetected,
    requires_separation: mixedCategoriesDetected,
    strict_mode: strictMode,
    strict_rejection_triggered: strictRejectionTriggered,
    routing_action: routingAction,
    method: {
      kind: "heuristic",
      version: 1,
      notes: [
        "Deterministic segments are anchored to extracted title/body/options, evidence quotes, or hard literals.",
        "Probabilistic segments include recommendation, risk, benefit, and uncertainty language.",
        "Unverifiable segments are vague or unsupported without clear anchors.",
      ],
    },
  };
}

function collectCandidateArray(out, arr, basePath) {
  if (!Array.isArray(arr)) return;
  for (let i = 0; i < arr.length; i++) {
    collectCandidateSegments(out, arr[i], `${basePath}[${i}]`);
  }
}

function collectCandidateSegments(out, text, path) {
  if (typeof text !== "string" || !text.trim()) return;
  const parts = splitIntoSegments(text);
  if (parts.length <= 1) {
    out.push({ path, text: text.trim() });
    return;
  }
  for (let i = 0; i < parts.length; i++) {
    out.push({ path, text: parts[i] });
  }
}

function splitIntoSegments(text) {
  return String(text)
    .split(/(?<=[.!?])\s+|\s*[;•]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function classifySegment(text, context) {
  const normalized = normalizeText(text);
  const lower = normalized.toLowerCase();
  const reasons = [];

  const deterministic = matchesDeterministic(lower, context, reasons);
  const probabilistic = matchesProbabilistic(lower, context, reasons);
  const path = String(context.path || "");

  if (probabilistic && (path.startsWith("recommendation.") || path.startsWith("analysis.risks") || path.startsWith("analysis.benefits"))) {
    return { category: "probabilistic", reasons };
  }
  if (deterministic) return { category: "deterministic", reasons };
  if (probabilistic) return { category: "probabilistic", reasons };

  if (looksVague(lower)) reasons.push("vague_or_unsupported");
  else reasons.push("not_anchored_to_source_material");
  return { category: "unverifiable", reasons };
}

function matchesDeterministic(lower, context, reasons) {
  let matched = false;
  if (context.evidenceQuotes.some((quote) => {
    const q = normalizeText(quote).toLowerCase();
    return q && (lower.includes(q) || q.includes(lower));
  })) {
    reasons.push("matches_evidence_quote");
    matched = true;
  }
  if (context.extractedTitle && context.extractedTitle.toLowerCase().length >= 8) {
    const titleFragment = context.extractedTitle.toLowerCase().slice(0, 24);
    if (lower.includes(titleFragment)) {
      reasons.push("matches_extracted_title");
      matched = true;
    }
  }
  if (context.extractedBody && context.extractedBody.toLowerCase().length >= 60) {
    const bodyFragment = context.extractedBody.toLowerCase().slice(0, 60);
    if (lower.includes(bodyFragment)) {
      reasons.push("matches_extracted_body_fragment");
      matched = true;
    }
  }
  if (context.extractedOptions.some((option) => containsWholeOption(lower, option))) {
    reasons.push("mentions_extracted_option");
    matched = true;
  }
  if (/\b\d+([.,]\d+)?\b/.test(lower) || /\b0x[a-f0-9]{8,}\b/.test(lower) || /\b[a-z]{2,6}-\d+\b/i.test(lower)) {
    reasons.push("contains_hard_literal");
    matched = true;
  }
  return matched;
}

function matchesProbabilistic(lower, context, reasons) {
  let matched = false;
  const path = String(context.path || "");
  if (/\b(likely|unlikely|probably|possible|possibly|may|might|could|appears|suggests|risk|benefit|recommend|confidence|should|prefer|best)\b/.test(lower)) {
    reasons.push("contains_inference_language");
    matched = true;
  }
  if (path.startsWith("analysis.risks") || path.startsWith("analysis.benefits") || path.startsWith("recommendation.")) {
    reasons.push("interpretive_field");
    matched = true;
  }
  if (/\b(unknown|unclear|insufficient|not enough|cannot determine|can't determine|missing information)\b/.test(lower)) {
    reasons.push("uncertainty_language");
    matched = true;
  }
  return matched;
}

function looksVague(lower) {
  return /\b(good|bad|strong|weak|important|positive|negative|reasonable|concerning|interesting)\b/.test(lower);
}

function containsWholeOption(lower, option) {
  const normalizedOption = normalizeText(option).toLowerCase();
  if (!normalizedOption) return false;
  const escaped = normalizedOption.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (normalizedOption.length <= 3) {
    return new RegExp(`(?:option|vote|choose|support|oppose|recommend)\\s+${escaped}\\b|["'“”]${escaped}["'“”]|\\b${escaped}\\b\s*[:)]`, "i").test(lower);
  }
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(lower);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export async function analyzeWithLLM(url, extracted, principles, opts = {}) {
  if (!API_KEY) throw new Error("Set AMBIENT_API_KEY env variable");
  // Week 8: Progress logging
  console.log(`[${new Date().toISOString()}] Starting analysis for: ${url}`);
  
  const {
    model = "zai-org/GLM-5-FP8",

    // Keep raw response JSON? For now: no spam, but can save if you need.
    debugRawToFile = false,

    // IMPORTANT: for "UI-like verification", stream must be true
    stream = true,
  } = opts;

  // Week 8: Check if financial proposal
  const isFinancial = isFinancialProposal(extracted?.title || '', extracted?.body || '');
  console.log(`[${new Date().toISOString()}] Checking if financial proposal... ${isFinancial ? 'YES' : 'NO'}`);
  
  // Week 8: Multi-node analysis for financial proposals (default: enabled)
  const MULTI_NODE_ENABLED = process.env.MULTI_NODE_ENABLED === 'true' || process.env.MULTI_NODE_ENABLED === undefined;
  if (isFinancial && MULTI_NODE_ENABLED && !opts.skipFinancialCheck) {
    console.log(`[${new Date().toISOString()}] Financial proposal detected - running multi-node analysis...`);
    const report = await multiNodeAnalysis(url, extracted, principles);
    // Attach financial proposal flag to report
    if (report && report.input) {
      report.input.isFinancialProposal = true;
    }
    return report;
  }
  
  const prompt = buildPrompt(url, extracted, principles);

  if (!stream) {
    return withRetry(async () => {
      // Non-streaming mode: you only get verified + merkle_root (no lifecycle events).
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
          stream: false,
          emit_verified: true,
          emit_ambient_events: true,
          wait_for_verification: true,
          emit_usage: true,
        }),
      });

      const requestId = response.headers.get("x-request-id") || null;
      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw new Error(`Ambient API error HTTP ${response.status} (x-request-id: ${requestId || "UNKNOWN"}): ${shorten(bodyText, 800)}`);
      }

      const data = await response.json().catch(async () => {
        const bodyText = await response.text().catch(() => "");
        throw new Error(`Ambient returned non-JSON response (x-request-id: ${requestId || "UNKNOWN"}): ${shorten(bodyText, 500)}`);
      });

      const verificationUI = {
        verified: data?.verified ?? null,
        merkle_root: data?.merkle_root ?? null,
        request_id: requestId,
        verified_by_validators: null,
        validators: null,
        auction: null,
        bids: null,
        bidder: null,
      };

      console.log("verification:", verificationUI);

      const assistantMsg = data?.choices?.[0]?.message;
      const text = assistantMsg?.content;
      if (!text) throw new Error(`No response from Ambient (x-request-id: ${requestId || "UNKNOWN"})`);

      const report = safeJsonParse(text);
      if (!report) throw new Error("Invalid JSON from model");

      report.__ambient = verificationUI;
      // Attach prompt in the correct place (input.prompt_used), programmatically (not model-controlled)
      attachPromptUsed(report, {
        prompt,
        model,
        stream: false,
        files: {
principles: "./principles.json",
schema: "./report.schema.json",
        },
      });

      // Week 8: Attach financial proposal flag
      if (report && report.input) {
        report.input.isFinancialProposal = isFinancial;
      }

      return report;
    });
  }

  return withRetry(async () => {
    // Streaming mode: captures ambient.lifecycle events + text chunks + merkle_root + verified
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
    });

    const requestId = response.headers.get("x-request-id") || null;
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(`Ambient API error HTTP ${response.status} (x-request-id: ${requestId || "UNKNOWN"}): ${shorten(bodyText, 800)}`);
    }

    let text = "";
    let verified = null;
    let merkleRoot = null;
    let usage = null;

    // Collect minimal lifecycle info needed for UI-like verification
    const lifecycle = {
      jobRequested: null,
      bundled: null,
      auctionStarted: null,
      auctionEnded: null,
      winningBid: null,
    };

    // Optional raw event log file (off by default)
    let rawEvents = [];
    const rawPath = debugRawToFile ? `ambient-sse-${isoSafeFileName()}.jsonl` : null;

    for await (const dataLine of sseDataLines(response)) {
      if (dataLine === "[DONE]") continue;

      const obj = safeJsonParse(dataLine);
      if (!obj) continue;

      if (debugRawToFile) {
        rawEvents.push(obj);
        if (rawEvents.length >= 50) {
          fs.appendFileSync(rawPath, rawEvents.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");
          rawEvents = [];
        }
      }

      if (obj.object === "ambient.lifecycle") {
        const t = obj.type;
        if (t === "jobRequested") lifecycle.jobRequested = obj.content;
        else if (t === "bundled") lifecycle.bundled = obj.content;
        else if (t === "auctionStarted") lifecycle.auctionStarted = obj.content;
        else if (t === "auctionEnded") lifecycle.auctionEnded = obj.content;
        else if (t === "winningBid") lifecycle.winningBid = obj.content;
        continue;
      }

      if (obj.object === "chat.completion.chunk") {
        const delta = obj.choices?.[0]?.delta?.content;
        if (typeof delta === "string") text += delta;
        continue;
      }

      if (obj.object === "chat.completion.usage") {
        if (obj.merkle_root) merkleRoot = obj.merkle_root;
        if (obj.usage) usage = obj.usage;
        continue;
      }

      if (typeof obj.verified === "boolean") {
        verified = obj.verified;
        continue;
      }
    }

    if (debugRawToFile) {
      if (rawEvents.length) {
        fs.appendFileSync(rawPath, rawEvents.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");
        rawEvents = [];
      }
    }

    // Build UI-like verification block (similar to app.ambient.xyz)
    const verifiers = lifecycle?.bundled?.verifiers?.keys || null;
    const validatorsCount = Array.isArray(verifiers) ? verifiers.length : null;

    const auctionAddress = lifecycle?.bundled?.auction || lifecycle?.auctionStarted?.auction || lifecycle?.auctionEnded?.auction || null;
    const auctionStatusRaw = pickAuctionStatus(lifecycle);
    const auctionStatus = auctionStatusRaw ? (String(auctionStatusRaw).toLowerCase() === "ended" ? "Done" : auctionStatusRaw) : null;

    const bids = pickBidsCount(lifecycle);
    const bidder = pickBidder(lifecycle);

    const verificationUI = {
      verified: verified,
      merkle_root: merkleRoot,
      request_id: requestId,
      model,

      // UI-like lines
      verified_by_validators: validatorsCount != null ? `Verified by ${validatorsCount} validators` : null,
      auction: auctionAddress
        ? {
            status: auctionStatus,
            bids: (bids.placed != null || bids.revealed != null) ? { placed: bids.placed, revealed: bids.revealed } : null,
            address: ambientAddressUrl(auctionAddress),
          }
        : null,

      bidder: bidder ? ambientAddressUrl(bidder) : null,
    };

    // Print only verification block (as you requested)
    console.log("verification:", verificationUI);

    // Parse JSON report (model output is expected to be JSON)
    if (!text) throw new Error(`No streamed content from Ambient (x-request-id: ${requestId || "UNKNOWN"})`);

    const report = safeJsonParse(text);
    if (!report) {
      console.error("Model returned non-JSON (first 2000 chars):");
      console.error(text.slice(0, 2000));
      throw new Error("Invalid JSON from model");
    }

    // Attach metadata (keeps existing pipeline unchanged)
    report.__ambient = verificationUI;

    // Attach prompt in the correct place (input.prompt_used), programmatically (not model-controlled)
    attachPromptUsed(report, {
      prompt,
      model,
      stream: true,
      files: {
principles: "./principles.json",
schema: "./report.schema.json",
      },
    });

    // Week 8: Attach financial proposal flag
    if (report && report.input) {
      report.input.isFinancialProposal = isFinancial;
    }

    return report;
  });
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
    // This satisfies "Prompt used" without bloating report.json
    prompt_used_summary:
      "Structured governance analysis prompt. Must output ONLY valid JSON. Must not guess missing options/results; use UNKNOWN.",
    prompt_used_excerpt: excerpt,
    prompt_used_excerpt_truncated: prompt.length > excerptMax,
    prompt_used_sha256: sha256(prompt),

    // Helpful run metadata
    model,
    stream: Boolean(stream),
  };

  // Optional: reference input files instead of duplicating their contents
  if (files && typeof files === "object") {
    const out = {};
    for (const [key, path] of Object.entries(files)) {
      if (!path) continue;
      if (fs.existsSync(path)) {
        out[key] = { path, sha256: sha256File(path) };
      } else {
        out[key] = { path, sha256: null, missing: true };
      }
    }
    promptMeta.prompt_used_files = out;
  }

  report.input.prompt_used = promptMeta;
}

function buildPrompt(url, extracted, principles) {
  return `
You are given:

URL:
${url}

EXTRACTED_DATA (may be incomplete):
${JSON.stringify(extracted, null, 2)}

USER_PRINCIPLES:
${JSON.stringify(principles, null, 2)}

TASK:
Produce a JSON report with the following rules:

- If some fields (options, results, execution details) are missing or uncertain, you MUST explicitly say "UNKNOWN".
- Do NOT guess voting options or results.
- Base your analysis ONLY on provided data.
- Interpretation note: Treat 'avoid_admin_key_changes' as: proposals that add or modify privileged roles, upgrade admins, multisig signers, or emergency permissions are high-risk.
- Avoid generic statements. Every benefit/risk must reference a concrete mechanism or outcome mentioned in the proposal.
- Do not mix categories: risks must describe negative outcomes of passing the proposal, benefits must describe positive outcomes of passing it. Do not put benefits into risks.
- Be conservative and honest.
- Output ONLY valid JSON, no comments, no markdown.
- Output must be in English only. Do not use non-English words or characters.

RECOMMENDATION DISCIPLINE (IMPORTANT):
- Do NOT use "current_results" as social proof or as a reason to follow the crowd.
- You MAY mention current_results factually (numbers/status) but must NOT infer sentiment, intent, or "community believes" from vote counts.
- Recommendation reasoning must be based on proposal content: key_changes, benefits, risks, unknowns, and user principles - not on vote distribution.
- Apply a higher evidence threshold for high-impact proposals (treasury spending, admin privileges, protocol security, upgrades).
- If such a proposal is underspecified, treat it as high-risk and reflect that in risks/unknowns and in recommendation confidence.
- Do NOT default to abstaining mechanically: choose the suggested_option ONLY from the extracted voting options (case-sensitive), based on whether benefits vs risks are supported by the proposal text.
- If extracted options are ["YAE","NAY","Abstain"], suggested_option must be exactly "YAE" or "NAY" or "Abstain" (do NOT output FOR/AGAINST/YES/NO).

BENEFITS FIELD REQUIREMENTS (NEW):

The "analysis.benefits" field is a string array that must contain ONLY evidence-based potential upsides.

Rules:
1) Each benefit must be directly supported by the proposal text or extracted metadata
2) Benefits must be concrete and specific, not vague or speculative
3) If a benefit is mentioned but depends on missing information, move it to "unknowns" instead
4) If no clear benefits are stated in the proposal, return empty array: []
5) Do NOT use marketing language (revolutionary, game-changing, unprecedented, innovative)
6) Keep each benefit short and factual
7) Do NOT include generic platitudes (e.g. "improves decentralization") unless explicitly stated in the proposal text

Examples of ACCEPTABLE benefits:
✅ "Reduces deficit recognition latency (proposal states 'faster deficit realization')"
✅ "Automates manual cleanup process"
✅ "Provides budget-bounded approach to risk management"

Examples of UNACCEPTABLE benefits (move to unknowns or omit):
❌ "Could improve user confidence" (speculative, not in proposal)
❌ "Revolutionary risk management approach" (marketing language)
❌ "Will save millions in bad debt" (no amount specified → move to unknowns)
❌ "Better than competing protocols" (no comparison made)

Decision tree:
- Is benefit explicitly mentioned in proposal?
  → NO: Do not include
  → YES: Continue
- Is it concrete and measurable?
  → NO: Move to unknowns as "Unclear: [detail]"
  → YES: Continue
- Does it use marketing language?
  → YES: Rephrase neutrally
  → NO: Include in benefits[]

Follow this JSON structure exactly:
${fs.readFileSync("./report.schema.json", "utf-8")}
`;
}
