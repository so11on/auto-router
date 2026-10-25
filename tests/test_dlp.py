"""SEC-08: DLP detection, masking and failure behaviour."""
import copy
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "litellm"))
import dlp  # noqa: E402

S = {"mask_secrets": "on", "mask_pii": "off", "images": "trusted_only", "fail_mode": "closed"}
S_PII = {**S, "mask_pii": "on"}
FAKE_OPENAI = "sk-proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"
FAKE_GOOGLE = "AIza" + "Sy" + "A" * 33
GOOD_CPF, BAD_CPF = "529.982.247-25", "123.456.789-00"
GOOD_CNPJ = "11.222.333/0001-81"
GOOD_CARD = "4539 1488 0343 6467"


def scan(text, s=S, known=()):
    data = {"messages": [{"role": "user", "content": text}]}
    res = dlp.scan_and_mask(data, s, known=list(known))
    return res, data["messages"][0]["content"]


class Secrets(unittest.TestCase):
    def test_prefixed_keys_are_masked(self):
        for raw, kind in [(FAKE_OPENAI, "openai_key"), (FAKE_GOOGLE, "google_key"), ("ghp_" + "a" * 36, "github_token"),
                          ("gsk_" + "b" * 30, "groq_key"), ("AKIA" + "ABCDEFGHIJKLMNOP", "aws_key"),
                          ("nvapi-" + "c" * 30, "nvidia_key"), ("sk-ant-" + "d" * 30, "anthropic_key")]:
            res, out = scan(f"before {raw} after")
            self.assertEqual(res.secrets, 1, raw)
            self.assertIn(kind, res.kinds)
            self.assertEqual(out, "before «SECRET_1:" + kind + "» after")
            self.assertTrue(res.sensitive)

    def test_pem_jwt_connection_string_assignment_and_env_line(self):
        res, out = scan("-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----")
        self.assertEqual(res.kinds.get("pem_private_key"), 1)
        self.assertNotIn("MIIEabc", out)
        res, out = scan("auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")
        self.assertIn("jwt", res.kinds)
        res, out = scan("DATABASE_URL=postgres://admin:hunter2secret@db.internal:5432/app")
        self.assertIn("connection_string", res.kinds)
        self.assertNotIn("hunter2secret", out)
        res, out = scan("password: 'correct-horse-battery'")
        self.assertIn("assigned_secret", res.kinds)
        self.assertNotIn("correct-horse-battery", out)
        res, out = scan("STRIPE_SECRET_KEY=abcd1234efgh5678")
        self.assertEqual(res.secrets, 1)
        self.assertIn("STRIPE_SECRET_KEY=", out)
        self.assertNotIn("abcd1234efgh5678", out)

    def test_same_value_same_placeholder_within_a_request(self):
        res, out = scan(f"a {FAKE_OPENAI} b {FAKE_OPENAI} c {FAKE_GOOGLE}")
        self.assertEqual(out.count("«SECRET_1:openai_key»"), 2)
        self.assertIn("«SECRET_2:google_key»", out)

    def test_project_secrets_are_masked_wherever_they_appear(self):
        res, out = scan("my gateway key is zz-local-master-value-123 ok", known=["zz-local-master-value-123"])
        self.assertEqual(res.kinds, {"project_secret": 1})
        self.assertNotIn("zz-local-master-value-123", out)

    def test_entropy_only_near_a_keyword(self):
        blob = "Zk9fQ2x1c3RlclNlY3JldFZhbHVlMTIzNDU2Nzg5MEFCQ0Q"
        res, _ = scan(f"the token is {blob}")
        self.assertGreaterEqual(res.secrets, 1)
        res, _ = scan(f"commit hash {blob} was merged")
        self.assertEqual(res.secrets, 0)

    def test_idempotent(self):
        data = {"messages": [{"role": "user", "content": f"x {FAKE_OPENAI}"}]}
        dlp.scan_and_mask(data, S, known=[])
        once = copy.deepcopy(data)
        res = dlp.scan_and_mask(data, S, known=[])
        self.assertEqual(data, once)
        self.assertEqual(res.secrets, 0)

    def test_placeholders_and_examples_do_not_trigger(self):
        for text in ["api_key = 'your-key-here'", "token: ${GITHUB_TOKEN}", "password: changeme", "secret=<redacted>",
                     "OPENAI_API_KEY=xxxxxxxx", "api_key=${API_KEY}"]:
            res, _ = scan(text)
            self.assertEqual(res.secrets, 0, text)


