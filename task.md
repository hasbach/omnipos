# OmniPOS Improvement Plan

## Phase 1: Stabilization & Security
- `[x]` Install `connect-sqlite3` and `dotenv`
- `[x]` Update `server.ts` to configure `connect-sqlite3` for session management
- `[x]` Move session secret and hardcoded passwords to a `.env` file
- `[x]` Update `server.ts` to load secrets from `.env`

## Phase 2: Refactoring
- `[x]` Create `server/` module structure (`server/db.ts`, `server/routes.ts`)
- `[x]` Extract database connection & initialization logic out of `server.ts`
- `[x]` Extract Express API routes into `server/routes/` and hook them up to `server.ts`
- `[x]` Break down `src/Dashboard.tsx` into `src/pages/...` (LiveMonitor, DailySales, Products, etc.)
- `[x]` Break down `src/App.tsx` (POS interface) into smaller components (`Cart.tsx`, `ProductGrid.tsx`, `PaymentModal.tsx`)
- `[x]` Rebuild and ensure the app still compiles successfully via `npm run build:server` and Vite.

## Phase 3: New Features & Fixes
- `[x]` Remove the "Recent Transactions" section from the POS UI in `App.tsx` (or its split component)
- `[x]` Clean up the POS UI layout (flex/grid sizing) to ensure the Cart & Payment options fit without scrolling
- `[x]` Add a "Credit Customers Payment" button in POS UI opening a modal/window to receive balance payments
- `[x]` Modify the End of Day (Settlement) feature to reset the current register's total sales & order numbering
- `[x]` Update Electron configuration (`electron-main.js`) to load Dashboard in a frameless window (no Electron wrapper toolbar)
- `[x]` Implement custom React control buttons (Minimize, Maximize, Close) in the Dashboard UI (`WindowFrame.tsx`)
- `[x]` Adjust React Router / Dashboard behavior to prevent the user from navigating "back" to a duplicate POS screen.

## Phase 4: Multi-Terminal Networking & Discovery
- `[x]` Add `terminal_id` and `terminal_sequence` to `transactions` table in `server/db.ts`
- `[x]` Modify `POST /api/transactions` in `server/routes.ts` to calculate independent `terminal_sequence`
- `[x]` Create `server/discovery.ts` to broadcast a UDP beacon across the local network
- `[x]` Modify `server.ts` to launch the UDP discovery broadcaster alongside the Express server
- `[x]` Create `setup.html` and `setup-preload.cjs` inside `dist-electron/` to act as the native host/client modal UI
- `[x]` Alter `electron-main.js` to read `network-config.json` and display `setup.html` if missing
- `[x]` Inject the `terminalId` state into `React` frontend securely (from config / query params)
- `[x]` Update receipt and history views in `PaymentModal.tsx` and `Settlement.tsx` to display formatted `${terminal_id}-${terminal_sequence}`
