'use strict';
const L = require('./_lib');
/* Sepetteki indirim kodunu sunucuda doğrular. Kupon listesi hiçbir zaman tarayıcıya gönderilmez. */
module.exports = async (req, res) => {
  if (req.method !== 'POST') return L.send(res, 405, { ok: false });
  try {
    const b = req.body || {};
    const user = await L.getUser(req);
    const cfg = await L.getConfig();
    const by = L.catalog(cfg);
    let sub = 0;
    (Array.isArray(b.items) ? b.items : []).slice(0, 50).forEach(l => {
      const p = by[String(l.id)]; const q = Math.max(1, Math.min(20, parseInt(l.q, 10) || 1));
      if (p && !p.hidden) sub += p.price * q;
    });
    const r = await L.evalCoupon(b.code, sub, user && user.id, cfg);
    if (!r.ok) return L.send(res, 200, { ok: false, msg: r.msg || 'Bu kod geçerli değil.', min: r.min || 0 });
    return L.send(res, 200, { ok: true, code: r.code, label: r.label, pct: r.pct || 0, amt: r.amt || 0, min: r.min || 0 });
  } catch (e) {
    console.error(e);
    return L.send(res, 500, { ok: false, msg: 'Kod şu an kontrol edilemedi, biraz sonra tekrar dene.' });
  }
};
