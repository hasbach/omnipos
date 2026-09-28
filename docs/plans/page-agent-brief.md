# Brief for page agents (OmniPOS 1.2.0 UI rebuild)

Repo: `C:\Users\InfoCenter\source\antigravity projects\omnipos`, branch feature/pro-upgrade-1.2. React 19 + TS,
Tailwind v4, lucide-react. Electron desktop back-office app used by large retail/wholesale companies — must feel
like a professional ERP: dense, fast, keyboard-friendly, zero surprises.

## Read first
1. `design-system/omnipos/MASTER.md` — top "AUTHORITATIVE SPEC" section is binding (tokens, type, components,
   interaction rules, RTL). Style: Data-Dense Dashboard.
2. `docs/plans/2026-09-28-pro-upgrade.md` — product spec (pricing tiers, costing, invoice editing, reports).
3. The foundation you MUST build on (read the source of what you use):
   - `src/components/ui/index.ts` (+ each component) — Button, IconButton, Input, NumberInput, MoneyInput, Select
     (options prop), Textarea, Checkbox, Switch, Field, Card/CardHeader/CardBody, StatCard, Badge, Tabs, Modal,
     Drawer, useConfirm, useToast, DataTable, EmptyState, Skeleton, PageHeader, Toolbar, DateRangePicker,
     SearchInput, Kbd, Tooltip, charts (LineChart, BarChart, DonutChart).
   - `src/lib/format.ts` (formatMoney etc., localToday, resolveDateRangePreset), `src/lib/api.ts` (api.get/post/put/del
     → throws Error(server error message)), `src/lib/pricing.ts` (tier pricing, margins/markups — mirrors server).
   - `src/intl/index.tsx` → `import { useI18n } from '<rel>/intl/index'`; `const { t, lang, dir } = useI18n()`;
     `t('key', 'English fallback')`. Put ALL your new strings in your own locale file
     `src/intl/locales/<area>.ts` (default export `{ en: {...}, ar: {...}, fr: {...} }`, real Arabic + French),
     prefix keys with your area (e.g. `inv_`). Legacy `src/i18n.ts` still exists; don't add to it.
   - Token classes: bg-bg, bg-surface, bg-surface-2, border-border, border-border-strong, text-text, text-text-2,
     text-text-3, bg-primary/text-primary/bg-primary-soft, accent, success, danger, info (+ -soft). `.num` for numbers.
   - `src/types.ts` (Product incl. tier prices, Stakeholder incl. price_level/credit_limit, Transaction, PriceLevel).
   - Backend: read the actual route code in `server/routes.ts`, `server/invoiceEdit.ts`, `server/reports.ts` for the
     exact request/response shapes you call — never guess.
4. The existing page(s) you're rewriting: keep EVERY existing capability (don't drop features, exports, printing,
   modals, keyboard shortcuts); improve them.

## Rules
- You own ONLY the files listed in your task. Do NOT edit src/components/ui/*, src/index.css, src/types.ts,
  src/lib/*, src/intl/index.tsx, src/Dashboard.tsx, src/components/shell/*, server/*, tests/* — if something
  shared is missing/buggy, work around it locally (page-local component) and list it in your report.
- Pages are rendered by `src/Dashboard.tsx` routes; check what props it passes and keep the default export name/
  signature compatible (props may be ignored if you switch to useI18n).
- Money: amounts from the server are USD. Show USD primary; show the local currency (the non-USD currency from
  GET /api/currencies, code may be 'LBP' or 'LB' — match `code !== 'USD'`) where the old page did.
- Replace window.alert/confirm with useToast/useConfirm. Loading → skeletons; errors → toast with server message.
- RTL-safe: logical utilities only (ms/me/ps/pe/start/end, text-start/end), `rtl:rotate-180` on arrows.
- The current back-office user id (for `user_id` in requests) is `sessionStorage.getItem('currentCashierId')`
  (may be null — server falls back safely).
- No new npm dependencies. Don't run npm install / npm rebuild / npm test / dev servers (other agents run
  concurrently; the native module ABI must not change).
- Verify: `npx tsc --noEmit 2>&1 | grep -E "<your files>"` → no errors, and
  `npx vite build --outDir "$TEMP/omni-build-<yourarea>" --emptyOutDir` → succeeds (use your own outDir; never
  build into ./build concurrently).
- Do NOT git commit. Report: files changed, features delivered (checklist), backend endpoints used, any shared
  component bugs/workarounds, and anything you could not finish.
