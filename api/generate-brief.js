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
import { findMentionedSystem, getSupabase, slugify, enqueueResearchTopic } from "./_lib/knowledge-base.js";
// Synchronous in-request research fallback (added Sep 15, 2026, per Shaun's
// "Yes - build it now"): when a coach names a system the KB doesn't
// recognize, this reuses the EXACT same citation-gate / domain-restricted
// research logic the 6-hour cron worker uses (api/research-knowledge.js),
// so the two paths can't silently drift apart. See the "SYNCHRONOUS
// RESEARCH FALLBACK" block below for the full flow.
import { researchTopic, verifyCitations, buildKbEntryUpsertPayload } from "./_lib/kb-research.js";

// Runs on Vercel's default Node.js runtime — Edge Functions have a hard
// ~25s cap that can't be extended, and open-ended play descriptions can
// take the model longer to reason through than that.
export const config = { maxDuration: 180 };

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

const BRIEF_SYSTEM_PROMPT = `You are a basketball play analyst. A coach will describe a play in plain language, sometimes with a hand-drawn diagram image. Your ONLY job right now is to extract a STRUCTURED BRIEF of what happens — you are NOT generating any HTML, CSS, or SVG code.

Court coordinate system (half-court, viewBox 0 0 520 420 — use these ranges when placing players). The coach also specifies a basket position, either DOWN (basket near the bottom, the default) or UP (basket near the top, vertically mirrored) -- use whichever anchor set matches what you were told for this request:

These anchors were verified directly against the real court art (fitting
the actual 3-point arc pixel-by-pixel), not estimated -- the arc is an
ELLIPSE in this coordinate system (not a circle), centered at
x=260 y=350 (DOWN) / x=260 y=157 (UP) with radius roughly 190 horizontally
and 110 vertically. A perimeter player meant to be clearly beyond the line
(a shooter, a guard in a 4-out/5-out spacing alignment) should sit
noticeably outside that ellipse, not just barely past it -- use the Slot
and Deep corner anchors below for that, not Wings or an invented spot.
 
FORMATION GUIDANCE -- 4-out / 5-out alignments (spread, motion,
dribble-drive-style spacing with players spread around the perimeter and
zero or one player inside): the four perimeter spots are TWO SLOT
positions (elevated guards, top of the key, well beyond the arc) and TWO
DEEP CORNER positions (baseline shooters, right at/just beyond the arc,
matching where a real corner-3 shooter actually stands) -- NOT "Wings."
Reserve Wings for formations that specifically call for a true wing
alignment (a 1-3-1, a box set, a flex cut landing spot, etc.), where a
position between the corner and the slot is actually wanted. Getting this
distinction right matters: a 4-out set with two players parked at Wings
instead of Slot reads as noticeably tighter/closer to the rim than a real
4-out spacing should look.
 
DOWN (basket at bottom):
- Basket is at approximately x=260, y=375
- Elbows: left x=207 y=285, right x=313 y=285
- Blocks: left x=207 y=338, right x=313 y=338
- Screen spot outside the block (baseline/flex screen standing position -- just outside the block toward the sideline, NOT the same spot as the Block anchor itself): left x=182 y=345, right x=338 y=345
- Short corner: left x=132 y=385, right x=388 y=385
- Wings (mid-level perimeter spot, between corner and slot -- use only for wing-specific formations, see above): left x=90 y=250, right x=430 y=250
- Slot (elevated guard spot for 4-out/5-out spacing, well beyond the arc): left x=135 y=200, right x=385 y=200
- Deep corners (baseline shooter spot, right at the real corner-3 line): left x=58 y=355, right x=462 y=355
- Center top (above the arc): x=260 y=185
- Free-throw line center (default start for a player who will screen at either elbow): x=260 y=285
 
UP (basket at top -- mirrored around the court rectangle's real center, NOT simply 420 minus the DOWN value; the rectangle spans y=110-397, so the correct mirror is y_up = 507 - y_down):
- Basket is at approximately x=260, y=132
- Elbows: left x=207 y=222, right x=313 y=222
- Blocks: left x=207 y=169, right x=313 y=169
- Screen spot outside the block (baseline/flex screen standing position -- just outside the block toward the sideline, NOT the same spot as the Block anchor itself): left x=182 y=162, right x=338 y=162
- Short corner: left x=132 y=122, right x=388 y=122
- Wings (mid-level perimeter spot, between corner and slot -- use only for wing-specific formations, see above): left x=90 y=257, right x=430 y=257
- Slot (elevated guard spot for 4-out/5-out spacing, well beyond the arc): left x=135 y=307, right x=385 y=307
- Deep corners (baseline shooter spot, right at the real corner-3 line): left x=58 y=152, right x=462 y=152
- Center top (below the arc, toward mid-court): x=260 y=322
- Free-throw line center (default start for a player who will screen at either elbow): x=260 y=222
 
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
 
SCREENER POSITIONING RULE (critical): when a player's role in phase 1 is to set a screen at an elbow later in the play (rather than starting locked to a specific side), place their phase-1 startX/startY at the Free-throw line center anchor above (x=260, y=285 DOWN / y=135 UP) rather than guessing left or right — this lets them move cleanly to whichever elbow the play actually needs. When that player then sets the screen, their endX/endY for that phase MUST be the elbow on the SAME SIDE OF THE COURT AS THE BALL at that moment: compare the ball-handler's x position in that phase to court-center x=260 — if the ball-handler's x is less than 260, the screen happens at the LEFT elbow (x=207); if the ball-handler's x is 260 or greater, it happens at the RIGHT elbow (x=313). Never place a screen at the elbow opposite the ball. State this explicitly in that phase's action text (e.g. "Sets a screen at the ball-side elbow").

FLEX CUT RULE (critical -- this is a real basketball structure rule, not a style preference; verified directly against real flex-offense diagrams, read image-by-image rather than inferred): the flex continuity's base formation is TWO SLOT positions (the two guards running the ball) and TWO WING positions (the two remaining perimeter players) -- NOT two Deep corners, and NOT a 4-out spread shape. The fifth player (the traveling screener/cutter role) works out of the lane area, never fixed on the block or in a corner as a starting spot.

The baseline cutter for the flex action is the player at the WING on the WEAK side -- the side of the court OPPOSITE wherever the ball is at that moment -- and cuts underneath a screen, down through the lane, to the Block anchor on the STRONG side (the ball's side). Determine which side is which the same way as the SCREENER POSITIONING RULE above: compare the ball-handler's x position to court-center x=260. If the ball-handler's x is less than 260 (ball on the LEFT / strong side), the flex cutter starts at the RIGHT Wing (the weak side) and cuts to the LEFT Block. If the ball-handler's x is 260 or greater (ball on the RIGHT / strong side), the flex cutter starts at the LEFT Wing and cuts to the RIGHT Block. NEVER start the flex cutter in a Deep corner -- a Deep corner is only ever where the screener relocates to AFTER screening (see below), never a starting spot for anyone in this action. NEVER start the flex cutter at a Slot either -- the Slots belong to the two guards running the ball-reversal side of the continuity, not the baseline cutter.

The screener for this action is a DIFFERENT teammate, standing at the Short corner anchor (a lane-adjacent spot near the baseline, not out at the true corner-3 line) on the SAME (strong) side as the cutter's destination -- NOT the Screen spot outside the block anchor (reserve that one for other baseline/flex screening actions outside this specific continuity) and NOT an elbow (that is the separate SCREENER POSITIONING RULE above, for a different action).

If the flex cutter isn't open for the pass, the continuity's next step is a SEPARATE phase (per the SCREEN-THEN-MOVE RULE immediately below): a teammate down-screens for the original flex screener -- who is now down near the Short corner/Block after setting that first screen -- and that screener pops out to the Deep corner on their own strong side. This is the ONLY point in the whole continuity where a Deep corner is a real destination, and it is always a post-screen relocation in its own phase, never a starting position. The player being down-screened for cuts up to the Elbow on that same side, looking for the catch-and-shoot jumper.

State the weak-side start and strong-side destination explicitly in that phase's action text (e.g. "Cuts from the weak-side [right] wing, underneath 4's screen at the short corner, to the strong-side [left] block").

SCREEN-THEN-MOVE RULE (critical): a player cannot both set a screen AND relocate/pop/roll to a different spot within the SAME phase — these are two different actions and must be two different phases. If a player's role in a phase is to set a screen (elbow screen, flex/baseline screen, or any other), that player's startX/startY and endX/endY for THIS phase MUST be identical (they stay planted at the screen position for the whole phase) — do not also describe them popping out, rolling to the rim, or cutting anywhere else in that same phase's action text, and do not give them a second endX/endY reflecting that further movement. If the play calls for that screener to move again after screening (popping to the perimeter, rolling to the rim, re-screening elsewhere), that movement belongs in the NEXT phase: that phase's startX/startY for them must equal this phase's endX/endY (the screen spot, per the CONTINUITY RULE), and only that next phase's endX/endY reflects where they go. Never compress a screen-and-then-move sequence into one phase for one player — doing so produces a single phase with two contradictory actions for the same player, which is exactly the kind of ambiguity that later causes the diagram step to draw two conflicting movement elements (and the wrong color) for that one player.

HARD CAP: never generate more than 8 phases total, no matter how long or continuous the described action is (e.g. a full motion-offense cycle back to starting spots). If the play logically needs more to fully resolve, consolidate the least essential intermediate movements so the whole thing still fits in 8 phases or fewer -- a coach can always describe a follow-up play separately. This cap exists because the response has a fixed size budget; going over it produces a cut-off, invalid response instead of a complete one.`;

