import * as vscode from "vscode";
import type { AgentPolicy } from "@synapse/client";
import type { CoreConnection } from "./connection.js";

export const POLICY_SCHEME = "synapse-policy";

/**
 * Agent policies as editable JSON documents (`synapse-policy:/<agent>.json`).
 * Saving sends the policy to synapse-core, which validates and applies it.
 */
export class PolicyFileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly mtimes = new Map<string, number>();

  constructor(private readonly conn: CoreConnection) {}

  static uri(agentId: string): vscode.Uri {
    return vscode.Uri.from({ scheme: POLICY_SCHEME, path: `/${agentId}.json` });
  }

  private agentId(uri: vscode.Uri): string {
    return uri.path.replace(/^\//, "").replace(/\.json$/, "");
  }

  private async policy(uri: vscode.Uri): Promise<AgentPolicy> {
    const id = this.agentId(uri);
    const agent = (await this.conn.call("agents.list")).find((a) => a.id === id);
    if (!agent) throw vscode.FileSystemError.FileNotFound(uri);
    return agent.policy;
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const text = JSON.stringify(await this.policy(uri), null, 2);
    return { type: vscode.FileType.File, ctime: 0, mtime: this.mtimes.get(uri.path) ?? 0, size: Buffer.byteLength(text) };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const header = {
      $comment:
        "Edit and save to apply. writable/protected: repo-relative globs. commands.allow: run without asking when every part of a command matches. commands.deny: refuse when any part matches. edits: allow|ask. network, otherwise: allow|ask|deny.",
    };
    return Buffer.from(JSON.stringify({ ...header, ...(await this.policy(uri)) }, null, 2) + "\n");
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    let parsed: Partial<AgentPolicy> & { $comment?: string };
    try {
      parsed = JSON.parse(Buffer.from(content).toString("utf8"));
    } catch (err) {
      throw vscode.FileSystemError.NoPermissions(`Not valid JSON: ${(err as Error).message}`);
    }
    delete parsed.$comment;
    try {
      await this.conn.call("agents.setPolicy", { id: this.agentId(uri), policy: parsed });
    } catch (err) {
      throw vscode.FileSystemError.NoPermissions(`Synapse rejected the policy: ${(err as Error).message}`);
    }
    this.mtimes.set(uri.path, Date.now());
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    void vscode.window.setStatusBarMessage(`Synapse: policy for ${this.agentId(uri)} applied`, 3000);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }
  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
  delete(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
  rename(): void {
    throw vscode.FileSystemError.NoPermissions();
  }
}
