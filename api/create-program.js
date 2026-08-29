/**
 * POST /api/create-program
 *
 * Entry point for BOTH ways a new program config gets proposed:
 *
 *   1. Admin, from /admin.html -- Authorization: Bearer <ADMIN_TOKEN>.
 *      Trusted immediately: commits programs/<slug>.json straight to a
 *      new feature branch (feature/new-program-<slug>-<timestamp>), the
 *      same "feature branch -> preview -> manual merge" habit already
 *      used for every other change in this project. Nothing goes live
 *      until Shaun reviews the diff and merges it himself.
 *
 *   2. The beta-signup Google Form's Apps Script trigger -- body.formSecret
 *      matching FORM_SHARED_SECRET instead of an admin token. NOT trusted
 *      to touch a real branch: this instead commits the same JSON to
 *      programs/_pending/<slug>.json on a long-lived `programs-pending`
 *      branch that is never built or merged. It just sits there as
 *      durable storage until an admin clicks Approve or Reject in
 *      admin.html (see api/approve-program.js / api/reject-program.js).
 *      A form submission can *never* reach a real branch on its own --
 *      that only happens via the approve endpoint, which requires the
 *      admin token.
 *
 * Body (same shape for both paths):
 *   {
 *     slug, title, team_name, team_sub, league, coach_line, tagline,
 *     sign_accent, hero_line, primary_color ("#rrggbb"), initials,
 *     beta_status ("beta"|"live"), formSecret?
 *   }
 *
 * Deliberately does NOT accept hand-written crest_html/hero_art/accent_*
 * from the request body -- those are derived server-side from
 * primary_color + initials so a form submission can't inject arbitrary
 * HTML/SVG into a page that will eventually be reviewed and merged. A
 * coach who wants a custom crest can still get one; it just means Shaun
 * hand-edits the JSON before merging, same as any other review comment.
 */

import {
  getBranchSha,
  createBranch,
  ensureBranch,
  getFileContent,
  putFileContent,
  compareUrl,
} from "./_lib/github-repo.js";
import { validateAdminToken } from "./_lib/validate-admin.js";

const PENDING_BRANCH = "programs-pending";
const REQUIRED_FIELDS = ["slug", "title", "team_name"];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

function sendJson(res, status, body) {
  res.status(status).json(body);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function shade(hex, amount) {
  // amount negative = darker, positive = lighter. Cheap linear blend, good
  // enough for a generated crest gradient's second stop.
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const r = clamp(parseInt(hex.slice(1, 3), 16) + amount);
  const g = clamp(parseInt(hex.slice(3, 5), 16) + amount);
  const b = clamp(parseInt(hex.slice(5, 7), 16) + amount);
  const toHex = (v) => v.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function buildProgramConfig(body) {
  const slug = String(body.slug || "").trim().toLowerCase();
  const title = String(body.title || "").trim();
  const teamName = String(body.team_name || title).trim().toUpperCase();
  const primaryColor = HEX_COLOR_RE.test(body.primary_color || "") ? body.primary_color : "#f0b429";
  const initials = String(body.initials || teamName.slice(0, 3)).trim().toUpperCase().slice(0, 4);
  const betaStatus = body.beta_status === "live" ? "live" : "beta";

  return {
    slug,
    file_prefix: slug,
    title,
    team_name: teamName,
    team_sub: escapeHtml(body.team_sub || body.league || ""),
    hero_line:
      escapeHtml(body.hero_line) ||
      `Playbook hub for ${escapeHtml(title)} &mdash; built for coaches and players to see the same system explained at the depth each of them needs.`,
    sign_accent: escapeHtml(body.sign_accent || ""),
    coach_line: body.coach_line ? `Head Coach: <b>${escapeHtml(body.coach_line)}</b>` : "",
    crest_html: `<span>${escapeHtml(initials)}</span>`,
    accent_glow: hexToRgba(primaryColor, 0.35),
    accent_crest: `linear-gradient(160deg,${primaryColor},${shade(primaryColor, -60)})`,
    notes_text:
      "No plays have been built yet for this program. Pick a section below, or search above " +
      "&mdash; each card fills in once this staff runs a play through <b>Intake Mode</b> " +
      "(spoken description, uploaded diagram, or typed notes).",
    hero_mode: "art",
    tagline: title,
    beta_status: betaStatus,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const body = req.body || {};

  const missing = REQUIRED_FIELDS.filter((k) => !body[k]);
  if (missing.length) {
    return sendJson(res, 400, { error: `Missing required field(s): ${missing.join(", ")}` });
  }
  const slug = String(body.slug).trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    return sendJson(res, 400, {
      error: "slug must be lowercase letters/numbers/hyphens, 2-40 chars (e.g. 'crossover-elite')",
    });
  }

  const adminCheck = validateAdminToken(req);
  const isAdmin = adminCheck.ok;
  const isFormSubmission =
    !isAdmin && body.formSecret && process.env.FORM_SHARED_SECRET && body.formSecret === process.env.FORM_SHARED_SECRET;

  if (!isAdmin && !isFormSubmission) {
    return sendJson(res, 401, { error: "Missing or invalid admin token / form secret" });
  }

  const programConfig = buildProgramConfig({ ...body, slug });
  const jsonText = JSON.stringify(programConfig, null, 2) + "\n";

  try {
    const existing = await getFileContent(`programs/${slug}.json`, "main");
    if (existing) {
      return sendJson(res, 409, {
        error: `programs/${slug}.json already exists on main -- pick a different slug, or edit the existing program directly via the GitHub web editor.`,
      });
    }

    if (isAdmin) {
      const branch = `feature/new-program-${slug}-${Date.now()}`;
      const baseSha = await getBranchSha("main");
      if (!baseSha) throw new Error("Could not read main branch HEAD");
      await createBranch(branch, baseSha);
      await putFileContent(
        `programs/${slug}.json`,
        branch,
        jsonText,
        `Add new program config: ${slug}`
      );
      return sendJson(res, 200, {
        ok: true,
        pending: false,
        branch,
        compareUrl: compareUrl(branch),
      });
    }

    // Form path -- park it in programs-pending, no real branch touched.
    await ensureBranch(PENDING_BRANCH, "main");
    await putFileContent(
      `programs/_pending/${slug}.json`,
      PENDING_BRANCH,
      jsonText,
      `Pending program request: ${slug}`
    );
    return sendJson(res, 200, { ok: true, pending: true, slug });
  } catch (err) {
    console.error("[create-program]", err.message);
    return sendJson(res, 502, { error: `Couldn't save the program config: ${err.message}` });
  }
}
