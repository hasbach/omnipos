# Feature Specification: B2C Retail Ordering (Cart, Checkout, Sales Order, Pickup/Delivery)

**Feature Branch**: `003-retail-ordering`

**Created**: 2026-10-20

**Status**: Clarified 2026-10-20 — ready for planning

**Input**: User description: "Feature 003 — B2C retail ordering, per ROADMAP row 003 and
OmniPOS_Marketplace_Supply_Chain_Master_Blueprint.md §11 and §34 Phase 2. Builds on 002 (public, read-only,
server-rendered storefront at `<address>.myomnipos.com`, edge-cached per URL, no cookies, WhatsApp/phone/email
contact) and 001 Slice A (stores, listings, public catalog). Visitors add products to a cart and check out without an
account (name + phone, optional address), choosing pickup or delivery; payment is cash on pickup/delivery (no payment
gateway). Compare a lightweight 'send the order on WhatsApp' first slice with real orders that reach the shop's
registers (accept/reject, conversion into a POS sale, stock re-check, USD + local prices, orderable units, abuse
limits). Delivery zones and fees stay in 010; custom domains in 012."

## Overview

Feature 002 made every shop's products visible online, but a visitor who wants to buy still has to type out what they
want in a WhatsApp chat or a phone call. This feature lets the visitor **build a cart on the storefront and send it to
the shop as an order**, then pick it up or have it delivered and pay cash on handover, exactly as Lebanese shops trade
today.

It comes in two slices that share the cart and checkout screens:

1. **WhatsApp order (Slice 1)** — the checkout turns the cart into a ready-to-send WhatsApp message to the shop. Nothing
   is stored by OmniPOS; the shop handles the order in WhatsApp as it does now, just with a clean, priced list. Small,
   fast to ship, no new data.
2. **Online orders (Slice 2)** — the checkout creates a real **sales order** that appears in the shop's back office on
   every register. The shop accepts (possibly adjusting quantities) or rejects it, the customer follows its status
   through a private link, and at handover the order is turned into an ordinary POS sale, so stock, invoices,
   payments, balances, settlement and reports keep working through the existing engines.

The storefront pages themselves stay what 002 made them: the same cached HTML for every visitor. The cart lives only
in the visitor's browser.

## Clarifications

### Session 2026-10-20

- Q: Which slices does 003 deliver? → A: Both — Slice 1 "WhatsApp order" first, then Slice 2 "Online orders" (FR-001).
- Q: Is there a delivery fee in 003? → A: No. No fee is shown, charged or added to orders; the shop tells the customer
  about any delivery charge as today. Fees and zones stay in 010 (FR-023).
- Q: Must customers verify their phone number? → A: No. The abuse limits of FR-041 (per-phone and per-network limits,
  cart and field limits, bot trap, expiry, blocked-phone list) are enough; no one-time code (FR-041).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A visitor builds a cart on the storefront (Priority: P1)

A customer browsing `abc-market.myomnipos.com` taps "Add to cart" on Halloumi 250g, picks "Pack of 6" instead of
"Piece", adds two bottles of water from the product list and opens the cart. They see each line with its unit,
quantity, price and line total, the cart total in US dollars and Lebanese pounds, and can change quantities or remove
lines. They close the browser, come back the next day, and the cart is still there.

**Why this priority**: both slices need it; without a cart nothing can be ordered.

**Independent Test**: On a store with ordering turned on, add, change and remove items on a phone-sized screen, reload
and reopen the browser, and confirm the cart and totals survive while every store and product page is still served
from the edge cache unchanged.

**Acceptance Scenarios**:

1. **Given** a store with ordering on and an orderable product, **When** the visitor taps "Add to cart" on the product
   page or product card, **Then** the item is added in the chosen unit (default: the product's base unit or the only
   orderable unit), the cart count updates, and a short confirmation appears without leaving the page.
2. **Given** a product sold in several orderable units, **When** the visitor adds it, **Then** they can choose the unit,
   and each unit is its own cart line with that unit's price.
3. **Given** items in the cart, **When** the visitor opens the cart, **Then** they see lines (photo, name, unit,
   quantity, unit price, line total), the total in USD and, when the store shows local prices, in the local currency,
   with a note that prices and availability are confirmed when the order is sent.
