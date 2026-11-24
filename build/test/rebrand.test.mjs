import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rebrandApp, rebrandText } from "../rebrand.mjs";

test("replaces the upstream product names with the product name", () => {
  assert.equal(rebrandText("Please reload Visual Studio Code to enable it.", "Synapse"), "Please reload Synapse to enable it.");
  assert.equal(rebrandText("Controls whether VS Code shows hints. VSCode restarts.", "Synapse"), "Controls whether Synapse shows hints. Synapse restarts.");
  assert.equal(rebrandText("VS Code's terminal", "Synapse"), "Synapse's terminal");
  assert.equal(rebrandText("Welcome to Code - OSS", "Synapse"), "Welcome to Synapse");
});

test("keeps phrases that name Microsoft's real products, identifiers and links", () => {
  for (const s of [
    "Installing configured marketplace plugins is not available in VS Code for the Web.",
    "Press the reload button to switch to the Insiders version of VS Code.",
    "Foreground color of the Stable VS Code icon",
    "The banner color on the VS Code marketplace page header.",
    "Settings live in .vscode/settings.json; see vscode.dev or `vscode://` links.",
  ]) {
    assert.equal(rebrandText(s, "Synapse"), s.replace("Stable VS Code icon", "Stable VS Code icon"));
  }
  assert.equal(rebrandText("Use VS Code or vscode.dev/agents. Not in VS Code for the Web.", "Synapse"), "Use Synapse or vscode.dev/agents. Not in VS Code for the Web.");
  assert.equal(rebrandText(undefined, "Synapse"), undefined);
});

test("rewrites a built app's messages and built-in extension strings, not Synapse's own", () => {
  const app = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "synapse-rebrand-")), "resources", "app");
  const w = (f, s) => (fs.mkdirSync(path.dirname(path.join(app, f)), { recursive: true }), fs.writeFileSync(path.join(app, f), s));
  w("package.json", "{}");
  w("out/nls.messages.json", JSON.stringify(["Reload VS Code", "Open File", "Welcome to Visual Studio Code — é"]));
  w("out/nls.messages.js", "/* header */\nglobalThis._VSCODE_NLS_MESSAGES=[\"Reload VS Code\"];");
  w("extensions/git/package.nls.json", JSON.stringify({ a: "Git for VS Code", b: { message: "VS Code setting", comment: ["x"] }, c: "Plain" }));
  w("extensions/git/package.json", JSON.stringify({ name: "git", displayName: "%displayName%", description: "Git SCM integration for VS Code" }));
  w("extensions/synapse-collab/package.nls.json", JSON.stringify({ a: "Runs inside VS Code during development" }));
  const stats = rebrandApp(app, "Synapse");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app, "out/nls.messages.json"), "utf8")), ["Reload Synapse", "Open File", "Welcome to Synapse — é"]);
  const js = fs.readFileSync(path.join(app, "out/nls.messages.js"), "utf8");
  assert.ok(js.startsWith("/* header */\n"));
  assert.match(js, /_VSCODE_NLS_MESSAGES=\["Reload Synapse","Open File","Welcome to Synapse \\u2014 \\u00e9"\];$/);
  const nls = JSON.parse(fs.readFileSync(path.join(app, "extensions/git/package.nls.json"), "utf8"));
  assert.deepEqual(nls, { a: "Git for Synapse", b: { message: "Synapse setting", comment: ["x"] }, c: "Plain" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(app, "extensions/git/package.json"), "utf8")).description, "Git SCM integration for Synapse");
  assert.match(fs.readFileSync(path.join(app, "extensions/synapse-collab/package.nls.json"), "utf8"), /VS Code/);
  assert.deepEqual(stats, { messages: 2, extensionStrings: 3 });
});
