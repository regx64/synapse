import * as path from "node:path";
import * as vscode from "vscode";
import type { CodeComment } from "@synapse/client";
import type { CoreConnection } from "./connection.js";
import { liveDiffHtml } from "./livediff-html.js";

/** One panel per agent: its changes as they happen, with the person's comments on them. */
export class LiveDiffPanel implements vscode.Disposable {
  private static readonly open = new Map<string, LiveDiffPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private lastKey = "";
  private refreshing?: Promise<void>;

  static show(conn: CoreConnection, agentId: string): void {
    const existing = LiveDiffPanel.open.get(agentId);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    LiveDiffPanel.open.set(agentId, new LiveDiffPanel(conn, agentId));
  }

  private constructor(
    private readonly conn: CoreConnection,
    private readonly agentId: string,
  ) {
    const name = conn.state?.agents.find((a) => a.id === agentId)?.name ?? agentId;
    this.panel = vscode.window.createWebviewPanel("synapse.liveDiff", `${name}: live changes`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel.webview.html = liveDiffHtml(name);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), undefined, this.disposables);
    // Re-fetch when the agent's snapshot or its comments change.
    this.disposables.push(conn.onState(() => void this.refresh()));
  }

  private key(): string {
    const s = this.conn.state;
    const own = s?.ownership[this.agentId];
    const comments = (s?.comments ?? []).filter((c) => c.agentId === this.agentId).map((c) => `${c.id}:${c.updatedAt}`);
    return `${own?.snapshot ?? ""}|${own?.updatedAt ?? ""}|${comments.join(",")}`;
  }

  private async refresh(force = false): Promise<void> {
    const key = this.key();
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    // One request at a time; a newer state triggers another round.
    await this.refreshing;
    this.refreshing = (async () => {
      try {
        const diff = await this.conn.call("agents.diff", { id: this.agentId });
        const comments: CodeComment[] = (this.conn.state?.comments ?? []).filter((c) => c.agentId === this.agentId);
        void this.panel.webview.postMessage({ type: "data", diff, comments });
      } catch (err) {
        void vscode.window.showErrorMessage(`Synapse: ${(err as Error).message}`);
      }
    })();
    await this.refreshing;
  }

  private async onMessage(m: { type: string; path?: string; line?: number; text?: string; action?: CodeComment["action"]; id?: string; status?: CodeComment["status"] }): Promise<void> {
    try {
      if (m.type === "ready") await this.refresh(true);
      else if (m.type === "comment" && m.path && m.line && m.text) {
        const c = await this.conn.call("comments.add", { agentId: this.agentId, path: m.path, line: m.line, text: m.text, action: m.action });
        if (c.action === "task") void vscode.window.showInformationMessage(`Synapse: created task ${c.taskId} for this agent.`);
        await this.refresh(true);
      } else if (m.type === "resolve" && m.id) {
        await this.conn.call("comments.resolve", { id: m.id, status: m.status });
        await this.refresh(true);
      } else if (m.type === "open" && m.path) {
        const agent = this.conn.state?.agents.find((a) => a.id === this.agentId);
        const root = agent ? agent.worktree.path : this.conn.repoRoot;
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, m.path)), { preview: true });
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Synapse: ${(err as Error).message}`);
    }
  }

  dispose(): void {
    LiveDiffPanel.open.delete(this.agentId);
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
