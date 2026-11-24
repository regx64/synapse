import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentConfig,
  AgentMessage,
  AgentOwnership,
  AgentState,
  Approval,
  AuditEntry,
  Conflict,
  CodeComment,
  Decision,
  GoalSplit,
  TeamState,
  Task,
  CoreEvent,
  CoreEventType,
  CoreState,
  Review,
} from "@synapse/protocol";
import { CORE_API_VERSION } from "@synapse/protocol";
import { computeAlerts } from "./alerts.js";
import { debounce, nowIso } from "./util.js";

const BACKLOG_LIMIT = 2000;

interface PersistedState {
  version: number;
  agents: (Omit<AgentState, "status" | "sessionId" | "error" | "currentTaskId" | "policy"> & { command: string; args: string[]; policy?: AgentState["policy"] })[];
  reviews: Review[];
  conflicts: Conflict[];
  tasks?: Task[];
  messages?: AgentMessage[];
  decisions?: Decision[];
  comments?: CodeComment[];
  goals?: GoalSplit[];
  audit?: AuditEntry[];
}

const MESSAGE_LIMIT = 500;
const AUDIT_LIMIT = 1000;
const COMMENT_LIMIT = 1000;

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
  private readonly tasks = new Map<string, Task>();
  private readonly messages = new Map<string, AgentMessage>();
  private readonly decisions = new Map<string, Decision>();
  private readonly goals = new Map<string, GoalSplit>();
  private readonly comments = new Map<string, CodeComment>();
  private team: TeamState = { enabled: false, person: "", role: "editor", remote: "origin", peers: [], claimsOnMe: [] };
  private audit: AuditEntry[] = [];
  private readonly backlog: CoreEvent[] = [];
  private readonly persistSoon = debounce(() => this.persistNow(), 200);

  constructor(
    public readonly repoRoot: string,
    public baseRef: string,
    private readonly stateFile?: string,
    private readonly defaultPolicy: () => AgentState["policy"] = () => {
      throw new Error("no default policy");
    },
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
    const state: Omit<CoreState, "alerts"> = {
      team: this.team,
      version: CORE_API_VERSION,
      repoRoot: this.repoRoot,
      baseRef: this.baseRef,
      agents: this.listAgents(),
      ownership: Object.fromEntries(this.ownership),
      conflicts: this.conflicts,
      approvals: [...this.approvals.values()],
      reviews: [...this.reviews.values()],
      tasks: this.listTasks(),
      messages: this.listMessages(),
      decisions: this.listDecisions(),
      comments: this.listComments(),
      goals: this.listGoals(),
      audit: this.audit.slice(-200),
      seq: this.seq,
    };
    return { ...state, alerts: computeAlerts({ ...state, audit: this.audit }) };
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
  // Tasks, messages, decisions, audit (phase 3)

  listTasks(): Task[] {
    return [...this.tasks.values()];
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  putTask(t: Task): Task {
    t.updatedAt = nowIso();
    this.tasks.set(t.id, t);
    this.emitEvent("task.updated", t);
    this.persistSoon();
    return t;
  }

  removeTask(id: string): void {
    if (!this.tasks.delete(id)) return;
    this.emitEvent("task.removed", { id });
    this.persistSoon();
  }

  listMessages(): AgentMessage[] {
    return [...this.messages.values()];
  }

  getMessage(id: string): AgentMessage | undefined {
    return this.messages.get(id);
  }

  putMessage(m: AgentMessage): AgentMessage {
    this.messages.set(m.id, m);
    if (this.messages.size > MESSAGE_LIMIT) {
      const old = [...this.messages.values()].filter((x) => x.status === "delivered" || x.status === "rejected");
      for (const x of old.slice(0, this.messages.size - MESSAGE_LIMIT)) this.messages.delete(x.id);
    }
    this.emitEvent("message.updated", m);
    this.persistSoon();
    return m;
  }

  listDecisions(): Decision[] {
    return [...this.decisions.values()];
  }

  getDecision(id: string): Decision | undefined {
    return this.decisions.get(id);
  }

  putDecision(d: Decision): Decision {
    this.decisions.set(d.id, d);
    this.emitEvent("decision.updated", d);
    this.persistSoon();
    return d;
  }

  listGoals(): GoalSplit[] {
    return [...this.goals.values()];
  }

  getGoal(id: string): GoalSplit | undefined {
    return this.goals.get(id);
  }

  putGoal(g: GoalSplit): GoalSplit {
    g.updatedAt = nowIso();
    this.goals.set(g.id, g);
    // Keep the open ones and the 20 most recent others.
    const closed = [...this.goals.values()].filter((x) => x.status !== "splitting" && x.status !== "proposed");
    for (const old of closed.slice(0, Math.max(0, closed.length - 20))) this.goals.delete(old.id);
    this.emitEvent("goal.updated", g);
    this.persistSoon();
    return g;
  }

  /** Where per-repository files other than state.json go (undefined when ephemeral). */
  get dataDir(): string | undefined {
    return this.stateFile ? path.dirname(this.stateFile) : undefined;
  }

  getTeam(): TeamState {
    return this.team;
  }

  setTeam(t: TeamState): void {
    const changed = JSON.stringify(t) !== JSON.stringify(this.team);
    this.team = t;
    if (changed) this.emitEvent("team.updated", t);
  }

  listComments(agentId?: string): CodeComment[] {
    const all = [...this.comments.values()];
    return agentId ? all.filter((c) => c.agentId === agentId) : all;
  }

  getComment(id: string): CodeComment | undefined {
    return this.comments.get(id);
  }

  putComment(c: CodeComment): CodeComment {
    c.updatedAt = nowIso();
    this.comments.set(c.id, c);
    if (this.comments.size > COMMENT_LIMIT) {
      for (const old of [...this.comments.values()].filter((x) => x.status === "resolved").slice(0, this.comments.size - COMMENT_LIMIT)) this.comments.delete(old.id);
    }
    this.emitEvent("comment.updated", c);
    this.persistSoon();
    return c;
  }

  addAudit(e: AuditEntry): void {
    this.audit.push(e);
    if (this.audit.length > AUDIT_LIMIT) this.audit.splice(0, this.audit.length - AUDIT_LIMIT);
    this.emitEvent("audit.added", e);
    this.persistSoon();
  }

  listAudit(agentId?: string, limit = 200): AuditEntry[] {
    const list = agentId ? this.audit.filter((a) => a.agentId === agentId) : this.audit;
    return list.slice(-limit);
  }

  // -------------------------------------------------------------------------
  // Persistence. Agent env values are deliberately not persisted (risk C4).

  load(): void {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    const data = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as PersistedState;
    for (const a of data.agents ?? []) {
      this.agents.set(a.id, { ...a, status: "stopped", toolCalls: a.toolCalls ?? [], policy: a.policy ?? this.defaultPolicy() });
    }
    for (const r of data.reviews ?? []) this.reviews.set(r.id, r);
    this.conflicts = data.conflicts ?? [];
    for (const t of data.tasks ?? []) this.tasks.set(t.id, t.status === "in_progress" ? { ...t, status: "todo" } : t);
    for (const m of data.messages ?? []) this.messages.set(m.id, m);
    for (const d of data.decisions ?? []) this.decisions.set(d.id, d);
    for (const c of data.comments ?? []) this.comments.set(c.id, c);
    for (const g of data.goals ?? []) this.goals.set(g.id, g.status === "splitting" ? { ...g, status: "failed", error: "Synapse restarted while the agent was splitting the goal" } : g);
    this.audit = data.audit ?? [];
  }

  persistNow(): void {
    if (!this.stateFile) return;
    const data: PersistedState = {
      version: 1,
      agents: [...this.agents.values()].map(({ status: _s, sessionId: _sid, error: _e, currentTaskId: _t, ...rest }) => rest),
      reviews: [...this.reviews.values()].slice(-50),
      conflicts: this.conflicts,
      tasks: this.listTasks(),
      messages: this.listMessages(),
      decisions: this.listDecisions(),
      comments: this.listComments(),
      goals: this.listGoals(),
      audit: this.audit.slice(-500),
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
