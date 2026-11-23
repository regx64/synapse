import * as path from "node:path";
import * as vscode from "vscode";
import type { Conflict, CoreState, FileMarker } from "@synapse/client";
import type { CoreConnection } from "./connection.js";

/**
 * Editor markers ("whose code is this") and conflict diagnostics. All data
 * comes from synapse-core: `ownership.forFile` maps agents' symbols onto the
 * open buffer, and `conflicts` feed the Problems panel.
 */
export class Markers implements vscode.Disposable {
  private readonly blockTypes = new Map<string, vscode.TextEditorDecorationType>();
  private readonly labelTypes = new Map<string, vscode.TextEditorDecorationType>();
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("synapse");
  private readonly disposables: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly conn: CoreConnection) {
    this.disposables.push(
      this.diagnostics,
      conn.onState((s) => {
        this.scheduleEditors();
        void this.updateDiagnostics(s);
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.scheduleEditors()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.visibleTextEditors.some((ed) => ed.document === e.document)) this.scheduleEditors(400);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("synapse.showInlineOwners")) this.scheduleEditors();
      }),
    );
  }

  private scheduleEditors(delay = 100): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.updateEditors(), delay);
  }

  private inRepo(uri: vscode.Uri): boolean {
    if (uri.scheme !== "file") return false;
    const rel = path.relative(this.conn.repoRoot, uri.fsPath);
    return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  private async updateEditors(): Promise<void> {
    const editors = vscode.window.visibleTextEditors;
    if (!this.conn.connected || !this.conn.state?.agents.length) {
      for (const ed of editors) this.clear(ed);
      return;
    }
    for (const ed of editors) {
      if (!this.inRepo(ed.document.uri)) continue;
      try {
        const markers = await this.conn.call("ownership.forFile", { path: ed.document.uri.fsPath, content: ed.document.getText() });
        this.apply(ed, markers);
      } catch {
        this.clear(ed);
      }
    }
  }

  private clear(ed: vscode.TextEditor): void {
    for (const t of this.blockTypes.values()) ed.setDecorations(t, []);
    for (const t of this.labelTypes.values()) ed.setDecorations(t, []);
  }

  private typesFor(color: string): { block: vscode.TextEditorDecorationType; label: vscode.TextEditorDecorationType } {
    let block = this.blockTypes.get(color);
    if (!block) {
      block = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: `${color}12`,
        borderWidth: "0 0 0 2px",
        borderStyle: "solid",
        borderColor: color,
        overviewRulerColor: color,
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      });
      this.blockTypes.set(color, block);
    }
    let label = this.labelTypes.get(color);
    if (!label) {
      label = vscode.window.createTextEditorDecorationType({
        after: { color, margin: "0 0 0 2em", fontStyle: "italic" },
      });
      this.labelTypes.set(color, label);
    }
    return { block, label };
  }

  private apply(ed: vscode.TextEditor, markers: FileMarker[]): void {
    const showLabels = vscode.workspace.getConfiguration("synapse").get<boolean>("showInlineOwners", true);
    const blocks = new Map<string, vscode.DecorationOptions[]>();
    const labels = new Map<string, vscode.DecorationOptions[]>();
    const push = (m: Map<string, vscode.DecorationOptions[]>, color: string, o: vscode.DecorationOptions) => {
      if (!m.has(color)) m.set(color, []);
      m.get(color)!.push(o);
    };
    const fileLevel = new Map<string, FileMarker[]>();
    for (const m of markers) {
      if (!m.range) {
        if (!fileLevel.has(m.color)) fileLevel.set(m.color, []);
        fileLevel.get(m.color)!.push(m);
        continue;
      }
      const range = new vscode.Range(m.range.startLine, 0, m.range.endLine, 0);
      const what = m.signatureChanged ? "changing the signature of" : m.change === "removed" ? "removing" : "changing";
      const hover = new vscode.MarkdownString(`**${m.agentName}** is ${what} \`${m.symbol}\` in its worktree.`);
      push(blocks, m.color, { range, hoverMessage: hover });
      if (showLabels) {
        const line = ed.document.lineAt(Math.min(m.range.startLine, ed.document.lineCount - 1));
        push(labels, m.color, {
          range: new vscode.Range(line.range.end, line.range.end),
          renderOptions: { after: { contentText: `● ${m.agentName}${m.signatureChanged ? " · signature changed" : m.change === "removed" ? " · removing" : ""}` } },
        });
      }
    }
    for (const [color, ms] of fileLevel) {
      if (!showLabels || ed.document.lineCount === 0) continue;
      const end = ed.document.lineAt(0).range.end;
      const names = [...new Set(ms.map((m) => (m.symbol === "(file)" ? "this file" : m.symbol)))].slice(0, 4).join(", ");
      push(labels, color, {
        range: new vscode.Range(end, end),
        hoverMessage: new vscode.MarkdownString(`**${ms[0]!.agentName}** is changing: ${ms.map((m) => `\`${m.symbol}\` (${m.change})`).join(", ")}`),
        renderOptions: { after: { contentText: `● ${ms[0]!.agentName}: ${names}` } },
      });
    }
    // Every known color gets set, so markers from agents that stopped owning code are cleared.
    const colors = new Set([...this.blockTypes.keys(), ...blocks.keys(), ...labels.keys()]);
    for (const color of colors) {
      const t = this.typesFor(color);
      ed.setDecorations(t.block, blocks.get(color) ?? []);
      ed.setDecorations(t.label, labels.get(color) ?? []);
    }
  }

  private async updateDiagnostics(state: CoreState | undefined): Promise<void> {
    this.diagnostics.clear();
    if (!state) return;
    const byPath = new Map<string, Conflict[]>();
    for (const c of state.conflicts) {
      if (!byPath.has(c.path)) byPath.set(c.path, []);
      byPath.get(c.path)!.push(c);
    }
    for (const [rel, conflicts] of byPath) {
      const uri = vscode.Uri.file(path.join(this.conn.repoRoot, rel));
      let markers: FileMarker[] = [];
      try {
        markers = await this.conn.call("ownership.forFile", { path: rel });
      } catch {
        /* file may not exist in the main checkout */
      }
      const diags = conflicts.map((c) => {
        const r = markers.find((m) => m.symbol === c.symbol && m.range)?.range;
        const range = r ? new vscode.Range(r.startLine, r.startCol, r.startLine, Number.MAX_SAFE_INTEGER) : new vscode.Range(0, 0, 0, 0);
        const d = new vscode.Diagnostic(
          range,
          c.message,
          c.severity === "error" ? vscode.DiagnosticSeverity.Error : c.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information,
        );
        d.source = "synapse";
        d.code = c.kind;
        return d;
      });
      this.diagnostics.set(uri, diags);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const t of this.blockTypes.values()) t.dispose();
    for (const t of this.labelTypes.values()) t.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
