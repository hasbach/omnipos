# OmniPOS Marketplace & Supply-Chain Master Blueprint

## 1. Document Purpose

This document is the master product and architecture blueprint for
evolving OmniPOS from a multi-tenant POS SaaS into a connected commerce
and supply-chain platform.

The existing OmniPOS application remains the operational foundation. The
new platform must extend it without replacing or breaking existing POS,
inventory, customer/supplier, financial, permissions, settlement,
reporting, cloud-sync, and multi-terminal functionality.

The target evolution is:

``` text
Current OmniPOS
POS + Inventory + Financial Operations
        |
        v
OmniPOS Commerce
POS + Online Stores
        |
        v
OmniPOS B2B
Business-to-Business Ordering
        |
        v
OmniPOS Supply Chain
Manufacturer -> Importer -> Distributor -> Wholesaler -> Retailer
        |
        v
OmniPOS Marketplace
Businesses discover and transact with other businesses
        |
        v
OmniPOS Network
Connected commercial ecosystem
```

The central product idea is:

> OmniPOS should know what was ordered, what was confirmed, what was
> shipped, what was actually received, what entered inventory, what was
> invoiced, what was paid, and what remains owed.

------------------------------------------------------------------------

# 2. Existing OmniPOS Baseline

The current roadmap establishes a substantial foundation that the new
platform must reuse.

Existing capabilities include:

-   Multi-tenant architecture.
-   POS sales.
-   Purchase entry.
-   Products and categories.
-   Customers and suppliers.
-   Inventory and stock movement ledger.
-   Units of measure including packs/cartons with their own barcodes and
    prices.
-   Retail, wholesale and super-wholesale price levels.
-   Customer-specific price levels.
-   Customer credit limits.
-   Invoices and invoice editing with audit history.
-   Refunds and store credit.
-   Customer/supplier balances.
-   Payment recording.
-   Cash flow.
-   Settlement.
-   Roles and permissions.
-   Multiple open sales / POS sale tabs.
-   Multi-terminal operation.
-   Cloud synchronization.
-   Import wizard for products, customers and suppliers.
-   Reports and inventory valuation.
-   Stock adjustments with reasons.
-   Arabic/French/RTL support.
-   Local/offline-oriented POS architecture.

The new platform must treat these capabilities as existing
infrastructure, not recreate them unnecessarily.

------------------------------------------------------------------------

# 3. Product Vision

OmniPOS will become a platform where every participating business can
operate its physical POS and optionally expose a digital storefront.

A business may act as one or more of:

-   Manufacturer.
-   Importer.
-   Distributor.
-   Wholesaler.
-   Retailer.
-   Convenience store / mini market.
-   Restaurant or other retail/service business.

A business can simultaneously be:

-   A seller to customers.
-   A buyer from suppliers.
-   A wholesaler selling to retailers.
-   A retailer selling to consumers.
-   A manufacturer selling to wholesalers.
-   An importer selling to distributors or wholesalers.

The platform must therefore model business relationships independently
from business type.

------------------------------------------------------------------------

# 4. Core Architectural Principle

The system should be divided conceptually into four layers.

``` text
OMNIPOS CORE
------------------------------------------------
Products
Inventory
Customers
Suppliers
Invoices
Payments
Balances
POS
Reports
Users
Permissions
Settlement


COMMERCE CORE
------------------------------------------------
Business relationships
Stores
Store listings
Orders
Order lines
Fulfillment
Shipments
Receipts


SUPPLY-CHAIN CORE
------------------------------------------------
Purchase orders
Goods receipts
Short shipments
Backorders
Supplier relationships
Business pricing
Payment terms
Credit


CHANNELS
------------------------------------------------
Physical POS
B2C Store
B2B Store
Marketplace
Future mobile/API channels
```

The POS is one operational channel of the platform, not the definition
of the entire platform.

------------------------------------------------------------------------

# 5. Fundamental Domain Model

## 5.1 Business

A Business represents an OmniPOS tenant/company.

Possible business roles:

``` text
MANUFACTURER
IMPORTER
DISTRIBUTOR
WHOLESALER
RETAILER
SERVICE
OTHER
```

Roles must be composable. A business may have multiple roles.

A business owns or controls:

