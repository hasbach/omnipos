-- OmniPOS public storefront (feature 002), part 2: photo storage. Run AFTER 2026-10-19_storefront.sql.
-- Safe to re-run. specs/002-tenant-online-store/contracts/cloud-api.md.
--
-- If the SQL editor refuses this file (e.g. "must be owner of table objects"), create the same thing in the
-- dashboard instead:
--   Storage → New bucket: name store-images, Public bucket ON, file size limit 2 MB, allowed MIME types image/webp.
--   Storage → Policies → store-images → New policy (for full customization), three times, role "authenticated":
--     INSERT  with check:  (storage.foldername(name))[1] = (auth.uid())::text
--     UPDATE  using + with check:  (storage.foldername(name))[1] = (auth.uid())::text
--     DELETE  using:  (storage.foldername(name))[1] = (auth.uid())::text
--   (Policy names: "store-images owner insert" / "... update" / "... delete" — the check script looks for them.)

-- ---- storage: product photos, store logo / cover --------------------------------------------------
-- Paths: <tenant global id>/l/<listing global id>/<random>.webp and <tenant gid>/s/<store gid>/(logo|cover)-<random>.webp.
-- Public read comes from the bucket being public; writes only inside the caller's own first folder.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('store-images', 'store-images', true, 2097152, ARRAY['image/webp'])
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = 2097152, allowed_mime_types = ARRAY['image/webp'];

DROP POLICY IF EXISTS "store-images owner insert" ON storage.objects;
CREATE POLICY "store-images owner insert" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'store-images' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "store-images owner update" ON storage.objects;
CREATE POLICY "store-images owner update" ON storage.objects
FOR UPDATE TO authenticated
USING (bucket_id = 'store-images' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'store-images' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "store-images owner delete" ON storage.objects;
CREATE POLICY "store-images owner delete" ON storage.objects
FOR DELETE TO authenticated
USING (bucket_id = 'store-images' AND (storage.foldername(name))[1] = auth.uid()::text);
