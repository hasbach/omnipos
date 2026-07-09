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
  balance: number;
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
    };
    electronSetup?: {
      scanNetwork: () => Promise<string[]>;
      saveConfig: (config: any) => Promise<any>;
      close: () => void;
    };
  }
}
