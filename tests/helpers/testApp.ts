// Shared harness for the regression suite. Boots the REAL server/routes.ts against a fresh,
// throwaway SQLite database (a temp directory per test file) — no mocking of the database layer,
// so these tests exercise the actual SQL these bugs lived in.
//
// Auth is short-circuited with a test-only header (x-test-tenant-id) read by a middleware defined
// ONLY here, never in production code — the real login flow talks to Supabase, which these tests
// have no business depending on. Everything downstream of "the session already has a tenantId"
// (every route in server/routes.ts) runs completely unmodified.
import express from "express";
import session from "express-session";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import bcrypt from "bcryptjs";

export interface TestApp {
  baseUrl: string;
  db: any;
  close: () => Promise<void>;
  /** GET/POST/etc. helper — pass tenantId to act as that tenant, or omit for an unauthenticated call. */
  api: (method: string, url: string, opts?: { tenantId?: number; body?: any }) => Promise<{ status: number; body: any }>;
}

export async function createTestApp(): Promise<TestApp> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnipos-test-"));
  const prevCwd = process.cwd();
  process.chdir(tmpDir);

  // server/db.ts resolves its (relative) db path against process.cwd() at import time when
  // neither NODE_ENV=production nor ELECTRON_RUN_AS_NODE is set — that's the lever used here to
  // give each test file its own isolated pos.db, without touching the real one or db.ts itself.
  let db: any, setupRoutes: any;
  try {
    ({ db } = await import("../../server/db.js"));
    ({ setupRoutes } = await import("../../server/routes.js"));
  } finally {
    process.chdir(prevCwd);
  }

  const app = express();
  app.use(express.json());
  app.use(session({ secret: "test-secret", resave: false, saveUninitialized: false }));
  app.use((req: any, _res, next) => {
    const tenantId = req.header("x-test-tenant-id");
    if (tenantId) req.session.tenantId = Number(tenantId);
    next();
  });
  const authenticate = (req: any, res: any, next: any) =>
    req.session.tenantId ? next() : res.status(401).json({ error: "Unauthorized" });
  const wss = { clients: [] as any[] };
  const broadcast = () => {};
  setupRoutes(app, wss, broadcast, authenticate);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const api = async (method: string, url: string, opts: { tenantId?: number; body?: any } = {}) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.tenantId) headers["x-test-tenant-id"] = String(opts.tenantId);
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
  };

  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { db.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  };

  return { baseUrl, db, close, api };
}

/** Seeds a fresh tenant (business) with the minimum a POS needs, mirroring establishLogin's
 * first-time seed in server/routes.ts. Returns the new tenant's id. */
export function seedTenant(db: any, name: string, email: string): number {
  const password = bcrypt.hashSync("test-password", 4); // low cost factor — tests don't need real security
  const result = db.prepare("INSERT INTO tenants (name, email, password) VALUES (?, ?, ?)").run(name, email, password);
  const tenantId = Number(result.lastInsertRowid);
  db.prepare("INSERT INTO users (tenant_id, name, role) VALUES (?, 'Admin', 'admin')").run(tenantId);
  db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Walk-in Customer', 'customer')").run(tenantId);
  db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate, is_default) VALUES (?, 'USD', '$', 1, 1)").run(tenantId);
  return tenantId;
}

export function seedProduct(db: any, tenantId: number, opts: { barcode: string; name: string; price: number; stock?: number }): number {
  const result = db.prepare(
    "INSERT INTO products (tenant_id, barcode, name, price, stock, category) VALUES (?, ?, ?, ?, ?, 'general')"
  ).run(tenantId, opts.barcode, opts.name, opts.price, opts.stock ?? 100);
  return Number(result.lastInsertRowid);
}
