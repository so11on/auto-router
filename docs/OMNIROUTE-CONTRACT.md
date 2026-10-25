# OmniRoute contract

OmniRoute is a third-party project that changes fast. auto-router depends on it at run time (the free pool) and nothing else:
it is isolated behind the small surface below, verified by a script, and its image is pinned by digest.
FreeLLMAPI was evaluated and rejected ([DECISIONS](DECISIONS.md)); it is not used.

## What the project uses (and nothing more)
Verified 2026-10-25 against OmniRoute 3.8.52 by reading `ar.mjs omniroute` and `litellm/router_hook.py`.

| # | Call | Used by | Expectation |
|---|---|---|---|
| 1 | `POST /api/auth/login` `{password}` | `ar.mjs omniroute` | 200 and a `set-cookie` session |
| 2 | `POST /api/keys` `{name}` | `ar.mjs omniroute` | JSON with `key` |
| 3 | `GET /api/providers`, `POST /api/providers`, `POST /api/providers/:id/test`, `DELETE /api/providers/:id`, `GET /api/providers/:id/models` | `ar.mjs omniroute` | `{connections: []}`, `{valid}`, `{models: []}` |
| 4 | `GET/POST /api/combos`, `PUT/DELETE /api/combos/:id` | `ar.mjs omniroute` | `{combos: []}`; a combo needs **at least one model** (found 2026-10-25) and the created object has a top-level `id` |
| 5 | `GET /v1/models` (Bearer key) | verifier | `{data: []}` |
| 6 | `POST /v1/chat/completions` (Bearer key) | LiteLLM (groups `free-pool*`) | OpenAI shape; unknown model → 4xx JSON error |
| 7 | response headers `x-omniroute-provider`, `x-omniroute-model` | the footer | optional: without them the footer shows the chunk's model |

A retired model answers 410 and locks its whole connection: `ar.mjs omniroute` deletes and recreates the connection.

## Checking it
```sh
node ar.mjs omniroute --check            # against the running instance (one harmless chat on free-fast)
node scripts/omniroute-contract.mjs http://127.0.0.1:20128 --password <pw> [--key <key>] [--chat free-fast]
```
Exit code is non-zero if a required item fails. Missing headers are only a warning.

## Failure behaviour
- Unknown or renamed headers, extra fields: ignored. A response outside the expected shape counts as a pool failure.
- **Circuit breaker** (`litellm/pool.py`): `POOL_FAIL_THRESHOLD` failures (default 3) within `POOL_FAIL_WINDOW_S` (60 s) open it for `POOL_COOLDOWN_S` (300 s). While open the router skips the pool at once instead of waiting for the 15 s timeout, and `data/quota-report.json` shows why.
- **The pool failing never escalates:** in `auto-free` with the pool down the router uses only the other free models that `SAFETY_MODE`/DLP allow; if none, it answers *"O pool gratuito está indisponível. Tente de novo em alguns minutos ou use Auto: Balanced."* It never falls to a paid or `unsafe` model.

## Upgrading OmniRoute safely
```sh
node ar.mjs omniroute-upgrade                       # read-only: pinned image + recent tags
node ar.mjs omniroute-upgrade --to 3.9.0 --dry-run  # pull, start on 127.0.0.1:20129 with NEW data, run the contract, stop
node ar.mjs omniroute-upgrade --to 3.9.0            # same, then back up the data volume (data/backups/, 0600),
                                                    # save data/omniroute-last-good.json, pin tag+digest, recreate, re-check
node ar.mjs omniroute-upgrade --rollback            # previous image + data volume
```
Any failed step leaves `docker-compose.yml` and the running container untouched (or reverts them). `node ar.mjs update` never changes
an `image:` line (an old floating tag such as `:latest` is replaced by the repository's pinned line). Floating tags are forbidden in the compose file (tested).
