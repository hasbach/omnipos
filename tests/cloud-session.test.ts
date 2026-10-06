// Production bug (2026-10-06): every register's cloud session died and sync silently stopped.
// Causes covered here: concurrent refreshes of the same (rotating) refresh token tripped GoTrue's
// reuse detection; the rotated token was never stored so a restart reused a dead one; and a dead
// token was retried forever with no visible signal. The Supabase auth client is mocked.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let session: typeof import("../server/session.js");
let anonSupabase: any;
let tenantA: number;
let tenantB: number;
const GID_A = "11111111-1111-1111-1111-111111111111";
const GID_B = "22222222-2222-2222-2222-222222222222";

interface FakeClient {
  refreshCalls: string[];
  setSessionCalls: number;
  listeners: Array<(event: string, session: any) => void>;
  auth: any;
  from: () => never;
}
let clients: FakeClient[] = [];
let refreshImpl: (token: string) => Promise<{ data: any; error: any }>;

function makeClient(): FakeClient {
  const c: FakeClient = {
    refreshCalls: [],
    setSessionCalls: 0,
    listeners: [],
    from: () => { throw new Error("offline in tests"); },
    auth: {
      setSession: async (tokens: any) => { c.setSessionCalls++; return { data: { session: { ...tokens } }, error: null }; },
      refreshSession: async ({ refresh_token }: any) => { c.refreshCalls.push(refresh_token); return refreshImpl(refresh_token); },
      signOut: async () => ({ error: null }),
      onAuthStateChange: (cb: any) => { c.listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
    },
  };
  clients.push(c);
  return c;
}
const totalRefreshCalls = () => clients.reduce((n, c) => n + c.refreshCalls.length, 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const okRefresh = (next: string) => async () => ({
  data: { session: { access_token: "acc-" + next, refresh_token: next } }, error: null,
});

before(async () => {
  app = await createTestApp();
  session = await import("../server/session.js");
  ({ anonSupabase } = await import("../server/supabase.js"));
  tenantA = seedTenant(app.db, "Business A", "a@example.com");
  tenantB = seedTenant(app.db, "Business B", "b@example.com");
  app.db.prepare("UPDATE tenants SET global_id = ? WHERE id = ?").run(GID_A, tenantA);
  app.db.prepare("UPDATE tenants SET global_id = ? WHERE id = ?").run(GID_B, tenantB);
});
after(async () => {
  session.__setClientFactory();
  await app.close();
});
beforeEach(() => {
  clients = [];
  session.__resetSessionStateForTests();
  session.forgetCloudSession(tenantA);
  session.forgetCloudSession(tenantB);
  session.__setClientFactory(() => makeClient() as any);
});

test("concurrent rehydrates share ONE refresh of the stored token", async () => {
  refreshImpl = async () => { await sleep(40); return okRefresh("t-next")(); };
  const results = await Promise.all(
    Array.from({ length: 10 }, () => session.rehydrateActiveSession(tenantA, GID_A, "a@example.com", "t-cookie"))
  );
  assert.deepEqual(new Set(results), new Set(["ok"]));
  assert.equal(totalRefreshCalls(), 1, "exactly one refreshSession call");
  assert.equal(session.getActiveSession()?.refreshToken, "t-next");
});

test("a rotated token is persisted and the next rehydrate uses it (not the stale cookie)", async () => {
  await session.setActiveSession(tenantA, GID_A, "a@example.com", { access_token: "acc1", refresh_token: "t1" });
  assert.equal(session.__peekPersistedRefreshToken(tenantA), "t1");

  // supabase-js auto-refreshes mid-shift and announces the rotation
  clients[0].listeners.forEach((cb) => cb("TOKEN_REFRESHED", { access_token: "acc2", refresh_token: "t2" }));
  assert.equal(session.getActiveSession()?.refreshToken, "t2");
  assert.equal(session.__peekPersistedRefreshToken(tenantA), "t2");

  // app restart: memory is gone, the cookie still holds the original t1
  session.__resetSessionStateForTests();
  refreshImpl = okRefresh("t3");
  const r = await session.rehydrateActiveSession(tenantA, GID_A, "a@example.com", "t1");
  assert.equal(r, "ok");
  assert.deepEqual(clients[1].refreshCalls, ["t2"], "refreshed with the latest persisted token");
  assert.equal(session.__peekPersistedRefreshToken(tenantA), "t3");
});

test("refresh_token_already_used => auth_expired, never retried, surfaced by /api/sync/status", async () => {
  refreshImpl = async () => ({
    data: { session: null },
    error: Object.assign(new Error("Invalid Refresh Token: Already Used"), { name: "AuthApiError", status: 400, code: "refresh_token_already_used" }),
  });
  // an unsynced local row must stay unsynced throughout
  app.db.prepare("INSERT INTO products (tenant_id, barcode, name, price, stock, category) VALUES (?, 'AUTH-1', 'Pending', 1, 1, 'general')").run(tenantA);

  assert.equal(await session.rehydrateActiveSession(tenantA, GID_A, "a@example.com", "dead"), "auth_expired");
  assert.equal(totalRefreshCalls(), 1);
  for (let i = 0; i < 3; i++) {
    assert.equal(await session.rehydrateActiveSession(tenantA, GID_A, "a@example.com", "dead"), "auth_expired");
  }
  assert.equal(totalRefreshCalls(), 1, "no further refresh attempts for a rejected token");

  const st = await app.api("GET", "/api/sync/status", { tenantId: tenantA });
  assert.equal(st.status, 200);
  assert.equal(st.body.state, "auth_expired");
  assert.equal(totalRefreshCalls(), 1, "status polling does not hammer auth");
  assert.ok(st.body.pendingCounts.products >= 1);
  assert.ok(!JSON.stringify(st.body).includes("dead"), "no token in the response");
  const row = app.db.prepare("SELECT last_synced_at FROM products WHERE barcode = 'AUTH-1'").get() as any;
  assert.equal(row.last_synced_at, null);
});

test("a network failure during refresh is retryable, not auth_expired", async () => {
  refreshImpl = async () => ({
    data: { session: null },
    error: Object.assign(new Error("fetch failed"), { name: "AuthRetryableFetchError", status: 0 }),
  });
  assert.equal(await session.rehydrateActiveSession(tenantA, GID_A, "a@example.com", "t-keep"), "network");
  assert.equal(session.isAuthExpired(tenantA), false);
  const st = await app.api("GET", "/api/sync/status", { tenantId: tenantA });
  assert.equal(st.body.state, "offline");
});

test("cloud-reconnect rejects another tenant's email/account and succeeds for the current tenant", async () => {
  const original = anonSupabase.auth.signInWithPassword;
  let signIns = 0;
  let nextUser: any = { id: GID_A, email: "a@example.com" };
  anonSupabase.auth.signInWithPassword = async () => {
    signIns++;
    return { data: { session: { access_token: "accN", refresh_token: "tN" }, user: nextUser }, error: null };
  };
  try {
    // dead session first
    refreshImpl = async () => ({ data: { session: null }, error: Object.assign(new Error("x"), { status: 400, code: "refresh_token_not_found" }) });
    await session.rehydrateActiveSession(tenantA, GID_A, "a@example.com", "dead");
    assert.equal(session.isAuthExpired(tenantA), true);

    // wrong email in the request: rejected before any sign-in
    let r = await app.api("POST", "/api/auth/cloud-reconnect", { tenantId: tenantA, body: { email: "b@example.com", password: "pw" } });
    assert.equal(r.status, 403);
    assert.equal(signIns, 0);

    // credentials of a different business: rejected, session not adopted
    nextUser = { id: GID_B, email: "b@example.com" };
    r = await app.api("POST", "/api/auth/cloud-reconnect", { tenantId: tenantA, body: { password: "pw" } });
    assert.equal(r.status, 403);
    assert.equal(session.getActiveSession(), null);

    // missing password
    r = await app.api("POST", "/api/auth/cloud-reconnect", { tenantId: tenantA, body: {} });
    assert.equal(r.status, 400);

    // current tenant: success
    nextUser = { id: GID_A, email: "a@example.com" };
    r = await app.api("POST", "/api/auth/cloud-reconnect", { tenantId: tenantA, body: { password: "pw" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(session.getActiveSession()?.localId, tenantA);
    assert.equal(session.isAuthExpired(tenantA), false);
    assert.equal(session.__peekPersistedRefreshToken(tenantA), "tN");
    assert.ok(!JSON.stringify(r.body).includes("tN"), "no token in the response");

    await sleep(50); // let the background resume settle before teardown
    const st = await app.api("GET", "/api/sync/status", { tenantId: tenantA });
    assert.notEqual(st.body.state, "auth_expired");
  } finally {
    anonSupabase.auth.signInWithPassword = original;
  }
});

test("logout clears the persisted cloud session", async () => {
  await session.setActiveSession(tenantA, GID_A, "a@example.com", { access_token: "acc", refresh_token: "tz" });
  assert.equal(session.__peekPersistedRefreshToken(tenantA), "tz");
  const r = await app.api("POST", "/api/auth/logout", { tenantId: tenantA });
  assert.equal(r.status, 200);
  assert.equal(session.__peekPersistedRefreshToken(tenantA), null);
});
