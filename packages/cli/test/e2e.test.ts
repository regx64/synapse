import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { SynapseClient, JsonRpcPeer, ErrorCodes, RpcError, type Approval, type CoreEvent } from "@synapse/client";
import { SynapseCore, serve } from "@synapse/core";
import { SHOP, gitOut, makeRepo, waitFor } from "@synapse/core/testing";

const steps = (...s: unknown[]) => JSON.stringify({ steps: s });

test("two agents, a pre-merge conflict, approval, combined review and merge — all over the core API", async () => {
  const repo = makeRepo({
    ...SHOP,
    "synapse.config.json": JSON.stringify({ testCommand: "node check.mjs" }),
    "check.mjs": `import fs from "node:fs";\nconst src = fs.readFileSync("src/pricing.ts", "utf8");\nif (!src.includes("applyDiscount")) process.exit(1);\nconsole.log("checks passed");\n`,
  });
  const core = await SynapseCore.open({ workspace: repo, ephemeral: true });
  const socket = process.platform === "win32" ? `\\\\.\\pipe\\synapse-test-${process.pid}` : path.join(os.tmpdir(), `synapse-test-${process.pid}.sock`);
  const server = await serve(core, { socket });
  const client = await SynapseClient.connect({ workspace: repo, clientName: "e2e" });
  const events: CoreEvent[] = [];
  client.on("event", (e: CoreEvent) => events.push(e));

  try {
    // Unauthenticated connections are refused.
    const raw = net.connect(socket);
    await new Promise((r) => raw.once("connect", r));
    const anon = new JsonRpcPeer(raw, raw);
    await assert.rejects(anon.request("state.get"), (e: RpcError) => e.code === ErrorCodes.Unauthorized);
    anon.close();
    raw.destroy();

    assert.equal(client.hello.baseRef, "main");
    await client.subscribe();
    const alpha = await client.call("agents.add", { preset: "mock", id: "alpha", name: "Alpha", start: true });
    const beta = await client.call("agents.add", { preset: "mock", id: "beta", name: "Beta", start: true });
    assert.equal(alpha.status, "idle");
    assert.equal(beta.status, "idle");

    const idle = (id: string) => waitFor(async () => (await client.call("agents.list")).find((a) => a.id === id && a.status === "idle" && a.turn?.endedAt), `${id} idle`);

    // Alpha changes applyDiscount's signature, updates the caller it knows about, then asks to run tests.
    await client.call("agents.prompt", {
      id: "alpha",
      text: steps(
        { plan: ["Add a cap to discounts", "Update callers"] },
        { edit: { path: "src/pricing.ts", find: "percent: number): number", replace: "percent: number, cap: number): number" } },
        { edit: { path: "src/cart.ts", find: "applyDiscount(this.total(), percent)", replace: "applyDiscount(this.total(), percent, 50)" } },
        { ask: { title: "Run the test suite", kind: "execute" } },
        { say: "Done: discounts are capped." },
      ),
    });
    const approval = await waitFor(async () => (await client.call("approvals.list", {})).find((a) => a.agentId === "alpha"), "approval request");
    assert.equal(approval.title, "Run the test suite");
    assert.equal((await client.call("agents.list")).find((a) => a.id === "alpha")!.status, "awaiting-approval");
    await client.call("approvals.resolve", { id: approval.id });
    const alphaDone = await idle("alpha");
    assert.match(alphaDone.lastMessage ?? "", /discounts are capped/);
    assert.equal(alphaDone.plan?.length, 2);

    // Beta adds a new caller using the old signature, and tries to write outside its worktree.
    const outside = path.join(repo, "src", "escaped.ts");
    await client.call("agents.prompt", {
      id: "beta",
      text: steps(
        { write: { path: "src/checkout.ts", content: `import { applyDiscount } from "./pricing";\n\nexport function checkout(total: number): number {\n  return applyDiscount(total, 10);\n}\n` } },
        { write: { path: outside, content: "nope" } },
      ),
    });
    await idle("beta");
    assert.ok(!fs.existsSync(outside), "write outside the worktree must be refused");
    assert.equal(gitOut(repo, "status", "--porcelain"), "", "main checkout untouched by agents");

    // The conflict shows up before any merge, pushed as an event.
    const sig = await waitFor(async () => (await client.call("conflicts.list")).find((c) => c.kind === "signature-change"), "signature-change conflict");
    assert.deepEqual(sig.agents, ["alpha", "beta"]);
    assert.ok(events.some((e) => e.type === "conflicts.updated"));
    assert.ok(events.some((e) => e.type === "approval.requested" && (e.data as Approval).agentId === "alpha"));

    // Editor markers for the human's checkout.
    const markers = await client.call("ownership.forFile", { path: path.join(repo, "src/pricing.ts") });
    assert.equal(markers[0]?.agentId, "alpha");
    assert.equal(markers[0]?.signatureChanged, true);

    // Combined review sees the conflict; merging is refused without force.
    const r1 = await client.call("review.prepare", {});
    assert.equal(r1.status, "ready");
    assert.equal(r1.tests?.passed, true);
    assert.ok(r1.conflicts.some((c) => c.kind === "signature-change"));
    assert.deepEqual(r1.files.map((f) => f.path).sort(), ["src/cart.ts", "src/checkout.ts", "src/pricing.ts"]);
    await assert.rejects(client.call("review.merge", { id: r1.id }), /conflict/);
    await client.call("review.discard", { id: r1.id });

    // Beta fixes its call; the conflict clears.
    await client.call("agents.prompt", { id: "beta", text: steps({ edit: { path: "src/checkout.ts", find: "applyDiscount(total, 10)", replace: "applyDiscount(total, 10, 50)" } }) });
    await idle("beta");
    await waitFor(async () => !(await client.call("conflicts.check")).some((c) => c.kind === "signature-change"), "conflict cleared");

    const r2 = await client.call("review.prepare", {});
    assert.equal(r2.status, "ready");
    const diff = (await client.call("review.diff", { id: r2.id })).diff;
    assert.match(diff, /cap: number/);
    assert.match(diff, /applyDiscount\(total, 10, 50\)/);
    const merged = await client.call("review.merge", { id: r2.id, resetAgents: true });
    assert.equal(merged.status, "merged");

    // The person's checkout now has both agents' work, and the agents start fresh from it.
    assert.match(fs.readFileSync(path.join(repo, "src/checkout.ts"), "utf8"), /applyDiscount\(total, 10, 50\)/);
    assert.match(fs.readFileSync(path.join(repo, "src/pricing.ts"), "utf8"), /cap: number/);
    const head = gitOut(repo, "rev-parse", "HEAD");
    const agents = await client.call("agents.list");
    for (const a of agents) assert.equal(a.worktree.baseCommit, head);
    const own = await client.call("ownership.refresh", {});
    assert.ok(own.every((o) => o.files.length === 0), "agents have no pending changes after reset");
  } finally {
    client.close();
    await server.close();
    await core.close();
  }
});
