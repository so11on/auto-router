# Decisions

Short ADR-style log. Date format: ISO.

## 2026-10-20 — LiteLLM as the gateway, custom hook as the brain
Needed: three Cursor-style Auto modes that look at the task, set effort and fall back across providers.
- FreeLLMAPI: free tiers only; routes by live model scores, not by prompt; Anthropic is an inbound API only. Rejected. OmniRoute is a run-time dependency isolated by a contract ([OMNIROUTE-CONTRACT](OMNIROUTE-CONTRACT.md), SEC-16); FreeLLMAPI is not used.
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

## 2026-10-24 — GitHub Copilot plan as a third subscription route; profile "auto"; plan detection
Users chat in the Copilot Chat window, but the gateway runs outside VS Code and cannot reach Copilot's models by itself. The sanctioned programmatic path is the Copilot CLI (`copilot -p -s`), so Copilot joins Claude and OpenAI as a bridge route (`copilot-code-*` → `copilot-mini|main|max`).
Rejected: re-exporting `vscode.lm` over HTTP from the companion extension and community Copilot proxies (terms/abuse risk). Output is plain text (no documented JSON event schema), tokens are estimated, premium-request balance is invisible.
With four vendor families the fixed profiles A-F stop scaling, so `init --profile auto --families …` generates the tables from a ladder per family (verified to reproduce profile A exactly), and `ar.mjs detect` reads local logins (`claude auth status`, `codex login status`, `gh api copilot_internal/user`) to pre-fill the installer's questions.

## 2026-10-24 — `update` is file sync + merge, not `git pull`
Users have different setups (clone, ZIP) and edited files that must survive (`.env`, `routing.yaml` tuning, managed blocks in `config.yaml`). `update` downloads the repository archive, syncs file by file,
merges the three user-touched files with small text merges, backs up what it replaces, and is a dry run unless `--apply`. A clone is realigned with a printed `git fetch && git reset --mixed origin/main`.
First-time bootstrap for copies that predate the command: fetch the new `ar.mjs` (UPDATE_WITH_AI.md Step 2). Trust model: whoever controls the repository can change the code that runs on the user's computer; hence the dry run, the file list, and `--repo/--ref/--from` to pin another source.

