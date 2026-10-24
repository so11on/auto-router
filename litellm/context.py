"""Context control: measure how full a request is for a given model and compact the history when needed.

Compaction keeps the leading system messages and the last `keep_user_turns` user turns verbatim (a turn starts at a
user message, so assistant tool calls and their tool results are never split), replaces everything older with one
summary message, and trims oversized tool outputs in what is left. Summaries are cached per conversation and extended
incrementally, so a long chat is not re-summarized from scratch on every request.
"""
import json

try:
    import litellm  # available inside the proxy; tests run without it
except Exception:  # pragma: no cover
    litellm = None

SUMMARY_PREFIX = "Summary of the earlier part of this conversation (compacted by auto-router to fit the context window):\n"
TOOL_OUTPUT_KEEP = 4000  # characters kept from each old tool result when the recent part alone is still too big

_summaries: dict = {}  # conv key -> {"upto": int, "summary": str}


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def count_tokens(messages: list, tools=None) -> int:
    """Token estimate for the request. Uses LiteLLM's tokenizer when present, else ~4 chars per token."""
    n = None
    if litellm is not None and hasattr(litellm, "token_counter"):
        try:
            n = litellm.token_counter(model="gpt-4o", messages=messages)
        except Exception:
            n = None
    if n is None:
        chars = 0
        for m in messages:
            chars += len(_text(m.get("content")))
            if m.get("tool_calls"):
                chars += len(json.dumps(m["tool_calls"], default=str))
        n = chars // 4
    if tools:
        n += len(json.dumps(tools, default=str)) // 4
    return int(n)


def split(messages: list, keep_user_turns: int):
    """(system_prefix, older, recent) or None when there is nothing old enough to compact."""
    i = 0
    while i < len(messages) and messages[i].get("role") in ("system", "developer"):
        i += 1
    system, rest = messages[:i], messages[i:]
    user_idx = [k for k, m in enumerate(rest) if m.get("role") == "user"]
    if len(user_idx) <= keep_user_turns:
        return None
    cut = user_idx[-keep_user_turns]
    return system, rest[:cut], rest[cut:]


def transcript(messages: list, limit_chars: int = 60000) -> str:
    lines = []
    for m in messages:
        role = m.get("role")
        if role == "tool":
            lines.append(f"[tool result] {_text(m.get('content'))[:1500]}")
            continue
        text = _text(m.get("content")).strip()
        if m.get("tool_calls"):
            names = [((c.get("function") or {}).get("name") or "?") for c in m["tool_calls"] if isinstance(c, dict)]
            text = (text + f"\n[called tools: {', '.join(names)}]").strip()
        if text:
            lines.append(f"{'User' if role == 'user' else 'Assistant'}: {text[:6000]}")
    out = "\n\n".join(lines)
    if len(out) > limit_chars:  # keep the start (goal) and the end (latest state)
        half = limit_chars // 2
        out = out[:half] + "\n\n[... middle omitted ...]\n\n" + out[-half:]
    return out


def shrink_tool_outputs(messages: list, keep_last: int = 2) -> list:
    tool_idx = [k for k, m in enumerate(messages) if m.get("role") == "tool"]
    old = set(tool_idx[:-keep_last]) if keep_last else set(tool_idx)
    out = []
    for k, m in enumerate(messages):
        c = m.get("content")
        if k in old and isinstance(c, str) and len(c) > TOOL_OUTPUT_KEEP:
            m = {**m, "content": c[:TOOL_OUTPUT_KEEP] + f"\n[... {len(c) - TOOL_OUTPUT_KEEP} characters trimmed by auto-router ...]"}
        out.append(m)
    return out


async def compact(messages: list, conv_key: str, summarize, keep_user_turns: int = 2):
    """Return (new_messages, summary or None). `summarize(text, previous_summary) -> str` is injected by the caller."""
    parts = split(messages, keep_user_turns)
    if parts is None:
        return shrink_tool_outputs(messages), None
    system, older, recent = parts
    cached = _summaries.get(conv_key)
    if cached and cached["upto"] <= len(older):
        new_part = older[cached["upto"]:]
        summary = cached["summary"] if not new_part else await summarize(transcript(new_part), cached["summary"])
    else:
        summary = await summarize(transcript(older), None)
    _summaries[conv_key] = {"upto": len(older), "summary": summary}
    compacted = system + [{"role": "system", "content": SUMMARY_PREFIX + summary}] + shrink_tool_outputs(recent)
    return compacted, summary


def touched_files(messages: list) -> list:
    """File paths that appear as arguments of tool calls (for the session memory)."""
    seen = []
    for m in messages:
        for c in m.get("tool_calls") or []:
            try:
                args = json.loads((c.get("function") or {}).get("arguments") or "{}")
            except Exception:
                continue
            for k in ("filePath", "file_path", "path", "uri", "file"):
                v = args.get(k) if isinstance(args, dict) else None
                if isinstance(v, str) and v not in seen:
                    seen.append(v)
    return seen[-40:]
