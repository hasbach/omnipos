// Online-store photos of one product (spec 002 US5): up to 4, first = main photo. Adding resizes in the
// browser to WebP (src/lib/imageResize.ts) and uploads; reordering works offline; removing needs internet.
import React, { useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ImagePlus, Star, Trash2 } from 'lucide-react';
import { IconButton, useConfirm, useToast } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { commerceApi, photoUrl, type CommerceStatus, type ListingView } from '../../lib/commerceApi';
import { ImageError, PHOTO_ACCEPT, resizeToWebp } from '../../lib/imageResize';
import { translateServerError } from '../../lib/serverErrors';

export const MAX_PHOTOS = 4;

export function ListingPhotos({ status, productId, listing, editable, onChange }: {
  status: CommerceStatus;
  productId: number;
  listing: ListingView | null;
  editable: boolean;
  onChange: (l: ListingView) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const images = listing?.images || [];
  const storeId = status.store!.id;

  const fail = (err: any) => {
    if (err instanceof ImageError) toast.error(t(`commerce_photo_err_${err.code.toLowerCase()}`));
    else toast.error(translateServerError(err, t) || err?.message || String(err));
  };

  const run = async (fn: () => Promise<ListingView>) => {
    setBusy(true);
    try { onChange(await fn()); } catch (err: any) { fail(err); } finally { setBusy(false); }
  };

  const add = async (files: FileList | null) => {
    const list = Array.from(files || []).slice(0, MAX_PHOTOS - images.length);
    if (input.current) input.current.value = '';
    for (const file of list) {
      setBusy(true);
      try {
        const webp = await resizeToWebp(file);
        onChange(await commerceApi.addPhoto(storeId, productId, webp));
      } catch (err: any) {
        fail(err);
        break;
      } finally {
        setBusy(false);
      }
    }
  };

  const reorder = (next: string[]) => run(() => commerceApi.setPhotos(storeId, productId, next));
  const move = (i: number, delta: number) => {
    const next = [...images];
    const j = i + delta;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    reorder(next);
  };
  const remove = async (i: number) => {
    const ok = await confirm({ title: t('commerce_photo_remove_title'), description: t('commerce_photo_remove_desc'), confirmLabel: t('commerce_photo_remove'), variant: 'danger' });
    if (ok) reorder(images.filter((_, n) => n !== i));
  };

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium text-text">{t('commerce_photos')}</h4>
        <span className="text-xs text-text-3">{t('commerce_photos_count').replace('{count}', String(images.length)).replace('{max}', String(MAX_PHOTOS))}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {images.map((path, i) => (
          <div key={path} className="group relative overflow-hidden rounded-[var(--radius-input)] border border-border bg-surface-2">
            <img src={photoUrl(status, path)} alt="" className="aspect-square w-full object-cover" loading="lazy" />
            {i === 0 && (
              <span className="absolute start-1 top-1 inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-white">
                <Star size={12} /> {t('commerce_photo_main')}
              </span>
            )}
            {editable && (
              <div className="absolute inset-x-1 bottom-1 flex justify-between gap-1 rounded-[var(--radius-input)] bg-surface/90 p-0.5">
                <IconButton size="sm" variant="ghost" aria-label={t('commerce_photo_earlier')} title={t('commerce_photo_earlier')} disabled={busy || i === 0} onClick={() => move(i, -1)}>
                  <ChevronLeft size={16} className="rtl:rotate-180" />
                </IconButton>
                {i > 0 && (
                  <IconButton size="sm" variant="ghost" aria-label={t('commerce_photo_make_main')} title={t('commerce_photo_make_main')} disabled={busy} onClick={() => reorder([path, ...images.filter((p) => p !== path)])}>
                    <Star size={16} />
                  </IconButton>
                )}
                <IconButton size="sm" variant="ghost" aria-label={t('commerce_photo_remove')} title={t('commerce_photo_remove')} disabled={busy} onClick={() => remove(i)}>
                  <Trash2 size={16} />
                </IconButton>
                <IconButton size="sm" variant="ghost" aria-label={t('commerce_photo_later')} title={t('commerce_photo_later')} disabled={busy || i === images.length - 1} onClick={() => move(i, 1)}>
                  <ChevronRight size={16} className="rtl:rotate-180" />
                </IconButton>
              </div>
            )}
          </div>
        ))}
        {editable && images.length < MAX_PHOTOS && (
          <button
            type="button"
            disabled={busy}
            onClick={() => input.current?.click()}
            className="flex aspect-square flex-col items-center justify-center gap-1 rounded-[var(--radius-input)] border border-dashed border-border text-sm text-text-2 transition-colors hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
          >
            <ImagePlus size={22} />
            <span>{busy ? t('commerce_photo_uploading') : t('commerce_photo_add')}</span>
          </button>
        )}
      </div>
      <input ref={input} type="file" accept={PHOTO_ACCEPT} multiple hidden onChange={(e) => add(e.target.files)} />
      <p className="mt-1 text-xs text-text-3">{t('commerce_photos_helper')}</p>
    </div>
  );
}

export default ListingPhotos;
