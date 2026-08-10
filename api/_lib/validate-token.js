/**
 * Shared token-validation helper for tokens.json-backed auth.
 *
 * Reads tokens.json from the function's own bundled filesystem (NOT over
 * HTTP -- a self-referential network fetch back to the same deployment is
 * unreliable on the Node.js runtime, per the note that used to live in
 * generate-brief.js/generate-playbook.js). Every Node function that needs
 * to check a token+program pair should import from here instead of
 * re-implementing this logic.
 *
 * NOTE: this whole file is a stopgap. It goes away in the Part 2 rebuild
 * once auth moves to Supabase (real coach sessions + hashed, revocable
 * access_links for players/parents).
 */

import { readFile } from "fs/promises";
import path from "path";

async function loadTokens() {
  const tokensPath = path.join(process.cwd(), "tokens.json");
  const raw = await readFile(tokensPath, "utf-8");
  return JSON.parse(raw);
}

/**
 * Validates that `token` is active and belongs to `program`, with no role
 * restriction. Used by content-serving paths (any active role may read).
 * Returns { ok: true, entry } or { ok: false, error, status }.
 */
export async function validateActiveToken(token, program) {
  if (!token || !program) {
    return { ok: false, error: "Missing token or program", status: 400 };
  }

  let tokens;
  try {
    tokens = await loadTokens();
  } catch (err) {
    // Fail closed: any error loading the token list denies access.
    return { ok: false, error: `Could not load token list: ${err.message}`, status: 500 };
  }

  const programTokens = tokens[program];
  const entry = programTokens && programTokens[token];

  if (!entry || entry.active !== true) {
    return { ok: false, error: "Invalid or inactive token", status: 403 };
  }

  return { ok: true, entry };
}

/**
 * Validates that `token` is active, belongs to `program`, AND has role
 * "coach". Used by the two generation endpoints, which only coaches may
 * call.
 */
export async function validateCoachToken(token, program) {
  const result = await validateActiveToken(token, program);
  if (!result.ok) return result;

  if (result.entry.role !== "coach") {
    return { ok: false, error: "Only coaches can generate plays", status: 403 };
  }

  return { ok: true, entry: result.entry };
}

/**
 * If `token` exists ANYWHERE in tokens.json (any program), return its
 * role as a hint so blocked.html can pick an audience-appropriate
 * headline -- mirrors the UX the old check-token.js had. Returns "" if
 * the token is entirely unknown or tokens.json can't be read (fails
 * silently here since this is cosmetic, not a security check).
 */
export async function findRoleHint(token) {
  if (!token) return "";
  let tokens;
  try {
    tokens = await loadTokens();
  } catch {
    return "";
  }

  for (const program of Object.keys(tokens)) {
    const entry = tokens[program] && tokens[program][token];
    if (entry && typeof entry.role === "string") return entry.role;
  }
  return "";
}
