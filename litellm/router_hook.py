"""LiteLLM hook for auto-router: resolves auto-free / auto-balanced / auto-smart.

Pre-call: classifies new user turns and, inside agent tasks, re-evaluates at checkpoints
(policy.py: up on failure signals or harder steps, down with hysteresis), then adjusts for quota
(quota.py) and context window (context.py, registry.py), compacts the history when it would not fit,
keeps a session memory file in the project (written by claude-bridge) and publishes
data/context-state.json for the VS Code companion (status bar, automatic new chat).

Streaming: if a model dies after it already produced text, LiteLLM cannot recover (it only falls
back before the first token). `async_post_call_streaming_iterator_hook` continues the answer on the
next model of the fallback chain and tells the user in the output.

Logging: usage rows (data/usage.jsonl) and operational events (data/router.jsonl).
"""
import copy
import hashlib
import json
import os
import re
import time
import uuid

import asyncio

import litellm
import yaml
from litellm.integrations.custom_logger import CustomLogger

import context as ctxmod
import dlp
import policy
import pool
import registry
import safety
from quota import Tracker

try:  # inside the proxy; a plain stand-in elsewhere (tests)
    from fastapi import HTTPException
except Exception:  # pragma: no cover
    class HTTPException(Exception):
        def __init__(self, status_code: int = 500, detail=""):
            super().__init__(str(detail))
            self.status_code, self.detail = status_code, detail

ROUTING_FILE = os.environ.get("ROUTING_FILE", "/app/routing.yaml")
CLASSIFIER_MODEL = os.environ.get("CLASSIFIER_MODEL", "gemini/gemini-3.5-flash-lite")
STICKY_TTL = 60 * 60
FREE_POOL_ENABLED = os.environ.get("FREE_POOL_ENABLED", "false").lower() == "true"  # needs provider keys in OmniRoute
CLAUDE_PRIMARY = os.environ.get("CLAUDE_PRIMARY", "cli")  # cli = Claude Code bridge, api = Anthropic API
OPENAI_PRIMARY = os.environ.get("OPENAI_PRIMARY", "cli")  # cli = Codex CLI with a ChatGPT login (via the bridge), api = OpenAI API key
USAGE_FILE = os.environ.get("USAGE_FILE", "/app/data/usage.jsonl")
EVENT_FILE = os.environ.get("EVENT_LOG", "/app/data/router.jsonl")
MAX_LOG_BYTES = 10_000_000
MAX_CONTINUATIONS = 3
FREE_FALLBACK_MODEL = "gemini-free-flash-lite"
# last resorts after the profile ladder; each is still filtered by safety / sensitivity / profile per request
FALLBACK_TAIL = {"free": ["gemini-free-flash-lite"], "balanced": ["gemini-flash"], "smart": ["gemini-pro"]}
CLASSIFIER_MAX_CHARS = int(os.environ.get("CLASSIFIER_MAX_CHARS", "4000"))
SHOW_FOOTER = os.environ.get("AUTO_ROUTER_FOOTER", "true").lower() == "true"
DATA_DIR = os.path.dirname(USAGE_FILE)
STATE_FILE = os.path.join(DATA_DIR, "context-state.json")
BRIDGE_URL = os.environ.get("BRIDGE_URL", "http://host.docker.internal:4100")
BRIDGE_KEY = os.environ.get("BRIDGE_KEY", "")
DEFAULT_CONTEXT = {"client_budget": 100000, "output_reserve": 8000, "memory_at": 0.60, "new_chat_at": 0.85,
                   "compact_at": 0.90, "keep_user_turns": 2, "memory_every_messages": 12}
CHECKPOINT_PROMPT = (
    "You are judging an AI coding agent in the middle of a task. Given the original request and the latest steps, "
    "classify the NEXT steps. " + 'Reply with JSON only: {"task": one of explain|codegen|debug|refactor|plan|research, '
    '"complexity": integer 1-5}. 1 = mechanical (apply known edits, read files); 3 = normal coding; '
    "5 = hard debugging, design decisions or repeated failures."
)
SUMMARY_PROMPT = (
    "Summarize this part of a coding conversation for another AI that will continue it. Keep: the goal, decisions and "
    "their reasons, files and functions touched, current state, unresolved problems, and the next steps. Be factual "
    "and concise (max ~600 words). If a previous summary is given, merge it with the new part."
)

VIRTUAL = {"auto-free": "free", "auto-balanced": "balanced", "auto-smart": "smart"}
TASKS = ("explain", "codegen", "debug", "refactor", "plan", "research")

CLASSIFIER_PROMPT = (
    "Classify the user's latest request for a coding assistant. "
    'Reply with JSON only: {"task": one of explain|codegen|debug|refactor|plan|research, '
    '"complexity": integer 1-5}. '
    "Complexity 1 = trivial lookup or small edit; 3 = multi-step change in one area; "
    "5 = cross-cutting design, hard debugging or large refactor."
)

_sticky: dict = {}  # conv key -> (conversation state dict, ts)
_last_model: dict = {}
_memory_marks: dict = {}  # conv key -> message count at the last memory write
_quota = Tracker(DATA_DIR, registry.spec)

