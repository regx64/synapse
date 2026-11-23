import type { AgentState, Review } from "@synapse/client";

/** The review panel's HTML. Pure (no VS Code API), so it can be rendered and checked outside the editor. */
export function reviewHtml(r: Review, agents: Pick<AgentState, "id" | "name" | "color">[]): string {
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
    const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
    const color = (id: string) => agents.find((a) => a.id === id)?.color ?? "var(--vscode-focusBorder)";
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

    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
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
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .blocked { padding: 8px 10px; border-left: 3px solid var(--vscode-errorForeground); background: var(--vscode-textCodeBlock-background); }
  .status { font-weight: 600; }
</style></head><body>
<h2>Combined review <span class="muted">${esc(r.id)}</span></h2>
<p><span class="status">${r.status}</span> — ${r.agents.map((a) => `<span class="tag" style="border-color:${color(a)}">${esc(agentName(a))}</span>`).join(" ")} onto <code>${esc(r.baseRef)}</code> @ ${r.baseCommit.slice(0, 8)}</p>
${r.error ? `<p class="sev-error">${esc(r.error)}</p>` : ""}
${r.mergeConflicts.length ? `<p class="sev-error">Textual conflicts in: ${r.mergeConflicts.map(esc).join(", ")}</p>` : ""}
<h3>Conflicts</h3><ul>${conflicts}</ul>
<h3>Files (${r.files.length})</h3><table>${files || `<tr><td class="muted">No changes.</td></tr>`}</table>
<h3>Tests on the combined result</h3>${tests}
${canMerge && !clean ? `<p class="blocked">Merging is blocked: ${[testsOk ? "" : "the tests failed on the combined result", blocking.length ? `${blocking.length} conflict${blocking.length === 1 ? "" : "s"} between agents ${blocking.length === 1 ? "is" : "are"} still open` : ""].filter(Boolean).join(", and ")}. Fix ${blocking.length && !testsOk ? "them" : "it"} and prepare again, or merge anyway.</p>` : ""}
<p>
  ${canMerge ? `<button class="primary" data-act="merge" ${clean ? "" : "disabled"} title="${clean ? "" : "Blocked: see above"}">Merge into ${esc(r.baseRef)}</button>` : ""}
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
