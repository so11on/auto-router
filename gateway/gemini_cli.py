#!/usr/bin/env python3
"""Gemini as a TOOL the Claude calls from the shell (`node ar.mjs gemini <task> ...`), never as the conversation.

Why a command and not an MCP server: a command adds nothing to the Claude's context until it is run (an MCP server lists its tools
in every request) and it works the same from Claude Code, Codex or Copilot. Why Gemini at all: a 1M-token window and low prices make
it the cheap reader of things the Claude should not read itself, and the Google credits that expire are money that would be lost.

  digest   <paths...> --ask "..."     read files or folders and answer; only the answer reaches the Claude
  media    <file> --ask "..."         PDF, image, audio, video
  research "<question>"               web search with sources (Google Search grounding)
  review   [--diff <git range>]       independent second opinion on a diff (stdin if piped)
  batch    submit <jobs.jsonl> | status <name> | collect <name>   many small jobs at half price (Batch API, asynchronous)

Everything passes the same checks as the rest of the project: the DLP masks secrets and personal data before anything leaves the
machine, and `safety` decides which models may receive sensitive content. Spend is added to data/gateway-spend.json. Stdlib + PyYAML.
"""
import argparse
import base64
import http.client
import json
import mimetypes
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import router as rt  # noqa: E402  (puts litellm/ on sys.path)
import server  # noqa: E402  (read_dotenv, DATA)

HOST = "generativelanguage.googleapis.com"
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", "data"}
SKIP_FILES = {".env", ".env.bak", ".npmrc", ".netrc", "id_rsa", "id_ed25519"}
SKIP_SUFFIX = (".pem", ".key", ".p12", ".pfx", ".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".tar", ".gz", ".so", ".dylib", ".pyc",
               ".mp4", ".mov", ".mp3", ".wav", ".lock", ".ico", ".woff", ".woff2")


class Refused(Exception):
    pass


def load():
    cfg = rt.load_config()
    keys = server.read_dotenv(["GEMINI_API_KEY"])
    if not keys.get("GEMINI_API_KEY"):
        raise Refused("GEMINI_API_KEY is not set (.env); see docs/CONFIGURATION.md")
    return cfg, keys["GEMINI_API_KEY"], rt.safety.settings()


def pick_model(cfg, task, settings, sensitive=False):
    spec = (cfg.get("gemini_tasks") or {}).get(task)
    if not spec:
        raise Refused(f"task '{task}' is not defined under gemini_tasks in the config")
    name = spec["model"]
    m = (cfg.get("models") or {}).get(name) or {}
    if not m or not m.get("enabled", True):
        raise Refused(f"model {name} is disabled in the config (models.{name}.enabled)")
    if "tools" not in (m.get("roles") or []):
        raise Refused(f"model {name} has no 'tools' role in the config")
    if not rt.safety.allowed_by_safety(name, settings):
        raise Refused(f"safety forbids {name}")
    if sensitive and not rt.safety.allowed_for_sensitive(name, settings):
        raise Refused(f"the content looks sensitive (secrets or personal data) and {name} is not allowed to receive it")
    return name, m["id"], spec


def mask(text: str, settings: dict) -> str:
    """The DLP runs before anything leaves the machine. Secrets and personal data are replaced by placeholders (values never logged)."""
    data = {"messages": [{"role": "user", "content": text}]}
    res = rt.dlp.scan_and_mask(data, dict(settings, mask_secrets="on"))
    if res.error:
        raise Refused("the DLP failed on this content; refusing to send it")
    return data["messages"][0]["content"]


def call(key, path, body, timeout=300):
    conn = http.client.HTTPSConnection(HOST, timeout=timeout)
    try:
        conn.request("POST", path, body=json.dumps(body).encode(), headers={"x-goog-api-key": key, "content-type": "application/json"})
        r = conn.getresponse()
        raw = r.read()
        try:
            data = json.loads(raw)
        except ValueError:
            data = {"error": {"message": raw[:300].decode("utf-8", "replace")}}
        return r.status, data
    finally:
        conn.close()


def get(key, path, timeout=60):
    conn = http.client.HTTPSConnection(HOST, timeout=timeout)
    try:
        conn.request("GET", path, headers={"x-goog-api-key": key})
        r = conn.getresponse()
        return r.status, json.loads(r.read() or b"{}")
    finally:
        conn.close()


