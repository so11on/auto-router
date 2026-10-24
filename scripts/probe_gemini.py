#!/usr/bin/env python3
"""Probe Gemini models with a key: is the model reachable, and is the key on a free or paid tier?

Usage:  GEMINI_PROBE_KEY=... python3 scripts/probe_gemini.py [--burst N] model [model ...]

For each model it sends N (default 30) parallel one-token requests. Free-tier keys answer part of
them with HTTP 429 and the body names the free-tier quota (`limit: <requests per minute>`).
A key on a billing-enabled project answers all of them with 200, which is how a paid key is told
apart from a free one. Costs a few tokens per model on paid keys and nothing on free keys.
"""
import argparse
import collections
import json
import os
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

URL = "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent"
BODY = json.dumps({"contents": [{"parts": [{"text": "hi"}]}], "generationConfig": {"maxOutputTokens": 8}}).encode()


def call(key: str, model: str) -> tuple[int, str]:
    req = urllib.request.Request(URL.format(model), data=BODY,
                                 headers={"x-goog-api-key": key, "Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=60)
        return 200, ""
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf8", "ignore")
    except Exception as e:  # network errors count as code 0
        return 0, str(e)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("models", nargs="+")
    ap.add_argument("--burst", type=int, default=30)
    args = ap.parse_args()
    key = os.environ.get("GEMINI_PROBE_KEY")
    if not key:
        print("set GEMINI_PROBE_KEY", file=sys.stderr)
        return 2
    for model in args.models:
        with ThreadPoolExecutor(args.burst) as ex:
            results = list(ex.map(lambda _: call(key, model), range(args.burst)))
        codes = collections.Counter(c for c, _ in results)
        quotas = {(m[0].rsplit("/", 1)[-1], m[1]) for _, b in results
                  for m in re.findall(r"metric: (\S+), limit: (\d+)", b)}
        print(f"{model}: {dict(sorted(codes.items()))} quotas={sorted(quotas)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
