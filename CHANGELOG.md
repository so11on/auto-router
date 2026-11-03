# Changelog

Newest first. `node ar.mjs update` shows the entries newer than the version installed on the computer.

## 1.0.0 — 2026-11-03
The Claude Code gateway and an umbrella around it. Read `docs/INCIDENTS.md`: the first real install turned the agent "dumb" and this release is
built from what that taught.
- **Umbrella.** `node ar.mjs on|off|feature list|feature <name> on|off|status`. Everything is off by default (`gateway/features.defaults.json`);
  your choices live in the git-ignored `config/local/`. Parts: `gateway`, `claude_code`, `gemini_tools`, `token_hooks`, `haiku_subagents`,
  `compact_instructions`, `terse_style`, `statusline`, `vscode_status`, `resume_on_reset`, `notifications`, `legacy_stack`. `off` always
  returns Claude Code to Anthropic directly (and gives back the start model it changed) and removes only what the umbrella installed.
- **`auto` inside Claude Code** (`gateway/`): picks Haiku / Sonnet / Opus and the reasoning effort by adequacy first, then cost, with plan
  and credit balance only as a tie-break. **`shadow` mode** (default: decide and log, send as asked) and **`route` mode**
  (`node ar.mjs mode`), `node ar.mjs report`. Gemini is no longer a conversation model: it classifies and is a tool.
- **Gemini as a tool**: `node ar.mjs gemini digest|media|research|review|batch` (`gateway/gemini_cli.py`): DLP before sending, safety checks,
  spend in the ledger, answers cut to protect the Claude's context. Verified with real calls on 2026-11-03 (Batch API included).
- **Model and effort in view**: `sonnet (medium)` in a status line (`templates/claude-code/statusline.mjs`) and the VS Code status bar.
- **Token saving** (`docs/TOKEN-SAVING.md`): test-output hook, Haiku subagent for verbose work, compaction instructions, optional terse style
  (the caveman verdict: small effect, off by default), `node ar.mjs optimize` context audit.
- **Fixes from the incident** (D1-D9, each with a regression test): plan "exhausted" until the weekly reset after a 5-hour window had reset;
  weak model as the agent's main loop (`quality.main_floor`, `roles`); continuations ("continue", "yes") rated as trivial; checkpoints using the
  first prompt; tool results without `name` (Gemini 400); parallel tool calls merged into one; wrong model label in replies; lost-history
  requests; learning that counted complaints as successes; `status` ignoring the new gateway.
- All user-facing texts come from `messages:` in the config (English default); continuation/complaint words from `patterns:`.
- The VS Code companion is **1.0.0**: status bar and "Add to Claude Code". The Copilot-era context status and automatic new chat are kept only
  behind `autoRouter.legacyStack` (off). `gateway/spike_proxy.py` removed. `docs/PLAN-v0.6.md` is now `docs/ROADMAP.md`.
- Tests: the privacy scan ignores git-ignored local state (bytecode caches, `config/local`).

## 0.5.0 — 2026-10-25
- **Routing v3.** One table for every install: `litellm/routing.yaml` now says, per profile (free / balanced / smart), task type (14) and complexity band, which models may answer, in order. A new engine filters (safety, sensitivity, availability, tools, vision, context, quota, budget), reorders (a plan with room before a billed neighbour), applies a quality floor and a cost rule, and returns fallbacks already filtered. See `docs/ROUTING.md`.
- `litellm/models.yaml` is now the registry of facts: privacy class, price (with scheduled changes, DeepSeek off-peak, long-context tiers), suitability per task (`fit`, **estimates** until you calibrate), tool / vision reliability, limits.
- Individual free-pool models (`pool-qwen`, `pool-cf-glm`, …) verified through OmniRoute; models for which there is no key or verified id yet (DeepSeek, Grok, Gemini Argon, Maverick, Codestral) are described but stay off until you add them.
- Mid-task: the DLP re-runs on every request, sensitivity is sticky, failures escalate at once (another vendor first for `debug`), a short message never drops below the previous band, mechanical steps move to cheap models only when it pays.
- Daily/per-request spend caps per profile (`data/spend.json`); a model that answers "credit balance too low" is paused for 6 h; API models have request timeouts.
- `node ar.mjs tune`: learns from your usage and proposes (`--apply`: makes) one-place re-orderings of table cells.
- Status bar shows `🔒` (safety on) and `🔒 sensível`; extension 0.3.0 (**run `node ar.mjs vscode` and reload VS Code**); footer shows safety mode, limit and quality warnings.
- **Update note:** `routing.yaml` changes format. `node ar.mjs update --apply` replaces your v2 tiers with the v3 tables and keeps your pins, `switching` and `context` sections (the old file is in `data/update-backup-*`). The per-plan profiles A–F and `--profile auto` generation are gone (`--profile` is still accepted and ignored).

