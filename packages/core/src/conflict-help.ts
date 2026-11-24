import type { AgentState, Conflict } from "@synapse/protocol";
import { ErrorCodes, RpcError } from "@synapse/protocol";
import type { AgentManager } from "./agents.js";
import type { StateStore } from "./store.js";

/**
 * Tells one of the agents in a conflict what the other agent is doing and
 * what to change, as guidance after its current turn (or as a prompt when
 * it is idle). The text is written for the agent; the conflict is data.
 */
export function tellAboutConflict(store: StateStore, agents: AgentManager, conflictId: string, agentId: string): AgentState {
  const c = store.getConflicts().find((x) => x.id === conflictId);
  if (!c) throw new RpcError(ErrorCodes.NotFound, `No conflict "${conflictId}" (it may have been resolved)`);
  if (!c.agents.includes(agentId)) throw new RpcError(ErrorCodes.InvalidParams, `${agentId} is not part of this conflict`);
  if (agentId.startsWith("@")) throw new RpcError(ErrorCodes.InvalidParams, "A teammate's agent can only be told by its owner");
  const a = store.getAgent(agentId);
  if (!a) throw new RpcError(ErrorCodes.NotFound, `No agent "${agentId}"`);
  return agents.steer(agentId, conflictGuidance(c, agentId, (id) => store.getAgent(id)?.name ?? id), "next");
}

/** The guidance an agent gets about a conflict it is part of. */
export function conflictGuidance(c: Conflict, agentId: string, nameOf: (id: string) => string): string {
  const others = c.agents.filter((x) => x !== agentId).map(nameOf).join(" and ") || "another agent";
  const at = c.symbol ? `\`${c.symbol}\` in ${c.path}` : c.path;
  switch (c.kind) {
    case "signature-change": {
      const owner = c.signature?.owner;
      const change = c.signature?.new ? `from \`${c.signature.old ?? "?"}\` to \`${c.signature.new}\`` : "(it is being removed)";
      const sites = (c.callSites ?? []).filter((s) => s.agentId !== owner);
      const list = sites.length ? sites.map((s) => `- ${s.path}:${s.line + 1}: ${s.text.trim()}`).join("\n") : "- (see your changes)";
      if (owner === agentId) {
        return [
          `Synapse found a conflict: you changed the signature of \`${c.symbol}\` in ${c.path} ${change}, and ${others}'s work still calls it the old way:`,
          list,
          `Keep those calls working (for example give new parameters a default), or tell the person if the change has to break them.`,
        ].join("\n");
      }
      return [
        `Synapse found a conflict: ${nameOf(owner ?? "")} changed the signature of \`${c.symbol}\` in ${c.path} ${change}. Your work calls it the old way:`,
        list,
        `Update these calls to the new signature.`,
      ].join("\n");
    }
    case "same-symbol":
      return `Synapse found a conflict: ${others} is also changing ${at}. Keep your change to it as small as the task allows and compatible with theirs, or leave that code to them and say so in your summary.`;
    case "text-conflict":
      return `Synapse found a conflict: your changes to ${c.path} and ${others}'s will not merge cleanly as text. Limit your edits in ${c.path} to what the task needs, and avoid reformatting or moving code there.`;
    case "decision":
      return `Synapse found a conflict: you are changing ${at}, which an accepted project decision (${c.decisionId ?? "?"}) is pinned to. Check that your change still follows it; if it cannot, stop and say why.`;
    default:
      return `Synapse found a conflict with ${others} in ${at}. Coordinate: keep your changes there minimal.`;
  }
}
