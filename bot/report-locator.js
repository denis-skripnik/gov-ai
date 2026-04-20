import fs from "fs";
import path from "path";

const REPORTS_DIR = path.join(process.cwd(), "reports");

export function findMatchingReport({ inputUrl, startedAtMs }) {
  if (!fs.existsSync(REPORTS_DIR)) return null;

  const files = fs.readdirSync(REPORTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const filePath = path.join(REPORTS_DIR, name);
      const stat = fs.statSync(filePath);
      return { filePath, name, mtimeMs: stat.mtimeMs };
    })
    .filter((item) => item.mtimeMs >= startedAtMs - 1000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const item of files) {
    try {
      const report = JSON.parse(fs.readFileSync(item.filePath, "utf-8"));
      if (String(report?.input?.url || "") === String(inputUrl)) {
        return { filePath: item.filePath, report };
      }
    } catch {
      continue;
    }
  }

  return null;
}
