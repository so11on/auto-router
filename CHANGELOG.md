# Changelog

Newest first. `node ar.mjs update` shows the entries newer than the version installed on the computer.

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
