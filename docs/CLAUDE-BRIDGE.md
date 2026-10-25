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

## OpenAI Codex route (ChatGPT Plus/Pro)
The same server also exposes `codex-code-mini|main|max`. A request for those models runs `codex exec --json --skip-git-repo-check --ephemeral --sandbox <mode> -C <workspace> [-m model] [-c model_reasoning_effort="…"] -`
with the prompt on stdin, using the user's own `codex login` (ChatGPT account). `OPENAI_API_KEY`/`CODEX_API_KEY`/`OPENAI_BASE_URL` are removed from the child's environment so the plan, not an API key, is used.
- **Sandbox:** `workspace-write` when the request carries tools (Copilot Agent), otherwise `read-only` (override with header `x-codex-sandbox`).
- **No session resume:** every turn is a fresh Codex session; the last 12 turns and files changed on disk since the previous turn are replayed in the prompt. (`codex exec resume` flags differ from `exec`; not used.)
- **Output:** the final `agent_message` text, then `*Codex (model · sandbox · effort)*` with files edited / commands run, like the Claude route. Token usage comes from `turn.completed`.
- **Limits:** a message containing limit/quota/usage/credits becomes HTTP 429 (gateway falls back); after partial text the stream is broken on purpose so the gateway continues on another model.
- **Status:** the JSON event shapes follow OpenAI's non-interactive-mode documentation; no real `codex` was available on the development machine, so the route is verified against a stand-in CLI (`tests/fake_codex.sh`, `tests/bridge.test.mjs`) and by `node ar.mjs openai --check` on your machine.

## GitHub Copilot route (paid Copilot plan)
Models `copilot-code-mini|main|max` run `copilot -p <prompt> -s --no-ask-user [--model=ID] --allow-tool=read [--allow-tool=write]` (GitHub's documented programmatic mode; `-s` = only the agent's answer) with the user's own `copilot login`.
- **Permissions:** read-only unless the request carries tools (Copilot Agent); then `write` is allowed. Shell commands only if listed in `BRIDGE_ALLOWED_TOOLS` as `Bash(...)`. Anything not pre-approved is denied in non-interactive mode.
- **Prompt:** passed as an argument (stdin is not documented). Prompts over 6000 characters, and anything on a Windows `.cmd` launcher, are written to `<project>/.auto-router/prompts/<id>.md` and the CLI is told to read it; the file is deleted afterwards.
- **Output:** plain text, delivered in one piece (the CLI does not stream here) plus `*GitHub Copilot (model · mode)*`. Edited files are found by comparing file modification times (`git status` when the folder is a repository, a bounded scan otherwise). Token counts are **estimates** (chars/4): the CLI reports none.
- **Environment:** `GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN` are removed so the signed-in Copilot account is used; auto-update is disabled.
- **Limits:** messages mentioning limit/quota/premium become HTTP 429 (the gateway falls back). Premium-request balance cannot be read, so there is no forecast for this route.
- **Status:** verified against a stand-in CLI (`tests/fake_copilot.sh`); no real Copilot CLI was available on the development machine (the account there is on the free plan). `node ar.mjs copilot --check` verifies it for real.

## Protection against reading secrets (SEC-11)
Claude Code reads files straight from disk, so the gateway's DLP never sees them. The bridge therefore starts **every**
`claude` run with `--settings` built from [`claude-bridge/settings.bridge.json`](../claude-bridge/settings.bridge.json):
- `permissions.deny` for `.env*`, `*.pem`, `*.key`, `id_rsa*`, `secrets/`, `.aws/`, `.ssh/`, `*credential*` (Read and Edit; Edit rules also cover Write) and `Bash(env)`, `Bash(printenv*)`, `Bash(cat *.env*)`;
- a `PreToolUse` hook, [`hooks/protect-sensitive.mjs`](../claude-bridge/hooks/protect-sensitive.mjs), that resolves the real path (symlinks included) and blocks the same files plus commands that print the environment. It exits with code 2, which Claude Code treats as a block.

Verified 2026-10-25 on Claude Code 2.1.304 with a temporary project holding `.env` (`SECRET=abc123`): reading it, `cat .env` and `printenv` were all refused, both with the full settings and with the hook alone, and the value never appeared in the answer.
Limits: the guard works on names and patterns, so a secret stored in a file with an ordinary name is not caught; Codex and Copilot CLIs have no equivalent hook (no mechanism found in `codex exec --help`), so those routes rely on the sandbox and on keeping secrets outside `BRIDGE_ALLOWED_ROOTS`.
