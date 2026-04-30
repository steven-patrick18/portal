// Seeds the database with realistic demo data across all modules.
// Idempotent at coarse level — aborts if products already exist.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db, initDb } = require('./index');

initDb();

const productCount = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
if (productCount > 0) {
  console.log('Demo data already present (products table is non-empty). Aborting.');
  console.log('To reseed: stop the server, delete data/portal.db, restart, then run `npm run seed-demo`.');
  process.exit(0);
}

const today = new Date();
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const daysAgo = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return ymd(d); };
const TODAY = ymd(today);

const hash = bcrypt.hashSync('admin123', 10);

const trx = db.transaction(() => {

// ---------- USERS ----------
const ensureUser = (name, email, phone, role) => {
  const ex = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (ex) return ex.id;
  return db.prepare('INSERT INTO users (name,email,phone,password_hash,role) VALUES (?,?,?,?,?)')
    .run(name, email, phone, hash, role).lastInsertRowid;
};
const sp1 = ensureUser('Ramesh (Salesperson)', 'sales1@portal.local', '7777777777', 'salesperson');
const sp2 = ensureUser('Anil (Salesperson)', 'anil@portal.local', '7766554433', 'salesperson');
const sp3 = ensureUser('Priya Accountant', 'priya@portal.local', '6677889900', 'accountant');
const sp4 = ensureUser('Suresh Production', 'suresh@portal.local', '6699887766', 'production');

// ---------- SUPPLIERS ----------
const insSup = db.prepare('INSERT INTO suppliers (name,contact_person,phone,email,address,gstin) VALUES (?,?,?,?,?,?)');
const supA = insSup.run('Khan Textiles', 'Imran Khan', '9876543201', 'imran@khan.in', 'GIDC, Surat, Gujarat', '24AAACK1234A1Z5').lastInsertRowid;
const supB = insSup.run('Coats Threads India', 'Mehul Shah', '9988776655', 'sales@coats.in', 'Andheri East, Mumbai', '27AAGCC9876B1Z2').lastInsertRowid;
const supC = insSup.run('ABC Buttons & Zippers', 'Vinod Patel', '9123456789', 'vinod@abc.in', 'Karol Bagh, Delhi', '07AAGFA5678C1Z9').lastInsertRowid;

// ---------- RAW MATERIALS ----------
const insRM = db.prepare('INSERT INTO raw_materials (code,name,type,unit,current_stock,reorder_level,cost_per_unit,supplier_id) VALUES (?,?,?,?,?,?,?,?)');
const rmList = [
  { code: 'RM00001', name: 'Cotton Fabric Blue 44"', type: 'fabric', unit: 'MTR', stock: 1250, reorder: 200, cost: 145, sup: supA },
  { code: 'RM00002', name: 'Cotton Fabric White 44"', type: 'fabric', unit: 'MTR', stock: 880, reorder: 200, cost: 140, sup: supA },
  { code: 'RM00003', name: 'Polyester Mix Grey 60"', type: 'fabric', unit: 'MTR', stock: 95, reorder: 150, cost: 220, sup: supA }, // low
  { code: 'RM00004', name: 'Denim 12oz Indigo 58"', type: 'fabric', unit: 'MTR', stock: 670, reorder: 100, cost: 310, sup: supA },
  { code: 'RM00005', name: 'Sewing Thread Black 5000m', type: 'thread', unit: 'CONE', stock: 240, reorder: 50, cost: 95, sup: supB },
  { code: 'RM00006', name: 'Sewing Thread White 5000m', type: 'thread', unit: 'CONE', stock: 180, reorder: 50, cost: 95, sup: supB },
  { code: 'RM00007', name: 'Brass Buttons 18mm', type: 'button', unit: 'PCS', stock: 8400, reorder: 1000, cost: 3.5, sup: supC },
  { code: 'RM00008', name: 'YKK Zipper 6" Black', type: 'zipper', unit: 'PCS', stock: 320, reorder: 500, cost: 28, sup: supC }, // low
  { code: 'RM00009', name: 'Care Label Cotton', type: 'label', unit: 'PCS', stock: 12500, reorder: 2000, cost: 1.2, sup: supC },
];
const rmIds = {};
rmList.forEach(rm => {
  const r = insRM.run(rm.code, rm.name, rm.type, rm.unit, rm.stock, rm.reorder, rm.cost, rm.sup);
  rmIds[rm.code] = r.lastInsertRowid;
});

// Raw material transactions (purchases over last 30 days)
const insRMT = db.prepare('INSERT INTO raw_material_txns (raw_material_id,txn_type,quantity,rate,total_amount,ref_no,notes,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
[
  { code: 'RM00001', type: 'purchase', qty: 500, rate: 145, ref: 'GRN-101', day: 28 },
  { code: 'RM00002', type: 'purchase', qty: 400, rate: 140, ref: 'GRN-102', day: 26 },
  { code: 'RM00004', type: 'purchase', qty: 300, rate: 310, ref: 'GRN-103', day: 22 },
  { code: 'RM00005', type: 'purchase', qty: 100, rate: 95, ref: 'GRN-104', day: 18 },
  { code: 'RM00007', type: 'purchase', qty: 5000, rate: 3.5, ref: 'GRN-105', day: 15 },
  { code: 'RM00001', type: 'issue', qty: 80, rate: 145, ref: 'ISS-201', day: 14 },
  { code: 'RM00002', type: 'issue', qty: 60, rate: 140, ref: 'ISS-202', day: 10 },
  { code: 'RM00004', type: 'issue', qty: 120, rate: 310, ref: 'ISS-203', day: 7 },
  { code: 'RM00005', type: 'issue', qty: 18, rate: 95, ref: 'ISS-204', day: 5 },
].forEach(t => {
  insRMT.run(rmIds[t.code], t.type, t.qty, t.rate, t.qty * t.rate, t.ref, null, sp4, daysAgo(t.day));
});

// ---------- CATEGORIES (already seeded by initDb) ----------
const cats = db.prepare('SELECT id, name FROM product_categories').all();
const catId = (n) => cats.find(c => c.name === n)?.id;

// ---------- PRODUCTS ----------
const insProd = db.prepare('INSERT INTO products (code,name,category_id,hsn_code,size,color,unit,mrp,sale_price,cost_price,gst_rate,reorder_level) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
const prodList = [
  { code: 'PRD00001', name: 'Cotton Shirt Formal', cat: 'Shirts',    size: 'M',  color: 'Blue',    mrp: 1499, sale: 1100, cost: 720, hsn: '6105', reorder: 20 },
  { code: 'PRD00002', name: 'Cotton Shirt Formal', cat: 'Shirts',    size: 'L',  color: 'White',   mrp: 1499, sale: 1100, cost: 720, hsn: '6105', reorder: 20 },
  { code: 'PRD00003', name: 'Cotton Shirt Casual', cat: 'Shirts',    size: 'XL', color: 'Sky Blue',mrp: 1299, sale: 950,  cost: 600, hsn: '6105', reorder: 15 },
  { code: 'PRD00004', name: 'Polo T-Shirt',        cat: 'T-Shirts',  size: 'M',  color: 'Red',     mrp: 899,  sale: 650,  cost: 380, hsn: '6109', reorder: 25 },
  { code: 'PRD00005', name: 'Round-Neck T-Shirt',  cat: 'T-Shirts',  size: 'L',  color: 'Black',   mrp: 699,  sale: 500,  cost: 280, hsn: '6109', reorder: 30 },
  { code: 'PRD00006', name: 'Round-Neck T-Shirt',  cat: 'T-Shirts',  size: 'M',  color: 'Navy',    mrp: 699,  sale: 500,  cost: 280, hsn: '6109', reorder: 30 },
  { code: 'PRD00007', name: 'Slim Fit Trouser',    cat: 'Trousers',  size: '32', color: 'Black',   mrp: 1799, sale: 1350, cost: 850, hsn: '6203', reorder: 18 },
  { code: 'PRD00008', name: 'Regular Trouser',     cat: 'Trousers',  size: '34', color: 'Khaki',   mrp: 1599, sale: 1200, cost: 750, hsn: '6203', reorder: 15 },
  { code: 'PRD00009', name: 'Skinny Jeans',        cat: 'Jeans',     size: '30', color: 'Indigo',  mrp: 2199, sale: 1700, cost: 1050,hsn: '6203', reorder: 15 },
  { code: 'PRD00010', name: 'Distressed Jeans',    cat: 'Jeans',     size: '32', color: 'Light',   mrp: 2499, sale: 1900, cost: 1180,hsn: '6203', reorder: 12 },
  { code: 'PRD00011', name: 'Anarkali Kurti',      cat: 'Kurtis',    size: 'M',  color: 'Pink',    mrp: 1799, sale: 1350, cost: 820, hsn: '6204', reorder: 15 },
  { code: 'PRD00012', name: 'Straight Kurti',      cat: 'Kurtis',    size: 'L',  color: 'Yellow',  mrp: 1399, sale: 1050, cost: 640, hsn: '6204', reorder: 18 },
  { code: 'PRD00013', name: 'Cotton Saree',        cat: 'Sarees',    size: 'FS', color: 'Red',     mrp: 2999, sale: 2300, cost: 1400,hsn: '5407', reorder: 10 },
  { code: 'PRD00014', name: 'Silk Saree',          cat: 'Sarees',    size: 'FS', color: 'Magenta', mrp: 5999, sale: 4500, cost: 2900,hsn: '5407', reorder: 8 },
  { code: 'PRD00015', name: 'Linen Shirt',         cat: 'Shirts',    size: 'L',  color: 'Beige',   mrp: 1999, sale: 1500, cost: 900, hsn: '6105', reorder: 12 },
];
const prodIds = {};
prodList.forEach(p => {
  const r = insProd.run(p.code, p.name, catId(p.cat), p.hsn, p.size, p.color, 'PCS', p.mrp, p.sale, p.cost, 5, p.reorder);
  prodIds[p.code] = r.lastInsertRowid;
});

// ---------- READY STOCK ----------
const insStock = db.prepare('INSERT INTO ready_stock (product_id, quantity) VALUES (?,?)');
const stockData = {
  PRD00001: 145, PRD00002: 88, PRD00003: 12 /*low*/, PRD00004: 210, PRD00005: 175,
  PRD00006: 95, PRD00007: 65, PRD00008: 8 /*low*/, PRD00009: 42, PRD00010: 28,
  PRD00011: 70, PRD00012: 110, PRD00013: 35, PRD00014: 22, PRD00015: 6 /*low*/,
};
Object.entries(stockData).forEach(([code, q]) => insStock.run(prodIds[code], q));

// ---------- DEALERS ----------
const insDealer = db.prepare('INSERT INTO dealers (code,name,contact_person,phone,email,address,city,state,pincode,gstin,credit_limit,opening_balance,salesperson_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
const dealerSeed = [
  { code: 'DLR00001', name: 'Mumbai Fashion House',   contact: 'Rajesh Mehta',   phone: '9820011111', city: 'Mumbai',     state: 'Maharashtra', pin: '400001', gst: '27AABCM1234A1Z5', credit: 200000, sp: sp1 },
  { code: 'DLR00002', name: 'Delhi Style Emporium',   contact: 'Sunita Verma',   phone: '9810022222', city: 'New Delhi',  state: 'Delhi',        pin: '110001', gst: '07AABCD5678B1Z3', credit: 250000, sp: sp1 },
  { code: 'DLR00003', name: 'Bangalore Boutique',     contact: 'Anjali Rao',     phone: '9844033333', city: 'Bangalore',  state: 'Karnataka',   pin: '560001', gst: '29AABCB9012C1Z7', credit: 180000, sp: sp2 },
  { code: 'DLR00004', name: 'Chennai Silks',          contact: 'Murugan S',       phone: '9444044444', city: 'Chennai',    state: 'Tamil Nadu',  pin: '600001', gst: '33AABCC3456D1Z9', credit: 300000, sp: sp2 },
  { code: 'DLR00005', name: 'Kolkata Garments',       contact: 'Subir Banerjee',  phone: '9830055555', city: 'Kolkata',    state: 'West Bengal', pin: '700001', gst: '19AABCK7890E1Z1', credit: 150000, sp: sp1 },
  { code: 'DLR00006', name: 'Pune Trends',            contact: 'Kiran Patil',     phone: '9822066666', city: 'Pune',       state: 'Maharashtra', pin: '411001', gst: '27AABCP1234F1Z5', credit: 120000, sp: sp1 },
  { code: 'DLR00007', name: 'Hyderabad Wear',         contact: 'Lakshmi Reddy',   phone: '9866077777', city: 'Hyderabad',  state: 'Telangana',   pin: '500001', gst: '36AABCH5678G1Z3', credit: 220000, sp: sp2 },
  { code: 'DLR00008', name: 'Ahmedabad Textiles',     contact: 'Kalpesh Shah',    phone: '9824088888', city: 'Ahmedabad',  state: 'Gujarat',     pin: '380001', gst: '24AABCA9012H1Z7', credit: 280000, sp: sp1 },
  { code: 'DLR00009', name: 'Jaipur Fabrics',         contact: 'Manoj Sharma',    phone: '9829099999', city: 'Jaipur',     state: 'Rajasthan',   pin: '302001', gst: '08AABCJ3456I1Z9', credit: 100000, sp: sp2 },
  { code: 'DLR00010', name: 'Lucknow Couture',        contact: 'Sadiq Ahmed',     phone: '9839010101', city: 'Lucknow',    state: 'Uttar Pradesh',pin:'226001', gst: '09AABCL7890J1Z1', credit: 160000, sp: sp1 },
  { code: 'DLR00011', name: 'Indore Apparels',        contact: 'Pooja Joshi',     phone: '9826011110', city: 'Indore',     state: 'Madhya Pradesh',pin:'452001',gst: '23AABCI1234K1Z5', credit: 90000,  sp: sp2 },
  { code: 'DLR00012', name: 'Surat Wholesale',        contact: 'Bhavesh Desai',   phone: '9824012121', city: 'Surat',      state: 'Gujarat',     pin: '395001', gst: '24AABCS5678L1Z3', credit: 350000, sp: sp1, opening: 25000 },
];
const dealerIds = {};
dealerSeed.forEach(d => {
  const r = insDealer.run(d.code, d.name, d.contact, d.phone, null, null, d.city, d.state, d.pin, d.gst, d.credit, d.opening || 0, d.sp);
  dealerIds[d.code] = r.lastInsertRowid;
});

// ---------- MFG EXPENSES ----------
const expCats = db.prepare('SELECT id, name FROM expense_categories').all();
const expCatId = (n) => expCats.find(c => c.name === n)?.id;
const insExp = db.prepare('INSERT INTO mfg_expenses (expense_date,category_id,description,amount,paid_to,payment_mode,reference_no,created_by) VALUES (?,?,?,?,?,?,?,?)');
[
  { day: 28, cat: 'Electricity', desc: 'Factory power bill (March)', amt: 28500, to: 'MSEDCL', mode: 'Bank Transfer', ref: 'TXN-3392' },
  { day: 25, cat: 'Rent',        desc: 'Factory unit lease',          amt: 75000, to: 'Mehta Properties', mode: 'Cheque', ref: 'CHQ-110' },
  { day: 22, cat: 'Salary',      desc: 'Tailoring staff salary',       amt: 180000, to: 'Workforce', mode: 'Bank Transfer', ref: 'SAL-04' },
  { day: 18, cat: 'Transport',   desc: 'Fabric pickup from Surat',     amt: 8500, to: 'Khan Logistics', mode: 'Cash', ref: '' },
  { day: 15, cat: 'Tailoring',   desc: 'Stitching contractor',          amt: 22000, to: 'Iqbal Stitch House', mode: 'UPI', ref: 'UPI-991' },
  { day: 10, cat: 'Misc',        desc: 'Stationery + printing',         amt: 3200, to: 'Office Supplies', mode: 'Cash', ref: '' },
  { day: 5,  cat: 'Electricity', desc: 'DG fuel top-up',               amt: 4200, to: 'HP Petrol', mode: 'Cash', ref: '' },
  { day: 1,  cat: 'Transport',   desc: 'Dispatch courier — multiple', amt: 6750, to: 'Bluedart', mode: 'Card', ref: 'TXN-44021' },
].forEach(e => insExp.run(daysAgo(e.day), expCatId(e.cat), e.desc, e.amt, e.to, e.mode, e.ref || null, sp3));

// ---------- FABRIC COST CALCS ----------
const insFC = db.prepare(`INSERT INTO fabric_cost_calc (product_id,raw_material_id,fabric_used_meters,pieces_cut,efficiency_percent,fabric_cost_per_piece,notes,calc_date,created_by) VALUES (?,?,?,?,?,?,?,?,?)`);
[
  { p: 'PRD00001', rm: 'RM00001', mtr: 60, pcs: 40, day: 20 }, // 1.5m/pc
  { p: 'PRD00002', rm: 'RM00002', mtr: 50, pcs: 35, day: 16 },
  { p: 'PRD00009', rm: 'RM00004', mtr: 45, pcs: 30, day: 12 },
].forEach(f => {
  const rm = db.prepare('SELECT cost_per_unit FROM raw_materials WHERE id=?').get(rmIds[f.rm]);
  const fab = f.mtr * rm.cost_per_unit;
  const cpp = fab / f.pcs;
  const eff = (f.pcs / f.mtr) * 100;
  insFC.run(prodIds[f.p], rmIds[f.rm], f.mtr, f.pcs, eff, cpp, null, daysAgo(f.day), sp4);
});

// ---------- PRODUCTION BATCHES ----------
const insBatch = db.prepare('INSERT INTO production_batches (batch_no,product_id,qty_planned,qty_completed,current_stage,status,start_date,end_date,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)');
const insStage = db.prepare(`INSERT INTO production_stage_entries (batch_id,stage,qty_in,qty_out,qty_rejected,worker_name,rate_per_piece,total_cost,entry_date,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

// Batch 1 - Completed
const b1 = insBatch.run('BATCH00001', prodIds['PRD00001'], 100, 95, 'packing', 'completed', daysAgo(15), daysAgo(3), 'Spring formal collection', sp4).lastInsertRowid;
[
  ['cutting', 100, 100, 0, 'Mohan',  4,   daysAgo(14)],
  ['stitching', 100, 98, 2, 'Iqbal', 22,  daysAgo(11)],
  ['washing',   98, 97, 1, 'Inhouse',6,   daysAgo(8)],
  ['finishing', 97, 96, 1, 'Inhouse',5,   daysAgo(5)],
  ['packing',   96, 95, 1, 'Inhouse',2,   daysAgo(3)],
].forEach(([stage, qin, qout, qrej, w, rate, d]) => insStage.run(b1, stage, qin, qout, qrej, w, rate, qout*rate, d, null, sp4));

// Batch 2 - In progress at washing stage
const b2 = insBatch.run('BATCH00002', prodIds['PRD00009'], 80, 0, 'washing', 'in_progress', daysAgo(8), null, 'Skinny jeans run', sp4).lastInsertRowid;
[
  ['cutting',   80, 80, 0, 'Mohan',  6,  daysAgo(7)],
  ['stitching', 80, 76, 4, 'Iqbal',  35, daysAgo(4)],
  ['washing',   76, 0,  0, 'Acid Wash Co', 10, daysAgo(1)], // not yet finished
].forEach(([stage, qin, qout, qrej, w, rate, d]) => insStage.run(b2, stage, qin, qout, qrej, w, rate, qout*rate, d, null, sp4));

// Batch 3 - In progress at stitching
const b3 = insBatch.run('BATCH00003', prodIds['PRD00004'], 150, 0, 'stitching', 'in_progress', daysAgo(5), null, 'Polo T-Shirts batch', sp4).lastInsertRowid;
[
  ['cutting',   150, 150, 0, 'Mohan', 3,  daysAgo(4)],
  ['stitching', 150, 0,   0, 'Sanaa', 18, daysAgo(2)],
].forEach(([stage, qin, qout, qrej, w, rate, d]) => insStage.run(b3, stage, qin, qout, qrej, w, rate, qout*rate, d, null, sp4));

// Batch 4 - Just started (cutting)
const b4 = insBatch.run('BATCH00004', prodIds['PRD00011'], 60, 0, 'cutting', 'in_progress', daysAgo(1), null, 'Anarkali Kurti pink batch', sp4).lastInsertRowid;
insStage.run(b4, 'cutting', 60, 60, 0, 'Mohan', 5, 300, daysAgo(1), null, sp4);

// ---------- SALES ORDERS + INVOICES ----------
const insSO = db.prepare(`INSERT INTO sales_orders (order_no,dealer_id,salesperson_id,order_date,status,subtotal,gst_amount,total,created_by) VALUES (?,?,?,?,?,?,?,?,?)`);
const insSOI = db.prepare(`INSERT INTO sales_order_items (sales_order_id,product_id,quantity,rate,gst_rate,amount) VALUES (?,?,?,?,?,?)`);
const insInv = db.prepare(`INSERT INTO invoices (invoice_no,sales_order_id,dealer_id,salesperson_id,invoice_date,subtotal,cgst,sgst,igst,total,paid_amount,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insInvI = db.prepare(`INSERT INTO invoice_items (invoice_id,product_id,quantity,rate,gst_rate,amount) VALUES (?,?,?,?,?,?)`);
const insMv = db.prepare(`INSERT INTO stock_movements (product_id,movement_type,quantity,ref_table,ref_id,created_by) VALUES (?,?,?,?,?,?)`);

const COMPANY_STATE = (process.env.COMPANY_STATE || 'Maharashtra').toLowerCase();

// invoice template: { dealer_code, day, status, paid_pct, items: [{prod, qty, rate?}] }
const invoiceTpl = [
  { dlr: 'DLR00001', day: 25, paid: 1.0,  items: [{p:'PRD00001',q:10},{p:'PRD00002',q:8}] },
  { dlr: 'DLR00002', day: 23, paid: 1.0,  items: [{p:'PRD00004',q:24},{p:'PRD00005',q:20}] },
  { dlr: 'DLR00003', day: 21, paid: 0.6,  items: [{p:'PRD00007',q:6},{p:'PRD00008',q:5},{p:'PRD00015',q:3}] },
  { dlr: 'DLR00004', day: 20, paid: 1.0,  items: [{p:'PRD00013',q:8},{p:'PRD00014',q:4}] },
  { dlr: 'DLR00005', day: 18, paid: 0.0,  items: [{p:'PRD00006',q:18}] },
  { dlr: 'DLR00006', day: 16, paid: 0.5,  items: [{p:'PRD00009',q:5},{p:'PRD00010',q:3}] },
  { dlr: 'DLR00007', day: 15, paid: 1.0,  items: [{p:'PRD00011',q:10},{p:'PRD00012',q:12}] },
  { dlr: 'DLR00002', day: 14, paid: 0.0,  items: [{p:'PRD00001',q:6},{p:'PRD00003',q:4}] },
  { dlr: 'DLR00008', day: 13, paid: 1.0,  items: [{p:'PRD00007',q:8}] },
  { dlr: 'DLR00009', day: 12, paid: 0.4,  items: [{p:'PRD00004',q:18}] },
  { dlr: 'DLR00010', day: 10, paid: 0.0,  items: [{p:'PRD00012',q:14}] },
  { dlr: 'DLR00011', day: 9,  paid: 1.0,  items: [{p:'PRD00006',q:10}] },
  { dlr: 'DLR00012', day: 8,  paid: 0.7,  items: [{p:'PRD00009',q:6},{p:'PRD00010',q:4},{p:'PRD00007',q:5}] },
  { dlr: 'DLR00001', day: 6,  paid: 0.0,  items: [{p:'PRD00013',q:5}] },
  { dlr: 'DLR00003', day: 5,  paid: 0.3,  items: [{p:'PRD00015',q:6},{p:'PRD00002',q:5}] },
  { dlr: 'DLR00006', day: 4,  paid: 1.0,  items: [{p:'PRD00011',q:8}] },
  { dlr: 'DLR00004', day: 2,  paid: 0.0,  items: [{p:'PRD00014',q:3}] },
  { dlr: 'DLR00007', day: 1,  paid: 0.0,  items: [{p:'PRD00005',q:12},{p:'PRD00006',q:8}] },
  { dlr: 'DLR00002', day: 0,  paid: 0.5,  items: [{p:'PRD00001',q:4},{p:'PRD00007',q:3}] },  // today
  { dlr: 'DLR00008', day: 0,  paid: 0.0,  items: [{p:'PRD00012',q:5},{p:'PRD00011',q:4}] },  // today
];

let invSeq = 0, soSeq = 0;
const invIdsByDealer = {};
const allInvIds = [];
invoiceTpl.forEach(t => {
  const dealer = db.prepare('SELECT id, salesperson_id, state FROM dealers WHERE code=?').get(t.dlr);
  // Build items
  const items = t.items.map(it => {
    const p = db.prepare('SELECT id, sale_price, gst_rate FROM products WHERE id=?').get(prodIds[it.p]);
    const rate = it.rate || p.sale_price;
    return { product_id: prodIds[it.p], quantity: it.q, rate, gst_rate: p.gst_rate, amount: it.q * rate };
  });
  let subtotal = 0, gst = 0;
  items.forEach(i => { subtotal += i.amount; gst += i.amount * i.gst_rate / 100; });
  const isInter = dealer.state && dealer.state.toLowerCase() !== COMPANY_STATE;
  const cgst = isInter ? 0 : gst/2, sgst = isInter ? 0 : gst/2, igst = isInter ? gst : 0;
  const total = subtotal + gst;

  // Sales order
  soSeq++;
  const soNo = 'SO' + String(soSeq).padStart(5, '0');
  const so = insSO.run(soNo, dealer.id, dealer.salesperson_id, daysAgo(t.day), 'invoiced', subtotal, gst, total, sp1).lastInsertRowid;
  items.forEach(i => insSOI.run(so, i.product_id, i.quantity, i.rate, i.gst_rate, i.amount));

  // Invoice
  invSeq++;
  const invNo = 'INV' + String(invSeq).padStart(5, '0');
  const paidAmt = Math.round(total * t.paid * 100) / 100;
  const status = paidAmt + 0.01 >= total ? 'paid' : (paidAmt > 0 ? 'partial' : 'unpaid');
  const invId = insInv.run(invNo, so, dealer.id, dealer.salesperson_id, daysAgo(t.day), subtotal, cgst, sgst, igst, total, paidAmt, status, sp1).lastInsertRowid;
  items.forEach(i => {
    insInvI.run(invId, i.product_id, i.quantity, i.rate, i.gst_rate, i.amount);
    insMv.run(i.product_id, 'sale_out', i.quantity, 'invoices', invId, sp1);
    db.prepare('UPDATE ready_stock SET quantity = quantity - ? WHERE product_id=?').run(i.quantity, i.product_id);
  });
  allInvIds.push({ id: invId, dealer: dealer.id, paid: paidAmt, total, day: t.day, sp: dealer.salesperson_id });
  if (!invIdsByDealer[dealer.id]) invIdsByDealer[dealer.id] = [];
  invIdsByDealer[dealer.id].push({ id: invId, total, paid: paidAmt });
});

// ---------- PAYMENTS (matching the paid_amounts above + a few extras pending) ----------
const modes = db.prepare('SELECT id, name FROM payment_modes').all();
const modeId = (n) => modes.find(m => m.name === n)?.id;
const insPmt = db.prepare(`INSERT INTO payments (payment_no,dealer_id,invoice_id,salesperson_id,payment_date,amount,payment_mode_id,reference_no,remarks,status,verified_by,verified_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

let pmtSeq = 0;
allInvIds.forEach((inv, idx) => {
  if (inv.paid <= 0) return;
  pmtSeq++;
  const pmtNo = 'PMT' + String(pmtSeq).padStart(5, '0');
  const mode = ['UPI','Bank Transfer','Cash','Cheque','Card'][idx % 5];
  const ref = mode === 'UPI' ? 'UPI-' + (4000 + pmtSeq) : mode === 'Cheque' ? 'CHQ-' + (200 + pmtSeq) : mode === 'Bank Transfer' ? 'NEFT-' + (5000 + pmtSeq) : '';
  insPmt.run(pmtNo, inv.dealer, inv.id, inv.sp, daysAgo(Math.max(0, inv.day - 1)), inv.paid, modeId(mode), ref || null, null, 'verified', sp3, daysAgo(Math.max(0, inv.day - 1)), inv.sp);
});

// Pending payments awaiting verification (today)
[
  { dealer: 'DLR00005', amount: 8500, mode: 'UPI', ref: 'UPI-9991' },
  { dealer: 'DLR00010', amount: 12500, mode: 'Cash', ref: '' },
  { dealer: 'DLR00009', amount: 6800, mode: 'Cheque', ref: 'CHQ-555' },
].forEach(p => {
  pmtSeq++;
  const pmtNo = 'PMT' + String(pmtSeq).padStart(5, '0');
  insPmt.run(pmtNo, dealerIds[p.dealer], null, sp1, TODAY, p.amount, modeId(p.mode), p.ref || null, null, 'pending', null, null, sp1);
});

// ---------- DISPATCHES ----------
const insDsp = db.prepare(`INSERT INTO dispatches (dispatch_no,invoice_id,dealer_id,dispatch_date,transport_name,vehicle_no,lr_no,freight,status,delivered_date,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
let dspSeq = 0;
const dispatchPlan = [
  { invIdx: 0, transport: 'VRL Logistics', veh: 'MH-12-AB-1234', lr: 'LR-1001', freight: 850, status: 'delivered', day: 24 },
  { invIdx: 1, transport: 'GATI',          veh: 'DL-1C-2345',   lr: 'LR-1002', freight: 1200, status: 'delivered', day: 22 },
  { invIdx: 3, transport: 'TCI',           veh: 'TN-22-X-9988', lr: 'LR-1003', freight: 1850, status: 'delivered', day: 19 },
  { invIdx: 6, transport: 'Bluedart',      veh: 'TS-09-V-7766', lr: 'LR-1004', freight: 1100, status: 'in_transit', day: 14 },
  { invIdx: 11, transport: 'VRL Logistics',veh: 'MP-09-AC-3344',lr: 'LR-1005', freight: 950,  status: 'dispatched', day: 8 },
];
dispatchPlan.forEach(d => {
  dspSeq++;
  const dspNo = 'DSP' + String(dspSeq).padStart(5, '0');
  const inv = allInvIds[d.invIdx];
  const delivered = d.status === 'delivered' ? daysAgo(Math.max(0, d.day - 2)) : null;
  insDsp.run(dspNo, inv.id, inv.dealer, daysAgo(d.day), d.transport, d.veh, d.lr, d.freight, d.status, delivered, sp4);
});

// ---------- RETURNS ----------
const insRet = db.prepare(`INSERT INTO returns (return_no,invoice_id,dealer_id,return_date,reason,total_amount,status,created_by) VALUES (?,?,?,?,?,?,?,?)`);
const insRetI = db.prepare(`INSERT INTO return_items (return_id,product_id,quantity,rate,amount,restock) VALUES (?,?,?,?,?,?)`);

let retSeq = 1;
{
  // Return 1: defective shirts from Mumbai dealer, restocked
  const ret1 = insRet.run('RET' + String(retSeq).padStart(5,'0'), allInvIds[0].id, dealerIds.DLR00001, daysAgo(20), 'Defective stitching - 2 pcs', 2 * 1100, 'restocked', sp3).lastInsertRowid;
  insRetI.run(ret1, prodIds['PRD00001'], 2, 1100, 2200, 1);
  // restock the products back
  db.prepare('UPDATE ready_stock SET quantity = quantity + 2 WHERE product_id=?').run(prodIds['PRD00001']);
  insMv.run(prodIds['PRD00001'], 'return_in', 2, 'returns', ret1, sp3);
}
retSeq++;
{
  // Return 2: pending
  const ret2 = insRet.run('RET' + String(retSeq).padStart(5,'0'), allInvIds[5].id, dealerIds.DLR00006, daysAgo(2), 'Wrong size shipped', 2 * 1700, 'pending', sp1).lastInsertRowid;
  insRetI.run(ret2, prodIds['PRD00009'], 2, 1700, 3400, 1);
}

// ---------- NOTIFICATIONS LOG ----------
const insNotif = db.prepare(`INSERT INTO notifications_log (channel,to_phone,template,message,related_dealer_id,related_payment_id,related_invoice_id,status,provider_response) VALUES (?,?,?,?,?,?,?,?,?)`);
[
  { ch: 'sms',      phone: '9820011111', dealer: 'DLR00001', msg: 'Hi Mumbai Fashion House, payment of Rs.18,795 received. Thanks!', status: 'sent' },
  { ch: 'whatsapp', phone: '9810022222', dealer: 'DLR00002', msg: 'Dear Sunita, your invoice INV00002 has been generated for Rs.32,340.', status: 'sent' },
  { ch: 'sms',      phone: '9844033333', dealer: 'DLR00003', msg: 'Reminder: Outstanding amount Rs.7,938 on Invoice INV00003.', status: 'sent' },
  { ch: 'sms',      phone: '9839010101', dealer: 'DLR00010', msg: 'Reminder: Invoice INV00011 is overdue. Please clear the dues.', status: 'sent' },
].forEach(n => insNotif.run(n.ch, n.phone, null, n.msg, dealerIds[n.dealer], null, null, n.status, JSON.stringify({ stub: true, demo: true })));

// ---------- IMPORT LOG (one demo entry) ----------
db.prepare(`INSERT INTO import_log (entity, filename, total_rows, inserted, failed, errors, created_by) VALUES (?,?,?,?,?,?,?)`)
  .run('dealers', 'demo-dealers-master.csv', 12, 12, 0, '', sp3);

// ---------- AUDIT LOG (a few logins) ----------
[sp1, sp2, sp3, sp4].forEach(uid => {
  db.prepare('INSERT INTO audit_log (user_id, action, ip) VALUES (?,?,?)').run(uid, 'login', '192.168.1.50');
});

console.log('Demo data seeded:');
console.log(` • Suppliers: 3   • Raw materials: ${rmList.length}   • Products: ${prodList.length}`);
console.log(` • Dealers: ${dealerSeed.length}   • Production batches: 4   • Sales orders: ${invoiceTpl.length}`);
console.log(` • Invoices: ${invoiceTpl.length}   • Payments: ${pmtSeq}   • Dispatches: ${dispatchPlan.length}`);
console.log(` • Returns: 2   • Mfg expenses: 8   • Notifications: 4`);
console.log('');
console.log('Demo accounts (password admin123):');
console.log(' • owner@portal.local        (Owner)');
console.log(' • admin@portal.local        (Admin)');
console.log(' • sales1@portal.local       (Salesperson - Ramesh)');
console.log(' • anil@portal.local         (Salesperson - Anil)');
console.log(' • priya@portal.local        (Accountant)');
console.log(' • suresh@portal.local       (Production)');
});

trx();
console.log('Done.');
process.exit(0);
