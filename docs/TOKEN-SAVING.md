# Saving tokens in Claude Code

What actually moves the bill, what the auto-router automates, and what is not worth it. Researched 2026-11-03; numbers from third parties are
marked as such. Each automated item is a separate switch: `node ar.mjs feature list`.

## Where the tokens go
In Claude Code the cost is dominated by **input** (the history re-read from the cache on every request, tool definitions, files read) and by
**thinking** (billed as output). The visible text of the answers is a small slice: independent measurements put output at roughly 0.6-2.5 %
of billed tokens. Optimise the big slices first.

## What is automated or semi-automated

| Technique | Switch | What it does | Expected effect |
|---|---|---|---|
| Effort per prompt | gateway in `route` mode | `low/medium/high` from the task analysis; thinking is the largest output cost | high |
| Keep the model while its cache is warm | gateway | a warm model reads its context at the cached rate; a switch pays the full write | avoids re-reading a big context at full price |
| Cut test output | `token_hooks` | a plain test command is rewritten so only failures and the last lines reach the context; exit code kept | high in test-heavy sessions |
| Haiku subagent for verbose work | `haiku_subagents` | tests, builds and long logs run in a Haiku subagent; only a summary returns | high |
| Gemini as a reader | `gemini_tools` | `node ar.mjs gemini digest/media/research/review/batch`: 1M-token window, low price, only the answer returns | high for big inputs; uses expiring credits |
| Compaction instructions | `compact_instructions` | tells `/compact` what to keep | medium |
| Terse style | `terse_style` | optional, see below | low |
| Context audit | `node ar.mjs optimize` | sizes of CLAUDE.md/AGENTS.md (read on every turn), MCP servers, missing hooks | medium |
| Status line | `statusline` | shows model (effort), context % and plan use, so waste is visible | indirect |

## Habits no tool can replace (official guidance, code.claude.com "Manage costs")
- `/clear` between unrelated tasks; `/compact` with instructions; keep CLAUDE.md short (under about 200 lines) and move workflow-specific text to skills.
- Prefer CLI tools (`gh`, `aws`) to MCP servers; disable servers you do not use (`/mcp`). Tool definitions are deferred by default.
- Sonnet for most work, Opus for hard design; Haiku for simple subagents.
- Plan mode before big changes; specific prompts; give verification targets.
- `/usage` shows what counts against the plan and recommends changes; pressing `f` applies those it can.
- Code-intelligence (language server) plugins cut exploratory reads in typed languages.

## "Caveman" mode: does it pay?
A skill/style that makes the model answer in clipped, filler-free text.
- Vendor claim: 65-75 % fewer output tokens. Independent tests (third-party write-ups, 2026): 12-23 % of output tokens against a chatty baseline,
  and about 4 % against simply telling the model to be concise. Accuracy at default intensity was reported unchanged; the "ultra" level had
  instruction-following failures on complex tasks.
- Because output is a small slice of the bill, the whole-bill effect is small: roughly 0.4 % to 3 %.
- Its sibling that compresses memory files (CLAUDE.md) is worth more: that file is input on every turn.

Verdict: **optional, off by default** (`terse_style`). Worth turning on when your sessions are mostly explanation and chat, when you simply prefer
short answers, or when the reply has to fit somewhere small. Not worth it as a bill-reduction measure for agentic coding. The style keeps code,
commands and error messages exact.

## What is not automated, on purpose
- Rewriting your CLAUDE.md (the audit tells you; you decide).
- Anything that changes `messages`, `system` or `tools` of a Claude request: it would break the cache and thinking.
- Batch for Claude: the Message Batches API needs a Console API balance, a different wallet from the subscription's usage credits.
  Batch for Gemini works (`node ar.mjs gemini batch ...`, half price, asynchronous). Gemini's implicit cache does not stack with batch
  pricing: use batch for non-urgent bulk, the cache for repeated large prefixes.

## Sources
- Claude Code costs: https://code.claude.com/docs/en/costs
- Caveman measurements: https://www.implicator.ai/caveman-claude-code-skill-cuts-output-20-your-bill-barely-notices-2/ ,
  https://decrypt.co/363440/devs-claude-talk-like-caveman-cut-costs-work-better , https://pasqualepillitteri.it/pt/news/1659/claude-code-caveman-mode-economia-tokens
- Other guides: https://www.kdnuggets.com/7-practical-ways-to-reduce-claude-code-token-usage
- Gemini prices and cache: third-party tables disagree; check https://ai.google.dev/gemini-api/docs/pricing. Calls made by this project are logged with their cost.
