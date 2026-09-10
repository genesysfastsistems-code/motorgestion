# MotorGestión — Publicar en GitHub Pages

Sistema de gestión para playa de venta de autos (stock, ventas, cobranza, caja, reportes y más).
Es una web autónoma: no necesita compilar. Solo subís estos archivos.

## Archivos de esta carpeta
- `index.html` — la aplicación completa
- `manifest.webmanifest` — para instalarla como app (PWA)
- `sw.js` — service worker (permite instalarla y cargar más rápido)
- `icon.svg` — ícono de la app

## Pasos para publicar en GitHub Pages
1. Entrá a https://github.com y creá una cuenta (si no tenés).
2. Arriba a la derecha: **+ → New repository**.
   - Repository name: por ejemplo `motorgestion`
   - Marcá **Public** y creá el repo.
3. En el repo nuevo, hacé clic en **Add file → Upload files** y **arrastrá los 4 archivos**
   (`index.html`, `manifest.webmanifest`, `sw.js`, `icon.svg`). Luego **Commit changes**.
4. Andá a **Settings** (del repo) → menú lateral **Pages**.
   - En **Source** elegí **Deploy from a branch**.
   - En **Branch** elegí **main** y carpeta **/ (root)** → **Save**.
5. Esperá ~1 minuto. Arriba aparecerá el link, del tipo:
   **https://TU-USUARIO.github.io/motorgestion/**
6. ¡Listo! Ese link ya es tu sistema online. Compartilo o abrilo desde cualquier dispositivo.

## Instalar como app en el celular
- Abrí el link en **Chrome (Android)** o **Safari (iPhone)**.
- Menú del navegador → **"Agregar a pantalla de inicio"** / **"Instalar app"**.
- Queda como una app con su ícono, a pantalla completa.

## Acceso
- **Desarrollador (dueño del sistema):** pestaña *Desarrollador* → usuario `admin` / contraseña `99147685`.
  Desde ahí creás las empresas-cliente con su usuario y contraseña.
- **Empresa (playa de autos):** entra con el usuario/contraseña que le diste; la primera vez cambia su clave.

## IMPORTANTE sobre los datos
- Los datos se guardan **en el navegador de cada dispositivo** (localStorage).
- **No se comparten** entre celulares/PCs ni hay respaldo en la nube automático.
- Usá **Ajustes → Descargar copia (JSON)** seguido para no perder información.
- Para uso multiusuario en tiempo real (varios dispositivos con los mismos datos) hace falta un
  **backend** (por ejemplo Firebase o Supabase) — es el siguiente paso si lo necesitás.

## Nota
- Para PDFs, permití las **ventanas emergentes** en el navegador.
- La cotización por internet depende de la conexión; si falla, cargá el valor manual en Ajustes.
