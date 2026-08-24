/**
 * POST /api/notify-team-member
 * Body: { programId, email, name, link, programName? }
 *
 * Sends the "your playbook is ready" email to a newly-added team member
 * (player/parent/etc). Separate from Supabase Auth's own emails (used for
 * coach invites) because team members never get a real Supabase Auth
 * account -- they use the passwordless access_links token system instead.
 * Supabase's SMTP config (Resend, set up Aug 20, 2026) is internal to
 * Supabase Auth and not reachable from our own Vercel functions, so this
 * calls Resend's HTTP API directly with its own API key (RESEND_API_KEY).
 *
 * Auth: any of the four coach roles can send team-member invites per the
 * locked permission matrix ("Send invites (issue access links): all four
 * roles"), so this only requires the caller to be a coach on the program
 * at all -- no head-coach-only check like invite-coach.js has.
 *
 * SMS is not implemented yet. Once a texting provider is chosen, add a
 * sendSms() call alongside sendEmail() below, gated on a phone number
 * being present, with its own try/catch so an SMS failure never blocks
 * the email (and vice versa).
 */

import { validateCoachSession } from "./_lib/validate-session.js";

const RESEND_FROM = "ChalkTalk <invites@notifications.crossover-india.org>";

function sendJson(res, status, body) {
  res.status(status).json(body);
}

async function sendEmail({ to, name, link, programName }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not set");

  const subject = programName
    ? `Your ${programName} playbook access is ready`
    : "Your ChalkTalk playbook access is ready";

  const html = `
    <p>Hi ${name || "there"},</p>
    <p>You've been added to ${programName ? `<strong>${programName}</strong>'s` : "your team's"} ChalkTalk playbook.</p>
    <p><a href="${link}">Click here to see your playbook</a></p>
    <p>This link is yours alone -- no password needed. Save it or bookmark it so you can check plays anytime.</p>
    <p>-- ChalkTalk</p>
  `;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to,
      subject,
      html,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Resend ${resp.status}: ${body || resp.statusText}`);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const { programId, email, name, link, programName } = req.body || {};

  if (!programId || !email || !link) {
    return sendJson(res, 400, { error: "programId, email, and link are all required" });
  }

  const session = await validateCoachSession(req, programId);
  if (!session.ok) {
    return sendJson(res, session.status, { error: session.error });
  }

  try {
    await sendEmail({ to: email, name, link, programName });
  } catch (err) {
    console.error("[notify-team-member]", err.message);
    return sendJson(res, 502, { error: `Couldn't send the email: ${err.message}` });
  }

  return sendJson(res, 200, { ok: true });
}
