import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

/** "ko" when the editor runs in Korean, else "en". */
export function uiLanguage(): "en" | "ko" {
  return vscode.env.language.toLowerCase().startsWith("ko") ? "ko" : "en";
}

/** The folders a Synapse webview may load from. */
export function webviewRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [vscode.Uri.joinPath(extensionUri, "media")];
}

/**
 * A Synapse webview page: the UI kit (fonts, tokens, strings, helpers) and
 * one view script. Scripts run only with the page's nonce.
 */
export function pageHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: string, title: string, extraStyles: string[] = []): string {
  const nonce = randomBytes(16).toString("base64");
  const media = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", ...p)).toString();
  const lang = uiLanguage();
  const styles = ["ui/kit.css", "ui/views.css", ...extraStyles].map((s) => `<link rel="stylesheet" href="${media(...s.split("/"))}">`).join("\n");
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${styles}
<title>${title}</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${media("ui", "strings.js")}"></script>
<script nonce="${nonce}" src="${media("ui", "kit.js")}"></script>
<script nonce="${nonce}" src="${media("ui", `${view}.js`)}"></script>
</body>
</html>`;
}
