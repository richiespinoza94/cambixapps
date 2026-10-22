-- ============================================================================
-- Pulso Cambiario · Registro de accesos (seguridad)
-- Requiere haber corrido antes supabase_auth_lock.sql (usa is_allowed_user()).
-- Corre este script en Supabase > SQL Editor. Es idempotente.
--
-- Que guarda: quien abrio el tablero (correo del token, no falseable), si tenia
-- acceso o no, IP y navegador (leidos en el servidor) y datos del dispositivo
-- que manda la web (navegador, sistema, tipo, pantalla, idioma, zona horaria).
-- Que NO guarda: contrasenas, contenido consultado ni cookies.
-- ============================================================================

create table if not exists public.access_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  email      text not null,
  allowed    boolean not null,
  ip         text,
  user_agent text,
  device     jsonb not null default '{}'::jsonb
);

create index if not exists idx_access_log_at       on public.access_log (at desc);
create index if not exists idx_access_log_email_at on public.access_log (email, at desc);

-- Cerrada para la web: solo se lee desde el SQL Editor.
alter table public.access_log enable row level security;
revoke all on table public.access_log from anon, authenticated;

-- La web llama a esta funcion al abrir. Registra y devuelve si tiene acceso.
--  - Sin sesion: no registra nada.
--  - Mismo correo + IP + navegador + resultado en 30 min: no repite la fila.
--  - Tope de 20 filas por correo por hora, para que nadie pueda llenar la tabla.
create or replace function public.register_access(p_device jsonb default '{}'::jsonb)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email   text    := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_allowed boolean := public.is_allowed_user();
  v_headers json    := coalesce(nullif(current_setting('request.headers', true), '')::json, '{}'::json);
  v_ip      text    := nullif(trim(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1)), '');
  v_ua      text    := left(v_headers ->> 'user-agent', 400);
  v_device  jsonb   := case
                         when p_device is not null
                          and jsonb_typeof(p_device) = 'object'
                          and pg_column_size(p_device) <= 2000
                         then p_device
                         else '{}'::jsonb
                       end;
begin
  if v_email = '' then
    return false;
  end if;

  if not exists (
       select 1 from public.access_log l
       where l.email = v_email
         and l.allowed = v_allowed
         and l.ip is not distinct from v_ip
         and l.user_agent is not distinct from v_ua
         and l.at > now() - interval '30 minutes'
     )
     and (select count(*) from public.access_log l
          where l.email = v_email and l.at > now() - interval '1 hour') < 20
  then
    insert into public.access_log (email, allowed, ip, user_agent, device)
    values (v_email, v_allowed, v_ip, v_ua, v_device);
  end if;

  return v_allowed;
end;
$$;

revoke all on function public.register_access(jsonb) from public, anon;
grant execute on function public.register_access(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Vistas para revisar (solo desde el SQL Editor)
-- ---------------------------------------------------------------------------

-- Ultimos accesos, en hora Lima.
create or replace view public.vw_access_recent as
select
  (at at time zone 'America/Lima')                        as hora_lima,
  email,
  case when allowed then 'ENTRO' else 'SIN ACCESO' end    as resultado,
  ip,
  device ->> 'type'                                       as tipo,
  device ->> 'os'                                         as sistema,
  device ->> 'browser'                                    as navegador,
  device ->> 'screen'                                     as pantalla,
  user_agent
from public.access_log
order by at desc;

-- Movimientos que conviene mirar (ultimos 7 dias).
--  INTENTO_SIN_ACCESO : cuenta que no esta autorizada intento entrar.
--  FUERA_DE_HORARIO   : acceso entre 22:00 y 05:59 hora Lima.
--  DISPOSITIVO_NUEVO  : primer acceso de un correo desde un navegador que no habia usado.
--  MUCHAS_IPS_24H     : 4 o mas IPs distintas para el mismo correo en 24 horas.
create or replace view public.vw_access_flags as
with ev as (
  select l.*, (l.at at time zone 'America/Lima') as at_lima
  from public.access_log l
  where l.at > now() - interval '7 days'
)
select at_lima, email, 'INTENTO_SIN_ACCESO'::text as alerta, ip, user_agent
from ev
where not allowed
union all
select at_lima, email, 'FUERA_DE_HORARIO', ip, user_agent
from ev
where allowed and (extract(hour from at_lima) >= 22 or extract(hour from at_lima) < 6)
union all
select ev.at_lima, ev.email, 'DISPOSITIVO_NUEVO', ev.ip, ev.user_agent
from ev
where ev.allowed
  and exists (select 1 from public.access_log o where o.email = ev.email and o.at < ev.at)
  and not exists (select 1 from public.access_log o
                  where o.email = ev.email and o.user_agent is not distinct from ev.user_agent and o.at < ev.at)
union all
select max(at_lima), email, 'MUCHAS_IPS_24H', string_agg(distinct ip, ', '), null::text
from ev
where allowed and at > now() - interval '24 hours' and ip is not null
group by email
having count(distinct ip) >= 4
order by 1 desc;

revoke all on table public.vw_access_recent, public.vw_access_flags from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Uso diario
-- ---------------------------------------------------------------------------
-- select * from public.vw_access_recent limit 100;
-- select * from public.vw_access_flags;
-- select email, count(*) accesos, count(distinct ip) ips, max(at) ultimo from public.access_log group by 1 order by 2 desc;

-- ---------------------------------------------------------------------------
-- Retencion: borra lo que pase de 180 dias (corrida manual o programada)
-- ---------------------------------------------------------------------------
-- delete from public.access_log where at < now() - interval '180 days';
--
-- Programada (Database > Extensions > activar pg_cron):
-- select cron.schedule('limpiar-access-log', '0 8 * * 0',
--   $$delete from public.access_log where at < now() - interval '180 days'$$);

-- ---------------------------------------------------------------------------
-- Pruebas (cada bloque por separado)
-- ---------------------------------------------------------------------------
-- A) Un correo del banco queda registrado como ENTRO:
-- begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims', '{"role":"authenticated","email":"prueba@bancom.pe"}', true);
--   select set_config('request.headers', '{"x-forwarded-for":"200.1.2.3, 10.0.0.1","user-agent":"prueba"}', true);
--   select public.register_access('{"browser":"Chrome","os":"Windows","type":"pc"}'::jsonb);
-- rollback;  -- cambia a commit si quieres conservar la fila de prueba
--
-- B) Un Gmail no autorizado queda como SIN ACCESO (y devuelve false):
-- begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims', '{"role":"authenticated","email":"intruso@gmail.com"}', true);
--   select public.register_access('{}'::jsonb);
-- rollback;
