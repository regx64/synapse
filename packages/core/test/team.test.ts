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

test("a teammate's agent's work can be continued; its owner is told, and viewers only watch", async () => {
  const { alice, bob, remote } = team();
  const root = path.dirname(remote);
  const carol = path.join(root, "carol");
  gitOut(root, "clone", "-q", remote, carol);
  for (const [repo, name] of [[alice, "alice"], [bob, "bob"], [carol, "carol"]] as const) {
    write(repo, ".synapse/config.json", JSON.stringify({ team: { enabled: true, name, intervalSec: 3600, members: { carol: "viewer" } } }));
  }
  const A = await SynapseCore.open({ workspace: alice, ephemeral: true });
  const B = await SynapseCore.open({ workspace: bob, ephemeral: true });
  const C = await SynapseCore.open({ workspace: carol, ephemeral: true });
  try {
    // Alice's agent got halfway through a task, then Alice went offline.
    const alpha = await A.agents.add({ preset: "mock", id: "alpha", name: "Alpha" });
    const t = A.collab.createTask({ title: "Add a discount cap", agentId: "alpha" });
    A.store.updateAgent("alpha", { currentTaskId: t.id });
    write(alpha.worktree.path, "src/pricing.ts", SHOP["src/pricing.ts"].replace("percent: number): number {", "percent: number, cap: number): number {"));
    await A.refreshOwnership();
    await A.handlers()["team.sync"]();

    // Bob continues it with his own agent.
    const beta = await B.agents.add({ preset: "mock", id: "beta", name: "Beta", start: true });
    await B.handlers()["team.sync"]();
    const r = await B.handlers()["team.adopt"]({ from: "@alice/alpha", to: "beta", note: "Alice is out today" });
    assert.deepEqual(r.files, ["src/pricing.ts"]);
    assert.equal(r.task!.title, "Add a discount cap (continued from alice)");
    assert.match(fs.readFileSync(path.join(beta.worktree.path, "src/pricing.ts"), "utf8").replace(/\r\n/g, "\n"), /cap: number/);
    assert.match(B.store.getAgent("beta")!.turn!.prompt, /continuing work that Alpha \(alice\) started[\s\S]*Note from the person: Alice is out today/);
    await B.handlers()["team.sync"]();

    // Alice is told, and can dismiss it.
    const a = await A.handlers()["team.sync"]();
    assert.equal(a.claimsOnMe.length, 1);
    assert.equal(a.claimsOnMe[0]!.by, "bob");
    const alert = A.store.snapshot().alerts.find((x) => x.kind === "team-claim");
    assert.match(alert!.title, /bob continued Alpha's work on "Add a discount cap"/);
    const after = await A.handlers()["team.dismissClaim"]({ id: a.claimsOnMe[0]!.id });
    assert.deepEqual(after.claimsOnMe, []);
    assert.ok(!A.store.snapshot().alerts.some((x) => x.kind === "team-claim"));

    // Carol is a viewer: she sees everyone, publishes nothing, and cannot continue work.
    await C.agents.add({ preset: "mock", id: "gamma", start: true });
    const c = await C.handlers()["team.sync"]();
    assert.equal(c.role, "viewer");
    assert.deepEqual(c.peers.map((p) => p.person), ["alice", "bob"]);
    assert.equal(c.peers.find((p) => p.person === "alice")!.agents[0]!.claimedBy, "bob");
    assert.doesNotMatch(gitOut(alice, "ls-remote", "--refs", remote, "refs/synapse/team/*"), /carol/);
    await assert.rejects(async () => C.handlers()["team.adopt"]({ from: "@alice/alpha", to: "gamma" }), /Viewers/);
  } finally {
    await A.close();
    await B.close();
    await C.close();
  }
});

test("team mode can be turned on from the UI; it is written to the local config", async () => {
  const repo = makeRepo(SHOP);
  const remote = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-team-")), "remote.git");
  gitOut(path.dirname(remote), "clone", "-q", "--bare", repo, remote);
  gitOut(repo, "remote", "add", "origin", remote);
  const core = await SynapseCore.open({ workspace: repo, ephemeral: true });
  try {
    const h = core.handlers();
    assert.equal((await h["team.status"]()).enabled, false);
    const s = await h["team.enable"]({ name: "Dana" });
    assert.equal(s.enabled, true);
    assert.equal(s.person, "dana");
    assert.equal(s.error, undefined);
    const local = JSON.parse(fs.readFileSync(path.join(repo, ".synapse", "config.json"), "utf8"));
    assert.deepEqual(local.team, { enabled: true, name: "Dana" });
    assert.match(gitOut(repo, "ls-remote", "--refs", remote, "refs/synapse/team/*"), /refs\/synapse\/team\/dana\/lane/);
  } finally {
    await core.close();
  }
});
