// Slips & Forms — print-ready shop-floor forms for the full garment flow
// (cutting → stitching → washing → QC → finishing → gate pass → dispatch).
// These are BLANK fillable forms: they carry the company letterhead and ruled
// boxes for batch / bundle / piece numbers, quantities, and signatures
// (operator, supervisor, manager / HOD) plus a company-seal box. Staff print
// a stack and fill them by hand. No data is stored — print only.
const express = require('express');
const router = express.Router();

// Each template: header info fields, a ruled table (cols × blank rows),
// optional summary lines + note, the signature roles, and a seal box.
// `triplicate: true` prints ORIGINAL / DUPLICATE / TRIPLICATE copies.
const TEMPLATES = [
  // ── Cutting & Production ───────────────────────────────────────
  {
    key: 'cutting-bundle', group: 'Cutting & Production', icon: 'bi-scissors',
    name: 'Cutting Slip / Bundle Card',
    desc: 'Lay & bundle breakup with piece numbers — issued from the cutting table.',
    fields: ['Date', 'Batch / Lot No', 'Style / Article', 'Fabric / Shade', 'Lay No', 'Marker No', 'Total Layers', 'Cut By'],
    table: { cols: ['Bundle No', 'Size', 'Shade', 'Piece No. (from – to)', 'Qty (pcs)', 'Remarks'], rows: 14 },
    summary: ['Total Bundles', 'Total Pieces'],
    signs: ['Cutting Master', 'Store In-charge', 'Supervisor', 'Manager / HOD'],
    seal: true,
  },
  {
    key: 'batch-details', group: 'Cutting & Production', icon: 'bi-clipboard2-data',
    name: 'Batch Details Sheet (Job Card)',
    desc: 'Master traveller card — tracks one batch size-wise through every stage.',
    fields: ['Batch No', 'Date', 'Style / Article', 'Buyer / Order No', 'Fabric', 'Total Order Qty'],
    table: { cols: ['Size', 'Order Qty', 'Cut', 'Stitched', 'Washed', 'Finished', 'Packed', 'Balance'], rows: 12 },
    summary: ['Grand Total'],
    signs: ['Prepared By', 'Production Manager', 'HOD'],
    seal: true,
  },
  {
    key: 'stitching-line', group: 'Cutting & Production', icon: 'bi-needle',
    name: 'Stitching / Line Production Slip',
    desc: 'Per-line daily output by operation — input vs output and rejects.',
    fields: ['Date', 'Line No', 'Style', 'Batch No', 'Shift', 'Supervisor'],
    table: { cols: ['Operation', 'Operator Name', 'Bundle No', 'Qty In', 'Qty Out', 'Rejects', 'Sign'], rows: 14 },
    summary: ['Total Output', 'Total Rejects'],
    signs: ['Line Supervisor', 'Floor In-charge', 'Production Manager'],
    seal: true,
  },
  {
    key: 'bundle-ticket', group: 'Cutting & Production', icon: 'bi-ticket-detailed',
    name: 'Bundle Ticket / Operation Card',
    desc: 'Travels with a single bundle — each operation signs as it is done.',
    fields: ['Bundle No', 'Batch No', 'Size', 'Shade', 'Qty (pcs)', 'Piece No. (from – to)'],
    table: { cols: ['Operation', 'Operator', 'Date', 'Qty OK', 'Qty Reject', 'Sign'], rows: 12 },
    signs: ['Supervisor', 'QC'],
    seal: false,
  },

  // ── Washing & Quality ──────────────────────────────────────────
  {
    key: 'washing-slip', group: 'Washing & Quality', icon: 'bi-droplet-half',
    name: 'Washing / Process Slip',
    desc: 'Garments in/out of wash with shrinkage & shade reference.',
    fields: ['Date', 'Batch No', 'Style', 'Wash Type', 'Shade Ref', 'Qty In', 'Qty Out', 'Shrinkage %'],
    table: { cols: ['Bundle / Lot No', 'Size', 'Qty In', 'Qty Out', 'Rejects', 'Remarks'], rows: 12 },
    summary: ['Total In', 'Total Out'],
    signs: ['Wash Master', 'Supervisor', 'QC', 'Manager'],
    seal: true,
  },
  {
    key: 'qc-inspection', group: 'Washing & Quality', icon: 'bi-search-heart',
    name: 'Quality Inspection / QC Report',
    desc: 'Inline or final inspection — defect tally with pass / reject result.',
    fields: ['Date', 'Batch No', 'Style', 'Stage (Inline / Final)', 'Inspected Qty', 'AQL'],
    table: { cols: ['Defect Type', 'Qty', 'Major / Minor', 'Remarks'], rows: 12 },
    summary: ['Total Checked', 'Passed', 'Rejected', 'Result (Pass / Fail)'],
    signs: ['QC Inspector', 'QC In-charge', 'Production Manager'],
    seal: true,
  },
  {
    key: 'finishing-packing', group: 'Washing & Quality', icon: 'bi-box-seam',
    name: 'Finishing / Packing List',
    desc: 'Carton-wise packing with size ratio and weights.',
    fields: ['Date', 'Batch No', 'Style', 'Buyer / Order No', 'Carton From – To', 'Total Cartons'],
    table: { cols: ['Carton No', 'Color', 'Size Ratio', 'Pcs / Carton', 'Total Pcs', 'Net Wt', 'Gross Wt'], rows: 12 },
    summary: ['Total Cartons', 'Total Pieces'],
    signs: ['Packing In-charge', 'QC', 'Store', 'Manager'],
    seal: true,
  },

  // ── Store & Materials ──────────────────────────────────────────
  {
    key: 'store-issue', group: 'Store & Materials', icon: 'bi-box-arrow-up',
    name: 'Material Issue / Store Requisition',
    desc: 'Request and issue of fabric / trims / accessories from the store.',
    fields: ['Issue No', 'Date', 'Department', 'Batch / Style', 'Issued To'],
    table: { cols: ['S.No', 'Material / Item', 'Code', 'Qty Requested', 'Qty Issued', 'Unit', 'Remarks'], rows: 12 },
    signs: ['Requested By', 'Issued By (Store)', 'Approved By (Manager)'],
    seal: true,
  },

  // ── Gate & Dispatch ────────────────────────────────────────────
  {
    key: 'gate-pass-out', group: 'Gate & Dispatch', icon: 'bi-door-open',
    name: 'Gate Pass — Outward (Returnable / Non-Returnable)',
    desc: 'Goods or material leaving the factory gate.',
    fields: ['Gate Pass No', 'Date', 'Time Out', 'Party / To', 'Vehicle No', 'Driver / Carrier', 'Returnable? (Y / N)', 'Expected Return Date'],
    table: { cols: ['S.No', 'Item Description', 'Qty', 'Unit', 'Remarks'], rows: 8 },
    signs: ['Prepared By', 'Store In-charge', 'Authorized By (Manager)', 'Security / Gate', 'Receiver'],
    seal: true, triplicate: true,
  },
  {
    key: 'gate-pass-in', group: 'Gate & Dispatch', icon: 'bi-door-closed',
    name: 'Gate Pass — Inward (Material Receipt)',
    desc: 'Material / goods received at the factory gate against a challan.',
    fields: ['Inward No', 'Date', 'Time In', 'Received From', 'Vehicle No', 'Challan / Invoice No', 'DC No'],
    table: { cols: ['S.No', 'Item', 'Qty as per Challan', 'Qty Received', 'Condition', 'Remarks'], rows: 8 },
    signs: ['Received By (Store)', 'Checked By', 'Security / Gate'],
    seal: true,
  },
  {
    key: 'jobwork-challan', group: 'Gate & Dispatch', icon: 'bi-arrow-left-right',
    name: 'Job Work / Delivery Challan (Outward)',
    desc: 'Goods sent out for job work — washing, embroidery, printing (GST job-work).',
    fields: ['Challan No', 'Date', 'To (Job Worker)', 'GSTIN', 'Process', 'Vehicle No', 'E-Way Bill No'],
    table: { cols: ['S.No', 'Description of Goods', 'HSN', 'Qty', 'Unit', 'Approx. Value (₹)', 'Remarks'], rows: 8 },
    note: 'Goods sent for job work and to be returned after process. Not a sale. Issued under GST rules for job work.',
    signs: ['Prepared By', 'Authorized Signatory'],
    seal: true, triplicate: true,
  },
  {
    key: 'dispatch-challan', group: 'Gate & Dispatch', icon: 'bi-truck',
    name: 'Dispatch / Delivery Challan (to Dealer)',
    desc: 'Finished goods dispatched to a dealer / customer.',
    fields: ['Challan No', 'Date', 'Dealer / Party', 'GSTIN', 'Address', 'Order / Invoice No', 'Transport', 'Vehicle No', 'LR No', 'E-Way Bill No'],
    table: { cols: ['S.No', 'Product / Style', 'HSN', 'Size / Color', 'Qty', 'Unit', 'Remarks'], rows: 10 },
    summary: ['Total Pieces', 'No. of Packages'],
    signs: ['Prepared By', 'Store / Dispatch', 'Authorized Signatory', 'Receiver (Sign & Seal)'],
    seal: true, triplicate: true,
  },
];

const byKey = Object.fromEntries(TEMPLATES.map(t => [t.key, t]));

// Gallery — grouped list of every slip with an Open / Print button.
router.get('/', (req, res) => {
  const groups = [];
  const seen = {};
  for (const t of TEMPLATES) {
    if (!seen[t.group]) { seen[t.group] = { title: t.group, items: [] }; groups.push(seen[t.group]); }
    seen[t.group].items.push(t);
  }
  res.render('slips/index', { title: 'Slips & Forms', groups, total: TEMPLATES.length });
});

// A single slip as a standalone print-ready page.
router.get('/:key', (req, res) => {
  const tpl = byKey[req.params.key];
  if (!tpl) return res.redirect('/slips');
  let copies = parseInt(req.query.copies, 10);
  if (!Number.isInteger(copies) || copies < 1 || copies > 3) copies = 1;
  res.render('slips/print', { layout: false, tpl, copies });
});

module.exports = router;