## 0.4.0 — 2026-10-25 (released together with 0.5.0, as tag v0.5.0)
Security hardening — full account, with what was verified for real and what is pending, in `docs/SECURITY-CHANGES.md`.
- **Safety mode** (`SAFETY_MODE=on`, default; `node ar.mjs safety on|off`): models that may log, train on or let humans read your prompts (Gemini free tier, LLM7, OpenRouter `:free`, NVIDIA trial, Mistral free) leave every route, fallback and pin. **After updating, run `node ar.mjs omniroute` once and recreate the gateway, or Auto: Free stays blocked** (the pool must be verified and classified).
- **DLP / sensitive guard** (`SENSITIVE_GUARD=on`): secrets and personal data (CPF, CNPJ, cards, e-mail, phone) and images are detected before any model; secrets are masked; sensitive requests only reach `trusted` models (Auto: Free refuses them with a message). Regex-based: limits in `docs/SECURITY.md`.
- Bridge: validated permission modes, Codex sandboxes and model ids; constant-time key check; 2 MB limit; real-path root checks; trusted workspace from the VS Code window; conversation ids include the system prompt and workspace; Claude Code runs with deny rules and a hook that blocks `.env`, keys and env dumps.
- Docker: images pinned by digest, explicit env list for the gateway (no OmniRoute password or free-provider keys inside), `no-new-privileges`, `cap_drop`, read-only filesystem. `ar.mjs update` never changes image lines.
- OmniRoute isolated behind a contract (`omniroute --check`), a circuit breaker for the free pool, `omniroute-upgrade` with backup and rollback.
- Private data files, masked logs and project memory (delivered to new chats as data, not instructions), OmniRoute request logging off, `init` refuses roots that contain the install, `doctor` checks, optional `vscode --harden`.
- CI: least privilege, actions pinned by SHA, gitleaks, dependabot; reproducible `.vsix` with `SHA256SUMS`; `update` follows release tags (`--ref <branch>` needs `--yes`).
- **Update note:** read `docs/SECURITY-CHANGES.md` (manual steps M1–M8). Move the install folder out of your code folders. `GEMINI_FREE_API_KEY` is ignored while safety mode is on.

## 0.3.0 — 2026-10-24
- **Paid GitHub Copilot plan** can now be a router target (Copilot CLI, `node ar.mjs copilot`), with pins `!copilot`, `!copilot-max`, `!copilot-mini`.
  **If you have a paid Copilot plan and installed an earlier version: update, then run `node ar.mjs detect` and `node ar.mjs copilot`.**
- `node ar.mjs detect`: finds which paid plans/logins exist (Claude plan, Codex login, Copilot plan, keys).
- `node ar.mjs init --profile auto --families …`: routing generated from the plans you have.
- `node ar.mjs update`: updates an existing install from the repository, keeping your keys and choices (this entry's feature).
- Bridge: changed files are also detected in folders that are not git repositories.

## 0.2.0 — 2026-10-24
- OpenAI / ChatGPT: Codex CLI route (Plus/Pro login) and OpenAI API route, `node ar.mjs openai`, profiles E and F, pins `!gpt`, `!gpt-max`, `!gpt-mini`.
- Cloudflare Workers AI works (account id passed to OmniRoute, models discovered and verified); `node ar.mjs cloudflare-token`.
- `node ar.mjs keys --check`; `docs/GET-KEYS.md` with step-by-step instructions for every key.

## 0.1.0 — 2026-10-24
- First public release: gateway with Auto: Free / Balanced / Smart, mid-task switching, quota forecast, context control, fallbacks, Claude Code bridge, VS Code companion extension, `ar.mjs` installer, `INSTALL_WITH_AI.md`.
