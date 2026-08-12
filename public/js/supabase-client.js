// Shared Supabase client config for coach-facing pages (login.html, dashboard.html).
//
// The values below are the Project URL and the "anon"/"publishable" key.
// Both are meant to be public — this is the same pattern as a Firebase web
// config or a Stripe publishable key. They only let a client authenticate
// as a specific logged-in user and read/write whatever Row Level Security
// policies allow that user to touch. The database enforces "a coach can
// only see their own programs/plays/team members" — this key can't bypass
// that. The separate service-role key (used only in Vercel's server-side
// environment variables, never here) is the one that must stay secret.

const SUPABASE_URL = "https://dvilirimxnkaghqyoueh.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_hhEb5Mj8QS1Byv8_Ne6FIw_NbZHbu9-";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Redirects to login.html if there's no active session. Call this at the
// top of any page that requires a logged-in coach.
export async function requireSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = "/login.html";
    return null;
  }
  return session;
}
