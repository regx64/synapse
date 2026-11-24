import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CORE_API_VERSION } from "@synapse/protocol";
import { scrubForReport } from "./redact.js";
import { nowIso } from "./util.js";

/**
 * Synapse collects no telemetry and sends nothing about its users: no usage
 * events, no install id, no crash uploads. The only thing kept is a local,
 * redacted crash report when the core itself crashes, for the user to read or
 * attach to a bug report by hand.
 */

export function synapseHome(): string {
  return process.env.SYNAPSE_HOME ?? path.join(os.homedir(), ".synapse-ide");
}

// ---------------------------------------------------------------------------
// Crash reports: written on this machine only (redacted). Never sent anywhere.

export function crashDir(): string {
  return path.join(synapseHome(), "crash-reports");
}

export function listCrashReports(): string[] {
  try {
    return fs.readdirSync(crashDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

export function writeCrashReport(err: unknown, kind: "uncaughtException" | "unhandledRejection"): string | undefined {
  const e = err instanceof Error ? err : new Error(String(err));
  const report = {
    kind,
    at: nowIso(),
    version: CORE_API_VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    name: e.name,
    message: scrubForReport(e.message),
    stack: scrubForReport(e.stack ?? ""),
  };
  try {
    fs.mkdirSync(crashDir(), { recursive: true });
    const file = path.join(crashDir(), `${report.at.replace(/[:.]/g, "-")}-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
    // Keep the newest 50.
    const all = listCrashReports().sort();
    for (const old of all.slice(0, Math.max(0, all.length - 50))) fs.rmSync(path.join(crashDir(), old), { force: true });
    return file;
  } catch {
    return undefined;
  }
}