4. **Given** a cart, **When** the visitor reloads, leaves and returns on the same device and browser, **Then** the cart
   is unchanged; carts of different stores are kept separately.
5. **Given** a product that is out of stock (indicator), unpublished, or has no orderable unit, **When** it is shown,
   **Then** "Add to cart" is disabled or absent and the contact buttons remain.
6. **Given** a store whose ordering is off (or that is paused, Wholesale, unlicensed, …), **When** the storefront is
   shown, **Then** no cart or "Add to cart" appears and the store behaves exactly as in 002.
7. **Given** two visitors with different carts, **When** they open the same product page, **Then** both receive the
   same cached page; the cart count and buttons' state come only from each visitor's own browser.

---

### User Story 2 - The visitor sends the order on WhatsApp (Priority: P1, Slice 1)

The customer taps "Order on WhatsApp", types their name, chooses "Delivery" and their address, adds "ring the bell
twice", and taps "Send". WhatsApp opens with a message to the shop, in the store's language, listing every item, unit,
quantity and price, the total in USD and LBP, the name, pickup or delivery with address, the note and the store link.
They press send in WhatsApp; the cart is emptied after they confirm they sent it.

**Why this priority**: it gives every shop with a WhatsApp number a working order flow immediately, with no new data,
no back-office work and no abuse surface, while real orders (Slice 2) are built.

**Independent Test**: With ordering set to "WhatsApp", fill a cart and complete the checkout on a phone and on a
desktop; check that the message opened in WhatsApp (app or web) contains exactly the cart's lines and totals, and that
OmniPOS stored nothing.

**Acceptance Scenarios**:

1. **Given** a store whose ordering mode is "WhatsApp" and which has a WhatsApp number, **When** the visitor completes
   the checkout form, **Then** WhatsApp opens a conversation with the shop's number (normalised exactly as the contact
   buttons are) with the full order pre-filled in the store's language.
2. **Given** the checkout form, **When** the visitor leaves the name empty, or chooses delivery without an address,
   **Then** they are told what is missing before WhatsApp opens.
3. **Given** a store with ordering mode "WhatsApp" but no WhatsApp number, **When** the storefront is shown, **Then**
   ordering is not offered (the back office does not allow this combination; the storefront also guards it).
4. **Given** a very large cart, **When** the message would exceed what WhatsApp links reliably carry, **Then** the cart
   limit (FR-007) prevents it and the visitor is told to split the order.
5. **Given** the visitor returns from WhatsApp, **When** they confirm "I sent it", **Then** the cart is emptied; if they
   say they did not, the cart is kept so they can try again.

---

### User Story 3 - The visitor places an online order and follows it (Priority: P1, Slice 2)

With ordering set to "Online orders", the customer checks out with name, phone (`71 315 744`), pickup, and a note.
Before submitting they see the final total, recomputed by the shop's current prices: one item's price changed since it
was added and is shown highlighted. They submit and get an order number and a private link. The page says "Waiting for
the shop to confirm". Twenty minutes later the same link shows "Accepted — ready for pickup", with one line reduced from
6 to 4 because only 4 were left.

**Why this priority**: this is what makes the store an actual sales channel with the order inside OmniPOS instead of a
chat.

**Independent Test**: Place orders on a test store (pickup and delivery), including one with a stale price and one with
an item that went out of stock, and follow each status link through accept, adjust, reject, cancel and expiry.

**Acceptance Scenarios**:

1. **Given** a cart, **When** the visitor reaches the last checkout step, **Then** every line is re-priced and re-checked
   against the shop's current published catalog; changed prices, units no longer orderable, and items now out of stock
   are shown to the visitor, who must accept the updated order before submitting.
2. **Given** a valid checkout (name, phone, pickup or delivery, address if delivery), **When** the visitor submits,
   **Then** the order is recorded once, even if they tap twice or the connection drops and they retry, and they see the
   order number, a summary, and a private status link that they can bookmark or share.
