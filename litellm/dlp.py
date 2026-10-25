"""DLP (SEC-08): find secrets and personal data in a request, mask the secrets, say whether the request is sensitive.

Runs BEFORE any model sees the request (including the classifier, summaries and project memory).
Secrets are replaced by «SECRET_n:kind» (n is stable inside one request). Personal data is replaced by «CPF_n» etc. only when
SENSITIVE_MASK_PII=on; otherwise it stays but the request is flagged sensitive so the router only uses classes allowed for it.

Limits (documented in docs/SECURITY.md): regular expressions cannot find free-form passwords or secrets without a recognisable shape.
Nothing detected is ever logged: only counts and kinds leave this module.
"""
import math
import os
import re
from dataclasses import dataclass, field

MARK = "«"  # every placeholder starts with this: a masked value is never matched again


@dataclass
class DlpResult:
    secrets: int = 0
    pii: int = 0
    kinds: dict = field(default_factory=dict)
    has_image: bool = False
    sensitive: bool = False
    error: bool = False

    def public(self) -> dict:
        return {"secrets": self.secrets, "pii": self.pii, "kinds": dict(self.kinds), "has_image": self.has_image,
                "sensitive": self.sensitive, "error": self.error}


# ---------------------------------------------------------------- secrets
_PREFIXED = [
    ("pem_private_key", r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)"),
    ("anthropic_key", r"\bsk-ant-[A-Za-z0-9_-]{20,}"),
    ("openai_key", r"\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}"),
    ("openrouter_key", r"\bsk-or-[A-Za-z0-9_-]{20,}"),
    ("google_key", r"\bAIza[0-9A-Za-z_-]{35}"),
    ("github_token", r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})"),
    ("gitlab_token", r"\bglpat-[A-Za-z0-9_-]{20,}"),
    ("slack_token", r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
    ("aws_key", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    ("google_oauth", r"\bya29\.[A-Za-z0-9_-]{20,}"),
    ("stripe_key", r"\b(?:sk|rk)_live_[A-Za-z0-9]{16,}"),
    ("webhook_secret", r"\bwhsec_[A-Za-z0-9]{16,}"),
    ("sendgrid_key", r"\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}"),
    ("huggingface_token", r"\bhf_[A-Za-z0-9]{30,}"),
    ("groq_key", r"\bgsk_[A-Za-z0-9]{20,}"),
    ("nvidia_key", r"\bnvapi-[A-Za-z0-9_-]{20,}"),
    ("npm_token", r"\bnpm_[A-Za-z0-9]{30,}"),
    ("pypi_token", r"\bpypi-[A-Za-z0-9_-]{30,}"),
    ("jwt", r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}"),
    ("connection_string", r"\b[a-z][a-z0-9+.-]*://[^:\s/@]+:[^@\s/]{3,}@[^\s]+"),
]
_PREFIXED = [(k, re.compile(p)) for k, p in _PREFIXED]
_ASSIGN = re.compile(r"(?i)\b(api[_-]?key|secret|token|passw(?:or)?d|senha|pwd|auth)\b(\s*[:=]\s*)(['\"]?)([^\s'\"]{8,})")
_ENV_LINE = re.compile(r"(?m)^([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASS))(=)(\S{4,})$")
_ENTROPY = re.compile(r"(?i)(?:key|secret|token|passw|senha|pwd|auth)[^\n]{0,40}?([A-Za-z0-9+/=_-]{32,})")

_PLACEHOLDER = re.compile(r"(?i)^(?:x{3,}|\*{3,}|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|changeme|change-me|your[-_ ]?(?:api[-_ ]?)?(?:key|token|secret)[-_ ]?(?:here)?|example|placeholder|todo|none|null|true|false|undefined|redacted|password|secret|token)$")
_TEST_CARDS = {"4111111111111111", "4242424242424242", "5555555555554444", "378282246310005", "6011111111111117", "4012888888881881"}
_FAKE_DOMAINS = re.compile(r"@(?:example\.(?:com|org|net)|test|invalid|localhost)\b", re.I)

# ---------------------------------------------------------------- personal data
_CPF = re.compile(r"(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)")
_CNPJ = re.compile(r"(?<!\d)\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}(?!\d)")
_CARD = re.compile(r"(?<![\d.])(?:\d[ -]?){13,19}(?![\d.])")
_EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b")
_PHONE = re.compile(r"(?<!\d)(?:\+55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}(?!\d)")


def _entropy(s: str) -> float:
    if not s:
        return 0.0
    counts = {}
    for ch in s:
        counts[ch] = counts.get(ch, 0) + 1
    return -sum(c / len(s) * math.log2(c / len(s)) for c in counts.values())


def valid_cpf(raw: str) -> bool:
    d = re.sub(r"\D", "", raw)
    if len(d) != 11 or len(set(d)) == 1:
        return False
    for n in (9, 10):
        s = sum(int(d[i]) * (n + 1 - i) for i in range(n))
        if (s * 10 % 11) % 10 != int(d[n]):
            return False
    return True


def valid_cnpj(raw: str) -> bool:
    d = re.sub(r"\D", "", raw)
    if len(d) != 14 or len(set(d)) == 1:
        return False
    for n, weights in ((12, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]), (13, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])):
        s = sum(int(d[i]) * weights[i] for i in range(n))
        r = s % 11
        if int(d[n]) != (0 if r < 2 else 11 - r):
            return False
    return True


