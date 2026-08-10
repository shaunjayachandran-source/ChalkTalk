/**
 * GET /api/serve-playbook?program=<program>&token=<token>&file=<file>
 *
 * Replaces the old api/check-token.js. That function validated a token
 * and then 302-redirected to the static file at /playbooks/<program>/...
 * -- but that static path was ALSO directly reachable by anyone who
 * requested it without ever going through check-token.js first, since
 * Vercel serves every file in the repo as a public static asset by
 * default. The redirect was not a gate; it was a signpost pointing at an
 * unlocked door.
 *
 * vercel.json now rewrites all requests under /playbooks/:program/:file*
 * to this function, so the static files are no longer reachable directly
 * -- THIS function is the only thing that can read and return them, and
 * it actually checks the token before doing so.
 *
 * On success: streams the requested file's bytes back with an appropriate
 * Content-Type.
 * On failure (missing/invalid/inactive token, wrong program, unreadable
 * file): fail closed, 302 to /blocked.html -- same behavior the old
 * check-token.js had.
 */

import { readFile } from "fs/promises";
import path from "path";
import { validateActiveToken, findRoleHint } from "./_lib/validate-token.js";

const BLOCKED_URL = "/blocked.html";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export default async function handler(req, res) {
  const { program, token, file } = req.query;

  // file defaults to index.html when hitting /playbooks/:program/ itself.
  const rawFile = Array.isArray(file) ? file.join("/") : file || "index.html";

  if (!program || typeof program !== "string") {
    return redirectBlocked(res);
  }

  // ---- Path-traversal guard ----
  // We're now serving an arbitrary filename out of user input, which the
  // old check-token.js never had to worry about (it only ever redirected
  // to a hardcoded index.html). Reject anything that isn't a plain,
  // relative, single-directory-deep-or-less path.
  const normalizedFile = path.normalize(rawFile);
  if (
    normalizedFile.includes("..") ||
    path.isAbsolute(normalizedFile) ||
    normalizedFile.startsWith("/") ||
    normalizedFile.includes("\0")
  ) {
    return redirectBlocked(res);
  }

  const normalizedProgram = path.normalize(String(program));
  if (
    normalizedProgram.includes("..") ||
    path.isAbsolute(normalizedProgram) ||
    normalizedProgram.includes("/") ||
    normalizedProgram.includes("\0")
  ) {
    return redirectBlocked(res);
  }

  const authResult = await validateActiveToken(token, normalizedProgram);
  if (!authResult.ok) {
    const role = await findRoleHint(token);
    return redirectBlocked(res, role);
  }

  const playbooksRoot = path.join(process.cwd(), "playbooks");
  const programRoot = path.join(playbooksRoot, normalizedProgram);
  const targetPath = path.join(programRoot, normalizedFile);

  // Belt-and-suspenders: after joining, confirm the resolved path is
  // still inside the program's own directory.
  if (!targetPath.startsWith(programRoot + path.sep) && targetPath !== programRoot) {
    return redirectBlocked(res);
  }

  let contents;
  try {
    contents = await readFile(targetPath);
  } catch (err) {
    return redirectBlocked(res);
  }

  const ext = path.extname(targetPath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || "application/octet-stream";

  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(200).send(contents);
}

function redirectBlocked(res, role) {
  const location = role ? `${BLOCKED_URL}?role=${encodeURIComponent(role)}` : BLOCKED_URL;
  res.writeHead(302, { Location: location });
  res.end();
}
