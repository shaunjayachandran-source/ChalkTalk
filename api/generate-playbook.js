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
 *   { programId: string, brief: { ...see generate-brief.js schema } }
 *
 * Response (JSON):
 *   { url: string }   -- public Blob URL of the generated playbook
 *   or { error: string } with an appropriate status code
 */

import { put } from "@vercel/blob";
import { validateCoachSession } from "./_lib/validate-session.js";

export const config = { maxDuration: 60 };

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

const PLAYER_COLORS = {
  1: { fill: "#f0b429", stroke: "#ffd060" },
  2: { fill: "#27ae60", stroke: "#2ecc71" },
  3: { fill: "#2a6ae8", stroke: "#7db3ff" },
  4: { fill: "#9b59b6", stroke: "#c39bd3" },
  5: { fill: "#e03a2e", stroke: "#ff7b6e" },
};

const PHASE_SYSTEM_PROMPT = `You are a master basketball coach and visual communications expert. You generate ONE PHASE of an interactive basketball playbook -- just the SVG diagram and sidebar content for this single phase, not the full page.

Return ONLY valid JSON, no markdown fences, no preamble. Match this exact schema:
{
  "diagramSvg": "<svg>...</svg> markup as a string",
  "sidebarHtml": "HTML fragment as a string (no <html>/<body> wrapper)"
}

## SVG Diagram Rules
- Half-court viewBox "0 0 520 420" (or "0 0 520 500" for full court). You'll be told this phase's basket position: DOWN (default) or UP. Draw a simple court outline using whichever anchor set matches -- rect border, key/paint rectangle, free-throw circle, three-point arc, basket, backboard line -- all in stroke #27364a, fill none, stroke-width 1.5-2:
  DOWN: key/paint rect x=207 y=285 width=106 height=112 (baseline ~397), free-throw circle cx=260 cy=285 r=53, three-point arc path "M 58,355 Q 260,155 462,355", basket circle cy=375, backboard line y=385.
  UP: key/paint rect x=207 y=23 width=106 height=112 (baseline ~23, opening toward the top), free-throw circle cx=260 cy=135 r=53, three-point arc path "M 58,65 Q 260,265 462,65", basket circle cy=45, backboard line y=35.
  Full court always shows both baskets, so basket position doesn't apply there -- use the existing defensive/attacking basket layout regardless.
- Player circles r=18, font-size=17, class="pc", with data-l (short label e.g. "1 - POINT GUARD") and data-t (2-4 sentence coaching detail) attributes for tooltips. Fill/stroke per this mapping: ${JSON.stringify(PLAYER_COLORS)}.
- Solid circle = where player BEGINS the phase. If a player moves, add a ghost circle (r=8, fill none, stroke same color, stroke-dasharray "3,3") at their END position, plus an arrow/line connecting start to end (solid line = dribble/primary movement, dashed stroke-dasharray "7,4" = pass, stroke-width 2.5 primary / 2.0 secondary). Arrow tail/tip must touch circle edges, never float in open space. Players who don't move: solid circle only, no ghost, no line.
- Ball dot r=6 fill=#ff6b00 stroke=white, placed just outside the ball-handler's circle on the side closest to the basket.
- Footer caption bar: rect x=32 y=396 width=456 height=14 fill="rgba(0,0,0,.55)", centered text x=260 font-size=10 fill=#f0b429 font-weight=600, format "PHASE NAME - key action" (max ~80 chars, one line).
- Use unique marker/gradient IDs prefixed with the phase number if any defs are needed, to avoid collisions when multiple phases' SVGs sit in the same page.

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

  const { programId, brief } = body;

  if (!programId || !brief || !Array.isArray(brief.phases) || brief.phases.length === 0) {
    return sendJson(res, { error: "Missing or invalid brief" }, 400);
  }

  const authResult = await validateCoachSession(req, programId);
  if (!authResult.ok) {
    return sendJson(res, { error: authResult.error }, authResult.status);
  }
  const { user, supabase } = authResult;

  const slug = slugify(brief.playName || "untitled-play");

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
            play_type: null,
            phase_count: brief.phases.length,
            court_type: brief.courtType || "half",
            status: "published",
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

  return sendJson(res, { url: blobResult.url });
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
      max_tokens: 4000,
      system: PHASE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error on phase ${phase.phaseNumber}: ${errText}`);
  }

  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) {
    throw new Error(`No text response for phase ${phase.phaseNumber}`);
  }

  const cleaned = textBlock.text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "");

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Invalid JSON for phase ${phase.phaseNumber}`);
  }

  return {
    phaseNumber: phase.phaseNumber,
    phaseName: phase.phaseName,
    diagramSvg: parsed.diagramSvg || "",
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

  const diagrams = phaseResults
    .map(
      (p, i) =>
        `<div class="phase-diagram${i === 0 ? " active" : ""}" id="pd-${p.phaseNumber}">${p.diagramSvg}</div>`
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
