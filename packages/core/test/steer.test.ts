import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SynapseCore } from "../src/index.js";
import { listPresets } from "../src/presets.js";
import { SHOP, gitOut, makeRepo, waitFor, write } from "../src/testing.js";

const mock = listPresets({}).find((p) => p.id === "mock")!;

/** A mock agent; with `turns`, plain-text prompts (tasks, guidance) play these scripted turns in order. */
async function addMock(core: SynapseCore, id: string, turns?: unknown[][]) {
  const args = [...mock.args];
  if (turns) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-script-")), "script.json");
    fs.writeFileSync(file, JSON.stringify({ turns: turns.map((steps) => ({ steps })) }));
    args.push("--script", file);
  }
  return core.agents.add({ preset: "mock", id, name: id[0]!.toUpperCase() + id.slice(1), args, start: true });
}

const state = (core: SynapseCore, id: string) => core.store.getAgent(id)!;
const idle = (core: SynapseCore, id: string) => waitFor(() => (state(core, id).status === "idle" ? state(core, id) : undefined), `${id} idle`);
const working = (core: SynapseCore, id: string) => waitFor(() => (state(core, id).status === "working" ? true : undefined), `${id} working`);

test("guidance for after the turn continues the same work in a follow-up turn", async () => {
  const core = await SynapseCore.open({ workspace: makeRepo(SHOP), ephemeral: true });
  try {
    await addMock(core, "alpha");
    const h = core.handlers();
    await h["agents.prompt"]({ id: "alpha", text: JSON.stringify({ steps: [{ sleep: 300 }, { say: "first turn done" }] }) });
    await working(core, "alpha");
    const s = await h["agents.steer"]({ id: "alpha", text: "Store amounts as integer cents" });
    assert.deepEqual(s.guidance?.map((g) => [g.mode, g.text]), [["next", "Store amounts as integer cents"]]);
    // The first turn finishes normally, then the guidance turn runs.
    const done = await waitFor(() => (state(core, "alpha").status === "idle" && state(core, "alpha").turn?.steered ? state(core, "alpha") : undefined), "guidance turn");
    assert.equal(done.turn!.steered, 1);
    assert.equal(done.guidance, undefined);
    assert.match(done.lastMessage ?? "", /Guidance from the person[\s\S]*- Store amounts as integer cents/);
  } finally {
    await core.close();
  }
});

test("guidance now interrupts the turn and the task stays in progress until the agent finishes", async () => {
  const core = await SynapseCore.open({ workspace: makeRepo(SHOP), ephemeral: true });
  try {
    const a = await addMock(core, "alpha", [
      [{ write: { path: "src/tax.ts", content: "export const rate = 0.1;\n" } }, { sleep: 5000 }, { say: "too slow" }],
      [{ say: "continued with the guidance" }],
    ]);
    const t = await core.collab.createTask({ title: "Add tax", agentId: "alpha" });
    core.collab.startTask(t.id);
    await waitFor(() => fs.existsSync(path.join(a.worktree.path, "src/tax.ts")) || undefined, "tax.ts written");
    await core.handlers()["agents.steer"]({ id: "alpha", text: "Use a 9% rate", mode: "now" });
    const done = await waitFor(() => (core.store.getTask(t.id)!.status === "review" ? core.store.getTask(t.id) : undefined), "task in review");
    const s = state(core, "alpha");
    assert.equal(s.turn!.steered, 1);
    assert.equal(s.lastMessage?.trim(), "continued with the guidance");
    assert.equal(done!.agentId, "alpha");
    assert.ok(fs.existsSync(path.join(a.worktree.path, "src/tax.ts")), "work done before the interruption is kept");
  } finally {
    await core.close();
  }
});

test("cancelling a turn drops guidance that was waiting for it", async () => {
  const core = await SynapseCore.open({ workspace: makeRepo(SHOP), ephemeral: true });
  try {
    await addMock(core, "alpha");
    const h = core.handlers();
    await h["agents.prompt"]({ id: "alpha", text: JSON.stringify({ steps: [{ sleep: 5000 }] }) });
    await working(core, "alpha");
    await h["agents.steer"]({ id: "alpha", text: "Then add tests" });
    await h["agents.cancel"]({ id: "alpha" });
    const s = await idle(core, "alpha");
    assert.equal(s.turn!.stopReason, "cancelled");
    assert.equal(s.turn!.steered, undefined, "no follow-up turn");
    assert.equal(s.guidance, undefined);
  } finally {
    await core.close();
  }
});

