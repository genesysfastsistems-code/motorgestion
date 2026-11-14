-- =====================================================================
--  MotorGestión — Seguridad de Supabase (login + aislamiento por empresa)
--  Ejecutar UNA vez en: Supabase → SQL Editor → New query → pegar → Run
--  Se puede volver a ejecutar sin problema (es idempotente).
-- =====================================================================

-- 0) Extensiones
create extension if not exists pgcrypto with schema extensions;

-- 1) Borrar TODAS las políticas anteriores (si había alguna abierta al público)
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies where schemaname = 'public' and tablename in ('registros', 'perfiles', 'respaldo') loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- 2) Tabla de perfiles (quién es cada usuario y a qué empresa pertenece)
create table if not exists public.perfiles (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  tenant_id text,
  rol       text not null default 'funcionario',
  email     text,
  usuario   text,
  nombre    text,
  permisos  jsonb not null default '{}'::jsonb,
  bloqueado boolean not null default false,
  temp      boolean not null default false,
  creado    timestamptz not null default now()
);
alter table public.perfiles add column if not exists tenant_id text;
alter table public.perfiles add column if not exists rol text;
alter table public.perfiles add column if not exists email text;
alter table public.perfiles add column if not exists usuario text;
alter table public.perfiles add column if not exists nombre text;
alter table public.perfiles add column if not exists permisos jsonb not null default '{}'::jsonb;
alter table public.perfiles add column if not exists bloqueado boolean not null default false;
alter table public.perfiles add column if not exists temp boolean not null default false;
alter table public.perfiles add column if not exists creado timestamptz not null default now();
alter table public.perfiles alter column tenant_id type text using tenant_id::text;
create unique index if not exists perfiles_user_id_uk on public.perfiles(user_id);
update public.perfiles set rol = 'admin' where rol = 'empresa' or rol is null;

-- Cuenta del desarrollador (dueño del sistema)
insert into public.perfiles (user_id, rol, email, nombre, tenant_id)
select id, 'dev', email, 'Desarrollador', null from auth.users where lower(email) = 'genesysfastsistems@gmail.com'
on conflict (user_id) do update set rol = 'dev', tenant_id = null, bloqueado = false;

-- 3) Tabla de registros (sincronización)
create table if not exists public.registros (
  pk         text primary key,
  coleccion  text not null,
  tenant_id  text,
  data       jsonb,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.registros alter column data type jsonb using data::jsonb;
create index if not exists registros_updated_idx on public.registros(updated_at);
create index if not exists registros_tenant_idx on public.registros(tenant_id);

-- La hora la pone el servidor (evita errores por relojes de celulares desfasados)
create or replace function public.mg_set_updated() returns trigger language plpgsql as $$
begin new.updated_at := clock_timestamp(); return new; end $$;
drop trigger if exists mg_updated on public.registros;
create trigger mg_updated before insert or update on public.registros for each row execute function public.mg_set_updated();

-- Completar tenant_id de registros viejos y borrar las claves guardadas en los datos
update public.registros set tenant_id = substr(pk, 14) where coleccion = 'suscriptores';
update public.registros set tenant_id = data->>'suscriptorId' where coleccion = 'pagosSusc' and data ? 'suscriptorId';
update public.registros set tenant_id = substr(pk, 6) where coleccion = 'cfgs' and tenant_id is null;
update public.registros set tenant_id = data->>'tenantId' where tenant_id is null and data ? 'tenantId';
update public.registros set data = data - 'pass' - 'temp' where coleccion in ('suscriptores', 'usuarios') and (data ? 'pass' or data ? 'temp');

-- 4) Funciones de ayuda (security definer: leen perfiles sin pasar por RLS)
create or replace function public.mg_rol() returns text language sql stable security definer set search_path = public as $$
  select rol from public.perfiles where user_id = auth.uid() and not bloqueado $$;
