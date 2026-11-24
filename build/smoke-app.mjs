#!/usr/bin/env node
// Launches a built Synapse IDE and checks it works as a product, not just as
// a build: the workbench opens under the Synapse name, the built-in extension
// starts synapse-core for the open repository, the board renders, and there
// is no GitHub Copilot. Drives the app with Playwright's Electron support.
//
//   node build/smoke-app.mjs <VSCode-platform-arch> [--screenshot out.png]
//
// On Linux CI, run it under a virtual display: xvfb-run -a node build/smoke-app.mjs …
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron } from "playwright-core";
import { findAppRoot, readJson } from "./lib.mjs";

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--screenshot");
const shotIdx = args.indexOf("--screenshot");
const screenshot = shotIdx >= 0 ? path.resolve(args[shotIdx + 1]) : undefined;
if (!outDir || !fs.existsSync(outDir)) {
  console.error("usage: node build/smoke-app.mjs <built app folder> [--screenshot out.png]");
  process.exit(2);
}

const appRoot = findAppRoot(path.resolve(outDir));
if (!appRoot) throw new Error(`no resources/app folder under ${outDir}`);
const product = readJson(path.join(appRoot, "product.json"));

/** The app's executable inside the build folder. */
function executable() {
  const root = path.resolve(outDir);
  if (process.platform === "darwin") {
    const bundle = fs.readdirSync(root).find((f) => f.endsWith(".app"));
    const macos = path.join(root, bundle ?? "", "Contents", "MacOS");
    const exe = fs.readdirSync(macos)[0];
    return path.join(macos, exe);
  }
  if (process.platform === "win32") return path.join(root, `${product.nameShort}.exe`);
  return path.join(root, product.applicationName);
}

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// 1. What ships (no app launch needed).
check("no built-in GitHub Copilot extension", !fs.existsSync(path.join(appRoot, "extensions", "copilot")));
check("Synapse extension is built in", fs.existsSync(path.join(appRoot, "extensions", "synapse-collab", "dist", "extension.cjs")));
const messages = JSON.parse(fs.readFileSync(path.join(appRoot, "out", "nls.messages.json"), "utf8"));
const vsCode = messages.filter((m) => /\bVisual Studio Code\b|\bVS ?Code\b/.test(m) && !/VS Code for the Web|(Stable|Insiders)( version of)? VS Code|VS Code (Stable|Insiders)|VS Code marketplace/i.test(m));
check('UI messages say "Synapse", not "VS Code"', vsCode.length === 0, vsCode.slice(0, 3).join(" | "));

// 2. A small git repository to open.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-smoke-"));
const repo = path.join(tmp, "repo");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.writeFileSync(path.join(repo, "src", "pricing.ts"), "export function applyDiscount(total: number, percent: number): number {\n  return total - (total * percent) / 100;\n}\n");
const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
git("init", "-q", "-b", "main");
git("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "add", "-A");
git("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-qm", "init");

// 3. Launch.
const app = await electron.launch({
  executablePath: executable(),
  args: [
    repo,
    `--user-data-dir=${path.join(tmp, "user")}`,
    `--extensions-dir=${path.join(tmp, "extensions")}`,
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    "--use-inmemory-secretstorage",
    "--disable-gpu",
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
  ],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
  timeout: 120_000,
});
let failed = false;
try {
  const page = await app.firstWindow({ timeout: 120_000 });
  await page.waitForSelector(".monaco-workbench", { timeout: 120_000 });
  check("workbench opens", true);
  const title = await page.title();
  check("window title names Synapse", /Synapse/.test(title) && !/Visual Studio Code|VS Code/.test(title), title);

  // The built-in extension starts synapse-core for the open repository.
  const coreFile = path.join(repo, ".synapse", "core.json");
  const started = await waitFor(() => fs.existsSync(coreFile), 90_000);
  check("synapse-core starts for the open repository", started, started ? "" : "no .synapse/core.json");

  const synapseIcon = page.locator('.activitybar [aria-label^="Synapse"]').first();
  check("Synapse is in the activity bar", (await synapseIcon.count()) > 0);
  const copilot = await page.locator('.activitybar [aria-label*="Copilot" i], .statusbar [aria-label*="Copilot" i]').count();
  check("no Copilot in the activity bar or status bar", copilot === 0, copilot ? `${copilot} element(s)` : "");
  const copilotText = await page.getByText(/Copilot/i).count();
  check("no Copilot chat or setup anywhere in the window", copilotText === 0, copilotText ? `${copilotText} element(s)` : "");
  const usage = await page.getByText(/collects usage data/i).count();
  check("no usage-data (telemetry) notice", usage === 0);

  // The board renders (a webview: look through its frames).
  if ((await synapseIcon.count()) > 0) await synapseIcon.click();
  const board = await waitFor(async () => {
    for (const f of page.frames()) {
      if (await f.locator("text=Needs you").count().catch(() => 0)) return true;
    }
    return false;
  }, 60_000);
  check("the board renders its Overview", board);

  if (screenshot) {
    await page.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot}`);
  }
} catch (err) {
  check("app run", false, err.message.split("\n")[0]);
} finally {
  await app.close().catch(() => {});
  failed = checks.some((c) => !c.ok);
}

console.log(failed ? `\n${checks.filter((c) => !c.ok).length} check(s) failed` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