HANDOFF_NOTE = (
    "Handoff: earlier turns of this conversation were answered by a different model ({prev}). "
    "Claude Code edits files itself and lists its edits in '*Claude Code ...*' blocks of the history; "
    "other models may have changed files too. The files on disk are the source of truth, so re-read a file "
    "before editing it and do not repeat work already described in the history."
)
CONTINUE_PROMPT = (
    "Your previous reply was cut off by a provider error after the text above. Continue exactly where it stopped, "
    "without repeating anything already written and without apologising. If files may have been changed, "
    "re-read them before relying on them."
)
FAILOVER_NOTICE = "\n\n> ⚠️ `{failed}` was interrupted ({reason}). Continuing with `{nxt}`.\n\n"


# ---------- logging ----------
def _append(path: str, row: dict) -> None:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if os.path.exists(path) and os.path.getsize(path) > MAX_LOG_BYTES:
            os.replace(path, path + ".1")
        with open(path, "a") as f:
            f.write(json.dumps(row, default=str) + "\n")
    except Exception:
        pass  # logging must never break a request


def _event(kind: str, **fields) -> None:
    _append(EVENT_FILE, {"ts": time.time(), "type": kind, **fields})


def _write_usage(kwargs: dict, response_obj, status: str) -> None:
    slo = kwargs.get("standard_logging_object") or {}
    meta = (kwargs.get("litellm_params") or {}).get("metadata") or {}
    usage = getattr(response_obj, "usage", None)
    prompt = slo.get("prompt_tokens") or getattr(usage, "prompt_tokens", 0) or 0
    completion = slo.get("completion_tokens") or getattr(usage, "completion_tokens", 0) or 0
    route = meta.get("auto_router") or {}
    _append(USAGE_FILE, {
        "ts": time.time(),
        "status": status,
        "model_group": "classifier" if meta.get("classifier") else (slo.get("model_group") or meta.get("model_group") or kwargs.get("model")),
        "model": slo.get("model") or kwargs.get("model"),
        "mode": route.get("mode"),
        "task": route.get("task"),
        "complexity": route.get("complexity"),
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": slo.get("total_tokens") or (prompt + completion),
        "cost_usd": slo.get("response_cost") or 0,
    })


def _log_call(kwargs: dict, status: str, start_time, end_time) -> None:
    try:
        slo = kwargs.get("standard_logging_object") or {}
        meta = (kwargs.get("litellm_params") or {}).get("metadata") or {}
        route = meta.get("auto_router") or {}
        try:
            ms = int((end_time - start_time).total_seconds() * 1000)
        except Exception:
            ms = None
        err = None
        if status != "ok":
            err = str(kwargs.get("exception") or slo.get("error_str") or "")[:300]
        _event("call", status=status, rid=route.get("rid"),
               model_group="classifier" if meta.get("classifier") else (slo.get("model_group") or kwargs.get("model")),
               deployment=slo.get("model") or kwargs.get("model"), latency_ms=ms, error=err)
    except Exception:
        pass


# ---------- helpers ----------
def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def _as_messages(data: dict) -> list:
    """Chat/Anthropic bodies carry `messages`; the Responses API carries `input`."""
    if data.get("messages"):
        return data["messages"]
    inp = data.get("input")
    if isinstance(inp, str):
        return [{"role": "user", "content": inp}]
    out = []
    for item in inp or []:
        if not isinstance(item, dict):
            continue
        role = item.get("role") or ("tool" if item.get("type") == "function_call_output" else "assistant")
        out.append({"role": role, "content": item.get("content", item.get("output", ""))})
    return out


THINKING_BUDGET = {"low": 2000, "medium": 8000, "high": 24000}


def _apply_effort(data: dict, call_type: str, model: str, effort: str) -> None:
    if call_type in ("responses", "aresponses"):
        data["reasoning"] = {"effort": effort}
    elif call_type in ("anthropic_messages", "aanthropic_messages"):
        if model.startswith("claude") and model.endswith("-api"):
            data["thinking"] = {"type": "enabled", "budget_tokens": THINKING_BUDGET[effort]}
            data["max_tokens"] = max(data.get("max_tokens", 0), THINKING_BUDGET[effort] + 4096)
    else:
        data["reasoning_effort"] = effort


def _add_handoff_note(data: dict, note: str) -> None:
    if data.get("messages"):
        data["messages"] = [{"role": "system", "content": note}] + list(data["messages"])
    elif "input" in data:
        data["instructions"] = f"{data.get('instructions') or ''}\n\n{note}".strip()


def _load_routing() -> dict:
    with open(ROUTING_FILE) as f:
        return yaml.safe_load(f)


def _heuristic(text: str) -> dict:
    t = text.lower()
    task = "explain"
    for name, words in (
        ("debug", ("bug", "error", "traceback", "fails", "erro", "falha")),
        ("refactor", ("refactor", "refator", "rename", "cleanup")),
        ("plan", ("plan", "design", "architecture", "planej", "arquitetura")),
        ("codegen", ("implement", "create", "add ", "write", "crie", "implemente")),
    ):
        if any(w in t for w in words):
            task = name
            break
    complexity = 1 if len(text) < 200 else 2 if len(text) < 800 else 3
    return {"task": task, "complexity": complexity, "source": "heuristic"}


def _classifier_privacy() -> str:
    """Privacy class of the model CLASSIFIER_MODEL points at (unknown strings are unsafe)."""
    cm = CLASSIFIER_MODEL
    if cm == "pool":
        return safety.privacy_of("free-pool-fast")
    if cm.startswith("gemini/") and os.environ.get("GEMINI_API_KEY"):
        return safety.privacy_of("gemini-flash-lite")  # paid key: trusted
    if cm.startswith(("groq/", "cloudflare/")):
        return "no_retention"
    return "unsafe"


