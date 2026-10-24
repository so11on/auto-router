# AGENTS.md — auto-router

Entry point for AI coding assistants working in this repository. Read this first, then the doc you need.

## What this is
A local LiteLLM gateway that exposes `auto-free`, `auto-balanced`, `auto-smart`. A pre-call hook classifies each new user
turn (task + complexity 1-5), picks a model and reasoning effort from `litellm/routing.yaml`, and LiteLLM falls back across
providers. Claude is reached through `claude-bridge` (Claude Code CLI) or the Anthropic API.

## Map
| Need | Go to |
|---|---|
| Understand the flow | `docs/ARCHITECTURE.md` |
| Change which model a mode uses | `litellm/routing.yaml`, `docs/ROUTING.md` |
| Add/rename a model or fallback | `litellm/config.yaml` |
| Change selection logic | `litellm/router_hook.py` (+ `tests/test_router_hook.py`) |
| Change the Claude Code bridge | `claude-bridge/server.mjs`, `docs/CLAUDE-BRIDGE.md` |
| Env vars | `docs/CONFIGURATION.md`, `.env.example` |
| Free-tier numbers | `docs/FREE-TIER-LIMITS.md` |
| Run/debug | `docs/OPERATIONS.md`, `scripts/` |
| Why a choice was made | `docs/DECISIONS.md` |
| Install on another computer (AI-readable) | `INSTALL_WITH_AI.md`, `docs/INSTALL-LESSONS.md` |

## Commands
```sh
python3 -m unittest discover -s tests -v      # unit tests (pip install pyyaml)
node ar.mjs up|down|status
node ar.mjs smoke                               # end-to-end, needs the stack up
node ar.mjs logs [-f]                   # operation log (route/call/failover events)
node ar.mjs usage                       # token/usage shares on demand
docker compose up -d --force-recreate litellm  # after editing config.yaml / router_hook.py / .env
```

## Invariants — do not break
1. `auto-free` must never resolve to a paid model or the billed Gemini key. Only `free-pool*`, `pool-*` (single pool models used by pins), `gemini-free-*`.
2. Claude model names in `routing.yaml` carry no suffix; the hook appends `-cli` or `-api`. Both must exist in `config.yaml`.
3. `GEMINI_FREE_API_KEY` is a key from a project without billing; `GEMINI_API_KEY` is billed. Never swap them.
4. The bridge must keep: required `BRIDGE_KEY`, loopback bind, `BRIDGE_ALLOWED_ROOTS`, no shell unless opted in.
5. Tool-result turns reuse the previous decision; conversations only escalate. Changing this affects agent loops.
6. Pool entries in `config.yaml` keep `timeout: 15` (an empty OmniRoute hangs for minutes).
7. Verify model ids by calling the provider before adding them; do not guess ids. Record measurements in `docs/FREE-TIER-LIMITS.md`.
8. Never print or commit secrets from `.env`.

9. VS Code auth is `requestHeaders` (not `apiKey`); the model footer is part of the answer text and is stripped from history — keep both behaviours.
10. Pins (`pins:` in routing.yaml) never let `auto-free` reach a paid model; keep that check in `async_pre_call_hook`.
11. Streaming failover: `router_hook.async_post_call_streaming_iterator_hook` continues a broken answer on the next fallback; keep it Chat-Completions-only unless you test the other formats.

## Conventions
- Python 3.9-compatible code in `litellm/` and `scripts/`; Node without dependencies in `claude-bridge/`.
- Comments explain *why*; configs carry the tuning, code carries the mechanism.
- Dates in docs are ISO; note the measurement date next to any provider-dependent number.
- Update the relevant doc and `tests/` in the same change as behaviour.

## Gotchas
- LiteLLM runs in Docker and reaches the host bridge at `host.docker.internal:4100`.
- Shell here is zsh: write `${var}:suffix`, not `$var:suffix`.
- OmniRoute `/api/*` needs a login cookie; `/v1/*` needs the API key.
- The Gemini free tier is slow (~20 s) and shares quota across the Flash family.
- `ANTHROPIC_API_KEY` must not reach the `claude` child process, or the CLI bills the API account instead of the subscription (the bridge strips it; a smoke test can still pass through fallbacks, so check `data/usage.jsonl` or the bridge log).
- Usage log: `data/usage.jsonl`; report with ``ar.mjs usage``.
- Status and open items live in `README.md` and `docs/DECISIONS.md`.
