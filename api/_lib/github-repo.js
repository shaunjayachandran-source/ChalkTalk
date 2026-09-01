/**
 * Small GitHub REST API wrapper used by the new-program pipeline
 * (api/create-program.js, api/approve-program.js, api/reject-program.js,
 * api/list-pending-programs.js).
 *
 * Why raw fetch instead of the GitHub Action / git CLI: Vercel functions
 * are stateless and have no working git checkout, so "commit a new file
 * to a branch" has to happen through the Contents API instead of `git
 * commit` + `git push`. This mirrors the exact sequence a person would
 * do by hand in the GitHub web UI (which is how every prior branch in
 * this project has been created, since this sandbox's own git push is
 * blocked) -- get the base branch's SHA, create a new ref from it, PUT
 * the file. Nothing here needs a local git checkout.
 *
 * GITHUB_API_TOKEN must be a fine-grained PAT scoped to just this repo
 * with "Contents: Read and write" permission, stored as its own Vercel
 * env var -- separate from RESEND_API_KEY, SUPABASE_SERVICE_ROLE_KEY,
 * and ADMIN_TOKEN. Treat it like any other secret: it can create
 * branches and commit files in this repo, nothing more (no other repos,
 * no account-level actions) if scoped correctly when it's generated.
 */

const OWNER = "shaunjayachandran-source";
const REPO = "ChalkTalk";
const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;

function authHeaders() {
  const token = process.env.GITHUB_API_TOKEN;
  if (!token) throw new Error("GITHUB_API_TOKEN is not set");
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
}

async function ghFetch(path, options = {}) {
  const resp = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  });
  return resp;
}

/** SHA of the tip commit of a branch (404-safe: returns null instead of throwing). */
export async function getBranchSha(branch) {
  const resp = await ghFetch(`/git/ref/heads/${encodeURIComponent(branch)}`);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`getBranchSha(${branch}): GitHub ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.object.sha;
}

/** Creates `branch` pointing at `fromSha`. Throws if it already exists. */
export async function createBranch(branch, fromSha) {
  const resp = await ghFetch(`/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha }),
  });
  if (!resp.ok) throw new Error(`createBranch(${branch}): GitHub ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

/** Ensures `branch` exists, branching from `main` if it doesn't yet. Used
 * for the long-lived `programs-pending` storage branch. */
export async function ensureBranch(branch, baseBranch = "main") {
  const existing = await getBranchSha(branch);
  if (existing) return existing;
  const baseSha = await getBranchSha(baseBranch);
  if (!baseSha) throw new Error(`ensureBranch(${branch}): base branch '${baseBranch}' not found`);
  await createBranch(branch, baseSha);
  return baseSha;
}

/** Reads one file's content + sha from a branch. Returns null (not throw) on 404. */
export async function getFileContent(path, branch) {
  const resp = await ghFetch(`/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`getFileContent(${path}@${branch}): GitHub ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return {
    sha: data.sha,
    content: Buffer.from(data.content, "base64").toString("utf-8"),
  };
}

/** Creates or updates a file on `branch`. Pass `sha` (from getFileContent)
 * when overwriting an existing file -- omit it for a brand-new file. */
export async function putFileContent(path, branch, contentString, message, sha) {
  const body = {
    message,
    branch,
    content: Buffer.from(contentString, "utf-8").toString("base64"),
  };
  if (sha) body.sha = sha;
  const resp = await ghFetch(`/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`putFileContent(${path}@${branch}): GitHub ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

/** Deletes a file on `branch`. `sha` is required by the GitHub API. */
export async function deleteFileContent(path, branch, sha, message) {
  const resp = await ghFetch(`/contents/${encodeURIComponent(path)}`, {
    method: "DELETE",
    body: JSON.stringify({ message, branch, sha }),
  });
  if (!resp.ok) throw new Error(`deleteFileContent(${path}@${branch}): GitHub ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

/** Lists files directly inside a directory on a branch. Returns [] (not
 * throw) if the directory doesn't exist yet (e.g. no pending submissions). */
export async function listDirectory(path, branch) {
  const resp = await ghFetch(`/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`);
  if (resp.status === 404) return [];
  if (!resp.ok) throw new Error(`listDirectory(${path}@${branch}): GitHub ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

export function compareUrl(branch, baseBranch = "main") {
  return `https://github.com/${OWNER}/${REPO}/compare/${baseBranch}...${branch}?expand=1`;
}
