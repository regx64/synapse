import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { CoreEvent, DiscoveryFile } from "@synapse/protocol";
import { CORE_API_VERSION, DISCOVERY_DIR, DISCOVERY_FILE, ErrorCodes, JsonRpcPeer, RpcError } from "@synapse/protocol";
import type { SynapseCore } from "./core.js";
import { addSecret } from "./redact.js";
import { nowIso, shortHash } from "./util.js";

export function defaultSocketPath(repoRoot: string): string {
  const id = shortHash(repoRoot, 12);
  if (process.platform === "win32") return `\\\\.\\pipe\\synapse-${id}`;
  // Unix socket paths are limited to ~104 bytes, so they live in the temp dir, not the repo.
  return path.join(os.tmpdir(), `synapse-${id}.sock`);
}

export interface ServerHandle {
  socket: string;
  token: string;
  discoveryFile: string;
  connections(): number;
  close(): Promise<void>;
}

/**
 * Serves the core API on a local socket. Every connection must call
 * `session.hello` with the token from the discovery file before anything
 * else; the discovery file and the socket are readable by the owner only.
 */
export async function serve(core: SynapseCore, opts: { socket?: string } = {}): Promise<ServerHandle> {
  const socket = opts.socket ?? defaultSocketPath(core.repoRoot);
  const token = randomBytes(24).toString("hex");
  addSecret(token);
  const handlers = core.handlers() as Record<string, (p: unknown) => unknown>;
  const peers = new Set<JsonRpcPeer>();

  if (process.platform !== "win32" && fs.existsSync(socket)) {
    if (await isAlive(socket)) throw new Error(`Another synapse-core is already serving ${core.repoRoot} on ${socket}`);
    fs.rmSync(socket, { force: true });
  }

  core.socket = socket;
  const server = net.createServer((conn) => {
    const peer = new JsonRpcPeer(conn, conn, { name: "client" });
    peers.add(peer);
    let authed = false;
    let agentId: string | undefined;
    let subscribed = false;
    const onEvent = (ev: CoreEvent) => {
      if (subscribed) peer.notify("event", ev);
    };
    core.store.on("event", onEvent);
    peer.on("close", () => {
      peers.delete(peer);
      core.store.off("event", onEvent);
      conn.destroy();
    });
    conn.on("error", () => peer.close());

    peer.onRequest("session.hello", (p: { token?: string; client?: string }) => {
      if (!p?.token || !safeEqual(p.token, token)) throw new RpcError(ErrorCodes.Unauthorized, "Invalid token");
      authed = true;
      core.log(`client connected: ${p.client ?? "unknown"}`);
      return { version: CORE_API_VERSION, repoRoot: core.repoRoot, baseRef: core.store.baseRef, pid: process.pid };
    });
    // Agents' MCP servers authenticate with an agent token and get only the agent API.
    peer.onRequest("agent.hello", (p: { agentToken?: string }) => {
      if (authed) throw new RpcError(ErrorCodes.Unauthorized, "Already authenticated");
      const id = p?.agentToken ? core.agentForToken(p.agentToken) : undefined;
      if (!id) throw new RpcError(ErrorCodes.Unauthorized, "Invalid agent token");
      agentId = id;
      return { agentId: id, agentName: core.store.getAgent(id)?.name ?? id };
    });
    peer.onRequest("events.subscribe", (p: { sinceSeq?: number }) => {
      if (!authed) throw new RpcError(ErrorCodes.Unauthorized, "Call session.hello first");
      subscribed = true;
      const backlog = typeof p?.sinceSeq === "number" ? core.store.eventsSince(p.sinceSeq) : [];
      return { seq: core.store.currentSeq, backlog };
    });
    peer.onRequest("events.unsubscribe", () => {
      subscribed = false;
      return null;
    });
    peer.onAnyRequest(async (params, { method }) => {
      if (agentId) {
        const h = (core.agentHandlers(agentId) as Record<string, (p: unknown) => unknown>)[method];
        if (!h) throw new RpcError(ErrorCodes.Unauthorized, `Agents cannot call ${method}`);
        return h(params ?? {});
      }
      if (!authed) throw new RpcError(ErrorCodes.Unauthorized, "Call session.hello first");
      const h = handlers[method];
      if (!h) throw new RpcError(ErrorCodes.MethodNotFound, `Unknown method: ${method}`);
      return h(params ?? {});
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") fs.chmodSync(socket, 0o600);

  const discoveryFile = path.join(core.repoRoot, DISCOVERY_DIR, DISCOVERY_FILE);
  fs.mkdirSync(path.dirname(discoveryFile), { recursive: true });
  const discovery: DiscoveryFile = { pid: process.pid, socket, token, version: CORE_API_VERSION, startedAt: nowIso() };
  fs.writeFileSync(discoveryFile, JSON.stringify(discovery, null, 2), { mode: 0o600 });
  core.log(`serving ${core.repoRoot} on ${socket}`);

  return {
    socket,
    token,
    discoveryFile,
    connections: () => peers.size,
    close: async () => {
      for (const p of peers) p.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        const current = JSON.parse(fs.readFileSync(discoveryFile, "utf8")) as DiscoveryFile;
        if (current.pid === process.pid && current.token === token) fs.rmSync(discoveryFile, { force: true });
      } catch {
        /* already gone */
      }
      if (process.platform !== "win32") fs.rmSync(socket, { force: true });
    },
  };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function isAlive(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(socket);
    c.once("connect", () => {
      c.destroy();
      resolve(true);
    });
    c.once("error", () => resolve(false));
  });
}
