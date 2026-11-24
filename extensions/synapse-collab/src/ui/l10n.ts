import * as vscode from "vscode";

/**
 * A message in the editor's language (English and Korean: l10n/). `{0}`,
 * `{1}`… are replaced by the arguments.
 */
export function l(message: string, ...args: (string | number | boolean)[]): string {
  return vscode.l10n.t(message, ...args);
}
