import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { AddAgentParams, AgentState, Approval, PresetInfo, ToolCallSummary } from "@synapse/protocol";
import { CORE_API_VERSION, ErrorCodes, RpcError } from "@synapse/protocol";
import { AcpAgentProcess, type AcpPermissionOutcome, type AcpPermissionRequest, type AcpPlanUpdate, type AcpSessionUpdate, type AcpToolCallUpdate } from "./acp.js";
import type { StateStore } from "./store.js";
import type { WorktreeManager } from "./worktrees.js";
import { AGENT_COLORS, AGENT_ID_RE, debounce, isInside, nowIso, randomId, toPosix, truncateTail } from "./util.js";
import { revParse } from "./git.js";

const MAX_TOOL_CALLS = 30;
const MAX_MESSAGE_TAIL = 4000;

export interface AgentManagerDeps {
  store: StateStore;
  worktrees: WorktreeManager;
  presets: () => PresetInfo[];
  /** Called when an agent's files may have changed. */
  onFilesChanged: (agentId: string) => void;
  log: (msg: string) => void;
}

/**
 * Agent lifecycle (add, start, stop, restart, remove) and the ACP client
 * handlers: file access confined to the agent's worktree, permission requests
 * routed to the person as approvals, and session updates mapped to state.
 */
export class AgentManager {
  private readonly procs = new Map<string, AcpAgentProcess>();
  private readonly pendingPermissions = new Map<string, { agentId: string; resolve: (o: AcpPermissionOutcome) => void; options: Approval["options"] }>();
  private readonly watchers = new Map<string, fs.FSWatcher>();

  constructor(private readonly deps: AgentManagerDeps) {}

  private get store(): StateStore {
    return this.deps.store;
  }

  private require(id: string) {
    const a = this.store.getAgent(id);
    if (!a) throw new RpcError(ErrorCodes.NotFound, `No agent with id "${id}"`);
    return a;
  }

  async add(params: AddAgentParams): Promise<AgentState> {
    const presets = this.deps.presets();
    const preset = params.preset ? presets.find((p) => p.id === params.preset) : undefined;
    if (params.preset && !preset) throw new RpcError(ErrorCodes.InvalidParams, `Unknown preset "${params.preset}". Known: ${presets.map((p) => p.id).join(", ")}`);
    const command = params.command ?? preset?.command;
    if (!command) throw new RpcError(ErrorCodes.InvalidParams, "Give a preset or a command");

    const existing = new Set(this.store.listAgents().map((a) => a.id));
    let id = params.id ?? preset?.id ?? "agent";
    if (!params.id) {
      const base = id;
      for (let n = 2; existing.has(id); n++) id = `${base}-${n}`;
    }
    if (!AGENT_ID_RE.test(id)) throw new RpcError(ErrorCodes.InvalidParams, `Invalid agent id "${id}": use lowercase letters, digits and dashes`);
    if (existing.has(id)) throw new RpcError(ErrorCodes.Conflict, `Agent "${id}" already exists`);

    const usedColors = new Set(this.store.listAgents().map((a) => a.color));
    const color =
      params.color ??
      (preset && !usedColors.has(preset.color) ? preset.color : AGENT_COLORS.find((c) => !usedColors.has(c)) ?? AGENT_COLORS[existing.size % AGENT_COLORS.length]!);

    const worktree = await this.deps.worktrees.create(id, this.store.baseRef);
    const now = nowIso();
    const agent = this.store.addAgent(
      {
        id,
        name: params.name ?? (preset ? (id === preset.id ? preset.name : `${preset.name} ${id.slice(preset.id.length + 1)}`) : id),
        color,
        preset: preset?.id,
        command,
        args: params.args ?? preset?.args ?? [],
        status: "stopped",
        worktree,
        toolCalls: [],
        createdAt: now,
        updatedAt: now,
      },
      params.env,
    );
    this.deps.log(`agent ${id} added (worktree ${worktree.path})`);
    if (params.start) return this.start(id);
    return agent;
  }

  async remove(id: string, keepWorktree = false): Promise<void> {
    this.require(id);
    await this.stop(id);
    if (!keepWorktree) await this.deps.worktrees.remove(id, { deleteBranch: true });
    this.store.removeAgent(id);
  }

