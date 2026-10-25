# Architecture

## Goal
One endpoint, three model names (`auto-free`, `auto-balanced`, `auto-smart`). The client never picks a real
model: the gateway decides per request from the task and the mode, like Cursor's Auto.

## Components

| Component | Runs | Port | Role |
|---|---|---|---|
| LiteLLM proxy | Docker | 4000 | Public endpoint (OpenAI Chat, OpenAI Responses, Anthropic Messages). Holds the model list, fallbacks and timeouts. |
| `router_hook.py` | inside LiteLLM | - | `async_pre_call_hook`: runs the DLP, classifies the request, asks the engine for the model and rewrites `model`, the effort and the per-request `fallbacks` before LiteLLM routes. |
| `dlp.py`, `safety.py` | inside LiteLLM | - | Secret / personal-data / image detection and masking; privacy classes and the `SAFETY_MODE` / sensitive-content rules. |
| `engine.py` | inside LiteLLM | - | `route()`: tables → filters → reorder → floor / cost → fallbacks. Pure Python, unit-tested. See [ROUTING.md](ROUTING.md). |
| `pool.py` | inside LiteLLM | - | Circuit breaker for the free pool (OmniRoute). |
| OmniRoute | Docker | 127.0.0.1:20128 | Third-party dependency isolated by a [contract](OMNIROUTE-CONTRACT.md). Aggregates free provider accounts behind one OpenAI endpoint: the `free-fast` / `free-coding` combos and the individual pool models. |
| claude-bridge | host (Node) | 127.0.0.1:4100 | OpenAI-compatible facade over `claude -p`, so Claude is used through the Claude Code login. |
| Classifier | `CLASSIFIER_MODEL` (paid Gemini by default; the pool in `auto-free`) | - | Returns `{task, complexity, risk, long_output}` as JSON. Falls back to a local keyword heuristic on error or when no allowed model may see the text. |

## Request flow

1. Client calls `POST :4000/v1/chat/completions` (or `/v1/responses`, `/v1/messages`) with `model=auto-*`.
2. `router_hook.py`:
   - reads the profile from the model name (`free | balanced | smart`);
   - derives a conversation key (hash of profile + system prompt + first user message) from the ORIGINAL text;
   - **DLP**: masks secrets (and personal data if asked) in `messages`, `input`, `instructions`…, flags the request sensitive (sticky per conversation);
   - a pin is validated against safety and availability, or ignored with a note;
   - a new user turn is classified (task, complexity, risk); a tool-result turn re-runs the engine with the stored classification, re-classifying at checkpoints or on failure signals (policy.py: escalate at once, descend with hysteresis);
   - `engine.route()` returns the model, effort and fallbacks (see [ROUTING.md](ROUTING.md));
   - resolves `claude-*` / `gpt-*` to `-cli` or `-api`, compacts the history if the chosen model's window would be exceeded, prepends a handoff note when the serving model changed;
   - sets the effort (`reasoning_effort`, `reasoning.effort` for Responses, `thinking` for Anthropic API models) and `data["fallbacks"]`.
3. LiteLLM calls the chosen deployment. On error or timeout it walks the per-request `fallbacks` (the static `router_settings.fallbacks` are the last resort).
4. For `claude-*-cli` the call goes to claude-bridge, which runs `claude -p` in the project directory.

## Smooth model switching
Conversation state lives in the chat history the client resends on every request, so any model sees prior turns.
Two gaps exist because Claude Code edits files itself: other models would not know what it changed, and Claude Code
would not know what others did. Both are closed:
- Every Claude Code reply ends with an actions block (files edited, commands run).
- On each turn the bridge feeds Claude Code the messages it has not seen plus files changed on disk since its last turn.
- The hook adds a system note on any model change telling the new model that files on disk are the source of truth.

Details: [CLAUDE-BRIDGE.md](CLAUDE-BRIDGE.md).

## State
- Hook: in-memory dicts (`_sticky`, `_last_model`), 1 h TTL; lost on LiteLLM restart (next turn reclassifies). On disk (`data/`, private): `router.jsonl`, `usage.jsonl`, `context-state.json`, `quota-state.json`, `quota-report.json`, `spend.json` (daily estimate), `pool-members.json` (verified pool models and their classes), `tune-state.json`.
- Bridge: `~/.auto-router/bridge-state.json` (conversation → Claude Code session id, cwd, messages seen, last end time).
- OmniRoute: Docker volume `omniroute-data` (provider keys, dashboard password, API keys).

## Failure behaviour
- Provider 429/5xx/timeout → next deployment in `fallbacks`; the cooldown is 300 s after 1 failure.
- Classifier failure → heuristic classification (length + keywords).
- Claude subscription limit → bridge answers HTTP 429 → LiteLLM falls to the API route, then Gemini.
- `auto-free` never falls back to paid models; when the free pool is down (circuit breaker) or nothing allowed is left it answers with a clear message.
- A fallback never reintroduces a model the request may not use: the chain is computed per request after the safety and sensitivity filters.

## Failover while an answer is being written
Two layers, because LiteLLM only falls back **before the first token**:
1. **Before any text** (rate limit, 5xx, timeout, bad key): LiteLLM walks `router_settings.fallbacks` and the user sees nothing.
2. **After text has started** (a provider drops the stream, the Claude plan limit hits mid-run): `async_post_call_streaming_iterator_hook`
   in `router_hook.py` catches the error, takes the next model of the fallback chain, sends it the original messages plus the
   partial answer as an assistant message and an instruction to continue without repeating, and streams that. The user sees one
   uninterrupted answer with a one-line notice: `> ⚠️ <model> was interrupted (<reason>). Continuing with <next>.`
   Up to 3 hops. Not attempted when the partial output contains tool calls (cannot be resumed safely) or when no text was produced.
   Implemented for streaming Chat Completions requests; non-streaming requests are simply retried on the fallback by LiteLLM.
For the Claude CLI route the bridge cooperates: if `claude` dies after emitting text it appends what it did (files edited) and then
breaks the HTTP stream so the gateway sees an error; in non-streaming mode it returns 429/502 instead of a half answer.

## Model footer
The streaming hook holds back the final `finish_reason` chunk, inserts a footer chunk before it and then releases it, so clients still see a normal
end of stream. It is added only to routed `auto-*` requests, only when text was produced and no tool call was made, and in non-streaming answers via
`async_post_call_success_hook`. The real upstream name comes from OmniRoute's `x-omniroute-provider` / `x-omniroute-model` headers when LiteLLM keeps
them (`_hidden_params.additional_headers`). On the next request the pre-call hook strips footers from assistant messages in the history.

## Logs
| File | Written by | Content | Viewer |
|---|---|---|---|
| `data/router.jsonl` | hook | `route`, `call`, `stream_failover`, `stream_error` events (rotated at 10 MB to `.1`) | ``ar.mjs logs`` |
| `data/usage.jsonl` | hook | one row per upstream call with tokens | ``ar.mjs usage`` |
| `docker compose logs litellm` | LiteLLM | process log incl. `[auto-router] <rid> <mode> -> <model> ...` lines | `docker compose logs -f litellm` |
| `$TMPDIR/claude-bridge.log` | bridge | process log | `tail` |
