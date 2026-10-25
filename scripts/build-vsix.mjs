#!/usr/bin/env node
// Builds vscode-extension/auto-router-companion.vsix from the sources, byte-for-byte reproducibly (no dependencies), and
// writes vscode-extension/SHA256SUMS. `ar.mjs vscode` builds from source before installing, so the installed extension
// always matches the code you can read; the committed .vsix is a convenience checked against SHA256SUMS (and by a test).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "vscode-extension");

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** Minimal zip writer: fixed timestamp, fixed order, deflate. */
export function zip(entries) {
  const DOS_TIME = 0, DOS_DATE = (46 << 9) | (1 << 5) | 1; // 2026-01-01 00:00, so builds are identical everywhere
  const local = [], central = []; let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name), comp = zlib.deflateRawSync(data, { level: 9 }), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    local.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

export function buildVsix() {
  const pkg = JSON.parse(fs.readFileSync(path.join(EXT, "package.json"), "utf8"));
  const read = (...p) => fs.readFileSync(path.join(EXT, ...p));
  return zip([
    ["extension.vsixmanifest", Buffer.from(read("vsix", "extension.vsixmanifest").toString("utf8").replaceAll("{{VERSION}}", pkg.version))],
    ["[Content_Types].xml", read("vsix", "[Content_Types].xml")],
    ["extension/package.json", read("package.json")],
    ["extension/extension.js", read("extension.js")],
    ["extension/readme.md", Buffer.from("# auto-router companion\n\nSee ../docs/VSCODE-SETUP.md\n")],
    ["extension/LICENSE.txt", fs.readFileSync(path.join(ROOT, "LICENSE"))],
  ]);
}
export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = buildVsix();
  fs.writeFileSync(path.join(EXT, "auto-router-companion.vsix"), out);
  fs.writeFileSync(path.join(EXT, "SHA256SUMS"), `${sha256(out)}  auto-router-companion.vsix\n`);
  console.log(`built vscode-extension/auto-router-companion.vsix (${out.length} bytes) sha256 ${sha256(out)}`);
}
