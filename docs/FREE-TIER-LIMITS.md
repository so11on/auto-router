# Free-tier models and limits

Everything here was measured on **2026-10-20** with real calls. Providers change quotas and models often; re-run
the probes before trusting a number after a few weeks. "Observed" means seen in a response or a timing; it is not
a published guarantee.

## How free vs paid was told apart
The Gemini API does not label a key. A key on a **billed** project passed 30 parallel requests on every model,
including Pro, in ~1 s each. A key on a project **without billing** returns HTTP 429 with a body such as
`generate_content_free_tier_requests, limit: 15`. `scripts/probe_gemini.py` automates this. The key in
`GEMINI_API_KEY` is billed; `GEMINI_FREE_API_KEY` is free-tier.

## Gemini free tier (key without billing)

| Model | Works | Observed limit | Observed latency | Notes |
|---|---|---|---|---|
| `gemini-3.5-flash-lite` | yes | 15 requests/min | 19-24 s per call | Used as `gemini-free-flash-lite` and as the classifier-grade fallback. |
| `gemini-3.1-flash-lite` | yes | 15 requests/min | 13-27 s | Frequent HTTP 503 "high demand". |
| `gemini-flash-lite-latest` | yes | same family | 24-31 s | Alias of flash-lite. |
| `gemini-3.8-flash` | yes | 5 and 20 requests/min reported | 0.3 s when 429, else seconds | Was `gemini-free-flash`; removed from the config on 2026-10-20 (hits 429 after a handful of calls). |
| `gemini-3.5-flash`, `gemini-3.6-flash`, `gemini-3-flash-preview` | yes, intermittently | 5-20 requests/min; the Flash family appears to share quota | - | Right after the key was created some calls returned 403 "caller does not have permission"; they cleared later. |
| `gemini-3.7-flash` | yes | not measured | - | One 503 "high demand". |
| `gemma-4-26b-a4b-it` | yes | no quota text seen | 0.6-1.5 s | Was `gemma-free`; removed from the config on 2026-10-20. Intermittent HTTP 500. Spends tokens on hidden reasoning, keep `max_tokens` generous. |
| `gemma-4-31b-it` | mostly no | - | - | 28 of 30 burst calls returned HTTP 500. |
| `gemini-3.1-pro-preview`, `gemini-pro-latest` | **no** | - | - | 403 PERMISSION_DENIED on the free key: no free tier for Pro. |
| `gemini-4-argon` | **no** | `limit: 0` | - | 429 with free-tier limit 0. |
| `gemini-2.5-*` | **no** | - | - | 404 "no longer available to new users". |

Not measured: daily request and token limits (RPD/TPD). Treat the per-minute numbers as the floor of what you can rely on.
**Practical consequence:** the Gemini free tier is a slow last-resort fallback (~20 s per answer), not a primary route.

## Free pool (OmniRoute combos)
`free-fast` and `free-coding` are priority combos (they now also contain LLM7 DeepSeek-V4-Flash, see the research section) created in OmniRoute; LiteLLM calls them as `free-pool-fast` and
`free-pool-coding` (`free-pool` = `free-coding`). Latency measured through OmniRoute, one tiny prompt each:

| Provider / model | Works | Latency | Notes |
|---|---|---|---|
| Groq `openai/gpt-oss-120b` | yes | 0.46 s | First choice of `free-coding`. |
| Groq `openai/gpt-oss-20b` | yes | 0.46 s | First choice of `free-fast`. Reasoning model: returned empty text at `max_tokens=60`; allow >= 200. |
| Groq `qwen/qwen3.8-27b` | yes | 0.30 s | |
| Groq `qwen/qwen3.6-27b`, `groq/compound` | **no** | - | 404 "does not exist or you do not have access". |
| Groq `allam-2-7b` | yes | 0.5 s | Arabic-centred model. `auto/best-free` picked it, which is why explicit combos are used instead of `auto/*`. |
| OpenRouter `nvidia/nemotron-3-ultra-550b-a55b:free` | yes | 0.7 s | |
| OpenRouter `minimax/minimax-m3.1-flash:free` | yes | 1.1 s | |
| OpenRouter `poolside/laguna-s-2.1:free` | yes | 0.9 s | |
| OpenRouter `cohere/north-mini-code:free` | yes | 1.2 s | |
| OpenRouter `google/gemma-4-31b-it:free` | yes | 10 s | Slow. |
| OpenRouter `nvidia/nemotron-3-super-120b-a12b:free` | no | - | 404 "Provider returned error". |
| OpenRouter `thinkingmachines/inkling:free` | no | - | 403 "only available on agentic harnesses". |
| Mistral `codestral-latest` | yes | 3.4 s | The only Mistral model that answered. |
| Mistral `mistral-small-latest`, `mistral-medium-3-5`, `devstral-latest` | **no** | 25-30 s then 429 | "upstream error (reset after 3s)", repeatable with 6 s spacing. |
| Mistral `mistral-large-latest` | **no** | 10 s | 403. |

