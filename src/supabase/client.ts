// Server-only client. Uses the service-role key, which bypasses RLS —
// this module must never be bundled into, or its key sent to, the frontend.
import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
