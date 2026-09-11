-- Pulso Cambiario - vista minima de lectura para el frontend.
-- Este script NO toca ni revoca permisos existentes de public.rates para evitar
-- romper otros consumidores. La revision completa de grants/RLS debe hacerse
-- antes de produccion si rates hoy ya esta expuesta a anon/authenticated.

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
  and sell > 0;

-- Acceso de solo lectura para un navegador sin login usando Publishable Key.
revoke all on table public.vw_rates_public from anon, authenticated;
grant select on table public.vw_rates_public to anon;

-- Indice recomendado para el historico. No cambia datos.
create index if not exists idx_rates_provider_time
  on public.rates (provider, captured_at desc);
