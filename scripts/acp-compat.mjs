#!/usr/bin/env node
// Nightly ACP compatibility check (risk T3): starts each pinned agent adapter
// and checks that it still speaks ACP v1 (initialize, and session/new when
// credentials are available). Never sends a prompt, so it costs nothing.
//   node scripts/acp-compat.mjs [preset...]
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JsonRpcPeer } from "@synapse/protocol";
import { listPresets } from "@synapse/core";
import { killTree } from "@synapse/core/acp";

const wanted = process.argv.slice(2);
const presets = listPresets({}).filter((p) => (wanted.length ? wanted.includes(p.id) : ["claude", "codex", "mock"].includes(p.id)));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-acp-"));
const results = [];

for (const p of presets) {
  const started = Date.now();
  const child = spawn(p.command, p.args, { cwd, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32", detached: process.platform !== "win32" });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const peer = new JsonRpcPeer(child.stdout, child.stdin, { name: p.id, timeoutMs: 180_000 });
  const r = { preset: p.id, command: `${p.command} ${p.args.join(" ")}` };
  try {
    const init = await peer.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: "synapse-compat", version: "0.1.0" },
    });
    r.protocolVersion = init.protocolVersion;
    r.agent = init.agentInfo ? `${init.agentInfo.name} ${init.agentInfo.version ?? ""}`.trim() : undefined;
    r.authMethods = (init.authMethods ?? []).map((m) => m.id);
    r.initialize = init.protocolVersion === 1 ? "ok" : `unexpected protocol version ${init.protocolVersion}`;
    try {
      const s = await peer.request("session/new", { cwd, mcpServers: [] }, { timeoutMs: 60_000 });
      r.sessionNew = s?.sessionId ? "ok" : "no sessionId";
    } catch (err) {
      r.sessionNew = err.code === -32000 ? "auth required (expected without credentials)" : `error: ${err.message}`;
    }
  } catch (err) {
    r.initialize = `failed: ${err.message}`;
    r.stderr = stderr.slice(-800);
  } finally {
    r.seconds = Math.round((Date.now() - started) / 1000);
    peer.close();
    killTree(child, "SIGKILL");
  }
  results.push(r);
  console.log(JSON.stringify(r));
}
fs.rmSync(cwd, { recursive: true, force: true });
const broken = results.filter((r) => r.initialize !== "ok" || (r.sessionNew && r.sessionNew.startsWith("error")));
if (broken.length) {
  console.error(`ACP compatibility broken for: ${broken.map((r) => r.preset).join(", ")}`);
  process.exit(1);
}
process.exit(0);
