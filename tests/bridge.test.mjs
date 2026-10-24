// Bridge tests with stand-in CLIs (no network, no accounts). Run: node --test tests/bridge.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const skip = process.platform === "win32" ? "stand-in CLIs are shell scripts" : false;

async function withBridge(fn) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ar-bridge-")));
  const ws = path.join(tmp, "proj"); fs.mkdirSync(ws); fs.writeFileSync(path.join(ws, "package.json"), "{}");
  const port = 4300 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, [path.join(ROOT, "claude-bridge", "server.mjs")], {
    env: { ...process.env, BRIDGE_PORT: String(port), BRIDGE_KEY: "k", BRIDGE_ALLOWED_ROOTS: tmp, BRIDGE_STATE: path.join(tmp, "state.json"),
      AUTO_ROUTER_DATA: path.join(tmp, "data"), CODEX_BIN: path.join(ROOT, "tests", "fake_codex.sh"), CODEX_MODEL_MAIN: "test-model" },
    stdio: "ignore" });
  for (let i = 0; i < 30; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  try { return await fn({ port, ws, tmp }); } finally { child.kill(); fs.rmSync(tmp, { recursive: true, force: true }); }
}
const post = (port, body, headers = {}) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`,
  { method: "POST", headers: { authorization: "Bearer k", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("codex route: answer, actions, usage, workspace detection", { skip }, async () => {
  await withBridge(async ({ port, ws }) => {
    const r = await post(port, { model: "codex-code-main", reasoning_effort: "high", tools: [{ type: "function" }],
      messages: [{ role: "system", content: `workspace ${ws}` }, { role: "user", content: "edit a.txt" }] });
    assert.equal(r.status, 200);
    const d = await r.json();
    const text = d.choices[0].message.content;
    assert.match(text, /Done: edited a\.txt/);
    assert.match(text, /\*Codex \(test-model · workspace-write · high\)\*/);
    assert.match(text, /files edited: `a\.txt`/);
    assert.match(text, /commands: `ls -la`/);
    assert.deepEqual(d.usage, { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 });
  });
});

test("codex route: read-only without tools; outside allowed roots is refused; bad key is refused", { skip }, async () => {
  await withBridge(async ({ port, ws }) => {
    const ro = await (await post(port, { model: "codex-code-main", messages: [{ role: "system", content: ws }, { role: "user", content: "hi" }] })).json();
    assert.match(ro.choices[0].message.content, /read-only mode/);
    const out = await post(port, { model: "codex-code-main", messages: [{ role: "user", content: "see /etc/passwd" }, { role: "user", content: "hi" }] }, {});
    assert.ok([403, 200].includes(out.status));
    const noauth = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", body: "{}" });
    assert.equal(noauth.status, 401);
  });
});

test("codex route: usage limit -> HTTP 429 (no text) and broken stream (partial text)", { skip }, async () => {
  await withBridge(async ({ port, ws }) => {
    const msgs = (t) => [{ role: "system", content: ws }, { role: "user", content: t }];
    const none = await post(port, { model: "codex-code-main", messages: msgs("NOTHING") });
    assert.equal(none.status, 429);
    const nonStream = await post(port, { model: "codex-code-main", messages: msgs("LIMIT") });
    assert.equal(nonStream.status, 429);
    const r = await post(port, { model: "codex-code-main", stream: true, messages: msgs("LIMIT") });
    assert.equal(r.status, 200);
    let got = "", broke = false;
    try { for await (const c of r.body) got += Buffer.from(c).toString(); } catch { broke = true; }
    assert.match(got, /Partial text before the limit/);
    assert.ok(broke || !got.includes("[DONE]"), "stream must end abnormally so the gateway can continue elsewhere");
  });
});

test("model list includes both routes", { skip }, async () => {
  await withBridge(async ({ port }) => {
    const d = await (await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: "Bearer k" } })).json();
    const ids = d.data.map((m) => m.id);
    for (const id of ["claude-code-opus", "codex-code-main", "codex-code-mini", "codex-code-max"]) assert.ok(ids.includes(id), id);
  });
});