def _internal_route(mode: str, s: dict, sensitive: bool):
    """Where classifier / checkpoint / summary calls may go: 'pool', 'paid' or None (then: heuristic / no LLM summary).
    auto-free never uses a paid key. Every route must pass SAFETY_MODE and, for sensitive text, the sensitive-class check."""
    def ok(privacy: str) -> bool:
        if s["safety_mode"] == "on" and privacy == "unsafe":
            return False
        return not sensitive or (privacy in s["sensitive_allowed"] and privacy not in safety.NEVER_SENSITIVE)
    pool_ok = FREE_POOL_ENABLED and not _pool_open("free-pool-fast") and ok(safety.privacy_of("free-pool-fast"))
    if mode == "free" or CLASSIFIER_MODEL == "pool":
        return "pool" if pool_ok else None
    return "paid" if ok(_classifier_privacy()) else (("pool" if pool_ok else None))


async def _llm_json(route, system: str, text: str, max_tokens: int):
    """Small helper call used by the classifier and the summarizer. `route` comes from _internal_route()."""
    if route is None:
        raise RuntimeError("no model allowed for internal calls")  # callers fall back to the heuristic
    msgs = [{"role": "system", "content": system}, {"role": "user", "content": text}]
    if route == "pool":
        from litellm.proxy import proxy_server
        router = getattr(proxy_server, "llm_router", None)
        if router is None:
            raise RuntimeError("router not ready")
        return await router.acompletion(model="free-pool-fast", messages=msgs, max_tokens=max(max_tokens, 400),
                                        temperature=0, timeout=15, metadata={"classifier": True})
    return await litellm.acompletion(model=CLASSIFIER_MODEL, messages=msgs, max_tokens=max_tokens, temperature=0,
                                     timeout=15, metadata={"classifier": True})


async def _classify(text: str, mode: str = "balanced", checkpoint: bool = False, s: dict = None, sensitive: bool = False) -> dict:
    s = s or safety.settings()
    try:
        r = await _llm_json(_internal_route(mode, s, sensitive), CHECKPOINT_PROMPT if checkpoint else CLASSIFIER_PROMPT,
                            text[:CLASSIFIER_MAX_CHARS], 60)
        raw = r.choices[0].message.content or ""
        out = json.loads(raw[raw.find("{"):raw.rfind("}") + 1])
        task = out.get("task") if out.get("task") in TASKS else "explain"
        complexity = max(1, min(5, int(out.get("complexity", 3))))
        return {"task": task, "complexity": complexity, "source": "checkpoint" if checkpoint else "llm"}
    except Exception:
        return _heuristic(text)


def _checkpoint_text(messages: list, first_user: str) -> str:
    recent = ctxmod.transcript(messages[-8:], limit_chars=4000)
    return f"Original request:\n{_request_text(first_user)[:1500]}\n\nLatest steps:\n{recent}"


async def _summarize(mode: str, text: str, previous, s: dict = None, sensitive: bool = False):
    s = s or safety.settings()
    prompt = (f"Previous summary:\n{previous}\n\nNew part of the conversation:\n{text}" if previous else text)
    try:
        r = await _llm_json(_internal_route(mode, s, sensitive), SUMMARY_PROMPT, prompt[:60000], 1200)
        return (r.choices[0].message.content or "").strip() or (previous or "")
    except Exception:
        return previous or "(summary unavailable)"


# ---------- streaming continuation ----------
def _chunk_delta(chunk):
    try:
        return chunk.choices[0].delta
    except Exception:
        return None


def _fallback_chain(router, model: str, request_data: dict = None) -> list:
    """Fallback model groups for `model`, in order. The per-request chain computed by the router hook (already filtered by
    safety, sensitivity and profile) wins over the static list in config.yaml; a static list is filtered here as well."""
    meta = ((request_data or {}).get("metadata") or {}).get("auto_router") or {}
    fb = meta.get("fallbacks")
    if fb is not None:
        if model == meta.get("model"):
            return list(fb)
        return list(fb[fb.index(model) + 1:]) if model in fb else []
    chain = []
    for entry in getattr(router, "fallbacks", None) or []:
        if isinstance(entry, dict) and model in entry:
            chain.extend(entry[model])
    s = safety.settings()
    sensitive = bool(meta.get("sensitive"))
    return [m for m in chain if _model_allowed(m, s, sensitive, meta.get("mode"))]


def _short_reason(err: Exception) -> str:
    text = str(err).replace("\n", " ")
    for needle, label in (("429", "rate limit"), ("limit", "usage limit"), ("quota", "quota"),
                          ("timeout", "timeout"), ("connection", "connection lost"), ("503", "provider overloaded")):
        if needle in text.lower():
            return label
    return type(err).__name__


# ---------- pins: "!opus", "model:opus", "usando o opus" ----------
FREE_PREFIXES = ("free-pool", "gemini-free", "pool-")


def _is_free_model(name: str) -> bool:
    return name.startswith(FREE_PREFIXES)


def _request_text(text: str) -> str:
    """Copilot wraps the user's own words in <userRequest>; look only there when present."""
    m = re.search(r"<userRequest>(.*?)</userRequest>", text, re.DOTALL)
    return m.group(1) if m else text


