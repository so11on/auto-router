# Claude Code gateway (`auto`)

A small local process that sits between Claude Code and the model providers and picks, for every request, the model and effort
that fit the task. It keeps the claude.ai subscription login: Claude Code points `ANTHROPIC_BASE_URL` at it **without** a gateway
credential, so Claude requests still carry the subscription's OAuth token (verified 2026-11-02, see DECISIONS.md).

```
Claude Code ──► 127.0.0.1:4001 gateway ──► api.anthropic.com   (pass-through; only `model` and `output_config.effort` change)
                    │                  └──► Gemini OpenAI endpoint (translated, GEMINI_API_KEY; tools + streaming)
                    └─ answers itself: "Claude plan is out" question, resume confirmation
```

Light and local: Python 3.9+ standard library plus PyYAML, in its own venv (`~/.auto-router/venv`), about 35 MB of RAM. No Docker.
The only outbound connections are to the providers you enabled.

## The decision rule
Decided with the owner on 2026-11-02, in this order:

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
   work when the Claude week is tight, and Flash replaces Haiku only when the plan is very tight. It keeps any quota from running out early and any credit from expiring unused.
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
| `auto_model` | requests for this model are routed (keep Claude Code's start model = `sonnet`) |
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
- The project card and index (`.auto-router/project.md`, PLAN 2C) are read when present but not generated yet.
- Credit lots are entered by hand from the console export. New monthly lots must be added to `config/local/gateway.yaml`.
- Gemini serving Claude Code is not supported by Anthropic. It is translated by `translate_openai.py`, and thinking blocks and server
  tools are dropped on that route.
- Windows: no login service yet.
