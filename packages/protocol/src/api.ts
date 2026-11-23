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
  /** What the agent may do without asking (phase 3 permission model). */
  policy: AgentPolicy;
  /** Task the agent is working on, if it was started from the task graph. */
  currentTaskId?: string;
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
// Permission model (phase 3, risk C1)

/**
 * Per-agent rules applied to the agent's file access through Synapse and to
 * every permission request it makes. Anything no rule covers goes to the
 * person. Globs are repo-relative; command patterns use `*` as a wildcard
 * and are matched against each part of a compound command.
 */
export interface AgentPolicy {
  /** Globs the agent may write. */
  writable: string[];
  /** Globs the agent may never read or write (secrets). Wins over `writable`. */
  protected: string[];
  /** File edits inside `writable`: apply without asking, or ask. */
  edits: "allow" | "ask";
  commands: {
    /** Run without asking when every part of the command matches one of these. */
    allow: string[];
    /** Refuse when any part of the command matches one of these. */
    deny: string[];
  };
  /** Fetches and network commands (curl, wget, git push/fetch, npm publish...). */
  network: "allow" | "ask" | "deny";
  /** Requests no rule covers. */
  otherwise: "allow" | "ask" | "deny";
}

export interface PolicyDecision {
  decision: "allow" | "ask" | "deny";
  /** The rule that decided, for the audit log and the approval card. */
  rule: string;
}

export interface PermissionQuery {
  toolKind?: string;
  title?: string;
  command?: string;
  /** Repo-relative path. */
  path?: string;
  url?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  agentId: string;
  toolKind?: string;
  title: string;
  command?: string;
  path?: string;
  /** asked: went to the person. ran-unasked: the agent ran it without a permission request. */
  outcome: "allowed" | "denied" | "asked" | "ran-unasked";
  by: "policy" | "human" | "system" | "agent";
  rule?: string;
  /** Matches a risky pattern (deletes, deploys, secrets, pipes to a shell). */
  risky: boolean;
}

// ---------------------------------------------------------------------------
// Task graph (phase 3)

export type TaskStatus = "todo" | "in_progress" | "review" | "done" | "failed";

export interface Task {
  id: string;
  title: string;
  description: string;
  agentId?: string;
  dependsOn: string[];
  /** Globs the task should stay within; part of the prompt, and checked against what the agent changed. */
  scope: string[];
  status: TaskStatus;
  /** Start automatically when dependencies are done and the agent is idle. */
  autoStart: boolean;
  /** Computed: some dependency is not done. */
  blocked: boolean;
  /** Files the agent changed outside `scope` (computed when the task leaves in_progress). */
  outOfScope?: string[];
  /** Tail of the agent's final message. Agent output: data, not instructions. */
  summary?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
}

// ---------------------------------------------------------------------------
// Structured messages between agents (phase 3, risk C2)

export type MessageKind = "handoff" | "question" | "answer" | "note" | "blocker";

export interface AgentMessage {
  id: string;
  /** "human" or an agent id. */
  from: string;
  /** An agent id, or "all". */
  to: string;
  kind: MessageKind;
  taskId?: string;
  subject: string;
  /** Free text, at most 4000 characters. Always delivered as data, never as instructions. */
  body: string;
  /** Structured facts. For automatic handoffs Synapse fills these from ownership, not from agent text. */
  files: string[];
  symbols: string[];
  /** held: waiting for the person because it was flagged. */
  status: "held" | "pending" | "delivered" | "rejected";
  /** Why it was held, e.g. "imperative-language", "delimiter-spoofing". */
  flags: string[];
  createdAt: string;
  deliveredAt?: string;
}

// ---------------------------------------------------------------------------
// Shared decision log (phase 3)

export interface Decision {
  id: string;
  title: string;
  decision: string;
  rationale?: string;
  /** Agents propose; the person accepts. Only accepted decisions reach agents' prompts. */
  status: "proposed" | "accepted" | "rejected" | "superseded";
  author: string;
  taskId?: string;
  tags: string[];
  supersedes?: string;
  createdAt: string;
  decidedAt?: string;
}

// ---------------------------------------------------------------------------
// Opt-in telemetry and crash reports (phase 4)