3. **Given** a submitted order, **When** the visitor opens its status link, **Then** they see its current status
   (Waiting for confirmation, Accepted, Ready, Completed, Rejected with the shop's reason, Cancelled, Expired), the
   lines with ordered and confirmed quantities, the totals, pickup or delivery details, and the shop's contact
   buttons.
4. **Given** an order still waiting for confirmation, **When** the visitor taps "Cancel order", **Then** it is cancelled
   and the shop sees it as cancelled by the customer; once accepted, the visitor can no longer cancel online and is
   pointed to the contact buttons.
5. **Given** the visitor has placed orders from this device, **When** they open "My orders" on that store, **Then** they
   see those orders' numbers, dates and statuses (kept only on that device).
6. **Given** a store whose ordering is "Online orders", **When** cloud services are unreachable at submission, **Then**
   the visitor is told the order could not be sent and is offered "Send on WhatsApp instead" when the shop has a
   WhatsApp number; the cart is kept.

---

### User Story 4 - The shop sees, accepts or rejects online orders (Priority: P1, Slice 2)

A new order arrives. Every register signed into the shop shows a notification with a sound and a badge on "Online
orders". The cashier opens it: customer name and phone, pickup, note, lines with the current local stock next to each.
They lower one line from 6 to 4 with reason "Out of stock", accept, and tap "WhatsApp customer", which opens a chat
with a message saying the order is accepted and ready in 30 minutes. A second cashier who opened the same order a
moment later sees it already accepted.

**Why this priority**: an order no one sees or answers is worse than no ordering at all.

**Independent Test**: Submit orders while two registers are online and one offline; check notification, accept with
adjustment, reject with reason, concurrent accept, and the offline register's read-only view after it reconnects.

**Acceptance Scenarios**:

1. **Given** a new order, **When** it reaches the shop, **Then** every online register of that business whose user may
   view orders shows a notification within 1 minute, and the order appears at the top of "Online orders" as New.
2. **Given** a new order, **When** a user with permission opens it, **Then** they see the customer's name, phone,
   fulfilment choice (pickup or delivery with address), note, order time, each line with ordered quantity, unit,
   quoted price and the register's current stock for it, and the totals in USD and local currency.
3. **Given** a new order, **When** the user accepts it, **Then** they may lower or zero any line's confirmed quantity
   with a reason (Out of stock, Damaged, Customer request, Other), the order becomes Accepted and the customer's status
   page shows the confirmed quantities and new total; confirming more than ordered is refused.
4. **Given** a new order, **When** the user rejects it with a reason, **Then** the order becomes Rejected and the
   customer's status page shows the reason. Confirming zero on every line is treated as a rejection.
5. **Given** two users acting on the same order at the same time, **When** both accept, reject or edit it, **Then**
   exactly one action succeeds and the other user is told the order was already handled, with its current state.
6. **Given** a register without internet, **When** a user opens "Online orders", **Then** the last-synced orders are
   shown read-only with an "offline — can't accept or reject" message; selling at the POS is never blocked.
7. **Given** an order with a customer phone, **When** the user taps "WhatsApp customer" or "Call", **Then** a chat or
   call opens with a message pre-filled for the order's state (accepted, ready, rejected) in the store language.
8. **Given** an order not accepted or rejected within the store's expiry time (default 24 hours), **When** that time
   passes, **Then** it becomes Expired, the customer's page says so, and it leaves the New list.

---

### User Story 5 - The accepted order becomes a POS sale at handover (Priority: P1, Slice 2)

The customer arrives. The cashier opens the order, marks it Ready (optional, if it was prepared earlier), then taps
"Complete sale". The POS opens a new sale tab already filled with the confirmed lines, units and quoted prices, and the
customer matched by phone (or Walk-in). The customer pays 45 USD in cash plus the rest in LBP; the sale is recorded
exactly like any POS sale, stock goes down, the receipt prints, and the order shows Completed with a link to the sale.

**Why this priority**: an order that never becomes a sale leaves stock, cash and reports wrong; converting it through
the existing POS keeps every money and stock rule intact (Constitution I).

**Independent Test**: Convert accepted orders paid in USD, LBP and mixed, with a matched customer and with Walk-in,
then check stock movements, the invoice, payments, cash drawer, daily sales, settlement and the order's link to its
sale.

**Acceptance Scenarios**:

1. **Given** an accepted order, **When** the user taps "Complete sale" on a register, **Then** a POS sale is prepared
   with the confirmed lines (product, unit, quantity, quoted unit price) and the order reference, and nothing is
   recorded until the cashier finishes the sale through the normal checkout.
2. **Given** the prepared sale, **When** the cashier finishes it, **Then** stock, the invoice, payments, balances and
   the cash drawer change exactly as for a sale typed by hand, and the order becomes Completed, linked to that sale.
3. **Given** the prepared sale, **When** the customer takes fewer items or the cashier changes a price, **Then** the
   cashier edits the sale with the usual POS permissions (price override, discount); the order keeps its confirmed
   quantities and records the sale's final totals.
4. **Given** the customer's phone matches one existing customer, **When** the sale is prepared, **Then** that customer is
   proposed; otherwise Walk-in is used, and the cashier may pick or create a customer as in any sale.
5. **Given** an accepted order, **When** the customer never comes, **Then** the user can cancel it with a reason; no
   stock or money was ever affected.
6. **Given** an order already completed on one register, **When** another register tries to complete it, **Then** it is
   refused, so one order never produces two sales.
7. **Given** a completed order's sale, **When** it is later refunded, edited or settled, **Then** the existing refund,
   invoice-edit and settlement paths apply unchanged and the order keeps its link to the sale.

---

### User Story 6 - The owner sets up ordering for the store (Priority: P2)

In Settings → Online store, the owner chooses the ordering mode (Off, WhatsApp, Online orders), turns on pickup and/or
delivery, writes pickup instructions and the delivery area ("Achrafieh and Gemmayzeh only"), sets a minimum order of
10 USD and an expiry of 12 hours. In a product's Online store tab they restrict "Water 1.5L" to be orderable only by
the pack of 6.

**Why this priority**: shops must opt in and set their rules, but the defaults let P1 stories be tested first.

**Independent Test**: Change each setting and check the storefront and checkout reflect it within the refresh time,
and that a shop that never opens these settings sees no change at all.

**Acceptance Scenarios**:

1. **Given** an existing store, **When** the app is upgraded, **Then** ordering is Off and the storefront is unchanged.
2. **Given** a user with permission to manage the store, **When** they set ordering to WhatsApp, **Then** it is refused
   unless the store has a WhatsApp number; setting it to Online orders requires at least one of pickup or delivery.
3. **Given** a listing, **When** the owner restricts its orderable units, **Then** the storefront offers only those
   units, the same restriction holds on every register and in the cloud, and checkout refuses any other unit.
4. **Given** a minimum order value, **When** a cart is below it, **Then** checkout is disabled with the remaining amount
   shown.
5. **Given** a user without the order permissions, **When** they use the back office, **Then** they see neither the
   "Online orders" page nor its notifications.

---

### Edge Cases

- **Price changed between add-to-cart and checkout**: the final checkout step shows the current price; the order
  records the price shown at submission. Prices in the cart before that step are indicative.
- **Price changed between order and handover**: the sale is prepared at the order's quoted prices (the price the shop
  accepted); the cashier can change it with the usual permission.
