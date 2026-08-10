/**
 * Catch-all for static assets that must never be served, no matter what
 * -- currently tokens.json (the plaintext token list, which used to be
 * publicly fetchable at /tokens.json) and the two committed debug
 * artifacts (test_payload.json, response_output.json). vercel.json
 * rewrites requests for those paths here instead of letting Vercel's
 * static file server answer them.
 */
export default function handler(req, res) {
  res.status(404).json({ error: "Not found" });
}
