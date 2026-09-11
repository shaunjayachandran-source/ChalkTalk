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
  const points = d.match(/[ML]\s*-?\d/gi) || [];
  return Math.max(points.length - 1, 0);
}

/**
 * @param {object} phase - the brief's phase object: { phaseNumber, players: [{id, startX, startY, endX, endY, action}, ...], ... }
 * @param {string} svg - the generated (already-stripped) SVG fragment for this phase
 * @returns {{ok: boolean, issues: string[]}}
 */
export function validatePhaseOutput(phase, svg) {
  const issues = [];
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

    const actionText = (p.action || "").toLowerCase();
    if (actionText.includes("dribbl") && moveLines.length >= 1) {
      const pathTag = moveLines.find((t) => t.startsWith("<path"));
      if (!pathTag) {
        issues.push(`Player ${id}: action describes dribbling but the movement element isn't a <path> (likely a straight <line> -- that's a cut, not a dribble).`);
      } else {
        const segs = countPathSegments(pathTag);
        if (segs < 4) {
          issues.push(`Player ${id}: dribble path has only ${segs} segment(s), needs at least 4 for a real zigzag.`);
        }
      }
    }
  }

  return { ok: issues.length === 0, issues };
}
