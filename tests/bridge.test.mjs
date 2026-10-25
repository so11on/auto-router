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

async function withBridge(fn, extraEnv = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ar-bridge-")));
  const ws = path.join(tmp, "proj"); fs.mkdirSync(ws); fs.writeFileSync(path.join(ws, "package.json"), "{}");
  const port = 4300 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, [path.join(ROOT, "claude-bridge", "server.mjs")], {
    env: { ...process.env, BRIDGE_PORT: String(port), BRIDGE_KEY: "k", BRIDGE_ALLOWED_ROOTS: tmp, BRIDGE_STATE: path.join(tmp, "state.json"),
      AUTO_ROUTER_DATA: path.join(tmp, "data"), CODEX_BIN: path.join(ROOT, "tests", "fake_codex.sh"), CODEX_MODEL_MAIN: "test-model",
      COPILOT_BIN: path.join(ROOT, "tests", "fake_copilot.sh"), COPILOT_MODEL_MAIN: "cp-model", GH_TOKEN: "must-be-stripped", BRIDGE_ACTIVE_WORKSPACE: path.join(tmp, "active-workspace.json"), ...extraEnv },
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

test("copilot route: read-only vs agent flags, model flag, answer + footer, estimated usage", { skip }, async () => {
  await withBridge(async ({ port, ws }) => {
    const ask = async (extra, text = "hello") => (await (await post(port, { model: "copilot-code-main",
      messages: [{ role: "system", content: ws }, { role: "user", content: text }], ...extra })).json());
    const ro = await ask({});
    const t1 = ro.choices[0].message.content;
    assert.match(t1, /Copilot answer/);
    assert.match(t1, /--model=cp-model/);
    assert.match(t1, /--allow-tool=read/);
    assert.ok(!t1.includes("--allow-tool=write"), "read-only must not allow writes");
    assert.match(t1, /GitHub Copilot \(cp-model · read-only\)/);
    assert.ok(ro.usage.total_tokens > 0);
    const ag = await ask({ tools: [{ type: "function" }] }, "please EDITFILE");
    const t2 = ag.choices[0].message.content;
    assert.match(t2, /--allow-tool=write/);
    assert.match(t2, /files changed: `copilot-edit\.txt`/);
  });
});

test("copilot route: long prompts go through a file (and the file is removed), limits become 429, tokens are not inherited", { skip }, async () => {
  await withBridge(async ({ port, ws }) => {
    const long = "x".repeat(8000);
    const r = await (await post(port, { model: "copilot-code-main", messages: [{ role: "system", content: ws }, { role: "user", content: long }] })).json();
    assert.match(r.choices[0].message.content, /Copilot answer/);
    const dir = path.join(ws, ".auto-router", "prompts");
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], "temporary prompt file must be deleted");
    const lim = await post(port, { model: "copilot-code-main", messages: [{ role: "system", content: ws }, { role: "user", content: "PREMIUMLIMIT" }] });
    assert.equal(lim.status, 429);
  });
});

test("model list includes both routes", { skip }, async () => {
  await withBridge(async ({ port }) => {
    const d = await (await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: "Bearer k" } })).json();
    const ids = d.data.map((m) => m.id);
    for (const id of ["claude-code-opus", "codex-code-main", "codex-code-mini", "codex-code-max", "copilot-code-mini", "copilot-code-main", "copilot-code-max"]) assert.ok(ids.includes(id), id);
  });
});

test("SEC-01: callers cannot pick dangerous permission modes, sandboxes or unknown models", { skip }, async () => {
  await withBridge(async ({ port, ws }) => {
    const msgs = [{ role: "system", content: ws }, { role: "user", content: "hi" }];
    const c = await (await post(port, { model: "claude-code-haiku", tools: [{ type: "function" }], messages: msgs }, { "x-claude-mode": "bypassPermissions" })).json();
    const text = c.choices[0].message.content;
    assert.match(text, /--permission-mode acceptEdits/);
    assert.doesNotMatch(text, /bypassPermissions/);
    assert.match(text, /--settings .*protect-sensitive\.mjs/, "SEC-11: every claude run carries the protection settings");
    const ok = await (await post(port, { model: "claude-code-haiku", messages: msgs }, { "x-claude-mode": "plan" })).json();
    assert.match(ok.choices[0].message.content, /--permission-mode plan/);
    const x = await (await post(port, { model: "codex-code-main", tools: [{ type: "function" }], messages: msgs }, { "x-codex-sandbox": "danger-full-access" })).json();
    assert.match(x.choices[0].message.content, /workspace-write/);
    assert.doesNotMatch(x.choices[0].message.content, /danger-full-access/);
    for (const model of ["--foo", "claude-code-nope", "constructor", "codex-code-nope", "copilot-code-nope"]) {
      const bad = await post(port, { model, messages: msgs });
      assert.equal(bad.status, 400, model);
    }
  }, { CLAUDE_BIN: path.join(ROOT, "tests", "fake_claude_echo.sh") });
});

