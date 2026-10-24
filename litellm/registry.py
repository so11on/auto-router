"""Model registry: per-model facts (context window, paid, quota tracker, limits) from models.yaml."""
import os

import yaml

MODELS_FILE = os.environ.get("MODELS_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "models.yaml"))

_cache = {"mtime": None, "data": None}


def _load() -> dict:
    try:
        mtime = os.path.getmtime(MODELS_FILE)
    except OSError:
        return {"defaults": {}, "models": {}}
    if _cache["mtime"] != mtime:  # re-read when the file changes, like routing.yaml
        with open(MODELS_FILE) as f:
            _cache["data"] = yaml.safe_load(f) or {}
        _cache["mtime"] = mtime
    return _cache["data"]


def spec(model_name: str) -> dict:
    data = _load()
    base = dict(data.get("defaults") or {})
    base.update((data.get("models") or {}).get(model_name) or {})
    base.setdefault("context", 128000)
    base.setdefault("paid", False)
    base.setdefault("quota", "counted")
    base.setdefault("limits", {})
    return base


def context_window(model_name: str) -> int:
    return int(spec(model_name)["context"])


def is_paid(model_name: str) -> bool:
    return bool(spec(model_name)["paid"])


def names() -> list:
    return list((_load().get("models") or {}).keys())
