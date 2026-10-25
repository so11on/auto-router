"""Quota tracking and exhaustion forecast. Pure Python (no LiteLLM import) so it can be unit-tested anywhere.

Sources, most to least trustworthy:
  claude-subscription  data/claude-quota.json written by claude-bridge from Claude Code's `rate_limit_event`
                       (`unifiedWindows.five_hour|seven_day.utilization` + `resetsAt`, plus a short history of samples)
  learned cooldowns    429 / "daily limit" errors seen on calls -> model blocked until the reset they announce
  counted              our own counters (requests and tokens per minute / per 24 h) against `limits` in models.yaml
States: ok | warn | critical | exhausted | unknown. Unknown never blocks a model.
"""
import json
import os
import re
import time
from collections import deque

WARN_REMAINING, CRITICAL_REMAINING = 0.20, 0.05
WARN_ETA_MIN, CRITICAL_ETA_MIN = 30, 5
RANK = {"ok": 0, "unknown": 0, "warn": 1, "critical": 2, "exhausted": 3}


def _state(remaining_frac, eta_min):
    if remaining_frac is not None and remaining_frac <= 0:
        return "exhausted"
    if (remaining_frac is not None and remaining_frac <= CRITICAL_REMAINING) or (eta_min is not None and eta_min <= CRITICAL_ETA_MIN):
        return "critical"
    if (remaining_frac is not None and remaining_frac <= WARN_REMAINING) or (eta_min is not None and eta_min <= WARN_ETA_MIN):
        return "warn"
    return "ok"


def _slope(samples):
    """Least-squares slope (utilization per second) of [(ts, util), ...]; None if not enough data or not rising."""
    if len(samples) < 2:
        return None
    n = len(samples)
    mx = sum(t for t, _ in samples) / n
    my = sum(u for _, u in samples) / n
    den = sum((t - mx) ** 2 for t, _ in samples)
    if den <= 0:
        return None
    s = sum((t - mx) * (u - my) for t, u in samples) / den
    return s if s > 0 else None


