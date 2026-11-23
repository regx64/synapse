import * as vscode from "vscode";
import type { Review } from "@synapse/client";
import type { CoreConnection } from "./connection.js";

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
    const r = this.review;
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
    const agentName = (id: string) => this.conn.state?.agents.find((a) => a.id === id)?.name ?? id;
    const color = (id: string) => this.conn.state?.agents.find((a) => a.id === id)?.color ?? "var(--vscode-focusBorder)";
    const blocking = r.conflicts.filter((c) => c.severity === "error");
    const testsOk = !r.tests || r.tests.passed;
    const canMerge = r.status === "ready";
    const clean = canMerge && testsOk && blocking.length === 0;

    const files = r.files
      .map(
        (f) => `<tr>
          <td><a href="#" data-diff="${esc(f.path)}">${esc(f.path)}</a></td>
          <td class="muted">${f.status}</td>
          <td class="muted">+${f.linesAdded} −${f.linesRemoved}</td>
          <td>${f.agents.map((a) => `<span class="tag" style="border-color:${color(a)}">${esc(agentName(a))}</span>`).join(" ")}</td>
        </tr>`,
      )
      .join("");
    const conflicts = r.conflicts.length
      ? r.conflicts.map((c) => `<li class="sev-${c.severity}"><b>${c.kind}</b> ${esc(c.message)}</li>`).join("")
      : `<li class="muted">No conflicts between agents.</li>`;
    const tests = r.tests
      ? `<p>${r.tests.passed ? "✅ Tests passed" : r.tests.timedOut ? "⏱ Tests timed out" : "❌ Tests failed"} — <code>${esc(r.tests.command)}</code> (${(r.tests.durationMs / 1000).toFixed(1)} s)</p><pre>${esc(r.tests.output.slice(-6000))}</pre>`
      : `<p class="muted">No test command configured. Set <code>testCommand</code> in synapse.config.json.</p>`;

    this.panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px 20px; max-width: 980px; }
  .muted { color: var(--vscode-descriptionForeground); }
  table { border-collapse: collapse; width: 100%; } td { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .tag { border-left: 3px solid; padding: 0 6px; font-size: 12px; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 8px; max-height: 260px; overflow: auto; font-size: 12px; }
  .sev-error { color: var(--vscode-errorForeground); } .sev-info { color: var(--vscode-descriptionForeground); }
  button { font: inherit; padding: 5px 12px; border: none; border-radius: 2px; cursor: pointer; margin-right: 6px;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .status { font-weight: 600; }
</style></head><body>
<h2>Combined review <span class="muted">${esc(r.id)}</span></h2>
<p><span class="status">${r.status}</span> — ${r.agents.map((a) => `<span class="tag" style="border-color:${color(a)}">${esc(agentName(a))}</span>`).join(" ")} onto <code>${esc(r.baseRef)}</code> @ ${r.baseCommit.slice(0, 8)}</p>
${r.error ? `<p class="sev-error">${esc(r.error)}</p>` : ""}
${r.mergeConflicts.length ? `<p class="sev-error">Textual conflicts in: ${r.mergeConflicts.map(esc).join(", ")}</p>` : ""}
<h3>Conflicts</h3><ul>${conflicts}</ul>
<h3>Files (${r.files.length})</h3><table>${files || `<tr><td class="muted">No changes.</td></tr>`}</table>
<h3>Tests on the combined result</h3>${tests}
<p>
  ${canMerge ? `<button class="primary" data-act="merge" ${clean ? "" : "disabled"}>Merge into ${esc(r.baseRef)}</button>` : ""}
  ${canMerge && !clean ? `<button data-act="force">Merge anyway</button>` : ""}
  ${r.status !== "merged" ? `<button data-act="again">Prepare again</button><button data-act="discard">Discard</button>` : ""}
</p>
<script>
  const vscode = acquireVsCodeApi();
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-diff],[data-act]");
    if (!t) return;
    e.preventDefault();
    if (t.dataset.diff) vscode.postMessage({ type: "diff", path: t.dataset.diff });
    else if (t.dataset.act === "force") vscode.postMessage({ type: "merge", force: true });
    else vscode.postMessage({ type: t.dataset.act });
  });
</script></body></html>`;
  }

  dispose(): void {
    ReviewPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
