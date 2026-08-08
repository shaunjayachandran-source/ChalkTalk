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
 * Auth: requires a valid, active token from tokens.json whose role
 * is "coach", and the token must belong to the program being built
 * for. Same enforcement pattern as check-token.js.
 *
 * Body (JSON):
 *   {
 *     token: string,
 *     program: string,
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

import { readFile } from "fs/promises";
import path from "path";

// Runs on Vercel's default Node.js runtime — Edge Functions have a hard
// ~25s cap that can't be extended, and open-ended play descriptions can
// take the model longer to reason through than that.
export const config = { maxDuration: 60 };

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

const BRIEF_SYSTEM_PROMPT = `You are a basketball play analyst. A coach will describe a play in plain language, sometimes with a hand-drawn diagram image. Your ONLY job right now is to extract a STRUCTURED BRIEF of what happens — you are NOT generating any HTML, CSS, or SVG code.

Court coordinate system (half-court, viewBox 0 0 520 420 — use these ranges when placing players):
- Basket is at approximately x=260, y=370 (bottom of court)
- Elbows: left x=207 y=285, right x=313 y=285
- Top of key / slots: y≈205
- Deep corners: left x=58 y=355, right x=462 y=355
- Center top (above the arc): x=260 y=185
- Court spans roughly x=15 to x=504, y=110 to y=397

For full-court plays (viewBox 0 0 520 500), defensive basket is near y=28, half-court line is y=252, attacking basket is near y=472. Scale positions proportionally.

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

If the coach mentions a specific number of phases, honor it; otherwise infer a sensible phase count from the description.`;

export default async function handler(req) {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const {
    token,
    program,
    playName,
    courtType,
    level,
    phaseCount,
    description,
    imageBase64,
    imageMediaType,
  } = body || {};

  if (!token || !program || !description) {
    return json({ error: "Missing required fields" }, 400);
  }

  // ---- Auth: validate token against tokens.json, require role=coach ----
  const authResult = await validateCoachToken(req, token, program);
  if (!authResult.ok) {
    return json({ error: authResult.error }, authResult.status);
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
        max_tokens: 4000,
        system: BRIEF_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });
    console.log(`[generate-brief] Anthropic call took ${Date.now() - callStart}ms, status ${anthropicRes.status}`);
  } catch (err) {
    console.log(`[generate-brief] Anthropic call FAILED after ${Date.now() - callStart}ms: ${err.message}`);
    return json({ error: "Failed to reach Anthropic API" }, 502);
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return json({ error: `Anthropic API error: ${errText}` }, 502);
  }

  const data = await anthropicRes.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");

  if (!textBlock) {
    return json({ error: "No text response from model" }, 502);
  }

  let brief;
  try {
    const cleaned = textBlock.text
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "");
    brief = JSON.parse(cleaned);
  } catch (err) {
    return json(
      { error: "Model did not return valid JSON", raw: textBlock.text },
      502
    );
  }

  brief.phases = (brief.phases || []).map(fillMissingPlayers);

  return json({ brief });
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

/**
 * Validates that `token` is active, has role "coach", and belongs to `program`.
 * Reads tokens.json directly from the filesystem (bundled with this
 * function's deployment) rather than fetching it over the network —
 * a self-referential network fetch back to the same deployment proved
 * unreliable on the Node.js runtime and could hang indefinitely.
 */
async function validateCoachToken(req, token, program) {
  let tokens;
  try {
    const tokensPath = path.join(process.cwd(), "tokens.json");
    const raw = await readFile(tokensPath, "utf-8");
    tokens = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `Could not load token list: ${err.message}`, status: 500 };
  }

  const programTokens = tokens[program];
  const entry = programTokens && programTokens[token];

  if (!entry || entry.active !== true) {
    return { ok: false, error: "Invalid or inactive token", status: 403 };
  }

  if (entry.role !== "coach") {
    return { ok: false, error: "Only coaches can generate plays", status: 403 };
  }

  return { ok: true };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