- **Online stock lags the registers** (≈ 60 s online, longer offline): the checkout re-check uses the latest published
  stock; the real check is the shop's, at acceptance, against the register's current stock. Out-of-stock lines can be
  reduced at acceptance. Orders never reserve or move stock before the sale.
- **Shop allows negative stock**: online ordering still refuses items shown as out of stock; the shop decides at
  acceptance.
- **Product unpublished, disabled or deleted after ordering**: existing orders keep their lines (name, unit, price as
  ordered); the shop can still accept, adjust or reject them. A deleted product cannot be put into a POS sale; that
  line must be confirmed at zero.
- **Unit removed after ordering**: the order line keeps its unit, contents and price as ordered (001 rule); conversion
  uses the product's base unit with the equivalent quantity, or the line is confirmed at zero.
- **Store paused or ordering turned off with open orders**: no new orders; open orders can still be accepted,
  completed or cancelled.
- **Exchange rate changes**: the order stores the local rate used for its local-currency total; payment at handover
  follows the POS's normal rate rules (sale-time and per-party rates).
- **Local price on a product** (`price_lbp`): local totals use it, exactly as the storefront and POS display do.
- **Fractional quantities** (kg): allowed only for products sold by weight, with the same decimals as the POS; the
  visitor types the quantity.
