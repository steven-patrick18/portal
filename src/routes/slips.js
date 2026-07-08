// Slips & Forms — print-ready shop-floor forms for the full garment flow.
// Designed for semi-literate floor staff: SHORT, big boxes, bilingual labels
// (English / हिंदी). Blank fillable forms carrying the company letterhead and
// ruled boxes for batch / bundle / piece numbers + signatures & seal.
// No data is stored — print only.
//
// Template shape:
//   name / nameHi        title (English + Hindi)
//   group / groupHi      gallery section
//   desc                 one short line for the card
//   fields[]             header blanks ("English / हिंदी")
//   table {cols[], rows} ruled grid
//   summary[]            total blanks (optional)
//   handover {from,to}   two-party GIVEN→RECEIVED block (replaces signs)
//   signs[]              signature roles (when not a handover)
//   seal                 show a Company-Seal box
//   big                  larger boxes/fonts (floor slips)
//   triplicate           print Original/Duplicate/Triplicate
const express = require('express');
const { db } = require('../db');
const router = express.Router();

// Short per-slip number prefix (e.g. HCS-0001, CUT-0042, DC-0007).
const PREFIX = {
  'handover-cut-stitch': 'HCS', 'handover-stitch-wash': 'HSW', 'handover-wash-finish': 'HWF',
  'handover-finish-pack': 'HFP', 'handover-pack-store': 'HPS', 'handover-general': 'HO',
  'cutting-bundle': 'CUT', 'batch-details': 'BAT', 'stitching-line': 'STL', 'bundle-ticket': 'BTK',
  'washing-slip': 'WSH', 'qc-inspection': 'QC', 'finishing-packing': 'PCK', 'store-issue': 'STR', 'size-chart': 'SZC',
  'gate-pass-out': 'GPO', 'gate-pass-in': 'GPI', 'jobwork-challan': 'JW', 'dispatch-challan': 'DC',
};
// Allocate the next running slip number(s) for a template (persisted counter).
function nextSlipNos(key, count) {
  const prefix = PREFIX[key] || 'SLP';
  const k = 'SLIP_SEQ_' + key;
  const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(k);
  let last = row ? (parseInt(row.value, 10) || 0) : 0;
  const out = [];
  for (let i = 0; i < count; i++) { last += 1; out.push(prefix + '-' + String(last).padStart(4, '0')); }
  db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, String(last));
  return out;
}

// Reusable bits to keep handover slips identical & simple.
const HO_FIELDS = ['Date / दिनांक', 'Batch / Lot No / बैच नं', 'Style / स्टाइल'];
const HO_TABLE = { cols: ['Bundle No / बंडल नं', 'Size / साइज़', 'Qty (pcs) / नग', 'Remarks / नोट'], rows: 8 };
const HO_SUMMARY = ['Total Bundles / कुल बंडल', 'Total Pieces / कुल नग'];
const handover = (key, name, nameHi, desc, from, to) => ({
  key, group: 'Handover / Transfer', groupHi: 'हैंडओवर / देना-लेना',
  name, nameHi, desc, icon: 'bi-arrow-left-right', big: true,
  fields: HO_FIELDS, table: HO_TABLE, summary: HO_SUMMARY,
  handover: { from, to }, seal: false,
});

