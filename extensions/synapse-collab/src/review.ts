import * as vscode from "vscode";
import type { Review } from "@synapse/client";
import type { CoreConnection } from "./connection.js";
import { reviewHtml } from "./review-html.js";

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

  static show(conn: CoreConnection, review: Review): void {
    if (ReviewPanel.current) {
      ReviewPanel.current.review = review;
      ReviewPanel.current.render();
      ReviewPanel.current.panel.reveal();
      return;
    }
    ReviewPanel.current = new ReviewPanel(conn, review);
  }

  private constructor(
    private readonly conn: CoreConnection,
    private review: Review,
  ) {
    this.panel = vscode.window.createWebviewPanel("synapse.review", "Synapse Review", vscode.ViewColumn.Active, { enableScripts: true });
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
      if (m.type === "diff" && m.path) {
        const file = r.files.find((f) => f.path === m.path);
        await vscode.commands.executeCommand(
          "vscode.diff",
          ReviewContentProvider.uri(r.id, "base", m.path),
          ReviewContentProvider.uri(r.id, "merged", m.path),
          `${m.path} (${r.baseRef} ↔ combined${file?.agents.length ? `: ${file.agents.join(" + ")}` : ""})`,
        );
      } else if (m.type === "merge") {
        const ok = await vscode.window.showWarningMessage(
          `Merge the combined work of ${r.agents.join(", ")} into ${r.baseRef}?${m.force ? " Tests or conflict checks did not pass." : ""}`,
          { modal: true },
          "Merge",
        );
        if (ok !== "Merge") return;
        this.review = await this.conn.call("review.merge", { id: r.id, resetAgents: true, force: !!m.force });
        void vscode.window.showInformationMessage(`Synapse: merged into ${r.baseRef}.`);
        this.render();
      } else if (m.type === "discard") {
        this.review = await this.conn.call("review.discard", { id: r.id });
        this.panel.dispose();
      } else if (m.type === "again") {
        this.review = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Synapse: preparing combined review…" },
          () => this.conn.call("review.prepare", { agents: r.agents }),
        );
        this.render();
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Synapse: ${(err as Error).message}`);
    }
  }

  private render(): void {
    this.panel.webview.html = reviewHtml(this.review, this.conn.state?.agents ?? []);
  }

  dispose(): void {
    ReviewPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