-   Products.
-   Inventory.
-   Stores.
-   Customers.
-   Suppliers.
-   Employees/users.
-   Price rules.
-   Commercial relationships.
-   Orders.
-   Financial records.

------------------------------------------------------------------------

## 5.2 Business Relationship

A Business Relationship represents an explicit commercial relationship
between two businesses.

Example:

``` text
Wholesaler A
    <---- commercial relationship ---->
Mini Market B
```

The relationship may define:

-   Relationship status.
-   Buyer/seller role.
-   Price level.
-   Customer-specific pricing.
-   Credit limit.
-   Payment terms.
-   Minimum order value.
-   Minimum order quantity.
-   Allowed products.
-   Delivery rules.
-   Notes.
-   Effective dates.
-   Relationship-specific permissions.

A business must not automatically gain access to another business's
private data simply because both use OmniPOS.

------------------------------------------------------------------------

# 6. Customer and Supplier Model

The current customer/supplier concepts should be preserved while
allowing a business to represent another OmniPOS business.

A business can therefore have:

``` text
Individual Customer
Business Customer
Individual Supplier
Business Supplier
```

For OmniPOS-to-OmniPOS transactions, the business relationship should
provide the authoritative commercial context.

Example:

``` text
Wholesaler
  |
  +-- Business Customer: ABC Mini Market
       |
       +-- Price Level: Wholesale
       +-- Credit Limit: $1,000
       +-- Payment Terms: Net 30
       +-- Minimum Order: $100
```

------------------------------------------------------------------------

# 7. Product Architecture

The existing product model remains the source of truth for operational
product data.

The commerce layer adds store-specific publication.

``` text
Product
   |
   +-- Store Listing
         |
         +-- Published / unpublished
         +-- Online title
         +-- Online description
         +-- Images
         +-- Category
         +-- Online availability
         +-- Retail price
         +-- Wholesale price
         +-- Customer-specific price rules
         +-- Minimum quantity
         +-- Ordering restrictions
```

A product must not need to be duplicated simply because it is sold
through multiple channels.

------------------------------------------------------------------------

# 8. Units of Measure

Units of measure are important to B2B commerce.

A product may be sold as:

``` text
Piece
Pack
Carton
Case
Box
```

Each unit may have:

-   Barcode.
-   Conversion factor.
-   Selling price.
-   Purchase price.
-   Inventory conversion.

Example:

``` text
1 carton = 24 pieces
```

The order and receiving system must preserve the selected unit and
correctly translate quantities into the inventory base unit.

------------------------------------------------------------------------

# 9. Store Architecture

Every business may optionally activate an online store.

The store should be a presentation/channel layer over the existing
OmniPOS data.

Example:

``` text
Business
   |
   +-- Store
        |
        +-- Categories
        +-- Published Products
        +-- Prices
        +-- Branding
        +-- Ordering settings
```

Potential URL architecture:

``` text
store.omnipos.com/business-slug
```

or, in a later stage:

``` text
business-slug.omnipos.com
```

Custom domains may be added later.

------------------------------------------------------------------------

# 10. Store Modes

Do not create separate store engines for retail and wholesale.

Use one Store engine with multiple modes.

``` text
RETAIL
WHOLESALE
HYBRID
```

## Retail Mode

Designed for consumers.

Features may include:

-   Product browsing.
-   Cart.
-   Checkout.
-   Delivery/pickup.
-   Customer account.
-   Payment.
-   Order tracking.

## Wholesale Mode

Designed for business customers.

Features may include:

-   Business login.
-   Customer-specific prices.
-   Wholesale prices.
-   Pack/carton ordering.
-   Minimum quantities.
-   Credit limit visibility.
-   Outstanding balance.
-   Previous orders.
-   Reordering.
-   Purchase orders.
-   Payment terms.

## Hybrid Mode

The same business can serve both retail consumers and business
customers.

------------------------------------------------------------------------

# 11. B2C Commerce Flow

The standard consumer flow is:

``` text
Customer
    |
    v
Online Store
    |
    v
Browse Products
    |
    v
Cart
    |
    v
Checkout
    |
    v
Sales Order
    |
    v
Business Fulfillment
    |
    v
Shipment / Pickup
    |
    v
Payment
```

