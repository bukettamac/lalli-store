'use strict';
const L = require('./_lib');
/* Siparişi oluşturur: tutarları sunucuda hesaplar, kuponu doğrular, iyzico ödeme sayfasını hazırlar. */
module.exports = async (req, res) => {
  if (req.method !== 'POST') return L.send(res, 405, { ok: false });
  if (!L.SERVICE) return L.send(res, 503, { ok: false, msg: 'Sipariş sistemi henüz açılmadı. Çok yakında!' });
  try {
    const user = await L.getUser(req);
    if (!user) return L.send(res, 401, { ok: false, msg: 'Oturum bulunamadı, sayfayı yenileyip tekrar dene.' });
    const b = req.body || {};
    const c = b.customer || {};
    const customer = {
      name: L.clean(c.name, 60), surname: L.clean(c.surname, 60), phone: L.clean(c.phone, 20).replace(/[^\d+]/g, ''),
      email: L.clean(c.email, 120).toLowerCase(), city: L.clean(c.city, 40), district: L.clean(c.district, 40),
      address: L.clean(c.address, 300), note: L.clean(c.note, 300)
    };
    if (!customer.name || !customer.surname || customer.phone.length < 10 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customer.email) || !customer.city || !customer.district || customer.address.length < 10)
      return L.send(res, 400, { ok: false, msg: 'Teslimat bilgilerini eksiksiz doldur.' });
    if (!b.accept) return L.send(res, 400, { ok: false, msg: 'Mesafeli satış sözleşmesini onaylaman gerekiyor.' });

    const cfg = await L.getConfig();
    const mode = ['kapali', 'siparis', 'iyzico'].includes(cfg.shop && cfg.shop.mode) ? cfg.shop.mode : 'kapali';
    if (mode === 'kapali') return L.send(res, 403, { ok: false, msg: 'Satışlarımız çok yakında başlıyor.' });
    const by = L.catalog(cfg);
    const items = [];
    let sub = 0, stockErr = '';
    (Array.isArray(b.items) ? b.items : []).slice(0, 50).forEach(l => {
      const p = by[String(l.id)];
      if (!p || p.hidden || !(p.price > 0)) return;
      const q = Math.max(1, Math.min(20, parseInt(l.q, 10) || 1));
      if (L.tracked(p) && +p.stock < q) { stockErr = stockErr || (+p.stock <= 0 ? p.name + ' tükendi.' : p.name + ' için yalnızca ' + (+p.stock) + ' adet kaldı.'); return; }
      const opt = l.opt || {};
      items.push({ id: p.id, name: p.name, cat: p.cat, q, price: p.price, opt: { size: L.clean(opt.size, 8), eng: L.clean(opt.eng, 40) } });
      sub += p.price * q;
    });
    if (stockErr) return L.send(res, 409, { ok: false, msg: stockErr + ' Sepetini güncelleyip tekrar dene.' });
    if (!items.length) return L.send(res, 400, { ok: false, msg: 'Sepetin boş ya da ürünler artık satışta değil.' });

    let discount = 0, coupon = null, couponLabel = null;
    if (b.code) {
      const r = await L.evalCoupon(b.code, sub, user.id, cfg);
      if (!r.ok) return L.send(res, 400, { ok: false, msg: r.msg || 'İndirim kodu geçerli değil.', badCode: true });
      discount = Math.min(sub, r.discount || 0); coupon = r.code; couponLabel = r.label;
    }
    const total = Math.max(0, sub - discount);
    const d = L.dealsOf(cfg);
    const stand = (+d.standMin > 0 && total >= +d.standMin) ? (L.STANDS[b.stand] || L.STANDS.bar) : null;
    const id = 'LL' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 4).toUpperCase();
    const pay = mode === 'iyzico' && L.iyzOn();
    const order = {
      id, user_id: user.id, status: 'Ödeme bekleniyor', payment_status: pay ? 'bekliyor' : 'manuel',
      subtotal: sub, discount, total, coupon, coupon_label: couponLabel, items, customer, stand
    };
    await L.rest('orders', { method: 'POST', body: order, headers: { Prefer: 'return=minimal' } });
    try { await L.adjustStock(items, -1); } catch (e) { console.error('stok', e); }

    if (!pay) return L.send(res, 200, { ok: true, id, manual: true });

    // iyzico ödeme formu: indirim, satır fiyatlarına orantılı dağıtılır
    const ratio = sub > 0 ? total / sub : 1;
    let acc = 0;
    const basket = items.map((it, i) => {
      let line = Math.round(it.price * it.q * ratio * 100) / 100;
      if (i === items.length - 1) line = Math.round((total - acc) * 100) / 100;
      acc += line;
      return { id: it.id + '-' + i, name: it.name.slice(0, 60), category1: it.cat || 'Takı', itemType: 'PHYSICAL', price: L.money(line) };
    }).filter(x => +x.price > 0);
    const site = L.siteUrl(req);
    const addr = customer.address + ' ' + customer.district;
    const body = {
      locale: 'tr', conversationId: id, price: L.money(total), paidPrice: L.money(total), currency: 'TRY',
      basketId: id, paymentGroup: 'PRODUCT', callbackUrl: site + '/api/odeme-sonuc', enabledInstallments: [1, 2, 3, 6],
      buyer: {
        id: user.id, name: customer.name, surname: customer.surname, gsmNumber: customer.phone, email: customer.email,
        identityNumber: '11111111111', registrationAddress: addr, ip: L.clientIp(req), city: customer.city, country: 'Turkey'
      },
      shippingAddress: { contactName: customer.name + ' ' + customer.surname, city: customer.city, country: 'Turkey', address: addr },
      billingAddress: { contactName: customer.name + ' ' + customer.surname, city: customer.city, country: 'Turkey', address: addr },
      basketItems: basket
    };
    const r = await L.iyz('/payment/iyzipos/checkoutform/initialize/auth/ecom', body);
    if (!r || r.status !== 'success' || !r.paymentPageUrl) {
      console.error('iyzico', r && r.errorMessage);
      await L.rest('orders?id=eq.' + id, { method: 'PATCH', body: { payment_status: 'basarisiz', updated_at: new Date().toISOString() } });
      try { await L.adjustStock(items, +1); } catch (e) { console.error('stok', e); }
      return L.send(res, 502, { ok: false, msg: 'Ödeme sayfası açılamadı, biraz sonra tekrar dene.' });
    }
    await L.rest('order_admin', { method: 'POST', body: { order_id: id, payment: { token: r.token } }, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
    return L.send(res, 200, { ok: true, id, paymentPageUrl: r.paymentPageUrl });
  } catch (e) {
    console.error(e);
    return L.send(res, 500, { ok: false, msg: 'Sipariş oluşturulamadı, biraz sonra tekrar dene.' });
  }
};
