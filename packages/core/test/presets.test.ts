import { test } from "node:test";
import assert from "node:assert/strict";
import { SynapseCore } from "../src/index.js";
import { SHOP, makeRepo } from "../src/testing.js";
import { listPresets } from "../src/presets.js";

test("the Claude preset will not start without API-key credentials (vendor terms)", async () => {
  const saved = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX: process.env.CLAUDE_CODE_USE_VERTEX };
  for (const k of Object.keys(saved)) delete process.env[k];
  const core = await SynapseCore.open({ workspace: makeRepo(SHOP), ephemeral: true });
  try {
    const claude = listPresets({}).find((p) => p.id === "claude")!;
    assert.deepEqual(claude.requiresEnv?.anyOf, ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]);
    await core.agents.add({ preset: "claude", id: "claude" });
    await assert.rejects(core.agents.start("claude"), /needs one of ANTHROPIC_API_KEY/);
    const state = core.store.getAgent("claude")!;
    assert.equal(state.status, "error");
    assert.match(state.error ?? "", /API-key authentication/);
  } finally {
    await core.close();
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});

test("the Codex preset uses the maintained adapter package", () => {
  const codex = listPresets({}).find((p) => p.id === "codex")!;
  assert.match(codex.args.join(" "), /@agentclientprotocol\/codex-acp@\d/);
});
