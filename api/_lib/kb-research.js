/**
 * Shared research/citation-gate logic for the basketball knowledge base.
 *
 * EXTRACTED this session from api/research-knowledge.js (the 6-hour cron
 * worker) so the exact same "no guessing" contract -- real web_search tool
 * use required, every self-reported source cross-checked against citations
 * Anthropic's own tool actually returned, >=2 distinct verified sources
 * required -- can be reused by api/generate-brief.js's new SYNCHRONOUS
 * in-request research fallback (see claude/chalktalk-part2-rebuild-status.md,
 * "Yes - build it now," Sep 15 2026) without duplicating this logic between
 * two files that could silently drift out of sync with each other. Behavior
 * is unchanged from the cron worker's original inline copy -- this is a
 * pure relocation, not a rewrite, except researchTopic() below gains an
 * optional timeoutMs so a request-path caller (which has a real coach
 * waiting) can bound how long it waits, something the cron worker never
 * needed since it already runs on its own schedule with no one watching.
 *
 * Destination: api/_lib/kb-research.js
 */

export const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
export const MODEL = "claude-sonnet-4-6";
export const MIN_DISTINCT_SOURCES = 2;

// Restricted to Shaun's designated first research spots (Sep 15, 2026)
// rather than the open web -- see api/research-knowledge.js for the full
// rationale. Shared here so the synchronous in-request path in
// generate-brief.js searches the exact same coach-vetted sites as the
// background cron worker, not a separately-drifting list.
export const ALLOWED_RESEARCH_DOMAINS = [
  "coachesclipboard.net",
  "www.coachesclipboard.net",
  "basketballforcoaches.com",
  "www.basketballforcoaches.com",
];

export const RESEARCH_SYSTEM_PROMPT = `You are a basketball research assistant for ChalkTalk, a coaching-playbook
product. You are given the name of an offensive or defensive system a coach
typed or said aloud, which is NOT YET in ChalkTalk's knowledge base. Your job
is to research it for real using the web_search tool and produce a single
structured JSON entry -- or say plainly that you could not find enough to be
confident.

HARD RULES:
- You MUST use the web_search tool at least once before answering. Do not
  answer from memory alone.
- Every factual/structural claim in your output (personnel, spacing,
  formation, key reads, who runs it) must be something you actually found in
  a search result during this conversation, not something you already knew
  before searching. If your prior knowledge and the search results agree,
  cite the search result anyway -- citations are what make this trustworthy,
  not correctness alone.
- If your searches turn up fewer than 2 independent, credible sources that
  substantively describe this system, DO NOT pad the entry with guesses. Set
  "insufficient_evidence": true and explain what you found and didn't find.
- Never fabricate a URL, title, or quote. Only report sources you actually
  retrieved via the tool this turn.
- Basketball terminology is often used loosely online (the same name can mean
  different things at different levels). If sources disagree or the term is
  ambiguous, say so in "notes" rather than picking one interpretation
  silently.

Respond with your reasoning first if useful, then end your response with
exactly one fenced code block, \`\`\`json ... \`\`\`, containing an object with
this exact shape:

{
  "insufficient_evidence": false,
  "system_name": "Canonical name, Title Case",
  "category": "offense" | "defense",
  "formation": "e.g. 4-out 1-in, 2-3, 1-3-1, or null if not applicable",
  "aliases": ["lowercase alt names/abbreviations"],
  "summary": "2-4 sentence plain-language description a parent could follow",
  "structure": {
    "personnel": "who's involved and where they start",
    "key_action": "the core mechanism (screen, cut, read, trap, etc.)",
    "common_variations": "brief note on notable variants, if any"
  },
  "coaching_level": "youth" | "high-school" | "college" | "pro" | null,
  "sources": [
    { "url": "https://...", "title": "...", "cited_text": "short quote or paraphrase of what this source told you" }
  ],
  "notes": "anything uncertain, disputed, or worth a human reviewer's attention"
}`;

