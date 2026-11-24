import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SynapseCore } from "../src/index.js";
import { listPresets } from "../src/presets.js";
import { SHOP, makeRepo, waitFor } from "../src/testing.js";

const mock = listPresets({}).find((p) => p.id === "mock")!;

test("a plan-first task waits for the person to approve (or revise) the plan before code changes", async () => {
  const core = await SynapseCore.open({ workspace: makeRepo(SHOP), ephemeral: true });
  try {
    const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-plan-")), "s.json");
    fs.writeFileSync(script, JSON.stringify({ turns: [
      { steps: [{ plan: ["Add src/tax.ts", "Use it in Cart.total"] }, { say: "That is my plan." }] },
      { steps: [{ plan: ["Add src/tax.ts with a 9% rate", "Use it in Cart.total", "Add a test"] }] },
      { steps: [{ write: { path: "src/tax.ts", content: "export const rate = 0.09;\n" } }, { say: "Done." }] },
    ] }));
    await core.agents.add({ preset: "mock", id: "alpha", name: "Alpha", args: [...mock.args, "--script", script], start: true });
    const h = core.handlers();
    const t = await h["tasks.create"]({ title: "Add tax", agentId: "alpha", planFirst: true });
    await h["tasks.start"]({ id: t.id });
    const task = () => core.store.getTask(t.id)!;
    assert.match(core.store.getAgent("alpha")!.turn!.prompt, /Plan first\. Do not change any files/);

    await waitFor(() => (task().plan?.state === "proposed" ? true : undefined), "plan proposed");
    assert.equal(task().status, "review");
    assert.equal(task().plan!.text, "1. Add src/tax.ts\n2. Use it in Cart.total");
    assert.ok(core.store.snapshot().alerts.some((a) => a.kind === "plan-review" && a.ref === t.id));
    assert.ok(!core.store.snapshot().alerts.some((a) => a.kind === "task-review"));

    await h["tasks.revisePlan"]({ id: t.id, feedback: "Use a 9% rate and add a test" });
    assert.match(core.store.getAgent("alpha")!.turn!.prompt, /feedback on your previous plan[\s\S]*Use a 9% rate and add a test/);
    await waitFor(() => (task().plan?.state === "proposed" && task().plan!.rounds === 2 ? true : undefined), "revised plan");
    assert.match(task().plan!.text!, /9% rate[\s\S]*Add a test/);

    await h["tasks.approvePlan"]({ id: t.id, plan: "1. Add src/tax.ts with rate 0.09\n2. Stop there" });
    assert.match(core.store.getAgent("alpha")!.turn!.prompt, /approved this plan\. Carry it out:\n1\. Add src\/tax\.ts with rate 0\.09/);
    await waitFor(() => (task().status === "review" && task().plan?.state === "approved" ? true : undefined), "work done");
    assert.ok(fs.existsSync(path.join(core.store.getAgent("alpha")!.worktree.path, "src/tax.ts")));
    assert.ok(core.store.snapshot().alerts.some((a) => a.kind === "task-review" && a.ref === t.id));
    await assert.rejects(async () => h["tasks.approvePlan"]({ id: t.id }), /no plan waiting/);
  } finally {
    await core.close();
  }
});
