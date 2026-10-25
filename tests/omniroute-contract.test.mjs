// SEC-16: the contract verifier against a fake OmniRoute that misbehaves in the ways a real upgrade might.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runContract, failed } from "../scripts/omniroute-contract.mjs";

function fake(mode) {
  const combos = new Map();
  const srv = http.createServer((req, res) => {
    let raw = ""; req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
      if (mode === "slow") return setTimeout(() => send(200, {}), 3000);
      if (mode === "invalid-json") return send(200, "<html>not json</html>");
      const url = req.url;
      if (url === "/api/auth/login") return mode === "login-changed" ? send(200, { token: "x" }) : send(200, { ok: true }, { "set-cookie": "sid=abc; Path=/" });
      if (url === "/api/keys") return send(200, { key: "sk-fake" });
      if (url === "/api/providers") return send(200, { connections: [] });
      if (url === "/api/combos" && req.method === "GET") return send(200, { combos: [...combos.values()] });
      if (url === "/api/combos" && req.method === "POST") { const c = { id: "c1", ...JSON.parse(raw) }; combos.set("c1", c); return send(201, { combo: c }); }
      if (url === "/api/combos/c1") { if (req.method === "DELETE") combos.delete("c1"); return send(200, {}); }
      if (url === "/v1/models") return send(200, { data: mode === "empty-pool" ? [] : [{ id: "free-fast" }] });
      if (url === "/v1/chat/completions") {
        const body = JSON.parse(raw || "{}");
        if (body.model === "free-fast") {
          if (mode === "retired") return send(410, { error: { message: "model retired" } });
          return send(200, { choices: [{ message: { content: "ok" } }] }, mode === "no-headers" ? {} : { "x-omniroute-provider": "groq", "x-omniroute-model": "gpt-oss" });
        }
        return send(404, { error: { message: "unknown model" } });
      }
      send(404, "nope");
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}
const withFake = async (mode, fn) => { const f = await fake(mode); try { return await fn(f.base); } finally { f.srv.close(); } };

test("a healthy OmniRoute passes every item", async () => {
  await withFake("ok", async (base) => {
    const r = await runContract({ base, password: "pw", chat: "free-fast" });
    assert.deepEqual(failed(r), []);
    assert.ok(r.length >= 9);
  });
});

test("missing x-omniroute headers are tolerated (warning only)", async () => {
  await withFake("no-headers", async (base) => {
    const r = await runContract({ base, password: "pw", chat: "free-fast" });
    assert.deepEqual(failed(r), []);
    assert.equal(r.filter((x) => !x.ok).length, 1);
  });
});

test("a changed login response, a retired model, bad JSON and a slow server are all reported as failures", async () => {
  await withFake("login-changed", async (base) => assert.equal(failed(await runContract({ base, password: "pw" })).length, 1));
  await withFake("retired", async (base) => assert.ok(failed(await runContract({ base, password: "pw", chat: "free-fast" })).some((x) => /combo free-fast answers/.test(x.name))));
  await withFake("invalid-json", async (base) => assert.ok(failed(await runContract({ base, password: "pw" })).length > 0));
  await withFake("slow", async (base) => assert.ok(failed(await runContract({ base, password: "pw", timeout: 300 })).length > 0));
});

test("an empty pool is a contract success but visible as no models", async () => {
  await withFake("empty-pool", async (base) => {
    const r = await runContract({ base, password: "pw" });
    assert.deepEqual(failed(r), []);
  });
});
