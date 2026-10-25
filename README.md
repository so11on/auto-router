# auto-router

Pick **one** model name in VS Code Copilot Chat — **Auto: Free**, **Auto: Balanced** or **Auto: Smart** — and a local gateway chooses the
actual model for each request, sets the reasoning effort, switches model during a task when the work gets harder or easier, falls back when a
provider fails or runs out of quota (Claude, OpenAI/ChatGPT, your paid GitHub Copilot plan, Gemini and a pool of free providers), and keeps your context under control (memory file + automatic new chat when the context is nearly full).

```
VS Code Copilot Chat ──► gateway (LiteLLM, Docker) ──► free pool (Groq, Ollama Cloud, Cloudflare … via OmniRoute)
   Auto: Free/Balanced/Smart      │                 ├─► Gemini (your keys)
                                  └─ DLP + routing  └─► Claude / ChatGPT / Copilot (your logins) or API keys
```

## Install in 5 minutes (any OS: Windows, macOS, Linux)

**Easiest:** give your AI assistant this link and say *"install this for me"*:
`INSTALL_WITH_AI.md` in this repository. It will ask you a few questions and do everything.

**By hand:**
```sh
git clone --branch v0.5.0 https://github.com/so11on/auto-router.git && cd auto-router   # keep this folder OUTSIDE your code folders
node ar.mjs doctor                       # checks Docker, Node, Claude CLI, VS Code
node ar.mjs init --roots "<your code folder>"       # creates .env with generated secrets (safety mode on by default)
# put the keys you have into .env — step by step with links: docs/GET-KEYS.md — none are mandatory
node ar.mjs keys --check                 # tells you which keys work
node ar.mjs up                           # starts everything
node ar.mjs omniroute                    # connects free providers, tests each model, builds the free pool
node ar.mjs detect                       # which paid plans/logins this computer has
node ar.mjs openai                       # (only if you use ChatGPT Plus/Pro via Codex, or an OpenAI key)
node ar.mjs copilot                      # (only if you have a paid GitHub Copilot plan)
node ar.mjs vscode                       # adds Auto: Free/Balanced/Smart to VS Code + status-bar extension
node ar.mjs smoke                        # one real request per profile
```
Then in VS Code: **Developer: Reload Window** → open Copilot Chat → pick **Auto: …** in the model picker.

