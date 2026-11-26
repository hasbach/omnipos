import React, { useEffect, useState } from 'react';
import { Button, Card, Field, NumberInput } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { usePermissions } from '../../lib/usePermissions';
import type { Product } from '../../types';
import { ProductEditorDrawer, type ProductEditorDrawerProps } from '../products/ProductEditorDrawer';

interface Idea {
  key: string;
  products: Array<{ id: number; name: string }>;
  supportCount: number;
  support: number;
  confidence: number;
  lift: number;
  combinedRegularPrice: number;
  combinedCost: number;
  suggestedPrice: number;
  slowFast: boolean;
  canCreate: boolean;
}

export function BundleIdeas({ products, onSaved }: { products: Product[]; onSaved: () => void }) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [minSupport, setMinSupport] = useState(3);
  const [target, setTarget] = useState(20);
  const [data, setData] = useState<{ basketCount: number; ideas: Idea[] } | null>(null);
  const [error, setError] = useState(false);
  const [draft, setDraft] = useState<ProductEditorDrawerProps['initialBundle']>();
  useEffect(() => {
    let active = true;
    setData(null);
    setError(false);
    api.get<{ basketCount: number; ideas: Idea[] }>(`/api/or/bundle-ideas?min_support=${minSupport}&target_percent=${target}`)
      .then((result) => { if (active) setData(result); })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [minSupport, target]);
  const money = (value: number) => `$${value.toFixed(2)}`;
  return (
    <div className="space-y-4">
      <p className="text-sm text-text-3">{t('bi_description')}</p>
      <div className="flex flex-wrap gap-4">
        <Field label={t('bi_min_support')}>
          <NumberInput
            value={minSupport}
            min={1}
            step={1}
            onChange={(value) => setMinSupport(Math.max(1, Math.round(value || 1)))}
          />
        </Field>
        <Field label={t('bi_target')}>
          <NumberInput
            value={target}
            min={0}
            max={1000}
            onChange={(value) => setTarget(Math.min(1000, Math.max(0, value || 0)))}
          />
        </Field>
      </div>
      {error && <p role="alert">{t('bi_error')}</p>}
      {!data && !error && <p>{t('bi_loading')}</p>}
      {data && <p className="text-sm">{t('bi_baskets')}: {data.basketCount}</p>}
      {data?.ideas.length === 0 && <p>{t('bi_empty')}</p>}
      {data?.ideas.map((idea) => (
        <Card
          key={idea.key}
          className="space-y-3 p-4"
        >
          <h3 className="font-semibold">{idea.products.map((p) => p.name).join(' + ')}</h3>
          <div className="flex flex-wrap gap-4 text-sm">
            <span>{t('bi_together')}: {idea.supportCount} ({(idea.support * 100).toFixed(1)}%)</span>
            <span>{t('bi_confidence')}: {(idea.confidence * 100).toFixed(1)}%</span>
            <span>{t('bi_lift')}: {idea.lift.toFixed(2)}</span>
            <span>{t('bi_regular')}: {money(idea.combinedRegularPrice)}</span>
            <span>{t('bi_suggested')}: {money(idea.suggestedPrice)}</span>
          </div>
          {idea.slowFast && <p className="text-sm text-text-3">{t('bi_slow_fast')}</p>}
          {!idea.canCreate && <p className="text-sm text-text-3">{t('bi_existing_bundle')}</p>}
          <Button
            disabled={!idea.canCreate || !can('products.edit') || !idea.products.every((p) => products.some((item) => item.id === p.id))}
            onClick={() => setDraft({
              name: idea.products.map((p) => p.name).join(' + '),
              price: idea.suggestedPrice,
              cost: idea.combinedCost,
              bundle_items: idea.products.map((p) => ({ component_id: p.id, quantity: 1 })),
            })}
          >
            {t('bi_create')}
          </Button>
        </Card>
      ))}
      <ProductEditorDrawer
        open={!!draft}
        product={null}
        initialBundle={draft}
        products={products}
        categories={[...new Set(products.map((p) => p.category).filter(Boolean))]}
        localCurrency={null}
        onClose={() => setDraft(undefined)}
        onSaved={onSaved}
      />
    </div>
  );
}
