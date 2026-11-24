import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { SynapseCore } from "../src/index.js";
import { SHOP, gitOut, makeRepo, write } from "../src/testing.js";

const DISCOUNT = "export function applyDiscount(total: number, percent: number): number {\n  return total - (total * percent) / 100;";

async function setup() {
  const repo = makeRepo(SHOP);
  const core = await SynapseCore.open({ workspace: repo, ephemeral: true });
  const h = core.handlers();
  const d = await h["decisions.add"]({ title: "Discounts", decision: "Discounts never exceed the order total", pins: [{ path: "src/pricing.ts", symbol: "applyDiscount" }] });
  return { repo, core, h, d };
}

/** Commits a change on the base branch in the person's checkout. */
function commitOnBase(repo: string, rel: string, content: string) {
  write(repo, rel, content);
  gitOut(repo, "commit", "-qam", `edit ${rel}`);
}

test("a decision pinned to a symbol is fingerprinted on the base branch", async () => {
  const { core, d } = await setup();
  try {
    assert.equal(d.anchors?.length, 1);
    assert.deepEqual({ path: d.anchors![0]!.path, symbol: d.anchors![0]!.symbol, state: d.anchors![0]!.state }, { path: "src/pricing.ts", symbol: "applyDiscount", state: "current" });
    assert.match(d.anchors![0]!.fingerprint, /^[0-9a-f]{16}$/);
  } finally {
    await core.close();
  }
});

test("pins are validated: unknown symbols and paths outside the repository are refused", async () => {
  const { core, h, d } = await setup();
  try {
    await assert.rejects(async () => h["decisions.pin"]({ id: d.id, path: "src/pricing.ts", symbol: "nope" }), /No symbol "nope"/);
    await assert.rejects(async () => h["decisions.pin"]({ id: d.id, path: "../outside.ts" }), /repository-relative/);
    await assert.rejects(async () => h["decisions.pin"]({ id: d.id, path: "src/missing.ts" }), /not on the base branch/);
  } finally {
    await core.close();
  }
});

test("pinning by line picks the innermost symbol at that line", async () => {
  const { core, h, d } = await setup();
  try {
    // Line 6 (0-based) of src/cart.ts is inside Cart.add.
    const next = await h["decisions.pin"]({ id: d.id, path: "src/cart.ts", line: 6 });
    assert.deepEqual(next.anchors!.map((a) => a.symbol), ["applyDiscount", "Cart.add"]);
    const again = await h["decisions.pin"]({ id: d.id, path: "src/cart.ts", symbol: "Cart.add" });
    assert.equal(again.anchors!.length, 2, "pinning twice is a no-op");
    const fewer = await h["decisions.unpin"]({ id: d.id, path: "src/cart.ts", symbol: "Cart.add" });
    assert.equal(fewer.anchors!.length, 1);
  } finally {
    await core.close();
  }
});

test("an agent changing pinned code raises a decision conflict before merge", async () => {
  const { core, h, d } = await setup();
  try {
    const a = await core.agents.add({ preset: "mock", id: "alpha", name: "Alpha" });
    write(a.worktree.path, "src/pricing.ts", SHOP["src/pricing.ts"].replace("return total - (total * percent) / 100;", "return total * (1 - percent / 100);"));
    await core.refreshOwnership("alpha");
    const c = core.store.getConflicts().find((x) => x.kind === "decision");
    assert.ok(c, "decision conflict");
    assert.equal(c.decisionId, d.id);
    assert.deepEqual(c.agents, ["alpha"]);
    assert.equal(c.severity, "warning");
    assert.match(c.message, /Alpha is changing applyDiscount, which decision D-1 \("Discounts"\) is pinned to/);

    // Editing another symbol of the same file does not touch the decision.
    write(a.worktree.path, "src/pricing.ts", SHOP["src/pricing.ts"].replace('"$" + value', '"USD " + value'));
    await core.refreshOwnership("alpha");
    assert.ok(!core.store.getConflicts().some((x) => x.kind === "decision"));

    // Only accepted decisions count.
    write(a.worktree.path, "src/pricing.ts", SHOP["src/pricing.ts"].replace("/ 100;", "/ 100.0;"));
    h["decisions.resolve"]({ id: d.id, status: "rejected" });
    await core.refreshOwnership("alpha");
    assert.ok(!core.store.getConflicts().some((x) => x.kind === "decision"));
  } finally {
    await core.close();
  }
});

test("when pinned code changes on the base branch the decision is flagged until the person re-pins it", async () => {
  const { repo, core, h, d } = await setup();
  try {
    // Reformatting only: still current.
    commitOnBase(repo, "src/pricing.ts", SHOP["src/pricing.ts"].replace(DISCOUNT, DISCOUNT.replace("{\n  return", "{\n\n      return")));
    await core.checkConflicts();
    assert.equal(core.store.getDecision(d.id)!.anchors![0]!.state, "current");

    // A real change: flagged, in state and in the Markdown log.
    commitOnBase(repo, "src/pricing.ts", SHOP["src/pricing.ts"].replace("return total - (total * percent) / 100;", "return Math.max(0, total - (total * percent) / 100);"));
    await core.checkConflicts();
    assert.equal(core.store.getDecision(d.id)!.anchors![0]!.state, "changed");
    const log = fs.readFileSync(path.join(repo, ".synapse", "decisions.md"), "utf8");
    assert.match(log, /`src\/pricing.ts` › `applyDiscount` \(code changed since pinned/);

    // The person confirms it still holds.
    const confirmed = await h["decisions.repin"]({ id: d.id });
    assert.equal(confirmed.anchors![0]!.state, "current");
    assert.notEqual(confirmed.anchors![0]!.fingerprint, d.anchors![0]!.fingerprint);

    // Removing the symbol: missing.
    commitOnBase(repo, "src/pricing.ts", 'export function formatPrice(value: number): string {\n  return "$" + value.toFixed(2);\n}\n');
    await core.checkConflicts();
    assert.equal(core.store.getDecision(d.id)!.anchors![0]!.state, "missing");
    await assert.rejects(async () => h["decisions.repin"]({ id: d.id }), /Unpin it/);
  } finally {
    await core.close();
  }
});

test("agents see where an accepted decision applies in their task prompts", async () => {
  const { core } = await setup();
  try {
    await core.agents.add({ preset: "mock", id: "alpha" });
    const prompt = core.collab.composePrompt("alpha", "Do the task", true);
    assert.match(prompt, /D-1: Discounts: Discounts never exceed the order total \[applies to: src\/pricing.ts › applyDiscount\]/);
  } finally {
    await core.close();
  }
});
