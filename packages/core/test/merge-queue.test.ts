import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { SynapseCore } from "../src/index.js";
import { SHOP, gitOut, makeRepo, waitFor, write } from "../src/testing.js";

const FILES = {
  ...SHOP,
  "check.js": "const fs = require('fs');\nif (fs.existsSync('src/broken.ts')) { console.log('broken.ts must not exist'); process.exit(1); }\n",
  "synapse.config.json": JSON.stringify({ testCommand: "node check.js", testsAfterTurn: false }),
};

test("the merge queue merges agents' work one at a time, only when the tests pass", async () => {
  const repo = makeRepo(FILES);
  const core = await SynapseCore.open({ workspace: repo, ephemeral: true });
  try {
    const a = await core.agents.add({ preset: "mock", id: "alpha", name: "Alpha" });
    const b = await core.agents.add({ preset: "mock", id: "beta", name: "Beta" });
    const c = await core.agents.add({ preset: "mock", id: "gamma", name: "Gamma" });
    write(a.worktree.path, "src/tax.ts", "export const rate = 0.1;\n");
    write(b.worktree.path, "src/money.ts", "export type Cents = number;\n");
    write(c.worktree.path, "src/broken.ts", "export {};\n");
    await core.refreshOwnership();
    const t = core.collab.createTask({ title: "Add tax", agentId: "alpha" });
    core.store.putTask({ ...t, status: "review" });
    const h = core.handlers();

    const qa = await h["queue.add"]({ agentId: "alpha", taskId: t.id });
    const qb = await h["queue.add"]({ agentId: "beta" });
    const qc = await h["queue.add"]({ agentId: "gamma" });
    await assert.rejects(async () => h["queue.add"]({ agentId: "alpha" }), /already in the queue/);
    const status = (id: string) => core.store.getQueueEntry(id)!.status;
    await waitFor(() => (status(qc.id) !== "queued" && status(qc.id) !== "merging" ? true : undefined), "queue drained", 60_000);

    assert.equal(status(qa.id), "merged");
    assert.equal(status(qb.id), "merged");
    assert.equal(status(qc.id), "failed");
    assert.match(core.store.getQueueEntry(qc.id)!.error!, /tests failed[\s\S]*broken\.ts must not exist/);
    const files = gitOut(repo, "ls-tree", "-r", "--name-only", "main");
    assert.match(files, /src\/tax\.ts/);
    assert.match(files, /src\/money\.ts/);
    assert.doesNotMatch(files, /src\/broken\.ts/);
    assert.equal(core.store.getTask(t.id)!.status, "done", "the queued task is done once merged");
    assert.ok(core.store.snapshot().alerts.some((x) => x.kind === "queue-failed" && x.ref === qc.id));

    // Gamma fixes it; the entry goes back in the queue and merges.
    fs.rmSync(path.join(c.worktree.path, "src/broken.ts"));
    write(c.worktree.path, "src/fixed.ts", "export {};\n");
    await core.refreshOwnership("gamma");
    await h["queue.retry"]({ id: qc.id });
    await waitFor(() => (status(qc.id) === "merged" ? true : undefined), "retry merged", 60_000);
    assert.match(gitOut(repo, "ls-tree", "-r", "--name-only", "main"), /src\/fixed\.ts/);
  } finally {
    await core.close();
  }
});
