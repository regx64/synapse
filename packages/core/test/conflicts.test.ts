import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { SynapseCore } from "../src/index.js";
import { SHOP, gitOut, makeRepo, write } from "../src/testing.js";

async function setup() {
  const repo = makeRepo(SHOP);
  const core = await SynapseCore.open({ workspace: repo, ephemeral: true });
  const a = await core.agents.add({ preset: "mock", id: "alpha", name: "Alpha" });
  const b = await core.agents.add({ preset: "mock", id: "beta", name: "Beta" });
  return { repo, core, a, b };
}

test("each agent gets its own worktree and branch, ignored by the main checkout", async () => {
  const { repo, core, a, b } = await setup();
  try {
    assert.equal(a.worktree.branch, "synapse/alpha");
    assert.ok(fs.existsSync(path.join(a.worktree.path, "src/pricing.ts")));
    assert.notEqual(a.worktree.path, b.worktree.path);
    assert.equal(gitOut(repo, "status", "--porcelain"), "", "main checkout stays clean");
    await core.agents.remove("alpha");
    assert.ok(!fs.existsSync(a.worktree.path));
    assert.ok(!gitOut(repo, "branch", "--list").includes("synapse/alpha"));
  } finally {
    await core.close();
  }
});

test("ownership is tracked per symbol, including uncommitted and untracked files", async () => {
  const { core, a } = await setup();
  try {
    write(a.worktree.path, "src/cart.ts", SHOP["src/cart.ts"].replace("this.items.push(price);", "if (price > 0) this.items.push(price);"));
    write(a.worktree.path, "src/tax.ts", "export function tax(v: number) { return v * 0.1; }\n");
    const [own] = await core.refreshOwnership("alpha");
    const cart = own!.files.find((f) => f.path === "src/cart.ts")!;
    assert.deepEqual(cart.symbols.map((s) => [s.name, s.change]), [["Cart.add", "modified"]]);
    const tax = own!.files.find((f) => f.path === "src/tax.ts")!;
    assert.equal(tax.status, "added");
    assert.deepEqual(tax.symbols.map((s) => s.name), ["tax"]);
    assert.ok(own!.snapshot);
  } finally {
    await core.close();
  }
});

test("signature change plus a new caller in another worktree is flagged before merge", async () => {
  const { core, a, b } = await setup();
  try {
    // Alpha adds a parameter to applyDiscount and updates the existing caller.
    write(a.worktree.path, "src/pricing.ts", SHOP["src/pricing.ts"].replace(
      "export function applyDiscount(total: number, percent: number): number {\n  return total - (total * percent) / 100;",
      "export function applyDiscount(total: number, percent: number, cap: number): number {\n  return total - Math.min((total * percent) / 100, cap);",
    ));
    write(a.worktree.path, "src/cart.ts", SHOP["src/cart.ts"].replace("applyDiscount(this.total(), percent)", "applyDiscount(this.total(), percent, 50)"));
    // Beta, unaware, adds a new caller using the old signature in a new file.
    write(b.worktree.path, "src/checkout.ts", `import { applyDiscount } from "./pricing";\n\nexport function checkout(total: number): number {\n  return applyDiscount(total, 10);\n}\n`);

    await core.refreshOwnership();
    const conflicts = core.store.getConflicts();
    const sig = conflicts.find((c) => c.kind === "signature-change");
    assert.ok(sig, `expected a signature-change conflict, got ${JSON.stringify(conflicts.map((c) => c.kind))}`);
    assert.equal(sig.symbol, "applyDiscount");
    assert.deepEqual(sig.agents, ["alpha", "beta"]);
    assert.equal(sig.signature?.owner, "alpha");
    assert.equal(sig.callSites?.[0]?.path, "src/checkout.ts");
    assert.equal(sig.callSites?.[0]?.line, 3);
    // The textual merge is clean, which is exactly why this check matters.
    assert.ok(!conflicts.some((c) => c.kind === "text-conflict"));
  } finally {
    await core.close();
  }
});

test("same symbol edited by two agents, and textual conflicts, are flagged", async () => {
  const { core, a, b } = await setup();
  try {
    write(a.worktree.path, "src/pricing.ts", SHOP["src/pricing.ts"].replace('"$"', '"USD "'));
    write(b.worktree.path, "src/pricing.ts", SHOP["src/pricing.ts"].replace('"$"', '"€"'));
    await core.refreshOwnership();
    const kinds = core.store.getConflicts().map((c) => `${c.kind}:${c.symbol ?? c.path}`);
    assert.ok(kinds.includes("same-symbol:formatPrice"), kinds.join(","));
    assert.ok(kinds.includes("text-conflict:src/pricing.ts"), kinds.join(","));
  } finally {
    await core.close();
  }
});

