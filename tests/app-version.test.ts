// Settings -> Updates shows the running app's version (package.json), not the old "2.5.0" placeholder
// stored in tenants.current_version, and the legacy fake "update available" prompt is off.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { createTestApp, seedTenant } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
before(async () => { app = await createTestApp(); });
after(async () => { await app.close(); });

test("GET /api/auth/me reports the package.json version and no legacy available_version", async () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const { APP_VERSION } = await import("../server/appVersion.js");
  assert.equal(APP_VERSION, pkg.version);

  const tenantId = seedTenant(app.db, "Version Co", `version-${Date.now()}@example.com`);
  app.db.prepare("UPDATE tenants SET current_version = '2.5.0', available_version = '2.5.0' WHERE id = ?").run(tenantId);
  const me = await app.api("GET", "/api/auth/me", { tenantId });
  assert.equal(me.status, 200);
  assert.equal(me.body.current_version, pkg.version);
  assert.equal(me.body.available_version, null);
});
