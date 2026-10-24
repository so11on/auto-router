# Architecture

## Goal
One endpoint, three model names (`auto-free`, `auto-balanced`, `auto-smart`). The client never picks a real
model: the gateway decides per request from the task and the mode, like Cursor's Auto.

## Components

| Component | Runs | Port | Role |
|---|---|---|---|
| LiteLLM proxy | Docker | 4000 | Public endpoint (OpenAI Chat, OpenAI Responses, Anthropic Messages). Holds the model list, fallbacks and timeouts. |
| `router_hook.py` | inside LiteLLM | - | `async_pre_call_hook`: classifies the request and rewrites `model` and the effort parameter before LiteLLM routes. |
| OmniRoute | Docker | 127.0.0.1:20128 | Aggregates free provider accounts behind one OpenAI endpoint. Holds the `free-fast` and `free-coding` combos over Groq, OpenRouter `:free` and Mistral Codestral. |
| claude-bridge | host (Node) | 127.0.0.1:4100 | OpenAI-compatible facade over `claude -p`, so Claude is used through the Claude Code login. |
| Classifier | Gemini API | - | `gemini-3.5-flash-lite` returns `{task, complexity}` as JSON. Falls back to a keyword heuristic on error. |

## Request flow

1. Client calls `POST :4000/v1/chat/completions` (or `/v1/responses`, `/v1/messages`) with `model=auto-*`.
2. `router_hook.py`:
   - reads the mode from the model name (`free | balanced | smart`);
   - derives a conversation key (hash of mode + first user message);
   - if the newest message is a user turn: classifies it (task + complexity 1-5, +1 above 60k tokens);
   - if it is a tool-result turn: reuses the conversation's previous decision;
   - applies `task_bump`, looks up the first tier with `complexity <= max_complexity` in `routing.yaml`;
   - keeps the old decision if the new one is lower (a conversation only escalates);
   - resolves the Claude route (`-cli` or `-api`, from `CLAUDE_PRIMARY`) and the free pool switch (`FREE_POOL_ENABLED`);
   - sets the effort (`reasoning_effort`, `reasoning.effort` for Responses, `thinking` for Anthropic API models);
   - prepends a handoff note when the serving model differs from the previous turn.
3. LiteLLM calls the chosen deployment. On error or timeout it walks `router_settings.fallbacks`.
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
- Hook: in-memory dicts (`_sticky`, `_last_model`), 1 h TTL; lost on LiteLLM restart (next turn reclassifies).
- Bridge: `~/.auto-router/bridge-state.json` (conversation → Claude Code session id, cwd, messages seen, last end time).
- OmniRoute: Docker volume `omniroute-data` (provider keys, dashboard password, API keys).

## Failure behaviour
- Provider 429/5xx/timeout → next deployment in `fallbacks`; the cooldown is 300 s after 1 failure.
- Classifier failure → heuristic classification (length + keywords).
- Claude subscription limit → bridge answers HTTP 429 → LiteLLM falls to the API route, then Gemini.
- `auto-free` never falls back to paid models; when the free tier is exhausted it errors.

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