- **Same visitor submits twice quickly**: the second submission of the same checkout is recognised and returns the
  first order.
- **Phone numbers**: accepted in local form (`03 123 456`, `71315744`) or international; stored normalised (+961…) the
  same way as the shop's WhatsApp number.
- **Arabic names and notes**: stored and shown as typed, with correct direction; the WhatsApp message is in the store
  language with names as typed.
- **Cart from a store that later closes**: the cart page says the store is not taking orders and keeps the contact
  buttons.
- **Browser storage unavailable** (private mode, blocked): the cart still works for the visit but is not remembered;
  the visitor is told.
- **Very long notes or addresses**: trimmed to a set length with a counter.
- **Multiple stores of one business**: each store has its own cart, ordering settings and orders; the back office shows
  which store each order came from.

## Requirements *(mandatory)*

### Functional Requirements

**Scope and slices**

- **FR-001**: This feature MUST deliver two slices sharing the same cart and checkout: Slice 1 "WhatsApp order" (no
  order is stored by OmniPOS) and Slice 2 "Online orders" (stored sales orders handled in the back office). Each store
  chooses one ordering mode: Off (default), WhatsApp, or Online orders. Slice 1 ships first and MUST be usable on its
  own; Slice 2 follows on the same cart and checkout.
- **FR-002**: Ordering MUST be offered only on stores that are publicly visible under 002's rules (open, Retail or
  Hybrid, commerce on, valid online license, not deleted) and whose ordering mode is not Off.

**Cart (both slices)**

- **FR-003**: Visitors MUST be able to add orderable products to a cart from product pages and product cards, choose
  the unit when several units are orderable, change quantities and remove lines.
- **FR-004**: The cart MUST be kept only in the visitor's browser, per store, surviving reloads and browser restarts;
  OmniPOS MUST NOT store a cart anywhere until an order is submitted (Slice 2).
- **FR-005**: Store and product pages MUST remain identical for every visitor (no cart content, count or visitor data in
  the page as served), so they keep being cached per URL exactly as in 002 (002 FR-022/FR-023). Cart state MUST be
  applied in the visitor's browser.
- **FR-006**: The cart MUST show, per line, photo, name, unit, quantity, unit price and line total, and the cart total in
  USD and, when the store shows local prices, in the local currency, computed with the same rules as the storefront's
  price display.
- **FR-007**: A cart MUST hold at most 50 distinct lines and a per-line quantity of at most 999 (or the equivalent
  weight limit); the visitor MUST be told when a limit is reached.
- **FR-008**: "Add to cart" MUST be unavailable for products shown as out of stock, unpublished, or without an
  orderable unit; the contact buttons of 002 MUST stay available everywhere.
- **FR-009**: All cart and checkout text MUST exist in English, Arabic and French, follow the visitor's storefront
  language, render right to left in Arabic, and work from 360 px wide.

**Checkout form (both slices)**

- **FR-010**: Checkout MUST ask for: name (required), phone (required in Slice 2, optional in Slice 1), fulfilment
  method (pickup or delivery, among those the store offers), delivery address (required for delivery), and an optional
  note. No account, password or email is required.
- **FR-011**: The visitor MAY choose "remember my details on this device"; then name, phone and address are kept only in
  their browser to prefill the next checkout, and can be cleared.
- **FR-012**: Checkout MUST show the store's pickup instructions or delivery area text, the minimum order value when
  one is set (disabling checkout below it), and that payment is made on pickup or delivery.

**WhatsApp order (Slice 1)**

- **FR-013**: In WhatsApp mode, submitting checkout MUST open a WhatsApp conversation with the store's WhatsApp number,
  normalised with the same rule as the storefront contact buttons, pre-filled in the store language with: store name,
  each line (name, unit, quantity, unit price, line total), totals in USD and local currency when shown, customer
  name, phone if given, pickup or delivery with address, note, and the store link.
