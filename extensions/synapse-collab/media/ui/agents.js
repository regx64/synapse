// @ts-check
// Left column: the agents, each with its status, task and plan progress, and
// teammates' agents below. Narrow widths turn it into a column of dots.
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const { t, h, icon, segmented, dot, statusOf, statusEl, taskOf, planOf, progress, ago, guardedRender } = /** @type {any} */ (window).SynapseUI;
  const root = /** @type {HTMLElement} */ (document.getElementById("root"));
  /** @type {any} */
  let msg = { state: null, connected: false };
  const post = (m) => vscode.postMessage(m);
  const cmd = (command, ...args) => post({ type: "command", command, args });

  const narrow = () => document.body.clientWidth < 140;

  function render() {
    root.replaceChildren();
    root.className = narrow() ? "agents rail" : "agents";
    const { state, connected, selected } = msg;
    if (!connected || !state) {
      root.append(
        h("div", { class: "empty" }, [
          h("p", {}, [t("core.notRunning")]),
          h("button", { class: "btn primary", onclick: () => cmd("synapse.startCore") }, [t("core.start")]),
        ]),
      );
      return;
    }
    if (narrow()) return renderRail(state, selected);

    root.append(
      h("div", { class: "pad" }, [
        segmented(
          [
            { id: "agents", label: [t("agents"), " ", h("span", { class: "muted" }, [String(state.agents.length)])] },
            { id: "files", label: t("files") },
          ],
          "agents",
          (id) => id === "files" && cmd("synapse.showFiles"),
          t("left.label"),
          "full",
        ),
      ]),
    );

    const list = h("div", { class: "list", role: "list" }, []);
    if (!state.agents.length) {
      list.append(h("p", { class: "muted small pad" }, [t("agents.none")]));
    }
    const mod = navigator.platform.startsWith("Mac") ? "⌘⌥" : "Ctrl+Alt+";
    for (const [i, a] of state.agents.entries()) {
      const st = statusOf(a, state);
      const { title } = taskOf(a, state);
      const plan = planOf(a);
      list.append(
        h("div", { role: "listitem" }, [
          h(
            "button",
            {
              class: "arow",
              "aria-current": String(a.id === selected),
              title: i < 9 ? `${a.name} (${mod}${i + 1})` : a.name,
              onclick: () => post({ type: "select", id: a.id, show: "detail" }),
              ondblclick: () => post({ type: "select", id: a.id, show: "diff" }),
              oncontextmenu: (e) => (e.preventDefault(), cmd("synapse.agentMenu", a.id)),
            },
            [
              h("span", { class: "row" }, [dot(a.color), h("span", { class: "name" }, [a.name]), h("span", { class: "tiny muted ell" }, [a.agentInfo?.name || a.preset || ""]), h("span", { class: "spacer" }), statusEl(st)]),
              h("span", { class: "task ell small fg2" }, [title || t("agents.noTask")]),
              plan.total ? h("span", { class: "row indent" }, [progress(plan.done, plan.total, a.color)]) : null,
            ],
          ),
        ]),
      );
    }
    root.append(
      list,
      h("div", { class: "pad-x" }, [
        h("button", { class: "btn ghost new", onclick: () => cmd("synapse.addAgent") }, [icon("plus", 14), t("agents.new")]),
      ]),
    );
    renderTeam(state);
  }

  function renderRail(state, selected) {
    root.append(
      h("button", { class: "icon-btn", "aria-label": t("agents.new"), title: t("agents.new"), onclick: () => cmd("synapse.addAgent") }, [icon("plus")]),
      ...state.agents.map((a) => {
        const st = statusOf(a, state);
        return h(
          "button",
          { class: "icon-btn dotbtn", "aria-current": String(a.id === selected), "aria-label": `${a.name}, ${t(`status.${st}`)}`, title: `${a.name} · ${t(`status.${st}`)}`, onclick: () => post({ type: "select", id: a.id, show: "detail" }) },
          [dot(a.color, "lg"), h("span", { class: `badge st-${st}${st === "working" ? " pulse" : ""}` })],
        );
      }),
    );
  }

  function renderTeam(state) {
    const team = state.team;
    if (!team || !team.enabled) return;
    const box = h("section", { class: "team", "aria-label": t("team") }, [
      h("div", { class: "row small" }, [
        h("strong", {}, [t("team")]),
        h("span", { class: "spacer" }),
        h("span", { class: "muted tiny" }, [team.lastSync ? t("team.synced", ago(team.lastSync)) : t("team.notSynced")]),
        h("button", { class: "icon-btn", "aria-label": t("team.sync"), title: t("team.sync"), onclick: () => post({ type: "teamSync" }) }, [icon("sync", 14)]),
      ]),
    ]);
    if (team.error) box.append(h("div", { class: "tiny error-text" }, [team.error]));
    if (!team.peers.length) box.append(h("div", { class: "tiny muted" }, [t("team.noPeers")]));
    for (const p of team.peers) {
      box.append(
        h("div", { class: "peer" }, [
          h("div", { class: "row small" }, [h("span", { class: "avatar", "aria-hidden": "true" }, [p.person.slice(0, 1).toUpperCase()]), h("span", {}, [p.person]), p.stale ? h("span", { class: "tiny muted" }, [t("team.stale")]) : null]),
          ...p.agents.map((a) =>
            h("div", { class: "row tiny fg2 indent" }, [dot(a.color, "sm"), h("span", { class: "ell" }, [`${a.name.replace(/ \([^)]*\)$/, "")}${a.task ? ` · ${a.task}` : ""}`]), a.claimedBy ? h("span", { class: "muted" }, [t("team.continuedBy", a.claimedBy)]) : null]),
          ),
        ]),
      );
    }
    root.append(box);
  }

  const update = guardedRender(root, render);
  window.addEventListener("message", (e) => {
    if (e.data?.type === "state") {
      msg = e.data;
      update();
    }
  });
  new ResizeObserver(() => update(true)).observe(document.body);
  setInterval(() => update(), 30000); // "synced 3 min ago" stays true
  post({ type: "ready" });
})();
