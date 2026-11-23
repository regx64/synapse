import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SynapseClient } from "@synapse/client";
import { makeRepo, waitFor } from "@synapse/core/testing";

const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "main.js");

test("the core starts as its own process on a fresh repository and stops on request", async () => {
  const repo = makeRepo({ "a.ts": "export const x = 1;\n" });
  const client = await SynapseClient.connectOrStart({ workspace: repo, coreMain: require.resolve("@synapse/core/main"), clientName: "process-test" });
  try {
    assert.equal(client.hello.baseRef, "main");
    const state = await client.call("state.get");
    assert.deepEqual(state.agents, []);
  } finally {
    await client.call("core.shutdown");
    client.close();
  }
  await waitFor(async () => !(await SynapseClient.connect({ workspace: repo }).then((c) => (c.close(), true), () => false)), "core to stop");
});

test("the CLI drives a mock agent end to end", () => {
  const repo = makeRepo({ "a.ts": "export function greet(name: string) { return name; }\n" });
  const run = (...args: string[]) => execFileSync(process.execPath, [cli, "-w", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    run("agent", "add", "mock", "--start");
    run("agent", "prompt", "mock", "--wait", JSON.stringify({ steps: [{ edit: { path: "a.ts", find: "name: string", replace: "name: string, n = 1" } }] }));
    const owners = JSON.parse(run("owners", "--json"));
    assert.equal(owners[0].files[0].symbols[0].name, "greet");
    assert.equal(owners[0].files[0].symbols[0].signatureChanged, true);
    const review = JSON.parse(run("review", "--json"));
    assert.equal(review.status, "ready");
    run("merge", review.id, "--reset-agents");
    assert.equal(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: repo, encoding: "utf8" }).trim(), "Synapse: merge work of Mock");
  } finally {
    run("core", "stop");
  }
});
