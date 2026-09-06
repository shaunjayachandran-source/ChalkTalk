/**
 * GET /api/view-play?playId=<uuid>[&accessToken=<token>]
 *
 * Streams a generated playbook's HTML back with headers that render it
 * inline, instead of handing out the raw Vercel Blob URL -- Blob always
 * serves files with Content-Disposition: attachment (not configurable via
 * put()'s options), which is why generated plays were downloading instead
 * of opening. Proxying the bytes through our own response means the
 * browser only sees OUR headers.
 *
 * Two ways in, checked in order:
 *   - A logged-in coach (Authorization: Bearer <session token>) viewing a
 *     play on their own program -- used right after create.html finishes
 *     a build.
 *   - A personal access-link token (?accessToken=<token>) viewing a
 *     published play -- same token model as api/team-access.js, used from
 *     my-playbook.html.
 * Neither checking out fails closed, same as every other reader-facing
 * endpoint in this app.
 */

import { createClient } from "@supabase/supabase-js";
import { validateCoachSession } from "./_lib/validate-session.js";

const SUPABASE_URL = "https://dvilirimxnkaghqyoueh.supabase.co";

function getServiceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(SUPABASE_URL, key);
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fail(res, status, message) {
  return res.status(status).send(message || "Not found");
}

export default async function handler(req, res) {
  const playId = typeof req.query.playId === "string" ? req.query.playId.trim() : "";
  const accessToken = typeof req.query.accessToken === "string" ? req.query.accessToken.trim() : "";

  if (!playId) return fail(res, 400, "Missing playId");

  let service;
  try {
    service = getServiceClient();
  } catch (err) {
    console.error("[view-play]", err.message);
    return fail(res, 500, "Server misconfiguration");
  }

  const { data: play, error: playErr } = await service
    .from("plays")
    .select("id, program_id, storage_url, status, hidden")
    .eq("id", playId)
    .maybeSingle();

  if (playErr || !play || !play.storage_url) return fail(res, 404, "Play not found");

  // ---- Auth: coach session OR a valid access-link token ----
  let authorized = false;

  const hasBearer = req.headers.authorization && req.headers.authorization.startsWith("Bearer ");
  if (hasBearer) {
    const sessionResult = await validateCoachSession(req, play.program_id);
    if (sessionResult.ok) authorized = true;
  }

  if (!authorized && accessToken) {
    const tokenHash = await sha256Hex(accessToken);
    const { data: link } = await service
      .from("access_links")
      .select("id, program_id, revoked_at, expires_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();

    if (
      link &&
      !link.revoked_at &&
      (!link.expires_at || new Date(link.expires_at) > new Date()) &&
      link.program_id === play.program_id &&
      play.status === "published" &&
      !play.hidden
    ) {
      authorized = true;
    }
  }

  if (!authorized) return fail(res, 403, "You don't have access to this play");

  // ---- Fetch the actual HTML from Blob storage and stream it back ----
  let blobRes;
  try {
    blobRes = await fetch(play.storage_url);
  } catch (err) {
    console.error("[view-play] failed to fetch blob:", err.message);
    return fail(res, 502, "Failed to load play");
  }

  if (!blobRes.ok) {
    return fail(res, 502, "Failed to load play");
  }

  const html = await blobRes.text();

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).send(html);
}
