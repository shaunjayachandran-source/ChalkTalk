/**
 * Shared helpers for the basketball offense/defense knowledge base.
 *
 * WHY THIS EXISTS: see claude/knowledge-base-architecture.md (ChalkTalk
 * Project doc) -- the standing rule is "refer to what we know; if it isn't
 * known, research it for real; never guess." This module is the retrieval
 * half of that contract. lookupKbEntry() is the ONLY sanctioned way any
 * generation code checks whether a named offense/defense system is already
 * known -- it returns null on a genuine miss rather than ever fabricating a
 * plausible-looking entry.
 *
 * Destination: api/_lib/knowledge-base.js
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://dvilirimxnkaghqyoueh.supabase.co";

function getSupabase() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(SUPABASE_URL, key);
}

export function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Retrieval-first lookup. Tries an exact slug match, then an alias match.
 * Returns the full kb_entries row, or null if genuinely not found -- callers
 * MUST treat null as "unknown to the knowledge base," not as license to
 * fall back to unverified general model knowledge without flagging it.
 */
export async function lookupKbEntry(systemName) {
  if (!systemName) return null;
  const supabase = getSupabase();
  const slug = slugify(systemName);

  const { data: bySlug, error: e1 } = await supabase
    .from("kb_entries")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();
  if (e1) throw e1;
  if (bySlug) return bySlug;

  const { data: byAlias, error: e2 } = await supabase
    .from("kb_entries")
    .select("*")
    .contains("aliases", [slug])
    .limit(1);
  if (e2) throw e2;
  return byAlias && byAlias.length > 0 ? byAlias[0] : null;
}

/**
 * Deterministic (non-LLM) substring match against every known system's name
 * and aliases. Used as the retrieval-first check against a coach's freeform
 * play description before generation -- intentionally NOT an LLM call, and
 * intentionally conservative (exact substring only) so it never "guesses"
 * that a description implies a system it doesn't literally name. A coach
 * writing "we run motion" matches "Motion Offense"; a coach describing
 * motion-like actions without naming it does not match, and correctly
 * falls through to the unverified/general-knowledge path rather than a
 * false-positive grounding.
 */
export async function findMentionedSystem(text) {
  if (!text) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("kb_entries")
    .select("id, system_name, slug, aliases, category, formation, summary, structure, sources, confidence, coaching_level, last_verified_at");
  if (error) throw error;

  const haystack = text.toLowerCase();
  for (const entry of data || []) {
    const names = [entry.system_name, ...(entry.aliases || [])].filter(Boolean);
    for (const name of names) {
      if (haystack.includes(String(name).toLowerCase())) {
        return entry;
      }
    }
  }
  return null;
}

const STALE_AFTER_DAYS = 180;

export function isStale(entry) {
  if (!entry || !entry.last_verified_at) return true;
  const ageMs = Date.now() - new Date(entry.last_verified_at).getTime();
  return ageMs > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Fire-and-forget queueing: called from generate-brief.js whenever a coach
 * names a system the KB doesn't recognize. This is how the research queue
 * fills itself from real usage instead of anyone guessing what to crawl
 * for next. Safe to call from a request path -- callers should await it in
 * a try/catch and never let a queueing failure block the coach's response.
 */
export async function enqueueResearchTopic(topic, { reason = "coach_requested_unknown_system", requestedBy = null } = {}) {
  if (!topic) return null;
  const supabase = getSupabase();
  const slug = slugify(topic);

  const { data: existing, error: eLookup } = await supabase
    .from("kb_research_queue")
    .select("id")
    .eq("normalized_slug", slug)
    .in("status", ["pending", "running"])
    .maybeSingle();
  if (eLookup) throw eLookup;
  if (existing) return existing.id;

  const { data, error } = await supabase
    .from("kb_research_queue")
    .insert({ topic, normalized_slug: slug, reason, requested_by: requestedBy })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export { getSupabase };
