/* LALLİ — Supabase veri katmanı
   Sitenin kullandığı belge arayüzünü (doc/collection/onSnapshot) Supabase üzerine kurar.
   Yetki kontrolü tamamen veritabanındaki satır güvenliği (RLS) kurallarıyla yapılır. */
(function () {
  'use strict';
  var CFG = window.LALLI_CONFIG || {};
  var sb = window.supabase.createClient(CFG.url, CFG.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: CFG.storageKey || 'lalli-auth' }
  });
  var MODE = CFG.mode || 'store';

  /* ---------- oturum ---------- */
  var sessionP = null;
  function ensureSession() {
    if (sessionP) return sessionP;
    sessionP = sb.auth.getSession().then(function (r) {
      var s = r.data && r.data.session;
      if (s) return s;
      if (MODE !== 'store') return null; // yönetim tarafında anonim oturum açılmaz
      return sb.auth.signInAnonymously().then(function (a) {
        if (a.error) { console.warn('Oturum açılamadı:', a.error.message); return null; }
        return a.data.session;
      });
    }).catch(function () { return null; });
    return sessionP;
  }
  sb.auth.onAuthStateChange(function (ev, s) {
    if (ev === 'SIGNED_OUT') sessionP = null;
    else if (s) sessionP = Promise.resolve(s);
  });
  function uid() { return ensureSession().then(function (s) { return s && s.user ? s.user.id : null; }); }

  /* ---------- yardımcılar ---------- */
  function rid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function fail(e) { var x = new Error((e && e.message) || 'Veri hatası'); x.code = (e && (e.code || e.status)) || 'db'; throw x; }
  function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms || 120); }; }
  function split(path) { var i = path.indexOf('/'); return [path.slice(0, i), path.slice(i + 1)]; }
  function dsnap(id, row) { return { id: id, exists: !!row, data: function () { return row ? row.data : undefined; } }; }

  /* ---------- canlı güncelleme ---------- */
  var listeners = {}, chans = {};
  function ping(col) { (listeners[col] || []).slice().forEach(function (f) { try { f(); } catch (e) {} }); }
  function watch(col, fn) {
    (listeners[col] = listeners[col] || []).push(fn);
    if (!chans[col]) {
      try {
        chans[col] = sb.channel('docs-' + col)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'docs', filter: 'col=eq.' + col }, function () { ping(col); })
          .subscribe();
      } catch (e) {}
    }
    return function () { listeners[col] = (listeners[col] || []).filter(function (x) { return x !== fn; }); };
  }

  /* ---------- belge / koleksiyon ---------- */
  function doc(path) {
    var p = split(path), col = p[0], id = p[1];
    var ref = {
      id: id,
      get: async function () {
        await ensureSession();
        var r = await sb.from('docs').select('data').eq('col', col).eq('id', id).maybeSingle();
        if (r.error) fail(r.error);
        return dsnap(id, r.data);
      },
      set: async function (data) {
        await ensureSession();
        var r = await sb.from('docs').upsert({ col: col, id: id, data: data });
        if (r.error) fail(r.error);
        ping(col);
      },
      delete: async function () {
        await ensureSession();
        var r = await sb.from('docs').delete().eq('col', col).eq('id', id);
        if (r.error) fail(r.error);
        ping(col);
      },
      onSnapshot: function (cb, eb) {
        var run = function () { ref.get().then(cb, eb || function () {}); };
        run();
        return watch(col, debounce(run));
      }
    };
    return ref;
  }
  function collection(col, o) {
    o = o || {};
    var q = {
      limit: function (n) { return collection(col, Object.assign({}, o, { limit: n })); },
      orderBy: function (f, d) { return collection(col, Object.assign({}, o, { ord: f, dir: d })); },
      doc: function (id) { return doc(col + '/' + id); },
      get: async function () {
        await ensureSession();
        var b = sb.from('docs').select('id,data').eq('col', col);
        if (o.ord) b = b.order('data->' + o.ord, { ascending: o.dir !== 'desc' });
        b = b.limit(o.limit || 1000);
        var r = await b;
        if (r.error) fail(r.error);
        var docs = (r.data || []).map(function (x) { return dsnap(x.id, x); });
        return { docs: docs, size: docs.length, empty: !docs.length };
      },
      add: async function (data) { var id = rid(); await doc(col + '/' + id).set(data); return doc(col + '/' + id); },
      onSnapshot: function (cb, eb) {
        var run = function () { q.get().then(cb, eb || function () {}); };
        run();
        return watch(col, debounce(run));
      }
    };
    return q;
  }

  /* ---------- fotoğraf yükleme (otomatik küçültme) ---------- */
  function shrink(file, max, quality) {
    return new Promise(function (resolve) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 350 * 1024) return resolve(file);
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, max / Math.max(w, h));
        var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { resolve(b && b.size < file.size ? new File([b], 'foto.jpg', { type: 'image/jpeg' }) : file); }, 'image/jpeg', quality);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }
  var assets = {
    upload: async function (file) {
      var me = await uid();
      if (!me) fail({ message: 'Oturum yok', code: 'auth' });
      var f = await shrink(file, 1800, 0.86);
      var ext = (f.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      var path = (MODE === 'admin' ? 'site' : me) + '/' + rid() + '.' + ext;
      var r = await sb.storage.from('media').upload(path, f, { cacheControl: '31536000', contentType: f.type, upsert: false });
      if (r.error) fail(r.error);
      return { id: path, url: sb.storage.from('media').getPublicUrl(path).data.publicUrl };
    },
    delete: async function (id) { var r = await sb.storage.from('media').remove([id]); if (r.error) fail(r.error); }
  };

  /* ---------- kullanıcı ---------- */
  var user = {
    id: uid,
    canEdit: async function () {
      if (MODE !== 'admin') return false;
      await ensureSession();
      var r = await sb.rpc('is_admin');
      return !r.error && r.data === true;
    }
  };

  /* ---------- dosya indirme ---------- */
  var downloads = {
    save: async function (o) {
      var blob = o.data instanceof Blob ? o.data : new Blob(['﻿' + o.data], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = o.filename || 'dosya';
      document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    }
  };

  var db = { doc: doc, collection: collection };
  window.LALLI = { sb: sb, ensureSession: ensureSession, uid: uid, db: db, assets: assets };
  window.claude = {
    use: function (name) {
      return Promise.resolve({ db: db, user: user, assets: assets, downloads: downloads }[name] || null);
    }
  };
})();
