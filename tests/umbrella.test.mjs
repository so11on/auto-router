// The umbrella (scripts/umbrella.mjs): one switch for everything, one per feature, and removal that never touches what is the person's.
// Everything runs against a temporary root and a temporary HOME; the real ~/.claude is never read or written.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createUmbrella, buildReport, auditContext, ORDER } from "../scripts/umbrella.mjs";

const REAL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function sandbox({ settings, key = true, claudeMd } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ar-umb-root-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ar-umb-home-"));
  fs.cpSync(path.join(REAL, "templates"), path.join(root, "templates"), { recursive: true });
  fs.mkdirSync(path.join(root, "gateway"), { recursive: true });
  fs.copyFileSync(path.join(REAL, "gateway", "features.defaults.json"), path.join(root, "gateway", "features.defaults.json"));
  if (key) fs.writeFileSync(path.join(root, ".env"), "GEMINI_API_KEY=test-value-not-a-real-key\n");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  if (settings) fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify(settings, null, 2));
  if (claudeMd) fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), claudeMd);
  const calls = [];
  const actions = {
    gatewayInstall: async () => { calls.push("gatewayInstall"); return true; }, gatewayUninstall: async () => { calls.push("gatewayUninstall"); return true; },
    gatewayHealthy: async () => calls.includes("gatewayInstall") && !calls.includes("gatewayUninstall"),
    claudeCodeOn: async () => { calls.push("claudeCodeOn"); return true; }, claudeCodeOff: async () => { calls.push("claudeCodeOff"); return true; },
  };
  const u = createUmbrella({ root, home, actions, say: () => {} });
  const settingsOf = () => JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  return { root, home, u, calls, settingsOf };
}

const USER_SETTINGS = {
  model: "opus", effortLevel: "medium",
  hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "/usr/bin/python3 /somewhere/their-own-hook.py" }] }], Stop: [{ matcher: "", hooks: [{ type: "command", command: "their-stop" }] }] },
  permissions: { allow: ["Bash(git status)"] },
  enabledPlugins: { "x@y": true },
};

test("defaults: the umbrella is off and every feature is off (the repository is opt-in)", () => {
  const d = JSON.parse(fs.readFileSync(path.join(REAL, "gateway", "features.defaults.json"), "utf8"));
  assert.equal(d.enabled, false);
  assert.deepEqual(Object.keys(d.features).sort(), [...ORDER].sort());
  assert.ok(Object.values(d.features).every((v) => v === false));
});

test("turning features on installs them and leaves the person's own hooks, permissions and plugins alone", async () => {
  const s = sandbox({ settings: USER_SETTINGS });
  for (const n of ["token_hooks", "gemini_tools", "haiku_subagents", "statusline"]) await s.u.set(n, true);
  assert.equal((await s.u.set("token_hooks", true)), "wanted (the umbrella is off: node ar.mjs on)");
  await s.u.on();
  const cur = s.settingsOf();
  assert.equal(cur.hooks.PreToolUse.length, 2);
  assert.ok(cur.hooks.PreToolUse[0].hooks[0].command.includes("their-own-hook.py"));
  assert.ok(cur.hooks.PreToolUse[1].hooks[0].command.includes(path.join(".auto-router", "hooks")));
  assert.ok(cur.permissions.allow.includes("Bash(git status)"));
  assert.ok(cur.permissions.allow.some((r) => r.endsWith("ar.mjs gemini *)")));
  assert.ok(cur.statusLine.command.includes("statusline.mjs"));
  assert.ok(fs.existsSync(path.join(s.home, ".claude", "skills", "gemini-offload", "SKILL.md")));
  assert.ok(fs.readFileSync(path.join(s.home, ".claude", "skills", "gemini-offload", "SKILL.md"), "utf8").includes(s.root), "the root is filled in");
  assert.ok(fs.existsSync(path.join(s.home, ".claude", "agents", "ar-verbose.md")));
});

test("off removes exactly what was installed: the settings come back to what the person had", async () => {
  const s = sandbox({ settings: USER_SETTINGS, claudeMd: "# My notes\nkeep this\n" });
  for (const n of ORDER) if (!["gateway", "claude_code", "vscode_status", "legacy_stack"].includes(n)) await s.u.set(n, true);
  await s.u.on();
  assert.ok(fs.readFileSync(path.join(s.home, ".claude", "CLAUDE.md"), "utf8").includes("auto-router:begin compact"));
  await s.u.off();
  const cur = s.settingsOf();
  assert.deepEqual(cur.hooks, USER_SETTINGS.hooks);
  assert.deepEqual(cur.permissions, USER_SETTINGS.permissions);
  assert.equal(cur.statusLine, undefined);
  assert.equal(cur.outputStyle, undefined);
  assert.equal(cur.model, "opus");
  assert.equal(fs.readFileSync(path.join(s.home, ".claude", "CLAUDE.md"), "utf8"), "# My notes\nkeep this\n");
  assert.ok(!fs.existsSync(path.join(s.home, ".claude", "skills", "gemini-offload")));
  assert.ok(!fs.existsSync(path.join(s.home, ".claude", "agents", "ar-verbose.md")));
  assert.equal((await s.u.list()).enabled, false);
  assert.ok((await s.u.list()).rows.every((r) => !r.installed || ["resume_on_reset", "notifications"].includes(r.name)));
});

test("off always puts Claude Code back first and the gateway last", async () => {
  const s = sandbox({ settings: USER_SETTINGS });
  await s.u.off();
  assert.ok(s.calls.indexOf("claudeCodeOff") < s.calls.indexOf("gatewayUninstall"));
});

