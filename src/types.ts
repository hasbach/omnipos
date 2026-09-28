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
  quantity: number;
  discount?: Discount;
}

export interface Payment {
  amount: number;
  method: 'cash' | 'card' | 'credit';
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
}

export interface TransactionItem {
  id?: number;
  transaction_id?: number;
  product_id: number;
  name?: string;
  quantity: number;
  unit_price: number;
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
  available_version: string;
  scheduled_update_at?: string;
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
    };
    electronSetup?: {
      scanNetwork: () => Promise<string[]>;
      saveConfig: (config: any) => Promise<any>;
      close: () => void;
    };
  }
}
