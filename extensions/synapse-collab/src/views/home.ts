import * as vscode from "vscode";
import { l } from "../ui/l10n.js";
import { attach, type ViewDeps } from "./common.js";

/**
 * The home tab: what needs the person, every agent, tasks, team and the
 * project's decisions, messages and audit. Pinned as the first editor tab.
 */
export class HomePanel implements vscode.Disposable {
  static readonly viewType = "synapse.home";
  private static current?: HomePanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    deps: ViewDeps,
  ) {
    panel.iconPath = {
      light: vscode.Uri.joinPath(deps.context.extensionUri, "media", "icons", "home-light.svg"),
      dark: vscode.Uri.joinPath(deps.context.extensionUri, "media", "icons", "home-dark.svg"),
    };
    attach(panel.webview, deps, "home", l("Home"), this.disposables);
    panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  /** Opens the home tab (or brings it forward) and pins it, so it stays first. */
  static async show(deps: ViewDeps, preserveFocus = false): Promise<void> {
    if (HomePanel.current) {
      HomePanel.current.panel.reveal(vscode.ViewColumn.One, preserveFocus);
      return;
    }
    const panel = vscode.window.createWebviewPanel(HomePanel.viewType, l("Home"), { viewColumn: vscode.ViewColumn.One, preserveFocus }, { retainContextWhenHidden: true, enableFindWidget: true });
    HomePanel.current = new HomePanel(panel, deps);
    await HomePanel.pin(panel);
  }

  /** Brings back the home tab after a window reload. */
  static restore(panel: vscode.WebviewPanel, deps: ViewDeps): void {
    HomePanel.current?.dispose();
    HomePanel.current = new HomePanel(panel, deps);
  }

  static get isOpen(): boolean {
    return !!HomePanel.current;
  }

  private static async pin(panel: vscode.WebviewPanel): Promise<void> {
    // Pin commands act on the active editor: pin while the home tab is active.
    if (!panel.active) panel.reveal(vscode.ViewColumn.One, false);
    await vscode.commands.executeCommand("workbench.action.pinEditor").then(undefined, () => {});
  }

  dispose(): void {
    if (HomePanel.current === this) HomePanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
