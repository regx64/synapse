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

/** Guidance the person gives an agent during a turn. */
export interface Guidance {
  text: string;
  /** "now": the turn is interrupted and continues with it; "next": it follows when the turn ends. */
  mode: "now" | "next";
  at: string;
}

/** Result of handing one agent's unfinished work to another. */
export interface TakeoverResult {
  /** The agent whose work moved (absent when it was a teammate's agent). */
  from?: AgentState;
  to: AgentState;
  /** The task that moved, if any. */
  task?: Task;
  /** The commit holding the work that moved (also kept at refs/synapse/takeovers/…). */
  commit: string;
  /** Files carried over. */
  files: string[];
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
  /** The current or last prompt. `steered` counts guidance turns that continued it. */
  turn?: { prompt: string; startedAt: string; endedAt?: string; stopReason?: string; steered?: number };
  /** Guidance from the person waiting to be given to the agent (see agents.steer). */
  guidance?: Guidance[];
  /** Tail of the agent's last message, for the board. */
  lastMessage?: string;
  plan?: PlanEntry[];
  /** The most recent tool calls (bounded). */
  toolCalls: ToolCallSummary[];
  /** The tests last run in this agent's worktree (after a turn, or on request). */
  tests?: AgentTests;
  createdAt: string;
  updatedAt: string;
}

/** `testCommand` run in an agent's own worktree. */
export interface AgentTests {
  status: "running" | "passed" | "failed";
  command: string;
  startedAt: string;
  durationMs?: number;
  timedOut?: boolean;
  /** The end of the output (redacted). */
  output?: string;
  /** The worktree snapshot the tests ran on. */
  snapshot?: string;
  /** Failures given back to the agent in a row (see testsFeedback). */
  feedbackCount?: number;
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
  | "same-file"
  /** An agent changes code that an accepted decision is pinned to. */
  | "decision";

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
  /** For decision conflicts: the decision whose pinned code is being changed. */
  decisionId?: string;
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
  /** The agent plans first and waits for the person to approve the plan before changing code. */
  planFirst?: boolean;
  /** Plan-first state: drafting (the agent is planning), proposed (waiting for the person), approved. */
  plan?: TaskPlan;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
}

/** A task an agent proposed while splitting a goal. Agent output: data, validated. */
export interface ProposedTask {
  /** The agent's handle for the task, used by dependsOn. */
  key: string;
  title: string;
  description: string;
  /** Keys of proposed tasks this one needs first. */
  dependsOn: string[];
  scope: string[];
  /** Suggested agent (an existing agent id), if any. */
  agentId?: string;
}

