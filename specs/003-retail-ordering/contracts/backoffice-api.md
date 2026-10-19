# Contract — Back-office changes (local Express server, Slice 1)

No new routes; two existing routes accept new fields. ROUTE_RULES unchanged
(`PUT /api/commerce/stores/:id` → `store.manage`, `PUT /api/commerce/stores/:id/listings/:productId` → `store.publish`).

## `PUT /api/commerce/stores/:id` — ordering settings

`settings` accepts the new keys (merged into the stored JSON like the existing flags):

```json
{ "settings": { "ordering_mode": "whatsapp", "pickup_enabled": true, "pickup_note": "Back door after 4 pm",
                "delivery_enabled": true, "delivery_note": "Achrafieh and Gemmayzeh only", "min_order_usd": 10 } }
```

| Code | When |
|---|---|
| `STORE_SETTINGS_INVALID` (field `settings.<key>`) | wrong type, unknown mode, note > 200, minimum < 0 / > 100 000 / > 2 decimals |
| `ORDERING_MODE_UNAVAILABLE` (field `settings.ordering_mode`) | `online` before Slice 2 |
| `STORE_ORDERING_NEEDS_WHATSAPP` (field `contact_whatsapp`) | mode `whatsapp` without a usable WhatsApp number, or the number cleared/invalid while the mode is `whatsapp` |
| `STORE_ORDERING_NEEDS_FULFILMENT` (field `settings.pickup_enabled`) | mode not `off` with pickup and delivery both off |

The store view (`GET /api/commerce/stores`) returns the merged settings with defaults, so the UI always sees every key.

## `PUT /api/commerce/stores/:id/listings/:productId` — orderable units

- New input `orderable_unit_keys: string[] | null` (`"base"` or unit global ids of this product); `null` = all units.
- Legacy input `orderable_unit_ids: number[]` still accepted (older UI builds) and converted to keys server-side.
- `ListingView` returns `orderable_unit_keys` (and drops `orderable_unit_ids`), and `units` gains `key`
  (`"base"` row first, then units) so the UI can render checkboxes.

| Code | When |
|---|---|
| `LISTING_UNIT_INVALID` (field `orderable_unit_keys`) | empty array, unknown key, unit of another product or tenant |
| `LISTING_MIN_QTY_INVALID` (existing) | minimum ≤ 0 |

## One-time conversion (server/db.ts)

Runs at startup, idempotent, per tenant, only on rows whose value parses as an array of integers (research R5).
Logged once with the number of listings converted; converted rows are marked for push.

## UI

- Settings → Online store → **Ordering** card: mode (Off / Order on WhatsApp / Online orders — disabled, "coming soon"),
  pickup switch + instructions, delivery switch + area text, minimum order (USD). Warning when the store has no
  WhatsApp number, with a link to the contact field.
- Product → Online store tab: "Orderable units" (all / pick: base unit + each unit), "Minimum quantity" (in the base
  unit). Strings in `src/intl/locales/commerce.ts` (en/ar/fr), error codes mapped by `translateServerError`.
