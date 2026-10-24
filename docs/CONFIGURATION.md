# Configuration

## Files
| File | Purpose | Reload |
|---|---|---|
| `.env` (from `.env.example`) | secrets and switches; never commit | restart LiteLLM (`docker compose up -d --force-recreate litellm`) and the bridge |
| `litellm/config.yaml` | model list, fallbacks, timeouts, hook registration | restart LiteLLM |
| `litellm/routing.yaml` | mode → tiers table | none (read per classification) |
| `docker-compose.yml` | services and mounts | `docker compose up -d` |

## Environment variables (`.env`)
| Variable | Used by | Meaning |
|---|---|---|
| `LITELLM_MASTER_KEY` | LiteLLM | Bearer token clients use against `:4000`. |
| `ANTHROPIC_API_KEY` | LiteLLM | Anthropic API (`claude-*-api`). Needs account credits. |
| `GEMINI_API_KEY` | LiteLLM, classifier | Gemini key on a **billed** project (`gemini-flash-lite`, `gemini-flash`, `gemini-pro`, classifier). |
| `GEMINI_FREE_API_KEY` | LiteLLM | Gemini key from a project **without billing** (free tier). Never put the billed key here. |
| `FREE_POOL_BASE`, `FREE_POOL_KEY` | LiteLLM | OmniRoute URL (`http://omniroute:20128/v1`) and its API key. |
| `FREE_POOL_ENABLED` | hook | `true` (current) uses the OmniRoute combos; `false` routes pool tiers to the Gemini free tier. Default when unset: `false`. |
| `OMNIROUTE_PASSWORD` | OmniRoute | Dashboard password (seeded through `INITIAL_PASSWORD`). |
| `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `OLLAMA_API_KEY`, `NVIDIA_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | operator | Free-provider keys to add in the OmniRoute dashboard. Not read by any service directly. |
| `OPENAI_API_KEY` | LiteLLM | OpenAI API key (`gpt-*-api`); billed separately from ChatGPT Plus/Pro. |
| `OPENAI_PRIMARY` | hook | `cli` (default: Codex CLI with your ChatGPT login, through the bridge) or `api` (OpenAI API key). |
| `CODEX_MODEL_MINI`, `CODEX_MODEL_MAIN`, `CODEX_MODEL_MAX` | bridge | Model ids passed to `codex exec -m` for the cli route; empty = Codex's default. Written by `node ar.mjs openai`. |
| `CODEX_BIN`, `CODEX_AGENT_SANDBOX` | bridge | Codex binary (default `codex`) and the sandbox used when a request carries tools (default `workspace-write`; requests without tools use `read-only`). |
| `CLAUDE_PRIMARY` | hook | `cli` (default, Claude Code bridge) or `api` (Anthropic API). |
| `CLASSIFIER_MODEL` | hook | LiteLLM model string for classification (default `gemini/gemini-3.5-flash-lite`). |
| `USAGE_FILE` | hook | Usage log path inside the container (default `/app/data/usage.jsonl`, mounted from `./data`). |
| `AUTO_ROUTER_FOOTER` | hook | `true` (default) appends `*auto-router · <mode> → <group> · <provider/model> · <task> c<n> · <secs>s*` to every final answer; `false` disables. |
| `EVENT_LOG` | hook | Operation log path in the container (default `/app/data/router.jsonl`). |
| `ROUTING_FILE` | hook | Path inside the container (default `/app/routing.yaml`). |
| `BRIDGE_KEY` | bridge, LiteLLM | Required bearer for the bridge; the bridge refuses to start without it. |
| `BRIDGE_ALLOWED_ROOTS` | bridge | Comma-separated directories where Claude Code may act (required; set by `node ar.mjs init --roots`). |

## Bridge-only variables (optional, set in the shell or `.env`)
| Variable | Default | Meaning |
|---|---|---|
| `BRIDGE_PORT` | 4100 | Listen port (always 127.0.0.1). |
| `BRIDGE_DEFAULT_CWD` | first entry of `BRIDGE_ALLOWED_ROOTS` | Used when no workspace path is found in the conversation. |
| `BRIDGE_AGENT_MODE` | `acceptEdits` | Claude Code permission mode for requests that carry tools. |
| `BRIDGE_ALLOWED_TOOLS` | empty | Extra pre-approved tools, e.g. `Bash(git status:*) Bash(npm test:*)`. Empty = no shell. |
| `BRIDGE_TIMEOUT_MS` | 600000 | Kill a Claude Code run after this long. |
| `BRIDGE_STATE` | `~/.auto-router/bridge-state.json` | Session store. |
| `CC_HAIKU`, `CC_SONNET`, `CC_OPUS` | `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` | Model ids passed to `claude --model`. |
| `CLAUDE_BIN` | `claude` | CLI binary. |

## `litellm/config.yaml` conventions
- `model_name` is what routing and fallbacks refer to; `litellm_params.model` is `provider/model-id`.
- Model ids were verified against each provider on 2026-10-20. Re-verify after a provider deprecates models
  (`scripts/probe_gemini.py`, Anthropic `GET /v1/models`).
- Pool entries have `timeout: 15` and `num_retries: 0` because an empty OmniRoute hangs for minutes.
- `router_settings`: `num_retries: 0`, `allowed_fails: 1`, `cooldown_time: 300`; fallbacks form the retry strategy.
- `litellm_settings.callbacks: router_hook.proxy_handler_instance` registers the hook; `drop_params: true` silences
  parameters a provider does not accept.

## Virtual models
`auto-free`, `auto-balanced`, `auto-smart` have placeholder deployments in `config.yaml` (their `litellm_params`
are never used because the hook rewrites `model` first). They exist so the names appear in `/v1/models`.

## OmniRoute
- Dashboard `http://127.0.0.1:20128` (password `OMNIROUTE_PASSWORD`). `REQUIRE_API_KEY=true`; the key LiteLLM uses is `FREE_POOL_KEY`.
- Provider connections are created in the dashboard or with `POST /api/providers {provider, name, apiKey}` after
  `POST /api/auth/login {password}`. Keyless providers tested on 2026-10-20 (Pollinations, OpenCode Zen, Kilo) did not work without real keys.
- LiteLLM talks to two explicit combos, `free-fast` and `free-coding` (priority strategy over tested Groq / OpenRouter / Mistral models). The built-in `auto/*` ids were rejected because they picked poor or unusable models; see [DECISIONS.md](DECISIONS.md).
- Edit a combo: `PUT /api/combos/<id>` with a new `models` array (an array replaces the stored one).

## Fixtures
`test-flaky` in `config.yaml` points at `scripts/flaky_server.py` (port 4199) and exists only for the mid-stream failover test.
It is harmless when the fixture server is not running.

## OpenAI blocks in `config.yaml`
`node ar.mjs openai` rewrites two marker-delimited blocks in `litellm/config.yaml` (`# >>> openai … # <<< openai` and `# >>> openai-fallbacks … # <<< openai-fallbacks`):
`gpt-{mini,main,max}-cli` → the bridge (`openai/codex-code-{mini,main,max}`) and `gpt-{mini,main,max}-api` → `openai/<id you verified>`. Do not edit between the markers by hand;
rerun the command instead. Routing tables refer to `gpt-mini`, `gpt-main`, `gpt-max` (no suffix); the hook appends `-cli`/`-api` from `OPENAI_PRIMARY`.
