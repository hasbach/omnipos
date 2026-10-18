# Validation — Commerce Foundation Slice A

Results of [quickstart.md](quickstart.md) for branch `001-commerce-domain-foundation` (phases 1–6). Recorded
2026-10-18 on the dev PC.

## 1. Automated suite and gates

| Gate | Result |
|---|---|
| `npm test` | 389 / 389 pass (new: commerce-compat, commerce-sync, commerce-store, commerce-listings; extended: permissions, multi-tenant-isolation, tenant-reset) |
| `npx tsc --noEmit` | 0 errors |
| `npm run build` / `npm run build:server` | both succeed |

## 2. Upgrade dry run (`scripts/commerce-dryrun.ts`, on copies only)

| Database copy | Size | Result |
|---|---|---|
| Installed app DB on the dev PC (`%APPDATA%/OmniPOS/pos.db`, never upgraded) | 5 parties, 0 sales | OK: no differences (31 values), no commerce rows created |
| Repo dev DB (`pos.db`, already had the new tables) | 6 products, 1,740 parties, 152 sales | OK: no differences (1,768 values incl. 1,740 balances), schema re-run is idempotent |

**Still to do before release:** run the dry run on a copy of a real customer database with settled days and
archived invoices. None is available on the dev PC (and logging into a customer tenant here is not allowed).

## 3. Back-office walk-through (preview server, seeded demo data)

| Step | Result |
|---|---|
| Turn commerce on (admin) with confirmation | OK |
| Create store | OK, status Draft |
| Save web address without a cloud session | Inline "needs an internet connection" error; nothing saved |
| Open the store | Not testable without the cloud migration (needs a claimed address) |
| Bulk publish 19 products; publish one from the product editor | OK |
| Product price change shows in the listing | OK (1.50 → 1.75, no listing edit) |
| Disable the product | Listing shows "Unavailable: product disabled" |
| Stock badge | Matches product stock / reorder point |
| Cashier (PIN user) | Online store section hidden; `/api/commerce/*` read and write return 403 |
| Arabic | RTL layout correct; DOM scan finds no untranslated text (only seeded names and the ASCII address example) |
| French | No English strings left (scan of the section's English phrases) |

## 4. Cloud functions

The migration and `supabase/checks/2026-10-18_commerce_store_checks.sql` were run on **PGlite** (Postgres in WASM)
against stub Supabase tables, with 41 behaviour checks, all passing: migration re-runnable; gates (paused store,
commerce off, expired license, unknown slug ⇒ nothing; lifetime license ⇒ visible); allow-list (no cost, tier
prices, ids, barcode or tenant data); retail prices and units; stock states, hide-out-of-stock and exact-stock
settings; category order; search as plain text; paging; privileges (anon may call only the two public functions;
helpers closed to API roles); every `claim_store_slug` outcome including the placeholder row and slug freeing.

**Still to do:** apply the migration to the live project in the Supabase SQL editor, run the check script there,
let a register push a store, then repeat the "Open the store" step and the two sample `store_public_*` queries.
