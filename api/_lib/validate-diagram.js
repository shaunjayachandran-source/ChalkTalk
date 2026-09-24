/**
 * Deterministic (non-LLM) checks that a generated phase's SVG actually
 * matches that phase's own authoritative player coordinates.
 *
 * WHY THIS EXISTS: see claude/known-failure-modes.md, entry "positional
 * drift on complex plays" -- a prior fix to PHASE_SYSTEM_PROMPT was
 * verified by reading the prompt back byte-for-byte, which only proves
 * the INSTRUCTION is correct, not that the model OBEYED it on a real
 * generation. This module checks the actual output instead. Every check
 * here is a hard fact derivable from the phase JSON + the generated
 * markup -- no basketball judgment, nothing an LLM call could get wrong
 * on its own.
 *
 * Requires PHASE_SYSTEM_PROMPT to instruct the model to tag every player
 * circle/movement element with data-player="<id>" and
 * data-role="start"|"ghost"|"move" -- without that tagging there's no
 * reliable way to know which SVG element belongs to which player.
 */

const TOLERANCE_PX = 1.5; // allow trivial float/rounding drift, not real repositioning

function extractAttr(tag, name) {
  const re = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i");
  const m = tag.match(re);
  return m ? m[1] : null;
}

// Finds every self-contained element (<circle .../>, <line .../>,
// <path ... />) carrying a given data-player + data-role pair.
function findTaggedElements(svg, playerId, role) {
  const tagRe = /<(circle|line|path)\b[^>]*>/gi;
  const out = [];
  let m;
  while ((m = tagRe.exec(svg))) {
    const tag = m[0];
    if (extractAttr(tag, "data-player") === String(playerId) && extractAttr(tag, "data-role") === role) {
      out.push(tag);
    }
  }
  return out;
}

function num(tag, attr) {
  const v = extractAttr(tag, attr);
  return v === null ? null : parseFloat(v);
}

// A path "M x,y L x,y L x,y ..." with N points has N-1 segments.
function countPathSegments(pathTag) {
  const d = extractAttr(pathTag, "d") || "";
  const points = d.match(/[MLQCTS]\s*-?\d/gi) || [];
  return Math.max(points.length - 1, 0);
}
 
// A dribble path built only from M/L (straight line-to) commands is a
// jagged zigzag with hard corners -- it reads as a lightning bolt, not a
// dribble (see claude/known-failure-modes.md). A real dribble needs at
// least one curve command.
function hasCurveCommand(pathTag) {
  const d = extractAttr(pathTag, "d") || "";
  return /[QCTS]/i.test(d);
}
 
// Keep in sync with COURT_PLACEMENT (and COURT_PLACEMENT.full) in
// api/generate-playbook.js -- these define where the real court image is
// actually drawn inside the 520x420 (half) / 520x500 (full) viewBox.
// Anything outside this rectangle renders in the black background above
// or around the court, not on it -- see claude/known-failure-modes.md.
const COURT_RECTS = {
  half: { x: 15, y: 110, width: 489, height: 287 },
  full: { x: 8, y: 4, width: 504, height: 464 },
};
 
// Checks that every player's GIVEN phase-data coordinate (not just what
// the SVG drew) actually falls inside the visible court rectangle. This
// catches the root problem even when the SVG faithfully reproduces a bad
// coordinate it was handed -- the per-element checks above only ever
// compare the SVG against the phase data, never the phase data against
// where the court art actually is.
function validateCourtBounds(phase, courtType) {
  const issues = [];
  const rect = COURT_RECTS[courtType] || COURT_RECTS.half;
  const players = phase.players || [];
  for (const p of players) {
    const id = p.id ?? p.number;
    if (id === undefined || id === null) continue;
    const checks = [
      ["start", p.startX, p.startY],
      ["end", p.endX, p.endY],
    ];
    for (const [label, x, y] of checks) {
      if (x === undefined || y === undefined || x === null || y === null) continue;
      if (x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height) {
        issues.push(
          `Player ${id}: ${label} position (${x},${y}) falls outside the visible ${courtType}-court rectangle ` +
          `(x:${rect.x}-${rect.x + rect.width}, y:${rect.y}-${rect.y + rect.height}) -- this player will render ` +
          `off the court art, in the black background.`
        );
      }
    }
  }
  return issues;
}
 
// Two player circles (r=9) whose centers sit closer than 18 units overlap,
// so one hides the other -- confirmed real bug Sep 24 2026 (screeners
// placed exactly on the teammate they screened for). generate-brief.js's
// separateStackedPlayers() should already prevent this; this is the
// second, independent check on the data the diagram was actually built from.
const STACK_MIN_DIST = 18;
function validateNoStacking(phase) {
  const issues = [];
  const players = (phase.players || []).filter((p) => (p.id ?? p.number) != null);
  for (const which of ["start", "end"]) {
    for (let a = 0; a < players.length; a++) {
      for (let b = a + 1; b < players.length; b++) {
        const A = players[a], B = players[b];
        const d = Math.hypot(A[which + "X"] - B[which + "X"], A[which + "Y"] - B[which + "Y"]);
        if (Number.isFinite(d) && d < STACK_MIN_DIST) {
          issues.push(
            `Players ${A.id ?? A.number} and ${B.id ?? B.number}: ${which} positions are only ${d.toFixed(1)} units apart ` +
            `-- their circles overlap and one will be hidden under the other.`
          );
        }
      }
    }
  }
  return issues;
}

