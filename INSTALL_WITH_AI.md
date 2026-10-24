# Install auto-router — instructions for an AI assistant

> **User:** paste this file's link (or its text) to your AI assistant and say: *"Install auto-router for me following this file."*
> **AI assistant:** you are installing this on the user's computer. Follow the steps in order, run the commands yourself, and talk to the
> user in **their language**. Keep messages short and non-technical. Never print, log or commit secret values — show only `set` / `empty`.

## What this is (say it in one sentence)
auto-router adds three models to VS Code Copilot Chat — **Auto: Free**, **Auto: Balanced**, **Auto: Smart**. A local gateway then picks the real model
for each request, switches model during a task when useful, avoids models that are about to run out of quota, and opens a new chat from a
memory file when the context is nearly full. Everything runs on the user's computer.

## Rules for you
1. Use only commands in this file and `node ar.mjs …`. Do **not** edit files outside the cloned folder except what `ar.mjs vscode` does (it backs up first).
2. **Ask before:** installing software (Docker, Node, Claude CLI), writing VS Code settings, starting anything that stays running, or anything that can cost money.
3. You cannot create accounts or API keys. Tell the user exactly where to click (links are printed by `node ar.mjs init`), wait, and have them **save** the `.env` file after pasting keys.
4. Never put real keys in chat logs. When you need to check a key, run `node ar.mjs keys`.
5. If a step fails, read the error, check `docs/INSTALL-LESSONS.md` (every known trap), fix, and retry. Do not skip verification.
6. Be honest at the end: say what passed, what failed, what you could not test.

## Step 0 — Get the code
```sh
git clone https://github.com/so11on/auto-router.git
cd auto-router
```
(No git? Download the repository as a ZIP from the same page and unzip it.)

