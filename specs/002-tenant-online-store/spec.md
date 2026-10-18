# Feature Specification: Tenant Online Store (Public Storefront)

**Feature Branch**: `002-tenant-online-store`

**Created**: 2026-10-18

**Status**: Draft

**Input**: User description: "Feature 002 — Tenant Online Store (public storefront), per
OmniPOS_Marketplace_Supply_Chain_Master_Blueprint.md §34 Phase 1 and ROADMAP row 002. Builds on 001 Slice A: stores,
listings, commerce on/off, the public catalog and the web-address claim. A public, read-only, mobile-first storefront
per tenant — store home (branding, contact, WhatsApp), categories, product listing with search and paging, product
page (images, description, units, retail price in USD and local currency, indicative stock state), store language
(en/ar/fr, RTL). Store address: default subdomain of an OmniPOS-owned storefront domain, path fallback, custom domains
as a later, separately-shippable story. Listing images uploaded from the back office. Hosted like the Live Monitor
with caching per store/page to protect the cloud data quota; stock shown as indicative. Out of scope: cart, checkout,
orders, payments, customer accounts (003), B2B pricing, marketplace discovery. Back-office changes allowed: reserved
addresses extended for subdomains, real public address shown in Settings, image upload in the product Online store
tab, store preview link."

## Overview

Feature 001 (Slice A) gave each OmniPOS business a store in the back office: it can turn commerce on, name the store,
claim a web address, open it and publish products. Nothing is visible to the public yet. This feature delivers the
**public storefront**: the page a customer opens on a phone to see what a shop sells, at what price, whether it is in
stock, and how to contact the shop.

The storefront is a window, not a till: it shows published products and lets visitors contact the shop, but nothing
can be ordered or paid online yet (that is Feature 003). Everything it shows comes from the shop's own products, so
the shop never maintains a second catalogue.

## Clarifications

### Session 2026-10-18

- Q: Which domain should host every store's default address? → A: Buy a short, dedicated new domain for storefronts
  (e.g. `omnipos.shop` / `omnipos.store`); exact name picked after an availability check, before deployment.
- Q: How can visitors contact a shop from the storefront? → A: WhatsApp, phone and email — one button per contact
  detail the shop filled in, on the store page and every product page.
- Q: Are custom domains part of this feature? → A: No — they become a separate feature after storefronts are live;
  002 ships only the OmniPOS subdomain and path addresses.
- Q: What limits apply to product photos? → A: Up to 4 photos per product; JPEG, PNG or WebP up to 5 MB each,
  automatically resized to web size before upload.
- Q: Can a Wholesale-mode store open a public storefront? → A: No. In 002 only Retail and Hybrid stores can be opened
  publicly; a Wholesale store stays closed until private B2B stores arrive with business relationships (004–005).
  Business types are descriptive labels, never permissions; wholesale catalogs and prices are visible only through
  approved business relationships.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A visitor opens a shop's address and browses its products (Priority: P1)

A customer receives the link `abc-market.<storefront domain>` on WhatsApp. On their phone they see the shop's name,
logo, colours and short description, the product categories, and a grid of published products with photo, name,
price and stock indicator. They search for "labneh", scroll through the results and switch between categories.

**Why this priority**: this is the feature. Without it, the back-office store has no audience.

**Independent Test**: Open a store that is open and has published products, on a phone-sized screen, and browse,
search and filter without any account.

**Acceptance Scenarios**:

1. **Given** an open store with 60 published products, **When** a visitor opens its address, **Then** they see the
   store's identity, its categories in the shop's chosen order, and the first page of products.
2. **Given** the product list, **When** the visitor picks a category, **Then** only products of that category are shown
   and the address reflects the category, so the filtered page can be shared.
3. **Given** the product list, **When** the visitor searches by part of a product name or its barcode, **Then** matching
   products are shown, and a clear "no products found" message appears when nothing matches.
4. **Given** more products than fit on one page, **When** the visitor reaches the end of the list, **Then** they can load
   or move to the next page without losing their category or search.
5. **Given** the shop has turned on "hide products that are out of stock", **When** a product is out of stock, **Then**
   it does not appear anywhere on the storefront.

---

### User Story 2 - A visitor opens a product and contacts the shop about it (Priority: P1)

