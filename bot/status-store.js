import fs from "fs";
import path from "path";

const JOBS_DIR = path.join(process.cwd(), "jobs");

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
