# Regenera index.html a partir de playa-autos.jsx (uso: python3 build.py)
# El JSX va dentro de index.html como texto. Al abrir la app:
#  - si ya está compilado en la caché del navegador, arranca directo (rápido, sin descargar Babel);
#  - si no (primera vez o versión nueva), descarga Babel, compila una sola vez y guarda el resultado.
import pathlib, re
d = pathlib.Path(__file__).parent
jsx = (d / "playa-autos.jsx").read_text(encoding="utf-8")
assert "</script" not in jsx.lower(), "el JSX no puede contener </script>"
destino = d / "index.html" if (d / "index.html").exists() else d.parent / "web" / "index.html"
html = destino.read_text(encoding="utf-8")

LOADER = r"""<script>
(function () {
  var BABEL = "https://unpkg.com/@babel/standalone@7.25.6/babel.min.js";
  var src = document.getElementById("mg-src").textContent;
  var h = 2166136261; for (var i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = Math.imul(h, 16777619); }
  var clave = "/__mg_js/" + (h >>> 0).toString(36) + "-" + src.length;
  function msg(t) { var c = document.getElementById("cargando-txt") || document.getElementById("cargando"); if (c) c.textContent = t; }
  function arrancar(js) { var s = document.createElement("script"); s.type = "module"; s.src = URL.createObjectURL(new Blob([js], { type: "text/javascript" })); document.body.appendChild(s); }
  function compilar() {
    msg("Preparando MotorGestión… (solo la primera vez)");
    var t = document.createElement("script"); t.src = BABEL;
    t.onload = function () {
      var js;
      try { js = Babel.transform(src, { presets: ["react"], sourceType: "module" }).code; }
      catch (e) { msg("Error al preparar la aplicación: " + e.message); return; }
      arrancar(js);
      if (window.caches) caches.open("mg-js").then(function (c) {
        return c.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return c.delete(k); })); })
          .then(function () { return c.put(clave, new Response(js, { headers: { "Content-Type": "text/javascript" } })); });
      }).catch(function () {});
    };
    t.onerror = function () { msg("No se pudo cargar. Revisá tu conexión a internet."); };
    document.head.appendChild(t);
  }
  if (!window.caches) return compilar();
  caches.open("mg-js").then(function (c) { return c.match(clave); })
    .then(function (r) { return r ? r.text() : null; })
    .then(function (js) { if (js) arrancar(js); else compilar(); })
    .catch(compilar);
})();
</script>"""

cuerpo = ('<script type="text/plain" id="mg-src">\n'
          'import { createRoot as __createRoot } from "react-dom/client";\n'
          + jsx.rstrip() + '\n\n__createRoot(document.getElementById("root")).render(React.createElement(App));\n'
          '</script>\n' + LOADER)

# quitar Babel de la cabecera (ahora se carga solo si hace falta)
html = re.sub(r'<script src="https://unpkg\.com/@babel/standalone@[^"]+"></script>\n?', "", html)
# reemplazar el bloque de código (formato viejo text/babel o nuevo text/plain + cargador)
m = re.search(r'<script type="text/babel"[^>]*>.*?</script>', html, re.S)
if m:
    html = html[:m.start()] + cuerpo + html[m.end():]
else:
    a = html.index('<script type="text/plain" id="mg-src">')
    b = html.index("})();\n</script>", a) + len("})();\n</script>")
    html = html[:a] + cuerpo + html[b:]
destino.write_text(html, encoding="utf-8")
print("index.html actualizado")
