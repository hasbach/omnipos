# Feature Specification: Commerce Domain Foundation

**Feature Branch**: `001-commerce-domain-foundation`

**Created**: 2026-10-04

**Status**: Draft

**Input**: User description: "Commerce Domain Foundation (Feature 001 of OmniPOS_Marketplace_Supply_Chain_Master_Blueprint.md,
sections 5-33, 37, 43). Define, for the existing multi-tenant OmniPOS, the commerce domain that every later feature
builds on — with NO storefront or marketplace UI. Settle business roles, business relationships and their mapping to
customers/suppliers, store and store-listing model, order and order-line model with ordered/confirmed/shipped/received
quantities, order state machine, shortage reasons, shipment and goods-receipt models, inventory/invoice/payment/balance
posting through the existing engines, tenant isolation and relationship-scoped access, permissions, audit, local vs
cloud data and conflict rules, backward compatibility and migration, and the domain invariants as acceptance tests."

## Overview

OmniPOS today is a POS, inventory and financial system for a single business (tenant). This feature establishes the
commerce layer **on top of** that core — the shared vocabulary, records, rules and guarantees that the later features
(online store, B2C ordering, B2B relationships, wholesale store, purchase orders, receiving, financial integration,
supply chain, marketplace) will use. It delivers a working, tested domain that back-office staff can exercise through
minimal management screens, but **no public storefront, checkout or marketplace**.

The guiding rule: a commerce order never replaces the existing engines. Stock still changes only through the existing
inventory ledger, money still becomes an invoice, payment and derived customer/supplier balance exactly as today, and
an existing shop that never turns commerce on sees no change at all.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Existing shops keep working unchanged (Priority: P1)

A shop owner on OmniPOS 1.7.x upgrades to the version containing the commerce foundation. They never enable commerce.
Their POS, invoices, purchases, stock, customer and supplier balances, settlement and reports behave exactly as before.

**Why this priority**: OmniPOS auto-updates on live registers. Any regression costs merchants money; the foundation is
worthless if it breaks the core.

**Independent Test**: Upgrade a copy of a real tenant database, run the full existing regression suite and compare
all counts, totals, stock levels and every customer/supplier balance before and after.

**Acceptance Scenarios**:

1. **Given** a tenant with sales, purchases, refunds, settled days and open balances, **When** the upgrade runs,
   **Then** every product, stock level, invoice total, payment and customer/supplier balance is identical afterwards.
2. **Given** an upgraded tenant that has not enabled commerce, **When** a cashier rings up sales, takes balance
   payments and closes the day, **Then** results, receipts and reports are identical to the previous version.
3. **Given** an upgraded tenant, **When** an admin opens Settings, **Then** commerce is shown as off and no store,
   relationship or order is created automatically.

---

### User Story 2 - Link two OmniPOS businesses in an explicit trading relationship (Priority: P1)

A wholesaler (Business A) and a mini market (Business B) both run OmniPOS. The mini market requests a relationship;
the wholesaler approves it and sets the commercial terms: price level "Wholesale", credit limit $1,000, payment terms
Net 30, minimum order $100, and which products the mini market may order. On the wholesaler's side, the mini market
appears as a **business customer**; on the mini market's side, the wholesaler appears as a **business supplier**.

**Why this priority**: every B2B and supply-chain flow depends on an authorized relationship; it is also the security
boundary between tenants.

**Independent Test**: Create two tenants, request and approve a relationship, then verify each side sees only the
counter-party record and terms intended for it, and that unrelated tenants see nothing.

**Acceptance Scenarios**:

1. **Given** two tenants with no relationship, **When** B tries to view A's catalog, prices, orders or balance,
   **Then** access is refused.
2. **Given** B requested a relationship, **When** A approves it with terms, **Then** a relationship with status
   Active, effective date and the terms exists, A has a business customer linked to B, and B has a business supplier
   linked to A.
3. **Given** an existing individual customer record "ABC Mini Market" at A, **When** A approves B's request,
   **Then** A can choose to link the relationship to that existing record so its history and balance are kept, instead
   of creating a duplicate.
4. **Given** an active relationship, **When** A suspends or ends it, **Then** B can no longer place new orders, while
   existing orders, invoices and balances remain visible to both sides for their own records.
5. **Given** A and B both buy from and sell to each other, **When** both directions are set up, **Then** they are two
   separate relationships, each with its own seller, buyer and terms.

