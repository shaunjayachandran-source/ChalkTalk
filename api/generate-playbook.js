/**
 * POST /api/generate-playbook
 *
 * Step 2 of the playbook builder (BUILD MODE): takes a CONFIRMED brief
 * (the coach already reviewed and approved player positions in the
 * preview step) and generates the full interactive HTML playbook
 * using the locked ChalkTalk template standard. Saves the result to
 * Vercel Blob storage, scoped to the coach's program, and returns the
 * public URL.
 *
 * Auth: same as generate-brief.js — requires a valid, active, coach-role
 * token whose program matches where the file gets written. This is
 * re-validated here independently; never trust that the brief step's
 * validation still holds by the time this runs.
 *
 * Body (JSON):
 *   { token: string, program: string, brief: { ...see generate-brief.js schema } }
 *
 * Response (JSON):
 *   { url: string }   — public Blob URL of the generated playbook
 *   or { error: string } with an appropriate status code
 */

import { put } from "@vercel/blob";
import { readFile } from "fs/promises";
import path from "path";

// Runs on Vercel's default Node.js runtime (not Edge) because
// @vercel/blob's put() relies on Node modules (net, tls, stream, etc.)
// that aren't available in the lightweight Edge runtime.
//
// maxDuration extended to 60s (Hobby plan max) since generating a full
// interactive HTML playbook via Claude can exceed the 10s default.
export const config = { maxDuration: 60 };

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

