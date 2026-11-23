import type { AgentOwnership, AgentState, CallSite, Conflict } from "@synapse/protocol";
import { predictMergeConflicts } from "./git.js";
import type { FileDetail } from "./ownership.js";
import { languageFor } from "./symbols.js";
import { nowIso, shortHash } from "./util.js";

/**
 * Finds conflicts between agents before anything is merged:
 *
 *  - same-symbol:      two agents change the same symbol;
 *  - signature-change: one agent changes (or removes) a function's signature
 *                      while another agent's new or changed code calls it.
 *                      This merges cleanly as text and still breaks;
 *  - text-conflict:    the agents' work would not merge cleanly as text;
 *  - same-file:        two agents edit different symbols of one file (info).
 */

export interface DetectInput {
  agents: AgentState[];
  ownership: AgentOwnership[];
  details: (agentId: string) => Map<string, FileDetail>;
  /** Paths that conflict textually, keyed by `pairKey(a, b)`. */
  textConflicts: Map<string, string[]>;
}

export const pairKey = (a: string, b: string) => [a, b].sort().join("|");

const family = (p: string) => {
  const l = languageFor(p);
  return l === "typescript" || l === "tsx" || l === "javascript" ? "js" : l;
};

function conflictId(kind: string, agents: string[], path: string, symbol?: string): string {
  return `${kind}-${shortHash([kind, [...agents].sort().join(","), path, symbol ?? ""].join("|"), 10)}`;
}

