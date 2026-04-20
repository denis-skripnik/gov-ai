import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatUserFacingAnalysisError } from "./error-format.js";
import { buildDetailLink } from "./page-link.js";
import { saveJob, loadJob, saveJobFeedback } from "./status-store.js";
import { buildTelegramSummary } from "./summary.js";

test("buildDetailLink supports optional section anchors", () => {
  const url = buildDetailLink("/tmp/report.json", "https://example.com/base", { section: "verification" });
  assert.equal(url, "https://example.com/base/report/report.json#verification");
});

test("buildTelegramSummary uses verification-oriented detail wording", () => {
  const summary = buildTelegramSummary({
    input: { title: "Test proposal" },
    recommendation: { suggested_option: "FOR", confidence: "MEDIUM" },
    analysis: { key_changes: ["Change A"] },
  }, "/tmp/report.json", "https://example.com");

  assert.match(summary.text, /Details and verification/);
  assert.match(summary.text, /Review the full report and verification details:/);
  assert.equal(summary.detailUrl, "https://example.com/report/report.json");
});

test("formatUserFacingAnalysisError hides raw report lookup failure details", () => {
  const formatted = formatUserFacingAnalysisError(new Error("Analysis finished, but no matching report file was found."));

  assert.equal(formatted.summary, "Analysis finished, but the report could not be loaded.");
  assert.match(formatted.detail, /Please retry this proposal/);
});

test("saveJobFeedback stores one latest vote per user for completed jobs", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-ai-feedback-"));
  const previousCwd = process.cwd();

  try {
    process.chdir(tempDir);
    saveJob({
      jobId: "job_feedback_test",
      userId: "owner-1",
      chatId: 123,
      status: "completed",
      createdAt: "2026-04-20T00:00:00.000Z",
      startedAt: "2026-04-20T00:01:00.000Z",
      finishedAt: "2026-04-20T00:02:00.000Z",
      summary: { recommendation: "FOR", confidence: "MEDIUM" },
    });

    const first = saveJobFeedback("job_feedback_test", "user-42", "helpful");
    const second = saveJobFeedback("job_feedback_test", "user-42", "needs_review");
    const savedJob = loadJob("job_feedback_test");

    assert.equal(first.ok, true);
    assert.equal(first.code, "created");
    assert.equal(second.ok, true);
    assert.equal(second.code, "updated");
    assert.equal(savedJob.feedback.votes["user-42"].value, "needs_review");
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("saveJobFeedback rejects incomplete jobs", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-ai-feedback-"));
  const previousCwd = process.cwd();

  try {
    process.chdir(tempDir);
    saveJob({
      jobId: "job_feedback_pending",
      userId: "owner-1",
      chatId: 123,
      status: "running",
      createdAt: "2026-04-20T00:00:00.000Z",
    });

    const result = saveJobFeedback("job_feedback_pending", "user-42", "helpful");
    assert.equal(result.ok, false);
    assert.equal(result.code, "job_not_completed");
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
