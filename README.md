# Portal — Garment Manufacturing ERP

A self-hosted ERP for a garment manufacturing business. Built with Node.js + Express + SQLite + EJS + Bootstrap.

## Modules implemented (Phase 1)

1. ✅ Product Management
2. ✅ Raw Material Management
3. ✅ Fabric Cost Calculation (Cutting Efficiency)
4. ✅ Manufacturing Expense Entry
5. ✅ Production Stage Tracking — Cutting / Stitching / Washing / Finishing / Packing (auto-stocks Ready Stock on packing)
6. ✅ Ready Stock Management
7. ✅ Dealer / Customer Management
8. ✅ Sales Order & Invoice (with GST: CGST/SGST or IGST)
9. ✅ Dealer Outstanding Ledger
10. ✅ Salesperson Payment Collection (with geolocation capture)
11. ✅ Dealer Notification (SMS / WhatsApp via MSG91; stub mode by default)
12. ✅ Fraud Control for Payment Entries (duplicate ref check, balance check, dealer-assignment check, salesperson approvals)
13. ✅ Payment Modes
14. ✅ Dispatch Management (with status: dispatched/in_transit/delivered/returned)
15. ✅ Returns Handling (with optional restock)
16-21. ✅ Reports — Daily Production, Daily Sales/Salesperson, Daily Collection, Outstanding, Stock
22. ✅ Owner Dashboard (live KPIs)
23. ✅ Salesperson Mobile Access (`/mobile`)
24. ✅ User Roles & Permissions (owner / admin / accountant / salesperson / production / store)
25. ✅ Data Import (CSV: products, dealers, suppliers, raw_materials)
26. ✅ SMS / WhatsApp Integration (MSG91 wrapper, stub mode)
27. ✅ Product Performance Monitoring (Slow / Fast moving)

## Quick start

```bash
npm install
cp .env.example .env   # already created with sane defaults
npm start
```

Open http://localhost:6672

**Default seed users** (password `admin123`):
- `owner@portal.local` (full access)
- `admin@portal.local`
- `sales1@portal.local` (mobile UI at `/mobile`)

## Project structure

```
portal/
├── server.js          # Entry point — boots app and inits DB
├── src/
│   ├── app.js         # Express setup, middleware, route registration
│   ├── db/
│   │   ├── index.js   # SQLite connection + first-run seed
│   │   └── schema.sql # All 29-module tables
│   ├── middleware/    # Auth, RBAC, flash
│   ├── routes/        # One file per feature area
│   └── utils/         # Format helpers, codegen, MSG91 wrapper
├── views/             # EJS templates (one folder per module)
├── public/            # CSS, JS, static assets
└── data/portal.db     # SQLite DB (auto-created, gitignored)
```

## Configuration

Edit `.env`:

| Var | Purpose |
|-----|---------|
| `PORT` | HTTP port (default 6672) |
| `SESSION_SECRET` | Cookie signing secret (change in prod!) |
| `DB_PATH` | SQLite DB file path |
| `COMPANY_NAME` / `COMPANY_GSTIN` / `COMPANY_ADDRESS` / `COMPANY_PHONE` | Printed on invoices |
| `COMPANY_STATE` | If set, intra-state invoices use CGST+SGST; otherwise IGST |
| `MSG91_AUTH_KEY` | MSG91 API auth key (leave blank for stub mode) |
| `MSG91_ENABLED` | `true` to actually send (default `false` = log only) |
| `MSG91_SENDER_ID` | DLT-approved sender ID |
| `MSG91_DLT_TEMPLATE_PAYMENT` | DLT template ID for payment confirmation |

## Roles & Permissions

| Role | Access |
|------|--------|
| **owner** | Everything (always overrides) |
| **admin** | Everything except being demoted |
| **accountant** | Verify payments, approve returns |
| **salesperson** | Mobile views, own dealers, raise orders, collect payments (require verification) |
| **production** | Production batches, raw materials |
| **store** | Stock, dispatch |

## Deployment to VPS (Ubuntu)

See [docs/DEPLOY.md](docs/DEPLOY.md).

## Notes

- **Phase 1**: All 29 modules have working pages and DB schema. Core flows (orders → invoices → payments → outstanding, production → stock) are wired end-to-end.
- **Phase 2 enhancements** (when needed): purchase orders for raw materials, batch-wise costing, GST returns export, e-invoicing/e-way bill, accounting ledger / journal entries, multi-warehouse, payment reconciliation with bank statement.
