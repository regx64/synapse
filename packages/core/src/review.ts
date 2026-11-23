import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Review, ReviewFile, TestRun } from "@synapse/protocol";
import { ErrorCodes, RpcError } from "@synapse/protocol";
import type { SynapseConfig } from "./config.js";
import { SYNAPSE_IDENTITY, currentBranch, diffNumstat, diffRaw, git, isWorkingTreeClean, revParse, runGit, showFile } from "./git.js";
import type { OwnershipService } from "./ownership.js";
import type { StateStore } from "./store.js";
import { nowIso, randomId } from "./util.js";

const OUTPUT_LIMIT = 64 * 1024;

export interface ReviewDeps {
  store: StateStore;
  ownership: OwnershipService;
  config: () => SynapseConfig;
  /** Recomputes conflicts and returns them (so the review captures the latest). */
  checkConflicts: () => Promise<import("@synapse/protocol").Conflict[]>;
  resetAgent: (id: string, ref: string) => Promise<unknown>;
  log: (msg: string) => void;
}

/**
 * Combined review: merge every agent's work into one integration worktree,
 * run the tests on the combined result, show one diff, then merge it into
 * the base branch in one step.
 */
export class ReviewService {
  constructor(private readonly deps: ReviewDeps) {}

  private get store(): StateStore {
    return this.deps.store;
  }

  private get repoRoot(): string {
    return this.store.repoRoot;
  }

  get root(): string {
    return path.join(this.repoRoot, ".synapse", "review");
  }

  private require(id: string): Review {
    const r = this.store.getReview(id);
    if (!r) throw new RpcError(ErrorCodes.NotFound, `No review "${id}"`);
    return r;
  }

