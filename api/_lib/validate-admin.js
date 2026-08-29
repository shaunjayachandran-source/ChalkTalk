/**
 * Admin-token auth helper for the site-owner-only /admin.html surface
 * (new program creation + reviewing pending Google Form submissions).
 *
 * Deliberately NOT the same thing as api/_lib/validate-session.js:
 * that one checks "is this a real coach, and do they own this program"
 * via Supabase Auth + RLS. This one checks "does the caller know the one
 * ADMIN_TOKEN Shaun set in Vercel" -- there is no per-user identity here,
 * because there is exactly one admin. Keeping it a flat shared secret
 * (rather than trying to shoehorn this into Supabase Auth as a fake
 * "coach") avoids implying multi-admin support that doesn't exist yet.
 *
 * ADMIN_TOKEN must be set in Vercel as its own env var -- pick a long
 * random string, it is never the same value as any Supabase key or the
 * GitHub PAT below.
 */

function extractBearerToken(req) {
  const header = req.headers && req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

export function validateAdminToken(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    return { ok: false, error: "Server misconfiguration: ADMIN_TOKEN is not set", status: 500 };
  }
  const token = extractBearerToken(req);
  if (!token || token !== expected) {
    return { ok: false, error: "Invalid or missing admin token", status: 401 };
  }
  return { ok: true };
}