create or replace function public.mg_es_dev() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select rol = 'dev' from public.perfiles where user_id = auth.uid() and not bloqueado), false) $$;
create or replace function public.mg_tenant() returns text language sql stable security definer set search_path = public as $$
  select tenant_id from public.perfiles where user_id = auth.uid() and not bloqueado $$;
-- empresa del usuario, solo si NO está bloqueada ni vencida
create or replace function public.mg_tenant_activo() returns text language sql stable security definer set search_path = public as $$
  select p.tenant_id from public.perfiles p
  where p.user_id = auth.uid() and not p.bloqueado and p.tenant_id is not null
    and exists (
      select 1 from public.registros r
      where r.pk = 'suscriptores:' || p.tenant_id and not r.deleted
        and coalesce((r.data->>'bloqueado')::boolean, false) = false
        and (coalesce(r.data->>'plan', '') = 'Único pago'
             or coalesce(nullif(r.data->>'vence', '')::date >= current_date, true))
    ) $$;

-- 4b) Permisos por módulo
-- ¿El usuario actual puede escribir en esta colección?
--  admin/dev: todo · funcionario: según sus permisos (módulos tildados)
create or replace function public.mg_puede_col(p_col text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p.rol in ('admin', 'dev') then true
    when p_col in ('actividad', 'papelera') then true                       -- registro de actividad y papelera: cualquiera de la empresa
    when p_col in ('cfgs', 'usuarios', 'suscriptores', 'pagosSusc') then false
    else exists (
      select 1 from jsonb_each_text(coalesce(p.permisos, '{}'::jsonb)) e
      where e.value = 'true' and e.key = any (case p_col
        when 'vehiculos' then array['stock', 'taller', 'legal', 'ventas', 'reservas']
        when 'clientes'  then array['clientes', 'ventas', 'reservas', 'cobranza']
        when 'ventas'    then array['ventas', 'cobranza', 'clientes']
        when 'caja'      then array['caja', 'ventas', 'cobranza', 'clientes', 'reservas', 'cxp', 'reportes']
        when 'reservas'  then array['reservas']
        when 'notas'     then array['notas']
        when 'cxp'       then array['cxp']
        else array[]::text[] end))
  end
  from public.perfiles p where p.user_id = auth.uid() and not p.bloqueado $$;
revoke all on function public.mg_puede_col(text) from public, anon;
grant execute on function public.mg_puede_col(text) to authenticated;


-- 5) RLS en registros
alter table public.registros enable row level security;
create policy mg_reg_select on public.registros for select to authenticated using (
  (select public.mg_es_dev())
  or tenant_id = (select public.mg_tenant_activo())
  or (coleccion = 'suscriptores' and tenant_id = (select public.mg_tenant()))   -- la empresa ve su propia suscripción (para saber si está bloqueada)
);
create policy mg_reg_insert on public.registros for insert to authenticated with check (
  (select public.mg_es_dev())
  or (tenant_id = (select public.mg_tenant_activo())
      and coleccion not in ('suscriptores', 'pagosSusc')
      and public.mg_puede_col(coleccion))
);
create policy mg_reg_update on public.registros for update to authenticated using (
  (select public.mg_es_dev())
  or (tenant_id = (select public.mg_tenant_activo())
      and coleccion not in ('suscriptores', 'pagosSusc')
      and public.mg_puede_col(coleccion))
) with check (
  (select public.mg_es_dev())
  or (tenant_id = (select public.mg_tenant_activo())
      and coleccion not in ('suscriptores', 'pagosSusc')
      and public.mg_puede_col(coleccion))
);

-- (sin política DELETE: los borrados son lógicos, deleted = true)