The customer taps "Halloumi 250g". They see its photos, description, price in US dollars and in Lebanese pounds, the
packs it is sold in (piece, pack of 6) with their prices, and "In stock". They tap "Ask on WhatsApp" and WhatsApp opens
with a message to the shop that already names the product and its link.

**Why this priority**: the product page and a way to reach the shop are what turn browsing into a sale while online
ordering does not exist yet.

**Independent Test**: Open a product page directly from a shared link, check every displayed value against the
product in the back office, and use each contact button.

**Acceptance Scenarios**:

1. **Given** a published product, **When** a visitor opens its page, **Then** they see its online title, description,
   photos, category, retail price in USD, the local-currency price (when the shop shows local prices), each unit it is
   sold in with that unit's price, and its stock indicator.
2. **Given** a product page, **When** the shop has a WhatsApp number, **Then** an "Ask on WhatsApp" button opens a
   conversation with the shop, pre-filled with the product name and page link, in the store's language.
3. **Given** a product page, **When** the shop has a phone number or an email address, **Then** a "Call" button starts a
   call and an "Email" button opens a new email naming the product; when the shop has no contact detail at all, no
   contact button is shown.
4. **Given** a product page link, **When** it is shared on WhatsApp or social media, **Then** the preview shows the
   product name, price and first photo.
5. **Given** a product that is unpublished, disabled or deleted after the link was shared, **When** someone opens the
   link, **Then** they see "This product is no longer available" with a link to the store, never stale details.
6. **Given** a product without photos, **When** its page or card is shown, **Then** a neat placeholder appears instead
   of a broken image.

---

### User Story 3 - The storefront speaks the shop's language and works on any phone (Priority: P1)

An Arabic-speaking shop sets its store language to Arabic. Visitors see the whole storefront in Arabic, laid out right
to left, with prices and numbers readable. A visitor can switch to English or French.

**Why this priority**: OmniPOS merchants and their customers work in Arabic, French and English; a storefront that
breaks in Arabic is unusable for a large share of shops (Constitution Principle VI).

**Independent Test**: View the same store in each language on a narrow phone screen and a desktop screen, checking
direction, translations and layout.

**Acceptance Scenarios**:

1. **Given** a store whose language is Arabic, **When** a visitor opens it, **Then** every storefront label is Arabic and
   the layout is right to left; product names and descriptions are shown as the shop wrote them.
2. **Given** any store, **When** the visitor picks another language, **Then** the storefront switches language and
   remembers the choice for that visitor on that device.
3. **Given** a phone 360 pixels wide, **When** the storefront is used, **Then** nothing overflows sideways, tap targets
   are comfortably large and product photos keep their proportions.

---

### User Story 4 - Only open, licensed, enabled stores are public, and nothing private ever shows (Priority: P1)

A shop pauses its store for renovation. Its link now shows "This store is currently unavailable". Another shop's online
license expires; its storefront becomes unavailable the same way. At no time does any storefront reveal product costs,
wholesale prices, exact stock (unless the shop chose to show it), customers, suppliers or any other internal data.

**Why this priority**: a privacy leak or a store showing after the owner closed it would break merchant trust
(Constitution Principle II).

**Independent Test**: For each unavailable state (paused, draft, commerce off, license expired, deleted), open the
address and check the page; inspect every storefront page and its underlying data for forbidden fields.

**Acceptance Scenarios**:

1. **Given** a store that is paused, still a draft, deleted, in Wholesale mode, belongs to a business with commerce off
   or with an expired online license, **When** anyone opens its address, **Then** they see a polite "store unavailable" page that does not
   reveal which of these is the reason or show any product.
2. **Given** an address that was never claimed, **When** it is opened, **Then** the visitor sees a "store not found" page
   with a link to the OmniPOS website.
3. **Given** any storefront page, **When** its content and the data it loaded are inspected, **Then** no cost, wholesale
   or super-wholesale price, reorder level, internal identifier, customer, supplier, invoice or staff data is present.
4. **Given** the shop has not chosen to show exact stock, **When** a product is shown, **Then** only "In stock", "Low
   stock" or "Out of stock" appears, never a quantity.

---

### User Story 5 - The shop owner adds photos and shares the store from the back office (Priority: P2)

In the product editor's "Online store" tab, the owner adds three photos of a product from the computer, sets the first
as the main photo and reorders the others. In Settings → Online store they see the store's real public address, copy
it, and open a preview of the storefront.

