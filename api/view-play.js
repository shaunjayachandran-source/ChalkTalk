/**
 * GET /api/view-play?playId=<uuid>[&accessToken=<token>]
 *
 * Streams a generated playbook's HTML back with headers that render it
 * inline (see the header comment history below for why), and now also:
 *   - Logs every successful view to play_views (who, when, from where) --
 *     the audit trail a coach needs if a play ever leaks somewhere it
 *     shouldn't.
 *   - Injects a low-opacity, tiled watermark identifying the viewer and
 *     timestamp across the whole page, so a screenshot or recording can
 *     be traced back to whoever's account saw it. Tiled edge-to-edge
 *     (not a single corner mark) so cropping doesn't remove it.
 *
 * Three ways in, checked in order:
 *   - A logged-in coach (Authorization: Bearer <session token>) viewing a
 *     play on their own program -- used right after create.html finishes
 *     a build.
 *   - A logged-in player/parent viewer account (Authorization: Bearer
 *     <session token>, added Sep 15, 2026 for the Dartmouth login pilot --
 *     see api/_lib/validate-viewer-session.js) viewing a published play on
 *     their linked program -- used from public/player-home.html.
 *   - A personal access-link token (?accessToken=<token>) viewing a
 *     published play -- same token model as api/team-access.js, used from
 *     my-playbook.html.
 * None of these checking out fails closed, same as every other
 * reader-facing endpoint in this app.
 */

import { createClient } from "@supabase/supabase-js";
import { validateCoachSession } from "./_lib/validate-session.js";
import { validateViewerSession } from "./_lib/validate-viewer-session.js";

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

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildWatermarkOverlay(label) {
  const stamp = `${label} \u00B7 ${new Date().toLocaleString()}`;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='340' height='170'>` +
    `<text x='170' y='90' font-family='DM Mono, monospace' font-size='13' ` +
    `fill='#f5f0e6' fill-opacity='0.06' text-anchor='middle' ` +
    `transform='rotate(-28 170 90)'>${escapeXml(stamp)}</text></svg>`;
  const dataUri = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  return (
    `<div style="position:fixed;inset:0;pointer-events:none;z-index:999999;` +
    `background-image:url('${dataUri}');background-repeat:repeat;"></div>`
  );
}

function injectWatermark(html, label) {
  const overlay = buildWatermarkOverlay(label);
  return html.includes("</body>") ? html.replace("</body>", overlay + "</body>") : html + overlay;
}

function getRequestMeta(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded || "").split(",")[0].trim() || null;
  const userAgent = req.headers["user-agent"] || null;
  return { ip, userAgent };
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
    .select("id, program_id, storage_url, status, hidden, title")
    .eq("id", playId)
    .maybeSingle();

  if (playErr || !play || !play.storage_url) return fail(res, 404, "Play not found");

  // ---- Auth: coach session OR a valid access-link token ----
  let authorized = false;
  let viewerKind = null;
  let viewerRefId = null;
  let viewerLabel = null;

  const hasBearer = req.headers.authorization && req.headers.authorization.startsWith("Bearer ");
  if (hasBearer) {
    const sessionResult = await validateCoachSession(req, play.program_id);
    if (sessionResult.ok) {
      authorized = true;
      viewerKind = "coach";
      viewerRefId = sessionResult.user.id;
      const { data: coachRow } = await service
        .from("coaches")
        .select("display_name, email")
        .eq("id", sessionResult.user.id)
        .maybeSingle();
      viewerLabel = (coachRow && (coachRow.display_name || coachRow.email)) || sessionResult.user.email || "Coach";
    }
  }

  // Player/parent login tier (Dartmouth pilot, Sep 15, 2026): only tried
  // once the coach-session check above has already failed, since a Bearer
  // token could legitimately be either kind of session.
  if (!authorized && hasBearer) {
    const viewerResult = await validateViewerSession(req);
    if (
      viewerResult.ok &&
      viewerResult.viewerAccount.program_id === play.program_id &&
      play.status === "published" &&
      !play.hidden
    ) {
      authorized = true;
      viewerKind = "viewer_account";
      viewerRefId = viewerResult.viewerAccount.id;
      const role = viewerResult.teamMember?.role || "viewer";
      viewerLabel = viewerResult.teamMember?.name ? `${viewerResult.teamMember.name} (${role})` : `Unnamed ${role}`;
    }
  }

  if (!authorized && accessToken) {
    const tokenHash = await sha256Hex(accessToken);
    const { data: link } = await service
      .from("access_links")
      .select("id, program_id, team_member_id, role, revoked_at, expires_at")
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
      viewerKind = "access_link";
      viewerRefId = link.id;

      let memberName = null;
      if (link.team_member_id) {
        const { data: member } = await service
          .from("team_members")
          .select("name")
          .eq("id", link.team_member_id)
          .maybeSingle();
        memberName = member ? member.name : null;
      }
      viewerLabel = memberName ? `${memberName} (${link.role})` : `Unnamed ${link.role}`;
    }
  }

  if (!authorized) return fail(res, 403, "You don't have access to this play");

  // ---- Fetch the actual HTML from Blob storage ----
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

  const rawHtml = await blobRes.text();
  const html = injectWatermark(rawHtml, viewerLabel);

  // ---- Audit log: best-effort, never blocks the view itself ----
  const { ip, userAgent } = getRequestMeta(req);
  service
    .from("play_views")
    .insert({
      play_id: play.id,
      program_id: play.program_id,
      viewer_label: viewerLabel,
      viewer_kind: viewerKind,
      viewer_ref_id: viewerRefId,
      ip_address: ip,
      user_agent: userAgent,
    })
    .then(({ error }) => {
      if (error) console.error("[view-play] failed to log view:", error.message);
    });

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).send(html);
}