---

### User Story 3 - Order lifecycle with separate ordered, confirmed, shipped and received quantities (Priority: P1)

The mini market sends an order for Coca-Cola ×10, Pepsi ×10 and Water ×20 cartons. The wholesaler confirms Coca-Cola
10, Pepsi 6 (supplier out of stock), Water 20; ships Coca-Cola 10, Pepsi 4, Water 20; the mini market receives
Coca-Cola 10, Pepsi 3 (1 damaged), Water 20. Both businesses can see, for every line, all four quantities, the
difference at each step and the reason for each shortage.

**Why this priority**: preserving "what was ordered vs confirmed vs shipped vs received" is the central promise of the
blueprint; every later feature records data in this shape.

**Independent Test**: Drive one order through each state transition with partial quantities and check the stored
quantities, shortages, reasons, state and history at each step.

**Acceptance Scenarios**:

1. **Given** a submitted order, **When** the seller confirms fewer units on a line, **Then** ordered stays 10,
   confirmed becomes 6, and the 4-unit difference is recorded with a reason (e.g. supplier out of stock).
2. **Given** a confirmed order, **When** only part of the confirmed quantity is shipped, **Then** the order becomes
   Partially Fulfilled and the remainder is either kept open as Backordered or cancelled, as the seller chooses.
3. **Given** a shipment, **When** the buyer records 3 received out of 4 shipped with reason Damaged, **Then** the line
   shows "1 shipped but not received (damaged)" separately from "6 not shipped" and "4 not confirmed".
4. **Given** any line, **When** someone tries to record received > shipped, shipped > confirmed or confirmed > ordered,
   **Then** the change is rejected unless it goes through the explicit over-receipt/over-ship exception (see FR-024).
5. **Given** a line ordered in cartons (1 carton = 24 pieces), **When** it is received, **Then** the order keeps the
   carton unit and quantity, and stock increases by the equivalent base pieces.
6. **Given** an order in any state, **When** a user views its history, **Then** every change of state and quantity is
   listed with who, when, previous value, new value, reason and source document.

---

### User Story 4 - Stock and money post only through the existing engines, at explicit events (Priority: P1)

When the mini market confirms a goods receipt, its stock increases through the existing inventory ledger with the
receipt as the source, and a purchase invoice is created for the received quantities at the agreed prices. On the
wholesaler side, the shipment decreases stock and creates the matching sales invoice. Both customer/supplier balances
reflect the same obligation; paying it reduces both. Nothing is posted when the order is only submitted or confirmed.

**Why this priority**: silent changes to stock or money semantics are the costliest possible failure (Constitution
Principle I).

**Independent Test**: Run the Pepsi example end-to-end and verify stock ledger entries, invoices, payments and both
balances against hand-computed values, including after a settlement.

**Acceptance Scenarios**:

1. **Given** a submitted or confirmed order, **When** nothing has shipped, **Then** no stock movement, invoice or
   balance change exists on either side.
2. **Given** a shipment is dispatched, **When** it is confirmed by the seller, **Then** the seller's stock decreases by
   the shipped base quantity via the inventory ledger, each movement referencing the shipment.
3. **Given** a goods receipt is confirmed, **When** the posting policy is "invoice on received quantity", **Then** the
   buyer's stock increases by received base quantity and both businesses hold one invoice each for received quantity ×
   agreed price, linked to the same order.
4. **Given** an invoice of $500 and a payment of $200 allocated to it, **When** either side views the account,
   **Then** outstanding is $300 on both sides, computed as posted obligations minus allocated payments.
5. **Given** a commerce invoice, **When** the day is settled, **Then** the balance effect is banked exactly like any
   other invoice and the order still links to its invoice and payments.
6. **Given** a posted receipt, **When** someone edits the received quantity, **Then** the change goes through the
   existing audited invoice-edit path and stock is corrected with a new traceable movement, never by overwriting.

---

### User Story 5 - Store and store listings layered over existing products (Priority: P2)

The wholesaler activates a store (name, slug, mode Wholesale) and publishes 200 of its 1,500 products as listings with
an online title, description, images, category, minimum quantity and orderable units. Prices, stock and units still
come from the product itself; nothing is duplicated.

**Why this priority**: needed by every channel feature, but no buyer-facing store is part of this feature, so it ranks
below the relationship and order core.

**Independent Test**: Activate a store, publish and unpublish listings, change the product's price and confirm the
listing reflects it without separate editing.