export function extractJsonBlock(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// Pulls every citation Anthropic itself attached to the response's text
// blocks. These come from the tool's own search results -- the model
// cannot inject an arbitrary URL into this array, which is exactly why it's
// the ground truth we check self-reported sources against, not the other
// way around.
export function extractRealCitations(contentBlocks) {
  const seen = new Map(); // url -> {url, title}
  for (const block of contentBlocks || []) {
    if (block.type !== "text" || !Array.isArray(block.citations)) continue;
    for (const c of block.citations) {
      if (c.type === "web_search_result_location" && c.url) {
        seen.set(c.url, { url: c.url, title: c.title || null });
      }
    }
  }
  return [...seen.values()];
}

export function countSearchToolResults(contentBlocks) {
  return (contentBlocks || []).filter((b) => b.type === "web_search_tool_result").length;
}

/**
 * The code-level gate. Never trust the model's "sources" array on its own
 * word -- cross-check every reported URL against citations Anthropic itself
 * attached from real search results this turn.
 */
export function verifyCitations(parsed, realCitations) {
  const realUrls = new Set(realCitations.map((c) => c.url));
  const reported = Array.isArray(parsed.sources) ? parsed.sources : [];

  if (reported.length === 0) {
    return { ok: false, reason: "model reported zero sources" };
  }

  const unverified = reported.filter((s) => !realUrls.has(s.url));
  if (unverified.length > 0) {
    return {
      ok: false,
      reason: `${unverified.length} reported source(s) do not match any real citation this run actually returned: ${unverified.map((s) => s.url).join(", ")}`,
    };
  }

  const distinctVerified = new Set(reported.map((s) => s.url));
  if (distinctVerified.size < MIN_DISTINCT_SOURCES) {
    return {
      ok: false,
      reason: `only ${distinctVerified.size} distinct verified source(s), need at least ${MIN_DISTINCT_SOURCES}`,
    };
  }

  return { ok: true };
}

/**
 * Calls the Anthropic Messages API with the web_search tool restricted to
 * ALLOWED_RESEARCH_DOMAINS, same as the cron worker.
 *
 * timeoutMs (new, optional): the cron worker never needed this -- it has no
 * one waiting on it -- but generate-brief.js's synchronous in-request path
 * does, so a slow/hung search doesn't stall a coach's "generate" click
 * indefinitely. On timeout this throws an error with `.code ===
 * "RESEARCH_TIMEOUT"` so callers can distinguish "took too long" from a
 * genuine API/network failure and fall back accordingly.
 */
export async function researchTopic(topic, { timeoutMs = null } = {}) {
  const controller = timeoutMs ? new AbortController() : null;
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system: RESEARCH_SYSTEM_PROMPT,
        tools: [
          {
            type: "web_search_20260318",
            name: "web_search",
            max_uses: 5,
            // allowed_domains and blocked_domains are mutually exclusive on
            // this tool (a 400 error if both are set) -- this is a hard
            // allowlist: a topic not covered on either site will correctly
            // fail the citation gate as insufficient_evidence rather than
            // silently falling back to broader, unvetted search results.
            allowed_domains: ALLOWED_RESEARCH_DOMAINS,
          },
        ],
        messages: [
          {
            role: "user",
            content: `Research this basketball system for ChalkTalk's knowledge base: "${topic}"`,
          },
        ],
      }),
      signal: controller ? controller.signal : undefined,
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      const timeoutErr = new Error(`research call for "${topic}" exceeded ${timeoutMs}ms timeout`);
      timeoutErr.code = "RESEARCH_TIMEOUT";
      throw timeoutErr;
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error researching "${topic}": ${errText}`);
  }

  const data = await res.json();
  const textBlocks = (data.content || []).filter((b) => b.type === "text");
  const fullText = textBlocks.map((b) => b.text).join("\n");
  const parsed = extractJsonBlock(fullText);
  const realCitations = extractRealCitations(data.content);
  const searchCallCount = countSearchToolResults(data.content);

  return { parsed, realCitations, searchCallCount, rawContent: data.content };
}

/**
 * Shapes a passed-gate research result into the exact kb_entries upsert
 * payload both the cron worker and the synchronous in-request path write.
 * Kept in one place so a future column change only has to happen once.
 */
export function buildKbEntryUpsertPayload(parsed, slug) {
  return {
    system_name: parsed.system_name,
    slug,
    aliases: parsed.aliases || [],
    category: parsed.category,
    formation: parsed.formation || null,
    summary: parsed.summary,
    structure: parsed.structure || {},
    sources: parsed.sources,
    confidence: "auto_merged_sourced",
    coaching_level: parsed.coaching_level || null,
    updated_at: new Date().toISOString(),
    last_verified_at: new Date().toISOString(),
  };
}