/** A goal an agent is splitting, or has split, into tasks for the person to accept. */
export interface GoalSplit {
  id: string;
  goal: string;
  /** The agent doing the splitting. */
  agentId: string;
  status: "splitting" | "proposed" | "accepted" | "discarded" | "failed";
  tasks: ProposedTask[];
  /** Task ids created when accepted. */
  createdTasks?: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** One agent's work waiting to be merged on its own, tests first. */
export interface QueueEntry {
  id: string;
  agentId: string;
  /** Marked done when the work is merged. */
  taskId?: string;
  status: "queued" | "merging" | "merged" | "failed" | "removed";
  /** The review used to merge it. */
  reviewId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskPlan {
  state: "drafting" | "proposed" | "approved";
  /** The plan: the agent's plan entries or its message; the person may edit it before approving. Agent output: data. */
  text?: string;
  /** The agent changed files while it was only supposed to plan. */
  changedFiles?: boolean;
  /** Planning rounds so far (revisions count). */
  rounds: number;
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
  /**
   * Code this decision is about. When that code changes on the base branch,
   * the anchor is marked `changed` so the person can check that the decision
   * still holds; while an agent is changing it, a `decision` conflict warns
   * before merge.
   */
  anchors?: DecisionAnchor[];
}

/** Where to pin a decision: a file, or one symbol in it. */
export interface DecisionPin {
  /** Repo-relative path with forward slashes. */
  path: string;
  /** Qualified symbol name, e.g. "Cart.add". Absent: the whole file. */
  symbol?: string;
}

export interface DecisionAnchor extends DecisionPin {
  /** Hash of the pinned code (whitespace-normalized) when it was pinned or last confirmed. */
  fingerprint: string;
  /** Base-branch commit the fingerprint was taken at. */
  pinnedCommit: string;
  pinnedAt: string;
  /** Result of the last check against the base branch. */
  state: "current" | "changed" | "missing";
  /** Base commit of the last check. */
  checkedCommit: string;
}

// ---------------------------------------------------------------------------
// Live diffs and comments on an agent's changes

export interface DiffLine {
  t: "+" | "-" | " ";
  text: string;
  /** 1-based line numbers in the base and agent versions. */
  oldNo?: number;
  newNo?: number;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  status: "added" | "modified" | "deleted";
  binary: boolean;
  hunks: DiffHunk[];
  /** The diff was cut short (very large file or change). */
  truncated?: boolean;
}

/** What an agent has changed against its base, as of its latest snapshot. */
export interface AgentDiff {
  agentId: string;
  baseCommit: string;
  snapshot?: string;
  files: FileDiff[];
  updatedAt: string;
}

/** A comment by the person on lines of an agent's changes. */
export interface CodeComment {
  id: string;
  agentId: string;
  path: string;
  /** 1-based lines in the agent's version of the file, where the quoted code was last found. */
  line: number;
  endLine: number;
  /** The commented code, used to follow it as the agent keeps editing. */
  quote: string;
  text: string;
  /** "note": kept for the person; "guidance": given to the agent; "task": turned into a task. */
  action: "note" | "guidance" | "task";
  taskId?: string;
  status: "open" | "resolved";
  /** The quoted code is no longer in the agent's version of the file. */
  outdated?: boolean;
  /** Written by a reviewer agent (its id); absent when the person wrote it. */
  author?: string;
  /** A reviewer agent's rating of the comment. */
  severity?: "blocker" | "suggestion";
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Team mode: teammates' agents, shared through the git remote (no server)

/** A teammate's agent, as their Synapse published it. Read-only here. */
export interface TeamAgent {
  /** "@<person>/<agent id>": how it appears in conflicts. */
  id: string;
  person: string;
  agentId: string;
  name: string;
  color: string;
  status: AgentStatus;
  /** Title of the task it works on, if any. */
  task?: string;
  baseRef: string;
  baseCommit: string;
  snapshot?: string;
  files: FileChange[];
  /** A teammate continued this agent's work (see team.adopt). */
  claimedBy?: string;
}

/** A teammate continued one of your agents' work (or you continued theirs). */
export interface TeamClaim {
  id: string;
  /** Who continued it, and with which of their agents. */
  by: string;
  byAgent: string;
  /** The agent whose work was continued: "@<person>/<agent id>". */
  agent: string;
  task?: string;
  at: string;
}

export interface TeamPeer {
  person: string;
  updatedAt: string;
  /** Not updated for a while (their Synapse is closed or offline). */
  stale: boolean;
  agents: TeamAgent[];
}

export interface TeamState {
  enabled: boolean;
  /** How this person appears to teammates. */
  person: string;
  /**
   * From team.members in the shared config. "editor" (default) publishes and
   * can continue teammates' work; "viewer" only watches. A coordination aid:
   * access itself is whatever the git remote allows.
   */
  role: "editor" | "viewer";
  /** Teammates who continued your agents' work, not yet dismissed. */
  claimsOnMe: TeamClaim[];
  remote: string;
  lastSync?: string;
  error?: string;
  peers: TeamPeer[];
}

// ---------------------------------------------------------------------------
// Alerts: only what needs the person

export type AlertKind =
  | "approval"
  | "conflict"
  | "agent-error"
  | "held-message"
  | "proposed-decision"
  | "stale-decision"
  | "task-review"
  | "risky-command"
  | "team-claim"
  | "tests-failed"
  | "plan-review"
  | "goal-split"
  | "queue-failed";

/** Something the person should act on. Derived from state; it goes away when acted on. */
export interface Alert {
  /** Stable while the underlying item exists. */
  id: string;
  kind: AlertKind;
  /** "urgent": blocks work or may cause damage; "action": waits for the person. */
  level: "urgent" | "action";
  title: string;
  detail?: string;
  agentId?: string;
  /** The item to act on: an approval, conflict, message, decision or task id; the agent id for agent errors. */
  ref: string;
  at: string;
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
  comments: CodeComment[];
  /** Goals being split into tasks by an agent, and recent results. */
  goals: GoalSplit[];
  /** Agents' work waiting to be merged one at a time, and recent results. */
  mergeQueue: QueueEntry[];
  /** What needs the person now, most urgent first. */
  alerts: Alert[];
  team: TeamState;
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
  | "comment.updated"
  | "goal.updated"
  | "queue.updated"
  | "agent.reviewed"
  | "team.updated"
  | "audit.added"
  | "core.log";

export interface CoreEvent<T = unknown> {
  seq: number;
  ts: string;
  type: CoreEventType;
  data: T;
}

/** A reviewer agent finished reviewing another agent's changes. */
export interface AgentReviewedEvent {
  reviewerId: string;
  targetId: string;
  summary: string;
  comments: number;
  /** Comments that could not be placed (unknown file or line). */
  skipped: number;
  error?: string;
}

export interface AgentOutputEvent {
  agentId: string;
  kind: "message" | "thought" | "tool" | "plan" | "stderr" | "turn";
  text: string;
  /** For "turn": what happened. "followup" is the turn that carries guidance. */
  phase?: "prompt" | "guidance" | "followup" | "end" | "checkpoint" | "rewind";
  /** For "turn" with phase "checkpoint": the snapshot taken before the turn. */
  checkpoint?: string;
  /** For "turn" with phase "guidance". */
  mode?: "now" | "next";
  guidance?: string;
  /** For "turn" with phase "end". */
  stopReason?: string;
  error?: string;
  /** For "tool": the call as it is now. */
  tool?: ToolCallSummary;
}

/**
 * One entry of an agent's conversation, as the agent-detail view shows it.
 * Kept per agent in `.synapse/transcripts/`, redacted and capped.
 */
export interface TranscriptEntry {
  /** Increasing per agent. */
  n: number;
  at: string;
  kind: "prompt" | "guidance" | "message" | "thought" | "tool" | "end" | "rewind" | "review";
  text: string;
  /** prompt: the task the agent was working on. */
  taskId?: string;
  /** prompt: a follow-up turn carrying guidance. */
  followup?: boolean;
  /** prompt: the worktree as it was before this turn (agents.rewind goes back to it). */
  checkpoint?: string;
  /** guidance: when the agent gets it. */
  mode?: "now" | "next";
  /** tool */
  toolId?: string;
  toolKind?: string;
  status?: ToolCallSummary["status"];
  locations?: string[];
  /** review: the reviewer agent's id, and how many comments it left (text is its summary). */
  reviewer?: string;
  comments?: number;
  /** end */
  stopReason?: string;
  error?: string;
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
  /**
   * Credentials the agent must get from its environment (the agent's own env
   * or the core's): at least one of these variables must be set before it
   * starts. Used where the vendor's terms require API-key authentication for
   * third-party tools.
   */
  requiresEnv?: { anyOf: string[]; reason: string };
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
  /**
   * Gives a working agent guidance from the person. "now" interrupts the turn
   * and continues it with the guidance; "next" (default) sends it as soon as
   * the turn ends. Either way the agent's task stays in progress. An idle
   * agent gets it as a normal prompt.
   */
  "agents.steer": { params: { id: string; text: string; mode?: "now" | "next" }; result: AgentState };
  /**
   * Another agent takes over unfinished work: `from` is stopped at its current
   * point, its work (including uncommitted changes) moves into `to`'s
   * worktree, the task is reassigned, and `to` continues it with a summary of
   * what was done. `to` must be running, idle and without changes of its own.
   */
  /** The agent's changes against its base as hunks (refreshes its snapshot first). */
  "agents.diff": { params: { id: string; path?: string }; result: AgentDiff };
  /** The agent's conversation, oldest first. `from` returns entries from that `n` on (pass the newest `n` you have: it may still be growing). */
  "agents.transcript": { params: { id: string; from?: number; limit?: number }; result: TranscriptEntry[] };
  /** Puts the agent's worktree back to how it was before the turn that starts at transcript entry `n`. */
  /** Runs testCommand in the agent's worktree now. */
  "agents.test": { params: { id: string }; result: AgentState };
  "agents.rewind": { params: { id: string; n: number }; result: AgentState };
  "comments.list": { params: { agentId?: string } | void; result: CodeComment[] };
  /**
   * Comments on lines of an agent's changes. `action` "guidance" also gives it
   * to the agent (as with agents.steer, after its turn); "task" turns it into a
   * task for that agent; "note" (default) keeps it for the person.
   */
  "comments.add": {
    params: { agentId: string; path: string; line: number; endLine?: number; text: string; action?: CodeComment["action"] };
    result: CodeComment;
  };
  "team.status": { params: void; result: TeamState };
  /** Publishes this person's agents to the remote and fetches teammates'. Needs team mode enabled. */
  /** Turns team mode on for this clone (written to `.synapse/config.json`, which is not committed) and syncs. */
  "team.enable": { params: { name?: string; remote?: string }; result: TeamState };
  "team.sync": { params: void; result: TeamState };
  /** Removes everything this person published from the remote. */
  "team.leave": { params: void; result: TeamState };
  /**
   * Continues a teammate's agent's work in one of yours: its latest published
   * snapshot moves into your agent's worktree, a task is created from theirs,
   * your agent is briefed, and a claim tells the teammate. Your agent must be
   * running, idle and without changes of its own. Needs the editor role.
   */
  "team.adopt": { params: { from: string; to: string; note?: string }; result: TakeoverResult };
  /** Dismisses a teammate's claim on one of your agents. */
  "team.dismissClaim": { params: { id: string }; result: TeamState };
  "comments.resolve": { params: { id: string; status?: CodeComment["status"] }; result: CodeComment };
  /** Gives a note (e.g. a reviewer agent's) to its agent as guidance after its turn. */
  "comments.tell": { params: { id: string }; result: CodeComment };
  /** Another agent reviews this agent's changes (changing no files) and leaves line comments on them. */
  "agents.review": { params: { reviewerId: string; targetId: string }; result: AgentState };
  "agents.takeover": { params: { from: string; to: string; taskId?: string; note?: string }; result: TakeoverResult };
  /** Throws the agent's worktree back to a ref (default: the current base). */
  "agents.reset": { params: { id: string; ref?: string }; result: AgentState };

