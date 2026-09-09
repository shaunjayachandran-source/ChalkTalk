/**
 * POST /api/generate-playbook
 *
 * Step 2 of the playbook builder (BUILD MODE): takes a CONFIRMED brief
 * and generates the full interactive HTML playbook.
 *
 * ARCHITECTURE NOTE: to stay within Vercel Hobby's 60s function timeout,
 * generation is split into:
 *   1. A deterministic HTML "shell" (fonts, CSS, tab-switching JS,
 *      tooltip JS, progress bar, home-link) built in code -- no LLM call,
 *      instant, and identical in structure across every play.
 *   2. One Claude call PER PHASE, run in PARALLEL via Promise.all, each
 *      generating only that phase's SVG diagram + sidebar content.
 * This keeps each individual Claude call small and fast regardless of
 * how many phases a play has, since they run concurrently rather than
 * accumulating sequentially against the 60s cap.
 *
 * Auth: requires a Supabase coach session (Authorization: Bearer
 * <access_token> header) that owns programId. Re-validated independently
 * from the brief step, same as before.
 *
 * Storage: writes a `plays` row first (so the play shows up on the coach's
 * dashboard immediately), then uploads the rendered HTML to Vercel Blob at
 * a path keyed by that row's UUID (generated/<play-id>.html) rather than by
 * human-readable program+slug -- removes the old, guessable
 * generated/<program>/<slug>.html path.
 *
 * Body (JSON):
 *   { programId: string, brief: { ...see generate-brief.js schema }, category?: string, subCategory?: string }
 *
 *   category is one of PLAY_CATEGORIES below (offense/defense/slob/blob/special).
 *   It powers the public team directory page (public/team.html) so plays can
 *   be grouped into the right section there -- purely organizational, no
 *   effect on the generated playbook content itself. Falls back to null
 *   (shown as "Uncategorized" on the team page) if omitted or invalid.
 *
 *   subCategory confirms the Man/Zone/Press(-Break) bucket for the public
 *   Offense/Defense subpages -- required (and validated) whenever category
 *   is "offense" or "defense", per SUB_CATEGORIES_BY_CATEGORY below. There is
 *   deliberately no inferred/"Other" fallback: a coach must confirm this at
 *   build time. Ignored (stored as null) for slob/blob/special, which stay
 *   flat grids with no sub-grouping.
 *
 * Response (JSON):
 *   { url: string }   -- public Blob URL of the generated playbook
 *   or { error: string } with an appropriate status code
 */

import { put } from "@vercel/blob";
import { validateCoachSession } from "./_lib/validate-session.js";

export const config = { maxDuration: 180 };

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

const PLAY_CATEGORIES = ["offense", "defense", "slob", "blob", "special"];

// Which sub_category values are valid for each category that requires one.
// Offense uses "press_break" (press-break terminology); defense uses plain
// "press". SLOB/BLOB/Special have no entry here -- they never get a
// sub_category.
const SUB_CATEGORIES_BY_CATEGORY = {
  offense: ["man", "zone", "press_break"],
  defense: ["man", "zone", "press"],
};

const PLAYER_COLORS = {
  1: { fill: "#f0b429", stroke: "#ffd060" },
  2: { fill: "#27ae60", stroke: "#2ecc71" },
  3: { fill: "#2a6ae8", stroke: "#7db3ff" },
  4: { fill: "#9b59b6", stroke: "#c39bd3" },
  5: { fill: "#e03a2e", stroke: "#ff7b6e" },
};

// Real court art assets -- see the project's court-asset-level-mapping.md:
// exactly two art buckets exist (not one per level), grouped as "hs" (youth,
// middle school, high school) and "pro" (prep, college, pro -- regardless of
// gender). Hosted as static files on the main site rather than embedded as
// base64 in this source file, since the base64 text (100KB+ combined) is
// impractical to hand-edit/verify through GitHub's web editor -- referenced
// here by absolute URL so it resolves correctly even though generated plays
// are served from a different origin (Vercel Blob), not this site.
const COURT_ASSET_BASE = "https://chalktalk-sand.vercel.app/assets/courts";

