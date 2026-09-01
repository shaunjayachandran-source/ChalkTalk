/**
 * POST /api/reject-program
 * Body: { slug }
 *
 * Admin-token gated. Discards a pending Google-Form program request --
 * deletes programs/_pending/<slug>.json from the `programs-pending`
 * branch. No real branch is ever touched; this is the "no" counterpart
 * to api/approve-program.js.
 */

import { getFileContent, deleteFileContent } from "./_lib/github-repo.js";
import { validateAdminToken } from "./_lib/validate-admin.js";

const PENDING_BRANCH = "programs-pending";

function sendJson(res, status, body) {
  res.status(status).json(body);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const auth = validateAdminToken(req);
  if (!auth.ok) {
    return sendJson(res, auth.status, { error: auth.error });
  }

  const { slug } = req.body || {};
  if (!slug) {
    return sendJson(res, 400, { error: "slug is required" });
  }

  const pendingPath = `programs/_pending/${slug}.json`;

  try {
    const pendingFile = await getFileContent(pendingPath, PENDING_BRANCH);
    if (!pendingFile) {
      return sendJson(res, 404, { error: `No pending request found for '${slug}'` });
    }

    await deleteFileContent(pendingPath, PENDING_BRANCH, pendingFile.sha, `Rejected pending program request: ${slug}`);

    return sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error("[reject-program]", err.message);
    return sendJson(res, 502, { error: `Couldn't reject '${slug}': ${err.message}` });
  }
}
