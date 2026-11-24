import * as path from "node:path";
import * as vscode from "vscode";
import type { CoreConnection } from "../connection.js";
import { handleViewMessage, type ViewMessage } from "../ui/actions.js";
import { pageHtml, webviewRoots } from "../ui/html.js";
import type { Selection } from "../ui/selection.js";

export interface ViewDeps {
  conn: CoreConnection;
  selection: Selection;
  context: vscode.ExtensionContext;
}

/** What every Synapse webview receives: core state plus the person's selection. */
export function statePayload(deps: ViewDeps): Record<string, unknown> {
  const { conn, selection, context } = deps;
  return {
    type: "state",
    state: conn.state ?? null,
    connected: conn.connected,
    selected: selection.current,
    repoName: path.basename(conn.repoRoot),
    checklistDismissed: context.workspaceState.get<boolean>("synapse.checklistDismissed", false),
  };
}

/**
 * Sets up a webview as a Synapse view: its page, state pushed on every core
 * change and selection change, and its messages handled.
 */
export function attach(webview: vscode.Webview, deps: ViewDeps, view: string, title: string, disposables: vscode.Disposable[], onMessage?: (m: ViewMessage | { type: string; [k: string]: unknown }) => boolean | Promise<boolean>): () => void {
  webview.options = { enableScripts: true, localResourceRoots: webviewRoots(deps.context.extensionUri) };
  webview.html = pageHtml(webview, deps.context.extensionUri, view, title);
  const post = () => void webview.postMessage(statePayload(deps));
  disposables.push(
    deps.conn.onState(post),
    deps.selection.onChange(post),
    webview.onDidReceiveMessage(async (m: ViewMessage) => {
      if (m.type === "ready") post();
      if (onMessage && (await onMessage(m))) return;
      await handleViewMessage(m, deps.conn, deps.selection, deps.context);
      if (m.type === "dismissChecklist") post();
    }),
  );
  return post;
}
