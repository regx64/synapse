import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { AddAgentParams, AgentPolicy, AgentState, Approval, AuditEntry, Guidance, PermissionQuery, PolicyDecision, PresetInfo, ToolCallSummary, WorktreeInfo } from "@synapse/protocol";
import { CORE_API_VERSION, ErrorCodes, RpcError } from "@synapse/protocol";
import { AcpAgentProcess, type AcpMcpServerStdio, type AcpPermissionOutcome, type AcpPermissionRequest, type AcpPlanUpdate, type AcpSessionUpdate, type AcpToolCallUpdate } from "./acp.js";
import type { StateStore } from "./store.js";
import type { WorktreeManager } from "./worktrees.js";
import { AGENT_COLORS, AGENT_ID_RE, debounce, isInside, nowIso, randomId, realpathLoose, toPosix, truncateTail } from "./util.js";
import { revParse } from "./git.js";
import { commandFromRawInput, evaluatePermission, isRisky, matchesAny, mergePolicy, pathFromRawInput, urlFromRawInput, validatePolicy } from "./policy.js";
import { addSecret, redact } from "./redact.js";

const MAX_TOOL_CALLS = 30;
const MAX_GUIDANCE = 4000;
const MAX_MESSAGE_TAIL = 4000;

export interface AgentManagerDeps {
  store: StateStore;
  worktrees: WorktreeManager;
  presets: () => PresetInfo[];
  /** Called when an agent's files may have changed. */
  onFilesChanged: (agentId: string) => void;
  log: (msg: string) => void;
  /** The workspace default policy (DEFAULT_POLICY plus synapse.config.json). */
  defaultPolicy: () => AgentPolicy;
  /** Called when a prompt turn ends. */
  onTurnEnd?: (agentId: string, stopReason: string, error?: string) => void;
  /** The Synapse MCP server to give an agent's session, if any. */
  mcpServerFor?: (agentId: string) => AcpMcpServerStdio | undefined;
}

/**
 * Agent lifecycle (add, start, stop, restart, remove) and the ACP client
 * handlers: file access confined to the agent's worktree, permission requests
 * routed to the person as approvals, and session updates mapped to state.
 */
export class AgentManager {
  private readonly procs = new Map<string, AcpAgentProcess>();
  /** Agents whose turn end is handled by a takeover, not by the task graph. */
  private readonly takingOver = new Set<string>();
  private readonly turnWaiters = new Map<string, (() => void)[]>();
  private readonly pendingPermissions = new Map<string, { agentId: string; resolve: (o: AcpPermissionOutcome) => void; options: Approval["options"] }>();
  private readonly watchers = new Map<string, fs.FSWatcher>();
  /** Tool calls that went through a permission request, and raw inputs seen, for the audit log. */
  private readonly askedToolCalls = new Set<string>();
  private readonly toolInputs = new Map<string, unknown>();

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

