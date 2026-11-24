#!/usr/bin/env node
// Screenshots of the Synapse UI with demo data: four scripted agents (one
// working, one waiting for approval, one finished, one about to conflict),
// tasks and a decision. No API keys; agents are the mock agent.
//
//   node build/ui-shots.mjs --exe <editor executable> --out <dir> [--locale en|ko] [--dev-extension <path>]
//
// --exe is a built Synapse app's executable, or a stock editor with
// --dev-extension pointing at extensions/synapse-collab (for local checks).
// Run `npm run build` first (the demo drives the core through @synapse/client).
// On Linux without a display: xvfb-run -a node build/ui-shots.mjs …
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron } from "playwright-core";
import { ROOT } from "./lib.mjs";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const exe = arg("exe");
const out = path.resolve(arg("out", "ui-shots"));
const locale = arg("locale", "en");
const devExtension = arg("dev-extension");
if (!exe || !fs.existsSync(exe)) {
  console.error("usage: node build/ui-shots.mjs --exe <editor executable> --out <dir> [--locale en|ko] [--dev-extension <path>]");
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const { SynapseClient } = await import(path.join(ROOT, "packages", "client", "dist", "src", "index.js"));

// 1. A small shop repository.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-shots-")));
const repo = path.join(tmp, "shop-api");
const files = {
  "src/pricing.ts": "export function applyDiscount(total: number, percent: number): number {\n  return total - (total * percent) / 100;\n}\n",
  "src/cart.ts":
    'import { applyDiscount } from "./pricing";\n\nexport class Cart {\n  items: { price: number; qty: number }[] = [];\n\n  total(): number {\n    return this.items.reduce((s, i) => s + i.price * i.qty, 0);\n  }\n\n  withDiscount(percent: number): number {\n    return applyDiscount(this.total(), percent);\n  }\n}\n',
  "src/tax.ts": "export const rate = 0.1;\n",
  "package.json": JSON.stringify({ name: "shop-api", private: true, scripts: { test: "node -e 1" } }, null, 2) + "\n",
  "synapse.config.json": JSON.stringify({ testCommand: "node -e \"console.log('tests passed')\"" }, null, 2) + "\n",
};
const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
fs.mkdirSync(repo, { recursive: true });
git("init", "-q", "-b", "main");
git("config", "user.email", "demo@synapse.invalid");
git("config", "user.name", "demo");
for (const [p, c] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
  fs.writeFileSync(path.join(repo, p), c);
}
git("add", "-A");
git("commit", "-qm", "initial");

// 2. Launch the editor.
// --user-data / --extensions reuse folders prepared beforehand (e.g. with a language pack installed).
const userData = path.resolve(arg("user-data", path.join(tmp, "user")));
const extensionsDir = path.resolve(arg("extensions", path.join(tmp, "extensions")));
fs.mkdirSync(path.join(userData, "User"), { recursive: true });
fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({ "workbench.tips.enabled": false, "security.workspace.trust.enabled": false }));
const app = await electron.launch({
  executablePath: exe,
  args: [
    repo,
    `--user-data-dir=${userData}`,
    `--extensions-dir=${extensionsDir}`,
    `--locale=${locale}`,
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    "--use-inmemory-secretstorage",
    "--disable-gpu",
    ...(devExtension ? [`--extensionDevelopmentPath=${path.resolve(devExtension)}`] : []),
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
  ],
  timeout: 120_000,
});
const shots = [];
let client;
try {
  const page = await app.firstWindow({ timeout: 120_000 });
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.unmaximize();
    w.setSize(1440, 900);
  });
  await page.waitForSelector(".monaco-workbench", { timeout: 120_000 });
  const discovery = path.join(repo, ".synapse", "core.json");
  await waitFor(() => fs.existsSync(discovery), 90_000, "synapse-core");
  client = await SynapseClient.connect({ workspace: repo, clientName: "ui-shots" });

  // 3. Demo agents, each playing a script.
  const mock = (await client.call("agents.presets")).find((p) => p.id === "mock");
  const script = (id, turns) => {
    const f = path.join(tmp, `${id}.json`);
    fs.writeFileSync(f, JSON.stringify({ turns: turns.map((steps) => ({ steps })) }));
    return [...mock.args, "--script", f];
  };
  /** Plan entries: the first `done` completed, the next one in progress. */
  const plan = (items, done) => items.map((content, i) => ({ content, status: i < done ? "completed" : i === done ? "in_progress" : "pending" }));
  const pricingCap = { edit: { path: "src/pricing.ts", find: "percent: number): number {\n  return total - (total * percent) / 100;", replace: "percent: number, cap: number): number {\n  const off = Math.min((total * percent) / 100, cap);\n  return total - off;" } };
  const agents = [
    ["alpha", "Alpha", [[
      { plan: plan(["Read pricing.ts and cart.ts", "Add a cap parameter to applyDiscount", "Run the tests", "Update Cart.withDiscount", "Check the other callers"], 3) },
      { say: "I'll add a cap parameter to applyDiscount, then update the caller in cart.ts." },
      pricingCap,
      { edit: { path: "src/cart.ts", find: "applyDiscount(this.total(), percent)", replace: "applyDiscount(this.total(), percent, 50)" } },
      { say: "Updating Cart.withDiscount to pass a cap of 50" },
      { sleep: 600000 },
    ]]],
    ["beta", "Beta", [[
      { plan: plan(["Create src/validate.ts", "Install zod", "Write the schema", "Add tests"], 1) },
      { say: "I'll describe the input with a zod schema. zod isn't installed yet." },
      { write: { path: "src/validate.ts", content: "export function validQuantity(q: number): boolean {\n  return Number.isInteger(q) && q > 0;\n}\n" } },
      { run: { command: "npm install zod", title: "npm install zod" } },
      { sleep: 600000 },
    ]]],
    ["gamma", "Gamma", [[
      { plan: plan(["Find every amount", "Add a Money type", "Convert the callers", "Run the tests"], 4) },
      { write: { path: "src/money.ts", content: "export type Cents = number;\n\nexport const toCents = (amount: number): Cents => Math.round(amount * 100);\n" } },
      { say: "Done. Prices are stored as integer cents and all tests pass." },
    ]]],
    ["delta", "Delta", [[
      { plan: plan(["Read checkout and tax", "Add tax to the total", "Show the tax line", "Run the tests"], 2) },
      { write: { path: "src/checkout.ts", content: 'import { applyDiscount } from "./pricing";\nimport { rate } from "./tax";\n\nexport function checkout(total: number): number {\n  const discounted = applyDiscount(total, 10);\n  return discounted * (1 + rate);\n}\n' } },
      { say: "Adding the tax line to checkout()" },
      { sleep: 600000 },
    ]]],
  ];
  const titles = { alpha: "Add a discount cap", beta: "Validate checkout input", gamma: "Store amounts as integer cents", delta: "Show tax at checkout" };
  for (const [id, name, turns] of agents) {
    await client.call("agents.add", { preset: "mock", id, name, args: script(id, turns), start: true });
    const t = await client.call("tasks.create", { title: titles[id], description: "", agentId: id });
    await client.call("tasks.start", { id: t.id });
  }
  await client.call("tasks.create", { title: "Rate-limit the coupon endpoint" });
  await client.call("decisions.add", { title: "Money representation", decision: "Store amounts as integer cents", rationale: "Floats round badly" });
  await waitFor(async () => {
    const s = await client.call("state.get");
    const by = (id) => s.agents.find((a) => a.id === id);
    return by("beta")?.status === "awaiting-approval" && s.tasks.some((t) => t.agentId === "gamma" && t.status === "review") && by("alpha")?.status === "working";
  }, 60_000, "demo state");
  await client.call("ownership.refresh", {});
  await waitFor(async () => (await client.call("conflicts.check")).some((c) => c.kind === "signature-change"), 30_000, "conflict");
  await page.waitForTimeout(2500);

  // 4. Screenshots.
  const shot = async (name) => {
    const file = path.join(out, `${name}-${locale}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
    console.log(`screenshot: ${file}`);
  };
  await shot("home");
  // Live changes of Alpha, from the conflict card on the home tab.
  const home = await findFrame(page, "text=Open live changes|text=실시간 변경 열기");
  if (home) {
    await home.locator("button", { hasText: /Open live changes|실시간 변경 열기/ }).first().click();
    await page.waitForTimeout(2500);
    await shot("live-changes");
    const live = await findFrame(page, "text=Unified|text=통합");
    if (live) {
      await live.locator("button", { hasText: /^(Split|양옆 비교)$/ }).first().click();
      await page.waitForTimeout(800);
      await shot("live-split");
    }
  }
} finally {
  await client?.call("core.shutdown").catch(() => {});
  client?.close();
  await app.close().catch(() => {});
}
console.log(`${shots.length} screenshot(s) in ${out}`);

async function findFrame(page, selector) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    for (const f of page.frames()) {
      for (const s of selector.split("|")) if (await f.locator(s).count().catch(() => 0)) return f;
    }
    await page.waitForTimeout(300);
  }
  return undefined;
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}`);
}
