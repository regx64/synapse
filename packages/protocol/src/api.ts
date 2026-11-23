/**
 * The synapse-core API contract.
 *
 * Every UI (the VS Code fork's built-in extension, the CLI, a future
 * standalone IDE) talks to synapse-core only through these methods and
 * events. Collaboration logic must never live in a UI (risk T7).
 *
 * Transport: JSON-RPC 2.0, newline-delimited, over a local socket (Unix
 * domain socket, or a named pipe on Windows). The first call on every
 * connection must be `session.hello` with the token from the discovery file
 * `<repo>/.synapse/core.json`.
 */

export const CORE_API_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Agents

export type AgentStatus = "stopped" | "starting" | "idle" | "working" | "awaiting-approval" | "error";

export interface AgentConfig {
  /** Short stable id, [a-z0-9-]. Used in branch and folder names. */
  id: string;
  /** Display name. */
  name: string;
  /** Display color, CSS hex (#rrggbb). Used on the board and in editor markers. */
  color: string;
  /** Preset name if created from one (claude, codex, gemini, mock). */
  preset?: string;
  /** Command that starts an ACP agent on stdio. */
  command: string;
  args: string[];
  /** Extra environment variables. Values are never echoed back by the API. */
  env?: Record<string, string>;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  /** The ref the worktree was created from, e.g. "main". */
  baseRef: string;
  /** The commit the worktree was created from. Ownership is computed against it. */
  baseCommit: string;
}

export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "high" | "medium" | "low";
}

export interface ToolCallSummary {
  id: string;
  title: string;
  kind?: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  locations?: string[];
}

