import * as path from "node:path";
import * as vscode from "vscode";
import { SynapseClient, type AgentOutputEvent, type CoreEvent, type CoreMethodName, type CoreState, type ParamsOf, type ResultOf } from "@synapse/client";

/**
 * The extension's only link to collaboration logic: a client of the
 * synapse-core API. It caches the latest core state for the UI and never
 * computes ownership, conflicts or merges itself (risk T7).
 */
export class CoreConnection implements vscode.Disposable {
  private client?: SynapseClient;
  private connecting?: Promise<SynapseClient>;
  private refreshTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private disposed = false;
  private stopping = false;
  private readonly outputs = new Map<string, vscode.OutputChannel>();
  state?: CoreState;

  private readonly _onState = new vscode.EventEmitter<CoreState | undefined>();
  readonly onState = this._onState.event;
  private readonly _onEvent = new vscode.EventEmitter<CoreEvent>();
  readonly onEvent = this._onEvent.event;

  constructor(
    readonly repoRoot: string,
    private readonly context: vscode.ExtensionContext,
  ) {}

  get connected(): boolean {
    return !!this.client && !this.client.closed;
  }

  async connect(start: boolean): Promise<SynapseClient> {
    if (this.client && !this.client.closed) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const cfg = vscode.workspace.getConfiguration("synapse");
      const coreMain = cfg.get<string>("corePath") || path.join(this.context.extensionPath, "dist", "core", "main.mjs");
      const nodePath = cfg.get<string>("nodePath") || undefined;
      const opts = { workspace: this.repoRoot, clientName: `synapse-collab ${vscode.version}` };
      const client = start
        ? await SynapseClient.connectOrStart({ ...opts, coreMain, nodePath, env: nodePath ? {} : { ELECTRON_RUN_AS_NODE: "1" } })
        : await SynapseClient.connect(opts);
      client.on("event", (ev: CoreEvent) => this.onCoreEvent(ev));
      client.on("close", () => this.onClose());
      await client.subscribe();
      this.client = client;
      await this.refresh();
      return client;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  async call<M extends CoreMethodName>(method: M, ...params: ParamsOf<M> extends void ? [] : [ParamsOf<M>]): Promise<ResultOf<M>> {
    const autoStart = vscode.workspace.getConfiguration("synapse").get<boolean>("autoStartCore", true);
    const client = await this.connect(autoStart);
    return client.call(method, ...params);
  }

  async refresh(): Promise<void> {
    if (!this.client || this.client.closed) return;
    this.state = await this.client.call("state.get");
    this._onState.fire(this.state);
  }

  output(agentId: string): vscode.OutputChannel {
    let ch = this.outputs.get(agentId);
    if (!ch) {
      const name = this.state?.agents.find((a) => a.id === agentId)?.name ?? agentId;
      ch = vscode.window.createOutputChannel(`Synapse: ${name}`);
      this.outputs.set(agentId, ch);
    }
    return ch;
  }

  private onCoreEvent(ev: CoreEvent): void {
    this._onEvent.fire(ev);
    if (ev.type === "agent.output") {
      const o = ev.data as AgentOutputEvent;
      const ch = this.output(o.agentId);
      if (o.kind === "message") ch.append(o.text);
      else if (o.kind === "thought") return;
      else ch.appendLine(`\n[${o.kind}] ${o.text.trimEnd()}`);
      return;
    }
    // State changes: refetch the snapshot, coalesced.
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh().catch(() => {}), 80);
  }

  private onClose(): void {
    this.client = undefined;
    this.state = undefined;
    this._onState.fire(undefined);
    if (this.disposed || this.stopping) {
      this.stopping = false;
      return;
    }
    const autoStart = vscode.workspace.getConfiguration("synapse").get<boolean>("autoStartCore", true);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(autoStart).catch(() => this.onClose()), 3000);
  }

  /** Stops the core without reconnecting. `connect(true)` starts it again. */
  async stopCore(): Promise<void> {
    if (!this.client) return;
    this.stopping = true;
    await this.client.call("core.shutdown").catch(() => {});
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.client?.close();
    for (const ch of this.outputs.values()) ch.dispose();
    this._onState.dispose();
    this._onEvent.dispose();
  }
}
