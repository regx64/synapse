import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Telemetry, listCrashReports, writeCrashReport } from "../src/telemetry.js";

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

test("telemetry preference persists per user and nothing is recorded while off", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-tel-"));
  const t = new Telemetry(dir);
  t.record("x");
  assert.equal(t.preview().length, 0);
  t.setEnabled(true);
  t.record("agent.added", { preset: "claude" });
  t.close();
  const again = new Telemetry(dir);
  assert.equal(again.status().enabled, true);
  assert.equal(again.preview().length, 1, "queue survives restarts");
  assert.equal(again.status().installId, t.status().installId);
  again.setEnabled(false);
  assert.equal(again.preview().length, 0);
  again.close();
});
