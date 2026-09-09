/**
 * POST /api/generate-brief
 *
 * Step 1 of the playbook builder: takes a coach's typed description
 * (and optional hand-drawn diagram image) and returns a STRUCTURED
 * BRIEF — phase-by-phase player positions and actions — WITHOUT
 * generating the final HTML yet. This is what the preview screen
 * renders so the coach can confirm player locations before the
 * expensive full build step runs.
 *
 * Auth: requires a Supabase coach session (Authorization: Bearer
 * <access_token> header) that owns the programId being built for.
 * See api/_lib/validate-session.js.
 *
 * Body (JSON):
 *   {
 *     programId: string,
 *     playName: string,
 *     courtType: "half" | "full",
 *     level: string,           // youth | high-school | prep | college | pro
 *     phaseCount: number,
 *     description: string,
 *     imageBase64?: string,    // optional hand-drawn diagram, base64 (no prefix)
 *     imageMediaType?: string  // e.g. "image/png", required if imageBase64 present
 *   }
 *
 * Response (JSON):
 *   { brief: { phases: [ ... ] } }
 *   or { error: string } with an appropriate status code
 */

import { validateCoachSession } from "./_lib/validate-session.js";

// Runs on Vercel's default Node.js runtime — Edge Functions have a hard
// ~25s cap that can't be extended, and open-ended play descriptions can
// take the model longer to reason through than that.
export const config = { maxDuration: 180 };

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