**Acceptance Scenarios**:

1. **Given** a tenant with commerce off, **When** nothing is configured, **Then** no store exists.
2. **Given** an active store, **When** a product is published, **Then** a listing exists that references the product;
   the product is not copied.
3. **Given** a listed product, **When** its price, units or stock change in the back office, **Then** the listing
   shows the new values with no further action.
4. **Given** a product that is disabled or deleted, **When** a listing references it, **Then** the listing becomes
   unavailable automatically.
5. **Given** a store in mode Retail, Wholesale or Hybrid, **When** a relationship buyer or a public visitor asks for a
   price, **Then** the price comes from the existing price-level rules for that buyer (retail for public visitors).

---

### User Story 6 - Cross-tenant privacy holds under every path (Priority: P1)

A buyer business can see only what the relationship exposes to it: listed products, its own prices, its own orders,
invoices and balance. It never sees the seller's costs, other customers, unrelated invoices, unpublished stock or
internal reports — and an unrelated tenant sees nothing.

**Why this priority**: a privacy leak between competing businesses would end the product (Constitution Principle II).

**Independent Test**: For every commerce read path, attempt access as the owner, as a related buyer, as a suspended
buyer and as an unrelated tenant, and compare the returned fields against an allow-list.

**Acceptance Scenarios**:

1. **Given** an active relationship, **When** the buyer views a listed product, **Then** cost, purchase price, supplier
   and exact stock are never included (only an availability indicator if the seller exposes it).
2. **Given** tenant C has no relationship with A, **When** C requests any of A's commerce data, **Then** access is
   refused and the attempt is logged.
3. **Given** a staff user at A without the new commerce permissions, **When** they try to confirm an order, **Then**
   the server refuses it, regardless of what the screen showed.

---

### User Story 7 - Offline registers and cloud commerce do not corrupt each other (Priority: P2)

The wholesaler's POS keeps selling while the internet is down. Meanwhile a B2B order for the same product is confirmed
in the cloud. When connectivity returns, stock and money stay correct, and any genuine conflict (e.g. not enough
stock left for a confirmed quantity) is surfaced to a person instead of silently overwritten.

**Why this priority**: required for correctness, but the buyer-facing flows that create heavy concurrency arrive in
later features.

**Independent Test**: Simulate offline POS sales and concurrent commerce confirmations against the same stock and
balances, reconnect, and verify totals plus a recorded conflict.

**Acceptance Scenarios**:

1. **Given** an offline register, **When** it sells items that a commerce order has also committed, **Then** the
   sale is never blocked; after sync, the commerce order shows the shortage for a person to resolve.
2. **Given** two changes to the same order quantity from different places, **When** they meet, **Then** neither is
   silently discarded; the later one is rejected with a clear conflict message or queued for review.
3. **Given** a register without internet, **When** a user opens an order and tries to confirm, ship or receive it,
   **Then** the action is unavailable with an "offline" message and the last-synced order is shown read-only.

---

### Edge Cases

- Confirmed quantity of 0 on a line: the line is shown as fully short with a reason, and the order continues.
- All lines confirmed at 0: the order becomes Rejected (seller) rather than Confirmed.
- Buyer cancels after partial shipment: only unshipped quantities are cancelled (Partially Cancelled); shipped goods
  still need receiving or a return.
- Shipment never received: the line remains "shipped, not received" until received, reported short, or written off
  with a reason; it never disappears.
- Over-delivery (supplier ships 12 against 10 confirmed): only possible through the explicit exception with reason and
  permission; otherwise rejected.
- Substitution (different product shipped): recorded as a short on the original line plus a new line marked as a
  substitute, so both are traceable.
- Relationship ends with open orders: open orders can be completed or cancelled; no new orders accepted.
- Credit limit would be exceeded at confirmation: the seller is warned and the existing credit-limit setting decides
  whether confirmation is blocked.
- Price changes between submit and confirm: the line keeps the price at submission; the seller may change it at
  confirmation with a reason, which the buyer sees.
- Unit removed from a product after it was ordered: the order line keeps its unit, conversion and price as ordered.
- A tenant's data reset (Danger zone) touches only that tenant's side of each commerce record; the counter-party keeps
  its own invoices and balances.
- Settlement of a day with commerce invoices: invoices and their order links survive archiving.
- Same product listed in several stores of one tenant: one product, several listings.
- Currency: an order priced in local currency stores the rate used, as payments do today.

