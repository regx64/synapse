import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

/**
 * Translations of the extension's messages (l10n/bundle.l10n.<lang>.json).
 * The editor loads that bundle for installed extensions only; a built-in
 * extension gets its translations from a language pack, which has none for
 * Synapse. So the extension reads its own bundle when the editor gave none.
 */
let own: Record<string, string> | undefined;

export function initL10n(extensionPath: string): void {
  if (vscode.l10n.bundle) return;
  const lang = vscode.env.language.toLowerCase();
  for (const tag of [lang, lang.split("-")[0]]) {
    const file = path.join(extensionPath, "l10n", `bundle.l10n.${tag}.json`);
    try {
      own = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
      return;
    } catch {
      // try the next tag; English needs no bundle
    }
  }
}

/**
 * A message in the editor's language (English and Korean: l10n/). `{0}`,
 * `{1}`… are replaced by the arguments.
 */
export function l(message: string, ...args: (string | number | boolean)[]): string {
  const translated = own?.[message];
  if (translated === undefined) return vscode.l10n.t(message, ...args);
  return translated.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m));
}
