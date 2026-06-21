// HR document template engine.
//
// Each builder takes a context { emp, company, today, extras } and
// returns { title, html } — the html is the BODY of the letter
// (the letterhead / signatures are added by the print view). Wording
// follows standard Indian HR / labour-law conventions and is meant as
// a vetted-once starting point: the owner reviews each generated
// letter and can edit it before issuing. NOT legal advice.
//
// "Merge" here is plain JS interpolation of the employee + company
// data — no separate token language to maintain.

const { fmtINR, fmtDate, amountInWordsINR } = require('./format');

// 'YYYY-MM-DD' → 'DD Month YYYY' (e.g. 08 June 2026). Falls back to '—'.
function longDate(iso) {
  if (!iso) return '__________';
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  if (isNaN(d)) return String(iso);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${String(d.getDate()).padStart(2,'0')} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Add N months to an ISO date → ISO date.
function addMonths(iso, n) {
  if (!iso) return null;
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  if (isNaN(d)) return null;
  d.setMonth(d.getMonth() + (parseInt(n) || 0));
  return d.toISOString().slice(0, 10);
}

// Standard non-metro CTC breakup from a monthly gross figure.
//   Basic   = 50% of gross
//   HRA     = 40% of Basic
//   Special = remainder
// PF/ESI are shown as notes, not deducted here (depends on registration).
function salaryBreakup(monthlyGross) {
  const gross = Number(monthlyGross) || 0;
  const basic = Math.round(gross * 0.50);
  const hra   = Math.round(basic * 0.40);
  const special = Math.max(0, gross - basic - hra);
  return {
    gross, basic, hra, special,
    annualCtc: gross * 12,
  };
}

function signatureNote() {
  // Shown on screen + print as a faint reminder that the issued copy
  // must be signed + stamped. (Vetting reminder is screen-only, in the
  // generate panel — not printed on the employee's letter.)
  return '';
}

// ── Letter builders ─────────────────────────────────────────────
const BUILDERS = {

  offer: (ctx) => {
    const { emp, company, today } = ctx;
    const b = salaryBreakup(emp.base_salary);
    return {
      title: 'Offer of Employment',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>${esc(emp.name)}</strong><br>${esc(emp.address || '')}</p>
<p><strong>Subject: Offer of Employment — ${esc(emp.designation || 'the position offered')}</strong></p>
<p>Dear ${esc(emp.name)},</p>
<p>With reference to your application and the subsequent interview, we are pleased to offer you the position of
<strong>${esc(emp.designation || '____________')}</strong>${emp.department ? ' in the ' + esc(emp.department) + ' department' : ''} at ${esc(company.name)}, on the following principal terms:</p>
<table style="width:100%; border-collapse:collapse; margin:8px 0">
  <tr><td style="padding:3px 8px; border:1px solid #999; width:45%">Designation</td><td style="padding:3px 8px; border:1px solid #999">${esc(emp.designation || '____________')}</td></tr>
  <tr><td style="padding:3px 8px; border:1px solid #999">Place of work</td><td style="padding:3px 8px; border:1px solid #999">${esc(company.address || company.name)}</td></tr>
  <tr><td style="padding:3px 8px; border:1px solid #999">Proposed date of joining</td><td style="padding:3px 8px; border:1px solid #999">${longDate(emp.joining_date)}</td></tr>
  <tr><td style="padding:3px 8px; border:1px solid #999">Gross monthly remuneration</td><td style="padding:3px 8px; border:1px solid #999">${fmtINR(b.gross)} (Annual ${fmtINR(b.annualCtc)})</td></tr>
  <tr><td style="padding:3px 8px; border:1px solid #999">Probation period</td><td style="padding:3px 8px; border:1px solid #999">${emp.probation_months || 3} months</td></tr>
</table>
<p>This offer is subject to: (a) verification of the documents and references submitted by you; (b) your being medically fit; and (c) your acceptance of our standard Appointment terms and Company policies. The detailed Appointment Letter will be issued on the date of your joining.</p>
<p>Please confirm your acceptance by signing the duplicate copy of this letter and reporting for duty on the date mentioned above. This offer, unless accepted, shall lapse after fifteen (15) days from the date hereof.</p>
<p>We look forward to a long and mutually rewarding association.</p>
<p>Yours sincerely,<br>For <strong>${esc(company.name)}</strong></p>
`,
    };
  },

  appointment: (ctx) => {
    const { emp, company, today } = ctx;
    const b = salaryBreakup(emp.base_salary);
    return {
      title: 'Appointment Letter',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>${esc(emp.name)}</strong>${emp.father_name ? '<br>S/o ' + esc(emp.father_name) : ''}<br>${esc(emp.address || '')}</p>
<p><strong>Subject: Letter of Appointment</strong></p>
<p>Dear ${esc(emp.name)},</p>
<p>We are pleased to appoint you as <strong>${esc(emp.designation || '____________')}</strong>${emp.department ? ' in the ' + esc(emp.department) + ' department' : ''} at ${esc(company.name)} with effect from <strong>${longDate(emp.joining_date)}</strong>, on the following terms and conditions:</p>

<p><strong>1. Remuneration.</strong> Your remuneration shall be as per the structure below:</p>
<table style="width:100%; border-collapse:collapse; margin:6px 0">
  <thead><tr>
    <th style="padding:4px 8px; border:1px solid #999; text-align:left; background:#f2f2f2">Component</th>
    <th style="padding:4px 8px; border:1px solid #999; text-align:right; background:#f2f2f2">Per Month (₹)</th>
    <th style="padding:4px 8px; border:1px solid #999; text-align:right; background:#f2f2f2">Per Annum (₹)</th>
  </tr></thead>
  <tbody>
    <tr><td style="padding:3px 8px; border:1px solid #999">Basic Salary</td><td style="padding:3px 8px; border:1px solid #999; text-align:right">${b.basic.toLocaleString('en-IN')}</td><td style="padding:3px 8px; border:1px solid #999; text-align:right">${(b.basic*12).toLocaleString('en-IN')}</td></tr>
    <tr><td style="padding:3px 8px; border:1px solid #999">House Rent Allowance</td><td style="padding:3px 8px; border:1px solid #999; text-align:right">${b.hra.toLocaleString('en-IN')}</td><td style="padding:3px 8px; border:1px solid #999; text-align:right">${(b.hra*12).toLocaleString('en-IN')}</td></tr>
    <tr><td style="padding:3px 8px; border:1px solid #999">Special / Other Allowance</td><td style="padding:3px 8px; border:1px solid #999; text-align:right">${b.special.toLocaleString('en-IN')}</td><td style="padding:3px 8px; border:1px solid #999; text-align:right">${(b.special*12).toLocaleString('en-IN')}</td></tr>
    <tr style="font-weight:700"><td style="padding:3px 8px; border:1px solid #999">Gross</td><td style="padding:3px 8px; border:1px solid #999; text-align:right">${b.gross.toLocaleString('en-IN')}</td><td style="padding:3px 8px; border:1px solid #999; text-align:right">${b.annualCtc.toLocaleString('en-IN')}</td></tr>
  </tbody>
</table>
<p style="font-size:9pt; color:#555">Statutory deductions (Provident Fund, ESI, Professional Tax, TDS) and statutory benefits (Bonus, Gratuity) shall apply as per the applicable laws and the Company's registration status, and will be reflected in your monthly pay slip.</p>

<p><strong>2. Probation.</strong> You will be on probation for a period of <strong>${emp.probation_months || 3} months</strong> from your date of joining. During probation, either party may terminate this engagement by giving seven (7) days' notice or salary in lieu thereof. On satisfactory completion, your services will be confirmed in writing.</p>

<p><strong>3. Notice period.</strong> After confirmation, either party may terminate the employment by giving <strong>${emp.notice_period_days || 30} days'</strong> written notice or salary in lieu thereof, except in cases of termination for misconduct, where no notice or pay in lieu shall be payable.</p>

<p><strong>4. Hours &amp; place of work.</strong> You will observe the working hours, weekly-off and holiday schedule notified by the Company from time to time, and will be based at ${esc(company.address || company.name)}. The Company may transfer or depute you to any of its units, branches or associated establishments.</p>

<p><strong>5. Duties.</strong> You will perform the duties assigned to you diligently and to the best of your ability, and will report to ${esc(emp.reporting_to || 'the Management / your reporting officer')}. You shall not engage in any other employment, business or trade during your service with the Company.</p>

<p><strong>6. Confidentiality.</strong> You shall keep confidential all designs, patterns, costing, supplier and customer information, and any other proprietary information of the Company, both during and after your employment.</p>

<p><strong>7. Conduct &amp; policies.</strong> You will abide by the Company's Rules, Standing Orders and Policy Handbook (including the Code of Conduct and the Prevention of Sexual Harassment policy), as amended from time to time. A breach may attract disciplinary action up to and including termination.</p>

<p><strong>8. Retirement.</strong> You shall retire on attaining the age of 58 years, unless extended in writing by the Company.</p>

<p><strong>9. Governing law.</strong> This appointment is governed by the laws of India, and the courts at the place of work shall have jurisdiction.</p>

<p>Please sign and return the duplicate copy of this letter in token of your acceptance of the above terms.</p>
<p>We welcome you to <strong>${esc(company.name)}</strong> and wish you a successful career with us.</p>
<p>Yours sincerely,<br>For <strong>${esc(company.name)}</strong></p>
`,
    };
  },

  joining: (ctx) => {
    const { emp, company, today } = ctx;
    return {
      title: 'Joining Report',
      html: `
<p style="text-align:right">Date: ${longDate(today)}</p>
<p>To,<br>The Management,<br><strong>${esc(company.name)}</strong></p>
<p><strong>Subject: Joining Report</strong></p>
<p>Dear Sir/Madam,</p>
<p>I, <strong>${esc(emp.name)}</strong>${emp.father_name ? ', S/o ' + esc(emp.father_name) : ''}, hereby report for duty and confirm that I have joined the services of ${esc(company.name)} as <strong>${esc(emp.designation || '____________')}</strong>${emp.department ? ' in the ' + esc(emp.department) + ' department' : ''} on <strong>${longDate(emp.joining_date)}</strong>.</p>
<p>I confirm that I have read, understood and accepted the terms of my Appointment Letter and the Company's Policy Handbook. The particulars and documents furnished by me are true and correct to the best of my knowledge.</p>
<p>Thanking you,<br>Yours faithfully,</p>
<p><br>(<strong>${esc(emp.name)}</strong>)${emp.code ? '<br>Emp Code: ' + esc(emp.code) : ''}</p>
`,
    };
  },

  confirmation: (ctx) => {
    const { emp, company, today } = ctx;
    const conf = emp.confirmation_date || addMonths(emp.joining_date, emp.probation_months || 3);
    return {
      title: 'Confirmation of Employment',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>${esc(emp.name)}</strong> (${esc(emp.code || '')})<br>${esc(emp.designation || '')}${emp.department ? ', ' + esc(emp.department) : ''}</p>
<p><strong>Subject: Confirmation of Employment</strong></p>
<p>Dear ${esc(emp.name)},</p>
<p>We are pleased to inform you that, based on the satisfactory performance during your probation period, your services with ${esc(company.name)} stand <strong>confirmed</strong> with effect from <strong>${longDate(conf)}</strong>.</p>
<p>All other terms and conditions of your Appointment Letter remain unchanged. Post confirmation, the notice period applicable to either party is <strong>${emp.notice_period_days || 30} days</strong>.</p>
<p>We congratulate you on your confirmation and look forward to your continued contribution.</p>
<p>Yours sincerely,<br>For <strong>${esc(company.name)}</strong></p>
`,
    };
  },

  probation_extension: (ctx) => {
    const { emp, company, today } = ctx;
    return {
      title: 'Extension of Probation',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>${esc(emp.name)}</strong> (${esc(emp.code || '')})<br>${esc(emp.designation || '')}</p>
<p><strong>Subject: Extension of Probation Period</strong></p>
<p>Dear ${esc(emp.name)},</p>
<p>This is to inform you that your probation period is hereby <strong>extended by ____ months</strong> with effect from __________, to enable a further assessment of your performance and suitability for the role of ${esc(emp.designation || '____________')}.</p>
<p>During the extended probation, the terms applicable to the probation period in your Appointment Letter shall continue to apply. You are encouraged to improve on the areas discussed with you, on which feedback will be provided.</p>
<p>All other terms of your appointment remain unchanged.</p>
<p>Yours sincerely,<br>For <strong>${esc(company.name)}</strong></p>
`,
    };
  },

  increment: (ctx) => {
    const { emp, company, today } = ctx;
    const b = salaryBreakup(emp.base_salary);
    return {
      title: 'Salary Revision / Increment Letter',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>${esc(emp.name)}</strong> (${esc(emp.code || '')})<br>${esc(emp.designation || '')}${emp.department ? ', ' + esc(emp.department) : ''}</p>
<p><strong>Subject: Revision in Remuneration</strong></p>
<p>Dear ${esc(emp.name)},</p>
<p>In recognition of your performance and contribution, we are pleased to revise your remuneration with effect from <strong>__________</strong>. Your revised gross remuneration will be <strong>${fmtINR(b.gross)} per month</strong> (Annual ${fmtINR(b.annualCtc)}), structured as Basic ${fmtINR(b.basic)}, HRA ${fmtINR(b.hra)} and Special/Other Allowance ${fmtINR(b.special)}.</p>
<p>All other terms and conditions of your employment remain unchanged. We thank you for your efforts and look forward to your continued contribution.</p>
<p>Yours sincerely,<br>For <strong>${esc(company.name)}</strong></p>
`,
    };
  },

  warning: (ctx) => {
    const { emp, company, today } = ctx;
    return {
      title: 'Warning Letter',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>${esc(emp.name)}</strong> (${esc(emp.code || '')})<br>${esc(emp.designation || '')}${emp.department ? ', ' + esc(emp.department) : ''}</p>
<p><strong>Subject: Letter of Warning</strong></p>
<p>Dear ${esc(emp.name)},</p>
<p>It has been brought to our notice that <em>[describe the incident / conduct / shortfall, with date(s)]</em>. This conduct is unsatisfactory and amounts to a breach of the Company's Rules and the Policy Handbook.</p>
<p>You are hereby <strong>warned</strong> to refrain from such conduct in future and to improve forthwith. Please note that a repetition of this or any similar act will be viewed seriously and may attract further disciplinary action, up to and including termination of your services, without further notice.</p>
<p>You are advised to acknowledge receipt of this letter on the duplicate copy. You may submit a written explanation, if any, within three (3) days.</p>
<p>Yours sincerely,<br>For <strong>${esc(company.name)}</strong></p>
`,
    };
  },

  termination: (ctx) => {
    const { emp, company, today } = ctx;
    return {
      title: 'Termination Letter',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>${esc(emp.name)}</strong> (${esc(emp.code || '')})<br>${esc(emp.designation || '')}${emp.department ? ', ' + esc(emp.department) : ''}</p>
<p><strong>Subject: Termination of Employment</strong></p>
<p>Dear ${esc(emp.name)},</p>
<p>This is with reference to <em>[the warning letter(s) / show-cause notice dated ______ and your reply, OR the notice period clause of your Appointment Letter]</em>.</p>
<p>The Management has decided to <strong>terminate your services</strong> with ${esc(company.name)} with effect from the close of business on <strong>__________</strong>.</p>
<p>Your full and final settlement, comprising salary and statutory dues payable up to your last working day, less any amounts recoverable from you, will be released after you hand over all Company property, documents and pending work in your charge.</p>
<p>We thank you for your services and wish you well.</p>
<p>Yours sincerely,<br>For <strong>${esc(company.name)}</strong></p>
<p style="font-size:8.5pt; color:#777">Note: Where the employee is a "workman" under the Industrial Disputes Act, 1947, the procedure, notice and compensation requirements of that Act and applicable Standing Orders must be followed. Have this letter vetted before issue.</p>
`,
    };
  },

  resignation_acceptance: (ctx) => {
    const { emp, company, today } = ctx;
    return {
      title: 'Acceptance of Resignation & Relieving',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>${esc(emp.name)}</strong> (${esc(emp.code || '')})<br>${esc(emp.designation || '')}${emp.department ? ', ' + esc(emp.department) : ''}</p>
<p><strong>Subject: Acceptance of Resignation and Relieving</strong></p>
<p>Dear ${esc(emp.name)},</p>
<p>We acknowledge receipt of your resignation letter dated <strong>__________</strong>. The same is <strong>accepted</strong>, and you will be relieved from the services of ${esc(company.name)} at the close of business on <strong>__________</strong>, being your last working day.</p>
<p>You are requested to hand over complete charge of your work, along with all Company property, documents and records in your possession, to the person nominated by the Management. Your full and final settlement will be processed after the handover is completed.</p>
<p>We thank you for your services and contribution during your tenure with us, and wish you the very best in your future endeavours.</p>
<p>Yours sincerely,<br>For <strong>${esc(company.name)}</strong></p>
`,
    };
  },

  relieving: (ctx) => {
    const { emp, company, today } = ctx;
    return {
      title: 'Relieving Letter',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>TO WHOMSOEVER IT MAY CONCERN</strong></p>
<p>This is to certify that <strong>${esc(emp.name)}</strong>${emp.father_name ? ', S/o ' + esc(emp.father_name) : ''} (Emp Code: ${esc(emp.code || '____')}) was employed with ${esc(company.name)} as <strong>${esc(emp.designation || '____________')}</strong>${emp.department ? ' in the ' + esc(emp.department) + ' department' : ''} from <strong>${longDate(emp.joining_date)}</strong> to <strong>${longDate(emp.exit_date)}</strong>.</p>
<p>He/She has been relieved of his/her duties with effect from the close of business on ${longDate(emp.exit_date)}, and there are no dues or obligations pending against him/her as on the date of relieving.</p>
<p>We wish him/her success in all future endeavours.</p>
<p>For <strong>${esc(company.name)}</strong></p>
`,
    };
  },

  experience: (ctx) => {
    const { emp, company, today } = ctx;
    return {
      title: 'Experience / Service Certificate',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>EXPERIENCE CERTIFICATE</strong></p>
<p><strong>TO WHOMSOEVER IT MAY CONCERN</strong></p>
<p>This is to certify that <strong>${esc(emp.name)}</strong>${emp.father_name ? ', S/o ' + esc(emp.father_name) : ''} was associated with ${esc(company.name)} as <strong>${esc(emp.designation || '____________')}</strong>${emp.department ? ' in the ' + esc(emp.department) + ' department' : ''} from <strong>${longDate(emp.joining_date)}</strong> to <strong>${longDate(emp.exit_date)}</strong>.</p>
<p>During this tenure, we found him/her to be sincere, hardworking and of good moral character. His/her conduct and performance were found to be satisfactory.</p>
<p>We wish him/her all success in future.</p>
<p>For <strong>${esc(company.name)}</strong></p>
`,
    };
  },

  salary_certificate: (ctx) => {
    const { emp, company, today } = ctx;
    const b = salaryBreakup(emp.base_salary);
    return {
      title: 'Salary Certificate',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>SALARY CERTIFICATE</strong></p>
<p><strong>TO WHOMSOEVER IT MAY CONCERN</strong></p>
<p>This is to certify that <strong>${esc(emp.name)}</strong> (Emp Code: ${esc(emp.code || '____')}) is employed with ${esc(company.name)} as <strong>${esc(emp.designation || '____________')}</strong>${emp.department ? ', ' + esc(emp.department) : ''} since <strong>${longDate(emp.joining_date)}</strong>. His/her present remuneration is as under:</p>
<table style="width:100%; border-collapse:collapse; margin:6px 0; max-width:420px">
  <tr><td style="padding:3px 8px; border:1px solid #999">Basic Salary</td><td style="padding:3px 8px; border:1px solid #999; text-align:right">${fmtINR(b.basic)}</td></tr>
  <tr><td style="padding:3px 8px; border:1px solid #999">House Rent Allowance</td><td style="padding:3px 8px; border:1px solid #999; text-align:right">${fmtINR(b.hra)}</td></tr>
  <tr><td style="padding:3px 8px; border:1px solid #999">Special / Other Allowance</td><td style="padding:3px 8px; border:1px solid #999; text-align:right">${fmtINR(b.special)}</td></tr>
  <tr style="font-weight:700"><td style="padding:3px 8px; border:1px solid #999">Gross per month</td><td style="padding:3px 8px; border:1px solid #999; text-align:right">${fmtINR(b.gross)}</td></tr>
</table>
<p>Gross annual remuneration: <strong>${fmtINR(b.annualCtc)}</strong> (${amountInWordsINR(b.annualCtc)}).</p>
<p>This certificate is issued on the request of the employee for the purpose of __________________.</p>
<p>For <strong>${esc(company.name)}</strong></p>
`,
    };
  },
};

// Metadata for the picker, grouped by lifecycle stage.
const DOC_TYPES = [
  { key: 'offer',                 label: 'Offer Letter',                     group: 'Hiring' },
  { key: 'appointment',           label: 'Appointment Letter',               group: 'Hiring' },
  { key: 'joining',               label: 'Joining Report',                   group: 'Hiring' },
  { key: 'confirmation',          label: 'Confirmation Letter',              group: 'Probation' },
  { key: 'probation_extension',   label: 'Probation Extension',              group: 'Probation' },
  { key: 'increment',             label: 'Increment / Revision Letter',      group: 'Performance' },
  { key: 'warning',               label: 'Warning Letter',                   group: 'Performance' },
  { key: 'resignation_acceptance',label: 'Resignation Acceptance',           group: 'Exit' },
  { key: 'relieving',             label: 'Relieving Letter',                 group: 'Exit' },
  { key: 'experience',            label: 'Experience / Service Certificate', group: 'Exit' },
  { key: 'termination',           label: 'Termination Letter',               group: 'Exit' },
  { key: 'salary_certificate',    label: 'Salary Certificate',               group: 'On-demand' },
];

function labelFor(key) {
  const t = DOC_TYPES.find(d => d.key === key);
  return t ? t.label : key;
}

// Build a document body for an employee. Returns { title, html } or
// null if the type is unknown.
function buildDoc(docType, emp, company) {
  const builder = BUILDERS[docType];
  if (!builder) return null;
  const today = new Date().toISOString().slice(0, 10);
  return builder({ emp, company, today });
}

// ── Standard Policy Handbook (one document, all staff) ──────────
// Returned when seeding the company_policies table the first time.
function defaultHandbookHtml(company) {
  const c = esc(company.name || 'the Company');
  return `
<h3 style="text-align:center">EMPLOYEE POLICY HANDBOOK</h3>
<p style="text-align:center; font-size:9pt; color:#555">Applicable to all employees — workers, sales team and management — of ${c}</p>

<p><strong>1. Introduction &amp; Scope.</strong> This Handbook sets out the rules, policies and code of conduct applicable to all employees of ${c}, irrespective of grade or department. It forms part of your terms of employment. The Company may amend these policies from time to time; the latest version will prevail.</p>

<p><strong>2. Working Hours, Attendance &amp; Punctuality.</strong> Normal working hours and weekly-off will be as notified for your unit. Attendance is recorded through the biometric / register system. Habitual late-coming, absence without sanctioned leave, or leaving the workplace without permission is treated as misconduct. Wages for unauthorised absence are not payable.</p>

<p><strong>3. Leave.</strong> Leave (casual, sick, earned/privilege and statutory holidays) shall be as per applicable law and Company notification. Leave must be applied for and sanctioned in advance, except in genuine emergencies, which must be intimated at the earliest. Un-sanctioned absence will be treated as leave without pay.</p>

<p><strong>4. Salary &amp; Statutory Benefits.</strong> Salary is paid monthly by bank transfer / as notified. Statutory deductions and benefits (Provident Fund, ESI, Bonus, Gratuity, Professional Tax, TDS) apply as per law and the Company's registration. Pay slips are issued each month.</p>

<p><strong>5. Code of Conduct.</strong> Every employee shall: (a) perform duties honestly and diligently; (b) maintain discipline and behave courteously with colleagues, customers and suppliers; (c) safeguard Company property and materials; (d) not accept or demand any illegal gratification, bribe or commission; (e) not consume alcohol or prohibited substances on Company premises; and (f) not engage in any act of dishonesty, theft, fraud, fighting, or wilful damage.</p>

<p><strong>6. Confidentiality &amp; Company Property.</strong> Designs, patterns, costing, customer and supplier lists, pricing and all business information are confidential and the property of ${c}. They must not be shared, copied or used for personal benefit, during or after employment. All tools, materials, samples and documents must be returned on separation.</p>

<p><strong>7. Quality &amp; Safety.</strong> Employees must follow quality standards and standard operating procedures, wear any prescribed protective equipment, keep the workplace clean and safe, and immediately report accidents, hazards or damaged machinery to the supervisor.</p>

<p><strong>8. Anti-Harassment (POSH).</strong> ${c} is committed to a workplace free of sexual harassment, in line with the Sexual Harassment of Women at Workplace (Prevention, Prohibition and Redressal) Act, 2013. Any complaint may be made to the Internal Committee / the Management and will be enquired into confidentially. Retaliation against a complainant is itself misconduct.</p>

<p><strong>9. Anti-Discrimination &amp; Equal Treatment.</strong> Recruitment, remuneration and advancement are based on merit and role requirements, without discrimination on the basis of religion, caste, sex or place of birth. Equal remuneration for the same work is maintained as per law.</p>

<p><strong>10. Use of IT, Phones &amp; Social Media.</strong> Company systems, internet and devices are for business use. Employees must not post confidential or defamatory content about the Company, its customers or colleagues on social media.</p>

<p><strong>11. Field Staff &amp; Travel (Sales Team).</strong> Field employees must record visits and attendance through the prescribed app/biometric, follow assigned routes, deposit collections promptly, and submit travel/mileage claims accurately with supporting evidence. Misreporting of visits, GPS or expenses is treated as misconduct.</p>

<p><strong>12. Disciplinary Procedure.</strong> Misconduct may attract counselling, warning, suspension, or termination depending on gravity. Save in cases warranting immediate action, the employee will ordinarily be given an opportunity to explain before action is taken.</p>

<p><strong>13. Separation.</strong> Resignation, notice period and full-and-final settlement will be as per your Appointment Letter and applicable law. All Company property must be returned before settlement.</p>

<p><strong>14. Acknowledgment.</strong> I confirm that I have received, read and understood this Policy Handbook, and I agree to abide by it as a condition of my employment with ${c}.</p>

<table style="width:100%; margin-top:34px; font-size:9.5pt">
  <tr>
    <td style="width:55%">
      Name: ______________________________<br><br>
      Emp Code: __________________________<br><br>
      Signature: _________________________<br><br>
      Date: ______________________________
    </td>
    <td style="width:45%; text-align:center; vertical-align:bottom">
      <div style="border-top:1px solid #000; padding-top:4px; width:200px; margin-left:auto">For ${c}<br><span style="font-size:8pt; color:#555">Authorised Signatory</span></div>
    </td>
  </tr>
</table>
`;
}

module.exports = { DOC_TYPES, BUILDERS, buildDoc, labelFor, salaryBreakup, defaultHandbookHtml, longDate };
