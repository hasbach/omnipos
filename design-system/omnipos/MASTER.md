# OmniPOS Design System — AUTHORITATIVE SPEC (lead override, 2026-09-28)

> The generated sections further below came from ui-ux-pro-max. Where they conflict with THIS section
> (e.g. "Exaggerated Minimalism", landing-page pattern, clamp() hero type, GSAP scroll reveals), THIS wins.
> Style: **Data-Dense Dashboard / enterprise back-office**. Desktop Electron app, 1280–1920px, also usable at 1024px.

## Tokens (CSS variables in src/index.css, exposed to Tailwind v4 via @theme)
Light:
- `--bg` #F4F6FA (app background) · `--surface` #FFFFFF · `--surface-2` #F8FAFC (table header, subtle panels)
- `--border` #E2E8F0 · `--border-strong` #CBD5E1
- `--text` #0F172A · `--text-2` #475569 (secondary) · `--text-3` #64748B (muted, min for text on white = 4.5:1)
- `--primary` #1E40AF · `--primary-hover` #1E3A8A · `--primary-soft` #DBEAFE · `--on-primary` #FFFFFF
- `--accent` #D97706 (amber, highlights/warnings) · `--accent-soft` #FEF3C7
- `--success` #047857 · `--success-soft` #D1FAE5 · `--danger` #DC2626 · `--danger-soft` #FEE2E2
- `--info` #0369A1 · `--info-soft` #E0F2FE
- `--ring` #2563EB
Dark (`.dark` on <html>): bg #0B1220, surface #111827, surface-2 #0F172A, border #1F2937, border-strong #334155,
text #F1F5F9, text-2 #CBD5E1, text-3 #94A3B8, primary #3B82F6, primary-hover #60A5FA, primary-soft #1E3A8A55,
accent #F59E0B, success #34D399, danger #F87171, info #38BDF8 (soft variants = 15–20% alpha).
Keep legacy aliases `--app-bg/--app-ink/--app-surface/--app-border` mapped to the new tokens so untouched
screens still render.

## Typography
- Latin: **Inter** (variable). Arabic: **IBM Plex Sans Arabic**. Bundled offline via @fontsource packages
  (this is an offline desktop app — NO Google Fonts CDN). `font-family: "Inter Variable", "IBM Plex Sans Arabic", system-ui`.
- Scale: 12 (captions/table meta), 13 (table body, dense), 14 (body/inputs), 16 (section titles), 20 (page title), 28 (KPI values).
- Numbers: `font-variant-numeric: tabular-nums` on all amounts/qty (`.num` utility). Amounts right-aligned (end-aligned in RTL).
- Weights: 400 body, 500 labels/buttons, 600 headings, 700 KPI values only. No all-caps paragraphs; uppercase only for
  11–12px overline labels with 0.04em tracking.

## Spacing / shape / elevation
- 4px grid; dense scale 4/8/12/16/24/32. Card padding 16 (dense 12). Grid gap 12–16.
- Radius: 6 inputs/buttons, 10 cards/modals, 999 chips. Shadows: `0 1px 2px rgb(15 23 42 / .06)` cards,
  `0 10px 30px rgb(15 23 42 / .18)` modals/drawers. Borders over shadows for structure.
- Heights: buttons/inputs 36 (sm 30, lg 44 for POS/touch). Table row 36–40, header 36 sticky.

## Components (src/components/ui) — all accept className, forward refs where sensible, RTL-safe (logical props: ps/pe/ms/me/start/end)
Button (primary/secondary/ghost/danger/success; sm/md/lg; loading; icon-only requires aria-label) · IconButton ·
Input / NumberInput (select-on-focus, tabular) / MoneyInput (currency suffix) / Select / Textarea / Checkbox / Switch ·
Field (label above, helper, inline error) · Card (+CardHeader/CardBody) · StatCard (label, value, delta %, icon, trend sparkline optional) ·
Badge (neutral/primary/success/warning/danger/info) · Tabs · Modal (focus trap, Esc, sizes) · Drawer (side panel, end side) ·
ConfirmDialog (replace window.confirm) · Toast system (useToast: success/error/info; replaces alert()) ·
DataTable<T> (columns with sortable/align/render/width, client-side sort + search + pagination (25/50/100),
row click, selectable rows with bulk action bar, sticky header, empty state, loading skeleton, footer totals row,
virtualization not required ≤ 2k rows via pagination) · EmptyState · Skeleton · PageHeader (title, subtitle,
breadcrumbs, actions) · Toolbar (filters row) · DateRangePicker (presets: Today, Yesterday, This week, This month,
Last month, This year, Custom) · SearchInput (debounced, Ctrl+K focus) · Kbd · Tooltip (title-based ok).
Charts: lightweight inline SVG components (LineChart/AreaChart, BarChart, Donut) — no heavy chart lib; axis labels,
hover tooltip, legend, colors from tokens; accessible table fallback toggle.

