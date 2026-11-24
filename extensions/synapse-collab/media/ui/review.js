// @ts-check
// Review & merge: every agent's work merged in a scratch worktree, with the
// files, conflicts and test run on the combined result; then merge.
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const { t, h, icon, dot, diffstat, conflictText } = /** @type {any} */ (window).SynapseUI;
  const root = /** @type {HTMLElement} */ (document.getElementById("root"));
  const post = (m) => vscode.postMessage(m);

  /** @param {any} r @param {any[]} agents */
  function render(r, agents) {
    root.replaceChildren();
    root.className = "review-page";
    const agent = (id) => agents.find((a) => a.id === id) || { id, name: id, color: "var(--sy-idle)" };
    const chip = (id) => h("span", { class: "row tiny fg2", style: { gap: "5px" } }, [dot(agent(id).color, "sm"), agent(id).name]);
    const blocking = r.conflicts.filter((c) => c.severity === "error");
    const testsOk = !r.tests || r.tests.passed;
    const canMerge = r.status === "ready";
    const clean = canMerge && testsOk && blocking.length === 0;
    const page = h("div", { class: "page col" }, []);

    page.append(
      h("div", { class: "row wrap" }, [
        h("h1", {}, [t("rev.title")]),
        h("span", { class: `pill ${r.status === "merged" ? "review" : r.status === "ready" ? "" : r.status === "preparing" ? "" : "error"}` }, [t(`rev.status.${r.status}`)]),
        h("span", { class: "spacer" }),
        h("span", { class: "mono tiny muted" }, [`${r.baseRef} @ ${r.baseCommit.slice(0, 8)}`]),
      ]),
      h("div", { class: "row wrap" }, [h("span", { class: "small muted" }, [t("rev.agents")]), ...r.agents.map(chip)]),
    );
    if (r.error) page.append(h("p", { class: "small error-text" }, [r.error]));
    if (r.mergeConflicts.length) page.append(h("p", { class: "small error-text" }, [t("rev.textConflicts", r.mergeConflicts.join(", "))]));

    // What blocks the merge, then the buttons.
    if (canMerge && !clean) {
      const why = [testsOk ? "" : t("rev.whyTests"), blocking.length ? t("rev.whyConflicts", blocking.length) : ""].filter(Boolean).join(" · ");
      page.append(h("div", { class: "card card-pad row blocked" }, [h("span", { class: "tile error", "aria-hidden": "true" }, [icon("alert")]), h("div", { class: "grow small" }, [h("div", { class: "strong" }, [t("rev.blocked")]), why])]));
    }
    page.append(
      h("div", { class: "row wrap" }, [
        canMerge ? h("button", { class: "btn primary", disabled: !clean || undefined, title: clean ? "" : t("rev.blocked"), onclick: () => post({ type: "merge" }) }, [icon("merge", 14), t("rev.merge", r.baseRef)]) : null,
        canMerge && !clean ? h("button", { class: "btn", onclick: () => post({ type: "merge", force: true }) }, [t("rev.mergeAnyway")]) : null,
        r.status !== "merged" ? h("button", { class: "btn", onclick: () => post({ type: "again" }) }, [icon("refresh", 14), t("rev.again")]) : null,
        r.status !== "merged" ? h("button", { class: "btn ghost", onclick: () => post({ type: "discard" }) }, [t("rev.discard")]) : null,
      ]),
    );

    // Conflicts between agents.
    page.append(h("h2", {}, [t("rev.conflicts")]));
    if (!r.conflicts.length) page.append(h("p", { class: "small muted" }, [t("rev.noConflicts")]));
    else
      page.append(
        h(
          "div",
          { class: "card rows" },
          r.conflicts.map((c) => h("div", { class: "row trow small" }, [h("span", { class: `pill ${c.severity === "error" ? "error" : c.severity === "warning" ? "needs" : ""}` }, [t(`conflict.${c.kind}`) === `conflict.${c.kind}` ? c.kind : t(`conflict.${c.kind}`)]), h("span", { class: "grow" }, [conflictText(c, (id) => agent(id).name)])])),
        ),
      );

    // Files.
    page.append(h("h2", {}, [t("rev.files", r.files.length)]));
    if (!r.files.length) page.append(h("p", { class: "small muted" }, [t("rev.noFiles")]));
    else
      page.append(
        h(
          "div",
          { class: "card rows" },
          r.files.map((f) =>
            h("button", { class: "row trow file", onclick: () => post({ type: "diff", path: f.path }), title: t("rev.openDiff") }, [
              h("span", { class: "filest" }, [f.status === "added" ? "A" : f.status === "deleted" ? "D" : "M"]),
              h("span", { class: "mono small ell grow" }, [f.path]),
              diffstat(f.linesAdded, f.linesRemoved),
              h("span", { class: "row" }, f.agents.map(chip)),
            ]),
          ),
        ),
      );

    // Tests on the combined result.
    page.append(h("h2", {}, [t("rev.tests")]));
    if (!r.tests) page.append(h("p", { class: "small muted" }, [t("rev.noTests")]));
    else {
      const tr = r.tests;
      page.append(
        h("div", { class: "row small" }, [
          h("span", { class: tr.passed ? "add" : "del" }, [icon(tr.passed ? "check" : "alert", 14)]),
          h("span", { class: "strong" }, [tr.passed ? t("rev.passed") : tr.timedOut ? t("rev.timedOut") : t("rev.failed")]),
          h("code", {}, [tr.command]),
          h("span", { class: "tiny muted" }, [`${(tr.durationMs / 1000).toFixed(1)} s`]),
        ]),
        h("pre", { class: "code-block output" }, [tr.output.slice(-6000)]),
      );
    }
    root.append(page);
  }

  window.addEventListener("message", (e) => {
    if (e.data?.type === "data") render(e.data.review, e.data.agents || []);
  });
  post({ type: "ready" });
})();