  async start(id: string): Promise<AgentState> {
    const agent = this.require(id);
    if (this.procs.get(id)?.running) return this.store.listAgents().find((a) => a.id === id)!;
    if (!fs.existsSync(agent.worktree.path)) {
      // The worktree was removed outside Synapse; recreate it.
      const wt = await this.deps.worktrees.create(id, agent.worktree.baseRef);
      this.store.updateAgent(id, { worktree: wt });
    }
    this.store.updateAgent(id, { status: "starting", error: undefined });
    const proc = new AcpAgentProcess(
      {
        command: agent.command,
        args: agent.args,
        cwd: agent.worktree.path,
        env: { ...this.store.getAgentEnv(id), SYNAPSE_AGENT_ID: id },
        clientVersion: CORE_API_VERSION,
        label: agent.name,
      },
      {
        readTextFile: (p) => this.readTextFile(id, p),
        writeTextFile: (p) => this.writeTextFile(id, p),
        requestPermission: (p) => this.requestPermission(id, p),
        sessionUpdate: (p) => this.onSessionUpdate(id, p.update),
      },
    );
    this.procs.set(id, proc);
    proc.on("stderr", (text: string) => this.store.emitEvent("agent.output", { agentId: id, kind: "stderr", text }));
    proc.on("exit", (code: number | null, signal: string | null) => {
      if (this.procs.get(id) !== proc) return;
      this.procs.delete(id);
      this.cancelPermissions(id);
      this.unwatch(id);
      const a = this.store.getAgent(id);
      if (!a) return;
      const clean = code === 0 || signal === "SIGTERM";
      this.store.updateAgent(id, {
        status: clean ? "stopped" : "error",
        sessionId: undefined,
        error: clean ? undefined : `Agent exited (${signal ?? `code ${code}`})`,
      });
    });
    try {
      const { sessionId, init } = await proc.start();
      this.watch(id, agent.worktree.path);
      return this.store.updateAgent(id, {
        status: "idle",
        sessionId,
        agentInfo: init.agentInfo ? { name: init.agentInfo.name, version: init.agentInfo.version } : undefined,
      })!;
    } catch (err) {
      this.procs.delete(id);
      await proc.stop().catch(() => {});
      this.store.updateAgent(id, { status: "error", error: (err as Error).message });
      throw new RpcError(ErrorCodes.InternalError, (err as Error).message);
    }
  }

  async stop(id: string): Promise<AgentState> {
    this.require(id);
    const proc = this.procs.get(id);
    this.procs.delete(id);
    this.cancelPermissions(id);
    this.unwatch(id);
    if (proc) await proc.stop();
    return this.store.updateAgent(id, { status: "stopped", sessionId: undefined })!;
  }

  async restart(id: string): Promise<AgentState> {
    await this.stop(id);
    return this.start(id);
  }

  prompt(id: string, text: string): void {
    const agent = this.require(id);
    const proc = this.procs.get(id);
    if (!proc?.running) throw new RpcError(ErrorCodes.Conflict, `Agent "${id}" is not running. Start it first.`);
    if (agent.status === "working" || agent.status === "awaiting-approval") {
      throw new RpcError(ErrorCodes.Conflict, `Agent "${id}" is busy with another turn`);
    }
    this.store.updateAgent(id, { status: "working", turn: { prompt: text, startedAt: nowIso() }, lastMessage: "", plan: undefined, error: undefined });
    this.store.emitEvent("agent.output", { agentId: id, kind: "turn", text: `> ${text}` });
    proc.prompt(text).then(
      (stopReason) => this.endTurn(id, proc, stopReason),
      (err: Error) => this.endTurn(id, proc, "error", err.message),
    );
  }

  private endTurn(id: string, proc: AcpAgentProcess, stopReason: string, error?: string): void {
    const agent = this.store.getAgent(id);
    if (!agent || this.procs.get(id) !== proc) return;
    this.store.updateAgent(id, {
      status: proc.running ? "idle" : "stopped",
      turn: agent.turn ? { ...agent.turn, endedAt: nowIso(), stopReason } : undefined,
      error,
    });
    this.store.emitEvent("agent.output", { agentId: id, kind: "turn", text: `turn ended: ${stopReason}${error ? ` (${error})` : ""}` });
    this.deps.onFilesChanged(id);
  }

  cancel(id: string): void {
    this.require(id);
    this.procs.get(id)?.cancel();
    this.cancelPermissions(id);
  }

