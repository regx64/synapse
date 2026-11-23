import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { CoreEvent, CoreMethodName, DiscoveryFile, HelloResult, ParamsOf, ResultOf } from "@synapse/protocol";
import { DISCOVERY_DIR, DISCOVERY_FILE, JsonRpcPeer } from "@synapse/protocol";

export * from "@synapse/protocol";

/**
 * Finds the main repository root for a directory. Directories inside an
 * agent worktree (`<repo>/.synapse/worktrees/<id>`) map to the main repo,
 * because that is where the core's discovery file lives.
 */
export function findRepoRoot(dir: string): string | undefined {
  let current = path.resolve(dir);
  const marker = `${path.sep}${DISCOVERY_DIR}${path.sep}`;
  const idx = current.indexOf(marker);
  if (idx >= 0) current = current.slice(0, idx);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function readDiscovery(repoRoot: string): DiscoveryFile | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, DISCOVERY_DIR, DISCOVERY_FILE), "utf8")) as DiscoveryFile;
  } catch {
    return undefined;
  }
}

export interface ConnectOptions {
  /** Any directory inside the repository. */
  workspace: string;
  clientName?: string;
  timeoutMs?: number;
}

export interface StartOptions extends ConnectOptions {
  /** Path to synapse-core's main.js. */
  coreMain: string;
  /** Node binary used to run the core. Default: process.execPath. */
  nodePath?: string;
  /** Extra environment for the core (e.g. ELECTRON_RUN_AS_NODE=1 inside Electron). */
  env?: Record<string, string>;
  startTimeoutMs?: number;
}

export class SynapseClient extends EventEmitter {
  private lastSeq = 0;

  private constructor(
    private readonly peer: JsonRpcPeer,
    readonly hello: HelloResult,
  ) {
    super();
    peer.onNotification("event", (ev: CoreEvent) => {
      this.lastSeq = Math.max(this.lastSeq, ev.seq);
      this.emit("event", ev);
    });
    peer.on("close", (err: Error) => this.emit("close", err));
  }

  /** Connects to the core serving `workspace`. Throws if none is running. */
  static async connect(opts: ConnectOptions): Promise<SynapseClient> {
    const repoRoot = findRepoRoot(opts.workspace);
    if (!repoRoot) throw new Error(`${opts.workspace} is not inside a git repository`);
    const disc = readDiscovery(repoRoot);
    if (!disc) throw new Error(`synapse-core is not running for ${repoRoot}`);
    const socket = await connectSocket(disc.socket, opts.timeoutMs ?? 5000);
    const peer = new JsonRpcPeer(socket, socket, { name: "synapse-core", timeoutMs: 0 });
    socket.on("error", () => peer.close());
    const hello = await peer.request<HelloResult>("session.hello", { token: disc.token, client: opts.clientName ?? "synapse-client" }, { timeoutMs: opts.timeoutMs ?? 5000 });
    return new SynapseClient(peer, hello);
  }

  /** Connects, starting a detached core first if none is running. */
  static async connectOrStart(opts: StartOptions): Promise<SynapseClient> {
    try {
      return await SynapseClient.connect(opts);
    } catch {
      /* start one */
    }
    const repoRoot = findRepoRoot(opts.workspace);
    if (!repoRoot) throw new Error(`${opts.workspace} is not inside a git repository`);
    const child = spawn(opts.nodePath ?? process.execPath, [opts.coreMain, "--workspace", repoRoot, "--quiet"], {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ...opts.env },
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    let exited: number | null | undefined;
    child.on("exit", (code) => (exited = code));
    const deadline = Date.now() + (opts.startTimeoutMs ?? 20_000);
    let lastErr: unknown;
    while (Date.now() < deadline) {
      if (exited !== undefined) throw new Error(`synapse-core exited with code ${exited}: ${stderr.trim()}`);
      try {
        const client = await SynapseClient.connect({ ...opts, timeoutMs: 1000 });
        child.stderr?.destroy();
        child.unref();
        return client;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    throw new Error(`synapse-core did not start in time: ${(lastErr as Error)?.message ?? "unknown"} ${stderr.trim()}`);
  }

  call<M extends CoreMethodName>(method: M, ...params: ParamsOf<M> extends void ? [] : [ParamsOf<M>]): Promise<ResultOf<M>> {
    return this.peer.request<ResultOf<M>>(method, params[0] ?? {});
  }

  /** Starts receiving `event` notifications. Pass a sequence number to replay what was missed. */
  async subscribe(sinceSeq?: number): Promise<void> {
    const r = await this.peer.request<{ seq: number; backlog: CoreEvent[] }>("events.subscribe", { sinceSeq });
    for (const ev of r.backlog) {
      this.lastSeq = Math.max(this.lastSeq, ev.seq);
      this.emit("event", ev);
    }
    this.lastSeq = Math.max(this.lastSeq, r.seq);
  }

  get seq(): number {
    return this.lastSeq;
  }

  get closed(): boolean {
    return this.peer.isClosed;
  }

  close(): void {
    this.peer.close();
  }
}

function connectSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(socketPath);
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error(`timed out connecting to ${socketPath}`));
    }, timeoutMs);
    s.once("connect", () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