// How long the synchronous research call is allowed to run before this
// request gives up and falls back to general model knowledge. Shaun's
// original ask was "how fast are we able to research an unknown play
// name/set in the moment" -- this is the bound we're holding it to (the
// "~20-25s" figure floated and approved), not yet validated against a real
// timed call; brief.synchronousResearchLatencyMs on the response is how
// that gets measured for real once this ships.
const SYNCHRONOUS_RESEARCH_TIMEOUT_MS = 22000;

// Deterministic (non-LLM, same philosophy as findMentionedSystem) fallback
// for detecting "the coach named a specific system" when the play-creation
// UI hasn't yet been given an explicit namedSystem field to make that
// unambiguous (see the TODO on kb_research_queue's design in
// claude/knowledge-base-architecture.md). Intentionally conservative: only
// fires on "<name> offense/defense/press/zone/series", so a coach who
// merely describes actions without naming a system correctly produces no
// match rather than a guessed one.
// Case-SENSITIVE on purpose: a real system name is almost always written
// as a proper noun ("Wheel offense", "1-4 High offense", "Read and React
// offense"), so requiring the captured phrase to start with an uppercase
// letter or digit is what keeps this from firing on generic phrasing like
// "we run our offense" or "read the defense". Known gap: this only catches
// the "<Name> offense/defense/..." word order, not "our defense is a
// Box-and-One" (name before the category word) -- acceptable for a
// heuristic that's explicitly a stopgap for the real fix (an explicit
// namedSystem field from the UI, see the destructured field above).
const NAMED_SYSTEM_PATTERN = /\b((?:[A-Z0-9][A-Za-z0-9\-\/']*|and|to)(?:\s+(?:[A-Z0-9][A-Za-z0-9\-\/']*|and|to)){0,4})\s+(offense|defense|press|zone|series)\b/;
const NAMED_SYSTEM_LEADING_STOPWORDS = new Set([
  "this", "our", "the", "we", "a", "an", "my", "your", "their", "some", "any",
  "it", "play", "run", "playing", "call", "calls", "named", "its",
]);

