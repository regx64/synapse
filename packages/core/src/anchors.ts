import { createHash } from "node:crypto";
import type { AgentOwnership, AgentState, Conflict, Decision, DecisionAnchor, DecisionPin, Range } from "@synapse/protocol";
import { ErrorCodes, RpcError } from "@synapse/protocol";
import { showFile } from "./git.js";
import { parseSource, type ParsedSymbol } from "./symbols.js";
import { nowIso, shortHash, toPosix } from "./util.js";

/**
 * Decisions pinned to code.
 *
 * A pin records a fingerprint of a file or of one symbol (its whole text,
 * nested members included) on the base branch. Two things are checked:
 *
 *  - the base branch moved and the pinned code is different now: the anchor
 *    becomes `changed` (or `missing`), and stays so until the person confirms
 *    the decision still holds (re-pin) or supersedes it;
 *  - an agent is changing pinned code in its worktree: a `decision` conflict,
 *    so the person sees it before merging.
 *
 * Fingerprints ignore whitespace, so reformatting does not flag a decision.
 */

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const hash = (text: string) => createHash("sha256").update(normalize(text)).digest("hex").slice(0, 16);

/** Validates and normalizes a pin given by a person or an agent. */
export function normalizePin(pin: DecisionPin): DecisionPin {
  const raw = toPosix(String(pin?.path ?? "").trim()).replace(/^\.\//, "");
  if (!raw || raw.startsWith("/") || /^[a-zA-Z]:/.test(raw) || raw.split("/").includes("..")) {
    throw new RpcError(ErrorCodes.InvalidParams, `Pin a repository-relative path, not "${pin?.path}"`);
  }
  const symbol = pin.symbol?.trim() || undefined;
  return symbol ? { path: raw, symbol } : { path: raw };
}

/** Parses "path#Symbol" (CLI and agents' tool calls). */
export function parsePinSpec(spec: string): DecisionPin {
  const at = spec.lastIndexOf("#");
  return at > 0 ? { path: spec.slice(0, at), symbol: spec.slice(at + 1) } : { path: spec };
}

export const pinLabel = (p: DecisionPin) => (p.symbol ? `${p.path} › ${p.symbol}` : p.path);
export const samePin = (a: DecisionPin, b: DecisionPin) => a.path === b.path && (a.symbol ?? "") === (b.symbol ?? "");

function sliceRange(content: string, r: Range): string {
  const lines = content.split("\n");
  if (r.startLine === r.endLine) return (lines[r.startLine] ?? "").slice(r.startCol, r.endCol);
  return [(lines[r.startLine] ?? "").slice(r.startCol), ...lines.slice(r.startLine + 1, r.endLine), (lines[r.endLine] ?? "").slice(0, r.endCol)].join("\n");
}

/** Fingerprint of the pinned code in `content`, or undefined when the symbol is not there. */
export async function fingerprintOf(pin: DecisionPin, content: string): Promise<string | undefined> {
  if (!pin.symbol) return hash(content);
  const parsed = await parseSource(pin.path, content);
  if (!parsed) throw new RpcError(ErrorCodes.InvalidParams, `Synapse cannot parse ${pin.path}; pin the whole file instead`);
  const sym = parsed.symbols.find((s) => s.name === pin.symbol);
  return sym ? hash(sliceRange(content, sym.range)) : undefined;
}

/** Fingerprint at a commit, or undefined when the file or symbol does not exist there. */
export async function fingerprintAt(repoRoot: string, commit: string, pin: DecisionPin): Promise<string | undefined> {
  const content = await showFile(repoRoot, commit, pin.path);
  if (content === null) return undefined;
  return fingerprintOf(pin, content);
}

/** Creates an anchor on the base branch; fails when the code to pin is not there. */
export async function createAnchor(repoRoot: string, baseCommit: string, pin: DecisionPin): Promise<DecisionAnchor> {
  const p = normalizePin(pin);
  const fingerprint = await fingerprintAt(repoRoot, baseCommit, p);
  if (!fingerprint) {
    throw new RpcError(ErrorCodes.NotFound, p.symbol ? `No symbol "${p.symbol}" in ${p.path} on the base branch` : `${p.path} is not on the base branch`);
  }
  return { ...p, fingerprint, pinnedCommit: baseCommit, pinnedAt: nowIso(), state: "current", checkedCommit: baseCommit };
}

/**
 * Re-checks a decision's anchors against the base commit. Returns undefined
 * when every anchor was already checked at this commit (cheap to call often);
 * otherwise the updated decision and whether any anchor's state changed.
 */
export async function checkAnchors(repoRoot: string, baseCommit: string, d: Decision): Promise<{ decision: Decision; stateChanged: boolean } | undefined> {
  if (!d.anchors?.length || d.anchors.every((a) => a.checkedCommit === baseCommit)) return undefined;
  let stateChanged = false;
  const anchors: DecisionAnchor[] = [];
  for (const a of d.anchors) {
    if (a.checkedCommit === baseCommit) {
      anchors.push(a);
      continue;
    }
    let state: DecisionAnchor["state"];
    try {
      const now = await fingerprintAt(repoRoot, baseCommit, a);
      state = now === undefined ? "missing" : now === a.fingerprint ? "current" : "changed";
    } catch {
      state = "changed"; // the file no longer parses
    }
    if (state !== a.state) stateChanged = true;
    anchors.push({ ...a, state, checkedCommit: baseCommit });
  }
  return { decision: { ...d, anchors }, stateChanged };
}

/** The innermost symbol containing a 0-based line. */
export function symbolAtLine(symbols: ParsedSymbol[], line: number): ParsedSymbol | undefined {
  return symbols
    .filter((s) => s.range.startLine <= line && line <= s.range.endLine)
    .sort((a, b) => a.range.endLine - a.range.startLine - (b.range.endLine - b.range.startLine))[0];
}

/** Agents changing code that accepted decisions are pinned to. */
export function detectDecisionConflicts(decisions: Decision[], agents: AgentState[], ownership: AgentOwnership[]): Conflict[] {
  const names = new Map(agents.map((a) => [a.id, a.name]));
  const out: Conflict[] = [];
  for (const d of decisions) {
    if (d.status !== "accepted" || !d.anchors?.length) continue;
    for (const own of ownership) {
      for (const a of d.anchors) {
        const file = own.files.find((f) => f.path === a.path);
        if (!file) continue;
        const touched = !a.symbol
          ? true
          : !file.parsed || file.status === "deleted" || file.symbols.some((s) => s.name === a.symbol || s.name.startsWith(`${a.symbol}.`));
        if (!touched) continue;
        const removing = file.status === "deleted" || file.symbols.some((s) => s.name === a.symbol && s.change === "removed");
        const who = names.get(own.agentId) ?? own.agentId;
        out.push({
          id: `decision-${shortHash([d.id, own.agentId, a.path, a.symbol ?? ""].join("|"), 10)}`,
          kind: "decision",
          severity: "warning",
          agents: [own.agentId],
          path: a.path,
          symbol: a.symbol,
          decisionId: d.id,
          message: `${who} is ${removing ? "removing" : "changing"} ${a.symbol ?? a.path}, which decision ${d.id} ("${d.title}") is pinned to. Check the change still follows it, or update the decision.`,
          firstSeen: nowIso(),
        });
      }
    }
  }
  return out;
}