def _find_pin(text: str, pins: dict):
    """Return (alias, spec, matched_text) if the message pins a model, else None."""
    if not pins:
        return None
    body = _request_text(text)
    names = "|".join(re.escape(n) for n in sorted(pins, key=len, reverse=True))
    m = re.search(rf"(?<![\w`/])(?:!|model:)({names})\b", body, re.IGNORECASE)
    if m:
        return m.group(1).lower(), pins[m.group(1).lower()], m.group(0)
    natural = "|".join(re.escape(n) for n, spec in pins.items() if spec.get("natural"))
    if natural:
        pat = rf"\b(?:usando|utilizando|use|using|com|with)\s+(?:o\s+|a\s+|the\s+)?({natural})\b"
        head, tail = body[:160], body[-160:]
        for chunk in (head, tail):
            m = re.search(pat, chunk, re.IGNORECASE)
            if m:
                return m.group(1).lower(), pins[m.group(1).lower()], None  # natural phrase stays in the text
    return None


def _remove_text(content, snippet: str):
    if isinstance(content, str):
        return re.sub(r"\s*" + re.escape(snippet) + r"\s*", " ", content, count=1).strip()
    if isinstance(content, list):
        return [{**p, "text": _remove_text(p["text"], snippet)} if isinstance(p, dict) and isinstance(p.get("text"), str) else p for p in content]
    return content


# ---------- visible footer: which model answered ----------
FOOTER_RE = re.compile(r"\n\n---\n\*auto-router · .*?\*\s*$", re.DOTALL)


def _strip_footer(messages: list) -> list:
    """Footers are for the human; keep them out of the history sent to models so they do not imitate or echo them."""
    out = []
    for m in messages:
        if m.get("role") == "assistant" and isinstance(m.get("content"), str) and "auto-router · " in m["content"]:
            m = {**m, "content": FOOTER_RE.sub("", m["content"])}
        out.append(m)
    return out


def _footer(request_data: dict, served_by: str, failed_over: list) -> str:
    route = (request_data.get("metadata") or {}).get("auto_router") or {}
    secs = time.time() - route.get("t0", time.time())
    parts = [f"auto-router", f"{route.get('requested', '?')} → {route.get('model', request_data.get('model'))}"]
    if served_by and served_by != route.get("model"):
        parts.append(served_by)
    if route.get("pinned"):
        alias = route["pinned"]
        parts.append(f"pinned: {alias}")
        if alias != "free" and served_by and alias not in str(served_by).lower():
            parts.append(f"⚠ pinned model unavailable, answered by {served_by}")
    else:
        if route.get("pin_note"):
            parts.append(route["pin_note"])
        parts.append(f"{route.get('task')} c{route.get('complexity')}" + (f" {route.get('effort')}" if route.get("effort") else ""))
    if route.get("sensitive"):
        kinds = (route.get("dlp") or {}).get("kinds") or {}
        parts.append("🔒 sensível" + (f" ({', '.join(sorted(kinds))})" if kinds else "") + ": só modelos permitidos")
    if route.get("switch"):
        parts.append(f"switched: {route['switch']}")
    if route.get("ctx_pct") is not None:
        parts.append(f"ctx {route['ctx_pct']:.0f}%" + (" (compacted)" if route.get("compacted") else ""))
    q = route.get("quota_info") or {}
    if q.get("state") in ("warn", "critical", "exhausted"):
        extra = f" {q.get('window')}" if q.get("window") else ""
        if q.get("utilization") is not None:
            extra += f" {round(100 * q['utilization'])}%"
        if q.get("eta_min") is not None:
            extra += f", ~{q['eta_min']:.0f} min left"
        parts.append(f"⚠ quota {q['state']}{extra}")
    if failed_over:
        parts.append("continued on " + " → ".join(failed_over))
    parts.append(f"{secs:.1f}s")
    return "\n\n---\n*" + " · ".join(parts) + "*"


def _served_by(chunk, previous=None):
    """Best available name of what really answered: OmniRoute headers (provider/model) if LiteLLM kept them, else the chunk's model."""
    try:
        h = (getattr(chunk, "_hidden_params", None) or {}).get("additional_headers") or {}
        prov = h.get("llm_provider-x-omniroute-provider") or h.get("x-omniroute-provider")
        model = h.get("llm_provider-x-omniroute-model") or h.get("x-omniroute-model")
        if model:
            return f"{prov}/{model.split('/')[-1]}" if prov else model
    except Exception:
        pass
    return getattr(chunk, "model", None) or previous


def _footer_chunk(template, text: str):
    chunk = copy.deepcopy(template)
    d = _chunk_delta(chunk)
    if d is not None:
        d.content = text
        d.tool_calls = None
        try:
            chunk.choices[0].finish_reason = None
        except Exception:
            pass
    return chunk


def _wants_footer(request_data: dict) -> bool:
    return SHOW_FOOTER and bool((request_data.get("metadata") or {}).get("auto_router"))


# ---------- what a model may receive ----------
def _model_allowed(name: str, s: dict, sensitive: bool, mode: str = None) -> bool:
    """SAFETY_MODE, sensitive-content classes and (for auto-free) the free-only rule, on the name the gateway will really call."""
    if not safety.allowed_by_safety(name, s):
        return False
    if sensitive and not safety.allowed_for_sensitive(name, s):
        return False
    if mode == "free" and not _is_free_model(name):
        return False
    return True


