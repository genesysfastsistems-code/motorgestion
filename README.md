# MotorGestión

Sistema de gestión para playas de venta de autos: stock, ventas, cobranza, caja, reportes y más.
Es una web sin compilación que se publica en GitHub Pages. Los datos se guardan en Supabase.

## Archivos
- `index.html`: la aplicación completa (se genera desde `playa-autos.jsx`).
- `playa-autos.jsx`: el código fuente que se edita.
- `build.py`: regenera `index.html` después de editar el JSX (`python3 build.py`).
- `supabase-seguridad.sql`: login y aislamiento por empresa en Supabase.
- `sw.js`, `manifest.webmanifest`, `icon.svg`: archivos para instalarla como app (PWA).

## Seguridad (cómo funciona)
- Todos ingresan con **usuario o email + contraseña**, validados por **Supabase Auth**.
  - Un usuario sin "@" se convierte internamente en `usuario@motorgestion.app`.
- Cada cuenta tiene un **perfil** con su empresa (`tenant_id`) y su rol: `dev`, `admin` o `funcionario`.
- Las **políticas RLS** de Supabase hacen que:
  - cada empresa lea y escriba **solo sus datos**;
  - una empresa bloqueada o vencida no acceda a nada;
  - solo el desarrollador gestione empresas y cobros;
  - solo el admin de cada empresa cambie Ajustes y usuarios.
- No hay contraseñas en el código ni en los datos.

## Configurar Supabase (una sola vez)
1. Supabase → **SQL Editor** → pegar `supabase-seguridad.sql` → **Run**.
   - Al final debe aparecer tu cuenta con `rol = dev`.
2. Supabase → **Authentication → Sign In / Providers → Email**:
   - **Confirm email**: desactivado (los usuarios sin email real no pueden confirmar).
   - **Allow new users to sign up**: activado (así el sistema crea las cuentas).
     Quien se registre por fuera no tiene perfil y no ve nada.

## Publicar en GitHub Pages
- Subir los archivos al repo → **Settings → Pages** → Branch `main`, carpeta `/ (root)`.
- Las actualizaciones llegan solas: el `sw.js` busca primero la versión nueva.

## Primer ingreso después de la actualización
- **Desarrollador**: entra con su email de Supabase (ya no existe `admin` fijo).
- **Empresas creadas antes** aparecen como **"SIN ACCESO NUBE"**:
  - tocá **Crear acceso** y entregá la contraseña temporal;
  - al entrar, la empresa la cambia.
- **Funcionarios creados antes**: el admin de cada empresa toca **Crear acceso** en Ajustes → Usuarios.

## Instalar como app en el celular
- Abrí el link en Chrome (Android) o Safari (iPhone).
- En el menú del navegador elegí **Agregar a pantalla de inicio**.

## Notas
- Para los PDF, permití las ventanas emergentes.
- Copia propia: **Ajustes → Descargar copia (JSON)**.