  async prepare(agentIds: string[] | undefined, runTests = true): Promise<Review> {
    const agents = agentIds?.length ? agentIds : this.store.listAgents().map((a) => a.id);
    for (const id of agents) if (!this.store.getAgent(id)) throw new RpcError(ErrorCodes.NotFound, `No agent "${id}"`);
    if (agents.length === 0) throw new RpcError(ErrorCodes.InvalidParams, "No agents to review");

    // Fresh snapshots of every agent's worktree.
    for (const id of agents) await this.deps.ownership.refresh(id);
    const conflicts = await this.deps.checkConflicts();

    const baseRef = this.store.baseRef;
    const baseCommit = await revParse(this.repoRoot, baseRef);
    const id = randomId("r");
    const worktreePath = path.join(this.root, id);
    const review: Review = {
      id,
      status: "preparing",
      agents,
      baseRef,
      baseCommit,
      worktreePath,
      files: [],
      mergeConflicts: [],
      conflicts: conflicts.filter((c) => c.agents.some((a) => agents.includes(a))),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.store.putReview(review);

    try {
      await fs.mkdir(this.root, { recursive: true });
      await git(this.repoRoot, ["worktree", "add", "--detach", worktreePath, baseCommit]);

      for (const agentId of agents) {
        const snap = this.store.getOwnership(agentId)?.snapshot;
        if (!snap) continue;
        const agentName = this.store.getAgent(agentId)?.name ?? agentId;
        const r = await runGit(worktreePath, ["merge", "--no-ff", "--no-edit", "-m", `Synapse: merge work of ${agentName}`, snap], { env: SYNAPSE_IDENTITY });
        if (r.code !== 0) {
          const unmerged = await git(worktreePath, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "");
          review.mergeConflicts = unmerged.split("\n").filter(Boolean);
          await runGit(worktreePath, ["merge", "--abort"]);
          review.status = "conflicted";
          review.error = `The work of ${agentName} does not merge cleanly with the agents merged before it.`;
          break;
        }
      }

      review.integrationCommit = await revParse(worktreePath, "HEAD");
      review.files = await this.reviewFiles(baseCommit, review.integrationCommit, agents);

      if (review.status !== "conflicted") {
        const cfg = this.deps.config();
        if (runTests && cfg.testCommand) {
          this.store.putReview(review);
          if (cfg.setupCommand) {
            const setup = await runShell(cfg.setupCommand, worktreePath, cfg.testTimeoutMs ?? 600_000);
            if (!setup.passed) {
              review.tests = { ...setup, output: `setup command failed: ${cfg.setupCommand}\n${setup.output}` };
            }
          }
          if (!review.tests) review.tests = await runShell(cfg.testCommand, worktreePath, cfg.testTimeoutMs ?? 600_000);
        }
        review.status = "ready";
      }
    } catch (err) {
      review.status = "failed";
      review.error = (err as Error).message;
    }
    return this.store.putReview(review);
  }

  async diff(id: string, filePath?: string): Promise<string> {
    const r = this.require(id);
    if (!r.integrationCommit) return "";
    const args = ["diff", "--no-color", "--no-renames", r.baseCommit, r.integrationCommit];
    if (filePath) args.push("--", filePath);
    return git(this.repoRoot, args);
  }

  async fileContent(id: string, filePath: string, side: "base" | "merged"): Promise<string | null> {
    const r = this.require(id);
    const rev = side === "base" ? r.baseCommit : r.integrationCommit;
    if (!rev) return null;
    return showFile(this.repoRoot, rev, filePath);
  }

  async merge(id: string, opts: { resetAgents?: boolean; force?: boolean } = {}): Promise<Review> {
    const r = this.require(id);
    if (r.status !== "ready") throw new RpcError(ErrorCodes.Conflict, `Review ${id} is ${r.status}, not ready`);
    if (!r.integrationCommit) throw new RpcError(ErrorCodes.Conflict, "Review has no integration commit");
    if (r.tests && !r.tests.passed && !opts.force) {
      throw new RpcError(ErrorCodes.Conflict, "Tests failed on the combined result. Fix them, or merge with force.");
    }
    const blocking = r.conflicts.filter((c) => c.severity === "error");
    if (blocking.length && !opts.force) {
      throw new RpcError(ErrorCodes.Conflict, `${blocking.length} unresolved conflict(s) between agents. Resolve them, or merge with force.`);
    }

    const tip = await revParse(this.repoRoot, r.baseRef);
    if (tip !== r.baseCommit) {
      throw new RpcError(ErrorCodes.Conflict, `${r.baseRef} moved since the review was prepared. Prepare a new review.`);
    }

    const checkedOut = await currentBranch(this.repoRoot);
    if (checkedOut === r.baseRef) {
      if (!(await isWorkingTreeClean(this.repoRoot))) {
        throw new RpcError(ErrorCodes.Conflict, `Your checkout of ${r.baseRef} has uncommitted changes. Commit or stash them first.`);
      }
      await git(this.repoRoot, ["merge", "--ff-only", r.integrationCommit]);
    } else {
      await git(this.repoRoot, ["update-ref", `refs/heads/${r.baseRef}`, r.integrationCommit, r.baseCommit]);
    }
    this.deps.log(`review ${id} merged into ${r.baseRef} at ${r.integrationCommit}`);
    r.status = "merged";
    await this.removeWorktree(r);

    if (opts.resetAgents) {
      for (const agentId of r.agents) {
        const own = this.store.getOwnership(agentId);
        const before = own?.snapshot;
        const after = await this.deps.ownership.refresh(agentId);
        if (before && after?.snapshot && before !== after.snapshot) {
          this.deps.log(`not resetting ${agentId}: it changed files after the review was prepared`);
          continue;
        }
        try {
          await this.deps.resetAgent(agentId, r.baseRef);
        } catch (err) {
          this.deps.log(`could not reset ${agentId}: ${(err as Error).message}`);
        }
      }
    }
    return this.store.putReview(r);
  }

  async discard(id: string): Promise<Review> {
    const r = this.require(id);
    if (r.status === "merged") return r;
    r.status = "discarded";
    await this.removeWorktree(r);
    return this.store.putReview(r);
  }

  private async removeWorktree(r: Review): Promise<void> {
    if (!r.worktreePath) return;
    const res = await runGit(this.repoRoot, ["worktree", "remove", "--force", r.worktreePath]);
    if (res.code !== 0) await fs.rm(r.worktreePath, { recursive: true, force: true });
    await runGit(this.repoRoot, ["worktree", "prune"]);
  }

  private async reviewFiles(base: string, merged: string, agents: string[]): Promise<ReviewFile[]> {
    const [entries, numstat] = await Promise.all([diffRaw(this.repoRoot, base, merged), diffNumstat(this.repoRoot, base, merged)]);
    return entries.map((e) => {
      const stat = numstat.get(e.path) ?? { added: 0, removed: 0 };
      const owners = agents.filter((a) => this.store.getOwnership(a)?.files.some((f) => f.path === e.path));
      return { path: e.path, status: e.status, agents: owners, linesAdded: stat.added, linesRemoved: stat.removed };
    });
  }
}

export function runShell(command: string, cwd: string, timeoutMs: number): Promise<TestRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, CI: "1" }, windowsHide: true, detached: process.platform !== "win32" });
    let output = "";
    let timedOut = false;
    const append = (d: Buffer) => {
      output += d.toString("utf8");
      if (output.length > OUTPUT_LIMIT * 2) output = output.slice(-OUTPUT_LIMIT);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      resolve({
        command,
        exitCode: code,
        passed: code === 0 && !timedOut,
        durationMs: Date.now() - started,
        output: output.length > OUTPUT_LIMIT ? output.slice(-OUTPUT_LIMIT) : output,
        timedOut,
      });
    };
    child.on("error", (err) => {
      output += `\n${err.message}`;
      finish(null);
    });
    child.on("close", finish);
  });
}
