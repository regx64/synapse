import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SynapseCore } from "../src/index.js";
import { parseReview } from "../src/agent-review.js";
import { listPresets } from "../src/presets.js";
import { SHOP, makeRepo, waitFor, write } from "../src/testing.js";

const mock = listPresets({}).find((p) => p.id === "mock")!;

test("one agent reviews another's changes and its comments land on the reviewed lines", async () => {
  const core = await SynapseCore.open({ workspace: makeRepo(SHOP), ephemeral: true });
  try {
    const reply = {
      summary: "The cap can go negative.",
      comments: [
        { path: "src/pricing.ts", line: 2, severity: "blocker", text: "Clamp cap at 0." },
        { path: "src/nowhere.ts", line: 1, text: "Lost comment" },
      ],
    };
    const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-rev-")), "s.json");
    fs.writeFileSync(script, JSON.stringify({ turns: [{ steps: [{ say: "```json\n" + JSON.stringify(reply) + "\n```" }] }] }));
    const a = await core.agents.add({ preset: "mock", id: "alpha", name: "Alpha" });
    await core.agents.add({ preset: "mock", id: "rev", name: "Reviewer", args: [...mock.args, "--script", script], start: true });
    write(a.worktree.path, "src/pricing.ts", SHOP["src/pricing.ts"].replace("percent: number): number {\n  return total - (total * percent) / 100;", "percent: number, cap: number): number {\n  return total - Math.min((total * percent) / 100, cap);"));
    const h = core.handlers();

    await h["agents.review"]({ reviewerId: "rev", targetId: "alpha" });
    const prompt = core.store.getAgent("rev")!.turn!.prompt;
    assert.match(prompt, /Review the changes Alpha made\. Do not change any files\./);
    assert.match(prompt, /=== src\/pricing\.ts \(modified\)/);
    assert.match(prompt, /\s+2\+ {3}return total - Math\.min/);

    const comments = await waitFor(() => {
      const list = core.store.listComments("alpha");
      return list.length ? list : undefined;
    }, "review comments");
    assert.equal(comments.length, 1, "the comment on a file that is not there is skipped");
    assert.equal(comments[0]!.author, "rev");
    assert.equal(comments[0]!.severity, "blocker");
    assert.equal(comments[0]!.action, "note");
    assert.match(comments[0]!.quote, /Math\.min/);
    const t = await waitFor(async () => (await h["agents.transcript"]({ id: "alpha" })).find((e) => e.kind === "review"), "review in the conversation");
    assert.equal(t.text, "The cap can go negative.");
    assert.equal(t.comments, 1);

    // The person passes the blocker on.
    await core.agents.start("alpha");
    const told = await h["comments.tell"]({ id: comments[0]!.id });
    assert.equal(told.action, "guidance");
    await waitFor(() => (core.store.getAgent("alpha")!.turn?.prompt.includes("A review by Reviewer says: Clamp cap at 0.") ? true : undefined), "guidance");
    await assert.rejects(async () => h["agents.review"]({ reviewerId: "alpha", targetId: "alpha" }), /own work/);
  } finally {
    await core.close();
  }
});

test("a review reply is data: bad entries dropped, capped", () => {
  assert.equal(parseReview("no json here"), undefined);
  const r = parseReview('{"comments":[{"path":"a.ts","line":"3","text":"x"},{"path":"","line":1,"text":"y"},{"path":"b.ts","line":0,"text":"z"}]}')!;
  assert.deepEqual(r.comments, [{ path: "a.ts", line: 3, text: "x", severity: "suggestion" }]);
});
