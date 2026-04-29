-- Portal ERP Database Schema (SQLite)
-- Covers Modules 1..29

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ============================================================
-- 24. Users & Roles
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','accountant','salesperson','production','store')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ============================================================
-- 1. Product Management
-- ============================================================
CREATE TABLE IF NOT EXISTS product_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category_id INTEGER,
  hsn_code TEXT,
  size TEXT,
  color TEXT,
  unit TEXT NOT NULL DEFAULT 'PCS',
  mrp REAL NOT NULL DEFAULT 0,
  sale_price REAL NOT NULL DEFAULT 0,
  cost_price REAL NOT NULL DEFAULT 0,
  gst_rate REAL NOT NULL DEFAULT 5,
  reorder_level INTEGER DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (category_id) REFERENCES product_categories(id)
);

-- ============================================================
-- 2. Raw Material Management
-- ============================================================
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  gstin TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS raw_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  type TEXT,        -- fabric, button, zipper, thread, label, etc.
  unit TEXT NOT NULL DEFAULT 'MTR',
  current_stock REAL NOT NULL DEFAULT 0,
  reorder_level REAL DEFAULT 0,
  cost_per_unit REAL NOT NULL DEFAULT 0,
  supplier_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

CREATE TABLE IF NOT EXISTS raw_material_txns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_material_id INTEGER NOT NULL,
  txn_type TEXT NOT NULL CHECK(txn_type IN ('purchase','issue','return','adjustment')),
  quantity REAL NOT NULL,
  rate REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  ref_no TEXT,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (raw_material_id) REFERENCES raw_materials(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ============================================================
-- 3. Fabric Cost Calculation (Cutting Efficiency)
-- ============================================================
CREATE TABLE IF NOT EXISTS fabric_cost_calc (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  raw_material_id INTEGER NOT NULL,
  fabric_used_meters REAL NOT NULL,
  pieces_cut INTEGER NOT NULL,
  efficiency_percent REAL NOT NULL DEFAULT 0,
  fabric_cost_per_piece REAL NOT NULL DEFAULT 0,
  notes TEXT,
  calc_date TEXT NOT NULL DEFAULT (date('now')),
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (raw_material_id) REFERENCES raw_materials(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ============================================================
-- 4. Manufacturing Expenses
-- ============================================================
CREATE TABLE IF NOT EXISTS expense_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS mfg_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_date TEXT NOT NULL,
  category_id INTEGER,
  description TEXT,
  amount REAL NOT NULL,
  paid_to TEXT,
  payment_mode TEXT,
  reference_no TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (category_id) REFERENCES expense_categories(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ============================================================
-- 5. Production Stage Tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS production_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no TEXT UNIQUE NOT NULL,
  product_id INTEGER NOT NULL,
  qty_planned INTEGER NOT NULL,
  qty_completed INTEGER NOT NULL DEFAULT 0,
  current_stage TEXT NOT NULL DEFAULT 'cutting',
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','completed','cancelled')),
  start_date TEXT NOT NULL DEFAULT (date('now')),
  end_date TEXT,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS production_stage_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('cutting','stitching','washing','finishing','packing')),
  qty_in INTEGER NOT NULL DEFAULT 0,
  qty_out INTEGER NOT NULL DEFAULT 0,
  qty_rejected INTEGER NOT NULL DEFAULT 0,
  worker_name TEXT,
  rate_per_piece REAL DEFAULT 0,
  total_cost REAL DEFAULT 0,
  entry_date TEXT NOT NULL DEFAULT (date('now')),
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (batch_id) REFERENCES production_batches(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ============================================================
-- 6. Ready Stock Management
-- ============================================================
CREATE TABLE IF NOT EXISTS ready_stock (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER UNIQUE NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  movement_type TEXT NOT NULL CHECK(movement_type IN ('production_in','sale_out','return_in','dispatch_out','adjustment')),
  quantity INTEGER NOT NULL,
  ref_table TEXT,
  ref_id INTEGER,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ============================================================
-- 7. Dealer / Customer Management
-- ============================================================
CREATE TABLE IF NOT EXISTS dealers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  pincode TEXT,
  gstin TEXT,
  credit_limit REAL DEFAULT 0,
  opening_balance REAL DEFAULT 0,
  salesperson_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (salesperson_id) REFERENCES users(id)
);

-- ============================================================
-- 8. Sales Order & Invoice
-- 13. Payment Modes (used here)
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_modes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sales_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE NOT NULL,
  dealer_id INTEGER NOT NULL,
  salesperson_id INTEGER,
  order_date TEXT NOT NULL DEFAULT (date('now')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','invoiced','dispatched','cancelled')),
  subtotal REAL NOT NULL DEFAULT 0,
  gst_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (dealer_id) REFERENCES dealers(id),
  FOREIGN KEY (salesperson_id) REFERENCES users(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sales_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sales_order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  rate REAL NOT NULL,
  gst_rate REAL NOT NULL DEFAULT 5,
  amount REAL NOT NULL,
  FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no TEXT UNIQUE NOT NULL,
  sales_order_id INTEGER,
  dealer_id INTEGER NOT NULL,
  salesperson_id INTEGER,
  invoice_date TEXT NOT NULL DEFAULT (date('now')),
  subtotal REAL NOT NULL DEFAULT 0,
  cgst REAL NOT NULL DEFAULT 0,
  sgst REAL NOT NULL DEFAULT 0,
  igst REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  paid_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN ('unpaid','partial','paid','cancelled')),
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id),
  FOREIGN KEY (dealer_id) REFERENCES dealers(id),
  FOREIGN KEY (salesperson_id) REFERENCES users(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  rate REAL NOT NULL,
  gst_rate REAL NOT NULL DEFAULT 5,
  amount REAL NOT NULL,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- ============================================================
-- 9. Dealer Outstanding Ledger (computed)
-- 10. Salesperson Payment Collection
-- 12. Fraud Control for Payment Entries
-- ============================================================
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_no TEXT UNIQUE NOT NULL,
  dealer_id INTEGER NOT NULL,
  invoice_id INTEGER,
  salesperson_id INTEGER,
  payment_date TEXT NOT NULL DEFAULT (date('now')),
  amount REAL NOT NULL,
  payment_mode_id INTEGER,
  reference_no TEXT,
  remarks TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','rejected')),
  verified_by INTEGER,
  verified_at TEXT,
  collected_lat REAL,
  collected_lng REAL,
  device_info TEXT,
  ip TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (dealer_id) REFERENCES dealers(id),
  FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  FOREIGN KEY (salesperson_id) REFERENCES users(id),
  FOREIGN KEY (payment_mode_id) REFERENCES payment_modes(id),
  FOREIGN KEY (verified_by) REFERENCES users(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ============================================================
-- 11. Dealer Notification log
-- 26. SMS / WhatsApp Integration log
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL CHECK(channel IN ('sms','whatsapp')),
  to_phone TEXT NOT NULL,
  template TEXT,
  message TEXT NOT NULL,
  related_dealer_id INTEGER,
  related_payment_id INTEGER,
  related_invoice_id INTEGER,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','failed')),
  provider_response TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (related_dealer_id) REFERENCES dealers(id),
  FOREIGN KEY (related_payment_id) REFERENCES payments(id),
  FOREIGN KEY (related_invoice_id) REFERENCES invoices(id)
);

-- ============================================================
-- 14. Dispatch Management
-- ============================================================
CREATE TABLE IF NOT EXISTS dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_no TEXT UNIQUE NOT NULL,
  invoice_id INTEGER NOT NULL,
  dealer_id INTEGER NOT NULL,
  dispatch_date TEXT NOT NULL DEFAULT (date('now')),
  transport_name TEXT,
  vehicle_no TEXT,
  lr_no TEXT,
  freight REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'dispatched' CHECK(status IN ('dispatched','in_transit','delivered','returned')),
  delivered_date TEXT,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  FOREIGN KEY (dealer_id) REFERENCES dealers(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ============================================================
-- 15. Returns Handling
-- ============================================================
CREATE TABLE IF NOT EXISTS returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_no TEXT UNIQUE NOT NULL,
  invoice_id INTEGER,
  dealer_id INTEGER NOT NULL,
  return_date TEXT NOT NULL DEFAULT (date('now')),
  reason TEXT,
  total_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','restocked')),
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  FOREIGN KEY (dealer_id) REFERENCES dealers(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  rate REAL NOT NULL,
  amount REAL NOT NULL,
  restock INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (return_id) REFERENCES returns(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- ============================================================
-- 25. Data Import log
-- ============================================================
CREATE TABLE IF NOT EXISTS import_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  filename TEXT,
  total_rows INTEGER DEFAULT 0,
  inserted INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  errors TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
CREATE INDEX IF NOT EXISTS idx_dealers_active ON dealers(active);
CREATE INDEX IF NOT EXISTS idx_dealers_salesperson ON dealers(salesperson_id);
CREATE INDEX IF NOT EXISTS idx_invoices_dealer ON invoices(dealer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(invoice_date);
CREATE INDEX IF NOT EXISTS idx_payments_dealer ON payments(dealer_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_salesperson ON payments(salesperson_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_date ON stock_movements(created_at);
CREATE INDEX IF NOT EXISTS idx_production_status ON production_batches(status);
CREATE INDEX IF NOT EXISTS idx_stage_entries_batch ON production_stage_entries(batch_id);
CREATE INDEX IF NOT EXISTS idx_rm_txns_material ON raw_material_txns(raw_material_id);
