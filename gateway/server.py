#!/usr/bin/env python3
"""The Claude Code gateway: `auto` routing between the Claude plan and paid Gemini, local and light (docs/GATEWAY.md).

Claude Code points ANTHROPIC_BASE_URL here (no gateway credential, so the claude.ai login keeps being used). For each
/v1/messages request router.Router decides; then:
  anthropic  -> pass-through to api.anthropic.com; only `model` and `output_config.effort` change (never messages/system/tools,
                which would break the prompt cache and thinking). Plan usage is read from every response's unified headers.
  gemini     -> translated to Gemini's OpenAI endpoint (translate_openai.py) with GEMINI_API_KEY; spend goes to the ledger.
  answer     -> the gateway answers itself (the "Claude plan is out: 1 = Gemini / 2 = wait" question, the resume confirmation).
Everything else (count_tokens, models …) is passed through untouched.

Logs hold decisions, sizes and timings: never prompt text, never credentials. Stdlib + PyYAML only.
"""
import http.client
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import router as rt  # noqa: E402  (puts litellm/ on sys.path)
import classify_rules  # noqa: E402
import translate_openai as tr  # noqa: E402

DATA = os.environ.get("AR_DATA_DIR", os.path.join(ROOT, "data"))
LOG = os.path.join(DATA, "gateway.jsonl")
STATE = os.path.join(DATA, "gateway-state.json")
QUEUE = os.path.join(DATA, "resume-queue.json")
ANTHROPIC = "api.anthropic.com"
GEMINI_HOST = "generativelanguage.googleapis.com"
HOP = {"connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host", "content-length",
       "accept-encoding"}
