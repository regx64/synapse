# Agent vendors' terms (risk L5)

What the vendors' published terms say about a tool like Synapse, and what
Synapse does because of it. Read on 2026-11-23; re-read before each release
and whenever a preset's adapter is bumped. This is a reading of the texts,
not legal advice.

Synapse is a free, MIT-licensed tool. It runs each vendor's ACP adapter as a
child process on the user's machine; it does not bundle, modify or host the
vendors' agents, and it never handles, stores or forwards model credentials.

## Claude (Anthropic)

Adapter: `@agentclientprotocol/claude-agent-acp` (Apache-2.0, built on the
Claude Agent SDK).

- **Login.** The Agent SDK documentation: "Unless previously approved,
  Anthropic does not allow third party developers to offer claude.ai login or
  rate limits for their products, including agents built on the Claude Agent
  SDK. Use the API key authentication methods [...] instead."
  ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)).
  Claude Code's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance)
  says the same for products "including those using the Agent SDK", and that
  developers may not route requests through Free, Pro, Max or Ultra plan
  credentials on their users' behalf, or collect or intermediate Claude.ai
  credentials.
- **Bundling.** Preinstalling or running Claude Code inside a product requires
  Anthropic's Commercial Terms and an unmodified binary. Synapse does not ship
  it: `npx` fetches the adapter from npm when the user starts the agent.
- **Names.** "Claude" is fine as the name of an agent in a list of agents;
  "Claude Code" must not be used as the name of a product or feature, and the
  product must not look like an Anthropic product.
- **Usage terms.** API-key use falls under Anthropic's
  [Commercial Terms](https://www.anthropic.com/legal/commercial-terms)
  (effective 2025-06-17) between Anthropic and the user who owns the key.

**What Synapse does:** the Claude preset needs `ANTHROPIC_API_KEY`, or
`CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` with that provider's
credentials, and refuses to start without one (`requiresEnv` in
`packages/core/src/presets.ts`). It does not offer or document a Claude
subscription login. Changing that needs Anthropic's written approval.

## Codex (OpenAI)

Adapter: `@agentclientprotocol/codex-acp` (Apache-2.0). The earlier
`@zed-industries/codex-acp` is deprecated and its repository archived.

- **Login.** The adapter supports an API key (`OPENAI_API_KEY` or
  `CODEX_API_KEY`) and the user's own ChatGPT sign-in made through Codex.
  OpenAI's [Codex authentication docs](https://developers.openai.com/codex/auth)
  and [Terms of Use](https://openai.com/policies/terms-of-use/) (effective
  2026-01-01) say nothing for or against third-party clients of Codex. For
  open-source, locally run apps that want to use a ChatGPT plan, OpenAI
  documents a separate flow,
  ["Sign in with ChatGPT" plan usage](https://developers.openai.com/siwc/token-sharing-open-source),
  which Synapse does not implement yet.
- **Terms that apply.** No sharing of account credentials; no circumventing
  rate limits or safety measures; no modifying, copying or distributing
  OpenAI's services. Synapse does none of these: Codex runs unmodified with
  the user's own sign-in or key.
- **Names.** OpenAI's names and logos only per its
  [brand guidelines](https://openai.com/brand/).
- **Notices.** Codex is Apache-2.0 with a NOTICE file. Synapse does not
  redistribute Codex; if it ever bundles it, the NOTICE must ship.

**What Synapse does:** the Codex preset uses the maintained adapter and an
API key or the user's own Codex sign-in. Synapse never reads, stores or
passes on that sign-in. If OpenAI says otherwise, switch the preset to API
keys only (`requiresEnv`, as for Claude).

## Open items

- Anthropic: written approval would be needed to let users use a Claude
  subscription through Synapse.
- OpenAI: confirm that using the user's own Codex sign-in through the ACP
  adapter is fine, or implement the "Sign in with ChatGPT" flow.
- Gemini CLI (not an MVP preset): read Google's terms before promoting it.
