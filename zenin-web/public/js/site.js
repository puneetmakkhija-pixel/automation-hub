// Website behaviour: the cost calculator (numbers come from the server, never computed here) and the service worker.
(function () {
  var box = document.querySelector('[data-calc]');
  if (box) {
    var range = document.getElementById('calc-amount');
    var fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
    var inr = function (n) { return '₹' + fmt.format(n); };
    var pct = function (n) { return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(n) + '%'; };
    var set = function (id, html) { var el = document.getElementById(id); if (el) el.innerHTML = html; };
    var timer;
    range.addEventListener('input', function () {
      var amount = Number(range.value);
      set('calc-out', inr(amount));
      set('calc-receive', inr(amount));
      clearTimeout(timer);
      timer = setTimeout(function () {
        fetch('/api/quote?amount=' + amount).then(function (r) { return r.ok ? r.json() : null; }).then(function (q) {
          if (!q || Number(range.value) !== q.amount) return;
          set('calc-fee', inr(q.fee));
          set('calc-repay', '<strong>' + inr(q.repayment) + '</strong>');
          set('calc-apr-simple', pct(q.aprSimplePct));
          set('calc-apr-eff', pct(q.aprEffectivePct));
        }).catch(function () {});
      }, 120);
    });
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});
})();
