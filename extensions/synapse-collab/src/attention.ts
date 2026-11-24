import * as vscode from "vscode";
import type { AgentState, Approval, CoreState, Task } from "@synapse/client";
import type { CoreConnection } from "./connection.js";
import { l } from "./ui/l10n.js";

/** Commands added to the workbench by Synapse's core patch (absent in a plain editor). */
const TITLE_STATUS = "_synapse.titleStatus";
const OS_NOTIFY = "_synapse.osNotify";

export interface TitleStatus {
  working: number;
  needs: number;
  review: number;
  conflicts: number;
  labels: { working: string; needs: string; review: string; conflicts: string; tooltip: string };
}

export function titleStatus(s: CoreState | undefined): TitleStatus | undefined {
  if (!s) return undefined;
  return {
    working: s.agents.filter((a) => a.status === "working").length,
    needs: s.approvals.filter((a) => a.status === "pending").length,
    review: s.tasks.filter((t) => t.status === "review").length,
    conflicts: s.conflicts.filter((c) => c.severity !== "info").length,
    labels: { working: l("Working"), needs: l("Needs you"), review: l("To review"), conflicts: l("Conflict"), tooltip: l("Open Synapse home") },
  };
}

/**
 * What tells the person something needs them: the status in the title bar
 * (a status bar item where the workbench has no Synapse title bar), and
 * notifications. When the window is in the background, approvals, agent
 * errors and finished work become desktop notifications (each can be turned
 * off in settings).
 */
export function attention(conn: CoreConnection): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];
  let hasTitle: boolean | undefined;
  let hasOsNotify = false;
  const ready = vscode.commands.getCommands(false).then((all) => {
    hasTitle = all.includes(TITLE_STATUS);
    hasOsNotify = all.includes(OS_NOTIFY);
  });

  const item = vscode.window.createStatusBarItem("synapse.status", vscode.StatusBarAlignment.Left, 50);
  item.name = "Synapse";
  item.command = "synapse.openHome";
  disposables.push(item);

  const showStatus = async (s: CoreState | undefined) => {
    await ready;
    const st = titleStatus(s);
    if (hasTitle) {
      await vscode.commands.executeCommand(TITLE_STATUS, st ?? null).then(undefined, () => {});
      item.hide();
      return;
    }
    if (!st) {
      item.text = "$(circle-slash) Synapse";
      item.tooltip = l("synapse-core is not connected");
    } else {
      const parts = [`$(organization) ${st.labels.working} ${st.working}`];
      if (st.needs) parts.push(`$(bell) ${st.needs}`);
      if (st.review) parts.push(`$(tasklist) ${st.review}`);
      if (st.conflicts) parts.push(`$(warning) ${st.conflicts}`);
      item.text = parts.join("  ");
      item.tooltip = st.labels.tooltip;
      item.backgroundColor = st.conflicts ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    }
    item.show();
  };
  disposables.push(conn.onState((s) => void showStatus(s)));
  void showStatus(conn.state);

  const cfg = () => vscode.workspace.getConfiguration("synapse.notifications");
  /** Desktop notification when the window is in the background, else an in-app one. */
  const notify = async (kind: "approvals" | "errors" | "finished", title: () => string, body: string, action?: { label: string; run: () => unknown }) => {
    await ready;
    // The event can arrive before the state that names a new agent.
    await conn.refresh().catch(() => {});
    if (!vscode.window.state.focused && hasOsNotify && cfg().get<boolean>(kind, true)) {
      await vscode.commands.executeCommand(OS_NOTIFY, { title: title(), body }).then(undefined, () => {});
      return;
    }
    const show = kind === "errors" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const pick = await show(`${title()}: ${body}`, ...(action ? [action.label] : []));
    if (pick && action) await action.run();
  };

  const prev = new Map<string, AgentState["status"]>();
  const taskStatus = new Map<string, Task["status"]>();
  const name = (id: string) => conn.state?.agents.find((a) => a.id === id)?.name ?? id;
  disposables.push(
    conn.onEvent((ev) => {
      switch (ev.type) {
        case "approval.requested": {
          const ap = ev.data as Approval;
          void notify("approvals", () => l("{0} needs you", name(ap.agentId)), ap.title, { label: l("Open home"), run: () => vscode.commands.executeCommand("synapse.openHome") });
          return;
        }
        case "agent.updated": {
          const a = ev.data as AgentState;
          const before = prev.get(a.id);
          prev.set(a.id, a.status);
          if (a.status === "error" && before && before !== "error") {
            void notify("errors", () => l("{0} stopped with an error", a.name), a.error ?? "", { label: l("Show details"), run: () => vscode.commands.executeCommand("synapse.showDetail", a.id) });
          }
          return;
        }
        case "task.updated": {
          const t = ev.data as Task;
          const before = taskStatus.get(t.id);
          taskStatus.set(t.id, t.status);
          if (t.status === "review" && before && before !== "review") {
            void notify("finished", () => l("{0} finished", t.agentId ? name(t.agentId) : t.id), t.title, { label: l("Review & merge"), run: () => vscode.commands.executeCommand("synapse.prepareReview") });
          }
          return;
        }
        case "message.updated": {
          const m = ev.data as { status: string; from: string; subject: string };
          if (m.status === "held") void vscode.window.showWarningMessage(l("Synapse held a message from {0}: \"{1}\". Review it on the home tab.", name(m.from), m.subject));
          return;
        }
        case "core.log": {
          const d = ev.data as { level?: string; message?: string };
          if (d.level === "warning" && d.message) void vscode.window.showWarningMessage(l("Synapse: {0}", d.message));
          return;
        }
      }
    }),
    conn.onState((s) => {
      // Seed what we compare against, so a reconnect doesn't notify about old news.
      for (const a of s?.agents ?? []) if (!prev.has(a.id)) prev.set(a.id, a.status);
      for (const t of s?.tasks ?? []) if (!taskStatus.has(t.id)) taskStatus.set(t.id, t.status);
    }),
  );
  return vscode.Disposable.from(...disposables);
}
