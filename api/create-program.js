/**
 * POST /api/create-program
 *
 * Entry point for BOTH ways a new program config gets proposed:
 *
 *   1. Admin, from /admin.html -- Authorization: Bearer <ADMIN_TOKEN>.
 *      Trusted immediately: commits programs/<slug>.json straight to a
 *      new feature branch (feature/new-program-<slug>-<timestamp>), the
 *      same "feature branch -> preview -> manual merge" habit already
 *      used for every other change in this project, AND provisions the
 *      real Supabase side (programs row, optionally a real invited head
 *      coach) immediately -- see api/_lib/provision-program.js. Nothing
 *      about the static page goes live until Shaun merges the branch,
 *      but the real account is created right away since this path is
 *      already fully trusted.
 *
 *   2. The beta-signup Google Form's Apps Script trigger -- body.formSecret
 *      matching FORM_SHARED_SECRET instead of an admin token. NOT trusted
 *      to touch a real branch OR provision anything real: this instead
 *      commits the same JSON to programs/_pending/<slug>.json on a
 *      long-lived `programs-pending` branch that is never built or
 *      merged. It just sits there as durable storage until an admin
 *      clicks Approve or Reject in admin.html (see api/approve-program.js
 *      / api/reject-program.js) -- approval is what actually creates the
 *      branch AND provisions Supabase, including sending the coach their
 *      real login invite. A form submission can *never* reach either on
 *      its own.
 *
 * Body (same shape for both paths):
 *   {
 *     slug, title, team_name, team_sub, league, coach_line, coach_email,
 *     tagline, sign_accent, hero_line, primary_color ("#rrggbb"), initials,
 *     beta_status ("beta"|"live"), plan? (see api/_lib/plans.js; defaults "trial"),
 *     formSecret?
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
import { provisionProgram } from "./_lib/provision-program.js";
import { normalizePlan } from "./_lib/plans.js";

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
  const secondaryColor = shade(primaryColor, -60);
  const initials = String(body.initials || teamName.slice(0, 3)).trim().toUpperCase().slice(0, 4);
  const betaStatus = body.beta_status === "live" ? "live" : "beta";
  const plan = normalizePlan(body.plan);
  const coachName = String(body.coach_line || "").trim();
  const coachEmail = String(body.coach_email || "").trim();

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
    coach_line: coachName ? `Head Coach: <b>${escapeHtml(coachName)}</b>` : "",
    // Raw (non-HTML) copies, used only for Supabase provisioning below --
    // never rendered directly by build_site.py.
    coach_name: coachName || null,
    coach_email: coachEmail || null,
    crest_html: `<span>${escapeHtml(initials)}</span>`,
    accent_glow: hexToRgba(primaryColor, 0.35),
    accent_crest: `linear-gradient(160deg,${primaryColor},${secondaryColor})`,
    color_primary: primaryColor,
    color_secondary: secondaryColor,
    crest_label: initials,
    notes_text:
      "No plays have been built yet for this program. Pick a section below, or search above " +
      "&mdash; each card fills in once this staff runs a play through <b>Intake Mode</b> " +
      "(spoken description, uploaded diagram, or typed notes).",
    hero_mode: "art",
    tagline: title,
    beta_status: betaStatus,
    // Carried in the JSON so a Google-Form plan survives the programs-pending
    // round trip to approve-program.js.
    plan,
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

      // Real Supabase provisioning -- this is what makes the program
      // actually usable (real programs row, optionally a real invited
      // head coach), separate from the static marketing hub page the
      // branch/JSON above produces. Trusted immediately here because this
      // is the admin path; see api/approve-program.js for why the form
      // path defers this until an explicit approval click.
      let provision = null;
      try {
        provision = await provisionProgram({
          slug,
          name: programConfig.title,
          coachEmail: programConfig.coach_email,
          coachName: programConfig.coach_name,
          colorPrimary: programConfig.color_primary,
          colorSecondary: programConfig.color_secondary,
          crestLabel: programConfig.crest_label,
          plan: programConfig.plan,
        });
      } catch (provisionErr) {
        console.error("[create-program] provisioning failed", provisionErr.message);
        return sendJson(res, 200, {
          ok: true,
          pending: false,
          branch,
          compareUrl: compareUrl(branch),
          provisionError: `Page config committed, but Supabase provisioning failed: ${provisionErr.message}`,
        });
      }

      return sendJson(res, 200, {
        ok: true,
        pending: false,
        branch,
        compareUrl: compareUrl(branch),
        programId: provision.programId,
        coachInvited: provision.coachInvited,
        coachError: provision.coachError,
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
