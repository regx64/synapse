import { execFile } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentState } from "@synapse/client";
import { CoreConnection } from "./connection.js";
import { LiveDiffPanel } from "./livediff.js";
import { Markers } from "./markers.js";
import { POLICY_SCHEME, PolicyFileSystem } from "./policy.js";
import { REVIEW_SCHEME, ReviewContentProvider, ReviewPanel } from "./review.js";
import { attention } from "./attention.js";
import { initL10n, l } from "./ui/l10n.js";
import { Selection } from "./ui/selection.js";
import { AgentsView } from "./views/agents.js";
import { DetailView } from "./views/detail.js";
import { HomePanel } from "./views/home.js";

/**
 * Synapse's built-in extension. It is a client of synapse-core and nothing
 * more: the home tab, agent views, editor markers, diagnostics and review panel render core
 * state, and every action is a core API call.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initL10n(context.extensionPath);
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== "file") return;
  const repoRoot = await gitRoot(folder.uri.fsPath);
  if (!repoRoot) return;

  const conn = new CoreConnection(repoRoot, context);
  const selection = new Selection(conn, context.workspaceState);
  const deps = { conn, selection, context };
  const agentsView = new AgentsView(deps);
  const detailView = new DetailView(deps);
  const markers = new Markers(conn);
  context.subscriptions.push(
    conn,
    selection,
    agentsView,
    detailView,
    markers,
    vscode.window.registerWebviewViewProvider(AgentsView.id, agentsView, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider(DetailView.id, detailView, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewPanelSerializer(HomePanel.viewType, {
      deserializeWebviewPanel: async (panel) => HomePanel.restore(panel, deps),
    }),
    vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, new ReviewContentProvider(conn)),
    vscode.workspace.registerFileSystemProvider(POLICY_SCHEME, new PolicyFileSystem(conn), { isCaseSensitive: true }),
    // Title bar status, desktop notifications and the in-app ones.
    attention(conn),
  );

  const pickAgent = async (id: unknown, filter?: (a: AgentState) => boolean): Promise<string | undefined> => {
    if (typeof id === "string") return id;
    const agents = (conn.state?.agents ?? (await conn.call("agents.list"))).filter(filter ?? (() => true));
    if (!agents.length) {
      void vscode.window.showInformationMessage(l("Synapse: no matching agents."));
      return undefined;
    }
    if (agents.length === 1) return agents[0]!.id;
    const pick = await vscode.window.showQuickPick(
      agents.map((a) => ({ label: a.name, description: a.status, detail: a.worktree.branch, id: a.id })),
      { placeHolder: l("Choose an agent") },
    );
    return pick?.id;
  };

  const register = (command: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async (...args: unknown[]) => {
        try {
          await fn(...args);
        } catch (err) {
          void vscode.window.showErrorMessage(l("Synapse: {0}", (err as Error).message));
        }
      }),
    );

  register("synapse.startCore", () => conn.connect(true));
  register("synapse.openHome", () => HomePanel.show(deps));
  register("synapse.showFiles", () => vscode.commands.executeCommand("workbench.view.explorer"));
  register("synapse.showAgents", () => vscode.commands.executeCommand("workbench.view.extension.synapse"));
  register("synapse.showDetail", async (id) => {
    if (typeof id === "string") selection.select(id);
    await vscode.commands.executeCommand("synapse.detail.focus");
  });
  register("synapse.enableTeam", async () => {
    const name = await vscode.window.showInputBox({ prompt: l("Your name in team mode (teammates see it)"), placeHolder: l("Leave empty to use your git user.name") });
    if (name === undefined) return;
    const t = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: l("Synapse: turning on team mode…") }, () => conn.call("team.enable", { name: name || undefined }));
    if (t.error) void vscode.window.showWarningMessage(l("Synapse team sync: {0}", t.error));
    else void vscode.window.showInformationMessage(l("Synapse: team mode is on. You are \"{0}\".", t.person));
  });
  register("synapse.stopCore", () => conn.stopCore());

  register("synapse.addAgent", async () => {
    const presets = await conn.call("agents.presets");
    const pick = await vscode.window.showQuickPick(
      [...presets.map((p) => ({ label: p.name, description: `${p.command} ${p.args.join(" ")}`, detail: p.notes, preset: p.id })), { label: "Custom command…", preset: "" }],
      { placeHolder: l("Which agent? Each one gets its own git worktree.") },
    );
    if (!pick) return;
    let command: string | undefined;
    let args: string[] | undefined;
    let id: string | undefined;
    if (!pick.preset) {
      const line = await vscode.window.showInputBox({ prompt: l("Command that starts an ACP agent on stdio"), placeHolder: "my-agent --acp" });
      if (!line) return;
      [command, ...args] = line.split(/\s+/);
      id = await vscode.window.showInputBox({ prompt: l("Agent id (lowercase letters, digits, dashes)"), value: "custom" });
      if (!id) return;
    }
    const agent = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: l("Synapse: creating worktree and starting agent…") }, () =>
      conn.call("agents.add", { preset: pick.preset || undefined, command, args, id, start: true }),
    );
    void vscode.window.showInformationMessage(l("Synapse: {0} is ready in {1}.", agent.name, agent.worktree.branch));
  });

  register("synapse.startAgent", async (id) => {
    const a = await pickAgent(id, (x) => x.status === "stopped" || x.status === "error");
    if (a) await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Starting ${a}…` }, () => conn.call("agents.start", { id: a }));
  });
  register("synapse.stopAgent", async (id) => {
    const a = await pickAgent(id, (x) => x.status !== "stopped");
    if (a) await conn.call("agents.stop", { id: a });
  });
  register("synapse.restartAgent", async (id) => {
    const a = await pickAgent(id);
    if (a) await conn.call("agents.restart", { id: a });
  });
  register("synapse.cancelAgent", async (id) => {
    const a = await pickAgent(id, (x) => x.status === "working" || x.status === "awaiting-approval");
    if (a) await conn.call("agents.cancel", { id: a });
  });
  register("synapse.teamAdopt", async (peerId) => {
    const state = conn.state;
    const peer = state?.team.peers.flatMap((p) => p.agents).find((x) => x.id === peerId);
    if (!peer) return;
    const candidates = (state?.agents ?? []).filter((x) => x.status === "idle" && !x.currentTaskId && !(state?.ownership[x.id]?.files.length));
    if (!candidates.length) {
      void vscode.window.showWarningMessage(l("Synapse: none of your agents can continue it. It needs a running, idle agent without changes of its own."));
      return;
    }
    const to = await vscode.window.showQuickPick(
      candidates.map((x) => ({ label: x.name, id: x.id })),
      { placeHolder: peer.task ? l("Which of your agents continues {0}'s work on \"{1}\"?", peer.name, peer.task) : l("Which of your agents continues {0}'s work?", peer.name) },
    );
    if (!to) return;
    const note = await vscode.window.showInputBox({ prompt: l("Note for {0} (optional)", to.label) });
    if (note === undefined) return;
    const r = await conn.call("team.adopt", { from: peer.id, to: to.id, note: note || undefined });
    void vscode.window.showInformationMessage(l("Synapse: {0} continues {1}'s work ({2} files). {3} will be told at the next sync.", r.to.name, peer.name, r.files.length, peer.person));
  });
  register("synapse.liveDiff", async (id) => {
    const a = await pickAgent(id);
    if (a) LiveDiffPanel.show(conn, context.extensionUri, a);
  });
  register("synapse.steerAgent", async (id) => {
    const a = await pickAgent(id, (x) => x.status === "working" || x.status === "awaiting-approval");
    if (!a) return;
    const text = await vscode.window.showInputBox({ prompt: l("Guidance for the agent while it works"), placeHolder: l("e.g. Keep the public API unchanged") });
    if (!text?.trim()) return;
    const when = await vscode.window.showQuickPick(
      [
        { label: `$(clock) ${l("After this turn")}`, description: l("the agent finishes its turn, then continues with this"), mode: "next" as const },
        { label: `$(debug-pause) ${l("Interrupt now")}`, description: l("the turn stops and continues with this at once"), mode: "now" as const },
      ],
      { placeHolder: l("When should the agent get it?") },
    );
    if (when) await conn.call("agents.steer", { id: a, text, mode: when.mode });
  });
  register("synapse.takeover", async (id) => {
    const from = await pickAgent(id, (x) => !!x.currentTaskId || !!x.turn);
    if (!from) return;
    const state = conn.state;
    const candidates = (state?.agents ?? []).filter((x) => x.id !== from && x.status === "idle" && !x.currentTaskId && !(state?.ownership[x.id]?.files.length));
    if (!candidates.length) {
      void vscode.window.showWarningMessage(l("Synapse: no agent can take over. It needs a running, idle agent without changes of its own."));
      return;
    }
    const to = await vscode.window.showQuickPick(
      candidates.map((x) => ({ label: x.name, description: x.agentInfo?.name ?? x.preset ?? "", id: x.id })),
      { placeHolder: l("Which agent continues this work? Its changes and task move to that agent.") },
    );
    if (!to) return;
    const note = await vscode.window.showInputBox({ prompt: l("Note for {0} (optional)", to.label), placeHolder: l("e.g. The tests in cart.test.ts still fail") });
    if (note === undefined) return;
    const r = await conn.call("agents.takeover", { from, to: to.id, note: note || undefined });
    void vscode.window.showInformationMessage(l("Synapse: {0} took over {1} from {2} ({3} files moved).", r.to.name, r.task ? r.task.id : l("the work"), r.from?.name ?? "", r.files.length));
  });
  register("synapse.removeAgent", async (id) => {
    const a = await pickAgent(id);
    if (!a) return;
    const remove = l("Remove");
    const ok = await vscode.window.showWarningMessage(l("Remove {0}? Its worktree and branch are deleted, with any work not merged.", a), { modal: true }, remove);
    if (ok === remove) await conn.call("agents.remove", { id: a });
  });
  register("synapse.promptAgent", async (id) => {
    const a = await pickAgent(id, (x) => x.status === "idle");
    if (!a) return;
    const text = await vscode.window.showInputBox({ prompt: l("Prompt for {0}", a) });
    if (text) await conn.call("agents.prompt", { id: a, text });
  });
  register("synapse.openWorktree", async (id) => {
    const a = await pickAgent(id);
    const agent = conn.state?.agents.find((x) => x.id === a);
    if (agent) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(agent.worktree.path), { forceNewWindow: true });
  });
  register("synapse.showOutput", async (id) => {
    const a = await pickAgent(id);
    if (a) conn.output(a).show(true);
  });
  register("synapse.agentMenu", async (id) => {
    const a = await pickAgent(id);
    if (!a) return;
    const items: { label: string; command: string }[] = [
      { label: `$(comment) ${l("Send prompt…")}`, command: "synapse.promptAgent" },
      { label: `$(diff) ${l("Live changes and comments")}`, command: "synapse.liveDiff" },
      { label: `$(comment-discussion) ${l("Add guidance while it works…")}`, command: "synapse.steerAgent" },
      { label: `$(arrow-swap) ${l("Hand work off to another agent…")}`, command: "synapse.takeover" },
      { label: `$(debug-restart) ${l("Restart")}`, command: "synapse.restartAgent" },
      { label: `$(folder-opened) ${l("Open worktree in new window")}`, command: "synapse.openWorktree" },
      { label: `$(output) ${l("Show output")}`, command: "synapse.showOutput" },
      { label: `$(shield) ${l("Edit permission policy")}`, command: "synapse.editPolicy" },
      { label: `$(discard) ${l("Reset worktree to base")}`, command: "synapse.resetAgent" },
      { label: `$(trash) ${l("Remove agent")}`, command: "synapse.removeAgent" },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: a });
    if (pick) await vscode.commands.executeCommand(pick.command, a);
  });
  register("synapse.editPolicy", async (id) => {
    const a = await pickAgent(id);
    if (!a) return;
    const doc = await vscode.workspace.openTextDocument(PolicyFileSystem.uri(a));
    await vscode.languages.setTextDocumentLanguage(doc, "jsonc");
    await vscode.window.showTextDocument(doc);
  });
  register("synapse.pinDecision", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const rel = path.relative(repoRoot, editor.document.uri.fsPath).split(path.sep).join("/");
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      void vscode.window.showWarningMessage(l("Synapse: open a file of this repository (not an agent's worktree) to pin a decision."));
      return;
    }
    const decisions = (conn.state?.decisions ?? []).filter((d) => d.status === "accepted" || d.status === "proposed");
    if (!decisions.length) {
      void vscode.window.showInformationMessage(l("Synapse: record a decision on the home tab's Decisions first."));
      return;
    }
    const pick = await vscode.window.showQuickPick(
      decisions.map((d) => ({ label: `${d.id} · ${d.title}`, description: d.status === "proposed" ? "proposed" : "", detail: d.decision, id: d.id })),
      { placeHolder: l("Pin which decision to the code at the cursor?") },
    );
    if (!pick) return;
    const d = await conn.call("decisions.pin", { id: pick.id, path: rel, line: editor.selection.active.line });
    const a = d.anchors?.at(-1);
    void vscode.window.showInformationMessage(l("Synapse: {0} pinned to {1}. You'll be told when that code changes.", d.id, a?.symbol ?? a?.path ?? rel));
  });
  register("synapse.newTask", async () => {
    const title = await vscode.window.showInputBox({ prompt: l("Task title") });
    if (!title) return;
    const agent = await pickAgent(undefined);
    const t = await conn.call("tasks.create", { title, agentId: agent });
    void vscode.window.showInformationMessage(l("Synapse: created {0}. Add details and dependencies on the home tab's Tasks.", t.id));
  });
  register("synapse.initConfig", async () => {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(repoRoot), "synapse.config.json");
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      const template = {
        testCommand: "npm test",
        setupCommand: "npm ci",
        decisionLogPath: "docs/decisions.md",
        policy: { network: "ask", commands: { allow: ["npm test*", "npm run lint*", "git status*", "git diff*"] } },
      };
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(template, null, 2) + "\n"));
    }
    await vscode.window.showTextDocument(uri);
  });
  register("synapse.resetAgent", async (id) => {
    const a = await pickAgent(id);
    if (!a) return;
    const reset = l("Reset");
    const ok = await vscode.window.showWarningMessage(l("Discard all of {0}'s changes and reset its worktree to the base branch?", a), { modal: true }, reset);
    if (ok === reset) await conn.call("agents.reset", { id: a });
  });
  register("synapse.checkConflicts", async () => {
    await conn.call("ownership.refresh", {});
    const list = await conn.call("conflicts.check");
    const n = list.filter((c) => c.severity !== "info").length;
    void vscode.window.showInformationMessage(n ? l("Synapse: {0} conflicts between agents. See the home tab or the Problems panel.", n) : l("Synapse: no conflicts between agents."));
  });
  register("synapse.prepareReview", async () => {
    const agents = conn.state?.agents ?? [];
    let selected = agents.map((a) => a.id);
    if (agents.length > 2) {
      const picks = await vscode.window.showQuickPick(
        agents.map((a) => ({ label: a.name, id: a.id, picked: true })),
        { canPickMany: true, placeHolder: l("Agents to combine") },
      );
      if (!picks?.length) return;
      selected = picks.map((p) => p.id);
    }
    const review = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: l("Synapse: merging agents' work and running tests…") }, () =>
      conn.call("review.prepare", { agents: selected }),
    );
    ReviewPanel.show(conn, context.extensionUri, review);
  });

  // The three columns: agents on the left, home in the middle, the selected
  // agent on the right. Opened once per repository; later the layout the
  // person leaves is restored.
  const layoutKey = "synapse.layoutShown";
  if (!context.workspaceState.get(layoutKey)) {
    void context.workspaceState.update(layoutKey, true);
    void (async () => {
      await vscode.commands.executeCommand("workbench.view.extension.synapse").then(undefined, () => {});
      await vscode.commands.executeCommand("workbench.view.extension.synapse-detail").then(undefined, () => {});
      await HomePanel.show(deps);
    })();
  } else if (!HomePanel.isOpen && vscode.workspace.getConfiguration("synapse").get<boolean>("openHomeOnStart", true)) {
    // The serializer restores a home tab the person left open; give it a moment first.
    setTimeout(() => !HomePanel.isOpen && void HomePanel.show(deps, true), 1500);
  }
  if (vscode.workspace.getConfiguration("synapse").get<boolean>("showWalkthroughOnStart", false)) {
    void vscode.commands.executeCommand("workbench.action.openWalkthrough", `${context.extension.id}#synapse.gettingStarted`, false);
  }

  if (vscode.workspace.getConfiguration("synapse").get<boolean>("autoStartCore", true)) {
    conn.connect(true).catch((err: Error) => void vscode.window.showErrorMessage(l("Synapse could not start synapse-core: {0}", err.message)));
  } else {
    conn.connect(false).catch(() => {});
  }
}

export function deactivate(): void {
  /* The core keeps running so agents survive a window reload; it stops with `Synapse: Stop Core`. */
}

function gitRoot(dir: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--show-toplevel"], { cwd: dir }, (err, stdout) => resolve(err ? undefined : stdout.trim()));
  });
}
