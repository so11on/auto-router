#!/usr/bin/env node
// PreToolUse hook (SEC-11): blocks Claude Code from reading/editing secret files or dumping the environment.
// Exit code 2 = block; stderr goes back to the model. Never prints file contents. Defence in depth next to
// settings.bridge.json "permissions.deny", which some Claude Code versions have not enforced for Read.
import fs from "node:fs";
import path from "node:path";

export const PATH_PATTERNS = [
  /(^|[\\/])\.env($|\.(?!example$|sample$|template$))/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)/i,
  /(^|[\\/])secrets?([\\/]|$)/i,
  /(^|[\\/])\.(aws|ssh|gnupg|kube|docker)([\\/]|$)/i,
  /credential/i,
  /(^|[\\/])\.(netrc|npmrc|pypirc)$/i,
  /(^|[\\/])auto-router[\\/](data|\.env)/i,
];
export const COMMAND_PATTERNS = [
  /(^|[;&|\s])(env|printenv|export\s+-p|set)\s*($|[;&|])/,
  /(^|[;&|\s])printenv\b/,
  /\b(cat|less|more|head|tail|bat|nl|sed|awk|grep|rg|cp|mv|base64|xxd|strings|open|source|\.)\s+[^|;&]*\.env(\.(?!example|sample|template)\S+)?(\s|$)/i,
  /\b(cat|less|more|head|tail|cp|base64)\s+[^|;&]*(id_(rsa|ed25519|ecdsa)|\.pem|\.key|\.aws\/|\.ssh\/)/i,
  /\/proc\/[^\s]*\/environ/,
];

export function blockedPath(p) {
  if (!p) return false;
  let real = p;
  try { real = fs.realpathSync.native(p); } catch { try { real = path.resolve(p); } catch {} }
  return PATH_PATTERNS.some((rx) => rx.test(p) || rx.test(real));
}
export function blockedCommand(c) { return COMMAND_PATTERNS.some((rx) => rx.test(c || "")); }

export function decide(input) {
  const ti = input?.tool_input || {};
  for (const k of ["file_path", "path", "notebook_path"]) if (blockedPath(ti[k])) return `blocked: ${path.basename(String(ti[k]))} looks like a secret file`;
  if (input?.tool_name === "Bash" && blockedCommand(ti.command)) return "blocked: this command would print secrets (env / .env / key files)";
  return null;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("protect-sensitive.mjs")) {
  let raw = "";
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    let input = {};
    try { input = JSON.parse(raw); } catch { process.exit(0); }
    const why = decide(input);
    if (why) { process.stderr.write(`auto-router: ${why}. Ask the user to paste the non-secret part if you need it.\n`); process.exit(2); }
    process.exit(0);
  });
}
