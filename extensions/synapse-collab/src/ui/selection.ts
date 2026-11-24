import * as vscode from "vscode";
import type { CoreConnection } from "../connection.js";

/**
 * The agent the person is looking at: picked in the agents list or on the
 * home tab, shown in the agent detail view. Remembered per workspace.
 */
export class Selection implements vscode.Disposable {
  private id?: string;
  private readonly emitter = new vscode.EventEmitter<string | undefined>();
  readonly onChange = this.emitter.event;
  private readonly tabEmitter = new vscode.EventEmitter<string>();
  /** A view asked the agent detail to show one of its tabs (conversation, plan, changes). */
  readonly onShowTab = this.tabEmitter.event;

  showTab(tab: string): void {
    this.tabEmitter.fire(tab);
  }
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly conn: CoreConnection,
    private readonly memento: vscode.Memento,
  ) {
    this.id = memento.get<string>("synapse.selectedAgent");
    // Keep the selection on an agent that exists; else the first one.
    this.sub = conn.onState((s) => {
      if (!s) return;
      if (this.id && s.agents.some((a) => a.id === this.id)) return;
      const next = s.agents[0]?.id;
      if (next !== this.id) this.select(next);
    });
  }

  get current(): string | undefined {
    const agents = this.conn.state?.agents ?? [];
    return this.id && agents.some((a) => a.id === this.id) ? this.id : agents[0]?.id;
  }

  select(id: string | undefined): void {
    if (id === this.id) return;
    this.id = id;
    void this.memento.update("synapse.selectedAgent", id);
    this.emitter.fire(id);
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
    this.tabEmitter.dispose();
  }
}