The exact point at which inventory and financial records are affected
must be explicitly defined by the implementation specification.

An order should not automatically be treated as a finalized invoice
merely because it was submitted.

------------------------------------------------------------------------

# 12. B2B Commerce Flow

The B2B workflow is fundamentally different from ordinary consumer
checkout.

``` text
Buyer Business
      |
      v
Supplier Store
      |
      v
Shopping / Reorder
      |
      v
Purchase Order
      |
      v
Supplier Review
      |
      v
Supplier Confirmation
      |
      v
Fulfillment / Shipment
      |
      v
Buyer Receiving
      |
      v
Actual Received Quantities
      |
      v
Invoice / Financial Posting
      |
      v
Payment
```

This workflow must support partial fulfillment and partial receiving.

------------------------------------------------------------------------

# 13. Order Quantity Lifecycle

Every order line must distinguish at least:

``` text
Ordered Quantity
Confirmed Quantity
Shipped Quantity
Received Quantity
```

Example:

``` text
Ordered:   10
Confirmed:  8
Shipped:   7
Received:  6
```

These values must not be represented by repeatedly overwriting one
quantity.

The history of each quantity state must remain auditable.

------------------------------------------------------------------------

# 14. Order State Machine

The exact state names may be finalized during the Spec Kit clarification
phase, but the conceptual lifecycle is:

``` text
DRAFT
  |
  v
SUBMITTED
  |
  v
CONFIRMED
  |
  v
PARTIALLY_FULFILLED
  |
  v
FULFILLED / SHIPPED
  |
  v
PARTIALLY_RECEIVED
  |
  v
RECEIVED
  |
  v
FINANCIALLY_SETTLED
```

Alternative terminal or exception states include:

``` text
REJECTED
CANCELLED
EXPIRED
BACKORDERED
PARTIALLY_CANCELLED
```

Not every order must pass through every state.

------------------------------------------------------------------------

# 15. Ordered vs Confirmed vs Shipped vs Received

These concepts must remain separate.

Example:

Buyer requests:

  Product       Ordered
  ----------- ---------
  Coca-Cola          10
  Pepsi              10
  Water              20

Supplier confirms:

  Product       Ordered   Confirmed
  ----------- --------- -----------
  Coca-Cola          10          10
  Pepsi              10           6
  Water              20          20

Supplier ships:

  Product       Confirmed   Shipped
  ----------- ----------- ---------
  Coca-Cola            10        10
  Pepsi                 6         4
  Water                20        20

Buyer receives:

  Product       Shipped   Received
  ----------- --------- ----------
  Coca-Cola          10         10
  Pepsi               4          3
  Water              20         20

Final result:

``` text
Pepsi
Ordered: 10
Confirmed: 6
Shipped: 4
Received: 3
Short from shipment: 1
Short from original order: 7
```

This information must be preserved.

------------------------------------------------------------------------

# 16. Shortages and Exceptions

Do not simply label missing quantities as "out of stock."

A shortage may have a reason such as:

``` text
SUPPLIER_OUT_OF_STOCK
PARTIALLY_FULFILLED
CUSTOMER_REDUCED_QUANTITY
DAMAGED
CANCELLED
SUBSTITUTED
BACKORDERED
OTHER
```

A line should be able to record the relevant reason and notes.

Example:

``` text
Ordered: 10
Confirmed: 10
Shipped: 7
Received: 6

Difference:
3 not shipped
1 shipped but not received
```

These are different business events and must not be collapsed into one
number.

------------------------------------------------------------------------

# 17. Receiving Workflow

The buyer should have a dedicated receiving interface.

Example:

``` text
Purchase Order #10452

Product       Ordered   Confirmed   Shipped   Received
-------------------------------------------------------
Coca Cola       10         10         10         10
Pepsi           10          6          4          3
Water           20         20         20         20
```

The receiver can:

-   Accept the suggested received quantity.
-   Change received quantity.
-   Mark a line as not received.
-   Record a shortage.
-   Record damage.
-   Add notes.
-   Confirm the receipt.

Only after confirmation should the relevant inventory transaction be
posted.

------------------------------------------------------------------------

# 18. Inventory Integration

