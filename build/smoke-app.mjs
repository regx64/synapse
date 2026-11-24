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
// The Korean language pack ships, is indexed for the editor (patch 0004), and says Synapse too.
const packsFile = path.join(appRoot, "out", "synapse-languagepacks.json");
const packs = fs.existsSync(packsFile) ? JSON.parse(fs.readFileSync(packsFile, "utf8")) : {};
const koMain = packs.ko?.translations?.vscode ? path.join(appRoot, "out", packs.ko.translations.vscode) : "";
check("Korean language pack is built in", !!koMain && fs.existsSync(koMain), koMain ? "" : "no out/synapse-languagepacks.json entry");
if (koMain && fs.existsSync(koMain)) {
  const ko = [];
  const walk = (o) => Object.values(o).forEach((v) => (typeof v === "string" ? ko.push(v) : v && typeof v === "object" && walk(v)));
  walk(JSON.parse(fs.readFileSync(koMain, "utf8")));
  const left = ko.filter((m) => /\bVisual Studio Code\b|\bVS ?Code\b/.test(m) && !/(Visual Studio Code|VS ?Code)\s*마켓플레이스|웹용 VS ?Code|VS ?Code\s*(Insiders|참가자|안정)|VS Code for the Web|marketplace/i.test(m));
  check('Korean messages say "Synapse", not "VS Code"', left.length === 0, left.slice(0, 2).join(" | "));
}

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
  const appName = await app.evaluate(({ app: electronApp }) => electronApp.getName());
  check("the app calls itself Synapse", appName === product.nameShort, appName);
  // macOS window titles show only the folder, never the app name.
  const windowTitle = await page.title();
  const titleOk = !/Visual Studio Code|VS Code/.test(windowTitle) && (process.platform === "darwin" || windowTitle.includes(product.nameShort));
  check("window title", titleOk, windowTitle);

  // The built-in extension starts synapse-core for the open repository.
  const coreFile = path.join(repo, ".synapse", "core.json");
  const started = await waitFor(() => fs.existsSync(coreFile), 90_000);
  check("synapse-core starts for the open repository", started, started ? "" : "no .synapse/core.json");

  // The new layout: agents on the left, home tab in the middle, agent detail on the right.
  const frameWith = (text) =>
    waitFor(async () => {
      for (const f of page.frames()) if (await f.getByText(text).count().catch(() => 0)) return true;
      return false;
    }, 60_000);
  check("the agents list is in the side bar", await frameWith(/^(New agent|새 에이전트)$/));
  check("the home tab renders its overview", await frameWith(/^(Needs you|확인 필요)$/));
  const homeTab = await page.locator('.tabs-container .tab[aria-label*="Home"], .tabs-container .tab[aria-label*="홈"]').count();
  check("the home tab is an editor tab", homeTab > 0);
  check("the agent column is open", await frameWith(/No agents yet\. Add one|아직 에이전트가 없습니다\. 에이전트를 추가하면/));
  const copilot = await page.locator('.activitybar [aria-label*="Copilot" i], .statusbar [aria-label*="Copilot" i], .titlebar [aria-label*="Copilot" i]').count();
  check("no Copilot in the activity bar, status bar or title bar", copilot === 0, copilot ? `${copilot} element(s)` : "");
  const copilotText = await page.getByText(/Copilot/i).count();
  check("no Copilot chat or setup anywhere in the window", copilotText === 0, copilotText ? `${copilotText} element(s)` : "");
  const usage = await page.getByText(/collects usage data/i).count();
  check("no usage-data (telemetry) notice", usage === 0);

  // Patch 0003: agent status in the title bar, the Synapse font; and the Synapse Dark theme.
  const title = await waitFor(async () => (await page.locator(".synapse-title-status").textContent().catch(() => "")) || "", 30_000).then(() => page.locator(".synapse-title-status").textContent().catch(() => ""));
  check("agent status in the title bar", /Working|작업 중/.test(title ?? ""), title ?? "");
  const look = await page.evaluate(() => {
    const wb = document.querySelector(".monaco-workbench");
    const css = wb ? getComputedStyle(wb) : undefined;
    return { font: css?.fontFamily ?? "", card: css?.getPropertyValue("--vscode-synapse-cardBackground").trim() ?? "", pretendard: document.fonts.check('12px "Pretendard"') };
  });
  check("the workbench uses Pretendard", /^"?Pretendard/.test(look.font), look.font);
  check("Synapse Dark is the theme", look.card.toLowerCase() === "#141417", look.card);
  await page.waitForTimeout(1500); // let the views finish rendering for the screenshot

  if (screenshot) {
    await page.screenshot({ path: screenshot });
    console.log(`screenshot: ${screenshot}`);
  }
} catch (err) {
  check("app run", false, err.message.split("\n")[0]);
} finally {
  const pid = app.process().pid;
  await app.close().catch(() => {});
  // Electron's helper processes can outlive close() on Windows and keep the
  // build folder locked; end the whole process tree.
  if (process.platform === "win32" && pid) {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // already gone
    }
  }
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
