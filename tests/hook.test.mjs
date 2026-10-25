// SEC-11: the PreToolUse hook that keeps Claude Code away from secret files. Run: node --test tests/hook.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decide, blockedCommand } from "../claude-bridge/hooks/protect-sensitive.mjs";

test("secret files are blocked, ordinary files and examples are not", () => {
  for (const p of ["/p/.env", "/p/.env.local", "/p/.env.production", "/home/u/.ssh/id_rsa", "/p/server.pem", "/p/a.key", "/p/secrets/db.txt", "/home/u/.aws/credentials", "/p/my-credentials.json"])
    assert.ok(decide({ tool_name: "Read", tool_input: { file_path: p } }), p);
  for (const p of ["/p/.env.example", "/p/src/app.js", "/p/README.md", "/p/environment.ts"])
    assert.equal(decide({ tool_name: "Read", tool_input: { file_path: p } }), null, p);
});

test("a symlink to a secret is blocked by its real path", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ar-hook-"));
  try {
    fs.writeFileSync(path.join(d, ".env"), "SECRET=1");
    fs.symlinkSync(path.join(d, ".env"), path.join(d, "notes.txt"));
    assert.ok(decide({ tool_name: "Read", tool_input: { file_path: path.join(d, "notes.txt") } }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("commands that print secrets are blocked, normal ones are not", () => {
  for (const c of ["env", "printenv", "printenv OPENAI_API_KEY", "cat .env", "cat ./app/.env.local | head", "ls && env", "cat ~/.ssh/id_rsa", "cat /proc/1/environ"])
    assert.ok(blockedCommand(c), c);
  for (const c of ["npm test", "git status", "cat README.md", "cat .env.example", "echo $HOME", "grep -rn environment src"])
    assert.ok(!blockedCommand(c), c);
});
