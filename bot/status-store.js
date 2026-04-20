import fs from "fs";
import path from "path";

const JOBS_DIR = path.join(process.cwd(), "jobs");
const FEEDBACK_VALUES = new Set(["helpful", "needs_review"]);

export function ensureJobsDir() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  return JOBS_DIR;
}

export function buildJobId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `job_${ts}_${rand}`;
}

export function getJobPath(jobId) {
  ensureJobsDir();
  return path.join(JOBS_DIR, `${jobId}.json`);
}

export function saveJob(job) {
  const filePath = getJobPath(job.jobId);
  fs.writeFileSync(filePath, JSON.stringify(job, null, 2));
  return filePath;
}

export function loadJob(jobId) {
  const filePath = getJobPath(jobId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export function updateJob(jobId, patch) {
  const current = loadJob(jobId);
  if (!current) return null;
  const next = { ...current, ...patch };
  saveJob(next);
  return next;
}

function readAllJobs() {
  ensureJobsDir();
  const files = fs.readdirSync(JOBS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(JOBS_DIR, name));

  return files
    .map((filePath) => {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function listJobsByUser(userId, limit = 10) {
  return readAllJobs()
    .filter((job) => String(job.userId) === String(userId))
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
    .slice(0, limit);
}

export function countActiveJobsByUser(userId) {
  return readAllJobs().filter(
    (job) => String(job.userId) === String(userId) && (job.status === "queued" || job.status === "running")
  ).length;
}

export function saveJobFeedback(jobId, userId, value) {
  if (!FEEDBACK_VALUES.has(value)) return { ok: false, code: "invalid_feedback" };

  const job = loadJob(jobId);
  if (!job) return { ok: false, code: "job_not_found" };
  if (job.status !== "completed") return { ok: false, code: "job_not_completed" };

  const normalizedUserId = String(userId);
  const feedback = { ...(job.feedback || {}) };
  const votes = { ...(feedback.votes || {}) };
  const previous = votes[normalizedUserId] || null;

  if (previous?.value === value) {
    return { ok: true, code: "unchanged", feedback: previous, job };
  }

  const nextEntry = {
    value,
    updatedAt: new Date().toISOString(),
  };

  votes[normalizedUserId] = nextEntry;
  const nextFeedback = {
    votes,
    updatedAt: nextEntry.updatedAt,
  };

  const nextJob = updateJob(jobId, { feedback: nextFeedback });
  return { ok: true, code: previous ? "updated" : "created", feedback: nextEntry, job: nextJob };
}