// Same distinction as generate-brief.js: "Uses 3's screen and pops" is the
// CUTTER (fine to move); only a player SETTING the screen must stay planted.
function isSettingScreen(actionText) {
  const a = actionText;
  if (!/screen/.test(a)) return false;
  const setsIt = /\b(sets?|setting|holds?|holding|plants?)\b[^.]*screen|\bscreens? for\b|\bscreens? (at|on)\b/.test(a);
  const usesIt = /\b(uses|using|use|off|waits? for|reads?|receives?|behind|coming off|comes off|curls off)\b[^.]*screen/.test(a);
  return setsIt || !usesIt ? setsIt : false;
}

/**
 * @param {object} phase - the brief's phase object: { phaseNumber, players: [{id, startX, startY, endX, endY, action}, ...], ... }
 * @param {string} svg - the generated (already-stripped) SVG fragment for this phase
 * @param {string} [courtType="half"] - "half" or "full", from the brief -- picks which court rectangle to bounds-check against
 * @returns {{ok: boolean, issues: string[]}}
 */
export function validatePhaseOutput(phase, svg, courtType = "half") {
  const issues = [];
  issues.push(...validateCourtBounds(phase, courtType));
  issues.push(...validateNoStacking(phase));
  const players = phase.players || [];

  for (const p of players) {
    const id = p.id ?? p.number;
    if (id === undefined || id === null) continue;

    const starts = findTaggedElements(svg, id, "start");
    if (starts.length === 0) {
      issues.push(`Player ${id}: no start circle found (missing data-player="${id}" data-role="start").`);
    } else {
      if (starts.length > 1) {
        issues.push(`Player ${id}: ${starts.length} start circles found, expected exactly 1.`);
      }
      const cx = num(starts[0], "cx");
      const cy = num(starts[0], "cy");
      if (cx === null || cy === null || Math.abs(cx - p.startX) > TOLERANCE_PX || Math.abs(cy - p.startY) > TOLERANCE_PX) {
        issues.push(`Player ${id}: start circle at (${cx},${cy}) does not match phase data startX/startY (${p.startX},${p.startY}).`);
      }
    }

    const moves = p.startX !== p.endX || p.startY !== p.endY;

    if (!moves) {
      const ghosts = findTaggedElements(svg, id, "ghost");
      if (ghosts.length > 0) {
        issues.push(`Player ${id}: does not move this phase (start==end) but a ghost circle was drawn anyway.`);
      }
      continue;
    }

    const ghosts = findTaggedElements(svg, id, "ghost");
    if (ghosts.length === 0) {
      issues.push(`Player ${id}: moves this phase but no ghost circle found (missing data-player="${id}" data-role="ghost").`);
    } else {
      if (ghosts.length > 1) {
        issues.push(`Player ${id}: ${ghosts.length} ghost circles found, expected exactly 1.`);
      }
      const cx = num(ghosts[0], "cx");
      const cy = num(ghosts[0], "cy");
      if (cx === null || cy === null || Math.abs(cx - p.endX) > TOLERANCE_PX || Math.abs(cy - p.endY) > TOLERANCE_PX) {
        issues.push(`Player ${id}: ghost circle at (${cx},${cy}) does not match phase data endX/endY (${p.endX},${p.endY}).`);
      }
    }

    const moveLines = findTaggedElements(svg, id, "move");
    if (moveLines.length === 0) {
      issues.push(`Player ${id}: moves this phase but no movement line/path found (missing data-player="${id}" data-role="move").`);
    } else if (moveLines.length > 1) {
      issues.push(`Player ${id}: ${moveLines.length} movement lines/paths found for one player in one phase, expected exactly 1.`);
    }

    // hasBall is the authoritative signal (set deterministically by the
    // brief step, not inferred from prose) -- a player who has the ball
    // AND is moving this phase is dribbling, full stop, regardless of how
    // their action text happens to be worded. Action-text containing
    // "dribbl" is kept as a fallback trigger too, in case hasBall is ever
    // missing/undefined on older briefs, but hasBall is checked first and
    // is what actually catches the "plain arrow instead of a dribble"
    // failure mode this validator exists for.
    const actionText = (p.action || "").toLowerCase();
    const shouldBeDribble = p.hasBall === true || actionText.includes("dribbl");
    if (shouldBeDribble && moveLines.length >= 1) {
      const pathTag = moveLines.find((t) => t.startsWith("<path"));
      if (!pathTag) {
        issues.push(`Player ${id}: has the ball and is moving this phase (a live dribble) but the movement element isn't a <path> (likely a straight <line> -- that's a cut, not a dribble).`);
      } else {
        if (!hasCurveCommand(pathTag)) {
          issues.push(`Player ${id}: dribble path uses only straight line-to (L) commands -- that's a jagged zigzag/lightning bolt, not a smooth sine-wave dribble. Use Q (quadratic Bezier) curves instead.`);
        }
        const segs = countPathSegments(pathTag);
        if (segs < 4) {
          issues.push(`Player ${id}: dribble path has only ${segs} segment(s), needs at least 4 for a real wave.`);
        }
      }
    }

    // SCREEN-THEN-MOVE guard: if the phase data itself shows a player NOT
    // moving (start==end, already skipped above via `continue`) this never
    // fires -- so this only matters when upstream data is malformed. Kept
    // here as a second line of defense: a screener's own action text
    // should never simultaneously claim they moved to a screen spot AND
    // popped/rolled elsewhere in prose while start==end says they didn't
    // move -- that combination means the brief step's SCREEN-THEN-MOVE
    // RULE was violated upstream, not a diagram bug, so just surface it.
    if (moves && isSettingScreen(actionText) && /(pop|roll|relocat)/.test(actionText)) {
      issues.push(
        `Player ${id}: action text describes both setting a screen AND popping/rolling/relocating in the same phase ("${p.action}") -- these must be two separate phases (see generate-brief.js's SCREEN-THEN-MOVE RULE); this phase's brief data needs to be split, not just its diagram.`
      );
    }
  }

  return { ok: issues.length === 0, issues };
}
