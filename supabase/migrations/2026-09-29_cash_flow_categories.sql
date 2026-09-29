-- OmniPOS cash-flow categories: which kind of cash movement a row is, and who it was with.
-- NOT applied automatically. Until this runs, the desktop sync strips the two new columns when pushing
-- cash_flow (cloudMissingColumns in server/sync.ts), so the category/counterparty stay local to each
-- register and nothing else breaks. Run it in the Supabase SQL editor.
--
-- category: top_up | loan_in | loan_repayment | owner_withdrawal | expense | supplier_payment |
--           customer_collection | other   (NULL reads as 'other'; validated by the desktop server, not a CHECK,
--           so adding a category later needs no migration)
-- counterparty: free text — who lent the money / who was paid.
ALTER TABLE public.cash_flow ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE public.cash_flow ADD COLUMN IF NOT EXISTS counterparty TEXT;

-- One-time backfill of the automatic rows, same rules as the desktop's startup backfill in server/db.ts.
UPDATE public.cash_flow SET category = 'customer_collection'
 WHERE category IS NULL AND type = 'in'
   AND (reason LIKE 'Balance collection from %' OR reason LIKE 'Payment on invoice #%');
UPDATE public.cash_flow SET category = 'supplier_payment'
 WHERE category IS NULL AND type = 'out'
   AND (reason LIKE 'Payment to supplier %' OR reason LIKE 'Payment on invoice #%');

-- LOCAL-ONLY (deliberately no cloud table): cash_flow_edits, the audit trail of admin edits to cash-flow
-- rows, and archived_cash_flow (settled rows), like transaction_edits / archived_* they are not synced.
