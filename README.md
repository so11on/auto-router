# auto-router

Pick **one** model name in VS Code Copilot Chat — **Auto: Free**, **Auto: Balanced** or **Auto: Smart** — and a local gateway chooses the
actual model for each request, sets the reasoning effort, switches model during a task when the work gets harder or easier, falls back when a
provider fails or runs out of quota, and keeps your context under control (memory file + automatic new chat when the context is nearly full).

```
VS Code Copilot Chat ──► gateway (LiteLLM, Docker) ──► free pool (Groq, OpenRouter, Mistral, Ollama, NVIDIA, LLM7 via OmniRoute)
   Auto: Free/Balanced/Smart      │                 ├─► Gemini (your keys)
                                  └─ routing hook   └─► Claude (your Claude Code login, or an Anthropic API key)
```

## Install in 5 minutes (any OS: Windows, macOS, Linux)

**Easiest:** give your AI assistant this link and say *"install this for me"*:
`INSTALL_WITH_AI.md` in this repository. It will ask you a few questions and do everything.

**By hand:**
```sh
git clone <this repository> && cd auto-router
node ar.mjs doctor                       # checks Docker, Node, Claude CLI, VS Code
node ar.mjs init --roots "<your code folder>"       # creates .env with generated secrets
# put the keys you have into .env (node ar.mjs keys shows where to get them) — none are mandatory
node ar.mjs up                           # starts everything
node ar.mjs omniroute                    # connects free providers, tests each model, builds the free pool
node ar.mjs vscode                       # adds Auto: Free/Balanced/Smart to VS Code + status-bar extension
node ar.mjs smoke                        # one real request per profile
```
Then in VS Code: **Developer: Reload Window** → open Copilot Chat → pick **Auto: …** in the model picker.

Requirements: [Docker](https://docs.docker.com/get-docker/), [Node.js ≥ 18](https://nodejs.org), VS Code ≥ 1.122 with GitHub Copilot Chat.
Optional: the [Claude Code CLI](https://docs.claude.com/claude-code) (use your Claude subscription), Python 3.9+ (only for `tests/` and two dev tools).

## What you get
| Profile | Behaviour |
|---|---|
| **Auto: Free** | Only free models. Never spends money. |
| **Auto: Balanced** | Cheap/free models for easy work, stronger ones for hard work. |
| **Auto: Smart** | Strongest suitable model, with reasoning effort scaled to the task. |

- **Per-request choice** (a cheap model classifies task + complexity) and **mid-task switching** up *and* down, with hysteresis; the profile's table is the floor and ceiling.
- **Quota forecast**: reads the providers' rate limits (and Claude Code's 5-hour/7-day usage) and moves away from a model *before* it runs out.
- **Fallbacks** before a model answers, and **continuation on another model** if one dies halfway through an answer (a notice appears in the text).
- **Context control**: measures each request against the model's window; compacts the history when needed; writes `.auto-router/memory/<session>.md` in your project and
  opens a **new chat that continues from it** when the context is nearly full (VS Code companion extension).
- **Pins**: write `!opus`, `!sonnet`, `!deepseek`, `model:pro` … or "usando o Opus" in a message to force a model for that turn.
- **Footer** on every answer: which model answered, task, context %, quota warnings. **Logs**: `node ar.mjs logs`; **usage**: `node ar.mjs usage`.

## Cost and privacy — read this
- `Auto: Balanced` and `Auto: Smart` can spend **your** money (Gemini billed key, Anthropic API) or your **Claude plan allowance**. `Auto: Free` cannot.
- Free providers may log prompts or use them for training (Gemini free tier, OpenRouter `:free`, LLM7, NVIDIA trial, Mistral free). Do not send confidential code through `Auto: Free`.
- Using a Claude **subscription** through the bridge runs the official `claude` program as you; Anthropic's rules for subscriptions in automated setups may change. See [docs/SECURITY.md](docs/SECURITY.md).
- Everything runs on your computer and listens on `127.0.0.1` only. Your keys stay in `.env` (never committed). The gateway key is also written into VS Code's user file (plain text, loopback-only).

## Status
Developed and verified on **macOS** (2026-10). The code is written to be portable (Node + Docker, Windows paths and `.cmd` launchers handled) but **Windows and Linux were not
tested** — `node ar.mjs doctor` and `node ar.mjs smoke` tell you quickly if something is off; please report problems. Free-tier models rotate: `node ar.mjs omniroute` re-tests them.

## Documentation
[INSTALL_WITH_AI.md](INSTALL_WITH_AI.md) (AI-driven install) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/ROUTING.md](docs/ROUTING.md) · [docs/CONFIGURATION.md](docs/CONFIGURATION.md) ·
[docs/OPERATIONS.md](docs/OPERATIONS.md) · [docs/CLAUDE-BRIDGE.md](docs/CLAUDE-BRIDGE.md) · [docs/FREE-TIER-LIMITS.md](docs/FREE-TIER-LIMITS.md) · [docs/VSCODE-SETUP.md](docs/VSCODE-SETUP.md) ·
[docs/SECURITY.md](docs/SECURITY.md) · [docs/TESTING.md](docs/TESTING.md) · [docs/DECISIONS.md](docs/DECISIONS.md) · [docs/INSTALL-LESSONS.md](docs/INSTALL-LESSONS.md) · [AGENTS.md](AGENTS.md)

## Layout
```
ar.mjs                    installer and control script (doctor, init, up, down, omniroute, vscode, smoke, logs, usage)
docker-compose.yml        gateway (LiteLLM) + OmniRoute
litellm/                  config.yaml (models, fallbacks), routing.yaml (profile tables), models.yaml (windows, limits), hook modules
profiles/                 routing profiles A-D and the list of free-pool models to verify
claude-bridge/            Node server that exposes your Claude Code login as an OpenAI-style endpoint
vscode-extension/         companion extension (status bar, automatic new chat) + prebuilt .vsix
templates/hooks/          optional VS Code agent hook (SessionStart → project memory)
tests/                    Python unit tests (hook modules) and Node tests (installer)
docs/                     documentation
```

License: MIT.
