import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentOwnership, AgentState, FileChange, TeamAgent, TeamClaim, TeamPeer, TeamState } from "@synapse/protocol";
import { ErrorCodes, RpcError } from "@synapse/protocol";
import type { SynapseConfig } from "./config.js";
import { git, runGit } from "./git.js";
import { analyzeSnapshot, type FileDetail } from "./ownership.js";
import type { StateStore } from "./store.js";
import { debounce, nowIso, randomId } from "./util.js";

/**
 * Team mode: several people, each with their own Synapse and agents, on one
 * repository. There is no server; the shared git remote carries it all:
 *
 *   refs/synapse/team/<person>/lane            a commit with lane.json: who,
 *                                               which agents, what they change
 *   refs/synapse/team/<person>/agents/<id>     each agent's latest snapshot
 *
 * Every Synapse publishes its own refs and fetches the others into
 * refs/synapse/peers/. Teammates' agents are then part of conflict detection
 * (same symbol, signature change, textual conflicts) and shown read-only.
 *
 * Off by default: publishing pushes unfinished code to the remote, like
 * pushing a branch. Lanes from teammates are data, never instructions.
 */

const TEAM = "refs/synapse/team";
const PEERS = "refs/synapse/peers";
const STALE_MS = 10 * 60 * 1000;
const MAX_LANE_BYTES = 2 * 1024 * 1024;

interface Lane {
  version: 1;
  person: string;
  updatedAt: string;
  baseRef: string;
  agents: { agentId: string; name: string; color: string; status: AgentState["status"]; task?: string; baseCommit: string; snapshot?: string; files: FileChange[] }[];
  /** Teammates' agents this person continued (team.adopt). */
  claims?: TeamClaim[];
}

/** What this person keeps between runs: claims they made, and teammates' claims they dismissed. */
interface TeamFile {
  claims: TeamClaim[];
  dismissed: string[];
}

export interface TeamDeps {
  store: StateStore;
  config: () => SynapseConfig;
  log: (msg: string) => void;
  /** Called after teammates' agents changed, so conflicts are checked again. */
  onPeersChanged: () => void;
}

export interface PeerAgent {
  agent: Pick<AgentState, "id" | "name" | "color">;
  ownership: AgentOwnership;
  details: Map<string, FileDetail>;
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

export class TeamService {
  private person = "";
  private timer?: NodeJS.Timeout;
  private readonly analyses = new Map<string, { files: FileChange[]; details: Map<string, FileDetail> }>();
  private peerAgents: PeerAgent[] = [];
  private syncing?: Promise<TeamState>;
  private saved: TeamFile = { claims: [], dismissed: [] };
  /** Publish soon after local work changes, at most every 15 s. */
  readonly syncSoon = debounce(() => void this.sync().catch(() => {}), 15_000);

  constructor(private readonly deps: TeamDeps) {}

  private get store(): StateStore {
    return this.deps.store;
  }

  private settings() {
    const t = this.deps.config().team ?? {};
    return { enabled: !!t.enabled, remote: t.remote || "origin", intervalSec: Math.max(15, t.intervalSec ?? 60), name: t.name, members: t.members ?? {} };
  }

  role(): TeamState["role"] {
    return this.settings().members[this.person] === "viewer" ? "viewer" : "editor";
  }

  private file(): string | undefined {
    return this.store.dataDir ? path.join(this.store.dataDir, "team.json") : undefined;
  }

  private save(): void {
    const f = this.file();
    if (!f) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(this.saved, null, 2));
  }

  /** Records that one of this person's agents continued a teammate's agent's work; published with the next sync. */
  addClaim(c: Omit<TeamClaim, "id" | "by" | "at">): TeamClaim {
    const claim: TeamClaim = { ...c, id: randomId("claim"), by: this.person, at: nowIso() };
    this.saved.claims = [...this.saved.claims.filter((x) => x.agent !== c.agent), claim].slice(-200);
    this.save();
    this.syncSoon();
    return claim;
  }

  dismissClaim(id: string): TeamState {
    const t = this.store.getTeam();
    if (!t.claimsOnMe.some((c) => c.id === id)) throw new RpcError(ErrorCodes.NotFound, `No claim "${id}"`);
    this.saved.dismissed = [...this.saved.dismissed, id].slice(-500);
    this.save();
    this.store.setTeam({ ...t, claimsOnMe: t.claimsOnMe.filter((c) => c.id !== id) });
    return this.store.getTeam();
  }

