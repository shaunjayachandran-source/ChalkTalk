/**
 * POST /api/generate-narration
 *
 * Item 2 (Auditory Narration): generates team-wide, number-based, per-phase
 * spoken narration for an already-published play. Pre-rendered (not
 * runtime TTS) -- called once, after publish, and the result (an MP3 per
 * phase + per-player-segment timing data for synced highlighting) is
 * stored on the `plays` row and in `chalktalk-blob`.
 *
 * NOT a build-time step -- this is deliberately separate from
 * generate-playbook.js's per-phase Claude call, because narration only
 * ever runs after a play is published (see the two call sites: the
 * publish branch in generate-playbook.js, and the Publish button in
 * dashboard.html), which is always strictly later than the build step.
 *
 * Hard constraints (do not relax without checking with Shaun first):
 *   - Number-based only. Never a player's real name -- "the 1," "the 4,"
 *     "the ball handler." No roster data exists to pronounce a name
 *     correctly even if we wanted to.
 *   - Team-wide: one narration track per phase, identical for every
 *     viewer. No per-role (coach/player/parent) variants -- that's a
 *     later item that depends on accounts infrastructure this endpoint
 *     must not assume exists.
 *   - Cost control: only runs when BOTH the play's own `narration_enabled`
 *     opt-in is true AND `level !== 'youth'`. Every other level (high
 *     school, prep, college, pro) is eligible.
 *   - Grounded in the EXISTING phase data (`plays.brief_json`, written by
 *     generate-playbook.js at build time) -- this endpoint does not
 *     regenerate or reinterpret the play, only re-voices what's already
 *     there for speech.
 *
 * Body (JSON): { playId: string }
 *
 * Response (JSON):
 *   { playId, skipped: true, reason } -- gated out, not an error
 *   { playId, phases: [{ phaseNumber, audioUrl, timings, error? }] }
 *   or { error: string } with an appropriate status code
 */

import { validateCoachSession } from "./_lib/validate-session.js";
import { getSupabase } from "./_lib/knowledge-base.js";
import { put } from "@vercel/blob";

export const config = { maxDuration: 180 };

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

// ElevenLabs "with timestamps" endpoint -- returns audio AND
// character-level alignment in one call, which is what makes
// player-synced highlighting possible without a second TTS call per
// segment (keeping this to exactly one ElevenLabs call per phase, not
// one per player-segment, matters directly for free-tier character
// budget).
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // "Rachel" -- a standard ElevenLabs premade voice, used as the default until Shaun picks one.
const ELEVENLABS_TTS_URL = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/with-timestamps`;

const NARRATION_SYSTEM_PROMPT = `You write short, spoken-language narration for ONE PHASE of a basketball playbook, to be read aloud by text-to-speech to coaches, players, and parents watching together.

CRITICAL, NON-NEGOTIABLE RULES:
- NEVER use a player's real name, under any circumstance -- you do not have real names and must not invent or infer one. Refer to every player only by number or role: "the 1," "the 4," "the ball handler," "the screener," "the cutter."
- Do not address any one audience specifically (no "coaches should..." or "parents, watch for...") -- this narration is heard identically by everyone watching, team-wide.
- Keep it tight and speakable: a coach reading this phase's narration aloud should take roughly 12-20 seconds, not a full paragraph of dense text.
- Base what you write ONLY on the phase data you're given below (teaching cue, key action, common error, each player's own action, and the existing sidebar coaching content) -- do not invent new basketball detail that isn't already implied by that data.

Return ONLY valid JSON, no markdown fences, no preamble. Match this exact schema:
{
  "segments": [
    { "player": "1" or null, "text": "a short clause or sentence" }
  ]
}