  /** Discards the agent's worktree changes and moves it to `ref` (default: current base). */
  async reset(id: string, ref?: string): Promise<AgentState> {
    const agent = this.require(id);
    if (agent.status === "working" || agent.status === "awaiting-approval") throw new RpcError(ErrorCodes.Conflict, `Agent "${id}" is busy`);
    const target = await revParse(this.store.repoRoot, ref ?? this.store.baseRef);
    await this.deps.worktrees.resetTo(id, target);
    const updated = this.store.updateAgent(id, { worktree: { ...agent.worktree, baseCommit: target, baseRef: ref ?? this.store.baseRef } })!;
    this.deps.onFilesChanged(id);
    return updated;
  }

  resolveApproval(approvalId: string, optionId?: string, reject?: boolean): Approval {
    const approval = this.store.getApproval(approvalId);
    if (!approval) throw new RpcError(ErrorCodes.NotFound, `No approval "${approvalId}"`);
    if (approval.status !== "pending") throw new RpcError(ErrorCodes.Conflict, `Approval "${approvalId}" is already ${approval.status}`);
    const pending = this.pendingPermissions.get(approvalId);
    let chosen = optionId;
    if (!chosen) {
      const want = reject ? "reject" : "allow";
      chosen = (approval.options.find((o) => o.kind === `${want}_once`) ?? approval.options.find((o) => o.kind.startsWith(want)))?.optionId;
    }
    if (chosen && !approval.options.some((o) => o.optionId === chosen)) throw new RpcError(ErrorCodes.InvalidParams, `Unknown option "${chosen}"`);
    this.pendingPermissions.delete(approvalId);
    pending?.resolve(chosen ? { outcome: "selected", optionId: chosen } : { outcome: "cancelled" });
    const resolved = this.store.resolveApproval(approvalId, chosen ? "resolved" : "cancelled", { optionId: chosen, by: "human", at: nowIso() })!;
    this.refreshApprovalStatus(approval.agentId);
    return resolved;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.procs.keys()].map((id) => this.stop(id).catch(() => {})));
  }

  isRunning(id: string): boolean {
    return !!this.procs.get(id)?.running;
  }

  // -------------------------------------------------------------------------
  // ACP client handlers

  private resolveAgentPath(agentId: string, p: string): string {
    const agent = this.require(agentId);
    const abs = path.isAbsolute(p) ? p : path.join(agent.worktree.path, p);
    if (!isInside(agent.worktree.path, abs)) {
      throw new RpcError(ErrorCodes.InvalidParams, `Access denied: ${p} is outside this agent's worktree (${agent.worktree.path})`);
    }
    if (toPosix(path.relative(agent.worktree.path, abs)).split("/")[0] === ".git") {
      throw new RpcError(ErrorCodes.InvalidParams, "Access denied: .git is managed by Synapse");
    }
    return abs;
  }

  private async readTextFile(agentId: string, p: { path: string; line?: number; limit?: number }): Promise<{ content: string }> {
    const abs = this.resolveAgentPath(agentId, p.path);
    let content = await fsp.readFile(abs, "utf8");
    if (p.line !== undefined || p.limit !== undefined) {
      const lines = content.split("\n");
      const start = Math.max(0, (p.line ?? 1) - 1);
      content = lines.slice(start, p.limit !== undefined ? start + p.limit : undefined).join("\n");
    }
    return { content };
  }

  private async writeTextFile(agentId: string, p: { path: string; content: string }): Promise<null> {
    const abs = this.resolveAgentPath(agentId, p.path);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, p.content, "utf8");
    this.deps.onFilesChanged(agentId);
    return null;
  }

  private requestPermission(agentId: string, req: AcpPermissionRequest): Promise<{ outcome: AcpPermissionOutcome }> {
    const id = randomId("ap");
    const tc = req.toolCall ?? { toolCallId: "?" };
    const approval: Approval = {
      id,
      agentId,
      title: tc.title ?? tc.kind ?? "Permission requested",
      toolKind: tc.kind,
      detail: tc.rawInput,
      locations: tc.locations?.map((l) => l.path),
      options: (req.options ?? []).map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
      status: "pending",
      createdAt: nowIso(),
    };
    return new Promise((resolve) => {
      this.pendingPermissions.set(id, { agentId, resolve: (outcome) => resolve({ outcome }), options: approval.options });
      this.store.addApproval(approval);
      this.refreshApprovalStatus(agentId);
    });
  }

  private cancelPermissions(agentId: string): void {
    for (const [id, p] of this.pendingPermissions) {
      if (p.agentId !== agentId) continue;
      this.pendingPermissions.delete(id);
      p.resolve({ outcome: "cancelled" });
      this.store.resolveApproval(id, "cancelled", { by: "system", at: nowIso() });
    }
  }

  private refreshApprovalStatus(agentId: string): void {
    const agent = this.store.getAgent(agentId);
    if (!agent) return;
    const hasPending = [...this.pendingPermissions.values()].some((p) => p.agentId === agentId);
    if (hasPending && agent.status === "working") this.store.updateAgent(agentId, { status: "awaiting-approval" });
    else if (!hasPending && agent.status === "awaiting-approval") this.store.updateAgent(agentId, { status: "working" });
  }

  private onSessionUpdate(agentId: string, update: AcpSessionUpdate): void {
    const agent = this.store.getAgent(agentId);
    if (!agent || !update) return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const content = (update as { content?: { type?: string; text?: string } }).content;
        const text = content?.type === "text" ? (content.text ?? "") : "";
        if (!text) return;
        const kind = update.sessionUpdate === "agent_message_chunk" ? "message" : "thought";
        this.store.emitEvent("agent.output", { agentId, kind, text });
        if (kind === "message") this.patchQuietly(agentId, { lastMessage: truncateTail((agent.lastMessage ?? "") + text, MAX_MESSAGE_TAIL) });
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const u = update as AcpToolCallUpdate;
        const calls = [...agent.toolCalls];
        const idx = calls.findIndex((c) => c.id === u.toolCallId);
        const prev: ToolCallSummary | undefined = idx >= 0 ? calls[idx] : undefined;
        const next: ToolCallSummary = {
          id: u.toolCallId,
          title: u.title ?? prev?.title ?? "tool call",
          kind: u.kind ?? prev?.kind,
          status: u.status ?? prev?.status ?? "pending",
          locations: u.locations?.map((l) => l.path) ?? prev?.locations,
        };
        if (idx >= 0) calls[idx] = next;
        else calls.push(next);
        this.store.updateAgent(agentId, { toolCalls: calls.slice(-MAX_TOOL_CALLS) });
        if (!prev || prev.status !== next.status) {
          this.store.emitEvent("agent.output", { agentId, kind: "tool", text: `${next.status}: ${next.title}` });
        }
        if (next.status === "completed" && (next.kind === "edit" || next.kind === "delete" || next.kind === "move" || next.kind === "execute")) {
          this.deps.onFilesChanged(agentId);
        }
        return;
      }
      case "plan": {
        const u = update as AcpPlanUpdate;
        this.store.updateAgent(agentId, { plan: (u.entries ?? []).map((e) => ({ content: e.content, status: e.status, priority: e.priority })) });
        this.store.emitEvent("agent.output", { agentId, kind: "plan", text: (u.entries ?? []).map((e) => `[${e.status}] ${e.content}`).join("\n") });
        return;
      }
      default:
        return;
    }
  }

  /** Message chunks arrive at high rates: update state without one event per chunk. */
  private readonly quietFlush = new Map<string, ReturnType<typeof debounce>>();
  private patchQuietly(agentId: string, patch: Partial<AgentState>): void {
    const a = this.store.getAgent(agentId);
    if (!a) return;
    Object.assign(a, patch);
    let flush = this.quietFlush.get(agentId);
    if (!flush) {
      flush = debounce(() => this.store.updateAgent(agentId, {}), 500);
      this.quietFlush.set(agentId, flush);
    }
    flush();
  }

  // -------------------------------------------------------------------------
  // File watching: agents may edit files directly (their own tools) rather
  // than through fs/write_text_file.

  private watch(agentId: string, dir: string): void {
    this.unwatch(agentId);
    try {
      const w = fs.watch(dir, { recursive: true }, (_ev, filename) => {
        const f = filename ? toPosix(filename.toString()) : "";
        if (f === ".git" || f.startsWith(".git/") || f.includes("node_modules/")) return;
        this.deps.onFilesChanged(agentId);
      });
      w.on("error", () => this.unwatch(agentId));
      this.watchers.set(agentId, w);
    } catch (err) {
      this.deps.log(`file watching unavailable for ${agentId}: ${(err as Error).message}`);
    }
  }

  private unwatch(agentId: string): void {
    this.watchers.get(agentId)?.close();
    this.watchers.delete(agentId);
  }
}