class Tracker:
    def __init__(self, data_dir: str, spec_fn):
        self.data_dir = data_dir
        self.spec = spec_fn  # model_name -> registry spec
        self.calls = {}  # model -> deque[(ts, tokens)]
        self.blocked = {}  # model -> (until_ts, reason)
        self._load_state()

    # ---------- persistence ----------
    def _path(self, name):
        return os.path.join(self.data_dir, name)

    def _load_state(self):
        try:
            with open(self._path("quota-state.json")) as f:
                raw = json.load(f)
            now = time.time()
            self.blocked = {k: tuple(v) for k, v in raw.get("blocked", {}).items() if v[0] > now}
        except Exception:
            self.blocked = {}
        try:  # rebuild 24 h of counters from the usage log
            cutoff = time.time() - 86400
            with open(self._path("usage.jsonl")) as f:
                for line in f:
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    if r.get("ts", 0) >= cutoff and r.get("status") == "ok" and r.get("model_group"):
                        self.calls.setdefault(r["model_group"], deque()).append((r["ts"], r.get("total_tokens") or 0))
        except Exception:
            pass

    def _save_state(self):
        try:
            os.makedirs(self.data_dir, exist_ok=True)
            with open(self._path("quota-state.json"), "w") as f:
                json.dump({"blocked": self.blocked}, f)
        except Exception:
            pass

    # ---------- inputs ----------
    def record_call(self, model: str, tokens: int, ok: bool, error_text: str = "", now: float = None):
        now = now or time.time()
        if ok:
            q = self.calls.setdefault(model, deque())
            q.append((now, tokens or 0))
            while q and q[0][0] < now - 86400:
                q.popleft()
            return
        until = self._cooldown_from_error(error_text or "", now)
        if until:
            self.blocked[model] = (until, (error_text or "")[:160])
            self._save_state()

    @staticmethod
    def _cooldown_from_error(text: str, now: float):
        t = text.lower()
        # an account without credit / with a billing problem stays broken until a human fixes it: do not retry it every request
        if any(w in t for w in ("credit balance is too low", "insufficient_quota", "insufficient credit", "billing", "payment required", "402")):
            return now + 6 * 3600
        if "429" not in t and "rate limit" not in t and "quota" not in t and "daily" not in t:
            return None
        m = re.search(r"reset(?:s)? after (\d+)\s*s", t) or re.search(r"retry[- ]after[^0-9]{0,5}(\d+)", t)
        if m:
            return now + int(m.group(1))
        if "daily" in t or "per day" in t or "rpd" in t or "tpd" in t:  # wait until the next UTC midnight
            return (int(now // 86400) + 1) * 86400
        return now + 60  # unknown 429: short cooldown

    # ---------- outputs ----------
    def status(self, model: str, now: float = None) -> dict:
        now = now or time.time()
        b = self.blocked.get(model)
        if b and b[0] > now:
            return {"state": "exhausted", "source": "learned", "resets_at": b[0], "reason": b[1], "eta_min": 0}
        spec = self.spec(model)
        kind = spec.get("quota")
        if kind == "claude-subscription":
            return self._claude_status(now)
        if kind == "counted":
            return self._counted_status(model, spec.get("limits") or {}, now)
        return {"state": "unknown", "source": "none"}

    def _claude_status(self, now):
        try:
            with open(self._path("claude-quota.json")) as f:
                q = json.load(f)
        except Exception:
            return {"state": "unknown", "source": "claude-subscription"}
        worst = {"state": "ok", "source": "claude-subscription"}
        if q.get("status") == "rejected":
            return {"state": "exhausted", "source": "claude-subscription", "resets_at": q.get("resetsAt"), "window": q.get("rateLimitType")}
        for name, w in (q.get("windows") or {}).items():
            util = w.get("utilization")
            if util is None:
                continue
            reset = w.get("resetsAt")
            samples = [(s[0], s[1]) for s in q.get("samples", {}).get(name, []) if s[2] == reset]
            rate = _slope(samples)
            eta = ((1 - util) / rate / 60) if rate else None
            if reset and eta is not None and now + eta * 60 > reset:
                eta = None  # the window resets before it would run out
            st = _state(1 - util, eta)
            if q.get("status") == "allowed_warning" and RANK[st] < RANK["warn"]:
                st = "warn"
            cand = {"state": st, "source": "claude-subscription", "window": name, "utilization": util,
                    "resets_at": reset, "eta_min": round(eta, 1) if eta is not None else None}
            if (RANK[st], util) >= (RANK[worst["state"]], worst.get("utilization", -1)):
                worst = cand  # worst state first, then the most used window
        return worst

    def _counted_status(self, model, limits, now):
        q = self.calls.get(model, deque())
        if not limits:
            return {"state": "unknown", "source": "counted", "requests_24h": len(q)}
        checks = []
        last_min = [x for x in q if x[0] >= now - 60]
        day = list(q)
        recent = [x for x in q if x[0] >= now - 600]  # burn rate over 10 minutes
        req_rate = len(recent) / 10 if recent else 0  # per minute
        tok_rate = sum(t for _, t in recent) / 10 if recent else 0
        if limits.get("rpm"):
            checks.append(("rpm", 1 - len(last_min) / limits["rpm"], None, now + 60))
        if limits.get("rpd"):
            rem = limits["rpd"] - len(day)
            checks.append(("rpd", rem / limits["rpd"], (rem / req_rate) if req_rate else None, None))
        if limits.get("tpd"):
            used = sum(t for _, t in day)
            rem = limits["tpd"] - used
            checks.append(("tpd", rem / limits["tpd"], (rem / tok_rate) if tok_rate else None, None))
        worst = {"state": "ok", "source": "counted"}
        for name, frac, eta, reset in checks:
            st = _state(max(frac, 0) if frac > 0 else 0, eta)
            if RANK[st] >= RANK[worst["state"]]:
                worst = {"state": st, "source": "counted", "window": name, "remaining": round(max(frac, 0), 3),
                         "eta_min": round(eta, 1) if eta is not None else None, "resets_at": reset}
        return worst

    def snapshot(self, models) -> dict:
        return {m: self.status(m) for m in models}
