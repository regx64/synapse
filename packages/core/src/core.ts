import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMethods, AgentPolicy, AgentState, Conflict, CoreEvent, CoreMethods, CoreMethodName } from "@synapse/protocol";
import { CORE_API_VERSION, ErrorCodes, RpcError } from "@synapse/protocol";
import type { AcpMcpServerStdio } from "./acp.js";
import { AgentManager } from "./agents.js";
import { CollabService } from "./collab.js";
import { DEFAULT_POLICY, mergePolicy } from "./policy.js";
import { addSecret } from "./redact.js";
import { loadConfig, type SynapseConfig } from "./config.js";
import { detectDecisionConflicts } from "./anchors.js";
import { CommentService } from "./comments.js";
import { TeamService } from "./team.js";
import { computeTextConflicts, detectConflicts } from "./conflicts.js";
import { currentBranch, ensureLocalExclude, repoRootOf, revParse } from "./git.js";
import { OwnershipService } from "./ownership.js";
import { listPresets } from "./presets.js";
import { ReviewService } from "./review.js";
import { StateStore } from "./store.js";
import { TranscriptStore } from "./transcripts.js";
import { tellAboutConflict } from "./conflict-help.js";
import { debounce, KeyedSerializer } from "./util.js";
import { WorktreeManager } from "./worktrees.js";

export interface CoreOptions {
  /** Any directory inside the repository. */
  workspace: string;
  /** Overrides config.baseRef and the checked-out branch. */
  baseRef?: string;
  /** Keep state in memory only (tests). */
  ephemeral?: boolean;
  log?: (msg: string) => void;
}

type Handler<M extends CoreMethodName> = (params: CoreMethods[M]["params"]) => Promise<CoreMethods[M]["result"]> | CoreMethods[M]["result"];
export type CoreHandlers = { [M in Exclude<CoreMethodName, "session.hello" | "events.subscribe" | "events.unsubscribe">]: Handler<M> };
type AgentHandler<M extends keyof AgentMethods> = (params: AgentMethods[M]["params"]) => Promise<AgentMethods[M]["result"]> | AgentMethods[M]["result"];
export type AgentHandlers = { [M in Exclude<keyof AgentMethods, "agent.hello">]: AgentHandler<M> };

/** Path of the Synapse MCP server script that agents start (bundled .mjs or compiled .js). */
function mcpServerScript(): string | undefined {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  for (const f of ["mcp-server.mjs", "mcp-server.js"]) if (fs.existsSync(path.join(dir, f))) return path.join(dir, f);
  return undefined;
}

/**
 * synapse-core: owns all collaboration state and logic. UIs are clients of
 * the API it serves (see server.ts); nothing here depends on VS Code.
 */
export class SynapseCore {
  readonly store: StateStore;
  readonly worktrees: WorktreeManager;
  readonly ownership: OwnershipService;
  readonly agents: AgentManager;
  readonly reviews: ReviewService;
  readonly comments: CommentService;
  readonly transcripts: TranscriptStore;
  readonly team: TeamService;
  readonly collab: CollabService;
  /** Where the API is served; set by serve(). Agents' MCP servers connect back here. */
  socket?: string;
  private readonly agentTokens = new Map<string, string>();
  private config: SynapseConfig;
  private readonly refreshers = new Map<string, ReturnType<typeof debounce>>();
  private readonly conflictSerializer = new KeyedSerializer();
  private readonly scheduleConflictCheck = debounce(() => void this.checkConflicts().catch((e) => this.log(`conflict check failed: ${e.message}`)), 300);
  private closed = false;
  readonly log: (msg: string) => void;