function courtLevelBucket(level) {
  return level === "college" || level === "pro" || level === "prep" ? "pro" : "hs";
}

// Placement rects for each asset -- NOT uniform, because the source images
// have different real aspect ratios (half-court HS 336x300 vs Pro 366x371;
// full-court vertical HS 336x570 vs Pro 366x640). Each rect is a centered
// "contain" fit of that specific image into its viewBox's available court
// area, computed directly from the actual asset dimensions.
const COURT_IMAGES = {
  half: {
    hs: {
      down: { file: "half-hs-down.png", x: 36.0, y: 8.0, width: 448.0, height: 400.0 },
      up: { file: "half-hs-up.png", x: 36.0, y: 8.0, width: 448.0, height: 400.0 },
    },
    pro: {
      down: { file: "half-pro-down.png", x: 62.7, y: 8.0, width: 394.6, height: 400.0 },
      up: { file: "half-pro-up.png", x: 62.7, y: 8.0, width: 394.6, height: 400.0 },
    },
  },
  full: {
    hs: { file: "full-hs-vertical.png", x: 123.2, y: 4.0, width: 273.5, height: 464.0 },
    pro: { file: "full-pro-vertical.png", x: 127.3, y: 4.0, width: 265.3, height: 464.0 },
  },
};

// Builds the deterministic court background + the correct viewBox for this
// play -- Claude no longer draws the court at all, it only returns the
// player/arrow/screen overlay layer (see PHASE_SYSTEM_PROMPT below). Returns
// an OPEN <svg> tag (with the court image already inside it) -- the caller
// appends the phase's overlay content and the closing </svg>.
function buildCourtSvgOpen(brief) {
  const bucket = courtLevelBucket(brief.level);
  const isFull = brief.courtType === "full";
  const viewBox = isFull ? "0 0 520 500" : "0 0 520 420";
  const entry = isFull ? COURT_IMAGES.full[bucket] : COURT_IMAGES.half[bucket][brief.basketOrientation === "up" ? "up" : "down"];
  const image = `<image href="${COURT_ASSET_BASE}/${entry.file}" x="${entry.x}" y="${entry.y}" width="${entry.width}" height="${entry.height}" preserveAspectRatio="xMidYMid meet"/>`;
  return `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg">${image}`;
}