Requirements: [Docker](https://docs.docker.com/get-docker/), [Node.js ≥ 18](https://nodejs.org), VS Code ≥ 1.122 with GitHub Copilot Chat.
Optional: the [Claude Code CLI](https://docs.claude.com/claude-code) (use your Claude subscription), the [Codex CLI](https://developers.openai.com/codex) (use your ChatGPT Plus/Pro plan), the [GitHub Copilot CLI](https://docs.github.com/copilot/concepts/agents/about-copilot-cli) (use a paid Copilot plan), Python 3.9+ (only for `tests/` and two dev tools).

## Already installed? Update in one sentence
Tell your AI assistant: *"Update my auto-router to the newest version following https://raw.githubusercontent.com/so11on/auto-router/main/UPDATE_WITH_AI.md"* — or run it yourself:
```sh
node ar.mjs update              # dry run: shows what would change and what is new
node ar.mjs update --apply --restart
```
Your `.env`, keys, `data/` and routing tuning are kept; replaced files are backed up in `data/update-backup-*`. `node ar.mjs status` tells you when a newer version exists. See [CHANGELOG.md](CHANGELOG.md).

## Profiles and safety
| | **Auto: Free** | **Auto: Balanced** | **Auto: Smart** |
|---|---|---|---|
| Promise | never spends money or plan allowance | best cost/benefit, the everyday default | the best model for the task, without waste |
| Use for | questions, drafts, study, POCs without sensitive data | features, scripts, data, docs, UI of MVPs | architecture, hard debugging, big refactors, production code |
| Spends money | never | little, capped (US$ 0.10/request, 3/day) | yes, capped (US$ 1.50/request, 15/day) |
| Uses your Claude / ChatGPT plan | no | when it has room | first choice |
| Sensitive content (default settings) | **blocked** with a message | only trusted paid models | only trusted paid models |

Two switches protect your data (details and limits in [docs/SECURITY.md](docs/SECURITY.md)):
- `SAFETY_MODE=on` (default) removes every model that may log, train on or let humans read your prompts (Gemini free tier, LLM7, OpenRouter `:free`, NVIDIA trial, Mistral free) from every route, fallback and pin. `node ar.mjs safety off` lifts it.
- `SENSITIVE_GUARD=on` (default) finds keys, passwords, tokens, CPF/CNPJ, cards, e-mails, phones and images **before any model sees the request**, masks secrets (`«SECRET_1:openai_key»`), and then only lets classes you allow (default: `trusted`) answer. A `🔒` shows in the answer footer and the status bar.

- **Per-request choice** (a cheap model classifies task + complexity) and **mid-task switching** up *and* down, with hysteresis; the routing tables ([docs/ROUTING.md](docs/ROUTING.md)) decide which models each profile may use per task type.
- **Quota forecast**: reads the providers' rate limits (and Claude Code's 5-hour/7-day usage) and moves away from a model *before* it runs out.
- **Fallbacks** before a model answers, and **continuation on another model** if one dies halfway through an answer (a notice appears in the text).
- **Context control**: measures each request against the model's window; compacts the history when needed; writes `.auto-router/memory/<session>.md` in your project and
  opens a **new chat that continues from it** when the context is nearly full (VS Code companion extension).
- **Pins**: write `!opus`, `!sonnet`, `!deepseek`, `model:pro` … or "usando o Opus" in a message to force a model for that turn.
- **Footer** on every answer: which model answered, task, context %, quota warnings. **Logs**: `node ar.mjs logs`; **usage**: `node ar.mjs usage`.

## Cost and privacy — read this
- `Auto: Balanced` and `Auto: Smart` can spend **your** money (Gemini billed key, Anthropic API) or your **Claude plan allowance**, within the caps above. `Auto: Free` cannot.
- With `SAFETY_MODE=on` the free pool is limited to providers that declare no training and no retention (Groq with Zero Data Retention enabled, Ollama Cloud, Cloudflare Workers AI). With `off`, the other free providers may log prompts or use them for training. The detector is regex-based and **cannot find everything** (see [docs/SECURITY.md](docs/SECURITY.md), "What the DLP does not detect").
- Using a Claude **subscription** (Claude Code) or a ChatGPT **plan** (Codex CLI) through the bridge runs the official program as you; the vendors' rules for subscriptions in automated setups may change. See [docs/SECURITY.md](docs/SECURITY.md).
- A paid **GitHub Copilot** plan is used through GitHub's own Copilot CLI; you keep chatting in the Copilot Chat window. Each request spends the plan's premium requests.
- **ChatGPT Plus/Pro does not include OpenAI API access** (the API is billed separately). With a plan, GPT is reached through the Codex terminal tool, like Claude through Claude Code.
- Everything runs on your computer and listens on `127.0.0.1` only. Your keys stay in `.env` (never committed). The gateway key is also written into VS Code's user file (plain text, loopback-only).

## Status
Version 0.5.0 (security hardening + routing v3), developed and verified on **macOS** (2026-10); see [docs/SECURITY-CHANGES.md](docs/SECURITY-CHANGES.md) for what was verified for real and what is pending. The code is written to be portable (Node + Docker, Windows paths and `.cmd` launchers handled) but **Windows and Linux were not
tested** — `node ar.mjs doctor` and `node ar.mjs smoke` tell you quickly if something is off; please report problems. Free-tier models rotate: `node ar.mjs omniroute` re-tests them.

## Documentation
[INSTALL_WITH_AI.md](INSTALL_WITH_AI.md) (AI-driven install) · [UPDATE_WITH_AI.md](UPDATE_WITH_AI.md) (AI-driven update) · [CHANGELOG.md](CHANGELOG.md) · [docs/GET-KEYS.md](docs/GET-KEYS.md) (every key, step by step) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/ROUTING.md](docs/ROUTING.md) · [docs/CONFIGURATION.md](docs/CONFIGURATION.md) ·
[docs/OPERATIONS.md](docs/OPERATIONS.md) · [docs/CLAUDE-BRIDGE.md](docs/CLAUDE-BRIDGE.md) · [docs/FREE-TIER-LIMITS.md](docs/FREE-TIER-LIMITS.md) · [docs/VSCODE-SETUP.md](docs/VSCODE-SETUP.md) ·
[docs/SECURITY.md](docs/SECURITY.md) · [docs/SECURITY-CHANGES.md](docs/SECURITY-CHANGES.md) · [docs/OMNIROUTE-CONTRACT.md](docs/OMNIROUTE-CONTRACT.md) · [docs/TESTING.md](docs/TESTING.md) · [docs/DECISIONS.md](docs/DECISIONS.md) · [docs/INSTALL-LESSONS.md](docs/INSTALL-LESSONS.md) · [AGENTS.md](AGENTS.md)

## Layout
```
ar.mjs                    installer and control script (doctor, init, safety, up, down, omniroute, omniroute-upgrade, vscode, smoke, logs, usage, tune, update)
docker-compose.yml        gateway (LiteLLM) + OmniRoute
litellm/                  config.yaml (models, fallbacks), routing.yaml (tables per profile/task), models.yaml (privacy, prices, fit, limits),
                          hook + engine.py (decision), dlp.py, safety.py, pool.py (circuit breaker), quota.py, context.py
profiles/                 the list of free-pool models to verify (with privacy classes)
scripts/                  omniroute-contract.mjs, build-vsix.mjs, tune.mjs, hook-session-start.mjs
claude-bridge/            Node server that exposes your Claude Code, Codex (ChatGPT) and Copilot logins as OpenAI-style endpoints (+ secret-file guard)
vscode-extension/         companion extension (status bar, automatic new chat) + prebuilt .vsix
templates/hooks/          optional VS Code agent hook (SessionStart → project memory)
tests/                    Python unit tests (hook modules) and Node tests (installer)
docs/                     documentation
```

License: MIT.
