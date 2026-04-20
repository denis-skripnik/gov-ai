import { buildTelegramSummary } from "./summary.js";
import { formatUserFacingAnalysisError } from "./error-format.js";
import { runGovAiAnalysis } from "./run-analysis.js";
import { saveJob, updateJob, listJobsByUser } from "./status-store.js";
import { ensurePageServer } from "./page-server.js";

export class JobQueue {
  constructor(bot) {
    this.bot = bot;
    this.items = [];
    this.running = false;
    this.pageServer = { mode: "unknown", url: null, started: false };
  }

  enqueue(job) {
    this.items.push(job);
    saveJob({ ...job, queuePosition: this.items.length, status: "queued" });
    this.syncQueuePositions();
    this.kick();
    return this.items.length;
  }

  getPosition(jobId) {
    const idx = this.items.findIndex((job) => job.jobId === jobId);
    return idx === -1 ? null : idx + 1;
  }

  async kick() {
    if (this.running) return;
    const next = this.items.shift();
    if (!next) return;

    this.syncQueuePositions();
    this.running = true;
    try {
      await this.runJob(next);
    } finally {
      this.running = false;
      this.kick();
    }
  }

  async runJob(job) {
    updateJob(job.jobId, { status: "running", startedAt: new Date().toISOString(), queuePosition: 0 });
    await this.bot.api.sendMessage(job.chatId, "Analysis started. This proposal is now being processed and may take up to about 1 hour.", {
      reply_markup: {
        inline_keyboard: [[
          { text: "Check status", callback_data: `check_status:${job.jobId}` },
          { text: "My jobs", callback_data: "my_jobs" },
        ]],
      },
    });

    try {
      if (!this.pageServer.url && this.pageServer.mode !== "unavailable") {
        this.pageServer = await ensurePageServer();
      }

      const { filePath, report } = await runGovAiAnalysis(job.inputUrl);
      const summary = buildTelegramSummary(report, filePath, this.pageServer.url);
      updateJob(job.jobId, {
        status: "completed",
        finishedAt: new Date().toISOString(),
        reportPath: filePath,
        summary,
        error: null,
      });

      const buttons = [
        [
          { text: "👍 Helpful", callback_data: `feedback:${job.jobId}:helpful` },
          { text: "👎 Needs review", callback_data: `feedback:${job.jobId}:needs_review` },
        ],
        [{ text: "My jobs", callback_data: "my_jobs" }, { text: "Analyze another", callback_data: "analyze_again" }],
      ];
      if (summary.detailUrl) buttons.unshift([{ text: "Details and verification", url: summary.detailUrl }]);

      await this.bot.api.sendMessage(job.chatId, summary.text, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons },
      });
    } catch (error) {
      const userError = formatUserFacingAnalysisError(error);

      updateJob(job.jobId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: String(error.message || error),
      });

      await this.bot.api.sendMessage(job.chatId, `${userError.summary}\n${userError.detail}`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Check status", callback_data: `check_status:${job.jobId}` },
              { text: "My jobs", callback_data: "my_jobs" },
            ],
            [{ text: "Analyze another", callback_data: "analyze_again" }],
          ],
        },
      });
    }
  }

  syncQueuePositions() {
    for (let i = 0; i < this.items.length; i++) {
      updateJob(this.items[i].jobId, { queuePosition: i + 1, status: "queued" });
    }
  }

  renderMyJobs(userId) {
    const jobs = listJobsByUser(userId, 10);
    if (!jobs.length) {
      return { text: "No jobs yet.", buttons: [] };
    }

    const lines = ["Your recent jobs:"];
    const buttons = [];
    for (const job of jobs) {
      lines.push(`#${job.jobId} ${job.status}`);
      buttons.push([{ text: `Status ${job.jobId.slice(-8)}`, callback_data: `check_status:${job.jobId}` }]);
    }
    return { text: lines.join("\n"), buttons };
  }
}
