/**
 * TEMPORARY DIAGNOSTIC — DELETE AFTER USE
 * GET /api/debug-key
 *
 * Reports the length and first/last few characters of ANTHROPIC_API_KEY
 * so we can catch whitespace, truncation, or stray-quote issues without
 * ever exposing the full key value.
 */

export const config = { runtime: "edge" };

export default async function handler() {
  const key = process.env.ANTHROPIC_API_KEY || "";

  return new Response(
    JSON.stringify({
      exists: key.length > 0,
      length: key.length,
      prefix: key.slice(0, 14),
      suffix: key.slice(-6),
      hasLeadingWhitespace: /^\s/.test(key),
      hasTrailingWhitespace: /\s$/.test(key),
      hasQuotes: key.startsWith('"') || key.endsWith('"'),
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}
