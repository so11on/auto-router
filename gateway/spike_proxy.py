#!/usr/bin/env python3
"""Phase-1 spike (docs/DECISIONS.md, 2026-11-02): a minimal pass-through between Claude Code and api.anthropic.com.

Answers the go/no-go questions of the v0.6 plan before the real gateway is built:
  1. Does a claude.ai (subscription) login keep working through a local ANTHROPIC_BASE_URL? Do SSE streams, the routing-hint
     headers (x-claude-code-*) and the plan-usage headers (anthropic-ratelimit-unified-*) come through?
  2. Rewriting only the `model` field (SPIKE_REWRITE_MODEL): is the call still served by the subscription?

Stdlib only. Bodies are forwarded untouched apart from `model` when asked. The log holds header names/values from a fixed allowlist,
the model, sizes and timings: never prompt text, never authorization / cookie / api-key headers.

Usage:  python3 gateway/spike_proxy.py            # listens on 127.0.0.1:4001
        SPIKE_REWRITE_MODEL=claude-haiku-5-5 python3 gateway/spike_proxy.py
        ANTHROPIC_BASE_URL=http://127.0.0.1:4001 CLAUDE_CODE_GATEWAY_HINT_HEADERS=1 claude -p "hi"
"""
import http.client
import json
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = "api.anthropic.com"
HOST, PORT = "127.0.0.1", int(os.environ.get("SPIKE_PORT", "4001"))
REWRITE = os.environ.get("SPIKE_REWRITE_MODEL", "").strip()
LOG = os.environ.get("SPIKE_LOG", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "spike.jsonl"))
HOP = {"connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host", "content-length"}
LOG_REQ = ("x-claude-code-", "anthropic-version")
SERVED = re.compile(rb'"model"\s*:\s*"([^"]{1,80})"')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import translate_openai as tr  # noqa: E402

ALTERNATE = [m.strip() for m in os.environ.get("SPIKE_ALTERNATE", "").split(",") if m.strip()]
_turn = -1
GEMINI = os.environ.get("SPIKE_ROUTE_GEMINI", "").strip()  # e.g. gemini-3.8-flash: answer /v1/messages with Gemini


