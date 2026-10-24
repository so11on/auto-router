// Starts the bridge with the values from ../.env (works on Windows, macOS and Linux).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
} catch (e) {
  console.error(`cannot read ${path.join(root, ".env")}: ${e.message}. Run: node ar.mjs init`);
  process.exit(1);
}
await import("./server.mjs");
