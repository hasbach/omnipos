# OmniPOS Constitution

## Core Principles

### I. Money & Balance Integrity (NON-NEGOTIABLE)

- Customer and supplier balances are **derived**, never stored as a running total:
  `balance = balance_baseline + Σ effect(ACTIVE transactions)` (`server/balance.ts`). Code MUST NOT
  write a balance directly except through the baseline/recompute helpers.
- Settlement MUST bank every affected stakeholder balance into `balance_baseline` **before** moving
  transactions to `archived_*` tables. Any new column on `transactions`, `transaction_items` or
  `payments` MUST be mirrored on the matching `archived_*` table and carried through settlement.
- Amounts are stored in USD (`total_amount`, `unit_price`, `unit_cost`). Products carry a single local
  price (`price_lbp`); `payments.amount` is in the payment's own currency and MUST be converted with
  the recorded rate, never a hardcoded one.
- Day boundaries are local time: `created_at` is UTC; day filters MUST compare
  `date(created_at, 'localtime')` and "today" MUST be the local date.
- Every invoice line snapshots its `unit_cost`; edits of settled invoices adjust the carried balance
  rather than rewriting history, and every edit records a reason and an audit entry.

Rationale: the v1.1.5 data-loss incident and v1.1.8 recovery came from violating these rules. Money
errors are silent, cumulative and destroy merchant trust.

### II. Tenant Isolation (NON-NEGOTIABLE)

- Every query, insert, update, delete, report and sync operation MUST be scoped by `tenant_id`.
- Id renumbering, data reset and settlement MUST touch only the acting tenant's rows.
- Cross-tenant references (e.g. `user_id`, `stakeholder_id`) MUST NOT leak into synced rows.
- New tables carry `tenant_id` and get a case in `tests/multi-tenant-isolation.test.ts` or an
  equivalent test.

Rationale: one installation serves several tenants and syncs to a shared cloud project.

### III. Offline-First, Cloud Best-Effort

- The local SQLite database (`better-sqlite3`, Electron ABI) is the source of truth; every POS and
  back-office flow MUST work with no internet.
- Supabase sync is best-effort and resilient per row: push strips columns the cloud lacks, pull
  updates only known columns, and a failed row MUST NOT block the rest.
- Schema changes are additive and idempotent in `server/db.ts`; the matching Supabase migration is
  written under `supabase/` and the app MUST keep working before it is applied.

Rationale: registers run in shops with unreliable connectivity; a sale must never wait on the cloud.

### IV. Server Is Authoritative

- Prices, totals, discounts, costs, stock and balances are computed and validated on the server;
  client-sent numbers are inputs to validate, never trusted results.
- Validation failures throw `ValidationError` (`server/errors.ts`) and return
  `{ error, code, field }`; the UI maps `code` via `translateServerError` and shows the message next
  to the offending field or line.
- Permissions are enforced server-side through `ROUTE_RULES` in `server/permissions.ts`; hiding a
  control in the UI is a convenience, not a guard. Every new route MUST have a rule. Secrets such as
  PINs MUST NOT be returned by any API.

Rationale: multiple terminals, the web monitor and the back office all hit the same API; only the
server sees the full state.

### V. Regression Suite Stays Green (NON-NEGOTIABLE)

- `npm test` (node:test via `scripts/run-tests.mjs`) MUST pass before any commit lands on `main`
  and before every release.
- Every new behaviour and every bug fix ships with a test in `tests/` that fails without the change.
- Money, balance, settlement, sync and permission changes require tests that exercise both live and
  settled (archived) data.

Rationale: the test suite is the only safety net for a system whose bugs surface weeks later in
balances.

### VI. Trilingual, RTL-Safe, Design-System UI

- Every user-visible string — UI, server error messages, enum labels, printed receipts — exists in
  English, Arabic and French (`src/intl/locales/*.ts`). No hardcoded display text.
- Layout uses logical (RTL-safe) classes; Arabic MUST render correctly on screen and on thermal
  printers.
- New UI is built from the existing component kit (`src/components/ui`) and the binding spec in
  `design-system/omnipos/MASTER.md`; no browser `alert`/`confirm`, use toasts and confirmation dialogs.
- Screens are dense, keyboard-friendly and touch-usable at POS.

Rationale: merchants work in Arabic, French and English, often on the same register.

### VII. Backward-Compatible by Default

- Every new setting's default reproduces existing behaviour; upgrading MUST NOT change how a
  running shop works until an admin opts in.
- Migrations MUST preserve all counts, totals, stock and balances; risky migrations are dry-run on a
  copy of a real database first.
- Prefer the simplest change that satisfies the spec; new abstractions require a stated reason.

Rationale: OmniPOS auto-updates on live registers; a surprise behaviour change costs real money.

## Security & Distribution Constraints

- The GitHub repository MUST stay public: `electron-updater` reads releases unauthenticated. No
  secrets, tokens, credentials or customer data are ever committed; secrets live in `.env` / local
  config only. New files are scanned for secrets before commit.
- Releases are built with `electron-builder` (Windows installer + portable), the version in
  `package.json` is bumped, and a matching `vX.Y.Z` git tag is pushed. Publishing is a deliberate,
  separate step from building.
- Native modules are built for the Electron ABI; do not run the server directly with `tsx` against
  them — use `npm test` and the documented scripts.
- Cloud tables are protected by Supabase RLS; Super Admin and licensing paths require explicit
  review.

## Development Workflow & Quality Gates

- Non-trivial work starts with a spec and plan (Spec Kit under `specs/`, or `docs/plans/` for
  earlier features) that names the hard constraints above it touches.
- Gates before merge: `npm test` green, `npx tsc --noEmit` with no new errors, `npm run build` and
  `npm run build:server` succeed; UI changes verified in the preview, including Arabic/RTL.
- Each release updates `ROADMAP.md` (Shipped section) in the same change; new ideas and follow-ups
  are added to its To do list.
- Work produced by other agents (Gemini, Codex, subagents) is reviewed by diff, build and tests
  before it is accepted.

## Governance

This constitution supersedes other practice documents; where a plan, spec or brief conflicts with
it, the constitution wins until amended. Specs and plans MUST include a constitution check and
justify any exception explicitly.

Amendments are made by editing this file through `/speckit-constitution`, with a Sync Impact Report,
and committed on their own. Versioning follows semantic versioning: MAJOR for removing or redefining
a principle, MINOR for a new principle or materially expanded guidance, PATCH for clarifications.
Reviews of any change touching money, tenants, sync or permissions MUST verify compliance with
Principles I–V.

**Version**: 1.0.0 | **Ratified**: 2026-10-04 | **Last Amended**: 2026-10-04
