# Quickstart — Validating Commerce Foundation Slice A

How to prove the slice works. Details of each rule live in [data-model.md](data-model.md) and the
[contracts](contracts/).

## Prerequisites

- Node ABI rebuilt for tests (`npm test` handles it; see memory "local run and test" — don't run `tsx server.ts`
  against the Electron-ABI native module).
- For the UI: preview server (`.claude/launch.json` → `omnipos-preview`, port 3100, seeded throwaway DB).
- For the cloud part: the user applies `supabase/migrations/2026-10-18_commerce_store_foundation.sql` in the
  Supabase SQL editor (the MCP connection is read-only).

## 1. Automated suite

```bash
npm test
```

Expected: all existing tests pass unchanged, plus the new ones:

| Test | Proves |
|---|---|
| `commerce-store.test.ts` | commerce off by default; store CRUD; slug format/reserved/offline errors (cloud claim stubbed); `STORE_NOT_READY`; status transitions; audit entries written |
| `commerce-listings.test.ts` | listing references the product (no copied price/stock); product price/unit change shows in the listing; disabled/deleted product ⇒ `visible=false` with reason; stock states; bulk publish all-or-nothing; no cost/min_price in any response |
| `multi-tenant-isolation.test.ts` (+cases) | tenant B cannot read/edit tenant A's store or listings; listing for another tenant's product rejected |
| `permissions.test.ts` (+cases) | admin has `store.*`; manager/accountant/staff/cashier defaults do **not**; every `/api/commerce/*` route has a rule |
| `tenant-reset.test.ts` (+cases) | product wipe removes the tenant's listings only; other tenant untouched |
| sync registration test | `stores`/`store_listings` in push/pull lists with correct fkMap; push skipped cleanly when the cloud table is missing |

## 2. Backward compatibility (US1, SC-001 slice)

1. Copy a real tenant DB and run the dry run on the copy (never the original):

   ```bash
   npm rebuild better-sqlite3
   ```
   ```bash
   npx tsx scripts/commerce-dryrun.ts "C:\path\to\copy-of-pos.db"
   ```
   ```bash
   npm run rebuild
   ```

   Expected: "OK: no differences in counts, stock, invoice totals, payments or balances." and no commerce rows
   created (`stores: 0, store_listings: 0, commerce_enabled: 0`). Exit code 1 on any difference.
2. Settings shows "Online store: off"; `stores` and `store_listings` are empty.

## 3. Back-office walk-through (preview server)

1. Settings → Online store: turn commerce on (admin). Create store "ABC Market", mode Retail.
2. Claim slug `abc-market` (online) → URL shown. Try `admin` → reserved error; go offline and retry → "needs
   internet" message; everything else still saves offline.
3. Products → bulk-select 20 → Publish. Open one product → Online store section shows the listing, edit title and
   category.
4. Change that product's price → listing preview shows the new price with no extra step.
5. Disable the product → listing shows "Unavailable: product disabled".
6. Switch UI to Arabic and French → every new string translated, layout RTL-correct.
7. Sign in as cashier (PIN 2222 in the preview seed) → Online store area hidden and `/api/commerce/*` writes return
   403.

## 4. Cloud checks (after the migration is applied and a register has pushed)

Run `supabase/checks/2026-10-18_commerce_store_checks.sql` in the SQL editor (read-only; each query lists its expected
result), then try one store:

```sql
select * from store_public_get('abc-market');
select title, price, stock_state, stock from store_public_listings('abc-market', null, null, 10, 0);
```

Expected: store row returned; listings with retail prices; `stock` null unless `show_exact_stock` is on.
Then verify each gate returns **no rows**: pause the store; set `commerce_enabled` to `'0'`; use a slug of a tenant
with an expired online license; disable a product (that listing disappears).
Allow-list check: the result column lists of both functions contain none of the "never returned" fields in
[public-catalog.md](contracts/public-catalog.md).
Anon check: with the anon key, `select * from products` and `select * from store_listings` return nothing (RLS),
while the two RPCs work.
