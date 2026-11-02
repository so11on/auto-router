# Changelog

Newest first. `node ar.mjs update` shows the entries newer than the version installed on the computer.

## Unreleased (v0.6 in progress, branch `v0.6-claude-gateway`)
- **Plan for v0.6** in `docs/PLAN-v0.6.md`: routing moves inside Claude Code through a light local gateway (no Docker, 100 % local), a
  single `auto` profile, a cost model that weighs plan quotas, expiring credits, prepayments and real money, mid-task switching with
  per-model cache tracking, a per-project `.auto-router/` folder, and an optional "Claude quota is out: use Gemini or wait and resume" flow.
- **Spike done** (`gateway/spike_proxy.py`, results in `docs/DECISIONS.md`): Claude Code keeps the subscription through a local
  `ANTHROPIC_BASE_URL`; the gateway may rewrite the model; Gemini can serve Claude Code tool loops; sessions resume with `claude --resume`.
- `gateway/translate_openai.py`: Anthropic Messages ↔ OpenAI Chat translation (tools, streaming, Gemini 3 thought signatures), with tests.
- **Claude Code gateway** (`gateway/server.py`, `router.py`, `funding.py`; `docs/GATEWAY.md`): `auto` routing between the Claude plan
  and paid Gemini — adequacy first, cheapest adequate model, plan/credit balance only as a tie-break, mid-task checkpoints, outcome
  history, "plan is out: 1 best available / 2 wait and resume / 3 paid extra usage" question, resume via `claude --resume`.
  `node ar.mjs gateway install|status|restart|uninstall` (login service) and `node ar.mjs claude-code on|off|status`.
- `litellm/classify_rules.py`: classifier prompts and heuristic shared by the LiteLLM hook and the gateway; `policy.signals_anthropic`.
- `models.yaml`: `reasoning` (0-5, estimate) for the Claude and Gemini models.
- Companion extension **0.4.0**: Explorer → **Add to Claude Code** (files via Claude Code's own @-mention command; folders copied as
  `@path/` to paste). Run `node ar.mjs vscode` and reload VS Code. `docs/VSCODE-SETUP.md` documents Shift-drag (files only) and Option+K.

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
