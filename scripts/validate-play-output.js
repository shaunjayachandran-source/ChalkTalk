#!/usr/bin/env node
/**
 * Offline / regression CLI for the same checks that now run automatically
 * inside api/generate-playbook.js on every real generation (see
 * api/_lib/validate-diagram.js). Use this to replay a SPECIFIC bug report
 * (e.g. "Memphis Dribble Drive Motion") against the current prompt without
 * needing to log into the app and rebuild the whole play.
 *
 * Usage:
 *   node scripts/validate-play-output.js path/to/captured-play.json
 *
 * Input file shape -- an array of phase objects, each the ORIGINAL brief
 * phase (with its players[] startX/startY/endX/endY/action) merged with
 * that same phase's generated diagramSvg string:
 *
 *   [
 *     {
 *       "phaseNumber": 1,
 *       "players": [
 *         { "id": 1, "startX": 260, "startY": 285, "endX": 260, "endY": 285, "action": "..." },
 *         ...
 *       ],
 *       "diagramSvg": "<circle data-player=\"1\" data-role=\"start\" .../>..."
 *     },
 *     ...
 *   ]
 *
 * How to assemble one from a real bug report: open the browser network
 * tab while building the play, copy the request body sent to
 * /api/generate-brief's caller (the brief JSON, which has players[] per
 * phase) and copy the diagramSvg string logged/returned per phase, then
 * merge them into this shape by hand. This is a manual step today because
 * the brief JSON isn't persisted server-side (see known-failure-modes.md)
 * -- the in-app validation (api/_lib/validate-diagram.js, wired into
 * generate-playbook.js) is the primary safety net for real plays; this
 * script is for deliberately reproducing and regression-testing one
 * specific reported bug.
 */

import { readFileSync } from "fs";
import { validatePhaseOutput } from "../api/_lib/validate-diagram.js";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/validate-play-output.js path/to/captured-play.json");
  process.exit(2);
}

let phases;
try {
  phases = JSON.parse(readFileSync(inputPath, "utf8"));
} catch (err) {
  console.error(`Failed to read/parse ${inputPath}: ${err.message}`);
  process.exit(2);
}

if (!Array.isArray(phases)) {
  console.error("Input must be a JSON array of phase objects. See this script's header comment for the expected shape.");
  process.exit(2);
}

let totalIssues = 0;
for (const phase of phases) {
  const { ok, issues } = validatePhaseOutput(phase, phase.diagramSvg || "");
  const label = `Phase ${phase.phaseNumber ?? "?"} (${phase.phaseName || "unnamed"})`;
  if (ok) {
    console.log(`PASS  ${label}`);
  } else {
    console.log(`FAIL  ${label}`);
    for (const issue of issues) {
      console.log(`      - ${issue}`);
    }
    totalIssues += issues.length;
  }
}

console.log("");
if (totalIssues === 0) {
  console.log(`All ${phases.length} phase(s) passed.`);
  process.exit(0);
} else {
  console.log(`${totalIssues} issue(s) found across ${phases.length} phase(s).`);
  process.exit(1);
}
