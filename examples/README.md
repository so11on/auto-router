# Examples

Copy what you need to `config/local/` (git-ignored) and edit. Nothing here is on by default.

| File | What it is |
|---|---|
| `gateway.claude-only.yaml` | only Haiku/Sonnet/Opus; the safest start (shadow mode) |
| `gateway.claude-plus-gemini-tools.yaml` | Claude conversation + Gemini as a tool for big reads; shows expiring-credit lots |
| `gateway.owner-suggested.yaml` | one person's real choices, anonymised: route mode, own language for texts, Gemini classifier, credits |
| `features.minimal.json` | gateway + status line only |
| `features.full.json` | everything except the older Docker stack |

`cp examples/gateway.claude-only.yaml config/local/gateway.yaml`, then `node ar.mjs gateway restart`.
Features: `cp examples/features.minimal.json config/local/features.json`, then `node ar.mjs on`.
