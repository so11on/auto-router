"""Anthropic Messages <-> OpenAI Chat Completions translation, stdlib only.

Lets the gateway answer a Claude Code request (Anthropic format: system blocks, tool_use / tool_result blocks, SSE events
message_start … message_stop) with a model that speaks the OpenAI format (Gemini's OpenAI endpoint, OpenAI, OpenRouter, Ollama).
Anthropic does not support Claude Code on non-Claude models; this is ours to keep working (docs/DECISIONS.md, 2026-11-02).

Not translated (dropped): thinking / redacted_thinking blocks (signatures are Anthropic's), server tools (web search, code execution:
tools with a `type` other than "custom"), cache_control markers, documents other than plain text.
"""
import json
import time
import uuid

# Gemini 3 requires the thought signature it returned with a function call to come back with that call on the next turn.
# Calls it never produced (Claude's, or ours after a restart) get Google's documented placeholder that skips the check.
SKIP_SIGNATURE = "skip_thought_signature_validator"
_signatures: dict = {}  # tool_call_id -> signature (in memory; bounded below)
_SIG_MAX = 5000

# JSON-Schema keys Gemini's function declarations accept (OpenAPI subset). Anything else is dropped so a tool is never rejected.
_SCHEMA_KEYS = {"type", "format", "description", "nullable", "enum", "items", "properties", "required", "minItems", "maxItems",
                "minimum", "maximum", "minLength", "maxLength", "pattern", "anyOf", "default", "title", "minProperties", "maxProperties"}


def clean_schema(s, strict=True):
    """Reduce a JSON Schema to what OpenAI-format providers accept. `strict` = Gemini's subset; else only `$schema` is removed."""
    if isinstance(s, list):
        return [clean_schema(x, strict) for x in s]
    if not isinstance(s, dict):
        return s
    out = {}
    for k, v in s.items():
        if k == "$schema" or (strict and k not in _SCHEMA_KEYS):
            continue
        if k == "type" and isinstance(v, list):  # ["string", "null"] -> "string" + nullable
            kinds = [t for t in v if t != "null"]
            v = kinds[0] if kinds else "string"
            if len(kinds) < len(s["type"]):
                out["nullable"] = True
        if k == "properties" and isinstance(v, dict):
            out[k] = {name: clean_schema(sub, strict) for name, sub in v.items()}
        elif k in ("items", "anyOf"):
            out[k] = clean_schema(v, strict)
        else:
            out[k] = v
    if strict and out.get("type") == "object" and "properties" not in out:
        out["properties"] = {}
    return out


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    parts = []
    for b in content or []:
        if isinstance(b, dict) and b.get("type") == "text":
            parts.append(b.get("text", ""))
        elif isinstance(b, dict) and b.get("type") == "image":
            parts.append("[image]")
    return "\n".join(parts)


def _user_parts(blocks):
    parts = []
    for b in blocks:
        t = b.get("type")
        if t == "text":
            parts.append({"type": "text", "text": b.get("text", "")})
        elif t == "image":
            src = b.get("source") or {}
            if src.get("type") == "base64":
                parts.append({"type": "image_url", "image_url": {"url": f"data:{src.get('media_type')};base64,{src.get('data')}"}})
            elif src.get("type") == "url":
                parts.append({"type": "image_url", "image_url": {"url": src.get("url")}})
        elif t == "document":
            src = b.get("source") or {}
            if src.get("type") == "text":
                parts.append({"type": "text", "text": src.get("data", "")})
    return parts


