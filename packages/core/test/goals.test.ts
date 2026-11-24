import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SynapseCore } from "../src/index.js";
import { parseProposal } from "../src/goals.js";
import { listPresets } from "../src/presets.js";
import { SHOP, makeRepo, waitFor } from "../src/testing.js";

const mock = listPresets({}).find((p) => p.id === "mock")!;

test("an agent splits a goal into tasks; the person edits and accepts; tasks are created with their dependencies", async () => {
  const core = await SynapseCore.open({ workspace: makeRepo(SHOP), ephemeral: true });
  try {
    const proposal = {
      tasks: [
        { key: "money", title: "Add a Money type", description: "Integer cents.", scope: ["src/money.ts"], agent: "beta" },
        { key: "cart", title: "Use Money in Cart", dependsOn: ["money"], agent: "gamma-does-not-exist" },
        { key: "docs", title: "Document it", dependsOn: ["cart"] },
      ],
    };
    const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-goal-")), "s.json");
    fs.writeFileSync(script, JSON.stringify({ turns: [{ steps: [{ say: "Here is the split:\n```json\n" + JSON.stringify(proposal) + "\n```" }] }] }));
    await core.agents.add({ preset: "mock", id: "planner", name: "Planner", args: [...mock.args, "--script", script], start: true });
    await core.agents.add({ preset: "mock", id: "beta", name: "Beta" });
    const h = core.handlers();

    const g = await h["goals.split"]({ goal: "Store money as integer cents everywhere", agentId: "planner" });
    assert.equal(g.status, "splitting");
    assert.match(core.store.getAgent("planner")!.turn!.prompt, /Split this goal[\s\S]*do not change any files[\s\S]*- beta: Beta/);
    await waitFor(() => (core.store.getGoal(g.id)!.status === "proposed" ? true : undefined), "proposal");
    const proposed = core.store.getGoal(g.id)!.tasks;
    assert.deepEqual(proposed.map((t) => [t.key, t.agentId, t.dependsOn]), [["money", "beta", []], ["cart", undefined, ["money"]], ["docs", undefined, ["cart"]]]);
    assert.ok(core.store.snapshot().alerts.some((a) => a.kind === "goal-split" && a.ref === g.id));

    // The person drops "docs" and assigns "cart" to beta.
    const created = await h["goals.accept"]({ id: g.id, tasks: [proposed[0]!, { ...proposed[1]!, agentId: "beta" }], planFirst: true });
    assert.deepEqual(created.map((t) => t.title), ["Add a Money type", "Use Money in Cart"]);
    assert.deepEqual(created[1]!.dependsOn, [created[0]!.id]);
    assert.equal(created[1]!.agentId, "beta");
    assert.ok(created.every((t) => t.planFirst));
    assert.match(created[0]!.description, /Integer cents\.\n\nPart of the goal: Store money as integer cents everywhere/);
    assert.equal(core.store.getGoal(g.id)!.status, "accepted");
    await assert.rejects(async () => h["goals.accept"]({ id: g.id }), /accepted, not waiting/);
  } finally {
    await core.close();
  }
});

test("a proposal is data: validated, capped, cycles and unknown agents dropped", () => {
  const ids = new Set(["alpha"]);
  assert.throws(() => parseProposal("I would rather not.", ids), /no task list/);
  const cyc = parseProposal('```json\n{"tasks":[{"key":"a","title":"A","dependsOn":["b"]},{"key":"b","title":"B","dependsOn":["a"]},{"title":""}]}\n```', ids);
  assert.deepEqual(cyc.map((t) => [t.key, t.dependsOn]), [["a", []], ["b", []]]);
  const many = parseProposal(JSON.stringify({ tasks: Array.from({ length: 50 }, (_, i) => ({ title: `T${i}`, agent: "alpha" })) }), ids);
  assert.equal(many.length, 20);
  assert.equal(many[0]!.agentId, "alpha");
});
