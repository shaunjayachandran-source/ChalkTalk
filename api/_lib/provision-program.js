/**
 * Provisions the REAL, live side of a new program -- a Supabase `programs`
 * row plus (if an email was given) a real coach account, invited and
 * attached as head_coach. This is the part that makes a program actually
 * usable in the coach dashboard: build_site.py's programs/<slug>.json only
 * produces the static marketing hub page (ghost cards, no login, no real
 * plays) -- this is what turns that into a program someone can actually
 * log into and build plays in, the same way LSU/Dartmouth/etc. work today.
 *
 * Mirrors api/invite-coach.js's own pattern (service-role client, used
 * narrowly for the one privileged write already authorized upstream) --
 * see that file's header comment for the full reasoning. The one
 * difference: invite-coach.js requires the caller to already be head_coach
 * on the program, because it's adding an ADDITIONAL coach to an existing
 * program. A brand-new program has no coaches yet, so there is nothing to
 * check membership against -- this function IS the bootstrap step Shaun
 * used to do by hand via SQL for every new program's first coach.
 *
 * Deliberately best-effort / non-atomic across the two halves (Supabase
 * programs row, then the coach invite): if the coach invite fails (e.g.
 * that email already has an account), the programs row still exists and
 * is returned so the caller can report a partial success rather than
 * losing the whole submission -- same philosophy as invite-coach.js's own
 * "attach them manually via SQL" fallback messages.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://dvilirimxnkaghqyoueh.supabase.co";

function getServiceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(SUPABASE_URL, key);
}

/**
 * @param {object} opts
 * @param {string} opts.slug
 * @param {string} opts.name
 * @param {string} [opts.coachEmail] -- if omitted, only the programs row is created (no invite).
 * @param {string} [opts.coachName]
 * @param {string} [opts.colorPrimary] -- "#rrggbb"
 * @param {string} [opts.colorSecondary] -- "#rrggbb"
 * @param {string} [opts.crestLabel]
 * @returns {{ programId: string, coachInvited: boolean, coachError?: string }}
 */
export async function provisionProgram({ slug, name, coachEmail, coachName, colorPrimary, colorSecondary, crestLabel }) {
  const serviceClient = getServiceClient();

  const { data: programRow, error: programErr } = await serviceClient
    .from("programs")
    .insert({
      slug,
      name,
      coach_name: coachName || null,
      coach_name_public: true,
      crest_label: crestLabel || null,
      color_primary: colorPrimary || null,
      color_secondary: colorSecondary || null,
    })
    .select("id")
    .single();

  if (programErr) {
    throw new Error(`Couldn't create the programs row: ${programErr.message}`);
  }

  const programId = programRow.id;

  if (!coachEmail) {
    return { programId, coachInvited: false };
  }

  const { data: inviteData, error: inviteErr } = await serviceClient.auth.admin.inviteUserByEmail(coachEmail);
  if (inviteErr) {
    return {
      programId,
      coachInvited: false,
      coachError: `Program created, but couldn't invite ${coachEmail}: ${inviteErr.message}. Use the dashboard's Invite Coach flow (or SQL) to attach them manually.`,
    };
  }

  const newCoachId = inviteData.user.id;

  const { error: coachUpsertErr } = await serviceClient
    .from("coaches")
    .upsert({ id: newCoachId, email: coachEmail, ...(coachName ? { display_name: coachName } : {}) }, { onConflict: "id" });

  if (coachUpsertErr) {
    return {
      programId,
      coachInvited: false,
      coachError: `Program created and invite sent, but failed to create their coach record: ${coachUpsertErr.message}. Attach them manually via SQL.`,
    };
  }

  const { error: programCoachErr } = await serviceClient
    .from("program_coaches")
    .upsert(
      { program_id: programId, coach_id: newCoachId, role: "head_coach", can_publish: true },
      { onConflict: "program_id,coach_id" }
    );

  if (programCoachErr) {
    return {
      programId,
      coachInvited: false,
      coachError: `Program created and invite sent, but failed to attach them as head coach: ${programCoachErr.message}. Attach them manually via SQL.`,
    };
  }

  return { programId, coachInvited: true };
}