Each segment is a short clause or sentence, in the order they should be spoken, concatenating into one flowing narration for the phase. Set "player" to the jersey number (as a string, e.g. "3") of whichever player that segment is actively describing, so playback can highlight that player on screen at the right moment -- use null for a segment that is general framing/transition text not about one specific player (e.g. an opening or closing line). Every segment naming a specific player action must carry that player's number.`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, { error: "Method not allowed" }, 405);
  }

  const body = req.body;
  if (!body || typeof body !== "object" || !body.playId) {
    return sendJson(res, { error: "Missing playId" }, 400);
  }
  const { playId } = body;

  // Service-role lookup first -- we need the play's program_id before we
  // can even validate the requesting coach's session against it (same
  // reason generate-playbook.js already knows programId from its own
  // request body; this endpoint only gets playId, so it looks the rest
  // up itself).
  const supabaseAdmin = getSupabase();
  const { data: play, error: playErr } = await supabaseAdmin
    .from("plays")
    .select("id, program_id, level, status, narration_enabled, brief_json")
    .eq("id", playId)
    .maybeSingle();

  if (playErr) {
    return sendJson(res, { error: `Failed to load play: ${playErr.message}` }, 500);
  }
  if (!play) {
    return sendJson(res, { error: "Play not found" }, 404);
  }

  const authResult = await validateCoachSession(req, play.program_id);
  if (!authResult.ok) {
    return sendJson(res, { error: authResult.error }, authResult.status);
  }

  // Defensive gates -- this endpoint is only ever CALLED right after a
  // publish action, but never trust the caller alone. Every gate below
  // returns 200 with skipped:true, not an error: being gated out is the
  // expected, correct outcome for most calls (e.g. every youth-level
  // play, or any play the coach didn't opt into), not a failure.
  if (play.status !== "published") {
    return sendJson(res, { playId, skipped: true, reason: "not_published" });
  }
  if (!play.narration_enabled) {
    return sendJson(res, { playId, skipped: true, reason: "narration_disabled" });
  }
  if (play.level === "youth") {
    return sendJson(res, { playId, skipped: true, reason: "youth_level_excluded" });
  }
  const phases = play.brief_json && Array.isArray(play.brief_json.phases) ? play.brief_json.phases : null;
  if (!phases || phases.length === 0) {
    // A play built before this migration has no brief_json at all -- not
    // an error the coach can fix by retrying, so say so plainly.
    return sendJson(
      res,
      { error: "This play has no stored phase data to narrate (it was likely built before narration support existed)." },
      400
    );
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    return sendJson(res, { error: "ELEVENLABS_API_KEY is not configured" }, 500);
  }

  let phaseResults;
  try {
    phaseResults = await Promise.all(phases.map((phase) => generateNarrationForPhase(phase, playId)));
  } catch (err) {
    return sendJson(res, { error: `Narration generation failed: ${err.message}` }, 502);
  }

  const narrationJson = phaseResults.map(({ phaseNumber, audioUrl, timings, error }) => ({
    phaseNumber,
    audioUrl,
    timings,
    error,
  }));

  const { error: updateErr } = await supabaseAdmin
    .from("plays")
    .update({ narration_json: narrationJson })
    .eq("id", playId);
  if (updateErr) {
    // Audio already exists in Blob at this point -- don't fail the whole
    // request over the DB write; the caller still gets the real URLs
    // back, same pattern generate-playbook.js already uses for its own
    // storage_url update.
    console.log(`[generate-narration] failed to save narration_json for play ${playId}: ${updateErr.message}`);
  }

  const phaseErrors = phaseResults.filter((p) => p.error).map((p) => `Phase ${p.phaseNumber}: ${p.error}`);
  return sendJson(res, {
    playId,
    phases: narrationJson,
    errors: phaseErrors.length ? phaseErrors : undefined,
  });
}

