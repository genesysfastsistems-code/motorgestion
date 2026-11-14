-- =====================================================================
--  MotorGestión — Permisos por módulo en el servidor (mejora nov 2026)
--  Requiere haber ejecutado antes supabase-seguridad.sql.
--  Ejecutar en: Supabase → SQL Editor → New query → pegar → Run (se puede repetir)
-- =====================================================================

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

drop policy if exists mg_reg_insert on public.registros;
drop policy if exists mg_reg_update on public.registros;
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

-- Verificación: debe devolver true (sos dev)
select public.mg_puede_col('vehiculos') as puedo_como_dev;
