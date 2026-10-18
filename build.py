# Regenera index.html a partir de playa-autos.jsx (uso: python3 build.py)
import re, pathlib
d = pathlib.Path(__file__).parent
jsx = (d / "playa-autos.jsx").read_text(encoding="utf-8")
assert "</script" not in jsx.lower(), "el JSX no puede contener </script>"
destino = d / "index.html" if (d / "index.html").exists() else d.parent / "web" / "index.html"
html = destino.read_text(encoding="utf-8")
a = html.index('<script type="text/babel" data-type="module" data-presets="react">')
b = html.index("</script>", a)
nuevo = ('<script type="text/babel" data-type="module" data-presets="react">\n'
         'import { createRoot as __createRoot } from "react-dom/client";\n'
         + jsx.rstrip() + '\n\n__createRoot(document.getElementById("root")).render(React.createElement(App));\n')
destino.write_text(html[:a] + nuevo + html[b:], encoding="utf-8")
print("index.html actualizado")