const BRIEF_SYSTEM_PROMPT = `You are a basketball play analyst. A coach will describe a play in plain language, sometimes with a hand-drawn diagram image. Your ONLY job right now is to extract a STRUCTURED BRIEF of what happens — you are NOT generating any HTML, CSS, or SVG code.

Court coordinate system (half-court, viewBox 0 0 520 420 — use these ranges when placing players). The coach also specifies a basket position, either DOWN (basket near the bottom, the default) or UP (basket near the top, vertically mirrored) -- use whichever anchor set matches what you were told for this request:

DOWN (basket at bottom):
- Basket is at approximately x=260, y=375
- Elbows: left x=207 y=285, right x=313 y=285
- Blocks: left x=207 y=338, right x=313 y=338
- Short corner: left x=132 y=385, right x=388 y=385
- Wings: left x=90 y=250, right x=430 y=250
- Top of key / slots: y≈205
- Deep corners: left x=58 y=355, right x=462 y=355
- Center top (above the arc): x=260 y=185

UP (basket at top -- every y above mirrored as 420 minus the DOWN value):
- Basket is at approximately x=260, y=45
- Elbows: left x=207 y=135, right x=313 y=135
- Blocks: left x=207 y=82, right x=313 y=82
- Short corner: left x=132 y=35, right x=388 y=35
- Wings: left x=90 y=170, right x=430 y=170
- Top of key / slots: y≈215
- Deep corners: left x=58 y=65, right x=462 y=65
- Center top (below the arc, toward mid-court): x=260 y=235

Court spans roughly x=15 to x=504, y=110 to y=397 either way.

For full-court plays (viewBox 0 0 520 500), basket position doesn't apply (both baskets are always shown) -- defensive basket is near y=28, half-court line is y=252, attacking basket is near y=472. Scale positions proportionally.

Return ONLY valid JSON, no markdown fences, no preamble, no explanation. Match this exact schema:

{
  "playName": "string",
  "courtType": "half" or "full",
  "level": "string",
  "phases": [
    {
      "phaseNumber": 1,
      "phaseName": "SHORT ALL-CAPS NAME",
      "players": [
        {
          "number": 1,
          "startX": 000, "startY": 000,
          "endX": 000, "endY": 000,
          "hasBall": true or false,
          "action": "one short phrase describing what this player does"
        }
      ],
      "keyAction": "one sentence describing the primary action of this phase",
      "teachingCue": "a short quotable coaching phrase",
      "commonError": "what commonly goes wrong, framed as what the defense wants"
    }
  ]
}

Infer reasonable court positions even if the coach's description is imprecise — always fill in startX/startY/endX/endY with your best estimate using the coordinate system above.

IMPORTANT: Every phase must include ALL FIVE offensive players (numbers 1-5), even if the coach only described the action for one or two of them. For players not mentioned in the coach's description, place them in sensible, realistic supporting positions for that phase (e.g. spacing the floor at the opposite wing, corner, or top, or holding a natural help/safety position) with startX/Y equal to endX/Y (they don't move) and an action like "Holds floor spacing on the [location]" or "Maintains position as a safety valve." Never omit a player just because the coach didn't mention them — a real possession always has 5 players on the court.

CONTINUITY RULE (critical): a player's position cannot silently teleport between phases. For phase 2 onward, every player's startX/startY MUST exactly equal that same player's endX/endY from the immediately preceding phase — inherit their last known position, never re-guess it. Only phase 1 may set arbitrary starting positions. If a player's narrative changes in a later phase (e.g. a new cut, screen, or reversal), that phase's action/keyAction text must be consistent with wherever their carried-forward position actually is — never describe a movement that contradicts the position they were already left in.

HARD CAP: never generate more than 8 phases total, no matter how long or continuous the described action is (e.g. a full motion-offense cycle back to starting spots). If the play logically needs more to fully resolve, consolidate the least essential intermediate movements so the whole thing still fits in 8 phases or fewer -- a coach can always describe a follow-up play separately. This cap exists because the response has a fixed size budget; going over it produces a cut-off, invalid response instead of a complete one.`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, { error: "Method not allowed" }, 405);
  }

  const body = req.body;

  if (!body || typeof body !== "object") {
    return sendJson(res, { error: "Invalid JSON body" }, 400);
  }

  const {
    programId,
    playName,
    courtType,
    basketOrientation,
    level,
    phaseCount,
    description,
    imageBase64,
    imageMediaType,
  } = body;

  // Basket orientation only applies to half court; default to "down" (the
  // original behavior) whenever it's missing or the court is full.
  const resolvedOrientation = courtType === "half" && basketOrientation === "up" ? "up" : "down";

  if (!programId || !description) {
    return sendJson(res, { error: "Missing required fields" }, 400);
  }

  // Server-side cap matching the UI's own max -- the client already limits
  // this to 8, but the API shouldn't just trust that.
  if (phaseCount !== undefined && phaseCount !== null && (phaseCount < 1 || phaseCount > 8)) {
    return sendJson(res, { error: "phaseCount must be between 1 and 8" }, 400);
  }

  // ---- Auth: require a logged-in coach who owns this program ----
  const authResult = await validateCoachSession(req, programId);
  if (!authResult.ok) {
    return sendJson(res, { error: authResult.error }, authResult.status);
  }

  // ---- Build the Anthropic API request ----
  const userContent = [];

  if (imageBase64 && imageMediaType) {
    userContent.push({
      type: "image",
      source: {
        type: "base64",
        media_type: imageMediaType,
        data: imageBase64,
      },
    });
  }

  const textPrompt = [
    `Play name: ${playName || "(untitled)"}`,
    `Court type: ${courtType || "half"}`,
    courtType === "half" ? `Basket position: ${resolvedOrientation} (${resolvedOrientation === "up" ? "basket near the top" : "basket near the bottom, the default"})` : null,
    `Coaching level: ${level || "high-school"}`,
    phaseCount ? `Target phase count: ${phaseCount}` : null,
    `Description from coach:`,
    description,
  ]
    .filter(Boolean)
    .join("\n");

  userContent.push({ type: "text", text: textPrompt });

  let anthropicRes;
  const callStart = Date.now();
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
        // Raised from 4000: a full-cycle play description (e.g. "until
        // players are back to their original spots") can produce enough
        // phases/players/text to get cut off mid-JSON at the old limit,
        // which fails to parse. This is a safety margin on top of the
        // 8-phase hard cap in the system prompt, not a substitute for it.
        max_tokens: 10000,
        system: BRIEF_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });
    console.log(`[generate-brief] Anthropic call took ${Date.now() - callStart}ms, status ${anthropicRes.status}`);
  } catch (err) {
    console.log(`[generate-brief] Anthropic call FAILED after ${Date.now() - callStart}ms: ${err.message}`);
    return sendJson(res, { error: "Failed to reach Anthropic API" }, 502);
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return sendJson(res, { error: `Anthropic API error: ${errText}` }, 502);
  }

  const data = await anthropicRes.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");

  if (!textBlock) {
    return sendJson(res, { error: "No text response from model" }, 502);
  }

  let brief;
  try {
    const cleaned = textBlock.text
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "");
    // Defensive: some responses add conversational preamble before the JSON
    // despite the "no preamble" instruction (e.g. "Here is the brief...").
    // Extract just the {...} object rather than trusting compliance alone.
    const startMatch = cleaned.match(/\{\s*"/);
    const firstBrace = startMatch ? startMatch.index : cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    const jsonSlice = firstBrace !== -1 && lastBrace > firstBrace ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned;
    brief = JSON.parse(jsonSlice);
  } catch (err) {
    // If the model ran out of room mid-response (stop_reason "max_tokens"),
    // say so specifically -- that's a distinct, actionable problem ("ask
    // for fewer phases") rather than a generic parsing failure.
    const truncated = data.stop_reason === "max_tokens";
    return sendJson(
      res,
      {
        error: truncated
          ? "The response was too long and got cut off before finishing. Try a shorter description, specify a lower phase count, or split this into two separate plays."
          : "Model did not return valid JSON",
        raw: textBlock.text,
      },
      502
    );
  }

  brief.phases = (brief.phases || []).map(fillMissingPlayers);

  // Stamp this ourselves rather than trusting the model to echo it back --
  // we already know what was requested, no need to rely on the model
  // faithfully including it in its JSON output.
  brief.basketOrientation = courtType === "half" ? resolvedOrientation : undefined;

  return sendJson(res, { brief });
}

// Default supporting-position spots (half-court coordinates) used to fill
// in any of the 5 offensive players the model didn't place in a phase.
// This guarantees every phase always shows a full 5-player alignment,
// regardless of how the model responded.
const DEFAULT_SPOTS = {
  1: { x: 260, y: 205 }, // top of key
  2: { x: 440, y: 240 }, // right wing
  3: { x: 80, y: 240 }, // left wing
  4: { x: 190, y: 350 }, // left block
  5: { x: 330, y: 350 }, // right block
};

function fillMissingPlayers(phase) {
  const present = new Set((phase.players || []).map((p) => p.number));
  const players = [...(phase.players || [])];

  for (let num = 1; num <= 5; num++) {
    if (!present.has(num)) {
      const spot = DEFAULT_SPOTS[num];
      players.push({
        number: num,
        startX: spot.x,
        startY: spot.y,
        endX: spot.x,
        endY: spot.y,
        hasBall: false,
        action: `Holds floor spacing at their position.`,
      });
    }
  }

  return { ...phase, players };
}

function sendJson(res, obj, status = 200) {
  res.status(status).json(obj);
}
