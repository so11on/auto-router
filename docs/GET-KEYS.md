# How to get every key — step by step

Nothing here is mandatory. Pick what you have or want; more providers = more resilience. Put each key into the `.env` file in the project folder
(`node ar.mjs init` created it), **save the file**, then check them all at once:

```sh
node ar.mjs keys --check
```
It prints `works` or `FAILS` for each key and says what is wrong. Website layouts change; the steps below were written on 2026-10-24 — if a button has moved,
the goal of each step still tells you what to look for. **Never paste a key into a chat, an issue or a screenshot.**

| You want | Needs | Costs | `.env` variable |
|---|---|---|---|
| Claude through your **Claude Pro/Max subscription** | Claude Code installed and logged in | your plan | none |
| Claude through the **API** | Anthropic account with credits | pay per token | `ANTHROPIC_API_KEY` |
| GPT through your **ChatGPT Plus/Pro subscription** | Codex CLI installed and logged in | your plan | none |
| GPT through the **API** | OpenAI API account with credits | pay per token | `OPENAI_API_KEY` |
| Models of your **paid GitHub Copilot** plan (Pro, Pro+, Business, Enterprise) | Copilot CLI installed and logged in | your plan (premium requests) | none |
| Gemini (paid models + classifier) | Google key from a project **with** billing | pay per token | `GEMINI_API_KEY` |
| Gemini free tier (last-resort fallback) | Google key from a project **without** billing | free, slow | `GEMINI_FREE_API_KEY` |
| Free pool: Groq, OpenRouter, Mistral, Ollama Cloud, NVIDIA, Cloudflare | one free account each | free | `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `OLLAMA_API_KEY`, `NVIDIA_API_KEY`, `CLOUDFLARE_*` |
| LLM7 (DeepSeek and others) | nothing | free | none |

Privacy: free tiers may log your prompts or train on them (Gemini free tier, OpenRouter `:free`, LLM7, NVIDIA trial, Mistral free). Do not send confidential code through **Auto: Free**.

---

## 1. Claude

### 1a. Subscription (Pro/Max) — no key
1. Install the Claude Code CLI: https://docs.claude.com/claude-code (the page shows the one-line installer for your system).
2. Open a terminal and run `claude`. Sign in with the **same account that has the subscription** (it opens the browser).
3. Check: `claude --version` should be **2.1.280 or newer** if you want Opus (`claude update` if older).
4. Run `node ar.mjs doctor` — it should show "Claude Code CLI found". Set `CLAUDE_PRIMARY=cli` in `.env`.

### 1b. API key
1. Go to https://console.anthropic.com and sign in (or create an account — this is separate from claude.ai).
2. **Plans & Billing → add credits.** A Pro/Max subscription does **not** include API credit; an API key with zero balance is "valid" but every call fails with *credit balance is too low*.
3. **API Keys → Create Key**. Copy it (starts with `sk-ant-`). It is shown only once.
4. `.env`: `ANTHROPIC_API_KEY=…` and, if you want the API instead of the subscription, `CLAUDE_PRIMARY=api`.

## 2. OpenAI / ChatGPT

**Does ChatGPT Plus include API access? No.** The OpenAI API is billed separately (pay as you go). A Plus/Pro plan works with OpenAI's own terminal tool, the **Codex CLI**,
which signs in with your ChatGPT account and spends your plan's included allowance — the same idea as Claude Code. So with a subscription you use the terminal route.

### 2a. ChatGPT Plus/Pro through the Codex CLI — no key
1. Install Node.js (https://nodejs.org), then in a terminal: `npm install -g @openai/codex`  (docs: https://developers.openai.com/codex).
2. Run `codex login`. A browser opens: sign in with the ChatGPT account that has the plan. On a machine without a browser: `codex login --device-auth`.
3. Check: `codex login status` (exit code 0 = signed in).
4. Configure auto-router: `node ar.mjs openai --route cli`  (add `--mini ID --main ID --max ID` to choose models; run `codex`, type `/model` to see the names. Empty = Codex's default).
5. Test: `node ar.mjs openai --route cli --check`, then restart: `node ar.mjs down && node ar.mjs up`.

### 2b. OpenAI API key
1. Go to https://platform.openai.com and sign in (a different site and billing from chatgpt.com).
2. **Settings → Billing → add payment / credits.**
3. **API keys → Create new secret key** (https://platform.openai.com/api-keys). Copy it (starts with `sk-`); shown once.
4. `.env`: `OPENAI_API_KEY=…`
5. See which models your key can use: `node ar.mjs openai --list`, then
   `node ar.mjs openai --route api --mini <id> --main <id> --max <id> --check`. Use both routes with `--route both` (Codex first, API as fallback).

Then pick a routing profile that uses OpenAI: `node ar.mjs init --roots "<your code folder>" --profile E` (OpenAI + Gemini) or `F` (OpenAI + free pool). Re-running init keeps your `.env`.
`!gpt`, `!gpt-max`, `!gpt-mini` always work as per-message pins once OpenAI is configured.

## 2c. GitHub Copilot (paid plan) through the Copilot CLI — no key
You keep using the Copilot **Chat window** exactly as before. The router additionally gets your plan's models as targets, through GitHub's own terminal tool (programmatic mode `copilot -p`).
1. Needs a **paid** Copilot plan (the free plan is not enough). Check: `node ar.mjs detect` shows the plan; an organization admin can also disable the CLI.
2. Install Node.js 22 or newer (https://nodejs.org), then: `npm install -g @github/copilot`  (alternatives: `winget install GitHub.Copilot` on Windows, `brew install --cask copilot-cli` on macOS/Linux).
3. Run `copilot login`. A browser opens: sign in to GitHub; if your organization uses SSO, click **Authorize**. Without a browser: `copilot login --device-auth` (enter the code at https://github.com/login/device).
4. See which models your plan offers: run `copilot`, type `/model`, read the names, exit.
5. `node ar.mjs copilot --main <model id> --check` (uses one request), then `node ar.mjs copilot --mini <id> --main <id> --max <id>` (leave an id out to use the CLI's default).
6. `node ar.mjs init --roots "<your code folder>" --profile auto` rebuilds the routing with Copilot included (keeps your `.env`), then `node ar.mjs down && node ar.mjs up`.

Notes: each request spends your plan's **premium requests** (heavier models cost more of them; the CLI does not tell us how many are left, so the router cannot forecast this quota — watch GitHub's usage page).
Do **not** put a classic personal access token (`ghp_…`) in the environment: the CLI refuses it; the bridge ignores `GH_TOKEN`/`GITHUB_TOKEN` and uses your `copilot login`.

## 3. Google Gemini (two different keys)

1. Open https://aistudio.google.com/apikey and sign in with a Google account.
2. **Free-tier key** (`GEMINI_FREE_API_KEY`): click **Create API key**, choose **Create API key in new project**. Do **not** attach billing to that project.
3. **Paid key** (`GEMINI_API_KEY`): create a key in a Google Cloud project that **has billing enabled** (https://console.cloud.google.com/billing). Only needed if you want the paid Gemini models
   (and a fast classifier). Free-tier keys are slow (~20 s) and rate limited; paid ones answer in about a second.
4. They must be **two different keys**. How to tell which is which if unsure: `python3 scripts/probe_gemini.py gemini-3.5-flash-lite` with `GEMINI_PROBE_KEY` set — a free key gets some `429` in a burst, a billed key gets none.
5. A brand-new key can return 403 for a few minutes.

## 4. The free pool

Each provider takes about two minutes. After adding any of them: `node ar.mjs omniroute` connects them and **tests every model with a real request**, keeping only those that answer.

### Groq — fastest (fractions of a second)
1. https://console.groq.com → sign up (Google/GitHub/e-mail), no card.
2. **API Keys → Create API Key** (https://console.groq.com/keys). Copy it (starts with `gsk_`).
3. `.env`: `GROQ_API_KEY=…`

### OpenRouter — many `:free` models
1. https://openrouter.ai → sign in.
2. **Keys → Create Key** (https://openrouter.ai/keys). Copy it (starts with `sk-or-`).
3. `.env`: `OPENROUTER_API_KEY=…`  (Free models are limited per day; a one-time small credit purchase raises the limits — optional.)

### Mistral — Codestral (code model)
1. https://console.mistral.ai → create an account; choose the free **Experiment** plan (a phone verification may be asked).
2. **API Keys → Create new key** (https://console.mistral.ai/api-keys). Copy it.
3. `.env`: `MISTRAL_API_KEY=…`

### Ollama Cloud — Gemma, Nemotron
1. https://ollama.com → sign up.
2. **Settings → Keys** (https://ollama.com/settings/keys) → **Add API key**. Copy it.
3. `.env`: `OLLAMA_API_KEY=…`  (The free plan has no DeepSeek/Kimi/GLM — those answer "402: not included"; `node ar.mjs omniroute` drops them automatically.)

### NVIDIA NIM — Nemotron 3 Ultra
1. https://build.nvidia.com → sign in / create a free NVIDIA account and join the (free) NVIDIA Developer Program if asked.
2. Open any model page → **Get API Key** / **Generate Key**. Copy it (starts with `nvapi-`).
3. `.env`: `NVIDIA_API_KEY=…`  (Trial use; many models in its catalogue are not enabled for free accounts — the verification keeps only the ones that work.)

### Cloudflare Workers AI — Llama 3.3 70B, GLM, Gemma, Qwen Coder (free daily allowance)
You need **two** values from the **same page**: the Account ID and a Workers AI token.
1. https://dash.cloudflare.com → sign up / sign in.
2. Left menu: **AI → Workers AI** (it may be under *Build*). Click **Use REST API**.
3. On that page: **Create a Workers AI API Token** (the pre-filled template "Workers AI"). Create it and **copy the token** (shown once).
4. On the same page copy the **Account ID** (32 hexadecimal characters).
5. `.env`: `CLOUDFLARE_ACCOUNT_ID=…` and `CLOUDFLARE_API_TOKEN=…`
6. `node ar.mjs keys --check` must print *works* for Cloudflare.

Traps we hit (do not repeat them):
- **A "user ID" is not the Account ID.** Cloudflare's built-in chat assistant may give you both; only the Account ID is used. A user ID returns *Invalid account identifier*.
- **A token created from the "Create additional tokens" / "API Tokens Write" template cannot call Workers AI**: it can only create other tokens. Symptom: *Authentication error* on every call
  although `…/user/tokens/verify` says the token is active. Fix: create the Workers AI token as in step 3. If you already have such a token and the Account ID, you can let auto-router mint the right one:
  `node ar.mjs cloudflare-token` (it uses the token-writing token once, creates a token limited to Workers AI on your account, saves it to `.env`, and prints nothing secret; then delete the old token in the dashboard).
- The token must be allowed on the same account whose ID you pasted.

### LLM7 — no key
`node ar.mjs omniroute` adds it automatically (a placeholder key is used). It offers a DeepSeek model and others, with a daily token cap. Prompts may be logged; skip it with `node ar.mjs omniroute --no-llm7`.

---

## Checking and fixing
| `node ar.mjs keys --check` says | Meaning / fix |
|---|---|
| `empty` | Not set — fine if you do not use that provider. |
| `works` | Accepted by the provider. |
| `FAILS … 401` | Wrong key: copy it again from the provider's page (no spaces or quotes), save `.env`. |
| `FAILS … 403` | Not allowed: brand-new Google/Cloudflare keys can take minutes; or the plan/project has no access. |
| `works (rate limited now)` | The key is fine; you hit its rate limit at this moment. |

Not sure what you already have? `node ar.mjs detect` lists the logged-in tools and plans on this computer.

After adding or changing keys: `node ar.mjs omniroute` (free pool), `node ar.mjs openai …` (OpenAI), then `node ar.mjs down && node ar.mjs up`.

## Optional keys the router can use once you add the model (not wired by default)
`models.yaml` already describes **DeepSeek** (`DEEPSEEK_API_KEY`, class `restricted`: servers in China, no zero-retention option — ordinary prompts only, never sensitive content), **xAI Grok** (`XAI_API_KEY`) and **Gemini 4 Argon**. They stay off until you (1) have the key in `.env`, (2) verify the model id with one real call, (3) add the `model_list` entry to `litellm/config.yaml` and the variable to the gateway's `environment:` list in `docker-compose.yml`. Steps: [ROUTING.md](ROUTING.md#adding-a-model). Never add an id you have not called.
