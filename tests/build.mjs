// Bundles every tests/*.test.ts into tests/dist/*.test.cjs so `node --test`
// can run them without a separate TypeScript toolchain. esbuild transpiles
// (no type-checking) — the pure parser/cueLayout modules have no Obsidian or
// DOM dependencies, so they bundle cleanly for Node.
import { build } from "esbuild";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const testsDir = dirname(fileURLToPath(import.meta.url));
const entryPoints = readdirSync(testsDir)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => join(testsDir, f));

await build({
  entryPoints,
  bundle: true,
  platform: "node",
  format: "cjs",
  outdir: join(testsDir, "dist"),
  outExtension: { ".js": ".cjs" },
  logLevel: "warning",
});
