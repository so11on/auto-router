# Installation lessons (deep dive)

> The quick, automated path is [`INSTALL_WITH_AI.md`](../INSTALL_WITH_AI.md) and `node ar.mjs`. This file keeps every trap met during the first installation
> (2026-10-20/24) and the manual way of doing each step. Where it says `scripts/…`, the command now lives in `ar.mjs`.

# auto-router — installation guide for an AI assistant

**Audience:** an AI coding assistant (Claude Code, Copilot agent, etc.) installing this tool on the machine of a *different person*.
**Goal:** the person gets three model names in their editor chat — `auto-free`, `auto-balanced`, `auto-smart` — that pick the model per task,
set the reasoning effort, fall back across providers, and continue an answer on another model if one dies mid-way.
**Read first, act second.** Everything below comes from a real installation (2026-10-20) and includes every trap hit. Do the phases in order. Never skip a verification step.

Rules for you, the installer:
- **Never guess a model id.** Call the provider's live model list and one tiny request per model (steps in Phase 6). Provider lists, docs and OmniRoute's own catalogue were stale or wrong in our run.
- **Never print, log or commit secrets.** Read keys from `.env` inside scripts; show only `[set]/[empty]`.
- **Ask before anything outward-facing or irreversible** (installing a login-time service, opening ports, spending money, changing the person's editor settings).
- **Do not use a Claude Pro/Max subscription token anywhere except the official `claude` binary.** Never put it in a proxy. (See Phase 2.)
- Report honestly: what passed, what failed, what was not tested.

---

## Phase 0 — Interview the person (ask all of these, then wait)

Ask in one message. Record the answers; they drive every later phase.

1. **Operating system and tools.** OS? Is Docker installed and running? Node.js version (bridge needs ≥ 18)? Python ≥ 3.9? Editor = VS Code ≥ 1.122 with GitHub Copilot Chat? (If another editor, the gateway still works; only Phase 9 changes.)
2. **Where do you keep code?** Absolute path(s) → `BRIDGE_ALLOWED_ROOTS` (comma separated). Claude Code will be allowed to edit files only there.
3. **Which PAID models do you use / have credit for?** For each, get the exact access type:
   | Provider | Ask | Why it matters |
   |---|---|---|
   | Anthropic Claude | "Claude **subscription** (Pro/Max) only, **API** key with credits, both, or none?" | Subscription → use the `claude` CLI bridge (`CLAUDE_PRIMARY=cli`). API credits → `CLAUDE_PRIMARY=api`. Both → choose primary, the other is the fallback. |
   | Google Gemini | "A key from a project **with billing** (paid)? Separately, can you create a key in a new project **without billing** (free tier)?" | Paid key = `GEMINI_API_KEY` (also runs the classifier). Free-tier key = `GEMINI_FREE_API_KEY`. They must be two different keys. |
   | OpenAI / others | "Any other paid API?" | Not wired by default; see Phase 5.4 to add one. |
4. **Budget stance.** "Is it OK for `auto-balanced`/`auto-smart` to spend money? Monthly ceiling?" (There is no automatic spend cap; ``ar.mjs usage`` reports usage.)
5. **Privacy.** "May prompts go to free tiers that can log or train on them (Gemini free tier, OpenRouter `:free`, LLM7, NVIDIA trial, Mistral free)?" If **no**, do not enable `auto-free` pool providers; make `auto-free` unavailable or point it only at providers they accept.
6. **Free providers.** Offer the list in Phase 2.2 and ask which accounts they will create (each needs a signup by the person; you cannot do it for them).
7. **Autostart.** "Should the Claude bridge start automatically at login?" (default: no; see Phase 8.)

Decide the **profile** from the answers:

| Profile | Condition | `routing.yaml` to use (Phase 5.3) |
|---|---|---|
| A | Claude (subscription or API) **and** paid Gemini | the shipped `litellm/routing.yaml` |
| B | Paid Gemini, no Claude | Variant B |
| C | Claude, no paid Gemini | shipped file, but set `CLASSIFIER_MODEL` to a model they have (Phase 5.2); `balanced` c2–c3 must be edited to a model they have |
| D | Only free | Variant D; `auto-balanced` and `auto-smart` degrade to free models — tell the person plainly |

---

## Phase 1 — Prerequisites and project files

1. Get the repository (`git clone`). It contains: `docker-compose.yml`, `litellm/{config.yaml,routing.yaml,router_hook.py}`, `claude-bridge/{server.mjs,start.sh}`, `scripts/`, `tests/`, `docs/`, `.env.example`, `AGENTS.md`. **Do not accept or copy someone else's `.env`, `.env.bak`, `data/`** — they contain secrets/usage.
2. Check tools; install what is missing (ask first):
   ```sh
   docker --version && docker compose version
   node --version        # >= 18 for claude-bridge
   python3 --version     # >= 3.9 for scripts/tests
   claude --version      # only if using the Claude CLI route; person must be logged in (`claude` then /login)
   ```
3. **OmniRoute does not run on Node ≥ 23 natively** (its docs say Node 18–22). Always use its Docker image (`diegosouzapw/omniroute`), which `docker-compose.yml` already does.
4. Shell is probably **zsh** on macOS: write `${var}:suffix`, never `$var:suffix` (zsh treats `:s...` as a modifier and silently breaks URLs).

## Phase 2 — Accounts and keys (the person does the signups; you tell them exactly where)

### 2.1 Paid
- **Anthropic API:** console.anthropic.com → Plans & Billing (buy credits) → API Keys. *A Claude Pro/Max subscription gives no API credit.* A key with zero balance is "valid" but every call fails with `credit balance is too low`.
- **Claude subscription:** nothing to create; the person runs `claude` and logs in. **Terms:** Anthropic's position (reported in 2026 by secondary sources — have the person read the current Claude Code legal page) is that subscription OAuth tokens are for Claude Code and Claude.ai only. The bridge runs the official binary as the person and never touches the token, which is less risky than a proxy but not guaranteed acceptable. If the person is uneasy, use `CLAUDE_PRIMARY=api` only.
- **Gemini billed key:** aistudio.google.com/apikey → create key in a project **with billing enabled**.

### 2.2 Free providers (all optional; more = more resilience)
| Provider | Where | Notes verified 2026-10-20 |
|---|---|---|
| Gemini free tier | aistudio.google.com/apikey → **Create API key in new project**, attach **no** billing | Works but ~20 s per answer, 15 req/min on flash-lite. Only `gemini-3.5-flash-lite` is kept. New keys may return 403 for a few minutes. |
| Groq | console.groq.com/keys | Fast (0.3–0.5 s). Works: `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`. |
| OpenRouter | openrouter.ai/keys | `:free` models rotate; some 404. |
| Mistral | console.mistral.ai/api-keys | Only `codestral-latest` answered reliably on our free plan. |
| Ollama Cloud | ollama.com/settings/keys | Free plan has `gemma4:31b`, `nemotron-3-super/ultra`, `gpt-oss`, `minimax-m3.1-flash`. DeepSeek/Kimi/GLM are **paid (HTTP 402)**. |
| NVIDIA NIM | build.nvidia.com (free Developer Program) | Only a handful of the ~80 listed models work (`nvidia/nemotron-3-ultra-550b-a55b`); many are 404/410/timeouts. |
| Cloudflare Workers AI | dash.cloudflare.com | Needs **Account ID** + API token (below). |
| LLM7 | none needed (placeholder key) | Keyless; has a DeepSeek-V4-Flash. Prompts may be logged; ToS "experimentation". |

**Cloudflare Account ID:** it is **not** the e-mail. It is 32 hex characters, visible in the dashboard URL right after the login (`dash.cloudflare.com/<ACCOUNT_ID>/...`) or in the Workers & Pages sidebar. An account-scoped API token cannot list accounts through the API (it returns an empty list) — the person must copy it. Then verify: `curl https://api.cloudflare.com/client/v4/accounts/<ID>/ai/models/search?per_page=1 -H "Authorization: Bearer <token>"` must succeed; a 401 "Authentication error" means the id is wrong or the token does not include that account under *Account Resources* / lacks the *Workers AI* permission (we hit exactly this). Token: My Profile → API Tokens → Create Token → template **Workers AI**.

Tell the person: **save the file** after pasting keys (an unsaved editor buffer is invisible to you — this cost us one round trip).

## Phase 3 — Create `.env`

```sh
cd auto-router && cp .env.example .env && chmod 600 .env
```
Generate secrets yourself (do not ask the person to invent them):
```sh
LITELLM_MASTER_KEY="sk-$(openssl rand -hex 16)"
BRIDGE_KEY="$(openssl rand -hex 16)"
OMNIROUTE_PASSWORD="$(openssl rand -hex 12)"
```
Final shape (values omitted; keep exactly these names and sections; every key blank unless the person has it):

```dotenv
# --- gateway (LiteLLM) ---
LITELLM_MASTER_KEY=sk-...                # bearer clients use against LiteLLM (:4000)
ROUTING_FILE=/app/routing.yaml
CLASSIFIER_MODEL=gemini/gemini-3.5-flash-lite   # any LiteLLM model string the person can call; falls back to a heuristic on error

# --- Gemini: two different keys on purpose ---
GEMINI_API_KEY=                          # project WITH billing (paid models + classifier)
GEMINI_FREE_API_KEY=                     # project WITHOUT billing (free tier). NEVER the billed key.

# --- Claude ---
ANTHROPIC_API_KEY=                       # API key with credits (route "api")
CLAUDE_PRIMARY=cli                       # cli = Claude Code bridge (subscription), api = Anthropic API

# --- claude-bridge (host process) ---
BRIDGE_KEY=...                           # required; bridge refuses to start without it
BRIDGE_ALLOWED_ROOTS=/abs/path/to/code   # comma separated; Claude Code may edit only here

# --- free pool (OmniRoute) ---
FREE_POOL_BASE=http://omniroute:20128/v1
FREE_POOL_KEY=                           # filled in Phase 5.1
FREE_POOL_ENABLED=false                  # set true after Phase 6 proves the combos work
OMNIROUTE_PASSWORD=...

# --- free provider keys (registered in OmniRoute, not read by services) ---
GROQ_API_KEY=
OPENROUTER_API_KEY=
MISTRAL_API_KEY=
OLLAMA_API_KEY=
NVIDIA_API_KEY=
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
```
Validate without printing: `awk -F= '/^[A-Za-z_]/{print $1, (length($2)>0?"[set]":"[empty]")}' .env`

**Important:** if `ANTHROPIC_API_KEY` is set and you start the bridge by sourcing `.env`, the bridge must strip it before spawning `claude`, otherwise the CLI bills the (possibly empty) API account instead of the subscription. The shipped `server.mjs` already deletes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` from the child environment — do not remove that.

## Phase 4 — Start the stack

```sh
node ar.mjs up          # docker compose up -d (omniroute + litellm) and the bridge (host)
node ar.mjs status
```
- `docker-compose.yml` publishes LiteLLM and OmniRoute on `127.0.0.1` only. Keep it that way.
- First start pulls images (minutes). LiteLLM listens on `127.0.0.1:4000`, OmniRoute on `127.0.0.1:20128`, bridge on `127.0.0.1:4100`.
- If the person has no Claude CLI route, skip the bridge: `docker compose up -d` only.

## Phase 5 — Configure

### 5.1 OmniRoute (free pool)
OmniRoute's management API needs a **login cookie**; `/v1/*` needs an **API key**.
```sh
J=$(mktemp)                              # cookie jar, outside the repo
PW=$(grep ^OMNIROUTE_PASSWORD= .env | cut -d= -f2)
curl -s -c $J -X POST 127.0.0.1:20128/api/auth/login -H 'Content-Type: application/json' -d "{\"password\":\"$PW\"}"
# create the API key LiteLLM will use; the value is shown ONCE -> write it straight into .env
K=$(curl -s -b $J -X POST 127.0.0.1:20128/api/keys -H 'Content-Type: application/json' -d '{"name":"litellm"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['key'])")
sed -i.bak "s|^FREE_POOL_KEY=.*|FREE_POOL_KEY=$K|" .env && rm -f .env.bak
```
Register each provider the person has a key for (repeat; provider ids: `groq`, `openrouter`, `mistral`, `ollama-cloud`, `nvidia`, `cloudflare-ai`, `llm7`):
```sh
KEY=$(grep ^GROQ_API_KEY= .env | cut -d= -f2-)
ID=$(curl -s -b $J -X POST 127.0.0.1:20128/api/providers -H 'Content-Type: application/json' \
  -d "$(python3 -c "import json,sys;print(json.dumps({'provider':'groq','name':'groq','apiKey':sys.argv[1]}))" "$KEY")" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['connection']['id'])")
curl -s -b $J -X POST 127.0.0.1:20128/api/providers/$ID/test      # REQUIRED: a new connection stays inactive until tested ("No active credentials")
curl -s -b $J 127.0.0.1:20128/api/providers/$ID/models            # what OmniRoute THINKS exists (may be stale)
```
- LLM7: `apiKey` = any placeholder (`unused`). Cloudflare: the provider needs the Account ID in addition to the token — check OmniRoute's `PROVIDER_REFERENCE.md` inside the container (`docker compose exec omniroute sh -c 'grep -n cloudflare /app/docs/reference/PROVIDER_REFERENCE.md'`) and the dashboard form; if the API call rejects, add it in the dashboard (`http://127.0.0.1:20128`, password from `.env`).
- **Do not probe retired or paid model ids through OmniRoute.** One 410 (retired model) made OmniRoute lock the whole Ollama connection: every model then returned 410 until we deleted and recreated the connection. Probe the provider's own API (Phase 6) and only add models that passed.
- **Do not use OmniRoute's `auto/*` model ids.** `auto/best-free` picked an Arabic 7B model, and some ids route to providers needing a headless browser and hang for minutes. Use explicit combos.

Create the two combos **with exactly these names** (LiteLLM refers to them) after Phase 6 has produced the list of working models:
```sh
curl -s -b $J -X POST 127.0.0.1:20128/api/combos -H 'Content-Type: application/json' \
  -d '{"name":"free-fast","strategy":"priority","models":["groq/openai/gpt-oss-20b","groq/qwen/qwen3.8-27b"]}'
curl -s -b $J -X POST 127.0.0.1:20128/api/combos -H 'Content-Type: application/json' \
  -d '{"name":"free-coding","strategy":"priority","models":["groq/openai/gpt-oss-120b","mistral/codestral-latest"]}'
# change later:  GET /api/combos -> id ; PUT /api/combos/<id> {"models":[...]}  (an array REPLACES the old one)
```
Model ids are `<provider>/<model id as the provider names it>` (e.g. `nvidia/nvidia/nemotron-3-ultra-550b-a55b`, `openrouter/minimax/minimax-m3.1-flash:free`). Order = priority: put the fastest, most reliable first. Known OmniRoute quirk: it rewrote `gpt-oss:120b` to `gpt-oss-120b` for Ollama (404) — skip such models.

### 5.2 `litellm/config.yaml`
- **Remove every `model_list` entry the person has no access to** (and its `fallbacks` lines), otherwise fallbacks waste time on them. Examples: no Claude CLI → delete `claude-*-cli`; no Anthropic API → delete `claude-*-api`; no paid Gemini → delete `gemini-flash-lite|flash|pro`; no free Gemini key → delete `gemini-free-flash-lite` and change `FREE_FALLBACK_MODEL` in `router_hook.py`.
- Verify ids as in Phase 6 before keeping them. Ids from our run (2026-10-20): `gemini-3.5-flash-lite`, `gemini-3.8-flash`, `gemini-3.1-pro-preview`, `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`. **`gemini-2.5-*` are gone for new accounts (404).**
- Keep `timeout: 15` and `num_retries: 0` on the three `free-pool*` entries: an OmniRoute call with nothing usable hangs for minutes.
- If the person lacks paid Gemini, set `CLASSIFIER_MODEL` to a cheap model they can call (LiteLLM string, e.g. `groq/openai/gpt-oss-20b` needs `GROQ_API_KEY` in the container env — add that variable to `.env` and it is passed through `env_file`). The hook falls back to a keyword heuristic if the classifier fails, so routing still works, less precisely.
- `CLAUDE_PRIMARY` in `.env` picks `-cli` or `-api`; each route is the other's fallback.

### 5.3 `litellm/routing.yaml`
Table "mode → first tier whose `max_complexity` ≥ the task complexity (1–5)". Effort `low|medium|high`. Shipped file = profile A. Variants (replace the file's `modes:` block):

**Variant B — Gemini only (no Claude)**
```yaml
modes:
  free:
    - {max_complexity: 2, model: free-pool-fast}
    - {max_complexity: 5, model: free-pool-coding}
  balanced:
    - {max_complexity: 1, model: free-pool-fast}
    - {max_complexity: 3, model: gemini-flash-lite}
    - {max_complexity: 5, model: gemini-flash}
  smart:
    - {max_complexity: 1, model: gemini-flash-lite}
    - {max_complexity: 2, model: gemini-flash}
    - {max_complexity: 3, model: gemini-pro, effort: low}
    - {max_complexity: 4, model: gemini-pro, effort: medium}
    - {max_complexity: 5, model: gemini-pro, effort: high}
```
**Variant D — free only** (tell the person `auto-smart` is just the best free model):
```yaml
modes:
  free:     [{max_complexity: 2, model: free-pool-fast}, {max_complexity: 5, model: free-pool-coding}]
  balanced: [{max_complexity: 2, model: free-pool-fast}, {max_complexity: 5, model: free-pool-coding}]
  smart:    [{max_complexity: 5, model: free-pool-coding}]
```
Keep the `task_bump:` block at the top. Model names with no suffix `claude-haiku|sonnet|opus` get `-cli`/`-api` appended by the hook. Any other `model:` must be a `model_name` from `config.yaml`.

### 5.4 Adding another paid provider (e.g. OpenAI)
1. In `config.yaml` add `- {model_name: gpt-main, litellm_params: {model: openai/<model id verified via GET https://api.openai.com/v1/models>, api_key: os.environ/OPENAI_API_KEY}}`.
2. Add `OPENAI_API_KEY=` to `.env` (+ `.env.example`).
3. Reference `gpt-main` in `routing.yaml` tiers and add `fallbacks:` entries both ways.
4. Add a line to `tests/` if the logic changed, run the unit tests.

### 5.5 Apply
```sh
docker compose up -d --force-recreate litellm     # after any change to config.yaml / router_hook.py / .env
```
`routing.yaml` changes need no restart. Bridge changes need `pkill -f "node server.mjs"; node claude-bridge/start.mjs &`.

## Phase 6 — Verify every model, then prune (do not skip)

For each model you intend to keep, call the **provider directly** with one cheap request. Use `max_tokens ≥ 200` for reasoning models (gpt-oss, Gemma) — at 60 they return an empty `content`.

```sh
# OpenAI-compatible providers (Groq, OpenRouter, Mistral, Ollama, NVIDIA, LLM7):
curl -s -m 60 -w "\n[%{http_code} %{time_total}s]\n" <BASE>/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"<id>","max_tokens":300,"messages":[{"role":"user","content":"In one sentence, what is a mutex?"}]}'
# bases: Groq https://api.groq.com/openai/v1 · OpenRouter https://openrouter.ai/api/v1 · Mistral https://api.mistral.ai/v1
#        Ollama https://ollama.com/v1 · NVIDIA https://integrate.api.nvidia.com/v1 · LLM7 https://api.llm7.io/v1
# Anthropic: GET https://api.anthropic.com/v1/models  (headers x-api-key, anthropic-version: 2023-06-01)
# Gemini:    GET https://generativelanguage.googleapis.com/v1beta/models  (header x-goog-api-key)
```
**Keep** a model only if: HTTP 200, non-empty `content`, answer in **< ~5 s** typically, and it passes a second call. **Drop** anything with 402/403/404/410, empty answers, repeated text, > 10 s, or intermittent 5xx. In our run these were dropped for those reasons: Gemini free Flash family (5–20 req/min, 403/429/503), Gemma (500s), most NVIDIA models (404/410/timeouts), Ollama DeepSeek/Kimi/GLM (402 paid), Mistral small/medium/devstral/large (429/403), Groq `qwen3.6`/`compound` (retired).

**Gemini: is this key free or billed?** The API never says. Burst 30 parallel one-token requests on a Flash model (`scripts/probe_gemini.py`). A free key answers part of them with HTTP 429 and `generate_content_free_tier_requests, limit: N`; a billed key answers all 200 (including Pro). Run it for both keys to be sure they are not swapped:
```sh
GEMINI_PROBE_KEY=$(grep ^GEMINI_FREE_API_KEY= .env | cut -d= -f2-) python3 scripts/probe_gemini.py gemini-3.5-flash-lite
```

Then set `FREE_POOL_ENABLED=true` in `.env` (only if the combos exist and work) and recreate LiteLLM.

## Phase 7 — Test

```sh
pip install pyyaml && python3 -m unittest discover -s tests -v     # 32 tests, offline
node ar.mjs smoke                                                    # one request per mode; all must PASS
node ar.mjs logs --tail 20                                   # shows route/call events
node ar.mjs usage                                            # usage shares
```
**A passing smoke test can hide a broken route** because fallbacks answer for it. After `smoke.sh`, read `node ar.mjs logs --errors --since 10m`: every `call ... error` is a route that failed and was covered by a fallback. Fix or remove those. (We once had `auto-smart` "passing" while the Claude CLI was billing an empty API account.)

Mid-answer failover test (proves a half-written answer continues on another model):
```sh
python3 scripts/flaky_server.py &        # fixture on 0.0.0.0:4199 — kill it afterwards
curl -sN localhost:4000/v1/chat/completions -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"test-flaky","stream":true,"messages":[{"role":"user","content":"Count from 1 to 20"}]}'
kill %1
```
Expected: `1, 2, 3, 4, 5, 6,` then `> ⚠️ test-flaky was interrupted ... Continuing with gemini-flash-lite.` then `7, 8, ...`. (Requires the person to have `gemini-flash-lite` configured; otherwise change the `test-flaky` fallback in `config.yaml`.)

Bridge checks: 401 without key; 403 for a path outside `BRIDGE_ALLOWED_ROOTS`; a read-only ask returns text ending with `*Claude Code (...)*`; an agent request (with a `tools` array) edits a file in a scratch git repo.

## Phase 7b — Claude Code version (only for the CLI route)
`claude --version` must be recent: **Opus 5.5 requires Claude Code ≥ 2.1.280** ("does not support this model" with 400 otherwise); Sonnet/Haiku 5.5 worked on 2.1.72.
Test every Claude model through the bridge (`curl 127.0.0.1:4100/v1/chat/completions` with `claude-code-opus|sonnet|haiku`), and if one fails ask the person before running `claude update`.

## Phase 8 — Operations the person should know
- Choosing a model from the chat: `!opus`, `!sonnet`, `!haiku`, `!pro`, `!flash`, `!deepseek`, `!gpt-oss`, `!nemotron`, `model:<alias>` or "usando o Opus" pins that model for the turn (aliases in `routing.yaml` → `pins:`; `auto-free` ignores paid pins). Tell the person which pins work given what they installed.
- `node ar.mjs up|down|status`; the bridge does **not** start at login. If they want that, create a launchd/systemd unit running `node claude-bridge/start.mjs` — **ask first**; it is a persistent agent able to edit files in the allowed roots.
- `node ar.mjs logs -f` live log; `node ar.mjs usage` token shares; limits only shown where `scripts/quotas.json` has a verified number.
- Out of tokens/limit **before** text: silent fallback to the next model. **While writing:** the next model continues and a one-line warning appears in the answer. Everything is logged (`stream_failover` events).
- Free providers rotate models and quotas: re-run Phase 6 monthly; remove dead ids from the combos.

## Phase 9 — Editor wiring (VS Code ≥ 1.122)
Use the schema from VS Code's official docs (*Language models → Custom Endpoint configuration reference*). The user file is
`~/Library/Application Support/Code/User/chatLanguageModels.json` (macOS) or the OS equivalent. **Ask the person first, back the file up
(`cp file file.bak-auto-router`), and append an object — never replace the file (it may hold other providers).** Insert before the final `]`:
```json
{
  "name": "auto-router",
  "vendor": "customendpoint",
  "apiKey": "unused",
  "apiType": "chat-completions",
  "models": [
    {"id": "auto-free",     "name": "Auto: Free",     "url": "http://localhost:4000/v1/chat/completions", "toolCalling": true, "vision": false, "thinking": false, "streaming": true, "maxInputTokens": 100000, "maxOutputTokens": 16000, "requestHeaders": {"Authorization": "Bearer <LITELLM_MASTER_KEY>"}},
    {"id": "auto-balanced", "name": "Auto: Balanced", "url": "http://localhost:4000/v1/chat/completions", "toolCalling": true, "vision": false, "thinking": false, "streaming": true, "maxInputTokens": 100000, "maxOutputTokens": 16000, "requestHeaders": {"Authorization": "Bearer <LITELLM_MASTER_KEY>"}},
    {"id": "auto-smart",    "name": "Auto: Smart",    "url": "http://localhost:4000/v1/chat/completions", "toolCalling": true, "vision": false, "thinking": false, "streaming": true, "maxInputTokens": 100000, "maxOutputTokens": 16000, "requestHeaders": {"Authorization": "Bearer <LITELLM_MASTER_KEY>"}}
  ]
}
```
- Keep `apiType: chat-completions` — mid-answer failover only exists for streaming Chat Completions (the `responses` and `messages` types bypass it).
- **The key must go in `requestHeaders`, per model.** Verified failures: a hand-written `${input:name}` is never prompted (VS Code sends `Authorization: Bearer` with an empty key → LiteLLM 401 "Malformed API Key"), and a literal `apiKey` string is **also ignored** (we captured the header: just the word `Bearer`, no key). The documented override works: `"requestHeaders": {"Authorization": "Bearer <LITELLM_MASTER_KEY>"}` on every model. Read the key from `.env` inside a script, never print it, `chmod 600` the file, and tell the person the trade-off: the key is plain text in a file Settings Sync might upload; it only opens the loopback gateway; rotating it is one edit. If they prefer the secret store they must add the provider through *Chat: Manage Language Models* themselves.
- If it still fails, **capture what VS Code sends**: run a tiny HTTP server on another port that logs header names, the `Authorization` scheme and token length (never the token), point one model's `url` at it, ask the person to send a message, then restore the URL. That is how we found the empty `Bearer`.
- `toolCalling: true` is required for Agent mode; `maxInputTokens + maxOutputTokens` must fit the smallest context among the free models.
- Tell the person to: run **Developer: Reload Window**, pick **Auto: …** in the chat model picker, then ask an easy and a hard question in Ask and in Agent, and check `node ar.mjs logs --tail 10`.
- Before touching the editor, prove the endpoint accepts what VS Code sends: a streaming request with a `tools` array to `auto-free` and `auto-balanced` must end with `finish_reason: tool_calls` or text.
Every final answer ends with a footer naming the model (`*auto-router · auto-free → free-pool-fast · groq/gpt-oss-20b · explain c1 · 2.2s*`); `AUTO_ROUTER_FOOTER=false` disables it. Known gaps to tell the person: when Claude is chosen through the CLI route, Claude Code (not the editor's tools) performs the edits and the chat shows its text; free models are weaker at tool calling in Agent mode; the editor UI flow itself was not driven end to end in our installation.

## Troubleshooting (symptom → cause → fix)
| Symptom | Cause / fix |
|---|---|
| `auto-free` takes ~20 s | It is on the Gemini free tier (slow). Pool disabled or empty: check `FREE_POOL_ENABLED`, provider connections active (`/test`), combos exist. |
| Requests hang for minutes | OmniRoute call with no usable provider; keep `timeout: 15` on pool entries. |
| `No active credentials for provider` | New OmniRoute connection never tested: `POST /api/providers/<id>/test`. |
| Every model of one provider returns the same 410 | OmniRoute locked the connection after a retired-model call: delete and recreate it, test, never probe dead ids via OmniRoute. |
| `credit balance is too low` on a Claude route | The API route (empty account) was used or `ANTHROPIC_API_KEY` leaked into the CLI. Use `CLAUDE_PRIMARY=cli`; keep the bridge's env stripping. |
| Bridge: 401 / connection refused | Bridge not running or `BRIDGE_KEY` differs from `.env`. Restart it. |
| Bridge 403 | Workspace outside `BRIDGE_ALLOWED_ROOTS`. |
| Claude Code "can't find file" | Workspace not detected (no absolute path in the conversation): set `BRIDGE_DEFAULT_CWD` or send header `x-workspace`. |
| Gemini 404 "no longer available to new users" | Retired model; list models and pick a 3.x one. |
| Gemini 403 on a brand-new key | Propagation delay; retry in minutes. |
| Gemini free key behaves like a paid one | It is a billed key. Create the free one in a project **without** billing. |
| Empty `content` from gpt-oss/Gemma | Reasoning model used all `max_tokens` thinking; raise to ≥ 200–400. |
| URLs with `$var:suffix` break | zsh modifier; use `${var}:suffix`. |
| `.env` edits ignored | The editor buffer was not saved, or LiteLLM was not recreated. |
| VS Code fails; ``ar.mjs logs`` shows 401 "Malformed API Key" | VS Code sent an empty key. Use `requestHeaders` (Phase 9); `apiKey` (literal or `${input:...}`) is not honoured. |
| OmniRoute `/api/*` says authentication required | Log in again; cookie expired. |

## Final report to give the person
List: which profile was installed; models kept per mode; which providers are connected; what the tests showed (unit count, smoke result, failover test, errors seen in the log); what was **not** verified (editor wiring, any untested provider); what costs money (paid tiers in `balanced`/`smart`); where logs are; how to stop everything; the terms-of-service notes for the Claude CLI route and free tiers that log prompts.

## Lessons from the security hardening (2026-10-25)
| Symptom | Cause / fix |
|---|---|
| `doctor` warns the auto-router is inside the folder the agent may edit | `BRIDGE_ALLOWED_ROOTS` contains the install folder (your `.env` is then readable by the agent). Move the install outside the code folders and rerun `init --roots` with the code folder only. |
| Auto: Free says it has no model with safety mode on | `data/pool-members.json` does not exist yet: run `node ar.mjs omniroute`. |
| After stopping OmniRoute the gateway is down too | The gateway depends on it in Compose: `docker compose up -d` brings both back (the upgrade commands do this). |
| Claude Code ignores `Write(...)` deny rules | It only matches `Edit(...)` rules (they cover Write); the shipped settings use `Edit`. The `PreToolUse` hook is the second layer. |
| Files written by the container are unreadable on Linux | `AR_UMASK=022` in `.env` (default 077 makes them private to the container's root). |
| OmniRoute rejects an empty combo | A combo needs at least one model; it returns the new id at the top level. |
| A paid API key without credit keeps being tried | Fixed: the router pauses a model for 6 h after "credit balance is too low". Remove `ANTHROPIC_API_KEY` or add credit. |
