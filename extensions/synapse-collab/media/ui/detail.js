// @ts-check
// Right column: the selected agent. Its conversation (prompts, guidance,
// what it said, tools it used), plan and changes, and the box where the
// person gives it guidance or a new prompt.
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const UI = /** @type {any} */ (window).SynapseUI;
  const { t, h, icon, iconButton, segmented, dot, statusOf, statusEl, taskOf, planOf, progress, filesOf, approvalText, testsEl, diffstat, ago, guardedRender, draftArea } = UI;
  const root = /** @type {HTMLElement} */ (document.getElementById("root"));
  const saved = vscode.getState() || {};
  /** @type {any} */
  let msg = { state: null, connected: false };
  /** @type {{ id?: string, entries: any[] }} */
  let transcript = { entries: [] };
  let tab = saved.tab || "conversation";
  let steerMode = saved.steerMode || "next";
  let stickToBottom = true;
  const post = (m) => vscode.postMessage(m);
  const cmd = (command, ...args) => post({ type: "command", command, args });
  const remember = () => vscode.setState({ ...(vscode.getState() || {}), tab, steerMode });

  function render() {
    const scroller = root.querySelector(".body");
    const prevScroll = scroller ? scroller.scrollTop : 0;
    root.replaceChildren();
    root.className = "detail";
    const { state, connected, selected } = msg;
    if (!connected || !state) {
      root.append(h("div", { class: "empty" }, [h("p", {}, [t("core.notRunning")])]));
      return;
    }
    const a = state.agents.find((x) => x.id === selected);
    if (!a) {
      root.append(
        h("div", { class: "empty" }, [
          h("p", {}, [t("detail.none")]),
          h("button", { class: "btn primary", onclick: () => cmd("synapse.addAgent") }, [icon("plus", 14), t("agents.new")]),
        ]),
      );
      return;
    }
    const st = statusOf(a, state);
    const busy = a.status === "working" || a.status === "awaiting-approval";
    const running = a.status !== "stopped" && a.status !== "error";
    const { title } = taskOf(a, state);
    const plan = planOf(a);
    const { files } = filesOf(a, state);

    // Header
    root.append(
      h("header", { class: "head" }, [
        h("div", { class: "row" }, [
          dot(a.color, "lg"),
          h("div", { class: "col tight grow" }, [
            h("div", { class: "row" }, [h("h1", { class: "name" }, [a.name]), statusEl(st), testsEl(a)]),
            h("div", { class: "mono tiny muted ell" }, [[a.agentInfo?.name || a.preset, a.worktree.branch].filter(Boolean).join(" · ")]),
          ]),
          running
            ? busy
              ? iconButton("stop", t("detail.cancelTurn"), () => cmd("synapse.cancelAgent", a.id))
              : null
            : iconButton("play", t("detail.start"), () => cmd("synapse.startAgent", a.id)),
          a.currentTaskId || busy || a.turn ? iconButton("handoff", t("detail.takeover"), () => cmd("synapse.takeover", a.id)) : null,
          iconButton("more", t("detail.more"), () => cmd("synapse.agentMenu", a.id)),
        ]),
        title ? h("div", { class: "task" }, [title]) : null,
        plan.total ? h("div", { class: "row" }, [h("span", { class: "tiny muted" }, [t("plan")]), progress(plan.done, plan.total, a.color)]) : null,
        a.error ? h("div", { class: "small error-text" }, [a.error]) : null,
        h(
          "nav",
          { class: "tabs", "aria-label": a.name },
          [
            ["conversation", t("detail.conversation")],
            ["plan", t("plan")],
            ["changes", [t("detail.changes"), " ", h("span", { class: "mono tiny muted" }, [String(files.length)])]],
          ].map(([id, label]) => h("button", { "aria-current": String(tab === id), onclick: () => ((tab = /** @type {string} */ (id)), remember(), render()) }, [label])),
        ),
      ]),
    );

    const body = h("div", { class: "body", tabindex: "0", "aria-label": t("detail.conversation") }, []);
    body.addEventListener("scroll", () => {
      stickToBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    });
    if (tab === "plan") renderPlan(body, a);
    else if (tab === "changes") renderChanges(body, a, files, state);
    else renderConversation(body, a, state);
    root.append(body);
    root.append(renderComposer(a, busy, running));
    if (tab === "conversation" && stickToBottom) body.scrollTop = body.scrollHeight;
    else body.scrollTop = prevScroll;
  }

  function renderConversation(body, a, state) {
    const entries = transcript.id === a.id ? transcript.entries : [];
    const approvals = state.approvals.filter((x) => x.status === "pending" && x.agentId === a.id);
    if (!entries.length && !approvals.length) {
      body.append(h("p", { class: "muted small" }, [a.status === "stopped" ? t("detail.stopped") : t("detail.quiet")]));
      return;
    }
    const list = h("div", { class: "conv" }, []);
    const last = entries[entries.length - 1];
    for (const e of entries) {
      const streaming = e === last && e.kind === "message" && a.status === "working";
      const el = entry(e, a, state, streaming);
      if (el) list.append(el);
      // Every turn can be undone: put the worktree back to how it was before it.
      if (el && e.kind === "prompt" && e.checkpoint && !e.followup && !busy(a)) {
        list.append(h("div", { class: "rewind-row" }, [h("button", { class: "link tiny", onclick: () => post({ type: "rewind", id: a.id, n: e.n }) }, [icon("refresh", 11), t("detail.rewind")])]));
      }
    }
    if (a.status === "working" && (!last || last.kind !== "message")) {
      list.append(h("div", { class: "agent-msg muted" }, [dot(a.color, "sm pulse"), h("span", {}, [t("detail.working")])]));
    }
    for (const ap of approvals) list.append(askCard(ap));
    body.append(list);
  }

  /** One conversation entry. */
  function entry(e, a, state, streaming) {
    switch (e.kind) {
      case "prompt": {
        if (e.followup) return h("div", { class: "divider tiny muted" }, [t("detail.followup")]);
        const task = e.taskId ? state.tasks.find((x) => x.id === e.taskId) : undefined;
        if (task) {
          return h("div", { class: "card task-card" }, [
            h("div", { class: "tiny muted label" }, [`${t("task")} · ${task.id}`]),
            h("div", { class: "strong" }, [task.title]),
            task.description ? h("div", { class: "small fg2 clamp" }, [task.description]) : null,
          ]);
        }
        return bubble(e.text, t("detail.you"), e.at);
      }
      case "guidance":
        return bubble(e.text, e.mode === "now" ? t("detail.guidanceNow") : t("detail.guidanceNext"), e.at);
      case "message":
        {
          const parts = richText(streaming ? e.text.trimEnd() : e.text);
          if (streaming) {
            const lastP = parts[parts.length - 1];
            const caret = h("span", { class: "caret", "aria-hidden": "true" });
            if (lastP && lastP.tagName === "P") lastP.append(caret);
            else parts.push(h("p", {}, [caret]));
          }
          return h("div", { class: "agent-msg" }, [dot(a.color, "sm"), h("div", { class: "text" }, parts)]);
        }
      case "thought":
        return h("details", { class: "thought" }, [h("summary", { class: "tiny muted" }, [t("detail.thinking")]), h("div", { class: "small fg2 pre" }, [e.text])]);
      case "tool": {
        const failed = e.status === "failed";
        const done = e.status === "completed";
        const loc = (e.locations || [])[0];
        return h(
          "button",
          { class: `tool mono${failed ? " failed" : ""}`, title: (e.locations || []).join("\n") || e.text, onclick: loc ? () => post({ type: "openFile", path: relPath(loc, a), agentId: a.id }) : undefined, disabled: !loc },
          [
            icon(failed ? "alert" : done ? "check" : "chevron", 12),
            h("span", { class: "ell grow" }, [e.text]),
            h("span", { class: "muted" }, [failed ? t("tool.failed") : done ? "" : t("tool.running")]),
          ],
        );
      }
      case "review": {
        const reviewer = state.agents.find((x) => x.id === e.reviewer);
        return h("div", { class: "card task-card" }, [
          h("div", { class: "row tiny muted label" }, [reviewer ? dot(reviewer.color, "sm") : null, t("detail.reviewBy", reviewer ? reviewer.name : e.reviewer || "")]),
          e.error ? h("div", { class: "small error-text" }, [e.error]) : h("div", { class: "small" }, [e.text || t("detail.reviewNoSummary")]),
          e.comments ? h("button", { class: "link tiny", onclick: () => post({ type: "select", id: a.id, show: "diff" }) }, [t("detail.reviewComments", e.comments)]) : null,
        ]);
      }
      case "rewind":
        return h("div", { class: "divider tiny st-needs" }, [t("detail.rewound")]);
      case "end":
        if (e.error) return h("div", { class: "divider small error-text" }, [t("detail.endedError", e.error)]);
        if (e.stopReason && e.stopReason !== "end_turn") return h("div", { class: "divider tiny muted" }, [t(`stop.${e.stopReason}`) === `stop.${e.stopReason}` ? t("detail.ended", e.stopReason) : t(`stop.${e.stopReason}`)]);
        return null;
      default:
        return null;
    }
  }

  const busy = (a) => a.status === "working" || a.status === "awaiting-approval";
  const relPath = (p, a) => (p.startsWith(a.worktree.path) ? p.slice(a.worktree.path.length).replace(/^[\\/]/, "") : p);

  function bubble(text, meta, at) {
    const long = text.length > 600;
    return h("div", { class: "you" }, [
      h("span", { class: "tiny muted" }, [meta, at ? ` · ${ago(at)}` : ""]),
      long
        ? h("details", { class: "bubble" }, [h("summary", {}, [text.slice(0, 240).trim() + "…"]), h("div", { class: "pre small" }, [text])])
        : h("div", { class: "bubble pre" }, [text]),
    ]);
  }

  /** Plain text with ``` code blocks and `inline code`. */
  function richText(text) {
    const out = [];
    const parts = text.split(/```[^\n]*\n?/);
    parts.forEach((part, i) => {
      if (!part) return;
      if (i % 2 === 1) out.push(h("pre", { class: "code-block" }, [part.replace(/\n$/, "")]));
      else {
        const p = h("p", { class: "pre" }, []);
        part.split(/(`[^`\n]+`)/).forEach((s) => p.append(s.startsWith("`") && s.endsWith("`") && s.length > 2 ? h("code", {}, [s.slice(1, -1)]) : document.createTextNode(s)));
        out.push(p);
      }
    });
    return out;
  }

  function askCard(ap) {
    return h("div", { class: "ask" }, [
      h("div", { class: "row small strong st-needs" }, [icon("terminal", 14), t("detail.asks")]),
      h("div", { class: "small" }, [ap.title]),
      ap.detail ? h("pre", { class: "code-block clamp" }, [approvalText(ap)]) : null,
      h(
        "div",
        { class: "row wrap" },
        ap.options.map((o) => h("button", { class: `btn sm${o.kind.startsWith("allow") ? (o.kind === "allow_once" ? " primary" : "") : " ghost"}`, onclick: () => post({ type: "approve", id: ap.id, optionId: o.optionId }) }, [o.name])),
      ),
    ]);
  }

  function renderPlan(body, a) {
    const plan = a.plan || [];
    if (!plan.length) {
      body.append(h("p", { class: "muted small" }, [t("detail.noPlan")]));
      return;
    }
    const firstOpen = plan.findIndex((p) => p.status !== "completed");
    body.append(
      h(
        "ol",
        { class: "plan" },
        plan.map((p, i) => {
          const done = p.status === "completed";
          const cur = p.status === "in_progress" || (i === firstOpen && a.status === "working");
          return h("li", { class: done ? "done" : cur ? "cur" : "" }, [
            done ? icon("check", 15, t("plan.done")) : cur ? h("span", { class: "ring pulse", role: "img", "aria-label": t("plan.current") }) : icon("circle", 15),
            h("span", {}, [p.content]),
          ]);
        }),
      ),
    );
  }

  /** The last test run in the agent's worktree, with its output. */
  function testsBlock(a) {
    const r = a.tests;
    const run = h("button", { class: "btn sm", onclick: () => post({ type: "runTests", id: a.id }), disabled: (r && r.status === "running") || undefined }, [icon("play", 10), r ? t("tests.runAgain") : t("tests.run")]);
    if (!r) return h("div", { class: "row tests" }, [h("span", { class: "tiny muted grow" }, [t("tests.none")]), run]);
    return h("details", { class: "tests", open: r.status === "failed" || undefined }, [
      h("summary", { class: "row" }, [testsEl(a), h("code", { class: "tiny muted ell grow" }, [r.command]), r.durationMs ? h("span", { class: "tiny muted" }, [`${(r.durationMs / 1000).toFixed(1)} s`]) : null, run]),
      r.output ? h("pre", { class: "code-block output" }, [r.output]) : null,
    ]);
  }

  function renderChanges(body, a, files, state) {
    body.append(testsBlock(a));
    if (!files.length) {
      body.append(h("p", { class: "muted small" }, [t("detail.noChanges")]));
      return;
    }
    const open = (state.comments || []).filter((c) => c.agentId === a.id && c.status === "open").length;
    body.append(
      h("div", { class: "row wrap" }, [
        h("button", { class: "btn", onclick: () => post({ type: "select", id: a.id, show: "diff" }) }, [icon("diff", 14), t("detail.openLive")]),
        h("button", { class: "btn", onclick: () => cmd("synapse.reviewAgent", a.id), title: t("detail.askReviewHint") }, [icon("comment", 14), t("detail.askReview")]),
        open ? h("span", { class: "tiny muted" }, [t("detail.openComments", open)]) : null,
      ]),
      h(
        "ul",
        { class: "files" },
        files.map((f) =>
          h("li", {}, [
            h("button", { class: "row mono small file", onclick: () => post({ type: "openFile", path: f.path, agentId: a.id }) }, [
              h("span", { class: "filest" }, [f.status === "added" ? "A" : f.status === "deleted" ? "D" : "M"]),
              h("span", { class: "ell grow" }, [f.path]),
              diffstat(f.linesAdded || 0, f.linesRemoved || 0),
            ]),
            f.symbols && f.symbols.length
              ? h(
                  "div",
                  { class: "symbols" },
                  f.symbols.slice(0, 12).map((s) => h("code", { class: `sym${s.signatureChanged ? " sig" : ""}`, title: s.newSignature || s.oldSignature || "" }, [s.name])),
                )
              : null,
          ]),
        ),
      ),
    );
  }

  function renderComposer(a, busy, running) {
    const foot = h("footer", { class: "foot" }, []);
    if (!running) {
      foot.append(h("button", { class: "btn primary", onclick: () => cmd("synapse.startAgent", a.id) }, [icon("play", 12), t("detail.start")]));
      return foot;
    }
    const placeholder = busy ? t("detail.guidancePh", a.name) : t("detail.messagePh", a.name);
    const area = draftArea(vscode, a.id, { rows: 2, placeholder, id: "composer-text" });
    const send = () => {
      const text = area.el.value.trim();
      if (!text) return;
      post(busy ? { type: "steer", id: a.id, text, mode: steerMode } : { type: "prompt", id: a.id, text });
      area.clear();
      stickToBottom = true;
    };
    area.el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        send();
      }
    });
    foot.append(
      h("div", { class: "composer" }, [
        h("label", { class: "sr", for: "composer-text" }, [placeholder]),
        area.el,
        h("div", { class: "row" }, [
          busy
            ? segmented(
                [
                  { id: "next", label: t("detail.afterTurn") },
                  { id: "now", label: t("detail.now") },
                ],
                steerMode,
                (id) => ((steerMode = id), remember(), render()),
                t("detail.when"),
              )
            : null,
          h("span", { class: "spacer" }),
          h("span", { class: "mono tiny muted", "aria-hidden": "true" }, [navigator.platform.startsWith("Mac") ? "⌘↵" : "Ctrl+↵"]),
          h("button", { class: "btn primary sm", onclick: send }, [t("detail.send")]),
        ]),
      ]),
    );
    return foot;
  }

  const update = guardedRender(root, render);
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (d?.type === "state") {
      if (d.selected !== msg.selected) stickToBottom = true;
      msg = d;
    } else if (d?.type === "showTab") {
      tab = d.tab;
      remember();
      render();
      return;
    } else if (d?.type === "focusComposer") {
      tab = tab === "conversation" ? tab : "conversation";
      const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("composer-text"));
      if (ta) ta.focus();
      return;
    } else if (d?.type === "transcript") {
      transcript = { id: d.id, entries: d.entries || [] };
    } else return;
    // The conversation keeps streaming while the person types guidance.
    const a = document.activeElement;
    if (a && a.id === "composer-text") renderKeepingFocus();
    else update();
  });

  /** Re-renders, then puts the cursor back where it was in the composer. */
  function renderKeepingFocus() {
    const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("composer-text"));
    const start = ta?.selectionStart ?? 0;
    const end = ta?.selectionEnd ?? 0;
    render();
    const again = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("composer-text"));
    if (again) {
      again.focus();
      again.setSelectionRange(start, end);
    }
  }
  setInterval(() => update(), 30000);
  post({ type: "ready" });
})();
