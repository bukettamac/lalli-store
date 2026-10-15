-- =====================================================================
-- LALLİ — Supabase veritabanı kurulumu
-- Supabase panelinde: SQL Editor > New query > bu dosyanın tamamını yapıştır > Run
-- Birden fazla kez çalıştırılabilir; mevcut veriyi silmez.
-- =====================================================================

-- ---------- yöneticiler ----------
create table if not exists public.admins(
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
-- admins tablosuna hiçbir politika yok: kimse okuyamaz, yazamaz (yalnızca aşağıdaki fonksiyon bakar)

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.admins a where a.user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- ---------- siparişler ----------
create table if not exists public.orders(
  id text primary key,
  user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'Ödeme bekleniyor'
    check (status in ('Ödeme bekleniyor','Hazırlanıyor','Kargoda','Teslim edildi','İptal','İade')),
  payment_status text not null default 'bekliyor'
    check (payment_status in ('bekliyor','odendi','basarisiz','iade','manuel')),
  subtotal numeric(12,2) not null default 0,
  discount numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  coupon text,
  coupon_label text,
  items jsonb not null default '[]'::jsonb,
  customer jsonb not null default '{}'::jsonb,
  stand text,
  cargo_company text,
  tracking_no text
);
create index if not exists orders_user_idx on public.orders(user_id);
create index if not exists orders_created_idx on public.orders(created_at desc);
create index if not exists orders_coupon_idx on public.orders(coupon);
alter table public.orders enable row level security;

drop policy if exists orders_read on public.orders;
create policy orders_read on public.orders for select
  using (user_id = auth.uid() or public.is_admin());
drop policy if exists orders_admin_upd on public.orders;
create policy orders_admin_upd on public.orders for update
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists orders_admin_del on public.orders;
create policy orders_admin_del on public.orders for delete using (public.is_admin());
-- INSERT politikası yok: siparişleri yalnızca sunucu (ödeme API'si) oluşturur.

-- yöneticiye özel sipariş notları ve ödeme kayıtları (müşteri göremez)
create table if not exists public.order_admin(
  order_id text primary key references public.orders(id) on delete cascade,
  note text,
  payment jsonb,
  updated_at timestamptz not null default now()
);
alter table public.order_admin enable row level security;
drop policy if exists order_admin_all on public.order_admin;
create policy order_admin_all on public.order_admin for all
  using (public.is_admin()) with check (public.is_admin());

create or replace function public.has_delivered(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.orders o where o.user_id = uid and o.status = 'Teslim edildi');
$$;
revoke all on function public.has_delivered(uuid) from public;
grant execute on function public.has_delivered(uuid) to anon, authenticated;

-- ---------- kuponlar (yalnızca yönetici görür; doğrulamayı sunucu yapar) ----------
create table if not exists public.coupons(
  code text primary key check (code = upper(code) and length(code) between 3 and 24),
  kind text not null check (kind in ('pct','amt')),
  value numeric(12,2) not null check (value > 0),
  min_total numeric(12,2) not null default 0,
  starts_at timestamptz,
  ends_at timestamptz,
  max_uses integer check (max_uses is null or max_uses > 0),
  once_per_user boolean not null default true,
  active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  constraint coupons_pct check (kind <> 'pct' or value <= 90)
);
alter table public.coupons enable row level security;
drop policy if exists coupons_admin on public.coupons;
create policy coupons_admin on public.coupons for all
  using (public.is_admin()) with check (public.is_admin());

-- ---------- site içeriği, akış, beğeniler, müşteri paylaşımları, üyeler ----------
create table if not exists public.docs(
  col text not null check (col in ('site','feed','likes','userposts','members')),
  id text not null check (length(id) between 1 and 200),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (col, id),
  constraint docs_size check (pg_column_size(data) < 1500000)
);
alter table public.docs enable row level security;

drop policy if exists docs_read on public.docs;
create policy docs_read on public.docs for select using (
  col in ('site','feed','likes','userposts')
  or public.is_admin()
  or (col = 'members' and id = auth.uid()::text)
);
drop policy if exists docs_ins on public.docs;
create policy docs_ins on public.docs for insert with check (
  public.is_admin()
  or (col = 'members' and id = auth.uid()::text)
  or (col = 'likes' and id like '%\_\_' || auth.uid()::text and data->>'uid' = auth.uid()::text)
  or (col = 'userposts' and id = auth.uid()::text and public.has_delivered(auth.uid()))
);
drop policy if exists docs_upd on public.docs;
create policy docs_upd on public.docs for update using (
  public.is_admin()
  or (col = 'members' and id = auth.uid()::text)
  or (col = 'userposts' and id = auth.uid()::text)
) with check (
  public.is_admin()
  or (col = 'members' and id = auth.uid()::text)
  or (col = 'userposts' and id = auth.uid()::text and public.has_delivered(auth.uid()))
);
drop policy if exists docs_del on public.docs;
create policy docs_del on public.docs for delete using (
  public.is_admin()
  or (col = 'likes' and id like '%\_\_' || auth.uid()::text)
  or (col = 'userposts' and id = auth.uid()::text)
  or (col = 'members' and id = auth.uid()::text)
);

-- müşteri, yöneticinin gizlediği paylaşımı kendi kendine geri açamaz; en fazla 30 paylaşım
create or replace function public.docs_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare hid jsonb := '[]'::jsonb;
begin
  new.updated_at := now();
  if new.col <> 'userposts' or public.is_admin() then return new; end if;
  if tg_op = 'UPDATE' then
    select coalesce(jsonb_agg(p->>'id'), '[]'::jsonb) into hid
      from jsonb_array_elements(coalesce(old.data->'posts','[]'::jsonb)) p
     where coalesce((p->>'hidden')::boolean, false);
  end if;
  new.data := jsonb_set(new.data, '{posts}', coalesce((
      select jsonb_agg(case when hid ? (p->>'id') then p || '{"hidden":true}'::jsonb else p - 'hidden' end)
        from jsonb_array_elements(coalesce(new.data->'posts','[]'::jsonb)) p), '[]'::jsonb));
  if jsonb_array_length(new.data->'posts') > 30 then
    raise exception 'En fazla 30 paylaşım yapılabilir';
  end if;
  return new;
end $$;
drop trigger if exists docs_guard on public.docs;
create trigger docs_guard before insert or update on public.docs
  for each row execute function public.docs_guard();

-- ---------- fotoğraf deposu ----------
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 8388608, array['image/jpeg','image/png','image/webp','image/gif','image/avif'])
on conflict (id) do update set public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists media_ins on storage.objects;
create policy media_ins on storage.objects for insert to authenticated with check (
  bucket_id = 'media' and (
    public.is_admin()
    or ((storage.foldername(name))[1] = auth.uid()::text and public.has_delivered(auth.uid()))
  )
);
drop policy if exists media_del on storage.objects;
create policy media_del on storage.objects for delete to authenticated using (
  bucket_id = 'media' and (public.is_admin() or (storage.foldername(name))[1] = auth.uid()::text)
);

-- ---------- canlı güncelleme ----------
do $$ begin
  begin alter publication supabase_realtime add table public.docs; exception when others then null; end;
  begin alter publication supabase_realtime add table public.orders; exception when others then null; end;
end $$;

-- ---------- yöneticiyi tanımla ----------
-- Önce Authentication > Users > Add user ile bu e-postayla kullanıcı oluştur ("Auto Confirm User" işaretli).
-- Farklı bir e-posta kullanacaksan aşağıdaki adresi değiştir ve bu bölümü yeniden çalıştır.
insert into public.admins(user_id)
select id from auth.users
 where lower(email) = lower('bukettamac@gmail.com') and email_confirmed_at is not null
on conflict do nothing;

select case when exists(select 1 from public.admins)
  then 'Kurulum tamam. Yönetici tanımlı.'
  else 'Kurulum tamam, ama yönetici henüz tanımlı değil: önce kullanıcıyı oluştur, sonra bu dosyayı yeniden çalıştır.'
end as sonuc;
