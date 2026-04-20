import http from "http";
import path from "path";
import { spawn } from "child_process";

function canConnect(port, host = "127.0.0.1", timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

export async function ensurePageServer() {
  const port = Number(process.env.PAGE_PORT || 3100);
  const baseUrl = process.env.PAGE_SERVER_BASE_URL;

  if (baseUrl) {
    return { mode: "external", url: baseUrl, started: false };
  }

  const alive = await canConnect(port);
  if (alive) {
    return { mode: "existing", url: `http://127.0.0.1:${port}`, started: false };
  }

  const child = spawn(process.execPath, [path.join(process.cwd(), "pageServer.js")], {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  for (let i = 0; i < 10; i++) {
    const ok = await canConnect(port, "127.0.0.1", 1000);
    if (ok) {
      return { mode: "spawned", url: `http://127.0.0.1:${port}`, started: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return { mode: "unavailable", url: null, started: false };
}
