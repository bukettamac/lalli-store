/* LALLİ — sunucu yardımcıları (Vercel Functions, Node 20+)
   Fiyatlar, kuponlar ve sipariş kayıtları yalnızca burada hesaplanır; tarayıcıdan gelen tutarlara güvenilmez. */
'use strict';
const crypto = require('crypto');
const BASE = require('./_base.json');

const SB_URL = (process.env.SUPABASE_URL || 'https://pufpgfsyihjhtooojcka.supabase.co').replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const ANON = process.env.SUPABASE_ANON_KEY || '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const STANDS = { bar: 'Kolye standı', tree: 'Ağaç stand', tray: 'Katlı tepsi' };

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

async function rest(path, opt) {
  opt = opt || {};
  const key = opt.key || SERVICE;
  const r = await fetch(SB_URL + '/rest/v1/' + path, {
    method: opt.method || 'GET',
    headers: Object.assign({ apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, opt.headers || {}),
    body: opt.body ? JSON.stringify(opt.body) : undefined
  });
  const txt = await r.text();
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  if (!r.ok) { const e = new Error('Veritabanı hatası: ' + r.status + ' ' + txt.slice(0, 200)); e.status = r.status; throw e; }
  return data;
}

/* İstek sahibinin oturumunu doğrula */
async function getUser(req) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!tok) return null;
  const r = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: ANON || SERVICE, Authorization: 'Bearer ' + tok } });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u : null;
}

async function getConfig() {
  const rows = await rest('docs?col=eq.site&id=eq.config&select=data', { key: SERVICE || ANON });
  return (rows && rows[0] && rows[0].data) || {};
}

/* Sitedeki buildCatalog ile aynı fiyat mantığı */
function catalog(cfg) {
  const prods = cfg.products || {};
  const all = [];
  BASE.P.forEach(b => {
    const o = prods[b.id] || {}, p = Object.assign({}, b);
    ['name', 'price', 'hidden', 'stock'].forEach(k => { if (o[k] !== undefined) p[k] = o[k]; });
    p.priceSet = o.price !== undefined; all.push(p);
  });
  Object.keys(prods).forEach(id => {
    const o = prods[id];
    if (o && o.extra) all.push({ id, cat: o.type || 'kolye', name: o.name || id, price: o.price || 0, hidden: o.hidden, incl: o.incl, stock: o.stock, priceSet: true });
  });
  const tmp = {}; all.forEach(p => { tmp[p.id] = p; });
  all.forEach(p => {
    p.price = Math.max(0, +p.price || 0);
    if (p.incl) {
      const old = p.incl.reduce((a, id) => a + ((tmp[id] && +tmp[id].price) || 0), 0);
      if (!p.priceSet) p.price = Math.round(old * 0.9 / 10) * 10;
    }
  });
  const by = {}; all.forEach(p => { by[p.id] = p; });
  return by;
}

function dealsOf(cfg) { return Object.assign({}, BASE.deals, cfg.deals || {}); }

/* Türkiye saatine göre bugünün günü */
function trDay() {
  const s = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Istanbul', day: 'numeric' }).format(new Date());
  return +s;
}
function norm(c) { return String(c || '').toLocaleUpperCase('en-US').replace(/\s+/g, '').slice(0, 24); }