- **FR-014**: Slice 1 MUST NOT send or store any order or visitor data in OmniPOS; the message goes only from the
  visitor's own WhatsApp.
- **FR-015**: After returning from WhatsApp, the visitor MUST be asked whether they sent the message; the cart is
  emptied only on "yes".
- **FR-016**: The back office MUST NOT allow WhatsApp mode for a store without a WhatsApp number.

**Online order submission (Slice 2)**

- **FR-017**: Before submission, every cart line MUST be re-priced and re-validated against the store's current public
  catalog (published, product enabled, unit orderable, not shown as out of stock, quantity within limits). Any change
  MUST be shown to the visitor, who must confirm the updated order before it is sent.
- **FR-018**: The submitted order's prices and totals MUST be computed by OmniPOS from the current catalog, never taken
  from the visitor's browser (Constitution IV); a line that fails validation at that moment MUST make the submission
  return the updated order for confirmation instead of creating it.
- **FR-019**: Each order line MUST record the product, the ordered unit and its contents in base units, the ordered
  quantity, the quoted unit price in USD and the quoted local unit price, and later the confirmed quantity with a
  shortfall reason; the order MUST record the local rate used, the totals in USD and local currency, the customer's
  name, phone, fulfilment method, address and note, the store, and the submission time.
- **FR-020**: Submission MUST be idempotent: retries of the same checkout (double tap, dropped connection) MUST return
  the same order and never create a second one.
- **FR-021**: After submission the visitor MUST receive an order number (short, human-readable, unique per store) and a
  private status link that cannot be guessed from the order number; the status page MUST be visible only through that
  link, never listed or indexed, and never stored in a shared cache.
- **FR-022**: If submission fails because the cloud is unreachable, the visitor MUST be told and, when the store has a
  WhatsApp number, offered to send the same order on WhatsApp (Slice 1 message); the cart MUST be kept.
- **FR-023**: This feature MUST NOT compute, show, charge or add any delivery fee to a cart, message or order. When
  delivery is chosen, checkout MUST show the store's delivery-area text and state that any delivery charge is agreed
  with the shop. Delivery zones, drivers and fee rules remain in Feature 010.

**Order lifecycle (Slice 2)**

