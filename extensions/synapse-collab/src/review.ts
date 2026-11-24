import * as vscode from "vscode";
import type { Review } from "@synapse/client";
import type { CoreConnection } from "./connection.js";
import { l } from "./ui/l10n.js";
import { pageHtml, webviewRoots } from "./ui/html.js";

export const REVIEW_SCHEME = "synapse-review";

/** Serves base and merged file versions of a review for VS Code's diff editor. */
export class ReviewContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly conn: CoreConnection) {}

  static uri(reviewId: string, side: "base" | "merged", filePath: string): vscode.Uri {
    return vscode.Uri.from({ scheme: REVIEW_SCHEME, path: `/${filePath}`, query: new URLSearchParams({ review: reviewId, side }).toString() });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = new URLSearchParams(uri.query);
    const r = await this.conn.call("review.fileContent", { id: q.get("review")!, path: uri.path.replace(/^\//, ""), side: q.get("side") as "base" | "merged" });
    return r.content ?? "";
  }
}

/** One screen for the combined result: files, conflicts, tests, then merge. */
export class ReviewPanel implements vscode.Disposable {
  private static current?: ReviewPanel;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(conn: CoreConnection, extensionUri: vscode.Uri, review: Review): void {
    if (ReviewPanel.current) {
      ReviewPanel.current.review = review;
      ReviewPanel.current.render();
      ReviewPanel.current.panel.reveal();
      return;
    }
    ReviewPanel.current = new ReviewPanel(conn, extensionUri, review);
  }

  private constructor(
    private readonly conn: CoreConnection,
    extensionUri: vscode.Uri,
    private review: Review,
  ) {
    this.panel = vscode.window.createWebviewPanel("synapse.review", l("Review & merge"), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: webviewRoots(extensionUri) });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "synapse.svg");
    this.panel.webview.html = pageHtml(this.panel.webview, extensionUri, "review", l("Review & merge"));
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), undefined, this.disposables);
    this.disposables.push(
      conn.onState((s) => {
        const updated = s?.reviews.find((r) => r.id === this.review.id);
        if (updated && updated.updatedAt !== this.review.updatedAt) {
          this.review = updated;
          this.render();
        }
      }),
    );
    this.render();
  }

  private async onMessage(m: { type: string; path?: string; force?: boolean }): Promise<void> {
    const r = this.review;
    try {
      if (m.type === "ready") this.render();
      else if (m.type === "diff" && m.path) {
        const file = r.files.find((f) => f.path === m.path);
        await vscode.commands.executeCommand(
          "vscode.diff",
          ReviewContentProvider.uri(r.id, "base", m.path),
          ReviewContentProvider.uri(r.id, "merged", m.path),
          l("{0} ({1} ↔ combined: {2})", m.path, r.baseRef, file?.agents.join(" + ") ?? ""),
        );
      } else if (m.type === "merge") {
        const merge = l("Merge");
        const ok = await vscode.window.showWarningMessage(
          m.force ? l("Merge the combined work of {0} into {1}? Tests or conflict checks did not pass.", r.agents.join(", "), r.baseRef) : l("Merge the combined work of {0} into {1}?", r.agents.join(", "), r.baseRef),
          { modal: true },
          merge,
        );
        if (ok !== merge) return;
        this.review = await this.conn.call("review.merge", { id: r.id, resetAgents: true, force: !!m.force });
        void vscode.window.showInformationMessage(l("Synapse: merged into {0}.", r.baseRef));
        this.render();
      } else if (m.type === "discard") {
        this.review = await this.conn.call("review.discard", { id: r.id });
        this.panel.dispose();
      } else if (m.type === "again") {
        this.review = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: l("Synapse: preparing combined review…") },
          () => this.conn.call("review.prepare", { agents: r.agents }),
        );
        this.render();
      }
    } catch (err) {
      void vscode.window.showErrorMessage(l("Synapse: {0}", (err as Error).message));
    }
  }

  private render(): void {
    const agents = (this.conn.state?.agents ?? []).map((a) => ({ id: a.id, name: a.name, color: a.color }));
    void this.panel.webview.postMessage({ type: "data", review: this.review, agents });
  }

  dispose(): void {
    ReviewPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
