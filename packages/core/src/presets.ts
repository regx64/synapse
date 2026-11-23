import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { PresetInfo } from "@synapse/protocol";
import type { SynapseConfig } from "./config.js";

/**
 * Agent presets. Versions are pinned on purpose (risk T3): bump them together
 * with the nightly compatibility test, not implicitly.
 *
 * Only official ACP paths are used (risk L5): each adapter runs the vendor's
 * own agent with the user's own credentials. Synapse never pays for, proxies
 * or handles model credentials. See docs/agent-terms.md for the vendor terms
 * behind each preset.
 */
const BUILTIN: PresetInfo[] = [
  {
    id: "claude",
    name: "Claude",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.109.1"],
    color: "#d97757",
    notes: "Claude through its ACP adapter (built on the Claude Agent SDK). Needs your own ANTHROPIC_API_KEY, or Amazon Bedrock / Google Vertex AI credentials.",
    // Anthropic does not allow third-party tools built on the Agent SDK to
    // offer Claude.ai (subscription) login; they must use API keys.
    requiresEnv: {
      anyOf: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"],
      reason:
        "Anthropic's terms require tools built on the Claude Agent SDK to use API-key authentication, not a Claude subscription login. Set ANTHROPIC_API_KEY (from the Claude Console), or CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX with that provider's credentials.",
    },
  },
  {
    id: "codex",
    name: "Codex",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@2.9.0"],
    color: "#10a37f",
    notes: "Codex through its ACP adapter. Uses OPENAI_API_KEY (or CODEX_API_KEY), or the sign-in you made with Codex's own CLI; Synapse never handles it.",
  },
  {
    id: "gemini",
    name: "Gemini",
    command: "gemini",
    args: ["--experimental-acp"],
    color: "#4285f4",
    notes: "Gemini CLI in ACP mode (needs `gemini` on PATH). Not part of the MVP: a third agent is out of scope until G2.",
  },
];

function mockAgentMain(): string | undefined {
  // Bundled next to the core (IDE build).
  const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), "mock-agent.mjs");
  if (fs.existsSync(bundled)) return bundled;
  try {
    const pkg = createRequire(import.meta.url).resolve("@synapse/mock-agent/package.json");
    return path.join(path.dirname(pkg), "dist", "src", "main.js");
  } catch {
    return undefined;
  }
}

function mockPreset(): PresetInfo | undefined {
  const main = mockAgentMain();
  if (!main) return undefined;
  return {
    id: "mock",
    name: "Mock",
    command: process.execPath,
    args: [main],
    color: "#a855f7",
    notes: "Scripted ACP agent for tests and demos. Replays steps; never calls a model.",
  };
}

export function listPresets(config: SynapseConfig): PresetInfo[] {
  const all = [...BUILTIN];
  const mock = mockPreset();
  if (mock) all.push(mock);
  return all.map((p) => {
    const o = config.presets?.[p.id];
    return o ? { ...p, ...o, args: o.args ?? p.args } : p;
  });
}