## Requirements *(mandatory)*

### Functional Requirements

**Business and roles**

- **FR-001**: Each existing tenant MUST be representable as a Business with zero or more roles from: Manufacturer,
  Importer, Distributor, Wholesaler, Retailer, Service, Other. Roles are descriptive and MUST NOT change what the
  business is allowed to do; permissions come from relationships and user roles.
- **FR-002**: Commerce MUST be off by default for every existing and new tenant and enabled only by an admin.

**Business relationships**

- **FR-003**: A Business Relationship MUST link exactly one seller business and one buyer business, with status
  (Requested, Active, Suspended, Ended, Rejected), effective-from and optional effective-to dates.
- **FR-004**: A relationship MUST carry the seller-defined terms: price level, credit limit, payment terms (e.g. Net
  N days), minimum order value, minimum order quantity, allowed products (all listed products or an explicit
  selection), delivery notes and free-text notes.
- **FR-005**: A relationship MUST become Active only by explicit approval of the seller (requests by the buyer or
  invitations by the seller both require the other side to accept).
- **FR-006**: On the seller's side the buyer MUST be represented by a customer record of kind "business", and on the
  buyer's side the seller by a supplier record of kind "business"; existing individual records MUST remain valid and
  MAY be linked to a relationship instead of creating a new record.
- **FR-007**: For orders placed through a relationship, the relationship's terms MUST be the authoritative commercial
  context (price level, credit limit, payment terms), taking precedence over the local customer record's defaults.
- **FR-008**: Two businesses trading in both directions MUST be modelled as two independent relationships.
- **FR-009**: Suspending or ending a relationship MUST block new orders and B2B access, but MUST NOT delete or alter
  existing orders, invoices, payments or balances.

**Stores and listings**

- **FR-010**: A tenant MAY have one or more Stores, each with name, unique slug, mode (Retail, Wholesale, Hybrid),
  branding, and ordering settings; no store is created automatically.
- **FR-011**: A Store Listing MUST reference an existing product (never copy it) and hold only channel data: published
  flag, online title, description, images, store category, orderable units, minimum quantity and ordering
  restrictions.
- **FR-012**: Listing prices, units, conversion factors and availability MUST be derived from the product and the
  existing price-level rules at the time of the request.
- **FR-013**: A listing whose product is disabled, deleted or excluded from a relationship MUST be unavailable for
  ordering through that path.

**Orders and lines**

- **FR-014**: One order model MUST serve both sales orders (seller view) and purchase orders (buyer view) of the same
  commercial transaction, for B2B and, later, B2C; there MUST NOT be separate implementations per business type.
- **FR-015**: Each order line MUST store product, ordered unit, conversion factor to base unit, unit price at the time
  of ordering, and four separate quantities: ordered, confirmed, shipped, received. None of these MAY be overwritten
  to represent another.
- **FR-016**: Each shortfall between consecutive quantities MUST be recorded with a reason from: Supplier out of
  stock, Partially fulfilled, Customer reduced quantity, Damaged, Cancelled, Substituted, Backordered, Other — plus
  optional notes.
- **FR-017**: Orders MUST follow this state machine:
  Draft → Submitted → Confirmed → (Partially Fulfilled) → Shipped → (Partially Received) → Received →
  Financially Settled, with exception states Rejected, Cancelled, Expired, Backordered and Partially Cancelled.
  Transitions not in the allowed set MUST be rejected. Not every order passes through every state.
- **FR-018**: The order state MUST be derivable from its line quantities and documents (e.g. Partially Received when
  some but not all shipped quantity is received) and MUST stay consistent with them.
- **FR-019**: Submitted orders older than a seller-configurable period without confirmation MUST move to Expired.

**Shipments and goods receipts**

- **FR-020**: A Shipment MUST belong to one order, list the shipped quantity per line, and support several shipments
  per order (partial fulfillment).
- **FR-021**: A Goods Receipt MUST belong to one shipment, propose received = shipped per line, and let the receiver
  change quantities, mark lines not received, record shortage/damage reasons and notes, then confirm.
- **FR-022**: Only a confirmed goods receipt MAY post stock or financial effects on the buyer's side; drafts MUST have
  no effect.

**Posting into the existing engines**

- **FR-023**: Every stock change caused by commerce MUST go through the existing inventory ledger as a movement that
  references its source document (shipment, goods receipt, return or adjustment) and be expressed in base units.