def _blocked_message(sensitive: bool, kinds: dict, mode: str) -> str:
    if sensitive:
        what = ", ".join(sorted(kinds)) or "dados sensíveis"
        return (f"Conteúdo sensível detectado ({what}). Nenhum modelo permitido para este perfil. "
                "Use Auto: Balanced/Smart, remova os dados, ou ajuste SENSITIVE_ALLOWED_CLASSES.")
    return ("Nenhum modelo disponível para este perfil com o modo de segurança ligado. "
            "Rode `node ar.mjs omniroute` (pool gratuito seguro), use Auto: Balanced/Smart, ou `node ar.mjs safety off`.")


# ---------- quota, context state, memory ----------
def _resolve(name: str) -> str:
    if name.startswith("claude-") and not name.endswith(("-cli", "-api")):
        name = f"{name}-{CLAUDE_PRIMARY}"
    if name.startswith("gpt-") and not name.endswith(("-cli", "-api")):
        name = f"{name}-{OPENAI_PRIMARY}"
    if name.startswith("free-pool") and not FREE_POOL_ENABLED:
        name = FREE_FALLBACK_MODEL
    return name


def _configured(name: str) -> bool:
    """Is this model group actually defined in the running gateway? (falls back to the registry in tests)"""
    try:
        from litellm.proxy import proxy_server
        router = getattr(proxy_server, "llm_router", None)
        if router is not None and hasattr(router, "model_names"):
            return name in router.model_names
    except Exception:
        pass
    return name in registry.names()


_breaker = pool.Breaker()
POOL_DOWN_MESSAGE = "O pool gratuito está indisponível. Tente de novo em alguns minutos ou use Auto: Balanced."


def _pool_open(name: str) -> bool:
    return pool.Breaker.covers(name) and _breaker.is_open()


def _track_quota(kwargs: dict, response_obj, ok: bool) -> None:
    try:
        slo = kwargs.get("standard_logging_object") or {}
        meta = (kwargs.get("litellm_params") or {}).get("metadata") or {}
        if meta.get("classifier"):
            return
        group = slo.get("model_group") or meta.get("model_group") or kwargs.get("model")
        err = str(kwargs.get("exception") or slo.get("error_str") or "")
        _quota.record_call(group, slo.get("total_tokens") or 0, ok, err)
        if pool.Breaker.covers(group):
            _breaker.record(ok, err)
    except Exception:
        pass


def _write_quota_report() -> None:
    """Snapshot of every known model's quota state for `node ar.mjs usage` (cheap: in-memory counters)."""
    try:
        out = {m: _quota.status(m) for m in registry.names()}
        for m in out:
            if _pool_open(m):
                out[m] = {**out[m], "state": "exhausted", "pool": _breaker.status()}
        tmp = os.path.join(DATA_DIR, "quota-report.json.tmp")
        with open(tmp, "w") as f:
            json.dump({"updated": time.time(), "models": out}, f, default=str)
        os.replace(tmp, os.path.join(DATA_DIR, "quota-report.json"))
    except Exception:
        pass


def _write_state(row: dict) -> None:
    try:
        tmp = STATE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(row, f, default=str)
        os.replace(tmp, STATE_FILE)  # atomic for the VS Code watcher
    except Exception:
        pass


async def _post_bridge(path: str, payload: dict):
    import httpx
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(f"{BRIDGE_URL}{path}", json=payload, headers={"Authorization": f"Bearer {BRIDGE_KEY}"})
        r.raise_for_status()
        return r.json()


def _memory_markdown(key: str, mode: str, summary: str, messages: list, state_row: dict) -> str:
    last_user = next((_text(m.get("content")) for m in reversed(messages) if m.get("role") == "user"), "")
    files = ctxmod.touched_files(messages)
    lines = [f"# auto-router session {key[:12]}", "",
             f"- updated: {time.strftime('%Y-%m-%d %H:%M:%S')}",
             f"- profile: auto-{mode}; model now: {state_row.get('model')}; models used: {' → '.join(state_row.get('trail') or [])}",
             f"- context: {state_row.get('ctx_tokens')} tokens ({state_row.get('ctx_pct')}% of {state_row.get('ctx_window')})",
             "", "## Summary", summary.strip() or "(empty)", "", "## Files touched (from tool calls)"]
    lines += [f"- {f}" for f in files] or ["- (none recorded)"]
    lines += ["", "## Last user request", _request_text(last_user).strip()[:2000]]
    return "\n".join(lines) + "\n"


def _mask_for_memory(text: str) -> str:
    """Memory is persistent and re-injected into new chats: secrets AND personal data are masked in it whatever the request settings are."""
    box = {"prompt": text}
    res = dlp.scan_and_mask(box, {**safety.settings(), "mask_secrets": "on", "mask_pii": "on"})
    return "(memory withheld: the scanner failed)" if res.error else box["prompt"]


