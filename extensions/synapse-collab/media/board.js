// @ts-check
// Collaboration board webview. Renders state pushed by the extension; every
// action is posted back and executed against synapse-core.
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const root = /** @type {HTMLElement} */ (document.getElementById("root"));
  const drafts = /** @type {Record<string, string>} */ ((vscode.getState() || {}).drafts || {});

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

  function agentCard(a, state) {
    const own = state.ownership[a.id];
    const files = own ? own.files : [];
    const running = a.status !== "stopped" && a.status !== "error";
    const busy = a.status === "working" || a.status === "awaiting-approval";
    const textarea = /** @type {HTMLTextAreaElement} */ (
      h("textarea", { rows: 2, placeholder: running ? `Tell ${a.name} what to do…` : "Start the agent to send a prompt", disabled: !running || busy })
    );
    textarea.value = drafts[a.id] || "";
    textarea.addEventListener("input", () => {
      drafts[a.id] = textarea.value;
      vscode.setState({ drafts });
    });
    const send = () => {
      if (!textarea.value.trim()) return;
      vscode.postMessage({ type: "prompt", id: a.id, text: textarea.value });
      drafts[a.id] = "";
      vscode.setState({ drafts });
      textarea.value = "";
    };
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
    });

    return h("div", { class: "card agent", style: { borderLeftColor: a.color } }, [
      h("div", { class: "row" }, [
        h("span", { class: "dot", style: { background: a.color } }),
        h("strong", {}, [a.name]),
        h("span", { class: `status st-${a.status}` }, [a.status]),
        h("span", { class: "spacer" }),
        running ? button("Stop", () => cmd("synapse.stopAgent", a.id)) : button("Start", () => cmd("synapse.startAgent", a.id), "primary"),
        busy ? button("Cancel", () => cmd("synapse.cancelAgent", a.id)) : null,
        button("⋯", () => cmd("synapse.agentMenu", a.id), "icon"),
      ]),
      h("div", { class: "muted small" }, [`${a.worktree.branch}${a.agentInfo && a.agentInfo.name ? ` · ${a.agentInfo.name} ${a.agentInfo.version || ""}` : ""}`]),
      a.error ? h("div", { class: "error" }, [a.error]) : null,
      a.turn ? h("div", { class: "turn" }, [h("span", { class: "muted" }, ["› "]), a.turn.prompt.slice(0, 240)]) : null,
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
            h("summary", {}, [`Owns ${files.length} file${files.length === 1 ? "" : "s"}`]),
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
      h("div", { class: "prompt" }, [textarea, button("Send", send, "primary")]),
      button("Show output", () => cmd("synapse.showOutput", a.id), "link"),
    ]);
  }

  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "state") render(e.data.state, e.data.connected);
  });
  vscode.postMessage({ type: "ready" });
})();
