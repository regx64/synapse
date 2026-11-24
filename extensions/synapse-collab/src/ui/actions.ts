import * as path from "node:path";
import * as vscode from "vscode";
import type { CoreConnection } from "../connection.js";
import { l } from "./l10n.js";
import type { Selection } from "./selection.js";

/** What a Synapse webview can ask the extension to do. */
export type ViewMessage =
  | { type: "ready" }
  | { type: "command"; command: string; args?: unknown[] }
  | { type: "select"; id: string; show?: "detail" | "diff" | "tests" }
  | { type: "prompt"; id: string; text: string }
  | { type: "steer"; id: string; text: string; mode: "now" | "next" }
  | { type: "teamSync" }
  | { type: "teamDismiss"; id: string }
  | { type: "approve"; id: string; optionId: string }
  | { type: "openFile"; path: string; agentId?: string; line?: number }
  | { type: "createTask"; title: string; description?: string; agentId?: string; dependsOn?: string[]; scope?: string[]; autoStart?: boolean }
  | { type: "taskAction"; id: string; action: "start" | "done" | "failed" | "todo" | "remove" }
  | { type: "sendMessage"; to: string; kind: "note"; subject: string; body?: string }
  | { type: "messageAction"; id: string; action: "release" | "reject" }
  | { type: "addDecision"; title: string; decision: string; rationale?: string; pins?: string }
  | { type: "decisionAction"; id: string; status: "accepted" | "rejected" | "superseded" }
  | { type: "decisionRepin"; id: string }
  | { type: "decisionUnpin"; id: string; path: string; symbol?: string }
  | { type: "editPolicy"; agentId: string }
  | { type: "dismissChecklist" }
  | { type: "tellConflict"; id: string; agentId: string }
  | { type: "rewind"; id: string; n: number }
  | { type: "runTests"; id: string };

/** Commands a webview may run through `{ type: "command" }`. */
const ALLOWED_COMMANDS = new Set([
  "synapse.startCore",
  "synapse.addAgent",
  "synapse.startAgent",
  "synapse.stopAgent",
  "synapse.restartAgent",
  "synapse.cancelAgent",
  "synapse.removeAgent",
  "synapse.teamAdopt",
  "synapse.liveDiff",
  "synapse.takeover",
  "synapse.agentMenu",
  "synapse.showOutput",
  "synapse.resetAgent",
  "synapse.prepareReview",
  "synapse.checkConflicts",
  "synapse.newTask",
  "synapse.initConfig",
  "synapse.openHome",
  "synapse.showFiles",
  "synapse.showAgents",
  "synapse.editPolicy",
  "synapse.enableTeam",
  "workbench.action.openSettings",
]);

/**
 * Carries out a webview's request against synapse-core. Shared by the home
 * tab, the agents list and the agent detail view, so each acts the same.
 */
export async function handleViewMessage(m: ViewMessage, conn: CoreConnection, selection: Selection, context: vscode.ExtensionContext): Promise<void> {
  try {
    switch (m.type) {
      case "ready":
        return;
      case "command":
        if (!ALLOWED_COMMANDS.has(m.command)) throw new Error(`command not allowed from a view: ${m.command}`);
        await vscode.commands.executeCommand(m.command, ...(m.args ?? []));
        return;
      case "select":
        selection.select(m.id);
        if (m.show === "diff") await vscode.commands.executeCommand("synapse.liveDiff", m.id);
        else if (m.show === "detail" || m.show === "tests") {
          await vscode.commands.executeCommand("synapse.detail.focus");
          if (m.show === "tests") selection.showTab("changes");
        }
        return;
      case "prompt":
        if (m.text.trim()) await conn.call("agents.prompt", { id: m.id, text: m.text });
        return;
      case "steer":
        if (m.text.trim()) await conn.call("agents.steer", { id: m.id, text: m.text, mode: m.mode });
        return;
      case "teamDismiss":
        await conn.call("team.dismissClaim", { id: m.id });
        return;
      case "teamSync": {
        const t = await conn.call("team.sync");
        if (t.error) void vscode.window.showWarningMessage(l("Synapse team sync: {0}", t.error));
        return;
      }
      case "approve":
        await conn.call("approvals.resolve", { id: m.id, optionId: m.optionId });
        return;
      case "createTask": {
        const { type: _t, ...p } = m;
        await conn.call("tasks.create", p);
        return;
      }
      case "taskAction":
        if (m.action === "remove") await conn.call("tasks.remove", { id: m.id });
        else if (m.action === "start") await conn.call("tasks.start", { id: m.id });
        else await conn.call("tasks.setStatus", { id: m.id, status: m.action });
        return;
      case "sendMessage":
        await conn.call("messages.send", { to: m.to, kind: m.kind, subject: m.subject, body: m.body });
        return;
      case "messageAction":
        await conn.call(m.action === "release" ? "messages.release" : "messages.reject", { id: m.id });
        return;
      case "addDecision": {
        // "path#Symbol, other/path" → pins
        const pins = (m.pins ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => (s.lastIndexOf("#") > 0 ? { path: s.slice(0, s.lastIndexOf("#")), symbol: s.slice(s.lastIndexOf("#") + 1) } : { path: s }));
        await conn.call("decisions.add", { title: m.title, decision: m.decision, rationale: m.rationale || undefined, pins: pins.length ? pins : undefined });
        return;
      }
      case "decisionRepin":
        await conn.call("decisions.repin", { id: m.id });
        return;
      case "decisionUnpin":
        await conn.call("decisions.unpin", { id: m.id, path: m.path, symbol: m.symbol });
        return;
      case "decisionAction":
        await conn.call("decisions.resolve", { id: m.id, status: m.status });
        return;
      case "editPolicy":
        await vscode.commands.executeCommand("synapse.editPolicy", m.agentId);
        return;
      case "tellConflict": {
        const a = await conn.call("conflicts.tell", { id: m.id, agentId: m.agentId });
        void vscode.window.showInformationMessage(l("Synapse: {0} will get this after its current turn.", a.name));
        return;
      }
      case "rewind": {
        const name = conn.state?.agents.find((a) => a.id === m.id)?.name ?? m.id;
        const go = l("Rewind");
        const ok = await vscode.window.showWarningMessage(l("Put {0}'s worktree back to how it was before this turn? Changes made since are discarded (the conversation stays).", name), { modal: true }, go);
        if (ok === go) await conn.call("agents.rewind", { id: m.id, n: m.n });
        return;
      }
      case "runTests":
        await conn.call("agents.test", { id: m.id });
        return;
      case "dismissChecklist":
        await context.workspaceState.update("synapse.checklistDismissed", true);
        return;
      case "openFile": {
        const agent = m.agentId ? conn.state?.agents.find((a) => a.id === m.agentId) : undefined;
        const root = agent ? agent.worktree.path : conn.repoRoot;
        const file = path.resolve(root, m.path);
        if (file !== root && !file.startsWith(root + path.sep)) throw new Error(`not in the repository: ${m.path}`);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        const line = Math.max(0, m.line ?? 0);
        await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0), preview: true });
        return;
      }
    }
  } catch (err) {
    void vscode.window.showErrorMessage(l("Synapse: {0}", (err as Error).message));
  }
}
