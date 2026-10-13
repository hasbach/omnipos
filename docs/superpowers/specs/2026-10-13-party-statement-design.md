# Customer / Supplier Statement — Unpaid Orders & Account Activity

Date: 2026-10-13
Status: approved design, pending implementation plan

## Goal

Let back-office users print or export a statement for any customer or supplier, in two modes:

1. **Unpaid orders** — the orders that make up what the party owes today, each with its products, and
   with a partially paid order showing paid / remaining. The statement total equals the party's balance.
2. **Account activity** — every movement between a From and To date (settled orders included), with an
   opening and closing balance, to trace calculation disputes.

Each statement can be previewed and printed on a **receipt printer** or an **A4 printer**, or saved as **PDF**.
Arabic names, addresses and products must render correctly in all outputs.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Allocating balance payments to orders | Oldest order first (FIFO), computed at statement time; no DB changes |
| Activity statement period | From–To date range, opening balance at From, closing balance at To |
| Where it lives | Back office only: stakeholder detail drawer + Reports → Customer statement |
| Currency | USD lines; LBP original shown on LBP payments; LBP equivalent of the final total at today's rate |
| Rendering | HTML (A4/PDF, Electron print + printToPDF) and ESC/POS (receipt) — option A |

Out of scope: POS-screen statement button, balance-math changes, the Quick Market Arabic receipt issue
(no printing-engine change since 2026-09-25; being checked on site as a configuration issue).

## 1. Data and server

### Shared builder

Extend `server/statement.ts`. `buildStatement` (the event ledger) stays the single source of events; two new
functions are built on it. The statement is read-only and never touches `server/balance.ts` math.

Sign convention is the app's: negative balance = party owes us (customer) / we owe them (supplier).

### Mode `open` — unpaid orders

1. Collect **debt items** — events that made the balance more negative:
   - each sale (customer) / purchase (supplier), live or archived, with its *amount outstanding after
     at-sale real-money payments* (`total − real-money payments on that transaction`, PAID_TOLERANCE_USD
     respected); fully paid at sale → not a debt item;
   - negative opening / import / manual-edit amounts, merged into one **"Previous balance"** item.
   - a refund is first netted against the order it reverses (`original_transaction_id`, live or archived):
     that order's outstanding amount shrinks by the refunded amount; only the remaining payments are then
     allocated oldest-first (step 3).
2. Let `due = −balance` (current `stakeholders.balance`). If `due ≤ 0.005`: no unpaid orders; return the
   credit amount (if any).
3. FIFO allocation ⇒ outstanding debt is always the **newest** debt items. Walk debt items newest → oldest,
   taking each until the running sum reaches `due`. Items fully taken = **unpaid**; the crossing item =
   **partially paid** (`remaining = due − sum of newer items`); older items are fully paid and omitted.
   If debt items sum to less than `due`, the shortfall is added to "Previous balance".
4. Each order returned with: id, receipt no (`terminal_id-sequence` or `#id`), date, items (name, uom name /
   factor, qty in the unit, unit price, line total, discount), order discount, total, `paid` (total −
   remaining), `remaining`, status (`unpaid` | `partial`).
5. Invariant: `previous_balance + Σ remaining = due` exactly (rounded to cents).

Suppliers: identical with purchases; labels say "amount we owe".

### Mode `activity` — date range

- Inputs `from`, `to` (YYYY-MM-DD, local dates). Boundaries are **local midnight** converted to the stored
  timestamp format (avoid the UTC day-boundary bug fixed in 1.5.0).
- Opening = running balance of the ledger before `from`; rows = ledger events in range; closing = running
  balance at end of `to`. Invariant: `opening + Σ effect(rows) = closing`.
- Invoice rows carry structured `items` (same shape as open mode) instead of only the description text.
- Includes archived (settled) transactions.

### API

- `GET /api/reports/statement/:id?mode=open|activity&from=&to=` →
  `{ party: {id,name,type,address,phone,balance}, business: {name,address,phone,language},
     mode, open?: {previous_balance, orders[], total_due, credit}, activity?: {from,to,opening,rows[],closing,total_debit,total_credit},
     localCurrency: {code,symbol,rate} | null, printed_at }`
- `POST /api/print/statement` `{ stakeholderId, mode, from?, to?, printerId? }` → builds the ESC/POS buffer
  server-side and sends it to the resolved receipt printer (same resolution as `/api/print/receipt`).
