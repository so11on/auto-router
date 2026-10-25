# AGENTS.md — auto-router

Entry point for AI coding assistants working in this repository. Read this first, then the doc you need.

## What this is
A local LiteLLM gateway that exposes `auto-free`, `auto-balanced`, `auto-smart`. A pre-call hook masks secrets / personal data (`dlp.py`),
classifies each new user turn (task + complexity 1-5), and `engine.route()` picks the model, reasoning effort and fallbacks from the tables in
`litellm/routing.yaml` after filtering by safety, sensitivity, availability, tools, context, quota and budget. Claude / ChatGPT / Copilot are reached through
`claude-bridge` (their CLIs) or their APIs.

## Map
| Need | Go to |
|---|---|
| Understand the flow | `docs/ARCHITECTURE.md` |
| Change which model a profile uses for a task | `litellm/routing.yaml`, `docs/ROUTING.md` |
| Model facts: privacy class, price, fit, limits | `litellm/models.yaml` |
| Change safety rules / DLP | `litellm/safety.py`, `litellm/dlp.py`, `docs/SECURITY.md` |
| Change the decision logic | `litellm/engine.py` (+ `tests/test_engine.py`) |
| Add/rename a model or fallback | `litellm/config.yaml` |
| Change the hook (DLP, classification, pins, streaming) | `litellm/router_hook.py` (+ `tests/test_router_hook.py`, `tests/test_hook_safety.py`) |
| Change the Claude Code bridge | `claude-bridge/server.mjs`, `docs/CLAUDE-BRIDGE.md` |
| Env vars | `docs/CONFIGURATION.md`, `.env.example` |
| Free-tier numbers | `docs/FREE-TIER-LIMITS.md` |
| Run/debug | `docs/OPERATIONS.md`, `scripts/` |
| Why a choice was made | `docs/DECISIONS.md` |
| Install on another computer (AI-readable) | `INSTALL_WITH_AI.md`, `docs/INSTALL-LESSONS.md` |

## Commands
```sh
python3 -m unittest discover -s tests -v      # unit tests (pip install pyyaml)
node --test tests/*.test.mjs                    # installer, bridge, hooks, OmniRoute contract, tune
node ar.mjs up|down|status
node ar.mjs smoke                               # end-to-end, needs the stack up
node ar.mjs logs [-f]                   # operation log (route/call/failover events)
node ar.mjs usage                       # token/usage shares on demand
docker compose up -d --force-recreate litellm  # after editing config.yaml / router_hook.py / .env
```

## Invariants — do not break
1. `auto-free` must never resolve to a paid model, a plan model or the billed Gemini key. Only free models (`profiles.free.allow_paid/allow_subscription: false` in `routing.yaml`).
1b. **Safety first**: nothing may reach a model that `safety.allowed_by_safety` / `allowed_for_sensitive` forbids — not a route, a pin, a per-request fallback, a stream continuation, the classifier, a summary or the project memory. A model without `privacy` is `unsafe`. The DLP runs before everything and never logs values. A fallback list is computed per request after the filters; do not reintroduce the static list as the main chain.
1c. A failing pool never makes `auto-free` use a paid or `unsafe` model; it answers with a message.
2. Claude / GPT aliases in `routing.yaml` resolve to `claude-*`/`gpt-*` without suffix; the hook appends `-cli` or `-api`. Both must exist in `config.yaml` (and in `models.yaml` with `privacy` and `fit`; a test enforces it).
3. `GEMINI_FREE_API_KEY` is a key from a project without billing; `GEMINI_API_KEY` is billed. Never swap them.
4. The bridge must keep: required `BRIDGE_KEY`, loopback bind, `BRIDGE_ALLOWED_ROOTS`, no shell unless opted in.
5. Tool-result turns re-run the engine with the stored classification and prefer the model already working; escalation after failures is immediate, a downgrade needs confirmations (`policy.py`). Changing this affects agent loops.
6. Pool entries in `config.yaml` keep `timeout: 15` (an empty OmniRoute hangs for minutes).
7. Verify model ids by calling the provider before adding them; do not guess ids. Record measurements in `docs/FREE-TIER-LIMITS.md`.
8. Never print or commit secrets from `.env`.

9. The bridge strips `ANTHROPIC_*` for `claude`, `OPENAI_*`/`CODEX_API_KEY` for `codex` and `GH_TOKEN`/`GITHUB_TOKEN`/`COPILOT_GITHUB_TOKEN` for `copilot` so subscriptions, not API keys, are used. Never hard-code OpenAI model ids: they come from `ar.mjs openai` after a verifying call.
9b. VS Code auth is `requestHeaders` (not `apiKey`); the model footer is part of the answer text and is stripped from history — keep both behaviours.
10. Pins (`pins:` in routing.yaml) never let `auto-free` reach a paid model and never override safety / sensitivity / availability; keep those checks in `async_pre_call_hook`.
12. `docker-compose.yml`: images pinned by digest (never `:latest` / `:main-stable`), the gateway gets an explicit `environment:` list (no `env_file`); `ar.mjs update` never changes an `image:` line. OmniRoute is used only through the surface in `docs/OMNIROUTE-CONTRACT.md`.
13. Prices, privacy classes, fit and limits are data in `models.yaml`; never hard-code a model's facts in Python.
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
