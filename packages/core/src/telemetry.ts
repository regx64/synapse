import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TelemetryEvent, TelemetryStatus } from "@synapse/protocol";
import { CORE_API_VERSION } from "@synapse/protocol";
import { scrubForReport } from "./redact.js";
import { nowIso } from "./util.js";

/**
 * Opt-in telemetry and crash reports (phase 4).
 *
 * Off by default. While off, nothing is recorded at all. When on, only
 * counts and enums are recorded (never code, paths, prompts, messages or
 * agent output), and they are sent only if an endpoint is configured. The
 * preference is per user, shared by every repository.
 */

const QUEUE_LIMIT = 1000;
const FLUSH_MS = 15 * 60 * 1000;

interface Prefs {
  enabled: boolean;
  endpoint: string;
  installId: string;
  sent: number;
}

export function synapseHome(): string {
  return process.env.SYNAPSE_HOME ?? path.join(os.homedir(), ".synapse-ide");
}

export class Telemetry {
  private prefs: Prefs;
  private queue: TelemetryEvent[] = [];
  private timer?: NodeJS.Timeout;
  readonly file: string;
  private readonly queueFile: string;

  constructor(dir = synapseHome()) {
    this.file = path.join(dir, "telemetry.json");
    this.queueFile = path.join(dir, "telemetry-queue.json");
    this.prefs = { enabled: false, endpoint: "", installId: randomUUID(), sent: 0 };
    try {
      this.prefs = { ...this.prefs, ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
    } catch {
      /* first run */
    }
    try {
      this.queue = this.prefs.enabled ? JSON.parse(fs.readFileSync(this.queueFile, "utf8")) : [];
    } catch {
      this.queue = [];
    }
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  status(): TelemetryStatus {
    return {
      enabled: this.prefs.enabled,
      endpoint: this.prefs.endpoint,
      installId: this.prefs.installId,
      queued: this.queue.length,
      sent: this.prefs.sent,
      crashReports: listCrashReports().length,
      file: this.file,
    };
  }

  setEnabled(enabled: boolean, endpoint?: string): TelemetryStatus {
    this.prefs.enabled = enabled;
    if (endpoint !== undefined) {
      if (endpoint && !/^https:\/\//.test(endpoint)) throw new Error("The telemetry endpoint must be an https:// URL");
      this.prefs.endpoint = endpoint;
    }
    if (!enabled) this.queue = [];
    this.save();
    return this.status();
  }

  /** Records an event when the user opted in; a no-op otherwise. */
  record(name: string, props: TelemetryEvent["props"] = {}): void {
    if (!this.prefs.enabled) return;
    this.queue.push({ name, at: nowIso(), props });
    if (this.queue.length > QUEUE_LIMIT) this.queue.splice(0, this.queue.length - QUEUE_LIMIT);
    this.saveQueue();
  }

  preview(): TelemetryEvent[] {
    return [...this.queue];
  }

  /** The exact payload a flush sends. */
  payload(): { installId: string; version: string; platform: string; arch: string; events: TelemetryEvent[] } {
    return { installId: this.prefs.installId, version: CORE_API_VERSION, platform: process.platform, arch: process.arch, events: this.preview() };
  }

  async flush(): Promise<number> {
    if (!this.prefs.enabled || !this.prefs.endpoint || !this.queue.length) return 0;
    const body = this.payload();
    try {
      const res = await fetch(this.prefs.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return 0;
      this.queue = this.queue.slice(body.events.length);
      this.prefs.sent += body.events.length;
      this.save();
      return body.events.length;
    } catch {
      return 0;
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.prefs, null, 2), { mode: 0o600 });
      this.saveQueue();
    } catch {
      /* best effort */
    }
  }

  private saveQueue(): void {
    try {
      fs.mkdirSync(path.dirname(this.queueFile), { recursive: true });
      fs.writeFileSync(this.queueFile, JSON.stringify(this.queue), { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Crash reports: always written locally (redacted); sent only with telemetry on.

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