async function generateNarrationForPhase(phase, playId) {
  const phaseNumber = phase.phaseNumber;
  try {
    const segments = await writeNarrationScript(phase);
    const { fullText, offsets } = buildConcatenatedScript(segments);
    const { audioBuffer, alignment } = await synthesizeWithTimestamps(fullText);
    const timings = computeSegmentTimings(segments, offsets, alignment);

    const blobPath = `narration/${playId}/phase-${phaseNumber}.mp3`;
    const blobResult = await put(blobPath, audioBuffer, {
      access: "public",
      contentType: "audio/mpeg",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentDisposition: "inline",
    });

    return { phaseNumber, audioUrl: blobResult.url, timings };
  } catch (err) {
    console.log(`[generate-narration] phase ${phaseNumber} failed: ${err.message}`);
    return { phaseNumber, audioUrl: null, timings: null, error: err.message };
  }
}

async function writeNarrationScript(phase) {
  const userPrompt = `Phase data for narration:

Phase name: ${phase.phaseName || ""}
Key action: ${phase.keyAction || ""}
Teaching cue: ${phase.teachingCue || ""}
Common error: ${phase.commonError || ""}
Players this phase:
${(phase.players || [])
    .map((p) => `- Player ${p.number}: ${p.action || ""}${p.hasBall ? " (has the ball)" : ""}`)
    .join("\n")}
Existing sidebar coaching content (HTML, for context only -- extract meaning, don't quote markup):
${stripHtml(phase.sidebarHtml || "")}`;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      system: NARRATION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error: ${errText}`);
  }

  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) {
    throw new Error("No text response from model");
  }

  const cleaned = textBlock.text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "");
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  const jsonSlice = firstBrace !== -1 && lastBrace > firstBrace ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned;

  let parsed;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (err) {
    throw new Error(`Invalid JSON from narration model: ${err.message}`);
  }

  const segments = Array.isArray(parsed.segments) ? parsed.segments : [];
  if (segments.length === 0) {
    throw new Error("Model returned zero narration segments");
  }
  return segments.map((s) => ({ player: s.player != null ? String(s.player) : null, text: String(s.text || "").trim() })).filter((s) => s.text.length > 0);
}

// Builds the exact single string sent to ElevenLabs, and records each
// segment's [startCharIndex, endCharIndex) offset within that string --
// needed afterward to slice the returned character-level alignment back
// into per-segment start/end times.
function buildConcatenatedScript(segments) {
  let fullText = "";
  const offsets = [];
  for (const seg of segments) {
    const start = fullText.length;
    fullText += (fullText.length > 0 ? " " : "") + seg.text;
    const end = fullText.length;
    offsets.push({ start, end });
  }
  return { fullText, offsets };
}

async function synthesizeWithTimestamps(text) {
  const res = await fetch(ELEVENLABS_TTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": process.env.ELEVENLABS_API_KEY,
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ElevenLabs API error: ${errText}`);
  }

  const data = await res.json();
  if (!data.audio_base64 || !data.alignment) {
    throw new Error("ElevenLabs response missing audio or alignment data");
  }

  return {
    audioBuffer: Buffer.from(data.audio_base64, "base64"),
    alignment: data.alignment, // { characters, character_start_times_seconds, character_end_times_seconds }
  };
}

// Maps each segment's [startCharIndex, endCharIndex) back onto real
// playback time using ElevenLabs' per-character alignment, so the front
// end can highlight the right player at the right moment without a
// separate TTS call per player-segment.
function computeSegmentTimings(segments, offsets, alignment) {
  const { character_start_times_seconds: starts, character_end_times_seconds: ends } = alignment;
  return segments.map((seg, i) => {
    const { start, end } = offsets[i];
    const startIdx = Math.min(start, starts.length - 1);
    const endIdx = Math.max(0, Math.min(end - 1, ends.length - 1));
    return {
      player: seg.player,
      startTime: starts[startIdx] != null ? starts[startIdx] : 0,
      endTime: ends[endIdx] != null ? ends[endIdx] : starts[startIdx] || 0,
    };
  });
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sendJson(res, obj, status = 200) {
  res.status(status).json(obj);
}