**Why this priority**: products without photos sell poorly and shops need an easy way to share their link; both
depend on the storefront existing (P1 stories) to matter.

**Independent Test**: Upload, reorder and remove photos for a product, then confirm the storefront shows them in that
order; copy the address from Settings and open it.

**Acceptance Scenarios**:

1. **Given** a saved product, **When** the owner adds photos, **Then** up to 4 photos can be attached, the first is the
   main photo, the order can be changed and any photo removed, and the storefront reflects the change within the
   refresh time (FR-022).
2. **Given** a photo that is too large or not an image, **When** the owner tries to add it, **Then** it is refused with
   a clear message and nothing else changes.
3. **Given** the computer is offline, **When** the owner tries to add a photo, **Then** they are told photos need an
   internet connection; every other product and store edit still works offline.
4. **Given** a store with a claimed address, **When** the owner opens Settings → Online store, **Then** the full public
   address is shown with "Copy" and "Open store" buttons; "Open store" shows the live storefront when the store is open
   and an owner-only preview when it is still a draft or paused.
5. **Given** a user without permission to publish products, **When** they open the product editor, **Then** they can
   see the photos but cannot add, reorder or remove them.

---

### User Story 6 - The storefront stays fast and affordable under traffic (Priority: P2)

A shop posts its link in a large WhatsApp group and 2,000 people open it within an hour. Pages load quickly for
everyone, the shop's tills are unaffected, and the platform's cloud data usage grows only a little.

**Why this priority**: OmniPOS's cloud project is already near its data transfer quota; an uncached public storefront
could take every shop's sync down. It ranks P2 because it protects the P1 stories rather than adding visible features.

**Independent Test**: Simulate a burst of visitors on one store and measure page load times and the number of requests
reaching the cloud database.

**Acceptance Scenarios**:

1. **Given** a burst of visitors to the same store pages, **When** they browse, **Then** repeated views of the same page
   are served from a cache instead of reading the cloud database each time.
2. **Given** the owner changes a price or publishes a product, **When** the refresh time passes (FR-022), **Then** the
   storefront shows the change without any action from the owner.
3. **Given** stock changes on the tills, **When** the storefront shows a stock indicator, **Then** it is labelled as
   indicative and is never more than the refresh time plus the tills' sync delay behind.

---

### Edge Cases

- A product's price changes while a visitor has the page open: the next page load shows the new price; nothing is
  promised or saved.
- A product has a local-currency price set on the product: it is shown as is; otherwise the local price is the USD
  price × the shop's local exchange rate, rounded to a whole local-currency amount (e.g. whole LL).
- The shop has no local currency configured, or turned local prices off: only USD is shown.
- A product belongs to no category: it appears under "All products" only.
- A category has no visible products (all hidden or out of stock with hiding on): the category is not listed.
- A very long product name or description: names are shortened on cards with the full name on the product page;
  descriptions keep line breaks and never break the layout.
- A store with zero visible products: the store page shows "No products available yet" with the contact buttons.
- A visitor opens an old link after the shop changed its address: they see "store not found" (old addresses are not
  redirected in this feature).
- A deleted photo still cached by a visitor's browser: it disappears from the storefront on the next refresh.
- Search text containing symbols or very long text: treated as plain text, trimmed to a reasonable length.
- An address typed with capitals (`ABC-Market`): it opens the same store.
- Reserved addresses (`www`, `api`, `mail`, `admin`, …) can never be claimed by a shop, so they never collide with
  OmniPOS's own services.
- Two products with the same name: both shown; each has its own page link.
- Arabic product names in a French store: shown as written, with correct direction inside the text.

## Requirements *(mandatory)*

### Functional Requirements

**Store address**

- **FR-001**: Every open store MUST be reachable at `<address>.<storefront domain>`, where `<address>` is the web address
  the shop claimed in the back office and the storefront domain is a single short domain bought by OmniPOS only for
  storefronts (nothing else is hosted on it).
- **FR-002**: Every open store MUST also be reachable at `<storefront domain>/s/<address>` (path form), for places
  where a subdomain is impractical; both forms show the same store.
