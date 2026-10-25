# Routing (v3)

Which model answers a request is decided in two places: **the tables** in [`litellm/routing.yaml`](../litellm/routing.yaml) say which models each profile may use for each kind of task, and **the engine** ([`litellm/engine.py`](../litellm/engine.py)) filters and reorders inside them. Facts about models (price, privacy class, task suitability, limits) live in [`litellm/models.yaml`](../litellm/models.yaml). Nothing about a vendor is hard-coded.

## Profiles
| | `auto-free` | `auto-balanced` | `auto-smart` |
|---|---|---|---|
| Promise | never spends money or plan allowance | best cost/benefit; the everyday default | the best model for the task, without waste |
| Use for | questions, drafts, study, proofs of concept without sensitive data | features, scripts, data, docs, UI of MVPs | architecture, hard debugging, big refactors, production code, important documents |
| Spends money | never | little, capped | yes, capped |
| Uses a Claude / ChatGPT plan | no | yes, when it has room | yes, first choice |
| Quality floor (complexity +) | −1 | 0 | +1 |
| Per request / per day cap | US$ 0 / 0 | US$ 0.10 / 3 | US$ 1.50 / 15 |
| Pins to paid models | ignored | accepted | accepted |
| Fallback outside the profile | never | only downwards | only downwards |

Caps and offsets are the `profiles:` section of `routing.yaml`. Daily spend is tracked in `data/spend.json` (estimates for billed API calls; plan models cost nothing per call).

## Task types and complexity
The classifier ([`router_hook._classify`](../litellm/router_hook.py)) reads only the text inside Copilot's `<userRequest>` tags (masked by the DLP, at most 4000 characters, plus an "image attached" note) and answers `{"task", "complexity" 1-5, "risk", "long_output"}`. Tasks: `qa`, `explain_code`, `codegen`, `feature`, `frontend`, `refactor`, `debug`, `test_review`, `architecture`, `data`, `doc_tech`, `writing`, `research_long`, plus `mechanical` (agent steps already decided, only at checkpoints).
Adjustments (`task_adjust`): architecture +1, debug +1 when c ≥ 3, qa −1, explain_code −1, risk +1; mechanical = 1. Bands: `c1-2`, `c3`, `c4-5`. The classifier model is `CLASSIFIER_MODEL`; in `auto-free` it is the pool; if the text is sensitive and no allowed model may see it, a local keyword heuristic is used (no external call).

## The tables
`routes[profile][task][band]` is a list, primary first. An entry is an alias (`sn`, `gf`, `qwen` … → `aliases:` → a `model_name` in `config.yaml`) or `{model, effort, warn}`. `warn` marks "this profile is at its limit for this cell" (the footer then suggests a stronger profile). `escalate:` holds extra candidates reached only after failures. Example:
```yaml
balanced:
  feature:
    c3:   [{model: sn, effort: medium}, gf, dsf]
    c4-5: [{model: sn, effort: high}, {model: sol, effort: high}, gf]
    escalate: [{model: op, effort: medium}]
```
`claude-*` / `gpt-*` aliases get `-cli` (your plan) or `-api` from `CLAUDE_PRIMARY` / `OPENAI_PRIMARY`; `hk` is Claude Haiku **through the API** on purpose (through the CLI its fixed overhead is not worth a trivial task). Edits to the file apply on the next request.
The shipped tables are the plan of 2026-10-24; the plan's reasoning and the numbers behind them are in [DECISIONS.md](DECISIONS.md). The `fit` numbers in `models.yaml` are **estimates** until you calibrate them (below).

## What the engine does, in order
1. **DLP** (before anything else): secrets masked, request flagged *sensitive* when it holds a secret, personal data or an image. Sensitivity is sticky for the rest of the conversation and is re-checked on every request (a tool result may bring a secret mid-task; if the model in use is no longer allowed it is replaced, reason `sensitive`).
2. **Pin?** A pin must pass the same safety checks or it is ignored with a note in the footer.
3. **Candidates** = the cell of the table for (profile, task, band).
4. **Filters** (a candidate leaves at the first one it fails): safety (`SAFETY_MODE=on` removes `unsafe`) → sensitivity (only classes in `SENSITIVE_ALLOWED_CLASSES`; `restricted` and `unsafe` never) → available (configured, key set, pool member verified) → profile (free: free models only) → tools (reliability ≥ 4 for c ≥ 3, ≥ 3 for c ≤ 2) → vision (≥ 3) → context (`context + output ≤ 0.85 × min(window, tokens/minute)`) → health (plan quota, cooldowns, pool circuit breaker) → budget.
5. **Reorder**: a plan model with room goes before a billed neighbour of similar quality (fit differs ≤ 1), a nearly used-up plan goes after it. Plan cost = API cost × 0.25 (< 50 % used) / 0.6 / 1.5 (> 80 %); ≥ 95 % removes it.
6. **Floor and cost**: floor = clamp(complexity + profile offset, 1, ceiling). A model 1 below the floor is only a fallback (footer: `⚠ abaixo do recomendado`); lower is dropped. Excess rule: a model with slack ≥ 2 yields to one that still passes at ≤ ⅓ of the cost. `smart` also upgrades to the next model when it is one point better and costs ≤ 2.5×.
7. **Empty list** → the capability matrix (every allowed model ordered by expected cost) → the profile's safety net (tool requirement relaxed by one, flagged) → a clear error. It never climbs to a higher profile and never weakens safety.
8. **Fallbacks** = the rest of the filtered list (max 4), with the first other-vendor model brought forward when the first two share the primary's vendor. They are sent with the request (`fallbacks`), so LiteLLM's static list in `config.yaml` is only a last resort and can never reintroduce an unsafe model. A streaming answer that breaks continues on the same chain (up to 3 hops).

