// @ts-check
// An agent's live changes, with the person's comments on them. Unified by
// default; split (side by side) when the panel is wide enough to read it.
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const { t, h, icon, segmented, dot, diffstat, ago, guardedRender } = /** @type {any} */ (window).SynapseUI;
  const root = /** @type {HTMLElement} */ (document.getElementById("root"));
  const saved = vscode.getState() || {};
  let mode = saved.mode || "unified";
  /** @type {any} */
  let data = null;
  /** @type {{ path: string, line: number } | null} */
  let form = null;
  const post = (m) => vscode.postMessage(m);

  function render() {
    root.replaceChildren();
    root.className = "live";
    if (!data) {
      root.append(h("p", { class: "muted small page" }, [t("live.loading")]));
      return;
    }
    const { diff, comments, agent } = data;
    let add = 0;
    let del = 0;
    for (const f of diff.files) for (const hk of f.hunks) for (const l of hk.lines) l.t === "+" ? add++ : l.t === "-" ? del++ : 0;
    const page = h("div", { class: "page col" }, [
      h("div", { class: "row wrap" }, [
        dot(agent.color, "lg"),
        h("h1", {}, [t("live.title", agent.name)]),
        agent.working ? h("span", { class: "tiny muted row" }, [h("span", { class: "dot sm pulse", style: { background: "var(--sy-working)" } }), t("live.updated", ago(diff.updatedAt))]) : h("span", { class: "tiny muted" }, [t("live.updated", ago(diff.updatedAt))]),
        h("span", { class: "spacer" }),
        diff.files.length ? h("span", { class: "mono tiny muted" }, [t(diff.files.length === 1 ? "files.one" : "files.count", diff.files.length), " · ", diffstat(add, del)]) : null,
        segmented(
          [
            { id: "unified", label: t("live.unified") },
            { id: "split", label: t("live.split") },
          ],
          mode,
          (id) => {
            mode = id;
            form = null;
            vscode.setState({ ...(vscode.getState() || {}), mode });
            render();
          },
          t("live.view"),
        ),
      ]),
      h("p", { class: "small muted" }, [t("live.hint")]),
    ]);
    if (!diff.files.length) page.append(h("p", { class: "muted" }, [t("live.none")]));
    for (const f of diff.files) page.append(fileBlock(f, comments.filter((c) => c.path === f.path)));
    root.append(page);
    const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("ctext"));
    if (ta) ta.focus();
  }

  function fileBlock(f, comments) {
    const st = f.status === "added" ? "A" : f.status === "deleted" ? "D" : "M";
    let add = 0;
    let del = 0;
    for (const hk of f.hunks) for (const l of hk.lines) l.t === "+" ? add++ : l.t === "-" ? del++ : 0;
    const sec = h("section", { class: "dfile" }, [
      h("div", { class: "dhead row" }, [
        h("span", { class: "filest" }, [st]),
        h("span", { class: "mono small ell" }, [f.path]),
        diffstat(add, del),
        f.truncated ? h("span", { class: "tiny muted" }, [t("live.truncated")]) : null,
        f.binary ? h("span", { class: "tiny muted" }, [t("live.binary")]) : null,
        h("span", { class: "spacer" }),
        h("button", { class: "btn ghost sm", onclick: () => post({ type: "open", path: f.path }) }, [t("live.openFile")]),
      ]),
    ]);
    for (const c of comments.filter((c) => c.outdated && c.status === "open")) sec.append(commentEl(c));
    const body = h("div", { class: "dbody mono" }, []);
    for (const hk of f.hunks) {
      body.append(h("div", { class: "hunk" }, [`@@ -${hk.oldStart},${hk.oldLines} +${hk.newStart},${hk.newLines} @@ ${hk.header || ""}`]));
      if (mode === "split") splitRows(body, hk);
      else unifiedRows(body, f, hk, comments);
    }
    sec.append(body);
    return sec;
  }

  function lineNo(f, no, isNew) {
    if (!no) return h("span", { class: "no" }, [""]);
    if (!isNew) return h("span", { class: "no" }, [String(no)]);
    return h("button", { class: "no lno", "aria-label": t("live.commentOn", `${f.path}:${no}`), title: t("live.commentHere"), onclick: () => ((form = { path: f.path, line: no }), render()) }, [String(no)]);
  }

  function unifiedRows(body, f, hk, comments) {
    for (const l of hk.lines) {
      body.append(
        h("div", { class: `dl u ${l.t === "+" ? "add-l" : l.t === "-" ? "del-l" : ""}` }, [
          h("span", { class: "no" }, [l.t === "+" ? "" : String(l.oldNo ?? "")]),
          lineNo(f, l.newNo, l.t !== "-"),
          h("span", { class: `sign ${l.t === "+" ? "add" : l.t === "-" ? "del" : ""}`, "aria-hidden": "true" }, [l.t === " " ? "" : l.t === "-" ? "−" : "+"]),
          h("span", { class: "code" }, [l.text]),
        ]),
      );
      if (l.newNo && l.t !== "-") {
        for (const c of comments.filter((c) => !c.outdated && c.endLine === l.newNo)) body.append(commentEl(c));
        if (form && form.path === f.path && form.line === l.newNo) body.append(formEl(f.path, l.newNo));
      }
    }
  }

  /** Side by side: removed lines on the left, added on the right, paired in order. */
  function splitRows(body, hk) {
    const cell = (l, side) =>
      l
        ? h("div", { class: `half ${l.t === "+" ? "add-l" : l.t === "-" ? "del-l" : ""}` }, [h("span", { class: "no" }, [String((side === "l" ? l.oldNo : l.newNo) ?? "")]), h("span", { class: `sign ${l.t === "+" ? "add" : l.t === "-" ? "del" : ""}`, "aria-hidden": "true" }, [l.t === " " ? "" : l.t === "-" ? "−" : "+"]), h("span", { class: "code" }, [l.text])])
        : h("div", { class: "half empty-l" }, []);
    let dels = [];
    let adds = [];
    const flush = () => {
      for (let i = 0; i < Math.max(dels.length, adds.length); i++) body.append(h("div", { class: "dl s" }, [cell(dels[i], "l"), cell(adds[i], "r")]));
      dels = [];
      adds = [];
    };
    for (const l of hk.lines) {
      if (l.t === "-") {
        if (adds.length) flush();
        dels.push(l);
      } else if (l.t === "+") adds.push(l);
      else {
        flush();
        body.append(h("div", { class: "dl s" }, [cell(l, "l"), cell(l, "r")]));
      }
    }
    flush();
  }

  function commentEl(c) {
    const what = c.action === "guidance" ? t("live.givenToAgent") : c.action === "task" ? t("live.becameTask", c.taskId || "") : t("live.note");
    const [first, ...rest] = c.text.split("\n");
    return h("div", { class: `cmt${c.status === "resolved" ? " resolved" : ""}${c.outdated ? " outdated" : ""}` }, [
      h("div", { class: "row wrap" }, [
        h("span", { class: "avatar", "aria-hidden": "true" }, [t("live.youInitial")]),
        h("strong", {}, [t("detail.you")]),
        h("span", { class: "tiny muted" }, [ago(c.createdAt)]),
        h("span", { class: "tag" }, [what]),
        c.outdated ? h("span", { class: "tag st-needs" }, [t("live.codeChanged")]) : null,
        h("span", { class: "tiny muted" }, [c.endLine > c.line ? t("live.lines", c.line, c.endLine) : t("live.line", c.line)]),
        h("span", { class: "spacer" }),
        c.status === "open" ? h("button", { class: "link", onclick: () => post({ type: "resolve", id: c.id, status: "resolved" }) }, [t("live.resolve")]) : h("button", { class: "link", onclick: () => post({ type: "resolve", id: c.id, status: "open" }) }, [t("live.reopen")]),
      ]),
      h("div", { class: "strong" }, [first]),
      rest.length ? h("div", { class: "pre small" }, [rest.join("\n")]) : null,
    ]);
  }

  function formEl(path, line) {
    const ta = /** @type {HTMLTextAreaElement} */ (h("textarea", { id: "ctext", rows: 3, placeholder: t("live.commentPh") }));
    ta.value = (vscode.getState() || {}).commentDraft || "";
    ta.addEventListener("input", () => vscode.setState({ ...(vscode.getState() || {}), commentDraft: ta.value }));
    const send = (action) => {
      const text = ta.value.trim();
      if (!text) return ta.focus();
      post({ type: "comment", path, line, text, action });
      vscode.setState({ ...(vscode.getState() || {}), commentDraft: "" });
      form = null;
      render();
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send("guidance");
      if (e.key === "Escape") ((form = null), render());
    });
    return h("div", { class: "cmt form composer" }, [
      h("label", { for: "ctext", class: "small muted" }, [t("live.commentOn", `${path}:${line}`)]),
      ta,
      h("div", { class: "row wrap" }, [
        h("button", { class: "btn primary sm", title: t("live.tellHint"), onclick: () => send("guidance") }, [t("live.tell")]),
        h("button", { class: "btn sm", onclick: () => send("task") }, [t("live.makeTask")]),
        h("button", { class: "btn sm", onclick: () => send("note") }, [t("live.keepNote")]),
        h("button", { class: "btn ghost sm", onclick: () => ((form = null), render()) }, [t("live.cancel")]),
      ]),
    ]);
  }

  const update = guardedRender(root, render);
  window.addEventListener("message", (e) => {
    if (e.data?.type === "data") {
      data = e.data;
      update();
    }
  });
  setInterval(() => update(), 30000);
  post({ type: "ready" });
})();
