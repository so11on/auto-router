# claude-bridge

`claude-bridge/server.mjs` (Node, no dependencies) exposes `POST /v1/chat/completions` and `GET /v1/models` on
`127.0.0.1:4100`. Each request runs the local `claude` CLI headlessly (`claude -p`, stream-json) with your own login,
so Claude can be used without API credits. It must run on the host, not in Docker, because the CLI login lives there.

## Models
Verified on 2026-10-20 with Claude Code 2.1.304: all three answer on the subscription (Opus 5.5 needs ≥ 2.1.280; 2.1.72 failed with HTTP 400 "version too old").
`claude-code-haiku|sonnet|opus` map to `CC_HAIKU|CC_SONNET|CC_OPUS` (defaults `claude-haiku-5-5`, `claude-sonnet-5-5`,
`claude-opus-5-5`). LiteLLM exposes them as `claude-haiku-cli`, `claude-sonnet-cli`, `claude-opus-cli`.

## Modes (derived from the request, override with header `x-claude-mode`)
| Request | Claude Code permission mode | Effect |
|---|---|---|
| has `tools` (Copilot Agent) | `BRIDGE_AGENT_MODE` (`acceptEdits`) | edits files; shell commands only if listed in `BRIDGE_ALLOWED_TOOLS` |
| no `tools` (Ask / Plan) | `plan` | read-only |

Copilot's own tools are not used on these turns: Claude Code does the work itself and the chat shows its text.
`reasoning_effort` (`low|medium|high`) becomes `claude --effort`.

## Workspace detection
The bridge scans the conversation for absolute paths under `/Users`, `/home`, `/private`, `/tmp`, `/Volumes`, `/mnt`,
`/workspaces`, `/opt`, `/srv`, walks each up to the nearest directory with `.git`, `package.json` or `pyproject.toml`,
and uses the most frequent. Fallbacks: header `x-workspace`, the directory saved for this conversation,
`BRIDGE_DEFAULT_CWD`. A directory outside `BRIDGE_ALLOWED_ROOTS` is refused with HTTP 403.

## Smooth switching between models
1. **Visible record.** Every reply ends with a block such as
   `*Claude Code (claude-sonnet-5-5 · acceptEdits · low)*`, `- files edited: ...`, `- commands: ...`.
   It becomes part of the chat history, so the next model (Gemini, a free model, ...) knows what changed.
2. **Catch-up for Claude.** The bridge keeps one Claude Code session per conversation (`--session-id`, then `--resume`).
   Before each turn it injects the messages added since its last turn (other models' replies, user messages) and the
   files `git status` reports as changed after its last turn ended ("re-read them before editing").
3. **Handoff note.** The LiteLLM hook prepends a system message whenever the serving model changes
   (see `HANDOFF_NOTE` in `router_hook.py`), telling the new model that files on disk are the source of truth.
4. If the saved session is gone, the bridge starts a new one and sends the whole transcript.

Conversation id: sha1 of the first user message. State file: `~/.auto-router/bridge-state.json`.

## Interrupted runs (plan limit, crash)
If `claude` fails **after** it already produced text: streaming → the bridge appends `*Claude Code (...) was interrupted: <reason>*` and the
files edited so far, saves the session state, then drops the HTTP connection; the gateway notices and continues the answer on the next
model (see ARCHITECTURE, "Failover while an answer is being written"). Non-streaming → HTTP 429 (limit) or 502 and no partial answer.
Tested with `tests/fake_claude.sh` (a stand-in CLI that prints text and then dies with "usage limit reached").

## Errors
| Condition | Response |
|---|---|
| missing/wrong bearer | 401 |
| workspace outside allowed roots | 403 `permission_error` |
| Claude plan limit / rate limit text in output | 429 `rate_limit_error` (LiteLLM then tries the API route, then Gemini) |
| other CLI failure | 502 |
| run exceeds `BRIDGE_TIMEOUT_MS` | process killed |

## Streaming
`stream: true` returns OpenAI SSE chunks as Claude Code emits text deltas. Nothing is sent before the first text, so an
immediate failure can still return a proper HTTP error.

## Limits
- Uses your plan allowance (5-hour windows). Concurrent requests of one conversation are serialized.
- Output token usage is reported as 0.
- Only Chat Completions is implemented; LiteLLM converts Responses/Messages requests.
- Terms of service: see [SECURITY.md](SECURITY.md).
