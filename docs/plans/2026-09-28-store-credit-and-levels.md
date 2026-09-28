# Store credit, balance display, optional price levels, inline editor errors

## 1. New payment method `store_credit` ("From account balance" / "من الرصيد" / "Depuis le solde")
A stakeholder with a POSITIVE balance (store credit for a customer — e.g. a refund left on account; a credit we
hold with a supplier) can use it to pay a sale (customer) or a purchase (supplier).

Semantics — two different notions of "paid", keep them straight:
- **Balance math** (server/balance.ts `unpaidNonCredit`, settlement banking via `stakeholderTxEffect`, archived
  effect in server/invoiceEdit.ts, credit-limit prospective balance): `store_credit` is NOT money, exactly like
  `credit`. So an invoice paid with store credit stays "unpaid" in balance math and its effect
  `-(total − realPaid)` consumes the positive balance. (That is what makes the credit get used up.)
- **Invoice settlement status** ("paid_amount" shown on invoices, lists, purchases list/detail, unpaid-sales /
  unpaid-purchases, custom-builder paid/status filters, aging per-invoice unpaid, refundable `paid_amount`,
  by-customer/by-supplier `paid`): `store_credit` COUNTS as paid (the invoice is settled). `credit` still doesn't.
- **Real money** (cash register — only `cash` anyway; reports summary `collected`; by-payment-method keeps it as
  its own row): `store_credit` is not collected money.
Helper constants in a new `server/paymentMethods.ts`:
`PAYMENT_METHODS = ['cash','card','credit','store_credit']`,
SQL fragments `REAL_MONEY_SQL = "method NOT IN ('credit','store_credit')"`,
`SETTLED_SQL = "method != 'credit'"`, and JS predicates `isRealMoney(m)`, `settlesInvoice(m)`.

Validation (POST /api/transactions and PUT /api/transactions/:id):
- method must be one of PAYMENT_METHODS (POST currently doesn't validate — add it).
- `store_credit` only for type sale/purchase, never refund; stakeholder must not be the tenant's Walk-in customer
  (name 'Walk-in Customer') → 400 `{error, code:'STORE_CREDIT_WALKIN'}`.
- Σ store_credit (USD, amount/exchange_rate) on the invoice ≤ available credit → else 400
  `{error, code:'STORE_CREDIT_EXCEEDED', available}`. Available = max(0, balance the stakeholder would have
  WITHOUT this invoice): POST → current balance; PUT → current balance − (this invoice's current effect) for a
  live invoice; for an archived invoice → current balance − (its effect computed from archived payments). If the
  PUT keeps an existing store_credit payment by id, it counts toward the Σ as well (it's being re-used).
- Errors from validation carry a `field` hint where it helps the UI: `field: 'payments'`, `'stakeholder_id'`,
  or `'items.<index>.unit_price'` / `'items.<index>.quantity'` (index = position in the request `items` array).
  Apply this to existing validations too: min price (`items.i.unit_price`), invalid qty/price (`items.i...`),
  refunded-qty guard in PUT (`items.i.quantity`), credit limit (`stakeholder_id`, keep `code:'CREDIT_LIMIT'`),
  payment validation (`payments`, or `payments.<index>`). Shape: `{ error, code?, field? }`. Keep status codes.

## 2. Balance before / after on every sale
- POST /api/transactions response adds `balance_before` and `balance_after` (the stakeholder's derived balance
  before and after the transaction; null for none). Same for PUT (before = before the edit).
- GET /api/transactions/:id adds `stakeholder_balance` (current) and `balance_effect` (this tx's effect on the
  balance: sale/purchase −(total − realPaid), refund +(total − realPaid)).
- Receipt (server/printing/receipt.ts via /api/print/receipt): for a non-Walk-in customer print
  "Previous balance / This invoice / New balance" lines (with the existing Arabic handling). Previous = balance
  now − this tx's effect (for the latest tx that equals the balance before it). Label balances human-readably:
  negative = "Due"/"مستحق", positive = "Credit"/"رصيد دائن". Keep the receipt byte tests passing; add a test.
- POS silent HTML receipt (built client-side in src/hooks/usePos.ts) prints the same three lines.

## 3. Optional price levels
- Setting `enable_price_levels`: '1' = on (DEFAULT when the key is missing), '0' = off.
- Server: when '0', POST ignores price_level (always 'retail' pricing, stored price_level 'retail').
- UI when off: hide the POS level selector and tier badges/prices, hide wholesale/super-wholesale columns and the
  tier sections in Products (retail price, package break and min price stay), hide price level on customers
  and in the invoice editor, price checker shows retail only, bulk price update offers retail only.
  Toggle lives in Settings → Sales & Pricing (with an explanation, e.g. "Turn off for restaurants/cafés").

## 4. POS
- Refund modal: method choice "Cash" (default) / "Keep on customer account" (payments [] — disabled for
  Walk-in). Show the customer's balance before and after the refund.
- Payment modal: "Use account balance" when the selected customer's balance > 0: adds a `store_credit` payment
  of min(balance, remaining due) (editable, capped); shows available credit.
- Cart/customer area: Previous balance · This sale · New balance (live). New balance =
  prev − (total − realMoneyPaid), where credit and store_credit are not real money. Colors: negative = danger
  ("owes"), positive = success ("credit").
- After checkout, the success dialog shows previous/new balance for non-walk-in customers.

## 5. Back-office invoice editor
- Payment method option "From account balance" (sales and purchases), showing available credit.
- Old / new balance panel for the selected party (computed client-side for new invoices; for edits use
  `stakeholder_balance` − `balance_effect` as "balance without this invoice").
- Inline field errors: client-side validation shown next to fields (party required, line qty > 0, unit price ≥ 0,
  below min price warning, reason required on edit, payment amount > 0, store credit ≤ available) AND server
  errors mapped via `field` to the line/field that caused them (plus the toast). Errors clear when the field is
  edited.