- **FR-003**: Addresses MUST be matched case-insensitively.
- **FR-004**: The reserved-address list MUST cover names needed by OmniPOS's own services on the storefront domain
  (at least: www, api, app, admin, mail, email, smtp, ftp, monitor, status, help, support, docs, blog, shop, store,
  stores, cdn, static, assets, media, img, images, login, signup, account, dashboard, omnipos, test, demo); the same list
  MUST be enforced by the back office and by the cloud address claim.
- **FR-005**: Settings → Online store MUST show the store's full public address (subdomain form) with "Copy" and "Open
  store" actions once an address is claimed.

**Storefront pages**

- **FR-006**: The store home MUST show the store name, logo (if any), cover image (if any), main colour, description,
  address, and contact buttons (WhatsApp, phone, email) for the contact details the shop filled in.
- **FR-007**: The store MUST list categories of visible products in the shop's chosen category order, then by name,
  plus "All products".
- **FR-008**: Product lists MUST show, per product: main photo, online title, retail price (USD, plus local price when
  shown), and stock indicator; lists MUST be paged with a default page of 48 products.
- **FR-009**: Visitors MUST be able to search products of one store by name or barcode, and to combine search with a
  category.
- **FR-010**: Each product MUST have its own page and shareable link showing: photos (main first, swipeable), online
  title, description, category, retail price in USD, local price when shown, each unit sold (name, contents, price), stock
  indicator, and contact buttons.
- **FR-010a**: Contact buttons (WhatsApp, Call, Email) MUST appear on the store page and every product page, one per
  contact detail the shop filled in, and none when the shop filled in none.
- **FR-011**: The WhatsApp button MUST open a conversation with the shop's WhatsApp number, pre-filled in the store
  language with the product name and its link (product page) or the store link (store page).
- **FR-012**: Store and product pages MUST provide link previews for messaging and social apps (title, short
  description or price, main image).
- **FR-013**: Prices shown MUST be the shop's retail prices only, exactly as the back office's listing preview computes
  them; no wholesale or customer-specific price may appear.
- **FR-014**: The stock indicator MUST be "In stock", "Low stock" or "Out of stock", with a note that availability is
  indicative; the exact quantity MUST appear only when the shop turned on "show the exact quantity".
- **FR-015**: Products that are unpublished, disabled, deleted, or out of stock while "hide out of stock" is on MUST NOT
  appear in lists, search, categories or counts; their product links MUST show "no longer available".

**Availability and privacy**

- **FR-016**: A storefront MUST be public only while the store is open, its mode is Retail or Hybrid, the business has
  commerce on, the business's online license is valid, and neither the store nor the business is deleted. Otherwise the address MUST show the same
  neutral "store unavailable" page for every reason.
- **FR-016a**: In the back office, a store in Wholesale mode MUST NOT be openable to the public; Settings → Online store
  MUST explain that private B2B stores come with business relationships. Switching an open store to Wholesale mode
  MUST take it off the public storefront (within the refresh period, FR-022).
- **FR-017**: An address that was never claimed MUST show the same neutral page as an unavailable store (FR-016): the
  public catalog deliberately never reveals whether an address exists. (Changed during implementation, 2026-10-19.)
- **FR-018**: The storefront MUST read store data only through the public catalog's allow-listed fields; it MUST NOT
  expose costs, non-retail prices, reorder levels, internal identifiers, other customers, suppliers, invoices, staff
  data or any other business's data.
- **FR-019**: The storefront MUST NOT require any visitor account, and MUST NOT collect visitor personal data in this
  feature beyond what is technically needed to serve pages.

**Language and layout**

- **FR-020**: Every storefront label, message and empty state MUST exist in English, Arabic and French; the store's
  language is the default, the visitor can switch, and the choice is remembered on that device. Arabic MUST be shown
  right to left.
- **FR-021**: The storefront MUST be usable on screens from 360 pixels wide to desktop, without sideways scrolling.

**Freshness and cost**

- **FR-022**: Changes made in the back office (prices, publishing, photos, store details, open/pause) MUST appear on the
  storefront within 5 minutes once the tills have synced, without action from the owner. A store being paused or
  closed MUST stop being shown within the same period.
- **FR-023**: Repeated visits to the same store pages within the refresh period MUST be served without reading the
  cloud database again, so that visitor traffic does not grow the platform's cloud data usage proportionally.

**Photos (back office)**

