-- ATORCH Tuya Monitor: tables, views and retention function.
-- Run it once in the Supabase SQL Editor (or with the Supabase CLI).
--
-- TIME ZONE / ZONA HORARIA: hours and days are grouped in Europe/Madrid.
-- If you live elsewhere, replace every 'Europe/Madrid' in this file with your
-- IANA zone (e.g. 'America/Mexico_City') BEFORE running it, and set the same
-- value in TIMEZONE in wrangler.toml.
-- Si vives en otra zona, sustituye todos los 'Europe/Madrid' de este archivo
-- ANTES de ejecutarlo y pon el mismo valor en TIMEZONE de wrangler.toml.

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------
create table public.energy_readings (
  id           bigserial primary key,
  ts           timestamptz not null default now(),
  power_w      numeric,
  voltage_v    numeric,
  current_a    numeric,
  power_factor numeric,
  frequency_hz numeric,
  energy_kwh   numeric,
  relay_on     boolean,
  raw          jsonb
);
create index energy_readings_ts_idx on public.energy_readings (ts);

create table public.energy_errors (
  id      bigserial primary key,
  ts      timestamptz not null default now(),
  stage   text not null,
  message text not null
);
create index energy_errors_ts_idx on public.energy_errors (ts);

-- Resumen diario de las lecturas que ya se han borrado por antigüedad.
create table public.energy_daily_archive (
  day           date primary key,
  kwh           numeric,
  kwh_counter   numeric,
  kwh_estimated numeric,
  samples       bigint not null,
  avg_power_w   numeric,
  max_power_w   numeric
);

-- ---------------------------------------------------------------------------
-- Vistas
-- ---------------------------------------------------------------------------
-- Energía de cada intervalo entre dos lecturas consecutivas.
-- kwh_counter: diferencia del contador; es NULL si falta o si el contador baja (reinicio).
-- kwh_estimated: media de power_w por tiempo; es NULL en huecos de más de 15 min,
-- para no inventar consumo durante un corte.
create view public.energy_intervals with (security_invoker = true) as
with d as (
  select
    ts,
    power_w,
    energy_kwh,
    lag(ts)         over w as prev_ts,
    lag(power_w)    over w as prev_power_w,
    lag(energy_kwh) over w as prev_energy_kwh
  from public.energy_readings
  window w as (order by ts)
)
select
  ts,
  prev_ts,
  power_w,
  case when energy_kwh >= prev_energy_kwh then energy_kwh - prev_energy_kwh end as kwh_counter,
  case when ts - prev_ts <= interval '15 minutes' then
    (coalesce(power_w, prev_power_w) + coalesce(prev_power_w, power_w)) / 2
      * extract(epoch from ts - prev_ts) / 3600000
  end as kwh_estimated
from d;

create view public.energy_hourly with (security_invoker = true) as
select
  date_trunc('hour', ts, 'Europe/Madrid') as hour_start,
  sum(coalesce(kwh_counter, kwh_estimated)) as kwh,
  sum(kwh_counter)   as kwh_counter,
  sum(kwh_estimated) as kwh_estimated,
  count(*)           as samples,
  avg(power_w)       as avg_power_w,
  max(power_w)       as max_power_w
from public.energy_intervals
group by 1;

-- Incluye los días ya archivados: las lecturas se borran por días completos,
-- así que un día nunca sale a la vez de las dos fuentes.
create view public.energy_daily with (security_invoker = true) as
select
  (ts at time zone 'Europe/Madrid')::date as day,
  sum(coalesce(kwh_counter, kwh_estimated)) as kwh,
  sum(kwh_counter)   as kwh_counter,
  sum(kwh_estimated) as kwh_estimated,
  count(*)           as samples,
  avg(power_w)       as avg_power_w,
  max(power_w)       as max_power_w,
  false              as archived
from public.energy_intervals
group by 1
union all
select day, kwh, kwh_counter, kwh_estimated, samples, avg_power_w, max_power_w, true
from public.energy_daily_archive;

-- ---------------------------------------------------------------------------
-- Retención
-- ---------------------------------------------------------------------------
-- Borra las lecturas y los errores anteriores a p_keep_months, cortando en días
-- completos. Con p_aggregate = true guarda antes el resumen diario de las lecturas.
create function public.energy_purge_old_data(
  p_keep_months integer default 12,
  p_aggregate   boolean default true
)
returns table (days_archived bigint, readings_deleted bigint, errors_deleted bigint)
language plpgsql
set search_path = ''
as $$
declare
  v_cutoff timestamptz;
begin
  if p_keep_months is null or p_keep_months < 1 then
    raise exception 'p_keep_months debe ser 1 o más';
  end if;

  v_cutoff := date_trunc('day', now() - make_interval(months => p_keep_months), 'Europe/Madrid');
  days_archived := 0;

  if p_aggregate then
    insert into public.energy_daily_archive as a
      (day, kwh, kwh_counter, kwh_estimated, samples, avg_power_w, max_power_w)
    select
      (ts at time zone 'Europe/Madrid')::date,
      sum(coalesce(kwh_counter, kwh_estimated)),
      sum(kwh_counter),
      sum(kwh_estimated),
      count(*),
      avg(power_w),
      max(power_w)
    from public.energy_intervals
    where ts < v_cutoff
    group by 1
    on conflict (day) do update set
      kwh           = coalesce(a.kwh, 0) + coalesce(excluded.kwh, 0),
      kwh_counter   = coalesce(a.kwh_counter, 0) + coalesce(excluded.kwh_counter, 0),
      kwh_estimated = coalesce(a.kwh_estimated, 0) + coalesce(excluded.kwh_estimated, 0),
      avg_power_w   = (coalesce(a.avg_power_w, 0) * a.samples
                       + coalesce(excluded.avg_power_w, 0) * excluded.samples)
                      / (a.samples + excluded.samples),
      max_power_w   = greatest(a.max_power_w, excluded.max_power_w),
      samples       = a.samples + excluded.samples;
    get diagnostics days_archived = row_count;
  end if;

  delete from public.energy_readings where ts < v_cutoff;
  get diagnostics readings_deleted = row_count;

  delete from public.energy_errors where ts < v_cutoff;
  get diagnostics errors_deleted = row_count;

  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Seguridad: RLS activado, sin políticas públicas. Solo service_role tiene acceso.
-- ---------------------------------------------------------------------------
alter table public.energy_readings      enable row level security;
alter table public.energy_errors        enable row level security;
alter table public.energy_daily_archive enable row level security;

revoke all on public.energy_readings, public.energy_errors, public.energy_daily_archive,
              public.energy_intervals, public.energy_hourly, public.energy_daily
  from anon, authenticated;
grant all on public.energy_readings, public.energy_errors, public.energy_daily_archive
  to service_role;
grant select on public.energy_intervals, public.energy_hourly, public.energy_daily
  to service_role;
grant usage, select on sequence public.energy_readings_id_seq, public.energy_errors_id_seq
  to service_role;

revoke all on function public.energy_purge_old_data(integer, boolean)
  from public, anon, authenticated;
grant execute on function public.energy_purge_old_data(integer, boolean) to service_role;
