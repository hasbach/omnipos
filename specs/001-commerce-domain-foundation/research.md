# Research — Commerce Foundation Slice A (Store & Listings)

Decisions taken for the plan in [plan.md](plan.md). Each entry: decision, rationale, alternatives considered.

## R1 — Where store and listing data is authored and owned

- **Decision**: Authored in the desktop back office, stored in local SQLite (`stores`, `store_listings`), pushed to
  the cloud by the existing sync engine (same path as `products` / `product_units`). The cloud copy is what the public
  storefront reads.
- **Rationale**: These records belong to one tenant only (not shared between two businesses like orders will be), so
  Constitution III (local is the source of truth) applies unchanged. Products, units and settings already reach the
  cloud this way, so the public functions can join them there without new plumbing.
- **Alternatives**: (a) Cloud-only authoring from the web — rejected: the back office is the desktop app and must work
  offline. (b) A separate "publish snapshot" job that copies products into a store table — rejected: FR-011/FR-012
  forbid duplicating product data, and copies go stale.

## R2 — Commerce on/off flag

- **Decision**: Tenant setting `commerce_enabled` (`'0'` default, `'1'` when an admin turns it on), stored in the
  existing `settings` table, which already syncs to the cloud.
- **Rationale**: Settings are per-tenant, synced, and every new setting already follows "default reproduces today"
  (Constitution VII). The public functions read the cloud copy of this row.
- **Alternatives**: A column on `tenants` — rejected: the desktop only pulls `tenants` (Super Admin owns it), so a
  tenant could not turn commerce on itself.

## R3 — Globally unique slug while staying offline-first

- **Decision**: The slug is unique across all tenants and enforced in the cloud by a partial unique index on
  `stores(lower(slug)) WHERE deleted_at IS NULL`. Claiming or changing a slug goes through a cloud RPC
  `claim_store_slug(store_global_id, slug)` (authenticated, owner only) **before** the local row is updated. Offline,
  the action fails with `STORE_SLUG_NEEDS_ONLINE`; every other store/listing action works offline. Local validation
  (format, reserved words) runs first, so most errors are caught without a network call.
- **Rationale**: A global namespace cannot be checked offline. Isolating this one action keeps everything else
  offline-first. Doing the claim first means two shops can never both believe they own the same slug.
- **Alternatives**: (a) Per-tenant slugs + tenant prefix in the URL (`/s/<tenant-id>/<slug>`) — rejected: ugly URLs,
  not what a shop expects. (b) Optimistic local save, conflict on push — rejected: the shop could print the URL on
  flyers before learning it was taken.
- **Slug rules**: 3–40 chars, `[a-z0-9-]`, no leading/trailing or double hyphen, stored lowercase, not in a reserved
  list (`admin`, `api`, `app`, `www`, `monitor`, `store`, `stores`, `omnipos`, `login`, `signup`, `help`, `support`,
  `static`, `assets`). Arabic names get a transliteration suggestion only in the UI; the slug itself is ASCII.

## R4 — How anonymous visitors read the catalog without exposing raw tables

- **Decision**: Two Postgres functions, `SECURITY DEFINER`, `STABLE`, `search_path = public`, granted `EXECUTE` to
  `anon` and `authenticated`:
  - `store_public_get(p_slug text)` → store identity, branding, settings and the category list.
  - `store_public_listings(p_slug text, p_category text, p_search text, p_limit int, p_offset int)` → one page of
    available listings with allow-listed fields.
  Both return nothing unless: the store exists, is not deleted, `status = 'active'`; the tenant's
  `commerce_enabled = '1'`; and the tenant's online license is valid (`online_license_type = 'lifetime'` or
  `online_license_expiry > now()`). No RLS policy for `anon` is added on any table.
- **Rationale**: Cloud `products` holds `cost`, `cost_lbp`, `min_price` and exact `stock`; an `anon` RLS policy on
  it would expose every column. A function returns only the columns we list, so FR-032 is enforced in one reviewed
  place. Supabase JS can call it with the anon key (`supabase.rpc(...)`), which the Live Monitor already ships.
- **Alternatives**: (a) A view with `security_invoker = false` + anon grant — workable, but harder to page, filter
  and license-check; functions are clearer. (b) A Vercel serverless API with the service-role key — adds a second
  backend and a secret to manage; keep as an option for Feature 002 caching (R7).

## R5 — Permissions

- **Decision**: New group `commerce` in `PERMISSION_GROUPS` with `store.view`, `store.manage`, `store.publish`.
  `admin` gets them through `ALL_PERMISSIONS`. **`manager`'s default is "all except …", so the three keys must be
  added to its exclusion list**; otherwise every manager would silently gain them (Constitution VII). `accountant`,
  `staff`, `cashier` defaults are explicit lists and are untouched. Mirror in `src/lib/permissions.ts`.
  Tenants with a stored `role_permissions` map are unaffected (keys absent ⇒ not granted); no version bump needed.
