#!/usr/bin/env node
// A two-agent demo with no API keys: creates a throwaway repository, starts
// synapse-core, and plays the "signature change plus new caller" scenario
// with two scripted agents. Run `npm run build` first.
//   npm run demo [-- --keep]
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { SynapseClient } from "@synapse/client";

const require = createRequire(import.meta.url);
const keep = process.argv.includes("--keep");
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-demo-")));
const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
const files = {
  "src/pricing.ts": "export function applyDiscount(total: number, percent: number): number {\n  return total - (total * percent) / 100;\n}\n",
  "src/cart.ts": 'import { applyDiscount } from "./pricing";\n\nexport function cartTotal(items: number[], percent: number): number {\n  return applyDiscount(items.reduce((a, b) => a + b, 0), percent);\n}\n',
  "synapse.config.json": JSON.stringify({ testCommand: "node -e \"console.log('tests passed')\"" }, null, 2),
};
git("init", "-q", "-b", "main");
git("config", "user.email", "demo@synapse.invalid");
git("config", "user.name", "Synapse demo");
for (const [p, c] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
  fs.writeFileSync(path.join(repo, p), c);
}
git("add", "-A");
git("commit", "-q", "-m", "initial");

const say = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const steps = (...s) => JSON.stringify({ steps: s });
const client = await SynapseClient.connectOrStart({ workspace: repo, coreMain: require.resolve("@synapse/core/main"), clientName: "demo" });
const wait = async (id) => {
  for (;;) {
    const a = (await client.call("agents.list")).find((x) => x.id === id);
    if (a?.status === "idle" && a.turn?.endedAt) return a;
    await new Promise((r) => setTimeout(r, 100));
  }
};

try {
  say(`Repository: ${repo}`);
  say("1. Two agents, each in its own git worktree");
  for (const [id, name] of [["claude", "Claude (mock)"], ["codex", "Codex (mock)"]]) {
    const a = await client.call("agents.add", { preset: "mock", id, name, start: true });
    console.log(`   ${a.name}: ${a.worktree.branch} at ${path.relative(repo, a.worktree.path)}`);
  }

  say("2. Claude adds a `cap` parameter to applyDiscount and updates the caller it knows about");
  await client.call("agents.prompt", {
    id: "claude",
    text: steps(
      { edit: { path: "src/pricing.ts", find: "percent: number): number", replace: "percent: number, cap: number): number" } },
      { edit: { path: "src/cart.ts", find: "0), percent)", replace: "0), percent, 100)" } },
    ),
  });
  await wait("claude");

  say("3. Meanwhile Codex writes a new checkout using the old signature");
  await client.call("agents.prompt", {
    id: "codex",
    text: steps({ write: { path: "src/checkout.ts", content: 'import { applyDiscount } from "./pricing";\n\nexport const checkout = (total: number) => applyDiscount(total, 10);\n' } }),
  });
  await wait("codex");

  say("4. Ownership, down to the symbol");
  for (const o of await client.call("ownership.refresh", {})) {
    for (const f of o.files) console.log(`   ${o.agentId.padEnd(7)} ${f.path.padEnd(16)} ${f.symbols.map((s) => `${s.name} (${s.change}${s.signatureChanged ? ", signature" : ""})`).join(", ")}`);
  }

  say("5. Conflicts, flagged before anything is merged");
  const conflicts = await client.call("conflicts.check");
  for (const c of conflicts) console.log(`   [${c.severity}] ${c.message}`);
  console.log("   (git would merge these branches cleanly, and the build would break)");

  say("6. Codex fixes its call; the combined review merges, tests, and lands both");
  await client.call("agents.prompt", { id: "codex", text: steps({ edit: { path: "src/checkout.ts", find: "(total, 10)", replace: "(total, 10, 100)" } }) });
  await wait("codex");
  const review = await client.call("review.prepare", {});
  console.log(`   review ${review.status}; ${review.files.length} files; tests ${review.tests?.passed ? "passed" : "failed"}; conflicts left: ${review.conflicts.filter((c) => c.severity === "error").length}`);
  const merged = await client.call("review.merge", { id: review.id, resetAgents: true });
  console.log(`   ${merged.status} into ${merged.baseRef}:`);
  console.log(execFileSync("git", ["log", "--oneline", "--graph", "-6"], { cwd: repo, encoding: "utf8" }).replace(/^/gm, "   "));
} finally {
  await client.call("core.shutdown").catch(() => {});
  client.close();
  if (!keep) fs.rmSync(repo, { recursive: true, force: true });
  else console.log(`kept ${repo}`);
}
