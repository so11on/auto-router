// SEC-06: bridge helpers. Run: node --test tests/safe.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { bearerMatches, cwdSafeForCmd, readBody } from "../claude-bridge/safe.mjs";
import { EventEmitter } from "node:events";

test("bearer comparison: right key only, any length", () => {
  assert.equal(bearerMatches("Bearer secret", "secret"), true);
  for (const h of ["Bearer secre", "Bearer secret!", "bearer secret", "", undefined, "Bearer"]) assert.equal(bearerMatches(h, "secret"), false, String(h));
});

test("cwd characters cmd.exe would re-parse are rejected", () => {
  for (const bad of ["C:\\a&b", "C:\\a|b", "C:\\a<b", "C:\\a>b", "C:\\a^b", "C:\\100%", 'C:\\a"b', "C:\\a\nb"]) assert.equal(cwdSafeForCmd(bad), false, bad);
  for (const good of ["C:\\Users\\ana\\my project", "/home/ana/code", "D:/work/app-1"]) assert.equal(cwdSafeForCmd(good), true, good);
});

test("request bodies over the limit are refused with 413 and nothing is stored", async () => {
  const req = new EventEmitter();
  const result = new Promise((resolve) => readBody(req, (err, text) => resolve({ err, text }), 10));
  req.emit("data", Buffer.alloc(6)); req.emit("data", Buffer.alloc(6)); req.emit("end");
  const { err } = await result;
  assert.equal(err.status, 413);
  const ok = new EventEmitter();
  const r2 = new Promise((resolve) => readBody(ok, (e, text) => resolve({ e, text }), 10));
  ok.emit("data", Buffer.from("hello")); ok.emit("end");
  assert.deepEqual(await r2, { e: null, text: "hello" });
});