test("claude_code needs the gateway: it installs it first", async () => {
  const s = sandbox({ settings: USER_SETTINGS });
  await s.u.set("claude_code", true);
  await s.u.on();
  assert.deepEqual(s.calls.filter((c) => !c.endsWith("Off")), ["gatewayInstall", "claudeCodeOn"]);
});

test("a status line of the person's own is never replaced", async () => {
  const mine = { type: "command", command: "my-status.sh" };
  const s = sandbox({ settings: { ...USER_SETTINGS, statusLine: mine } });
  await s.u.set("statusline", true);
  await s.u.on();
  assert.deepEqual(s.settingsOf().statusLine, mine);
  await s.u.off();
  assert.deepEqual(s.settingsOf().statusLine, mine);
});

test("terse style gives back the output style the person had", async () => {
  const s = sandbox({ settings: { ...USER_SETTINGS, outputStyle: "Explanatory" } });
  await s.u.set("terse_style", true);
  await s.u.on();
  assert.equal(s.settingsOf().outputStyle, "Terse");
  await s.u.set("terse_style", false);
  assert.equal(s.settingsOf().outputStyle, "Explanatory");
});

test("gemini_tools refuses to install without a key", async () => {
  const s = sandbox({ settings: USER_SETTINGS, key: false });
  await s.u.set("gemini_tools", true);
  const res = await s.u.on();
  assert.equal(res.gemini_tools, "not installed");
  assert.equal((await s.u.list()).rows.find((r) => r.name === "gemini_tools").installed, false);
});

test("features are independent and idempotent", async () => {
  const s = sandbox({ settings: USER_SETTINGS });
  await s.u.set("token_hooks", true);
  await s.u.on();
  await s.u.on();
  assert.equal(s.settingsOf().hooks.PreToolUse.length, 2, "no duplicate hook after turning on twice");
  assert.equal((await s.u.set("haiku_subagents", true)), "on");
  assert.equal((await s.u.set("token_hooks", false)), "off");
  assert.equal(s.settingsOf().hooks.PreToolUse.length, 1);
  assert.ok(fs.existsSync(path.join(s.home, ".claude", "agents", "ar-verbose.md")), "turning one off leaves the others");
  await assert.rejects(() => s.u.set("nonsense", true), /unknown feature/);
});

test("settings are backed up before the first change", async () => {
  const s = sandbox({ settings: USER_SETTINGS });
  await s.u.set("token_hooks", true);
  await s.u.on();
  const baks = fs.readdirSync(path.join(s.home, ".claude")).filter((f) => f.startsWith("settings.json.bak-auto-router-"));
  assert.equal(baks.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.home, ".claude", baks[0]), "utf8")), USER_SETTINGS);
});

test("the hook rewrites only one plain test command and keeps the exit code", () => {
  const hook = path.join(REAL, "templates", "claude-code", "hooks", "filter-test-output.mjs");
  const run = (command) => JSON.parse(spawnHook(hook, { tool_input: { command, description: "x" } }));
  const yes = run("python3 -m unittest discover -s tests");
  assert.match(yes.hookSpecificOutput.updatedInput.command, /exit \$__rc/);
  assert.equal(yes.hookSpecificOutput.updatedInput.description, "x", "other input fields are kept");
  for (const no of ["pytest | tee out.txt", "npm test && rm -rf x", "pytest $(whoami)", "ls -la", "pytest; curl evil"]) assert.deepEqual(run(no), {}, no);
});

test("the status line prints model (effort) from what Claude Code sends", () => {
  const out = spawnHook(path.join(REAL, "templates", "claude-code", "statusline.mjs"),
    { model: { id: "claude-opus-5-5" }, effort: { level: "high" }, context_window: { used_percentage: 42.4 }, session_id: "none" }, { AR_GATEWAY_PORT: "1" });
  assert.equal(out.trim(), "opus (high) · ctx 42%");
});

test("report: what routing would change and save, from the gateway log", () => {
  const now = 1_800_000_000_000;
  const row = (asked, model, cands, extra = {}) => ({ event: "route", class: "main", ts: now / 1000 - 60, mode: "shadow", asked, model, effort: "low",
    candidates: cands, usage: { input_tokens: 10, cache_read_input_tokens: 90 }, ...extra });
  const r = buildReport([
    row("claude-sonnet-5-5", "claude-haiku-cli", [["claude-haiku-cli", 4, 0.01, true, true], ["claude-sonnet-cli", 4, 0.04, true, true]]),
    row("claude-sonnet-5-5", "claude-sonnet-cli", [["claude-sonnet-cli", 4, 0.04, true, true]], { context_drop: true, status: 400 }),
    { event: "route", class: "auxiliary", ts: now / 1000 },
  ], 3600e3, now);
  assert.equal(r.requests, 2);
  assert.equal(r.changed, 1);
  assert.ok(Math.abs(r.estSavingUsd - 0.03) < 1e-9);
  assert.equal(r.drops, 1);
  assert.equal(r.errors, 1);
  assert.equal(r.cacheHit, 0.9);
});

test("optimize audit flags a large CLAUDE.md and unused MCP servers", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ar-aud-home-")), cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ar-aud-cwd-"));
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "line\n".repeat(400));
  fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { a: {}, b: {} } }));
  const { tips } = auditContext({ home, cwd });
  assert.ok(tips.some((t) => /CLAUDE\.md is 401 lines/.test(t)));
  assert.ok(tips.some((t) => /2 MCP server/.test(t)));
});

import { spawnSync } from "node:child_process";
function spawnHook(script, input, env = {}) {
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, ...env } });
  return r.stdout;
}