function extractNamedSystemCandidate(text) {
  if (!text) return null;
  const m = text.match(NAMED_SYSTEM_PATTERN);
  if (!m) return null;
  const words = m[1].trim().split(/\s+/);
  // Strip generic leading words a sentence-starting capital can produce
  // ("This 1-4 High offense..." -> drop "This"), and bail entirely if
  // nothing real is left ("This offense" alone, capitalized only because
  // it starts the sentence).
  while (words.length > 1 && NAMED_SYSTEM_LEADING_STOPWORDS.has(words[0].toLowerCase())) {
    words.shift();
  }
  if (words.length === 0 || NAMED_SYSTEM_LEADING_STOPWORDS.has(words[0].toLowerCase())) return null;
  return `${words.join(" ")} ${m[2]}`.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

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
    // Optional, not yet sent by the UI: the clean, unambiguous signal for
    // "the coach explicitly named a real system" that
    // claude/knowledge-base-architecture.md flagged as the natural next
    // step ("Wiring that up is the very next piece of this, not yet
    // built."). When the play-creation UI grows an explicit field for this,
    // wire it through here and it will be preferred over the regex
    // heuristic below (see extractNamedSystemCandidate).
    namedSystem,
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

    // ---- Retrieval-first knowledge base check ----
  // Never let the model guess at a named system's structure when we
  // actually have a verified entry for it. This is a plain substring
  // match against kb_entries (see api/_lib/knowledge-base.js) -- not an
  // LLM call, not a heuristic guess at intent, just: does the coach's own
  // text literally name a system we already know. A miss here isn't
  // treated as "the coach's play is unknown to basketball" -- most plays
  // don't name a formal system at all -- it just means this specific
  // grounding step doesn't apply, and generation proceeds on general
  // model knowledge as before.
  let groundedEntry = null;
  try {
    groundedEntry = await findMentionedSystem(description);
  } catch (err) {
    console.log(`[generate-brief] knowledge base lookup failed (non-fatal): ${err.message}`);
  }

  // ---- Synchronous in-request research fallback ----
  // Approved by Shaun Sep 15, 2026 ("Yes - build it now") in response to
  // "We need a more solid approach than general basketball knowledge - as
  // that has shown to create failures at this point." When the retrieval
  // step above misses AND the coach appears to have named a real system by
  // name, this makes ONE bounded, timeboxed, citation-gated web-search call
  // (same gate, same coach-vetted allowed_domains as the background cron
  // worker -- see api/_lib/kb-research.js) inline in this same request,
  // rather than either making the coach wait indefinitely or silently
  // falling back to ungrounded general knowledge. On success the result is
  // both used to ground THIS brief and persisted to kb_entries so every
  // future request for the same system is an instant retrieval-first hit.
  // On failure/timeout, generation proceeds on general model knowledge
  // exactly as before -- but brief.groundingSource below makes that
  // previously-silent case visible instead of hidden.
  let groundingSource = groundedEntry ? "kb_entries_hit" : "ungrounded_fallback";
  let synchronousResearchLatencyMs = null;

  if (!groundedEntry) {
    const candidateSystemName = (typeof namedSystem === "string" && namedSystem.trim()) || extractNamedSystemCandidate(description);

    if (candidateSystemName) {
      const researchStart = Date.now();
      try {
        const { parsed, realCitations, searchCallCount } = await researchTopic(candidateSystemName, {
          timeoutMs: SYNCHRONOUS_RESEARCH_TIMEOUT_MS,
        });
        synchronousResearchLatencyMs = Date.now() - researchStart;
        console.log(`[generate-brief] synchronous research for "${candidateSystemName}" took ${synchronousResearchLatencyMs}ms`);

        if (searchCallCount === 0) {
          console.log(`[generate-brief] synchronous research: model never invoked web_search for "${candidateSystemName}"`);
        } else if (!parsed) {
          console.log(`[generate-brief] synchronous research: could not parse a JSON block for "${candidateSystemName}"`);
        } else if (parsed.insufficient_evidence) {
          console.log(`[generate-brief] synchronous research: insufficient evidence for "${candidateSystemName}": ${parsed.notes || "(no notes)"}`);
        } else {
          const gate = verifyCitations(parsed, realCitations);
          if (!gate.ok) {
            console.log(`[generate-brief] synchronous research: citation gate failed for "${candidateSystemName}": ${gate.reason}`);
          } else {
            const slug = slugify(parsed.system_name);
            // Use the service-role client, not the request-scoped one from
            // validateCoachSession -- kb_entries is shared reference data
            // across every program, not something scoped to this coach's
            // own program by RLS.
            const supabaseAdmin = getSupabase();
            const { data: existingSeed } = await supabaseAdmin
              .from("kb_entries")
              .select("id, confidence")
              .eq("slug", slug)
              .maybeSingle();

            if (existingSeed && existingSeed.confidence === "seed_verified") {
              // Never let a live research hit overwrite a coach-curated
              // seed row -- same rule the cron worker enforces.
              console.log(`[generate-brief] synchronous research: a seed_verified entry already exists for "${slug}", not overwriting`);
            } else {
              const upsertPayload = buildKbEntryUpsertPayload(parsed, slug);
              const { data: inserted, error: upsertError } = await supabaseAdmin
                .from("kb_entries")
                .upsert(upsertPayload, { onConflict: "slug" })
                .select("*")
                .single();

              if (upsertError) {
                console.log(`[generate-brief] synchronous research: kb_entries upsert failed for "${slug}": ${upsertError.message}`);
              } else {
                groundedEntry = inserted;
                groundingSource = "synchronous_research_hit";
                console.log(`[generate-brief] synchronous research: merged "${slug}" live and grounded this request in it`);
              }
            }
          }
        }
      } catch (err) {
        synchronousResearchLatencyMs = Date.now() - researchStart;
        if (err && err.code === "RESEARCH_TIMEOUT") {
          console.log(`[generate-brief] synchronous research timed out after ${synchronousResearchLatencyMs}ms for "${candidateSystemName}"`);
        } else {
          console.log(`[generate-brief] synchronous research failed after ${synchronousResearchLatencyMs}ms for "${candidateSystemName}": ${err.message}`);
        }
      }

      // Whether or not the synchronous attempt above succeeded, also feed
      // this named system into the background pipeline -- this is the
      // "queue fills itself from real usage" wiring
      // claude/knowledge-base-architecture.md flagged as not yet built.
      // Fire-and-forget: never let a queueing failure affect this response.
      try {
        await enqueueResearchTopic(candidateSystemName, {
          reason: "coach_requested_unknown_system",
          requestedBy: authResult.user ? authResult.user.id : null,
        });
      } catch (err) {
        console.log(`[generate-brief] failed to enqueue "${candidateSystemName}" for background research (non-fatal): ${err.message}`);
      }
    }
  }

  if (groundedEntry) {
    const kbBlock = [
      ``,
      `VERIFIED KNOWLEDGE BASE ENTRY (use these specifics as ground truth for this named system; the coach's own description still wins for anything it explicitly overrides):`,
      `System: ${groundedEntry.system_name}${groundedEntry.formation ? ` (${groundedEntry.formation})` : ""}`,
      `Summary: ${groundedEntry.summary}`,
      groundedEntry.structure && Object.keys(groundedEntry.structure).length > 0
        ? `Structure: ${JSON.stringify(groundedEntry.structure)}`
        : null,
      groundedEntry.confidence === "seed_verified"
        ? `Source: ChalkTalk coach-curated reference (not web-sourced).`
        : Array.isArray(groundedEntry.sources) && groundedEntry.sources.length > 0
        ? `Sources: ${groundedEntry.sources.map((s) => s.url).join(", ")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
    userContent.push({ type: "text", text: kbBlock });
  }
 
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
 
  // Provenance flag for the UI/downstream code -- lets a coach (or a
  // future "verified" badge) see whether this brief was grounded in a
  // real knowledge base entry or fell back to general model knowledge.
  // This is the honest version of "if not found, don't pretend it was."
  brief.groundedInKb = Boolean(groundedEntry);
  brief.groundedSystemSlug = groundedEntry ? groundedEntry.slug : null;
  // Finer-grained than groundedInKb: distinguishes an existing KB hit from
  // a system researched live just now for this request, and -- the whole
  // point of this addition -- makes the previously-silent ungrounded case
  // ("groundedInKb: false" could mean either "no system named" or "named
  // but we couldn't verify it") visible instead of hidden.
  brief.groundingSource = groundingSource; // "kb_entries_hit" | "synchronous_research_hit" | "ungrounded_fallback"
  if (synchronousResearchLatencyMs !== null) {
    brief.synchronousResearchLatencyMs = synchronousResearchLatencyMs;
  }

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
