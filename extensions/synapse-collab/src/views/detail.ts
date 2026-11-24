import * as vscode from "vscode";
import type { AgentOutputEvent, TranscriptEntry } from "@synapse/client";
import { l } from "../ui/l10n.js";
import { attach, type ViewDeps } from "./common.js";

/**
 * The right column: the selected agent's conversation, plan and changes,
 * and where the person gives it guidance.
 */
export class DetailView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly id = "synapse.detail";
  private readonly disposables: vscode.Disposable[] = [];
  private view?: vscode.WebviewView;
  private timer?: NodeJS.Timeout;
  private fetching = false;
  private again = false;

  constructor(private readonly deps: ViewDeps) {
    this.disposables.push(
      deps.selection.onChange(() => this.sendTranscript()),
      deps.conn.onEvent((ev) => {
        if (ev.type !== "agent.output") return;
        const o = ev.data as AgentOutputEvent;
        if (o.agentId === deps.selection.current && o.kind !== "stderr" && o.kind !== "plan") this.scheduleTranscript();
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const post = attach(view.webview, this.deps, "detail", l("Agent"), this.disposables, (m) => {
      if (m.type === "ready") this.sendTranscript();
      return false;
    });
    view.onDidChangeVisibility(
      () => {
        if (!view.visible) return;
        post();
        this.sendTranscript();
      },
      undefined,
      this.disposables,
    );
  }

  /** Shows the view and puts the cursor in its guidance box. */
  async focusComposer(): Promise<void> {
    await vscode.commands.executeCommand("synapse.detail.focus");
    // The view may have just been created: give its page a moment to load.
    for (let i = 0; i < 20 && !this.view; i++) await new Promise((r) => setTimeout(r, 50));
    void this.view?.webview.postMessage({ type: "focusComposer" });
  }

  /** Streaming output arrives many times a second: send at most ~8 updates a second. */
  private scheduleTranscript(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.sendTranscript();
    }, 120);
  }

  private async sendTranscript(): Promise<void> {
    const view = this.view;
    const id = this.deps.selection.current;
    if (!view || !view.visible) return;
    if (this.fetching) {
      this.again = true;
      return;
    }
    this.fetching = true;
    try {
      const entries: TranscriptEntry[] = id && this.deps.conn.connected ? await this.deps.conn.call("agents.transcript", { id, limit: 300 }) : [];
      void view.webview.postMessage({ type: "transcript", id, entries });
    } catch {
      // The agent may have just been removed; the next state update clears the view.
    } finally {
      this.fetching = false;
      if (this.again) {
        this.again = false;
        this.scheduleTranscript();
      }
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}