- **FR-024**: Users allowed to publish products MUST be able to add up to 4 photos per listing from the product editor's
  "Online store" tab, choose the main photo, reorder and remove photos.
- **FR-025**: Photos MUST be JPEG, PNG or WebP, at most 5 MB each, and MUST be resized before they are stored so their
  longest side is at most 1600 pixels. Other files, and a 5th photo, MUST be refused with a clear message. The listing
  photo limit set in 001 (8) is lowered to 4 everywhere it is checked.
- **FR-026**: Adding or removing photos MUST require an internet connection and say so when offline; all other product
  and store edits MUST keep working offline.
- **FR-027**: Photos MUST be stored per business so that one business can never add, replace or remove another
  business's photos, and removed photos MUST stop being served.

**Preview**

- **FR-028**: The owner MUST be able to preview the storefront of a draft or paused store from the back office; the
  preview MUST not be reachable by the public.

**Scope boundary**

- **FR-032**: This feature MUST NOT include a cart, checkout, orders, payments, visitor accounts, wholesale or
  customer-specific pricing, cross-store discovery, or shop-owned custom domains (a separate later feature).

### Key Entities

- **Store (existing, 001)**: name, address, mode, status, branding, contact details, language, display settings. Its
  existing cover-image field becomes usable (upload in the back office).
- **Store Listing (existing, 001)**: references a product; its photo list now holds real uploaded photos in display
  order (first = main).
- **Listing Photo**: an uploaded image belonging to one business and one listing, stored in cloud storage, with its
  display order.
- **Storefront Domain**: the single OmniPOS-owned domain that hosts every store's default subdomain and the path form.
- **Public Catalog (existing, 001)**: the allow-listed read model the storefront uses (store identity, categories,
  listings, units, prices, stock indicator).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A visitor on a mid-range phone over a 4G connection sees the store home with products within 2 seconds
  for 95% of visits, and a product page within 1.5 seconds.
- **SC-002**: During a burst of 2,000 visits to one store within an hour, cloud database reads caused by the
  storefront stay under 5% of page views.
- **SC-003**: 100% of storefront pages and loaded data pass an automated check for forbidden fields (cost, non-retail
  prices, internal ids, customer, supplier, staff, invoice data).
- **SC-004**: For every unavailable state (paused, draft, commerce off, license expired, deleted), the address shows the
  neutral unavailable page in 100% of automated checks, and stops showing products within 5 minutes of the change.
- **SC-005**: Prices, units and stock indicators shown on the storefront match the back-office listing preview for 100%
  of products in automated comparison.
- **SC-006**: A shop owner can add photos to 10 products and share their store link in under 10 minutes using only the
  back office.
- **SC-007**: All storefront text is available in English, Arabic and French with no untranslated label in automated
  scans, and Arabic pages lay out right to left without horizontal scrolling at 360 pixels wide.
- **SC-008**: Back-office changes appear on the storefront within 5 minutes in 95% of measurements once the tills have
  synced.

## Assumptions

- The storefront domain is a new, dedicated short domain bought by OmniPOS (for example `omnipos.shop`); the exact
  name is chosen after an availability check and is needed before deployment, not before planning.
- The storefront is hosted alongside the Live Monitor on the same hosting provider, on a plan that allows commercial
  use, wildcard subdomains, custom domains and caching. Hosting cost is accepted as part of offering stores.
- Store data reaches the cloud through the tills' existing sync; the storefront never writes to store data.
- Only the retail price tier is public. Hybrid stores show retail prices publicly; Wholesale stores are not public at
  all in this feature. Business types (Wholesaler, Retailer, …) are descriptive only; who may see a wholesaler's
  catalog and prices is decided by approved business relationships (Features 004–006), and whether a business can be
  found by others by its discovery settings (Feature 011).
- Contacting the shop (WhatsApp, phone, email) is the only visitor action; it opens the visitor's own apps and records
  nothing in OmniPOS.
- Old addresses are not redirected after a shop changes its address.
- Visitor language choice is remembered locally on the visitor's device only.
- The unit-restriction setting of listings (orderable units) stays unenforced on the storefront until ordering (003);
  all live units are shown.
- Shop-owned custom domains (customer DNS record, verification, automatic secure access) are a separate later
  feature, possibly a paid add-on; the address model here (one store ⇔ one claimed address) must not block it.
- Analytics on storefront visits are out of scope for this feature.
