// @ts-check
// The home tab: what needs the person, every agent, tasks, team and getting
// started; then the project's tasks, decisions, messages and audit in full.
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const UI = /** @type {any} */ (window).SynapseUI;
  const { t, h, icon, button, dot, statusOf, statusEl, taskOf, planOf, progress, filesOf, fileCount, approvalText, diffstat, ago, guardedRender } = UI;
  const root = /** @type {HTMLElement} */ (document.getElementById("root"));
  const saved = vscode.getState() || {};
  let section = saved.section || "overview";
  /** @type {any} */
  let msg = { state: null, connected: false };
  const post = (type, data = {}) => vscode.postMessage({ type, ...data });
  const cmd = (command, ...args) => vscode.postMessage({ type: "command", command, args });
  const go = (s) => {
    section = s;
    vscode.setState({ ...(vscode.getState() || {}), section });
    update(true);
  };
  const agentOf = (state, id) => state.agents.find((a) => a.id === id);
  const nameOf = (state, id) => (id === "human" ? t("you") : id === "all" ? t("allAgents") : (agentOf(state, id) || { name: id }).name);
  const colorOf = (state, id) => (agentOf(state, id) || {}).color || "var(--sy-idle)";

  function render() {
    root.replaceChildren();
    root.className = "home";
    const { state, connected } = msg;
    if (!connected || !state) {
      root.append(h("div", { class: "page" }, [h("div", { class: "empty" }, [h("p", {}, [t("core.notRunning")]), button(t("core.start"), () => cmd("synapse.startCore"), "primary")])]));
      return;
    }
    const page = h("div", { class: "page" }, []);
    const counts = {
      tasks: state.tasks.filter((x) => x.status === "review" || x.status === "in_progress").length,
      decisions: state.decisions.filter((d) => d.status === "proposed").length,
      messages: state.messages.filter((m) => m.status === "held").length,
      audit: state.audit.filter((e) => e.risky && e.outcome === "ran-unasked").length,
    };
    page.append(
      h("div", { class: "row wrap head" }, [
        h("div", { class: "grow" }, [
          h("h1", {}, [t("home")]),
          h("p", { class: "muted small" }, [[msg.repoName, state.baseRef, t("home.agents", state.agents.length)].join(" · ")]),
        ]),
        button(t("agents.new"), () => cmd("synapse.addAgent")),
        state.agents.length ? button(t("review.merge"), () => cmd("synapse.prepareReview")) : null,
        h("button", { class: "btn primary", onclick: () => go("tasks") }, [icon("plus", 14), t("task.new")]),
      ]),
      h(
        "nav",
        { class: "tabs", "aria-label": t("home") },
        [
          ["overview", t("home.overview"), 0],
          ["tasks", t("tasks"), counts.tasks],
          ["decisions", t("decisions"), counts.decisions],
          ["messages", t("messages"), counts.messages],
          ["audit", t("audit"), counts.audit],
        ].map(([id, label, n]) => h("button", { "aria-current": String(section === id), onclick: () => go(id) }, [label, n ? h("span", { class: "mono tiny muted" }, [String(n)]) : null])),
      ),
    );
    if (section === "tasks") renderTasks(page, state);
    else if (section === "decisions") renderDecisions(page, state);
    else if (section === "messages") renderMessages(page, state);
    else if (section === "audit") renderAudit(page, state);
    else renderOverview(page, state);
    root.append(page);
  }

  // ---------------------------------------------------------------------------
  // Overview

  function renderOverview(page, state) {
    const alerts = state.alerts || [];
    const needs = h("section", { class: "col", "aria-labelledby": "h-needs" }, [
      h("h2", { id: "h-needs", class: "row" }, [t("status.needs"), alerts.length ? h("span", { class: "count" }, [String(alerts.length)]) : null]),
    ]);
    if (!alerts.length) needs.append(h("p", { class: "muted small" }, [t("needs.none")]));
    for (const a of alerts) needs.append(alertCard(a, state));
    page.append(needs);

    const agents = h("section", { class: "col", "aria-labelledby": "h-agents" }, [h("h2", { id: "h-agents" }, [t("agents")])]);
    if (!state.agents.length) {
      agents.append(h("div", { class: "card card-pad col" }, [h("p", { class: "small fg2" }, [t("agents.intro")]), h("div", {}, [button(t("agents.new"), () => cmd("synapse.addAgent"), "primary")])]));
    } else {
      const grid = h("div", { class: "agent-grid" }, []);
      for (const a of state.agents) grid.append(agentCard(a, state));
      agents.append(grid);
    }
    page.append(agents);

    const lower = h("div", { class: "lower" }, []);
    lower.append(tasksSummary(state));
    const side = h("div", { class: "col gap-lg" }, []);
    const team = teamSummary(state);
    if (team) side.append(team);
    const start = checklist(state);
    if (start) side.append(start);
    if (side.childElementCount) lower.append(side);
    page.append(lower);
  }

  const KIND = {
    approval: ["terminal", "needs"],
    conflict: ["alert", "error"],
    "agent-error": ["alert", "error"],
    "held-message": ["message", "needs"],
    "proposed-decision": ["decision", "info"],
    "stale-decision": ["pin", "needs"],
    "task-review": ["checkCircle", "review"],
    "risky-command": ["shield", "error"],
    "team-claim": ["users", "info"],
  };

  /** The alert's title in the person's language, built from state; the core's English title if the item is gone. */
  function alertTitle(a, state) {
    const where = (c) => (c.symbol ? `${c.path} › ${c.symbol}` : c.path);
    switch (a.kind) {
      case "approval": {
        const ap = state.approvals.find((x) => x.id === a.ref);
        return ap ? t("alert.approval", nameOf(state, ap.agentId), ap.title) : a.title;
      }
      case "conflict": {
        const c = state.conflicts.find((x) => x.id === a.ref);
        if (!c) return a.title;
        if (c.kind === "decision") return t("alert.conflictDecision", c.decisionId || "");
        const kind = t(`conflict.${c.kind}`);
        return t("alert.conflict", kind === `conflict.${c.kind}` ? c.kind : kind, where(c));
      }
      case "agent-error": {
        const ag = agentOf(state, a.ref);
        return ag ? t("alert.agentError", ag.name) : a.title;
      }
      case "held-message": {
        const m = state.messages.find((x) => x.id === a.ref);
        return m ? t("alert.held", nameOf(state, m.from), m.subject) : a.title;
      }
      case "proposed-decision": {
        const d = state.decisions.find((x) => x.id === a.ref);
        if (!d) return a.title;
        return d.author === "human" ? t("alert.proposedByYou", d.id, d.title) : t("alert.proposed", nameOf(state, d.author), d.id, d.title);
      }
      case "stale-decision":
        return t("alert.stale", a.ref);
      case "task-review": {
        const x = state.tasks.find((y) => y.id === a.ref);
        return x ? t("alert.review", x.id, x.title) : a.title;
      }
      case "risky-command": {
        const n = Number((a.title.match(/^\d+/) || ["0"])[0]);
        return n ? t("alert.risky", n) : a.title;
      }
      case "team-claim": {
        const c = (state.team?.claimsOnMe || []).find((x) => x.id === a.ref);
        if (!c) return a.title;
        const own = nameOf(state, c.agent.slice(c.agent.indexOf("/") + 1));
        return c.task ? t("alert.claimTask", c.by, own, c.task) : t("alert.claim", c.by, own);
      }
      default:
        return a.title;
    }
  }

  function alertCard(a, state) {
    const [ic, tone] = KIND[a.kind] || ["alert", "info"];
    const agent = a.agentId ? agentOf(state, a.agentId) : undefined;
    const ap = a.kind === "approval" ? state.approvals.find((x) => x.id === a.ref) : undefined;
    return h("div", { class: "card card-pad alert" }, [
      h("span", { class: `tile ${tone}`, "aria-hidden": "true" }, [icon(ic)]),
      h("div", { class: "grow col tight" }, [
        h("div", { class: "strong" }, [alertTitle(a, state)]),
        ap && ap.detail ? h("code", { class: "code-block clamp" }, [approvalText(ap)]) : a.detail ? h("div", { class: "small fg2 clamp" }, [a.detail]) : null,
        agent ? h("div", { class: "row tiny muted" }, [dot(agent.color, "sm"), agent.name, a.at ? ` · ${ago(a.at)}` : ""]) : null,
      ]),
      h("div", { class: "row wrap actions" }, alertActions(a, state, ap)),
    ]);
  }

  function alertActions(a, state, ap) {
    switch (a.kind) {
      case "approval":
        return ap ? ap.options.map((o) => button(o.name, () => post("approve", { id: ap.id, optionId: o.optionId }), o.kind === "allow_once" ? "primary" : o.kind.startsWith("allow") ? "" : "ghost")) : [];
      case "conflict": {
        const c = state.conflicts.find((x) => x.id === a.ref);
        const first = c && c.agents.find((id) => !id.startsWith("@"));
        return [first ? button(t("needs.openLive"), () => post("select", { id: first, show: "diff" }), "primary") : null, c ? button(t("needs.openFile"), () => post("openFile", { path: c.path })) : null];
      }
      case "agent-error":
        return [button(t("needs.restart"), () => cmd("synapse.restartAgent", a.ref), "primary"), button(t("needs.handOff"), () => cmd("synapse.takeover", a.ref))];
      case "held-message":
        return [button(t("needs.release"), () => post("messageAction", { id: a.ref, action: "release" })), button(t("needs.reject"), () => post("messageAction", { id: a.ref, action: "reject" }), "primary"), button(t("needs.details"), () => go("messages"), "ghost")];
      case "proposed-decision":
        return [button(t("needs.accept"), () => post("decisionAction", { id: a.ref, status: "accepted" }), "primary"), button(t("needs.reject"), () => post("decisionAction", { id: a.ref, status: "rejected" }))];
      case "stale-decision":
        return [button(t("needs.stillHolds"), () => post("decisionRepin", { id: a.ref }), "primary"), button(t("needs.details"), () => go("decisions"), "ghost")];
      case "task-review":
        return [button(t("review.merge"), () => cmd("synapse.prepareReview"), "primary"), a.agentId ? button(t("needs.seeChanges"), () => post("select", { id: a.agentId, show: "diff" })) : null, button(t("needs.markDone"), () => post("taskAction", { id: a.ref, action: "done" }), "ghost")];
      case "risky-command":
        return [button(t("needs.details"), () => go("audit"))];
      case "team-claim":
        return [button(t("needs.resetMine"), () => cmd("synapse.resetAgent", a.agentId)), button(t("needs.dismiss"), () => post("teamDismiss", { id: a.ref }), "ghost")];
      default:
        return [];
    }
  }

  function agentCard(a, state) {
    const st = statusOf(a, state);
    const { title } = taskOf(a, state);
    const plan = planOf(a);
    const { files, add, del } = filesOf(a, state);
    const last = (a.lastMessage || "").trim().split("\n").pop() || "";
    return h(
      "button",
      { class: "card agent-card", "aria-current": String(a.id === msg.selected), onclick: () => post("select", { id: a.id, show: "detail" }), oncontextmenu: (e) => (e.preventDefault(), cmd("synapse.agentMenu", a.id)) },
      [
        h("span", { class: "row" }, [dot(a.color), h("span", { class: "strong" }, [a.name]), h("span", { class: "tiny muted ell" }, [a.agentInfo?.name || a.preset || ""]), h("span", { class: "spacer" }), statusEl(st)]),
        h("span", { class: "ell" }, [title || h("span", { class: "muted" }, [t("agents.noTask")])]),
        plan.total ? h("span", { class: "row" }, [h("span", { class: "tiny muted" }, [t("plan")]), progress(plan.done, plan.total, a.color)]) : null,
        last ? h("span", { class: "small fg2 ell" }, [last.slice(0, 160)]) : null,
        h("span", { class: "row tiny muted" }, [files.length ? [fileCount(files.length), " · ", diffstat(add, del)] : t("agents.noChanges")]),
      ],
    );
  }

  function tasksSummary(state) {
    const order = { review: 0, in_progress: 1, todo: 2, failed: 3, done: 4 };
    const list = [...state.tasks].filter((x) => x.status !== "done").sort((a, b) => order[a.status] - order[b.status]).slice(0, 7);
    const sec = h("section", { class: "col grow2", "aria-labelledby": "h-tasks" }, [
      h("h2", { id: "h-tasks", class: "row" }, [t("tasks"), h("span", { class: "spacer" }), h("button", { class: "link", onclick: () => go("tasks") }, [t("tasks.all")])]),
    ]);
    if (!list.length) {
      sec.append(h("div", { class: "card card-pad small fg2" }, [t("tasks.intro")]));
      return sec;
    }
    sec.append(
      h(
        "div",
        { class: "card rows" },
        list.map((x) =>
          h("div", { class: "row trow" }, [
            taskPill(x),
            h("span", { class: "ell grow" }, [x.title]),
            h("span", { class: "row tiny fg2" }, [x.agentId ? [dot(colorOf(state, x.agentId), "sm"), nameOf(state, x.agentId)] : t("tasks.unassigned")]),
          ]),
        ),
      ),
    );
    return sec;
  }

  function taskPill(x) {
    const cls = x.status === "review" ? "review" : x.status === "failed" ? "error" : x.status === "todo" ? "todo" : x.status === "done" ? "" : "";
    const label = x.blocked && x.status === "todo" ? t("ts.blocked") : t(`ts.${x.status}`);
    return h("span", { class: `pill ${cls}` }, [label]);
  }

  function teamSummary(state) {
    const team = state.team;
    if (!team || !team.enabled) return null;
    const sec = h("section", { class: "col", "aria-labelledby": "h-team" }, [
      h("h2", { id: "h-team", class: "row" }, [t("team"), h("span", { class: "spacer" }), h("button", { class: "link", onclick: () => post("teamSync") }, [t("team.sync")])]),
    ]);
    const card = h("div", { class: "card card-pad col" }, [
      h("div", { class: "tiny muted" }, [
        t("team.youAre", team.person) + (team.role === "viewer" ? ` (${t("team.viewer")})` : "") + " · " + (team.lastSync ? t("team.synced", ago(team.lastSync)) : t("team.notSynced")),
      ]),
    ]);
    if (team.error) card.append(h("div", { class: "tiny error-text" }, [team.error]));
    if (!team.peers.length) card.append(h("div", { class: "small muted" }, [t("team.noPeers")]));
    for (const p of team.peers) {
      card.append(h("div", { class: "row small" }, [h("span", { class: "avatar", "aria-hidden": "true" }, [p.person.slice(0, 1).toUpperCase()]), h("strong", {}, [p.person]), p.stale ? h("span", { class: "tiny muted" }, [t("team.stale")]) : null]));
      for (const a of p.agents) {
        card.append(
          h("div", { class: "row small indent2" }, [
            dot(a.color, "sm"),
            h("span", { class: "ell grow fg2" }, [`${a.name.replace(/ \([^)]*\)$/, "")}${a.task ? ` · ${a.task}` : ""}`]),
            a.claimedBy ? h("span", { class: "tiny muted" }, [t("team.continuedBy", a.claimedBy)]) : null,
            team.role === "editor" && a.files.length && !a.claimedBy ? h("button", { class: "link", onclick: () => cmd("synapse.teamAdopt", a.id) }, [t("team.continue")]) : null,
          ]),
        );
      }
    }
    sec.append(card);
    return sec;
  }

  function checklist(state) {
    if (msg.checklistDismissed) return null;
    const merged = (state.reviews || []).some((r) => r.status === "merged");
    const items = [
      [t("start.repo"), true, null],
      [t("start.agent"), state.agents.length > 0, () => cmd("synapse.addAgent")],
      [t("start.task"), state.tasks.length > 0, () => go("tasks")],
      [t("start.review"), merged, () => cmd("synapse.prepareReview")],
      [t("start.team"), !!(state.team && state.team.enabled), () => cmd("synapse.enableTeam")],
    ];
    const done = items.filter((i) => i[1]).length;
    if (done === items.length) return null;
    return h("section", { class: "col", "aria-labelledby": "h-start" }, [
      h("h2", { id: "h-start", class: "row" }, [t("start"), h("span", { class: "spacer" }), h("span", { class: "mono tiny muted" }, [`${done}/${items.length}`]), h("button", { class: "link", onclick: () => post("dismissChecklist") }, [t("start.hide")])]),
      h(
        "div",
        { class: "card rows" },
        items.map(([label, ok, act]) =>
          h("div", { class: `row trow${ok ? " muted" : ""}` }, [
            ok ? h("span", { class: "add" }, [icon("check", 14, t("plan.done"))]) : icon("circle", 14),
            h("span", { class: "grow" }, [label]),
            !ok && act ? h("button", { class: "link", onclick: act }, [t("start.do")]) : null,
          ]),
        ),
      ),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Tasks

  function renderTasks(page, state) {
    const title = /** @type {HTMLInputElement} */ (h("input", { placeholder: t("task.titlePh"), "aria-label": t("task.title") }));
    const desc = /** @type {HTMLTextAreaElement} */ (h("textarea", { rows: 2, placeholder: t("task.descPh"), "aria-label": t("task.desc") }));
    const agent = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": t("agent") }, [h("option", { value: "" }, [t("tasks.unassigned")]), ...state.agents.map((a) => h("option", { value: a.id }, [a.name]))]));
    const deps = /** @type {HTMLSelectElement} */ (h("select", { multiple: true, size: Math.min(4, Math.max(2, state.tasks.length)), "aria-label": t("task.dependsOn") }, state.tasks.map((x) => h("option", { value: x.id }, [`${x.id} ${x.title}`]))));
    const scope = /** @type {HTMLInputElement} */ (h("input", { placeholder: t("task.scopePh"), "aria-label": t("task.scope") }));
    const auto = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", id: "auto" }));
    page.append(
      h("details", { class: "card card-pad form", open: state.tasks.length === 0 || undefined }, [
        h("summary", { class: "strong" }, [t("task.new")]),
        h("div", { class: "col" }, [
          title,
          desc,
          h("div", { class: "row wrap" }, [h("span", { class: "small muted" }, [t("agent")]), h("div", { style: { width: "180px" } }, [agent]), h("label", { class: "row small", for: "auto" }, [auto, t("task.autoStart")])]),
          state.tasks.length ? h("div", { class: "col tight" }, [h("span", { class: "small muted" }, [t("task.dependsOnHint")]), deps]) : null,
          scope,
          h("div", {}, [
            button(
              t("task.create"),
              () => {
                if (!title.value.trim()) return title.focus();
                post("createTask", { title: title.value, description: desc.value, agentId: agent.value || undefined, dependsOn: [...deps.selectedOptions].map((o) => o.value), scope: scope.value.split(",").map((x) => x.trim()).filter(Boolean), autoStart: auto.checked });
                title.value = "";
                desc.value = "";
              },
              "primary",
            ),
          ]),
        ]),
      ]),
    );
    if (!state.tasks.length) {
      page.append(h("p", { class: "muted small" }, [t("tasks.intro")]));
      return;
    }
    const order = { review: 0, in_progress: 1, todo: 2, failed: 3, done: 4 };
    const list = h("div", { class: "col" }, []);
    for (const x of [...state.tasks].sort((a, b) => order[a.status] - order[b.status] || a.id.localeCompare(b.id, undefined, { numeric: true }))) {
      const actions = [];
      if ((x.status === "todo" || x.status === "failed" || x.status === "review") && !x.blocked && x.agentId) actions.push(button(x.status === "todo" ? t("task.start") : t("task.runAgain"), () => post("taskAction", { id: x.id, action: "start" }), x.status === "todo" ? "primary sm" : "sm"));
      if (x.status === "review") actions.push(button(t("task.done"), () => post("taskAction", { id: x.id, action: "done" }), "primary sm"), button(t("task.failed"), () => post("taskAction", { id: x.id, action: "failed" }), "sm"));
      if (x.status === "in_progress") actions.push(button(t("task.markFailed"), () => post("taskAction", { id: x.id, action: "failed" }), "sm"));
      if (x.status === "done" || x.status === "failed") actions.push(button(t("task.reopen"), () => post("taskAction", { id: x.id, action: "todo" }), "sm"));
      if (x.status !== "in_progress") actions.push(button(t("task.remove"), () => post("taskAction", { id: x.id, action: "remove" }), "ghost sm"));
      list.append(
        h("div", { class: "card card-pad col tight" }, [
          h("div", { class: "row" }, [taskPill(x), h("span", { class: "strong ell grow" }, [`${x.id} · ${x.title}`]), x.autoStart ? h("span", { class: "tag", title: t("task.autoHint") }, [t("task.auto")]) : null]),
          h("div", { class: "row tiny fg2 wrap" }, [
            x.agentId ? [dot(colorOf(state, x.agentId), "sm"), nameOf(state, x.agentId)] : t("tasks.unassigned"),
            x.dependsOn.length ? ` · ${t("task.after", x.dependsOn.join(", "))}` : "",
            x.scope.length ? ` · ${t("task.scopeIs", x.scope.join(", "))}` : "",
          ]),
          x.description ? h("div", { class: "small pre fg2" }, [x.description]) : null,
          x.outOfScope && x.outOfScope.length ? h("div", { class: "small error-text" }, [t("task.outOfScope", x.outOfScope.join(", "))]) : null,
          x.summary ? h("details", {}, [h("summary", { class: "small" }, [t("task.summary")]), h("div", { class: "small pre" }, [x.summary])]) : null,
          actions.length ? h("div", { class: "row wrap" }, actions) : null,
        ]),
      );
    }
    page.append(list);
  }

  // ---------------------------------------------------------------------------
  // Decisions

  function renderDecisions(page, state) {
    const title = /** @type {HTMLInputElement} */ (h("input", { placeholder: t("dec.titlePh"), "aria-label": t("dec.title") }));
    const decision = /** @type {HTMLTextAreaElement} */ (h("textarea", { rows: 2, placeholder: t("dec.textPh"), "aria-label": t("dec.text") }));
    const rationale = /** @type {HTMLInputElement} */ (h("input", { placeholder: t("dec.whyPh"), "aria-label": t("dec.why") }));
    const pins = /** @type {HTMLInputElement} */ (h("input", { placeholder: t("dec.pinsPh"), "aria-label": t("dec.pins") }));
    page.append(
      h("details", { class: "card card-pad form", open: state.decisions.length === 0 || undefined }, [
        h("summary", { class: "strong" }, [t("dec.new")]),
        h("div", { class: "col" }, [
          title,
          decision,
          rationale,
          pins,
          h("p", { class: "tiny muted" }, [t("dec.pinHint")]),
          h("div", {}, [button(t("dec.add"), () => title.value.trim() && decision.value.trim() && post("addDecision", { title: title.value, decision: decision.value, rationale: rationale.value, pins: pins.value }), "primary")]),
        ]),
      ]),
    );
    if (!state.decisions.length) page.append(h("p", { class: "muted small" }, [t("dec.intro")]));
    const order = { proposed: 0, accepted: 1, superseded: 2, rejected: 3 };
    for (const d of [...state.decisions].sort((a, b) => order[a.status] - order[b.status] || a.id.localeCompare(b.id, undefined, { numeric: true }))) {
      const anchors = d.anchors || [];
      const stale = anchors.filter((x) => x.state !== "current");
      page.append(
        h("div", { class: "card card-pad col tight" }, [
          h("div", { class: "row" }, [h("span", { class: `pill ${d.status === "proposed" ? "needs" : d.status === "accepted" ? "" : "todo"}` }, [t(`dec.${d.status}`)]), h("span", { class: "strong grow" }, [`${d.id} · ${d.title}`])]),
          h("div", {}, [d.decision]),
          d.rationale ? h("div", { class: "small fg2" }, [t("dec.whyIs", d.rationale)]) : null,
          ...anchors.map((x) =>
            h("div", { class: "row small" }, [
              icon("pin", 13),
              h("button", { class: "link mono", onclick: () => post("openFile", { path: x.path }) }, [x.symbol ? `${x.path} › ${x.symbol}` : x.path]),
              x.state === "changed" ? h("span", { class: "pill needs" }, [t("dec.changed")]) : x.state === "missing" ? h("span", { class: "pill needs" }, [t("dec.missing")]) : null,
              h("button", { class: "link", onclick: () => post("decisionUnpin", { id: d.id, path: x.path, symbol: x.symbol }) }, [t("dec.unpin")]),
            ]),
          ),
          stale.length && d.status === "accepted"
            ? h("div", { class: "row wrap small" }, [t("dec.staleAsk"), button(t("needs.stillHolds"), () => post("decisionRepin", { id: d.id }), "primary sm"), button(t("dec.supersede"), () => post("decisionAction", { id: d.id, status: "superseded" }), "sm")])
            : null,
          h("div", { class: "tiny muted" }, [t("dec.by", nameOf(state, d.author)), d.supersedes ? ` · ${t("dec.supersedes", d.supersedes)}` : ""]),
          d.status === "proposed" ? h("div", { class: "row" }, [button(t("needs.accept"), () => post("decisionAction", { id: d.id, status: "accepted" }), "primary sm"), button(t("needs.reject"), () => post("decisionAction", { id: d.id, status: "rejected" }), "sm")]) : null,
        ]),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Messages

  function renderMessages(page, state) {
    const to = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": t("msg.to") }, [h("option", { value: "all" }, [t("allAgents")]), ...state.agents.map((a) => h("option", { value: a.id }, [a.name]))]));
    const subject = /** @type {HTMLInputElement} */ (h("input", { placeholder: t("msg.subjectPh"), "aria-label": t("msg.subject") }));
    const body = /** @type {HTMLTextAreaElement} */ (h("textarea", { rows: 2, placeholder: t("msg.bodyPh"), "aria-label": t("msg.body") }));
    page.append(
      h("details", { class: "card card-pad form" }, [
        h("summary", { class: "strong" }, [t("msg.new")]),
        h("div", { class: "col" }, [h("div", { style: { width: "220px" } }, [to]), subject, body, h("div", {}, [button(t("detail.send"), () => subject.value.trim() && post("sendMessage", { to: to.value, kind: "note", subject: subject.value, body: body.value }), "primary")])]),
      ]),
    );
    const list = [...state.messages].sort((a, b) => (a.status === "held" ? -1 : 0) - (b.status === "held" ? -1 : 0) || b.createdAt.localeCompare(a.createdAt));
    if (!list.length) page.append(h("p", { class: "muted small" }, [t("msg.intro")]));
    for (const m of list.slice(0, 100)) {
      page.append(
        h("div", { class: "card card-pad col tight" }, [
          h("div", { class: "row" }, [h("span", { class: "pill" }, [t(`msg.kind.${m.kind}`)]), dot(colorOf(state, m.from), "sm"), h("span", { class: "strong" }, [`${nameOf(state, m.from)} → ${nameOf(state, m.to)}`]), h("span", { class: "spacer" }), h("span", { class: `tiny ${m.status === "held" ? "st-needs" : "muted"}` }, [t(`msg.${m.status}`)])]),
          h("div", {}, [m.subject]),
          m.body ? h("div", { class: "small pre fg2" }, [m.body]) : null,
          m.files.length ? h("div", { class: "tiny muted mono" }, [m.files.join(", ")]) : null,
          m.flags.length ? h("div", { class: "small error-text" }, [t("msg.heldWhy", m.flags.join(", "))]) : null,
          m.status === "held" ? h("div", { class: "row" }, [button(t("needs.release"), () => post("messageAction", { id: m.id, action: "release" }), "sm"), button(t("needs.reject"), () => post("messageAction", { id: m.id, action: "reject" }), "primary sm")]) : null,
        ]),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Audit

  function renderAudit(page, state) {
    page.append(
      h("div", { class: "row wrap" }, [
        h("span", { class: "small fg2 grow" }, [t("audit.intro")]),
        ...state.agents.map((a) => h("button", { class: "link", onclick: () => post("editPolicy", { agentId: a.id }) }, [t("audit.policy", a.name)])),
      ]),
    );
    if (!state.audit.length) {
      page.append(h("p", { class: "muted small" }, [t("audit.none")]));
      return;
    }
    page.append(
      h(
        "div",
        { class: "card rows" },
        [...state.audit]
          .reverse()
          .slice(0, 150)
          .map((e) =>
            h("div", { class: "row trow small" }, [
              dot(colorOf(state, e.agentId), "sm"),
              h("span", { class: "mono tiny muted" }, [e.at.slice(11, 19)]),
              h("span", { class: `pill ${e.outcome === "denied" ? "error" : e.outcome === "ran-unasked" ? "needs" : ""}` }, [t(`audit.${e.outcome}`)]),
              h("span", { class: "tiny muted" }, [t("audit.by", e.by)]),
              h("code", { class: "ell grow" }, [e.command || e.path || e.title]),
              e.risky ? h("span", { class: "pill error" }, [t("audit.risky")]) : null,
            ]),
          ),
      ),
    );
  }

  const update = guardedRender(root, render);
  window.addEventListener("message", (e) => {
    if (e.data?.type === "state") {
      msg = e.data;
      update();
    }
  });
  setInterval(() => update(), 30000);
  vscode.postMessage({ type: "ready" });
})();
