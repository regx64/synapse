import * as vscode from "vscode";
import { l } from "../ui/l10n.js";
import { attach, type ViewDeps } from "./common.js";

/** The left column: every agent at a glance, and teammates' agents. */
export class AgentsView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly id = "synapse.agents";
  private readonly disposables: vscode.Disposable[] = [];
  constructor(private readonly deps: ViewDeps) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const post = attach(view.webview, this.deps, "agents", l("Agents"), this.disposables);
    view.onDidChangeVisibility(() => view.visible && post(), undefined, this.disposables);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
