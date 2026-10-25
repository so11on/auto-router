# Operations

## Start / stop / status
```sh
node ar.mjs up        # docker compose up -d + claude-bridge in the background (log: data/bridge.log)
node ar.mjs status
docker compose logs -f litellm      # LiteLLM logs; every routed request prints "[auto-router] <mode> -> <model> task=.. c=.. effort=.."
node ar.mjs down
```
The bridge does not start at login. `node ar.mjs up` starts it each time. To keep it running across reboots you would add an OS service
(launchd, systemd, Task Scheduler) running `node claude-bridge/start.mjs`; it is not provided, see [SECURITY.md](SECURITY.md) first.
The Docker services restart on their own (`restart: unless-stopped`).

## Apply a change
| Changed | Do |
|---|---|
| `litellm/routing.yaml` | nothing |
| `litellm/config.yaml`, `litellm/router_hook.py`, `.env` (LiteLLM vars) | `docker compose up -d --force-recreate litellm` |
| `claude-bridge/server.mjs`, bridge vars in `.env` | `node ar.mjs down && node ar.mjs up` (or kill the pid in `data/bridge.pid` and run `node ar.mjs up`) |

## Safety mode and the free pool
```sh
node ar.mjs safety status|on|off   # SAFETY_MODE; recreates the gateway
node ar.mjs omniroute              # connect providers, probe every model, write data/pool-members.json (needed once; Auto: Free is blocked under safety mode until then)
node ar.mjs omniroute --check      # does the running OmniRoute still honour the contract? (docs/OMNIROUTE-CONTRACT.md)
node ar.mjs omniroute-upgrade --to <tag> [--dry-run]   # test a new OmniRoute on a spare port; switch only if it passes; --rollback undoes
node ar.mjs doctor                 # ports on loopback, file modes, repo outside the code folders, the pinned images are the ones running
node ar.mjs tune [--apply]         # learn from your usage: small re-orderings of routing.yaml cells
```
`data/spend.json` holds today's estimated spend of billed API calls (the daily caps of `routing.yaml` read it).

## Switch Claude route
`CLAUDE_PRIMARY=cli` (Claude Code subscription) or `api` (Anthropic API key, needs credits) in `.env`, then recreate
LiteLLM. Each route is the other's fallback in `config.yaml`.

## Add a free provider
1. Get a key, put it in `.env` for the record.
2. OmniRoute login: `curl -c jar -X POST 127.0.0.1:20128/api/auth/login -H 'Content-Type: application/json' -d '{"password":"<OMNIROUTE_PASSWORD>"}'`
3. `curl -b jar -X POST 127.0.0.1:20128/api/providers -H 'Content-Type: application/json' -d '{"provider":"<id>","name":"<id>","apiKey":"<key>"}'`
4. `curl -b jar -X POST 127.0.0.1:20128/api/providers/<connection id>/test`
5. List its models: `GET /api/providers/<id>/models`; test each one with a one-token chat call before using it.
6. Add working models to a combo: `POST /api/combos {"name","strategy":"priority","models":["provider/model",...]}`
   (or `PUT /api/combos/<id>`). LiteLLM entries `free-pool*` point at the combos `free-fast` and `free-coding`.

Provider ids seen: `groq`, `mistral`, `openrouter`, `cloudflare-ai`, `gemini`, `pollinations`, `opencode-zen`, `kilo-gateway`.

## Rotate a key
Edit `.env`, recreate LiteLLM (LiteLLM/Gemini/Anthropic keys), or update the connection in the OmniRoute dashboard.
The OmniRoute API key for LiteLLM can be recreated with `POST /api/keys {"name":"litellm"}`; the value is shown once.

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| `auto-free` answers take ~20 s | Falling back to the Gemini free tier, which is slow. Check the pool: `FREE_POOL_ENABLED=true`, provider connections active, combos exist. |
| `auto-free` returns 429 from Gemini | Free-tier per-minute quota used up; wait a minute. The pool should normally absorb this. |
| Requests hang for minutes | An OmniRoute call with no usable provider (empty pool). Pool entries have a 15 s timeout, so the fallback should engage; if not, check `docker compose logs omniroute`. |
| `auto-smart` / `auto-balanced` show `credit balance is too low` | An Anthropic API model (Haiku `hk` is first in several cheap cells) was tried with an account without credit. The router now pauses that model for 6 h after the first such error and the next candidate answers; add credit, or remove `hk` from the cells. |
| `Nenhum modelo disponível… modo de segurança` in Auto: Free | The pool was never verified: `node ar.mjs omniroute`, then `docker compose up -d --force-recreate litellm`. |
| `O pool gratuito está indisponível` | The circuit breaker opened (3 failures in 60 s): wait ~5 min or run `node ar.mjs omniroute --check`. |
| `Conteúdo sensível detectado` | The request holds a secret / personal data and no allowed model exists in that profile (Auto: Free). Use Balanced/Smart, remove the data, or allow `no_retention` models with `SENSITIVE_ALLOWED_CLASSES=trusted,no_retention`. |
| `routing.yaml está no formato antigo` | Run `node ar.mjs update --apply` (v2 tables are replaced by v3, your pins and settings are kept). |
| HTTP 502/connection refused from `claude-*-cli` | Bridge not running (`node ar.mjs status`) or `BRIDGE_KEY` differs between `.env` and the running bridge. Restart it. |
| Bridge 403 | Workspace outside `BRIDGE_ALLOWED_ROOTS`. |
| Claude Code answers "can't find file" | Workspace not detected; the conversation lacks an absolute path. Send `x-workspace` or set `BRIDGE_DEFAULT_CWD`. |
| OmniRoute `/api/*` returns "authentication required" | Log in again; the cookie expires. |
| Gemini 403 "caller does not have permission" on a new key | Propagation delay after key creation; retry in a few minutes. |
| Gemini 404 "no longer available to new users" | Model retired (`gemini-2.5-*`). Use a 3.x model. |
| Model name works in curl but not in routing | Check `model_name` spelling in `config.yaml` and `routing.yaml`, and that fallbacks exist. |