Inventory must remain authoritative within OmniPOS.

Commerce documents create inventory events; they should not bypass the
inventory engine.

Examples:

``` text
Goods Receipt
    ->
Inventory Movement
    ->
+10 Coca Cola
```

Sales fulfillment:

``` text
Fulfillment
    ->
Inventory Movement
    ->
-3 Coca Cola
```

Return:

``` text
Approved Return
    ->
Inventory Movement
    ->
+1 Coca Cola
```

Adjustment:

``` text
Stock Adjustment
    ->
Inventory Movement
    ->
-2 Coca Cola
```

Every movement should remain traceable to its source document.

------------------------------------------------------------------------

# 19. Financial Integration

Financial records must remain separate from order workflow until the
appropriate business event occurs.

Potential lifecycle:

``` text
Purchase Order
     |
     v
Supplier Confirmation
     |
     v
Shipment
     |
     v
Goods Receipt
     |
     v
Purchase Invoice
     |
     v
Payment
```

The precise posting rules must be explicitly defined for each supported
business configuration.

The platform must support:

-   Full payment.
-   Partial payment.
-   Unpaid invoice.
-   Payment allocation.
-   Outstanding balance.
-   Credit.
-   Customer account balance.
-   Supplier account balance.
-   Payment history.

------------------------------------------------------------------------

# 20. Example Financial Flow

Purchase:

``` text
Invoice = $500
```

Payment:

``` text
Paid = $200
```

Remaining:

``` text
Balance = $300
```

The supplier's account should show:

``` text
Invoice        +500
Payment        -200
--------------------
Outstanding    +300
```

The buyer's corresponding supplier balance should represent the same
underlying commercial reality.

The implementation must prevent duplicate or contradictory balance
updates.

------------------------------------------------------------------------

# 21. Customer-Specific Commercial Rules

A business relationship can define:

``` text
Price Level
Credit Limit
Payment Terms
Minimum Order Value
Minimum Order Quantity
Allowed Products
Discount Rules
Delivery Rules
```

Example:

``` text
ABC Mini Market

Price Level: Wholesale
Credit Limit: $1,000
Payment Terms: Net 30
Minimum Order: $100
```

Another customer can have different rules.

The storefront must calculate prices according to the authenticated
business/customer relationship.

------------------------------------------------------------------------

# 22. Business-to-Business Authentication

A B2B customer should not be treated exactly like a public consumer.

A future B2B flow may be:

``` text
Business discovers Supplier
        |
        v
Relationship Request
        |
        v
Supplier Approves
        |
        v
Buyer receives B2B access
        |
        v
Login
        |
        v
Customer-specific store
```

The supplier should control whether the business is allowed to order.

------------------------------------------------------------------------

# 23. Business Relationship Permissions

Relationship access must be explicit.

Example:

``` text
Supplier A
    |
    +-- ABC Mini Market
          |
          +-- Can view wholesale catalog
          +-- Can place purchase orders
          +-- Can view own orders
          +-- Can view own invoices
          +-- Can view own balance
```

The mini market must never gain access to:

-   Supplier's other customers.
-   Supplier's internal costs.
-   Supplier's unrelated invoices.
-   Supplier's private stock data beyond what is intentionally exposed.
-   Supplier's internal financial reports.

------------------------------------------------------------------------

# 24. Manufacturer / Importer / Distributor / Wholesaler Model

Do not create separate implementations for each business type.

Use the same B2B engine.

Example:

``` text
Manufacturer
      |
      | sells to
      v
Wholesaler
      |
      | sells to
      v
Mini Market
      |
      | sells to
      v
Consumer
```

Another network:

``` text
Importer
      |
      v
Distributor
      |
      v
Wholesaler
      |
      v
Retailer
```

The document and transaction mechanisms remain the same.

Only the commercial relationship and business configuration differ.

------------------------------------------------------------------------

# 25. Supply-Chain Network

The long-term architecture is:

``` text
Manufacturer
      |
      v
Importer / Distributor
      |
      v
Wholesaler
      |
      v
Retailer
      |
      v
Consumer
```

Each business operates its own OmniPOS tenant.

OmniPOS connects them through explicit business relationships and
commerce transactions.

The platform should not require all businesses in a supply chain to
share one tenant.