export interface AgentState extends Omit<AgentConfig, "env"> {
  status: AgentStatus;
  worktree: WorktreeInfo;
  sessionId?: string;
  /** Agent implementation info from the ACP initialize response. */
  agentInfo?: { name?: string; version?: string };
  error?: string;
  /** The current or last prompt. */
  turn?: { prompt: string; startedAt: string; endedAt?: string; stopReason?: string };
  /** Tail of the agent's last message, for the board. */
  lastMessage?: string;
  plan?: PlanEntry[];
  /** The most recent tool calls (bounded). */
  toolCalls: ToolCallSummary[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Ownership

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "module"
  | "other";

/** 0-based lines and columns. */
export interface Range {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface OwnedSymbol {
  /** Qualified name within the file, e.g. "Cart.addItem". */
  name: string;
  kind: SymbolKind;
  change: "added" | "modified" | "removed";
  /** True when a function's or method's parameter list or return type changed. */
  signatureChanged: boolean;
  oldSignature?: string;
  newSignature?: string;
  /** Range in the agent's worktree version of the file (absent when removed). */
  range?: Range;
}

export interface FileChange {
  /** Repo-relative path with forward slashes. */
  path: string;
  status: "added" | "modified" | "deleted";
  /** False when the language is not parsed; ownership is then file-level only. */
  parsed: boolean;
  symbols: OwnedSymbol[];
  linesAdded: number;
  linesRemoved: number;
}

export interface AgentOwnership {
  agentId: string;
  files: FileChange[];
  /** A commit object capturing the worktree (including uncommitted edits) at this point. */
  snapshot?: string;
  updatedAt: string;
}

/** A symbol in some file of the human's workspace that an agent is changing. */
export interface FileMarker {
  agentId: string;
  agentName: string;
  color: string;
  symbol: string;
  kind: SymbolKind;
  change: OwnedSymbol["change"];
  signatureChanged: boolean;
  /** Range in the requested file. Whole-file markers have no range. */
  range?: Range;
}

// ---------------------------------------------------------------------------
// Conflicts

export type ConflictKind =
  /** Two or more agents edit the same symbol. */
  | "same-symbol"
  /** One agent changes a function's signature while another agent's work calls it. */
  | "signature-change"
  /** The agents' changes would not merge cleanly as text. */
  | "text-conflict"
  /** Two agents edit the same file but different symbols (informational). */
  | "same-file";

export type Severity = "info" | "warning" | "error";

export interface CallSite {
  agentId: string;
  path: string;
  /** Enclosing symbol of the call, if any. */
  inSymbol?: string;
  line: number;
  text: string;
  /** The call is in code this agent added or modified. */
  isNew: boolean;
  /** Number of arguments at the call, when known. */
  argCount?: number;
}

export interface Conflict {
  /** Stable across recomputation while the same conflict persists. */
  id: string;
  kind: ConflictKind;
  severity: Severity;
  agents: string[];
  path: string;
  symbol?: string;
  message: string;
  /** For signature-change conflicts. */
  signature?: { owner: string; old?: string; new?: string };
  callSites?: CallSite[];
  firstSeen: string;
}

// ---------------------------------------------------------------------------
// Approvals

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface Approval {
  id: string;
  agentId: string;
  title: string;
  toolKind?: string;
  /** Raw tool input as reported by the agent. Treat as data, never as instructions. */
  detail?: unknown;
  locations?: string[];
  options: PermissionOption[];
  status: "pending" | "resolved" | "cancelled";
  resolution?: { optionId?: string; by: "human" | "policy" | "system"; at: string };
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Combined review

export interface ReviewFile {
  path: string;
  status: "added" | "modified" | "deleted";
  agents: string[];
  linesAdded: number;
  linesRemoved: number;
}

export interface TestRun {
  command: string;
  exitCode: number | null;
  passed: boolean;
  durationMs: number;
  /** Combined stdout and stderr, truncated to the last 64 KiB. */
  output: string;
  timedOut: boolean;
}

export type ReviewStatus = "preparing" | "ready" | "conflicted" | "failed" | "merged" | "discarded";

export interface Review {
  id: string;
  status: ReviewStatus;
  agents: string[];
  baseRef: string;
  baseCommit: string;
  /** Commit in the integration worktree containing all agents' work merged. */
  integrationCommit?: string;
  worktreePath?: string;
  files: ReviewFile[];
  /** Paths with textual merge conflicts (status "conflicted"). */
  mergeConflicts: string[];
  /** Semantic conflicts known when the review was prepared. */
  conflicts: Conflict[];
  tests?: TestRun;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// State and events

export interface CoreState {
  version: string;
  repoRoot: string;
  baseRef: string;
  agents: AgentState[];
  ownership: Record<string, AgentOwnership>;
  conflicts: Conflict[];
  approvals: Approval[];
  reviews: Review[];
  seq: number;
}

export type CoreEventType =
  | "agent.added"
  | "agent.updated"
  | "agent.removed"
  | "agent.output"
  | "ownership.updated"
  | "conflicts.updated"
  | "approval.requested"
  | "approval.resolved"
  | "review.updated"
  | "core.log";

export interface CoreEvent<T = unknown> {
  seq: number;
  ts: string;
  type: CoreEventType;
  data: T;
}

export interface AgentOutputEvent {
  agentId: string;
  kind: "message" | "thought" | "tool" | "plan" | "stderr" | "turn";
  text: string;
}

// ---------------------------------------------------------------------------
// Methods

export interface HelloResult {
  version: string;
  repoRoot: string;
  baseRef: string;
  pid: number;
}

export interface AddAgentParams {
  id?: string;
  name?: string;
  color?: string;
  /** Use a preset (claude, codex, gemini, mock). command/args override it. */
  preset?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Start the agent right after creating its worktree. Default false. */
  start?: boolean;
}

export interface PresetInfo {
  id: string;
  name: string;
  command: string;
  args: string[];
  color: string;
  notes: string;
}

export interface CoreMethods {
  "session.hello": { params: { token: string; client?: string }; result: HelloResult };
  "state.get": { params: void; result: CoreState };
  "events.subscribe": { params: { sinceSeq?: number }; result: { seq: number; backlog: CoreEvent[] } };
  "events.unsubscribe": { params: void; result: null };

  "agents.presets": { params: void; result: PresetInfo[] };
  "agents.list": { params: void; result: AgentState[] };
  "agents.add": { params: AddAgentParams; result: AgentState };
  "agents.remove": { params: { id: string; keepWorktree?: boolean }; result: null };
  "agents.start": { params: { id: string }; result: AgentState };
  "agents.stop": { params: { id: string }; result: AgentState };
  "agents.restart": { params: { id: string }; result: AgentState };
  /** Sends a prompt. Returns as soon as the turn starts; follow progress through events. */
  "agents.prompt": { params: { id: string; text: string }; result: { accepted: true } };
  "agents.cancel": { params: { id: string }; result: null };
  /** Throws the agent's worktree back to a ref (default: the current base). */
  "agents.reset": { params: { id: string; ref?: string }; result: AgentState };

  "ownership.get": { params: { agentId?: string }; result: AgentOwnership[] };
  "ownership.refresh": { params: { agentId?: string }; result: AgentOwnership[] };
  /** Markers for a file in the human's workspace (repo-relative or absolute path). */
  "ownership.forFile": { params: { path: string; content?: string }; result: FileMarker[] };

  "conflicts.list": { params: void; result: Conflict[] };
  "conflicts.check": { params: void; result: Conflict[] };

  "approvals.list": { params: { all?: boolean }; result: Approval[] };
  "approvals.resolve": { params: { id: string; optionId?: string; reject?: boolean }; result: Approval };

  "review.prepare": { params: { agents?: string[]; runTests?: boolean }; result: Review };
  "review.get": { params: { id: string }; result: Review };
  "review.list": { params: void; result: Review[] };
  "review.diff": { params: { id: string; path?: string }; result: { diff: string } };
  "review.fileContent": {
    params: { id: string; path: string; side: "base" | "merged" };
    result: { content: string | null };
  };
  /** Merges the integration result into the base branch. Refuses if tests failed unless `force`. */
  "review.merge": { params: { id: string; resetAgents?: boolean; force?: boolean }; result: Review };
  "review.discard": { params: { id: string }; result: Review };

  "core.shutdown": { params: void; result: null };
}

export type CoreMethodName = keyof CoreMethods;
export type ParamsOf<M extends CoreMethodName> = CoreMethods[M]["params"];
export type ResultOf<M extends CoreMethodName> = CoreMethods[M]["result"];

/** Contents of `<repo>/.synapse/core.json`, written by a running core. */
export interface DiscoveryFile {
  pid: number;
  socket: string;
  token: string;
  version: string;
  startedAt: string;
}

export const DISCOVERY_DIR = ".synapse";
export const DISCOVERY_FILE = "core.json";