def luhn(raw: str) -> bool:
    d = re.sub(r"\D", "", raw)
    if not 13 <= len(d) <= 19 or d in _TEST_CARDS or len(set(d)) == 1:
        return False
    total = 0
    for i, ch in enumerate(reversed(d)):
        n = int(ch)
        if i % 2:
            n = n * 2 - 9 if n * 2 > 9 else n * 2
        total += n
    return total % 10 == 0


# ---------------------------------------------------------------- masking engine
class _Masker:
    def __init__(self, s: dict, known: list):
        self.s, self.known = s, known
        self.res = DlpResult()
        self._ids = {}

    def _num(self, family: str, value: str) -> int:
        return self._ids.setdefault((family, value), sum(1 for k in self._ids if k[0] == family) + 1)

    def _secret(self, kind: str, value: str) -> str:
        self.res.secrets += 1
        self.res.kinds[kind] = self.res.kinds.get(kind, 0) + 1
        if self.s.get("mask_secrets", "on") != "on":
            return value
        return f"{MARK}SECRET_{self._num('secret', value)}:{kind}»"

    def _pii(self, kind: str, value: str) -> str:
        self.res.pii += 1
        self.res.kinds[kind] = self.res.kinds.get(kind, 0) + 1
        if self.s.get("mask_pii", "off") != "on":
            return value
        return f"{MARK}{kind.upper()}_{self._num(kind, value)}»"

    def text(self, t: str) -> str:
        if not t or (MARK not in t and len(t) < 8):
            return t
        for secret in self.known:  # values of this project's own keys, wherever they appear
            if secret in t:
                t = t.replace(secret, self._secret("project_secret", secret))
        for kind, rx in _PREFIXED:
            t = rx.sub(lambda m, k=kind: m.group(0) if MARK in m.group(0) or _PLACEHOLDER.match(m.group(0)) else self._secret(k, m.group(0)), t)
        t = _ENV_LINE.sub(lambda m: m.group(0) if MARK in m.group(3) or _PLACEHOLDER.match(m.group(3)) else m.group(1) + m.group(2) + self._secret("env_value", m.group(3)), t)
        t = _ASSIGN.sub(lambda m: m.group(0) if m.group(4).startswith(MARK) or _PLACEHOLDER.match(m.group(4)) or m.group(4).startswith(("$", "{", "<", "%"))
                        else m.group(1) + m.group(2) + m.group(3) + self._secret("assigned_secret", m.group(4)), t)

        def ent(m):
            v = m.group(1)
            if MARK in v or _entropy(v) < 4.0 or _PLACEHOLDER.match(v):
                return m.group(0)
            return m.group(0).replace(v, self._secret("high_entropy", v))
        t = _ENTROPY.sub(ent, t)
        t = _CNPJ.sub(lambda m: self._pii("cnpj", m.group(0)) if valid_cnpj(m.group(0)) else m.group(0), t)
        t = _CPF.sub(lambda m: self._pii("cpf", m.group(0)) if valid_cpf(m.group(0)) else m.group(0), t)
        t = _CARD.sub(lambda m: self._pii("card", m.group(0)) if luhn(m.group(0)) else m.group(0), t)
        t = _EMAIL.sub(lambda m: m.group(0) if _FAKE_DOMAINS.search(m.group(0)) else self._pii("email", m.group(0)), t)
        t = _PHONE.sub(lambda m: self._pii("phone", m.group(0)) if len(re.sub(r"\D", "", m.group(0))) >= 10 and not re.fullmatch(r"\d+", m.group(0).strip()) or m.group(0).startswith(("+55", "(")) else m.group(0), t)
        return t

    def value(self, v):
        """Mask strings anywhere inside a JSON-like value; mark images."""
        if isinstance(v, str):
            return self.text(v)
        if isinstance(v, list):
            return [self.value(x) for x in v]
        if isinstance(v, dict):
            if v.get("type") in ("image_url", "input_image", "image") or "image_url" in v:
                self.res.has_image = True
            return {k: (self.value(x) if k not in ("id", "type", "role", "name", "tool_call_id") else x) for k, x in v.items()}
        return v


def known_secrets(env=None) -> list:
    """Values of this deployment's own keys (never logged), so a pasted .env value is masked wherever it appears."""
    env = os.environ if env is None else env
    out = []
    for k, v in env.items():
        if re.search(r"(_KEY|_TOKEN|_PASSWORD|_SECRET|MASTER_KEY)$", k) and len(v or "") >= 8 and v.lower() not in ("true", "false"):
            out.append(v)
    return sorted(set(out), key=len, reverse=True)


_TARGET_KEYS = ("messages", "input", "instructions", "system", "prompt")


def scan_and_mask(data: dict, s: dict, known=None) -> DlpResult:
    """Mask `data` in place. Never raises: on failure the result is sensitive (DLP_FAIL_MODE=closed) and `data` is unchanged."""
    m = _Masker(s, known_secrets() if known is None else known)
    try:
        staged = {k: m.value(data[k]) for k in _TARGET_KEYS if k in data}
        data.update(staged)
        res = m.res
        res.sensitive = res.secrets > 0 or res.pii > 0 or (res.has_image and s.get("images", "trusted_only") == "trusted_only")
        return res
    except Exception:
        res = DlpResult(error=True)
        res.sensitive = s.get("fail_mode", "closed") == "closed"
        return res
