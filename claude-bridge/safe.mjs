// Small security helpers for the bridge (SEC-06), kept apart so they can be unit-tested without starting a server.
import crypto from "node:crypto";

/** Constant-time comparison of the Authorization header with the expected bearer token. */
export function bearerMatches(header, key) {
  const a = Buffer.from(String(header || "")), b = Buffer.from(`Bearer ${key}`);
  if (a.length !== b.length) { crypto.timingSafeEqual(b, b); return false; } // same work either way
  return crypto.timingSafeEqual(a, b);
}

/** A working directory that is safe to hand to a .cmd/.bat launcher (cmd.exe re-parses these characters). */
export function cwdSafeForCmd(cwd) { return !/[&|<>^%"\r\n]/.test(String(cwd)); }

export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Collect a request body up to MAX_BODY_BYTES. Calls done(null, text) or done(Error) once; stops reading when too large. */
export function readBody(req, done, max = MAX_BODY_BYTES) {
  const chunks = []; let size = 0, finished = false;
  const end = (err, text) => { if (!finished) { finished = true; done(err, text); } };
  req.on("data", (d) => {
    size += d.length;
    if (size > max) { chunks.length = 0; end(Object.assign(new Error("body too large"), { status: 413 })); return; } // keep draining, store nothing
    if (!finished) chunks.push(d);
  });
  req.on("end", () => end(null, Buffer.concat(chunks).toString("utf8")));
  req.on("error", (e) => end(e));
}
