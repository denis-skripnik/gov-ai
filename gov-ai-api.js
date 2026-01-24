#!/usr/bin/env node
import "dotenv/config";
import fs from "fs";
import http from "http";
import { fetchAndExtract } from "./fetcher.js";
import { analyzeWithLLM } from "./analyzer.js";

// ---------------- CONFIG ----------------

const PORT = process.env.PORT || 3000;
const REPORTS_DIR = "prod-reports";
const MAX_CONCURRENT = 1; // how many jobs can run in parallel

// Ensure reports dir exists
fs.mkdirSync(REPORTS_DIR, { recursive: true });

// ---------------- SIMPLE IN-MEMORY QUEUE ----------------

const queue = [];
let running = 0;

function enqueueJob(job) {
  queue.push(job);
  processQueue();
}

function processQueue() {
  if (running >= MAX_CONCURRENT) return;
  const job = queue.shift();
  if (!job) return;

  running++;
  console.log(`[queue] starting job ${job.jobId}`);

  runAnalysisJob(job.jobId, job.url, job.principles)
    .catch(() => {}) // errors are handled inside runAnalysisJob
    .finally(() => {
      running--;
      console.log(`[queue] finished job ${job.jobId}`);
      processQueue();
    });
}

// ---------------- HELPERS ----------------

function json(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
  });
}

function makeJobId() {
  // ISO timestamp safe for filenames
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function buildReportPath(jobId) {
  return `${REPORTS_DIR}/${jobId}.json`;
}

// ---------------- CORE LOGIC ----------------

async function runAnalysisJob(jobId, url, principlesOverride) {
  try {
    if (!process.env.AMBIENT_API_KEY) {
      throw new Error("AMBIENT_API_KEY is not set");
    }

    let principles;

    if (principlesOverride && typeof principlesOverride === "object") {
      principles = principlesOverride;
    } else {
      if (!fs.existsSync("principles.json")) {
        throw new Error("principles.json not found. Create it or pass principles in request body.");
      }
      principles = JSON.parse(fs.readFileSync("principles.json", "utf-8"));
    }

    const extracted = await fetchAndExtract(url);
    const report = await analyzeWithLLM(url, extracted, principles);

    const path = buildReportPath(jobId);
    fs.writeFileSync(path, JSON.stringify(report, null, 2));
  } catch (e) {
    const path = buildReportPath(jobId);
    fs.writeFileSync(
      path,
      JSON.stringify(
        {
          status: "error",
          error: e?.message || String(e),
        },
        null,
        2
      )
    );
  }
}

// ---------------- HTTP SERVER ----------------

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlObj.pathname;

    // -------- POST /analyze --------
    if (req.method === "POST" && pathname === "/analyze") {
      const body = await readBody(req);

      if (!body.url || typeof body.url !== "string") {
        return json(res, 400, { status: false, error: "Missing or invalid 'url' field" });
      }

      const jobId = makeJobId();

      // Enqueue job instead of running immediately
      enqueueJob({
        jobId,
        url: body.url,
        principles: body.principles || null,
      });

      return json(res, 200, {
        status: true,
        job_id: jobId,
        queued: true,
      });
    }

    // -------- GET /job/:id --------
    if (req.method === "GET" && pathname.startsWith("/job/")) {
      const jobId = pathname.slice("/job/".length).trim();
      if (!jobId) {
        return json(res, 400, { status: false, error: "Missing job id" });
      }

      const path = buildReportPath(jobId);

      if (!fs.existsSync(path)) {
        return json(res, 200, { status: false });
      }

      const report = JSON.parse(fs.readFileSync(path, "utf-8"));
      return json(res, 200, {
        status: true,
        report,
      });
    }

    // -------- Not found --------
    json(res, 404, { status: false, error: "Not found" });
  } catch (e) {
    json(res, 500, { status: false, error: e?.message || String(e) });
  }
});

// ---------------- START ----------------

server.listen(PORT, () => {
  console.log(`gov-ai API server listening on http://localhost:${PORT}`);
  console.log("POST  /analyze   { url, principles? }");
  console.log("GET   /job/:id");
  console.log(`Queue concurrency: ${MAX_CONCURRENT}`);
});
