import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff, locateQuote } from "../src/comments.js";
import { SynapseCore } from "../src/index.js";
import { SHOP, makeRepo, waitFor, write } from "../src/testing.js";

const TAX = "export const rate = 0.1;\n\nexport function tax(v: number): number {\n  return v * rate;\n}\n";

test("unified diffs parse into files, hunks and line numbers", () => {
  const files = parseUnifiedDiff(
    [
      "diff --git a/a.ts b/a.ts",
      "index 1..2 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,3 @@ function f() {",
      " one",
      "-two",
      "+TWO",
      " three",
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1 @@",
      "+hello",
      "\\ No newline at end of file",
      "diff --git a/old.bin b/old.bin",
      "deleted file mode 100644",
      "Binary files a/old.bin and /dev/null differ",
    ].join("\n"),
  );
  assert.deepEqual(files.map((f) => [f.path, f.status, f.binary]), [["a.ts", "modified", false], ["new.ts", "added", false], ["old.bin", "deleted", true]]);
  assert.equal(files[0]!.hunks[0]!.header, "function f() {");
  assert.deepEqual(files[0]!.hunks[0]!.lines.map((l) => [l.t, l.oldNo, l.newNo]), [[" ", 1, 1], ["-", 2, undefined], ["+", undefined, 2], [" ", 3, 3]]);
  assert.deepEqual(files[1]!.hunks[0]!.lines, [{ t: "+", text: "hello", newNo: 1 }]);
});

test("a quote is found again nearest to where it was", () => {
  const content = "a\nx\ny\nb\nx\ny\n";
  assert.deepEqual(locateQuote(content, "x\ny", 5), { line: 5, endLine: 6 });
  assert.deepEqual(locateQuote(content, "x\ny", 1), { line: 2, endLine: 3 });
  assert.equal(locateQuote(content, "z", 1), undefined);
});

async function setup() {
  const core = await SynapseCore.open({ workspace: makeRepo(SHOP), ephemeral: true });
  const a = await core.agents.add({ preset: "mock", id: "alpha", name: "Alpha", start: true });
  write(a.worktree.path, "src/tax.ts", TAX);
  write(a.worktree.path, "src/pricing.ts", SHOP["src/pricing.ts"].replace("/ 100;", "/ 100.0;"));
  return { core, a, h: core.handlers() };
}

test("an agent's live diff lists its files and hunks against its base", async () => {
  const { core, h } = await setup();
  try {
    const d = await h["agents.diff"]({ id: "alpha" });
    assert.deepEqual(d.files.map((f) => [f.path, f.status]).sort(), [["src/pricing.ts", "modified"], ["src/tax.ts", "added"]]);
    const pricing = d.files.find((f) => f.path === "src/pricing.ts")!;
    assert.ok(pricing.hunks[0]!.lines.some((l) => l.t === "+" && l.text.includes("/ 100.0;") && l.newNo === 2));
    const one = await h["agents.diff"]({ id: "alpha", path: "src/tax.ts" });
    assert.deepEqual(one.files.map((f) => f.path), ["src/tax.ts"]);
  } finally {
    await core.close();
  }
});

test("a comment follows its code as the agent edits, and becomes outdated when the code is gone", async () => {
  const { core, a, h } = await setup();
  try {
    const c = await h["comments.add"]({ agentId: "alpha", path: "src/tax.ts", line: 3, endLine: 5, text: "Round to cents" });
    assert.equal(c.quote, "export function tax(v: number): number {\n  return v * rate;\n}");
    assert.equal(c.action, "note");
    write(a.worktree.path, "src/tax.ts", "// Tax helpers\n// (rates in percent)\n" + TAX);
    await core.refreshOwnership("alpha");
    const moved = core.store.getComment(c.id)!;
    assert.deepEqual([moved.line, moved.endLine, moved.outdated], [5, 7, undefined]);
    write(a.worktree.path, "src/tax.ts", "export const rate = 0.1;\n");
    await core.refreshOwnership("alpha");
    assert.equal(core.store.getComment(c.id)!.outdated, true);
    assert.equal((await h["comments.resolve"]({ id: c.id })).status, "resolved");
    await assert.rejects(async () => h["comments.add"]({ agentId: "alpha", path: "src/tax.ts", line: 9, text: "x" }), /has \d+ lines/);
    await assert.rejects(async () => h["comments.add"]({ agentId: "alpha", path: "src/tax.ts", line: 1, text: " " }), /needs some text/);
  } finally {
    await core.close();
  }
});

test("a comment can be given to the agent, or turned into a task for it", async () => {
  const { core, h } = await setup();
  try {
    const g = await h["comments.add"]({ agentId: "alpha", path: "src/tax.ts", line: 1, text: "Make the rate configurable", action: "guidance" });
    assert.equal(g.action, "guidance");
    const s = await waitFor(() => (core.store.getAgent("alpha")!.status === "idle" && core.store.getAgent("alpha")!.turn ? core.store.getAgent("alpha") : undefined), "guidance turn");
    assert.match(s!.turn!.prompt, /About src\/tax.ts:1: Make the rate configurable[\s\S]*export const rate = 0\.1;/);

    const t = await h["comments.add"]({ agentId: "alpha", path: "src/pricing.ts", line: 2, text: "Use integer cents here\nFloats lose precision.", action: "task" });
    const task = core.store.getTask(t.taskId!)!;
    assert.equal(task.title, "Use integer cents here");
    assert.equal(task.agentId, "alpha");
    assert.match(task.description, /src\/pricing.ts:2[\s\S]*\/ 100\.0;/);
  } finally {
    await core.close();
  }
});
