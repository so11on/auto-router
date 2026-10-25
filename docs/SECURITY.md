# Security

Last reviewed 2026-10-25 (security hardening, see [SECURITY-CHANGES.md](SECURITY-CHANGES.md)).

## Goal
Keep keys, passwords, tokens, personal data and confidential code from reaching providers that may log, train on or let humans read them,
and limit the damage of a compromised image, a prompt injection or a careless local caller. Using your Claude / ChatGPT / Copilot
subscription as a backend is an accepted design choice and is not restricted by any of this.

## The two switches
| Setting | Default | Effect |
|---|---|---|
| `SAFETY_MODE=on\|off` | `on` | `on` removes every model of class `unsafe` from all routes, fallbacks, pins and internal calls. `off` allows everything. |
| `SENSITIVE_GUARD=on\|off` | `on` | Detects secrets / personal data / images (DLP). A sensitive request only reaches classes in `SENSITIVE_ALLOWED_CLASSES` (default `trusted`; `restricted` and `unsafe` are never accepted, even if listed). To allow everything you must turn **both** off. |

Change with `node ar.mjs safety on|off|status`. Related: `SENSITIVE_MASK_SECRETS` (on), `SENSITIVE_MASK_PII` (off), `SENSITIVE_IMAGES` (`trusted_only`), `DLP_FAIL_MODE` (`closed`).

## Privacy classes (`privacy:` in `litellm/models.yaml`)
| Class | Meaning | Examples |
|---|---|---|
| `trusted` | Paid, terms say prompts are not used for training | Claude (CLI/API), OpenAI, Copilot, Gemini on a billed project |
| `no_retention` | Declares no training / no retention (free or paid) | Groq (enable Zero Data Retention), Ollama Cloud, Cloudflare Workers AI |
| `restricted` | Stable provider, jurisdiction or retention not acceptable | ordinary prompts only, never sensitive content |
| `unsafe` | May log, train, review; unknown policy; random host | Gemini free tier, LLM7, OpenRouter `:free`, NVIDIA trial, Mistral free |
| `pool` | computed: the worst class among the verified OmniRoute members (`data/pool-members.json`) | `free-pool*` |

A model without `privacy` counts as `unsafe`; an unknown pool counts as `unsafe`. To reclassify, edit `privacy:` in `litellm/models.yaml` (and `profiles/pool-models.json` for pool candidates). These classes come from each provider's published terms read on 2026-10-25; terms change, re-check them.

## Data flow by profile
| Profile | Where a normal prompt may go (`SAFETY_MODE=on`) | With `SAFETY_MODE=off` also | Sensitive prompt |
|---|---|---|---|
| Auto: Free | free pool (Groq, Ollama Cloud, Cloudflare) | + Mistral, OpenRouter `:free`, NVIDIA, LLM7, Gemini free tier | **blocked** with a message (pool is `no_retention`, not allowed for sensitive content by default) |
| Auto: Balanced | pool for trivial turns, billed Gemini, Claude / OpenAI / Copilot | same + unsafe pool members | only `trusted` models |
| Auto: Smart | Claude / OpenAI / Copilot | same | only `trusted` models |

Internal calls (classifier, checkpoint, summaries, project memory) follow the same rules: in Free they use the pool or a local heuristic, never a paid key; for sensitive text only an allowed class. Each sends at most `CLASSIFIER_MAX_CHARS` (4000) characters (summaries up to 60 000 of an already-masked transcript). If the pool is down Free never falls to a paid or `unsafe` model: it answers "O pool gratuito está indisponível…".

## What the DLP detects — and what it does not
Runs before any model (classifier and memory included). Secrets become `«SECRET_n:kind»`; personal data is masked only with `SENSITIVE_MASK_PII=on` (otherwise it flags the request sensitive). Masking is stable within a request and idempotent; values are never logged, only counts and kinds.
- **Detects:** prefixed keys (Anthropic, OpenAI, Google, GitHub, GitLab, Slack, AWS, Stripe, SendGrid, Hugging Face, Groq, NVIDIA, npm, PyPI…), PEM private keys, JWTs, connection strings with passwords, `password=`/`token:` assignments, `.env`-style lines, long high-entropy strings next to words like key/secret/token, this deployment's own secret values, CPF and CNPJ (checksum-validated), credit cards (Luhn, test cards ignored), e-mail (example/test domains ignored), Brazilian phone numbers, and images (sensitive unless `SENSITIVE_IMAGES=ignore`).
- **Does not detect:** passwords or secrets with no recognisable shape or keyword, names and addresses, business secrets, source code that is itself confidential, secrets split across messages, anything encoded or obfuscated. A regex tool cannot replace judgement: do not paste what must never leave your machine. If the scanner itself fails, `DLP_FAIL_MODE=closed` treats the request as sensitive.
- Files that Claude Code / Codex read **from disk** never pass through the gateway; see "Secret files" below.

## Secrets
- All secrets live in `.env` (`0600`, git-ignored); `.env.example` lists names only. Keep real secrets **outside** code folders.
- The gateway container receives only the variables it needs (explicit list in `docker-compose.yml`): no OmniRoute password and no free-provider keys.
- The billed Gemini and Anthropic keys are spendable. Never put the billed Gemini key in `GEMINI_FREE_API_KEY`. With `SAFETY_MODE=on` the free Gemini key is ignored and can stay empty.
- OmniRoute encrypts stored provider keys (AES-256-GCM) in the `omniroute-data` volume. Its detailed request logging is off (`ENABLE_REQUEST_LOGS=false`, retention 1 day).
- `node ar.mjs init` refuses `--roots` that contain the auto-router folder, your home folder or `/` (the agent could read every secret). `node ar.mjs doctor` also checks file modes and looks for `.env` files with real-looking values inside your roots.