## 2026-10-25 — Security hardening (0.4.0) and routing v3 (0.5.0)
Two review plans were executed in order; the facts of what was and was not verified are in [SECURITY-CHANGES.md](SECURITY-CHANGES.md).
- **Safety is data, not code.** Every model has a privacy class in `models.yaml` (`trusted`, `no_retention`, `restricted`, `unsafe`; pools take the worst verified member). `SAFETY_MODE=on` is the default because the free providers the project used first (Gemini free tier, LLM7, OpenRouter `:free`, NVIDIA trial, Mistral free) may log or train on prompts. The cost is a smaller, weaker free pool.
- **DLP by regex and checksums, no Presidio.** The plan's default: no extra dependency or service; the limits are documented instead of hidden.
- **The `.vsix` stays in the repository** (plan default) but is reproducible and checked against `SHA256SUMS`; the installer builds it from source.
- **Updates follow release tags.** A moving branch can change the code that runs on the user's computer.
- **Images pinned by digest; OmniRoute isolated by a contract** with a verifier, a circuit breaker and `omniroute-upgrade` with rollback. FreeLLMAPI stays rejected; OmniRoute is a run-time dependency behind the contract (SEC-16).
- **One routing table for everybody.** The per-plan profiles A–F and the `auto` generator are gone: tables name all models, and the engine skips whatever the user cannot use (no key, not configured, not allowed by safety). `--profile` is still accepted by `init` and ignored.
- **Estimates are marked.** The `fit` matrix, the CLI overhead (20 000 tokens), the DeepSeek off-peak window (16:30–00:30 UTC) and the Cloudflare / Ollama context windows are estimates until measured (`context_verified: false`, `fit_estimated`).
- **Not implemented from the routing plan:** per-project `.auto-router/policy.yaml`; models without a key / verified id (DeepSeek, xAI Grok, Gemini 4 Argon, Llama 4 Maverick, Codestral) exist in `models.yaml` but not in `config.yaml`; `xhigh` effort is sent as `high`.
- **A model that answers "credit balance too low" is paused for 6 h** instead of being retried on every request (found when the user's Anthropic API key had no credit and Haiku-by-API was the first choice of several cheap cells).

## 2026-11-02 — v0.6 spike: a local gateway inside Claude Code keeps the subscription
Plan: route inside Claude Code (the person's real client) instead of Copilot Chat; light, no Docker, 100 % local. `gateway/spike_proxy.py`
(stdlib only) sat between Claude Code 2.1.304 and `api.anthropic.com`, tested with `claude -p` and the claude.ai login, no API key in the env.
- **Pass-through works.** Requests arrive with `Authorization: Bearer` (OAuth) and `anthropic-beta` containing `oauth-2025-04-20`; SSE streams
  flow chunk by chunk. With `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` every request carries `x-claude-code-request-class` (`auxiliary`, `main`),
  main turns carry `x-claude-code-prompt-id`, and all carry **`x-claude-code-session-id`** (not in the docs page; makes the resume queue need
  no hook). Every response carries `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset,status}` plus `representative-claim`,
  `fallback-percentage` and `overage-status`: the plan's real usage, account-wide.
- **Rewriting only `model` works and stays on the subscription.** Claude Code asked for `claude-sonnet-5-5`; the proxy sent
  `claude-haiku-5-5`; the stream's `message_start` said `claude-haiku-5-5`; HTTP 200 with the OAuth bearer. Claude Code's own
  `modelUsage` / `total_cost_usd` still say Sonnet: they are computed client-side, so the gateway's log is the truth for which model served.
- **Gotcha:** Claude Code sends `Accept-Encoding: gzip`; adding a lower-case `accept-encoding: identity` next to it still got gzip. Drop every
  case variant first, or the gateway cannot read the stream (served model, usage, errors).
- **Gemini can serve Claude Code with tools.** `gateway/translate_openai.py` (Anthropic Messages ↔ OpenAI Chat, stdlib) sent a 6-step
  tool loop (read, edit, run test, 12 Claude Code tools) to `gemini-3.8-flash` on Gemini's OpenAI endpoint: bug fixed, test passed.
  Gemini 3 thought signatures are kept per tool-call id; calls it never made carry Google's skip placeholder. ~19 K input tokens per
  call are Claude Code's fixed system prompt + tools (≈ US$ 0.09 for the whole loop on Flash).
- **Resume works.** `claude -p "<msg>" --resume <session-id>` continued the same session id on the subscription, and a session whose
  history was written by Gemini (tool calls, no thinking blocks) was accepted by Opus.
- **Switching Claude models inside a tool loop works** (Opus → Sonnet with Opus thinking blocks in the history: no "bound to a different
  conversation" error). Cache cost of a switch, measured: the new model re-writes the conversation part (13 K tokens here); the shared
  prefix (system + tools, 22 K) was already cached for it; going **back** to the previous model within the cache TTL re-read 35 K from
  cache and wrote 414. So the gateway must track cache warmth **per model** with its TTL, not only "the current model".
- **Parameters:** Claude Code always sends `thinking`, `output_config` (effort) and `context_management`. With thinking on, Claude rejects
  `temperature` and `top_p` (HTTP 400): on Claude the levers are effort / thinking budget and `max_tokens`. Gemini's OpenAI endpoint
  accepts `reasoning_effort` (low/high) together with `temperature`.
- **Footprint:** the stdlib proxy uses 25 MB RSS idle, 34 MB after a call, ~0.1 s CPU.
- **Google AI Pro credits (Billing → Credits export, 2026-11-02):** one "Google Developer Program premium benefit" lot of US$ 10 per
  month, in local currency, scope "all Google Cloud Platform services". Each lot has its **own end date** in the export, which does not
  always match "one year after grant" from the FAQ, so the funding model reads the dates per lot from the export or from the user, and
  never computes them. A Gemini API key on the same billing account was already drawing down the oldest lot, so the credit covers the API.
- A **Cloud Billing prepayment** on the same account is used only after the credits. In the funding model it is the
  `prepaid_balance` source, after the per-lot `expiring_credit` sources.
- **The gateway must always be running**, not started by hand: once Claude Code's `ANTHROPIC_BASE_URL` points at it, a stopped gateway
  breaks Claude Code everywhere (terminal included). Phase 2 installs it as a per-user login service (LaunchAgent on macOS, systemd user
  unit on Linux, Task Scheduler on Windows) with restart on failure; `ar.mjs claude-code --off` points Claude Code back at Anthropic.
  This differs from the 2026-10-20 bridge decision (no LaunchAgent) because the gateway holds no shell and listens on loopback only.
- Companion extension 0.4.0 adds Explorer → **Add to Claude Code**. Checked by the owner: Shift-drag into Claude Code works for files,
  not for folders; the menu entry appears only after the new .vsix is installed (`node ar.mjs vscode`, or `code --install-extension`).

## 2026-11-02 — Gateway decision rule: adequacy first, cheapest adequate, balance only as tie-break
A first version let the plan/credit shadow price multiply cost by up to 5x among every model that merely "passed" an integer fit
floor, plus a "use the slack" upgrade. The owner rejected it: the quota state was deciding, not the task. The rule now is
(docs/GATEWAY.md): (1) a continuous adequacy score per model against a requirement built from a richer task analysis
(reasoning depth, uncertainty, tool intensity, risk, project criticality, failures, learned outcome history); (2) the cheapest
adequate model; (3) funding balance only between adequate models of equivalent quality and cost; (4) ask only when the adequate
models are all out of quota. No slack upgrade. An uncertainty margin applies only above 0.3: a 0.1 doubt pushed fit-4 models out
of a 4.0 requirement and sent medium refactors to Opus.
- Credit lots get cheaper only inside `horizon_days` (30) of their end date: with no spending history every lot looked like
  "expiring unused" and priced at 0.
- **Claude extra usage.** On 2026-11-02 the 5 h window reached `utilization 1.0, status rejected` while requests were still served
  (`overage-status: allowed`): paid extra usage. The owner keeps it as an emergency reserve (auto-reload with a monthly cap), so the
  gateway treats the plan as exhausted unless `allow_overage`, also for picker/text pins, and offers it only as an option of the
  "plan is out" question (`overage: ask`). The owner's four options, fixed numbers: 1 best available now (Gemini), 2 Claude paid
  extra usage, 3 wait and resume automatically, 4 stop and only notify when the plan is back.
- The gateway runs from its own venv (Python + PyYAML 6.0.3); the system Python has no PyYAML. 35 MB RSS as a LaunchAgent.

## 2026-11-02 — Model calibration from benchmarks + the owner's experience; Gemini 4 Argon added
The first gateway table put Gemini Flash level with Sonnet for features (estimated `fit` 4 vs Haiku 2). The owner's experience:
Haiku ~ Flash (and Flash poor in practice), Gemini Pro below Sonnet, Sonnet ~ Gemini 4 Argon. Checked against current sources:
- Artificial Analysis Intelligence Index: Opus 5.5 58 (1st), Sonnet 5.5 56, Haiku 5.5 43 at launch (36-38 on index v5),
  Gemini 3.8 Flash 40-41, Gemini 3.1 Pro preview 30 (artificialanalysis.ai comparisons and the Haiku 5.5 launch article;
  officechai.com; neuraltrust.ai).
- Sonnet 5.5 vs Gemini 4 Argon trade wins (Sonnet ahead on terminal and long agentic sessions, cheaper and faster per session;
  Argon ahead on some repository-scale/agentic benchmarks): benchlm.ai, respan.ai, memeburn.com, bito.ai.
- Gemini 3.8 Flash: harness-dependent, slow first token (~13 s), up to 30 % more tokens than 3.7 Flash, behind on hard agentic
  benchmarks (mindstudio.ai, eesel.ai).
Owner's choices: follow the data for Gemini 3.1 Pro (below Flash), add Argon, and lower Flash by 0.5 (`adequacy_bias`). Haiku and
Flash now share `fit`; Argon shares Sonnet's (`tools` 4 vs 5). `gemini-4-argon` verified with a real tool call on the billed key
(HTTP 200, 2.5 s). The tie group is now "equivalent adequacy" only (a cost ratio kept Argon out because it writes ~2x the tokens):
inside it, expected cost x shadow price decides, so Argon takes Sonnet-level work when the Claude week is tight.

## 2026-11-02 — Batches: what they can and cannot save (research for PLAN 2D)
Asked for "urgently configuring batch calls". Findings (docs read 2026-11-02): Anthropic Message Batches API 50 % off API price, 100 000
requests / 256 MB per batch, most done < 1 h, expires at 24 h, results kept 29 days, tools/thinking/vision allowed, no streaming, prompt
caching stacks best-effort (use the 1-hour TTL), not ZDR-eligible, only `x-api-key` documented (Console key, billed separately);
Gemini Batch Mode 50 % off, 24 h target / 48 h expiry, OpenAI-compatible endpoint, cache does not stack (limits from a secondary source).
Consequences: batches are asynchronous and cannot run tools, so they do not fit the interactive agent loop; the discount is on API
money (Gemini credits, Console balance, Claude extra usage), not on subscription tokens, which have no per-token price. They fit
single-round deferrable work, the router's own background jobs (project cards, `fit` calibration) and the "plan is out" case. Sources:
Owner chose the automatic path (the router detects deferrable work and offers a batch, always asking before spending).
Also found: Claude Code >= 2.1.234 can itself wait for a usage-limit reset and continue (`/rate-limit-options`,
`autoContinueAtUsageLimit`), and a third-party claim that `claude -p` usage moved to a separate credit pool on 2026-06-15 (unverified).
Sources: code.claude.com/docs/en/costs; platform.claude.com/docs/en/build-with-claude/batch-processing; developers.googleblog.com (Batch Mode in the Gemini API; Batch API
with embeddings and OpenAI compatibility).

## Open items
- Calibrate `fit` with real tasks (ROUTING.md, "Calibration") and measure the CLI overhead.
- Confirm in real Copilot Chat that the start of the system prompt is stable across turns (conversation id, SEC-02).
- Per-project privacy policy file; Windows / Linux runs of the security changes.
- Check Agent-mode edits on each `Auto:` model in the editor.
- Verify the Copilot CLI route with a real paid plan (flags, model ids, how limits are worded).
- Verify the Codex route with a real `codex` install (event shapes, `-m`, `-c model_reasoning_effort`).
- Extend mid-stream continuation to the Responses and Anthropic Messages streaming formats if the VS Code endpoint uses them.
- Buy Anthropic API credits if the API route is wanted.
- Consider Arch-Router as a local classifier to cut the ~1-2 s classification latency and the dependency on Google.
- Measure daily quotas of free providers.
