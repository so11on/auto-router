# Decisions

Short ADR-style log. Date format: ISO.

## 2026-10-20 — LiteLLM as the gateway, custom hook as the brain
Needed: three Cursor-style Auto modes that look at the task, set effort and fall back across providers.
- FreeLLMAPI: free tiers only; routes by live model scores, not by prompt; Anthropic is an inbound API only. Rejected.
- OmniRoute alone: huge provider catalogue and tiers, but no per-prompt complexity routing found in its docs; modes would be
  fixed combos. Kept only as the free-provider pool.
- OpenRouter Auto / RouteLLM / Arch-Router / vLLM semantic router: per-prompt routing exists but none gives three modes plus
  effort plus our provider mix. Arch-Router remains a candidate to replace the classifier later.
- claude-code-router: routes by scenario inside Claude Code only; the target UI is Copilot Chat.
- Chosen: LiteLLM proxy (fallbacks, OpenAI/Responses/Anthropic endpoints) + a ~200-line pre-call hook.

## 2026-10-20 — Modes, classifier and tables are data
`routing.yaml` holds the mode → tier table, so tuning needs no code change. The classifier is an ordinary LiteLLM model
string. Complexity is 1-5; `task_bump` shifts it per task type.

## 2026-10-20 — Sticky, escalate-only conversations
Agent loops send many requests per user turn and switching model mid-loop loses prompt caches and breaks tool-call formats.
Tool-result turns reuse the previous decision; new user turns may only raise complexity.

## 2026-10-20 — Free means free
`auto-free` never falls back to paid keys. Two separate Gemini keys exist (billed vs free-tier) because the API cannot
mark a key. The billed key was detected by bursting 30 requests (all passed, including Pro).

## 2026-10-20 — Explicit OmniRoute combos instead of `auto/*`
`auto/best-free` picked `allam-2-7b` (an Arabic-centred model) and `auto/*` ids sometimes selected providers needing a
headless browser, hanging for minutes. Explicit priority combos (`free-fast`, `free-coding`) over tested models fixed both.
Pool entries in LiteLLM have a 15 s timeout.

## 2026-10-20 — Claude through the CLI by default
The Anthropic API account had no credits, and a subscription cannot be used as an API key. Chosen: a host-side bridge that
runs `claude -p`. Because Claude Code edits files itself, it is not a drop-in model: the bridge records actions in the
reply, replays missed context, and the hook adds a handoff note. `CLAUDE_PRIMARY` flips between CLI and API, each being the
other's fallback.

## 2026-10-20 — Bridge hardening
After an agent-with-shell design was flagged as unsafe, the bridge got: required key, loopback bind, allowed roots,
no shell by default, `plan` mode for requests without tools. The LaunchAgent for autostart was deliberately not installed.

## 2026-10-20 — Usage log, report on demand
A hook callback appends one JSONL row per call; ``ar.mjs usage`` reports shares and known quota use only when run.
Quotas are shown only where a number was verified. Found while testing: sourcing `.env` into the bridge leaked
`ANTHROPIC_API_KEY` to the CLI, which then used the empty API account; the bridge now strips Anthropic variables.

## 2026-10-20 — LLM7 added for DeepSeek
Only keyless source of a DeepSeek model that passed a real prompt. Placed after Groq/Mistral so it is a fallback, not the
default. Other candidates are listed in FREE-TIER-LIMITS.md.

## 2026-10-20 — Mid-answer failover is ours, not LiteLLM's
LiteLLM 1.106 re-raises when a stream fails after content was produced (it only falls back before the first token). The hook
therefore continues the answer itself using the router's fallback chain, and the user is told in the output. Verified with a
deliberately broken stream.

## 2026-10-20 — Prune unstable models
Removed from the active lists: Gemini free Flash models (5-20 req/min, 403/429/503 bursts) and Gemma (HTTP 500), OpenRouter Gemma-4-31b (10 s),
Mistral small/medium/devstral/large (429/403), retired or paid-only Ollama/NVIDIA models. See FREE-TIER-LIMITS.md for the reasons.
The Gemini free flash-lite stays as the last free fallback: slow (~20 s) but stable.

## 2026-10-20 — VS Code: Chat Completions, key in requestHeaders
Official docs make `chat-completions` the default API type, which is the only streaming format with mid-answer failover. The key could not go in
`apiKey`: a hand-written `${input:...}` is never prompted and a literal string is ignored (captured header was a bare `Bearer`). `requestHeaders`
with an explicit `Authorization` per model works and is documented. Accepted trade-off: plain-text loopback key in a mode-600 file.

## 2026-10-20 — Footer with the answering model
VS Code's "Response details" popup cannot be copied, so each final answer ends with a one-line footer. Held-back finish chunk keeps stream semantics;
footers are stripped from model history to avoid imitation. Provider name taken from OmniRoute response headers.

## 2026-10-20 — Claude Code updated to 2.1.304
Opus 5.5 returned HTTP 400 "Claude Code 2.1.72 does not support this model; version 2.1.280 or newer is required" through the bridge. `claude update`
(→ 2.1.304) fixed it; haiku, sonnet and opus then answered. The bridge must be restarted after an update.

## 2026-10-24 — OpenAI: same two-route pattern as Claude
ChatGPT Plus/Pro has no API access, so a plan can only be used through OpenAI's own terminal tool (Codex CLI, `codex exec --json`). `gpt-*-cli` goes through the bridge, `gpt-*-api` through the OpenAI API;
`OPENAI_PRIMARY` picks the first, each is the other's fallback. Model ids are never hard-coded: `node ar.mjs openai` writes them after a verifying request. The Codex route has no session resume (fresh session per turn with a replayed transcript).
Profiles E and F use OpenAI instead of Claude.

## 2026-10-24 — Cloudflare finally working; ids verified, token minted
Both ids pasted from Cloudflare's dashboard assistant were not the problem: the Account ID was right, the **token** only had "API Tokens Write" (a create-tokens token), hence "Authentication error" everywhere.
With the owner's consent the token was used once to create `auto-router-workers-ai` (Workers AI Read+Write on that account). `node ar.mjs cloudflare-token` now automates that repair; `node ar.mjs keys --check` diagnoses it.

## Open items
- Check Agent-mode edits on each `Auto:` model in the editor.
- Verify the Codex route with a real `codex` install (event shapes, `-m`, `-c model_reasoning_effort`).
- Extend mid-stream continuation to the Responses and Anthropic Messages streaming formats if the VS Code endpoint uses them.
- Buy Anthropic API credits if the API route is wanted.
- Consider Arch-Router as a local classifier to cut the ~1-2 s classification latency and the dependency on Google.
- Measure daily quotas of free providers.