SERVED = re.compile(rb'"model"\s*:\s*"([^"]{1,80})"')
USAGE = {k: re.compile(rb'"' + k.encode() + rb'"\s*:\s*(\d+)') for k in
         ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")}
MAX_LOG_BYTES = 10_000_000
VERSION = "1.0.0"
_lock = threading.Lock()


def short(name) -> str:
    """claude-sonnet-5-5 / claude-sonnet-cli -> sonnet: what the person reads next to the effort."""
    n = str(name or "")
    for fam in ("haiku", "sonnet", "opus"):
        if fam in n:
            return fam
    return n


def shape(req: dict) -> dict:
    """Sizes and block types of a request, never its text: enough to see a client that lost its history or toolbox."""
    sysp = req.get("system")
    sys_chars = len(sysp) if isinstance(sysp, str) else sum(len(b.get("text", "")) for b in sysp or [] if isinstance(b, dict))
    msgs = req.get("messages") or []
    kinds = {}
    for m in msgs:
        content = m.get("content")
        for b in content if isinstance(content, list) else [{"type": "text"}]:
            if isinstance(b, dict):
                kinds[b.get("type")] = kinds.get(b.get("type"), 0) + 1
    return {"sys_chars": sys_chars, "tools": len(req.get("tools") or []), "msgs": len(msgs),
            "first": msgs[0].get("role") if msgs else None, "blocks": kinds, "est_tokens": rt.est_tokens(req)}


def read_dotenv(names, path=None) -> dict:
    """Only the named keys from the repo's .env (the rest never enters this process)."""
    out = {}
    path = path or os.path.join(ROOT, ".env")
    try:
        for line in open(path):
            k, _, v = line.partition("=")
            if k.strip() in names and v.strip():
                out[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    for n in names:
        if os.environ.get(n):
            out[n] = os.environ[n]
    return out


def log(rec: dict):
    rec.setdefault("ts", round(time.time(), 3))
    with _lock:
        os.makedirs(DATA, exist_ok=True)
        try:
            if os.path.getsize(LOG) > MAX_LOG_BYTES:
                os.replace(LOG, LOG + ".1")
        except OSError:
            pass
        with open(LOG, "a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def notify(title: str, text: str):
    """Local desktop notification; silently nothing where none is available or the feature is off."""
    if GW is not None and not GW.router.feature("notifications"):
        return
    try:
        if sys.platform == "darwin":
            script = 'display notification %s with title %s' % (json.dumps(text), json.dumps(title))
            subprocess.run(["osascript", "-e", script], timeout=10, capture_output=True)
        elif shutil.which("notify-send"):
            subprocess.run(["notify-send", title, text], timeout=10, capture_output=True)
    except Exception:
        pass


# ------------------------------------------------------------------ classifier (Gemini Flash-Lite, else the local heuristic)
class Classifier:
    def __init__(self, gw):
        self.gw = gw

    def __call__(self, text: str, checkpoint: bool = False, sensitive: bool = False) -> dict:
        cfg = self.gw.router.cfg.get("classifier") or {}
        name = cfg.get("model")
        m = (self.gw.router.cfg.get("models") or {}).get(name or "") or {}
        allowed = name and m.get("upstream") == "gemini" and "classifier" in (m.get("roles") or []) and self.gw.router._available(name, m) and \
            rt.safety.allowed_by_safety(name, self.gw.router.settings) and \
            (not sensitive or rt.safety.allowed_for_sensitive(name, self.gw.router.settings))
        if allowed and not self.gw.router.source_state(m.get("source", "google")).get("exhausted"):
            try:
                prompt = classify_rules.GATEWAY_CHECKPOINT_PROMPT if checkpoint else classify_rules.GATEWAY_CLASSIFIER_PROMPT
                body = {"model": m["id"], "max_tokens": 300, "temperature": 0, "reasoning_effort": "low",
                        "messages": [{"role": "system", "content": prompt},
                                     {"role": "user", "content": text[: int(cfg.get("max_chars", 4000))]}]}
                status, data = self.gw.gemini_json(body, timeout=float(cfg.get("timeout_s", 8)))
                if status == 200:
                    self.gw.charge(name, data.get("usage") or {})
                    raw = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
                    out = json.loads(raw[raw.find("{"):raw.rfind("}") + 1])
                    return classify_rules.normalise_rich(out, checkpoint, rt.engine.TASKS)
                log({"event": "classifier_error", "status": status})
            except Exception as e:  # noqa: BLE001 - any failure: heuristic
                log({"event": "classifier_error", "error": type(e).__name__})
        return classify_rules.heuristic_rich(text)


# ------------------------------------------------------------------ the gateway
class Gateway:
    def __init__(self, cfg=None):
        self.keys = read_dotenv(["GEMINI_API_KEY"])
        self.router = rt.Router(cfg=cfg, env=self.keys)
        self.router.classify = Classifier(self)
        self.router.resume_queue = self._load_queue()
        self.last_decisions = {}
        try:  # the last plan snapshot survives a restart (it is replaced by the next Anthropic response anyway)
            with open(STATE) as f:
                self.router.claude_snapshot = json.load(f).get("claude_snapshot") or {}
        except (OSError, ValueError):
            pass

    # ---------- money
    def charge(self, name: str, usage: dict):
        spec = rt.registry.spec(name)
        m = (self.router.cfg.get("models") or {}).get(name) or {}
        pr = rt.engine.price_for(spec, int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0),
                                 rt.datetime.now(rt.timezone.utc))
        if not pr or m.get("source", "claude") == "claude":
            return 0.0
        tin = int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
        tout = int(usage.get("completion_tokens") or usage.get("output_tokens") or 0)
        usd = (tin * pr[0] + tout * pr[1]) / 1e6
        with _lock:
            self.router.ledger.add(m.get("source"), usd)
        return usd

    def gemini_json(self, body: dict, timeout: float = 120):
        conn = http.client.HTTPSConnection(GEMINI_HOST, timeout=timeout)
        try:
            conn.request("POST", "/v1beta/openai/chat/completions", body=json.dumps(body).encode(),
                         headers={"authorization": "Bearer " + self.keys.get("GEMINI_API_KEY", ""), "content-type": "application/json"})
            r = conn.getresponse()
            raw = r.read()
            try:
                return r.status, json.loads(raw)
            except ValueError:
                return r.status, {"error": {"message": raw[:300].decode("utf-8", "replace")}}
        finally:
            conn.close()

    # ---------- state for the status line / companion extension
    def publish(self, sid=None, decision=None, sent=None):
        """`sent` = the model and effort that actually went upstream (shadow: what Claude Code asked for); `model`/`effort` stay the
        decision of `auto`, so the status shows both when they differ."""
        if sid and decision:
            self.last_decisions[sid] = {k: decision.get(k) for k in ("model", "effort", "task", "complexity", "reason", "source",
                                                                     "lambda", "switched_from", "sensitive")}
            self.last_decisions[sid]["sent"] = sent
            self.last_decisions[sid]["ts"] = time.time()
        claude = self.router.source_state("claude")
        google = self.router.source_state("google") if (self.router.cfg.get("funding") or {}).get("google") else {}
        state = _num({"ts": time.time(), "version": VERSION, "mode": self.router.mode, "claude": {"lambda": claude.get("lambda"), "exhausted": claude.get("exhausted"),
                                                    "until": claude.get("until"), "windows": claude.get("windows")},
                      "google": google, "sessions": dict(list(self.last_decisions.items())[-50:]),
                      "resume_queue": self.router.resume_queue, "claude_snapshot": self.router.claude_snapshot})
        with _lock:
            os.makedirs(DATA, exist_ok=True)
            tmp = STATE + ".tmp"
            with open(tmp, "w") as f:
                json.dump(state, f, default=str)
            os.replace(tmp, STATE)

    # ---------- resume queue
    def _load_queue(self):
        try:
            with open(QUEUE) as f:
                return json.load(f)
        except (OSError, ValueError):
            return []

    def save_queue(self):
        with _lock:
            os.makedirs(DATA, exist_ok=True)
            with open(QUEUE, "w") as f:
                json.dump(self.router.resume_queue, f)

    def resume_loop(self, port: int):
        while True:
            time.sleep(30)
            due = [r for r in list(self.router.resume_queue) if r["at"] <= time.time()]
            for r in due:
                self.router.resume_queue.remove(r)
                self.save_queue()
                threading.Thread(target=self._resume, args=(r, port), daemon=True).start()

    def _resume(self, r: dict, port: int):
        m, title = self.router.msg, self.router.msg("notify_title")
        folder = os.path.basename(r.get("cwd") or "")
        if r.get("mode") == "notify":  # option 4: the person continues by hand
            notify(title, m("notify_plan_back", folder=folder))
            log({"event": "plan_back_notified", "session": r["session"][:8]})
            return
        claude = shutil.which("claude")
        if not claude or not os.path.isdir(r["cwd"]):
            log({"event": "resume_failed", "session": r["session"][:8], "why": "no claude CLI or folder"})
            notify(title, m("notify_no_claude"))
            return
        env = {k: v for k, v in os.environ.items() if not k.startswith(("ANTHROPIC_", "CLAUDE_CODE_")) and k != "GEMINI_API_KEY"}
        env.update(ANTHROPIC_BASE_URL=f"http://127.0.0.1:{port}", CLAUDE_CODE_GATEWAY_HINT_HEADERS="1")
        notify(title, m("notify_resuming", folder=folder))
        log({"event": "resume_start", "session": r["session"][:8]})
        try:
            p = subprocess.run([claude, "-p", m("resume_prompt"), "--resume", r["session"], "--permission-mode", "acceptEdits",
                                "--output-format", "json"], cwd=r["cwd"], env=env, capture_output=True, text=True, timeout=3 * 3600,
                               stdin=subprocess.DEVNULL)
            ok = p.returncode == 0
            try:
                res = json.loads(p.stdout or "{}")
                ok = ok and not res.get("is_error")
            except ValueError:
                pass
        except subprocess.TimeoutExpired:
            ok = False
        tries = r.get("tries", 0) + 1
        log({"event": "resume_end", "session": r["session"][:8], "ok": ok, "tries": tries})
        if ok:
            notify(title, m("notify_resumed", folder=folder))
        elif tries < 4 and self.router.source_state("claude").get("exhausted"):
            r.update(at=time.time() + 900, tries=tries)
            self.router.resume_queue.append(r)
            self.save_queue()
        else:
            notify(title, m("notify_needs_you", folder=folder))


def _num(v):
    """JSON-safe: infinity (an exhausted window's shadow price) becomes null, floats are rounded, containers are walked."""
    if isinstance(v, float):
        return None if v in (float("inf"), float("-inf")) or v != v else round(v, 4)
    if isinstance(v, dict):
        return {k: _num(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_num(x) for x in v]
    return v


GW = None  # set in main()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    # ---------- plumbing
    def _send_json(self, status: int, obj: dict, headers=None):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _chunk(self, b: bytes):
        if b:
            self.wfile.write(b"%x\r\n%s\r\n" % (len(b), b))
            self.wfile.flush()

    def _start_stream(self, status=200, headers=()):
        self.send_response(status)
        for k, v in headers:
            if k.lower() not in HOP and k.lower() != "content-length":
                self.send_header(k, v)
        if not any(k.lower() == "content-type" for k, _ in headers):
            self.send_header("content-type", "text/event-stream; charset=utf-8")
        self.send_header("transfer-encoding", "chunked")
        self.end_headers()

    def _end_stream(self):
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def do_GET(self):
        if self.path == "/health":
            return self._send_json(200, {"ok": True, "service": "auto-router gateway"})
        if self.path == "/state":
            try:
                with open(STATE) as f:
                    return self._send_json(200, json.load(f))
            except (OSError, ValueError):
                return self._send_json(200, {})
        return self._passthrough(b"")

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(n) if n else b""
        if self.path.split("?")[0] == "/v1/messages":
            try:
                req = json.loads(body)
            except ValueError:
                return self._passthrough(body)
            return self._messages(req, body)
        return self._passthrough(body)

    do_PUT = do_DELETE = do_PATCH = lambda self: self._passthrough(self.rfile.read(int(self.headers.get("content-length") or 0)))

    # ---------- pass-through to Anthropic
    def _upstream(self, body: bytes):
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        headers["accept-encoding"] = "identity"  # Claude Code asks for gzip; we must read the stream (served model, usage, errors)
        headers["content-length"] = str(len(body))
        conn = http.client.HTTPSConnection(ANTHROPIC, timeout=900)
        conn.request(self.command, self.path, body=body or None, headers=headers)
        return conn, conn.getresponse()

    def _relay(self, conn, resp, rec=None):
        self._start_stream(resp.status, resp.getheaders())
        usage = {}
        try:
            while True:
                chunk = resp.read1(65536)
                if not chunk:
                    break
                if rec is not None:
                    if "served" not in rec:
                        m = SERVED.search(chunk)
                        if m:
                            rec["served"] = m.group(1).decode()
                    for k, rx in USAGE.items():
                        for v in rx.findall(chunk):
                            usage[k] = int(v)  # the last value wins (message_delta carries the final output count)
                self._chunk(chunk)
            self._end_stream()
        except (BrokenPipeError, ConnectionResetError):
            if rec is not None:
                rec["client_gone"] = True
        finally:
            conn.close()
        if rec is not None and usage:
            rec["usage"] = usage

    def _passthrough(self, body: bytes):
        try:
            conn, resp = self._upstream(body)
        except Exception as e:  # noqa: BLE001
            log({"event": "upstream_error", "path": self.path.split("?")[0], "error": type(e).__name__})
            return self._send_json(502, tr.error_body(502, "auto-router gateway: Anthropic unreachable"))
        GW.router.note_plan(dict(resp.getheaders()))
        self._relay(conn, resp)

    # ---------- /v1/messages
    def _messages(self, req: dict, raw: bytes):
        t0 = time.time()
        h = {k.lower(): v for k, v in self.headers.items()}
        sid = h.get("x-claude-code-session-id", "")
        try:
            d = GW.router.decide(req, h)
        except Exception as e:  # noqa: BLE001 - never block Claude Code because the router failed: send as asked
            log({"event": "router_error", "error": f"{type(e).__name__}: {e}"[:300]})
            return self._passthrough(raw)
        shadow = GW.router.mode == "shadow"
        asked_effort = (req.get("output_config") or {}).get("effort") if isinstance(req.get("output_config"), dict) else None
        rec = {"event": "route", "session": sid[:8], "class": h.get("x-claude-code-request-class"), "asked": req.get("model"),
               "asked_effort": asked_effort, "mode": GW.router.mode, "shape": shape(req),
               **{k: d.get(k) for k in ("model", "upstream", "effort", "reason", "task", "complexity", "floor", "lambda", "est_cost",
                                        "switched_from", "candidates") if d.get(k) is not None}}
        if (GW.router.sessions.get(sid) or {}).get("ctx_drop"):
            rec["context_drop"] = True  # the client sent far less than this session's peak: its history or toolbox is gone
        if shadow:
            # Decide and log, but send the request untouched: the report compares what routing would have used with what was used.
            rec.update(shadow=True, would=d.get("model") or d["action"])
            sent = {"model": short(req.get("model")), "effort": asked_effort}
            self._anthropic(req, {"action": "forward", "model": None, "id": None, "effort": None, "reason": "shadow"}, rec, h, shadow=True)
        elif d["action"] == "answer":
            sent = {"model": "auto-router", "effort": None}
            self._answer(req, d)
            if d.get("resume"):
                GW.save_queue()
        elif d["upstream"] == "gemini":
            sent = {"model": short(d["model"]), "effort": d.get("effort")}
            self._gemini(req, d, rec)
        else:
            sent = {"model": short(d["model"]), "effort": d.get("effort") or asked_effort}
            self._anthropic(req, d, rec, h)
        if rec.get("class") == "main" and (rec.get("status") or 0) in (400, 408, 413, 422) + tuple(range(500, 600)):  # not 401/403/429: not the model's fault
            GW.router.note_failure(sid)  # the upstream refused or broke: the model in use failed this task
        rec["ms"] = int((time.time() - t0) * 1000)
        log(rec)
        if sid:
            GW.publish(sid, d, sent)

    def _anthropic(self, req: dict, d: dict, rec: dict, h: dict, retried=False, shadow=False):
        out = dict(req)
        if d.get("id"):
            out["model"] = d["id"]
        if d.get("effort") and isinstance(req.get("output_config"), dict):
            out["output_config"] = dict(req["output_config"], effort=d["effort"])
        body = json.dumps(out, ensure_ascii=False).encode() if out != req else json.dumps(req, ensure_ascii=False).encode()
        try:
            conn, resp = self._upstream(body)
        except Exception as e:  # noqa: BLE001
            rec["error"] = type(e).__name__
            return self._send_json(502, tr.error_body(502, "auto-router gateway: Anthropic unreachable"))
        hdrs = dict(resp.getheaders())
        rec["status"] = resp.status
        if resp.status == 429 and not retried and not shadow and d.get("reason") not in ("picker pin",) and \
                str({k.lower(): v for k, v in hdrs.items()}.get("anthropic-ratelimit-unified-status", "")).lower() == "rejected":
            resp.read()
            conn.close()
            GW.router.mark_claude_limited(hdrs)
            d2 = GW.router.decide(req, h)  # the plan is out: simple work to Gemini, the rest asks
            rec.update(retried_as=d2.get("model") or d2["action"], reason=d2.get("reason"))
            if d2["action"] == "answer":
                return self._answer(req, d2)
            if d2.get("upstream") == "gemini":
                return self._gemini(req, d2, rec)
            return self._anthropic(req, d2, rec, h, retried=True)
        GW.router.note_plan(hdrs)
        if shadow and resp.status == 429:
            GW.router.mark_claude_limited(hdrs)  # keep the plan state current; the client sees the real answer
        low = {k.lower(): v for k, v in hdrs.items()}
        rec["plan"] = {k[len("anthropic-ratelimit-unified-"):]: v for k, v in low.items()
                       if k.startswith("anthropic-ratelimit-unified-") and k.endswith(("status", "utilization"))}
        self._relay(conn, resp, rec)

    def _gemini(self, req: dict, d: dict, rec: dict):
        oreq = tr.to_openai(req, d["id"], gemini=True)
        if d.get("effort"):
            oreq["reasoning_effort"] = d["effort"]
        label = d["id"]  # the real model: a Claude label made the client treat a Gemini answer (and its context size) as Claude's
        conn = http.client.HTTPSConnection(GEMINI_HOST, timeout=900)
        try:
            conn.request("POST", "/v1beta/openai/chat/completions", body=json.dumps(oreq, ensure_ascii=False).encode(),
                         headers={"authorization": "Bearer " + GW.keys.get("GEMINI_API_KEY", ""), "content-type": "application/json",
                                  "accept-encoding": "identity"})
            resp = conn.getresponse()
        except Exception as e:  # noqa: BLE001
            rec["error"] = type(e).__name__
            conn.close()
            return self._send_json(502, tr.error_body(502, "auto-router gateway: Gemini unreachable"))
        rec["status"] = resp.status
        if resp.status != 200:
            err = resp.read()[:1500].decode("utf-8", "replace")
            conn.close()
            rec["upstream_error"] = err[:300]
            status = resp.status if resp.status in (400, 401, 403, 404, 429) else 502
            return self._send_json(status, tr.error_body(status, f"Gemini ({d['id']}): {err[:400]}"))
        prefix = None
        if d.get("notice"):
            prefix = GW.router.msg("gemini_notice", model=d["model"])
        if not req.get("stream"):
            msg = tr.to_anthropic(json.loads(resp.read()), label)
            conn.close()
            if prefix:
                msg["content"].insert(0, {"type": "text", "text": prefix})
            GW.charge(d["model"], msg["usage"])
            rec["usage"] = msg["usage"]
            return self._send_json(200, msg)
        st = tr.StreamTranslator(label)
        self._start_stream(200, [("content-type", "text/event-stream; charset=utf-8"), ("cache-control", "no-cache")])
        try:
            if prefix:
                self._chunk(st._start() + tr._sse("content_block_start", {"type": "content_block_start", "index": 0,
                                                                          "content_block": {"type": "text", "text": ""}})
                            + tr._sse("content_block_delta", {"type": "content_block_delta", "index": 0,
                                                              "delta": {"type": "text_delta", "text": prefix}}))
                st.index, st.block = 0, ("text", 0)
            while True:
                line = resp.readline()
                if not line:
                    break
                self._chunk(st.feed(line))
            self._chunk(st.finish())
            self._end_stream()
        except (BrokenPipeError, ConnectionResetError):
            rec["client_gone"] = True
        finally:
            conn.close()
        GW.charge(d["model"], st.usage)
        rec["usage"] = st.usage

    def _answer(self, req: dict, d: dict):
        """The gateway's own reply, in the Anthropic format Claude Code expects."""
        label = "auto-router"
        text = d.get("text", "")
        if d.get("status", 200) != 200:
            return self._send_json(d["status"], tr.error_body(d["status"], text))
        if not req.get("stream"):
            return self._send_json(200, {"id": "msg_" + uuid.uuid4().hex[:24], "type": "message", "role": "assistant", "model": label,
                                         "content": [{"type": "text", "text": text}], "stop_reason": "end_turn", "stop_sequence": None,
                                         "usage": {"input_tokens": 0, "output_tokens": 0}})
        st = tr.StreamTranslator(label)
        self._start_stream(200, [("content-type", "text/event-stream; charset=utf-8")])
        self._chunk(st.feed(b"data: " + json.dumps({"choices": [{"delta": {"content": text}, "finish_reason": "stop"}]}).encode()))
        self._chunk(st.finish())
        self._end_stream()


def main():
    global GW
    GW = Gateway()
    lst = GW.router.cfg.get("listen") or {}
    host, port = lst.get("host", "127.0.0.1"), int(os.environ.get("AR_GATEWAY_PORT") or lst.get("port", 4001))
    if host not in ("127.0.0.1", "localhost", "::1"):
        sys.exit("auto-router gateway: refusing to listen on a non-loopback address")
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    threading.Thread(target=GW.resume_loop, args=(port,), daemon=True).start()
    signal.signal(signal.SIGTERM, lambda *a: os._exit(0))  # launchd/systemd stop: nothing to flush (files are written atomically)
    GW.publish()
    log({"event": "start", "port": port, "gemini": bool(GW.keys.get("GEMINI_API_KEY")),
         "models": [n for n, m in (GW.router.cfg.get("models") or {}).items() if m.get("enabled", True)]})
    print(f"auto-router gateway on http://{host}:{port}", file=sys.stderr)
    srv.serve_forever()


if __name__ == "__main__":
    main()
