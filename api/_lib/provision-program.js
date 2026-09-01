/**
 * Provisions the REAL, live side of a new program -- inviting a real coach
 * account and creating a Supabase `programs` row for them. This is the
 * part that makes a program actually usable in the coach dashboard:
 * build_site.py's programs/<slug>.json only produces the static marketing
 * hub page (ghost cards, no login, no real plays) -- this is what turns
 * that into a program someone can actually log into and build plays in,
 * the same way LSU/Dartmouth/etc. work today.
 *
 * IMPORTANT ordering, learned the hard way from a real Postgres error on
 * first use: `programs.coach_id` is a NOT NULL column, so a `programs`
 * row cannot be created before its coach exists. That also means a
 * program is never provisioned without a coach email -- there is no
 * "shell" program in Supabase, only the static hub page, when no email
 * is given. The steps are therefore: invite the coach -> get their real
 * user id -> upsert their `coaches` row -> THEN create `programs` with
 * coach_id already set -> THEN upsert `program_coaches` (the many-coach
 * roster join table) with them as head_coach.
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
 * Deliberately best-effort / non-atomic once the coach account exists: if
 * the `programs` insert or the `program_coaches` upsert fails after the
 * invite already went out, that's reported back rather than silently
 * swallowed, so Shaun can finish the job manually via SQL -- same
 * philosophy as invite-coach.js's own fallback messages.
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
 * @param {string} [opts.coachEmail] -- required for any real provisioning; if omitted, nothing is created (programs.coach_id is NOT NULL).
 * @param {string} [opts.coachName]
 * @param {string} [opts.colorPrimary] -- "#rrggbb"
 * @param {string} [opts.colorSecondary] -- "#rrggbb"
 * @param {string} [opts.crestLabel]
 * @returns {{ programId: string|null, coachInvited: boolean, coachError?: string, skipped?: boolean }}
 */
export async function provisionProgram({ slug, name, coachEmail, coachName, colorPrimary, colorSecondary, crestLabel }) {
  if (!coachEmail) {
    // No coach, no program row -- programs.coach_id is NOT NULL. Only the
    // static hub page exists until a coach email is provided (via a
    // future edit, or the dashboard's own Invite Coach + manual SQL).
    return { programId: null, coachInvited: false, skipped: true };
  }

  const serviceClient = getServiceClient();

  const { data: inviteData, error: inviteErr } = await serviceClient.auth.admin.inviteUserByEmail(coachEmail);
  if (inviteErr) {
    return {
      programId: null,
      coachInvited: false,
      coachError: `Couldn't invite ${coachEmail}: ${inviteErr.message}. If they already have a ChalkTalk account, provision the program manually via SQL instead.`,
    };
  }

  const newCoachId = inviteData.user.id;

  const { error: coachUpsertErr } = await serviceClient
    .from("coaches")
    .upsert({ id: newCoachId, email: coachEmail, ...(coachName ? { display_name: coachName } : {}) }, { onConflict: "id" });

  if (coachUpsertErr) {
    return {
      programId: null,
      coachInvited: false,
      coachError: `Invite sent, but failed to create their coach record: ${coachUpsertErr.message}. Attach them manually via SQL.`,
    };
  }

  const { data: programRow, error: programErr } = await serviceClient
    .from("programs")
    .insert({
      slug,
      name,
      coach_id: newCoachId,
      coach_name: coachName || null,
      coach_name_public: true,
      crest_label: crestLabel || null,
      color_primary: colorPrimary || null,
      color_secondary: colorSecondary || null,
    })
    .select("id")
    .single();

  if (programErr) {
    return {
      programId: null,
      coachInvited: false,
      coachError: `Invite sent and coach record created, but failed to create the programs row: ${programErr.message}. Attach them manually via SQL.`,
    };
  }

  const programId = programRow.id;

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
      coachError: `Program created and invite sent, but failed to attach them as head coach on the roster: ${programCoachErr.message}. Attach them manually via SQL.`,
    };
  }

  return { programId, coachInvited: true };
}