const PHASE_SYSTEM_PROMPT = `You are a master basketball coach and visual communications expert. You generate ONE PHASE of an interactive basketball playbook -- just the player/arrow/screen overlay and sidebar content for this single phase, not the full page and NOT the court itself.

IMPORTANT: the court background (outline, key, free-throw circle, three-point line, basket, backboard) is a real embedded court image added by the code, not drawn by you. Your diagramSvg is ONLY the overlay layer -- players, movement lines, screens, the ball dot, and the footer caption bar -- positioned using the same coordinate system the anchors below describe, as if that court were present, even though you're not drawing it.

Return ONLY valid JSON, no markdown fences, no preamble. Match this exact schema:
{
  "diagramSvg": "SVG fragment as a string -- player circles, movement lines, screens, ball dot, footer caption bar ONLY. Do NOT include an outer <svg> tag, a viewBox, or any court outline/key/three-point-line/basket -- the code supplies all of that.",
  "sidebarHtml": "HTML fragment as a string (no <html>/<body> wrapper)"
}

Since diagramSvg and sidebarHtml are JSON string values, use single quotes (not double quotes) for every SVG/HTML attribute in both (e.g. <circle cx='180' cy='285'>, <div class='cp'>) -- this avoids needing to escape quotes inside the JSON string, which is the most common cause of invalid JSON output.


## SVG Diagram Rules
- Coordinate system: half-court is 520x420 (or 520x500 for full court), matching the real court image already placed underneath your overlay. You'll be told this phase's basket position: DOWN (default) or UP. Use the anchor coordinates below exactly -- they're calibrated to the actual court image, not something you need to re-derive.
- Player circles r=13, class="pc", with data-l (short label e.g. "1 - POINT GUARD") and data-t (2-4 sentence coaching detail) attributes for tooltips. Fill/stroke per this mapping: ${JSON.stringify(PLAYER_COLORS)}.
- REQUIRED on every player circle: immediately after the <circle>, add a matching <text> element showing that player's jersey number, centered exactly on it (x/y equal to the circle's cx/cy, text-anchor='middle', dy='0.35em', font-family='Bebas Neue, sans-serif', font-size=13, font-weight='700', fill='#ffffff', stroke='#0d1017', stroke-width='2', paint-order='stroke fill' -- the stroke keeps the number legible against every fill color). Example: <circle cx='180' cy='285' r='13' class='pc' fill='#f0b429' stroke='#ffd060' data-l='...' data-t='...'/><text x='180' y='285' text-anchor='middle' dy='0.35em' font-family='Bebas Neue, sans-serif' font-size='13' font-weight='700' fill='#ffffff' stroke='#0d1017' stroke-width='2' paint-order='stroke fill'>1</text>. Never render a bare colored circle with no visible number.
- Solid circle = where player BEGINS the phase. If a player moves, add a ghost circle (r=6, fill none, stroke same color, stroke-dasharray "3,3") at their END position, plus a line connecting start to end, with the arrowhead touching the ghost circle's edge (never floating in open space). Line style depends on movement type:
  - Dribbling with the ball: a tight, very high-frequency zigzag/sine path (small back-and-forth segments along the route, not a straight line), stroke-width 2.5.
  - Cutting/relocating without the ball: a plain straight or gently curved solid line, stroke-width 2.0-2.5.
  - A pass: dashed line, stroke-dasharray "7,4", stroke-width 2.0.  Players who don't move: solid circle only, no ghost, no line.
- Screens/picks: the screener's own circle stays put at their set position (no ghost/line needed for them). At the exact point where the cutter or dribbler's path meets the screener, draw a short straight "T-bar" segment (length ~14-16, stroke-width 2.5, matching the moving player's stroke color) perpendicular to that player's direction of travel AT THAT CONTACT POINT (not their overall start-to-end direction) -- this is the standard basketball-diagram symbol for a screen. Never omit it when the phase involves a screen or pick.
- Ball dot r=6 fill=#ff6b00 stroke=white, placed just outside the ball-handler's circle on the side closest to the basket.
- Footer caption bar: rect x=32 y=396 width=456 height=14 fill="rgba(0,0,0,.55)", centered text x=260 font-size=10 fill=#f0b429 font-weight=600, format "PHASE NAME - key action" (max ~80 chars, one line).
- Marker/gradient IDs: every phase must use its own unique IDs, prefixed with the phase number, so multiple phases' SVGs sitting in the same page never collide (e.g. phase 2's gold arrow marker id="p2-au"). Use these two-letter color codes for arrow/gradient markers: au=gold, ag=green, ab=blue, ar=red, ap=purple, at=teal -- matching the player's stroke color for that arrow. Example: phase 3's blue player's dribble-path arrowhead is id="p3-ab".
- Named position anchors (half-court) -- use these exactly, do not invent your own coordinates for these spots:
  Elbows: right cx=340, left cx=180 (elbow-level cy=285 for DOWN, cy=135 for UP).
  Corners: right cx=462, left cx=58 (cy=355 for DOWN, cy=65 for UP).
  Top slots (guard spots above the arc, e.g. wings relocating out of a corner): cy=205 for DOWN, cy=215 for UP.
  Center top (ball-handler's start spot at the top of the key): cx=260 (cy=185 for DOWN, cy=235 for UP).
  Blocks (low lane spot right at the key, near the rim): right cx=313, left cx=207 (cy=390 for DOWN, cy=30 for UP).
  Short corner (between the block and the deep corner, still near the baseline): right cx=388, left cx=132 (cy=385 for DOWN, cy=35 for UP).
  Wings (outside the arc, between the corner and the top of the key): right cx=430, left cx=90 (cy=250 for DOWN, cy=170 for UP).
- Named position anchors (full court) -- same spots, mirrored per basket:
  Defensive basket (top): elbows cx=340/180 cy=118, corners cx=462/58 cy=48, blocks cx=313/207 cy=13, short corner cx=388/132 cy=18, wings cx=430/90 cy=153, top slots cy=198, center top cy=218.
  Attacking basket (bottom): elbows cx=340/180 cy=382, corners cx=462/58 cy=452, blocks cx=313/207 cy=487, short corner cx=388/132 cy=482, wings cx=430/90 cy=347, top slots cy=302, center top cy=282.
  
## Sidebar HTML Rules
- Wrap in a single top-level <div> (this fragment gets inserted into a container, don't repeat page chrome).
- <h3> phase name in Title Case.
- Numbered coaching points as <div class="cp"><span class="cp-n">N</span><span class="cp-t">...</span></div>, referencing players via <span class="pill p1">1</span> (p1 gold, p2 green, p3 blue, p4 purple, p5 red).
- One ".kbox" div: if level is "youth", label it "For Parents" and write analogy-driven content for a parent in the stands. For any other level, label it "Coach's Eye" or "Concept" and write tactical/conceptual content for players/coaches -- never address parents directly outside youth level.
- One ".bbridge" div explaining the structural connection to the NEXT phase (omit entirely if this is the final phase -- the caller will tell you if it is).
- Voice: PLAYERS get direct/actionable language, COACHES get technical/reads-based language, both woven into the coaching points. Frame common errors as "what the defense wants," never player failure. Use they/them, no he/him defaults. Calibrate depth to coaching level (youth = more analogy fewer reads; college/pro = full tactical depth, more defensive reads/counters).
- All output pure ASCII -- use HTML entities for anything outside standard ASCII (&mdash; &ldquo; &rdquo; &rarr; etc.)`;
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, { error: "Method not allowed" }, 405);
  }

  const body = req.body;

  if (!body || typeof body !== "object") {
    return sendJson(res, { error: "Invalid JSON body" }, 400);
  }

  const { programId, brief, category, subCategory } = body;

  if (!programId || !brief || !Array.isArray(brief.phases) || brief.phases.length === 0) {
    return sendJson(res, { error: "Missing or invalid brief" }, 400);
  }

  const resolvedCategory = PLAY_CATEGORIES.includes(category) ? category : null;

  // subCategory is only meaningful (and required) for offense/defense. If
  // this category needs one but the value sent isn't in its allowed set,
  // reject outright rather than silently storing null and letting the play
  // fall into an inferred/"Other" bucket downstream.
  const allowedSubCategories = SUB_CATEGORIES_BY_CATEGORY[resolvedCategory];
  let resolvedSubCategory = null;
  if (allowedSubCategories) {
    if (!allowedSubCategories.includes(subCategory)) {
      return sendJson(
        res,
        { error: `subCategory must be one of: ${allowedSubCategories.join(", ")} for category "${resolvedCategory}"` },
        400
      );
    }
    resolvedSubCategory = subCategory;
  }

  const authResult = await validateCoachSession(req, programId);
  if (!authResult.ok) {
    return sendJson(res, { error: authResult.error }, authResult.status);
  }
  const { user, supabase } = authResult;

  const slug = slugify(brief.playName || "untitled-play");

  // Staff-submission gate: only a coach with can_publish=true on this
  // program gets their build published immediately. Everyone else's build
  // lands as 'in_review' -- visible to the whole coaching staff on the
  // dashboard, but not on the public team page (play_directory only
  // exposes status='published') -- until a publisher approves it.
  const { data: coachRow } = await supabase
    .from("program_coaches")
    .select("can_publish")
    .eq("program_id", programId)
    .eq("coach_id", user.id)
    .maybeSingle();
  const initialStatus = coachRow && coachRow.can_publish ? "published" : "in_review";

  // Everything in this handler has to finish inside Vercel's 60s function
  // limit. The per-phase Claude calls (below) are the slow part and already
  // run in parallel with each other; the plays-row write doesn't depend on
  // their output at all, so run it CONCURRENTLY with phase generation
  // instead of strictly after it -- that fully hides its latency under the
  // AI calls' own time instead of adding to the total. A single `upsert`
  // (matching the `unique (program_id, slug)` constraint) replaces the old
  // select-then-insert-or-update pattern, cutting a full round trip too.
  // Re-running a build for the same play updates that row in place rather
  // than creating a duplicate.
  let phaseResults, playRow;
  try {
    const [pr, row] = await Promise.all([
      Promise.all(
        brief.phases.map((phase, idx) =>
          generatePhaseContent(phase, brief, idx === brief.phases.length - 1)
        )
      ),
      supabase
        .from("plays")
        .upsert(
          {
            program_id: programId,
            slug,
            title: brief.playName || "Untitled Play",
            play_type: resolvedCategory,
            sub_category: resolvedSubCategory,
            phase_count: brief.phases.length,
            court_type: brief.courtType || "half",
            status: initialStatus,
            created_by: user.id,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "program_id,slug" }
        )
        .select()
        .single()
        .then(({ data, error }) => {
          if (error) throw error;
          return data;
        }),
    ]);
    phaseResults = pr;
    playRow = row;
  } catch (err) {
    return sendJson(res, { error: `Play generation failed: ${err.message}` }, 502);
  }

  const html = buildShellHtml(brief, phaseResults);
  const blobPath = `generated/${playRow.id}.html`;

  let blobResult;
  try {
    blobResult = await put(blobPath, html, {
      access: "public",
      contentType: "text/html",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentDisposition: "inline",
    });
  } catch (err) {
    return sendJson(res, { error: `Failed to save playbook: ${err.message}` }, 502);
  }

  const { error: updateErr } = await supabase
    .from("plays")
    .update({ storage_url: blobResult.url })
    .eq("id", playRow.id);
  if (updateErr) {
    // The play and the file both exist at this point -- just the DB
    // record's storage_url link didn't save. Don't fail the whole
    // request over it; the coach still gets a working URL back.
    console.log(`[generate-playbook] Failed to update storage_url for play ${playRow.id}: ${updateErr.message}`);
  }

  return sendJson(res, { url: blobResult.url, playId: playRow.id, status: initialStatus });
}

