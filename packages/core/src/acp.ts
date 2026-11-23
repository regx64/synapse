import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { ErrorCodes, JsonRpcPeer, RpcError } from "@synapse/protocol";

/**
 * Client side of the Agent Client Protocol (https://agentclientprotocol.com),
 * protocol version 1. Synapse is the "client" (editor); each agent process is
 * an ACP "agent" speaking JSON-RPC over stdio.
 *
 * This file is the adapter layer for risk T3: everything that depends on the
 * exact shape of ACP messages lives here and in AgentManager's handlers.
 */

export const ACP_PROTOCOL_VERSION = 1;

export interface AcpContentBlock {
  type: string;
  text?: string;
  [k: string]: unknown;
}

export interface AcpToolCallLocation {
  path: string;
  line?: number;
}

export interface AcpToolCallUpdate {
  sessionUpdate: "tool_call" | "tool_call_update";
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  locations?: AcpToolCallLocation[];
  rawInput?: unknown;
  content?: unknown;
}

export interface AcpPlanUpdate {
  sessionUpdate: "plan";
  entries: { content: string; status: "pending" | "in_progress" | "completed"; priority?: "high" | "medium" | "low" }[];
}

export type AcpSessionUpdate =
  | { sessionUpdate: "agent_message_chunk" | "user_message_chunk" | "agent_thought_chunk"; content: AcpContentBlock }
  | AcpToolCallUpdate
  | AcpPlanUpdate
  | { sessionUpdate: string; [k: string]: unknown };

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: { toolCallId: string; title?: string; kind?: string; rawInput?: unknown; locations?: AcpToolCallLocation[] };
  options: { optionId: string; name: string; kind: string }[];
}

export type AcpPermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

/** Requests the agent makes of Synapse. */
/** An MCP server the agent should start (ACP McpServerStdio). */
export interface AcpMcpServerStdio {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

export interface AcpClientHandlers {
  readTextFile(params: { sessionId: string; path: string; line?: number; limit?: number }): Promise<{ content: string }>;
  writeTextFile(params: { sessionId: string; path: string; content: string }): Promise<null>;
  requestPermission(params: AcpPermissionRequest): Promise<{ outcome: AcpPermissionOutcome }>;
  sessionUpdate(params: { sessionId: string; update: AcpSessionUpdate }): void;
}

export interface AcpAgentOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  clientVersion: string;
  /** Name used in errors and logs. */
  label: string;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: Record<string, unknown>;
  agentInfo?: { name?: string; version?: string; title?: string };
  authMethods?: { id: string; name: string; description?: string }[];
}

export class AcpAgentProcess extends EventEmitter {
  private child?: ChildProcess;
  private peer?: JsonRpcPeer;
  sessionId?: string;
  initResult?: InitializeResult;

  constructor(
    private readonly opts: AcpAgentOptions,
    private readonly handlers: AcpClientHandlers,
  ) {
    super();
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  async start(mcpServers: AcpMcpServerStdio[] = []): Promise<{ sessionId: string; init: InitializeResult }> {
    const child = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      // Own process group, so stopping the agent also stops what its launcher
      // started (npx runs the real adapter binary as a child).
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.child = child;
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (err) => reject(new Error(`${this.opts.label}: failed to start \`${this.opts.command}\`: ${err.message}`)));
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => this.emit("stderr", d));
    child.on("exit", (code, signal) => {
      this.peer?.close(new Error(`${this.opts.label}: agent exited (${signal ?? code})`));
      this.emit("exit", code, signal);
    });
    await spawned;

    const peer = new JsonRpcPeer(child.stdout!, child.stdin!, { name: this.opts.label });
    this.peer = peer;
    peer.on("protocolError", (err: Error) => this.emit("stderr", `${err.message}\n`));

    peer.onRequest("fs/read_text_file", (p) => this.handlers.readTextFile(p));
    peer.onRequest("fs/write_text_file", (p) => this.handlers.writeTextFile(p));
    peer.onRequest("session/request_permission", (p) => this.handlers.requestPermission(p));
    peer.onNotification("session/update", (p) => this.handlers.sessionUpdate(p));
    peer.onAnyRequest((_p, { method }) => {
      throw new RpcError(ErrorCodes.MethodNotFound, `Synapse does not support ${method}`);
    });

    const init = await peer.request<InitializeResult>(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        clientInfo: { name: "synapse", title: "Synapse", version: this.opts.clientVersion },
      },
      { timeoutMs: 120_000 },
    );
    this.initResult = init;

    let session: { sessionId: string };
    try {
      session = await peer.request<{ sessionId: string }>("session/new", { cwd: this.opts.cwd, mcpServers }, { timeoutMs: 120_000 });
    } catch (err) {
      if (err instanceof RpcError && err.code === ErrorCodes.AuthRequired) {
        const methods = (init.authMethods ?? []).map((m) => m.name).join(", ");
        throw new Error(
          `${this.opts.label} needs authentication${methods ? ` (${methods})` : ""}. Log in with the agent's own CLI, then restart the agent.`,
        );
      }
      throw err;
    }
    this.sessionId = session.sessionId;
    return { sessionId: session.sessionId, init };
  }

  /** Runs one prompt turn. Resolves with the stop reason when the turn ends. */
  async prompt(text: string): Promise<string> {
    if (!this.peer || !this.sessionId) throw new Error(`${this.opts.label}: not started`);
    const r = await this.peer.request<{ stopReason: string }>("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });
    return r?.stopReason ?? "end_turn";
  }

  cancel(): void {
    if (this.peer && this.sessionId) this.peer.notify("session/cancel", { sessionId: this.sessionId });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || !this.running) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => killTree(child, "SIGKILL"), 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        // Children of the launcher may outlive it; end the whole group.
        killTree(child, "SIGKILL");
        resolve();
      });
      child.stdin?.end();
      killTree(child, "SIGTERM");
    });
  }
}

/** Signals a process and everything in its process group (Unix) or tree (Windows). */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    // Already gone.
  }
}
