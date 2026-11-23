import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

/**
 * A minimal JSON-RPC 2.0 peer over newline-delimited JSON.
 *
 * Used in three places: the synapse-core API server, the client library that
 * UIs use to reach it, and the ACP client that talks to agent processes. ACP
 * uses the same framing (one JSON message per line on stdio).
 */

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Synapse-specific: the caller has not completed the hello handshake. */
  Unauthorized: -32001,
  /** Synapse-specific: the request conflicts with current state. */
  Conflict: -32002,
  /** Synapse-specific: an object referenced by id does not exist. */
  NotFound: -32004,
  /** ACP: authentication required. */
  AuthRequired: -32000,
} as const;

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export type RequestHandler = (params: any, ctx: { method: string }) => unknown | Promise<unknown>;
export type NotificationHandler = (params: any, ctx: { method: string }) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
  method: string;
}

export interface PeerOptions {
  /** Used in error messages and logs. */
  name?: string;
  /** Default request timeout. 0 disables timeouts. */
  timeoutMs?: number;
  /** Maximum accepted line length in bytes; longer lines are dropped. */
  maxLineBytes?: number;
}

export class JsonRpcPeer extends EventEmitter {
  private nextId = 1;
  private buffer = "";
  private closed = false;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private fallbackRequest?: RequestHandler;
  private fallbackNotification?: NotificationHandler;
  private readonly name: string;
  private readonly timeoutMs: number;
  private readonly maxLineBytes: number;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    opts: PeerOptions = {},
  ) {
    super();
    this.name = opts.name ?? "peer";
    this.timeoutMs = opts.timeoutMs ?? 0;
    this.maxLineBytes = opts.maxLineBytes ?? 32 * 1024 * 1024;
    input.setEncoding?.("utf8");
    input.on("data", (chunk: string | Buffer) => this.onData(chunk.toString()));
    input.on("end", () => this.close(new Error(`${this.name}: input ended`)));
    input.on("error", (err) => this.close(err));
    output.on("error", (err) => this.close(err));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onRequest(method: string, handler: RequestHandler): this {
    this.requestHandlers.set(method, handler);
    return this;
  }

  onNotification(method: string, handler: NotificationHandler): this {
    this.notificationHandlers.set(method, handler);
    return this;
  }

  /** Handles any request without a dedicated handler. */
  onAnyRequest(handler: RequestHandler): this {
    this.fallbackRequest = handler;
    return this;
  }

  onAnyNotification(handler: NotificationHandler): this {
    this.fallbackNotification = handler;
    return this;
  }

  request<T = unknown>(method: string, params?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`${this.name}: connection closed`));
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = { resolve: resolve as (v: unknown) => void, reject, method };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${this.name}: request ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, pending);
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  close(reason?: Error): void {
    if (this.closed) return;
    this.closed = true;
    const err = reason ?? new Error(`${this.name}: connection closed`);
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.emit("close", err);
  }

  private send(msg: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    try {
      this.output.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      this.close(err as Error);
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.onLine(line);
    }
    if (this.buffer.length > this.maxLineBytes) {
      this.emit("protocolError", new Error(`${this.name}: line exceeds ${this.maxLineBytes} bytes, dropped`));
      this.buffer = "";
    }
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      // Agents sometimes print logs on stdout. Ignore non-JSON lines rather than failing.
      this.emit("protocolError", new Error(`${this.name}: non-JSON line ignored: ${line.slice(0, 200)}`));
      return;
    }
    if (Array.isArray(msg)) {
      for (const m of msg) this.dispatch(m);
    } else {
      this.dispatch(msg);
    }
  }

  private dispatch(msg: any): void {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
      this.emit("protocolError", new Error(`${this.name}: invalid message`));
      return;
    }
    if (typeof msg.method === "string") {
      if (msg.id !== undefined && msg.id !== null) {
        void this.handleRequest(msg as JsonRpcRequest);
      } else {
        this.handleNotification(msg as JsonRpcNotification);
      }
      return;
    }
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private async handleRequest(req: JsonRpcRequest): Promise<void> {
    const handler = this.requestHandlers.get(req.method) ?? this.fallbackRequest;
    if (!handler) {
      this.send({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: ErrorCodes.MethodNotFound, message: `Method not found: ${req.method}` },
      });
      return;
    }
    try {
      const result = await handler(req.params, { method: req.method });
      this.send({ jsonrpc: "2.0", id: req.id, result: result === undefined ? null : result });
    } catch (err) {
      const e = err as Error & { code?: unknown; data?: unknown };
      const code = err instanceof RpcError ? err.code : typeof e.code === "number" ? e.code : ErrorCodes.InternalError;
      this.send({
        jsonrpc: "2.0",
        id: req.id,
        error: { code, message: e.message ?? String(err), data: err instanceof RpcError ? err.data : undefined },
      });
    }
  }

  private handleNotification(n: JsonRpcNotification): void {
    const handler = this.notificationHandlers.get(n.method) ?? this.fallbackNotification;
    if (!handler) return;
    try {
      handler(n.params, { method: n.method });
    } catch (err) {
      this.emit("handlerError", err);
    }
  }
}
