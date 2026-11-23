import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentConfig,
  AgentOwnership,
  AgentState,
  Approval,
  Conflict,
  CoreEvent,
  CoreEventType,
  CoreState,
  Review,
} from "@synapse/protocol";
import { CORE_API_VERSION } from "@synapse/protocol";
import { debounce, nowIso } from "./util.js";

const BACKLOG_LIMIT = 2000;

interface PersistedState {
  version: number;
  agents: (Omit<AgentState, "status" | "sessionId" | "error"> & { command: string; args: string[] })[];
  reviews: Review[];
  conflicts: Conflict[];
}

/**
 * The single source of truth for collaboration state (risk T4). All
 * mutations go through this class, which assigns a sequence number to each
 * change and emits it as an event for subscribed UIs.
 */
export class StateStore extends EventEmitter {
  private seq = 0;
  private readonly agents = new Map<string, AgentState & { command: string; args: string[] }>();
  private readonly agentEnv = new Map<string, Record<string, string>>();
  private readonly ownership = new Map<string, AgentOwnership>();
  private conflicts: Conflict[] = [];
  private readonly approvals = new Map<string, Approval>();
  private readonly reviews = new Map<string, Review>();
  private readonly backlog: CoreEvent[] = [];
  private readonly persistSoon = debounce(() => this.persistNow(), 200);

  constructor(
    public readonly repoRoot: string,
    public baseRef: string,
    private readonly stateFile?: string,
  ) {
    super();
    this.setMaxListeners(100);
  }

  // -------------------------------------------------------------------------
  // Events

  emitEvent<T>(type: CoreEventType, data: T): CoreEvent<T> {
    const ev: CoreEvent<T> = { seq: ++this.seq, ts: nowIso(), type, data };
    this.backlog.push(ev);
    if (this.backlog.length > BACKLOG_LIMIT) this.backlog.splice(0, this.backlog.length - BACKLOG_LIMIT);
    this.emit("event", ev);
    return ev;
  }

  eventsSince(seq: number): CoreEvent[] {
    return this.backlog.filter((e) => e.seq > seq);
  }

  get currentSeq(): number {
    return this.seq;
  }

  snapshot(): CoreState {
    return {
      version: CORE_API_VERSION,
      repoRoot: this.repoRoot,
      baseRef: this.baseRef,
      agents: this.listAgents(),
      ownership: Object.fromEntries(this.ownership),
      conflicts: this.conflicts,
      approvals: [...this.approvals.values()],
      reviews: [...this.reviews.values()],
      seq: this.seq,
    };
  }

  // -------------------------------------------------------------------------
  // Agents

  listAgents(): AgentState[] {
    return [...this.agents.values()].map((a) => publicAgent(a));
  }

  getAgent(id: string): (AgentState & { command: string; args: string[] }) | undefined {
    return this.agents.get(id);
  }

  getAgentEnv(id: string): Record<string, string> {
    return this.agentEnv.get(id) ?? {};
  }

  addAgent(agent: AgentState & { command: string; args: string[] }, env?: Record<string, string>): AgentState {
    this.agents.set(agent.id, agent);
    if (env) this.agentEnv.set(agent.id, env);
    this.emitEvent("agent.added", publicAgent(agent));
    this.persistSoon();
    return publicAgent(agent);
  }

  updateAgent(id: string, patch: Partial<AgentState>): AgentState | undefined {
    const a = this.agents.get(id);
    if (!a) return undefined;
    Object.assign(a, patch, { updatedAt: nowIso() });
    this.emitEvent("agent.updated", publicAgent(a));
    this.persistSoon();
    return publicAgent(a);
  }

  removeAgent(id: string): void {
    if (!this.agents.delete(id)) return;
    this.agentEnv.delete(id);
    this.ownership.delete(id);
    this.emitEvent("agent.removed", { id });
    this.persistSoon();
  }

  // -------------------------------------------------------------------------
  // Ownership and conflicts

  getOwnership(agentId: string): AgentOwnership | undefined {
    return this.ownership.get(agentId);
  }

  allOwnership(): AgentOwnership[] {
    return [...this.ownership.values()].filter((o) => this.agents.has(o.agentId));
  }

  setOwnership(o: AgentOwnership): void {
    this.ownership.set(o.agentId, o);
    this.emitEvent("ownership.updated", o);
  }

  getConflicts(): Conflict[] {
    return this.conflicts;
  }

  setConflicts(next: Conflict[]): void {
    const firstSeen = new Map(this.conflicts.map((c) => [c.id, c.firstSeen]));
    const merged = next.map((c) => ({ ...c, firstSeen: firstSeen.get(c.id) ?? c.firstSeen }));
    const changed = JSON.stringify(merged) !== JSON.stringify(this.conflicts);
    this.conflicts = merged;
    if (changed) {
      this.emitEvent("conflicts.updated", merged);
      this.persistSoon();
    }
  }

  // -------------------------------------------------------------------------
  // Approvals

  addApproval(a: Approval): void {
    this.approvals.set(a.id, a);
    this.emitEvent("approval.requested", a);
  }

  getApproval(id: string): Approval | undefined {
    return this.approvals.get(id);
  }

  listApprovals(all = false): Approval[] {
    const list = [...this.approvals.values()];
    return all ? list : list.filter((a) => a.status === "pending");
  }

  resolveApproval(id: string, status: "resolved" | "cancelled", resolution: Approval["resolution"]): Approval | undefined {
    const a = this.approvals.get(id);
    if (!a || a.status !== "pending") return a;
    a.status = status;
    a.resolution = resolution;
    this.emitEvent("approval.resolved", a);
    // Keep a bounded history of resolved approvals.
    const resolved = [...this.approvals.values()].filter((x) => x.status !== "pending");
    for (const old of resolved.slice(0, Math.max(0, resolved.length - 200))) this.approvals.delete(old.id);
    return a;
  }

  // -------------------------------------------------------------------------
  // Reviews

  getReview(id: string): Review | undefined {
    return this.reviews.get(id);
  }

  listReviews(): Review[] {
    return [...this.reviews.values()];
  }

  putReview(r: Review): Review {
    r.updatedAt = nowIso();
    this.reviews.set(r.id, r);
    this.emitEvent("review.updated", r);
    this.persistSoon();
    return r;
  }

  // -------------------------------------------------------------------------
  // Persistence. Agent env values are deliberately not persisted (risk C4).

  load(): void {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    const data = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as PersistedState;
    for (const a of data.agents ?? []) {
      this.agents.set(a.id, { ...a, status: "stopped", toolCalls: a.toolCalls ?? [] });
    }
    for (const r of data.reviews ?? []) this.reviews.set(r.id, r);
    this.conflicts = data.conflicts ?? [];
  }

  persistNow(): void {
    if (!this.stateFile) return;
    const data: PersistedState = {
      version: 1,
      agents: [...this.agents.values()].map(({ status: _s, sessionId: _sid, error: _e, ...rest }) => rest),
      reviews: [...this.reviews.values()].slice(-50),
      conflicts: this.conflicts,
    };
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.stateFile);
  }

  flush(): void {
    this.persistSoon.cancel();
    this.persistNow();
  }
}

function publicAgent(a: AgentState & Partial<AgentConfig>): AgentState {
  const { env: _env, ...rest } = a as AgentState & { env?: unknown };
  return { ...rest, toolCalls: [...a.toolCalls], plan: a.plan ? [...a.plan] : undefined };
}
