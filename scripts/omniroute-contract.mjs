#!/usr/bin/env node
// OmniRoute contract verifier (SEC-16). Exercises exactly the surface listed in docs/OMNIROUTE-CONTRACT.md against an
// instance and reports ok/fail per item. It sends no real data: a throwaway combo/connection, a fixed harmless prompt.
//   node scripts/omniroute-contract.mjs <base_url> --password <initial password> [--key <api key>] [--chat <combo>]
// Exit code is non-zero when any required item fails. Library use: import { runContract }.
import { pathToFileURL } from "node:url";

const J = async (base, p, { method = "GET", body, headers = {}, timeout = 15000 } = {}) => {
  try {
    const r = await fetch(base + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, headers: r.headers, text, json };
  } catch (e) { return { status: 0, headers: new Headers(), text: String(e.message || e), json: null }; }
};

export async function runContract({ base, password, key = null, chat = null, timeout = 15000 }) {
  const out = [];
  const item = (name, ok, detail = "", required = true) => out.push({ name, ok: Boolean(ok), detail: ok ? "" : detail, required });
  let cookie = "", apiKey = key;
  const api = (p, o = {}) => J(base, p, { ...o, timeout, headers: { cookie, ...(o.headers || {}) } });

  const login = await J(base, "/api/auth/login", { method: "POST", body: { password }, timeout });
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  item("login: POST /api/auth/login → 200 + session cookie", login.status === 200 && cookie, `status ${login.status}, cookie ${cookie ? "yes" : "no"}`);
  if (!cookie) return out; // nothing else can be checked

  if (!apiKey) {
    const k = await api("/api/keys", { method: "POST", body: { name: "ar-contract" } });
    apiKey = k.json?.key || null;
    item("api key: POST /api/keys → { key }", apiKey, `status ${k.status}: ${k.text.slice(0, 80)}`);
  } else item("api key: provided, creation not exercised", true);

  const provs = await api("/api/providers");
  item("providers: GET /api/providers → { connections: [] }", provs.status === 200 && Array.isArray(provs.json?.connections), `status ${provs.status}, shape ${provs.json ? Object.keys(provs.json) : "not JSON"}`);

  const combos = await api("/api/combos");
  item("combos: GET /api/combos → { combos: [] }", combos.status === 200 && Array.isArray(combos.json?.combos), `status ${combos.status}`);
  const made = await api("/api/combos", { method: "POST", body: { name: "ar-contract-test", strategy: "priority", models: ["ar-contract/none"] } });
  const comboId = made.json?.id ?? made.json?.combo?.id ?? null; // 2026-10-25: top-level id (a combo needs >= 1 model)
  item("combos: POST /api/combos → id", made.status < 300 && comboId, `status ${made.status}: ${made.text.slice(0, 80)}`);
  if (comboId) {
    const put = await api(`/api/combos/${comboId}`, { method: "PUT", body: { models: ["ar-contract/none"] } });
    item("combos: PUT /api/combos/:id", put.status < 300, `status ${put.status}`);
    const del = await api(`/api/combos/${comboId}`, { method: "DELETE" });
    item("combos: DELETE /api/combos/:id", del.status < 300, `status ${del.status}`, false);
  }

  if (apiKey) {
    const bearer = { authorization: `Bearer ${apiKey}` };
    const models = await J(base, "/v1/models", { headers: bearer, timeout });
    item("models: GET /v1/models → { data: [] }", models.status === 200 && Array.isArray(models.json?.data), `status ${models.status}`);
    const unknown = await J(base, "/v1/chat/completions", { method: "POST", headers: bearer, timeout,
      body: { model: "ar-contract-does-not-exist", max_tokens: 1, messages: [{ role: "user", content: "ok" }] } });
    item("chat: unknown model → JSON error, not a crash", unknown.status >= 400 && unknown.status < 500 && unknown.json, `status ${unknown.status}, JSON ${unknown.json ? "yes" : "no"}`);
    if (chat) {
      const r = await J(base, "/v1/chat/completions", { method: "POST", headers: bearer, timeout: 45000,
        body: { model: chat, max_tokens: 50, messages: [{ role: "user", content: "Reply with one word: ok" }] } });
      const m = r.json?.choices?.[0]?.message;
      item(`chat: combo ${chat} answers (OpenAI shape)`, r.status === 200 && (m?.content || m?.reasoning || m?.reasoning_content), `status ${r.status}`);
      const hasHeaders = Boolean(r.headers.get("x-omniroute-provider") && r.headers.get("x-omniroute-model"));
      item("headers: x-omniroute-provider / x-omniroute-model present (optional: the footer degrades without them)", hasHeaders, "missing", false);
    }
  }
  return out;
}

export const failed = (results) => results.filter((r) => !r.ok && r.required);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
  const base = args.find((a) => /^https?:\/\//.test(a));
  if (!base || !flag("password")) { console.error("usage: omniroute-contract.mjs <base_url> --password <pw> [--key <api key>] [--chat <combo>]"); process.exit(2); }
  const res = await runContract({ base: base.replace(/\/$/, ""), password: flag("password"), key: flag("key"), chat: flag("chat") });
  for (const r of res) console.log(`${r.ok ? "ok    " : r.required ? "FAILED" : "warn  "} ${r.name}${r.detail ? "  — " + r.detail : ""}`);
  process.exit(failed(res).length ? 1 : 0);
}
