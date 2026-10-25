# Security changes (hardening release 0.4.0)

Executed 2026-10-25 from the review plan "achados e correções" (one commit per task `SEC-xx`). 🧪 = verified for real on this machine
(macOS, Docker Desktop, Claude Code 2.1.304, VS Code 1.142.0, OmniRoute 3.8.52, LiteLLM 1.106.0); "tests" = covered by the offline test suite only.
Concepts and reference: [SECURITY.md](SECURITY.md).

## What changed
| Task | Change | Verification |
|---|---|---|
| SEC-07 | Privacy classes (`trusted`, `no_retention`, `restricted`, `unsafe`, computed `pool`) for every model; `SAFETY_MODE`, `SENSITIVE_*` settings; `node ar.mjs safety`; `init --safety` | tests |
| SEC-08 | DLP before any model: secrets/PII/images detected and masked, sensitive requests restricted by class, per-request filtered fallbacks, blocked-with-message, 🔒 footer | tests; 🧪 live: a fake key was replaced by `«SECRET_1:openai_key»` before the model saw it, Auto: Free was blocked with the Portuguese message, Balanced answered with a trusted model |
| SEC-01 | Bridge: permission modes and Codex sandboxes validated (never `bypassPermissions` / `danger-full-access`), model ids validated (400), wildcard `BRIDGE_HOST` refused, client headers not forwarded | tests |
| SEC-04 | Images pinned by digest (omniroute 3.8.52, litellm main-stable = 1.106.0, pinned 2026-10-25), litellm gets an explicit env list (no `env_file`), `no-new-privileges`, `cap_drop ALL`, read-only filesystem, doctor network checks | 🧪 container env inspected (no OmniRoute password, no free-provider keys), smoke passed with `read_only` |
| SEC-10 | `init` refuses roots containing the repo, home or `/`; doctor checks modes and `.env` files in roots | tests; 🧪 doctor flagged this machine's own layout (see M6) |
| SEC-11 | Claude Code runs with deny rules + `PreToolUse` hook against secret files and env dumps | 🧪 real runs: Read `.env`, `cat .env`, `printenv` refused with the full settings and with the hook alone, `abc123` never returned |
| SEC-03 | Roots compared by real path; workspace only from header, VS Code window (`active-workspace.json`, 6 h), saved state, non-tool messages inside roots | tests |
| SEC-02 | Conversation id = system prompt + first message + workspace (bridge and hook) | tests |
| SEC-09 | `omniroute` skips `unsafe` providers/models under `SAFETY_MODE=on`, writes `data/pool-members.json` with classes | 🧪 live: Mistral/OpenRouter/NVIDIA/LLM7 not contacted, 16 members all `no_retention`, smoke OK |
| SEC-16 | OmniRoute contract (doc + verifier + `omniroute --check`), pool circuit breaker, `omniroute-upgrade` / `--rollback`, `update` never changes images, floating tags forbidden | 🧪 contract passes on the running instance and found two real API rules; dry-run, full switch and rollback with volume backup/restore executed; a non-existent tag changes nothing |
| SEC-05 | Internal calls (classifier, checkpoint, summary, memory): free never uses a paid key, safety/sensitivity respected, 4000-char cap | tests |
| SEC-13 | Memory masked (secrets and PII), `0600`/`0700`, delivered inside `<auto-router-memory>` marked as information | tests |
| SEC-14 | Private data files (umask), atomic bridge state, masked error text, sentinel test, OmniRoute request logging off | tests; OmniRoute variables set per its 3.8.52 documentation |
| SEC-12 | `node ar.mjs vscode --harden` (+ `--uninstall`) | tests |
| SEC-06 | Constant-time key check, 2 MB limit, cmd.exe cwd guard, stricter pins, CI least-privilege + SHA-pinned actions + gitleaks + dependabot, reproducible `.vsix` + `SHA256SUMS`, `update` follows release tags | tests |
| SEC-15 | This documentation | — |

## Differences from the plan (reality won)
- `Write(...)` deny rules are rejected by Claude Code 2.1.304 ("only Edit rules are matched; Edit covers all file-editing tools"): only `Read` and `Edit` rules are shipped.
- VS Code 1.142.0 contains `chat.agent.sandbox.enabled`, not `chat.tools.terminal.sandbox.enabled`: only the first is written.
- A combo in OmniRoute needs at least one model and returns its id at the top level; the contract verifier uses that.
- Stopping OmniRoute stops the gateway (dependency); the upgrade and rollback commands restart it.
- Under `SAFETY_MODE=on` Auto: Free is **blocked** until `node ar.mjs omniroute` has written `data/pool-members.json` (an unknown pool counts as `unsafe`).

## Decisions taken with the plan's default
- Presidio was not added; the DLP is regex + checksums (limits in SECURITY.md).
- The `.vsix` stays in the repository, but it is reproducible (`scripts/build-vsix.mjs`), `vscode-extension/SHA256SUMS` is checked by a test, and `ar.mjs vscode` builds from source before installing.
- `update` defaults to the latest release tag; while the repository had no tags it falls back to `main` with a warning. A branch needs `--yes`.

## Still pending / not verified
- Windows and Linux paths (cmd.exe cwd guard, `AR_UMASK` on Linux, `BRIDGE_HOST` for docker0) are written but only macOS was run.
- SEC-06 item 3: preferring the CLI's `cli.js` through `process.execPath` instead of a `.cmd` shell on Windows was not done (🧪 needs a Windows machine); the cwd guard covers the known risk.
- SEC-06 item 6: verifying a signed `SHA256SUMS` of a release before `update` — releases are not signed yet.
- SEC-02: confirm in real Copilot Chat that the start of the system prompt is stable across turns (otherwise sessions restart each turn; the bridge uses the first 500 characters only).
- SEC-14: that OmniRoute really stores no request bodies after `ENABLE_REQUEST_LOGS=false` was not inspected in its database.
- SEC-12: `vscode --harden` exists but was **not applied** to your VS Code settings; it asks first by design.
- Existing OmniRoute connections of skipped providers stay registered (but are in no combo).
- The extension (0.2.0) must be reinstalled to publish the active workspace: `node ar.mjs vscode`, then reload VS Code.

## Manual steps for you
| ID | Step | Where |
|---|---|---|
| M1 | Enable Zero Data Retention on Groq | console.groq.com → Settings → Data Controls |
| M2 | With `SAFETY_MODE=off` and OpenRouter: disable routing to training providers | openrouter.ai → Settings → Privacy |
| M3 | Leave `GEMINI_FREE_API_KEY` empty (ignored when safety is on) | `.env` |
| M4 | Budget alert (US$ 10) | console.cloud.google.com/billing |
| M5 | Review training/privacy settings of the Claude and ChatGPT subscription accounts | account settings |
| M6 | Move the auto-router folder outside your code folders (this machine: it is inside `BRIDGE_ALLOWED_ROOTS`) | filesystem |
| M7 | Remove real `.env` files from project repositories | projects |
| M8 | Open unknown repositories in restricted mode | VS Code |
