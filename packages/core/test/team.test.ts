import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SynapseCore } from "../src/index.js";
import { SHOP, gitOut, makeRepo, write } from "../src/testing.js";

/** A shared bare remote and two clones, each with team mode on under a different name. */
function team() {
  const alice = makeRepo(SHOP);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-team-"));
  const remote = path.join(root, "remote.git");
  gitOut(root, "clone", "-q", "--bare", alice, remote);
  gitOut(alice, "remote", "add", "origin", remote);
  const bob = path.join(root, "bob");
  gitOut(root, "clone", "-q", remote, bob);
  gitOut(bob, "config", "user.email", "bob@example.com");
  gitOut(bob, "config", "user.name", "Bob");
  for (const [repo, name] of [[alice, "alice"], [bob, "bob"]] as const) {
    write(repo, ".synapse/config.json", JSON.stringify({ team: { enabled: true, name, intervalSec: 3600 } }));
  }
  return { alice, bob, remote };
}

test("teammates' agents are shared through the git remote and take part in conflict detection", async () => {
  const { alice, bob, remote } = team();
  const A = await SynapseCore.open({ workspace: alice, ephemeral: true });
  const B = await SynapseCore.open({ workspace: bob, ephemeral: true });
  try {
    // Alice's agent changes applyDiscount's signature and updates its caller.
    const alpha = await A.agents.add({ preset: "mock", id: "alpha", name: "Alpha" });
    write(alpha.worktree.path, "src/pricing.ts", SHOP["src/pricing.ts"].replace("percent: number): number {", "percent: number, cap: number): number {"));
    write(alpha.worktree.path, "src/cart.ts", SHOP["src/cart.ts"].replace("applyDiscount(this.total(), percent)", "applyDiscount(this.total(), percent, 50)"));
    // Bob's agent, unaware, adds a call with the old signature.
    const beta = await B.agents.add({ preset: "mock", id: "beta", name: "Beta" });
    write(beta.worktree.path, "src/checkout.ts", `import { applyDiscount } from "./pricing";\n\nexport function checkout(total: number): number {\n  return applyDiscount(total, 10);\n}\n`);
    await A.refreshOwnership();
    await B.refreshOwnership();

    const a1 = await A.handlers()["team.sync"]();
    assert.equal(a1.person, "alice");
    assert.equal(a1.error, undefined);
    const refs = gitOut(alice, "ls-remote", "--refs", remote, "refs/synapse/team/*");
    assert.match(refs, /\trefs\/synapse\/team\/alice\/lane$/m);
    assert.match(refs, /\trefs\/synapse\/team\/alice\/agents\/alpha$/m);

    const b1 = await B.handlers()["team.sync"]();
    assert.deepEqual(b1.peers.map((p) => p.person), ["alice"]);
    const peerAlpha = b1.peers[0]!.agents[0]!;
    assert.equal(peerAlpha.id, "@alice/alpha");
    assert.deepEqual(peerAlpha.files.map((f) => f.path).sort(), ["src/cart.ts", "src/pricing.ts"]);

    // Bob sees the cross-person conflict before anyone merges.
    const conflicts = await B.checkConflicts();
    const sig = conflicts.find((c) => c.kind === "signature-change");
    assert.ok(sig, "signature-change across people");
    assert.deepEqual([...sig.agents].sort(), ["@alice/alpha", "beta"]);
    assert.match(sig.message, /Alpha \(alice\)/);

    // And Alice sees Bob's agent after her next sync.
    const a2 = await A.handlers()["team.sync"]();
    assert.deepEqual(a2.peers.map((p) => [p.person, p.agents.map((x) => x.agentId)]), [["bob", ["beta"]]]);
    assert.ok((await A.checkConflicts()).some((c) => c.kind === "signature-change" && c.agents.includes("@bob/beta")));

    // An agent that is gone disappears from the remote, and from teammates' view.
    await A.agents.remove("alpha");
    await A.handlers()["team.sync"]();
    assert.doesNotMatch(gitOut(alice, "ls-remote", "--refs", remote, "refs/synapse/team/*"), /agents\/alpha/);
    const b2 = await B.handlers()["team.sync"]();
    assert.deepEqual(b2.peers[0]!.agents, []);
    assert.ok(!(await B.checkConflicts()).some((c) => c.agents.some((x) => x.startsWith("@alice/"))));

    // Leaving removes everything Alice published.
    await A.handlers()["team.leave"]();
    assert.doesNotMatch(gitOut(alice, "ls-remote", "--refs", remote, "refs/synapse/team/*"), /alice/);
  } finally {
    await A.close();
    await B.close();
  }
});

test("team mode is off unless enabled", async () => {
  const core = await SynapseCore.open({ workspace: makeRepo(SHOP), ephemeral: true });
  try {
    const h = core.handlers();
    assert.equal((await h["team.status"]()).enabled, false);
    await assert.rejects(async () => h["team.sync"](), /Team mode is off/);
  } finally {
    await core.close();
  }
});
