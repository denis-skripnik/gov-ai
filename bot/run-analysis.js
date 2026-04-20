import { spawn } from "child_process";
import path from "path";
import { findMatchingReport } from "./report-locator.js";

export async function runGovAiAnalysis(inputUrl) {
  const startedAtMs = Date.now();

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), "gov-ai.js"), "analyze", inputUrl], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) return resolve();
      reject(new Error(stderr.trim() || `gov-ai exited with code ${code}`));
    });
  });

  const match = findMatchingReport({ inputUrl, startedAtMs });
  if (!match) {
    throw new Error("Analysis finished, but no matching report file was found.");
  }

  return match;
}