def _dotenv(name):
    """Read one key from the repo's .env without exporting the rest (and never print it)."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
    try:
        for line in open(path):
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return os.environ.get(name, "")


GEMINI_KEY = _dotenv("GEMINI_API_KEY") if GEMINI else ""
LOG_RESP = ("anthropic-ratelimit-unified-", "retry-after", "x-should-retry", "request-id", "content-type")


def _log(rec):
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a") as f:
        f.write(json.dumps(rec) + "\n")


def _pick(headers, prefixes):
    return {k.lower(): v for k, v in headers.items() if k.lower().startswith(prefixes)}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # silence the default stderr access log
        pass

    def _proxy(self):
        t0 = time.time()
        n = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(n) if n else b""
        rec = {"ts": round(t0, 3), "method": self.command, "path": self.path.split("?")[0], "req": _pick(self.headers, LOG_REQ),
               "beta": sorted(v.strip() for v in (self.headers.get("anthropic-beta") or "").split(",") if v.strip()),
               "auth": "bearer" if self.headers.get("authorization") else ("x-api-key" if self.headers.get("x-api-key") else "none")}
        if body and self.command == "POST" and self.path.startswith("/v1/messages"):
            try:
                j = json.loads(body)
                rec["model_in"] = j.get("model")
                rec["stream"] = bool(j.get("stream"))
                rec["fields"] = sorted(j.keys())
                rec["tools"] = len(j.get("tools") or [])
                if GEMINI and "count_tokens" not in self.path:
                    self._gemini(j, rec, t0)
                    return
                if ALTERNATE and "count_tokens" not in self.path and self.headers.get("x-claude-code-request-class") == "main":
                    global _turn  # spike test 7: switch model on every main request of a tool loop
                    _turn += 1
                    j["model"] = ALTERNATE[_turn % len(ALTERNATE)]
                    body = json.dumps(j, ensure_ascii=False).encode()
                    rec["model_out"] = j["model"]
                elif REWRITE and "count_tokens" not in self.path:
                    j.update(json.loads(os.environ.get("SPIKE_SET_JSON") or "{}"))  # spike test 6: which parameters are accepted
                    j["model"] = REWRITE
                    body = json.dumps(j, ensure_ascii=False).encode()
                    rec["model_out"] = REWRITE
            except ValueError:
                rec["body"] = "not json"
        rec["bytes_in"] = len(body)
        # Claude Code sends `Accept-Encoding: gzip, …`; header names are case-insensitive, so drop every variant before asking for
        # identity, or upstream sees both and compresses (found in the spike: the stream could not be inspected).
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP and k.lower() != "accept-encoding"}
        headers["accept-encoding"] = "identity"
        headers["content-length"] = str(len(body))
        try:
            conn = http.client.HTTPSConnection(UPSTREAM, timeout=600)
            conn.request(self.command, self.path, body=body or None, headers=headers)
            resp = conn.getresponse()
        except Exception as e:  # noqa: BLE001 - spike: report any upstream failure as 502
            rec.update(status=502, error=type(e).__name__)
            _log(rec)
            self.send_error(502, "upstream unreachable")
            return
        rec["status"] = resp.status
        rec["resp"] = _pick(resp.getheaders() and dict(resp.getheaders()) or {}, LOG_RESP)
        self.send_response(resp.status)
        for k, v in resp.getheaders():
            if k.lower() not in HOP:
                self.send_header(k, v)
        self.send_header("transfer-encoding", "chunked")
        self.end_headers()
        total, first = 0, None
        try:
            while True:
                chunk = resp.read1(65536)
                if not chunk:
                    break
                if first is None:
                    first = time.time()
                if "served_model" not in rec:  # the upstream's own word on which model answered (message_start / JSON body)
                    m = SERVED.search(chunk)
                    if m:
                        rec["served_model"] = m.group(1).decode()
                    for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
                        u = re.search(rb'"' + k.encode() + rb'"\s*:\s*(\d+)', chunk)
                        if u:
                            rec.setdefault("usage", {})[k] = int(u.group(1))
                total += len(chunk)
                self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            rec["client_gone"] = True
        finally:
            conn.close()
        rec.update(bytes_out=total, ttfb_ms=int(((first or time.time()) - t0) * 1000), ms=int((time.time() - t0) * 1000))
        _log(rec)

    def _gemini(self, j, rec, t0):
        """Answer an Anthropic Messages request with Gemini through its OpenAI-format endpoint (spike test 3)."""
        req = tr.to_openai(j, GEMINI, gemini=True)
        data = json.dumps(req, ensure_ascii=False).encode()
        rec.update(model_out=GEMINI, msgs_out=len(req["messages"]))
        conn = http.client.HTTPSConnection("generativelanguage.googleapis.com", timeout=600)
        conn.request("POST", "/v1beta/openai/chat/completions", body=data,
                     headers={"authorization": "Bearer " + GEMINI_KEY, "content-type": "application/json", "accept-encoding": "identity"})
        resp = conn.getresponse()
        rec["status"] = resp.status
        if resp.status != 200:
            err = resp.read()[:2000].decode("utf-8", "replace")
            rec["upstream_error"] = err[:600]
            _log(rec)
            out = json.dumps(tr.error_body(resp.status, "gemini: " + err[:400])).encode()
            self.send_response(resp.status if resp.status in (400, 401, 403, 404, 429) else 502)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            conn.close()
            return
        label = j.get("model") or GEMINI
        if not j.get("stream"):
            msg = tr.to_anthropic(json.loads(resp.read()), label)
            out = json.dumps(msg, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            rec.update(stop=msg["stop_reason"], blocks=[b["type"] for b in msg["content"]], usage=msg["usage"])
        else:
            st = tr.StreamTranslator(label)
            self.send_response(200)
            self.send_header("content-type", "text/event-stream; charset=utf-8")
            self.send_header("cache-control", "no-cache")
            self.send_header("transfer-encoding", "chunked")
            self.end_headers()

            def emit(b):
                if b:
                    self.wfile.write(b"%x\r\n%s\r\n" % (len(b), b))
                    self.wfile.flush()
            while True:
                line = resp.readline()
                if not line:
                    break
                emit(st.feed(line))
            emit(st.finish())
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
            rec.update(stop=st.stop, tool_calls=len(st.tools), usage=st.usage)
        conn.close()
        rec["ms"] = int((time.time() - t0) * 1000)
        _log(rec)

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _proxy


if __name__ == "__main__":
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"spike proxy on http://{HOST}:{PORT} -> https://{UPSTREAM}  rewrite={REWRITE or 'off'}  log={os.path.abspath(LOG)}", file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
