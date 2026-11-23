// Runs inside the VS Code extension host. Uses the core API (as a second
// client) to create agents, then checks what the extension shows.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

exports.run = async function run() {
  const repo = process.env.SYNAPSE_SMOKE_REPO;
  const ext = vscode.extensions.getExtension("synapse.synapse-collab");
  assert.ok(ext, "extension is installed");
  await ext.activate();

  // The extension starts synapse-core with the editor's own runtime.
  const discovery = path.join(repo, ".synapse", "core.json");
  await waitFor(() => fs.existsSync(discovery), "synapse-core to start");
  const { SynapseClient } = await import(path.join(__dirname, "..", "..", "..", "packages", "client", "dist", "src", "index.js"));
  const client = await SynapseClient.connect({ workspace: repo, clientName: "smoke" });
  try {
    const steps = (...s) => JSON.stringify({ steps: s });
    await client.call("agents.add", { preset: "mock", id: "alpha", name: "Alpha", start: true });
    await client.call("agents.add", { preset: "mock", id: "beta", name: "Beta", start: true });
    await client.call("agents.prompt", { id: "alpha", text: steps({ edit: { path: "src/pricing.ts", find: "percent: number)", replace: "percent: number, cap: number)" } }) });
    await client.call("agents.prompt", { id: "beta", text: steps({ write: { path: "src/checkout.ts", content: 'import { applyDiscount } from "./pricing";\nexport const checkout = (t: number) => applyDiscount(t, 10);\n' } }) });
    await waitFor(async () => (await client.call("conflicts.check")).some((c) => c.kind === "signature-change"), "conflict in core");

    // The extension turns core conflicts into Problems-panel diagnostics on the symbol.
    const uri = vscode.Uri.file(path.join(repo, "src", "pricing.ts"));
    const diag = await waitFor(() => vscode.languages.getDiagnostics(uri).find((d) => d.source === "synapse"), "synapse diagnostic");
    assert.equal(diag.code, "signature-change");
    assert.equal(diag.severity, vscode.DiagnosticSeverity.Error);
    assert.equal(diag.range.start.line, 0);

    // Editor markers come from ownership.forFile with the open buffer.
    await vscode.window.showTextDocument(uri);
    const markers = await client.call("ownership.forFile", { path: uri.fsPath });
    assert.equal(markers[0].agentName, "Alpha");

    // Commands are registered and run.
    const commands = await vscode.commands.getCommands(true);
    for (const c of ["synapse.addAgent", "synapse.prepareReview", "synapse.checkConflicts", "synapse.agentMenu"]) assert.ok(commands.includes(c), c);
    await vscode.commands.executeCommand("synapse.checkConflicts");
  } finally {
    await client.call("core.shutdown").catch(() => {});
    client.close();
  }
};