- Permissions (server/permissions.ts): both routes need `['reports.view', 'parties.view']`, same as the
  existing `/api/reports/customer-statement/:id`, which keeps working.

## 2. Layout

Language = store `language` setting (en / ar / fr); Arabic A4 pages are `dir="rtl"`. New fixed strings go into
the existing locale files (`src/intl/locales/*`) and `server/printing/receiptLabels.ts`.

### A4 / PDF — unpaid orders

Header: store name, address, phone; title "Statement of account — Unpaid orders"; printed date/time;
party name, address, phone. Then:
- "Previous balance" line (when non-zero).
- One block per order: receipt no, date, status badge (Unpaid / Partially paid); product table
  (Product · Unit · Qty · Price · Total); order total, paid, remaining.
- Footer: **Total due** (supplier: **Total we owe**), LBP equivalent at today's rate, signature line.
- No unpaid orders: "No unpaid orders" plus credit amount when the balance is positive.

### A4 / PDF — account activity

Header as above plus period "From – To". Table: Date · Ref · Description · Debit · Credit · Balance.
Opening balance row first, closing balance row last; invoice product lines indented beneath the invoice row;
LBP payments show the original amount, e.g. "$10.00 (895,000 LL)". Footer: total debit, total credit,
closing balance with LBP equivalent. Empty range: "No activity in this period" with opening/closing shown.

### Receipt (ESC/POS, 80 mm / 58 mm by printer setting)

New `buildStatementBuffer` in `server/printing/statement.ts`, reusing `EscPos` (`labeled`, `itemLine`, `kv`,
`hr`) so Arabic uses the same raster / code-page path as sale receipts.
- Open mode: header, party, previous balance, per order: ref + date + status, item lines, total / paid /
  remaining; then TOTAL DUE and LBP equivalent.
- Activity mode: header with period, opening balance, one compact line per movement (date, ref, amount,
  running balance) with item lines under invoices, closing balance.
- More than ~200 activity rows: preview warns and suggests A4 (does not block).

An 80 mm HTML layout of the same content is used when no ESC/POS receipt printer is configured.

## 3. UI and print flow

### `StatementView` component (`src/pages/statement/`)

Used in the stakeholder `DetailDrawer` Statement tab and in Reports → Customer statement (which gains a
customer/supplier picker and still opens from the Aging report).

Controls:
- Mode: `Unpaid orders` | `Account activity` — defaults to Unpaid orders when the party owes, else Activity.
- From / To (activity only), default first day of current month → today; quick ranges from the existing
  DateRangePicker presets (Today … This year, Custom) plus an "All" button.
- Format: `A4` | `Receipt` — switches the on-screen preview.
- Buttons: **Print**, **Save PDF**, **Export Excel** (activity mode).

The preview renders the same HTML that is printed.

Print flow:
- **Print, A4** → `electronAPI.printHtml(html, { dialog: true })` (system print dialog, user picks printer).
- **Print, Receipt** → `POST /api/print/statement` to the default receipt printer; if none configured,
  `printHtml` with the 80 mm HTML layout. On ESC/POS failure: error toast with a "Print as A4" action
  (no silent fallback).
- **Save PDF** → `electronAPI.savePdf(html, 'statement-<party>-<date>.pdf')` (A4 layout, `printToPDF` + save
  dialog). Replaces the jsPDF statement export (which cannot shape Arabic).
- Outside Electron (preview server): `window.print()` fallback.

Electron: add `print:html` and `print:pdf` IPC handlers in `electron-main.js` and expose them in
`electron-preload.cjs` alongside `printSilent`.

The HTML statement is rendered on the server and uses system fonts ("Segoe UI", Tahoma, Arial); Chromium
shapes Arabic, and the off-screen print window cannot load the app's bundled web fonts.

## 4. Testing

- `tests/statement.test.ts`:
  - open mode: `previous_balance + Σ remaining = −balance` for: partially paid order, several unpaid orders,
    refund, overpayment / credit, balance collection, opening debt from import/manual edit, archived
    (settled) orders, supplier with purchases, zero / positive balance;
  - activity mode: `opening + Σ effect = closing`; local-midnight boundaries include an event at 00:30 local
    on `from` and exclude one at 00:30 local after `to`.
- ESC/POS: `buildStatementBuffer` builds at 80 and 58 mm with an Arabic name/address; uses code-page text when
  the printer has an Arabic code page set.
- UI verified in the preview server: both modes, both formats, Arabic RTL, PDF output.
