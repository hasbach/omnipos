import React from 'react';
import {
  Search, ShoppingCart, User, Banknote, Menu, Pencil, Plus,
  BarChart3, LayoutDashboard, Shield, Sun, Moon, Wallet
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Link } from 'react-router-dom';
import { usePosContext } from '../context/PosContext';
import { CURRENCIES } from '../hooks/usePos';
import { Badge, IconButton, Kbd } from './ui';
import { formatMoney } from '../lib/format';
import type { PriceLevel } from '../lib/pricing';

export default function PosHeader() {
  const pos = usePosContext();
  const {
    stakeholders, selectedStakeholder, setSelectedStakeholder,
    selectedStakeholderObj, creditLimit, availableCredit,
    customerSearchTerm, setCustomerSearchTerm, showCustomerDropdown, setShowCustomerDropdown,
    tenant, currentUser, setCurrentUser, handleLogout, setShowDailyHistory, setShowDebtModal,
    openAddCustomer, openEditCustomer, priceLevel, setPriceLevel, t, dir, isDarkMode, setIsDarkMode,
    customerDropdownRef, priceLevelsEnabled,
  } = pos as any;

  const [showHeaderMenu, setShowHeaderMenu] = React.useState(false);
  const headerMenuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(event.target as Node)) {
        setShowHeaderMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const priceLevels: { value: PriceLevel; label: string }[] = [
    { value: 'retail', label: t('pos_tier_retail', 'Retail') },
    { value: 'wholesale', label: t('pos_tier_wholesale', 'Wholesale') },
    { value: 'super_wholesale', label: t('pos_tier_super_wholesale', 'Super Wholesale') },
  ];

  const balance = selectedStakeholderObj?.balance ?? 0;

  return (
    <header className="border-b border-border px-4 py-2.5 flex justify-between items-center bg-surface gap-3">
      <div className="flex items-center gap-3 shrink-0">
        <div className="bg-primary text-on-primary p-2 rounded-lg">
          <ShoppingCart size={18} />
        </div>
        <h1 className="text-base font-bold text-text hidden sm:block">OmniPOS</h1>
      </div>

      <div className="flex items-center gap-2 flex-wrap justify-end">
        {/* Price level selector — changeable per sale, defaults from the selected customer.
            Hidden entirely when Settings → Sales & Pricing → enable_price_levels is off. */}
        {priceLevelsEnabled && (
          <div className="flex items-center gap-1 bg-surface-2 border border-border rounded-lg p-1" role="group" aria-label={t('pos_price_level', 'Price Level')}>
            {priceLevels.map(lvl => (
              <button
                key={lvl.value}
                onClick={() => setPriceLevel(lvl.value)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-all cursor-pointer min-h-[32px] ${
                  priceLevel === lvl.value ? 'bg-primary text-on-primary shadow-sm' : 'text-text-2 hover:text-text'
                }`}
                title={t('pos_price_level', 'Price Level')}
              >
                {lvl.label}
              </button>
            ))}
          </div>
        )}

        {/* Customer selector — stays directly on the header, it's a per-sale action the cashier
            needs constantly, unlike the menu's occasional-use items. */}
        <div className="flex items-center gap-1.5 relative" ref={customerDropdownRef}>
          <div className="relative">
            <button
              onClick={() => setShowCustomerDropdown(!showCustomerDropdown)}
              className="bg-bg border border-border px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2 hover:border-border-strong transition-all min-w-[160px] min-h-[36px] justify-between cursor-pointer text-text"
            >
              <span className="flex items-center gap-1.5 min-w-0">
                <User size={14} className="text-text-3 shrink-0" />
                <span className="truncate">{stakeholders.find((s: any) => s.id === selectedStakeholder)?.name || t('select_customer', 'Select Customer')}</span>
              </span>
              <Plus size={12} className={`shrink-0 transition-transform text-text-3 ${showCustomerDropdown ? 'rotate-45' : ''}`} />
            </button>

            <AnimatePresence>
              {showCustomerDropdown && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="absolute end-0 top-full mt-2 w-72 bg-surface border border-border shadow-[var(--shadow-modal)] rounded-xl overflow-hidden z-[60]"
                >
                  <div className="p-2 border-b border-border bg-surface-2">
                    <div className="relative">
                      <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 text-text-3" size={13} />
                      <input
                        autoFocus
                        type="text"
                        placeholder={t('search_customers', 'Search customers...')}
                        className="w-full ps-8 pe-2 py-2 bg-surface border border-border rounded-md text-xs outline-none focus:border-primary transition-all text-text"
                        value={customerSearchTerm}
                        onChange={(e) => setCustomerSearchTerm(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="max-h-72 overflow-y-auto">
                    <button
                      onClick={openAddCustomer}
                      className="w-full text-start px-4 py-3 text-xs font-bold uppercase tracking-wide bg-success-soft text-success hover:bg-success hover:text-white transition-all flex items-center gap-2 border-b border-border cursor-pointer"
                    >
                      <Plus size={14} /> {t('add_new_customer', 'Add New Customer')}
                    </button>
                    {stakeholders
                      .filter((s: any) => s.type === 'customer' && s.name.toLowerCase().includes(customerSearchTerm.toLowerCase()))
                      .map((s: any) => (
                        <div key={s.id} className={`group flex items-stretch hover:bg-primary hover:text-on-primary transition-colors ${selectedStakeholder === s.id ? 'bg-primary-soft' : ''}`}>
                          <button
                            onClick={() => {
                              setSelectedStakeholder(s.id);
                              setShowCustomerDropdown(false);
                              setCustomerSearchTerm('');
                            }}
                            className="flex-1 min-w-0 text-start ps-4 pe-2 py-2.5 text-xs font-semibold flex justify-between items-center gap-2 cursor-pointer"
                          >
                            <span className="min-w-0">
                              <span className="block truncate">{s.name}</span>
                              {s.address && <span className="block truncate text-[10px] font-medium opacity-70">{s.address}</span>}
                            </span>
                            {s.balance !== 0 && (
                              <span className={`text-[10px] flex-shrink-0 num ${s.balance < 0 ? 'text-danger' : 'text-success'}`}>
                                {formatMoney(Math.abs(s.balance), { code: 'USD', symbol: '$' })}
                              </span>
                            )}
                          </button>
                          {/* Walk-in is looked up by name server-side, so it isn't editable here. */}
                          {s.name !== 'Walk-in Customer' && (
                            <button
                              onClick={() => openEditCustomer(s)}
                              title={t('pos_edit_customer_title', 'Edit customer')}
                              className="px-3 opacity-40 hover:opacity-100 transition-opacity cursor-pointer"
                            >
                              <Pencil size={12} />
                            </button>
                          )}
                        </div>
                      ))}
                    {stakeholders.filter((s: any) => s.type === 'customer' && s.name.toLowerCase().includes(customerSearchTerm.toLowerCase())).length === 0 && (
                      <div className="p-4 text-center text-[10px] text-text-3 italic">{t('no_customers_found', 'No customers found')}</div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Credit limit badge for the selected customer */}
          {creditLimit > 0 && (
            <Badge variant={availableCredit != null && availableCredit < 0 ? 'danger' : 'info'} title={t('pos_available_credit', 'Available Credit')}>
              <Wallet size={11} /> {formatMoney(availableCredit || 0, { code: 'USD', symbol: '$' })}
            </Badge>
          )}

          {showCustomerDropdown === false && selectedStakeholder && balance < 0 && stakeholders.find((s: any) => s.id === selectedStakeholder)?.type === 'customer' && (
            <IconButton
              variant="success"
              size="md"
              aria-label={t('receive_payment', 'Receive Payment')}
              title={t('receive_payment', 'Receive Payment')}
              onClick={() => setShowDebtModal(true)}
            >
              <Banknote size={16} />
            </IconButton>
          )}
        </div>

        <IconButton
          aria-label={isDarkMode ? t('pos_switch_light_mode', 'Switch to light mode') : t('pos_switch_dark_mode', 'Switch to dark mode')}
          title={isDarkMode ? t('pos_switch_light_mode', 'Switch to light mode') : t('pos_switch_dark_mode', 'Switch to dark mode')}
          onClick={() => setIsDarkMode((v: boolean) => !v)}
        >
          {isDarkMode ? <Sun size={16} /> : <Moon size={16} />}
        </IconButton>

        <div className="relative" ref={headerMenuRef}>
          <button
            onClick={() => setShowHeaderMenu((v: boolean) => !v)}
            className="flex items-center gap-2 px-3 py-2 min-h-[36px] border border-border rounded-lg text-xs font-bold uppercase tracking-wide text-text hover:bg-surface-2 transition-all cursor-pointer"
          >
            <Menu size={16} /> <span className="hidden md:inline">{currentUser?.name || t('cashier', 'Cashier')}</span>
          </button>

          <AnimatePresence>
            {showHeaderMenu && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="absolute end-0 top-full mt-2 w-[380px] max-w-[92vw] bg-surface border border-border shadow-[var(--shadow-modal)] rounded-xl p-4 z-[70] flex flex-col gap-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-xs font-bold text-text">{tenant.name}</span>
                    <button
                      onClick={handleLogout}
                      className="text-[10px] font-mono uppercase text-text-3 hover:text-danger transition-colors text-start cursor-pointer"
                    >
                      {t('logout', 'Logout')}
                    </button>
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <Kbd>F1</Kbd><span className="text-text-3">{t('checkout_key', 'Checkout')}</span>
                    <Kbd>F2</Kbd><span className="text-text-3">{t('scan_key', 'Scan')}</span>
                    <Kbd>F3</Kbd><span className="text-text-3">{t('cash_key', 'Cash')}</span>
                  </div>
                </div>
                <div className="h-px bg-border" />

                {/* User Status & Lock */}
                <div className="flex items-center justify-between gap-2">
                  <div className="px-3 py-1.5 bg-surface-2 border border-border rounded-lg flex items-center gap-2">
                    <User size={14} className="text-text-3" />
                    <span className="text-[10px] font-bold uppercase tracking-wide text-text">{currentUser?.name || t('cashier', 'Cashier')}</span>
                  </div>
                  <IconButton
                    variant="danger"
                    aria-label={t('lock_terminal', 'Lock Terminal')}
                    title={t('lock_terminal', 'Lock Terminal')}
                    onClick={() => setCurrentUser(null)}
                  >
                    <Shield size={16} />
                  </IconButton>
                </div>

                <button
                  onClick={() => { setShowDailyHistory(true); setShowHeaderMenu(false); }}
                  className="flex items-center justify-center gap-2 px-3 py-2.5 min-h-[40px] border border-border rounded-lg text-xs font-bold uppercase tracking-wide text-text hover:bg-surface-2 transition-all cursor-pointer"
                >
                  <BarChart3 size={14} /> {t('history', 'History')}
                </button>
                <Link
                  to="/price-checker"
                  onClick={() => setShowHeaderMenu(false)}
                  className="flex items-center justify-center gap-2 px-3 py-2.5 min-h-[40px] border border-border rounded-lg text-xs font-bold uppercase tracking-wide text-text hover:bg-surface-2 transition-all"
                >
                  <Search size={14} /> {t('price_checker', 'Price Checker')}
                </Link>
                <Link
                  to={`/dashboard?cashierId=${currentUser?.id || ''}`}
                  target="_blank"
                  onClick={() => setShowHeaderMenu(false)}
                  className="flex items-center justify-center gap-2 px-3 py-2.5 min-h-[40px] bg-primary text-on-primary rounded-lg text-xs font-bold uppercase tracking-wide hover:bg-primary-hover transition-all"
                >
                  <LayoutDashboard size={14} /> {t('dashboard', 'Dashboard')}
                </Link>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </header>
  );
}
