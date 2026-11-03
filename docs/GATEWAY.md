# Claude Code gateway (`auto`)

A small local process that sits between Claude Code and the model providers and picks, for every request, the model and effort
that fit the task. It keeps the claude.ai subscription login: Claude Code points `ANTHROPIC_BASE_URL` at it **without** a gateway
credential, so Claude requests still carry the subscription's OAuth token (verified 2026-11-02, see DECISIONS.md).

```
Claude Code ──► 127.0.0.1:4001 gateway ──► api.anthropic.com   (pass-through; only `model` and `output_config.effort` change)
                    │                  └──► Gemini OpenAI endpoint (translated, GEMINI_API_KEY; tools + streaming)
                    └─ answers itself: "Claude plan is out" question, resume confirmation
```

**Two modes** (`mode` in the config; `node ar.mjs mode shadow|route`):
- `shadow` (the default of the repository): the gateway decides and logs what it WOULD do, and sends every request exactly as Claude Code
  made it. Nothing changes for the person; `node ar.mjs report` shows what routing would have changed and saved.
- `route`: the request goes to the chosen model and effort.

**Gemini is not a conversation model here.** The `auto` choice is between Haiku, Sonnet and Opus (and their effort). Gemini serves the
classifier and the tools the Claude calls (`node ar.mjs gemini ...`, see `docs/TOKEN-SAVING.md`), because translating a Claude Code
conversation to another vendor loses thinking, server tools and the prompt cache (`docs/INCIDENTS.md`). A model takes the main loop only
if its `roles` in the config include `main`.

Light and local: Python 3.9+ standard library plus PyYAML, in its own venv (`~/.auto-router/venv`), about 35 MB of RAM. No Docker.
The only outbound connections are to the providers you enabled.

## The decision rule
Decided with the owner on 2026-11-02, in this order:

0. **A floor for the agent's main loop** (`quality.main_floor`, 3): a one-line question still arrives with the agent's whole toolbox and
   system prompt, so the main loop never asks for less. A reply that only continues the work ("continue", "yes", "did it hang?",
   your words in `patterns.continue_extra`) inherits the rating of the work in progress instead of being rated on its own, and so does a
   request that arrives far smaller than its session's peak (the client lost its history).
1. **Adequacy first.**
   - The task analysis gives:
     - `task`;
     - `complexity` 1-5;
     - `reasoning_depth` 1-5;
     - `uncertainty` 0-1;
     - `tool_intensity` 0-3;
     - `scope`;
     - `risk`.
   - The analysis comes from the classifier model, or from a keyword fallback marked uncertain. It also receives the project card
     `.auto-router/project.md` if one exists.
   - The **requirement** is the adjusted complexity, plus:
     - project criticality, from `.auto-router/policy.yaml`;
     - risk;
     - real uncertainty (above 0.3);
     - +1 after repeated failures inside the task.
   - Each model's **adequacy** is its `fit` for the task type (from `models.yaml`), corrected as follows:
     - minus a penalty for missing `reasoning`;
     - minus a penalty for tool-call reliability below what the task's tool use needs;
     - minus a penalty for a context near its window;
     - plus or minus the **outcome history** (how often that model finished this kind of task here without being escalated away).
   - A model is adequate when its adequacy is at least the requirement.
2. **Among adequate models, the cheapest** for this request: expected tokens × list price, with the prompt cache counted. A model
   used in this session within the cache lifetime reads the context at the cached rate; a cold one pays the cache write. If cheap
   models are adequate, they answer. If only an expensive one is, it answers. Never a bigger model "because there is room".
