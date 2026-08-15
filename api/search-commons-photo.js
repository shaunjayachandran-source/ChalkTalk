/**
 * GET/POST /api/search-commons-photo?query=<text>
 *
 * Simple passthrough/reshape in front of Wikimedia Commons' public
 * MediaWiki search API, used by the dashboard's Program Branding editor
 * so a coach can search for a hero photo without leaving the dashboard.
 *
 * No API key, no auth -- Commons' search API is public and read-only, and
 * nothing here touches Supabase or any per-coach data. This matches the
 * pattern of api/blocked-asset.js (also public, no session check): only
 * endpoints that read/write a program's own data (generate-playbook,
 * generate-brief, serve-playbook) validate a Supabase session, because
 * that's the actual point where access needs to be restricted.
 *
 * Accepts `query` as either a GET query-string param or a POST JSON body
 * field, whichever's easiest for the caller -- this endpoint has no side
 * effects either way, so there's no real POST-vs-GET semantic to enforce.
 *
 * Response (JSON):
 *   { results: [ { title, thumbnailUrl, fullUrl, filePageUrl, artist, licenseShortName }, ... ] }
 *   or { error: string } with an appropriate status code (only when the
 *   fetch to Commons itself fails outright -- a zero-result search is a
 *   normal 200 with an empty array, not an error).
 */

const COMMONS_API_URL = "https://commons.wikimedia.org/w/api.php";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return sendJson(res, { error: "Method not allowed" }, 405);
  }

  const query =
    req.method === "GET"
      ? req.query?.query
      : (req.body && typeof req.body === "object" ? req.body.query : undefined);

  if (!query || typeof query !== "string" || !query.trim()) {
    return sendJson(res, { error: "Missing query" }, 400);
  }

  const url = new URL(COMMONS_API_URL);
  url.searchParams.set("action", "query");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", query.trim());
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrlimit", "8");
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|extmetadata");
  url.searchParams.set("iiurlwidth", "400");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");

  let data;
  try {
    const commonsRes = await fetch(url.toString());
    if (!commonsRes.ok) {
      return sendJson(res, { error: `Wikimedia Commons returned ${commonsRes.status}` }, 502);
    }
    data = await commonsRes.json();
  } catch (err) {
    return sendJson(res, { error: `Couldn't reach Wikimedia Commons: ${err.message}` }, 502);
  }

  return sendJson(res, { results: shapeResults(data) });
}

// Exported (in addition to being used internally) purely so it can be unit
// tested against a saved sample API response without needing a live network
// call -- see api/_lib/search-commons-photo.test.js.
export function shapeResults(data) {
  const pages = data?.query?.pages;
  if (!pages || typeof pages !== "object") return [];

  return Object.values(pages)
    .map((page) => {
      const info = Array.isArray(page.imageinfo) ? page.imageinfo[0] : null;
      if (!info) return null;

      // Prefer the width-limited thumbnail Commons generated for us
      // (iiurlwidth=400); fall back to the full-res url if a thumbnail
      // wasn't returned for some reason (e.g. the file is already tiny).
      const thumbnailUrl = info.thumburl || info.url;
      const fullUrl = info.url;
      if (!thumbnailUrl || !fullUrl) return null;

      const meta = info.extmetadata || {};
      const artist = stripHtml(meta.Artist?.value || "");
      const licenseShortName = stripHtml(meta.LicenseShortName?.value || "");

      return {
        title: page.title || "",
        thumbnailUrl,
        fullUrl,
        filePageUrl: info.descriptionurl || info.descriptionshorturl || fullUrl,
        artist,
        licenseShortName,
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function stripHtml(str) {
  return String(str || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sendJson(res, obj, status = 200) {
  res.status(status).json(obj);
}