const BUILD_SYSTEM_PROMPT = `You are a master basketball coach, teacher, and visual communications expert. You generate a single, complete, self-contained HTML file implementing an interactive basketball playbook, following this locked template standard exactly.

## Visual Identity
- Fonts (import from Google Fonts): Bebas Neue (player numbers, phase titles, labels), DM Mono (coaching text, captions, tooltips), DM Sans (body text)
- Background: #0d1017 (near-black)
- Accent/gold: #f0b429 (primary highlight, ball dot secondary color, 1's color)
- Player colors: 1=gold #f0b429 (stroke #ffd060), 2=green #27ae60 (stroke #2ecc71), 3=blue #2a6ae8 (stroke #7db3ff), 4=purple #9b59b6 (stroke #c39bd3), 5=red #e03a2e (stroke #ff7b6e)

## SVG Coordinate System — Half Court (viewBox 0 0 520 420)
Court image area: x=15 y=110 width=489 height=287. Basket cy≈370. Elbow left cx=207, right cx=313, both y≈285. Top slots cy≈205. Right corner cx≈462 cy≈355. Left corner cx≈58 cy≈355. Center top cx=260 cy≈185. Since no court background image is embedded in this generator, draw a simple court outline (rect + free-throw circle + three-point arc using path) in #27364a strokes instead of an embedded photo.

## SVG Coordinate System — Full Court (viewBox 0 0 520 500)
Court image area: x=8 y=4 width=504 height=464. Defensive basket cy≈28. Half-court line y≈252. Attacking basket cy≈472. Court orientation: offense attacks the bottom basket.

## Circle & Arrow Standards
- Solid player circles r=18, font-size=17 (Bebas Neue), fill = player's color, stroke = player's lighter stroke color. Solid circle marks WHERE A PLAYER BEGINS a phase.
- Ghost circles r=8, faded, stroke-dasharray 3,3, no fill — mark WHERE A PLAYER ENDS a phase. Players who don't move: solid circle only, no ghost.
- Ball dot r=6 fill=#ff6b00 stroke=white, placed on the side of the ball-handler's circle closest to the basket being attacked.
- Arrow tail anchors to the solid (starting) circle edge; tip anchors to the ghost (ending) circle edge — both offset by radius along the direction of travel. Never floating in open space.
- Solid arrow = dribble/primary movement. Dashed arrow (stroke-dasharray 7,4) = pass or secondary movement. Stroke width 2.5 primary, 2.0 secondary.
- Marker IDs must be unique per phase (prefix with phase number, e.g. au1, ag1 for phase 1's gold/green arrows).

## Phase Tab System
Each phase = one SVG diagram + one sidebar content block. Tab IDs pd-1 through pd-N (diagrams), sb-1 through sb-N (sidebar). Active tab gets class "active". Include a simple progress bar that updates on tab change. Include working JavaScript to switch tabs on click.

## Sidebar Content (per phase)
- h3: Phase name (Title Case)
- Numbered coaching points (cp blocks) referencing player numbers with colored inline pill spans (p1 gold, p2 green, p3 blue, p4 purple, p5 red)
- A ".kbox" (tan/warm background) box — its framing depends on coaching level:
  - If level is "youth": label it "For Parents" and write it analogy-driven, outcome-focused, for a parent watching from the stands.
  - For all other levels (high-school, prep, college, pro): label it "Coach's Eye" or "Concept" instead, and write it as a tactical/conceptual note for players and coaches — do NOT address parents directly or use parent-in-the-stands framing unless the level is youth.
- A ".bbridge" (teal-bordered) box explaining the STRUCTURAL connection to the next phase (omit on the final phase)

## Tooltip System
Every player circle (class "pc") has data-l (short label, e.g. "1 — POINT GUARD") and data-t (2-4 sentence coaching detail). Include a #tip div, absolutely positioned, shown on hover via JavaScript, following the mouse.

## Footer Caption Bar (each phase SVG)
rect at x=32 y=396 width=456 height=14 fill=rgba(0,0,0,.55). Centered text x=260 font-size=10 fill=#f0b429 font-weight=600. Format: "PHASE NAME · Key action · Key action". Must fit one line, ~80 char max.

## Content & Voice Rules — Write for THREE audiences in every phase
1. PLAYERS: direct, actionable, spatial ("Cut hard to the left corner.")
2. COACHES: technical, reads-based ("This is the direct cue for 4 to fill the vacated slot.")
3. PARENTS (youth level only, via the kbox): analogy-driven, outcome-focused. For high-school/prep/college/pro, the kbox instead serves players/coaches as a conceptual note — do not write parent-facing content unless level is youth.

Never use jargon without a plain-language follow. Always explain WHY, not just what. Teaching cues are short quotable coach one-liners. Frame common errors as "what the defense wants," not player failure. Use gender-neutral language (they/them) throughout — no he/him defaults. Calibrate depth to coaching level: youth = more analogy, fewer reads, parent-facing kbox; high school = balanced, tactical kbox; college/pro = full tactical depth, no parent framing, more defensive reads and counter-actions.

## Required Page Elements
- A "← Return to Homepage" pill link (class="home-link", href="index.html") placed directly above the header, styled to match the dark/gold system.
- Page title in Bebas Neue.

## Output Rules
- Output ONLY the complete HTML document, starting with <!DOCTYPE html> and ending with </html>. No markdown fences, no explanation, no preamble or postamble text of any kind.
- All output must be pure ASCII — use HTML entities for any character outside standard ASCII (em dash as &mdash;, curly quotes as &ldquo;/&rdquo;, arrows as &rarr; etc.)
- The file must be fully self-contained: all CSS in a <style> tag, all JS in a <script> tag, fonts via Google Fonts @import. No external dependencies except the Google Fonts import.
- Build every phase provided in the input brief — do not omit or merge phases.
- Every player listed in a phase's "players" array must appear on that phase's diagram, even ones who are just holding a supporting position — never drop a player because they aren't the primary actor.`;

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

  const { token, program, brief } = body || {};

  if (!token || !program || !brief) {
    return json({ error: "Missing required fields" }, 400);
  }

  // ---- Auth: re-validate independently, never trust the brief step ----
  const authResult = await validateCoachToken(req, token, program);
  if (!authResult.ok) {
    return json({ error: authResult.error }, authResult.status);
  }

  // ---- Call Claude to build the full HTML ----
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
        max_tokens: 16000,
        system: BUILD_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Build the complete interactive HTML playbook for this confirmed brief:\n\n${JSON.stringify(
              brief,
              null,
              2
            )}`,
          },
        ],
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
    return json({ error: "No HTML returned from model" }, 502);
  }

  let html = textBlock.text.trim();
  // Strip stray markdown fences if the model added any despite instructions
  html = html.replace(/^```html\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");

  if (!html.toLowerCase().startsWith("<!doctype html")) {
    return json(
      { error: "Model did not return a valid HTML document", raw: html.slice(0, 300) },
      502
    );
  }

  // ---- Save to Blob, scoped to this program ----
  const slug = slugify(brief.playName || "untitled-play");
  const blobPath = `generated/${program}/${slug}.html`;

  let blobResult;
  try {
    blobResult = await put(blobPath, html, {
      access: "public",
      contentType: "text/html",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } catch (err) {
    return json({ error: `Failed to save playbook: ${err.message}` }, 502);
  }

  return json({ url: blobResult.url });
}

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

function slugify(str) {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "untitled-play";
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
