import React, { useEffect, useState } from 'react';
import { Card, CardBody, Field, Select } from '../../components/ui';
import { useI18n } from '../../intl/index';
import { api } from '../../lib/api';
import { stakeholderTypeLabel, partyDisplayName } from '../../lib/format';
import type { StakeholderLite } from './types';
import { BalanceLogTable } from '../stakeholders/BalanceLogTable';
import { StatementView } from '../statement/StatementView';

export interface CustomerStatementTabProps {
  businessName: string;
  selectedId?: string;
  onSelectedIdChange?: (id: string) => void;
}

export function CustomerStatementTab({ selectedId, onSelectedIdChange }: CustomerStatementTabProps) {
  const { t } = useI18n();
  const [stakeholders, setStakeholders] = useState<StakeholderLite[]>([]);
  const [internalId, setInternalId] = useState('');

  const id = selectedId !== undefined ? selectedId : internalId;
  const setId = onSelectedIdChange || setInternalId;

  useEffect(() => {
    api.get<StakeholderLite[]>('/api/stakeholders').then(setStakeholders).catch(() => {});
  }, []);

  const party = stakeholders.find((s) => String(s.id) === id);

  return (
    <div className="space-y-4">
      <Card className="print:hidden">
        <CardBody>
          <Field label={t('rep_statement_select', 'Customer / supplier')} className="max-w-sm">
            <Select
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder={t('rep_statement_select_placeholder', 'Select a party…')}
              options={stakeholders.map((s) => ({ value: String(s.id), label: `${partyDisplayName(s.name, t)} (${stakeholderTypeLabel(s.type, t)})` }))}
            />
          </Field>
        </CardBody>
      </Card>

      {id && party && (
        <div className="space-y-4">
          <StatementView stakeholder={party} />
          <div className="pt-2">
            <p className="mb-2 text-sm font-semibold text-text">{t('bal_log_title', 'Balance history')}</p>
            <BalanceLogTable stakeholderId={id} />
          </div>
        </div>
      )}
    </div>
  );
}

export default CustomerStatementTab;
