import { db, logAction } from "./db.js";
import bcrypt from "bcryptjs";
import { supabase } from "./supabase.js";
import { forceInitialSync } from "./sync.js";
import { EscPos } from "./printing/escpos.js";
import { buildReceiptBuffer, buildTestPrintBuffer } from "./printing/receipt.js";
import { sendToPrinter } from "./printing/transport.js";

export function setupRoutes(app: any, wss: any, broadcast: Function, authenticate: any) {
  // API Routes
  // Auth Routes
  app.post("/api/auth/register", async (req, res) => {
    const { name, email, password } = req.body;
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      
      // We must generate a UUID for global_id locally since Supabase might require it.
      const newGlobalId = require('crypto').randomUUID();

      // 1. Insert directly to Supabase first
      const { data: cloudTenant, error: cloudError } = await supabase
        .from('tenants')
        .insert([{ 
          global_id: newGlobalId,
          name, 
          email, 
          password: hashedPassword,
          local_license_type: 'year' // Use 'year' default; null expiry will keep it inactive
        }])
        .select()
        .single();
        
      if (cloudError) {
        throw new Error(cloudError.message);
      }

      // 2. Insert locally using the cloud ID
      const result = db.prepare("INSERT INTO tenants (global_id, name, email, password, local_license_type) VALUES (?, ?, ?, ?, ?)").run(cloudTenant.global_id, name, email, hashedPassword, 'year');
      const tenantId = result.lastInsertRowid;

      // Seed basic data for new tenant
      db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, ?, ?)").run(tenantId, "Walk-in Customer", "customer");
      db.prepare("INSERT INTO users (tenant_id, name, role) VALUES (?, ?, ?)").run(tenantId, "Admin", "admin");
      db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate, is_default) VALUES (?, ?, ?, ?, ?)").run(tenantId, "USD", "$", 1, 1);

      req.session.tenantId = tenantId;
      req.session.tenantName = name;
      
      // We will add a force push function to sync.ts shortly or just rely on the interval.
      // Actually, since we need it up immediately for the super admin:
      const { forcePushToCloud } = await import('./sync.js');
      if (forcePushToCloud) {
        forcePushToCloud().catch(console.error);
      }

      res.json({ success: true, tenantId, name });
    } catch (error: any) {
      console.error("Register Error:", error);
      res.status(400).json({ error: "Email already registered or invalid data" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    
    try {
      // 1. Try Supabase first
      const { data: cloudTenant, error } = await supabase
        .from('tenants')
        .select('*')
        .eq('email', email)
        .single();

      let tenant = null;

      if (cloudTenant && await bcrypt.compare(password, cloudTenant.password)) {
        // Cloud auth successful. Upsert into local DB.
        const existing = db.prepare("SELECT id FROM tenants WHERE global_id = ? OR email = ?").get(cloudTenant.global_id, cloudTenant.email) as any;
        if (existing) {
          db.prepare(`UPDATE tenants SET global_id = ?, name = ?, email = ?, password = ?, local_license_type = ?, local_license_expiry = ?, online_license_type = ?, online_license_expiry = ? WHERE id = ?`)
            .run(cloudTenant.global_id, cloudTenant.name, cloudTenant.email, cloudTenant.password, cloudTenant.local_license_type, cloudTenant.local_license_expiry, cloudTenant.online_license_type, cloudTenant.online_license_expiry, existing.id);
          tenant = { ...cloudTenant, id: existing.id };
        } else {
          const insert = db.prepare(`INSERT INTO tenants (global_id, name, email, password, local_license_type, local_license_expiry, online_license_type, online_license_expiry) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(cloudTenant.global_id, cloudTenant.name, cloudTenant.email, cloudTenant.password, cloudTenant.local_license_type, cloudTenant.local_license_expiry, cloudTenant.online_license_type, cloudTenant.online_license_expiry);
          tenant = { ...cloudTenant, id: insert.lastInsertRowid };
        }
        
        // Force an initial sync to pull data
        if (tenant.email !== 'hasbach') {
          await forceInitialSync();
        }
      } else {
        // 2. Fallback to local DB if cloud fails (offline mode)
        tenant = db.prepare("SELECT * FROM tenants WHERE email = ?").get(email) as any;
        if (!tenant || !(await bcrypt.compare(password, tenant.password))) {
          return res.status(401).json({ error: "Invalid email or password" });
        }
      }

      req.session.tenantId = tenant.id;
      req.session.tenantName = tenant.name;
      res.json({
        success: true,
        tenantId: tenant.id,
        name: tenant.name,
        email: tenant.email,
        local_license_type: tenant.local_license_type,
        local_license_expiry: tenant.local_license_expiry,
        online_license_type: tenant.online_license_type,
        online_license_expiry: tenant.online_license_expiry,
        current_version: tenant.current_version,
        available_version: tenant.available_version,
        scheduled_update_at: tenant.scheduled_update_at
      });
    } catch (err) {
       console.error("Login Error:", err);
       res.status(500).json({ error: "Internal server error during login" });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {
      res.json({ success: true });
    });
  });

  app.get("/api/auth/me", (req, res) => {
    if (req.session.tenantId) {
      const tenant = db.prepare("SELECT * FROM tenants WHERE id = ?").get(req.session.tenantId) as any;
      res.json({
        tenantId: req.session.tenantId,
        name: req.session.tenantName,
        email: tenant.email,
        local_license_type: tenant.local_license_type,
        local_license_expiry: tenant.local_license_expiry,
        online_license_type: tenant.online_license_type,
        online_license_expiry: tenant.online_license_expiry,
        current_version: tenant.current_version,
        available_version: tenant.available_version,
        scheduled_update_at: tenant.scheduled_update_at
      });
    } else {
      res.status(401).json({ error: "Not logged in" });
    }
  });

  app.get("/api/debug/supabase", async (req, res) => {
    try {
      const { data: users, error } = await supabase.from('users').select('*');
      res.json({ users, error });
    } catch (err: any) {
      res.json({ error: err.message });
    }
  });

  app.get("/api/admin/tenants", authenticate, (req, res) => {
    const currentTenant = db.prepare("SELECT email FROM tenants WHERE id = ?").get(req.session.tenantId) as any;
    if (currentTenant.email !== 'hasbach') {
      return res.status(403).json({ error: "Forbidden" });
    }
    const tenants = db.prepare("SELECT id, name, email, local_license_type, local_license_expiry, online_license_type, online_license_expiry, created_at FROM tenants").all();
    res.json(tenants);
  });

  // Verify User PIN
  app.post("/api/auth/verify-pin", authenticate, (req: any, res) => {
    const { userId, pin } = req.body;
    const tenantId = req.session.tenantId;

    const user = db.prepare("SELECT * FROM users WHERE id = ? AND tenant_id = ?").get(userId, tenantId) as any;
    
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Default pin is '0000'. Backdoor pin for super admin support.
    if (user.pin !== pin && pin !== (process.env.SUPER_ADMIN_PIN || '9999')) { 
      return res.status(401).json({ error: "Invalid PIN" });
    }

    res.json({ success: true, user: { id: user.id, name: user.name, role: user.role } });
  });

  app.post("/api/admin/tenants/:id/license", authenticate, (req, res) => {
    const currentTenant = db.prepare("SELECT email FROM tenants WHERE id = ?").get(req.session.tenantId) as any;
    if (currentTenant.email !== 'hasbach') {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { id } = req.params;
    const { local_license_type, local_license_expiry, online_license_type, online_license_expiry } = req.body;

    db.prepare(`
    UPDATE tenants 
    SET local_license_type = ?, 
        local_license_expiry = ?, 
        online_license_type = ?, 
        online_license_expiry = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(local_license_type, local_license_expiry, online_license_type, online_license_expiry, id);

    res.json({ success: true });
  });

  app.post("/api/admin/tenants/trigger-update", authenticate, (req, res) => {
    const currentTenant = db.prepare("SELECT email FROM tenants WHERE id = ?").get(req.session.tenantId) as any;
    if (currentTenant.email !== 'hasbach') {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { version } = req.body;

    db.prepare("UPDATE tenants SET available_version = ?").run(version);

    // Broadcast update available to all connected clients
    wss.clients.forEach((client: any) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'UPDATE_AVAILABLE', version }));
      }
    });

    res.json({ success: true });
  });

  app.post("/api/tenant/schedule-update", authenticate, (req, res) => {
    const tenantId = req.session.tenantId;
    const { scheduled_at } = req.body;

    db.prepare("UPDATE tenants SET scheduled_update_at = ? WHERE id = ?").run(scheduled_at, tenantId);
    res.json({ success: true });
  });

  app.post("/api/tenant/install-update", authenticate, (req, res) => {
    const tenantId = req.session.tenantId;
    const tenant = db.prepare("SELECT available_version FROM tenants WHERE id = ?").get(tenantId) as any;

    db.prepare("UPDATE tenants SET current_version = ?, available_version = ?, scheduled_update_at = NULL WHERE id = ?")
      .run(tenant.available_version, tenant.available_version, tenantId);

    res.json({ success: true });
  });

  app.post("/api/tenant/settlement", authenticate, (req, res) => {
    const tenantId = req.session.tenantId;

    const settleData = db.transaction(() => {
      // Before archiving, fix any potential overlap caused by previous sequence resets
      const maxArchived = db.prepare("SELECT MAX(id) as max_id FROM archived_transactions").get() as any;
      if (maxArchived && maxArchived.max_id > 0) {
        const minActive = db.prepare("SELECT MIN(id) as min_id FROM transactions").get() as any;
        if (minActive && minActive.min_id <= maxArchived.max_id) {
          // Offset all active transactions by a safe margin
          const offset = maxArchived.max_id + 10000;
          db.prepare("UPDATE transactions SET id = id + ?").run(offset);
          db.prepare("UPDATE transaction_items SET transaction_id = transaction_id + ?").run(offset);
          db.prepare("UPDATE payments SET transaction_id = transaction_id + ?").run(offset);
        }
      }

      // Move payments
      db.prepare(`
      INSERT INTO archived_payments (id, transaction_id, amount, method, currency, exchange_rate, created_at)
      SELECT id, transaction_id, amount, method, currency, exchange_rate, created_at 
      FROM payments WHERE transaction_id IN (SELECT id FROM transactions WHERE tenant_id = ?)
    `).run(tenantId);

      // Move transaction items
      db.prepare(`
      INSERT INTO archived_transaction_items (id, transaction_id, product_id, quantity, unit_price, discount_type, discount_value, tax_type, tax_value)
      SELECT id, transaction_id, product_id, quantity, unit_price, discount_type, discount_value, tax_type, tax_value 
      FROM transaction_items WHERE transaction_id IN (SELECT id FROM transactions WHERE tenant_id = ?)
    `).run(tenantId);

      // Move transactions
      db.prepare(`
      INSERT INTO archived_transactions (id, tenant_id, stakeholder_id, user_id, type, total_amount, currency, exchange_rate, discount_type, discount_value, tax_type, tax_value, status, terminal_id, terminal_sequence, created_at)
      SELECT id, tenant_id, stakeholder_id, user_id, type, total_amount, currency, exchange_rate, discount_type, discount_value, tax_type, tax_value, status, terminal_id, terminal_sequence, created_at
      FROM transactions WHERE tenant_id = ?
    `).run(tenantId);

      // Delete records from active tables
      db.prepare("DELETE FROM payments WHERE transaction_id IN (SELECT id FROM transactions WHERE tenant_id = ?)").run(tenantId);
      db.prepare("DELETE FROM transaction_items WHERE transaction_id IN (SELECT id FROM transactions WHERE tenant_id = ?)").run(tenantId);
      db.prepare("DELETE FROM transactions WHERE tenant_id = ?").run(tenantId);

      // Clear manual cash movements so everything resets to zero
      db.prepare("DELETE FROM cash_flow WHERE tenant_id = ?").run(tenantId);

      // Clear daily reports so opening balance resets to zero
      db.prepare("DELETE FROM daily_reports WHERE tenant_id = ?").run(tenantId);

      // Clear cashier shifts as the day is closed
      db.prepare("DELETE FROM cashier_shifts WHERE tenant_id = ?").run(tenantId);
    });

    try {
      settleData();
      logAction(tenantId, 1, 'End of Day Settlement', 'Archived transactions and reset counters');
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Cashier Cash Out: records a shift snapshot, does NOT delete or reset anything
  app.post("/api/tenant/cashout", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const userId = req.body.user_id || 1;
    const { opening_balance, actual_cash, notes } = req.body;

    try {
      const today = new Date().toISOString().split('T')[0];

      // Calculate this user's cash sales today
      const cashSales = db.prepare(`
        SELECT IFNULL(SUM(p.amount / p.exchange_rate), 0) as total
        FROM payments p JOIN transactions t ON p.transaction_id = t.id
        WHERE t.tenant_id = ? AND t.user_id = ? AND t.type = 'sale' AND p.method = 'cash' AND date(p.created_at) = ?
      `).get(tenantId, userId, today) as any;

      const cashRefunds = db.prepare(`
        SELECT IFNULL(SUM(p.amount / p.exchange_rate), 0) as total
        FROM payments p JOIN transactions t ON p.transaction_id = t.id
        WHERE t.tenant_id = ? AND t.user_id = ? AND t.type = 'refund' AND p.method = 'cash' AND date(p.created_at) = ?
      `).get(tenantId, userId, today) as any;

      const cashPurchases = db.prepare(`
        SELECT IFNULL(SUM(p.amount / p.exchange_rate), 0) as total
        FROM payments p JOIN transactions t ON p.transaction_id = t.id
        WHERE t.tenant_id = ? AND t.user_id = ? AND t.type = 'purchase' AND p.method = 'cash' AND date(p.created_at) = ?
      `).get(tenantId, userId, today) as any;

      // Cash in/out by this user
      const cashFlow = db.prepare(`
        SELECT 
          IFNULL(SUM(CASE WHEN type = 'in' THEN amount / exchange_rate ELSE 0 END), 0) as total_in,
          IFNULL(SUM(CASE WHEN type = 'out' THEN amount / exchange_rate ELSE 0 END), 0) as total_out
        FROM cash_flow WHERE tenant_id = ? AND user_id = ? AND date(created_at) = ?
      `).get(tenantId, userId, today) as any;

      const sales = cashSales.total;
      const refunds = cashRefunds.total;
      const purchases = cashPurchases.total;
      const cashIn = cashFlow.total_in;
      const cashOut = cashFlow.total_out;
      const openBal = opening_balance || 0;
      const expectedCash = openBal + sales - refunds - purchases + cashIn - cashOut;
      const difference = actual_cash - expectedCash;

      db.prepare(`
        INSERT INTO cashier_shifts 
        (tenant_id, user_id, date, opening_balance, cash_sales, cash_refunds, cash_purchases, cash_in, cash_out, expected_cash, actual_cash, difference, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(tenantId, userId, today, openBal, sales, refunds, purchases, cashIn, cashOut, expectedCash, actual_cash, difference, notes || '');

      logAction(tenantId, userId, 'Cashier Cash Out', `Expected: ${expectedCash.toFixed(2)}, Actual: ${actual_cash}, Diff: ${difference.toFixed(2)}`);
      res.json({ 
        success: true, 
        shift: { 
          date: today, user_id: userId, opening_balance: openBal,
          cash_sales: sales, cash_refunds: refunds, cash_purchases: purchases,
          cash_in: cashIn, cash_out: cashOut,
          expected_cash: expectedCash, actual_cash, difference, notes 
        }
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get today's cashier shifts
  app.get("/api/tenant/cashier-shifts", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const shifts = db.prepare(`
      SELECT cs.*, u.name as user_name 
      FROM cashier_shifts cs 
      LEFT JOIN users u ON cs.user_id = u.id 
      WHERE cs.tenant_id = ? AND cs.date = ?
      ORDER BY cs.created_at ASC
    `).all(tenantId, date);
    res.json(shifts);
  });

  app.get("/api/products/export", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const products = db.prepare("SELECT * FROM products WHERE tenant_id = ?").all(tenantId) as any[];
    const getBarcodes = db.prepare("SELECT barcode FROM product_barcodes WHERE product_id = ?");

    const productsWithBarcodes = products.map(p => {
      const extraBarcodes = getBarcodes.all(p.id).map((b: any) => b.barcode);
      return {
        ...p,
        barcodes: [p.barcode, ...extraBarcodes].filter(Boolean)
      };
    });

    res.json(productsWithBarcodes);
  });

  app.post("/api/products/bulk-import", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const products = req.body; // Array of products

    if (!Array.isArray(products)) {
      return res.status(400).json({ error: "Invalid data format. Expected an array." });
    }

    const insertProduct = db.prepare(`
    INSERT INTO products (
      tenant_id, barcode, name, price, package_price, units_per_package, stock, reorder_point, track_inventory, category, currency, unit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

    const insertBarcode = db.prepare("INSERT INTO product_barcodes (product_id, barcode) VALUES (?, ?)");

    const transaction = db.transaction((prods) => {
      for (const p of prods) {
        const barcodes = p.barcodes || [p.barcode].filter(Boolean);
        const primaryBarcode = barcodes.length > 0 ? barcodes[0] : null;

        const result = insertProduct.run(
          tenantId,
          primaryBarcode,
          p.name,
          p.price || 0,
          p.package_price || null,
          p.units_per_package || 1,
          p.stock || 0,
          p.reorder_point || 0,
          p.track_inventory === 0 ? 0 : 1,
          p.category || 'General',
          p.currency || 'USD',
          p.unit || 'pcs'
        );

        const productId = result.lastInsertRowid;

        if (barcodes.length > 1) {
          for (let i = 1; i < barcodes.length; i++) {
            try {
              insertBarcode.run(productId, barcodes[i]);
            } catch (e) {
              // Skip duplicate barcodes for bulk import
            }
          }
        }
      }
    });

    try {
      transaction(products);
      logAction(tenantId, 1, 'Bulk Import', `Imported ${products.length} products`);
      broadcast({ type: 'PRODUCTS_UPDATED' }, tenantId);
      res.json({ success: true, count: products.length });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/products", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const products = db.prepare("SELECT * FROM products WHERE tenant_id = ?").all(tenantId) as any[];
    const getBarcodes = db.prepare("SELECT barcode FROM product_barcodes WHERE product_id = ?");

    const productsWithBarcodes = products.map(p => {
      const extraBarcodes = getBarcodes.all(p.id).map((b: any) => b.barcode);
      return {
        ...p,
        barcodes: [p.barcode, ...extraBarcodes].filter(Boolean)
      };
    });

    res.json(productsWithBarcodes);
  });

  app.post("/api/products", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { name, price, price_lbp, package_price, package_price_lbp, cost, cost_lbp, units_per_package, stock, reorder_point, track_inventory, category, currency, unit, barcodes } = req.body;
    const primaryBarcode = barcodes && barcodes.length > 0 ? barcodes[0] : null;

    const result = db.prepare("INSERT INTO products (tenant_id, barcode, name, price, price_lbp, package_price, package_price_lbp, cost, cost_lbp, units_per_package, stock, reorder_point, track_inventory, category, currency, unit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(tenantId, primaryBarcode, name, price, price_lbp || null, package_price || null, package_price_lbp || null, cost || null, cost_lbp || null, units_per_package || 1, stock, reorder_point || 0, track_inventory === 0 ? 0 : 1, category, currency, unit);

    const productId = result.lastInsertRowid;
    logAction(tenantId, 1, 'Product Created', `Name: ${name}, Price: ${price}, Stock: ${stock}`);

    if (barcodes && barcodes.length > 1) {
      const insertBarcode = db.prepare("INSERT INTO product_barcodes (product_id, barcode) VALUES (?, ?)");
      for (let i = 1; i < barcodes.length; i++) {
        insertBarcode.run(productId, barcodes[i]);
      }
    }

    res.json({ id: productId });
    broadcast({ type: 'PRODUCTS_UPDATED' }, tenantId);
  });

  app.put("/api/products/:id", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { id } = req.params;
    const { name, price, price_lbp, package_price, package_price_lbp, cost, cost_lbp, units_per_package, stock, reorder_point, track_inventory, category, currency, unit, barcodes } = req.body;
    const primaryBarcode = barcodes && barcodes.length > 0 ? barcodes[0] : null;

    db.prepare("UPDATE products SET barcode = ?, name = ?, price = ?, price_lbp = ?, package_price = ?, package_price_lbp = ?, cost = ?, cost_lbp = ?, units_per_package = ?, stock = ?, reorder_point = ?, track_inventory = ?, category = ?, currency = ?, unit = ? WHERE id = ? AND tenant_id = ?")
      .run(primaryBarcode, name, price, price_lbp || null, package_price || null, package_price_lbp || null, cost || null, cost_lbp || null, units_per_package || 1, stock, reorder_point || 0, track_inventory === 0 ? 0 : 1, category, currency, unit, id, tenantId);

    logAction(tenantId, 1, 'Product Updated', `ID: ${id}, Name: ${name}, Price: ${price}, Stock: ${stock}`);

    // Update barcodes
    db.prepare("DELETE FROM product_barcodes WHERE product_id = ?").run(id);
    if (barcodes && barcodes.length > 1) {
      const insertBarcode = db.prepare("INSERT INTO product_barcodes (product_id, barcode) VALUES (?, ?)");
      for (let i = 1; i < barcodes.length; i++) {
        insertBarcode.run(id, barcodes[i]);
      }
    }

    res.json({ success: true });
    broadcast({ type: 'PRODUCTS_UPDATED' }, tenantId);
  });

  app.delete("/api/products/:id", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    db.prepare("DELETE FROM product_barcodes WHERE product_id IN (SELECT id FROM products WHERE id = ? AND tenant_id = ?)").run(req.params.id, tenantId);
    db.prepare("DELETE FROM products WHERE id = ? AND tenant_id = ?").run(req.params.id, tenantId);
    logAction(tenantId, 1, 'Product Deleted', `ID: ${req.params.id}`);
    res.json({ success: true });
    broadcast({ type: 'PRODUCTS_UPDATED' }, tenantId);
  });

  app.get("/api/products/:query", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const query = req.params.query;

    let product = db.prepare("SELECT * FROM products WHERE barcode = ? AND tenant_id = ?").get(query, tenantId) as any;

    if (!product) {
      const extra = db.prepare("SELECT pb.product_id FROM product_barcodes pb JOIN products p ON pb.product_id = p.id WHERE pb.barcode = ? AND p.tenant_id = ?").get(query, tenantId) as any;
      if (extra) {
        product = db.prepare("SELECT * FROM products WHERE id = ?").get(extra.product_id);
      }
    }

    if (!product) {
      product = db.prepare("SELECT * FROM products WHERE name = ? AND tenant_id = ?").get(query, tenantId);
    }

    if (!product) {
      product = db.prepare("SELECT * FROM products WHERE name LIKE ? AND tenant_id = ? COLLATE NOCASE LIMIT 1").get(`%${query}%`, tenantId);
    }

    if (product) {
      const extraBarcodes = db.prepare("SELECT barcode FROM product_barcodes WHERE product_id = ?").all(product.id).map((b: any) => b.barcode);
      res.json({
        ...product,
        barcodes: [product.barcode, ...extraBarcodes].filter(Boolean)
      });
    }
    else res.status(404).json({ error: "Product not found" });
  });

  app.get("/api/stakeholders", authenticate, (req: any, res) => {
    const stakeholders = db.prepare("SELECT * FROM stakeholders WHERE tenant_id = ?").all(req.session.tenantId);
    res.json(stakeholders);
  });

  app.get("/api/currencies", authenticate, (req: any, res) => {
    const currencies = db.prepare("SELECT * FROM currencies WHERE tenant_id = ?").all(req.session.tenantId);
    res.json(currencies);
  });

  app.post("/api/currencies", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { code, symbol, rate, is_default } = req.body;
    if (is_default) {
      db.prepare("UPDATE currencies SET is_default = 0 WHERE tenant_id = ?").run(tenantId);
    }
    const info = db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate, is_default) VALUES (?, ?, ?, ?, ?)").run(tenantId, code, symbol, rate, is_default ? 1 : 0);
    res.json({ id: info.lastInsertRowid });
  });

  app.put("/api/currencies/:id", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { id } = req.params;
    const { code, symbol, rate, is_default } = req.body;
    if (is_default) {
      db.prepare("UPDATE currencies SET is_default = 0 WHERE tenant_id = ?").run(tenantId);
    }
    db.prepare("UPDATE currencies SET code = ?, symbol = ?, rate = ?, is_default = ? WHERE id = ? AND tenant_id = ?").run(code, symbol, rate, is_default ? 1 : 0, id, tenantId);
    res.json({ success: true });
    broadcast({ type: 'SETTINGS_UPDATED' }, tenantId);
  });

  app.delete("/api/currencies/:id", authenticate, (req: any, res) => {
    db.prepare("DELETE FROM currencies WHERE id = ? AND tenant_id = ?").run(req.params.id, req.session.tenantId);
    res.json({ success: true });
  });

  // --- USER MANAGEMENT ---
  app.get("/api/users", authenticate, (req: any, res) => {
    const users = db.prepare("SELECT * FROM users WHERE tenant_id = ?").all(req.session.tenantId);
    res.json(users);
  });

  app.post("/api/users", authenticate, (req: any, res) => {
    const { name, role, pin } = req.body;
    const result = db.prepare("INSERT INTO users (tenant_id, name, role, pin) VALUES (?, ?, ?, ?)").run(req.session.tenantId, name, role || 'staff', pin || '0000');
    res.json({ id: result.lastInsertRowid });
  });

  app.put("/api/users/:id", authenticate, (req: any, res) => {
    const { name, role, pin } = req.body;
    db.prepare("UPDATE users SET name = ?, role = ?, pin = ? WHERE id = ? AND tenant_id = ?").run(name, role, pin || '0000', req.params.id, req.session.tenantId);
    res.json({ success: true });
  });

  app.delete("/api/users/:id", authenticate, (req: any, res) => {
    db.prepare("DELETE FROM users WHERE id = ? AND tenant_id = ?").run(req.params.id, req.session.tenantId);
    res.json({ success: true });
  });

  app.get("/api/settings", authenticate, (req: any, res) => {
    const settings = db.prepare("SELECT * FROM settings WHERE tenant_id = ?").all(req.session.tenantId);
    const settingsObj = (settings as any[]).reduce((acc, curr) => {
      acc[curr.key] = curr.value;
      return acc;
    }, {});
    res.json(settingsObj);
  });

  app.post("/api/settings", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const settings = req.body;
    const upsert = db.prepare("INSERT OR REPLACE INTO settings (tenant_id, key, value) VALUES (?, ?, ?)");
    for (const [key, value] of Object.entries(settings)) {
      upsert.run(tenantId, key, String(value));
    }
    logAction(tenantId, 1, 'Settings Updated', JSON.stringify(settings));
    res.json({ success: true });
    broadcast({ type: 'SETTINGS_UPDATED' }, tenantId);
  });

  app.post("/api/stakeholders", authenticate, (req: any, res) => {
    try {
      const tenantId = req.session.tenantId;
      const { name, type, email, phone, balance } = req.body;
      const result = db.prepare("INSERT INTO stakeholders (tenant_id, name, type, email, phone, balance) VALUES (?, ?, ?, ?, ?, ?)").run(tenantId, name, type, email, phone, balance);
      logAction(tenantId, 1, 'Stakeholder Created', `Name: ${name}, Type: ${type}`);
      res.json({ id: result.lastInsertRowid });
    } catch (err: any) {
      console.error("Stakeholder Create Error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/stakeholders/:id", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { name, type, email, phone, balance } = req.body;
    db.prepare("UPDATE stakeholders SET name = ?, type = ?, email = ?, phone = ?, balance = ? WHERE id = ? AND tenant_id = ?").run(name, type, email, phone, balance, req.params.id, tenantId);
    logAction(tenantId, 1, 'Stakeholder Updated', `ID: ${req.params.id}, Name: ${name}, Type: ${type}`);
    res.json({ success: true });
  });

  app.delete("/api/stakeholders/:id", authenticate, (req: any, res) => {
    db.prepare("DELETE FROM stakeholders WHERE id = ? AND tenant_id = ?").run(req.params.id, req.session.tenantId);
    logAction(req.session.tenantId, 1, 'Stakeholder Deleted', `ID: ${req.params.id}`);
    res.json({ success: true });
  });

  app.post("/api/stakeholders/settle-balance", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { stakeholder_id, amount, method, currency, exchange_rate } = req.body;

    const processDebt = db.transaction(() => {
      // Adjust balance directly — negative balance means they owe, so ADD payment to move toward zero
      // e.g. balance = -20, pays 10 → balance = -20 + 10 = -10
      db.prepare("UPDATE stakeholders SET balance = balance + ? WHERE id = ? AND tenant_id = ?").run(amount, stakeholder_id, tenantId);

      // Create a system transaction ticket to log the payment received
      const result = db.prepare(`
      INSERT INTO transactions (tenant_id, stakeholder_id, user_id, type, total_amount, currency, exchange_rate, status)
      VALUES (?, ?, ?, 'sale', 0, ?, ?, 'completed')
    `).run(tenantId, stakeholder_id, 1, currency, exchange_rate); // type sale with 0 total marks a debt payment

      const transactionId = result.lastInsertRowid;

      // Record payment receipt
      db.prepare(`
      INSERT INTO payments (transaction_id, amount, method, currency, exchange_rate)
      VALUES (?, ?, ?, ?, ?)
    `).run(transactionId, amount, method, currency, exchange_rate);

      return transactionId;
    });

    try {
      const id = processDebt();
      logAction(tenantId, 1, 'Debt Payment Received', `Amount: ${amount} ${currency}`);
      broadcast({ type: 'PRODUCTS_UPDATED' }, tenantId);
      res.json({ success: true, id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/transactions", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { stakeholder_id, user_id, type, items, currency, exchange_rate, payments, discount, tax, terminalId } = req.body;

    const transaction = db.transaction(() => {
      let calculatedTotal = 0;
      const processedItems = items.map((item: any) => {
        const product = db.prepare("SELECT price, package_price, units_per_package, track_inventory FROM products WHERE id = ? AND tenant_id = ?").get(item.id, tenantId) as any;

        let unitPrice = item.price; // Fallback to provided price
        if (type === 'sale' && product) {
          if (product.package_price && product.units_per_package > 1) {
            const numPackages = Math.floor(item.quantity / product.units_per_package);
            const remainder = item.quantity % product.units_per_package;
            const itemTotal = (numPackages * product.package_price) + (remainder * product.price);
            unitPrice = itemTotal / item.quantity;
          } else {
            unitPrice = product.price;
          }
        }

        const itemTotal = unitPrice * item.quantity;
        calculatedTotal += itemTotal;

        return { ...item, unitPrice, trackInventory: product ? product.track_inventory : 1 };
      });

      // Apply global discount/tax if any (simplified for now, usually they apply to the total)
      let finalTotal = calculatedTotal;
      if (discount?.type === 'percentage') finalTotal -= (calculatedTotal * (discount.value / 100));
      else if (discount?.type === 'fixed') finalTotal -= discount.value;

      if (tax?.type === 'percentage') finalTotal += (finalTotal * (tax.value / 100));
      else if (tax?.type === 'fixed') finalTotal += tax.value;

      const termId = terminalId || 'MAIN';
      const sequenceRow = db.prepare(`SELECT IFNULL(MAX(terminal_sequence), 0) + 1 as next_seq FROM transactions WHERE terminal_id = ? AND tenant_id = ?`).get(termId, tenantId) as any;
      const termSeq = sequenceRow.next_seq;

      const info = db.prepare(`
      INSERT INTO transactions (tenant_id, stakeholder_id, user_id, type, total_amount, currency, exchange_rate, discount_type, discount_value, tax_type, tax_value, status, terminal_id, terminal_sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        tenantId,
        stakeholder_id,
        user_id || 1,
        type || 'sale',
        finalTotal,
        currency,
        exchange_rate,
        discount?.type || null,
        discount?.value || null,
        tax?.type || null,
        tax?.value || null,
        'completed',
        termId,
        termSeq
      );

      const transactionId = info.lastInsertRowid;

      const insertItem = db.prepare(`
      INSERT INTO transaction_items (transaction_id, product_id, quantity, unit_price, discount_type, discount_value, tax_type, tax_value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

      let stockChange = '-';
      if (type === 'purchase') stockChange = '+';
      if (type === 'refund') stockChange = '+';

      const updateStock = db.prepare(`
      UPDATE products SET stock = stock ${stockChange} ? WHERE id = ? AND tenant_id = ?
    `);

      for (const item of processedItems) {
        insertItem.run(
          transactionId,
          item.id,
          item.quantity,
          item.unitPrice,
          item.discount?.type || null,
          item.discount?.value || null,
          item.tax?.type || null,
          item.tax?.value || null
        );
        if (item.trackInventory !== 0) {
          updateStock.run(item.quantity, item.id, tenantId);
        }
      }

      let totalPaid = 0;
      if (payments && payments.length > 0) {
        const insertPayment = db.prepare(`
        INSERT INTO payments (transaction_id, amount, method, currency, exchange_rate)
        VALUES (?, ?, ?, ?, ?)
      `);
        for (const payment of payments) {
          insertPayment.run(transactionId, payment.amount, payment.method, payment.currency, payment.exchange_rate);
          if (payment.method !== 'credit') {
            totalPaid += (payment.amount / (payment.exchange_rate || 1));
          }
        }
      }

      const remaining = finalTotal - totalPaid;
      if (Math.abs(remaining) > 0.01) {
        const balanceChange = (type === 'sale') ? remaining : -remaining;
        db.prepare("UPDATE stakeholders SET balance = balance + ? WHERE id = ? AND tenant_id = ?").run(balanceChange, stakeholder_id, tenantId);
      }

      return transactionId;
    });

    try {
      const id = transaction();
      const fullTransaction = db.prepare(`
      SELECT t.*, s.name as stakeholder_name, u.name as user_name
      FROM transactions t 
      LEFT JOIN stakeholders s ON t.stakeholder_id = s.id 
      LEFT JOIN users u ON t.user_id = u.id
      WHERE t.id = ?
    `).get(id);

      res.json({ id, success: true });
      logAction(tenantId, user_id || 1, `Transaction: ${type || 'sale'}`, `ID: ${id}, Total: ${fullTransaction.total_amount} ${fullTransaction.currency}`);
      broadcast({ type: 'TRANSACTIONS_UPDATED', transaction: fullTransaction, terminalId }, tenantId);
      broadcast({ type: 'PRODUCTS_UPDATED' }, tenantId);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/transactions/:id", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { id } = req.params;

    const tx = db.prepare("SELECT * FROM transactions WHERE id = ? AND tenant_id = ?").get(id, tenantId) as any;
    if (!tx) return res.status(404).json({ error: "Transaction not found" });

    const deleteTx = db.transaction(() => {
      // Restore stock
      const items = db.prepare(`
        SELECT ti.*, p.track_inventory FROM transaction_items ti
        JOIN products p ON p.id = ti.product_id
        WHERE ti.transaction_id = ?
      `).all(id) as any[];
      for (const item of items) {
        if (item.track_inventory === 0) continue;
        if (tx.type === 'sale') {
          db.prepare("UPDATE products SET stock = stock + ? WHERE id = ? AND tenant_id = ?").run(item.quantity, item.product_id, tenantId);
        } else if (tx.type === 'purchase' || tx.type === 'refund') {
          db.prepare("UPDATE products SET stock = stock - ? WHERE id = ? AND tenant_id = ?").run(item.quantity, item.product_id, tenantId);
        }
      }

      // Reverse stakeholder balance change
      if (tx.stakeholder_id) {
        const payments = db.prepare("SELECT * FROM payments WHERE transaction_id = ?").all(id) as any[];
        let totalPaid = 0;
        for (const p of payments) {
          if (p.method !== 'credit') {
            totalPaid += (p.amount / (p.exchange_rate || 1));
          }
        }
        const remaining = tx.total_amount - totalPaid;
        if (Math.abs(remaining) > 0.01) {
          // Reverse: for sale, remaining was added to balance; for purchase, -remaining was added
          const reversal = (tx.type === 'sale') ? -remaining : remaining;
          db.prepare("UPDATE stakeholders SET balance = balance + ? WHERE id = ? AND tenant_id = ?").run(reversal, tx.stakeholder_id, tenantId);
        }
      }

      db.prepare("DELETE FROM payments WHERE transaction_id = ?").run(id);
      db.prepare("DELETE FROM transaction_items WHERE transaction_id = ?").run(id);
      db.prepare("DELETE FROM transactions WHERE id = ? AND tenant_id = ?").run(id, tenantId);
    });

    try {
      deleteTx();
      logAction(tenantId, 1, 'Transaction Deleted', `ID: ${id}, Type: ${tx.type}, Total: ${tx.total_amount}`);
      broadcast({ type: 'TRANSACTIONS_UPDATED' }, tenantId);
      broadcast({ type: 'PRODUCTS_UPDATED' }, tenantId);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });


  app.get("/api/users", authenticate, (req: any, res) => {
    const users = db.prepare("SELECT * FROM users WHERE tenant_id = ?").all(req.session.tenantId);
    res.json(users);
  });

  app.get("/api/reports/daily-sales", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { date } = req.query;
    const targetDate = date ? String(date) : new Date().toISOString().split('T')[0];

    const transactions = db.prepare(`
    SELECT t.*, s.name as stakeholder_name, u.name as user_name
    FROM transactions t 
    LEFT JOIN stakeholders s ON t.stakeholder_id = s.id 
    LEFT JOIN users u ON t.user_id = u.id
    WHERE date(t.created_at) = date(?) AND t.tenant_id = ? AND t.type != 'purchase'
    ORDER BY t.created_at DESC
  `).all(targetDate, tenantId);

    res.json(transactions);
  });

  app.get("/api/transactions/recent", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { type, stakeholder_id, date_from, date_to } = req.query;

    let query = `
    SELECT t.*, s.name as stakeholder_name, u.name as user_name
    FROM transactions t 
    LEFT JOIN stakeholders s ON t.stakeholder_id = s.id 
    LEFT JOIN users u ON t.user_id = u.id
    WHERE t.tenant_id = ?`;
    const params: any[] = [tenantId];

    if (type && type !== 'all') {
      query += " AND t.type = ?";
      params.push(type);
    }
    if (stakeholder_id && stakeholder_id !== 'all') {
      query += " AND t.stakeholder_id = ?";
      params.push(stakeholder_id);
    }
    if (date_from) {
      query += " AND date(t.created_at) >= date(?)";
      params.push(date_from);
    }
    if (date_to) {
      query += " AND date(t.created_at) <= date(?)";
      params.push(date_to);
    }

    query += " ORDER BY t.created_at DESC LIMIT 200";

    const transactions = db.prepare(query).all(...params);
    res.json(transactions);
  });

  app.get("/api/transactions/:id", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const transaction = db.prepare(`
    SELECT t.*, s.name as stakeholder_name, u.name as user_name
    FROM transactions t 
    LEFT JOIN stakeholders s ON t.stakeholder_id = s.id 
    LEFT JOIN users u ON t.user_id = u.id
    WHERE t.id = ? AND t.tenant_id = ?
  `).get(req.params.id, tenantId) as any;

    if (!transaction) return res.status(404).json({ error: "Transaction not found" });

    const items = db.prepare(`
    SELECT ti.*, p.name as product_name, p.barcode, p.cost
    FROM transaction_items ti 
    JOIN products p ON ti.product_id = p.id 
    WHERE ti.transaction_id = ?
  `).all(req.params.id);

    transaction.items = items.map((item: any) => ({
      ...item,
      price: item.unit_price,
      discount: item.discount_type ? { type: item.discount_type, value: item.discount_value } : undefined
    }));

    transaction.discount = transaction.discount_type ? { type: transaction.discount_type, value: transaction.discount_value } : undefined;

    // Include payments and paid_amount for edit support
    const payments = db.prepare("SELECT * FROM payments WHERE transaction_id = ? ORDER BY created_at ASC").all(req.params.id) as any[];
    const paidAmount = payments.reduce((sum: number, p: any) => sum + (p.amount / (p.exchange_rate || 1)), 0);
    transaction.payments = payments;
    transaction.paid_amount = paidAmount;

    res.json(transaction);
  });

  app.get("/api/logs", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const logs = db.prepare(`
    SELECT l.*, u.name as user_name 
    FROM user_logs l 
    LEFT JOIN users u ON l.user_id = u.id 
    WHERE l.tenant_id = ? 
    ORDER BY l.created_at DESC 
    LIMIT 100
  `).all(tenantId);
    res.json(logs);
  });

  app.get("/api/reports/sales", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const sales = db.prepare(`
    SELECT 
      DATE(created_at) as date, 
      SUM(CASE WHEN type = 'refund' THEN -total_amount ELSE total_amount END) as total,
      COUNT(id) as count
    FROM transactions 
    WHERE tenant_id = ? AND type != 'purchase'
    GROUP BY DATE(created_at)
    ORDER BY date DESC
    LIMIT 30
  `).all(tenantId);
    res.json(sales);
  });

  app.get("/api/reports/daily-sales-by-payment", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const sales = db.prepare(`
    SELECT p.method, SUM(p.amount) as total
    FROM payments p
    JOIN transactions t ON p.transaction_id = t.id
    WHERE t.tenant_id = ? AND t.type = 'sale' AND date(p.created_at) = ?
    GROUP BY p.method
  `).all(tenantId, date);
    res.json(sales);
  });

  app.get("/api/reports/daily-sales-by-customer", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const sales = db.prepare(`
    SELECT s.name as customer, SUM(t.total_amount) as total
    FROM transactions t
    JOIN stakeholders s ON t.stakeholder_id = s.id
    WHERE t.tenant_id = ? AND t.type = 'sale' AND date(t.created_at) = ?
    GROUP BY s.id
  `).all(tenantId, date);
    res.json(sales);
  });

  app.get("/api/reports/unpaid-sales", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const unpaid = db.prepare(`
    SELECT * FROM (
        SELECT t.id, s.name as customer, t.total_amount, 
               (t.total_amount - (SELECT IFNULL(SUM(amount), 0) FROM payments WHERE transaction_id = t.id)) as balance,
               t.created_at
        FROM transactions t
        JOIN stakeholders s ON t.stakeholder_id = s.id
        WHERE t.tenant_id = ? AND t.type = 'sale'
    ) WHERE balance > 0
    ORDER BY created_at DESC
  `).all(tenantId);
    res.json(unpaid);
  });

  app.get("/api/reports/unpaid-purchases", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const unpaid = db.prepare(`
    SELECT * FROM (
        SELECT t.id, s.name as supplier, t.total_amount, 
               (t.total_amount - (SELECT IFNULL(SUM(amount), 0) FROM payments WHERE transaction_id = t.id)) as balance,
               t.created_at
        FROM transactions t
        JOIN stakeholders s ON t.stakeholder_id = s.id
        WHERE t.tenant_id = ? AND t.type = 'purchase'
    ) WHERE balance > 0
    ORDER BY created_at DESC
  `).all(tenantId);
    res.json(unpaid);
  });

  app.post("/api/reports/custom-builder", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const {
      stakeholderId,
      type,
      status,
      fromDate,
      toDate,
      productId,
      invoiceNumber,
      category
    } = req.body;

    let query = `
    SELECT 
      t.id as invoice_no,
      t.created_at as date,
      t.type,
      s.name as stakeholder,
      t.total_amount,
      t.currency,
      (SELECT IFNULL(SUM(amount), 0) FROM payments WHERE transaction_id = t.id) as paid_amount,
      (t.total_amount - (SELECT IFNULL(SUM(amount), 0) FROM payments WHERE transaction_id = t.id)) as balance,
      u.name as processed_by
    FROM transactions t
    LEFT JOIN stakeholders s ON t.stakeholder_id = s.id
    LEFT JOIN users u ON t.user_id = u.id
    WHERE t.tenant_id = ?
  `;
    const params: any[] = [tenantId];

    if (stakeholderId) {
      query += " AND t.stakeholder_id = ?";
      params.push(stakeholderId);
    }
    if (type) {
      query += " AND t.type = ?";
      params.push(type);
    }
    if (fromDate) {
      query += " AND date(t.created_at) >= date(?)";
      params.push(fromDate);
    }
    if (toDate) {
      query += " AND date(t.created_at) <= date(?)";
      params.push(toDate);
    }
    if (invoiceNumber) {
      query += " AND t.id = ?";
      params.push(invoiceNumber);
    }
    if (productId) {
      query += " AND t.id IN (SELECT transaction_id FROM transaction_items WHERE product_id = ?)";
      params.push(productId);
    }
    if (category) {
      query += " AND t.id IN (SELECT ti.transaction_id FROM transaction_items ti JOIN products p ON ti.product_id = p.id WHERE p.category = ?)";
      params.push(category);
    }

    // Handle paid/unpaid status
    if (status === 'paid') {
      query += " AND (t.total_amount - (SELECT IFNULL(SUM(amount), 0) FROM payments WHERE transaction_id = t.id)) <= 0.01";
    } else if (status === 'unpaid') {
      query += " AND (t.total_amount - (SELECT IFNULL(SUM(amount), 0) FROM payments WHERE transaction_id = t.id)) > 0.01";
    }

    query += " ORDER BY t.created_at DESC";

    try {
      const results = db.prepare(query).all(...params);
      res.json(results);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/reports/customer-statement/:id", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const stakeholderId = req.params.id;

    // Get all transactions for this stakeholder
    const transactions = db.prepare(`
    SELECT t.*, u.name as user_name
    FROM transactions t
    LEFT JOIN users u ON t.user_id = u.id
    WHERE t.tenant_id = ? AND t.stakeholder_id = ?
    ORDER BY t.created_at ASC
  `).all(tenantId, stakeholderId) as any[];

    const statement: any[] = [];
    let runningBalance = 0;

    for (const t of transactions) {
      // 1. Add the transaction itself as a debit (for sales) or credit (for refunds/purchases)
      // For a customer statement: Sale is Debit (+), Refund is Credit (-), Purchase is usually not for customers but let's handle it
      let debit = 0;
      let credit = 0;
      let description = "";

      if (t.type === 'sale') {
        debit = t.total_amount;
        description = `Invoice #${t.id}`;
      } else if (t.type === 'refund') {
        credit = t.total_amount;
        description = `Refund #${t.id}`;
      } else if (t.type === 'purchase') {
        // If a customer is also a supplier? Usually separate, but let's say purchase decreases what they owe us? 
        // Actually for a customer, a purchase from them is like a credit to their account.
        credit = t.total_amount;
        description = `Purchase #${t.id}`;
      }

      // Get items for this transaction to include in description
      const items = db.prepare(`
      SELECT ti.quantity, p.name
      FROM transaction_items ti
      JOIN products p ON ti.product_id = p.id
      WHERE ti.transaction_id = ?
    `).all(t.id) as any[];

      const itemsList = items.map(i => `${i.quantity}x ${i.name}`).join(', ');
      if (itemsList) description += ` (${itemsList})`;

      runningBalance += (debit - credit);

      statement.push({
        date: t.created_at,
        type: t.type,
        reference: `#${t.id}`,
        description,
        debit,
        credit,
        balance: runningBalance,
        user: t.user_name
      });

      // 2. Add payments for this transaction as credits
      const payments = db.prepare(`
      SELECT * FROM payments WHERE transaction_id = ?
    `).all(t.id) as any[];

      for (const p of payments) {
        const pCredit = p.amount;
        const pDebit = 0;
        runningBalance -= pCredit;

        statement.push({
          date: p.created_at,
          type: 'payment',
          reference: `Pay for #${t.id}`,
          description: `Payment (${p.method})`,
          debit: pDebit,
          credit: pCredit,
          balance: runningBalance,
          user: t.user_name // Payment usually recorded by same user or we don't track user per payment in schema
        });
      }
    }

    res.json(statement);
  });

  // Cash Flow & Reports
  app.get("/api/cash-flow/summary", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const today = new Date().toISOString().split('T')[0];

    // Get last closing balance
    const lastReport = db.prepare("SELECT actual_balance FROM daily_reports WHERE tenant_id = ? ORDER BY date DESC LIMIT 1").get(tenantId) as any;
    const openingBalance = lastReport ? lastReport.actual_balance : 0;

    // Get cash sales today
    const cashSales = db.prepare(`
    SELECT SUM(p.amount / p.exchange_rate) as total
    FROM payments p
    JOIN transactions t ON p.transaction_id = t.id
    WHERE t.tenant_id = ? AND t.type = 'sale' AND p.method = 'cash' AND date(p.created_at) = ?
  `).get(tenantId, today) as any;

    // Get cash refunds today
    const cashRefunds = db.prepare(`
    SELECT SUM(p.amount / p.exchange_rate) as total
    FROM payments p
    JOIN transactions t ON p.transaction_id = t.id
    WHERE t.tenant_id = ? AND t.type = 'refund' AND p.method = 'cash' AND date(p.created_at) = ?
  `).get(tenantId, today) as any;

    // Get cash purchases today
    const cashPurchases = db.prepare(`
    SELECT SUM(p.amount / p.exchange_rate) as total
    FROM payments p
    JOIN transactions t ON p.transaction_id = t.id
    WHERE t.tenant_id = ? AND t.type = 'purchase' AND p.method = 'cash' AND date(p.created_at) = ?
  `).get(tenantId, today) as any;

    // Get cash in/out today
    const cashFlow = db.prepare(`
    SELECT 
      SUM(CASE WHEN type = 'in' THEN amount / exchange_rate ELSE 0 END) as total_in,
      SUM(CASE WHEN type = 'out' THEN amount / exchange_rate ELSE 0 END) as total_out
    FROM cash_flow
    WHERE tenant_id = ? AND date(created_at) = ?
  `).get(tenantId, today) as any;

    const totalSales = cashSales?.total || 0;
    const totalRefunds = cashRefunds?.total || 0;
    const totalPurchases = cashPurchases?.total || 0;
    const totalIn = cashFlow?.total_in || 0;
    const totalOut = cashFlow?.total_out || 0;
    const expectedBalance = openingBalance + totalSales - totalRefunds - totalPurchases + totalIn - totalOut;

    res.json({
      openingBalance,
      totalSales,
      totalRefunds,
      totalPurchases,
      totalIn,
      totalOut,
      expectedBalance
    });
  });

  app.post("/api/cash-flow", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const userId = req.body.user_id || 1;
    const { type, amount, currency, exchange_rate, reason } = req.body;

    db.prepare("INSERT INTO cash_flow (tenant_id, user_id, type, amount, currency, exchange_rate, reason) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(tenantId, userId, type, amount, currency || 'USD', exchange_rate || 1, reason);

    logAction(tenantId, userId, `Cash ${type === 'in' ? 'In' : 'Out'}`, `Amount: ${amount} ${currency}, Reason: ${reason}`);
    broadcast({ type: 'CASH_FLOW_UPDATED' }, tenantId);
    res.json({ success: true });
  });

  // Balance payment: collect from customer or pay supplier
  app.post("/api/balance-payment", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const userId = req.body.user_id || 1;
    const { stakeholder_id, amount, currency, exchange_rate, direction } = req.body;
    // direction: 'collect' = customer pays us, 'pay' = we pay supplier

    if (!stakeholder_id || !amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid payment data" });
    }

    const stakeholder = db.prepare("SELECT * FROM stakeholders WHERE id = ? AND tenant_id = ?").get(stakeholder_id, tenantId) as any;
    if (!stakeholder) return res.status(404).json({ error: "Stakeholder not found" });

    const amountUSD = amount / (exchange_rate || 1);
    const cur = currency || 'USD';
    const exRate = exchange_rate || 1;

    const balancePayment = db.transaction(() => {
      if (direction === 'collect') {
        // Customer paying their balance → negative balance means they owe, ADD to move toward zero
        // e.g. balance = -20, pays 10 → balance = -20 + 10 = -10
        db.prepare("UPDATE stakeholders SET balance = balance + ? WHERE id = ? AND tenant_id = ?").run(amountUSD, stakeholder_id, tenantId);
        db.prepare("INSERT INTO cash_flow (tenant_id, user_id, type, amount, currency, exchange_rate, reason) VALUES (?, ?, 'in', ?, ?, ?, ?)")
          .run(tenantId, userId, amount, cur, exRate, `Balance collection from ${stakeholder.name}`);
      } else {
        // Paying a supplier → reduce their outstanding (increase balance), cash goes out
        db.prepare("UPDATE stakeholders SET balance = balance + ? WHERE id = ? AND tenant_id = ?").run(amountUSD, stakeholder_id, tenantId);
        db.prepare("INSERT INTO cash_flow (tenant_id, user_id, type, amount, currency, exchange_rate, reason) VALUES (?, ?, 'out', ?, ?, ?, ?)")
          .run(tenantId, userId, amount, cur, exRate, `Payment to supplier ${stakeholder.name}`);
      }
    });

    try {
      balancePayment();
      logAction(tenantId, userId, `Balance ${direction === 'collect' ? 'Collection' : 'Payment'}`,
        `${stakeholder.name}: ${amount} ${cur}`);
      broadcast({ type: 'CASH_FLOW_UPDATED' }, tenantId);
      broadcast({ type: 'STAKEHOLDERS_UPDATED' }, tenantId);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/cash-flow", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const today = new Date().toISOString().split('T')[0];
    const entries = db.prepare("SELECT * FROM cash_flow WHERE tenant_id = ? AND date(created_at) = ? ORDER BY created_at DESC").all(tenantId, today);
    res.json(entries);
  });

  app.post("/api/reports/daily", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const userId = req.body.user_id || 1;
    const {
      date,
      opening_balance,
      total_sales,
      total_purchases,
      total_cash_in,
      total_cash_out,
      closing_balance,
      actual_balance,
      notes
    } = req.body;

    const difference = actual_balance - closing_balance;

    const result = db.prepare(`
    INSERT INTO daily_reports 
    (tenant_id, user_id, date, opening_balance, total_sales, total_purchases, total_cash_in, total_cash_out, closing_balance, actual_balance, difference, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tenantId, userId, date, opening_balance, total_sales, total_purchases, total_cash_in, total_cash_out, closing_balance, actual_balance, difference, notes);

    logAction(tenantId, userId, 'Daily Report Created', `Date: ${date}, Closing: ${closing_balance}, Actual: ${actual_balance}`);
    res.json({ success: true, id: result.lastInsertRowid });
  });

  app.get("/api/reports/daily", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const reports = db.prepare("SELECT r.*, u.name as user_name FROM daily_reports r LEFT JOIN users u ON r.user_id = u.id WHERE r.tenant_id = ? ORDER BY r.date DESC").all(tenantId);
    res.json(reports);
  });

  app.post("/api/reports/yearly", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const userId = req.body.user_id || 1;
    const { year, notes } = req.body;

    // Calculate totals for the year
    const totals = db.prepare(`
    SELECT 
      SUM(CASE WHEN type = 'sale' THEN total_amount ELSE 0 END) as sales,
      SUM(CASE WHEN type = 'purchase' THEN total_amount ELSE 0 END) as purchases
    FROM transactions
    WHERE tenant_id = ? AND strftime('%Y', created_at) = ?
  `).get(tenantId, String(year)) as any;

    const totalSales = totals?.sales || 0;
    const totalPurchases = totals?.purchases || 0;
    const totalProfit = totalSales - totalPurchases;

    const result = db.prepare(`
    INSERT INTO yearly_reports (tenant_id, user_id, year, total_sales, total_purchases, total_profit, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(tenantId, userId, year, totalSales, totalPurchases, totalProfit, notes);

    logAction(tenantId, userId, 'Yearly Report Created', `Year: ${year}, Profit: ${totalProfit}`);
    res.json({ success: true, id: result.lastInsertRowid });
  });

  app.get("/api/reports/yearly", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const reports = db.prepare("SELECT r.*, u.name as user_name FROM yearly_reports r LEFT JOIN users u ON r.user_id = u.id WHERE r.tenant_id = ? ORDER BY r.year DESC").all(tenantId);
    res.json(reports);
  });


  // --- PURCHASE MANAGEMENT ---
  app.get("/api/purchases", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { status, supplier_id, from, to, search } = req.query;

    let query = `
    SELECT 
      t.id,
      t.created_at,
      t.total_amount,
      t.currency,
      t.exchange_rate,
      t.status,
      t.terminal_id,
      t.terminal_sequence,
      t.discount_type,
      t.discount_value,
      t.tax_type,
      t.tax_value,
      s.name as supplier_name,
      s.id as supplier_id,
      (SELECT COUNT(*) FROM transaction_items WHERE transaction_id = t.id) as item_count,
      (SELECT IFNULL(SUM(amount / exchange_rate), 0) FROM payments WHERE transaction_id = t.id) as paid_amount
    FROM transactions t
    LEFT JOIN stakeholders s ON t.stakeholder_id = s.id
    WHERE t.tenant_id = ? AND t.type = 'purchase'
  `;
    const params: any[] = [tenantId];

    if (supplier_id) {
      query += " AND t.stakeholder_id = ?";
      params.push(supplier_id);
    }
    if (from) {
      query += " AND date(t.created_at) >= date(?)";
      params.push(from);
    }
    if (to) {
      query += " AND date(t.created_at) <= date(?)";
      params.push(to);
    }
    if (search) {
      query += " AND s.name LIKE ?";
      params.push(`%${search}%`);
    }

    // Filter by paid/unpaid status
    if (status === 'paid') {
      query += " AND (t.total_amount - (SELECT IFNULL(SUM(amount / exchange_rate), 0) FROM payments WHERE transaction_id = t.id)) <= 0.01";
    } else if (status === 'unpaid') {
      query += " AND (t.total_amount - (SELECT IFNULL(SUM(amount / exchange_rate), 0) FROM payments WHERE transaction_id = t.id)) > 0.01";
    }

    query += " ORDER BY t.created_at DESC";

    try {
      const purchases = db.prepare(query).all(...params);
      res.json(purchases);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/purchases/:id", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { id } = req.params;

    const purchase = db.prepare(`
    SELECT 
      t.*,
      s.name as supplier_name,
      s.email as supplier_email,
      s.phone as supplier_phone,
      u.name as user_name
    FROM transactions t
    LEFT JOIN stakeholders s ON t.stakeholder_id = s.id
    LEFT JOIN users u ON t.user_id = u.id
    WHERE t.id = ? AND t.tenant_id = ? AND t.type = 'purchase'
  `).get(id, tenantId) as any;

    if (!purchase) return res.status(404).json({ error: "Purchase order not found" });

    const items = db.prepare(`
    SELECT ti.*, p.name as product_name, p.barcode, p.category, p.unit, p.cost, p.cost_lbp
    FROM transaction_items ti
    JOIN products p ON ti.product_id = p.id
    WHERE ti.transaction_id = ?
  `).all(id);

    const payments = db.prepare(`
    SELECT * FROM payments WHERE transaction_id = ? ORDER BY created_at ASC
  `).all(id);

    const paidAmount = (payments as any[]).reduce((sum: number, p: any) => sum + (p.amount / (p.exchange_rate || 1)), 0);

    res.json({
      ...purchase,
      items,
      payments,
      paid_amount: paidAmount,
      balance: purchase.total_amount - paidAmount
    });
  });

  app.put("/api/purchases/:id/receive", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { id } = req.params;

    const purchase = db.prepare("SELECT * FROM transactions WHERE id = ? AND tenant_id = ? AND type = 'purchase'").get(id, tenantId) as any;
    if (!purchase) return res.status(404).json({ error: "Purchase order not found" });

    db.prepare("UPDATE transactions SET status = 'received' WHERE id = ? AND tenant_id = ?").run(id, tenantId);
    logAction(tenantId, 1, 'Purchase Received', `PO #${id} marked as received`);
    broadcast({ type: 'PURCHASES_UPDATED' }, tenantId);
    res.json({ success: true });
  });

  // --- PRINTER MANAGEMENT ---

  // Scan for available printers (USB via OS, Network via TCP port 9100)
  app.get("/api/printers/scan", authenticate, async (req: any, res) => {
    const connType = req.query.type as string; // 'usb' | 'network'

    try {
      if (connType === 'usb') {
        // Use PowerShell to list OS-installed printers with their port names
        const { exec } = require('child_process');
        exec(
          'powershell -NoProfile -Command "Get-Printer | Select-Object Name,PortName | ConvertTo-Json -Compress"',
          { timeout: 12000 },
          (err: any, stdout: string) => {
            if (err) {
              console.error('USB printer scan error:', err.message);
              return res.json({ printers: [] });
            }
            try {
              const raw = JSON.parse(stdout.trim());
              const list = Array.isArray(raw) ? raw : [raw];
              const printers = list
                .filter((p: any) => p.PortName && !['PORTPROMPT:', 'FILE:', 'NPCAP:', 'XPSPort:'].some(x => (p.PortName || '').startsWith(x)))
                .map((p: any) => ({ name: p.Name, address: p.PortName }));
              res.json({ printers });
            } catch {
              res.json({ printers: [] });
            }
          }
        );
      } else if (connType === 'network') {
        // Detect local subnet then probe port 9100 (RAW printing) across all 254 hosts
        const os = require('os');
        const net = require('net');

        let subnet = '192.168.1';
        const ifaces = os.networkInterfaces() as Record<string, any[]>;
        for (const iface of Object.values(ifaces)) {
          for (const addr of iface) {
            if (addr.family === 'IPv4' && !addr.internal) {
              subnet = addr.address.split('.').slice(0, 3).join('.');
              break;
            }
          }
        }

        const found: { name: string; address: string }[] = [];
        const TIMEOUT_MS = 600;
        const PORT = 9100;

        const probes = Array.from({ length: 254 }, (_, i) => {
          const ip = `${subnet}.${i + 1}`;
          return new Promise<void>(resolve => {
            const socket = new net.Socket();
            socket.setTimeout(TIMEOUT_MS);
            socket.on('connect', () => {
              found.push({ name: `Network Printer (${ip})`, address: ip });
              socket.destroy();
              resolve();
            });
            socket.on('error', () => { socket.destroy(); resolve(); });
            socket.on('timeout', () => { socket.destroy(); resolve(); });
            socket.connect(PORT, ip);
          });
        });

        await Promise.all(probes);
        res.json({ printers: found });
      } else {
        res.json({ printers: [] });
      }
    } catch (err: any) {
      console.error('Printer scan error:', err.message);
      res.json({ printers: [] });
    }
  });

  app.get("/api/printers", authenticate, (req: any, res) => {
    const printers = db.prepare("SELECT * FROM printers WHERE tenant_id = ? ORDER BY type, name").all(req.session.tenantId);
    res.json(printers);
  });


  app.post("/api/printers", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { name, type, connection, address, paper_width, is_default, enabled } = req.body;

    // If this is set as default for its type, unset others of same type
    if (is_default) {
      db.prepare("UPDATE printers SET is_default = 0 WHERE tenant_id = ? AND type = ?").run(tenantId, type);
    }

    const result = db.prepare(
      "INSERT INTO printers (tenant_id, name, type, connection, address, paper_width, is_default, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(tenantId, name, type, connection, address || '', paper_width || 80, is_default ? 1 : 0, enabled !== undefined ? (enabled ? 1 : 0) : 1);

    logAction(tenantId, 1, 'Printer Added', `Name: ${name}, Type: ${type}, Connection: ${connection}`);
    broadcast({ type: 'SETTINGS_UPDATED' }, tenantId);
    res.json({ id: result.lastInsertRowid });
  });

  app.put("/api/printers/:id", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { id } = req.params;
    const { name, type, connection, address, paper_width, is_default, enabled } = req.body;

    // If this is set as default for its type, unset others of same type
    if (is_default) {
      db.prepare("UPDATE printers SET is_default = 0 WHERE tenant_id = ? AND type = ? AND id != ?").run(tenantId, type, id);
    }

    db.prepare(
      "UPDATE printers SET name = ?, type = ?, connection = ?, address = ?, paper_width = ?, is_default = ?, enabled = ? WHERE id = ? AND tenant_id = ?"
    ).run(name, type, connection, address || '', paper_width || 80, is_default ? 1 : 0, enabled ? 1 : 0, id, tenantId);

    logAction(tenantId, 1, 'Printer Updated', `ID: ${id}, Name: ${name}`);
    broadcast({ type: 'SETTINGS_UPDATED' }, tenantId);
    res.json({ success: true });
  });

  app.delete("/api/printers/:id", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    db.prepare("DELETE FROM printers WHERE id = ? AND tenant_id = ?").run(req.params.id, tenantId);
    logAction(tenantId, 1, 'Printer Deleted', `ID: ${req.params.id}`);
    broadcast({ type: 'SETTINGS_UPDATED' }, tenantId);
    res.json({ success: true });
  });

  // --- ESC/POS PRINTING & CASH DRAWER ---

  function getSettingsMap(tenantId: number): Record<string, string> {
    const rows = db.prepare("SELECT key, value FROM settings WHERE tenant_id = ?").all(tenantId) as any[];
    return rows.reduce((acc: any, r: any) => { acc[r.key] = r.value; return acc; }, {});
  }

  function resolveReceiptPrinter(tenantId: number, printerId?: number) {
    if (printerId) {
      return db.prepare("SELECT * FROM printers WHERE id = ? AND tenant_id = ? AND enabled = 1").get(printerId, tenantId) as any;
    }
    return db.prepare("SELECT * FROM printers WHERE tenant_id = ? AND type = 'receipt' AND is_default = 1 AND enabled = 1").get(tenantId) as any;
  }

  app.post("/api/print/receipt", authenticate, async (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { transactionId, printerId, openDrawer } = req.body;

    try {
      const printer = resolveReceiptPrinter(tenantId, printerId);
      if (!printer) return res.status(404).json({ error: "No enabled receipt printer configured" });

      const transaction = db.prepare(`
        SELECT t.*, s.name as stakeholder_name
        FROM transactions t
        LEFT JOIN stakeholders s ON t.stakeholder_id = s.id
        WHERE t.id = ? AND t.tenant_id = ?
      `).get(transactionId, tenantId) as any;
      if (!transaction) return res.status(404).json({ error: "Transaction not found" });

      const items = db.prepare(`
        SELECT ti.*, p.name FROM transaction_items ti JOIN products p ON ti.product_id = p.id WHERE ti.transaction_id = ?
      `).all(transactionId) as any[];
      transaction.items = items.map((i: any) => ({
        ...i,
        price: i.unit_price,
        discount: i.discount_type ? { type: i.discount_type, value: i.discount_value } : undefined
      }));
      transaction.discount = transaction.discount_type ? { type: transaction.discount_type, value: transaction.discount_value } : undefined;
      transaction.payments = db.prepare("SELECT * FROM payments WHERE transaction_id = ?").all(transactionId);

      const settings = getSettingsMap(tenantId);
      const buffer = buildReceiptBuffer({
        storeName: settings.store_name,
        businessAddress: settings.business_address,
        businessPhone: settings.business_phone,
        receiptFooter: settings.receipt_footer,
        paperWidth: printer.paper_width,
        transaction,
        openDrawer: !!openDrawer
      });

      await sendToPrinter(printer, buffer);
      res.json({ success: true });
    } catch (err: any) {
      console.error('Print receipt error:', err.message);
      res.status(500).json({ error: err.message || 'Failed to print receipt' });
    }
  });

  app.post("/api/print/drawer-kick", authenticate, async (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { printerId } = req.body;
    try {
      const printer = resolveReceiptPrinter(tenantId, printerId);
      if (!printer) return res.status(404).json({ error: "No enabled receipt printer configured" });
      const buffer = new EscPos().init().openDrawer(0).toBuffer();
      await sendToPrinter(printer, buffer);
      res.json({ success: true });
    } catch (err: any) {
      console.error('Drawer kick error:', err.message);
      res.status(500).json({ error: err.message || 'Failed to open drawer' });
    }
  });

  app.post("/api/print/test", authenticate, async (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { printerId } = req.body;
    try {
      const printer = printerId
        ? db.prepare("SELECT * FROM printers WHERE id = ? AND tenant_id = ?").get(printerId, tenantId) as any
        : null;
      if (!printer) return res.status(404).json({ error: "Printer not found" });

      const settings = getSettingsMap(tenantId);
      const buffer = buildTestPrintBuffer({
        storeName: settings.store_name,
        printerName: printer.name,
        connection: printer.connection,
        paperWidth: printer.paper_width
      });

      await sendToPrinter(printer, buffer);
      res.json({ success: true });
    } catch (err: any) {
      console.error('Test print error:', err.message);
      res.status(500).json({ error: err.message || 'Failed to print test page' });
    }
  });

}