async def _refresh_memory(key: str, mode: str, messages: list, state_row: dict, hint: str, new_chat: bool,
                          s: dict = None, sensitive: bool = False):
    """Background task: summarize, write .auto-router/memory/<session>.md via the bridge, then publish the state."""
    try:
        s = s or safety.settings()
        cached = ctxmod._summaries.get(key)
        summary = cached["summary"] if cached else await _summarize(mode, ctxmod.transcript(messages), None, s, sensitive)
        last_user = next((_text(m.get("content")) for m in reversed(messages) if m.get("role") == "user"), "")
        res = await _post_bridge("/memory/write", {"session": key[:12], "hint": _mask_for_memory(hint[:20000]),
                                                   "title": _mask_for_memory(_request_text(last_user).strip()[:100]),
                                                   "markdown": _mask_for_memory(_memory_markdown(key, mode, summary, messages, state_row))})
        state_row.update(memory_file=res.get("path"), workspace=res.get("workspace"))
        _event("memory", session=key[:12], path=res.get("path"), ctx_pct=state_row.get("ctx_pct"))
    except Exception as e:
        _event("memory_error", session=key[:12], error=str(e)[:200])
    if new_chat:
        state_row["action"] = "new_chat"
        _event("new_chat_requested", session=key[:12], ctx_pct=state_row.get("ctx_pct"), memory=state_row.get("memory_file"))
    _write_state(state_row)


