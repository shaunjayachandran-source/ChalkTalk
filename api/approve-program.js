/**
 * POST /api/approve-program
 * Body: { slug }
 *
 * Admin-token gated. This is the ONLY path by which a Google-Form-sourced
 * program request ever reaches a real branch -- see api/create-program.js
 * for why form submissions land in programs/_pending/ on the inert
 * `programs-pending` branch instead of going straight to a feature branch.
 *
 * Steps: read programs/_pending/<slug>.json off `programs-pending`, copy
 * its content verbatim onto a new feature/new-program-<slug>-<timestamp>
 * branch off main (same shape as the direct-admin path), then remove the
 * file from programs-pending so it doesn't show up as still-pending.
 * From here it's the same manual review/merge as any other change.
 */

import {
  getBranchSha,
  createBranch,
  getFileContent,
  putFileContent,
  deleteFileContent,
  compareUrl,
} from "./_lib/github-repo.js";
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

    const existing = await getFileContent(`programs/${slug}.json`, "main");
    if (existing) {
      return sendJson(res, 409, {
        error: `programs/${slug}.json already exists on main -- resolve the slug collision before approving.`,
      });
    }

    const branch = `feature/new-program-${slug}-${Date.now()}`;
    const baseSha = await getBranchSha("main");
    if (!baseSha) throw new Error("Could not read main branch HEAD");
    await createBranch(branch, baseSha);
    await putFileContent(
      `programs/${slug}.json`,
      branch,
      pendingFile.content,
      `Approve pending program request: ${slug}`
    );

    await deleteFileContent(
      pendingPath,
      PENDING_BRANCH,
      pendingFile.sha,
      `Approved: remove pending request ${slug}`
    );

    return sendJson(res, 200, { ok: true, branch, compareUrl: compareUrl(branch) });
  } catch (err) {
    console.error("[approve-program]", err.message);
    return sendJson(res, 502, { error: `Couldn't approve '${slug}': ${err.message}` });
  }
}
