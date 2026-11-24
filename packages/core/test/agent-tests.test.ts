import { test } from "node:test";
import assert from "node:assert/strict";
import { SynapseCore } from "../src/index.js";
import { SHOP, makeRepo, waitFor } from "../src/testing.js";

const FILES = {
  ...SHOP,
  // "Tests": fail when the tax rate is 0.2.
  "check.js": "const fs = require('fs');\nconst t = fs.existsSync('src/tax.ts') ? fs.readFileSync('src/tax.ts', 'utf8') : '';\nif (t.includes('0.2')) { console.log('expected rate 0.1, got 0.2'); process.exit(1); }\nconsole.log('ok');\n",
  "synapse.config.json": JSON.stringify({ testCommand: "node check.js", testsFeedback: true }),
};

test("tests run in the agent's own worktree after a turn; failures show and go back to the agent", async () => {
  const core = await SynapseCore.open({ workspace: makeRepo(FILES), ephemeral: true });
  try {
    await core.agents.add({ preset: "mock", id: "alpha", name: "Alpha", start: true });
    const h = core.handlers();
    const tests = () => core.store.getAgent("alpha")!.tests;

    await h["agents.prompt"]({ id: "alpha", text: JSON.stringify({ steps: [{ write: { path: "src/tax.ts", content: "export const rate = 0.1;\n" } }] }) });
    await waitFor(() => (tests()?.status === "passed" ? true : undefined), "tests pass");
    assert.equal(tests()!.command, "node check.js");
    assert.match(tests()!.output!, /ok/);
    assert.ok(!core.store.snapshot().alerts.some((a) => a.kind === "tests-failed"));

    await h["agents.prompt"]({ id: "alpha", text: JSON.stringify({ steps: [{ write: { path: "src/tax.ts", content: "export const rate = 0.2;\n" } }] }) });
    await waitFor(() => (tests()?.status === "failed" ? true : undefined), "tests fail");
    const alert = core.store.snapshot().alerts.find((a) => a.kind === "tests-failed");
    assert.match(alert!.title, /Alpha's tests failed/);
    // The failure went back to the agent as guidance (the mock agent just echoes it).
    await waitFor(() => (core.store.getAgent("alpha")!.turn?.prompt.includes("ran `node check.js` in your worktree") ? true : undefined), "feedback");
    assert.match(core.store.getAgent("alpha")!.turn!.prompt, /expected rate 0\.1, got 0\.2/);
    // The echo changed nothing, so no new run and no second feedback.
    await waitFor(() => (core.store.getAgent("alpha")!.status === "idle" ? true : undefined), "idle");
    assert.equal(tests()!.feedbackCount, 1);

    // On request, too.
    await h["agents.test"]({ id: "alpha" });
    await waitFor(() => (tests()?.status === "failed" ? true : undefined), "ran again");
  } finally {
    await core.close();
  }
});