# ---------- the hook ----------
class AutoRouter(CustomLogger):
    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        _write_usage(kwargs, response_obj, "ok")
        _log_call(kwargs, "ok", start_time, end_time)
        _track_quota(kwargs, response_obj, True)

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        _write_usage(kwargs, response_obj, "error")
        _log_call(kwargs, "error", start_time, end_time)
        _track_quota(kwargs, response_obj, False)

    async def async_post_call_streaming_iterator_hook(self, user_api_key_dict, response, request_data):
        partial: list = []
        saw_tool_call = False
        served_by = None
        held: list = []  # finish chunk (+ any usage chunk after it) is held back so the footer lands before it
        t_failed = []
        try:
            async for chunk in response:
                served_by = _served_by(chunk, served_by)
                delta = _chunk_delta(chunk)
                if delta is not None:
                    if getattr(delta, "tool_calls", None):
                        saw_tool_call = True
                    if getattr(delta, "content", None):
                        partial.append(delta.content)
                finish = None
                try:
                    finish = chunk.choices[0].finish_reason
                except Exception:
                    pass
                if finish or held:
                    held.append(chunk)
                    continue
                yield chunk
            if _wants_footer(request_data) and partial and not saw_tool_call and held:
                yield _footer_chunk(held[0], _footer(request_data, served_by, t_failed))
            for c in held:
                yield c
            return
        except Exception as err:
            failure = err

        rid = ((request_data.get("metadata") or {}).get("auto_router") or {}).get("rid")
        text = "".join(partial)
        # Nothing produced yet: LiteLLM's own fallbacks already ran. Tool calls cannot be resumed safely.
        if not text or saw_tool_call or not request_data.get("messages"):
            _event("stream_error", rid=rid, model=request_data.get("model"), partial_chars=len(text),
                   resumable=False, error=str(failure)[:300])
            raise failure

        from litellm.proxy import proxy_server  # imported lazily: only exists inside the proxy process
        router = getattr(proxy_server, "llm_router", None)
        failed = request_data.get("model")
        tried = {failed}
        messages = list(request_data["messages"])
        hops = 0
        while router is not None and hops < MAX_CONTINUATIONS:
            candidates = [m for m in _fallback_chain(router, failed, request_data) if m not in tried]
            if not candidates:
                break
            nxt = candidates[0]
            tried.add(nxt)
            hops += 1
            t_failed.append(nxt)
            _event("stream_failover", rid=rid, failed=failed, to=nxt, partial_chars=len(text),
                   reason=_short_reason(failure), error=str(failure)[:300])
            cont = messages + [{"role": "assistant", "content": text},
                               {"role": "user", "content": CONTINUE_PROMPT}]
            extra = {k: request_data[k] for k in ("max_tokens", "temperature") if k in request_data}
            try:
                stream = await router.acompletion(model=nxt, messages=cont, stream=True, **extra)
                notice_sent = False
                held = []
                async for chunk in stream:
                    served_by = _served_by(chunk, served_by)
                    if not notice_sent:
                        note = copy.deepcopy(chunk)
                        d = _chunk_delta(note)
                        if d is not None:
                            d.content = FAILOVER_NOTICE.format(failed=failed, reason=_short_reason(failure), nxt=nxt)
                            if hasattr(note.choices[0], "finish_reason"):
                                note.choices[0].finish_reason = None
                            yield note
                        notice_sent = True
                    delta = _chunk_delta(chunk)
                    if delta is not None and getattr(delta, "content", None):
                        text += delta.content
                    finish = None
                    try:
                        finish = chunk.choices[0].finish_reason
                    except Exception:
                        pass
                    if finish or held:
                        held.append(chunk)
                        continue
                    yield chunk
                if _wants_footer(request_data) and held:
                    yield _footer_chunk(held[0], _footer(request_data, served_by, t_failed))
                for c in held:
                    yield c
                return
            except Exception as err2:
                failure, failed = err2, nxt
        _event("stream_error", rid=rid, model=request_data.get("model"), partial_chars=len(text),
               resumable=False, error=f"no continuation available: {str(failure)[:250]}")
        raise failure

    async def async_post_call_success_hook(self, data, user_api_key_dict, response):
        """Non-streaming answers get the same footer."""
        try:
            if _wants_footer(data):
                msg = response.choices[0].message
                if msg.content and not getattr(msg, "tool_calls", None):
                    msg.content += _footer(data, _served_by(response), [])
        except Exception:
            pass
        return response

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        mode = VIRTUAL.get(data.get("model", ""))
        if not mode:
            return data

        rid = uuid.uuid4().hex[:8]
        t0 = time.time()
        if data.get("messages"):
            data["messages"] = _strip_footer(data["messages"])
        s = safety.settings()
        # conversation key from the ORIGINAL text, so it stays stable across turns whatever the masking does
        messages = _as_messages(data)
        first_user = next((_text(m.get("content")) for m in messages if m.get("role") == "user"), "")
        first_system = next((_text(m.get("content")) for m in messages if m.get("role") in ("system", "developer")), "")
        key = hashlib.sha1(f"{mode}:{first_system[:500]}\x00{first_user[:2000]}".encode()).hexdigest()
        # DLP runs before any model (classifier, summary, memory) sees the request
        dres = dlp.scan_and_mask(data, s) if s["sensitive_guard"] == "on" or s["mask_secrets"] == "on" else dlp.DlpResult()
        messages = _as_messages(data)
        first_user = next((_text(m.get("content")) for m in messages if m.get("role") == "user"), "")
        now = time.time()
        for k in [k for k, (_, ts) in _sticky.items() if now - ts > STICKY_TTL]:
            del _sticky[k]

        routing = _load_routing()
        cfg = {**policy.DEFAULT_SWITCHING, **(routing.get("switching") or {})}
        ccfg = {**DEFAULT_CONTEXT, **(routing.get("context") or {})}
        st = dict(_sticky.get(key, ({}, 0))[0])
        # sensitivity is sticky: once a conversation held a secret, later turns keep the restricted routing
        sensitive = bool(dres.sensitive and s["sensitive_guard"] == "on") or bool(st.get("sensitive"))
        st["sensitive"] = sensitive
        if dres.secrets or dres.pii or dres.error:
            _event("dlp", rid=rid, session=key[:12], **dres.public())
        last = messages[-1] if messages else {}
        new_user_turn = last.get("role") == "user"
        sig = policy.signals(messages)
        if new_user_turn:
            st.update(last_eval_step=0, switch_step=0, pinned=False)
        st["steps_since_switch"] = sig["steps"] - st.get("switch_step", 0)

        # ---- 1. which model (pin, sticky, or (re)classify with hysteresis) ----
        source, reason, pin_note, switched = "sticky", "", None, False
        pin = _find_pin(_text(last.get("content")), routing.get("pins", {})) if new_user_turn else None
        if pin and not _configured(_resolve(pin[1]["model"])):
            pin_note = f"ignored: {pin[0]} is not configured on this install"
            if pin[2]:
                last["content"] = _remove_text(last["content"], pin[2])
            pin = None
        if pin and not _model_allowed(_resolve(pin[1]["model"]), s, sensitive, None):
            pin_note = f"ignored: {pin[0]} is not allowed by the safety settings" + (" for sensitive content" if sensitive else "")
            if pin[2]:
                last["content"] = _remove_text(last["content"], pin[2])
            pin = None
        if pin and mode == "free" and not _is_free_model(pin[1]["model"]):
            pin_note = f"ignored: auto-free never uses paid models ({pin[0]})"
            if pin[2]:
                last["content"] = _remove_text(last["content"], pin[2])
            pin = None
        if pin:
            alias, spec, matched = pin
            if matched:  # remove the "!opus" token so the model never sees it
                last["content"] = _remove_text(last["content"], matched)
            decision = {"model": spec["model"], "effort": spec.get("effort"), "task": "pinned", "complexity": 1,
                        "pinned": alias}
            st["pinned"], source, reason = True, "pinned", f"pinned: {alias}"
            switched = bool(st.get("decision")) and st["decision"]["model"] != decision["model"]
        elif st.get("decision") and not new_user_turn and (st.get("pinned") or not policy.needs_checkpoint(st, sig, cfg)):
            decision = st["decision"]
        else:
            checkpoint = not new_user_turn
            text = _checkpoint_text(messages, first_user) if checkpoint else _text(last.get("content"))
            cls = await _classify(text, mode, checkpoint=checkpoint, s=s, sensitive=sensitive)
            source = cls.get("source", "llm")
            target = policy.pick(routing, mode, cls["task"], cls["complexity"])
            decision, reason, switched = policy.decide(routing, mode, st, target, sig, new_user_turn, cfg)
            st["last_eval_step"] = sig["steps"]

        # ---- 2. quota and context window ----
        tokens = ctxmod.count_tokens(messages, data.get("tools"))
        client_tokens = tokens  # what the editor is holding; compaction below only shrinks what the model receives
        need = tokens + ccfg["output_reserve"]
        health = lambda m: "exhausted" if _pool_open(m) else _quota.status(m)["state"]
        fits = lambda m: need <= registry.context_window(m) * ccfg["compact_at"]
        adj_reason = None
        if not decision.get("pinned"):
            before = decision["model"]
            try:
                decision, adj_reason = policy.adjust(routing, mode, decision, health, fits, _resolve,
                                                     allowed=lambda n: _model_allowed(n, s, sensitive, mode))
            except policy.Blocked:
                _event("blocked", rid=rid, mode=mode, sensitive=sensitive, kinds=dres.kinds)
                raise HTTPException(status_code=400, detail=_blocked_message(sensitive, dres.kinds, mode))
            if decision["model"] != before:
                switched = True
        if _pool_open(_resolve(decision["model"])):
            # the pool is down: never wait for its timeout and never escape to a paid / unsafe model by accident
            alt = next((n for n in FALLBACK_TAIL.get(mode, []) if _configured(n) and not _pool_open(n)
                        and _model_allowed(n, s, sensitive, mode)), None)
            if alt is None:
                _event("blocked", rid=rid, mode=mode, sensitive=sensitive, kinds=dres.kinds, pool=_breaker.status())
                raise HTTPException(status_code=503, detail=POOL_DOWN_MESSAGE)
            decision = {**decision, "model": alt}
            adj_reason, switched = "pool unhealthy", True
        model = _resolve(decision["model"])
        window = registry.context_window(model)
        compacted = False
        if need > window * ccfg["compact_at"] and data.get("messages"):
            data["messages"], _ = await ctxmod.compact(data["messages"], key, lambda t, p: _summarize(mode, t, p, s, sensitive),
                                                       ccfg["keep_user_turns"])
            tokens = ctxmod.count_tokens(data["messages"], data.get("tools"))
            compacted = True
            _event("compact", rid=rid, model=model, window=window, tokens_after=tokens)

        # ---- 3. bookkeeping: state, trail, handoff ----
        prev_model = _last_model.get(key)
        _last_model[key] = model
        trail = list(st.get("trail") or [])
        if not trail or trail[-1] != model:
            trail.append(model)
        if switched and prev_model and prev_model != model:
            st["switch_step"] = sig["steps"]
            _event("switch", rid=rid, session=key[:12], frm=prev_model, to=model, reason=adj_reason or reason,
                   step=sig["steps"], new_user_turn=new_user_turn)
        st.update(decision=decision, trail=trail[-12:])
        _sticky[key] = (st, now)
        handoff = bool(prev_model and prev_model != model)
        if handoff:
            _add_handoff_note(data, HANDOFF_NOTE.format(prev=prev_model))
        data["model"] = model
        if decision.get("effort"):
            _apply_effort(data, str(call_type), model, decision["effort"])
        # per-request fallbacks: only models this request may reach (safety, sensitivity, profile), never the static list
        chain, seen = [], {model}
        for n in [_resolve(m) for m in policy.ladder(routing, mode)] + list(FALLBACK_TAIL.get(mode, [])):
            if n not in seen and _configured(n) and not _pool_open(n) and _model_allowed(n, s, sensitive, mode):
                seen.add(n)
                chain.append(n)
        data["fallbacks"] = chain

        quota_now = _quota.status(model)
        # The chat's fullness is judged on the editor's side (its whole history vs the budget it was given), not on the
        # compacted copy: that is what decides when the conversation should move to a new chat.
        eff_window = ccfg["client_budget"]
        pct = round(100 * client_tokens / eff_window, 1) if eff_window else 0
        state_row = {"updated": time.time(), "session": key[:12], "mode": mode, "model": model, "trail": trail[-12:],
                     "ctx_tokens": client_tokens, "ctx_window": eff_window, "ctx_pct": pct, "model_tokens": tokens,
                     "model_window": window, "quota": quota_now,
                     "compacted": compacted, "action": "none"}
        data.setdefault("metadata", {})["auto_router"] = {
            "rid": rid, "t0": t0, "requested": f"auto-{mode}", "mode": mode,
            "task": decision["task"], "complexity": decision["complexity"], "model": model,
            "effort": decision.get("effort"), "pinned": decision.get("pinned"), "pin_note": pin_note,
            "ctx_pct": pct, "quota": quota_now.get("state"), "quota_info": quota_now,
            "switch": (adj_reason or reason) if handoff else None, "compacted": compacted,
            "sensitive": sensitive, "dlp": dres.public(), "fallbacks": chain,
        }

        # ---- 4. memory + new-chat signal (background, never delays the answer) ----
        n_msgs = len(messages)
        due = n_msgs - _memory_marks.get(key, -10**9) >= ccfg["memory_every_messages"]
        new_chat = pct >= 100 * ccfg["new_chat_at"]
        if (pct >= 100 * ccfg["memory_at"] and due) or (new_chat and not st.get("new_chat_sent")):
            _memory_marks[key] = n_msgs
            if new_chat:
                st["new_chat_sent"] = True
            hint = "\n".join(_text(m.get("content")) for m in messages[:3])
            try:
                asyncio.get_running_loop().create_task(
                    _refresh_memory(key, mode, list(data.get("messages") or messages), state_row, hint, new_chat, s, sensitive))
            except RuntimeError:
                _write_state(state_row)
        else:
            _write_state(state_row)
        _write_quota_report()

        _event("route", rid=rid, mode=mode, requested=f"auto-{mode}", model=model, task=decision["task"],
               complexity=decision["complexity"], effort=decision.get("effort"), source=source,
               reason=adj_reason or reason, handoff_from=prev_model if handoff else None, call_type=str(call_type),
               step=sig["steps"], ctx_tokens=client_tokens, model_tokens=tokens, ctx_pct=pct, quota=quota_now.get("state"),
               classify_ms=int((time.time() - t0) * 1000))
        print(f"[auto-router] {rid} {mode} -> {model} task={decision['task']} c={decision['complexity']} "
              f"effort={decision.get('effort')} via={source} step={sig['steps']} ctx={pct}% quota={quota_now.get('state')}")
        return data


proxy_handler_instance = AutoRouter()
