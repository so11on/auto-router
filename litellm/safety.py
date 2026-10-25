"""Safety settings and privacy classes (SEC-07).

SAFETY_MODE=on|off          on (default): models classed `unsafe` are removed from every route, fallback, pin and internal call.
SENSITIVE_GUARD=on|off      on (default): prompts holding secrets / personal data only go to classes allowed for sensitive content.
SENSITIVE_ALLOWED_CLASSES   classes that may receive sensitive content (default: trusted). `restricted` and `unsafe` can never be added.
A model whose class is unknown is `unsafe`.
"""
import json
import os

import registry

CLASSES = ("trusted", "no_retention", "restricted", "unsafe")  # most to least trustworthy
NEVER_SENSITIVE = ("restricted", "unsafe")


def _env(name: str, default: str) -> str:
    v = os.environ.get(name)
    return default if v is None or v.strip() == "" else v.strip()


def data_dir() -> str:
    return os.environ.get("AR_DATA_DIR") or os.path.dirname(os.environ.get("USAGE_FILE", "/app/data/usage.jsonl"))


def settings() -> dict:
    allowed, warnings = set(), []
    for c in _env("SENSITIVE_ALLOWED_CLASSES", "trusted").split(","):
        c = c.strip().lower()
        if not c:
            continue
        if c not in CLASSES:
            warnings.append(f"SENSITIVE_ALLOWED_CLASSES: unknown class '{c}' ignored")
        elif c in NEVER_SENSITIVE:
            warnings.append(f"SENSITIVE_ALLOWED_CLASSES: '{c}' can never receive sensitive content and was removed")
        else:
            allowed.add(c)
    return {
        "safety_mode": _env("SAFETY_MODE", "on").lower(),
        "sensitive_guard": _env("SENSITIVE_GUARD", "on").lower(),
        "sensitive_allowed": allowed or {"trusted"},
        "mask_secrets": _env("SENSITIVE_MASK_SECRETS", "on").lower(),
        "mask_pii": _env("SENSITIVE_MASK_PII", "off").lower(),
        "images": _env("SENSITIVE_IMAGES", "trusted_only").lower(),
        "fail_mode": _env("DLP_FAIL_MODE", "closed").lower(),
        "warnings": warnings,
    }


def worst(classes) -> str:
    classes = [c if c in CLASSES else "unsafe" for c in classes]
    return max(classes, key=CLASSES.index) if classes else "unsafe"


def pool_members() -> dict:
    """{combo: [{"id", "privacy"}]} written by `node ar.mjs omniroute`; empty when it was never run."""
    try:
        with open(os.path.join(data_dir(), "pool-members.json")) as f:
            return json.load(f)
    except Exception:
        return {}


_POOL_COMBO = {"free-pool-fast": "free-fast", "free-pool-coding": "free-coding", "free-pool": "free-coding"}


def privacy_of(model_name: str) -> str:
    declared = registry.spec(model_name).get("privacy") if model_name in registry.names() else None
    if declared == "pool":
        members = pool_members().get(_POOL_COMBO.get(model_name, ""), [])
        return worst([m.get("privacy", "unsafe") for m in members]) if members else "unsafe"
    return declared if declared in CLASSES else "unsafe"


def allowed_by_safety(model_name: str, s: dict) -> bool:
    return s["safety_mode"] != "on" or privacy_of(model_name) != "unsafe"


def allowed_for_sensitive(model_name: str, s: dict) -> bool:
    p = privacy_of(model_name)
    return p in s["sensitive_allowed"] and p not in NEVER_SENSITIVE