export function detectConflicts(input: DetectInput): Conflict[] {
  const names = new Map(input.agents.map((a) => [a.id, a.name]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const now = nowIso();
  const conflicts: Conflict[] = [];
  const own = input.ownership.filter((o) => names.has(o.agentId));

  // --- same-symbol and same-file -------------------------------------------
  const bySymbol = new Map<string, { path: string; symbol: string; agents: Map<string, string> }>();
  const byFile = new Map<string, Set<string>>();
  for (const o of own) {
    for (const f of o.files) {
      if (!byFile.has(f.path)) byFile.set(f.path, new Set());
      byFile.get(f.path)!.add(o.agentId);
      for (const s of f.symbols) {
        const key = `${f.path}::${s.name}`;
        if (!bySymbol.has(key)) bySymbol.set(key, { path: f.path, symbol: s.name, agents: new Map() });
        bySymbol.get(key)!.agents.set(o.agentId, s.change);
      }
    }
  }
  const pathsWithSymbolConflict = new Set<string>();
  for (const { path, symbol, agents } of bySymbol.values()) {
    if (agents.size < 2) continue;
    const ids = [...agents.keys()].sort();
    pathsWithSymbolConflict.add(path);
    const parts = ids.map((id) => `${nameOf(id)} (${agents.get(id)})`).join(" and ");
    conflicts.push({
      id: conflictId("same-symbol", ids, path, symbol),
      kind: "same-symbol",
      severity: "error",
      agents: ids,
      path,
      symbol,
      message: `${parts} are both changing \`${symbol}\` in ${path}.`,
      firstSeen: now,
    });
  }

  // --- signature-change ------------------------------------------------------
  for (const owner of own) {
    for (const file of owner.files) {
      for (const sym of file.symbols) {
        const breaking = (sym.signatureChanged || sym.change === "removed") && (sym.kind === "function" || sym.kind === "method");
        if (!breaking) continue;
        const shortName = sym.name.includes(".") ? sym.name.slice(sym.name.lastIndexOf(".") + 1).replace(/~\d+$/, "") : sym.name.replace(/~\d+$/, "");
        for (const other of own) {
          if (other.agentId === owner.agentId) continue;
          const newParams =
            sym.change === "removed" ? undefined : input.details(owner.agentId).get(file.path)?.newParsed?.symbols.find((s) => s.name === sym.name)?.params;
          const sites = findCallSites(other.agentId, input.details(other.agentId), shortName, family(file.path));
          // A call that already fits the new signature is not a problem.
          const newSites = sites.filter((s) => s.isNew && !(sym.change !== "removed" && fits(s.argCount, newParams)));
          if (newSites.length === 0) continue;
          const ids = [owner.agentId, other.agentId];
          const what = sym.change === "removed" ? `removed \`${sym.name}\`` : `changed the signature of \`${sym.name}\` from \`${sym.oldSignature ?? "?"}\` to \`${sym.newSignature ?? "?"}\``;
          const where = newSites
            .slice(0, 3)
            .map((s) => `${s.path}:${s.line + 1}`)
            .join(", ");
          conflicts.push({
            id: conflictId("signature-change", ids, file.path, sym.name),
            kind: "signature-change",
            severity: "error",
            agents: ids,
            path: file.path,
            symbol: sym.name,
            message: `${nameOf(owner.agentId)} ${what} in ${file.path}, but ${nameOf(other.agentId)}'s work calls it (${where}${newSites.length > 3 ? ", …" : ""}). The merge may be clean as text and still break.`,
            signature: { owner: owner.agentId, old: sym.oldSignature, new: sym.newSignature },
            callSites: newSites,
            firstSeen: now,
          });
        }
      }
    }
  }

  // --- text-conflict ---------------------------------------------------------
  for (const [key, paths] of input.textConflicts) {
    const ids = key.split("|");
    for (const p of paths) {
      conflicts.push({
        id: conflictId("text-conflict", ids, p),
        kind: "text-conflict",
        severity: "error",
        agents: ids,
        path: p,
        message: `${ids.map(nameOf).join(" and ")} have changes to ${p} that will not merge cleanly.`,
        firstSeen: now,
      });
    }
  }

  // --- same-file (informational) ---------------------------------------------
  const textConflictPaths = new Set([...input.textConflicts.values()].flat());
  for (const [p, agents] of byFile) {
    if (agents.size < 2 || pathsWithSymbolConflict.has(p) || textConflictPaths.has(p)) continue;
    const ids = [...agents].sort();
    conflicts.push({
      id: conflictId("same-file", ids, p),
      kind: "same-file",
      severity: "info",
      agents: ids,
      path: p,
      message: `${ids.map(nameOf).join(" and ")} are editing different parts of ${p}.`,
      firstSeen: now,
    });
  }

  const order = { error: 0, warning: 1, info: 2 } as const;
  return conflicts.sort((a, b) => order[a.severity] - order[b.severity] || a.path.localeCompare(b.path));
}

function fits(argCount: number | undefined, params: { min: number; max: number } | undefined): boolean {
  if (argCount === undefined || !params) return false;
  return argCount >= params.min && argCount <= params.max;
}

function findCallSites(agentId: string, details: Map<string, FileDetail>, callee: string, fam: string | undefined): CallSite[] {
  const sites: CallSite[] = [];
  for (const d of details.values()) {
    if (!d.newParsed || family(d.path) !== fam) continue;
    for (const call of d.newParsed.calls) {
      if (call.callee !== callee) continue;
      const isNew =
        d.status === "added" ||
        (call.inSymbol !== undefined && d.changedSymbols.has(call.inSymbol)) ||
        (call.inSymbol === undefined && !(d.oldText ?? "").includes(call.text));
      sites.push({ agentId, path: d.path, inSymbol: call.inSymbol, line: call.line, text: call.text, isNew, argCount: call.argCount });
    }
  }
  return sites;
}

/** Predicts textual merge conflicts for every pair of agents that touch a common file. */
export async function computeTextConflicts(repoRoot: string, ownership: AgentOwnership[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (let i = 0; i < ownership.length; i++) {
    for (let j = i + 1; j < ownership.length; j++) {
      const a = ownership[i]!;
      const b = ownership[j]!;
      if (!a.snapshot || !b.snapshot) continue;
      const aPaths = new Set(a.files.map((f) => f.path));
      if (!b.files.some((f) => aPaths.has(f.path))) continue;
      try {
        const r = await predictMergeConflicts(repoRoot, a.snapshot, b.snapshot);
        if (!r.clean) result.set(pairKey(a.agentId, b.agentId), r.paths);
      } catch {
        /* unrelated histories or old git: skip */
      }
    }
  }
  return result;
}