- **FR-024**: Received ≤ shipped ≤ confirmed ≤ ordered MUST hold for every line, except through an explicit
  over-delivery exception that requires a permission, a reason and an audit entry.
- **FR-025**: Financial posting MUST create invoices and payments through the existing invoice and payment engines,
  so customer/supplier balances stay derived and settlement, refunds, reports and audit history apply unchanged.
- **FR-026**: The financial posting event MUST be an explicit, per-relationship setting. The default MUST be
  "invoice the received quantity when the buyer confirms the goods receipt"; the alternatives "shipped quantity at
  shipment confirmation" and "confirmed quantity at order confirmation" MAY be selected per relationship by the
  seller. The active policy MUST be visible to both sides and recorded on each order when it is submitted.
- **FR-026a**: Under the default policy, a shipment not received within a seller-configurable period (default 7 days)
  MUST be shown to both sides as "awaiting receipt"; after that period the seller MAY request auto-confirmation, which
  records received = shipped with reason "auto-confirmed after N days" in the audit history and then posts as a normal
  receipt.
- **FR-027**: One commercial event MUST produce exactly one invoice on each side (seller's sales invoice and buyer's
  purchase invoice), linked to the same order and to each other; replays or retries MUST NOT create duplicates.
- **FR-028**: Outstanding balance for a relationship MUST equal posted obligations minus allocated payments, and the
  seller's receivable MUST equal the buyer's payable for the same relationship.
- **FR-029**: Submitting or confirming an order MUST NOT change stock or balances; confirmed quantities MAY be shown
  as "committed" for information only.
- **FR-030**: Corrections after posting MUST use the existing audited invoice-edit and refund/return paths and MUST
  create new traceable stock movements rather than altering past ones.

**Security, permissions and audit**

- **FR-031**: Every commerce record MUST belong to a tenant; cross-tenant reads and writes MUST be authorized against
  an Active relationship and limited to an explicit allow-list of fields.
- **FR-032**: The following MUST never be exposed to another tenant: product cost and purchase price, suppliers,
  other customers, unrelated invoices, exact stock unless the seller opts in, internal reports and user data.
- **FR-033**: New permissions MUST extend the existing role system: store (view, manage, publish), orders (view,
  create, confirm, cancel, fulfill), shipments (view, create, edit), receiving (view, create, confirm), business
  relationships (view, create, approve, manage), B2B pricing (view, manage). Admin gets all; other roles get none
  until granted, so existing users' access is unchanged.
- **FR-034**: Every change to price, quantity, customer, supplier, payment, credit terms, order status, shipped
  quantity, received quantity, invoice amount, payment allocation or stock MUST be audited with who, when, what,
  previous value, new value, reason and source document.
- **FR-035**: Refused cross-tenant access attempts MUST be logged.

**Local vs cloud data**

- **FR-036**: Operational data (POS sales, local stock ledger, cash flow, settlement) MUST remain local-first and
  fully usable offline.
- **FR-037**: Commerce data shared between two tenants (relationships, orders, shipments, receipts) MUST have a single
  authoritative copy that both sides read and change.
- **FR-037a**: Commerce actions (request/approve relationships, submit, confirm, cancel, ship, receive, post) MUST
  require a live connection to that authoritative copy and MUST NOT be queued offline. While offline, commerce screens
  MUST show the last-synced state read-only with a clear "offline" indication; POS selling and all existing operations
  stay fully available offline.
- **FR-038**: Conflicts on stock, order quantities, invoices, payments, customers and products MUST NOT be resolved by
  silent last-write-wins; each conflict MUST be rejected with a clear message or held for a person to resolve.

**Migration and compatibility**

- **FR-039**: The upgrade MUST be additive: existing products, customers, suppliers, price levels, units, stock,
  invoices, payments, balances, settlements and reports MUST be unchanged by it.
- **FR-040**: Existing tenants MUST not need any action after upgrade; every new setting MUST default to today's
  behaviour.
- **FR-041**: All new user-visible text MUST be available in English, Arabic and French.

**Scope boundary**

- **FR-042**: This feature MUST NOT include a public storefront, consumer checkout, B2B store front-end, marketplace
  discovery, payment gateways, delivery management or notifications beyond in-app status; it provides the domain,
  rules, back-office management of relationships/stores/listings/orders/shipments/receipts and the tests that later
  features rely on.

