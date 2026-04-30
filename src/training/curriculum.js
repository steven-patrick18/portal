// Training curriculum — all lesson content lives here so it's version-controlled
// alongside the code and easy to update when the UI changes.
//
// Structure: TOPICS[] → each has lessons[] of { heading, body[], tip?, warning? }.
// `body` items are paragraphs (strings) or step-arrays (string[]).
// Anything inside `<code>` is rendered monospace; **text** becomes bold.

module.exports = [
  {
    slug: 'getting-started',
    icon: 'bi-rocket-takeoff-fill',
    color: 'denim',
    title: 'Getting Started',
    summary: 'Log in, navigate the app, and set up your company branding.',
    duration: '5 min',
    audience: 'Everyone',
    lessons: [
      {
        heading: '1. Logging in',
        body: [
          'Open the app in any modern browser (Chrome, Edge, Firefox, Safari).',
          [
            'Enter your **email** (your owner gives you this — usually your name + your company\'s domain).',
            'Enter your **password**.',
            'Click **Sign In**.',
          ],
          'If you forget your password, ask the owner to reset it from **Settings → Users**.',
        ],
        warning: 'After 5 wrong attempts in 15 minutes the system will block your IP. Wait 15 minutes and try again.',
      },
      {
        heading: '2. Change your password (very important on first login)',
        body: [
          'The default password is `admin123`. Change it immediately.',
          [
            'Click your **name in the top-right corner**.',
            'Click **Profile** in the dropdown.',
            'Type a new strong password (min 8 characters, mix letters + numbers).',
            'Click **Save**.',
          ],
        ],
      },
      {
        heading: '3. Sidebar tour',
        body: [
          'The left sidebar groups every feature by area. Each section is **collapsible** — click the header to expand/collapse. Your last open/closed state is remembered.',
          [
            '**Dashboard** — KPIs and quick stats.',
            '**Sales** — dealers, orders, invoices, payments, dispatch, returns.',
            '**Inventory** — products, raw materials, suppliers, ready stock.',
            '**Production** — manufacturing batches, mfg expenses.',
            '**Purchasing** — purchase orders, vendor compare.',
            '**HR** — employees, attendance, payroll, advances, incentives.',
            '**Reports** — all reports + activity log.',
            '**Settings** — users, branding, payment modes, categories, roles.',
          ],
          'You only see sections your **role** has access to. The owner has access to everything.',
        ],
      },
      {
        heading: '4. Set company branding (one-time, owner only)',
        body: [
          'Make every invoice, page, and SMS show YOUR company name + logo:',
          [
            'Sidebar → **Settings → Company & Logo**.',
            'Upload your **logo** (PNG/JPG, max 2MB, square works best).',
            'Fill **Company Name**, **Address**, **Phone**, **GSTIN**, **State**.',
            'Click **Save Branding**. Done — appears everywhere immediately.',
          ],
        ],
        tip: '**State** matters: if a dealer is in the same state as you, GST splits as CGST + SGST. Different state → IGST. Set this once and forget about it.',
      },
    ],
  },

  {
    slug: 'sales',
    icon: 'bi-briefcase-fill',
    color: 'emerald',
    title: 'Sales: Dealer to Payment',
    summary: 'The full sales cycle — add dealer, create order, invoice, receive payment, dispatch.',
    duration: '15 min',
    audience: 'Salesperson, Owner, Admin',
    lessons: [
      {
        heading: '1. Add a new dealer (customer)',
        body: [
          [
            'Sidebar → **Sales → Dealers**.',
            'Click **+ New Dealer** (top-right).',
            'Fill required fields (**Name**, optional everything else but **GSTIN**, **City**, **State** are recommended).',
            'Set **Credit Limit** if you want a cap on outstanding balance.',
            'Pick a **Salesperson** (the person who owns this dealer\'s relationship).',
            'Click **Save**.',
          ],
        ],
        tip: 'Salespersons can only see dealers assigned to them. Admins/owners see all dealers.',
      },
      {
        heading: '2. Create a sales order',
        body: [
          [
            'Sidebar → **Sales → Sales Orders**.',
            'Click **+ New Order**.',
            'Pick the **Dealer**. Their assigned salesperson auto-links.',
            'Click **+ Add Row** for each product. Type to search the dropdown.',
            'Enter **Qty**, **Rate**, **GST%** for each line (rate auto-fills from the product\'s sale_price).',
            'Optional: add a **Discount** (₹ or %) — the totals recompute live.',
            'Click **Save Order**. The order is now **pending**.',
          ],
        ],
        warning: 'You can\'t add the same product twice in one order — the second dropdown hides it. Use the **Qty** column to order more of the same product instead.',
      },
      {
        heading: '3. Confirm + generate invoice',
        body: [
          'A **pending** order is just a quote — no stock is reserved. Once the dealer agrees:',
          [
            'Open the sales order.',
            'Click **Confirm** → status goes to *confirmed*.',
            'Click **Generate Invoice** → ',
            '  • Stock is decremented from ready stock',
            '  • An invoice is created (the discount carries over from the order)',
            '  • The order status flips to *invoiced*',
          ],
        ],
        tip: 'You can edit a sales order while it\'s pending (price changes, line items, discount). Once invoiced, the order is locked.',
      },
      {
        heading: '4. Print the invoice',
        body: [
          [
            'Open the invoice.',
            'Click **Print** (top-right).',
            'A printable tax invoice opens in a new tab with your logo + company info + GST split (CGST/SGST or IGST).',
            'Use the browser\'s print to PDF for a softcopy.',
          ],
        ],
      },
      {
        heading: '5. Receive a payment',
        body: [
          [
            'Open the invoice.',
            'Click **Receive Payment**.',
            'Enter **Amount** (defaults to invoice balance). For partial payments, type a smaller number.',
            'Pick **Mode** (Cash / Bank Transfer / UPI / Cheque).',
            'Type the **Reference No** (cheque #, UPI txn id, etc.).',
            'Click **Record Payment**.',
          ],
          'When the running total of payments equals the invoice total, the invoice flips to **paid** automatically.',
        ],
        warning: 'Payments by salespersons start in **pending** status. An accountant or admin must verify them in **Sales → Payments** before they reduce the dealer\'s outstanding balance. This catches collection fraud.',
      },
      {
        heading: '6. Dispatch + delivery tracking',
        body: [
          [
            'Open the invoice → click **Create Dispatch**.',
            'Fill **Transport / Vehicle / LR No / Freight**.',
            'Click **Save**.',
            'In **Sales → Dispatch**, update the status as the goods move: *dispatched → in_transit → delivered*.',
          ],
        ],
      },
    ],
  },

  {
    slug: 'production',
    icon: 'bi-gear-wide-connected',
    color: 'rose',
    title: 'Production: Cutting to Packing',
    summary: 'Plan a batch, move it through stages, and watch it auto-stock when packed.',
    duration: '12 min',
    audience: 'Production team, Owner, Admin',
    lessons: [
      {
        heading: '1. Set up your production stages (one-time, admin only)',
        body: [
          'The default stages are: Cutting → Stitching → Washing → Finishing → Packing. You can rename, reorder, or add stages.',
          [
            'Sidebar → **Settings → Production Stages**.',
            'Add stages with **+ Add Stage**.',
            'Set the **sort order** (smaller = earlier).',
            'The LAST stage is treated as "Packing" — completing it auto-adds the produced pieces to ready stock.',
          ],
        ],
      },
      {
        heading: '2. Define a product\'s BOM (raw material recipe)',
        body: [
          'Before producing a batch, the product needs a Bill of Materials so the system knows what raw materials to deduct.',
          [
            'Sidebar → **Inventory → Products** → open the product.',
            'Scroll to **BOM** section.',
            'Click **+ Add Material** → pick the raw material → enter qty per piece.',
            'Repeat for every material that goes into the product.',
          ],
        ],
        tip: 'BOMs are inherited by size variants automatically when you make a bundle batch (XL, L, M etc).',
      },
      {
        heading: '3. Create a production batch',
        body: [
          [
            'Sidebar → **Production → Batches** → **+ New Batch**.',
            'Pick the **Product**.',
            'Enter **Quantity Planned** (in pieces, or in *bundles* if it\'s a bundle batch).',
            'For a bundle batch: tick **Bundle** and list sizes like `XL, XL, L, M:2`. The system auto-creates size-variant products if they don\'t exist yet, copying the master\'s BOM.',
            'Click **Save**.',
          ],
        ],
      },
      {
        heading: '4. Issue raw materials',
        body: [
          'On the batch page, you\'ll see a BOM table showing exactly how much of each raw material is needed.',
          [
            'Click **Issue Materials**. Stock is deducted, an issue txn is logged.',
            'If you forget this step, the system **auto-issues** when you record the first stage entry — so it\'s mostly a safety button.',
          ],
        ],
        warning: 'If raw stock is short, the system warns and refuses (or, if you allow, lets the stock go negative for visibility).',
      },
      {
        heading: '5. Record stage progress (the daily worker entry)',
        body: [
          'Every day, the worker for each stage reports how many pieces moved through:',
          [
            'Open the batch.',
            'In the **next stage** card (auto-highlighted), enter **Qty Completed** + **Rejected**.',
            'Enter the **Worker Name** (free text).',
            'Enter **Rate per Piece** (this is the labour cost per piece — used for batch costing).',
            'Click **Save**. The pipeline progress bar updates.',
          ],
          'You can NEVER pass more pieces to a stage than the previous stage has completed. The system enforces this.',
        ],
      },
      {
        heading: '6. Pack & auto-stock',
        body: [
          'When you record entries on the **last stage** (Packing by default):',
          [
            'The pieces are added to **Ready Stock** automatically.',
            'A unique **piece code** (like `PRD00001-00042`) is created for every piece.',
            'For bundle batches, each size variant gets its own pieces.',
          ],
          'Click **Mark Complete** when the whole batch is done — this freezes the batch (no more entries).',
        ],
      },
    ],
  },

  {
    slug: 'hr',
    icon: 'bi-people-fill',
    color: 'marigold',
    title: 'HR & Payroll',
    summary: 'Onboard employees, mark attendance daily, and run the monthly payroll.',
    duration: '10 min',
    audience: 'Owner, Admin, Accountant',
    lessons: [
      {
        heading: '1. Add an employee',
        body: [
          [
            'Sidebar → **HR → Employees → + New Employee**.',
            'Fill **Name**, **Phone**, **Department**, **Designation**.',
            'Pick **Employee Type**:',
            '  • **Salary** — paid a fixed monthly salary (set **Base Salary**).',
            '  • **Contract** — paid per piece (set **Per-Piece Rate**).',
            'For sales staff, set **KM Rate** (₹ per km) for travel reimbursement.',
            'Optional: bank details for direct transfer slips.',
            'Click **Save**.',
          ],
        ],
      },
      {
        heading: '2. Define work types (operations)',
        body: [
          'For piece-rate workers, set up your operations once. The rate auto-fills when logging work.',
          [
            'Sidebar → **HR → Work Types**.',
            'Type the operation name (e.g. *baaltek*, *sidemunda*, *neckband*).',
            'Type the **Default Rate** (₹ per piece).',
            'Click **Add**. Repeat for each operation.',
          ],
          'Each operation can be edited or disabled later — past entries keep their original rate.',
        ],
      },
      {
        heading: '3. Mark attendance (daily — most important habit)',
        body: [
          [
            'Sidebar → **HR → Attendance**.',
            'Pick the **date** (defaults to today).',
            'For each employee, set status: **Present**, **Absent**, **Half-day**, **Leave**, **Holiday**.',
            'Click **Save All**.',
          ],
        ],
        warning: 'Days **not marked** count as **absent** in payroll. If you forget to mark for a day, mark them retroactively — or your salaried employees lose pay for that day.',
        tip: 'Mark **Holiday** for Sundays / public holidays — those count as paid. Mark **Leave** for paid leave.',
      },
      {
        heading: '4. Log per-piece work (for contract workers)',
        body: [
          [
            'Sidebar → **HR → Per-Piece Work**.',
            'Pick the **Employee** (only contract-type employees show).',
            'Pick the **Work Type** — rate auto-fills.',
            'Enter **Qty Pieces**.',
            'Optional: pick a **Product**.',
            'Click **Save**. Total amount is calculated and added to the month\'s payroll automatically.',
          ],
        ],
      },
      {
        heading: '5. Log KM trips (for sales staff)',
        body: [
          [
            'Sidebar → **HR → Mileage / KM**.',
            'Pick the **Employee** — KM rate auto-fills.',
            'Enter the **distance**, optionally pick the **Dealer** they visited.',
            'Click **Save**. Reimbursement adds to that month\'s payroll automatically.',
          ],
        ],
      },
      {
        heading: '6. Advances & incentives',
        body: [
          [
            '**Advances**: HR → Advances → enter employee + amount. Auto-deducted from the next salary payment, FIFO across multiple advances.',
            '**Incentives**: HR → Incentives → enter employee + period (YYYY-MM) + amount + reason. Auto-flows into that month\'s payroll.',
          ],
        ],
      },
      {
        heading: '7. Run the monthly payroll',
        body: [
          [
            'Sidebar → **HR → Payroll**.',
            'Pick the **period** (YYYY-MM, e.g. `2026-04`).',
            'Click **Generate**. The system creates a draft slip for every active employee, computing:',
            '  • **Base** = base_salary × (paid_days / month_days) [salary type] OR 0 [contract type]',
            '  • **Pieces** = sum of per-piece work that month',
            '  • **KM** = sum of trips that month',
            '  • **Incentives** = sum of incentives for the period',
            '  • **Advance deducted** = capped at gross',
            '  • **Net** = base + pieces + km + incentives − advance',
            'Open each slip → review → click **Mark Paid** when you actually pay.',
          ],
          'On Mark Paid: incentives are locked, open advances are auto-recovered FIFO.',
        ],
        warning: 'Once a slip is marked **paid**, it\'s locked forever — no edits, no delete. Drafts can be **Recalculate**\'d any time if you fix attendance / pieces / incentives after generating.',
      },
    ],
  },

  {
    slug: 'purchasing',
    icon: 'bi-cart3',
    color: 'denim',
    title: 'Purchasing & Vendor Comparison',
    summary: 'Compare vendor prices and create purchase orders for raw materials.',
    duration: '6 min',
    audience: 'Purchaser, Owner, Admin',
    lessons: [
      {
        heading: '1. Add suppliers + their prices',
        body: [
          [
            'Sidebar → **Inventory → Suppliers** → **+ New Supplier**.',
            'For each raw material a supplier sells, set their **price** in the supplier\'s product page.',
          ],
        ],
      },
      {
        heading: '2. Compare vendor prices',
        body: [
          [
            'Sidebar → **Purchasing → Compare Vendors**.',
            'Pick a raw material. The system shows every supplier\'s price side-by-side, sorted cheapest first.',
            'Use it to pick the best supplier before placing an order.',
          ],
        ],
      },
      {
        heading: '3. Raise a purchase order',
        body: [
          [
            'Sidebar → **Purchasing → Purchase Orders → + New PO**.',
            'Pick the **Supplier**.',
            'Add line items (raw material + qty + rate). Rates auto-fill from the supplier\'s recorded prices.',
            'Click **Save** to send.',
            'When goods arrive, click **Mark Received** — raw stock is incremented.',
          ],
        ],
      },
    ],
  },

  {
    slug: 'admin',
    icon: 'bi-shield-lock-fill',
    color: 'coral',
    title: 'Admin: Users, Roles & Backups',
    summary: 'Manage who can do what, see the audit log, and keep data safe.',
    duration: '8 min',
    audience: 'Owner, Admin',
    lessons: [
      {
        heading: '1. Add a user',
        body: [
          [
            'Sidebar → **Settings → Users → + New User**.',
            'Pick a **Role** (owner / admin / accountant / salesperson / production / store / purchaser).',
            'Fill **Name**, **Email**, **Phone**, set initial **Password** (they should change it after first login).',
            'Click **Save**.',
          ],
        ],
      },
      {
        heading: '2. Customize role permissions',
        body: [
          'Roles come with sensible defaults but you can fine-tune them:',
          [
            'Sidebar → **Settings → Access & Roles**.',
            'See the matrix: rows are roles, columns are features. Each cell shows the current level (none / view / limited / full).',
            'Click any cell → pick a new level → it saves immediately.',
          ],
          'You can\'t change owner permissions — owner always has full access.',
        ],
        tip: 'For a less-tech-savvy salesperson, set **payments** to *limited* — they can record a payment but not verify it (an accountant must do that).',
      },
      {
        heading: '3. Assign dealers to salespersons',
        body: [
          [
            'Sidebar → **Settings → Assign Dealers**.',
            'Filter the dealer list by salesperson or "unassigned".',
            'Tick dealers + pick a salesperson → click **Assign**.',
            'Salespersons only see dealers assigned to them — keeps their view focused.',
          ],
        ],
      },
      {
        heading: '4. The activity log (audit trail)',
        body: [
          'Every important action is logged: who did what, when, from which IP.',
          [
            'Sidebar → **Reports → Activity Log**.',
            'Filter by action / table / user / date range.',
            'Useful for: investigating disputes, tracking deletions, fraud detection.',
          ],
        ],
      },
      {
        heading: '5. Backups (automated)',
        body: [
          'On a properly-installed VPS, the system runs `deploy/backup.sh` daily at 02:30. It dumps the SQLite DB + uploaded files to `backups/` with 14-day retention. The script uses SQLite\'s online backup API so it\'s safe to run while users are working.',
          'For off-site backups, sync `backups/` to S3 / another server / your laptop with a cron rsync job.',
        ],
        warning: 'The DB is at `data/portal.db`. If anything goes wrong, restoring from a backup is: stop the app, restore the file, start the app. Migrations are idempotent so a restored old DB will still work with newer code.',
      },
    ],
  },
];
