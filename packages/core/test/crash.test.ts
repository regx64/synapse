import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listCrashReports, writeCrashReport } from "../src/crash.js";
import { SynapseCore } from "../src/index.js";
import { SHOP, makeRepo } from "../src/testing.js";

test("crash reports are written locally with secrets and the home directory scrubbed", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-home-"));
  process.env.SYNAPSE_HOME = home;
  try {
    const err = new Error(`failed with key sk-ant-${"x".repeat(24)} in ${os.homedir()}/project`);
    const file = writeCrashReport(err, "uncaughtException")!;
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(report.kind, "uncaughtException");
    assert.doesNotMatch(report.message, /sk-ant-x/);
    assert.match(report.message, /in ~\/project/);
    assert.equal(listCrashReports().length, 1);
  } finally {
    delete process.env.SYNAPSE_HOME;
  }
});

test("the core has no telemetry: no telemetry methods and nothing written to the user's home", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-home-"));
  process.env.SYNAPSE_HOME = home;
  const core = await SynapseCore.open({ workspace: makeRepo(SHOP), ephemeral: true });
  try {
    await core.agents.add({ preset: "mock", id: "alpha" });
    assert.ok(!Object.keys(core.handlers()).some((m) => m.startsWith("telemetry.")));
    assert.deepEqual(fs.readdirSync(home), []);
  } finally {
    await core.close();
    delete process.env.SYNAPSE_HOME;
  }
});
