import type { Conflict } from "@synapse/client";
import { l } from "./l10n.js";

/** A conflict in the editor's language, from its structured data (the core's message is English). */
export function conflictText(c: Conflict, nameOf: (id: string) => string): string {
  const and = l(" and ");
  const names = c.agents.map(nameOf);
  const sites = (c.callSites ?? []).slice(0, 3).map((x) => `${x.path}:${x.line + 1}`).join(", ") + ((c.callSites ?? []).length > 3 ? ", …" : "");
  switch (c.kind) {
    case "signature-change": {
      const owner = nameOf(c.signature?.owner ?? c.agents[0] ?? "");
      const other = names.filter((n) => n !== owner).join(and);
      return c.signature?.new
        ? l("{0} changed the signature of `{1}` in {2} from `{3}` to `{4}`, but {5}'s work calls it ({6}). The merge may be clean as text and still break.", owner, c.symbol ?? "", c.path, c.signature.old ?? "?", c.signature.new, other, sites)
        : l("{0} removed `{1}` in {2}, but {3}'s work calls it ({4}).", owner, c.symbol ?? "", c.path, other, sites);
    }
    case "same-symbol":
      return l("{0} are both changing `{1}` in {2}.", names.join(and), c.symbol ?? "", c.path);
    case "text-conflict":
      return l("{0} have changes to {1} that will not merge cleanly.", names.join(and), c.path);
    case "same-file":
      return l("{0} are editing different parts of {1}.", names.join(and), c.path);
    case "decision":
      return l("{0} is changing {1}, which decision {2} is pinned to. Check that the change still follows it.", names[0] ?? "", c.symbol ? `${c.path} › ${c.symbol}` : c.path, c.decisionId ?? "");
    default:
      return c.message;
  }
}