    if (params.policy) this.checkedPolicy(mergePolicy(this.deps.defaultPolicy(), params.policy));
    for (const v of Object.values(params.env ?? {})) addSecret(v);
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
        policy: this.checkedPolicy(mergePolicy(this.deps.defaultPolicy(), params.policy)),
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
    const env: Record<string, string> = { ...this.store.getAgentEnv(id), SYNAPSE_AGENT_ID: id };
    const required = this.deps.presets().find((p) => p.id === agent.preset)?.requiresEnv;
    if (required && !required.anyOf.some((k) => env[k] || process.env[k])) {
      const message = `${agent.name} needs one of ${required.anyOf.join(", ")}. ${required.reason}`;
      this.store.updateAgent(id, { status: "error", error: message });
      throw new RpcError(ErrorCodes.InvalidParams, message);
    }
    this.store.updateAgent(id, { status: "starting", error: undefined });
    const proc = new AcpAgentProcess(
      {
        command: agent.command,
        args: agent.args,
        cwd: agent.worktree.path,
        env,
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
    proc.on("stderr", (text: string) => this.store.emitEvent("agent.output", { agentId: id, kind: "stderr", text: redact(text) }));
    proc.on("exit", (code: number | null, signal: string | null) => {
      if (this.procs.get(id) !== proc) return;
      this.procs.delete(id);
      this.cancelPermissions(id);
      this.unwatch(id);
      this.releaseWaiters(id);
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
      const mcp = this.deps.mcpServerFor?.(id);
      const { sessionId, init } = await proc.start(mcp ? [mcp] : []);
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
    // Guidance left over (the agent stopped before it could be given) rides along.
    const pending = agent.guidance ?? [];
    const full = pending.length ? `${text}\n\n${guidanceBlock(pending)}` : text;
    this.store.updateAgent(id, { status: "working", turn: { prompt: full, startedAt: nowIso() }, guidance: undefined, lastMessage: "", plan: undefined, error: undefined });
    this.store.emitEvent("agent.output", { agentId: id, kind: "turn", phase: "prompt", text: `> ${full}` });
    this.runTurn(id, proc, full);
  }

  private runTurn(id: string, proc: AcpAgentProcess, text: string): void {
    proc.prompt(text).then(
      (stopReason) => this.endTurn(id, proc, stopReason),
      (err: Error) => this.endTurn(id, proc, "error", err.message),
    );
  }

  /**
   * Guidance from the person for a working agent. "now" interrupts the turn;
   * "next" waits for it to end. Either way a follow-up turn continues the same
   * work (and task) with the guidance. An idle agent just gets a prompt.
   */
  steer(id: string, text: string, mode: Guidance["mode"] = "next"): AgentState {
    const agent = this.require(id);
    const t = String(text ?? "").trim();
    if (!t) throw new RpcError(ErrorCodes.InvalidParams, "Guidance needs some text");
    if (t.length > MAX_GUIDANCE) throw new RpcError(ErrorCodes.InvalidParams, `Guidance is limited to ${MAX_GUIDANCE} characters`);
    if (mode !== "now" && mode !== "next") throw new RpcError(ErrorCodes.InvalidParams, `Unknown mode "${mode}"`);
    if (!this.procs.get(id)?.running) throw new RpcError(ErrorCodes.Conflict, `Agent "${id}" is not running. Start it first.`);
    if (this.takingOver.has(id)) throw new RpcError(ErrorCodes.Conflict, `${agent.name}'s work is being handed over`);
    if (agent.status !== "working" && agent.status !== "awaiting-approval") {
      this.prompt(id, t);
      return this.store.getAgent(id)!;
    }
    const next = this.store.updateAgent(id, { guidance: [...(agent.guidance ?? []), { text: t, mode, at: nowIso() }] })!;
    this.store.emitEvent("agent.output", { agentId: id, kind: "turn", phase: "guidance", mode, guidance: t, text: `guidance (${mode === "now" ? "interrupting" : "after this turn"}): ${t}` });
    if (mode === "now") this.cancel(id, true);
    return next;
  }

  /** Resolves when the agent's current turn has ended (at once if it is not in one). */
  waitForTurnEnd(id: string, timeoutMs: number): Promise<boolean> {
    const a = this.store.getAgent(id);
    if (!a || (a.status !== "working" && a.status !== "awaiting-approval")) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      const list = this.turnWaiters.get(id) ?? [];
      list.push(() => (clearTimeout(timer), resolve(true)));
      this.turnWaiters.set(id, list);
    });
  }

  private releaseWaiters(id: string): void {
    const list = this.turnWaiters.get(id);
    this.turnWaiters.delete(id);
    for (const w of list ?? []) w();
  }

  /** While set, the agent's turn end belongs to a takeover: no follow-up guidance, no task update. */
  holdForTakeover(id: string, hold: boolean): void {
    if (hold) this.takingOver.add(id);
    else this.takingOver.delete(id);
  }

  /** Puts `commit` (work from another agent) into this agent's worktree, measured against `base`. */
  async adoptWork(id: string, commit: string, base: Pick<WorktreeInfo, "baseCommit" | "baseRef">): Promise<AgentState> {
    const agent = this.require(id);
    await this.deps.worktrees.resetTo(id, commit);
    const next = this.store.updateAgent(id, { worktree: { ...agent.worktree, baseCommit: base.baseCommit, baseRef: base.baseRef } })!;
    this.deps.onFilesChanged(id);
    return next;
  }

  /** Discards the agent's work: its worktree goes back to its base commit. */
  async releaseWork(id: string): Promise<AgentState> {
    const agent = this.require(id);
    await this.deps.worktrees.resetTo(id, agent.worktree.baseCommit);
    this.deps.onFilesChanged(id);
    return this.store.getAgent(id)!;
  }

  private endTurn(id: string, proc: AcpAgentProcess, stopReason: string, error?: string): void {
    const agent = this.store.getAgent(id);
    if (!agent || this.procs.get(id) !== proc) return;
    this.store.updateAgent(id, {
      status: proc.running ? "idle" : "stopped",
      turn: agent.turn ? { ...agent.turn, endedAt: nowIso(), stopReason } : undefined,
      error,
    });
    this.store.emitEvent("agent.output", { agentId: id, kind: "turn", phase: "end", stopReason, error, text: `turn ended: ${stopReason}${error ? ` (${error})` : ""}` });
    this.deps.onFilesChanged(id);
    this.releaseWaiters(id);
    if (this.takingOver.has(id)) return;
    // Guidance from the person: the same work continues in a follow-up turn.
    const guidance = this.store.getAgent(id)?.guidance ?? [];
    if (guidance.length && proc.running && stopReason !== "refusal") {
      const turn = agent.turn;
      const text = guidanceBlock(guidance, stopReason === "cancelled");
      this.store.updateAgent(id, {
        status: "working",
        guidance: undefined,
        error: undefined,
        turn: { prompt: turn?.prompt ?? text, startedAt: turn?.startedAt ?? nowIso(), steered: (turn?.steered ?? 0) + 1 },
      });
      this.store.emitEvent("agent.output", { agentId: id, kind: "turn", phase: "followup", text: `> ${text}` });
      this.runTurn(id, proc, text);
      return;
    }
    this.deps.onTurnEnd?.(id, stopReason, error);
  }

  /** Stops the current turn. Guidance waiting for it is dropped, unless it is what interrupted the turn. */
  cancel(id: string, keepGuidance = false): void {
    const agent = this.require(id);
    if (!keepGuidance && agent.guidance?.length) this.store.updateAgent(id, { guidance: undefined });
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
    const kind = approval.options.find((o) => o.optionId === chosen)?.kind ?? "";
    this.audit(approval.agentId, {
      toolKind: approval.toolKind,
      title: approval.title,
      command: commandFromRawInput(approval.detail),
      outcome: kind.startsWith("allow") ? "allowed" : "denied",
      by: "human",
    });
    this.refreshApprovalStatus(approval.agentId);
    return resolved;
  }

  setPolicy(id: string, patch: Partial<AgentPolicy>): AgentState {
    const agent = this.require(id);
    const policy = this.checkedPolicy(mergePolicy(agent.policy, patch));
    return this.store.updateAgent(id, { policy })!;
  }

  /** What the agent's policy decides for a request. Paths may be absolute (inside the worktree) or repo-relative. */
  evaluate(id: string, q: PermissionQuery): PolicyDecision {
    const agent = this.require(id);
    let rel = q.path;
    if (rel && path.isAbsolute(rel)) {
      const wt = realpathLoose(agent.worktree.path);
      const real = realpathLoose(rel);
      if (!isInside(wt, real)) return { decision: "deny", rule: "outside the agent's worktree" };
      rel = toPosix(path.relative(wt, real));
    }
    return evaluatePermission(agent.policy, { ...q, path: rel });
  }

  private checkedPolicy(p: AgentPolicy): AgentPolicy {
    try {
      validatePolicy(p);
    } catch (err) {
      throw new RpcError(ErrorCodes.InvalidParams, (err as Error).message);
    }
    return p;
  }

  private audit(agentId: string, e: Omit<AuditEntry, "id" | "at" | "agentId" | "risky">): void {
    const entry: AuditEntry = {
      id: randomId("au"),
      at: nowIso(),
      agentId,
      ...e,
      title: redact(e.title),
      command: e.command ? redact(e.command) : undefined,
      risky: isRisky(e.command) || (!!e.path && /(^|\/)\.env|\.pem$|id_rsa/.test(e.path)),
    };
    this.store.addAudit(entry);
    if (entry.outcome === "ran-unasked" && entry.risky) {
      this.store.emitEvent("core.log", { level: "warning", message: `${agentId} ran a risky command without asking: ${entry.command ?? entry.title}` });
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.procs.keys()].map((id) => this.stop(id).catch(() => {})));
  }

