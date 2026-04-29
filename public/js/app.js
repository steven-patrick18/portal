// Auto-confirm forms with data-confirm
document.addEventListener('submit', (e) => {
  const f = e.target;
  if (f.dataset && f.dataset.confirm) {
    if (!confirm(f.dataset.confirm)) e.preventDefault();
  }
});

// Recompute totals in line-item forms
function recalcLines() {
  const rows = document.querySelectorAll('.line-row');
  let subtotal = 0, gst = 0;
  rows.forEach(r => {
    const qty = parseFloat(r.querySelector('.qty')?.value || 0);
    const rate = parseFloat(r.querySelector('.rate')?.value || 0);
    const gstRate = parseFloat(r.querySelector('.gst-rate')?.value || 0);
    const amt = qty * rate;
    const g = amt * gstRate / 100;
    subtotal += amt;
    gst += g;
    const amtCell = r.querySelector('.amount');
    if (amtCell) amtCell.textContent = amt.toFixed(2);
  });
  const sub = document.getElementById('subtotal');
  const gstEl = document.getElementById('gst-amount');
  const tot = document.getElementById('total');
  if (sub) sub.textContent = subtotal.toFixed(2);
  if (gstEl) gstEl.textContent = gst.toFixed(2);
  if (tot) tot.textContent = (subtotal + gst).toFixed(2);
}
document.addEventListener('input', (e) => {
  if (e.target.matches('.qty,.rate,.gst-rate')) recalcLines();
});