/* Kupon doğrulama: fırsat günü kodları, hoş geldin kuponu ve yönetim panelinde oluşturulan kuponlar */
async function evalCoupon(code, sub, userId, cfg) {
  code = norm(code);
  if (!code) return { ok: false, msg: '' };
  const d = dealsOf(cfg);
  if (d.firstCode && norm(d.firstCode) === code) {
    if (userId && SERVICE) {
      const used = await rest('orders?select=id&user_id=eq.' + userId + '&coupon=eq.' + encodeURIComponent(code) + '&status=neq.' + encodeURIComponent('İptal') + '&limit=1');
      if (used && used.length) return { ok: false, msg: 'Hoş geldin kuponunu daha önce kullandın.' };
    }
    const amt = Math.min(+d.firstAmt || 0, sub);
    return { ok: true, code, label: 'Hoş geldin kuponu', amt: +d.firstAmt || 0, discount: amt };
  }
  const day = (d.days || []).find(x => x && x.code && norm(x.code) === code);
  if (day) {
    if (+day.day !== trDay()) return { ok: false, msg: 'Bu kod yalnızca ayın ' + day.day + '. günü geçerli.' };
    return { ok: true, code, label: 'Fırsat günü kodu', pct: +day.pct || 0, discount: Math.round(sub * (+day.pct || 0) / 100) };
  }
  if (!SERVICE) return { ok: false, msg: 'Bu kod geçerli değil.' };
  const rows = await rest('coupons?code=eq.' + encodeURIComponent(code) + '&select=*');
  const c = rows && rows[0];
  if (!c || !c.active) return { ok: false, msg: 'Bu kod geçerli değil.' };
  const now = Date.now();
  if (c.starts_at && Date.parse(c.starts_at) > now) return { ok: false, msg: 'Bu kupon henüz başlamadı.' };
  if (c.ends_at && Date.parse(c.ends_at) < now) return { ok: false, msg: 'Bu kuponun süresi doldu.' };
  if (c.min_total && sub < +c.min_total) return { ok: false, msg: 'Bu kupon ' + (+c.min_total).toLocaleString('tr-TR') + ' ₺ ve üzeri sepetlerde geçerli.', min: +c.min_total };
  const notCancelled = '&status=not.in.(' + encodeURIComponent('"İptal","İade"') + ')';
  if (c.max_uses) {
    const all = await rest('orders?select=id&coupon=eq.' + encodeURIComponent(code) + notCancelled, { headers: { Prefer: 'count=exact' } });
    if ((all || []).length >= c.max_uses) return { ok: false, msg: 'Bu kuponun kullanım limiti doldu.' };
  }
  if (c.once_per_user && userId) {
    const mine = await rest('orders?select=id&user_id=eq.' + userId + '&coupon=eq.' + encodeURIComponent(code) + notCancelled + '&limit=1');
    if (mine && mine.length) return { ok: false, msg: 'Bu kuponu daha önce kullandın.' };
  }
  const label = c.note ? String(c.note).slice(0, 40) : 'Kupon';
  if (c.kind === 'pct') return { ok: true, code, label, pct: +c.value, min: +c.min_total || 0, discount: Math.round(sub * (+c.value) / 100) };
  return { ok: true, code, label, amt: +c.value, min: +c.min_total || 0, discount: Math.min(+c.value, sub) };
}

/* ---------- iyzico (Checkout Form, IYZWSv2 imzası) ---------- */
const IYZ_BASE = (process.env.IYZICO_BASE_URL || 'https://sandbox-api.iyzipay.com').replace(/\/+$/, '');
const IYZ_KEY = process.env.IYZICO_API_KEY || '';
const IYZ_SECRET = process.env.IYZICO_SECRET_KEY || '';
function iyzOn() { return !!(IYZ_KEY && IYZ_SECRET); }
async function iyz(path, body) {
  const rnd = Date.now() + '' + crypto.randomBytes(4).toString('hex');
  const payload = rnd + path + JSON.stringify(body);
  const sig = crypto.createHmac('sha256', IYZ_SECRET).update(payload).digest('hex');
  const auth = 'IYZWSv2 ' + Buffer.from('apiKey:' + IYZ_KEY + '&randomKey:' + rnd + '&signature:' + sig).toString('base64');
  const r = await fetch(IYZ_BASE + path, {
    method: 'POST',
    headers: { Authorization: auth, 'x-iyzi-rnd': rnd, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}
function money(n) { return (Math.round(n * 100) / 100).toFixed(2); }

function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return 'https://' + host;
}
function clientIp(req) { return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || '85.34.78.112'; }
function clean(s, n) { return String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, n || 120); }

function tracked(p) { return p && p.stock !== undefined && p.stock !== null && p.stock !== ''; }
/* Stok düş / geri ekle: site ayarlarındaki ürün stoklarını günceller (sign: -1 düş, +1 geri ekle) */
async function adjustStock(items, sign) {
  const rows = await rest('docs?col=eq.site&id=eq.config&select=data');
  const cfg = (rows && rows[0] && rows[0].data) || {};
  const prods = cfg.products || {};
  let changed = false;
  items.forEach(it => {
    const o = prods[it.id];
    if (o && o.stock !== undefined && o.stock !== null && o.stock !== '') { o.stock = Math.max(0, (+o.stock || 0) + sign * (+it.q || 0)); changed = true; }
  });
  if (!changed) return;
  await rest('docs?col=eq.site&id=eq.config', { method: 'PATCH', body: { data: cfg, updated_at: new Date().toISOString() }, headers: { Prefer: 'return=minimal' } });
}

module.exports = { tracked, adjustStock, send, rest, getUser, getConfig, catalog, dealsOf, evalCoupon, iyz, iyzOn, money, siteUrl, clientIp, clean, norm, STANDS, SERVICE };
