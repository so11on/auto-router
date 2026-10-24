# Routing

## Modes
| Model name | Intent |
|---|---|
| `auto-free` | Best free model for the task. Never uses paid keys. |
| `auto-balanced` | Best cost/benefit for the task. Cheap models for easy work, Claude Sonnet for hard work. |
| `auto-smart` | Best frontier model for the task; also sets reasoning effort. |

## Classification
`router_hook._classify` sends the newest user message (first 4000 chars) to `CLASSIFIER_MODEL` and expects
`{"task": explain|codegen|debug|refactor|plan|research, "complexity": 1-5}`:

| Complexity | Meaning |
|---|---|
| 1 | trivial lookup or tiny edit |
| 3 | multi-step change in one area |
| 5 | cross-cutting design, hard debugging, large refactor |

On any error it uses `_heuristic`: keywords pick the task, text length (<200, <800, else) picks complexity 1-3.
Contexts above 60k tokens (chars/4) add +1.

## Selection table: `litellm/routing.yaml`
```yaml
task_bump: {plan: 1, debug: 1, research: 0, codegen: 0, refactor: 0, explain: -1}
modes:
  smart:
    - {max_complexity: 2, model: claude-sonnet, effort: low}
    - ...
```
The first tier whose `max_complexity` is >= the (bumped, clamped 1-5) complexity wins. `effort` is `low|medium|high`.
The file is read on every new classification, so edits apply without restart (it is mounted read-only into the container).

Model names in the table are LiteLLM `model_name`s from `config.yaml`, with two special cases:
- `claude-haiku|sonnet|opus` get `-cli` or `-api` appended from `CLAUDE_PRIMARY`.
- `free-pool*` is replaced by `gemini-free-flash-lite` unless `FREE_POOL_ENABLED=true`.

Current tiers (2026-10-20):

| Mode | c1 | c2 | c3 | c4 | c5 |
|---|---|---|---|---|---|
| free | free-pool-fast | free-pool-fast | free-pool-coding | free-pool-coding | free-pool-coding |
| balanced | free-pool-fast | gemini-flash-lite (billed key) | gemini-flash (billed key) | claude-sonnet low | claude-sonnet medium |
| smart | claude-haiku | claude-sonnet low | claude-sonnet medium | claude-opus medium | claude-opus high |

`free-pool-fast` = OmniRoute combo `free-fast`; `free-pool-coding` = combo `free-coding` (see [FREE-TIER-LIMITS.md](FREE-TIER-LIMITS.md)). With `FREE_POOL_ENABLED=false` those tiers use the Gemini free tier (flash-lite only) instead, and if the whole pool fails LiteLLM falls back to that same model. `balanced` c1 also uses the free pool.

## Pinning a model for one turn
Write the model in the message and the router obeys instead of classifying (`via=pinned` in the log, `pinned: <alias>` in the footer):

| You type | Effect |
|---|---|
| `!opus fix the parser` or `model:opus fix the parser` | Opus, effort high. The `!opus` token is removed before the model sees the message. |
| `Faça a migração usando o Opus` / `write tests, using sonnet` / `com o Sonnet` | same, when the phrase is within the first or last 160 characters (only for aliases marked `natural: true`) |
| `!pro`, `!flash`, `!lite`, `!free` | ambiguous words: only the explicit `!` / `model:` forms work |

Aliases live in `routing.yaml` under `pins:` (`opus, sonnet, haiku, pro, flash, lite, deepseek, gpt-oss, nemotron, free`); add your own by pointing at any
`model_name` from `config.yaml`. Rules: the pin lasts for that user turn and its tool steps, the next plain message routes normally again;
`auto-free` **ignores pins to paid models** (footer says so) and accepts the free ones (`!deepseek`, `!gpt-oss`, `!nemotron`, `!free`);
inside Copilot only the text between `<userRequest>` tags is searched, so a `!haiku` inside pasted code is not a pin. If the pinned model fails, the normal
fallback chain answers and the footer shows `⚠ pinned model unavailable, answered by <model>`. `!` is used because Copilot treats `@` and `#` as its own syntax.

## Stickiness
- Key: sha1(mode + first user message). Entries live 1 h in memory.
- Tool-result turns (agent loops) reuse the stored decision, so an agent run stays on one model.
- A new user turn is reclassified but never lowers complexity; the conversation only escalates.

## Effort mapping
| Call type | Parameter set |
|---|---|
| Chat Completions | `reasoning_effort` |
| Responses API | `reasoning: {effort}` |
| Anthropic Messages to an `-api` Claude | `thinking: {type: enabled, budget_tokens: 2000 / 8000 / 24000}` |
| Claude CLI route | `reasoning_effort` is forwarded by LiteLLM; the bridge turns it into `claude --effort` |

## Changing behaviour
- Make a mode cheaper/smarter: edit `routing.yaml` tiers.
- Add a model: add a `model_list` entry in `config.yaml`, reference its `model_name` in `routing.yaml`, add fallbacks.
- Prefer the Claude API over the CLI: `CLAUDE_PRIMARY=api` in `.env`, then restart LiteLLM.
- Replace the classifier: set `CLASSIFIER_MODEL` (any LiteLLM model string).
