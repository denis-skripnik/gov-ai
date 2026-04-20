#!/usr/bin/env node
import "dotenv/config";
import { Bot, InlineKeyboard } from "grammy";
import { JobQueue } from "./bot/queue.js";
import { buildJobId, ensureJobsDir, loadJob, countActiveJobsByUser } from "./bot/status-store.js";
import { extractFirstUrl, validateProposalUrl } from "./bot/url-validate.js";

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set.");
  process.exit(1);
}

ensureJobsDir();

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const queue = new JobQueue(bot);

bot.command("start", async (ctx) => {
  await ctx.reply(
    "Send me a supported governance proposal URL and I will queue an analysis. Supported sources: Snapshot, DAO DAO, and Tally. Analysis is long-running by design. A single request may take up to about 1 hour, and if the queue is busy, total waiting time may be several hours."
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply("Send a Snapshot, DAO DAO, or Tally proposal URL. I will validate it, queue it, and send the result when analysis finishes.");
});

bot.on("message:text", async (ctx) => {
  const url = extractFirstUrl(ctx.message.text);
  if (!url) {
    await ctx.reply("Please send a supported proposal URL.");
    return;
  }

  const check = validateProposalUrl(url);
  if (!check.ok) {
    await ctx.reply(check.reason);
    return;
  }

  const activeCount = countActiveJobsByUser(String(ctx.from.id));
  if (activeCount >= 2) {
    await ctx.reply("You already have two proposals in progress. Please wait until one of them finishes before submitting another.");
    return;
  }

  const jobId = buildJobId();
  const position = queue.enqueue({
    jobId,
    userId: String(ctx.from.id),
    chatId: ctx.chat.id,
    inputUrl: check.normalizedUrl,
    sourceType: check.sourceType,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    reportPath: null,
    summary: null,
    error: null,
  });

  const keyboard = new InlineKeyboard()
    .text("Check status", `check_status:${jobId}`)
    .text("My jobs", "my_jobs");

  await ctx.reply(
    `URL accepted\nSource: ${check.sourceType}\nQueue position: ${position}\nJob ID: ${jobId}\n\nThis analysis may take up to about 1 hour once it starts. If the queue is busy, total waiting time may be several hours.`,
    { reply_markup: keyboard }
  );
});

bot.callbackQuery(/^check_status:(.+)$/, async (ctx) => {
  const jobId = ctx.match[1];
  const job = loadJob(jobId);
  if (!job) {
    await ctx.answerCallbackQuery({ text: "Job not found." });
    return;
  }

  let text = `Job ${job.jobId}\nStatus: ${job.status}`;
  if (job.status === "queued") text += `\nQueue position: ${queue.getPosition(jobId) ?? "pending"}`;
  if (job.startedAt) text += `\nStarted: ${job.startedAt}`;
  if (job.finishedAt) text += `\nFinished: ${job.finishedAt}`;
  if (job.error) text += `\nError: ${job.error}`;
  if (job.status === "completed" && job.summary?.recommendation) {
    text += `\nRecommendation: ${job.summary.recommendation}`;
    text += `\nConfidence: ${job.summary.confidence}`;
  }

  const keyboard = new InlineKeyboard().text("My jobs", "my_jobs");
  if (job.summary?.detailUrl) keyboard.row().url("Open details", job.summary.detailUrl);

  await ctx.reply(text, { reply_markup: keyboard });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("my_jobs", async (ctx) => {
  const { text, buttons } = queue.renderMyJobs(String(ctx.from.id));
  const replyMarkup = buttons.length ? { inline_keyboard: buttons } : undefined;
  await ctx.reply(text, replyMarkup ? { reply_markup: replyMarkup } : undefined);
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("analyze_again", async (ctx) => {
  await ctx.reply("Send another supported proposal URL when you are ready.");
  await ctx.answerCallbackQuery();
});

bot.catch((err) => {
  console.error(err.error);
});

bot.start();
console.log("gov-ai Telegram bot started");
