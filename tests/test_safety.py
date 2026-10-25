"""SEC-07: privacy classes and safety settings."""
import json
import os
import sys
import tempfile
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "litellm"))
import registry  # noqa: E402
import safety  # noqa: E402
import yaml  # noqa: E402

CONFIG = yaml.safe_load(open(os.path.join(ROOT, "litellm", "config.yaml")))
NAMES = [m["model_name"] for m in CONFIG["model_list"]]


class Env:
    def __init__(self, **kv):
        self.kv, self.old = kv, {}

    def __enter__(self):
        for k, v in self.kv.items():
            self.old[k] = os.environ.get(k)
            os.environ[k] = v
        return self

    def __exit__(self, *a):
        for k, v in self.old.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)


class Safety(unittest.TestCase):
    def test_every_model_in_config_has_a_privacy_class(self):
        missing = [n for n in NAMES if not n.startswith("auto-") and registry.spec(n).get("privacy") is None]
        self.assertEqual(missing, [], "every model_name in config.yaml needs `privacy` in models.yaml")

    def test_defaults_are_safe(self):
        with Env(SAFETY_MODE="", SENSITIVE_GUARD="", SENSITIVE_ALLOWED_CLASSES=""):
            s = safety.settings()
        self.assertEqual((s["safety_mode"], s["sensitive_guard"], s["fail_mode"]), ("on", "on", "closed"))
        self.assertEqual(s["sensitive_allowed"], {"trusted"})

    def test_unsafe_removed_only_when_safety_is_on(self):
        on, off = {"safety_mode": "on"}, {"safety_mode": "off"}
        self.assertEqual(safety.privacy_of("gemini-free-flash-lite"), "unsafe")
        self.assertFalse(safety.allowed_by_safety("gemini-free-flash-lite", on))
        self.assertTrue(safety.allowed_by_safety("gemini-free-flash-lite", off))
        self.assertTrue(safety.allowed_by_safety("claude-sonnet-cli", on))

    def test_unknown_model_is_unsafe(self):
        self.assertEqual(safety.privacy_of("something-new"), "unsafe")
        self.assertFalse(safety.allowed_by_safety("something-new", {"safety_mode": "on"}))

    def test_restricted_and_unsafe_can_never_receive_sensitive_content(self):
        with Env(SENSITIVE_ALLOWED_CLASSES="trusted,no_retention,restricted,unsafe,bogus"):
            s = safety.settings()
        self.assertEqual(s["sensitive_allowed"], {"trusted", "no_retention"})
        self.assertEqual(len(s["warnings"]), 3)
        self.assertTrue(safety.allowed_for_sensitive("claude-opus-cli", s))
        self.assertTrue(safety.allowed_for_sensitive("pool-gpt-oss-120b", s))
        self.assertFalse(safety.allowed_for_sensitive("gemini-free-flash-lite", s))
        # a class forced into the set still cannot pass
        s["sensitive_allowed"] = {"trusted", "restricted", "unsafe"}
        orig = registry.spec
        registry.spec = lambda n: {"privacy": "restricted"} if n == "deepseek-x" else orig(n)
        names = registry.names
        registry.names = lambda: names() + ["deepseek-x"]
        try:
            self.assertEqual(safety.privacy_of("deepseek-x"), "restricted")
            self.assertTrue(safety.allowed_by_safety("deepseek-x", {"safety_mode": "on"}))
            self.assertFalse(safety.allowed_for_sensitive("deepseek-x", s))
        finally:
            registry.spec, registry.names = orig, names

    def test_trusted_only_by_default_blocks_free_pool_for_sensitive(self):
        s = {"sensitive_allowed": {"trusted"}, "safety_mode": "on"}
        with Env(AR_DATA_DIR=tempfile.mkdtemp()):
            self.assertFalse(safety.allowed_for_sensitive("pool-gpt-oss-120b", s))

    def test_pool_combo_takes_the_worst_member(self):
        d = tempfile.mkdtemp()
        with Env(AR_DATA_DIR=d):
            self.assertEqual(safety.privacy_of("free-pool-fast"), "unsafe", "no pool-members.json yet")
            json.dump({"free-fast": [{"id": "a", "privacy": "no_retention"}, {"id": "b", "privacy": "no_retention"}],
                       "free-coding": [{"id": "a", "privacy": "no_retention"}, {"id": "c", "privacy": "unsafe"}]},
                      open(os.path.join(d, "pool-members.json"), "w"))
            self.assertEqual(safety.privacy_of("free-pool-fast"), "no_retention")
            self.assertEqual(safety.privacy_of("free-pool-coding"), "unsafe")
            self.assertTrue(safety.allowed_by_safety("free-pool-fast", {"safety_mode": "on"}))
            self.assertFalse(safety.allowed_by_safety("free-pool-coding", {"safety_mode": "on"}))


if __name__ == "__main__":
    unittest.main()
