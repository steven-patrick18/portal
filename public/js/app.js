// Auto-confirm forms with data-confirm
document.addEventListener('submit', (e) => {
  const f = e.target;
  if (f.dataset && f.dataset.confirm) {
    if (!confirm(f.dataset.confirm)) e.preventDefault();
  }
});

// Recompute totals in line-item forms.
// Bundle SKUs: line's product select carries data-bundle="1" + data-ppb=N → qty means "N bundles".
// Discount: optional #discount-amount input (₹) is pro-rated across lines before GST.
//          Optional #discount-pct input mirrors the % equivalent (kept in sync).
function recalcLines() {
  const rows = document.querySelectorAll('.line-row');
  let subtotal = 0;
  const lineAmounts = [];
  rows.forEach(r => {
    const sel = r.querySelector('select.prod-select');
    const opt = sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
    const qty = parseFloat(r.querySelector('.qty')?.value || 0);
    const rate = parseFloat(r.querySelector('.rate')?.value || 0);
    const gstRate = parseFloat(r.querySelector('.gst-rate')?.value || 0);
    const isBundle = !!(opt && opt.dataset && opt.dataset.bundle === '1');
    const ppb = isBundle ? parseInt(opt.dataset.ppb || 1) : 1;
    const amt = qty * rate * ppb;
    subtotal += amt;
    lineAmounts.push({ amt, gstRate });
    const amtCell = r.querySelector('.amount');
    if (amtCell) {
      amtCell.innerHTML = isBundle && ppb > 1
        ? `${amt.toFixed(2)}<br><small class="text-muted">${qty} × ${ppb} × ₹${rate}</small>`
        : amt.toFixed(2);
    }
  });

  const discInput = document.getElementById('discount-amount');
  const discPctInput = document.getElementById('discount-pct');
  let discount = parseFloat(discInput?.value || 0) || 0;
  if (discount > subtotal) discount = subtotal;
  if (discount < 0) discount = 0;
  const factor = subtotal > 0 ? (subtotal - discount) / subtotal : 1;
  let gst = 0;
  lineAmounts.forEach(l => { gst += (l.amt * factor) * l.gstRate / 100; });

  // Mirror % from amount (only when amount changed — guarded by the listener below)
  if (discPctInput && document.activeElement !== discPctInput) {
    discPctInput.value = subtotal > 0 ? (discount * 100 / subtotal).toFixed(2).replace(/\.?0+$/,'') : '';
  }

  const sub = document.getElementById('subtotal');
  const tax = document.getElementById('taxable');
  const gstEl = document.getElementById('gst-amount');
  const tot = document.getElementById('total');
  if (sub) sub.textContent = subtotal.toFixed(2);
  if (tax) tax.textContent = (subtotal - discount).toFixed(2);
  if (gstEl) gstEl.textContent = gst.toFixed(2);
  if (tot) tot.textContent = (subtotal - discount + gst).toFixed(2);
}
document.addEventListener('input', (e) => {
  if (e.target.matches('.qty,.rate,.gst-rate,#discount-amount')) recalcLines();
  // Typing % updates the ₹ amount, which then triggers a full recalc
  if (e.target.id === 'discount-pct') {
    const sub = parseFloat(document.getElementById('subtotal')?.textContent || 0) || 0;
    const pct = parseFloat(e.target.value || 0) || 0;
    const amtInput = document.getElementById('discount-amount');
    if (amtInput) { amtInput.value = (sub * pct / 100).toFixed(2); recalcLines(); }
  }
});

// Auto-enhance <select> dropdowns with search using Tom Select.
// Opt-in: add class "searchable". Auto: any single-value select with > 6 options.
// Opt-out: add attribute data-no-search.
(function () {
  if (typeof TomSelect === 'undefined') return;

  function shouldEnhance(sel) {
    if (!sel || sel.tagName !== 'SELECT') return false;
    if (sel.multiple) return false;
    if (sel.size && sel.size > 1) return false;
    if (sel.hasAttribute('data-no-search')) return false;
    if (sel.tomselect) return false;
    if (sel.classList.contains('searchable')) return true;
    return sel.options.length > 6;
  }

  function cleanupClonedWrapper(sel) {
    // Tom Select wraps the original <select> inside a .ts-wrapper. When a
    // row is cloned via cloneNode(true), the wrapper is cloned too but no
    // TomSelect instance is bound to the new select. Pull the select out
    // of the cloned wrapper, drop the wrapper, and strip stale state.
    if (!(sel.classList.contains('tomselected') || sel.classList.contains('ts-hidden-accessible'))) return;
    const wrapper = sel.closest('.ts-wrapper');
    if (wrapper && wrapper.parentNode) {
      wrapper.parentNode.insertBefore(sel, wrapper);
      wrapper.remove();
    }
    sel.classList.remove('tomselected', 'ts-hidden-accessible');
    sel.removeAttribute('tabindex');
    sel.style.display = '';
  }

  function enhance(sel) {
    cleanupClonedWrapper(sel);
    if (!shouldEnhance(sel)) return;
    try {
      new TomSelect(sel, {
        allowEmptyOption: true,
        maxOptions: 1000,
        // Render dropdown in body so it isn't clipped by .table-responsive
        // or other overflow:auto/hidden ancestors.
        dropdownParent: 'body',
        plugins: sel.required ? [] : ['clear_button']
      });
    } catch (_) { /* ignore double-init or unsupported */ }
  }

  function enhanceWithin(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('select').forEach(enhance);
  }

  document.addEventListener('DOMContentLoaded', () => enhanceWithin(document));

  // Catch dynamically-added selects (e.g. cloned line-item rows).
  const obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (node.tagName === 'SELECT') enhance(node);
        else if (node.querySelectorAll) node.querySelectorAll('select').forEach(enhance);
      });
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
})();