def charge(cfg, name, usage):
    """Add the cost of this call to the ledger the gateway also uses (credit lots are drawn oldest-first)."""
    tin = int(usage.get("promptTokenCount") or 0)
    tout = int(usage.get("candidatesTokenCount") or 0) + int(usage.get("thoughtsTokenCount") or 0)
    spec = rt.registry.spec(name)
    pr = rt.engine.price_for(spec, tin, datetime.now(timezone.utc))
    if not pr:
        return 0.0, tin, tout
    usd = (tin * pr[0] + tout * pr[1]) / 1e6
    ledger = rt.funding.Ledger(os.path.join(server.DATA, "gateway-spend.json"))
    ledger.add((cfg.get("models") or {}).get(name, {}).get("source", "google"), usd)
    return usd, tin, tout


def answer_text(data):
    parts = (((data.get("candidates") or [{}])[0]).get("content") or {}).get("parts") or []
    return "".join(p.get("text", "") for p in parts if "text" in p).strip()


def generate(cfg, key, name, model_id, parts, system=None, grounding=False, effort="low"):
    body = {"contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"thinkingConfig": {"thinkingLevel": effort}} if effort else {}}
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    if grounding:
        body["tools"] = [{"google_search": {}}]
    status, data = call(key, f"/v1beta/models/{model_id}:generateContent", body)
    if status != 200:
        raise Refused(f"Gemini {model_id} answered {status}: {(data.get('error') or {}).get('message', '')[:300]}")
    usd, tin, tout = charge(cfg, name, data.get("usageMetadata") or {})
    return data, usd, tin, tout


def collect_files(paths, max_chars):
    out, total, skipped = [], 0, []
    def add(path):
        nonlocal total
        base = os.path.basename(path)
        if base in SKIP_FILES or base.endswith(SKIP_SUFFIX):
            skipped.append(path)
            return
        try:
            text = open(path, encoding="utf-8").read()
        except (OSError, UnicodeDecodeError):
            skipped.append(path)
            return
        if total + len(text) > max_chars:
            skipped.append(path + " (over the size limit)")
            return
        total += len(text)
        out.append(f"=== {path} ===\n{text}")
    for p in paths:
        if os.path.isdir(p):
            for root, dirs, files in os.walk(p):
                dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith("."))
                for f in sorted(files):
                    add(os.path.join(root, f))
        else:
            add(p)
    return "\n\n".join(out), skipped


def trim(text, limit):
    return text if len(text) <= limit else text[:limit] + f"\n[... cut at {limit} characters; ask a narrower question for more]"


def footer(name, usd, tin, tout):
    return f"\n\n[{name} · {tin} in / {tout} out · ≈ US$ {usd:.4f}]"


def run(args):
    cfg, key, settings = load()
    limit = int(args.max_out)
    if args.task == "batch":
        return batch(args, cfg, key, settings)
    if args.task == "digest":
        body, skipped = collect_files(args.inputs, int(args.max_in))
        if not body:
            raise Refused("nothing readable to send" + (f" (skipped: {', '.join(skipped[:5])})" if skipped else ""))
        text = mask(body, settings)
        name, mid, spec = pick_model(cfg, "digest", settings)
        question = args.ask or "Summarise what these files contain and how they fit together. Be concise and concrete."
        data, usd, tin, tout = generate(cfg, key, name, mid, [{"text": text}, {"text": "\n\nQuestion: " + question}],
                                        system="You read material on behalf of another AI agent. Answer only what is asked, in a compact form, "
                                               "quoting file paths and line-level facts when they matter. Do not add advice nobody asked for.")
        note = f"\n[skipped: {', '.join(skipped[:8])}]" if skipped else ""
        return trim(answer_text(data), limit) + note + footer(name, usd, tin, tout)
    if args.task == "media":
        path = args.inputs[0]
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if os.path.getsize(path) > 18 * 1024 * 1024:
            raise Refused("file over 18 MB (the inline limit); upload it with the Files API first")
        name, mid, spec = pick_model(cfg, "media", settings)
        raw = base64.b64encode(open(path, "rb").read()).decode()
        data, usd, tin, tout = generate(cfg, key, name, mid, [{"inline_data": {"mime_type": mime, "data": raw}},
                                                              {"text": args.ask or "Describe the content and extract what matters."}])
        return trim(answer_text(data), limit) + footer(name, usd, tin, tout)
    if args.task == "research":
        question = mask(" ".join(args.inputs), settings)
        name, mid, spec = pick_model(cfg, "research", settings)
        data, usd, tin, tout = generate(cfg, key, name, mid, [{"text": question}], grounding=True,
                                        system="Answer with verified facts and give the date of each source when it matters.")
        meta = ((data.get("candidates") or [{}])[0].get("groundingMetadata") or {})
        urls = []
        for c in meta.get("groundingChunks") or []:
            w = c.get("web") or {}
            if w.get("uri") and w["uri"] not in [u for u, _ in urls]:
                urls.append((w["uri"], w.get("title", "")))
        src = "\n\nSources (redirect links, open to see the page):\n" + "\n".join(f"- {t or 'source'} <{u[:90]}...>" for u, t in urls[:8]) \
            if urls else "\n\n(no sources returned)"
        return trim(answer_text(data), limit) + src + footer(name, usd, tin, tout)
    if args.task == "review":
        if args.diff:
            diff = subprocess.run(["git", "diff", args.diff], capture_output=True, text=True).stdout
        elif not sys.stdin.isatty():
            diff = sys.stdin.read()
        else:
            diff = subprocess.run(["git", "diff", "HEAD"], capture_output=True, text=True).stdout
        if not diff.strip():
            raise Refused("no diff to review")
        name, mid, spec = pick_model(cfg, "review", settings)
        data, usd, tin, tout = generate(cfg, key, name, mid, [{"text": mask(diff[: int(args.max_in)], settings)},
                                                              {"text": "\n\nReview this diff for correctness bugs, regressions and missing tests. "
                                                                       "List only real problems with file and line; say 'no problems found' if none."}],
                                        effort="medium")
        return trim(answer_text(data), limit) + footer(name, usd, tin, tout)
    raise Refused(f"unknown task {args.task}")