------------------------------------------------------------------------

# 26. Marketplace

The marketplace should be a later layer on top of the B2B network.

Potential capabilities:

-   Search businesses.
-   Discover suppliers.
-   Discover manufacturers.
-   Discover distributors.
-   Discover wholesalers.
-   Search products.
-   View public supplier catalogs.
-   Request a business relationship.
-   Compare available suppliers.
-   Place B2B orders.

Marketplace discovery must respect business privacy and publication
settings.

A business should control:

``` text
Discoverable: yes/no
Catalog public: yes/no
Accept relationship requests: yes/no
Accept online orders: yes/no
```

------------------------------------------------------------------------

# 27. Document Architecture

Core commercial documents should include:

``` text
Product
Store Listing
Sales Order
Purchase Order
Shipment
Goods Receipt
Sales Invoice
Purchase Invoice
Payment
Credit Note
Debit Note
Return
```

The exact document relationships must be finalized during domain
specification.

The goal is to avoid creating independent implementations of the same
concept for B2C, B2B, manufacturer, importer, and wholesaler workflows.

------------------------------------------------------------------------

# 28. Auditability

The platform must preserve a reliable history of changes.

Audit-sensitive fields include:

-   Price.
-   Quantity.
-   Customer.
-   Supplier.
-   Payment.
-   Credit.
-   Order status.
-   Shipment quantity.
-   Received quantity.
-   Invoice amount.
-   Payment allocation.
-   Stock movement.

Important changes should record:

``` text
Who
When
What changed
Previous value
New value
Reason
Source document
```

Existing invoice editing and audit history should be reused rather than
replaced.

------------------------------------------------------------------------

# 29. Multi-Tenant Security

Every feature must respect tenant isolation.

Rules:

1.  A tenant can access its own data.
2.  A business relationship explicitly grants limited access to another
    business's exposed commerce data.
3.  Customer-facing users can access only their own accounts and orders.
4.  B2B users can access only their organization's relationship data.
5.  Marketplace discovery exposes only explicitly published information.
6.  Internal costs and private operational data must never leak through
    public/B2B APIs.
7.  Every cross-business request must be authorized against the
    relationship.

------------------------------------------------------------------------

# 30. Roles and Permissions

Existing roles and permissions must be extended rather than bypassed.

Potential new permissions:

``` text
store.view
store.manage
store.publish

orders.view
orders.create
orders.confirm
orders.cancel
orders.fulfill

shipments.view
shipments.create
shipments.edit

receiving.view
receiving.create
receiving.confirm

business_relationship.view
business_relationship.create
business_relationship.approve
business_relationship.manage

b2b_pricing.view
b2b_pricing.manage

marketplace.view
marketplace.manage
```

Exact permission names are implementation details and should be
finalized by Spec Kit.

------------------------------------------------------------------------

# 31. Notifications

The commerce system should eventually provide notifications for:

-   New order.
-   Order confirmation.
-   Order rejection.
-   Partial fulfillment.
-   Shipment.
-   Goods received.
-   Shortage.
-   Invoice issued.
-   Payment received.
-   Payment overdue.
-   Relationship request.
-   Relationship approved/rejected.

The initial release can use in-app notifications.

Email, WhatsApp, SMS, and push notifications should be separate
integrations later.

------------------------------------------------------------------------

# 32. Offline and Cloud Considerations

The existing POS has local/cloud synchronization.

The new commerce architecture must clearly distinguish:

``` text
LOCAL OPERATIONAL DATA
        vs
CLOUD COMMERCE DATA
```

The physical POS should remain resilient when internet connectivity is
unavailable where current architecture supports offline operation.

However, online marketplace operations inherently require cloud
connectivity.

Conflict resolution rules must be explicitly defined for:

-   stock changes
-   order changes
-   invoice changes
-   payment changes
-   customer changes
-   product changes

Do not allow silent last-write-wins behavior for financial or inventory
conflicts without an explicit business rule.

------------------------------------------------------------------------

# 33. Migration Strategy

Existing OmniPOS tenants must continue functioning after the commerce
upgrade.

Migration principles:

