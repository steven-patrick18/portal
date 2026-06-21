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

// Parse an employee's optional custom salary components.
// Accepts the JSON string stored on employees.salary_components, or an
// already-parsed array. Returns a clean [{name, amount}] (positive,
// named) or [] if none usable.
function parseComponents(emp) {
  let raw = emp && emp.salary_components;
  if (!raw) return [];
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (_) { return []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map(r => ({ name: String(r.name || '').trim(), amount: Number(r.amount) || 0 }))
    .filter(r => r.name && r.amount > 0);
}

// Salary breakup. If `components` (or emp.salary_components) are given,
// the breakup is built from those exact rows and the gross is their sum
// — "add more columns if needed". Otherwise the standard non-metro
// split is auto-calculated from the monthly gross:
//   Basic = 50% of gross · HRA = 40% of Basic · Special = remainder.
// PF/ESI are shown as notes elsewhere, not deducted here.
function salaryBreakup(monthlyGross, components) {
  const comps = Array.isArray(components) ? components.filter(c => c && c.name && Number(c.amount) > 0) : [];
  if (comps.length) {
    const rows = comps.map(c => ({ name: c.name, amount: Math.round(Number(c.amount)) }));
    const gross = rows.reduce((s, r) => s + r.amount, 0);
    return { custom: true, rows, gross, annualCtc: gross * 12 };
  }
  const gross = Number(monthlyGross) || 0;
  const basic = Math.round(gross * 0.50);
  const hra   = Math.round(basic * 0.40);
  const special = Math.max(0, gross - basic - hra);
  return {
    custom: false,
    rows: [
      { name: 'Basic Salary', amount: basic },
      { name: 'House Rent Allowance', amount: hra },
      { name: 'Special / Other Allowance', amount: special },
    ],
    gross, basic, hra, special,
    annualCtc: gross * 12,
  };
}

// Render a breakup's rows as table body <tr>s (Component | /month | /annum).
function breakupRows(b) {
  return b.rows.map(r =>
    `<tr><td style="padding:3px 8px; border:1px solid #999">${esc(r.name)}</td>` +
    `<td style="padding:3px 8px; border:1px solid #999; text-align:right">${r.amount.toLocaleString('en-IN')}</td>` +
    `<td style="padding:3px 8px; border:1px solid #999; text-align:right">${(r.amount * 12).toLocaleString('en-IN')}</td></tr>`
  ).join('');
}

// Inline "Basic ₹X, HRA ₹Y, …" summary — works for custom or auto rows.
function breakupInline(b) {
  return b.rows.map(r => `${esc(r.name)} ${fmtINR(r.amount)}`).join(', ');
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
    const b = salaryBreakup(emp.base_salary, parseComponents(emp));
    return {
      title: 'Offer of Employment',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>${esc(emp.name)}</strong>${emp.father_name ? '<br>S/o ' + esc(emp.father_name) : ''}<br>${esc(emp.address || '')}</p>
<p><strong>Subject: Letter of Offer for the position of ${esc(emp.designation || 'the position offered')}</strong></p>
<p>Dear ${esc(emp.name)},</p>
<p>With reference to your application and the selection process / interview conducted, we are pleased to offer you employment with <strong>${esc(company.name)}</strong> (hereinafter "the Company") on the following principal terms. This is a conditional offer; the detailed Letter of Appointment, setting out the complete terms and conditions, will be issued to you on the date you report for duty.</p>

<table style="width:100%; border-collapse:collapse; margin:8px 0; font-size:10.5pt">
  <tr><td style="padding:4px 8px; border:1px solid #999; width:42%">Position / Designation</td><td style="padding:4px 8px; border:1px solid #999">${esc(emp.designation || '____________')}</td></tr>
  <tr><td style="padding:4px 8px; border:1px solid #999">Department</td><td style="padding:4px 8px; border:1px solid #999">${esc(emp.department || '____________')}</td></tr>
  <tr><td style="padding:4px 8px; border:1px solid #999">Place of posting</td><td style="padding:4px 8px; border:1px solid #999">${esc(company.address || company.name)}</td></tr>
  <tr><td style="padding:4px 8px; border:1px solid #999">Reporting to</td><td style="padding:4px 8px; border:1px solid #999">${esc(emp.reporting_to || 'the Management')}</td></tr>
  <tr><td style="padding:4px 8px; border:1px solid #999">Proposed date of joining</td><td style="padding:4px 8px; border:1px solid #999">${longDate(emp.joining_date)}</td></tr>
  <tr><td style="padding:4px 8px; border:1px solid #999">Gross monthly remuneration</td><td style="padding:4px 8px; border:1px solid #999">${fmtINR(b.gross)} per month</td></tr>
  <tr><td style="padding:4px 8px; border:1px solid #999">Cost to Company (annual)</td><td style="padding:4px 8px; border:1px solid #999">${fmtINR(b.annualCtc)} (${amountInWordsINR(b.annualCtc)})</td></tr>
  <tr><td style="padding:4px 8px; border:1px solid #999">Probation period</td><td style="padding:4px 8px; border:1px solid #999">${emp.probation_months || 3} months from the date of joining</td></tr>
</table>

<p><strong>1. Conditions of this offer.</strong> This offer of employment is subject to, and conditional upon: (a) satisfactory verification of the certificates, testimonials, identity and address proofs, and previous-employment / character references submitted by you; (b) your being found medically fit for the duties of the position; (c) there being no subsisting contract, bond or restriction that prevents you from accepting this employment; and (d) your acceptance of the Company's standard terms of appointment and its Policy Handbook. If any information furnished by you is later found to be false or material facts are found suppressed, this offer (or the resulting employment) is liable to be withdrawn / terminated without notice or compensation.</p>

<p><strong>2. Documents to be produced on joining.</strong> You are requested to bring, in original and self-attested photocopies, the following on the date of joining: proof of date of birth, educational and experience certificates, relieving / experience letter from your previous employer (if any), Aadhaar and PAN, bank account details (cancelled cheque / passbook), recent passport-size photographs, and details for Provident Fund / ESI as applicable.</p>

<p><strong>3. Remuneration structure (indicative).</strong> Your gross remuneration of ${fmtINR(b.gross)} per month will be structured broadly as ${breakupInline(b)}, and will be subject to statutory deductions and benefits (Provident Fund, ESI, Professional Tax, TDS, Bonus, Gratuity) as applicable. The final structure will be set out in your Appointment Letter.</p>

<p><strong>4. Probation &amp; confirmation.</strong> You will be on probation for ${emp.probation_months || 3} months, extendable at the Company's discretion. Confirmation of your services will be communicated in writing upon satisfactory completion of probation.</p>

<p><strong>5. Validity &amp; acceptance.</strong> Kindly convey your acceptance by signing and returning the duplicate copy of this letter within <strong>seven (7) days</strong> from the date hereof and by reporting for duty on or before the proposed date of joining. Unless so accepted, this offer shall stand automatically withdrawn. The Company reserves the right to revise the date of joining or to withdraw this offer at any time before you join, without assigning any reason.</p>

<p>We are confident that you will find your association with ${esc(company.name)} professionally rewarding, and we look forward to welcoming you to our team.</p>
<p>Yours sincerely,<br>For <strong>${esc(company.name)}</strong></p>

<p style="margin-top:26px"><strong>Acceptance:</strong> I, ${esc(emp.name)}, have read and understood the above terms and I accept this offer of employment. I shall report for duty on ____________.</p>
<p>Signature: ________________________&nbsp;&nbsp;&nbsp;&nbsp;Date: ____________</p>
`,
    };
  },

  appointment: (ctx) => {
    const { emp, company, today } = ctx;
    const b = salaryBreakup(emp.base_salary, parseComponents(emp));
    return {
      title: 'Letter of Appointment',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>${esc(emp.name)}</strong>${emp.father_name ? '<br>S/o ' + esc(emp.father_name) : ''}<br>${esc(emp.address || '')}</p>
<p><strong>Subject: Letter of Appointment</strong></p>
<p>Dear ${esc(emp.name)},</p>
<p>With reference to your application and the interview / selection process, we are pleased to appoint you in the services of <strong>${esc(company.name)}</strong> (hereinafter referred to as "the Company") as <strong>${esc(emp.designation || '____________')}</strong>${emp.department ? ' in the ' + esc(emp.department) + ' department' : ''}, with effect from <strong>${longDate(emp.joining_date)}</strong>, on the following terms and conditions:</p>

<p><strong>1. Appointment &amp; Reporting.</strong> You are appointed to the post of ${esc(emp.designation || '____________')} and will ordinarily report to ${esc(emp.reporting_to || 'the Management / your reporting officer')}. You shall diligently and faithfully perform the duties assigned to you and such other duties as may be entrusted to you from time to time, commensurate with your position, and shall comply with all lawful instructions of your superiors.</p>

<p><strong>2. Place of Work, Transfer &amp; Deputation.</strong> Your present place of posting is at ${esc(company.address || company.name)}. However, the Company may, at its sole discretion, transfer or depute you to any of its departments, units, factories, branches, depots or associated / group establishments, whether existing now or set up in future, anywhere in India, on the same terms or on the terms then applicable at the place of transfer. On transfer, you will be governed by the rules, regulations and timings applicable at the new location.</p>

<p><strong>3. Remuneration.</strong> Your remuneration shall be as per the structure set out in the Annexure to this letter (Annexure&nbsp;A — Compensation Structure), summarised as a gross of <strong>${fmtINR(b.gross)} per month</strong> (Cost to Company ${fmtINR(b.annualCtc)} per annum). Your salary is personal and confidential to you, and you shall not disclose it to any other employee or third party.</p>

<p><strong>4. Statutory Deductions &amp; Benefits.</strong> Your remuneration is subject to deduction of Income Tax (TDS), Provident Fund (employee contribution), Employees' State Insurance (where applicable), Professional Tax and any other statutory dues, and to such other deductions as may be authorised by law or by you. You will be entitled to statutory benefits such as Bonus (under the Payment of Bonus Act, 1965), Gratuity (under the Payment of Gratuity Act, 1972, on completion of the qualifying period), Provident Fund and ESI, in accordance with the applicable laws and the Company's registration status.</p>

<p><strong>5. Probation.</strong> You will be on probation for a period of <strong>${emp.probation_months || 3} months</strong> from your date of joining. The Company may, at its discretion, extend the probation period by a further period by notice in writing. During the period of probation (including any extension), your services may be terminated by either party by giving seven (7) days' notice or salary in lieu thereof, without assigning any reason. You shall be deemed to continue on probation until confirmed in writing.</p>

<p><strong>6. Confirmation.</strong> On satisfactory completion of the probation period, your services will be confirmed by a letter in writing. Mere continuance in service beyond the probation period shall not, by itself, be construed as confirmation.</p>

<p><strong>7. Notice Period &amp; Termination.</strong> After confirmation, this employment may be terminated by either party by giving <strong>${emp.notice_period_days || 30} days'</strong> notice in writing, or payment / forfeiture of salary in lieu of the notice period. Notwithstanding the above, the Company may terminate your services forthwith, without notice or salary in lieu, in the event of misconduct, breach of the terms hereof, breach of the Company's rules / Standing Orders, or unsatisfactory performance. The Company also reserves the right not to accept the notice and to relieve you earlier.</p>

<p><strong>8. Working Hours &amp; Attendance.</strong> You will observe the working hours, shift schedule, weekly-off and holiday list notified by the Company / the establishment from time to time, and will mark your attendance through the prescribed system. You may be required to work beyond the normal hours and on holidays as per the exigencies of work, in accordance with applicable law.</p>

<p><strong>9. Duties of Good Faith &amp; Exclusivity.</strong> You shall devote your whole time and attention to the business of the Company and shall not, during the period of your employment, engage or be interested, directly or indirectly, in any other trade, business, profession or employment, whether for remuneration or otherwise, without the prior written permission of the Company.</p>

<p><strong>10. Confidentiality &amp; Intellectual Property.</strong> During and after your employment, you shall keep strictly confidential and shall not disclose or use, except for the Company's business, any trade secrets or confidential information of the Company, including designs, patterns, samples, costing, pricing, processes, supplier and buyer lists, and business plans. All work product, designs and developments made by you in the course of employment shall be the exclusive property of the Company.</p>

<p><strong>11. Company Property &amp; Materials.</strong> All tools, equipment, materials, samples, documents and other property of the Company entrusted to you shall be maintained with due care and returned on demand or on cessation of employment. The Company may recover the value of any loss or damage caused by your negligence or default from your dues.</p>

<p><strong>12. Conduct, Rules &amp; Policy Handbook.</strong> You shall abide by the Company's Rules, Standing Orders / Service Rules and the Employee Policy Handbook (including the Code of Conduct, the Health &amp; Safety rules, and the Policy on Prevention of Sexual Harassment), as in force and as amended from time to time, which shall be deemed to form part of these terms. Any act of misconduct shall render you liable to disciplinary action up to and including dismissal, in accordance with the said rules and applicable law.</p>

<p><strong>13. Medical Fitness.</strong> Your appointment and continuance in service are subject to your being and remaining medically fit for your duties. The Company may require you to undergo medical examination by a medical practitioner nominated by it.</p>

<p><strong>14. Verification of Particulars.</strong> This appointment is based on the particulars and documents furnished by you. If, at any time, any such particular is found to be false or any material information is found to have been suppressed, your services are liable to be terminated forthwith without notice or compensation, without prejudice to any other action.</p>

<p><strong>15. Retirement.</strong> You shall retire from the services of the Company on attaining the age of <strong>58 years</strong>, unless your service is extended in writing by the Company at its discretion.</p>

<p><strong>16. Governing Law &amp; Jurisdiction.</strong> This appointment and your employment shall be governed by the laws of India. The courts having jurisdiction over the place of your posting shall have exclusive jurisdiction in respect of any dispute arising out of or in connection with your employment.</p>

<p>Please signify your acceptance of the above terms and conditions by signing and returning the duplicate copy of this letter and the Annexure. We welcome you to <strong>${esc(company.name)}</strong> and wish you a long, productive and mutually rewarding association.</p>
<p>Yours sincerely,<br>For <strong>${esc(company.name)}</strong></p>

<p style="margin-top:22px"><strong>Acceptance:</strong> I have read, understood and accept the terms and conditions of this Letter of Appointment and the Annexure, and the Company's Policy Handbook, and I agree to be bound by them.</p>
<p>Signature: ________________________&nbsp;&nbsp;&nbsp;&nbsp;Name: ${esc(emp.name)}&nbsp;&nbsp;&nbsp;&nbsp;Date: ____________</p>

<div style="page-break-before:always; margin-top:18px">
  <h4 style="text-align:center; text-decoration:underline">ANNEXURE A — COMPENSATION STRUCTURE</h4>
  <p style="font-size:10pt">Employee: <strong>${esc(emp.name)}</strong>${emp.code ? ' (' + esc(emp.code) + ')' : ''} · Designation: ${esc(emp.designation || '____________')} · Effective: ${longDate(emp.joining_date)}</p>
  <table style="width:100%; border-collapse:collapse; margin:6px 0">
    <thead><tr>
      <th style="padding:4px 8px; border:1px solid #999; text-align:left; background:#f2f2f2">Component</th>
      <th style="padding:4px 8px; border:1px solid #999; text-align:right; background:#f2f2f2">Per Month (₹)</th>
      <th style="padding:4px 8px; border:1px solid #999; text-align:right; background:#f2f2f2">Per Annum (₹)</th>
    </tr></thead>
    <tbody>
      ${breakupRows(b)}
      <tr style="font-weight:700"><td style="padding:3px 8px; border:1px solid #999">Gross Total</td><td style="padding:3px 8px; border:1px solid #999; text-align:right">${b.gross.toLocaleString('en-IN')}</td><td style="padding:3px 8px; border:1px solid #999; text-align:right">${b.annualCtc.toLocaleString('en-IN')}</td></tr>
    </tbody>
  </table>
  <p style="font-size:9pt; color:#555">Note: The above is the gross compensation. Statutory deductions (PF, ESI, Professional Tax, TDS) and statutory benefits (Bonus, Gratuity) apply as per law and the Company's registration status and will be reflected in your monthly pay slip. The Company may revise the structure to comply with statutory requirements without reducing the gross.</p>
</div>
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
    const b = salaryBreakup(emp.base_salary, parseComponents(emp));
    return {
      title: 'Salary Revision / Increment Letter',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>${esc(emp.name)}</strong> (${esc(emp.code || '')})<br>${esc(emp.designation || '')}${emp.department ? ', ' + esc(emp.department) : ''}</p>
<p><strong>Subject: Revision in Remuneration</strong></p>
<p>Dear ${esc(emp.name)},</p>
<p>In recognition of your performance and contribution, we are pleased to revise your remuneration with effect from <strong>__________</strong>. Your revised gross remuneration will be <strong>${fmtINR(b.gross)} per month</strong> (Annual ${fmtINR(b.annualCtc)}), structured as ${breakupInline(b)}.</p>
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
    const b = salaryBreakup(emp.base_salary, parseComponents(emp));
    return {
      title: 'Salary Certificate',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>SALARY CERTIFICATE</strong></p>
<p><strong>TO WHOMSOEVER IT MAY CONCERN</strong></p>
<p>This is to certify that <strong>${esc(emp.name)}</strong> (Emp Code: ${esc(emp.code || '____')}) is employed with ${esc(company.name)} as <strong>${esc(emp.designation || '____________')}</strong>${emp.department ? ', ' + esc(emp.department) : ''} since <strong>${longDate(emp.joining_date)}</strong>. His/her present remuneration is as under:</p>
<table style="width:100%; border-collapse:collapse; margin:6px 0; max-width:420px">
  ${b.rows.map(r => `<tr><td style="padding:3px 8px; border:1px solid #999">${esc(r.name)}</td><td style="padding:3px 8px; border:1px solid #999; text-align:right">${fmtINR(r.amount)}</td></tr>`).join('')}
  <tr style="font-weight:700"><td style="padding:3px 8px; border:1px solid #999">Gross per month</td><td style="padding:3px 8px; border:1px solid #999; text-align:right">${fmtINR(b.gross)}</td></tr>
</table>
<p>Gross annual remuneration: <strong>${fmtINR(b.annualCtc)}</strong> (${amountInWordsINR(b.annualCtc)}).</p>
<p>This certificate is issued on the request of the employee for the purpose of __________________.</p>
<p>For <strong>${esc(company.name)}</strong></p>
`,
    };
  },

  // ── Phase 2 ──────────────────────────────────────────────────
  promotion: (ctx) => {
    const { emp, company, today } = ctx;
    const b = salaryBreakup(emp.base_salary, parseComponents(emp));
    return {
      title: 'Promotion Letter',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>${esc(emp.name)}</strong> (${esc(emp.code || '')})<br>${esc(emp.designation || '')}${emp.department ? ', ' + esc(emp.department) : ''}</p>
<p><strong>Subject: Promotion &amp; Re-designation</strong></p>
<p>Dear ${esc(emp.name)},</p>
<p>In recognition of your performance, commitment and the contribution you have made to ${esc(company.name)}, we are pleased to <strong>promote you to the position of ____________________</strong> with effect from <strong>__________</strong>.</p>
<p>Consequent to this promotion, your revised gross remuneration will be <strong>${fmtINR(b.gross)} per month</strong> (Annual ${fmtINR(b.annualCtc)}), with effect from the said date. In your new role you will report to ${esc(emp.reporting_to || 'the Management')} and will be responsible for the duties and deliverables that will be communicated to you separately.</p>
<p>All other terms and conditions of your employment, as set out in your Letter of Appointment and the Policy Handbook, remain unchanged and continue to apply. We congratulate you and are confident that you will carry the additional responsibilities with the same dedication.</p>
<p>Yours sincerely,<br>For <strong>${esc(company.name)}</strong></p>
`,
    };
  },

  transfer: (ctx) => {
    const { emp, company, today } = ctx;
    return {
      title: 'Transfer Letter',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>${esc(emp.name)}</strong> (${esc(emp.code || '')})<br>${esc(emp.designation || '')}${emp.department ? ', ' + esc(emp.department) : ''}</p>
<p><strong>Subject: Transfer / Deputation</strong></p>
<p>Dear ${esc(emp.name)},</p>
<p>In exercise of the Company's rights under your Letter of Appointment, and in the interest of work, you are hereby <strong>transferred / deputed from ${esc(company.address || 'the present unit')} to ____________________</strong> with effect from <strong>__________</strong>.</p>
<p>On transfer, you will report to ____________________ and will be governed by the working hours, rules and timings applicable at the new location. Your terms of employment otherwise remain unchanged, save for such location-linked allowances (if any) as may be notified to you.</p>
<p>You are requested to complete the handover of your present charge and report at the new location on or before the effective date. Please acknowledge receipt of this letter.</p>
<p>Yours sincerely,<br>For <strong>${esc(company.name)}</strong></p>
`,
    };
  },

  performance_appraisal: (ctx) => {
    const { emp, company, today } = ctx;
    return {
      title: 'Performance Appraisal Letter',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>${esc(emp.name)}</strong> (${esc(emp.code || '')})<br>${esc(emp.designation || '')}${emp.department ? ', ' + esc(emp.department) : ''}</p>
<p><strong>Subject: Annual Performance Appraisal — Period __________ to __________</strong></p>
<p>Dear ${esc(emp.name)},</p>
<p>As part of the Company's annual performance management process, your performance for the above period has been reviewed against your key responsibilities and agreed objectives. A summary of the assessment is set out below.</p>
<table style="width:100%; border-collapse:collapse; margin:6px 0">
  <thead><tr>
    <th style="padding:4px 8px; border:1px solid #999; text-align:left; background:#f2f2f2">Area of Assessment</th>
    <th style="padding:4px 8px; border:1px solid #999; text-align:center; background:#f2f2f2; width:22%">Rating</th>
    <th style="padding:4px 8px; border:1px solid #999; text-align:left; background:#f2f2f2">Remarks</th>
  </tr></thead>
  <tbody>
    <tr><td style="padding:6px 8px; border:1px solid #999">Quality &amp; output of work</td><td style="padding:6px 8px; border:1px solid #999"></td><td style="padding:6px 8px; border:1px solid #999"></td></tr>
    <tr><td style="padding:6px 8px; border:1px solid #999">Attendance &amp; discipline</td><td style="padding:6px 8px; border:1px solid #999"></td><td style="padding:6px 8px; border:1px solid #999"></td></tr>
    <tr><td style="padding:6px 8px; border:1px solid #999">Skill &amp; knowledge</td><td style="padding:6px 8px; border:1px solid #999"></td><td style="padding:6px 8px; border:1px solid #999"></td></tr>
    <tr><td style="padding:6px 8px; border:1px solid #999">Teamwork &amp; conduct</td><td style="padding:6px 8px; border:1px solid #999"></td><td style="padding:6px 8px; border:1px solid #999"></td></tr>
    <tr><td style="padding:6px 8px; border:1px solid #999"><strong>Overall</strong></td><td style="padding:6px 8px; border:1px solid #999"></td><td style="padding:6px 8px; border:1px solid #999"></td></tr>
  </tbody>
</table>
<p><strong>Strengths:</strong> ____________________________________________</p>
<p><strong>Areas for improvement:</strong> ________________________________</p>
<p><strong>Goals for next period:</strong> __________________________________</p>
<p>Based on this appraisal, the management has decided: ☐ Increment&nbsp;&nbsp; ☐ Promotion&nbsp;&nbsp; ☐ Status quo&nbsp;&nbsp; ☐ Performance Improvement Plan. The financial revision, if any, will be communicated through a separate letter.</p>
<p>We thank you for your contribution and look forward to your continued growth with ${esc(company.name)}.</p>
<table style="width:100%; margin-top:30px; font-size:9.5pt"><tr>
  <td style="width:33%; text-align:center"><div style="border-top:1px solid #000; padding-top:4px">Employee</div></td>
  <td style="width:33%; text-align:center"><div style="border-top:1px solid #000; padding-top:4px">Appraiser / Reporting Officer</div></td>
  <td style="width:33%; text-align:center"><div style="border-top:1px solid #000; padding-top:4px">Management</div></td>
</tr></table>
`,
    };
  },

  pip: (ctx) => {
    const { emp, company, today } = ctx;
    return {
      title: 'Performance Improvement Plan (PIP)',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>${esc(emp.name)}</strong> (${esc(emp.code || '')})<br>${esc(emp.designation || '')}${emp.department ? ', ' + esc(emp.department) : ''}</p>
<p><strong>Subject: Performance Improvement Plan</strong></p>
<p>Dear ${esc(emp.name)},</p>
<p>This is further to the feedback given to you regarding shortfalls in your performance / conduct, specifically: <em>[describe the gaps — e.g. quality rejections, targets not met, attendance, etc.]</em>. To support you in meeting the expected standards, you are being placed on a <strong>Performance Improvement Plan (PIP)</strong> for a period of <strong>____ days/weeks</strong>, commencing <strong>__________</strong>.</p>
<p>During this period you are expected to achieve the following measurable objectives:</p>
<table style="width:100%; border-collapse:collapse; margin:6px 0">
  <thead><tr>
    <th style="padding:4px 8px; border:1px solid #999; text-align:left; background:#f2f2f2">Objective / Expected Standard</th>
    <th style="padding:4px 8px; border:1px solid #999; text-align:left; background:#f2f2f2; width:26%">Measure / Target</th>
    <th style="padding:4px 8px; border:1px solid #999; text-align:left; background:#f2f2f2; width:20%">Review Date</th>
  </tr></thead>
  <tbody>
    <tr><td style="padding:8px; border:1px solid #999">1. </td><td style="padding:8px; border:1px solid #999"></td><td style="padding:8px; border:1px solid #999"></td></tr>
    <tr><td style="padding:8px; border:1px solid #999">2. </td><td style="padding:8px; border:1px solid #999"></td><td style="padding:8px; border:1px solid #999"></td></tr>
    <tr><td style="padding:8px; border:1px solid #999">3. </td><td style="padding:8px; border:1px solid #999"></td><td style="padding:8px; border:1px solid #999"></td></tr>
  </tbody>
</table>
<p>Your progress will be reviewed periodically with your reporting officer, and necessary support / guidance will be provided. Please note that failure to demonstrate sustained improvement to the required standard within the PIP period may lead to further action, including extension of the plan, re-assignment, or termination of your services in accordance with your Appointment Letter and the Company's rules.</p>
<p>We are confident that, with focused effort, you will be able to meet the expectations. Please acknowledge receipt of this letter.</p>
<p>Yours sincerely,<br>For <strong>${esc(company.name)}</strong></p>
`,
    };
  },

  show_cause: (ctx) => {
    const { emp, company, today } = ctx;
    return {
      title: 'Show-Cause Notice',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>${esc(emp.name)}</strong> (${esc(emp.code || '')})<br>${esc(emp.designation || '')}${emp.department ? ', ' + esc(emp.department) : ''}</p>
<p><strong>Subject: Show-Cause Notice</strong></p>
<p>Dear ${esc(emp.name)},</p>
<p>It has been reported / observed that on <strong>__________</strong> at about ______, you <em>[state the alleged act / omission in clear factual detail, with date, time and place]</em>.</p>
<p>The aforesaid act, if established, amounts to <strong>misconduct</strong> under the Company's Standing Orders / Service Rules and the Policy Handbook, and is prejudicial to the discipline and interest of the Company.</p>
<p>You are hereby called upon to <strong>show cause in writing within ____ (____) days</strong> of receipt of this notice as to why disciplinary action should not be taken against you for the said misconduct. Your explanation, if any, should reach the undersigned within the stipulated time.</p>
<p>Should you fail to submit your explanation within the said period, or should your explanation be found unsatisfactory, the Company shall be constrained to proceed further in the matter in accordance with its rules and applicable law, which may include the holding of a domestic enquiry. This notice is issued without prejudice to the rights of the Company.</p>
<p>Please acknowledge receipt of this notice on the duplicate copy.</p>
<p>For <strong>${esc(company.name)}</strong></p>
`,
    };
  },

  suspension: (ctx) => {
    const { emp, company, today } = ctx;
    return {
      title: 'Suspension Pending Enquiry',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>${esc(emp.name)}</strong> (${esc(emp.code || '')})<br>${esc(emp.designation || '')}${emp.department ? ', ' + esc(emp.department) : ''}</p>
<p><strong>Subject: Order of Suspension Pending Enquiry</strong></p>
<p>Dear ${esc(emp.name)},</p>
<p>Whereas certain acts of misconduct alleged against you are proposed to be / are being enquired into, and whereas it is considered necessary in the interest of discipline and a fair enquiry that you should not remain on active duty during the pendency of the proceedings;</p>
<p>Now, therefore, you are hereby placed under <strong>suspension with effect from __________</strong>, pending enquiry into the said charges. During the period of suspension, you will be paid a subsistence allowance as per applicable law / Standing Orders.</p>
<p>During the suspension period you shall: (a) not enter the Company premises except with the written permission of the undersigned or to attend the enquiry; (b) be available and present yourself for the enquiry as and when required; and (c) not leave the station without prior written permission. This order of suspension is not a punishment and is without prejudice to the rights of the Company.</p>
<p>Please acknowledge receipt.</p>
<p>For <strong>${esc(company.name)}</strong></p>
`,
    };
  },

  charge_sheet: (ctx) => {
    const { emp, company, today } = ctx;
    return {
      title: 'Charge-Sheet (Articles of Charge)',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>${esc(emp.name)}</strong> (${esc(emp.code || '')})<br>${esc(emp.designation || '')}${emp.department ? ', ' + esc(emp.department) : ''}</p>
<p><strong>Subject: Charge-Sheet</strong></p>
<p>Dear ${esc(emp.name)},</p>
<p>You are hereby charged with the following act(s) of misconduct:</p>
<p style="margin-left:18px"><strong>Article of Charge:</strong> That you, on <strong>__________</strong> at ______, while on duty as ${esc(emp.designation || '____________')}, <em>[set out the charge precisely]</em>.</p>
<p>The above act(s), if proved, constitute misconduct under Clause ____ of the Company's Standing Orders / Service Rules read with the Policy Handbook.</p>
<p>You are required to submit your written statement of defence within <strong>____ (____) days</strong> of receipt of this charge-sheet, stating whether you admit or deny the charge and whether you desire to be heard in person. If you fail to submit your defence within the stipulated time, it shall be presumed that you have no explanation to offer and the matter will be decided ex-parte / a domestic enquiry will be held to ascertain the truth of the charge, in accordance with the principles of natural justice.</p>
<p>A domestic enquiry, if held, will be intimated to you separately with the name of the Enquiry Officer, the date, time and venue. You will be entitled to defend yourself, to examine and cross-examine witnesses, and to be represented as permitted by the Standing Orders.</p>
<p>This charge-sheet is issued without prejudice to the Company's rights.</p>
<p>For <strong>${esc(company.name)}</strong></p>
`,
    };
  },

  full_final: (ctx) => {
    const { emp, company, today } = ctx;
    const b = salaryBreakup(emp.base_salary, parseComponents(emp));
    return {
      title: 'Full & Final Settlement Statement',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>Full &amp; Final Settlement</strong></p>
<p>Employee: <strong>${esc(emp.name)}</strong> (${esc(emp.code || '')}) · ${esc(emp.designation || '')}${emp.department ? ', ' + esc(emp.department) : ''}<br>
Date of joining: ${longDate(emp.joining_date)} · Last working day: ${longDate(emp.exit_date)}</p>
<table style="width:100%; border-collapse:collapse; margin:8px 0">
  <thead><tr><th style="padding:4px 8px; border:1px solid #999; text-align:left; background:#f2f2f2">Earnings / Payable</th><th style="padding:4px 8px; border:1px solid #999; text-align:right; background:#f2f2f2; width:22%">Amount (₹)</th></tr></thead>
  <tbody>
    <tr><td style="padding:4px 8px; border:1px solid #999">Salary for ____ days of __________</td><td style="padding:4px 8px; border:1px solid #999"></td></tr>
    <tr><td style="padding:4px 8px; border:1px solid #999">Leave encashment (____ days)</td><td style="padding:4px 8px; border:1px solid #999"></td></tr>
    <tr><td style="padding:4px 8px; border:1px solid #999">Bonus / statutory dues</td><td style="padding:4px 8px; border:1px solid #999"></td></tr>
    <tr><td style="padding:4px 8px; border:1px solid #999">Gratuity (if eligible)</td><td style="padding:4px 8px; border:1px solid #999"></td></tr>
    <tr><td style="padding:4px 8px; border:1px solid #999">Other (specify)</td><td style="padding:4px 8px; border:1px solid #999"></td></tr>
    <tr style="font-weight:700"><td style="padding:4px 8px; border:1px solid #999">Total Payable (A)</td><td style="padding:4px 8px; border:1px solid #999"></td></tr>
  </tbody>
</table>
<table style="width:100%; border-collapse:collapse; margin:8px 0">
  <thead><tr><th style="padding:4px 8px; border:1px solid #999; text-align:left; background:#f2f2f2">Deductions / Recoverable</th><th style="padding:4px 8px; border:1px solid #999; text-align:right; background:#f2f2f2; width:22%">Amount (₹)</th></tr></thead>
  <tbody>
    <tr><td style="padding:4px 8px; border:1px solid #999">Salary advance / loan outstanding</td><td style="padding:4px 8px; border:1px solid #999"></td></tr>
    <tr><td style="padding:4px 8px; border:1px solid #999">Notice-period shortfall recovery</td><td style="padding:4px 8px; border:1px solid #999"></td></tr>
    <tr><td style="padding:4px 8px; border:1px solid #999">Statutory deductions (PF/ESI/TDS/PT)</td><td style="padding:4px 8px; border:1px solid #999"></td></tr>
    <tr><td style="padding:4px 8px; border:1px solid #999">Loss / damage / unreturned property</td><td style="padding:4px 8px; border:1px solid #999"></td></tr>
    <tr style="font-weight:700"><td style="padding:4px 8px; border:1px solid #999">Total Deductions (B)</td><td style="padding:4px 8px; border:1px solid #999"></td></tr>
  </tbody>
</table>
<p style="font-size:12pt"><strong>Net amount payable / (recoverable) (A − B): ₹ ____________</strong> (Rupees ____________________________ only).</p>
<p>I, ${esc(emp.name)}, hereby acknowledge receipt of the above amount in full and final settlement of all my dues from ${esc(company.name)}, and confirm that I have no further claim of any nature whatsoever against the Company. I confirm that I have returned all Company property, documents and materials in my possession.</p>
<table style="width:100%; margin-top:30px; font-size:9.5pt"><tr>
  <td style="width:50%; text-align:left"><div style="border-top:1px solid #000; padding-top:4px; width:230px">Employee — ${esc(emp.name)}</div></td>
  <td style="width:50%; text-align:right"><div style="border-top:1px solid #000; padding-top:4px; width:230px; margin-left:auto">For ${esc(company.name)} — Authorised Signatory</div></td>
</tr></table>
`,
    };
  },

  noc: (ctx) => {
    const { emp, company, today } = ctx;
    return {
      title: 'No Objection Certificate (NOC)',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>NO OBJECTION CERTIFICATE</strong></p>
<p><strong>TO WHOMSOEVER IT MAY CONCERN</strong></p>
<p>This is to certify that <strong>${esc(emp.name)}</strong>${emp.father_name ? ', S/o ' + esc(emp.father_name) : ''} (Emp Code: ${esc(emp.code || '____')}) is/was employed with ${esc(company.name)} as <strong>${esc(emp.designation || '____________')}</strong>${emp.department ? ' in the ' + esc(emp.department) + ' department' : ''}.</p>
<p>The Company has <strong>no objection</strong> to ${esc(emp.name)} ____________________ <em>[state purpose — e.g. applying for a passport / visa / pursuing higher studies / taking up the stated engagement]</em>, in so far as the Company is concerned.</p>
<p>This certificate is issued on the request of the employee for the purpose stated above.</p>
<p>For <strong>${esc(company.name)}</strong></p>
`,
    };
  },

  bonafide: (ctx) => {
    const { emp, company, today } = ctx;
    return {
      title: 'Bonafide / Employment Certificate',
      html: `
<p style="text-align:right">Ref: <strong>{{DOC_NO}}</strong><br>Date: ${longDate(today)}</p>
<p><strong>TO WHOMSOEVER IT MAY CONCERN</strong></p>
<p>This is to certify that <strong>${esc(emp.name)}</strong>${emp.father_name ? ', S/o ' + esc(emp.father_name) : ''} is a bonafide employee of ${esc(company.name)}, presently working as <strong>${esc(emp.designation || '____________')}</strong>${emp.department ? ' in the ' + esc(emp.department) + ' department' : ''} since <strong>${longDate(emp.joining_date)}</strong>.</p>
<p>${emp.address ? 'As per our records, his/her residential address is: ' + esc(emp.address) + '.' : ''} This certificate is issued on the request of the employee for ____________________ purposes and does not constitute any financial guarantee on the part of the Company.</p>
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
  { key: 'performance_appraisal', label: 'Performance Appraisal',            group: 'Performance' },
  { key: 'increment',             label: 'Increment / Revision Letter',      group: 'Performance' },
  { key: 'promotion',             label: 'Promotion Letter',                 group: 'Performance' },
  { key: 'pip',                   label: 'Performance Improvement Plan',     group: 'Performance' },
  { key: 'warning',               label: 'Warning Letter',                   group: 'Discipline' },
  { key: 'show_cause',            label: 'Show-Cause Notice',                group: 'Discipline' },
  { key: 'charge_sheet',          label: 'Charge-Sheet',                     group: 'Discipline' },
  { key: 'suspension',            label: 'Suspension Pending Enquiry',       group: 'Discipline' },
  { key: 'transfer',              label: 'Transfer Letter',                  group: 'Transfer' },
  { key: 'resignation_acceptance',label: 'Resignation Acceptance',           group: 'Exit' },
  { key: 'relieving',             label: 'Relieving Letter',                 group: 'Exit' },
  { key: 'experience',            label: 'Experience / Service Certificate', group: 'Exit' },
  { key: 'termination',           label: 'Termination Letter',               group: 'Exit' },
  { key: 'full_final',            label: 'Full & Final Settlement',          group: 'Exit' },
  { key: 'salary_certificate',    label: 'Salary Certificate',               group: 'On-demand' },
  { key: 'noc',                   label: 'No Objection Certificate',         group: 'On-demand' },
  { key: 'bonafide',              label: 'Bonafide / Employment Certificate',group: 'On-demand' },
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
  // Assemble the four authored sections. Each part is a self-contained
  // HTML fragment using the literal __COMPANY__ token; we stitch them
  // in order and substitute the real company name once at the end.
  // Wrapped in try/require so a missing part can't crash seeding.
  const parts = [];
  for (const p of ['part1', 'part2', 'part3', 'part4']) {
    try { parts.push(require('./handbookSections/' + p)); }
    catch (_) { /* skip a missing section */ }
  }
  const cover = `
<div style="text-align:center; padding:30px 0 18px">
  <h2 style="margin:0; font-size:20pt; letter-spacing:.4px">EMPLOYEE POLICY HANDBOOK</h2>
  <div style="font-size:11pt; color:#444; margin-top:6px">${c}</div>
  <div style="font-size:9.5pt; color:#666; margin-top:10px">Applicable to all employees — factory workers, sales team and management</div>
</div>
<p style="font-size:9.5pt; color:#555"><em>This Handbook forms part of your terms of employment. It is read together with your Letter of Appointment and the Company's Standing Orders / Service Rules. Where any provision conflicts with an applicable law, the law shall prevail. ${c} may amend this Handbook from time to time; the latest issued version supersedes all earlier versions.</em></p>
<hr>
`;
  const body = parts.length
    ? cover + parts.join('\n<hr>\n')
    // Fallback (parts not found) — minimal handbook so the page still works.
    : cover + '<p>The detailed handbook sections could not be loaded. Please contact the administrator.</p>';
  return body.replace(/__COMPANY__/g, c);
}

module.exports = { DOC_TYPES, BUILDERS, buildDoc, labelFor, salaryBreakup, defaultHandbookHtml, longDate };