  isRunning(id: string): boolean {
    return !!this.procs.get(id)?.running;
  }

  // -------------------------------------------------------------------------
  // ACP client handlers

  private resolveAgentPath(agentId: string, p: string, mode: "read" | "write"): string {
    const agent = this.require(agentId);
    const abs = path.isAbsolute(p) ? p : path.join(agent.worktree.path, p);
    const wt = realpathLoose(agent.worktree.path);
    const realAbs = realpathLoose(abs);
    const inside = isInside(wt, realAbs);
    const shown = inside ? toPosix(path.relative(wt, realAbs)) : p;
    const deny = (why: string, rule: string) => {
      this.audit(agentId, { toolKind: mode === "read" ? "read" : "edit", title: `${mode} ${shown}`, path: shown, outcome: "denied", by: "policy", rule });
      throw new RpcError(ErrorCodes.InvalidParams, `Access denied: ${why}`);
    };
    if (!inside) deny(`${p} is outside this agent's worktree (${agent.worktree.path})`, "outside the agent's worktree");
    const rel = shown;
    if (rel.split("/")[0] === ".git") deny(".git is managed by Synapse", ".git");
    const prot = matchesAny(agent.policy.protected, rel);
    if (prot) deny(`${rel} is protected by policy (${prot})`, `protected: ${prot}`);
    if (mode === "write" && !matchesAny(agent.policy.writable, rel)) deny(`${rel} is not writable by policy`, "outside writable");
    return abs;
  }

