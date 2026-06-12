// DEBUG HARNESS RUNNER (throwaway). Serves the plugin dir over localhost,
// launches headless Brave at the harness page, and waits for the page to POST
// its probe results back — robust against Chromium's stdout detachment on
// Windows. Usage: node tests/lpclick-harness/run.mjs [fixVariant ...]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const harnessDir = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(harnessDir, "..", "..");

// bundle.js is generated (gitignored) — build it fresh on every run.
await build({
  entryPoints: [join(harnessDir, "harness.mjs")],
  bundle: true,
  format: "iife",
  outfile: join(harnessDir, "bundle.js"),
  logLevel: "warning",
});
const BRAVE = "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const variants = process.argv.slice(2);
if (variants.length === 0) variants.push("none");

let resolveResult;
const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/result") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200).end("ok");
      resolveResult?.(JSON.parse(body));
    });
    return;
  }
  const path = normalize(join(pluginDir, req.url.split("?")[0])).replace(/\\/g, "/");
  if (!path.startsWith(pluginDir.replace(/\\/g, "/"))) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(path);
    res.writeHead(200, { "Content-Type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

for (const fix of variants) {
  const url =
    `http://127.0.0.1:${port}/tests/lpclick-harness/index.html` +
    (fix === "none" ? "" : `?fix=${fix}`);
  const udd = join(process.env.TEMP ?? ".", `brave-lpclick-${fix}-${process.pid}`);
  const child = spawn(
    BRAVE,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--disable-extensions",
      `--user-data-dir=${udd}`,
      url,
    ],
    { stdio: "ignore" }
  );
  const result = await Promise.race([
    new Promise((r) => (resolveResult = r)),
    new Promise((r) => setTimeout(() => r({ timeout: true }), 30000)),
  ]);
  try {
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
  } catch {}
  console.log(JSON.stringify({ variant: fix, ...result }));
}
server.close();
process.exit(0);
