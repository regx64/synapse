import { test } from "node:test";
import assert from "node:assert/strict";
import { SynapseCore } from "../src/index.js";
import { SHOP, makeRepo, waitFor, write } from "../src/testing.js";

test("an agent in a conflict can be told what to change, in its own words", async () => {
  const core = await SynapseCore.open({ workspace: makeRepo(SHOP), ephemeral: true });
  try {
    const a = await core.agents.add({ preset: "mock", id: "alpha", name: "Alpha", start: true });
    const b = await core.agents.add({ preset: "mock", id: "beta", name: "Beta", start: true });
    write(a.worktree.path, "src/pricing.ts", SHOP["src/pricing.ts"].replace("percent: number): number {", "percent: number, cap: number): number {"));
    write(b.worktree.path, "src/checkout.ts", `import { applyDiscount } from "./pricing";\n\nexport function checkout(total: number): number {\n  return applyDiscount(total, 10);\n}\n`);
    await core.refreshOwnership();
    const sig = core.store.getConflicts().find((c) => c.kind === "signature-change")!;
    const h = core.handlers();

    // Beta is idle: the guidance becomes its next prompt.
    await h["conflicts.tell"]({ id: sig.id, agentId: "beta" });
    const beta = await waitFor(() => (core.store.getAgent("beta")!.turn?.prompt ? core.store.getAgent("beta") : undefined), "beta prompted");
    assert.match(beta!.turn!.prompt, /Alpha changed the signature of `applyDiscount` in src\/pricing\.ts/);
    assert.match(beta!.turn!.prompt, /- src\/checkout\.ts:4: return applyDiscount\(total, 10\);/);
    assert.match(beta!.turn!.prompt, /Update these calls to the new signature\./);

    // The owner hears the other side.
    await h["conflicts.tell"]({ id: sig.id, agentId: "alpha" });
    const alpha = await waitFor(() => (core.store.getAgent("alpha")!.turn?.prompt ? core.store.getAgent("alpha") : undefined), "alpha prompted");
    assert.match(alpha!.turn!.prompt, /you changed the signature of `applyDiscount`[\s\S]*Beta's work still calls it the old way/);

    await assert.rejects(async () => h["conflicts.tell"]({ id: sig.id, agentId: "gamma" }), /not part of this conflict/);
    await assert.rejects(async () => h["conflicts.tell"]({ id: "nope", agentId: "beta" }), /No conflict/);
  } finally {
    await core.close();
  }
});
