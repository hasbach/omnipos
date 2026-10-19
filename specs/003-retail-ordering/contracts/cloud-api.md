# Contract — Cloud migration `2026-10-21_retail_ordering_s1.sql` (Slice 1)

Not applied automatically: run in the Supabase SQL editor, then `supabase/checks/2026-10-21_retail_ordering_s1_checks.sql`.
Safe to re-run. Wrapped in `BEGIN; … COMMIT;` so the public functions are never missing between drop and create.

## `_store_public_settings(text) → jsonb` (internal)

Defaults become:

```json
{ "show_exact_stock": 0, "hide_out_of_stock": 0, "show_local_price": 1, "category_order": [],
  "ordering_mode": "off", "pickup_enabled": 1, "pickup_note": "", "delivery_enabled": 0, "delivery_note": "",
  "min_order_usd": null }
```

## `_store_orderable_keys(text) → text[]` (internal, IMMUTABLE)

Returns the array of string keys when the value is a JSON array whose elements are all strings; otherwise NULL (legacy
integer arrays, invalid JSON, empty array) meaning "no restriction".

## `store_public_get(p_slug text, p_preview text DEFAULT NULL)` — recreated

Same columns as 2026-10-19 plus, after `categories`/before `is_preview`:

| Column | Type | Source |
|---|---|---|
| `ordering_mode` | text | settings, only `off` / `whatsapp` / `online`, anything else → `off` |
| `pickup_enabled` | boolean | settings |
| `pickup_note` | text | settings, trimmed to 200 |
| `delivery_enabled` | boolean | settings |
| `delivery_note` | text | settings, trimmed to 200 |
| `min_order_usd` | numeric | settings, NULL when absent / ≤ 0 / not a number |

Gate (`_store_public_store`) unchanged: these values are only returned for public stores (or valid previews).

## `store_public_listings(...)` / `store_public_listing(...)` — recreated

Same arguments and columns plus `base_orderable boolean`. With keys = `_store_orderable_keys(orderable_unit_ids)`:

- keys NULL → `base_orderable = true`, `units` = every live unit (2026-10-19 behaviour);
- otherwise → `base_orderable = 'base' = ANY(keys)`, `units` = live units whose `global_id::text = ANY(keys)`.

Search, paging, ordering, stock and price fields are unchanged.

## Grants

`REVOKE ALL … FROM PUBLIC`; `GRANT EXECUTE` on the three public functions to `anon, authenticated`; internal helpers
revoked from `anon` and `authenticated` (same pattern as 2026-10-18 / 2026-10-19).

## Checks (PGlite in `tests/commerce-sql.test.ts` and the SQL checks file)

- Settings defaults: a store with `settings = '{}'` returns `ordering_mode = 'off'`, pickup on, delivery off.
- Unknown `ordering_mode` value → `off`.
- Orderable filter: `["base"]` → base only, no units; `["<u2>"]` → base not orderable, only u2; `[3,5]` → all units;
  deleted unit's key → not returned.
- Non-public store → no row (gate unchanged); preview token → row with ordering fields.
- anon can EXECUTE the three public functions and nothing else new; no anon table access.
