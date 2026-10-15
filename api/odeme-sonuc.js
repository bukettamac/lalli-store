'use strict';
const L = require('./_lib');
/* iyzico ödeme sonrası buraya döner. Sonucu iyzico'dan yeniden sorgulayıp siparişi günceller. */
module.exports = async (req, res) => {
  const site = L.siteUrl(req);
  const go = (q) => { res.statusCode = 303; res.setHeader('Location', site + '/?' + q); res.end(); };
  try {
    const token = (req.body && req.body.token) || (req.query && req.query.token);
    if (!token || !L.iyzOn() || !L.SERVICE) return go('odeme=hata');
    const r = await L.iyz('/payment/iyzipos/checkoutform/auth/ecom/detail', { locale: 'tr', token: String(token) });
    const id = r && (r.basketId || r.conversationId);
    if (!id) return go('odeme=hata');
    const rows = await L.rest('orders?id=eq.' + encodeURIComponent(id) + '&select=id,total,status,payment_status,items');
    const o = rows && rows[0];
    if (!o) return go('odeme=hata');
    const paid = r.status === 'success' && r.paymentStatus === 'SUCCESS' && Math.abs(+r.paidPrice - +o.total) < 0.05;
    if (paid) {
      if (o.status === 'Ödeme bekleniyor')
        await L.rest('orders?id=eq.' + encodeURIComponent(id), { method: 'PATCH', body: { status: 'Hazırlanıyor', payment_status: 'odendi', updated_at: new Date().toISOString() } });
    } else {
      if (o.status === 'Ödeme bekleniyor' && o.payment_status !== 'basarisiz') {
        await L.rest('orders?id=eq.' + encodeURIComponent(id), { method: 'PATCH', body: { payment_status: 'basarisiz', updated_at: new Date().toISOString() } });
        try { await L.adjustStock(o.items || [], +1); } catch (e) { console.error('stok', e); }
      }
    }
    await L.rest('order_admin', { method: 'POST', body: { order_id: id, payment: { token: String(token), paymentId: r.paymentId || null, status: r.paymentStatus || r.status, paidPrice: r.paidPrice || null, installment: r.installment || null, error: r.errorMessage || null } }, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
    return go(paid ? 'odeme=ok&no=' + encodeURIComponent(id) : 'odeme=hata&no=' + encodeURIComponent(id));
  } catch (e) {
    console.error(e);
    return go('odeme=hata');
  }
};