## Network exposure
| Service | Bind | Auth |
|---|---|---|
| LiteLLM `:4000` | `127.0.0.1` | bearer `LITELLM_MASTER_KEY` |
| OmniRoute `:20128` | `127.0.0.1` | `REQUIRE_API_KEY=true` + dashboard password |
| claude-bridge `:4100` | `BRIDGE_HOST` (default `127.0.0.1`; `0.0.0.0` and `::` are refused) | bearer `BRIDGE_KEY`, compared in constant time; bodies over 2 MB → 413 |

LiteLLM does not forward client headers to providers (`forward_client_headers_to_llm_api: false`), so a caller cannot steer the agent through `x-claude-mode` and similar.

## Containers and updates
Images are pinned by tag **and** digest (see the comment at the top of `docker-compose.yml`), `no-new-privileges` on both, `cap_drop: ALL` and a read-only filesystem on the gateway. `node ar.mjs update` never changes an `image:` line. OmniRoute is a third-party dependency isolated by a contract; upgrade it with `node ar.mjs omniroute-upgrade` (contract test on a spare port, data backup, automatic revert, `--rollback`): [OMNIROUTE-CONTRACT.md](OMNIROUTE-CONTRACT.md). The LiteLLM image is changed by editing the compose file on purpose and running `node ar.mjs smoke`.
`ar.mjs update` follows the latest release tag; a branch needs `--yes`. The companion extension is built from `vscode-extension/` on your machine; the committed `.vsix` must match `vscode-extension/SHA256SUMS`.

## claude-bridge permissions
It lets HTTP requests drive an agent that can edit files. Mitigations: required key, loopback bind, `BRIDGE_ALLOWED_ROOTS` (required; compared by real path, so symlinks out of a root are refused), no shell by default, `plan` mode for requests without tools, 10-minute kill timeout.
- Callers cannot choose `bypassPermissions` or Codex `danger-full-access` (headers are validated against allow-lists; the same values in the environment stop the bridge at boot). Unknown model names → 400.
- The workspace comes from `x-workspace`, then the folder the VS Code window published (`~/.auto-router/active-workspace.json`, valid 6 h), then the conversation's saved folder, then paths found in non-tool messages inside the roots.
- A conversation is identified by its system prompt, first message and workspace, so two projects never share a CLI session.

## Secret files (Claude Code)
Every `claude` run gets deny rules and a `PreToolUse` hook that block reading or editing `.env*`, keys, `.ssh`, `.aws`, `secrets/`, credentials, and commands such as `env`, `printenv`, `cat .env` ([CLAUDE-BRIDGE.md](CLAUDE-BRIDGE.md)). Verified on Claude Code 2.1.304. Codex and Copilot CLIs have no such hook: keep secrets outside `BRIDGE_ALLOWED_ROOTS`.

## Memory and logs
- `.auto-router/memory/*.md` (git-ignored, `0600`/`0700`) is masked (secrets and personal data, always) and is handed to new chats wrapped in `<auto-router-memory>` with the instruction to treat it as information, not instructions.
- Files in `data/` and `~/.auto-router/` are private (`AR_UMASK`, default 077; on Linux set 022 if your user cannot read files the container wrote). `router.jsonl` and `usage.jsonl` hold metadata only; error text is masked before logging (a test sends a sentinel and checks).

## VS Code
`node ar.mjs vscode --harden` (optional, reversible) requires approval for edits to secret files and enables the terminal sandbox. Open unknown repositories in Workspace Trust restricted mode.

## Terms of service
- **Claude subscription.** Anthropic's published position, as reported by secondary sources in 2026 (not verified against the primary policy), is that Pro/Max OAuth tokens are for Claude Code and Claude.ai only. The bridge never extracts or forwards the token: it runs the official `claude` binary as you. Read Anthropic's current Claude Code legal page; `CLAUDE_PRIMARY=api` avoids the question.
- **ChatGPT plan.** The bridge runs the official `codex` binary as you; whether OpenAI accepts a wrapper that drives it from another UI could not be verified. `OPENAI_PRIMARY=api` avoids the question. Plus/Pro does not include API credit.
- **GitHub Copilot.** Only through GitHub's own Copilot CLI (`copilot -p`); no extension re-export or reverse-engineered proxy. Bulk automated use is subject to GitHub's acceptable-use rules and the plan's premium-request limits.
- **Free tiers.** Each provider sets its own terms; some forbid relaying or log prompts. That is why `SAFETY_MODE=on` is the default.
- **Personal data of third parties** sent to providers abroad may have LGPD implications. Check with legal counsel.

## Manual steps nobody can do for you
M1 enable Groq Zero Data Retention (console.groq.com → Settings → Data Controls) · M2 with `SAFETY_MODE=off` and OpenRouter, disable routing to training providers (openrouter.ai → Settings → Privacy) · M3 leave `GEMINI_FREE_API_KEY` empty · M4 set a budget alert (US$ 10) in Google Cloud Billing · M5 review privacy / training settings of your Claude and ChatGPT subscription accounts (CLI routes follow consumer terms) · M6 keep the auto-router folder outside your code folders · M7 remove real `.env` files from project repositories · M8 open unknown repositories in restricted mode.
