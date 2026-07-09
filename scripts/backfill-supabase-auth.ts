// One-time maintenance script: creates a Supabase Auth user for every existing tenant,
// keyed to that tenant's existing `global_id` and reusing its existing bcrypt password hash
// (no plaintext password needed, no user-facing password reset required).
//
// This is what makes Row Level Security (`auth.uid() = tenant_id`) work for tenants that
// registered before Supabase Auth was wired into the registration flow.
//
// Safe to re-run: skips tenants that already have a matching Supabase Auth user.
//
// Usage:
//   1. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env
//   2. npx tsx scripts/backfill-supabase-auth.ts

import { supabase } from "../server/supabase.js";

async function main() {
  const { data: tenants, error } = await supabase
    .from("tenants")
    .select("global_id, email, password, name");

  if (error) {
    console.error("Failed to fetch tenants from Supabase:", error.message);
    process.exit(1);
  }

  if (!tenants || tenants.length === 0) {
    console.log("No tenants found in Supabase — nothing to do.");
    return;
  }

  console.log(`Found ${tenants.length} tenant(s). Backfilling Supabase Auth users...\n`);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const tenant of tenants) {
    if (!tenant.global_id || !tenant.email || !tenant.password) {
      console.warn(`SKIP  ${tenant.email || "(no email)"} — missing global_id, email, or password`);
      skipped++;
      continue;
    }

    const { error: createError } = await supabase.auth.admin.createUser({
      id: tenant.global_id,
      email: tenant.email,
      password_hash: tenant.password,
      email_confirm: true,
    });

    if (!createError) {
      console.log(`OK    ${tenant.email} — Supabase Auth user created`);
      created++;
      continue;
    }

    const alreadyExists =
      createError.code === "email_exists" ||
      /already been registered|already exists/i.test(createError.message);

    if (alreadyExists) {
      console.log(`SKIP  ${tenant.email} — Supabase Auth user already exists`);
      skipped++;
    } else {
      console.error(`FAIL  ${tenant.email} — ${createError.message}`);
      failed++;
    }
  }

  console.log(`\nDone. Created: ${created}, Skipped: ${skipped}, Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main();
