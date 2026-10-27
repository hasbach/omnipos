import { api } from './api';

export type OrderState = 'submitted' | 'confirmed' | 'ready' | 'completed' | 'rejected' | 'cancelled' | 'expired';
export type ShortfallReason = 'out_of_stock' | 'damaged' | 'customer_request' | 'other';

export const orderStates: OrderState[] = ['submitted', 'confirmed', 'ready', 'completed', 'rejected', 'cancelled', 'expired'];
export const shortfallReasons: ShortfallReason[] = ['out_of_stock', 'damaged', 'customer_request', 'other'];

export interface OrderRow {
  id: number;
  global_id: string;
  store: { id: number; name: string };
  number: string;
  state: OrderState;
  effective_state: OrderState;
  submitted_at: string;
  customer_name: string;
  customer_phone: string;
  fulfilment: 'pickup' | 'delivery';
  total_usd: number;
  total_local: number | null;
  confirmed_total_usd: number | null;
  local_currency: string | null;
  line_count: number;
}

export interface Order extends Omit<OrderRow, 'store' | 'line_count'> {
  reason: string | null;
  cancelled_by: string | null;
  address: string | null;
  note: string | null;
  local_rate: number | null;
  confirmed_total_local: number | null;
  expires_at: string;
  confirmed_at: string | null;
  ready_at: string | null;
  closed_at: string | null;
  sale_global_id: string | null;
}

export interface OrderLine {
  line_no: number;
  product_name: string;
  unit_name: string;
  unit_factor: number;
  ordered_qty: number;
  confirmed_qty: number | null;
  shortfall_reason: ShortfallReason | null;
  unit_price_usd: number;
  unit_price_local: number | null;
  line_total_usd: number;
  line_total_local: number | null;
  local_product: { id: number; name: string; stock: number; unit: string } | null;
}

export interface OrderDetail {
  order: Order;
  lines: OrderLine[];
  events: {
    at: string;
    kind: string;
    from_state: OrderState | null;
    to_state: OrderState | null;
    actor_kind: string;
    actor_name: string | null;
    terminal: string | null;
    reason: string | null;
    detail: unknown;
  }[];
  sale: { id: number; total_amount: number } | null;
  matched_customer: { id: number; name: string } | null;
  actions: Record<'accept' | 'reject' | 'ready' | 'cancel' | 'complete', boolean>;
  online: boolean;
  customer_wa_digits: string | null;
  store: { id: number; name: string; default_language: string; pickup_note: string | null };
}

export interface OrderSaleDraft {
  order_global_id: string;
  number: string;
  stakeholder_id: number;
  lines: { product_id: number; uom_id: number | null; quantity: number; unit_price: number }[];
  skipped: { line_no: number; product_name: string; reason: string }[];
  converted: { line_no: number; reason: string }[];
}

export interface ConfirmLine {
  line_no: number;
  confirmed_qty: number;
  reason?: ShortfallReason;
}

export interface BlockedPhone {
  phone: string;
  note: string | null;
  created_at: string;
}

export const ordersApi = {
  blockedPhones: (storeId: number) =>
    api.get<{ rows: BlockedPhone[] }>(`/api/commerce/stores/${storeId}/blocked-phones`),
  blockPhone: (storeId: number, phone: string, note?: string) =>
    api.post<{ phone: string }>(`/api/commerce/stores/${storeId}/blocked-phones`, { phone, note }),
  unblockPhone: (storeId: number, phone: string) =>
    api.del<{ ok: true }>(`/api/commerce/stores/${storeId}/blocked-phones/${encodeURIComponent(phone)}`),
  list: (query?: { state?: string; store?: string; from?: string; to?: string; q?: string }) =>
    api.get<{ rows: OrderRow[]; online: boolean; last_pull_at: string | null }>('/api/orders', query),
  summary: () => api.get<{ submitted: number; open: number }>('/api/orders/summary'),
  detail: (id: number) => api.get<OrderDetail>('/api/orders/' + id),
  getSaleDraft: (id: number) => api.get<OrderSaleDraft>('/api/orders/' + id + '/sale-draft'),
  accept: (id: number, expected_state: OrderState, lines: ConfirmLine[]) =>
    api.post<{ order: Order; lines: OrderLine[] }>('/api/orders/' + id + '/accept', { expected_state, lines }),
  action: (id: number, action: 'reject' | 'cancel' | 'ready', expected_state: OrderState, reason?: string) =>
    api.post<{ order: Order; lines: OrderLine[] }>('/api/orders/' + id + '/' + action, { expected_state, reason }),
};

export function orderBadge(state: OrderState) {
  return state === 'submitted' ? 'warning'
    : state === 'confirmed' ? 'info'
    : state === 'ready' || state === 'completed' ? 'success'
    : state === 'rejected' ? 'danger'
    : 'neutral';
}