// Defensive: the prompt tells the model NOT to include its own outer <svg>
// tag (the code supplies the court + real <svg> wrapper already), but if
// it does anyway, that nested tag brings its own coordinate system and
// silently rescales/mispositions everything inside it. Strip it rather
// than trusting compliance.
function stripOuterSvgWrapper(fragment) {
  const trimmed = (fragment || "").trim();
  const match = trimmed.match(/^<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/i);
  return match ? match[1] : trimmed;
}

// Anthropic's raw SVG/HTML fields inside the phase JSON response often
// contain literal newlines (the model formats multi-line markup for
// readability), which the JSON spec forbids unescaped inside a string --
// that's the "Bad control character in string literal" parse failure.
// Walk the text and escape control characters, but ONLY while inside a
// string literal, so real structural whitespace between JSON tokens is
// left alone.
function sanitizeJsonControlChars(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      const code = text.charCodeAt(i);
      if (code < 0x20) {
        if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else out += "\\u" + code.toString(16).padStart(4, "0");
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}
async function generatePhaseContent(phase, brief, isFinalPhase) {
  const userPrompt = `Generate the diagram and sidebar for this phase.

Play: ${brief.playName || "(untitled)"}
Court type: ${brief.courtType || "half"}
${brief.courtType === "half" ? `Basket position: ${brief.basketOrientation === "up" ? "up (basket near the top)" : "down (basket near the bottom, the default)"}` : ""}
Coaching level: ${brief.level || "high-school"}
This is ${isFinalPhase ? "the FINAL phase (omit the bbridge)" : "NOT the final phase (include a bbridge to the next phase)"}.

Phase data:
${JSON.stringify(phase, null, 2)}`;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 10000,
      system: PHASE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error on phase ${phase.phaseNumber}: ${errText}`);
  }

  const data = await res.json();
  console.log(`[generate-playbook] phase ${phase.phaseNumber} usage:`, data.usage);
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) {
    throw new Error(`No text response for phase ${phase.phaseNumber}`);
  }

  const cleaned = textBlock.text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "");

  // Defensive: some responses add conversational preamble before the JSON
  // despite the "no preamble" instruction (e.g. "Here is the diagram...").
  // Extract just the {...} object rather than trusting compliance alone.
  const startMatch = cleaned.match(/\{\s*"/);
  const firstBrace = startMatch ? startMatch.index : cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  const jsonSlice = firstBrace !== -1 && lastBrace > firstBrace ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned;

  let parsed;
  try {
    parsed = JSON.parse(sanitizeJsonControlChars(jsonSlice));
  } catch (err) {
    throw new Error(`Invalid JSON for phase ${phase.phaseNumber}: ${err.message}`);
  }

  return {
    phaseNumber: phase.phaseNumber,
    phaseName: phase.phaseName,
    diagramSvg: stripOuterSvgWrapper(parsed.diagramSvg) || "",
    sidebarHtml: parsed.sidebarHtml || "",
  };
}

function buildShellHtml(brief, phaseResults) {
  const tabs = phaseResults
    .map(
      (p, i) =>
        `<button class="tab-btn${i === 0 ? " active" : ""}" data-phase="${p.phaseNumber}" onclick="switchPhase(${p.phaseNumber})">PHASE ${p.phaseNumber}<br><span class="tab-name">${escapeHtml(p.phaseName)}</span></button>`
    )
    .join("\n");

  const courtSvgOpen = buildCourtSvgOpen(brief);

  const diagrams = phaseResults
    .map(
      (p, i) =>
        `<div class="phase-diagram${i === 0 ? " active" : ""}" id="pd-${p.phaseNumber}">${courtSvgOpen}${p.diagramSvg}</svg></div>`
    )
    .join("\n");

  const sidebars = phaseResults
    .map(
      (p, i) =>
        `<div class="phase-sidebar${i === 0 ? " active" : ""}" id="sb-${p.phaseNumber}">${p.sidebarHtml}</div>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(brief.playName || "ChalkTalk Play")}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:wght@400;500;700&family=DM+Sans:wght@300;400;500;700&display=swap');
  :root {
    --bg: #0d1017; --panel: #121820; --panel-2: #161e29; --border: #1e2a3a;
    --gold: #f0b429; --white: #f2ede4; --gray: #6b7a8d; --teal: #1abc9c;
    --kbox-bg: #2a2318; --kbox-border: #5c4a1f;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--white); font-family: 'DM Sans', sans-serif; padding: 24px; }
  .home-link { display: inline-block; color: var(--gray); text-decoration: none; font-size: 13px; margin-bottom: 16px; }
  .home-link:hover { color: var(--gold); }
  h1 { font-family: 'Bebas Neue', sans-serif; font-size: 32px; letter-spacing: 1px; color: var(--gold); margin: 0 0 20px; }
  .progress-bar { height: 4px; background: var(--border); border-radius: 2px; margin-bottom: 20px; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--gold); transition: width 0.3s; }
  .tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
  .tab-btn { font-family: 'DM Mono', monospace; font-size: 11px; background: var(--panel-2); border: 1px solid var(--border); color: var(--gray); padding: 8px 14px; border-radius: 8px; cursor: pointer; text-align: left; }
  .tab-btn.active { border-color: var(--gold); color: var(--gold); }
  .tab-name { font-family: 'DM Sans', sans-serif; font-size: 12px; font-weight: 600; }
  .layout { display: grid; grid-template-columns: 1.3fr 1fr; gap: 24px; }
  @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
  .phase-diagram, .phase-sidebar { display: none; }
  .phase-diagram.active, .phase-sidebar.active { display: block; }
  .phase-diagram svg { width: 100%; height: auto; background: #0a0d12; border: 1px solid var(--border); border-radius: 8px; }
  .phase-sidebar { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
  .phase-sidebar h3 { font-family: 'Bebas Neue', sans-serif; color: var(--gold); font-size: 22px; letter-spacing: 0.5px; margin-top: 0; }
  .cp { display: flex; gap: 10px; margin-bottom: 10px; font-size: 14px; line-height: 1.5; }
  .cp-n { flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%; background: var(--panel-2); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--gold); }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 12px; font-weight: 700; color: #0d1017; }
  .p1 { background: #f0b429; } .p2 { background: #27ae60; } .p3 { background: #7db3ff; } .p4 { background: #c39bd3; } .p5 { background: #ff7b6e; }
  .kbox { background: var(--kbox-bg); border: 1px solid var(--kbox-border); border-radius: 8px; padding: 14px; margin-top: 16px; font-size: 13px; line-height: 1.6; }
  .bbridge { background: rgba(26,188,156,0.08); border: 1px solid var(--teal); border-radius: 8px; padding: 14px; margin-top: 16px; font-size: 13px; line-height: 1.6; }
  #tip { position: absolute; display: none; background: #1a1400; border: 1px solid var(--gold); color: var(--white); padding: 8px 12px; border-radius: 6px; font-size: 12px; max-width: 240px; z-index: 100; pointer-events: none; }
</style>
</head>
<body>

<a class="home-link" href="index.html">&larr; Return to Homepage</a>
<h1>${escapeHtml(brief.playName || "PLAY")}</h1>

<div class="progress-bar"><div class="progress-fill" id="progressFill" style="width: ${Math.round(100 / phaseResults.length)}%"></div></div>

<div class="tabs">
${tabs}
</div>

<div class="layout">
  <div class="diagrams">
${diagrams}
  </div>
  <div class="sidebars">
${sidebars}
  </div>
</div>

<div id="tip"></div>

<script>
  const totalPhases = ${phaseResults.length};
  function switchPhase(n) {
    document.querySelectorAll('.phase-diagram, .phase-sidebar').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById('pd-' + n).classList.add('active');
    document.getElementById('sb-' + n).classList.add('active');
    document.querySelector('.tab-btn[data-phase="' + n + '"]').classList.add('active');
    document.getElementById('progressFill').style.width = Math.round((n / totalPhases) * 100) + '%';
  }
  const tip = document.getElementById('tip');
  document.addEventListener('mouseover', (e) => {
    const pc = e.target.closest('.pc');
    if (!pc) return;
    tip.textContent = pc.getAttribute('data-t') || pc.getAttribute('data-l') || '';
    tip.style.display = 'block';
  });
  document.addEventListener('mousemove', (e) => {
    if (tip.style.display === 'block') {
      tip.style.left = (e.pageX + 12) + 'px';
      tip.style.top = (e.pageY + 12) + 'px';
    }
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('.pc')) tip.style.display = 'none';
  });
</script>

</body>
</html>`;
}

function slugify(str) {
  return (
    str
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "untitled-play"
  );
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sendJson(res, obj, status = 200) {
  res.status(status).json(obj);
}