def to_openai(req: dict, model: str, gemini: bool = True) -> dict:
    """Anthropic Messages request -> OpenAI Chat Completions request for `model`."""
    msgs = []
    system = req.get("system")
    if system:
        msgs.append({"role": "system", "content": _text_of(system)})
    for m in req.get("messages") or []:
        role, content = m.get("role"), m.get("content")
        if isinstance(content, str):
            msgs.append({"role": role, "content": content})
            continue
        blocks = [b for b in content or [] if isinstance(b, dict)]
        if role == "assistant":
            text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
            calls = []
            for b in blocks:
                if b.get("type") != "tool_use":
                    continue
                call = {"id": b.get("id"), "type": "function",
                        "function": {"name": b.get("name"), "arguments": json.dumps(b.get("input") or {}, ensure_ascii=False)}}
                if gemini:
                    call["extra_content"] = {"google": {"thought_signature": _signatures.get(b.get("id"), SKIP_SIGNATURE)}}
                calls.append(call)
            out = {"role": "assistant", "content": text or None}
            if calls:
                out["tool_calls"] = calls
            if text or calls:
                msgs.append(out)
            continue
        # user turn: tool results first (they must follow the assistant's tool calls), then the rest as one user message
        for b in blocks:
            if b.get("type") == "tool_result":
                body = _text_of(b.get("content"))
                if b.get("is_error"):
                    body = "ERROR: " + body
                msgs.append({"role": "tool", "tool_call_id": b.get("tool_use_id"), "content": body or "(empty)"})
        parts = _user_parts([b for b in blocks if b.get("type") != "tool_result"])
        if parts:
            only_text = all(p["type"] == "text" for p in parts)
            msgs.append({"role": "user", "content": "\n".join(p["text"] for p in parts) if only_text else parts})
    out = {"model": model, "messages": msgs}
    tools = [t for t in req.get("tools") or [] if t.get("type") in (None, "custom") and t.get("name")]
    if tools:
        out["tools"] = [{"type": "function", "function": {"name": t["name"], "description": (t.get("description") or "")[:4000],
                                                          "parameters": clean_schema(t.get("input_schema") or {"type": "object"}, gemini)}}
                        for t in tools]
        tc = req.get("tool_choice") or {}
        kind = tc.get("type")
        if kind == "any":
            out["tool_choice"] = "required"
        elif kind == "tool" and tc.get("name"):
            out["tool_choice"] = {"type": "function", "function": {"name": tc["name"]}}
        elif kind == "none":
            out["tool_choice"] = "none"
    if req.get("max_tokens"):
        out["max_tokens"] = req["max_tokens"]
    for k in ("temperature", "top_p"):
        if req.get(k) is not None:
            out[k] = req[k]
    if req.get("stop_sequences"):
        out["stop"] = req["stop_sequences"][:4]
    if req.get("stream"):
        out["stream"] = True
        out["stream_options"] = {"include_usage": True}
    return out


_STOP = {"stop": "end_turn", "length": "max_tokens", "tool_calls": "tool_use", "function_call": "tool_use", "content_filter": "refusal"}


def _remember(call_id, call):
    sig = ((call.get("extra_content") or {}).get("google") or {}).get("thought_signature")
    if sig and call_id:
        if len(_signatures) >= _SIG_MAX:
            _signatures.pop(next(iter(_signatures)))
        _signatures[call_id] = sig


def _sse(event: str, data: dict) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()


