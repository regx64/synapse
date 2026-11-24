import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { SynapseCore } from "../src/index.js";
import { SHOP, makeRepo, waitFor } from "../src/testing.js";

const idleAfterTurn = (core: SynapseCore, id: string) =>
  waitFor(() => {
    const a = core.store.getAgent(id)!;
    return a.status === "idle" && a.turn?.endedAt ? a : undefined;
  }, `${id} idle`);

test("an agent's conversation is kept: prompts, messages, tool calls, guidance and how turns ended", async () => {
  const repo = makeRepo(SHOP);
  let core = await SynapseCore.open({ workspace: repo });
  try {
    await core.agents.add({ preset: "mock", id: "alpha", name: "Alpha", start: true });
    const h = core.handlers();
    const token = "sk-ant-" + "a".repeat(24);
    await h["agents.prompt"]({
      id: "alpha",
      text: JSON.stringify({ steps: [{ say: "Adding a tax module. " }, { write: { path: "src/tax.ts", content: "export const rate = 0.1;\n" } }, { sleep: 300 }, { say: `Done, key ${token}` }] }),
    });
    await waitFor(() => (core.store.getAgent("alpha")!.status === "working" ? true : undefined), "working");
    await h["agents.steer"]({ id: "alpha", text: "Then add tests" });
    await waitFor(() => (core.store.getAgent("alpha")!.turn?.steered ? true : undefined), "guidance turn");
    await idleAfterTurn(core, "alpha");

    const t = await h["agents.transcript"]({ id: "alpha" });
    const kinds = t.map((e) => e.kind);
    assert.equal(kinds[0], "prompt");
    assert.ok(kinds.includes("tool"), "tool call recorded");
    assert.deepEqual(t.filter((e) => e.kind === "guidance").map((e) => [e.text, e.mode]), [["Then add tests", "next"]]);
    assert.equal(t.filter((e) => e.kind === "prompt" && e.followup).length, 1, "the follow-up turn is marked");
    assert.equal(t.filter((e) => e.kind === "end").length, 2);
    const said = t.filter((e) => e.kind === "message").map((e) => e.text.trim());
    // Chunks join into one entry until something else (here a tool call) happens.
    assert.equal(said[0], "Adding a tax module.");
    assert.equal(said[1], "Done, key «redacted»", "secrets are redacted");
    const tool = t.find((e) => e.kind === "tool")!;
    assert.equal(tool.status, "completed");
    assert.deepEqual(t.map((e) => e.n), t.map((_, i) => i + 1), "entries are numbered in order");

    // A task's prompt is linked to the task.
    const task = await h["tasks.create"]({ title: "Add tests", agentId: "alpha" });
    await h["tasks.start"]({ id: task.id });
    await idleAfterTurn(core, "alpha");
    const withTask = await h["agents.transcript"]({ id: "alpha" });
    assert.equal(withTask.filter((e) => e.kind === "prompt" && !e.followup).at(-1)!.taskId, task.id);

    // `from` returns the newest entries again, so a growing message refreshes.
    const tail = await h["agents.transcript"]({ id: "alpha", from: withTask[withTask.length - 1]!.n });
    assert.deepEqual(tail.map((e) => e.n), [withTask[withTask.length - 1]!.n]);

    await core.close();
    // It survives a restart.
    assert.ok(fs.existsSync(path.join(repo, ".synapse", "transcripts", "alpha.json")));
    core = await SynapseCore.open({ workspace: repo });
    assert.deepEqual((await core.handlers()["agents.transcript"]({ id: "alpha" })).map((e) => e.kind), withTask.map((e) => e.kind));

    // Removing the agent forgets it.
    await core.agents.remove("alpha");
    assert.ok(!fs.existsSync(path.join(repo, ".synapse", "transcripts", "alpha.json")));
  } finally {
    await core.close();
  }
});