## Step 1 — Check the computer
```sh
node ar.mjs doctor
```
`node` itself missing? Install Node.js ≥ 18 from https://nodejs.org first (ask), then continue.
Fix every ✘ before going on: Docker must be installed **and running** (https://docs.docker.com/get-docker/). A `!` for the Claude CLI or VS Code `code` command is fine.

## Step 2 — Interview the user (ask all of these in ONE message, then wait)
1. **Where do you keep your code?** (a folder path; several allowed). → `--roots`. This is the only place Claude Code is allowed to edit.
2. **Which paid AI services do you use?**
   - *Claude:* a **subscription** (Pro/Max) used through the `claude` command → profile with `--claude cli`; an **API key with credits** → `--claude api`; none → `--claude none`.
   - *Google Gemini:* a key from a project **with billing**? (yes/no)
3. **May their prompts go to free AI services that can log or train on them?** (Gemini free tier, OpenRouter free models, LLM7, NVIDIA trial.) If **no**: skip those providers (tell them Auto: Free will then have fewer models) and use `--no-llm7`.
4. **Which free accounts will they create?** Groq, OpenRouter, Mistral, Ollama Cloud, NVIDIA (all optional; more = more resilient). Each takes ~2 minutes at the links printed by `init`.
5. **Is it OK that Balanced/Smart can spend their money / Claude allowance?** (Auto: Free never does.)

Pick the profile:
| Situation | `--profile` |
|---|---|
| Claude **and** a billed Gemini key | `A` |
| Billed Gemini key, no Claude | `B` |
| Claude, no billed Gemini | `C` |
| Only free providers | `D` |

## Step 3 — Create the configuration
```sh
node ar.mjs init --roots "<folder(s) from question 1>" --profile <A|B|C|D> --claude <cli|api|none>
```
This creates `.env` (secrets generated for the user), activates the routing profile, and remembers the folder for the VS Code extension.
Then tell the user the key names and links from the output, and ask them to paste **only the keys they have** into `.env` and **save the file**. Check with:
```sh
node ar.mjs keys
```
Key notes (tell the user only what is relevant):
- `GEMINI_API_KEY` = project **with** billing; `GEMINI_FREE_API_KEY` = a **different** key from a project **without** billing. Never the same key twice.
- A Claude **subscription** needs no key: the user must be logged in to the `claude` command (`claude` → `/login`). `ANTHROPIC_API_KEY` is only for the API route and needs credits ("credit balance too low" means none).
- Nothing is mandatory. With no keys at all, `omniroute` still connects LLM7 (keyless) so Auto: Free works at a basic level.

## Step 4 — Start
```sh
node ar.mjs up
```
First start downloads Docker images (a few minutes). It starts the gateway, OmniRoute and — if the Claude CLI exists and `CLAUDE_PRIMARY=cli` — the Claude bridge.

## Step 5 — Connect and verify the free providers
```sh
node ar.mjs omniroute            # add --no-llm7 if the user said no in question 3
docker compose up -d --force-recreate litellm
```
This logs in to OmniRoute, registers every provider whose key is in `.env`, **sends a real test request to every candidate model**, keeps only the ones that answer, builds the
`free-fast` and `free-coding` pools and sets `FREE_POOL_ENABLED=true`. Read its output to the user: which providers connected, which models were dropped and why.
(Free tiers rotate models; dropping some is normal. A provider with a rejected key: ask the user to re-check that key.)

## Step 6 — VS Code
```sh
node ar.mjs vscode
```
Ask first. It backs up the user's `chatLanguageModels.json`, adds the three models, and installs the companion extension (status bar + automatic new chat).
**Then tell the user to do these two things (VS Code cannot be scripted):**
1. Command Palette (Ctrl/Cmd+Shift+P) → **Developer: Reload Window**.
2. Open Copilot Chat → click the model name under the message box → choose **Auto: Free**, **Auto: Balanced** or **Auto: Smart**. (If they are hidden: *Manage Models…* and tick them.)

## Step 7 — Test it
```sh
node ar.mjs smoke
node ar.mjs logs --errors --since 30m
```
`smoke` sends one real request to each profile and prints the model that answered. **A pass can hide a broken route** (fallbacks answered), so also read the `--errors` output and tell the user about
any failing upstream call. Then ask the user to send one easy and one hard question in Copilot Chat: every final answer ends with a line such as
`auto-router · auto-balanced → gemini-flash · … · ctx 3%` showing the model used.

## Step 8 — Hand over (tell the user)
- **Choose a profile:** model picker in Copilot Chat. **Force a model:** write `!opus`, `!sonnet`, `!haiku`, `!pro`, `!flash`, `!deepseek`, `!gpt-oss` or `model:opus` (or "usando o Opus") in the message.
- **Commands:** `node ar.mjs up | down | status | logs | usage | keys | smoke`. The stack does not start by itself after a reboot: run `node ar.mjs up` first.
- **Costs/privacy:** Balanced and Smart can spend their money or Claude allowance; Auto: Free cannot. Free providers may log prompts. Everything is local (127.0.0.1).
- **Honest limits to mention:** developed and verified on macOS; Windows/Linux were not tested by the author. Mid-answer continuation works for streaming chat only. The "new chat" automation uses VS Code commands that are not officially documented; if it does not open a chat, the extension copies the continuation text to the clipboard.
- **Where things are:** `README.md`, `docs/OPERATIONS.md` (daily use and troubleshooting), `docs/SECURITY.md`.

## If something breaks (quick table)
| Symptom | Fix |
|---|---|
| `doctor` says Docker not running | Start Docker Desktop / `sudo systemctl start docker`, rerun. |
| VS Code shows an error immediately | `node ar.mjs status` (stack up?), `node ar.mjs logs --errors`. A 401 means the gateway key in VS Code differs from `.env`: rerun `node ar.mjs vscode`, reload the window. |
| Auto: Free answers slowly (~20 s) | The free pool is empty/disabled and it fell back to Gemini's free tier. Rerun `node ar.mjs omniroute`, then recreate litellm. |
| `!opus` falls back to Sonnet | Claude Code too old: `claude update`, then `node ar.mjs down && node ar.mjs up`. |
| "credit balance is too low" | The Anthropic API route is being used with no credits: use the subscription (`CLAUDE_PRIMARY=cli` + logged-in `claude`) or add credits. |
| Windows: bridge does not start | Check `data/bridge.log`; make sure `claude` is on PATH (`where claude`). |
| Anything else | `docs/INSTALL-LESSONS.md` lists every problem met so far with its fix. |

To uninstall: `node ar.mjs vscode --uninstall && node ar.mjs down`, then delete the folder (and `~/.auto-router`).
