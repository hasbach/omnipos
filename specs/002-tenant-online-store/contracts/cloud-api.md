# Contract — Cloud changes (`supabase/migrations/2026-10-19_storefront.sql` + `2026-10-19b_storefront_storage.sql`)

Applied by the user in the SQL editor after 001's migration; re-runnable. Checks:
`supabase/checks/2026-10-19_storefront_checks.sql`.

## Gate change

`_store_public_store(p_slug text, p_preview text DEFAULT NULL)` (internal, replaces the 1-arg version):

- Without a valid preview: store active, not deleted, **mode IN ('retail','hybrid')**, commerce_enabled = '1', license
  valid, tenant not deleted (001 rules + mode).
- With a valid preview token for that store (unexpired): status and mode not checked; commerce on, license valid and
  not deleted still required.

## Public functions (anon + authenticated; SECURITY DEFINER; PUBLIC revoked)

Old 001 signatures are dropped and recreated with the extra trailing parameter (no caller exists yet outside tests).

| Function | Change |
|---|---|
| `store_public_get(p_slug text, p_preview text DEFAULT NULL)` | + `is_preview boolean` column |
| `store_public_listings(p_slug, p_category, p_search, p_limit, p_offset, p_preview text DEFAULT NULL)` | + preview |
| `store_public_listing(p_slug text, p_listing uuid, p_preview text DEFAULT NULL)` | **new**: one visible listing (same columns as `store_public_listings` minus `total_count`), honours `hide_out_of_stock` and `show_exact_stock` |

## Owner functions (authenticated only)

| Function | Contract |
|---|---|
| `create_store_preview_token(p_store uuid) → TABLE(token text, expires_at timestamptz)` | caller must own the store (`stores.tenant_id = auth.uid()`), else no row; token 32 random bytes base64url; valid 30 min; deletes the caller's expired tokens |
| `claim_store_slug(p_store uuid, p_slug text)` | unchanged behaviour; reserved list extended to FR-004 (`www, api, app, admin, mail, email, smtp, ftp, monitor, status, help, support, docs, blog, shop, store, stores, cdn, static, assets, media, img, images, login, signup, account, dashboard, omnipos, test, demo`) |

## Table

`store_preview_tokens` — see [data-model.md](../data-model.md); RLS on, no policies.

## Storage

- Bucket `store-images`: `public = true`, `file_size_limit = 2097152`, `allowed_mime_types = {image/webp}`.
- Policies on `storage.objects` for `bucket_id = 'store-images'`, role `authenticated`:
  - INSERT `WITH CHECK ((storage.foldername(name))[1] = auth.uid()::text)`
  - UPDATE / DELETE `USING ((storage.foldername(name))[1] = auth.uid()::text)`
  - No anon write policy. Public read comes from the bucket being public (served at
    `/storage/v1/object/public/store-images/<path>`).

## Never returned

Unchanged from 001 ([../../001-commerce-domain-foundation/contracts/public-catalog.md](../../001-commerce-domain-foundation/contracts/public-catalog.md)).
