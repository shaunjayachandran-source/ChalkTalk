/**
 * POST /api/regenerate-action
 *
 * Play Data Editor, Step 10: the "Describe New Action..." path in the
 * reposition modal. A coach drags a player to a new spot, and instead of
 * the deterministic "same action, new start" re-anchor (handled entirely
 * client-side, no AI involved), they describe a genuinely different action
 * from that new spot. This endpoint turns that description into ONE
 * candidate action object matching the play-data schema.
 *
 * DELIBERATE DIFFERENCE FROM generate-playbook.js: this endpoint does NOT
 * write anything to the database and does NOT touch Vercel Blob. It only
 * returns a candidate action for the client to run through its own schema
 * validator and show in a preview (Accept / Try Again / Cancel) -- the
 * coach's explicit Accept is what actually mutates PLAY client-side, which
 * then flows through the existing Save Now path. Nothing here is ever
 * auto-applied, per the coach's explicit answer when this was scoped.
 *
 * Auth: same validateCoachSession(req, programId) pattern as
 * generate-playbook.js -- requires a Supabase coach session that owns
 * programId. Re-validated independently on every call, not cached.
 *
 * Body (JSON):
 *   {
 *     programId: string,
 *     playerId: string,          // e.g. "p1" -- the player who was repositioned
 *     playerNumber: number,      // 1-5, drives the required colorKey
 *     newPosition: { cx, cy },   // where the coach dragged them to
 *     oldAction: { ... },        // the real action object being replaced (for context + id reuse)
 *     otherPlayers: [ { id, number, cx, cy } ],  // everyone else's position this phase
 *     phaseContext: { diagramLabel, footerCaption },  // short phase framing, not the full phase
 *     description: string        // the coach's own words for what happens instead
 *   }
 *
 * Response (JSON):
 *   { action: { ... } }   -- one candidate action object, same shape as an
 *                             entry in phase.actions. NOT validated against
 *                             the schema here -- that happens client-side,
 *                             deliberately, so validation logic lives in one
 *                             place (the renderer) rather than being
 *                             duplicated between server and client.
 *   or { error: string } with an appropriate status code
 */

import { validateCoachSession } from "./_lib/validate-session.js";

export const config = { maxDuration: 30 };

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

// Same convention as generate-playbook.js's PLAYER_COLORS, but keyed to the
// two-letter marker prefixes the renderer actually uses for colorKey
// (COLOR_MAP in renderer-template.html), not hex values -- this endpoint
// only ever needs to tell Claude which marker prefix belongs to which
// player number, never the hex color itself.
const COLOR_KEY_BY_PLAYER_NUMBER = {
  1: "au", // gold
  2: "ag", // green
  3: "ab", // blue
  4: "ap", // purple
  5: "ar", // red
};

const ACTION_SYSTEM_PROMPT = `You are a basketball playbook data generator. You are given ONE player's new court position and a coach's plain-language description of what that player does from there. You return exactly ONE action object -- valid JSON, no markdown fences, no preamble, no explanation -- matching this schema:

Every action has:
  "id": string (reuse the id you're given for oldAction, so this replaces it in place)
  "type": one of "dribble", "cut", "pass", "screen"
  "colorKey": the exact two-letter code you're given for this player -- never invent a different one

If type is "screen":
  "byPlayerId": the repositioned player's id (they are setting the screen)
  "forPlayerId": the id of whichever other player they are screening for (infer from the description; pick from the otherPlayers list you're given)
  "atPoint": { "cx": number, "cy": number } -- normally the repositioned player's own newPosition
  Do NOT include playerId, path, waypoints, or endpoint on a screen action.

If type is "dribble", "cut", or "pass":
  "playerId": the repositioned player's id
  "endpoint": { "cx": number, "cy": number } -- where they end up, inferred from the description and court geometry (half-court viewBox 0 0 520 420, basket at approximately cx=260 cy=370, key/lane edges at approximately cx=180 and cx=340, top of the key around cy=205)
  Either:
    "path": an SVG path string "M startX,startY Q controlX,controlY endX,endY" (a single quadratic curve from newPosition to endpoint), for a "cut" or "pass" -- OR --
    "waypoints": an array of at least 2 {"cx","cy"} points starting at newPosition and ending at endpoint, for a "dribble" (an active dribble is drawn as a squiggle across these points, so include a middle waypoint if the description implies the path bends, e.g. going around a screen)
  A "pass" additionally needs no waypoints, just path + endpoint.
  Optionally include "contactSegment": {"from":{cx,cy},"to":{cx,cy}} -- only if this action is the one a screen elsewhere in the phase should orient its crossbar perpendicular to; omit otherwise.

Always include a short "note" string (1-2 sentences) explaining the basketball logic of what you generated, in the same explanatory style as the rest of this play's data -- plain, coach-to-coach, not generic.

Stay strictly inside the half-court viewBox (x: 15-504, y: 110-397) -- never place an endpoint or waypoint outside those bounds, and never place a finish point at or behind the basket (basket is at approximately cx=260 cy=370 -- a realistic finish is IN FRONT of that, smaller cy, not equal to or greater than it).

Return ONLY the JSON object for this one action, nothing else.`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, { error: "Method not allowed" }, 405);
  }

  const body = req.body;
  if (!body || typeof body !== "object") {
    return sendJson(res, { error: "Invalid JSON body" }, 400);
  }

  const { programId, playerId, playerNumber, newPosition, oldAction, otherPlayers, phaseContext, description } = body;

  if (!programId || !playerId || !playerNumber || !newPosition || !description) {
    return sendJson(res, { error: "Missing required fields (programId, playerId, playerNumber, newPosition, description)" }, 400);
  }
  if (!COLOR_KEY_BY_PLAYER_NUMBER[playerNumber]) {
    return sendJson(res, { error: `Invalid playerNumber: ${playerNumber}` }, 400);
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    return sendJson(res, { error: "description must be a non-empty string" }, 400);
  }

  const authResult = await validateCoachSession(req, programId);
  if (!authResult.ok) {
    return sendJson(res, { error: authResult.error }, authResult.status);
  }

  const colorKey = COLOR_KEY_BY_PLAYER_NUMBER[playerNumber];

  const userPrompt = `Repositioned player: ${playerId} (colorKey "${colorKey}")
New position (their starting point for this action): ${JSON.stringify(newPosition)}

${oldAction ? `The action being replaced (reuse its "id" field, ignore everything else about it -- the coach said this is now a DIFFERENT action):\n${JSON.stringify(oldAction, null, 2)}` : "No prior action existed for this player this phase -- generate a fresh id like \"regen-1\"."}

Other players' current positions this phase:
${JSON.stringify(otherPlayers || [], null, 2)}

Phase context: ${phaseContext ? JSON.stringify(phaseContext) : "(none given)"}

Coach's description of the new action: "${description.trim()}"`;

  let anthropicRes;
  try {
    anthropicRes = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        system: ACTION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
  } catch (err) {
    return sendJson(res, { error: `Failed to reach Anthropic API: ${err.message}` }, 502);
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return sendJson(res, { error: `Anthropic API error: ${errText}` }, 502);
  }

  const data = await anthropicRes.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) {
    return sendJson(res, { error: "No text response from Anthropic" }, 502);
  }

  const cleaned = textBlock.text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "");

  let action;
  try {
    action = JSON.parse(cleaned);
  } catch (err) {
    return sendJson(res, { error: "Model did not return valid JSON" }, 502);
  }

  return sendJson(res, { action });
}

function sendJson(res, obj, status = 200) {
  res.status(status).json(obj);
}