const TEMPLATES = [
  // ── Handover / Transfer (the floor hand-off slips) ─────────────
  handover('handover-cut-stitch', 'Cutting → Stitching Handover', 'कटिंग → सिलाई हैंडओवर',
    'Cutting Master gives bundles to the Line Master, who signs.',
    'Given by — Cutting Master / कटिंग मास्टर', 'Received by — Line Master / लाइन मास्टर'),
  handover('handover-stitch-wash', 'Stitching → Washing Handover', 'सिलाई → धुलाई हैंडओवर',
    'Line Master gives stitched pieces to the Wash Master, who signs.',
    'Given by — Line Master / लाइन मास्टर', 'Received by — Wash Master / वॉश मास्टर'),
  handover('handover-wash-finish', 'Washing → Finishing Handover', 'धुलाई → फिनिशिंग हैंडओवर',
    'Wash Master gives washed pieces to Finishing, who signs.',
    'Given by — Wash Master / वॉश मास्टर', 'Received by — Finishing In-charge / फिनिशिंग इंचार्ज'),
  handover('handover-finish-pack', 'Finishing → Packing Handover', 'फिनिशिंग → पैकिंग हैंडओवर',
    'Finishing gives finished pieces to Packing, who signs.',
    'Given by — Finishing In-charge / फिनिशिंग इंचार्ज', 'Received by — Packing In-charge / पैकिंग इंचार्ज'),
  handover('handover-pack-store', 'Packing → Store / Dispatch Handover', 'पैकिंग → स्टोर हैंडओवर',
    'Packing gives packed cartons to Store / Dispatch, who signs.',
    'Given by — Packing In-charge / पैकिंग इंचार्ज', 'Received by — Store In-charge / स्टोर इंचार्ज'),
  {
    key: 'handover-general', group: 'Handover / Transfer', groupHi: 'हैंडओवर / देना-लेना',
    name: 'General Handover / Transfer Slip', nameHi: 'सामान्य हैंडओवर पर्ची',
    desc: 'Any person → any person. Write both names; both sign.',
    icon: 'bi-arrows-collapse', big: true,
    fields: ['Date / दिनांक', 'Batch / Lot No / बैच नं', 'From (dept) / किससे (विभाग)', 'To (dept) / किसको (विभाग)'],
    table: HO_TABLE, summary: HO_SUMMARY,
    handover: { from: 'Given by / देने वाला', to: 'Received by / लेने वाला' }, seal: false,
  },

  // ── Cutting & Production ───────────────────────────────────────
  {
    key: 'cutting-bundle', group: 'Cutting & Production', groupHi: 'कटिंग / प्रोडक्शन', icon: 'bi-scissors',
    name: 'Cutting Slip / Bundle Card', nameHi: 'कटिंग / बंडल पर्ची',
    desc: 'Bundle breakup with piece numbers — from the cutting table.',
    big: true,
    fields: ['Date / दिनांक', 'Batch / Lot No / बैच नं', 'Style / स्टाइल', 'Fabric / Shade / कपड़ा/शेड'],
    table: { cols: ['Bundle No / बंडल', 'Size / साइज़', 'Piece No (से–तक)', 'Qty / नग', 'Remarks / नोट'], rows: 10 },
    summary: ['Total Bundles / कुल बंडल', 'Total Pieces / कुल नग'],
    signs: ['Cutting Master / कटिंग मास्टर', 'Supervisor / सुपरवाइज़र'],
    seal: true,
  },
  {
    key: 'batch-details', group: 'Cutting & Production', groupHi: 'कटिंग / प्रोडक्शन', icon: 'bi-clipboard2-data',
    name: 'Batch Details Sheet (Job Card)', nameHi: 'बैच कार्ड',
    desc: 'One batch tracked size-wise through every stage.',
    fields: ['Batch No / बैच नं', 'Date / दिनांक', 'Style / स्टाइल', 'Total Qty / कुल नग'],
    table: { cols: ['Size / साइज़', 'Cut / कटा', 'Stitched / सिला', 'Washed / धुला', 'Finished / फिनिश', 'Packed / पैक', 'Balance / बाकी'], rows: 10 },
    signs: ['Prepared By / बनाया', 'Production Manager / मैनेजर', 'HOD'],
    seal: true,
  },
  {
    key: 'stitching-line', group: 'Cutting & Production', groupHi: 'कटिंग / प्रोडक्शन', icon: 'bi-needle',
    name: 'Stitching / Line Production Slip', nameHi: 'सिलाई लाइन पर्ची',
    desc: 'Per-line daily output — in vs out and rejects.',
    big: true,
    fields: ['Date / दिनांक', 'Line No / लाइन नं', 'Style / स्टाइल', 'Batch No / बैच नं'],
    table: { cols: ['Operation / काम', 'Operator / ऑपरेटर', 'Qty In / आया', 'Qty Out / गया', 'Reject / रिजेक्ट'], rows: 10 },
    summary: ['Total Out / कुल गया', 'Total Reject / कुल रिजेक्ट'],
    signs: ['Supervisor / सुपरवाइज़र', 'Production Manager / मैनेजर'],
    seal: true,
  },
  {
    key: 'bundle-ticket', group: 'Cutting & Production', groupHi: 'कटिंग / प्रोडक्शन', icon: 'bi-ticket-detailed',
    name: 'Bundle Ticket / Operation Card', nameHi: 'बंडल टिकट',
    desc: 'Travels with one bundle — each operation signs.',
    big: true,
    fields: ['Bundle No / बंडल नं', 'Batch No / बैच नं', 'Size / साइज़', 'Qty / नग'],
    table: { cols: ['Operation / काम', 'Operator / ऑपरेटर', 'OK', 'Reject / रिजेक्ट', 'Sign / साइन'], rows: 8 },
    signs: ['Supervisor / सुपरवाइज़र'],
    seal: false,
  },

  // ── Washing & Quality ──────────────────────────────────────────
  {
    key: 'washing-slip', group: 'Washing & Quality', groupHi: 'धुलाई / चेकिंग', icon: 'bi-droplet-half',
    name: 'Washing / Process Slip', nameHi: 'धुलाई पर्ची',
    desc: 'Pieces in/out of wash with shrinkage & shade.',
    big: true,
    fields: ['Date / दिनांक', 'Batch No / बैच नं', 'Wash Type / धुलाई', 'Shrinkage % / सिकुड़न %'],
    table: { cols: ['Lot No / लॉट', 'Size / साइज़', 'In / आया', 'Out / गया', 'Reject / रिजेक्ट'], rows: 8 },
    summary: ['Total In / कुल आया', 'Total Out / कुल गया'],
    signs: ['Wash Master / वॉश मास्टर', 'QC / चेकर'],
    seal: true,
  },
  {
    key: 'qc-inspection', group: 'Washing & Quality', groupHi: 'धुलाई / चेकिंग', icon: 'bi-search-heart',
    name: 'Quality Check / QC Report', nameHi: 'क्वालिटी चेक रिपोर्ट',
    desc: 'Defect tally with pass / reject result.',
    big: true,
    fields: ['Date / दिनांक', 'Batch No / बैच नं', 'Style / स्टाइल', 'Checked Qty / चेक नग'],
    table: { cols: ['Defect / खराबी', 'Qty / नग', 'Remarks / नोट'], rows: 9 },
    summary: ['Checked / चेक', 'Pass / पास', 'Reject / फेल'],
    signs: ['QC Inspector / चेकर', 'Production Manager / मैनेजर'],
    seal: true,
  },
  {
    key: 'size-chart', group: 'Washing & Quality', groupHi: 'धुलाई / चेकिंग', icon: 'bi-rulers',
    name: 'Size Chart / Measurement Sheet', nameHi: 'साइज़ चार्ट / माप शीट',
    desc: 'Measure pieces of every size against the style spec — before/after wash.',
    fields: ['Date / दिनांक', 'Style / स्टाइल', 'Batch / Lot No / बैच नं', 'Stage: Before ▢ / After wash ▢ / धुलाई से पहले-बाद', 'Fabric & Shrinkage % / कपड़ा व सिकुड़न', 'Pcs checked per size / प्रति साइज़ नग'],
    table: {
      cols: ['Measurement / माप', 'Tol ± / छूट', 'Size ___', 'Size ___', 'Size ___', 'Size ___', 'Size ___', 'Size ___'],
      rowLabels: ['Waist / कमर', 'Hip / हिप', 'Thigh / जाँघ', 'Knee / घुटना', 'Leg opening / मोहरी', 'Front rise / फ्रंट राइज़', 'Back rise / बैक राइज़', 'Inseam / इनसीम', 'Outseam (Length) / लंबाई', 'Waistband height / बेल्ट चौड़ाई', '', '', ''],
    },
    note: 'Write the SPEC from the style\'s master size chart, then the measured value in each size column. Denim must be measured AFTER wash. Blank rows are for extra points (shirt: chest, shoulder, sleeve). / मास्टर साइज़ चार्ट से स्पेक लिखें, फिर हर साइज़ का नापा माप। डेनिम धुलाई के बाद नापें।',
    signs: ['QC / चेकर', 'Pattern Master / पैटर्न मास्टर', 'Production Manager / मैनेजर'],
    seal: true,
  },
  {
    key: 'finishing-packing', group: 'Washing & Quality', groupHi: 'धुलाई / चेकिंग', icon: 'bi-box-seam',
    name: 'Finishing / Packing List', nameHi: 'फिनिशिंग / पैकिंग लिस्ट',
    desc: 'Carton-wise packing with size ratio.',
    fields: ['Date / दिनांक', 'Batch No / बैच नं', 'Style / स्टाइल', 'Total Cartons / कुल कार्टन'],
    table: { cols: ['Carton No / कार्टन', 'Color / रंग', 'Size Ratio / रेशियो', 'Pcs/Carton / नग', 'Total / कुल'], rows: 10 },
    summary: ['Total Cartons / कुल कार्टन', 'Total Pieces / कुल नग'],
    signs: ['Packing In-charge / पैकिंग इंचार्ज', 'QC / चेकर'],
    seal: true,
  },

  // ── Store & Gate ───────────────────────────────────────────────
  {
    key: 'store-issue', group: 'Store & Gate', groupHi: 'स्टोर / गेट', icon: 'bi-box-arrow-up',
    name: 'Material Issue / Store Slip', nameHi: 'सामान देने की पर्ची',
    desc: 'Fabric / trims issued from the store.',
    big: true,
    fields: ['Date / दिनांक', 'Issue No / नं', 'Department / विभाग', 'Issued To / किसको'],
    table: { cols: ['Item / सामान', 'Qty / नग', 'Unit / यूनिट', 'Remarks / नोट'], rows: 9 },
    signs: ['Issued By (Store) / स्टोर', 'Received By / लेने वाला', 'Manager / मैनेजर'],
    seal: true,
  },
  {
    key: 'gate-pass-out', group: 'Store & Gate', groupHi: 'स्टोर / गेट', icon: 'bi-door-open',
    name: 'Gate Pass — Outward', nameHi: 'गेट पास — बाहर',
    desc: 'Goods leaving the gate (returnable / non-returnable).',
    fields: ['Gate Pass No / नं', 'Date / दिनांक', 'To / किसको', 'Vehicle No / गाड़ी नं', 'Returnable? (Y/N) / वापसी?'],
    table: { cols: ['S.No', 'Item / सामान', 'Qty / नग', 'Remarks / नोट'], rows: 8 },
    signs: ['Store / स्टोर', 'Authorized By / मैनेजर', 'Security / गेट'],
    seal: true, triplicate: true,
  },
  {
    key: 'gate-pass-in', group: 'Store & Gate', groupHi: 'स्टोर / गेट', icon: 'bi-door-closed',
    name: 'Gate Pass — Inward', nameHi: 'गेट पास — अंदर',
    desc: 'Material received at the gate against a challan.',
    fields: ['Inward No / नं', 'Date / दिनांक', 'From / किससे', 'Vehicle No / गाड़ी नं', 'Challan No / चालान नं'],
    table: { cols: ['S.No', 'Item / सामान', 'Qty / नग', 'Condition / हालत', 'Remarks / नोट'], rows: 8 },
    signs: ['Received By (Store) / स्टोर', 'Security / गेट'],
    seal: true,
  },

  // ── Dispatch & Job Work (office documents) ─────────────────────
  {
    key: 'jobwork-challan', group: 'Dispatch & Job Work', groupHi: 'डिस्पैच', icon: 'bi-arrow-left-right',
    name: 'Job Work / Delivery Challan', nameHi: 'जॉब वर्क चालान',
    desc: 'Goods sent out for wash / embroidery / printing (GST).',
    fields: ['Challan No / नं', 'Date / दिनांक', 'To (Job Worker) / किसको', 'GSTIN', 'Process / काम', 'Vehicle No / गाड़ी', 'E-Way Bill No'],
    table: { cols: ['S.No', 'Description / सामान', 'HSN', 'Qty / नग', 'Unit', 'Approx. Value (₹)', 'Remarks'], rows: 8 },
    note: 'Goods sent for job work, to be returned after process. Not a sale. / जॉब वर्क के लिए भेजा — बिक्री नहीं, वापस आएगा।',
    signs: ['Prepared By / बनाया', 'Authorized Signatory / अधिकृत'],
    seal: true, triplicate: true,
  },
  {
    key: 'dispatch-challan', group: 'Dispatch & Job Work', groupHi: 'डिस्पैच', icon: 'bi-truck',
    name: 'Dispatch / Delivery Challan', nameHi: 'डिस्पैच चालान',
    desc: 'Finished goods dispatched to a dealer.',
    fields: ['Challan No / नं', 'Date / दिनांक', 'Dealer / Party / पार्टी', 'GSTIN', 'Invoice No', 'Transport', 'Vehicle No / गाड़ी', 'E-Way Bill No'],
    table: { cols: ['S.No', 'Product / Style', 'HSN', 'Size / Color', 'Qty / नग', 'Unit', 'Remarks'], rows: 9 },
    summary: ['Total Pieces / कुल नग', 'Packages / कार्टन'],
    signs: ['Prepared By / बनाया', 'Store / Dispatch / स्टोर', 'Authorized / अधिकृत', 'Receiver / लेने वाला'],
    seal: true, triplicate: true,
  },
];

const byKey = Object.fromEntries(TEMPLATES.map(t => [t.key, t]));

// Gallery — grouped list of every slip with an Open / Print button.
router.get('/', (req, res) => {
  const groups = [];
  const seen = {};
  for (const t of TEMPLATES) {
    if (!seen[t.group]) { seen[t.group] = { title: t.group, titleHi: t.groupHi, items: [] }; groups.push(seen[t.group]); }
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
  // Triplicate = the SAME document printed 3 times → one shared number.
  // Plain multi-copy = separate blank forms → a distinct number each.
  const seq = nextSlipNos(tpl.key, tpl.triplicate ? 1 : copies);
  const slipNos = [];
  for (let i = 0; i < copies; i++) slipNos.push(tpl.triplicate ? seq[0] : seq[i]);
  const d = new Date();
  const today = String(d.getDate()).padStart(2, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + d.getFullYear();
  res.render('slips/print', { layout: false, tpl, copies, slipNos, today });
});

module.exports = router;
