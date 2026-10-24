# Testing

| Layer | Command | Network | Cost |
|---|---|---|---|
| Unit (routing hook) | `python3 -m unittest discover -s tests -v` | none | free |
| Installer helpers + simulated fresh install + personal-data scan | `node --test tests/ar.test.mjs` | none | free |
| Bridge with stand-in `claude`/`codex` programs (answer, actions, usage, limits, broken stream) | `node --test tests/bridge.test.mjs` | none | free |
| Key verification against the real providers | `node ar.mjs keys --check` | yes | free (list endpoints) |
| Smoke (3 modes end to end) | `node ar.mjs smoke` | yes | a few cents at most |
| Mid-stream failover (live) | `python3 scripts/flaky_server.py &` + streaming request to `model=test-flaky` | local + 1 Gemini call | negligible |
| Operation log | `node ar.mjs logs` | none | free |
| Usage report | `node ar.mjs usage` | none | free |
| Gemini probe (free vs paid, limits) | `GEMINI_PROBE_KEY=... python3 scripts/probe_gemini.py <models...>` | yes | free on a free key, tokens on a billed key |

Unit tests need `pip install pyyaml`; LiteLLM is stubbed. They cover: untouched real models, free never using paid
models, pool vs Gemini-free substitution, effort per tier, `task_bump`, sticky tool turns, escalate-only conversations,
`CLAUDE_PRIMARY=api`, handoff note on model change, Responses API effort, the heuristic classifier, route events written to the log and the streaming continuation (continues on the next model with a notice, no text yet → re-raise, tool calls not resumed, no fallback left → re-raise, clean stream untouched). 31 tests (adds: pins — `!opus`, `model:x`, natural phrases, no false positives, ambiguous names need `!`, auto-free refuses paid pins and accepts free ones, pin survives tool steps, `<userRequest>` scoping, footer warning when the pinned model did not answer; and footer inserted before the finish chunk, absent on tool-call steps and non-auto requests, stripped from history).

`node ar.mjs smoke` checks LiteLLM liveness, bridge liveness and one trivial prompt per mode. Exit code 1 on any failure.

## Manual checks used during development
- Bridge: 401 without key; 403 outside allowed roots; Ask returns read-only; Agent edits a file in a scratch git repo and lists it.
- Handoff: a conversation containing a Gemini reply and a file edited by someone else; Claude Code reported both correctly.
- Fallback: an invalid or exhausted provider falls to the next entry in `fallbacks`.

## Verified live on 2026-10-20
- Broken stream: `test-flaky` streamed "1, 2, 3, 4, 5, 6, " and dropped the connection; the client received the notice and "7, 8, ... 20" from `gemini-flash-lite` in one response.
- Bridge interruption: with `tests/fake_claude.sh` as the CLI, streaming returned the partial text and then a broken connection; non-streaming returned 429.

- VS Code itself: a real chat in `Auto:` models reached the gateway after the `requestHeaders` fix; the footer was verified on streaming and non-streaming answers and on `auto-smart` (Claude bridge); no footer on a tool-call step.
- VS Code-shaped request: streaming + `tools` through `auto-free` and `auto-balanced` returned a tool call (`finish_reason: tool_calls`).

- Pins live: `!opus` on `auto-smart` before the CLI update fell back to Sonnet with a visible warning; after updating Claude Code to 2.1.304 Opus answers.

## Not covered yet
- Agent-mode edits through every `Auto:` model in the editor.
- Anthropic API route (no credits).
- Gemini reading the handoff note after a Claude Code turn.
- Mid-stream continuation for the Responses and Anthropic Messages APIs (only Chat Completions streaming is handled).
- A real Claude plan-limit hit (only simulated).
- Cloudflare Workers AI.
- Daily quota behaviour of the free providers.
