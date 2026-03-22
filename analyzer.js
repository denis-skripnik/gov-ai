import fs from "fs";
import "dotenv/config";
import crypto from "crypto";

const API_URL = "https://api.ambient.xyz/v1/chat/completions";
const API_KEY = process.env.AMBIENT_API_KEY;

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
    /\$\d+[.,]?\d*\s*(m|k|million|billion)?/i,
    /\b(usdc|eth|dai|weth|aave|ens|btc|wbtc|DAI|Jun|ATOM)\b/i,
    /\b(transfer|allocate|distribute|fund|pay|grant|budget|send)\b/i,
    /\b(treasury|endowment|safe|timelock|budget|revenue|compensation|bounty|payment)\b/i,
    /0x[a-fA-F0-9]{40}/, // Ethereum addresses
  ];
  
  let matches = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) matches++;
  }
  
  return matches >= 2; // минимум 2 совпадения
}

// ========== Week 8: Multi-node Analysis ==========
function findConsensusIndex(results) {
  // results = [{ result: {...}}, ...] с analysis и recommendation
  
  // Создай ключи для сравнения:
  // suggested_option + confidence + first 50 chars of reasoning
  
  const keys = results.map(r => {
    const rec = r.result.recommendation || {};
    const key = [
      rec.suggested_option || 'UNKNOWN',
      rec.confidence || 'unknown',
      (rec.reasoning || '').substring(0, 50)
    ].join('|');
    return key;
  });
  
  // Подсчитай совпадения
  const counts = {};
  keys.forEach((key, idx) => {
    if (!counts[key]) counts[key] = [];
    counts[key].push(idx);
  });
  
  // Найди консенсус (2+)
  let bestCount = 0;
  let bestIndex = 0;
  
  for (const key in counts) {
    if (counts[key].length > bestCount) {
      bestCount = counts[key].length;
      bestIndex = counts[key][0];
    }
  }
  
  // Логируй
  console.log(`[${new Date().toISOString()}] Consensus check: ${bestCount} identical out of ${keys.length}`);
  console.log(`[${new Date().toISOString()}] Recommendation keys:`, keys);
  
  return bestCount >= 2 ? bestIndex : 0;
}

async function multiNodeAnalysis(url, extracted, principles, maxAttempts = 3) {
  const results = [];
  const tempDir = './temp/multi-node';
  
  // Create temp directory if not exists
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const startTime = Date.now();
      const result = await analyzeWithLLM(url, extracted, principles);
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
    throw new Error('All attempts failed');
  }
  
  // Compare recommendations for consensus
  const chosenIndex = findConsensusIndex(successful);
  const chosen = successful[chosenIndex].result;
  
  // For debugging: collect recommendation keys
  const recommendationKeys = successful.map(r => {
    const rec = r.result?.recommendation || {};
    return [rec.suggested_option || 'UNKNOWN', rec.confidence || 'unknown'].join('|');
  });
  
  // Log why this choice was made
  const reason = chosenIndex === 0 ? 'first-or-no-consensus' : 'consensus';
  console.log(`[${new Date().toISOString()}] Multi-node comparison: ${successful.length} successful, consensus index: ${chosenIndex}, reason: ${reason}`);
  
  // Save final choice with reason
  const summaryFile = `${tempDir}/analysis-${Date.now()}-chosen.json`;
  fs.writeFileSync(summaryFile, JSON.stringify({ 
    chosenFrom: successful.map(r => r.filename),
    chosenIndex,
    recommendationKeys,
    final: chosen,
    reason,
    attempts: results
  }, null, 2));
  
  return chosen;
}

if (!API_KEY) {
  throw new Error("Set AMBIENT_API_KEY env variable");
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
export { latencyTracker, isFinancialProposal, multiNodeAnalysis };

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

export async function analyzeWithLLM(url, extracted, principles, opts = {}) {
  // Week 8: Progress logging
  console.log(`[${new Date().toISOString()}] Starting analysis for: ${url}`);
  
  const {
    model = "zai-org/GLM-5",

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
  if (isFinancial && MULTI_NODE_ENABLED) {
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