1.  No forced online store activation.
2.  Existing products remain valid.
3.  Existing customers remain valid.
4.  Existing suppliers remain valid.
5.  Existing price levels remain valid.
6.  Existing inventory remains valid.
7.  Existing invoices remain valid.
8.  Existing balances remain valid.
9.  Existing POS workflows remain valid.
10. Existing reports remain valid.

New commerce entities should be introduced in a backward-compatible
manner.

------------------------------------------------------------------------

# 34. Recommended Spec Kit Feature Sequence

## Phase 0 --- Domain Foundation

### Feature 001 --- Commerce Domain Foundation

Define:

-   Business relationships.
-   Commerce entities.
-   Order model.
-   Order lifecycle.
-   Quantity lifecycle.
-   Inventory integration contracts.
-   Financial integration contracts.
-   Tenant boundaries.
-   Permissions.
-   Audit requirements.

No storefront implementation.

------------------------------------------------------------------------

## Phase 1 --- Online Store

### Feature 002 --- Tenant Online Store

Implement:

-   Store activation.
-   Store identity.
-   Store slug.
-   Store branding.
-   Product publishing.
-   Categories.
-   Product pages.
-   Availability.
-   Store settings.

------------------------------------------------------------------------

## Phase 2 --- B2C Ordering

### Feature 003 --- Retail Customer Ordering

Implement:

-   Customer account/guest flow.
-   Cart.
-   Checkout.
-   Sales order.
-   Fulfillment.
-   Pickup/delivery selection.
-   Payment status.
-   Customer order history.

------------------------------------------------------------------------

## Phase 3 --- B2B Relationships

### Feature 004 --- Business-to-Business Relationships

Implement:

-   Business discovery/invitation.
-   Relationship request.
-   Approval.
-   Relationship configuration.
-   Customer-specific price level.
-   Credit limit.
-   Payment terms.
-   Relationship permissions.

------------------------------------------------------------------------

## Phase 4 --- B2B Store

### Feature 005 --- Wholesale Storefront

Implement:

-   B2B authentication.
-   Wholesale pricing.
-   Customer-specific pricing.
-   Units of measure.
-   Minimum quantities.
-   Minimum order value.
-   Reorder.
-   Purchase-order checkout.
-   Account balance display.

------------------------------------------------------------------------

## Phase 5 --- Purchase Order Lifecycle

### Feature 006 --- B2B Order Confirmation & Fulfillment

Implement:

-   Purchase orders.
-   Supplier review.
-   Quantity editing.
-   Confirmation.
-   Partial confirmation.
-   Fulfillment.
-   Shipment.
-   Partial fulfillment.
-   Backorder.
-   Cancellation.

------------------------------------------------------------------------

## Phase 6 --- Receiving

### Feature 007 --- Goods Receiving & Inventory Integration

Implement:

-   Receiving screen.
-   Received quantities.
-   Shortages.
-   Damaged goods.
-   Receiving notes.
-   Receipt confirmation.
-   Inventory movement creation.
-   Receiving audit history.

------------------------------------------------------------------------

## Phase 7 --- Financial Integration

### Feature 008 --- Commerce Accounting Integration

Implement:

-   Invoice creation rules.
-   Payment recording.
-   Partial payments.
-   Payment allocation.
-   Customer balances.
-   Supplier balances.
-   Credit limits.
-   Aging.
-   Account history.

------------------------------------------------------------------------

## Phase 8 --- Supply Chain

### Feature 009 --- Supply Chain Commerce

Generalize the B2B engine for:

``` text
Manufacturer
Importer
Distributor
Wholesaler
Retailer
```

Implement reusable supply-chain workflows rather than
business-type-specific copies.

------------------------------------------------------------------------

## Phase 9 --- Fulfillment

### Feature 010 --- Delivery & Fulfillment

Implement:

-   Shipment management.
-   Delivery orders.
-   Delivery status.
-   Drivers.
-   Delivery zones.
-   Delivery fees.
-   Proof of delivery.
-   Partial delivery.

------------------------------------------------------------------------

## Phase 10 --- Marketplace

### Feature 011 --- OmniPOS Marketplace

Implement:

-   Supplier discovery.
-   Product discovery.
-   Business discovery.
-   Marketplace profiles.
-   Catalog discovery.
-   Relationship requests.
-   B2B ordering from marketplace.