class StreamTranslator:
    """Feed OpenAI SSE lines (bytes, without the trailing newline); get Anthropic SSE event bytes back."""

    def __init__(self, model_label: str):
        self.model = model_label
        self.started = False
        self.block = None          # ("text", index) | ("tool", index, openai_tool_index)
        self.index = -1
        self.tools = {}            # openai tool index -> anthropic block index
        self.stop = None
        self.usage = {"input_tokens": 0, "output_tokens": 0}

    def _start(self):
        self.started = True
        msg = {"id": "msg_" + uuid.uuid4().hex[:24], "type": "message", "role": "assistant", "model": self.model, "content": [],
               "stop_reason": None, "stop_sequence": None, "usage": dict(self.usage)}
        return _sse("message_start", {"type": "message_start", "message": msg})

    def _close_block(self):
        if self.block is None:
            return b""
        out = _sse("content_block_stop", {"type": "content_block_stop", "index": self.block[1]})
        self.block = None
        return out

    def feed(self, line: bytes) -> bytes:
        line = line.strip()
        if not line.startswith(b"data:"):
            return b""
        payload = line[5:].strip()
        if payload == b"[DONE]":
            return b""
        try:
            chunk = json.loads(payload)
        except ValueError:
            return b""
        out = b"" if self.started else self._start()
        u = chunk.get("usage")
        if u:
            self.usage = {"input_tokens": u.get("prompt_tokens") or 0, "output_tokens": u.get("completion_tokens") or 0}
        for ch in chunk.get("choices") or []:
            d = ch.get("delta") or {}
            if d.get("content"):
                if not self.block or self.block[0] != "text":
                    out += self._close_block()
                    self.index += 1
                    self.block = ("text", self.index)
                    out += _sse("content_block_start", {"type": "content_block_start", "index": self.index,
                                                        "content_block": {"type": "text", "text": ""}})
                out += _sse("content_block_delta", {"type": "content_block_delta", "index": self.index,
                                                    "delta": {"type": "text_delta", "text": d["content"]}})
            for tc in d.get("tool_calls") or []:
                ti = tc.get("index", 0)
                fn = tc.get("function") or {}
                if ti not in self.tools:
                    out += self._close_block()
                    self.index += 1
                    self.tools[ti] = self.index
                    call_id = tc.get("id") or ("toolu_" + uuid.uuid4().hex[:24])
                    _remember(call_id, tc)
                    self.block = ("tool", self.index, ti)
                    out += _sse("content_block_start", {"type": "content_block_start", "index": self.index,
                                                        "content_block": {"type": "tool_use", "id": call_id, "name": fn.get("name"), "input": {}}})
                if fn.get("arguments"):
                    out += _sse("content_block_delta", {"type": "content_block_delta", "index": self.tools[ti],
                                                        "delta": {"type": "input_json_delta", "partial_json": fn["arguments"]}})
            if ch.get("finish_reason"):
                self.stop = _STOP.get(ch["finish_reason"], "end_turn")
        return out

    def finish(self) -> bytes:
        out = b"" if self.started else self._start()
        out += self._close_block()
        stop = self.stop or "end_turn"
        if self.tools and stop == "end_turn":
            stop = "tool_use"
        out += _sse("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None},
                                      "usage": {"output_tokens": self.usage["output_tokens"], "input_tokens": self.usage["input_tokens"]}})
        out += _sse("message_stop", {"type": "message_stop"})
        return out


def to_anthropic(resp: dict, model_label: str) -> dict:
    """Non-streaming OpenAI response -> Anthropic message."""
    ch = (resp.get("choices") or [{}])[0]
    m = ch.get("message") or {}
    content = []
    if m.get("content"):
        content.append({"type": "text", "text": m["content"]})
    for tc in m.get("tool_calls") or []:
        fn = tc.get("function") or {}
        call_id = tc.get("id") or ("toolu_" + uuid.uuid4().hex[:24])
        _remember(call_id, tc)
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except ValueError:
            args = {}
        content.append({"type": "tool_use", "id": call_id, "name": fn.get("name"), "input": args})
    stop = _STOP.get(ch.get("finish_reason"), "end_turn")
    if any(b["type"] == "tool_use" for b in content):
        stop = "tool_use"
    u = resp.get("usage") or {}
    return {"id": "msg_" + uuid.uuid4().hex[:24], "type": "message", "role": "assistant", "model": model_label, "content": content,
            "stop_reason": stop, "stop_sequence": None,
            "usage": {"input_tokens": u.get("prompt_tokens") or 0, "output_tokens": u.get("completion_tokens") or 0}}


def error_body(status: int, message: str) -> dict:
    kind = {400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error",
            429: "rate_limit_error", 529: "overloaded_error"}.get(status, "api_error")
    return {"type": "error", "error": {"type": kind, "message": message}, "ts": int(time.time())}
