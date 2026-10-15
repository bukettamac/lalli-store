# LALLİ — mağaza

lallejewelry.com mağaza sitesi. Yönetim paneli bu depoda **yoktur**; ayrı bir depoda ve ayrı bir adreste çalışır.

## Yapı
- `index.html` — mağaza (fırsat kartları, kategoriler, ürünler, LALLİ Akışı, üyelik, SSS, yasal metinler, çerez onayı)
- `lalli-db.js` — Supabase veri katmanı (yetki kontrolü veritabanındaki RLS kurallarında)
- `api/siparis.js` — siparişi oluşturur; fiyat ve indirimi sunucuda hesaplar, iyzico ödeme sayfasını açar
- `api/odeme-sonuc.js` — iyzico dönüşünde ödemeyi doğrular, siparişi "Hazırlanıyor" yapar
- `api/kupon.js` — indirim kodunu sunucuda doğrular (kupon listesi tarayıcıya gönderilmez)
- `supabase/kurulum.sql` — veritabanı tabloları ve güvenlik kuralları
- `robots.txt`, `sitemap.xml`, `llms.txt`, `404.html`, ikonlar, `og.png`

## Vercel ortam değişkenleri
| Ad | Değer |
|---|---|
| `SUPABASE_URL` | `https://pufpgfsyihjhtooojcka.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase › Project Settings › API › anon public |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase › Project Settings › API › service_role (**gizli**; yalnızca Vercel'e girilir) |
| `IYZICO_API_KEY` / `IYZICO_SECRET_KEY` | iyzico üye işyeri paneli |
| `IYZICO_BASE_URL` | Test: `https://sandbox-api.iyzipay.com` · Canlı: `https://api.iyzipay.com` |
| `SITE_URL` | `https://lallejewelry.com` |

iyzico anahtarları girilmezse siparişler "Elden / havale" olarak alınır; ödeme için müşteriyle iletişime geçilir.