## Interaction rules
- Hover/active transitions 150–200ms; respect `prefers-reduced-motion`. No decorative animation.
- Visible focus ring (2px `--ring`, offset 2) on every interactive element. cursor-pointer on clickables.
- Never use window.alert/confirm in new/rewritten code — Toast + ConfirmDialog.
- Loading: skeletons for tables/cards; buttons show spinner and disable while submitting.
- Errors inline near the field + toast for server errors (show server `error` message).
- Destructive actions confirm with the object's name; edits of settled invoices show a warning banner.
- Keyboard: Esc closes modals/drawers, Enter submits forms, Ctrl+K search, arrow keys in tables optional.
- Icons: lucide-react only, 16px in tables/buttons, 18–20px nav. No emoji.
- Money: always show currency (`$ 1,234.50`, `LL 1,234,000`), negative balances in danger color with sign,
  receivable/payable wording rather than raw sign where shown to users.
- RTL: `<html dir="rtl" lang="ar">` when Arabic. Use logical Tailwind utilities (ms-/me-/ps-/pe-/start-/end-,
  text-start/text-end). Chevron/arrow icons flip in RTL (`rtl:rotate-180`).

## Layout
- Shell: sidebar 240px (collapsible to 64px icons), grouped sections with overline labels; top bar 56px
  (page title, global search, theme, language, user, "Open POS" primary button). Content max-width none,
  padding 24 (20 at <1280).
- Pages: PageHeader → Toolbar (filters) → content (cards/tables). KPI rows use 4–6 StatCards in a responsive grid.
- Detail views open in a Drawer (end side, 560–720px) to keep list context; large editors (invoice editor) use a
  full-height Modal/route.

---

# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** OmniPOS
**Generated:** 2026-09-28 02:10:20
**Category:** Analytics Dashboard
**Design Dials:** Variance 3/10 (Centered / Minimal) | Motion 3/10 (Subtle) | Density 8/10 (Dense / Dashboard)

---

## Global Rules

### Color Palette

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Primary | `#1E40AF` | `--color-primary` |
| On Primary | `#FFFFFF` | `--color-on-primary` |
| Secondary | `#3B82F6` | `--color-secondary` |
| Accent/CTA | `#D97706` | `--color-accent` |
| Background | `#F8FAFC` | `--color-background` |
| Foreground | `#1E3A8A` | `--color-foreground` |
| Muted | `#E9EEF6` | `--color-muted` |
| Border | `#DBEAFE` | `--color-border` |
| Destructive | `#DC2626` | `--color-destructive` |
| Ring | `#1E40AF` | `--color-ring` |

