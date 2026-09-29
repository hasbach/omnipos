import React, { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Globe, Network } from 'lucide-react';
import { Card, CardBody, CardHeader, useToast } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';

// Where the hosted Live Monitor PWA is deployed (Vercel project "omnipos-monitor"; see vercel.json).
export const ONLINE_MONITOR_URL: string =
  (import.meta as any).env?.VITE_MONITOR_URL || 'https://omnipos-monitor.vercel.app';

interface NetworkInfo {
  port: number;
  addresses: { ip: string; url: string }[];
}

// navigator.clipboard only exists in a secure context; a client register loads the host over plain
// http://<lan-ip>, so fall back to a hidden textarea + execCommand there.
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function LinkRow({ url, label }: { url: string; label?: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    if (await copyText(url)) {
      setCopied(true);
      toast.success(t('fin_lm_link_copied', 'Link copied'));
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error(t('fin_lm_link_copy_failed', 'Could not copy — select the link and copy it manually.'));
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-[var(--radius-input)] border border-border bg-surface-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        {label && <span className="block text-[11px] font-medium uppercase tracking-[0.06em] text-text-3">{label}</span>}
        {/* LTR on purpose: a URL reads left-to-right even in the Arabic UI. */}
        <span dir="ltr" className="num block select-all truncate text-sm font-medium text-text">{url}</span>
      </div>
      <button
        type="button"
        onClick={onCopy}
        className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[var(--radius-input)] border border-border bg-surface px-2.5 text-xs font-semibold text-text-2 transition-colors hover:border-border-strong hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t('fin_lm_copy_link', 'Copy link')}
      >
        {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
        <span>{copied ? t('fin_lm_copied', 'Copied') : t('fin_lm_copy', 'Copy')}</span>
      </button>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-input)] border border-border bg-surface text-text-2 transition-colors hover:border-border-strong hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t('fin_lm_open_link', 'Open link')}
        title={t('fin_lm_open_link', 'Open link')}
      >
        <ExternalLink size={14} />
      </a>
    </div>
  );
}

/** The links an owner needs to reach this store again: the online monitor and this host on the LAN. */
export default function AccessLinksCard({ tenantEmail }: { tenantEmail?: string | null }) {
  const { t } = useI18n();
  const [net, setNet] = useState<NetworkInfo | null>(null);

  useEffect(() => {
    api.get<NetworkInfo>('/api/system/network-info').then(setNet).catch(() => setNet({ port: 3000, addresses: [] }));
  }, []);

  return (
    <Card>
      <CardHeader>
        <span className="text-sm font-semibold text-text">{t('fin_lm_links_title', 'Access links')}</span>
      </CardHeader>
      <CardBody className="grid gap-5 md:grid-cols-2">
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Globe size={16} className="text-primary" />
            <span className="text-sm font-semibold text-text">{t('fin_lm_online_link', 'Online monitor (anywhere)')}</span>
          </div>
          <p className="text-xs text-text-3">
            {t('fin_lm_online_link_help', 'Open it on your phone or any computer and sign in with your business account.')}
            {tenantEmail ? (
              <>
                {' '}
                {t('fin_lm_online_link_account', 'Account:')} <span dir="ltr" className="font-medium text-text-2">{tenantEmail}</span>
              </>
            ) : null}
          </p>
          <LinkRow url={ONLINE_MONITOR_URL} />
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Network size={16} className="text-primary" />
            <span className="text-sm font-semibold text-text">{t('fin_lm_lan_link', 'This register on your network')}</span>
          </div>
          <p className="text-xs text-text-3">
            {t('fin_lm_lan_link_help', 'Use it to connect another cashier (Client → enter this address) or to open the POS in a browser on the same Wi-Fi / network.')}
          </p>
          {net === null ? (
            <div className="h-12 animate-pulse rounded-[var(--radius-input)] bg-surface-2" />
          ) : net.addresses.length === 0 ? (
            <p className="rounded-[var(--radius-input)] border border-dashed border-border px-3 py-2 text-xs text-text-3">
              {t('fin_lm_lan_none', 'No network connection found on this computer.')}
            </p>
          ) : (
            net.addresses.map((a) => (
              <LinkRow
                key={a.ip}
                url={a.url}
                label={net.addresses.length > 1 ? t('fin_lm_lan_address', 'Address') : undefined}
              />
            ))
          )}
        </section>
      </CardBody>
    </Card>
  );
}