  /** Resolves who this person is and starts syncing if team mode is on. */
  async start(): Promise<void> {
    const s = this.settings();
    const fromGit = (await runGit(this.store.repoRoot, ["config", "user.name"])).stdout.trim();
    this.person = slug(s.name || fromGit || os.userInfo().username) || "me";
    try {
      const f = this.file();
      if (f && fs.existsSync(f)) this.saved = { claims: [], dismissed: [], ...JSON.parse(fs.readFileSync(f, "utf8")) };
    } catch {
      /* start fresh */
    }
    this.store.setTeam({ ...this.store.getTeam(), enabled: s.enabled, person: this.person, role: this.role(), remote: s.remote });
    if (!s.enabled) return;
    this.timer = setInterval(() => void this.sync().catch(() => {}), s.intervalSec * 1000);
    this.timer.unref();
    void this.sync().catch(() => {});
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.syncSoon.cancel();
  }

  status(): TeamState {
    return this.store.getTeam();
  }

  /** A teammate's agent as last fetched. */
  peerAgent(id: string): TeamAgent | undefined {
    return this.store
      .getTeam()
      .peers.flatMap((p) => p.agents)
      .find((a) => a.id === id);
  }

  /** Teammates' agents for conflict detection. */
  peers(): PeerAgent[] {
    return this.peerAgents;
  }