  private async readTextFile(agentId: string, p: { path: string; line?: number; limit?: number }): Promise<{ content: string }> {
    const abs = this.resolveAgentPath(agentId, p.path, "read");
    let content = await fsp.readFile(abs, "utf8");
    if (p.line !== undefined || p.limit !== undefined) {
      const lines = content.split("\n");
      const start = Math.max(0, (p.line ?? 1) - 1);
      content = lines.slice(start, p.limit !== undefined ? start + p.limit : undefined).join("\n");
    }
    return { content };
  }

  private async writeTextFile(agentId: string, p: { path: string; content: string }): Promise<null> {
    const abs = this.resolveAgentPath(agentId, p.path, "write");
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, p.content, "utf8");
    this.deps.onFilesChanged(agentId);
    return null;
  }

  private requestPermission(agentId: string, req: AcpPermissionRequest): Promise<{ outcome: AcpPermissionOutcome }> {
    const id = randomId("ap");
    const tc = req.toolCall ?? { toolCallId: "?" };
    this.askedToolCalls.add(`${agentId}:${tc.toolCallId}`);
    const raw = tc.rawInput ?? this.toolInputs.get(`${agentId}:${tc.toolCallId}`);
    const command = commandFromRawInput(raw);
    const filePath = pathFromRawInput(raw) ?? tc.locations?.[0]?.path;
    const toolKind = tc.kind ?? this.store.getAgent(agentId)?.toolCalls.find((c) => c.id === tc.toolCallId)?.kind;
    const verdict = this.evaluate(agentId, { toolKind, title: tc.title, command, path: filePath, url: urlFromRawInput(raw) });
    const options = (req.options ?? []).map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind }));
    const auditBase = { toolKind, title: tc.title ?? toolKind ?? "permission", command, path: filePath };

    if (verdict.decision !== "ask") {
      const want = verdict.decision === "allow" ? "allow" : "reject";
      const option = options.find((o) => o.kind === `${want}_once`) ?? options.find((o) => o.kind.startsWith(want));
      if (option || verdict.decision === "deny") {
        this.audit(agentId, { ...auditBase, outcome: verdict.decision === "allow" ? "allowed" : "denied", by: "policy", rule: verdict.rule });
        return Promise.resolve({ outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } });
      }
    }
    this.audit(agentId, { ...auditBase, outcome: "asked", by: "policy", rule: verdict.rule });
    const approval: Approval = {
      id,
      agentId,
      title: tc.title ?? tc.kind ?? "Permission requested",
      toolKind: tc.kind,
      detail: raw,
      locations: tc.locations?.map((l) => l.path),
      options,
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
        const key = `${agentId}:${u.toolCallId}`;
        if (u.rawInput !== undefined) this.toolInputs.set(key, u.rawInput);
        if (next.status === "completed" && next.kind === "execute" && (!prev || prev.status !== "completed")) {
          if (!this.askedToolCalls.has(key)) {
            const command = commandFromRawInput(this.toolInputs.get(key));
            this.audit(agentId, { toolKind: "execute", title: next.title, command, outcome: "ran-unasked", by: "agent" });
          }
          this.askedToolCalls.delete(key);
          this.toolInputs.delete(key);
        }
        if (this.toolInputs.size > 500) this.toolInputs.delete(this.toolInputs.keys().next().value!);
        this.store.updateAgent(agentId, { toolCalls: calls.slice(-MAX_TOOL_CALLS) });
        if (!prev || prev.status !== next.status) {
          this.store.emitEvent("agent.output", { agentId, kind: "tool", tool: next, text: `${next.status}: ${next.title}` });
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

/** The follow-up prompt that gives an agent the person's guidance. */
function guidanceBlock(guidance: Guidance[], interrupted = false): string {
  return [
    interrupted
      ? "The person interrupted your turn to add guidance. Continue the same work with it in mind; don't start over, build on what you have already done."
      : "Guidance from the person for the work you are doing. Continue the same work with it in mind; don't start over, build on what you have already done.",
    "",
    ...guidance.map((g) => `- ${g.text}`),
  ].join("\n");
}
