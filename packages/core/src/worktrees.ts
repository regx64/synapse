import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorktreeInfo } from "@synapse/protocol";
import { git, runGit, revParse } from "./git.js";

/**
 * One git worktree per agent, under `<repo>/.synapse/worktrees/<agentId>`,
 * on branch `synapse/<agentId>`. Agents write only to their own worktree;
 * the main checkout belongs to the person (risk T4).
 */
export class WorktreeManager {
  constructor(private readonly repoRoot: string) {}

  get root(): string {
    return path.join(this.repoRoot, ".synapse", "worktrees");
  }

  pathFor(agentId: string): string {
    return path.join(this.root, agentId);
  }

  branchFor(agentId: string): string {
    return `synapse/${agentId}`;
  }

  async create(agentId: string, baseRef: string): Promise<WorktreeInfo> {
    const wtPath = this.pathFor(agentId);
    const branch = this.branchFor(agentId);
    const baseCommit = await revParse(this.repoRoot, baseRef);
    await fs.mkdir(this.root, { recursive: true });
    await this.prune();

    const existing = await this.list();
    const found = existing.find((w) => path.resolve(w.path) === path.resolve(wtPath));
    if (found) {
      // Re-adopt a worktree left over from an earlier run.
      const head = await revParse(wtPath, "HEAD");
      return { path: wtPath, branch, baseRef, baseCommit: (await this.mergeBase(head, baseCommit)) ?? baseCommit };
    }
    // -B resets a stale branch of the same name to the base.
    await git(this.repoRoot, ["worktree", "add", "-B", branch, wtPath, baseCommit]);
    return { path: wtPath, branch, baseRef, baseCommit };
  }

  async remove(agentId: string, opts: { deleteBranch?: boolean } = {}): Promise<void> {
    const wtPath = this.pathFor(agentId);
    const r = await runGit(this.repoRoot, ["worktree", "remove", "--force", wtPath]);
    if (r.code !== 0) await fs.rm(wtPath, { recursive: true, force: true });
    await this.prune();
    if (opts.deleteBranch) await runGit(this.repoRoot, ["branch", "-D", this.branchFor(agentId)]);
  }

  /** Discards everything in the worktree and moves its branch to `commit`. */
  async resetTo(agentId: string, commit: string): Promise<void> {
    const wtPath = this.pathFor(agentId);
    await git(wtPath, ["reset", "--hard", commit]);
    await git(wtPath, ["clean", "-fd"]);
  }

  async list(): Promise<{ path: string; head?: string; branch?: string }[]> {
    const out = await git(this.repoRoot, ["worktree", "list", "--porcelain"]);
    const result: { path: string; head?: string; branch?: string }[] = [];
    let cur: { path: string; head?: string; branch?: string } | undefined;
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        cur = { path: line.slice(9) };
        result.push(cur);
      } else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5);
      else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    }
    return result;
  }

  async prune(): Promise<void> {
    await runGit(this.repoRoot, ["worktree", "prune"]);
  }

  private async mergeBase(a: string, b: string): Promise<string | undefined> {
    const r = await runGit(this.repoRoot, ["merge-base", a, b]);
    return r.code === 0 ? r.stdout.trim() : undefined;
  }
}
