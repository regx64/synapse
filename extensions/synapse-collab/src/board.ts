import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import type { CoreConnection } from "./connection.js";

type BoardMessage =
  | { type: "ready" }
  | { type: "command"; command: string; args?: unknown[] }
  | { type: "prompt"; id: string; text: string }
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
  | { type: "editPolicy"; agentId: string };

/** The collaboration board: status, ownership and pending approvals of every agent. */
export class BoardProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "synapse.board";
  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly conn: CoreConnection,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.disposables.push(conn.onState(() => this.post()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomBytes(16).toString("base64");
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "board.js"));
    const style = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "board.css"));
    view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Synapse</title>
</head>
<body>
<div id="root"><p class="muted">Connecting to synapse-core…</p></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    view.webview.onDidReceiveMessage((m: BoardMessage) => void this.onMessage(m), undefined, this.disposables);
    view.onDidChangeVisibility(() => view.visible && this.post(), undefined, this.disposables);
  }

  private post(): void {
    void this.view?.webview.postMessage({ type: "state", state: this.conn.state ?? null, connected: this.conn.connected });
  }

  private async onMessage(m: BoardMessage): Promise<void> {
    try {
      switch (m.type) {
        case "ready":
          this.post();
          return;
        case "command":
          await vscode.commands.executeCommand(m.command, ...(m.args ?? []));
          return;
        case "prompt":
          if (m.text.trim()) await this.conn.call("agents.prompt", { id: m.id, text: m.text });
          return;
        case "approve":
          await this.conn.call("approvals.resolve", { id: m.id, optionId: m.optionId });
          return;
        case "createTask": {
          const { type: _t, ...p } = m;
          await this.conn.call("tasks.create", p);
          return;
        }
        case "taskAction":
          if (m.action === "remove") await this.conn.call("tasks.remove", { id: m.id });
          else if (m.action === "start") await this.conn.call("tasks.start", { id: m.id });
          else await this.conn.call("tasks.setStatus", { id: m.id, status: m.action });
          return;
        case "sendMessage":
          await this.conn.call("messages.send", { to: m.to, kind: m.kind, subject: m.subject, body: m.body });
          return;
        case "messageAction":
          await this.conn.call(m.action === "release" ? "messages.release" : "messages.reject", { id: m.id });
          return;
        case "addDecision": {
          // "path#Symbol, other/path" → pins
          const pins = (m.pins ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => (s.lastIndexOf("#") > 0 ? { path: s.slice(0, s.lastIndexOf("#")), symbol: s.slice(s.lastIndexOf("#") + 1) } : { path: s }));
          await this.conn.call("decisions.add", { title: m.title, decision: m.decision, rationale: m.rationale || undefined, pins: pins.length ? pins : undefined });
          return;
        }
        case "decisionRepin":
          await this.conn.call("decisions.repin", { id: m.id });
          return;
        case "decisionUnpin":
          await this.conn.call("decisions.unpin", { id: m.id, path: m.path, symbol: m.symbol });
          return;
        case "decisionAction":
          await this.conn.call("decisions.resolve", { id: m.id, status: m.status });
          return;
        case "editPolicy":
          await vscode.commands.executeCommand("synapse.editPolicy", m.agentId);
          return;
        case "openFile": {
          const agent = m.agentId ? this.conn.state?.agents.find((a) => a.id === m.agentId) : undefined;
          const root = agent ? agent.worktree.path : this.conn.repoRoot;
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, m.path)));
          const line = Math.max(0, m.line ?? 0);
          await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0), preview: true });
          return;
        }
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Synapse: ${(err as Error).message}`);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