- **Mapping**: `store.view` — read store settings and listings; `store.manage` — commerce toggle, store identity,
  branding, settings, slug; `store.publish` — create/edit/publish/unpublish listings (incl. bulk). Turning commerce on
  needs `store.manage` **and** is admin-only by default because only admin has it.

## R6 — Availability and public price rules

- **Decision** (computed identically in `server/commerce.ts` for the back-office preview and in the cloud function):
  - A listing is **visible** when: listing `published = 1` and not deleted; product exists, not deleted,
    `active = 1`; store active; commerce on; license valid (cloud only).
  - **Stock state** (only when the product `track_inventory = 1`): `stock <= 0` ⇒ `out_of_stock`;
    `stock <= reorder_point` (and `reorder_point > 0`) ⇒ `low_stock`; else `in_stock`. `track_inventory = 0` ⇒
    `in_stock`. Out-of-stock listings are still returned (with the state) unless the store setting
    `hide_out_of_stock = 1`. Exact `stock` is returned only if store setting `show_exact_stock = 1`.
  - **Public price** = retail tier only: product `price` (USD) and `price_lbp` when set; for each unit of measure,
    `product_units.price` / `price_lbp`. Matches `tierUnitPrice(product,'retail')` and `uomUnitPrice(...,'retail')`
    in `server/pricing.ts`, which for retail are plain column reads, so the SQL mirror is trivial. A parity note is
    added next to those functions.
  - The store's local exchange rate (from the tenant's local `currencies` row) is returned with the store so the
    storefront can show local prices when `price_lbp` is empty.
- **Rationale**: Uses existing columns only; no price ever stored on a listing (FR-012).
- **Stock lag**: cloud stock is up to one hot-pull/push cycle behind the registers (≈ 60 s when online, longer when a
  register is offline). Slice A documents this; the storefront (002) labels availability as indicative, and ordering
  (003) must re-check at confirmation.

## R7 — Supabase egress and caching

- **Decision**: Slice A keeps responses small (allow-listed columns, page size ≤ 100, default 48) and adds the
  indexes the functions need. Caching is decided in Feature 002; preferred direction: the storefront is served from
  Vercel (where the Live Monitor already lives) and catalog responses are cached at the edge for 60 s per
  slug/page, so repeat visitors do not hit Supabase. Images are served from Supabase Storage with long cache headers
  or moved to a CDN in 002.
- **Rationale**: The project was already over the Free plan egress quota (memory, 2026-10-07). A public catalog
  without caching would make that worse.

## R8 — Store categories

- **Decision**: No new category table. A listing's category is `store_listings.store_category` when set, else the
  product's existing `category` text. `store_public_get` returns the distinct categories of visible listings with
  counts. Category order/visibility: optional `settings.category_order` (JSON array) on the store.
- **Rationale**: Products already use free-text `category`; a parallel table would need its own sync, UI and
  migration and isn't needed for a first storefront.
- **Alternatives**: `store_categories` table with images and nesting — deferred until a shop asks for it.

## R9 — Audit

- **Decision**: Reuse `logAction(tenantId, userId, action, details)` (`user_logs`, shown in User Logs). Actions:
  `commerce_toggle`, `store_create`, `store_update`, `store_slug_change`, `store_status_change`, `listing_publish`,
  `listing_unpublish`, `listing_update`, `listing_bulk_publish`. `details` is JSON `{ entity, id, before, after,
  reason? }` with only the changed fields.
- **Rationale**: FR-034's full audit model is for prices, quantities and money (Slice B). For store settings the
  existing log is sufficient and already permissioned (`logs.view`).

## R10 — Data reset, settlement, sync and migration safety

- **Decision**:
  - `tenantReset.ts`: when products are wiped, wipe `store_listings` of that tenant first (FK); `stores` survive a
    product wipe (the store stays, empty). Cloud deletes follow the existing reset path.
  - Settlement: no interaction (no transactional data).
  - Sync: add `stores` and `store_listings` to `PUSH_TABLES`, `PULL_TABLES` and `COLD_PULL_TABLES`
    (changes are rare; 5-min pull is enough for other registers). `fkMap`: `stores: { tenant_id }`,
    `store_listings: { tenant_id, store_id: 'stores', product_id: 'products' }`. Order: after `products` /
    `product_units`. Soft delete (`deleted_at`) like products' units, so deletes reach the cloud.
  - Before the cloud migration is applied, the sync engine already marks missing cloud tables and skips them
    (`noteMissingCloudTable`), so the app keeps working (Constitution III).
- **Rationale**: Mirrors how `product_units` and `cash_flow_categories` were added in 1.4.0 / 1.6.0.