- **FR-024**: Online orders MUST follow these states: New (submitted) → Accepted → Ready (optional) → Completed;
  exceptions: Rejected (by the shop, from New), Cancelled by customer (from New), Cancelled by shop (from Accepted or
  Ready, with a reason), Expired (New past the store's expiry time, default 24 hours, configurable 1–72 hours). Any
  other transition MUST be refused.
- **FR-025**: These states MUST be a subset of the single order model defined in 001 (FR-014–FR-018): New = Submitted,
  Accepted = Confirmed, Completed = fulfilled by a POS sale; Rejected, Cancelled and Expired are 001 exception states.
  Ordered and confirmed quantities MUST be stored separately; confirmed MUST NOT exceed ordered.
- **FR-026**: Every state change and every quantity change MUST be recorded in the order's history with time, actor
  (customer, user name and register, or system) and reason.
- **FR-027**: State changes by the shop (accept, adjust, reject, ready, cancel, complete) MUST require an internet
  connection and MUST be applied atomically in the cloud so that, across registers, exactly one conflicting action
  succeeds and the others are told the current state.
- **FR-028**: The customer's status page MUST reflect a state change within 1 minute.

**Back office (Slice 2)**

- **FR-029**: The back office MUST have an "Online orders" page listing the business's orders by store, filterable by
  state and date, with New orders first, showing number, time, customer name, fulfilment method, total and state.
- **FR-030**: A new order MUST produce an in-app notification (toast, sound that can be muted per register, badge with
  the count of New orders) on every online register whose signed-in user may view orders, within 1 minute of
  submission.
- **FR-031**: The order detail MUST show every recorded field, the history, and each line's current stock on that
  register; it MUST offer Accept (with per-line confirmed quantity and reason), Reject (with reason), Mark ready,
  Cancel (with reason), Complete sale, and "WhatsApp customer" / "Call customer" with a message pre-filled for the
  current state.
- **FR-032**: Registers without internet MUST show the last-synced orders read-only and say why actions are unavailable;
  the POS MUST never wait on, or be blocked by, online orders (Constitution III).
- **FR-033**: New permissions MUST extend the existing role system: orders.view (see orders and notifications) and
  orders.manage (accept, reject, adjust, ready, cancel); completing the sale additionally requires the normal POS sale
  permission. Store ordering settings require the existing store.manage permission. Every new back-office route MUST
  have a permission rule.

**Conversion into a POS sale (Slice 2)**

- **FR-034**: "Complete sale" MUST open a POS sale pre-filled with the confirmed lines (product, unit, quantity, quoted
  unit price) and a reference to the order; nothing is recorded until the cashier finishes the sale through the normal
  checkout.
- **FR-035**: The finished sale MUST be an ordinary POS transaction: stock, invoice, payments, cash drawer, balances,
  sale-time exchange rate, settlement, refunds, edits and reports MUST behave exactly as for a manually typed sale; the
  order only gains a link to it and the sale's final totals.
- **FR-036**: One order MUST produce at most one sale; a second completion attempt (same or other register) MUST be
  refused.
- **FR-037**: The customer MUST default to the existing customer whose phone matches the order's phone when exactly one
  matches, otherwise Walk-in; the cashier MAY change it. Orders MUST NOT create customer records automatically.
- **FR-038**: Submitting, accepting, adjusting, readying, rejecting, cancelling or expiring an order MUST NOT change
  stock, invoices, payments or balances (001 FR-029). Accepted quantities MAY be shown as "committed" for information.

**Orderable units**

- **FR-039**: A listing's orderable-unit restriction MUST identify units in a way that is the same on every register and
  in the cloud; the current register-local unit references MUST be converted, and any value that cannot be converted
  MUST fall back to "all live units orderable" (today's storefront behaviour) rather than blocking ordering.
- **FR-040**: The storefront and the order submission MUST both enforce the restriction and the listing's minimum
  quantity; an unrestricted listing allows every live unit.

**Abuse and privacy (Slice 2)**

- **FR-041**: The public order submission MUST be protected against abuse by: per-phone and per-network limits (at most
  5 orders per phone per store per hour and at most 3 orders per phone per store in state New), the cart limits
  (FR-007), field length limits, a bot trap invisible to people, the store's expiry time, and a per-store blocked-phone
  list managed by users with orders.manage. Customers MUST NOT be asked to verify their phone number (no one-time
  code); the shop's review at acceptance is the final check.
- **FR-042**: Order submission, customer cancellation and status reads MUST be the only storefront operations that read
  or write order data; they MUST be limited to the single order concerned and MUST NOT reveal other orders, stock
  quantities, costs or any data beyond 002's allow-list.
- **FR-043**: Customer name, phone, address and note MUST be visible only to users of the receiving business with
  orders.view, MUST be stored per business (tenant isolation, Constitution II), and MUST NOT appear in any public page
  other than that order's private status page (which shows only the customer's own first name and fulfilment details).
- **FR-044**: The storefront MUST still set no cookies and run no analytics or tracking; remembered details, the cart
  and "My orders" MUST stay in the visitor's own browser.

**Store ordering settings**

- **FR-045**: Per store, users with store.manage MUST be able to set: ordering mode (Off / WhatsApp / Online orders),
  pickup on/off with instructions, delivery on/off with delivery-area text, minimum order value (optional, USD), order
  expiry time (Slice 2), and the blocked-phone list (Slice 2). Defaults reproduce today's behaviour: ordering Off
  (Constitution VII).
- **FR-046**: Setting changes MUST reach the storefront within the 002 refresh time (5 minutes).

**Scope boundary**

- **FR-047**: This feature MUST NOT include online payment or a payment gateway, customer accounts or passwords,
  phone verification codes, delivery fees, delivery zones, drivers or proof of delivery (010), B2B or customer-specific pricing (004–006), stock reservation,
  marketplace discovery (011), or custom domains (012).

### Key Entities

- **Cart (visitor's browser only)**: per store; lines of listing, unit, quantity, last seen price. Never stored by
  OmniPOS.
- **Store Ordering Settings (extends Store, 001)**: ordering mode, pickup/delivery switches and texts, minimum order
  value, expiry time, blocked phones.
- **Store Listing (existing)**: orderable units (now identified the same everywhere) and minimum quantity, now enforced.
- **Sales Order (Slice 2; first use of 001's Order model)**: one store, one customer contact (name, phone, address,
  note), fulfilment method, state, order number, private status key, local rate, totals, submission time, link to the
  resulting POS sale; belongs to the selling business only (B2C has no buyer business).
- **Order Line (001 Order Line, subset)**: product, unit and contents, ordered quantity, confirmed quantity, shortfall
  reason, quoted USD and local unit prices. Shipped/received quantities are not used for pickup/cash B2C orders.
- **Order History Entry**: state or quantity change, time, actor, reason.
- **POS Sale (existing transaction)**: gains an optional reference to the order it fulfils.

### Dependencies

- **002** (storefront pages, caching, contact normalisation) — must be deployed; 003 adds client-side cart behaviour,
  checkout, and the order status page to it.
- **001 Slice A** (stores, listings, public catalog) — done.
- **001 Slice B** — 003 needs only part of it: the order and order-line model (ordered vs confirmed quantity,
  shortfall reasons, state machine subset, history) and the orders.view / orders.manage permissions. It does **not**
  need business relationships, shipments, goods receipts, buyer-side purchase orders or the per-relationship posting
  policy (B2C posts through a normal POS sale). Planning 003 therefore defines this B2C subset so that 006 extends
  the same model rather than replacing it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A visitor can go from a product page to a sent order (either slice) in under 2 minutes on a phone, in
  each of English, Arabic and French.
- **SC-002**: With ordering on, cloud database reads caused by store and product page views still stay under 5% of
  page views during a 2,000-visit burst (002 SC-002 unchanged); only checkout, submission and status checks reach the
  cloud.
- **SC-003**: 100% of WhatsApp order messages in automated tests contain exactly the cart's lines, quantities, prices
  and totals.
- **SC-004**: 100% of submitted orders are priced from the shop's catalog in automated tests where the browser sends
  altered prices; no order is ever created at a visitor-supplied price.
- **SC-005**: A new order is visible and notified on every online register of the shop within 1 minute in 95% of
  measurements, and the customer's status page reflects the shop's answer within 1 minute.
- **SC-006**: In repeated concurrent-action tests (two registers acting on one order), every order ends in exactly one
  consistent state and produces at most one POS sale.
- **SC-007**: For converted orders, stock, invoices, payments, balances, cash drawer and settlement totals equal those
  of the same sale typed by hand, in 100% of automated comparisons (live and settled data).
- **SC-008**: Retried or duplicated submissions create zero duplicate orders in automated tests.
- **SC-009**: Abuse limits refuse 100% of submissions beyond the per-phone limits in automated tests, while a normal
  customer placing 3 orders in a day is never refused.
- **SC-010**: A shop that never turns ordering on sees no change in its storefront or back office after upgrading.

## Assumptions

- Customers in Lebanon expect to pay cash (USD or LBP) on pickup or delivery; no payment gateway is needed in 003.
- Guest checkout (name + phone) is enough; accounts would add friction and passwords without solving a problem shops
  have today. Order history per customer is per device ("My orders") plus each order's private link.
- The shop informs the customer of changes by WhatsApp or phone from the back office's buttons (opening the cashier's
  own WhatsApp); automatic SMS, WhatsApp or email notifications to customers need a paid messaging provider and are a
  later integration (blueprint §31).
- The shop's registers are online most of the time; ordering-related actions need internet, selling does not.
- Order data lives in the cloud first (the storefront has no other place to write) and is synced down to the
  registers for display; registers act on it through the cloud so the first action wins.
- Stock is never reserved by orders; the shop is the final judge of availability at acceptance.
- The order number is per store (e.g. `W-1042`); the private status link uses a separate unguessable key.
- Retention: orders are business records kept like invoices; customer contact data on orders is not used for anything
  else (no marketing lists) in this feature.
- Hosting: the order submission and status page run on the existing storefront service; their traffic is small
  compared with page views.
- Fractional (weight) quantities follow the product's POS rules.
