/**
 * The live-diff panel's page. Pure (no VS Code API), so it can be rendered
 * and checked outside the editor. The extension posts `{ type: "data", diff,
 * comments, agent }`; the page renders it, and re-renders on every update
 * unless the person is typing a comment.
 */
export function liveDiffHtml(agentName: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px 16px; }
  .muted { color: var(--vscode-descriptionForeground); }
  .file { margin: 14px 0; border: 1px solid var(--vscode-panel-border); border-radius: 3px; }
  .fhead { display: flex; gap: 8px; align-items: center; padding: 6px 10px; background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-background)); position: sticky; top: 0; }
  .fhead a { color: var(--vscode-textLink-foreground); text-decoration: none; font-family: var(--vscode-editor-font-family); }
  .st { font-size: 11px; padding: 0 5px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  table { border-collapse: collapse; width: 100%; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size, 12px); }
  td { padding: 0 6px; white-space: pre; vertical-align: top; }
  td.no { width: 1%; text-align: right; color: var(--vscode-editorLineNumber-foreground); cursor: pointer; user-select: none; }
  td.no:hover { color: var(--vscode-textLink-foreground); }
  tr.add td.code { background: var(--vscode-diffEditor-insertedLineBackground, rgba(80,200,120,.15)); }
  tr.del td.code { background: var(--vscode-diffEditor-removedLineBackground, rgba(240,80,80,.15)); }
  tr.hunk td { color: var(--vscode-descriptionForeground); background: var(--vscode-textCodeBlock-background); padding: 2px 6px; }
  .comment, .form { margin: 4px 8px 6px 60px; padding: 6px 8px; border-left: 3px solid var(--vscode-textLink-foreground); background: var(--vscode-textCodeBlock-background); white-space: normal; font-family: var(--vscode-font-family); }
  .comment.resolved { opacity: .55; } .comment.outdated { border-left-color: var(--vscode-inputValidation-warningBorder); }
  .tag { font-size: 11px; padding: 0 5px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; margin-left: 6px; }
  textarea { width: 100%; box-sizing: border-box; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  button { font: inherit; padding: 3px 10px; border: none; border-radius: 2px; cursor: pointer; margin: 4px 6px 0 0; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.link { background: none; color: var(--vscode-textLink-foreground); padding: 0 4px; }
</style></head><body>
<h3>${esc(agentName)} — live changes <span class="muted" id="when"></span></h3>
<p class="muted">Click a line number to comment. A comment can stay a note, go to the agent as guidance after its turn, or become a task. Comments follow their code as the agent keeps editing.</p>
<div id="root"><p class="muted">Loading…</p></div>
<script>
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  let data = null, form = null, pending = false;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function commentHtml(c) {
    const what = c.action === "guidance" ? "given to the agent" : c.action === "task" ? "task " + esc(c.taskId || "") : "note";
    return '<div class="comment ' + c.status + (c.outdated ? " outdated" : "") + '"><b>' + esc(c.text.split("\\n")[0]) + '</b>' +
      (c.text.includes("\\n") ? '<div>' + esc(c.text.split("\\n").slice(1).join("\\n")) + '</div>' : "") +
      '<div class="muted"><span class="tag">' + what + '</span>' + (c.outdated ? '<span class="tag">code changed</span>' : "") +
      (c.endLine > c.line ? " lines " + c.line + "–" + c.endLine : " line " + c.line) +
      (c.status === "open" ? ' <button class="link" data-resolve="' + c.id + '">Resolve</button>' : ' <button class="link" data-reopen="' + c.id + '">Reopen</button>') + '</div></div>';
  }
  function render() {
    if (!data) return;
    const { diff, comments } = data;
    document.getElementById("when").textContent = diff.files.length ? "updated " + new Date(diff.updatedAt).toLocaleTimeString() : "";
    if (!diff.files.length) { root.innerHTML = '<p class="muted">No changes yet.</p>'; return; }
    let html = "";
    for (const f of diff.files) {
      const fc = comments.filter((c) => c.path === f.path);
      html += '<div class="file"><div class="fhead"><span class="st">' + f.status + '</span><a href="#" data-open="' + esc(f.path) + '">' + esc(f.path) + '</a>' +
        (f.truncated ? '<span class="muted">(truncated)</span>' : "") + (f.binary ? '<span class="muted">(binary)</span>' : "") + '</div>';
      for (const c of fc.filter((c) => c.outdated && c.status === "open")) html += commentHtml(c);
      html += "<table>";
      for (const h of f.hunks) {
        html += '<tr class="hunk"><td colspan="2">@@ -' + h.oldStart + ',' + h.oldLines + ' +' + h.newStart + ',' + h.newLines + ' @@ ' + esc(h.header) + '</td></tr>';
        for (const l of h.lines) {
          const cls = l.t === "+" ? "add" : l.t === "-" ? "del" : "";
          const no = l.newNo ?? "";
          html += '<tr class="' + cls + '"><td class="no"' + (l.newNo ? ' data-line="' + l.newNo + '" data-path="' + esc(f.path) + '" title="Comment on this line"' : "") + '>' + (l.oldNo && !l.newNo ? "−" : no) + '</td><td class="code">' + esc(l.t === " " ? " " + l.text : l.t + l.text) + '</td></tr>';
          if (l.newNo) {
            for (const c of fc.filter((c) => !c.outdated && c.endLine === l.newNo)) html += '<tr><td colspan="2">' + commentHtml(c) + '</td></tr>';
            if (form && form.path === f.path && form.line === l.newNo) {
              html += '<tr><td colspan="2"><div class="form"><div class="muted">Comment on ' + esc(f.path) + ':' + form.line + '</div>' +
                '<textarea id="ctext" rows="3" placeholder="What should change here?"></textarea>' +
                '<button class="primary" data-send="guidance" title="The agent gets it after its current turn">Tell the agent</button>' +
                '<button data-send="task">Make a task</button><button data-send="note">Keep as note</button><button class="link" data-cancel>Cancel</button></div></td></tr>';
            }
          }
        }
      }
      html += "</table></div>";
    }
    const draft = document.getElementById("ctext")?.value;
    root.innerHTML = html;
    const ta = document.getElementById("ctext");
    if (ta) { if (draft) ta.value = draft; ta.focus(); }
  }
  window.addEventListener("message", (e) => {
    if (e.data?.type !== "data") return;
    data = e.data;
    if (document.activeElement?.id === "ctext") { pending = true; return; }
    render();
  });
  document.addEventListener("focusout", () => { if (pending) { pending = false; setTimeout(render, 0); } });
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-line],[data-send],[data-cancel],[data-open],[data-resolve],[data-reopen]");
    if (!t) return;
    e.preventDefault();
    if (t.dataset.line) { form = { path: t.dataset.path, line: Number(t.dataset.line) }; render(); }
    else if (t.dataset.cancel !== undefined) { form = null; render(); }
    else if (t.dataset.send) {
      const text = document.getElementById("ctext").value.trim();
      if (!text) return;
      vscode.postMessage({ type: "comment", path: form.path, line: form.line, text, action: t.dataset.send });
      form = null; render();
    }
    else if (t.dataset.open) vscode.postMessage({ type: "open", path: t.dataset.open });
    else if (t.dataset.resolve) vscode.postMessage({ type: "resolve", id: t.dataset.resolve, status: "resolved" });
    else if (t.dataset.reopen) vscode.postMessage({ type: "resolve", id: t.dataset.reopen, status: "open" });
  });
  vscode.postMessage({ type: "ready" });
</script></body></html>`;
}