  "ownership.get": { params: { agentId?: string }; result: AgentOwnership[] };
  "ownership.refresh": { params: { agentId?: string }; result: AgentOwnership[] };
  /** Markers for a file in the human's workspace (repo-relative or absolute path). */
  "ownership.forFile": { params: { path: string; content?: string }; result: FileMarker[] };

  "conflicts.list": { params: void; result: Conflict[] };
  "conflicts.check": { params: void; result: Conflict[] };
  /** Gives one agent in the conflict guidance about it (after its turn; a prompt when idle). */
  "conflicts.tell": { params: { id: string; agentId: string }; result: AgentState };

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
    params: { title: string; description?: string; agentId?: string; dependsOn?: string[]; scope?: string[]; autoStart?: boolean; planFirst?: boolean };
    result: Task;
  };
  "tasks.update": {
    params: { id: string; title?: string; description?: string; agentId?: string | null; dependsOn?: string[]; scope?: string[]; autoStart?: boolean; planFirst?: boolean };
    result: Task;
  };
  "tasks.remove": { params: { id: string }; result: null };
  /** Sends the task to its agent, with dependencies' handoffs and accepted decisions as context. */
  "tasks.start": { params: { id: string }; result: Task };
  /** The person's verdict. "done" hands off to dependent tasks and may auto-start them. */
  "tasks.setStatus": { params: { id: string; status: TaskStatus }; result: Task };
  /** Approves a proposed plan (optionally edited) and lets the agent carry it out. */
  /** Asks an agent to split a goal into tasks (it changes no files); the result waits for the person. */
  /** Queues an agent's work to be merged on its own: prepared on the current base, tested, merged only when green. */
  "queue.add": { params: { agentId: string; taskId?: string }; result: QueueEntry };
  "queue.remove": { params: { id: string }; result: QueueEntry };
  /** Puts a failed entry back in the queue. */
  "queue.retry": { params: { id: string }; result: QueueEntry };
  "goals.split": { params: { goal: string; agentId: string }; result: GoalSplit };
  /** Creates the proposed tasks (optionally edited, a subset, or with other agents) with their dependencies. */
  "goals.accept": { params: { id: string; tasks?: ProposedTask[]; autoStart?: boolean; planFirst?: boolean }; result: Task[] };
  "goals.discard": { params: { id: string }; result: GoalSplit };
  "tasks.approvePlan": { params: { id: string; plan?: string }; result: Task };
  /** Sends the plan back to the agent with the person's feedback; it plans again. */
  "tasks.revisePlan": { params: { id: string; feedback: string }; result: Task };

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
    params: { title: string; decision: string; rationale?: string; tags?: string[]; supersedes?: string; status?: Decision["status"]; pins?: DecisionPin[] };
    result: Decision;
  };
  "decisions.resolve": { params: { id: string; status: "accepted" | "rejected" | "superseded" }; result: Decision };
  /**
   * Pins a decision to a file or symbol, fingerprinted on the base branch.
   * With `line` (0-based) and no `symbol`, the innermost symbol at that line
   * of the file in the main checkout is used.
   */
  "decisions.pin": { params: { id: string; path: string; symbol?: string; line?: number }; result: Decision };
  "decisions.unpin": { params: { id: string; path: string; symbol?: string }; result: Decision };
  /** The person confirms the decision still holds for the code as it is now: re-fingerprints every anchor at the base branch. */
  "decisions.repin": { params: { id: string }; result: Decision };

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
  "agent.proposeDecision": { params: { title: string; decision: string; rationale?: string; tags?: string[]; pins?: DecisionPin[] }; result: Decision };
  /** The agent reports its task finished; the person still confirms it. */
  "agent.completeTask": { params: { taskId: string; summary: string }; result: Task };
}