**Color Notes:** Blue data + amber highlights [Accent adjusted from #F59E0B for WCAG 3:1]

### Typography

- **Heading Font:** Fira Code
- **Body Font:** Fira Sans
- **Mood:** dashboard, data, analytics, code, technical, precise
- **Google Fonts:** [Fira Code + Fira Sans](https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&family=Fira+Sans:wght@300;400;500;600;700&display=swap)

**CSS Import:**
```css
@import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&family=Fira+Sans:wght@300;400;500;600;700&display=swap');
```

### Spacing Variables

*Density: 8/10 — Dense / Dashboard*

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `2px` / `0.125rem` | Tight gaps |
| `--space-sm` | `4px` / `0.25rem` | Icon gaps, inline spacing |
| `--space-md` | `8px` / `0.5rem` | Standard padding |
| `--space-lg` | `12px` / `0.75rem` | Section padding |
| `--space-xl` | `16px` / `1rem` | Large gaps |
| `--space-2xl` | `24px` / `1.5rem` | Section margins |
| `--space-3xl` | `32px` / `2rem` | Hero padding |

### Shadow Depths

| Level | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | Subtle lift |
| `--shadow-md` | `0 4px 6px rgba(0,0,0,0.1)` | Cards, buttons |
| `--shadow-lg` | `0 10px 15px rgba(0,0,0,0.1)` | Modals, dropdowns |
| `--shadow-xl` | `0 20px 25px rgba(0,0,0,0.15)` | Hero images, featured cards |

---

## Component Specs

### Buttons

```css
/* Primary Button */
.btn-primary {
  background: #D97706;
  color: white;
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}

.btn-primary:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}

/* Secondary Button */
.btn-secondary {
  background: transparent;
  color: #1E40AF;
  border: 2px solid #1E40AF;
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}
```

### Cards

```css
.card {
  background: #F8FAFC;
  border-radius: 12px;
  padding: 24px;
  box-shadow: var(--shadow-md);
  transition: all 200ms ease;
  cursor: pointer;
}

.card:hover {
  box-shadow: var(--shadow-lg);
  transform: translateY(-2px);
}
```

### Inputs

```css
.input {
  padding: 12px 16px;
  border: 1px solid #E2E8F0;
  border-radius: 8px;
  font-size: 16px;
  transition: border-color 200ms ease;
}

.input:focus {
  border-color: #1E40AF;
  outline: none;
  box-shadow: 0 0 0 3px #1E40AF20;
}
```

### Modals

```css
.modal-overlay {
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
}

.modal {
  background: white;
  border-radius: 16px;
  padding: 32px;
  box-shadow: var(--shadow-xl);
  max-width: 500px;
  width: 90%;
}
```

---

## Style Guidelines

**Style:** Exaggerated Minimalism

**Keywords:** Bold minimalism, oversized typography, high contrast, negative space, loud minimal, statement design

**Best For:** Fashion, architecture, portfolios, agency landing pages, luxury brands, editorial

**Key Effects:** font-size: clamp(3rem 10vw 12rem), font-weight: 900, letter-spacing: -0.05em, massive whitespace

### Page Pattern

**Pattern Name:** Real-Time / Operations Landing

- **Conversion Strategy:** For ops/security/iot products. Demo or sandbox link. Trust signals.
- **CTA Placement:** Primary CTA in nav + After metrics
- **Section Order:** 1. Hero (product + live preview or status), 2. Key metrics/indicators, 3. How it works, 4. CTA (Start trial / Contact)

---

## Motion

**Scroll Reveal** (Subtle) — Trigger: scroll (viewport enter) | Duration: 300-400ms | Easing: `power1.out`

```js
gsap.from(el, { opacity: 0, y: 12, duration: 0.35, ease: 'power1.out', scrollTrigger: { trigger: el, start: 'top 90%', toggleActions: 'play none none reverse' } });
```

**Framework notes:** Requires the ScrollTrigger plugin registered once via gsap.registerPlugin(ScrollTrigger)

- ✅ Keep the y offset small (8-16px) so it reads as a fade, not a slide
- ❌ Don't reveal below-the-fold content needed for SEO/crawlers as invisible-by-default without a no-JS fallback
- ⚡ toggleActions 'play none none reverse' avoids re-triggering on every scroll direction change

---

## Anti-Patterns (Do NOT Use)

- ❌ Ornate design
- ❌ No filtering

### Additional Forbidden Patterns

- ❌ **Emojis as icons** — Use SVG icons (Heroicons, Lucide, Simple Icons)
- ❌ **Missing cursor:pointer** — All clickable elements must have cursor:pointer
- ❌ **Layout-shifting hovers** — Avoid scale transforms that shift layout
- ❌ **Low contrast text** — Maintain 4.5:1 minimum contrast ratio
- ❌ **Instant state changes** — Always use transitions (150-300ms)
- ❌ **Invisible focus states** — Focus states must be visible for a11y

---

## Pre-Delivery Checklist

Before delivering any UI code, verify:

- [ ] No emojis used as icons (use SVG instead)
- [ ] All icons from consistent icon set (Heroicons/Lucide)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Light mode: text contrast 4.5:1 minimum
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] No content hidden behind fixed navbars
- [ ] No horizontal scroll on mobile