Cost estimate: `(context + CLI overhead) × input price + expected output × verbosity × output price`, with the price in force today (scheduled changes, DeepSeek off-peak window, Haiku above 100 K, Grok above 200 K).

## Blocked requests
| Situation | Message (HTTP 400/503) |
|---|---|
| sensitive content, no allowed model | `Conteúdo sensível detectado (<tipos>). Nenhum modelo permitido para <perfil>. Use Auto: Balanced/Smart, remova os dados ou ajuste SENSITIVE_ALLOWED_CLASSES.` |
| free pool down (circuit breaker open) | `O pool gratuito está indisponível. Tente de novo em alguns minutos ou use Auto: Balanced.` |
| safety on and the pool never verified | `Nenhum modelo disponível para este perfil com o modo de segurança ligado. Rode node ar.mjs omniroute…` |
| anything else | `Nenhum modelo disponível para <tarefa> no perfil <perfil>.` |
`auto-free` in Agent mode with c ≥ 3 has no free model with tool reliability ≥ 4: it uses the safety net (`qwen`) and says so, or blocks.

## During a task (Agent mode)
- Tool-result turns reuse the task's classification and re-run the engine (filters change: quota, pool health, sensitivity), preferring the model already working so it does not flip-flop.
- Every `checkpoint_every` steps (default 4) or on failure signals the next steps are re-classified. Two failing tool results in a row or a tool-call loop **escalate** at once (band above + the cell's `escalate:`; for `debug` a different vendor first). A cheaper model needs `downgrade_confirmations` (2) checkpoints in a row and `min_steps_between_switches` (3) steps; a new user message may go down at once. A short message (< 200 characters) does not drop below the previous band.
- `mechanical` steps move to the cheap list only if the saving exceeds re-sending the context to the new model (`engine.switch_saving_ok`).
- On a switch a handoff note tells the new model that others answered before and the files on disk are the truth.

## Effort
Per candidate (`effort:`), else `effort_default` by model (Opus: none ≤ c2, medium c3–4, high c5; Sonnet: low for qa/doc/writing at c ≤ 2 else medium, high from c4; GPT Sol: medium → high → xhigh; Haiku low/medium; others low/medium/high). `xhigh` is accepted but sent as `high` (support at the providers was not verified). Never `max`.
| Call type | Parameter set |
|---|---|
| Chat Completions | `reasoning_effort` |
| Responses API | `reasoning: {effort}` |
| Anthropic Messages to an `-api` Claude | `thinking: {type: enabled, budget_tokens: 2000 / 8000 / 24000}` |
| Claude CLI route | `reasoning_effort` forwarded by LiteLLM; the bridge turns it into `claude --effort` |

## Pinning a model for one turn
| You type | Effect |
|---|---|
| `!opus fix the parser` / `model:opus fix the parser` | Opus, effort high; the token is removed before the model sees the message |
| `Refactor this file. Do it using Opus` / `usando o Opus` | same, when it is a short sentence (≤ 120 characters) in the first or last 160 characters (only aliases marked `natural: true`) |
| `!pro`, `!flash`, `!lite`, `!argon`, `!grok`, `!sol`, `!luna`, `!astra`, `!deepseek`, `!dspro`, `!qwen`, `!oss`, `!free`, `!gpt`, `!copilot` … | see `pins:` in `routing.yaml`; add your own pointing at any `model_name` |
The token must start a line or follow whitespace (`foo!opus`, URLs and paths are not pins). A pin never overrides safety: a pin to a model the safety settings or the sensitive content forbid, to one that is not available on this install (no key / not configured), or to a paid model in `auto-free` is ignored and the footer says why. `!deepseek-free` (LLM7) is ignored while `SAFETY_MODE=on`; `!deepseek` (the official API) is ignored for sensitive content. The pin lasts for that turn and its tool steps. Inside Copilot only the text between `<userRequest>` tags is searched.

## Per-project privacy (planned)
The plan describes an optional `.auto-router/policy.yaml` (`confidential: true`, `allow_classes`) read when the workspace is known. It is **not implemented yet**; use `SENSITIVE_ALLOWED_CLASSES` globally for now.

## Learning from use
Every routed request writes `band`, `task`, `model` and `session` to `data/router.jsonl`. `node ar.mjs tune` counts, per (profile, task, band, model), the uses and the failures (escalation after tool errors or loops, a stream that had to continue elsewhere, a manual pin right after the answer). With ≥ 20 uses: failure rate > 30 % → the model moves one place **down** in that cell; < 10 % and cheaper than the model above → one place **up** (never a model the safety filter would remove; at most one move per cell per week). Dry run by default; `--apply` edits `routing.yaml` (backup `routing.yaml.bak`).

## Calibration (manual, after installing)
1. Pick the task types you use most; run ~12 real tasks of each at an easy and a hard level.
2. Pin the candidates of the cell in turn (`!sonnet`, `!flash` …).
3. Note whether it was solved, iterations, cost (`node ar.mjs usage`) and time.
4. Adjust the `fit` numbers in `models.yaml` and the order in `routing.yaml`; repeat monthly or when a model changes.

## Adding a model
1. Verify its id with a real call and give it a `model_name` in `config.yaml` (only when you have the key; pool models come from `node ar.mjs omniroute`).
2. Add it to `models.yaml` (vendor, privacy class, price, fit, tools, vision, context, `needs:` = the env variable with its key).
3. Give it an alias in `routing.yaml` and put it in the cells where it belongs.
Models in `models.yaml` that are not in `config.yaml` (DeepSeek, Grok, Gemini Argon, Llama 4 Maverick, Codestral) are skipped silently until you do.
