# Incidents and lessons

Read this before installing or changing the gateway. It records what went wrong on a real install so that you, or the AI agent installing
this for you, do not repeat it. No names, paths, keys or amounts are recorded here.

## 2026-11-02 — the gateway was switched on and the agent "became dumb"

**What the person saw**
- The agent worked, but answered poorly, misused file tools, and in one window forgot the whole conversation ("this is our first message").
- The model picker said a Claude model; the answers were not Claude's.
- Asking "which model are you?" produced a wrong, confident answer.

**What the logs showed** (`data/gateway.jsonl`)
- Out of about 110 routing decisions, none of the main-loop answers came from Claude. Almost all went to the smallest Gemini model, the rest
  to bigger Gemini models. Eleven requests failed with HTTP 400.

**Causes and fixes** (each has a regression test in `tests/test_gateway_router.py` or `tests/test_translate_openai.py`)

| # | Cause | Fix |
|---|---|---|
| D1 | The Claude plan stayed "exhausted" until the WEEKLY reset. After the 5-hour window reset, the stale `rejected` snapshot kept every request away from Anthropic, so the snapshot could never refresh. | Only a window that itself says `rejected`, with a reset still in the future, blocks. It heals by itself at that window's reset. |
| D2 | The cheapest "adequate" model for a one-line question was the smallest Gemini, and it became the agent's main loop. | `quality.main_floor`; models have `roles`; Gemini is not a main-loop model by default. |
| D3 | The classifier saw only the last message. "continue", "yes", "did it hang?" were rated trivial and dropped a running task to the weakest model. Checkpoints used the session's FIRST prompt and lowered the task. | Continuations inherit the rating of the work in progress; checkpoints use the current prompt and only raise the task inside one prompt. |
| D4 | Tool results were sent without the tool name, or without the call they answer. Gemini answered 400 `function_response.name: Name cannot be empty`. | Every tool result carries its name; an orphan result becomes plain text; a nameless call is never forwarded. |
| D5 | Parallel tool calls without a usable `index` were merged into one call whose arguments were two JSON objects glued together. The client rejected it. | Calls are told apart by id; each is emitted whole with validated JSON (`{..}{..}` is repaired). |
| D6 | The reply labelled the model with the one the client asked for, so a small Gemini answer looked like a Claude answer, with a Claude-sized context accounting. | The label is the real model; the gateway's own texts are labelled `auto-router`. |
| D7 | After a very large Gemini-labelled answer, the client began to send almost-empty requests (no system prompt, no history). The gateway did not cut anything; the likely trigger is D6. | The request shape is logged (never its text); `context_drop` is flagged and such a request inherits the work in progress. |
| D8 | Learning reinforced the mistake: "it hung" counted as a success, upstream 4xx did not count as failures, and without a known project every outcome was counted twice. The working folder was never found. | Complaints, upstream errors and manual up-switches count as failures; keys are not duplicated; the folder is also looked for in the first user turn. |
| D9 | `status` showed only the older stack, so the person (and the agent) believed the gateway was down or old. | `status` shows the gateway, mode, model and effort per session, and every feature. |

**Rules that follow**
1. Never give the agent's main conversation to a model of another vendor by default. Use it as a tool the Claude calls (`node ar.mjs gemini ...`).
2. Start in `shadow` mode, read `node ar.mjs report` for a few days, and only then `node ar.mjs mode route`.
3. Verify the model that really answered (`node ar.mjs status`, the status line), never the label the chat shows or the model's own claim about itself.
4. Do not switch the gateway off from a session that goes through it: the session loses its connection. Use a normal terminal. `ar.mjs off` refuses unless `--force`.
5. Do not run the older stack's `up` because "the gateway is down": check `node ar.mjs status` first. The two stacks are different things.
6. A classifier or a router must not learn "success" from the absence of a complaint alone.
7. When you add a translation layer to another vendor, test: parallel tool calls with missing or repeated `index`, a tool result whose call is not in the history, thinking blocks, an error in the middle of a stream.
8. Keep a way back that does not depend on the thing that broke: `node ar.mjs off` restores the previous Claude Code settings (a dated backup of `settings.json` is also kept) and the start model that was set before.
9. Anything you install into the user's `~/.claude` must be removable without touching the user's own entries (hooks, permissions, status line, CLAUDE.md). Mark what is yours.
10. Run the privacy test from a clean tree: bytecode caches (`__pycache__`) contain the user's home path. They are git-ignored; do not commit them.

## Smaller lessons from the same day
- A gateway restart does not forget a "rejected" snapshot: it is reloaded from disk. Fix the logic, not the file.
- `claude-code on` may change the start model (the model whose requests are routed). It now remembers the earlier one and `off` gives it back.
- A command that outputs only failures hides a passing run: the test-output hook always prints the exit code and the last lines.
- Gemini's Batch API worked as documented (inline requests, asynchronous, results in the batch object); its answers are verified before use.
