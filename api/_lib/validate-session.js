/**
 * Session-based auth helper for the Supabase-backed rebuild (Part 2, Phase 3).
 *
 * Replaces api/_lib/validate-token.js (tokens.json-backed) for the two
 * generation endpoints. A coach is now a real Supabase Auth user, not a
 * flat-file token entry -- the browser sends the coach's Supabase access
 * token in an `Authorization: Bearer <token>` header (see public/create.html),
 * and this helper:
 *
 *   1. Verifies that token is a real, current Supabase session
 *      (supabase.auth.getUser(token)).
 *   2. Confirms the resulting user actually owns the program_id being
 *      written to, by querying `programs` through a Supabase client that
 *      carries the caller's JWT -- so Postgres Row Level Security (not
 *      application code) is what enforces "a coach can only touch their
 *      own programs." If the row doesn't come back, either the program
 *      doesn't exist or isn't theirs; both are treated as unauthorized.
 *
 * The Project URL and publishable/anon key below are the same public
 * values already embedded in public/js/supabase-client.js -- safe to be
 * public, RLS is the actual access boundary, not secrecy of this key.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://dvilirimxnkaghqyoueh.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_hhEb5Mj8QS1Byv8_Ne6FIw_NbZHbu9-";

function extractBearerToken(req) {
  const header = req.headers && req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

/**
 * Validates the request's Authorization header as a logged-in coach who
 * owns `programId`. Returns:
 *   { ok: true, user, supabase }  -- supabase is a client authenticated as
 *                                    this user, safe to reuse for further
 *                                    RLS-scoped queries/inserts (e.g. the
 *                                    plays table) in the same request.
 *   { ok: false, error, status }
 */
export async function validateCoachSession(req, programId) {
  const token = extractBearerToken(req);
  if (!token) {
    return { ok: false, error: "Missing or invalid Authorization header", status: 401 };
  }
  if (!programId) {
    return { ok: false, error: "Missing programId", status: 400 };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData || !userData.user) {
    return { ok: false, error: "Invalid or expired session -- please log in again", status: 401 };
  }

  const { data: program, error: programErr } = await supabase
    .from("programs")
    .select("id")
    .eq("id", programId)
    .maybeSingle();

  if (programErr || !program) {
    return { ok: false, error: "Program not found, or you don't have access to it", status: 403 };
  }

  return { ok: true, user: userData.user, supabase };
}