class Pii(unittest.TestCase):
    def test_valid_documents_are_detected_invalid_are_not(self):
        res, _ = scan(f"cpf {GOOD_CPF} e cnpj {GOOD_CNPJ}")
        self.assertEqual(res.kinds, {"cnpj": 1, "cpf": 1})
        self.assertTrue(res.sensitive)
        for bad in (BAD_CPF, "111.111.111-11", "000.000.000-00"):
            self.assertEqual(scan(f"cpf {bad}")[0].pii, 0, bad)

    def test_card_luhn_and_test_cards(self):
        self.assertEqual(scan(f"card {GOOD_CARD}")[0].kinds, {"card": 1})
        self.assertEqual(scan("card 4111111111111111")[0].pii, 0)
        self.assertEqual(scan("order 1234567890123456")[0].pii, 0)

    def test_email_phone_and_fake_domains(self):
        res, _ = scan("write to maria.silva@empresa.com.br or (11) 98765-4321")
        self.assertEqual(res.kinds, {"email": 1, "phone": 1})
        self.assertEqual(scan("contact test@example.com")[0].pii, 0)

    def test_pii_stays_unless_masking_is_on(self):
        res, out = scan(f"cpf {GOOD_CPF}")
        self.assertIn(GOOD_CPF, out)
        self.assertTrue(res.sensitive)
        res, out = scan(f"cpf {GOOD_CPF}", S_PII)
        self.assertNotIn(GOOD_CPF, out)
        self.assertIn("«CPF_1»", out)

    def test_ordinary_code_and_numbers_are_not_sensitive(self):
        res, _ = scan("def add(a, b):\n    return a + b  # 2026-10-24, build 20261024, port 4000, version 1.2.3")
        self.assertFalse(res.sensitive)


class Shapes(unittest.TestCase):
    def test_all_message_roles_tool_calls_and_responses_api(self):
        data = {"messages": [
            {"role": "system", "content": f"key {FAKE_OPENAI}"},
            {"role": "assistant", "content": None, "tool_calls": [{"id": "1", "type": "function", "function": {"name": "run", "arguments": f'{{"k": "{FAKE_GOOGLE}"}}'}}]},
            {"role": "tool", "tool_call_id": "1", "content": f"ghp_{'e' * 36}"},
            {"role": "user", "content": [{"type": "text", "text": f"again {FAKE_OPENAI}"}]}]}
        res = dlp.scan_and_mask(data, S, known=[])
        self.assertEqual(res.secrets, 4)
        flat = repr(data)
        for leaked in (FAKE_OPENAI, FAKE_GOOGLE, "ghp_" + "e" * 36):
            self.assertNotIn(leaked, flat)
        self.assertEqual(data["messages"][1]["tool_calls"][0]["id"], "1", "ids and roles are never rewritten")
        resp = {"input": [{"role": "user", "content": f"x {FAKE_OPENAI}"}], "instructions": f"y {FAKE_GOOGLE}"}
        self.assertEqual(dlp.scan_and_mask(resp, S, known=[]).secrets, 2)
        self.assertNotIn(FAKE_OPENAI, repr(resp))

    def test_images_make_the_request_sensitive_unless_ignored(self):
        data = {"messages": [{"role": "user", "content": [{"type": "text", "text": "look"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]}]}
        res = dlp.scan_and_mask(copy.deepcopy(data), S, known=[])
        self.assertTrue(res.has_image and res.sensitive)
        res = dlp.scan_and_mask(copy.deepcopy(data), {**S, "images": "ignore"}, known=[])
        self.assertTrue(res.has_image and not res.sensitive)

    def test_scanner_failure_is_closed_by_default(self):
        class Boom(dict):
            def __getitem__(self, k):
                raise RuntimeError("boom")
        data = {"messages": [{"role": "user", "content": "hello"}]}
        orig = dlp._Masker.value
        dlp._Masker.value = lambda self, v: (_ for _ in ()).throw(RuntimeError("boom"))
        try:
            res = dlp.scan_and_mask(data, S, known=[])
            self.assertTrue(res.error and res.sensitive)
            self.assertEqual(data["messages"][0]["content"], "hello")
            self.assertFalse(dlp.scan_and_mask(data, {**S, "fail_mode": "open"}, known=[]).sensitive)
        finally:
            dlp._Masker.value = orig

    def test_public_result_has_counts_only(self):
        res, _ = scan(f"{FAKE_OPENAI} and {GOOD_CPF}")
        pub = res.public()
        self.assertEqual(set(pub), {"secrets", "pii", "kinds", "has_image", "sensitive", "error"})
        self.assertNotIn(FAKE_OPENAI, repr(pub))

    def test_known_secrets_from_environment(self):
        env = {"LITELLM_MASTER_KEY": "sk-master-abcdef123456", "BRIDGE_KEY": "bridgekey9999", "CLAUDE_PRIMARY": "cli", "SHORT_KEY": "abc"}
        self.assertEqual(set(dlp.known_secrets(env)), {"sk-master-abcdef123456", "bridgekey9999"})


if __name__ == "__main__":
    unittest.main()
