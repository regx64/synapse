import { execFile } from "node:child_process";
import * as vscode from "vscode";
import type { AgentState } from "@synapse/client";
import { BoardProvider } from "./board.js";
import { CoreConnection } from "./connection.js";
import { Markers } from "./markers.js";
import { POLICY_SCHEME, PolicyFileSystem } from "./policy.js";
import { REVIEW_SCHEME, ReviewContentProvider, ReviewPanel } from "./review.js";

/**
 * Synapse's built-in extension. It is a client of synapse-core and nothing
 * more: the board, editor markers, diagnostics and review panel render core
 * state, and every action is a core API call.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== "file") return;
  const repoRoot = await gitRoot(folder.uri.fsPath);
  if (!repoRoot) return;

  const conn = new CoreConnection(repoRoot, context);
  const board = new BoardProvider(conn, context.extensionUri);
  const markers = new Markers(conn);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "workbench.view.extension.synapse";
  context.subscriptions.push(
    conn,
    board,
    markers,
    status,
    vscode.window.registerWebviewViewProvider(BoardProvider.viewId, board, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, new ReviewContentProvider(conn)),
    vscode.workspace.registerFileSystemProvider(POLICY_SCHEME, new PolicyFileSystem(conn), { isCaseSensitive: true }),
    conn.onState((s) => {
      if (!s) {
        status.text = "$(circle-slash) Synapse";
        status.tooltip = "synapse-core is not connected";
      } else {
        const working = s.agents.filter((a) => a.status === "working").length;
        const waiting = s.approvals.filter((a) => a.status === "pending").length;
        const conflicts = s.conflicts.filter((c) => c.severity !== "info").length;
        const held = s.messages.filter((m) => m.status === "held").length;
        const review = s.tasks.filter((t) => t.status === "review").length;
        status.text = `$(organization) ${s.agents.length} agents${working ? ` · ${working} working` : ""}${waiting ? ` · $(bell) ${waiting}` : ""}${review ? ` · $(tasklist) ${review}` : ""}${held ? ` · $(mail) ${held}` : ""}${conflicts ? ` · $(warning) ${conflicts}` : ""}`;
        status.tooltip = `Synapse — base ${s.baseRef}`;
        status.backgroundColor = conflicts ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
      }
      status.show();
    }),
    conn.onEvent((ev) => {
      if (ev.type === "core.log") {
        const d = ev.data as { level?: string; message?: string };
        if (d.level === "warning" && d.message) void vscode.window.showWarningMessage(`Synapse: ${d.message}`, "Open audit");
        return;
      }
      if (ev.type === "message.updated") {
        const m = ev.data as { status: string; from: string; subject: string };
        if (m.status === "held") void vscode.window.showWarningMessage(`Synapse held a message from ${m.from}: "${m.subject}". Review it on the board.`);
        return;
      }
      if (ev.type === "approval.requested") {
        const ap = ev.data as { agentId: string; title: string };
        const name = conn.state?.agents.find((a) => a.id === ap.agentId)?.name ?? ap.agentId;
        void vscode.window.showInformationMessage(`${name} asks: ${ap.title}`, "Open board").then((x) => {
          if (x) void vscode.commands.executeCommand("workbench.view.extension.synapse");
        });
      }
    }),
  );

  const pickAgent = async (id: unknown, filter?: (a: AgentState) => boolean): Promise<string | undefined> => {
    if (typeof id === "string") return id;
    const agents = (conn.state?.agents ?? (await conn.call("agents.list"))).filter(filter ?? (() => true));
    if (!agents.length) {
      void vscode.window.showInformationMessage("Synapse: no matching agents.");
      return undefined;
    }
    if (agents.length === 1) return agents[0]!.id;
    const pick = await vscode.window.showQuickPick(
      agents.map((a) => ({ label: a.name, description: a.status, detail: a.worktree.branch, id: a.id })),
      { placeHolder: "Choose an agent" },
    );
    return pick?.id;
  };

  const register = (command: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async (...args: unknown[]) => {
        try {
          await fn(...args);
        } catch (err) {
          void vscode.window.showErrorMessage(`Synapse: ${(err as Error).message}`);
        }
      }),
    );

  register("synapse.startCore", () => conn.connect(true));
  register("synapse.stopCore", () => conn.stopCore());

  register("synapse.addAgent", async () => {
    const presets = await conn.call("agents.presets");
    const pick = await vscode.window.showQuickPick(
      [...presets.map((p) => ({ label: p.name, description: `${p.command} ${p.args.join(" ")}`, detail: p.notes, preset: p.id })), { label: "Custom command…", preset: "" }],
      { placeHolder: "Which agent? Each one gets its own git worktree." },
    );
    if (!pick) return;
    let command: string | undefined;
    let args: string[] | undefined;
    let id: string | undefined;
    if (!pick.preset) {
      const line = await vscode.window.showInputBox({ prompt: "Command that starts an ACP agent on stdio", placeHolder: "my-agent --acp" });
      if (!line) return;
      [command, ...args] = line.split(/\s+/);
      id = await vscode.window.showInputBox({ prompt: "Agent id (lowercase letters, digits, dashes)", value: "custom" });
      if (!id) return;
    }
    const agent = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Synapse: creating worktree and starting agent…" }, () =>
      conn.call("agents.add", { preset: pick.preset || undefined, command, args, id, start: true }),
    );
    void vscode.window.showInformationMessage(`Synapse: ${agent.name} is ${agent.status} in ${agent.worktree.branch}.`);
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
  register("synapse.removeAgent", async (id) => {
    const a = await pickAgent(id);
    if (!a) return;
    const ok = await vscode.window.showWarningMessage(`Remove ${a}? Its worktree and branch are deleted, with any work not merged.`, { modal: true }, "Remove");
    if (ok === "Remove") await conn.call("agents.remove", { id: a });
  });
  register("synapse.promptAgent", async (id) => {
    const a = await pickAgent(id, (x) => x.status === "idle");
    if (!a) return;
    const text = await vscode.window.showInputBox({ prompt: `Prompt for ${a}` });
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
      { label: "$(comment) Send prompt…", command: "synapse.promptAgent" },
      { label: "$(debug-restart) Restart", command: "synapse.restartAgent" },
      { label: "$(folder-opened) Open worktree in new window", command: "synapse.openWorktree" },
      { label: "$(output) Show output", command: "synapse.showOutput" },
      { label: "$(shield) Edit permission policy", command: "synapse.editPolicy" },
      { label: "$(discard) Reset worktree to base", command: "synapse.resetAgent" },
      { label: "$(trash) Remove agent", command: "synapse.removeAgent" },
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
  register("synapse.newTask", async () => {
    const title = await vscode.window.showInputBox({ prompt: "Task title" });
    if (!title) return;
    const agent = await pickAgent(undefined);
    const t = await conn.call("tasks.create", { title, agentId: agent });
    void vscode.window.showInformationMessage(`Synapse: created ${t.id}. Add details and dependencies on the board's Tasks tab.`);
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
    const ok = await vscode.window.showWarningMessage(`Discard all of ${a}'s changes and reset its worktree to the base branch?`, { modal: true }, "Reset");
    if (ok === "Reset") await conn.call("agents.reset", { id: a });
  });
  register("synapse.checkConflicts", async () => {
    await conn.call("ownership.refresh", {});
    const list = await conn.call("conflicts.check");
    const n = list.filter((c) => c.severity !== "info").length;
    void vscode.window.showInformationMessage(n ? `Synapse: ${n} conflict(s) between agents. See the board or Problems panel.` : "Synapse: no conflicts between agents.");
  });
  register("synapse.prepareReview", async () => {
    const agents = conn.state?.agents ?? [];
    let selected = agents.map((a) => a.id);
    if (agents.length > 2) {
      const picks = await vscode.window.showQuickPick(
        agents.map((a) => ({ label: a.name, id: a.id, picked: true })),
        { canPickMany: true, placeHolder: "Agents to combine" },
      );
      if (!picks?.length) return;
      selected = picks.map((p) => p.id);
    }
    const review = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Synapse: merging agents' work and running tests…" }, () =>
      conn.call("review.prepare", { agents: selected }),
    );
    ReviewPanel.show(conn, review);
  });

  // Onboarding (phase 4): the walkthrough opens once per repository.
  const seenKey = `synapse.walkthroughShown:${repoRoot}`;
  if (vscode.workspace.getConfiguration("synapse").get<boolean>("showWalkthroughOnStart", true) && !context.globalState.get(seenKey)) {
    void context.globalState.update(seenKey, true);
    void vscode.commands.executeCommand("workbench.action.openWalkthrough", `${context.extension.id}#synapse.gettingStarted`, false);
  }

  if (vscode.workspace.getConfiguration("synapse").get<boolean>("autoStartCore", true)) {
    conn.connect(true).catch((err: Error) => {
      status.text = "$(error) Synapse";
      status.tooltip = err.message;
      status.show();
    });
  } else {
    conn.connect(false).catch(() => {
      status.text = "$(circle-slash) Synapse";
      status.show();
    });
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
