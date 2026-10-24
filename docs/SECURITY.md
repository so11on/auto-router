# Security

## Secrets
- All secrets live in `.env` (`chmod 600`, git-ignored). `.env.example` lists names only.
- `.env` holds: LiteLLM master key, Anthropic key, billed and free Gemini keys, OmniRoute password and API key,
  free-provider keys, bridge key. Treat the billed Gemini key and the Anthropic key as spendable.
- Never put the billed Gemini key in `GEMINI_FREE_API_KEY`: `auto-free` would spend money.
- OmniRoute encrypts stored provider keys (AES-256-GCM) in the `omniroute-data` Docker volume.

## Network exposure
| Service | Bind | Auth |
|---|---|---|
| LiteLLM `:4000` | `127.0.0.1` only (`"127.0.0.1:4000:4000"`) | bearer `LITELLM_MASTER_KEY` |
| OmniRoute `:20128` | `127.0.0.1` only | `REQUIRE_API_KEY=true` + dashboard password |
| claude-bridge `:4100` | `127.0.0.1` only | bearer `BRIDGE_KEY` (required) |

All three services are loopback-only. Opening LiteLLM to the LAN means removing `127.0.0.1:` from the port mapping; do that only behind a trusted network and keep the master key long.

## claude-bridge permissions
It lets HTTP requests drive an agent that can edit files. Mitigations: required key, loopback bind, `BRIDGE_ALLOWED_ROOTS`
(required, no default), no shell by default (`BRIDGE_ALLOWED_TOOLS` empty), `plan` mode for requests without tools,
10-minute kill timeout. Widening `BRIDGE_ALLOWED_TOOLS` or the roots widens what a request can do; do it knowingly.
Anything able to reach `127.0.0.1:4100` with the key can edit files in the allowed roots.

## Terms of service
- **Claude subscription.** Anthropic's published position, as reported by secondary sources in 2026 (not verified against
  the primary policy), is that Pro/Max OAuth tokens are for Claude Code and Claude.ai only, and third-party tools must use
  API keys. The bridge never extracts or forwards the token: it runs the official `claude` binary as you. That is
  not guaranteed to be accepted if Anthropic treats automated wrappers as a violation. Read Anthropic's current Claude Code
  legal page before relying on it; set `CLAUDE_PRIMARY=api` to avoid the question.
- **Free tiers.** Each provider sets its own terms (some forbid relaying, some log prompts). OmniRoute marks risky ones
  (`tos: avoid`) and excludes them from `auto/*`. Prompts sent to free tiers (Gemini free tier, OpenRouter free models)
  may be used by the provider for training or review; do not route confidential code through `auto-free`.

## Data flow
Prompts go to whichever provider the mode selects: Google (classifier on every new user turn, and Gemini models),
Groq, OpenRouter, Mistral, Anthropic (through Claude Code or the API). The classifier receives the first 4000
characters of each new user message.