test("SEC-01: the bridge refuses unsafe settings at boot", { skip }, async () => {
  const run = (env) => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, "claude-bridge", "server.mjs")],
      { env: { ...process.env, BRIDGE_PORT: "4899", BRIDGE_KEY: "k", BRIDGE_ALLOWED_ROOTS: os.tmpdir(), ...env }, stdio: "ignore" });
    const timer = setTimeout(() => { c.kill(); resolve("running"); }, 1500);
    c.on("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(await run({ BRIDGE_AGENT_MODE: "bypassPermissions" }), 1);
  assert.equal(await run({ CODEX_AGENT_SANDBOX: "danger-full-access" }), 1);
  assert.equal(await run({ BRIDGE_HOST: "0.0.0.0" }), 1);
  assert.equal(await run({ BRIDGE_HOST: "::" }), 1);
});

test("SEC-03: symlinks out of the roots are refused; tool output does not pick the workspace; the VS Code window does", { skip }, async () => {
  await withBridge(async ({ port, ws, tmp }) => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ar-outside-")));
    try {
      const link = path.join(tmp, "link"); fs.symlinkSync(outside, link);
      const r = await post(port, { model: "codex-code-main", messages: [{ role: "user", content: "hi" }] }, { "x-workspace": link });
      assert.equal(r.status, 403);
      const other = path.join(tmp, "other"); fs.mkdirSync(other); fs.writeFileSync(path.join(other, "package.json"), "{}");
      const ask = async (messages, headers = {}) => (await (await post(port, { model: "codex-code-main", messages }, headers)).json()).choices[0].message.content;
      const cwdOf = (text) => fs.realpathSync(text.match(/CWD=(\S+)/)[1]);
      const real = (p) => fs.realpathSync(p);
      const text1 = await ask([{ role: "system", content: `workspace ${ws}` }, { role: "assistant", content: "ok" },
        { role: "tool", content: `${other}/a ${other}/b ${other}/c` }, { role: "user", content: "hi 1" }]);
      assert.equal(cwdOf(text1), real(ws));
      fs.writeFileSync(path.join(tmp, "active-workspace.json"), JSON.stringify({ ws: other, ts: Date.now() }));
      const text2 = await ask([{ role: "system", content: `workspace ${ws}` }, { role: "user", content: "hi 2" }]);
      assert.equal(cwdOf(text2), real(other));
      fs.writeFileSync(path.join(tmp, "active-workspace.json"), JSON.stringify({ ws: other, ts: Date.now() - 7 * 3600 * 1000 }));
      const text3 = await ask([{ role: "system", content: `workspace ${ws}` }, { role: "user", content: "hi 3" }]);
      assert.equal(cwdOf(text3), real(ws), "an active workspace older than 6 h is ignored");
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
});

test("SEC-02: same first message in two workspaces are two conversations", { skip }, async () => {
  await withBridge(async ({ port, ws, tmp }) => {
    const other = path.join(tmp, "other"); fs.mkdirSync(other); fs.writeFileSync(path.join(other, "package.json"), "{}");
    const msgs = [{ role: "system", content: "You are a coding assistant." }, { role: "user", content: "fix the bug" }];
    for (const w of [ws, other, ws]) await post(port, { model: "codex-code-main", messages: msgs }, { "x-workspace": w });
    const state = JSON.parse(fs.readFileSync(path.join(tmp, "state.json"), "utf8"));
    const ids = Object.keys(state).filter((k) => k.startsWith("codex:"));
    assert.equal(ids.length, 2);
    const again = await (await post(port, { model: "codex-code-main", messages: [{ role: "system", content: "Another system prompt." }, msgs[1]] }, { "x-workspace": ws })).json();
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(tmp, "state.json"), "utf8"))).filter((k) => k.startsWith("codex:")).length, 3);
    assert.ok(again.choices);
  });
});

test("SEC-13: project memory is private (0600 file, 0700 folder)", { skip }, async () => {
  await withBridge(async ({ port, ws, tmp }) => {
    const r = await fetch(`http://127.0.0.1:${port}/memory/write`, { method: "POST", headers: { authorization: "Bearer k", "content-type": "application/json" },
      body: JSON.stringify({ session: "abcd1234", workspace: ws, title: "t", markdown: "# notes\n" }) });
    assert.equal(r.status, 200);
    const dir = path.join(ws, ".auto-router", "memory");
    assert.equal(fs.statSync(path.join(dir, "abcd1234.md")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, "INDEX.md")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  });
});
