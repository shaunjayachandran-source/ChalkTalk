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

export const config = { runtime: "edge" };

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

Infer reasonable court positions even if the coach's description is imprecise — always fill in startX/startY/endX/endY with your best estimate using the coordinate system above. If the coach mentions a specific number of phases, honor it; otherwise infer a sensible phase count from the description. Every player who appears in a phase must have a full position, even if they didn't move (startX/Y == endX/Y).`;

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
        max_tokens: 2000,
        system: BRIEF_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });
  } catch (err) {
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

  return json({ brief });
}

/**
 * Validates that `token` is active, has role "coach", and belongs to `program`.
 * Fetches tokens.json from the same origin, same pattern as check-token.js.
 */
async function validateCoachToken(req, token, program) {
  const reqUrl = new URL(req.url);

  let tokens;
  try {
    const res = await fetch(new URL("/tokens.json", reqUrl), {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`tokens.json fetch ${res.status}`);
    tokens = await res.json();
  } catch (err) {
    return { ok: false, error: "Could not load token list", status: 500 };
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