test("steering an idle agent is a plain prompt; empty guidance is refused", async () => {
  const core = await SynapseCore.open({ workspace: makeRepo(SHOP), ephemeral: true });
  try {
    await addMock(core, "alpha");
    const h = core.handlers();
    await assert.rejects(async () => h["agents.steer"]({ id: "alpha", text: "  " }), /needs some text/);
    await h["agents.steer"]({ id: "alpha", text: "hello there", mode: "now" });
    const s = await idle(core, "alpha");
    assert.equal(s.lastMessage?.trim(), "mock agent received: hello there");
    assert.equal(s.turn!.steered, undefined);
  } finally {
    await core.close();
  }
});

test("another agent takes over unfinished work: changes, task and context move with it", async () => {
  const repo = makeRepo(SHOP);
  const core = await SynapseCore.open({ workspace: repo, ephemeral: true });
  try {
    const a = await addMock(core, "alpha", [[{ plan: ["Add tax module", "Use it in Cart.total"] }, { write: { path: "src/tax.ts", content: "export const rate = 0.1;\n" } }, { edit: { path: "src/pricing.ts", find: "/ 100;", replace: "/ 100.0;" } }, { sleep: 10000 }]]);
    const b = await addMock(core, "beta");
    const t = await core.collab.createTask({ title: "Add tax", description: "Tax at checkout.", agentId: "alpha" });
    core.collab.startTask(t.id);
    await waitFor(() => (fs.existsSync(path.join(a.worktree.path, "src/tax.ts")) && fs.readFileSync(path.join(a.worktree.path, "src/pricing.ts"), "utf8").includes("100.0") ? true : undefined), "alpha's edits");

    const r = await core.handlers()["agents.takeover"]({ from: "alpha", to: "beta", note: "Keep the 10% rate" });
    assert.deepEqual([...r.files].sort(), ["src/pricing.ts", "src/tax.ts"]);
    assert.equal(r.task!.agentId, "beta");
    assert.equal(r.task!.status, "in_progress");
    assert.equal(r.from.currentTaskId, undefined);
    assert.match(gitOut(repo, "for-each-ref", "--format=%(refname)", "refs/synapse/takeovers"), /refs\/synapse\/takeovers\/alpha-to-beta-\d+/);

    // The work moved: beta has it, alpha is back at its base.
    assert.equal(fs.readFileSync(path.join(b.worktree.path, "src/tax.ts"), "utf8"), "export const rate = 0.1;\n");
    assert.ok(!fs.existsSync(path.join(a.worktree.path, "src/tax.ts")));
    assert.equal(fs.readFileSync(path.join(a.worktree.path, "src/pricing.ts"), "utf8"), SHOP["src/pricing.ts"]);

    // Beta was briefed, then finished; the task is beta's.
    const s = await idle(core, "beta");
    assert.ok(s.turn!.prompt.includes(`You are taking over task ${t.id} from Alpha`));
    assert.match(s.turn!.prompt, /Note from the person: Keep the 10% rate/);
    assert.match(s.turn!.prompt, /Their plan:\n\s+\[pending\] Add tax module/);
    assert.equal(core.store.getTask(t.id)!.status, "review");
    assert.equal(core.store.getTask(t.id)!.agentId, "beta");

    await core.refreshOwnership();
    assert.deepEqual(core.store.getOwnership("beta")!.files.map((f) => f.path).sort(), ["src/pricing.ts", "src/tax.ts"]);
    assert.deepEqual(core.store.getOwnership("alpha")?.files ?? [], []);
    assert.ok(!core.store.getConflicts().some((c) => c.agents.includes("alpha")), "no conflicts left between the two");
    assert.equal(state(core, "alpha").status, "idle");
  } finally {
    await core.close();
  }
});

test("a takeover needs an idle agent without changes of its own", async () => {
  const core = await SynapseCore.open({ workspace: makeRepo(SHOP), ephemeral: true });
  try {
    await addMock(core, "alpha", [[{ sleep: 10000 }]]);
    const b = await addMock(core, "beta");
    const t = await core.collab.createTask({ title: "Something", agentId: "alpha" });
    core.collab.startTask(t.id);
    await working(core, "alpha");
    const h = core.handlers();
    await assert.rejects(async () => h["agents.takeover"]({ from: "alpha", to: "alpha" }), /own work/);
    write(b.worktree.path, "src/mine.ts", "export {};\n");
    await assert.rejects(async () => h["agents.takeover"]({ from: "alpha", to: "beta" }), /changes of its own/);
    assert.equal(state(core, "alpha").status, "working", "nothing was stopped");
    assert.equal(core.store.getTask(t.id)!.agentId, "alpha");
  } finally {
    await core.close();
  }
});