def batch(args, cfg, key, settings):
    """Asynchronous, half price. jobs.jsonl: one {"key": "...", "prompt": "..."} per line."""
    sub = args.inputs[0] if args.inputs else ""
    name, mid, spec = pick_model(cfg, "batch", settings)
    if sub == "submit":
        jobs = [json.loads(l) for l in open(args.inputs[1]) if l.strip()]
        reqs = [{"request": {"contents": [{"role": "user", "parts": [{"text": mask(j["prompt"], settings)}]}]},
                 "metadata": {"key": str(j.get("key", i))}} for i, j in enumerate(jobs)]
        status, data = call(key, f"/v1beta/models/{mid}:batchGenerateContent",
                            {"batch": {"display_name": "auto-router-" + str(int(time.time())),
                                       "input_config": {"requests": {"requests": reqs}}}})
        if status != 200:
            raise Refused(f"batch submit answered {status}: {(data.get('error') or {}).get('message', '')[:300]}")
        return f"batch submitted: {data.get('name')}  ({len(reqs)} jobs, {mid}, results within 24 h)\nCheck: node ar.mjs gemini batch status {data.get('name')}"
    if sub in ("status", "collect"):
        bname = args.inputs[1]
        status, data = get(key, "/v1beta/" + bname)
        if status != 200:
            raise Refused(f"batch lookup answered {status}")
        state = ((data.get("metadata") or {}).get("state")) or data.get("state") or "UNKNOWN"
        if sub == "status" or "SUCCEEDED" not in state:
            return f"{bname}: {state}"
        resp = (data.get("response") or {}).get("inlinedResponses") or ((data.get("response") or {}).get("inlinedResponses", {}))
        items = resp.get("inlinedResponses", resp) if isinstance(resp, dict) else resp
        out = []
        for it in items or []:
            txt = answer_text(it.get("response") or {})
            out.append(json.dumps({"key": (it.get("metadata") or {}).get("key"), "answer": txt}, ensure_ascii=False))
        usage = (data.get("metadata") or {}).get("batchStats") or {}
        return "\n".join(out) or f"{bname}: finished with no inline responses ({usage})"
    raise Refused("usage: batch submit <jobs.jsonl> | status <name> | collect <name>")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="ar.mjs gemini", description=__doc__.split("\n")[0])
    ap.add_argument("task", choices=["digest", "media", "research", "review", "batch"])
    ap.add_argument("inputs", nargs="*")
    ap.add_argument("--ask")
    ap.add_argument("--diff")
    ap.add_argument("--max-in", default=3_000_000, help="characters read at most (default 3M ≈ 750k tokens)")
    ap.add_argument("--max-out", default=8000, help="characters of the answer handed back (protects the Claude's context)")
    args = ap.parse_args(argv)
    try:
        print(run(args))
        return 0
    except Refused as e:
        print(f"gemini {args.task}: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
