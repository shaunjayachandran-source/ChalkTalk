/**
 * GET /api/list-pending-programs
 *
 * Admin-token gated. Lists every programs/_pending/*.json file sitting on
 * the `programs-pending` branch -- these are Google Form beta-signup
 * submissions that haven't been approved or rejected yet (see
 * api/create-program.js for how they land there, api/approve-program.js
 * and api/reject-program.js for how they leave). Powers the "Pending
 * requests" panel on /admin.html.
 */

import { listDirectory, getFileContent } from "./_lib/github-repo.js";
import { validateAdminToken } from "./_lib/validate-admin.js";

const PENDING_BRANCH = "programs-pending";
const PENDING_DIR = "programs/_pending";

function sendJson(res, status, body) {
  res.status(status).json(body);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const auth = validateAdminToken(req);
  if (!auth.ok) {
    return sendJson(res, auth.status, { error: auth.error });
  }

  try {
    const entries = await listDirectory(PENDING_DIR, PENDING_BRANCH);
    const files = entries.filter((e) => e.type === "file" && e.name.endsWith(".json"));

    const pending = [];
    for (const f of files) {
      const file = await getFileContent(`${PENDING_DIR}/${f.name}`, PENDING_BRANCH);
      if (!file) continue;
      try {
        pending.push(JSON.parse(file.content));
      } catch (err) {
        console.error("[list-pending-programs] bad JSON in", f.name, err.message);
      }
    }

    return sendJson(res, 200, { ok: true, pending });
  } catch (err) {
    console.error("[list-pending-programs]", err.message);
    return sendJson(res, 502, { error: `Couldn't list pending programs: ${err.message}` });
  }
}
