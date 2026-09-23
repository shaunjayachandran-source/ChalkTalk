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
import { validatePhaseOutput } from "./_lib/validate-diagram.js";
import { getPlanLimits } from "./_lib/plan-limits.js";

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

// Fixed placement rects, matching the proven reference implementation
// (melo15u.vercel.app) exactly: ONE rect per court type, used for every
// asset regardless of that asset's native aspect ratio. preserveAspectRatio
// "none" stretches the image to fill the rect exactly rather than centering
// it proportionally -- this is what lets a single set of named position
// anchors (elbow, block, corner, etc. below) stay valid across every real
// court image instead of needing per-asset recalibration.
const COURT_PLACEMENT = {
  half: { x: 15, y: 110, width: 489, height: 287 },
  full: { x: 8, y: 4, width: 504, height: 464 },
};

const COURT_FILES = {
  half: {
    hs: { down: "half-hs-down.png", up: "half-hs-up.png" },
    pro: { down: "half-pro-down.png", up: "half-pro-up.png" },
  },
  full: {
    hs: "full-hs-vertical.png",
    pro: "full-pro-vertical.png",
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
  const rect = isFull ? COURT_PLACEMENT.full : COURT_PLACEMENT.half;
  const file = isFull ? COURT_FILES.full[bucket] : COURT_FILES.half[bucket][brief.basketOrientation === "up" ? "up" : "down"];
  const image = `<image href="${COURT_ASSET_BASE}/${file}" x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" preserveAspectRatio="none"/>`;
  return `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg">${image}`;
}

// KNOWN FAILURE MODES: before editing this prompt, read
// claude/known-failure-modes.md in the ChalkTalk project (Claude
// Projects -> ChalkTalk). It logs every diagram-generation bug found so
// far, its root cause, and the fix commit -- so this prompt doesn't
// re-drift into a bug already solved once. Log any new one you find or
// fix here too. Every prompt change to this constant should also be
// checked with validatePhaseOutput() (api/_lib/validate-diagram.js) on a
// real generation before being called "fixed" -- a correct-looking
// instruction is not the same as the model obeying it.
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
- REQUIRED, read this before placing anything: every player object in the "Phase data" JSON you're given already has exact startX/startY (where they begin this phase) and endX/endY (where they end, if they move) -- these numbers were computed by an earlier step specifically for this coordinate system and are already correct. Place every player's solid circle at EXACTLY their given startX/startY, and their ghost circle (if they move) at EXACTLY their given endX/endY. NEVER recompute, adjust, average, or substitute your own coordinate for a player based on their role, the named-anchor list further below, or your own basketball knowledge -- if a player's given position looks unusual for their described role, use it anyway; it is correct and was placed there deliberately by the previous step. The named-anchor list further below exists ONLY for drawing things that do NOT already have a coordinate in the phase data (for example, exactly where along a path a screen's contact point falls).
- Player circles r=9, class="pc", with data-player="<id>" (that player's number, e.g. "1") and data-role="start" (or "ghost" for a ghost circle -- see below) IN ADDITION TO data-l (short label e.g. "1 - POINT GUARD") and data-t (2-4 sentence coaching detail) attributes for tooltips. Fill/stroke per this mapping: ${JSON.stringify(PLAYER_COLORS)}. The data-player/data-role attributes on every circle and movement line are REQUIRED, not optional decoration -- an automated check reads them to confirm your output matches the phase data.
- REQUIRED on every player circle: immediately after the <circle>, add a matching <text> element showing that player's jersey number, centered exactly on it (x/y equal to the circle's cx/cy, text-anchor='middle', dy='0.35em', font-family='Bebas Neue, sans-serif', font-size=10). Fill color depends on which player it is (contrast against that player's circle color): player 1 (gold) uses fill='#0d1017' (dark); players 2, 3, 4, and 5 (green, blue, purple, red) use fill='white'. Example for player 1: <circle cx='260' cy='185' r='9' class='pc' fill='#f0b429' stroke='#ffd060' stroke-width='1.6' data-l='...' data-t='...'/><text x='260' y='188.5' text-anchor='middle' dy='0.35em' font-family='Bebas Neue, sans-serif' font-size='10' fill='#0d1017'>1</text>. Never render a bare colored circle with no visible number.
- Solid circle = where player BEGINS the phase. If a player moves, add a ghost circle (r=8, with data-player="<id>" data-role="ghost") at their END position (using their given endX/endY -- see above), plus EXACTLY ONE line or path (with data-player="<id>" data-role="move") connecting start to end, with the arrowhead touching the ghost circle's edge (never floating in open space). Never draw a second, different line for the same player in the same phase, even if their role could arguably involve more than one concept -- one player, one movement line, period. The ghost circle uses a soft tinted look, not a plain outline: fill and stroke both use that player's own circle-fill color as an rgba with reduced opacity -- fill at .18 opacity, stroke at .65 opacity, stroke-width 1.4, stroke-dasharray "3,3". Use these exact rgba values per player: 1 (gold) rgba(240,180,41,.18) fill / rgba(240,180,41,.65) stroke; 2 (green) rgba(39,174,96,.18) / rgba(39,174,96,.65); 3 (blue) rgba(42,106,232,.18) / rgba(42,106,232,.65); 4 (purple) rgba(155,89,182,.18) / rgba(155,89,182,.65); 5 (red) rgba(224,58,46,.18) / rgba(224,58,46,.65).
- DETERMINE LINE STYLE FROM THE OBJECTIVE "hasBall" FIELD, NOT FROM YOUR OWN READING OF THE ACTION TEXT (critical): every player object in the phase data already has a "hasBall" boolean. Use it directly, exactly like this decision table, rather than guessing from how the action phrase happens to be worded (an action can say "attacks the middle" or "brings it up" without ever using the word "dribble," and this must still render as a dribble):
  - hasBall is true AND this player moves this phase (startX/Y != endX/Y): this is a LIVE DRIBBLE. It MUST use the tight sine-wave <path> style described immediately below -- never a plain straight or gently-curved line, no matter how the action text is phrased. If you find yourself about to draw a plain <line> for a player whose hasBall is true and who is moving, stop -- that is the exact bug this rule exists to prevent.
  - hasBall is false AND this player moves this phase: this is a cut/relocation (plain straight or gently curved solid line, stroke-width 2.0-2.5) UNLESS this same phase's data shows them receiving the ball from a teammate's pass this phase, in which case draw the passer-to-receiver connector as the dashed pass line instead (stroke-dasharray "7,4", stroke-width 2.0) and the receiver's own solid/ghost circles as normal.
  - Live dribble (hasBall true, moving): REQUIRED to be a smooth, continuous, HIGH-FREQUENCY wave -- like an actual tight sine curve, not a lazy one -- along the ENTIRE route from start to end, stroke-width 2.5, fill='none'. NEVER a jagged zigzag built from straight line-to (L) commands with hard corners -- that reads as a lightning bolt, not a dribble, even though it alternates sides. Space corner points roughly every 6-8px of travel along the route (about 4x tighter than a normal cut/zigzag spacing) -- a typical 150-200px drive needs roughly 20-30 corner points, not 5-7; do not space them out just because the route is long, the WAVELENGTH stays tight and short regardless of total distance. Build it as a single <path> using quadratic Bezier curves (Q), not L commands: alternate a fixed offset (roughly 8-10px, slightly tighter than before since the wave is now denser) to each side of the straight line from start to end for each corner point, then connect them SMOOTHLY by using each corner point as a Bezier CONTROL point and the MIDPOINT between each pair of consecutive corners as the actual on-curve point -- this rounds every corner into a continuous wave instead of a sharp angle. Concretely: given corner points C0 (=start), C1, C2, ... Cn (=end), draw 'M C0 Q C1 mid(C1,C2) Q C2 mid(C2,C3) ... Q C(n-1) Cn' -- every Q's second value is a midpoint EXCEPT the very last one, which ends exactly at Cn (the given endX/endY). Worked example for a SHORT 40px stretch of a dribble (illustrating the required ~6-8px corner spacing -- extrapolate this same density across however long the real route is): from (260,285) toward (230,255), corner points every ~7px: (260,285), (255,278), (263,271), (253,264), (261,257), (230,255) -- becomes <path d='M260,285 Q255,278 259,274.5 Q263,271 258,267.5 Q253,264 257,260.5 Q261,257 245.5,256 230,255' stroke='#f0b429' stroke-width='2.5' fill='none' marker-end='url(#...)'/> (note the last two points collapse toward the endpoint since this illustration is short -- for a real full-length route keep generating corner points at the same ~6-8px spacing all the way to the given endX/endY). Never submit a dribble path built only from L commands, and never fewer than 4 Q segments for even the shortest dribble.
- Players who don't move: solid circle only, no ghost, no line.
- Screens/picks: the screener's own circle stays put at their set position -- NO ghost circle and NO movement line/path for the screener in this phase, ever, even if the phase's narrative also mentions where they'll go later. (The phase data you're given already enforces this upstream: a screener's startX/Y and endX/Y for a screening phase are always identical. If you ever see a screener's endX/Y differ from their startX/Y in the same phase where they're also described as screening, draw them per the given coordinates anyway and do not invent an extra line for them -- one screener, one planted circle, no movement element, full stop.) REQUIRED: draw the screen symbol as a complete "T" shape with TWO parts, never just a crossbar floating alone: (1) a short stem/leg line running from the screener's circle edge outward to the contact point on the cutter or dribbler's path, and (2) a crossbar segment (length ~14-16) centered ON that contact point, perpendicular to the moving player's direction of travel AT THAT CONTACT POINT (not their overall start-to-end direction). Both the stem and the crossbar use ONE consistent stroke-width 2.5 and are drawn in the color of the player being screened (the mover/cutter/dribbler), not the screener's own color. Example: a screener sitting at the right elbow (cx=313, cy=285) with the cutter's vertical path passing 10px to the right of it at x=323, cutter is player 3 (blue, stroke #7db3ff): stem = <line x1='313' y1='285' x2='323' y2='285' stroke='#7db3ff' stroke-width='2.5'/>, crossbar (perpendicular to the cutter's vertical travel) = <line x1='323' y1='278' x2='323' y2='292' stroke='#7db3ff' stroke-width='2.5'/>. Never render a bare crossbar with no stem connecting it back to the screener -- that is an incomplete screen symbol. Never omit this when the phase involves a screen or pick.
- Ball dot r=6 fill='#ff6b00' stroke='white'. REQUIRED: it must visually touch the ball-handler's own circle, never float apart from it. Compute its position with this exact formula: take the ball-handler's circle center (hx, hy) and this phase's basket position (bx, by from the anchors above), find the unit direction vector from the handler toward the basket -- ((bx-hx)/dist, (by-hy)/dist) where dist is the straight-line distance between them -- then place the ball dot's center at hx + direction_x*15, hy + direction_y*15 (exactly 15px from the handler's center, toward the basket -- this lands it just outside the r=9 circle's edge with a small visible gap, clearly attached rather than floating in open space or off the court). Example: ball-handler player 1 at cx=260 cy=285 with a DOWN basket at cx=260 cy=375: the direction is straight down (0,1), so the ball dot goes at cx=260 cy=300 -- <circle cx='260' cy='300' r='6' fill='#ff6b00' stroke='white'/>. Never place the ball dot more than ~16px from the ball-handler's circle center, and never place it outside the visible court/viewBox bounds.
- Footer caption bar: rect x=32 y=396 width=456 height=14 fill="rgba(0,0,0,.55)", centered text x=260 font-size=10 fill=#f0b429 font-weight=600, format "PHASE NAME - key action" (max ~80 chars, one line).
- Marker/gradient IDs: every phase must use its own unique IDs, prefixed with the phase number, so multiple phases' SVGs sitting in the same page never collide (e.g. phase 2's gold arrow marker id="p2-au"). Use these two-letter color codes for arrow/gradient markers: au=gold, ag=green, ab=blue, ar=red, ap=purple, at=teal -- matching the player's stroke color for that arrow. Example: phase 3's blue player's dribble-path arrowhead is id="p3-ab".
- Named position anchors: use ONLY the table below matching this phase's actual court type (half vs full) -- given at the top of this prompt as "Court type: half" or "Court type: full". These two tables use DIFFERENT coordinate systems (different viewBox, different court-image placement) even where the cx values look identical -- pulling a cy value from the wrong table is a real, confirmed bug class (a full-court "defensive basket" cy is only valid inside the full-court rectangle, and will render off the visible court entirely if used on a half-court play, or vice versa). Never mix the two tables within one phase.
- Named position anchors (half-court) -- use these exactly, do not invent your own coordinates for these spots:  
  Elbows: right cx=313, left cx=207 (elbow-level cy=285 for DOWN, cy=222 for UP).
  Corners: right cx=462, left cx=58 (cy=355 for DOWN, cy=152 for UP).
  Top slots (guard spots above the arc, e.g. wings relocating out of a corner): cy=205 for DOWN, cy=302 for UP.
  Center top (ball-handler's start spot at the top of the key): cx=260 (cy=185 for DOWN, cy=322 for UP).
  Free-throw line center (default start for a player who will screen at either elbow): cx=260 (cy=285 for DOWN, cy=222 for UP).
  Blocks (low lane spot right at the key, near the rim): right cx=313, left cx=207 (cy=338 for DOWN, cy=169 for UP).
  Screen spot outside the block (baseline/flex screen standing position -- just outside the block toward the sideline, NOT the same spot as the Block anchor itself): right cx=338, left cx=182 (cy=345 for DOWN, cy=162 for UP).
  Short corner (between the block and the deep corner, still near the baseline): right cx=388, left cx=132 (cy=385 for DOWN, cy=122 for UP).
  Wings (outside the arc, between the corner and the top of the key -- use only for wing-specific formations like a 1-3-1 or flex, NOT as a stand-in for 4-out/5-out slot spacing): right cx=430, left cx=90 (cy=250 for DOWN, cy=257 for UP).
  Slot (elevated guard spot for a 4-out/5-out alignment, well beyond the arc -- verified against the real 3pt arc, which is an ellipse centered at cx=260 cy=350 DOWN / cy=157 UP with radius ~190 horizontal / ~110 vertical): right cx=385, left cx=135 (cy=200 for DOWN, cy=307 for UP). A 4-out/5-out set's two non-corner perimeter players belong HERE, not at Wings.
- Named position anchors (full court) -- same spots, mirrored per basket:
  Defensive basket (top): elbows cx=313/207 cy=118, corners cx=462/58 cy=48, blocks cx=313/207 cy=13, short corner cx=388/132 cy=18, wings cx=430/90 cy=153, top slots cy=198, center top cy=218.
  Attacking basket (bottom): elbows cx=313/207 cy=382, corners cx=462/58 cy=452, blocks cx=313/207 cy=487, short corner cx=388/132 cy=482, wings cx=430/90 cy=347, top slots cy=302, center top cy=282.

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

  // PLAYBOOK-CAP CHECK (Phase 2, Prompt 8, added 2026-09-23, decision D5:
  // "active" means published and not hidden). Counts existing plays for
  // this program only when the play about to be created is a genuinely
  // NEW slug -- re-running a build for an existing play (the upsert
  // below, onConflict program_id,slug) updates that row in place and must
  // never count as a new set. KNOWN LOOPHOLE, per D5's own definition:
  // an in_review play (a coach without can_publish building one) doesn't
  // count toward the cap until it's actually published, since D5 counts
  // published-and-not-hidden only -- flagging this rather than silently
  // tightening D5's definition without checking with Shaun first.
  const { data: programPlanRow, error: programPlanErr } = await supabase
    .from("programs")
    .select("plan")
    .eq("id", programId)
    .maybeSingle();
  if (programPlanErr) {
    return sendJson(res, { error: `Could not resolve this program's plan: ${programPlanErr.message}` }, 500);
  }
  const planLimits = getPlanLimits(programPlanRow ? programPlanRow.plan : null);
  if (planLimits.playbookCap !== null) {
    const { data: existingPlay } = await supabase
      .from("plays")
      .select("id")
      .eq("program_id", programId)
      .eq("slug", slug)
      .maybeSingle();
    if (!existingPlay) {
      const { count, error: countErr } = await supabase
        .from("plays")
        .select("id", { count: "exact", head: true })
        .eq("program_id", programId)
        .eq("status", "published")
        .eq("hidden", false);
      if (countErr) {
        return sendJson(res, { error: `Could not check current playbook count: ${countErr.message}` }, 500);
      }
      if ((count || 0) >= planLimits.playbookCap) {
        return sendJson(
          res,
          {
            error: `This program's plan allows up to ${planLimits.playbookCap} active playbook set(s), and it's already at that limit. Ask about upgrading to build more.`,
          },
          403
        );
      }
    }
  }

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

  const diagramWarnings = phaseResults.flatMap((p) =>
    (p.diagramIssues || []).map((issue) => `Phase ${p.phaseNumber} (${p.phaseName}): ${issue}`)
  );
  if (diagramWarnings.length) {
    console.warn(`[generate-playbook] play ${playRow.id} has ${diagramWarnings.length} diagram validation warning(s).`);
  }
 
  return sendJson(res, {
    url: blobResult.url,
    playId: playRow.id,
    status: initialStatus,
    diagramWarnings: diagramWarnings.length ? diagramWarnings : undefined,
  });}

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

  const diagramSvg = stripOuterSvgWrapper(parsed.diagramSvg) || "";
 
  // Deterministic check, not another LLM call -- see
  // api/_lib/validate-diagram.js and claude/known-failure-modes.md.
  // Non-blocking for now (log + surface, don't fail the request): a false
  // positive here shouldn't stop a coach from getting their playbook, but
  // a real miss should be visible in Vercel logs and in the response
  // immediately, not discovered later from a screenshot.
  const { ok: diagramOk, issues: diagramIssues } = validatePhaseOutput(phase, diagramSvg, brief.courtType);
  if (!diagramOk) {
    console.warn(`[generate-playbook] phase ${phase.phaseNumber} diagram validation found ${diagramIssues.length} issue(s):`, diagramIssues);
  }
 
  return {
    phaseNumber: phase.phaseNumber,
    phaseName: phase.phaseName,
    diagramSvg,
    sidebarHtml: parsed.sidebarHtml || "",
    diagramIssues,
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