  private constructor(
    readonly repoRoot: string,
    baseRef: string,
    config: SynapseConfig,
    opts: CoreOptions,
  ) {
    this.log = opts.log ?? (() => {});
    this.config = config;
    this.store = new StateStore(repoRoot, baseRef, opts.ephemeral ? undefined : path.join(repoRoot, ".synapse", "state.json"), () => this.defaultPolicy());
    this.worktrees = new WorktreeManager(repoRoot);
    this.ownership = new OwnershipService(this.store, repoRoot, this.log);
    this.agents = new AgentManager({
      store: this.store,
      worktrees: this.worktrees,
      presets: () => listPresets(this.config),
      onFilesChanged: (id) => this.scheduleRefresh(id),
      log: this.log,
      defaultPolicy: () => this.defaultPolicy(),
      onTurnEnd: (id, stopReason, error) => void this.collab.onTurnEnd(id, stopReason, error).catch((e: Error) => this.log(`task update failed: ${e.message}`)),
      mcpServerFor: (id) => this.mcpServerFor(id),
    });
    this.collab = new CollabService({
      store: this.store,
      agents: this.agents,
      config: () => this.config,
      refreshOwnership: (id) => this.ownership.refresh(id),
      log: this.log,
    });
    this.transcripts = new TranscriptStore(this.store);
    this.comments = new CommentService({ store: this.store, agents: this.agents, collab: this.collab, ownership: this.ownership });
    this.team = new TeamService({ store: this.store, config: () => this.config, log: this.log, onPeersChanged: () => this.scheduleConflictCheck() });
    this.reviews = new ReviewService({
      store: this.store,
      ownership: this.ownership,
      config: () => this.config,
      checkConflicts: () => this.checkConflicts(),
      resetAgent: (id, ref) => this.agents.reset(id, ref),
      log: this.log,
    });
  }

  static async open(opts: CoreOptions): Promise<SynapseCore> {
    const repoRoot = fs.realpathSync.native(await repoRootOf(opts.workspace));
    const config = await loadConfig(repoRoot);
    const baseRef = opts.baseRef ?? config.baseRef ?? (await currentBranch(repoRoot));
    if (!baseRef) throw new Error("Cannot determine the base branch: HEAD is detached. Check out a branch or set baseRef in synapse.config.json.");
    await revParse(repoRoot, baseRef);
    await ensureLocalExclude(repoRoot, "/.synapse/");
    const core = new SynapseCore(repoRoot, baseRef, config, opts);
    core.store.load();
    await core.team.start();
    // Agents restored from disk are stopped; refresh what they own.
    for (const a of core.store.listAgents()) void core.ownership.refresh(a.id).catch(() => {});
    core.scheduleConflictCheck();
    // Pinned decisions: notice when the base branch moves (a merge, or the person's own commits).
    core.baseWatch = setInterval(() => {
      void core.collab.checkDecisionAnchors().catch((e: Error) => core.log(`decision anchor check failed: ${e.message}`));
    }, 10_000);
    core.baseWatch.unref();
    return core;
  }

  private baseWatch?: NodeJS.Timeout;

  defaultPolicy(): AgentPolicy {
    return mergePolicy(DEFAULT_POLICY, this.config.policy);
  }

  /** A per-agent token for the restricted agent API; regenerated each core run. */
  agentToken(agentId: string): string {
    let t = this.agentTokens.get(agentId);
    if (!t) {
      t = randomBytes(24).toString("hex");
      this.agentTokens.set(agentId, t);
      addSecret(t);
    }
    return t;
  }

  agentForToken(token: string): string | undefined {
    for (const [agentId, t] of this.agentTokens) if (t === token && this.store.getAgent(agentId)) return agentId;
    return undefined;
  }

  private mcpServerFor(agentId: string): AcpMcpServerStdio | undefined {
    const script = mcpServerScript();
    if (!script || !this.socket) return undefined;
    const env = [
      { name: "SYNAPSE_SOCKET", value: this.socket },
      { name: "SYNAPSE_AGENT_TOKEN", value: this.agentToken(agentId) },
    ];
    if (process.env.ELECTRON_RUN_AS_NODE) env.push({ name: "ELECTRON_RUN_AS_NODE", value: "1" });
    return { name: "synapse", command: process.execPath, args: [script], env };
  }


  async reloadConfig(): Promise<void> {
    this.config = await loadConfig(this.repoRoot);
  }