### Key Entities

- **Business**: an existing tenant seen as a trading party; has composable roles and commerce on/off.
- **Business Relationship**: directed seller→buyer link between two businesses with status, effective dates, terms
  (price level, credit limit, payment terms, minimums, allowed products) and posting policy; linked to a business
  customer on the seller side and a business supplier on the buyer side.
- **Customer / Supplier (existing)**: gains a kind (individual or business) and an optional link to a relationship;
  remains the record that invoices, payments and balances attach to.
- **Store**: a tenant's sales channel with slug, mode (Retail/Wholesale/Hybrid), branding and ordering settings.
- **Store Listing**: publication of one existing product in one store with channel-only data.
- **Order**: one commercial transaction between a seller and a buyer (sales order to one, purchase order to the
  other), with state, relationship, currency and rate, totals, and links to shipments, receipts, invoices, payments.
- **Order Line**: product, unit and conversion, price, ordered/confirmed/shipped/received quantities, shortage
  reasons and notes.
- **Shipment**: a dispatch of part or all of an order, with per-line shipped quantities.
- **Goods Receipt**: the buyer's confirmed count of a shipment, with per-line received quantities and reasons.
- **Inventory Movement (existing ledger)**: gains a reference to its commerce source document.
- **Invoice / Payment (existing)**: gain a link to the originating order and to the counter-party's matching invoice.
- **Commerce Audit Entry**: who, when, entity, field, previous value, new value, reason, source document.
- **Sync Conflict**: a recorded disagreement on stock, quantity or money awaiting resolution by a person.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After upgrade, 100% of existing regression tests pass and a dry-run on a copy of a real tenant database
  shows zero differences in product counts, stock levels, invoice totals, payments and every customer/supplier balance.
- **SC-002**: For the blueprint's Pepsi and Water-carton scenarios, the system reports ordered, confirmed, shipped,
  received and every shortage with its reason exactly as hand-computed, on both businesses' screens.
- **SC-003**: 100% of commerce-caused stock changes can be traced from the stock ledger to their source document in
  one step.
- **SC-004**: For every relationship, the seller's receivable equals the buyer's payable at all times in automated
  tests, including after partial payments, edits, returns and settlement.
- **SC-005**: Automated tests attempting cross-tenant access through every commerce read and write path succeed 0
  times without an Active relationship, and 0 forbidden fields (cost, other customers, internal reports) are ever
  returned to a related buyer.
- **SC-006**: Every attempt to break the quantity order (received ≤ shipped ≤ confirmed ≤ ordered) outside the
  exception path is rejected in automated tests.
- **SC-007**: An admin can set up a relationship with terms, publish 20 listings and walk one order from submission to
  confirmed receipt in under 15 minutes using only the back office.
- **SC-008**: POS selling, balance payments and day closing remain fully available during a 24-hour internet outage
  with commerce enabled.

## Assumptions

- "Business" maps one-to-one to an existing OmniPOS tenant; no new company concept is introduced.
- Existing customer and supplier records stay the anchor for invoices, payments and balances; commerce adds a
  "business" kind and a link, never a parallel ledger.
- Default posting rules for stock: the seller's stock decreases when a shipment is confirmed; the buyer's stock
  increases when a goods receipt is confirmed. Orders do not reserve stock; confirmed quantity is informational.
- One shared commerce order produces mirrored records on both tenants; each tenant posts to its own ledger from the
  same event, guarded so retries cannot duplicate.
- Prices are fixed per line at submission; changes at confirmation require a reason and are visible to the buyer.
- Amounts follow the existing currency model (USD accounting base, local currency with recorded rate).
- B2C ordering, public storefronts, marketplace discovery, delivery, payment gateways and external notifications are
  later features (002–011) and out of scope here.
- Shared commerce records live in the existing cloud project, protected by the same per-tenant access rules; this
  makes commerce features available only to tenants with an online license.
- The order-expiry period defaults to 14 days and can be changed per store.

## Clarifications

### Session 2026-10-04

- Q: Default invoicing point for B2B orders? → A: Received quantity, when the buyer confirms the goods receipt
  (per-relationship override to shipped or confirmed quantity allowed). See FR-026, FR-026a.
- Q: Can commerce orders be acted on offline? → A: No — commerce actions require a connection; POS selling stays
  offline-capable and commerce screens are read-only while offline. See FR-037a.