------------------------------------------------------------------------

# 35. Spec Kit Workflow for Every Feature

Each feature should follow:

``` text
/speckit.specify
        |
        v
/speckit.clarify
        |
        v
/speckit.plan
        |
        v
/speckit.checklist
        |
        v
/speckit.tasks
        |
        v
/speckit.analyze
        |
        v
/speckit.implement
        |
        v
/speckit.converge
```

The exact available command names should be verified against the
installed Spec Kit version before execution.

------------------------------------------------------------------------

# 36. Rules for AI Implementation

The AI coding agent must follow these rules.

## Rule 1 --- Inspect before changing

Before implementing a feature, inspect:

-   Existing architecture.
-   Database schema.
-   API routes.
-   Frontend routes.
-   Existing services.
-   Existing models.
-   Existing synchronization mechanisms.
-   Existing permissions.
-   Existing tests.

Do not assume a greenfield architecture.

## Rule 2 --- Reuse existing domain functionality

If OmniPOS already has:

-   Customer balances.
-   Inventory movements.
-   Product pricing.
-   Units.
-   Payments.
-   Invoices.

extend them rather than creating parallel systems.

## Rule 3 --- Do not silently change accounting semantics

Financial behavior must be explicitly specified.

## Rule 4 --- Do not silently change stock semantics

Inventory changes must always have a documented source.

## Rule 5 --- Preserve backward compatibility

Existing POS users must continue operating.

## Rule 6 --- Implement one bounded feature at a time

Do not implement the whole marketplace in one pass.

## Rule 7 --- Test domain invariants

Every feature must test:

-   Tenant isolation.
-   Permissions.
-   Quantity correctness.
-   Stock correctness.
-   Balance correctness.
-   State transitions.
-   Audit behavior.

------------------------------------------------------------------------

# 37. Critical Domain Invariants

The following should become explicit acceptance criteria and automated
tests.

### Inventory

``` text
Inventory changes must be traceable to an inventory event.
```

### Receiving

``` text
Received quantity cannot exceed the allowed shippable quantity
unless an explicit business rule permits it.
```

### Order quantities

``` text
Received <= Shipped <= Confirmed <= Ordered
```

unless a documented exception workflow exists.

### Financials

``` text
Outstanding balance =
posted financial obligations
-
allocated payments
```

The exact accounting model must be finalized before implementation.

### Tenant isolation

``` text
Tenant A cannot access Tenant B's private data.
```

### B2B relationship

``` text
B2B access requires an authorized relationship.
```

### Auditability

``` text
Important commercial changes are traceable.
```

------------------------------------------------------------------------

# 38. Example End-to-End Scenario

## Manufacturer -\> Wholesaler -\> Retailer

### Manufacturer

``` text
Manufacturer A
Product: Water
Wholesale price: $3/carton
```

Wholesaler B has a relationship with Manufacturer A.

``` text
Credit limit: $5,000
Payment terms: Net 30
```

Wholesaler B orders:

``` text
100 cartons
```

Manufacturer confirms:

``` text
100
```

Manufacturer ships:

``` text
95
```

Wholesaler receives:

``` text
93
```

OmniPOS records:

``` text
Ordered: 100
Confirmed: 100
Shipped: 95
Received: 93
```

Inventory:

``` text
Wholesaler inventory
+93 cartons
```

Financial obligation:

``` text
93 cartons x $3 = $279
```

If the commercial configuration invoices shipped quantity instead, the
financial document can instead be based on the appropriate configured
event. This rule must be explicit rather than assumed.

Wholesaler later sells 20 cartons to Retailer C.

Retailer C orders through Wholesaler B's B2B store.

The same order/fulfillment/receiving engine handles the transaction.

------------------------------------------------------------------------

# 39. What Should NOT Be Built Initially

Do not attempt to build all of the following in the first release:

-   Full public marketplace.
-   Advanced delivery routing.
-   Driver application.
-   Payment gateway abstraction for every provider.
-   Complex promotions engine.
-   Supplier bidding/auction system.
-   Advanced demand forecasting.
-   AI purchasing recommendations.
-   Automated procurement.
-   Multi-country tax engine.
-   Full accounting ERP.