  async sync(): Promise<TeamState> {
    const s = this.settings();
    if (!s.enabled) throw new RpcError(ErrorCodes.InvalidParams, 'Team mode is off. Set "team": { "enabled": true } in synapse.config.json.');
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        // Viewers only watch: nothing of theirs is published.
        if (this.role() === "editor") await this.publish(s.remote);
        const { peers, claimsOnMe } = await this.fetchPeers(s.remote);
        this.store.setTeam({ enabled: true, person: this.person, role: this.role(), remote: s.remote, lastSync: nowIso(), peers, claimsOnMe });
        this.deps.onPeersChanged();
      } catch (err) {
        const message = (err as Error).message.split("\n")[0]!.slice(0, 300);
        this.store.setTeam({ ...this.store.getTeam(), enabled: true, person: this.person, remote: s.remote, error: message });
        this.deps.log(`team sync failed: ${message}`);
      } finally {
        this.syncing = undefined;
      }
      return this.store.getTeam();
    })();
    return this.syncing;
  }

  /** Deletes everything this person published. */
  async leave(): Promise<TeamState> {
    const remote = this.settings().remote;
    const mine = await this.remoteRefs(remote, `${TEAM}/${this.person}/`);
    if (mine.length) await git(this.store.repoRoot, ["push", "--quiet", remote, ...mine.map((r) => `:${r}`)]);
    this.store.setTeam({ ...this.store.getTeam(), lastSync: nowIso() });
    return this.store.getTeam();
  }

  private async remoteRefs(remote: string, prefix: string): Promise<string[]> {
    const out = await git(this.store.repoRoot, ["ls-remote", "--refs", remote, `${prefix}*`]);
    return out
      .split("\n")
      .map((l) => l.split("\t")[1])
      .filter((r): r is string => !!r && r.startsWith(prefix));
  }

  /** Pushes this person's lane and agent snapshots; removes refs of agents that are gone. */
  private async publish(remote: string): Promise<void> {
    const repo = this.store.repoRoot;
    const agents = this.store.listAgents();
    const lane: Lane = {
      version: 1,
      person: this.person,
      updatedAt: nowIso(),
      baseRef: this.store.baseRef,
      agents: agents.map((a) => {
        const own = this.store.getOwnership(a.id);
        const task = a.currentTaskId ? this.store.getTask(a.currentTaskId)?.title : undefined;
        return { agentId: a.id, name: a.name, color: a.color, status: a.status, task, baseCommit: a.worktree.baseCommit, snapshot: own?.snapshot, files: own?.files ?? [] };
      }),
      claims: this.saved.claims,
    };
    const blob = await git(repo, ["hash-object", "-w", "--stdin"], { input: JSON.stringify(lane) });
    const tree = await git(repo, ["mktree"], { input: `100644 blob ${blob}\tlane.json\n` });
    const laneCommit = await git(repo, ["commit-tree", tree, "-m", `Synapse lane of ${this.person}`], {
      env: { GIT_AUTHOR_NAME: "Synapse", GIT_AUTHOR_EMAIL: "synapse@localhost", GIT_COMMITTER_NAME: "Synapse", GIT_COMMITTER_EMAIL: "synapse@localhost" },
    });
    const prefix = `${TEAM}/${this.person}/`;
    const specs = [`+${laneCommit}:${prefix}lane`];
    for (const a of lane.agents) if (a.snapshot) specs.push(`+${a.snapshot}:${prefix}agents/${a.agentId}`);
    const keep = new Set(lane.agents.filter((a) => a.snapshot).map((a) => `${prefix}agents/${a.agentId}`));
    const existing = await this.remoteRefs(remote, `${prefix}agents/`);
    for (const r of existing) if (!keep.has(r)) specs.push(`:${r}`);
    await git(repo, ["push", "--quiet", "--no-verify", remote, ...specs]);
  }

  /** Fetches teammates' lanes and snapshots and analyzes what their agents change. */
  private async fetchPeers(remote: string): Promise<{ peers: TeamPeer[]; claimsOnMe: TeamClaim[] }> {
    const repo = this.store.repoRoot;
    await git(repo, ["fetch", "--quiet", "--prune", "--no-tags", remote, `+${TEAM}/*:${PEERS}/*`]);
    const lanes = (await git(repo, ["for-each-ref", "--format=%(refname)", `${PEERS}/`]))
      .split("\n")
      .filter((r) => /\/lane$/.test(r));
    const peers: TeamPeer[] = [];
    const peerAgents: PeerAgent[] = [];
    const claims: TeamClaim[] = [...this.saved.claims];
    for (const ref of lanes) {
      const person = ref.slice(PEERS.length + 1, -"/lane".length);
      if (!person || person === this.person || person.includes("/")) continue;
      const lane = await this.readLane(ref);
      if (!lane) continue;
      for (const c of lane.claims ?? []) if (c.by === person) claims.push(c);
      const agents: TeamAgent[] = [];
      for (const a of lane.agents.slice(0, 50)) {
        const id = `@${person}/${a.agentId}`;
        const t: TeamAgent = { id, person, agentId: a.agentId, name: `${a.name} (${person})`, color: a.color, status: a.status, task: a.task, baseRef: lane.baseRef, baseCommit: a.baseCommit, snapshot: a.snapshot, files: a.files };
        agents.push(t);
        if (!a.snapshot || a.snapshot === a.baseCommit) continue;
        // Analyze from the fetched objects (the lane's file list is only shown, not trusted for conflicts).
        const key = `${a.baseCommit}..${a.snapshot}`;
        let analysis = this.analyses.get(key);
        if (!analysis) {
          analysis = await analyzeSnapshot(repo, a.baseCommit, a.snapshot).catch(() => undefined);
          if (!analysis) continue;
          this.analyses.set(key, analysis);
          if (this.analyses.size > 200) this.analyses.delete(this.analyses.keys().next().value!);
        }
        peerAgents.push({ agent: { id, name: t.name, color: t.color }, ownership: { agentId: id, files: analysis.files, snapshot: a.snapshot, updatedAt: lane.updatedAt }, details: analysis.details });
      }
      peers.push({ person, updatedAt: lane.updatedAt, stale: Date.now() - Date.parse(lane.updatedAt) > STALE_MS, agents });
    }
    this.peerAgents = peerAgents;
    // Latest claim per agent; mark claimed teammates' agents, and collect claims on this person's agents.
    const latest = new Map<string, TeamClaim>();
    for (const c of claims.sort((a, b) => a.at.localeCompare(b.at))) latest.set(c.agent, c);
    for (const p of peers) for (const a of p.agents) a.claimedBy = latest.get(a.id)?.by;
    const claimsOnMe = [...latest.values()].filter((c) => c.agent.startsWith(`@${this.person}/`) && c.by !== this.person && !this.saved.dismissed.includes(c.id));
    return { peers: peers.sort((a, b) => a.person.localeCompare(b.person)), claimsOnMe };
  }

  private async readLane(ref: string): Promise<Lane | undefined> {
    const r = await runGit(this.store.repoRoot, ["show", `${ref}:lane.json`]);
    if (r.code !== 0 || r.stdout.length > MAX_LANE_BYTES) return undefined;
    try {
      const lane = JSON.parse(r.stdout) as Lane;
      const sha = /^[0-9a-f]{40,64}$/;
      if (lane.version !== 1 || !Array.isArray(lane.agents) || typeof lane.updatedAt !== "string") return undefined;
      lane.agents = lane.agents.filter(
        (a) => a && typeof a.agentId === "string" && /^[a-z0-9-]{1,40}$/.test(a.agentId) && typeof a.name === "string" && sha.test(a.baseCommit) && (a.snapshot === undefined || sha.test(a.snapshot)),
      );
      for (const a of lane.agents) {
        a.name = a.name.slice(0, 60);
        a.color = /^#[0-9a-fA-F]{3,8}$/.test(a.color) ? a.color : "#888888";
        a.task = typeof a.task === "string" ? a.task.slice(0, 200) : undefined;
        a.files = Array.isArray(a.files) ? a.files.slice(0, 500) : [];
      }
      lane.claims = (Array.isArray(lane.claims) ? lane.claims : [])
        .filter((c) => c && typeof c.id === "string" && typeof c.by === "string" && typeof c.agent === "string" && /^@[a-z0-9-]+\/[a-z0-9-]+$/.test(c.agent) && typeof c.at === "string")
        .slice(-200)
        .map((c) => ({ id: c.id.slice(0, 60), by: c.by.slice(0, 40), byAgent: String(c.byAgent ?? "").slice(0, 40), agent: c.agent, task: typeof c.task === "string" ? c.task.slice(0, 200) : undefined, at: c.at }));
      return lane;
    } catch {
      return undefined;
    }
  }
}
