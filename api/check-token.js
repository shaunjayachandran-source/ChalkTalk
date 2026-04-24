/**
 * GET /api/check-token?token=<token>&program=<program>
 *
 * Gate into a program's playbook index by token.
 *   - Valid token + active  → 302 to the program index page
 *   - Missing / invalid / inactive / wrong program → 302 to /blocked.html
 *
 * tokens.json lives at the repo root and is fetched per request so that
 * token edits go live immediately without a redeploy of this function.
 *
 * NOTE: the program folder on disk is currently `playbooks/<program>/`,
 * not `programs/<program>/`. If the repo is reorganized to `programs/`,
 * flip PROGRAM_BASE below.
 */

export const config = { runtime: "edge" };

const PROGRAM_BASE = "/playbooks";
const BLOCKED_URL  = "/blocked.html";

export default async function handler(req) {
  const reqUrl = new URL(req.url);
  const { token, program } = Object.fromEntries(reqUrl.searchParams);

  // Short-circuit: missing inputs can't be valid.
  if (!token || !program) {
    return Response.redirect(new URL(BLOCKED_URL, reqUrl), 302);
  }

  // Load token list. Static file at the repo root → same origin as this fn.
  let tokens;
  try {
    const res = await fetch(new URL("/tokens.json", reqUrl), {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`tokens.json fetch ${res.status}`);
    tokens = await res.json();
  } catch (err) {
    // Fail closed: any error loading the token list sends the user to blocked.
    return Response.redirect(new URL(BLOCKED_URL, reqUrl), 302);
  }

  const programTokens = tokens[program];
  const entry = programTokens && programTokens[token];
  const valid = Boolean(entry && entry.active === true);

  if (valid) {
    const dest = `${PROGRAM_BASE}/${encodeURIComponent(program)}/index.html`;
    return Response.redirect(new URL(dest, reqUrl), 302);
  }

  // Invalid. If the token exists *anywhere* in tokens.json, surface its role
  // as a hint so blocked.html can pick an audience-appropriate headline.
  // Falls back to no hint if the token is entirely unknown — rotation on
  // blocked.html will show the union of both pools in that case.
  let role = "";
  for (const prog of Object.keys(tokens)) {
    const t = tokens[prog] && tokens[prog][token];
    if (t && typeof t.role === "string") { role = t.role; break; }
  }

  const blocked = new URL(BLOCKED_URL, reqUrl);
  if (role) blocked.searchParams.set("role", role);
  return Response.redirect(blocked, 302);
}