-- 6) RLS en perfiles
alter table public.perfiles enable row level security;
create policy mg_perf_select on public.perfiles for select to authenticated using (
  user_id = auth.uid()
  or (select public.mg_es_dev())
  or ((select public.mg_rol()) = 'admin' and tenant_id = (select public.mg_tenant()))
);
create policy mg_perf_insert on public.perfiles for insert to authenticated with check (
  (select public.mg_es_dev())
  or ((select public.mg_rol()) = 'admin' and tenant_id = (select public.mg_tenant_activo()) and rol in ('admin', 'funcionario'))
);
create policy mg_perf_update on public.perfiles for update to authenticated using (
  (select public.mg_es_dev())
  or ((select public.mg_rol()) = 'admin' and tenant_id = (select public.mg_tenant_activo()) and rol <> 'dev' and user_id <> auth.uid())
) with check (
  (select public.mg_es_dev())
  or ((select public.mg_rol()) = 'admin' and tenant_id = (select public.mg_tenant_activo()) and rol in ('admin', 'funcionario'))
);

-- 7) Tabla vieja "respaldo" (copia completa en una fila): solo el desarrollador
do $$ begin
  if to_regclass('public.respaldo') is not null then
    execute 'alter table public.respaldo enable row level security';
    execute 'create policy mg_resp_dev on public.respaldo for all to authenticated using ((select public.mg_es_dev())) with check ((select public.mg_es_dev()))';
  end if;
end $$;

-- 8) Cambiar contraseña (propia, o de un usuario de mi empresa si soy admin, o de cualquiera si soy dev)
create or replace function public.mg_cambiar_clave(p_user uuid, p_clave text) returns void
language plpgsql security definer set search_path = public, auth, extensions as $$
declare v perfiles%rowtype;
begin
  if p_clave is null or length(p_clave) < 6 then raise exception 'La contraseña debe tener al menos 6 caracteres'; end if;
  select * into v from public.perfiles where user_id = p_user;
  if not found then raise exception 'Usuario inexistente'; end if;
  if not (p_user = auth.uid()
          or public.mg_es_dev()
          or (public.mg_rol() = 'admin' and v.tenant_id = public.mg_tenant() and v.rol <> 'dev')) then
    raise exception 'Sin permiso' using errcode = '42501';
  end if;
  update auth.users set encrypted_password = extensions.crypt(p_clave, extensions.gen_salt('bf')), updated_at = now() where id = p_user;
  update public.perfiles set temp = (p_user <> auth.uid()) where user_id = p_user;
end $$;

-- 9) Eliminar un usuario (admin de su empresa o dev)
create or replace function public.mg_eliminar_usuario(p_user uuid) returns void
language plpgsql security definer set search_path = public, auth as $$
declare v perfiles%rowtype;
begin
  select * into v from public.perfiles where user_id = p_user;
  if not found then return; end if;
  if p_user = auth.uid() then raise exception 'No podés eliminar tu propio usuario'; end if;
  if not (public.mg_es_dev() or (public.mg_rol() = 'admin' and v.tenant_id = public.mg_tenant() and v.rol <> 'dev')) then
    raise exception 'Sin permiso' using errcode = '42501';
  end if;
  delete from public.perfiles where user_id = p_user;
  delete from auth.users where id = p_user;
end $$;

-- 10) Eliminar todos los accesos de una empresa (solo dev)
create or replace function public.mg_eliminar_empresa(p_tenant text) returns void
language plpgsql security definer set search_path = public, auth as $$
declare ids uuid[];
begin
  if not public.mg_es_dev() then raise exception 'Sin permiso' using errcode = '42501'; end if;
  select array_agg(user_id) into ids from public.perfiles where tenant_id = p_tenant and rol <> 'dev';
  delete from public.perfiles where tenant_id = p_tenant and rol <> 'dev';
  if ids is not null then delete from auth.users where id = any(ids); end if;
end $$;

revoke all on function public.mg_cambiar_clave(uuid, text), public.mg_eliminar_usuario(uuid), public.mg_eliminar_empresa(text) from public, anon;
grant execute on function public.mg_cambiar_clave(uuid, text), public.mg_eliminar_usuario(uuid), public.mg_eliminar_empresa(text) to authenticated;
grant select, insert, update on public.registros, public.perfiles to authenticated;

-- Verificación rápida (debe mostrar tu cuenta con rol = dev)
select user_id, email, rol, tenant_id from public.perfiles order by creado;
