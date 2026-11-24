import * as path from "node:path";
import * as vscode from "vscode";
import type { CodeComment } from "@synapse/client";
import type { CoreConnection } from "./connection.js";
import { pageHtml, webviewRoots } from "./ui/html.js";
import { l } from "./ui/l10n.js";

/** One panel per agent: its changes as they happen, with the person's comments on them. */
export class LiveDiffPanel implements vscode.Disposable {
  private static readonly open = new Map<string, LiveDiffPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private lastKey = "";
  private refreshing?: Promise<void>;

  static show(conn: CoreConnection, extensionUri: vscode.Uri, agentId: string): void {
    const existing = LiveDiffPanel.open.get(agentId);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    LiveDiffPanel.open.set(agentId, new LiveDiffPanel(conn, extensionUri, agentId));
  }

  private constructor(
    private readonly conn: CoreConnection,
    extensionUri: vscode.Uri,
    private readonly agentId: string,
  ) {
    const name = conn.state?.agents.find((a) => a.id === agentId)?.name ?? agentId;
    this.panel = vscode.window.createWebviewPanel("synapse.liveDiff", l("{0}: live changes", name), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: webviewRoots(extensionUri),
    });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "synapse.svg");
    this.panel.webview.html = pageHtml(this.panel.webview, extensionUri, "livediff", l("{0}: live changes", name));
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), undefined, this.disposables);
    // Re-fetch when the agent's snapshot or its comments change.
    this.disposables.push(conn.onState(() => void this.refresh()));
  }

  private key(): string {
    const s = this.conn.state;
    const own = s?.ownership[this.agentId];
    const comments = (s?.comments ?? []).filter((c) => c.agentId === this.agentId).map((c) => `${c.id}:${c.updatedAt}`);
    const status = s?.agents.find((a) => a.id === this.agentId)?.status ?? "";
    return `${own?.snapshot ?? ""}|${own?.updatedAt ?? ""}|${comments.join(",")}|${status}`;
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
        const a = this.conn.state?.agents.find((x) => x.id === this.agentId);
        const agent = { name: a?.name ?? this.agentId, color: a?.color ?? "", working: a?.status === "working" };
        void this.panel.webview.postMessage({ type: "data", diff, comments, agent });
      } catch (err) {
        void vscode.window.showErrorMessage(l("Synapse: {0}", (err as Error).message));
      }
    })();
    await this.refreshing;
  }

  private async onMessage(m: { type: string; path?: string; line?: number; text?: string; action?: CodeComment["action"]; id?: string; status?: CodeComment["status"] }): Promise<void> {
    try {
      if (m.type === "ready") await this.refresh(true);
      else if (m.type === "comment" && m.path && m.line && m.text) {
        const c = await this.conn.call("comments.add", { agentId: this.agentId, path: m.path, line: m.line, text: m.text, action: m.action });
        if (c.action === "task") void vscode.window.showInformationMessage(l("Synapse: created task {0} for this agent.", c.taskId ?? ""));
        await this.refresh(true);
      } else if (m.type === "resolve" && m.id) {
        await this.conn.call("comments.resolve", { id: m.id, status: m.status });
        await this.refresh(true);
      } else if (m.type === "open" && m.path) {
        const agent = this.conn.state?.agents.find((a) => a.id === this.agentId);
        const root = agent ? agent.worktree.path : this.conn.repoRoot;
        const file = path.resolve(root, m.path);
        if (!file.startsWith(root + path.sep)) return;
        await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
      }
    } catch (err) {
      void vscode.window.showErrorMessage(l("Synapse: {0}", (err as Error).message));
    }
  }

  dispose(): void {
    LiveDiffPanel.open.delete(this.agentId);
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
