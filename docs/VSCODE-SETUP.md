# VS Code setup

Status (2026-10-20): **working** (VS Code 1.142, Copilot Chat 0.70). A real chat through `Auto:` models reached the gateway and answered.

## What is written
File `~/Library/Application Support/Code/User/chatLanguageModels.json` (macOS; backup of the original next to it as
`chatLanguageModels.json.bak-auto-router`; file mode 600). The existing `Gemini` provider entry is untouched; this object was appended:

```json
{
  "name": "auto-router",
  "vendor": "customendpoint",
  "apiKey": "<anything non-empty, ignored>",
  "apiType": "chat-completions",
  "models": [
    {"id": "auto-free", "name": "Auto: Free", "url": "http://localhost:4000/v1/chat/completions",
     "toolCalling": true, "vision": false, "thinking": false, "streaming": true,
     "maxInputTokens": 100000, "maxOutputTokens": 16000,
     "requestHeaders": {"Authorization": "Bearer <LITELLM_MASTER_KEY value>"}}
    /* auto-balanced ("Auto: Balanced") and auto-smart ("Auto: Smart") are identical apart from id and name */
  ]
}
```
Schema source: VS Code docs, *Language models → Custom Endpoint configuration reference*.
- `apiType: chat-completions` on purpose: mid-answer failover and the model footer exist for streaming Chat Completions.
- A URL ending in `/chat/completions` is used as is. `toolCalling: true` is required for Agent mode; `maxInputTokens + maxOutputTokens` must fit the smallest context among the free models.

## The key: what failed and what works
| Attempt | Result |
|---|---|
| `"apiKey": "${input:autoRouterKey}"` | VS Code never prompts for a hand-written input variable. It sent `Authorization: Bearer` with an empty key → gateway 401 "Malformed API Key". (Only references created by the *Manage Language Models* UI, `${input:chat.lm.secret.<id>}`, are resolved.) |
| literal `"apiKey": "sk-..."` | **Ignored too.** A capture stub on another port showed the header was just the word `Bearer` (6 characters, no key). |
| `requestHeaders: {"Authorization": "Bearer sk-..."}` on each model | **Works.** The docs say an explicit well-known auth header replaces the default one. |

Trade-off: the key sits in plain text in this file (mode 600). If Settings Sync uploads it, the key travels with it. The key only opens the loopback
gateway (`127.0.0.1:4000`), and rotating it is one edit of `LITELLM_MASTER_KEY` in `.env` + this file. To keep it in VS Code's secret store, re-add
the provider through *Chat: Manage Language Models* and enter the key in the UI.

## What the person does
1. Command Palette → **Developer: Reload Window** after any change to this file.
2. Chat model picker → **Auto: Free / Balanced / Smart**.
3. Stack up: `node ar.mjs status` (LiteLLM :4000; the Claude bridge :4100 for `auto-smart`).
4. Which model answered: **the end of every final answer carries a footer** (below), and `node ar.mjs logs --tail 10` has the details.

## Footer: which model answered
Every final answer (not tool-call steps) ends with, for example:
```
---
*auto-router · auto-free → free-pool-fast · groq/gpt-oss-20b · explain c1 · 2.2s*
```
Meaning: `requested mode → routed model group · real provider/model that answered (when known) · task, complexity[, effort] · time since routing`.
After a mid-answer failover it adds `continued on <model>`. It lives in the message text, so it can be selected and copied (VS Code's floating
"Response details" cannot). Footers are stripped from the history that models receive so they do not echo them. Turn it off with
`AUTO_ROUTER_FOOTER=false` in `.env` (recreate LiteLLM). The provider name comes from OmniRoute's `x-omniroute-provider` header; for non-streaming
answers or non-OmniRoute models only the model name may appear.

## Known limits
- Ask / Plan / Agent are the editor's modes. When `auto-smart` picks Claude through the CLI route, Claude Code (not the editor's tools) edits files;
  the chat shows its text, a `*Claude Code (...)*` block listing the files it touched, then the footer.
- Free models are less reliable at tool calling in Agent mode; if an Agent run misbehaves on `auto-free`, use `auto-balanced`.
- Inline completions are not routed through custom endpoints. If the stack is down the `Auto:` models just fail.
- VS Code sends ~110-130 tools in Agent mode (capped at 128; it logs "dropped N tool(s)"); a request is ~160 KB.
- Not verified in the UI: how mid-answer failover notices render; Agent-mode edits on every model.

## Undo
`cp "$HOME/Library/Application Support/Code/User/chatLanguageModels.json.bak-auto-router" "$HOME/Library/Application Support/Code/User/chatLanguageModels.json"`
