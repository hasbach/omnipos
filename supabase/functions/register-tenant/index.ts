// Supabase Edge Function: register-tenant
//
// Creates a new business account. This is the ONE registration step that needs the
// service-role key (to create the Supabase Auth user), which must never ship inside the
// desktop installer — so it lives here, server-side in Supabase, where the service-role key
// is injected automatically as an environment variable and never exposed to any client.
//
// The desktop app calls this (with only the public anon key) instead of touching Supabase
// admin APIs directly. Mirrors the behavior of the old server/routes.ts register flow:
//   - bcrypt-hash the password once
//   - create the Auth user from that hash (so signInWithPassword works)
//   - insert the tenants row keyed to the Auth user's id (so RLS `auth.uid() = global_id`
//     resolves), with license inactive until the super-admin activates it
//
// Deploy: Supabase dashboard > Edge Functions > deploy this file as "register-tenant".
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import bcrypt from "https://esm.sh/bcryptjs@2.4.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!name || !email || !password) {
      return json({ error: "Missing name, email, or password" }, 400);
    }
    if (!email.includes("@")) {
      return json({ error: "Please enter a valid email address" }, 400);
    }
    if (password.length < 6) {
      return json({ error: "Password must be at least 6 characters" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Reject duplicates up front (case-insensitive) for a clean error message.
    const { data: existing } = await admin
      .from("tenants")
      .select("global_id")
      .ilike("email", email)
      .maybeSingle();
    if (existing) {
      return json({ error: "This email is already registered" }, 409);
    }

    // One bcrypt hash serves both the Auth credential (via password_hash import) and the
    // tenants.password column the desktop app uses for offline-fallback login.
    const hashedPassword = bcrypt.hashSync(password, 10);

    // Create the Auth user first, then key the tenant row to its id.
    const { data: created, error: authError } = await admin.auth.admin.createUser({
      email,
      password_hash: hashedPassword,
      email_confirm: true,
    });
    if (authError || !created?.user) {
      const msg = authError?.message || "";
      if (/already been registered|already exists|email_exists/i.test(msg)) {
        return json({ error: "This email is already registered" }, 409);
      }
      return json({ error: msg || "Failed to create account" }, 400);
    }

    const globalId = created.user.id;

    const { error: tenantError } = await admin.from("tenants").insert([{
      global_id: globalId,
      name,
      email,
      password: hashedPassword,
      local_license_type: "year", // null expiry keeps the license inactive until activated
    }]);

    if (tenantError) {
      // Roll back the Auth user so a retry starts from a clean slate.
      await admin.auth.admin.deleteUser(globalId).catch(() => {});
      return json({ error: tenantError.message }, 400);
    }

    return json({ success: true, global_id: globalId, name });
  } catch (e) {
    return json({ error: (e as Error)?.message || "Unexpected error" }, 500);
  }
});
