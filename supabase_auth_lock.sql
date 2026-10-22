-- ============================================================================
-- Pulso Cambiario · Candado de acceso (login Google @bancom.pe)
-- Corre este script en Supabase > SQL Editor, DESPUES de desplegar la web nueva.
-- Es idempotente: puedes volver a correrlo sin romper nada.
-- ============================================================================

-- 1) Lista de excepciones (correos fuera de @bancom.pe que SI pueden entrar).
create table if not exists public.allowed_emails (
  email      text primary key,
  note       text,
  created_at timestamptz not null default now(),
  constraint allowed_emails_lowercase check (email = lower(email))
);

-- Nadie la toca desde la API: ni anon ni authenticated. Se edita solo desde el SQL Editor.
alter table public.allowed_emails enable row level security;
revoke all on table public.allowed_emails from anon, authenticated;

-- 2) Quien puede entrar: dominio @bancom.pe  O  correo en la lista de excepciones.
--    Lee el correo del token (JWT) que Supabase valida en cada pedido.
create or replace function public.is_allowed_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select lower(coalesce(auth.jwt() ->> 'email', '')) as email
  )
  select
    coalesce(auth.jwt() ->> 'role', '') = 'authenticated'
    and (
      me.email ~ '^[^@\s]+@bancom\.pe$'
      or exists (select 1 from public.allowed_emails a where a.email = me.email)
    )
  from me;
$$;

revoke all on function public.is_allowed_user() from public, anon;
grant execute on function public.is_allowed_user() to authenticated;

-- 3) La vista que lee la web: misma de siempre, pero ahora devuelve filas
--    solo si quien pregunta esta autorizado.
create or replace view public.vw_rates_public as
select
  captured_at,
  provider,
  provider_type,
  buy,
  sell,
  spread
from public.rates
where provider in ('CAMBIX','REXTIE','TKAMBIO','TUCAMBISTA','KAMBISTA','SUNAT')
  and buy > 0
  and sell > 0
  and public.is_allowed_user();

-- 4) El cierre: la llave publica (anon) ya no lee nada; solo usuarios con sesion.
revoke all on table public.vw_rates_public from anon, authenticated;
grant select on table public.vw_rates_public to authenticated;

-- ============================================================================
-- AGREGAR EXCEPCIONES (ejemplos, descomenta y cambia el correo)
-- ============================================================================
-- insert into public.allowed_emails (email, note) values ('alguien@gmail.com', 'Analitica - pruebas') on conflict do nothing;
-- delete from public.allowed_emails where email = 'alguien@gmail.com';
-- select * from public.allowed_emails order by created_at desc;

-- ============================================================================
-- PRUEBAS RAPIDAS (corre cada bloque por separado en el SQL Editor)
-- ============================================================================
-- A) Un correo del banco debe ver filas (cuenta > 0):
-- begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims', '{"role":"authenticated","email":"prueba@bancom.pe"}', true);
--   select count(*) from public.vw_rates_public;
-- rollback;
--
-- B) Un Gmail que NO esta en la lista debe ver 0 filas:
-- begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims', '{"role":"authenticated","email":"intruso@gmail.com"}', true);
--   select count(*) from public.vw_rates_public;
-- rollback;
--
-- C) Sin sesion (anon) debe fallar con "permission denied":
-- begin;
--   set local role anon;
--   select count(*) from public.vw_rates_public;
-- rollback;

-- ============================================================================
-- MARCHA ATRAS (solo si algo sale mal y necesitas reabrir la lectura publica)
-- ============================================================================
-- create or replace view public.vw_rates_public as
--   select captured_at, provider, provider_type, buy, sell, spread
--   from public.rates
--   where provider in ('CAMBIX','REXTIE','TKAMBIO','TUCAMBISTA','KAMBISTA','SUNAT') and buy > 0 and sell > 0;
-- grant select on table public.vw_rates_public to anon;
