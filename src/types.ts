export interface Currency {
  id?: number;
  code: string;
  symbol: string;
  rate: number;
  is_default: number;
}

export interface Printer {
  id?: number;
  name: string;
  type: 'receipt' | 'kitchen' | 'bar';
  connection: 'usb' | 'network' | 'bluetooth';
  address: string; // IP for network, device path for USB/BT
  is_default: number; // 1 = default for that type
  paper_width: number; // mm: 58 or 80
  enabled: number; // 1 = active
}

export type PriceLevel = 'retail' | 'wholesale' | 'super_wholesale';

export interface ProductUnit {
  id: number;
  product_id?: number;
  name: string;
  factor: number; // base pieces in one unit (> 1)
  barcode?: string | null;
  price: number; // retail price of ONE unit, USD
  price_lbp?: number | null;
  price_wholesale?: number | null;
  price_wholesale_lbp?: number | null;
  price_super_wholesale?: number | null;
  price_super_wholesale_lbp?: number | null;
  sort_order?: number;
}

export interface Product {
  id: number;
  barcode: string;
  barcodes?: string[];
  name: string;
  price: number; // Unit Price USD
  price_lbp?: number; // Unit Price LBP
  package_price?: number; // Bulk Price USD
  package_price_lbp?: number; // Bulk Price LBP
  cost?: number; // Cost Price USD
  cost_lbp?: number; // Cost Price LBP
  units_per_package?: number;
  price_wholesale?: number; // Wholesale unit price USD (0/null = not set)
  price_wholesale_lbp?: number;
  price_super_wholesale?: number; // Super-wholesale unit price USD (0/null = not set)
  price_super_wholesale_lbp?: number;
  min_price?: number; // Optional floor price USD
  stock: number;
  reorder_point?: number;
  track_inventory?: number; // 1 = physical product (default), 0 = service/non-stock item
  category: string;
  currency: string;
  unit: string;
  units?: ProductUnit[]; // extra units of measure (packs, cartons...)
  active?: number; // 1 = active (default), 0 = disabled (can't be sold, hidden from the POS)
}

export interface Stakeholder {
  id: number;
  name: string;
  type: 'customer' | 'supplier';
  email?: string;
  phone?: string;
  address?: string;
  balance: number;
  price_level?: PriceLevel;
  credit_limit?: number; // NULL/0 = unlimited
}

export interface Discount {
  type: 'percentage' | 'fixed';
  value: number;
}

export interface CartItem extends Product {
  /** `${productId}:${uomId ?? 'base'}` - identifies the cart line. */
  line_key: string;
  /** Selected unit of measure (null/undefined = base piece). */
  uom_id?: number | null;
  uom_name?: string | null;
  uom_factor?: number | null;
  /** Quantity in the line's unit (pieces for base lines). */
  quantity: number;
  discount?: Discount;
}

export type PaymentMethod = 'cash' | 'card' | 'credit' | 'store_credit';

export interface Payment {
  amount: number;
  method: PaymentMethod;
  currency: string;
  exchange_rate: number;
}

export interface Transaction {
  id?: number;
  stakeholder_id: number;
  items: CartItem[];
  total_amount: number;
  currency: string;
  exchange_rate: number;
  payments: Payment[];
  discount?: Discount;
  created_at?: string;
  stakeholder_name?: string;
  price_level?: PriceLevel;
  notes?: string;
  reference?: string;
  edited_at?: string;
  edit_count?: number;
  archived?: boolean;
  /** The stakeholder's derived balance immediately before/after this transaction (null if none). */
  balance_before?: number | null;
  balance_after?: number | null;
  /** GET /api/transactions/:id only: current balance and this tx's effect on it. */
  stakeholder_balance?: number | null;
  balance_effect?: number | null;
}

/** Server error shape for POST/PUT /api/transactions and related endpoints. */
export interface ApiErrorBody {
  error: string;
  code?: string;
  field?: string;
  available?: number;
}

export interface TransactionItem {
  id?: number;
  transaction_id?: number;
  product_id: number;
  name?: string;
  quantity: number;
  unit_price: number;
  uom_id?: number | null;
  uom_name?: string | null;
  uom_factor?: number | null;
  uom_qty?: number | null;
  display_qty?: number;
  display_unit_price?: number;
  unit_cost?: number; // USD cost snapshot at time of the line (COGS)
  discount?: Discount;
}

export interface Tenant {
  id: number;
  name: string;
  email: string;
  local_license_type: 'year' | 'lifetime';
  local_license_expiry?: string;
  online_license_type: 'monthly' | 'lifetime';
  online_license_expiry?: string;
  current_version: string;
  global_id?: string;
  available_version: string;
  scheduled_update_at?: string;
}

export interface StoreConnection {
  id: string;
  name: string;
  url: string;
}

declare global {
  interface Window {
    electronAPI?: {
      // Window controls
      minimize: () => void;
      maximize: () => void;
      close: () => void;
      // Auto-updater
      checkForUpdates: () => Promise<any>;
      downloadUpdate: () => Promise<any>;
      installUpdate: () => void;
      onUpdateStatus: (callback: (data: {
        event: 'checking' | 'available' | 'not-available' | 'progress' | 'downloaded' | 'error';
        version?: string;
        releaseDate?: string;
        percent?: number;
        transferred?: number;
        total?: number;
        bytesPerSecond?: number;
        message?: string;
      }) => void) => (() => void);
      // Silent printing (no OS print dialog) — see electron-main.js's 'print:silent-html' handler.
      printSilent: (html: string) => Promise<{ success: boolean; error: string | null }>;
      // Second window for another store — see electron-main.js "STORE CONNECTIONS".
      connections?: {
        list: () => Promise<{ ok: boolean; connections?: StoreConnection[]; error?: string }>;
        add: (conn: { name: string; url: string }) => Promise<{ ok: boolean; connection?: StoreConnection; error?: string }>;
        remove: (id: string) => Promise<{ ok: boolean; error?: string }>;
        open: (id: string) => Promise<{ ok: boolean; error?: string }>;
        scan: () => Promise<{ ok: boolean; servers?: string[]; error?: string }>;
        resetConnectionMode: (labels?: { title?: string; message?: string; confirm?: string; cancel?: string }) => Promise<{ ok: boolean; cancelled?: boolean; error?: string }>;
      };
    };
    electronSetup?: {
      scanNetwork: () => Promise<string[]>;
      saveConfig: (config: any) => Promise<any>;
      close: () => void;
    };
  }
}

export const cartLineKey = (productId: number, uomId?: number | null): string => `${productId}:${uomId ?? 'base'}`;
