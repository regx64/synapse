// @ts-check
// Synapse UI kit for webviews: DOM helpers, icons, strings (English and
// Korean), and how agent state reads to a person. Loaded before each view's
// own script; exposes window.SynapseUI.
(function () {
  /** @type {Record<string, Record<string, string>>} */
  // eslint-disable-next-line no-undef
  const STRINGS = /** @type {any} */ (window).SYNAPSE_STRINGS || { en: {} };
  const lang = (document.documentElement.lang || "en").toLowerCase().startsWith("ko") ? "ko" : "en";

  /**
   * A string in the person's language. `{0}`, `{1}`… are replaced by `args`.
   * Missing Korean strings fall back to English, missing keys to the key.
   * @param {string} key @param {...(string|number)} args
   */
  function t(key, ...args) {
    const s = (STRINGS[lang] && STRINGS[lang][key]) ?? (STRINGS.en && STRINGS.en[key]) ?? key;
    return s.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ""));
  }

  /** @param {string} tag @param {Record<string, any>} [attrs] @param {any[]} [children] @returns {HTMLElement} */
  function h(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "class") el.className = String(v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    append(el, children);
    return el;
  }
  /** @param {Node} el @param {any} children */
  function append(el, children) {
    for (const c of [].concat(children ?? [])) {
      if (c === null || c === undefined || c === false || c === "") continue;
      if (Array.isArray(c)) append(el, c);
      else el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
  }

  // Stroke icons (24×24), drawn to match codicons' weight at 16px.
  /** @type {Record<string, string>} */
  const ICONS = {
    plus: "M12 5v14M5 12h14",
    home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z",
    terminal: "m4 17 6-5-6-5M12 19h8",
    alert: "M12 3 2 20h20ZM12 10v4M12 17h.01",
    check: "m5 12.5 4.5 4.5L19 7.5",
    checkCircle: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-4 9.5 2.5 2.5L16 9.5",
    circle: "M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z",
    chevron: "m9 6 6 6-6 6",
    chevronDown: "m6 9 6 6 6-6",
    handoff: "M4 8h13l-3-3M20 16H7l3 3",
    panel: "M3 4h18v16H3ZM15 4v16",
    close: "M6 6l12 12M18 6 6 18",
    file: "M6 3h8l4 4v14H6ZM14 3v4h4",
    files: "M8 3h7l4 4v11H8ZM15 3v4h4M5 7v14h10",
    search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-3.5-3.5",
    comment: "M4 5h16v11H9l-5 4Z",
    diff: "M12 4v8M8 8h8M8 18h8M6 2h12v20H6Z",
    merge: "M6 3v12M18 9v12M6 15a6 6 0 0 0 6-6h6",
    message: "M4 4h16v12H5l-1 4Z",
    pin: "M9 4h6l-1 6 4 3H6l4-3ZM12 13v7",
    shield: "M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6Z",
    users: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20c0-3 3-5 6-5s6 2 6 5M16 5a3 3 0 0 1 0 6M18 15c2 .5 3 2 3 5",
    play: "M7 5v14l12-7Z",
    stop: "M6 6h12v12H6Z",
    refresh: "M20 11a8 8 0 1 0-2 6M20 5v6h-6",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    list: "M4 6h16M4 12h16M4 18h16",
    task: "M9 11l3 3 8-8M20 12v7H4V5h11",
    decision: "M12 3v18M5 7h14l-2 5H7Z",
    settings: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4",
    sync: "M4 12a8 8 0 0 1 14-5M20 12a8 8 0 0 1-14 5M18 3v4h-4M6 21v-4h4",
  };
  /** @param {string} name @param {number} [size] @param {string} [label] */
  function icon(name, size = 16, label) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", name === "stop" || name === "play" ? "currentColor" : "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    if (label) {
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", label);
    } else svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", ICONS[name] || ICONS.circle);
    svg.appendChild(path);
    return svg;
  }

  /** A button with an icon and a screen-reader label. */
  function iconButton(name, label, onclick, attrs = {}) {
    return h("button", { class: "icon-btn", "aria-label": label, title: label, onclick, ...attrs }, [icon(name)]);
  }
  /** @param {string} label @param {(e: Event) => void} onclick @param {string} [cls] @param {Record<string, any>} [attrs] */
  function button(label, onclick, cls = "", attrs = {}) {
    return h("button", { class: `btn ${cls}`.trim(), onclick, ...attrs }, [label]);
  }
  /** A segmented control. @param {{ id: string, label: any }[]} options @param {string} current @param {(id: string) => void} onpick @param {string} label */
  function segmented(options, current, onpick, label, cls = "") {
    return h(
      "div",
      { class: `seg ${cls}`.trim(), role: "group", "aria-label": label },
      options.map((o) => h("button", { "aria-pressed": String(o.id === current), onclick: () => onpick(o.id) }, [o.label])),
    );
  }
  const dot = (color, cls = "") => h("span", { class: `dot ${cls}`.trim(), style: { background: color }, "aria-hidden": "true" });

  /**
   * How an agent reads to the person: working, needs you (waiting for an
   * approval), ready for review (its task is in review), error, idle.
   */
  function statusOf(agent, state) {
    if (agent.status === "awaiting-approval") return "needs";
    if (agent.status === "working" || agent.status === "starting") return "working";
    if (agent.status === "error") return "error";
    const task = (state?.tasks || []).find((x) => x.agentId === agent.id && x.status === "review");
    if (task) return "review";
    return agent.status === "stopped" ? "stopped" : "idle";
  }
  /** @param {string} st */
  const statusLabel = (st) => t(`status.${st}`);
  function statusEl(st) {
    return h("span", { class: `status st-${st}` }, [h("span", { class: `dot${st === "working" ? " pulse" : ""}`, "aria-hidden": "true" }), statusLabel(st)]);
  }

  /** The agent's current task, else the first line of its prompt. */
  function taskOf(agent, state) {
    const task = agent.currentTaskId ? (state?.tasks || []).find((x) => x.id === agent.currentTaskId) : (state?.tasks || []).find((x) => x.agentId === agent.id && x.status === "review");
    if (task) return { title: task.title, task };
    if (agent.turn && agent.turn.prompt) return { title: agent.turn.prompt.split("\n")[0].slice(0, 120) };
    return { title: "" };
  }
  function planOf(agent) {
    const plan = agent.plan || [];
    return { done: plan.filter((p) => p.status === "completed").length, total: plan.length };
  }
  function progress(done, total, color) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return h("span", { class: "row", style: { gap: "7px", flex: "1" } }, [
      h("span", { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total), "aria-valuenow": String(done), "aria-label": t("plan") }, [h("span", { style: { width: `${pct}%`, background: color } })]),
      h("span", { class: "mono tiny muted" }, [`${done}/${total}`]),
    ]);
  }
  function filesOf(agent, state) {
    const own = state?.ownership?.[agent.id];
    const files = own ? own.files : [];
    let add = 0;
    let del = 0;
    for (const f of files) {
      add += f.linesAdded || 0;
      del += f.linesRemoved || 0;
    }
    return { files, add, del };
  }
  /** "1 file", "3 files". */
  const fileCount = (n) => (n === 1 ? t("files.one") : t("files.count", n));
  /** What an approval is about, readable: the command it would run, else its details. */
  function approvalText(ap) {
    const d = ap && ap.detail;
    if (!d) return "";
    if (typeof d === "string") return d;
    if (typeof d.command === "string") return d.command + (Array.isArray(d.args) && d.args.length ? " " + d.args.join(" ") : "");
    if (typeof d.path === "string") return d.path;
    return JSON.stringify(d, null, 2).slice(0, 1200);
  }
  /** "+12 −3" */
  const diffstat = (add, del) => h("span", { class: "mono tiny" }, [h("span", { class: "add" }, [`+${add}`]), " ", h("span", { class: "del" }, [`−${del}`])]);

  /** "12 s ago", "3 min ago", "2 h ago" in the person's language. */
  function ago(iso) {
    if (!iso) return "";
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 10) return t("time.now");
    if (s < 60) return t("time.s", s);
    if (s < 3600) return t("time.min", Math.round(s / 60));
    if (s < 86400) return t("time.h", Math.round(s / 3600));
    return t("time.d", Math.round(s / 86400));
  }

  /** Re-render unless the person is typing; then wait until they leave the field. */
  function guardedRender(root, render) {
    let pending = false;
    const typing = () => {
      const a = document.activeElement;
      return !!a && root.contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT");
    };
    document.addEventListener("focusout", () =>
      setTimeout(() => {
        if (pending && !typing()) {
          pending = false;
          render();
        }
      }, 0),
    );
    return (force = false) => {
      if (!force && typing()) {
        pending = true;
        return;
      }
      pending = false;
      render();
    };
  }

  /** Keeps a textarea's draft across re-renders and webview reloads. */
  function draftArea(vscode, key, attrs = {}) {
    const st = vscode.getState() || {};
    const drafts = st.drafts || {};
    const ta = /** @type {HTMLTextAreaElement} */ (h("textarea", attrs));
    ta.value = drafts[key] || "";
    ta.addEventListener("input", () => {
      const s = vscode.getState() || {};
      vscode.setState({ ...s, drafts: { ...(s.drafts || {}), [key]: ta.value } });
    });
    const clear = () => {
      ta.value = "";
      const s = vscode.getState() || {};
      const d = { ...(s.drafts || {}) };
      delete d[key];
      vscode.setState({ ...s, drafts: d });
    };
    return { el: ta, clear };
  }

  /** @type {any} */ (window).SynapseUI = { t, lang, h, append, icon, iconButton, button, segmented, dot, statusOf, statusLabel, statusEl, taskOf, planOf, progress, filesOf, fileCount, approvalText, diffstat, ago, guardedRender, draftArea };
})();