Published quotas (from OmniRoute's own documentation, not measured): OpenRouter `:free` models are capped
per day (about 50 requests/day without a deposit); Groq limits are per model and per day; Mistral's free plan is
rate limited. OpenRouter free models can disappear without notice (`nemotron-3-super` already returned 404).
Verify current numbers in each provider's console.

## Not connected
- **Cloudflare Workers AI** — **working since 2026-10-24** (see below). Earlier problem: account id and token saved, but every call to `/accounts/<id>/ai/...` returned 401 "Authentication error" and `/accounts/<id>` returned 9109 "Unauthorized". The token verifies as a user token. Fix in the dashboard: token must list this account under *Account Resources* and have *Workers AI* permission (template "Workers AI"), and the id must be the account id from the dashboard URL. Not tested beyond that.
- **OmniRoute keyless providers** (Pollinations, OpenCode Zen, Kilo): all required a real key at test time and were removed.
- **Anthropic API**: key valid, balance zero ("credit balance is too low"); not free in any case.

## Claude through Claude Code (subscription)
Not a free tier: it spends your Claude plan allowance (5-hour and weekly windows). Verified models on 2026-10-20:
`claude-haiku-5-5`, `claude-sonnet-5-5` and `claude-opus-5-5` all work through the bridge with Claude Code 2.1.304 (Opus failed on 2.1.72: version too old). When the plan
limit is hit the bridge returns HTTP 429 and LiteLLM falls back to the API route, then to Gemini.

## Re-measuring
```sh
GEMINI_PROBE_KEY=<free key> python3 scripts/probe_gemini.py gemini-3.5-flash-lite gemini-3.8-flash gemma-4-26b-a4b-it
```
For the pool, call `POST http://127.0.0.1:20128/v1/chat/completions` with `model=<provider>/<model>` and the `FREE_POOL_KEY`.

## Is the Google free tier "slow and bad"?
Slow and unreliable: yes. Bad quality: not shown by these tests. The same `gemini-3.5-flash-lite` answers in ~0.9 s on the
billed key and in 19-24 s on the free-tier key, so the model is the same and the free tier gets low queue priority and
tight per-minute quotas (15/min flash-lite, 5-20/min Flash, shared across the family). Answer quality was not benchmarked
here. That is why Gemini free is only the fallback behind the Groq / OpenRouter / Mistral combos.

## DeepSeek and other free models — research of 2026-10-20
Sources: OmniRoute's `FREE_TIERS.md` and `FREE-TIERS-GUIDE.md` (shipped in its container), the community list
[mnfst/awesome-free-llm-apis](https://github.com/mnfst/awesome-free-llm-apis), and a web search. Numbers marked *listed* come from
those sources and were **not** measured by us; *measured* ones were called from this machine.

### Added today
| Provider / model | Status | Evidence |
|---|---|---|
| LLM7 `DeepSeek-V4-Flash-0731` (**daily token cap: after our tests it answered 429 "Daily t…" on 2026-10-20**, so expect it to be a part-time fallback) | **in `free-fast` and `free-coding`** (after Groq/Mistral, before OpenRouter) | measured: works with no key (a placeholder token), 1.7 s; answered a real question correctly. A 1-token "ok" prompt returned repeated text, so give it real prompts. Listed: 60 req/min, 250/h, 100K tokens/day with a free token. Terms: "experimentation, development and research"; prompts may be logged. Its catalogue also lists many Claude/Gemini models for free; they were not used (provenance unclear). |

### Works without an account but is not wired in
| Provider | Measured | Why not wired |
|---|---|---|
| OVHcloud AI Endpoints (`oai.endpoints.kepler.ai.cloud.ovh.net/v1`) | anonymous; `gpt-oss-120b`, `Qwen3.8-27B`, `Qwen3.5-397B-A17B`, `Meta-Llama-3_3-70B-Instruct`, `Mistral-Small-3.2-24B` listed; `gpt-oss-120b` answered in 3.6 s, then **429 on 5 immediate retries** | listed limit 2 requests/min per IP per model: only an emergency fallback. Keyed access is billed per token. EU-hosted. |

### Connected and tested after signup (2026-10-20)
**Ollama Cloud** (key in OmniRoute; direct API `https://ollama.com/v1`). The free plan is small:

| Model | Result |
|---|---|
| `gemma4:31b`, `nemotron-3-super`, `nemotron-3-ultra`, `nemotron-3-nano:30b`, `gpt-oss:20b`, `gpt-oss:120b`, `minimax-m3.1-flash` | **free, work** (0.6-3.4 s) |
| `deepseek-v4-pro`, `deepseek-v4.1-flash`, `kimi-k3`, `kimi-k2.6`, `kimi-k2.7-code`, `glm-5.2`, `glm-5.3`, `glm-5.3-flash`, `minimax-m3`, `mistral-large-3:675b` | **HTTP 402 "not included in your free usage"**: paid credits only |
| `mistral-large-4` | 403 "being rolled out, not yet available to you" |
| `glm-5.1`, `qwen3.5:397b`, `deepseek-v4-flash` | **410 retired** (2026-09-25) |

So Ollama Cloud gives **no free DeepSeek or Kimi** on this account, contrary to the community list. Through OmniRoute only `gemma4:31b`
and `nemotron-3-super` were confirmed; OmniRoute rewrites `gpt-oss:120b` to `gpt-oss-120b`, which Ollama rejects (404), and
Groq already serves gpt-oss. Warning: one call to a retired model made OmniRoute lock out the whole connection (every model
returned 410 until the connection was deleted and recreated). Do not probe retired or paid ids through OmniRoute; use the direct API.

**NVIDIA NIM** (`https://integrate.api.nvidia.com/v1`, 81 models listed, most unusable):

| Model | Result |
|---|---|
| `nvidia/nemotron-3-ultra-550b-a55b` | works: 8.6 s direct, 1.2 s through OmniRoute |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | works (4.3 s) |
| `z-ai/glm-5.3` | works, 14-45 s |
| `meta/muse-glimmer-30b` | works (10 s) |
| `poolside/laguna-xs-2.1` | works but 44 s |
| `deepseek-ai/deepseek-v4.1-flash`, `z-ai/glm-5.3-flash`, `google/gemma-4-31b-it` | timeouts (>90 s; DeepSeek >280 s) |
| `moonshotai/kimi-k3`, `deepseek-ai/deepseek-v4-pro-0813`, `deepseek-v4-flash-0731`, `openai/gpt-oss-120b` | **410 end of life** |
| `moonshotai/kimi-k2.6`, `nemotron-3-super-120b-a12b`, `llama-3.1-nemotron-ultra-253b`, `mistral-large-2-instruct`, `codestral-22b` | 404 "not found for account" (listed but not enabled) |

OmniRoute's own model list for both providers was stale (it still lists retired ids): always test the provider's live `/v1/models`.
Wired into the combos: `nvidia/nemotron-3-ultra-550b-a55b`, `ollama-cloud/nemotron-3-super`, `ollama-cloud/gemma4:31b`.

### Still needs a signup (not connected; nothing below was tested)
| Provider | Best free models (listed) | Limits (listed) | Notes |
|---|---|---|---|
| Z.AI (api.z.ai; open.bigmodel.cn) | GLM-4.7-Flash (reasoning, 200K ctx), GLM-4.6V-Flash | 1 concurrent request | no card; overseas phone numbers accepted. |
| Cloudflare Workers AI | Llama 3.3 70B, gpt-oss-120b, Gemma 4 26B, GLM-4.7-Flash, DeepSeek-R1-Distill-Qwen-32B | 10,000 Neurons/day shared; fails instead of billing | token saved, account id missing. DeepSeek V4 and Kimi need a paid plan here. |
| Cohere (dashboard.cohere.com/api-keys) | Command A / A Reasoning / R+, Aya | 20 req/min, 1,000 calls/month | **non-commercial** trial key. |
| Kilo (app.kilo.ai) | Nemotron 3 Ultra, Step 3.7 Flash, Laguna, North Mini Code, Qwen3.8-27B, `kilo-auto/free` | 200 req/h per IP | listed as keyless, but OmniRoute rejected a placeholder key; prompts may be logged. |
| Logfare (logfare.ai/register) | deepseek-v4-pro, kimi-k3, glm-5.2, minimax-m3 | none stated | **logs every request** (opt-out at logfare.ai/consent). |
| DeepSeek platform (platform.deepseek.com) | DeepSeek V4 | one-time ~5M tokens | not recurring. |
| ModelScope, SiliconFlow | Qwen3.5-35B / Qwen3-8B | 2,000 req/day; 1,000 RPM | require Chinese real-name verification; skip. |
| Hugging Face, Aion Labs, OpenCode Zen | small models; roleplay models; rotating free models | ~$0.10/month credit; 15 req/min; unpublished | low value for coding. |

Caveats common to this research: aggregator lists age quickly (Groq already retired `qwen3.6-27b`; OpenRouter free models
rotate), "free" often means prompts may be logged or used for training, and several terms of service forbid reselling or
sharing keys. Personal use through a local proxy is the case we rely on; read each provider's terms.

Free DeepSeek/Kimi remains scarce: the only working free DeepSeek is LLM7 `DeepSeek-V4-Flash-0731`. Next to try: **Z.AI** (GLM-4.7-Flash), then Cloudflare (needs the account id) and Logfare.

Add one with the steps in [OPERATIONS.md](OPERATIONS.md), test each model with a one-token call, then append it to the
`free-fast` / `free-coding` combos.

## Removed from the active lists because they were unreliable (2026-10-20)
| Model | Why removed |
|---|---|
| Gemini free `gemini-3.8-flash` (and 3.5/3.6/3-flash-preview) | 5-20 requests/min shared by the family; 403/429/503 bursts |
| Gemini free `gemma-4-26b-a4b-it`, `gemma-4-31b-it` | intermittent HTTP 500 (28 of 30 burst calls for the 31b) |
| OpenRouter `google/gemma-4-31b-it:free` | 10 s per answer |
| Mistral `mistral-small-latest`, `mistral-medium-3-5`, `devstral-latest`, `mistral-large-latest` | 429 (even spaced 6 s) / 403 |
| NVIDIA `deepseek-v4.1-flash`, `glm-5.3-flash`, `gemma-4-31b-it`, `laguna-xs-2.1` | timeouts or 44 s answers |
| NVIDIA `kimi-k3`, `deepseek-v4-pro-0813`, `gpt-oss-120b`, Ollama `glm-5.1`, `qwen3.5:397b`, `deepseek-v4-flash` | retired (410) |
| NVIDIA `kimi-k2.6`, `nemotron-3-super`, `mistral-large-2`, `codestral-22b`; Ollama DeepSeek/Kimi/GLM 5.x | not enabled for the account (404) or paid-only (402) |
| Groq `qwen3.6-27b`, `groq/compound` | 404 |
| Pollinations, OpenCode Zen, Kilo (keyless attempts) | 401 / auth expired |

Active members today: `free-fast` = Groq gpt-oss-20b, Groq qwen3.8-27b, LLM7 DeepSeek-V4-Flash, Ollama gemma4:31b, Ollama nemotron-3-super,
OpenRouter minimax-m3.1-flash:free. `free-coding` = Groq gpt-oss-120b, Mistral codestral, LLM7 DeepSeek-V4-Flash, NVIDIA nemotron-3-ultra,
Ollama nemotron-3-super, OpenRouter nemotron-3-ultra / north-mini-code / laguna-s-2.1 (:free), Groq qwen3.8-27b, Ollama gemma4:31b.

## Cloudflare Workers AI (verified 2026-10-24)
After replacing the credentials with a Workers-AI-scoped token (see docs/GET-KEYS.md), `node ar.mjs omniroute` discovered and verified these models with real requests; they are in both pool combos:
`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, `@cf/zai-org/glm-4.7-flash`, `@cf/google/gemma-4-26b-a4b-it`, `@cf/qwen/qwen2.5-coder-32b-instruct`.
Published free allowance: about 10,000 "neurons" per day shared by all models (from OmniRoute's documentation, not measured by us). Going over fails the request rather than billing.
