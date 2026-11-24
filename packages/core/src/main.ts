#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { SynapseCore } from "./core.js";
import { serve } from "./server.js";
import { writeCrashReport } from "./crash.js";
import { redact } from "./redact.js";

/**
 * synapse-core entry point. Runs in the foreground; UIs spawn it detached.
 *
 *   synapse-core [--workspace <dir>] [--socket <path>] [--base <branch>]
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      workspace: { type: "string", short: "w" },
      socket: { type: "string" },
      base: { type: "string" },
      quiet: { type: "boolean", short: "q" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write("Usage: synapse-core [--workspace <dir>] [--socket <path>] [--base <branch>] [--quiet]\n");
    return;
  }

  let logStream: fs.WriteStream | undefined;
  const log = (msg: string) => {
    const line = `${new Date().toISOString()} ${redact(msg)}\n`;
    if (!values.quiet) process.stderr.write(line);
    logStream?.write(line);
  };

  const core = await SynapseCore.open({ workspace: path.resolve(values.workspace ?? process.cwd()), baseRef: values.base, log });
  fs.mkdirSync(path.join(core.repoRoot, ".synapse"), { recursive: true });
  logStream = fs.createWriteStream(path.join(core.repoRoot, ".synapse", "core.log"), { flags: "a" });
  logStream.on("error", () => (logStream = undefined));
  const server = await serve(core, { socket: values.socket });
  process.stdout.write(JSON.stringify({ ready: true, socket: server.socket, repoRoot: core.repoRoot, pid: process.pid }) + "\n");

  let stopping = false;
  const shutdown = async (why: string) => {
    if (stopping) return;
    stopping = true;
    log(`shutting down (${why})`);
    await server.close().catch(() => {});
    await core.close().catch(() => {});
    logStream?.end();
    process.exit(0);
  };
  core.store.on("shutdown", () => void shutdown("requested"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Crash reports are written locally (redacted) and never sent.
process.on("uncaughtException", (err) => {
  const file = writeCrashReport(err, "uncaughtException");
  process.stderr.write(`synapse-core crashed: ${err.message}${file ? ` (report: ${file})` : ""}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  writeCrashReport(err, "unhandledRejection");
  process.stderr.write(`synapse-core: unhandled rejection: ${(err as Error)?.message ?? String(err)}\n`);
});

main().catch((err: Error) => {
  process.stderr.write(`synapse-core: ${err.message}\n`);
  process.exit(1);
});