3. **Plan and credit balance only breaks ties.** It applies between adequate models of equivalent quality (`tie.adequacy_delta`,
   0.5): inside that group the expected cost of the task × the source's shadow price decides, so Gemini 4 Argon takes Sonnet-level
   work when the Claude week is tight. A source projected to run out before its reset (shadow price above `tie.pressure_lambda`, 1.0)
   always loses inside the group, whatever the prices: in a tight Claude week Gemini Flash takes the simple work Haiku would do
   (Haiku is ~17x cheaper per token, so price alone would never move it). Work that Flash is not adequate for (its adequacy is
   lowered by 0.5 from the owner's experience, so mid-size features) stays on Haiku. It keeps any quota from running out early and any credit from expiring unused.
   It never swaps an adequate model for a less adequate one. Sources and their shadow prices are in `gateway/funding.py`:
   - plan windows (5 h / 7 d, read from Anthropic's `anthropic-ratelimit-unified-*` headers);
   - credit lots with end dates;
   - prepayment;
   - card.
4. **The Claude plan is out and only a Claude model is adequate:** the gateway answers with a question. The numbers are fixed; an
   option that is not possible right now is left out, and the others keep their numbers:
   - **1**: the best available model now (Gemini), kept for the session until the plan is back;
   - **2**: Claude's paid extra usage (the owner's emergency reserve), only when Anthropic would serve it and
     `funding.claude.overage: ask`;
   - **3**: wait; the gateway resumes the session with `claude --resume` when the plan resets and sends a desktop notification;
   - **4**: stop; the gateway sends a notification when the plan is back, and the person continues by hand.

   An adequate Gemini is simply used, without asking.

**Paid extra usage is never automatic.** Past the plan limit, Anthropic may keep serving requests as paid extra usage
(`overage-status: allowed`). The gateway treats the plan as exhausted unless `allow_overage: true`, including for models picked in
the picker and for `!opus` pins.

**Inside a task** (same `x-claude-code-prompt-id`) the model is kept. At checkpoints (every 4 tool steps, or at once on two tool
errors or a loop) the remaining work is re-analysed:
- **Up, at once**, when the current model is no longer adequate.
- **Down, only after confirmation:** two checkpoints in a row must agree, at least 3 steps must have passed since the last switch,
  and the cheaper model must stay cheaper after paying its cold cache.

**Request classes:**
- `auxiliary` (titles, summaries) and the `Explore` subagent: Haiku, or the cheapest available model if Claude is out.
- `compaction`: the session's current model, because its cache is warm.

**Pins:**
- A Claude model chosen in Claude Code's picker, other than `auto_model`, is sent as asked.
- `!opus`, `!sonnet`, `!haiku`, `!pro`, `!flash` and `!lite` in a message pin that prompt.
- `!esperar` is option 3 at any time.

## The umbrella: switch everything, or one part
```sh
node ar.mjs on | off              # all of it / none of it. off ALWAYS returns Claude Code to Anthropic directly
node ar.mjs feature list          # what each part is, wanted vs installed
node ar.mjs feature token_hooks off
node ar.mjs status                # gateway, mode, model and effort in use per session, plan, features
node ar.mjs mode route            # shadow | route
node ar.mjs report --since 24h    # what routing chose against what Claude Code asked, estimated saving, cache hit, context drops
```
Wanted state: `gateway/features.defaults.json` (everything off, committed) overlaid by `config/local/features.json` (yours). Parts:
`gateway`, `claude_code`, `gemini_tools`, `token_hooks`, `haiku_subagents`, `compact_instructions`, `terse_style`, `statusline`,
`vscode_status`, `resume_on_reset`, `notifications`, `legacy_stack`. Everything installed under `~/.claude` is recognisable as ours and
removing a part touches nothing else (your hooks, permissions, status line, CLAUDE.md text stay). Do not switch the gateway off from a
session that goes through it: that cuts the session itself (`off` refuses unless `--force`).

**Which model is answering?** `sonnet (medium)`: the status line (`statusline`) and the VS Code status bar (`vscode_status`) show the model
and effort actually sent, and in shadow mode also `auto: haiku (low)`. The answer's own model label is the real model, never a Claude name
for a non-Claude model.

## Commands
```sh
node ar.mjs gateway install      # venv + login service (LaunchAgent on macOS, systemd --user on Linux); restarts on failure
node ar.mjs gateway status       # plan use, credits, last decisions per session, resume queue
node ar.mjs gateway restart      # after editing gateway/*.py, litellm/models.yaml or config/local/gateway.yaml
node ar.mjs gateway uninstall
node ar.mjs claude-code on       # point Claude Code at the gateway (~/.claude/settings.json, backup kept); new sessions
node ar.mjs claude-code off      # straight to Anthropic again
```
Logs:
- `data/gateway.jsonl`: one row per request with model, reason, analysis, requirement, adequacy and cost. No prompt text.
- `data/gateway.log`: the process log.
- `data/gateway-state.json`: read by `status`.
- `data/gateway-spend.json`: money spent per source.
- `data/gateway-outcomes.json`: learned history.
- `data/resume-queue.json`.

## Configuration
`gateway/defaults.yaml` holds the generic defaults and is committed. `config/local/gateway.yaml` holds your setup and is
git-ignored; it is merged over the defaults key by key. The main keys:

| Key | What |
|---|---|
| `models` | candidates: `upstream` (anthropic / gemini), provider `id`, funding `source`, `enabled` |
| `mode` | `shadow` or `route` |
| `auto_model` | requests for this model are routed (keep Claude Code's start model = `sonnet`; `claude-code off` gives your earlier model back) |
| `gemini_tasks` | what each `node ar.mjs gemini <task>` uses (model, purpose) |
| `patterns` | your language's continuation and complaint words (`continue_extra`, `complaint_extra`) |
| `messages` | every text the person reads (the plan-is-out question, notifications, the resume prompt): set your language here |
| `quality`, `adequacy`, `tie` | the weights of the rule above; per-model `adequacy_bias` in models.yaml holds the owner's experience |
| `funding.claude` | `allow_overage` (automatic paid extra usage, default false), `overage: never|ask` |
| `funding.google` | `currency`, `lots` (remaining, end date: from Cloud Console → Billing → Credits), `prepaid`, `allow_payg`, `horizon_days` |
| `funding.rates` | local currency units per USD |
| `on_claude_exhausted` | `ask`, `resume`, `resume_margin_s` |

Model facts (price, `fit`, `tools`, `reasoning`, `vision`, `privacy`, context) stay in `litellm/models.yaml`. `reasoning` and `fit`
are estimates until calibrated; the outcome history corrects them per project over time.

## Safety
- Safety and sensitivity filters (`litellm/safety.py`) run before adequacy.
- The DLP detects secrets and personal data in the last turns and makes the session sensitive (only `trusted` models). Here it
  **does not mask**: rewriting the body would break the prompt cache and thinking signatures, and every destination in this setup is
  `trusted`.
- The gateway listens on loopback only.
- It reads only `GEMINI_API_KEY` from `.env`.
- Logs never hold prompt text or credentials.

## Known limits
- Switching models mid-conversation breaks the prompt cache of the model left. The cost model counts that (a warm model reads its
  context at the cached rate); whether a change of `effort` alone keeps the cache is to be confirmed with the cache-hit line of `report`.
- The project card and index (`.auto-router/project.md`, PLAN 2C) are read when present but not generated yet.
- Credit lots are entered by hand from the console export. New monthly lots must be added to `config/local/gateway.yaml`.
- Gemini serving Claude Code is not supported by Anthropic. `translate_openai.py` keeps it working for an explicit choice (a model with
  the `main` role), but thinking blocks, server tools, documents and `tool_reference` blocks are dropped or reduced to text on that route.
- Windows: no login service yet.