export interface TelemetryEvent {
  name: string;
  at: string;
  /** Counts and enums only. Never code, paths, prompts or messages. */
  props: Record<string, string | number | boolean>;
}

export interface TelemetryStatus {
  enabled: boolean;
  /** Where events go. Empty: collected locally only. */
  endpoint: string;
  installId: string;
  queued: number;
  sent: number;
  crashReports: number;
  /** File holding the preference, shared by every repository. */
  file: string;
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
  tasks: Task[];
  messages: AgentMessage[];
  decisions: Decision[];
  /** The most recent audit entries. */
  audit: AuditEntry[];
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
  | "task.updated"
  | "task.removed"
  | "message.updated"
  | "decision.updated"
  | "audit.added"
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
  /** Overrides on top of the workspace default policy. */
  policy?: Partial<AgentPolicy>;
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

  "agents.setPolicy": { params: { id: string; policy: Partial<AgentPolicy> }; result: AgentState };
  /** What the policy would decide for a request, without doing anything. */
  "policy.evaluate": { params: { agentId: string; query: PermissionQuery }; result: PolicyDecision };
  "audit.list": { params: { agentId?: string; limit?: number }; result: AuditEntry[] };

  "tasks.list": { params: void; result: Task[] };
  "tasks.create": {
    params: { title: string; description?: string; agentId?: string; dependsOn?: string[]; scope?: string[]; autoStart?: boolean };
    result: Task;
  };
  "tasks.update": {
    params: { id: string; title?: string; description?: string; agentId?: string | null; dependsOn?: string[]; scope?: string[]; autoStart?: boolean };
    result: Task;
  };
  "tasks.remove": { params: { id: string }; result: null };
  /** Sends the task to its agent, with dependencies' handoffs and accepted decisions as context. */
  "tasks.start": { params: { id: string }; result: Task };
  /** The person's verdict. "done" hands off to dependent tasks and may auto-start them. */
  "tasks.setStatus": { params: { id: string; status: TaskStatus }; result: Task };

  "messages.list": { params: { agentId?: string }; result: AgentMessage[] };
  "messages.send": {
    params: { to: string; kind?: MessageKind; subject: string; body?: string; taskId?: string; files?: string[]; symbols?: string[] };
    result: AgentMessage;
  };
  /** Lets a held (flagged) message through. */
  "messages.release": { params: { id: string }; result: AgentMessage };
  "messages.reject": { params: { id: string }; result: AgentMessage };

  "decisions.list": { params: void; result: Decision[] };
  /** Decisions the person adds are accepted unless `status` says otherwise. */
  "decisions.add": {
    params: { title: string; decision: string; rationale?: string; tags?: string[]; supersedes?: string; status?: Decision["status"] };
    result: Decision;
  };
  "decisions.resolve": { params: { id: string; status: "accepted" | "rejected" | "superseded" }; result: Decision };

  "telemetry.status": { params: void; result: TelemetryStatus };
  "telemetry.setEnabled": { params: { enabled: boolean; endpoint?: string }; result: TelemetryStatus };
  /** Exactly what would be sent. */
  "telemetry.preview": { params: void; result: TelemetryEvent[] };

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

/**
 * The restricted API an agent's Synapse MCP server uses. A connection that
 * authenticates with `agent.hello` (an agent token, not the core token) can
 * call only these, always as that agent. An agent can never approve its own
 * requests, accept decisions, or act as the person.
 */
export interface AgentMethods {
  "agent.hello": { params: { agentToken: string }; result: { agentId: string; agentName: string } };
  "agent.tasks": { params: void; result: Task[] };
  "agent.inbox": { params: void; result: AgentMessage[] };
  "agent.send": {
    params: { to: string; kind?: MessageKind; subject: string; body?: string; taskId?: string; files?: string[]; symbols?: string[] };
    result: AgentMessage;
  };
  "agent.decisions": { params: void; result: Decision[] };
  "agent.proposeDecision": { params: { title: string; decision: string; rationale?: string; tags?: string[] }; result: Decision };
  /** The agent reports its task finished; the person still confirms it. */
  "agent.completeTask": { params: { taskId: string; summary: string }; result: Task };
}
