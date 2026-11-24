// @ts-check
// Collaboration board webview. Renders state pushed by the extension; every
// action is posted back and executed against synapse-core.
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const root = /** @type {HTMLElement} */ (document.getElementById("root"));
  const saved = vscode.getState() || {};
  const drafts = /** @type {Record<string, string>} */ (saved.drafts || {});
  const ui = { tab: saved.tab || "agents" };
  let last = { state: null, connected: false };
  const setTab = (tab) => {
    ui.tab = tab;
    vscode.setState({ ...(vscode.getState() || {}), drafts, tab });
    render(last.state, last.connected);
  };

  /** @param {string} tag @param {Record<string, any>} [attrs] @param {(Node|string|null|undefined|false)[]} [children] */
  function h(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else el.setAttribute(k, String(v));
    }
    for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === "string" ? document.createTextNode(c) : c);
    return el;
  }

  const cmd = (command, ...args) => vscode.postMessage({ type: "command", command, args });
  const button = (label, onclick, cls = "") => h("button", { class: cls, onclick }, [label]);

  function render(state, connected) {
    root.replaceChildren();
    if (!connected || !state) {
      root.append(
        h("div", { class: "empty" }, [
          h("p", {}, ["synapse-core is not running for this workspace."]),
          button("Start core", () => cmd("synapse.startCore"), "primary"),
        ]),
      );
      return;
    }
    const pending = state.approvals.filter((a) => a.status === "pending");
    const errors = state.conflicts.filter((c) => c.severity !== "info");

    root.append(
      h("div", { class: "toolbar" }, [
        h("span", { class: "muted" }, [`base: ${state.baseRef}`]),
        h("span", { class: "spacer" }),
        button("Add agent", () => cmd("synapse.addAgent")),
        button("Review & merge", () => cmd("synapse.prepareReview"), "primary"),
      ]),
    );

    if (pending.length) {
      root.append(h("h2", {}, [`Approvals (${pending.length})`]));
      for (const ap of pending) {
        const agent = state.agents.find((a) => a.id === ap.agentId);
        root.append(
          h("div", { class: "card approval", style: { borderLeftColor: agent ? agent.color : "" } }, [
            h("div", { class: "row" }, [h("strong", {}, [agent ? agent.name : ap.agentId]), h("span", { class: "muted" }, [ap.toolKind || ""])]),
            h("div", {}, [ap.title]),
            ap.detail ? h("pre", { class: "detail" }, [JSON.stringify(ap.detail, null, 2).slice(0, 1200)]) : null,
            h(
              "div",
              { class: "row" },
              ap.options.map((o) =>
                button(o.name, () => vscode.postMessage({ type: "approve", id: ap.id, optionId: o.optionId }), o.kind.startsWith("allow") ? "primary" : ""),
              ),
            ),
          ]),
        );
      }
    }

    const held = state.messages.filter((m) => m.status === "held").length;
    const proposed = state.decisions.filter((d) => d.status === "proposed").length;
    const stale = state.decisions.filter((d) => d.status === "accepted" && (d.anchors ?? []).some((a) => a.state !== "current")).length;
    const review = state.tasks.filter((t) => t.status === "review").length;
    const risky = state.audit.filter((e) => e.risky && e.outcome === "ran-unasked").length;
    const tabs = [
      ["agents", `Agents${errors.length ? ` ⚠${errors.length}` : ""}`],
      ["tasks", `Tasks${review ? ` •${review}` : ""}`],
      ["messages", `Messages${held ? ` ⏸${held}` : ""}`],
      ["decisions", `Decisions${proposed ? ` •${proposed}` : ""}${stale ? ` ⚠${stale}` : ""}`],
      ["audit", `Audit${risky ? ` ⚠${risky}` : ""}`],
    ];
    root.append(
      h(
        "div",
        { class: "tabs" },
        tabs.map(([id, label]) => h("button", { class: `tab${ui.tab === id ? " active" : ""}`, onclick: () => setTab(id) }, [label])),
      ),
    );
    if (ui.tab === "tasks") return renderTasks(state);
    if (ui.tab === "messages") return renderMessages(state);
    if (ui.tab === "decisions") return renderDecisions(state);
    if (ui.tab === "audit") return renderAudit(state);

    root.append(h("h2", {}, [`Conflicts (${errors.length})`]));
    if (!state.conflicts.length) root.append(h("p", { class: "muted" }, ["No conflicts between agents."]));
    for (const c of state.conflicts) {
      const site = c.callSites && c.callSites[0];
      root.append(
        h("div", { class: `conflict sev-${c.severity}` }, [
          h("div", { class: "row" }, [h("span", { class: "pill" }, [c.kind]), h("a", { href: "#", onclick: (e) => (e.preventDefault(), vscode.postMessage({ type: "openFile", path: c.path })) }, [c.path])]),
          h("div", {}, [c.message]),
          site
            ? h("a", { href: "#", class: "muted", onclick: (e) => (e.preventDefault(), vscode.postMessage({ type: "openFile", path: site.path, agentId: site.agentId, line: site.line })) }, [
                `open call site in ${site.agentId}'s worktree`,
              ])
            : null,
        ]),
      );
    }

    root.append(h("h2", {}, [`Agents (${state.agents.length})`]));
    if (!state.agents.length) root.append(h("p", { class: "muted" }, ["No agents yet. Add one to give it its own worktree."]));
    for (const a of state.agents) root.append(agentCard(a, state));
  }

  // ---------------------------------------------------------------------------
  // Tabs (phase 3)

  const agentName = (state, id) => (id === "human" ? "you" : id === "all" ? "all agents" : (state.agents.find((a) => a.id === id) || { name: id }).name);
  const agentColor = (state, id) => (state.agents.find((a) => a.id === id) || {}).color || "var(--vscode-descriptionForeground)";
  const post = (type, data) => vscode.postMessage({ type, ...data });
  const input = (attrs) => /** @type {HTMLInputElement} */ (h("input", attrs));
  const select = (options, attrs = {}) =>
    /** @type {HTMLSelectElement} */ (h("select", attrs, options.map(([value, label]) => h("option", { value }, [label]))));

  function renderTasks(state) {
    const title = input({ placeholder: "New task title" });
    const desc = /** @type {HTMLTextAreaElement} */ (h("textarea", { rows: 2, placeholder: "What should the agent do? (optional)" }));
    const agent = select([["", "unassigned"], ...state.agents.map((a) => [a.id, a.name])]);
    const deps = /** @type {HTMLSelectElement} */ (h("select", { multiple: true, size: Math.min(4, Math.max(2, state.tasks.length)), title: "Depends on" }, state.tasks.map((t) => h("option", { value: t.id }, [`${t.id} ${t.title}`]))));
    const scope = input({ placeholder: "Scope globs, comma-separated (optional), e.g. src/api/**" });
    const auto = input({ type: "checkbox", id: "auto" });
    root.append(
      h("details", { class: "card form", open: state.tasks.length === 0 }, [
        h("summary", {}, ["New task"]),
        title,
        desc,
        h("div", { class: "row" }, [h("span", { class: "muted small" }, ["Agent"]), agent, h("label", { class: "small" }, [auto, " start automatically"])]),
        state.tasks.length ? h("div", {}, [h("div", { class: "muted small" }, ["Depends on (ctrl/cmd-click for several)"]), deps]) : null,
        scope,
        button("Create task", () => {
          if (!title.value.trim()) return;
          post("createTask", {
            title: title.value,
            description: desc.value,
            agentId: agent.value || undefined,
            dependsOn: [...deps.selectedOptions].map((o) => o.value),
            scope: scope.value.split(",").map((x) => x.trim()).filter(Boolean),
            autoStart: auto.checked,
          });
        }, "primary"),
      ]),
    );
    if (!state.tasks.length) {
      root.append(h("p", { class: "muted" }, ["Split a goal into tasks, assign each to an agent, and say which tasks depend on which. Finished work is handed to the next agent with what it changed."]));
      return;
    }
    const order = { review: 0, in_progress: 1, todo: 2, failed: 3, done: 4 };
    for (const t of [...state.tasks].sort((a, b) => order[a.status] - order[b.status] || a.id.localeCompare(b.id, undefined, { numeric: true }))) {
      const actions = [];
      if ((t.status === "todo" || t.status === "failed" || t.status === "review") && !t.blocked && t.agentId) actions.push(button(t.status === "todo" ? "Start" : "Run again", () => post("taskAction", { id: t.id, action: "start" }), "primary"));
      if (t.status === "review") actions.push(button("Done", () => post("taskAction", { id: t.id, action: "done" }), "primary"), button("Failed", () => post("taskAction", { id: t.id, action: "failed" })));
      if (t.status === "in_progress") actions.push(button("Mark failed", () => post("taskAction", { id: t.id, action: "failed" })));
      if (t.status === "done" || t.status === "failed") actions.push(button("Reopen", () => post("taskAction", { id: t.id, action: "todo" })));
      if (t.status !== "in_progress") actions.push(button("Remove", () => post("taskAction", { id: t.id, action: "remove" }), "link"));
      root.append(
        h("div", { class: "card task", style: { borderLeftColor: t.agentId ? agentColor(state, t.agentId) : "" } }, [
          h("div", { class: "row" }, [
            h("strong", {}, [`${t.id} · ${t.title}`]),
            h("span", { class: `status ts-${t.status}` }, [t.blocked && t.status === "todo" ? "blocked" : t.status.replace("_", " ")]),
            t.autoStart ? h("span", { class: "muted small", title: "Starts automatically when its dependencies are done" }, ["auto"]) : null,
          ]),
          h("div", { class: "muted small" }, [
            t.agentId ? `→ ${agentName(state, t.agentId)}` : "unassigned",
            t.dependsOn.length ? ` · after ${t.dependsOn.join(", ")}` : "",
            t.scope.length ? ` · scope ${t.scope.join(", ")}` : "",
          ]),
          t.description ? h("div", { class: "small" }, [t.description]) : null,
          t.outOfScope && t.outOfScope.length ? h("div", { class: "error small" }, [`Changed files outside its scope: ${t.outOfScope.join(", ")}`]) : null,
          t.summary ? h("details", {}, [h("summary", { class: "small" }, ["Agent's summary"]), h("div", { class: "message" }, [t.summary])]) : null,
          h("div", { class: "row" }, actions),
        ]),
      );
    }
  }

  function renderMessages(state) {
    const to = select([["all", "all agents"], ...state.agents.map((a) => [a.id, a.name])]);
    const kind = select([["note", "note"], ["question", "question"], ["answer", "answer"], ["blocker", "blocker"], ["handoff", "handoff"]]);
    const subject = input({ placeholder: "Subject" });
    const body = /** @type {HTMLTextAreaElement} */ (h("textarea", { rows: 2, placeholder: "Message (delivered with the agent's next prompt)" }));
    root.append(
      h("details", { class: "card form" }, [
        h("summary", {}, ["Message an agent"]),
        h("div", { class: "row" }, [to, kind]),
        subject,
        body,
        button("Send", () => subject.value.trim() && post("sendMessage", { to: to.value, kind: kind.value, subject: subject.value, body: body.value }), "primary"),
      ]),
    );
    const list = [...state.messages].sort((a, b) => (a.status === "held" ? -1 : 0) - (b.status === "held" ? -1 : 0) || b.createdAt.localeCompare(a.createdAt));
    if (!list.length) root.append(h("p", { class: "muted" }, ["Agents' handoffs, questions and notes appear here. Text from agents is passed on as data, and anything that reads like instructions is held for you."]));
    for (const m of list.slice(0, 100)) {
      root.append(
        h("div", { class: `card msg msg-${m.status}`, style: { borderLeftColor: agentColor(state, m.from) } }, [
          h("div", { class: "row" }, [
            h("span", { class: "pill" }, [m.kind]),
            h("strong", {}, [`${agentName(state, m.from)} → ${agentName(state, m.to)}`]),
            h("span", { class: "muted small" }, [m.status + (m.taskId ? ` · ${m.taskId}` : "")]),
          ]),
          h("div", {}, [m.subject]),
          m.body ? h("div", { class: "message" }, [m.body]) : null,
          m.files.length ? h("div", { class: "muted small" }, [`files: ${m.files.join(", ")}`]) : null,
          m.flags.length ? h("div", { class: "error small" }, [`Held: ${m.flags.join(", ")}`]) : null,
          m.status === "held"
            ? h("div", { class: "row" }, [button("Deliver anyway", () => post("messageAction", { id: m.id, action: "release" })), button("Reject", () => post("messageAction", { id: m.id, action: "reject" }), "primary")])
            : null,
        ]),
      );
    }
  }

  function renderDecisions(state) {
    const title = input({ placeholder: "Title, e.g. Money representation" });
    const decision = /** @type {HTMLTextAreaElement} */ (h("textarea", { rows: 2, placeholder: "The decision, e.g. Store amounts as integer cents" }));
    const rationale = input({ placeholder: "Why (optional)" });
    const pins = input({ placeholder: "Applies to (optional), e.g. src/pricing.ts#applyDiscount, src/money.ts" });
    root.append(
      h("details", { class: "card form", open: state.decisions.length === 0 }, [
        h("summary", {}, ["Record a decision"]),
        title,
        decision,
        rationale,
        pins,
        h("div", { class: "muted small" }, ["Or pin from the editor: right-click a function and choose \"Pin a Decision Here\". Synapse flags the decision when that code changes."]),
        button("Add (accepted)", () => title.value.trim() && decision.value.trim() && post("addDecision", { title: title.value, decision: decision.value, rationale: rationale.value, pins: pins.value }), "primary"),
      ]),
    );
    if (!state.decisions.length) root.append(h("p", { class: "muted" }, ["Project memory shared with agents. Accepted decisions are included in every task prompt; agents can propose new ones."]));
    const order = { proposed: 0, accepted: 1, superseded: 2, rejected: 3 };
    for (const d of [...state.decisions].sort((a, b) => order[a.status] - order[b.status] || a.id.localeCompare(b.id, undefined, { numeric: true }))) {
      root.append(
        h("div", { class: `card decision dec-${d.status}`, style: { borderLeftColor: d.author === "human" ? "" : agentColor(state, d.author) } }, [
          h("div", { class: "row" }, [h("strong", {}, [`${d.id} · ${d.title}`]), h("span", { class: "muted small" }, [d.status])]),
          h("div", {}, [d.decision]),
          d.rationale ? h("div", { class: "muted small" }, [`Why: ${d.rationale}`]) : null,
          renderAnchors(d),
          h("div", { class: "muted small" }, [`by ${agentName(state, d.author)}${d.supersedes ? ` · supersedes ${d.supersedes}` : ""}`]),
          d.status === "proposed"
            ? h("div", { class: "row" }, [button("Accept", () => post("decisionAction", { id: d.id, status: "accepted" }), "primary"), button("Reject", () => post("decisionAction", { id: d.id, status: "rejected" }))])
            : d.status === "accepted" && !(d.anchors ?? []).some((a) => a.state !== "current")
              ? h("div", { class: "row" }, [button("Supersede", () => post("decisionAction", { id: d.id, status: "superseded" }), "link")])
              : null,
        ]),
      );
    }
  }

  /** Where a decision applies, and whether that code changed since it was pinned. */
  function renderAnchors(d) {
    const anchors = d.anchors ?? [];
    if (!anchors.length) return null;
    const stale = anchors.filter((a) => a.state !== "current");
    const label = (a) => (a.symbol ? `${a.path} › ${a.symbol}` : a.path);
    return h("div", { class: `anchors${stale.length && d.status === "accepted" ? " stale" : ""}` }, [
      ...anchors.map((a) =>
        h("div", { class: "row small" }, [
          h("a", { href: "#", class: "anchor", onclick: (e) => (e.preventDefault(), post("openFile", { path: a.path })) }, [`📌 ${label(a)}`]),
          a.state === "changed" ? h("span", { class: "badge warn" }, ["code changed"]) : a.state === "missing" ? h("span", { class: "badge warn" }, ["gone from base"]) : null,
          button("Unpin", () => post("decisionUnpin", { id: d.id, path: a.path, symbol: a.symbol }), "link"),
        ]),
      ),
      stale.length && d.status === "accepted"
        ? h("div", { class: "row" }, [
            h("span", { class: "small" }, ["The code changed since this decision was pinned. Does it still hold?"]),
            button("Still holds", () => post("decisionRepin", { id: d.id }), "primary"),
            button("Supersede", () => post("decisionAction", { id: d.id, status: "superseded" })),
          ])
        : null,
    ]);
  }

  function renderAudit(state) {
    root.append(
      h("div", { class: "row" }, [
        h("span", { class: "muted small" }, ["Permission decisions and commands agents ran. Policies decide first; anything they don't cover comes to you."]),
        h("span", { class: "spacer" }),
        ...state.agents.map((a) => button(`${a.name} policy`, () => post("editPolicy", { agentId: a.id }), "link")),
      ]),
    );
    if (!state.audit.length) root.append(h("p", { class: "muted" }, ["Nothing yet."]));
    for (const e of [...state.audit].reverse().slice(0, 150)) {
      root.append(
        h("div", { class: `audit ${e.risky ? "risky" : ""} out-${e.outcome}` }, [
          h("span", { class: "dot", style: { background: agentColor(state, e.agentId) } }),
          h("span", { class: "small muted" }, [e.at.slice(11, 19)]),
          h("span", { class: `pill out-${e.outcome}` }, [e.outcome]),
          h("span", { class: "small" }, [`by ${e.by}`]),
          h("code", { class: "small" }, [e.command || e.path || e.title]),
          e.rule ? h("span", { class: "muted small" }, [`(${e.rule})`]) : null,
          e.risky ? h("span", { class: "error small" }, ["risky"]) : null,
        ]),
      );
    }
  }

  const openComments = (id, state) => (state.comments || []).filter((c) => c.agentId === id && c.status === "open").length;

  function agentCard(a, state) {
    const own = state.ownership[a.id];
    const files = own ? own.files : [];
    const running = a.status !== "stopped" && a.status !== "error";
    const busy = a.status === "working" || a.status === "awaiting-approval";
    const textarea = /** @type {HTMLTextAreaElement} */ (
      h("textarea", {
        rows: 2,
        placeholder: !running ? "Start the agent to send a prompt" : busy ? `Add guidance for ${a.name} while it works…` : `Tell ${a.name} what to do…`,
        disabled: !running,
      })
    );
    textarea.value = drafts[a.id] || "";
    textarea.addEventListener("input", () => {
      drafts[a.id] = textarea.value;
      vscode.setState({ drafts, tab: ui.tab });
    });
    /** @param {"now"|"next"} [mode] */
    const send = (mode) => {
      if (!textarea.value.trim()) return;
      vscode.postMessage(busy ? { type: "steer", id: a.id, text: textarea.value, mode: mode || "next" } : { type: "prompt", id: a.id, text: textarea.value });
      drafts[a.id] = "";
      vscode.setState({ drafts, tab: ui.tab });
      textarea.value = "";
    };
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send("next");
    });

    return h("div", { class: "card agent", style: { borderLeftColor: a.color } }, [
      h("div", { class: "row" }, [
        h("span", { class: "dot", style: { background: a.color } }),
        h("strong", {}, [a.name]),
        h("span", { class: `status st-${a.status}` }, [a.status]),
        h("span", { class: "spacer" }),
        running ? button("Stop", () => cmd("synapse.stopAgent", a.id)) : button("Start", () => cmd("synapse.startAgent", a.id), "primary"),
        busy ? button("Cancel", () => cmd("synapse.cancelAgent", a.id)) : null,
        a.currentTaskId || busy || (a.error && a.turn) ? button("Hand off…", () => cmd("synapse.takeover", a.id)) : null,
        button("⋯", () => cmd("synapse.agentMenu", a.id), "icon"),
      ]),
      h("div", { class: "muted small" }, [`${a.worktree.branch}${a.agentInfo && a.agentInfo.name ? ` · ${a.agentInfo.name} ${a.agentInfo.version || ""}` : ""}`]),
      a.error ? h("div", { class: "error" }, [a.error]) : null,
      a.turn
        ? h("div", { class: "turn" }, [
            h("span", { class: "muted" }, ["› "]),
            a.turn.prompt.slice(0, 240),
            a.turn.steered ? h("span", { class: "pill" }, [`steered ${a.turn.steered}×`]) : null,
          ])
        : null,
      a.guidance && a.guidance.length
        ? h(
            "ul",
            { class: "guidance" },
            a.guidance.map((g) => h("li", { class: "small" }, [h("span", { class: "muted" }, [g.mode === "now" ? "⏸ interrupting: " : "⏳ after this turn: "]), g.text])),
          )
        : null,
      a.plan && a.plan.length
        ? h(
            "ul",
            { class: "plan" },
            a.plan.map((p) => h("li", { class: `plan-${p.status}` }, [p.content])),
          )
        : null,
      a.lastMessage ? h("div", { class: "message" }, [a.lastMessage.slice(-400)]) : null,
      files.length
        ? h("details", { open: files.length <= 6 }, [
            h("summary", {}, [
              `Owns ${files.length} file${files.length === 1 ? "" : "s"}`,
              " ",
              button("Live diff", () => cmd("synapse.liveDiff", a.id), "link"),
              openComments(a.id, state) ? h("span", { class: "pill" }, [`💬 ${openComments(a.id, state)}`]) : null,
            ]),
            h(
              "ul",
              { class: "files" },
              files.map((f) =>
                h("li", {}, [
                  h("a", { href: "#", onclick: (e) => (e.preventDefault(), vscode.postMessage({ type: "openFile", path: f.path, agentId: a.id })) }, [f.path]),
                  h("span", { class: "muted small" }, [` +${f.linesAdded}/-${f.linesRemoved}`]),
                  f.symbols.length
                    ? h(
                        "div",
                        { class: "symbols" },
                        f.symbols.map((s) => h("code", { class: `sym sym-${s.change}${s.signatureChanged ? " sig" : ""}`, title: s.newSignature || s.oldSignature || "" }, [s.name])),
                      )
                    : null,
                ]),
              ),
            ),
          ])
        : h("div", { class: "muted small" }, ["No changes yet."]),
      h(
        "div",
        { class: busy ? "prompt steer" : "prompt" },
        busy
          ? [textarea, h("div", { class: "row" }, [button("After this turn", () => send("next"), "primary"), button("Interrupt now", () => send("now"))])]
          : [textarea, button("Send", () => send(), "primary")],
      ),
      button("Show output", () => cmd("synapse.showOutput", a.id), "link"),
    ]);
  }

  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "state") {
      last = { state: e.data.state, connected: e.data.connected };
      // Don't wipe a form the person is typing in; the next update after blur renders.
      const active = document.activeElement;
      if (active && root.contains(active) && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT") && ui.tab !== "agents") {
        pendingRender = true;
        return;
      }
      render(last.state, last.connected);
    }
  });
  let pendingRender = false;
  document.addEventListener("focusout", () =>
    setTimeout(() => {
      if (pendingRender && !(document.activeElement && root.contains(document.activeElement) && document.activeElement !== document.body)) {
        pendingRender = false;
        render(last.state, last.connected);
      }
    }, 0),
  );
  vscode.postMessage({ type: "ready" });
})();
