-- Supabase Database Schema for OmniPOS Synchronization
-- Run this in your Supabase SQL Editor

-- Disable RLS for now to ensure smooth initial sync (enable later for production security)
-- Alternatively, we can use the Service Role Key for backend sync and keep RLS on.

CREATE TABLE public.tenants (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id INTEGER,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    local_license_type TEXT DEFAULT 'year',
    local_license_expiry TIMESTAMP,
    online_license_type TEXT DEFAULT 'monthly',
    online_license_expiry TIMESTAMP,
    current_version TEXT DEFAULT '2.5.0',
    available_version TEXT DEFAULT '2.5.0',
    scheduled_update_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP
);

CREATE TABLE public.products (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id INTEGER,
    tenant_id UUID REFERENCES public.tenants(global_id),
    barcode TEXT,
    name TEXT NOT NULL,
    price NUMERIC NOT NULL,
    price_lbp NUMERIC,
    package_price NUMERIC,
    package_price_lbp NUMERIC,
    cost NUMERIC,
    cost_lbp NUMERIC,
    units_per_package INTEGER DEFAULT 1,
    stock INTEGER DEFAULT 0,
    reorder_point INTEGER DEFAULT 0,
    category TEXT,
    currency TEXT DEFAULT 'USD',
    unit TEXT DEFAULT 'pcs',
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP
);

CREATE TABLE public.product_barcodes (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id INTEGER,
    product_id UUID REFERENCES public.products(global_id),
    barcode TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP
);

CREATE TABLE public.stakeholders (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id INTEGER,
    tenant_id UUID REFERENCES public.tenants(global_id),
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    balance NUMERIC DEFAULT 0,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP
);

CREATE TABLE public.users (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id INTEGER,
    tenant_id UUID REFERENCES public.tenants(global_id),
    name TEXT NOT NULL,
    pin TEXT DEFAULT '0000',
    role TEXT DEFAULT 'staff',
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP
);

CREATE TABLE public.transactions (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id INTEGER,
    tenant_id UUID REFERENCES public.tenants(global_id),
    stakeholder_id UUID REFERENCES public.stakeholders(global_id),
    user_id UUID REFERENCES public.users(global_id),
    type TEXT DEFAULT 'sale',
    total_amount NUMERIC NOT NULL,
    currency TEXT NOT NULL,
    exchange_rate NUMERIC NOT NULL,
    discount_type TEXT,
    discount_value NUMERIC,
    tax_type TEXT,
    tax_value NUMERIC,
    status TEXT DEFAULT 'pending',
    terminal_id TEXT,
    terminal_sequence INTEGER,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP
);

CREATE TABLE public.transaction_items (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id INTEGER,
    transaction_id UUID REFERENCES public.transactions(global_id),
    product_id UUID REFERENCES public.products(global_id),
    quantity NUMERIC NOT NULL,
    unit_price NUMERIC NOT NULL,
    discount_type TEXT,
    discount_value NUMERIC,
    tax_type TEXT,
    tax_value NUMERIC,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP
);

CREATE TABLE public.payments (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id INTEGER,
    transaction_id UUID REFERENCES public.transactions(global_id),
    amount NUMERIC NOT NULL,
    method TEXT NOT NULL,
    currency TEXT NOT NULL,
    exchange_rate NUMERIC NOT NULL,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP
);

-- We won't map archived tables directly as they are local archival structures.
-- The cloud database has enough capacity to hold everything in the main tables.

CREATE TABLE public.currencies (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id INTEGER,
    tenant_id UUID REFERENCES public.tenants(global_id),
    code TEXT NOT NULL,
    symbol TEXT NOT NULL,
    rate NUMERIC NOT NULL,
    is_default INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP
);

CREATE TABLE public.settings (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES public.tenants(global_id),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP
);

CREATE TABLE public.cash_flow (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id INTEGER,
    tenant_id UUID REFERENCES public.tenants(global_id),
    user_id UUID REFERENCES public.users(global_id),
    type TEXT NOT NULL,
    amount NUMERIC NOT NULL,
    currency TEXT DEFAULT 'USD',
    exchange_rate NUMERIC DEFAULT 1,
    reason TEXT,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP
);

CREATE TABLE public.daily_reports (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id INTEGER,
    tenant_id UUID REFERENCES public.tenants(global_id),
    user_id UUID REFERENCES public.users(global_id),
    date TEXT NOT NULL,
    opening_balance NUMERIC DEFAULT 0,
    total_sales NUMERIC DEFAULT 0,
    total_purchases NUMERIC DEFAULT 0,
    total_cash_in NUMERIC DEFAULT 0,
    total_cash_out NUMERIC DEFAULT 0,
    closing_balance NUMERIC DEFAULT 0,
    actual_balance NUMERIC DEFAULT 0,
    difference NUMERIC DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP
);

CREATE TABLE public.cashier_shifts (
    global_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    local_id INTEGER,
    tenant_id UUID REFERENCES public.tenants(global_id),
    user_id UUID REFERENCES public.users(global_id),
    date TEXT NOT NULL,
    opening_balance NUMERIC DEFAULT 0,
    cash_sales NUMERIC DEFAULT 0,
    cash_refunds NUMERIC DEFAULT 0,
    cash_purchases NUMERIC DEFAULT 0,
    cash_in NUMERIC DEFAULT 0,
    cash_out NUMERIC DEFAULT 0,
    expected_cash NUMERIC DEFAULT 0,
    actual_cash NUMERIC DEFAULT 0,
    difference NUMERIC DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now(),
    deleted_at TIMESTAMP
);
