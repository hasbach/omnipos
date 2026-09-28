import React, { useEffect, useMemo, useState } from 'react';
import { Printer } from 'lucide-react';
import { PageHeader, Toolbar, DateRangePicker, Tabs, Button } from '../components/ui';
import { useI18n } from '../intl/index';
import { api } from '../lib/api';
import { resolveDateRangePreset, type DateRange, type CurrencyLike } from '../lib/format';

import { OverviewTab } from './reports/OverviewTab';
import { ProductsTab } from './reports/ProductsTab';
import { CategoriesTab } from './reports/CategoriesTab';
import { CustomersTab, SuppliersTab, CashiersTab } from './reports/PartiesTabs';
import { PaymentsTab } from './reports/PaymentsTab';
import { InventoryTab } from './reports/InventoryTab';
import { AgingTab } from './reports/AgingTab';
import { CustomBuilderTab } from './reports/CustomBuilderTab';
import { CustomerStatementTab } from './reports/CustomerStatementTab';
import { DailyYearlyTab } from './reports/DailyYearlyTab';
import { printReport } from './reports/exportUtils';

interface CurrencyRow {
  id: number;
  code: string;
  symbol: string;
  rate: number;
  is_default: number;
}

type TabKey =
  | 'overview' | 'products' | 'categories' | 'customers' | 'suppliers' | 'cashiers'
  | 'payments' | 'inventory' | 'aging' | 'custom-builder' | 'statement' | 'daily-yearly';

export default function Reports() {
  const { t } = useI18n();
  const [tab, setTab] = useState<TabKey>('overview');
  const [range, setRange] = useState<DateRange>(() => resolveDateRangePreset('this_month'));
  const [businessName, setBusinessName] = useState('');
  const [localCurrency, setLocalCurrency] = useState<CurrencyLike | null>(null);
  const [statementStakeholderId, setStatementStakeholderId] = useState<string>('');

  useEffect(() => {
    api
      .get<{ store_name?: string }>('/api/settings')
      .then((s) => s?.store_name && setBusinessName(s.store_name))
      .catch(() => {});
    api
      .get<CurrencyRow[]>('/api/currencies')
      .then((rows) => {
        const nonUsd = rows.find((c) => c.code !== 'USD');
        if (nonUsd) setLocalCurrency({ code: nonUsd.code, symbol: nonUsd.symbol, rate: nonUsd.rate });
      })
      .catch(() => {});
  }, []);

  const tabItems = useMemo(
    () => [
      { value: 'overview', label: t('rep_tab_overview', 'Overview / P&L') },
      { value: 'products', label: t('rep_tab_products', 'Products') },
      { value: 'categories', label: t('rep_tab_categories', 'Categories') },
      { value: 'customers', label: t('rep_tab_customers', 'Customers') },
      { value: 'suppliers', label: t('rep_tab_suppliers', 'Suppliers') },
      { value: 'cashiers', label: t('rep_tab_cashiers', 'Cashiers') },
      { value: 'payments', label: t('rep_tab_payments', 'Payments') },
      { value: 'inventory', label: t('rep_tab_inventory', 'Inventory') },
      { value: 'aging', label: t('rep_tab_aging', 'Aging') },
      { value: 'custom-builder', label: t('rep_tab_custom_builder', 'Custom report builder') },
      { value: 'statement', label: t('rep_tab_customer_statement', 'Customer statement') },
      { value: 'daily-yearly', label: t('rep_tab_daily_yearly', 'Daily & yearly') },
    ],
    [t],
  );

  const openStatement = (stakeholderId: number) => {
    setStatementStakeholderId(String(stakeholderId));
    setTab('statement');
  };

  const tabProps = { range, localCurrency, businessName };

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('rep_page_title', 'Reports')}
        subtitle={t('rep_page_subtitle', 'Business intelligence and analytics for the selected period.')}
        actions={
          <Button variant="secondary" onClick={printReport}>
            <Printer size={15} /> {t('rep_print', 'Print')}
          </Button>
        }
      />

      <Toolbar>
        <DateRangePicker value={range} onChange={setRange} />
      </Toolbar>

      <Tabs items={tabItems} value={tab} onChange={(v) => setTab(v as TabKey)} className="overflow-x-auto" />

      <div className="pt-2">
        {tab === 'overview' && <OverviewTab {...tabProps} />}
        {tab === 'products' && <ProductsTab {...tabProps} />}
        {tab === 'categories' && <CategoriesTab {...tabProps} />}
        {tab === 'customers' && <CustomersTab {...tabProps} />}
        {tab === 'suppliers' && <SuppliersTab {...tabProps} />}
        {tab === 'cashiers' && <CashiersTab {...tabProps} />}
        {tab === 'payments' && <PaymentsTab {...tabProps} />}
        {tab === 'inventory' && <InventoryTab {...tabProps} />}
        {tab === 'aging' && <AgingTab {...tabProps} onOpenStatement={openStatement} />}
        {tab === 'custom-builder' && <CustomBuilderTab businessName={businessName} />}
        {tab === 'statement' && (
          <CustomerStatementTab
            businessName={businessName}
            selectedId={statementStakeholderId}
            onSelectedIdChange={setStatementStakeholderId}
          />
        )}
        {tab === 'daily-yearly' && <DailyYearlyTab businessName={businessName} />}
      </div>
    </div>
  );
}