## Usage and quota report (on demand)
The hook appends one JSON line per upstream call to `data/usage.jsonl` (model, mode, task, tokens, reported cost, ok/error).
Nothing is shown unless you ask:
```sh
node ar.mjs usage                         # last 24 h, by model
node ar.mjs usage --since 7d --by mode    # also: --by task, --since today|Nh|Nd|all
```
Columns: requests, errors, input/output tokens, share of total requests and tokens, and quota use when
`litellm/models.yaml` knows a limit. The gateway writes `data/quota-report.json` after every request and `ar.mjs usage` prints the forecast from it.
Add verified limits to `models.yaml` (`limits: {rpm, rpd, tpd}`) and they are tracked.
Notes: the classifier's own calls are listed as `classifier`; failed attempts count as errors; Claude Code tokens come from
the CLI's result event (mostly its own system prompt and cache) and say nothing about your plan's remaining allowance,
which Anthropic does not expose to this tool.

## OpenAI / ChatGPT
`node ar.mjs openai --list` (models your API key can use), `node ar.mjs openai --route cli|api|both [--mini ID --main ID --max ID] --check` (verifies with real requests), then the same command without `--check`, then `node ar.mjs down && node ar.mjs up`.
ChatGPT Plus/Pro → Codex CLI route (`codex login`); API key → separate billing. Details: docs/GET-KEYS.md, docs/CLAUDE-BRIDGE.md.

## GitHub Copilot plan
`node ar.mjs detect` (plan visible?), `copilot login`, `node ar.mjs copilot --main <id> --check`, `node ar.mjs copilot --mini <id> --main <id> --max <id>`, then `node ar.mjs down && node ar.mjs up`. Pins `!copilot`, `!copilot-max`, `!copilot-mini`. Details: docs/GET-KEYS.md §2c.

## Choosing a specific model
Put `!opus`, `!sonnet`, `!haiku`, `!pro`, `!flash`, `!deepseek`, `!gpt-oss`, `!nemotron` (or `model:opus`) in the message, or say "usando o Opus" / "using Opus".
Details and rules: ROUTING.md, "Pinning a model for one turn". **Opus through the CLI route needs Claude Code ≥ 2.1.280** (2.1.72 answered "does not support this model"). Updated on 2026-10-20 to 2.1.304: haiku, sonnet and opus
all answer through the bridge. After any `claude update`, restart the bridge. If `!opus` ever falls back to Sonnet the footer says so.

## Which model answered (in the chat)
Every final answer ends with `*auto-router · auto-free → free-pool-fast · groq/gpt-oss-20b · explain c1 · 2.2s*` (mode → routed group · real
provider/model · task, complexity, effort · time). Tool-call steps of an Agent run get no footer. Disable with `AUTO_ROUTER_FOOTER=false`.

## Updating
`node ar.mjs update` (dry run) → `node ar.mjs update --apply --restart`. It downloads the **latest release tag** of the repository (`--repo owner/name`, `--ref vX.Y.Z`, or `--from <folder>` for an unpacked copy; a branch needs `--yes`),
compares file by file, replaces code and docs, **merges** `litellm/routing.yaml` (v3: keeps your tables and settings, adds new sections, aliases and pins; a v2 file is replaced by the v3 tables, keeping your pins/switching/context), `litellm/config.yaml` (keeps the managed OpenAI/Copilot blocks) and `docker-compose.yml` (keeps the pinned image lines),
appends new `.env` settings with their defaults, and never touches `.env` values or `data/`. Replaced files go to `data/update-backup-<time>/`. Runbook for an AI: UPDATE_WITH_AI.md.

## Operation log
```sh
node ar.mjs logs                       # last 30 events
node ar.mjs logs -f                    # follow live
node ar.mjs logs --errors --since 2h   # failed calls and broken streams
node ar.mjs logs --rid ab12cd34        # one request end to end
node ar.mjs logs --type stream_failover
```
Each routed request gets a short `rid`; `route` shows the decision and why (`via=llm` classifier, `heuristic` fallback, `sticky`
tool turn, `pinned`; plus `band`, `session`, `safety_mode`, `sensitive`, `est_cost`), `dlp` shows counts and kinds only (never values), `blocked` a refused request, `call` shows each upstream attempt (fallbacks appear as extra `call` rows), `stream_failover` shows a
continuation. Fields are documented in the header of ``ar.mjs logs``.

## What happens when a model runs out mid-answer
- Out of quota/limit **before** it wrote anything: the gateway silently tries the next model of the chain (`config.yaml` fallbacks).
- Dies **while** writing (stream broken, Claude plan limit): the answer is continued by the next model and a one-line warning is
  inserted in the text. Check with ``ar.mjs logs` --type stream_failover`.
- Every model in the chain failed: the client gets the error. Free mode never falls back to paid models.
- Test it any time: `python3 scripts/flaky_server.py &` then stream `model=test-flaky` (see the script header). Stop the server afterwards.
