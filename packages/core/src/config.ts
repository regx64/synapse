import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentPolicy } from "@synapse/protocol";

/**
 * Workspace configuration. Read from `synapse.config.json` at the repository
 * root (meant to be committed) and then `.synapse/config.json` (local
 * overrides, not committed).
 */
export interface SynapseConfig {
  /** Branch that agents start from and reviews merge into. Default: the branch checked out at startup. */
  baseRef?: string;
  /** Command run in the integration worktree during a combined review, e.g. "npm test". */
  testCommand?: string;
  /** Command run in the integration worktree before tests, e.g. "npm ci". */
  setupCommand?: string;
  /** Default 10 minutes. */
  testTimeoutMs?: number;
  /** Debounce for ownership refreshes after file changes. Default 750 ms. */
  ownershipDebounceMs?: number;
  /** Default permission policy for agents, on top of Synapse's built-in default. */
  policy?: Partial<AgentPolicy>;
  /** Where the decision log is written as Markdown. Default `.synapse/decisions.md`; set e.g. `docs/decisions.md` to commit it. */
  decisionLogPath?: string;
  /**
   * Team mode (off by default): publish this person's agents' work in progress
   * to the git remote under refs/synapse/team/<name>/ and read teammates', so
   * conflicts across people show up before merge. It pushes unfinished code
   * to that remote, like pushing a branch.
   */
  team?: { enabled?: boolean; remote?: string; name?: string; intervalSec?: number; members?: Record<string, "editor" | "viewer"> };
  /** Agent preset overrides, keyed by preset id. */
  presets?: Record<string, { command?: string; args?: string[]; name?: string; color?: string }>;
}

export async function loadConfig(repoRoot: string): Promise<SynapseConfig> {
  const merged: SynapseConfig = {};
  for (const file of [path.join(repoRoot, "synapse.config.json"), path.join(repoRoot, ".synapse", "config.json")]) {
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(text) as SynapseConfig;
      Object.assign(merged, parsed, { presets: { ...merged.presets, ...parsed.presets } });
    } catch (err) {
      throw new Error(`Invalid JSON in ${file}: ${(err as Error).message}`);
    }
  }
  return merged;
}
