import * as fs from "node:fs";
import * as path from "node:path";
import type { Conflict, CoreMethods, CoreMethodName } from "@synapse/protocol";
import { CORE_API_VERSION, ErrorCodes, RpcError } from "@synapse/protocol";
import { AgentManager } from "./agents.js";
import { loadConfig, type SynapseConfig } from "./config.js";
import { computeTextConflicts, detectConflicts } from "./conflicts.js";
import { currentBranch, ensureLocalExclude, repoRootOf, revParse } from "./git.js";
import { OwnershipService } from "./ownership.js";
import { listPresets } from "./presets.js";
import { ReviewService } from "./review.js";
import { StateStore } from "./store.js";
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
    this.store = new StateStore(repoRoot, baseRef, opts.ephemeral ? undefined : path.join(repoRoot, ".synapse", "state.json"));
    this.worktrees = new WorktreeManager(repoRoot);
    this.ownership = new OwnershipService(this.store, repoRoot, this.log);
    this.agents = new AgentManager({
      store: this.store,
      worktrees: this.worktrees,
      presets: () => listPresets(this.config),
      onFilesChanged: (id) => this.scheduleRefresh(id),
      log: this.log,
    });
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
    // Agents restored from disk are stopped; refresh what they own.
    for (const a of core.store.listAgents()) void core.ownership.refresh(a.id).catch(() => {});
    core.scheduleConflictCheck();
    return core;
  }

  async reloadConfig(): Promise<void> {
    this.config = await loadConfig(this.repoRoot);
  }

  scheduleRefresh(agentId: string): void {
    if (this.closed) return;
    let r = this.refreshers.get(agentId);
    if (!r) {
      r = debounce(() => {
        void this.ownership
          .refresh(agentId)
          .then(() => this.scheduleConflictCheck())
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
    }
    await this.checkConflicts();
    return this.store.allOwnership().filter((o) => ids.includes(o.agentId));
  }

  async checkConflicts(): Promise<Conflict[]> {
    await this.conflictSerializer.run("conflicts", async () => {
      const ownership = this.store.allOwnership();
      const textConflicts = await computeTextConflicts(this.repoRoot, ownership);
      const conflicts = detectConflicts({
        agents: this.store.listAgents(),
        ownership,
        details: (id) => this.ownership.detailsFor(id),
        textConflicts,
      });
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
      "agents.prompt": (p) => {
        this.agents.prompt(req(p, "id"), req(p, "text"));
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
      "review.merge": (p) => this.reviews.merge(req(p, "id"), { resetAgents: p.resetAgents, force: p.force }),
      "review.discard": (p) => this.reviews.discard(req(p, "id")),
      "core.shutdown": () => {
        setImmediate(() => this.emitShutdown());
        return null;
      },
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
    for (const r of this.refreshers.values()) r.cancel();
    this.scheduleConflictCheck.cancel();
    await this.agents.shutdown();
    this.store.flush();
  }
}

function req<T extends object, K extends keyof T>(params: T | undefined, key: K): NonNullable<T[K]> {
  const v = params?.[key];
  if (v === undefined || v === null || v === "") throw new RpcError(ErrorCodes.InvalidParams, `Missing parameter: ${String(key)}`);
  return v as NonNullable<T[K]>;
}
