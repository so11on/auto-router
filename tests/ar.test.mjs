// Tests for ar.mjs helpers and a fresh-install simulation. Run: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv, setEnvText, patchProviders, buildProvider, vscodeUserDir } from "../ar.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("parseEnv handles comments, quotes and inline comments", () => {
  const e = parseEnv('# c\nA=1\nB = "two words"  \nC=3   # inline\n\nD=\n');
  assert.deepEqual(e, { A: "1", B: "two words", C: "3", D: "" });
});

test("setEnvText replaces in place and appends missing keys", () => {
  const t = setEnvText("A=\nB=keep\n", "A", "x");
  assert.equal(t, "A=x\nB=keep\n");
  assert.match(setEnvText("A=1\n", "Z", "9"), /Z=9\n$/);
});

test("patchProviders adds, replaces and removes only auto-router", () => {
  const other = [{ name: "Gemini", vendor: "gemini" }];
  const p = buildProvider("sk-test");
  let out = JSON.parse(patchProviders(JSON.stringify(other), p));
  assert.deepEqual(out.map((x) => x.name), ["Gemini", "auto-router"]);
  assert.equal(out[1].models[0].requestHeaders.Authorization, "Bearer sk-test");
  assert.equal(out[1].apiType, "chat-completions");
  out = JSON.parse(patchProviders(JSON.stringify(out), buildProvider("sk-new")));
  assert.equal(out.length, 2);
  assert.equal(out[1].models[0].requestHeaders.Authorization, "Bearer sk-new");
  out = JSON.parse(patchProviders(JSON.stringify(out), p, true));
  assert.deepEqual(out.map((x) => x.name), ["Gemini"]);
  assert.equal(JSON.parse(patchProviders("", p)).length, 1);
  assert.throws(() => patchProviders("// comment\n[]", p), /plain JSON/);
});

test("vscodeUserDir is OS specific and ends with User", () => {
  assert.match(vscodeUserDir(), /User$/);
  assert.match(vscodeUserDir("Code - Insiders"), /Code - Insiders/);
});

test("fresh install: init creates .env with generated secrets, profile and local config; vscode --dir patches a file", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fresh-"));
  const copy = path.join(tmp, "repo");
  fs.cpSync(ROOT, copy, { recursive: true, filter: (s) => !/[\\/](\.git|data|node_modules|\.auto-router)([\\/]|$)/.test(s) && !/[\\/]\.env(\.bak)?$/.test(s) });
  const home = path.join(tmp, "home");
  fs.mkdirSync(path.join(home, "code"), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const run = (...a) => spawnSync(process.execPath, [path.join(copy, "ar.mjs"), ...a], { encoding: "utf8", env });
  assert.notEqual(run("init").status, 0, "init without --roots must fail");
  const r = run("init", "--roots", path.join(home, "code"), "--profile", "D", "--claude", "api");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const e = parseEnv(fs.readFileSync(path.join(copy, ".env"), "utf8"));
  assert.match(e.LITELLM_MASTER_KEY, /^sk-[0-9a-f]{32}$/);
  assert.match(e.BRIDGE_KEY, /^[0-9a-f]{32}$/);
  assert.equal(e.BRIDGE_ALLOWED_ROOTS, path.join(home, "code"));
  assert.equal(e.CLAUDE_PRIMARY, "api");
  assert.equal(e.CLASSIFIER_MODEL, "pool");
  assert.equal(e.GEMINI_API_KEY, "");
  assert.match(fs.readFileSync(path.join(copy, "litellm", "routing.yaml"), "utf8"), /Profile D/);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, ".auto-router", "config.json"), "utf8"));
  assert.equal(fs.realpathSync(cfg.repo), fs.realpathSync(copy));
  const vs = path.join(tmp, "vscode-user");
  const v = run("vscode", "--dir", vs);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  const prov = JSON.parse(fs.readFileSync(path.join(vs, "chatLanguageModels.json"), "utf8"));
  assert.equal(prov[0].models.length, 3);
  assert.equal(prov[0].models[0].requestHeaders.Authorization, `Bearer ${e.LITELLM_MASTER_KEY}`);
  assert.equal(run("init", "--roots", path.join(home, "code")).status, 0, "re-running init keeps .env");
  assert.equal(parseEnv(fs.readFileSync(path.join(copy, ".env"), "utf8")).LITELLM_MASTER_KEY, e.LITELLM_MASTER_KEY);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("no personal data or secrets are shipped", () => {
  const bad = [/so11on/i, /sollon/i, /limarj/i, /\/Users\/[a-z0-9]+/i, /C:\\Users\\[a-z0-9]+/i, /sk-[A-Za-z0-9]{24,}/, /AIza[0-9A-Za-z_-]{30}/, /gsk_[A-Za-z0-9]{20,}/, /nvapi-/, /sk-ant-/, /ghp_[A-Za-z0-9]{20,}/];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => {
    const p = path.join(d, x.name);
    if (/^(\.git|data|node_modules|\.auto-router)$/.test(x.name) || /^\.env(\.bak)?$/.test(x.name) || x.name.endsWith(".vsix") || p.endsWith(path.join("tests", "ar.test.mjs"))) return [];
    return x.isDirectory() ? walk(p) : [p];
  });
  const hits = [];
  for (const f of walk(ROOT)) {
    const t = fs.readFileSync(f, "utf8").replaceAll("github.com/so11on/auto-router", ""); // the public repository URL is intentional
    for (const re of bad) if (re.test(t)) hits.push(`${path.relative(ROOT, f)} ~ ${re}`);
  }
  assert.deepEqual(hits, []);
});