test("different symbols in one file are informational only; ids are stable", async () => {
  const { core, a, b } = await setup();
  try {
    write(a.worktree.path, "src/cart.ts", SHOP["src/cart.ts"].replace("this.items.push(price);", "this.items.push(Math.max(0, price));"));
    write(b.worktree.path, "src/cart.ts", SHOP["src/cart.ts"].replace("(a, b) => a + b, 0", "(sum, x) => sum + x, 0"));
    await core.refreshOwnership();
    const first = core.store.getConflicts();
    assert.deepEqual(first.map((c) => [c.kind, c.severity]), [["same-file", "info"]]);
    await core.refreshOwnership();
    assert.equal(core.store.getConflicts()[0]!.id, first[0]!.id);
  } finally {
    await core.close();
  }
});

test("markers for a file in the main checkout map agent symbols onto its ranges", async () => {
  const { repo, core, a } = await setup();
  try {
    write(a.worktree.path, "src/cart.ts", SHOP["src/cart.ts"].replace("this.items.push(price);", "this.items.push(Math.max(0, price));"));
    await core.refreshOwnership("alpha");
    const markers = await core.ownership.markersFor(path.join(repo, "src/cart.ts"));
    assert.equal(markers.length, 1);
    assert.equal(markers[0]!.symbol, "Cart.add");
    assert.equal(markers[0]!.agentId, "alpha");
    assert.equal(markers[0]!.range?.startLine, 5);
    // Viewing alpha's own worktree file shows no markers for alpha itself.
    assert.equal((await core.ownership.markersFor(path.join(a.worktree.path, "src/cart.ts"))).length, 0);
  } finally {
    await core.close();
  }
});

test("a new call that already matches the new signature is not a conflict", async () => {
  const { core, a, b } = await setup();
  try {
    write(a.worktree.path, "src/pricing.ts", SHOP["src/pricing.ts"].replace("percent: number): number", "percent: number, cap: number): number"));
    write(b.worktree.path, "src/checkout.ts", `import { applyDiscount } from "./pricing";\nexport const checkout = (t: number) => applyDiscount(t, 10, 50);\n`);
    await core.refreshOwnership();
    assert.ok(!core.store.getConflicts().some((c) => c.kind === "signature-change"));
    // Removing the function breaks every caller regardless of arity.
    write(a.worktree.path, "src/pricing.ts", SHOP["src/pricing.ts"].replace(/export function applyDiscount[\s\S]*?\n}\n/, ""));
    await core.refreshOwnership();
    assert.ok(core.store.getConflicts().some((c) => c.kind === "signature-change" && c.message.includes("removed")));
  } finally {
    await core.close();
  }
});

test("markers resolve non-canonical paths (symlinks here; 8.3 short names on Windows)", async () => {
  const { repo, core, a } = await setup();
  try {
    write(a.worktree.path, "src/cart.ts", SHOP["src/cart.ts"].replace("this.items.push(price);", "this.items.push(Math.max(0, price));"));
    await core.refreshOwnership("alpha");
    const link = `${repo}-link`;
    fs.symlinkSync(repo, link, "dir");
    const markers = await core.ownership.markersFor(path.join(link, "src/cart.ts"));
    assert.equal(markers.length, 1);
    assert.equal(markers[0]!.symbol, "Cart.add");
    // Inside an agent's worktree, through the link: viewer is that agent, so no markers for itself.
    assert.equal((await core.ownership.markersFor(path.join(link, ".synapse/worktrees/alpha/src/cart.ts"))).length, 0);
    assert.equal(core.agents.evaluate("alpha", { toolKind: "edit", path: path.join(link, ".synapse/worktrees/alpha/.env") }).decision, "deny");
  } finally {
    await core.close();
  }
});

test("call matching follows imports: aliases count, unrelated same-name functions do not", async () => {
  const { core, a, b } = await setup();
  try {
    write(a.worktree.path, "src/pricing.ts", SHOP["src/pricing.ts"].replace("percent: number): number", "percent: number, cap: number): number"));
    // Not the changed function: imported from another module, and defined locally.
    write(b.worktree.path, "src/legacy.ts", `import { applyDiscount } from "./old-pricing";\nexport const legacy = (t: number) => applyDiscount(t, 5);\n`);
    write(b.worktree.path, "src/local.ts", `import { formatPrice } from "./pricing";\nfunction applyDiscount(t: number, p: number) { return t - p; }\nexport const local = (t: number) => formatPrice(applyDiscount(t, 5));\n`);
    await core.refreshOwnership();
    assert.ok(!core.store.getConflicts().some((c) => c.kind === "signature-change"), JSON.stringify(core.store.getConflicts()));

    // The changed function under an alias, imported with the .js extension TypeScript ESM uses.
    write(b.worktree.path, "src/checkout.ts", `import { applyDiscount as discount } from "./pricing.js";\nexport const checkout = (t: number) => discount(t, 10);\n`);
    await core.refreshOwnership();
    const sig = core.store.getConflicts().find((c) => c.kind === "signature-change");
    assert.ok(sig, "aliased import is matched");
    assert.deepEqual(sig.callSites?.map((s) => s.path), ["src/checkout.ts"]);
  } finally {
    await core.close();
  }
});
