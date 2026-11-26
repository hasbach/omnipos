import React, { useEffect, useState } from 'react';
import { Card, CardBody, CardHeader, Select, Skeleton } from '../../components/ui';
import { LineChart, type LineChartSeries } from '../../components/ui/charts/LineChart';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { formatMoney, formatPercent } from '../../lib/format';
import { builtinCategoryLabel, CATEGORIES, type Category } from '../cashflow/common';
import type { ProfitReport } from '../../../server/reports/profit';

type Report = ProfitReport & { categories: { key: string; name: string }[] };
type Period = ProfitReport['currentMonth'] | ProfitReport['daily'][number];

const usd = (amount: number) => formatMoney(amount, { code: 'USD', symbol: '$' });

function PeriodSummary({
  title,
  period,
  categoryLabels,
}: {
  title: string;
  period: Period;
  categoryLabels: Map<string, string>;
}) {
  const { t, lang } = useI18n();
  const rows = [
    { label: t('rep_pl_revenue', 'Revenue'), value: usd(period.revenue) },
    { label: t('rep_pl_cogs', 'Cost of goods sold'), value: usd(period.cogs) },
    { label: t('rep_pl_gross_profit', 'Gross profit'), value: usd(period.grossMargin) },
    { label: t('rep_profit_margin_pct', 'Gross margin %'), value: period.marginPct === null
      ? t('rep_profit_unavailable', 'Unavailable')
      : formatPercent(period.marginPct, { locale: lang }) },
    { label: t('rep_pl_expenses', 'Expenses'), value: usd(period.expenses) },
  ];

  return (
    <Card>
      <CardHeader>
        <h3 className="font-semibold">{title}</h3>
      </CardHeader>
      <CardBody>
        <dl className="space-y-2 text-sm">
          {rows.map(({ label, value }) => (
            <div key={label} className="flex justify-between gap-4">
              <dt>{label}</dt>
              <dd className="num">{value}</dd>
            </div>
          ))}
          {period.expenseCategories.map(({ category, amount }) => (
            <div key={category} className="flex justify-between gap-4 ps-4 text-text-2">
              <dt>
                {(CATEGORIES as readonly string[]).includes(category)
                  ? builtinCategoryLabel(category as Category, t)
                  : categoryLabels.get(category) ?? category}
              </dt>
              <dd className="num">{usd(amount)}</dd>
            </div>
          ))}
          <div className="flex justify-between gap-4 border-t border-border pt-2 font-semibold">
            <dt>{t('rep_pl_net_profit', 'Net profit')}</dt>
            <dd className={period.netProfit < 0 ? 'num text-danger' : 'num'}>{usd(period.netProfit)}</dd>
          </div>
          <div className="flex justify-between gap-4 text-text-2">
            <dt>{t('rep_profit_owner_draws', 'Owner draws')}</dt>
            <dd className="num">{usd(period.ownerDraws)}</dd>
          </div>
        </dl>
      </CardBody>
    </Card>
  );
}

export function ProfitTab() {
  const { t, lang } = useI18n();
  const [report, setReport] = useState<Report | null>(null);
  const [failed, setFailed] = useState(false);
  const [date, setDate] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.get<Report>('/api/reports/profit')
      .then((data) => {
        if (cancelled) return;
        setReport(data);
        setDate(data.daily[data.daily.length - 1].date);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  if (failed) return <p role="alert">{t('rep_profit_load_error', 'Could not load the profit report.')}</p>;
  if (!report) return <Skeleton className="h-64 rounded-[var(--radius-card)]" />;

  const { currentMonth, previousMonth, daily, dailySalesTarget } = report;
  const currentDays = daily.filter((day) => day.date.startsWith(currentMonth.month));
  const selectedDay = daily.find((day) => day.date === date);
  const categoryLabels = new Map(report.categories.map(({ key, name }) => [key, name]));
  const monthName = (month: string) => new Intl.DateTimeFormat(lang, {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(month + '-01T00:00:00Z'));
  const dayName = (day: string) => new Intl.DateTimeFormat(lang, {
    day: 'numeric', month: 'short', timeZone: 'UTC',
  }).format(new Date(day + 'T00:00:00Z'));
  const series: LineChartSeries[] = [{ name: t('rep_daily_sales', 'Sales'), data: currentDays.map((day) => day.revenue) }];
  if (dailySalesTarget !== null) {
    series.push({
      name: t('rep_profit_break_even', 'Break-even'),
      color: 'var(--color-warning)',
      data: currentDays.map(() => dailySalesTarget),
      reference: true,
    });
  }

  return (
    <div id="printable-report" className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <PeriodSummary
          title={monthName(currentMonth.month)}
          period={currentMonth}
          categoryLabels={categoryLabels}
        />
        <PeriodSummary
          title={monthName(previousMonth.month)}
          period={previousMonth}
          categoryLabels={categoryLabels}
        />
      </div>
      <Card>
        <CardHeader>
          <h3 className="font-semibold">{t('rep_profit_daily_sales', 'Daily sales this month')}</h3>
        </CardHeader>
        <CardBody>
          <p className="mb-3 text-sm font-medium">
            {dailySalesTarget === null
              ? t('rep_profit_no_target', 'A positive gross margin is needed to calculate the break-even target.')
              : t('rep_profit_target', 'You need {sales} in sales per day to cover your bills.')
                .replace('{sales}', usd(dailySalesTarget))}
          </p>
          <LineChart
            labels={currentDays.map((day) => dayName(day.date))}
            series={series}
            valueFormatter={usd}
          />
        </CardBody>
      </Card>
      <div className="flex items-center gap-3">
        <label htmlFor="profit-day" className="text-sm font-medium">{t('rep_profit_day', 'Profit by day')}</label>
        <Select
          id="profit-day"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          options={daily.slice().reverse().map((day) => ({ value: day.date, label: dayName(day.date) }))}
        />
      </div>
      {selectedDay && (
        <PeriodSummary
          title={dayName(selectedDay.date)}
          period={selectedDay}
          categoryLabels={categoryLabels}
        />
      )}
    </div>
  );
}