  /** Team mode on for this clone: `.synapse/config.json` gets `team.enabled` (and the name and remote, when given). */
  private async enableTeam(name?: string, remote?: string): Promise<ReturnType<TeamService["status"]>> {
    const file = path.join(this.repoRoot, ".synapse", "config.json");
    let local: Record<string, unknown> = {};
    try {
      local = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      /* no local config yet */
    }
    const team: Record<string, unknown> = { ...((local.team as Record<string, unknown> | undefined) ?? {}), enabled: true };
    if (name?.trim()) team.name = name.trim();
    if (remote?.trim()) team.remote = remote.trim();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...local, team }, null, 2) + "\n");
    await this.reloadConfig();
    this.team.stop();
    await this.team.start();
    return this.team.sync();
  }

  scheduleRefresh(agentId: string): void {
    if (this.closed) return;
    let r = this.refreshers.get(agentId);
    if (!r) {
      r = debounce(() => {
        void this.ownership
          .refresh(agentId)
          .then(() => {
            this.scheduleConflictCheck();
            if (this.team.status().enabled) this.team.syncSoon();
            return this.comments.relocate(agentId);
          })
          .catch((err: Error) => this.log(`ownership refresh failed for ${agentId}: ${err.message}`));
      }, this.config.ownershipDebounceMs ?? 750);
      this.refreshers.set(agentId, r);
    }
    r();
  }

  async refreshOwnership(agentId?: string) {
    const ids = agentId ? [agentId] : this.store.listAgents().map((a) => a.id);
    for (const id of ids) {
      if (!this.store.getAgent(id)) throw new RpcError(ErrorCodes.NotFound, `No agent "${id}"`);
      await this.ownership.refresh(id);
      await this.comments.relocate(id);
    }
    await this.checkConflicts();
    return this.store.allOwnership().filter((o) => ids.includes(o.agentId));
  }

  async checkConflicts(): Promise<Conflict[]> {
    await this.conflictSerializer.run("conflicts", async () => {
      const local = this.store.listAgents();
      // Teammates' agents (team mode) take part; only conflicts that involve one of ours are kept.
      const peers = this.team.peers();
      const peerDetails = new Map(peers.map((p) => [p.agent.id, p.details]));
      const ownership = [...this.store.allOwnership(), ...peers.map((p) => p.ownership)];
      const textConflicts = await computeTextConflicts(this.repoRoot, ownership);
      const mine = new Set(local.map((a) => a.id));
      const conflicts = detectConflicts({
        agents: [...local, ...peers.map((p) => p.agent as AgentState)],
        ownership,
        details: (id) => peerDetails.get(id) ?? this.ownership.detailsFor(id),
        textConflicts,
      }).filter((c) => c.agents.some((a) => mine.has(a)));
      await this.collab.checkDecisionAnchors().catch((e: Error) => this.log(`decision anchor check failed: ${e.message}`));
      conflicts.push(...detectDecisionConflicts(this.store.listDecisions(), this.store.listAgents(), ownership));
      this.store.setConflicts(conflicts);
    });
    return this.store.getConflicts();
  }

  /** Method table served over JSON-RPC. */
  handlers(): CoreHandlers {
    return {
      "state.get": () => this.store.snapshot(),
      "agents.presets": () => listPresets(this.config),
      "agents.list": () => this.store.listAgents(),
      "agents.add": (p) => this.agents.add(p ?? {}),
      "agents.remove": async (p) => {
        await this.agents.remove(req(p, "id"), p.keepWorktree);
        this.ownership.forget(p.id);
        this.scheduleConflictCheck();
        return null;
      },
      "agents.start": (p) => this.agents.start(req(p, "id")),
      "agents.stop": (p) => this.agents.stop(req(p, "id")),
      "agents.restart": (p) => this.agents.restart(req(p, "id")),
      "agents.steer": (p) => this.agents.steer(req(p, "id"), req(p, "text"), p.mode ?? "next"),
      "agents.diff": (p) => this.comments.diff(req(p, "id"), p.path),
      "agents.rewind": async (p) => {
        const entry = this.transcripts.list(req(p, "id")).find((e) => e.n === p.n);
        if (!entry?.checkpoint) throw new RpcError(ErrorCodes.NotFound, "No checkpoint before that turn (it may be older than the 30 kept)");
        return this.agents.rewind(p.id, entry.checkpoint, `before turn ${p.n}`);
      },
      "agents.transcript": (p) => {
        if (!this.store.getAgent(req(p, "id"))) throw new RpcError(ErrorCodes.NotFound, `No agent "${p.id}"`);
        return this.transcripts.list(p.id, p.from, p.limit);
      },
      "comments.list": (p) => this.comments.list(p?.agentId),
      "comments.add": (p) => this.comments.add(p),
      "team.status": () => this.team.status(),
      "team.sync": () => this.team.sync(),
      "team.enable": (p) => this.enableTeam(p?.name, p?.remote),
      "team.leave": () => this.team.leave(),
      "team.adopt": async (p) => {
        if (this.team.role() !== "editor") throw new RpcError(ErrorCodes.Unauthorized, "Viewers in team mode cannot continue teammates' work");
        const peer = this.team.peerAgent(req(p, "from"));
        if (!peer) throw new RpcError(ErrorCodes.NotFound, `No teammate's agent "${p.from}" (sync the team first)`);
        const r = await this.collab.adoptFromTeammate(peer, req(p, "to"), p.note);
        this.team.addClaim({ byAgent: r.to.id, agent: peer.id, task: peer.task });
        return r;
      },
      "team.dismissClaim": (p) => this.team.dismissClaim(req(p, "id")),
      "comments.resolve": (p) => this.comments.resolve(req(p, "id"), p.status),
      "agents.takeover": (p) => this.collab.takeover(req(p, "from"), req(p, "to"), { taskId: p.taskId, note: p.note }),
      "agents.prompt": (p) => {
        const id = req(p, "id");
        const agent = this.store.getAgent(id);
        if (!agent) throw new RpcError(ErrorCodes.NotFound, `No agent "${id}"`);
        // Pending messages ride along with the person's prompt, as data.
        const before = this.collab.pendingFor(id);
        const text = this.collab.composePrompt(id, req(p, "text"), false);
        try {
          this.agents.prompt(id, text);
        } catch (err) {
          // Not sent: put the messages back.
          for (const m of before) this.store.putMessage({ ...m, status: "pending", deliveredAt: undefined });
          throw err;
        }
        return { accepted: true as const };
      },
      "agents.cancel": (p) => {
        this.agents.cancel(req(p, "id"));
        return null;
      },
      "agents.reset": (p) => this.agents.reset(req(p, "id"), p.ref),
      "ownership.get": (p) => this.store.allOwnership().filter((o) => !p?.agentId || o.agentId === p.agentId),
      "ownership.refresh": (p) => this.refreshOwnership(p?.agentId),
      "ownership.forFile": (p) => this.ownership.markersFor(req(p, "path"), p.content),
      "conflicts.list": () => this.store.getConflicts(),
      "conflicts.check": () => this.checkConflicts(),
      "conflicts.tell": (p) => tellAboutConflict(this.store, this.agents, req(p, "id"), req(p, "agentId")),
      "approvals.list": (p) => this.store.listApprovals(p?.all),
      "approvals.resolve": (p) => this.agents.resolveApproval(req(p, "id"), p.optionId, p.reject),
      "review.prepare": (p) => this.reviews.prepare(p?.agents, p?.runTests ?? true),
      "review.get": (p) => {
        const r = this.store.getReview(req(p, "id"));
        if (!r) throw new RpcError(ErrorCodes.NotFound, `No review "${p.id}"`);
        return r;
      },
      "review.list": () => this.store.listReviews(),
      "review.diff": async (p) => ({ diff: await this.reviews.diff(req(p, "id"), p.path) }),
      "review.fileContent": async (p) => ({ content: await this.reviews.fileContent(req(p, "id"), req(p, "path"), p.side ?? "merged") }),
      "review.merge": async (p) => {
        const r = await this.reviews.merge(req(p, "id"), { resetAgents: p.resetAgents, force: p.force });
        // The base moved: flag decisions whose pinned code the merge changed.
        await this.collab.checkDecisionAnchors().catch((e: Error) => this.log(`decision anchor check failed: ${e.message}`));
        return r;
      },
      "review.discard": (p) => this.reviews.discard(req(p, "id")),
      "agents.setPolicy": (p) => this.agents.setPolicy(req(p, "id"), req(p, "policy")),
      "policy.evaluate": (p) => this.agents.evaluate(req(p, "agentId"), req(p, "query")),
      "audit.list": (p) => this.store.listAudit(p?.agentId, p?.limit),
      "tasks.list": () => this.collab.listTasks(),
      "tasks.create": (p) => this.collab.createTask(p),
      "tasks.update": (p) => this.collab.updateTask({ ...p, id: req(p, "id") }),
      "tasks.remove": (p) => {
        this.collab.removeTask(req(p, "id"));
        return null;
      },
      "tasks.start": (p) => this.collab.startTask(req(p, "id")),
      "tasks.setStatus": (p) => this.collab.setStatus(req(p, "id"), req(p, "status")),
      "messages.list": (p) => this.collab.listMessages(p?.agentId),
      "messages.send": (p) => this.collab.send("human", { ...p, to: req(p, "to") }),
      "messages.release": (p) => this.collab.release(req(p, "id")),
      "messages.reject": (p) => this.collab.reject(req(p, "id")),
      "decisions.list": () => this.collab.listDecisions(),
      "decisions.add": (p) => this.collab.addDecision("human", p),
      "decisions.resolve": (p) => {
        const d = this.collab.resolveDecision(req(p, "id"), req(p, "status"));
        this.scheduleConflictCheck(); // only accepted decisions raise conflicts
        return d;
      },
      "decisions.pin": async (p) => {
        const d = await this.collab.pinDecision(req(p, "id"), { path: req(p, "path"), symbol: p.symbol, line: p.line });
        this.scheduleConflictCheck();
        return d;
      },
      "decisions.unpin": (p) => {
        const d = this.collab.unpinDecision(req(p, "id"), { path: req(p, "path"), symbol: p.symbol });
        this.scheduleConflictCheck();
        return d;
      },
      "decisions.repin": (p) => this.collab.repinDecision(req(p, "id")),
      "core.shutdown": () => {
        setImmediate(() => this.emitShutdown());
        return null;
      },
    };
  }

  /** The restricted method table for an agent's MCP server, bound to that agent. */
  agentHandlers(agentId: string): AgentHandlers {
    return {
      "agent.tasks": () => this.collab.agentTasks(),
      "agent.inbox": () => this.collab.agentInbox(agentId),
      "agent.send": (p) => this.collab.send(agentId, { ...p, to: req(p, "to") }),
      "agent.decisions": () => this.collab.listDecisions().filter((d) => d.status === "accepted"),
      "agent.proposeDecision": (p) => this.collab.addDecision(agentId, p),
      "agent.completeTask": (p) => this.collab.agentCompleteTask(agentId, req(p, "taskId"), p.summary ?? ""),
    };
  }

  private emitShutdown(): void {
    this.store.emit("shutdown");
  }

  get version(): string {
    return CORE_API_VERSION;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.baseWatch) clearInterval(this.baseWatch);
    this.team.stop();
    for (const r of this.refreshers.values()) r.cancel();
    this.scheduleConflictCheck.cancel();
    await this.agents.shutdown();
    this.store.flush();
    this.transcripts.flush();
  }
}

function req<T extends object, K extends keyof T>(params: T | undefined, key: K): NonNullable<T[K]> {
  const v = params?.[key];
  if (v === undefined || v === null || v === "") throw new RpcError(ErrorCodes.InvalidParams, `Missing parameter: ${String(key)}`);
  return v as NonNullable<T[K]>;
}
