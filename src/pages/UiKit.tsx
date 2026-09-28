import React, { useState } from 'react';
import { Package, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../intl/index';
import {
  Badge,
  BarChart,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  DataTable,
  DateRangePicker,
  DonutChart,
  Drawer,
  EmptyState,
  Field,
  IconButton,
  Input,
  Kbd,
  LineChart,
  Modal,
  MoneyInput,
  NumberInput,
  PageHeader,
  Select,
  SkeletonTable,
  StatCard,
  Switch,
  Tabs,
  Textarea,
  Toolbar,
  useConfirm,
  useToast,
} from '../components/ui';
import { localToday } from '../lib/format';

interface Row {
  id: number;
  name: string;
  qty: number;
  price: number;
}

const ROWS: Row[] = [
  { id: 1, name: 'Coca-Cola 330ml', qty: 120, price: 0.75 },
  { id: 2, name: 'Pepsi 330ml', qty: 80, price: 0.7 },
  { id: 3, name: 'Water 1.5L', qty: 240, price: 0.5 },
  { id: 4, name: 'Chips Large', qty: 12, price: 1.5 },
];

export default function UiKit() {
  const { t, dir } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const [modalOpen, setModalOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tab, setTab] = useState('general');
  const [numberVal, setNumberVal] = useState<number | ''>(5);
  const [moneyVal, setMoneyVal] = useState<number | ''>(12.5);
  const [checked, setChecked] = useState(false);
  const [switchOn, setSwitchOn] = useState(true);
  const [range, setRange] = useState({ from: localToday(), to: localToday() });
  const [selected, setSelected] = useState<Set<string | number>>(new Set());

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('ui_kit_title', 'UI Kit')}
        subtitle={t('ui_kit_subtitle')}
        breadcrumbs={[{ label: 'OmniPOS' }, { label: 'UI Kit' }]}
        actions={<Badge variant="info">dir: {dir}</Badge>}
      />

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold">Buttons &amp; Badges</h2>
        </CardHeader>
        <CardBody className="flex flex-wrap items-center gap-2">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="success">Success</Button>
          <Button variant="primary" loading>
            Loading
          </Button>
          <IconButton aria-label="Add">
            <Plus size={16} />
          </IconButton>
          <Badge variant="neutral">Neutral</Badge>
          <Badge variant="primary">Primary</Badge>
          <Badge variant="success">Paid</Badge>
          <Badge variant="warning">Partial</Badge>
          <Badge variant="danger">Unpaid</Badge>
          <Badge variant="info">Settled</Badge>
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold">Form controls</h2>
        </CardHeader>
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Name" required>
            <Input placeholder="Product name" />
          </Field>
          <Field label="Quantity" helper="Select on focus">
            <NumberInput value={numberVal} onChange={setNumberVal} />
          </Field>
          <Field label="Price">
            <MoneyInput value={moneyVal} onChange={setMoneyVal} currencySymbol="$" />
          </Field>
          <Field label="Category">
            <Select
              placeholder="Choose…"
              options={[
                { value: 'drinks', label: 'Drinks' },
                { value: 'snacks', label: 'Snacks' },
              ]}
            />
          </Field>
          <Field label="Notes">
            <Textarea placeholder="Optional notes" />
          </Field>
          <Field label="Options">
            <div className="flex items-center gap-4">
              <Checkbox checked={checked} onChange={(e) => setChecked(e.target.checked)} label="Track inventory" />
              <Switch checked={switchOn} onChange={setSwitchOn} label="Active" />
            </div>
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold">StatCards</h2>
        </CardHeader>
        <CardBody className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Today's Sales" value="$1,284.50" delta={4.2} icon={Package} trend={[3, 5, 4, 7, 6, 8, 9]} />
          <StatCard label="Refunds" value="$42.00" delta={-2.1} icon={Package} />
          <StatCard label="Transactions" value="128" />
          <StatCard label="Low Stock" value="6" />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold">Charts</h2>
        </CardHeader>
        <CardBody className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <LineChart
            labels={['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']}
            series={[{ name: 'Sales', data: [120, 200, 150, 260, 180, 300, 250] }]}
          />
          <BarChart
            data={[
              { label: 'Drinks', value: 420 },
              { label: 'Snacks', value: 280 },
              { label: 'Dairy', value: 150 },
            ]}
          />
          <DonutChart
            data={[
              { label: 'Cash', value: 60, color: 'var(--color-success)' },
              { label: 'Card', value: 30, color: 'var(--color-primary)' },
              { label: 'Credit', value: 10, color: 'var(--color-accent)' },
            ]}
            centerLabel="Payments"
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold">Tabs, Toolbar, DateRangePicker</h2>
        </CardHeader>
        <CardBody className="space-y-4">
          <Tabs
            items={[
              { value: 'general', label: 'General' },
              { value: 'pricing', label: 'Pricing' },
              { value: 'inventory', label: 'Inventory' },
            ]}
            value={tab}
            onChange={setTab}
          />
          <Toolbar actions={<Button variant="primary">Add Product</Button>}>
            <DateRangePicker value={range} onChange={setRange} />
          </Toolbar>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold">DataTable</h2>
        </CardHeader>
        <CardBody>
          <DataTable<Row>
            columns={[
              { key: 'name', header: 'Name', sortable: true },
              { key: 'qty', header: 'Qty', sortable: true, align: 'end' },
              {
                key: 'price',
                header: 'Price',
                sortable: true,
                align: 'end',
                render: (r) => `$${r.price.toFixed(2)}`,
              },
            ]}
            data={ROWS}
            rowKey={(r) => r.id}
            searchable
            selectable
            selectedKeys={selected}
            onSelectedKeysChange={setSelected}
            bulkActions={(rows, clear) => (
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  toast.info(`Would delete ${rows.length} row(s)`);
                  clear();
                }}
              >
                <Trash2 size={14} /> Delete
              </Button>
            )}
            footerTotals={{ name: 'Total', qty: String(ROWS.reduce((s, r) => s + r.qty, 0)) }}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold">Skeleton &amp; EmptyState</h2>
        </CardHeader>
        <CardBody className="space-y-4">
          <SkeletonTable rows={3} cols={4} />
          <EmptyState icon={Package} title="No products yet" description="Add your first product to get started." />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold">Overlays: Modal, Drawer, Toast, Confirm</h2>
        </CardHeader>
        <CardBody className="flex flex-wrap gap-2">
          <Button onClick={() => setModalOpen(true)}>Open Modal</Button>
          <Button onClick={() => setDrawerOpen(true)}>Open Drawer</Button>
          <Button onClick={() => toast.success('Saved successfully')}>Success Toast</Button>
          <Button onClick={() => toast.error('Something went wrong')}>Error Toast</Button>
          <Button
            variant="danger"
            onClick={async () => {
              const ok = await confirm({
                title: 'Delete product?',
                description: 'This cannot be undone.',
                confirmText: 'DELETE',
              });
              if (ok) toast.success('Deleted');
            }}
          >
            Confirm Dialog
          </Button>
        </CardBody>
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Example Modal" footer={<Button onClick={() => setModalOpen(false)}>Close</Button>}>
        <p className="text-sm text-text-2">This is a modal body. Esc closes it, focus is trapped inside.</p>
      </Modal>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Example Drawer">
        <p className="text-sm text-text-2">Drawers open from the end side (right in LTR, left in RTL).</p>
      </Drawer>
    </div>
  );
}