The first objective is to establish reliable:

``` text
Business
    ->
Store
    ->
Order
    ->
Fulfillment
    ->
Receipt
    ->
Inventory
    ->
Invoice
    ->
Payment
    ->
Balance
```

------------------------------------------------------------------------

# 40. MVP Definition

The first meaningful marketplace/supply-chain MVP should contain:

``` text
1. Online store
2. Product publishing
3. Retail ordering
4. Business relationships
5. B2B storefront
6. Wholesale pricing
7. Purchase orders
8. Supplier confirmation
9. Partial fulfillment
10. Receiving
11. Partial receiving
12. Inventory integration
13. Invoice integration
14. Payment integration
15. Customer/supplier balances
16. Audit history
17. Tenant isolation
18. Existing POS compatibility
```

Everything else can follow.

------------------------------------------------------------------------

# 41. Long-Term Product Architecture

The final OmniPOS ecosystem should look approximately like this:

``` text
                           OMNIPOS NETWORK
                                  |
        +-------------------------+-------------------------+
        |                         |                         |
   Manufacturer               Importer                  Distributor
        |                         |                         |
        +-------------------------+-------------------------+
                                  |
                             Wholesaler
                                  |
                    +-------------+-------------+
                    |                           |
                Retailer                  Mini Market
                    |                           |
                    +-------------+-------------+
                                  |
                              Consumer


Every business may have:

    Physical POS
    Online Store
    B2B Store
    Customers
    Suppliers
    Inventory
    Orders
    Invoices
    Payments
    Balances
    Reports
```

The OmniPOS platform becomes the infrastructure connecting those
businesses.

------------------------------------------------------------------------

# 42. Final Product Principle

The most important architectural decision is:

> **Do not build an online store beside OmniPOS. Build a commerce layer
> on top of OmniPOS's existing operational core.**

The POS, inventory, pricing, customers, suppliers, invoices, payments,
balances and reporting remain the core operational system.

The commerce layer adds:

``` text
Stores
Relationships
Orders
Fulfillment
Shipments
Receiving
Marketplace
```

The supply-chain layer then connects those commerce transactions between
businesses.

This produces a platform that can evolve from:

``` text
POS software
```

into:

``` text
POS
+
E-commerce
+
B2B ordering
+
Wholesale commerce
+
Supply-chain management
+
Business marketplace
```

without maintaining separate systems for each business type.

------------------------------------------------------------------------

# 43. Immediate Next Step

The next implementation artifact should be:

``` text
docs/plans/001-commerce-domain-foundation.md
```

or the equivalent Spec Kit feature specification.

It should be created before the first marketplace UI is implemented.

That specification should settle, in detail:

1.  Business entity and business roles.
2.  Business relationships.
3.  Customer/supplier relationship mapping.
4.  Store and store listing model.
5.  Order and order-line model.
6.  Order state machine.
7.  Ordered/confirmed/shipped/received quantities.
8.  Shipment model.
9.  Goods receipt model.
10. Invoice linkage.
11. Payment linkage.
12. Balance linkage.
13. Inventory movement linkage.
14. Tenant isolation.
15. Permissions.
16. Audit requirements.
17. Backward compatibility with current OmniPOS.
18. Migration requirements.

Only after that specification is accepted should the project move to the
storefront feature.

------------------------------------------------------------------------

# 44. Master Roadmap Summary

``` text
CURRENT
1.7.x
POS + Inventory + Financial Foundation
        |
        v
001 Commerce Domain Foundation
        |
        v
002 Tenant Online Store
        |
        v
003 B2C Ordering
        |
        v
004 Business Relationships
        |
        v
005 B2B Wholesale Store
        |
        v
006 Purchase Orders + Fulfillment
        |
        v
007 Goods Receiving
        |
        v
008 Financial Integration
        |
        v
009 Supply Chain
        |
        v
010 Delivery / Fulfillment
        |
        v
011 OmniPOS Marketplace
        |
        v
OMNIPOS NETWORK
```

The roadmap should remain incremental. Each feature should have its own
specification, plan, task list, implementation, tests, and release
notes.

The existing `ROADMAP.md` should continue to be the release-level source
of truth, while detailed feature specifications live under
`docs/plans/`.
