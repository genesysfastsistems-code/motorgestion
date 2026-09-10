import React, { useState, useEffect, useMemo, useRef } from "react";

/* ============================================================
   PLAYA DE AUTOS — Plataforma multi-empresa (prototipo)
   DESARROLLADOR (aparte): crea empresas-cliente, planes, cobros, bloqueo.
   SISTEMA (por empresa): Stock · Clientes · Ventas · Cobranza · IVA · Legal · Ajustes.
   Roles: administrador (todo) y funcionario (permisos elegidos).
   ⚠ Auth de prototipo (sin cifrado real). Producción: backend.
   ============================================================ */

const KEY = "playa_autos_v4";
async function loadDB() { try { const r = await window.storage.get(KEY); return r ? JSON.parse(r.value) : null; } catch { return null; } }
async function saveDB(db) { try { await window.storage.set(KEY, JSON.stringify(db)); } catch {} }

// ---------- Supabase (respaldo en la nube) ----------
const SB_URL = "https://xyrmjbfaakvfnriijiwx.supabase.co";
const SB_KEY = "sb_publishable_jz-Je03pSDgc4dVtH81ZnQ_e8gMdFxL";
const SB_ROW = "motorgestion";
const sbHeaders = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" };
async function subirNube(db) {
  const body = JSON.stringify([{ id: SB_ROW, data: db, updated: new Date().toISOString() }]);
  const r = await fetch(`${SB_URL}/rest/v1/respaldo?on_conflict=id`, { method: "POST", headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" }, body });
  if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 120));
  return true;
}
async function bajarNube() {
  const r = await fetch(`${SB_URL}/rest/v1/respaldo?id=eq.${SB_ROW}&select=data,updated`, { headers: sbHeaders });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  return j && j[0] ? j[0] : null;
}

const uid = () => Math.random().toString(36).slice(2, 9);
const tempPass = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const today = () => new Date().toISOString().slice(0, 10);
const ahora = () => new Date().toLocaleString("es-PY");
const nf = new Intl.NumberFormat("es-PY");
const money = (v, m) => m === "USD" ? "US$ " + new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(v || 0) : "Gs " + nf.format(Math.round(v || 0));
const toGs = (amt, mon, cfg) => (mon === "USD" ? (amt || 0) * (cfg.cotizacion || 1) : amt || 0);
const diasEntre = (desde, hasta) => Math.max(0, Math.floor((new Date(hasta) - new Date(desde)) / 864e5));
function calcMora(c, tasaMensual) { const dias = diasEntre(c.venc, today()); return { dias, monto: Math.round((c.monto || 0) * ((tasaMensual || 0) / 100 / 30) * dias) }; }

const PROCEDENCIA = ["Iquique (vía Chile)", "Importación directa", "Local"];
const COMBUSTIBLE = ["Nafta", "Diésel", "Flex", "Híbrido", "Eléctrico"];
const CONDICION = ["Excelente", "Muy bueno", "Bueno", "Regular", "Para reparar"];
const GASTOS_FIJOS = [["despacho", "Despacho aduanero"], ["flete", "Flete"], ["taller", "Reparación taller"], ["pintura", "Pintura"], ["escribania", "Escribanía"], ["otros", "Otros"]];
const PERMS = [["inicio", "Inicio"], ["stock", "Stock"], ["taller", "Taller"], ["clientes", "Clientes"], ["reservas", "Reservas"], ["ventas", "Ventas"], ["cobranza", "Cobranza"], ["caja", "Caja"], ["cxp", "Por pagar"], ["fact", "Facturación"], ["reportes", "Reportes"], ["notas", "Notas"], ["legal", "Legal"]];
const PLANES = ["Mensual", "Anual", "Único pago"];
const allPerms = () => Object.fromEntries(PERMS.map(([k]) => [k, true]));

const CFG0 = { moneda: "Gs", cotizacion: 7300, cotizacionFecha: null, iva: 10, tasaMora: 3, comision: 0, empresa: { nombre: "", tel: "", dir: "", ciudad: "Ciudad del Este", logo: null } };

async function fetchCotizacion() {
  const fuentes = [
    async () => { const r = await fetch("https://open.er-api.com/v6/latest/USD"); const j = await r.json(); return j && j.rates && j.rates.PYG; },
    async () => { const r = await fetch("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json"); const j = await r.json(); return j && j.usd && j.usd.pyg; },
    async () => { const r = await fetch("https://api.exchangerate.host/latest?base=USD&symbols=PYG"); const j = await r.json(); return j && j.rates && j.rates.PYG; },
    async () => { const r = await fetch("https://latest.currency-api.pages.dev/v1/currencies/usd.json"); const j = await r.json(); return j && j.usd && j.usd.pyg; },
  ];
  for (const f of fuentes) { try { const v = await f(); if (v && v > 1000) return Math.round(v); } catch {} }
  throw new Error("sin dato");
}

function costoTotal(v) {
  const g = v.gastos || {};
  const base = (+v.precioCompra || 0) + GASTOS_FIJOS.reduce((a, [k]) => a + (+g[k] || 0), 0);
  const extra = (v.gastosExtra || []).reduce((a, x) => a + (+x.monto || 0), 0);
  return base + extra;
}
const margen = (v) => (+v.precioVenta || 0) - costoTotal(v);
const margenPct = (v) => { const c = costoTotal(v); return c ? (margen(v) / c) * 100 : 0; };

function generarPlan(monto, entrega, nCuotas, tasaAnual, fechaBase) {
  const capital = Math.max(0, monto - entrega);
  const i = (tasaAnual / 100) / 12;
  let cuota = i === 0 ? capital / nCuotas : (capital * i) / (1 - Math.pow(1 + i, -nCuotas));
  const plan = []; const d = new Date(fechaBase || today());
  for (let k = 1; k <= nCuotas; k++) { const fv = new Date(d); fv.setMonth(fv.getMonth() + k); plan.push({ n: k, venc: fv.toISOString().slice(0, 10), monto: Math.round(cuota), pagado: false, fechaPago: null, moraPagada: 0, diasAtrasoPago: 0 }); }
  return { capital, cuota: Math.round(cuota), plan };
}
function deudaVenta(venta, tasaMora, cot) {
  const c1 = cot || 7300;
  const pend = venta.plan.filter((c) => !c.pagado);
  const capital = pend.reduce((a, c) => a + c.monto, 0);
  const abonado = pend.reduce((a, c) => { const ab = c.abonadoGs || 0; return a + (venta.moneda === "USD" ? ab / c1 : ab); }, 0);
  const venc = pend.filter((c) => c.venc < today());
  const mora = venc.reduce((a, c) => a + calcMora(c, tasaMora).monto, 0);
  const total = Math.max(0, capital + mora - abonado);
  return { capital: Math.max(0, capital - abonado), mora, total, vencidas: venc.length, moneda: venta.moneda };
}

// ---------- theme ----------
const C = { bg: "#0a1424", panel: "#101d33", panel2: "#16243d", border: "#22334f", txt: "#eaf0fb", dim: "#8ea3c6", acc: "#2b7bff", ok: "#22d39a", warn: "#f5a623", bad: "#ff5c62", dev: "#7c6cff" };
const BGGRAD = `radial-gradient(1100px 520px at 85% -15%, #14345f 0%, ${C.bg} 55%)`;
const box = { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: "0 1px 3px rgba(0,0,0,.28)" };
function Btn({ children, onClick, kind = "def", small, style }) {
  const grad = { acc: `linear-gradient(135deg, ${C.acc}, #1f63d8)`, ok: `linear-gradient(135deg, ${C.ok}, #14b07f)`, dev: `linear-gradient(135deg, ${C.dev}, #5b49d6)` };
  const bg = grad[kind] || (kind === "ghost" ? "transparent" : C.panel2);
  const colored = !!grad[kind];
  return <button onClick={onClick} style={{ background: bg, color: kind === "ghost" ? C.dim : "#fff", border: `1px solid ${colored ? "transparent" : (kind === "ghost" ? C.border : C.panel2)}`, borderRadius: 9, padding: small ? "6px 11px" : "9px 15px", cursor: "pointer", fontSize: small ? 12 : 13, fontWeight: 600, boxShadow: colored ? "0 2px 8px rgba(0,0,0,.28)" : "none", ...style }}>{children}</button>;
}
const Field = ({ label, children }) => <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: C.dim }}>{label}{children}</label>;
const inp = { background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, color: C.txt, padding: "8px 10px", fontSize: 13, width: "100%", boxSizing: "border-box" };
const SubT = ({ children }) => <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: C.acc, margin: "10px 0 6px" }}>{children}</div>;
const Kpi = ({ t, v, c, onClick }) => <div onClick={onClick} className={onClick ? "kpi-click" : ""} style={{ ...box, padding: 14, borderTop: `2px solid ${c || C.acc}`, cursor: onClick ? "pointer" : "default", position: "relative" }}><div style={{ fontSize: 11, color: C.dim, textTransform: "uppercase", letterSpacing: 0.5 }}>{t}</div><div style={{ fontSize: 18, fontWeight: 700, color: c || C.txt, marginTop: 4 }}>{v}</div>{onClick && <div style={{ position: "absolute", top: 12, right: 12, color: C.dim, fontSize: 14 }}>›</div>}</div>;
const Rows = ({ rows }) => <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>{rows.map(([k, val], i) => <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}><span style={{ color: C.dim }}>{k}</span><span>{val}</span></div>)}</div>;
const Empty = ({ t }) => <div style={{ ...box, padding: 34, textAlign: "center", color: C.dim }}><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke={C.border} strokeWidth="1.6" style={{ marginBottom: 8 }}><path d="M3 8l9-5 9 5v8l-9 5-9-5V8z" /><path d="M3 8l9 5 9-5M12 13v9" strokeLinecap="round" strokeLinejoin="round" /></svg><div style={{ fontSize: 14 }}>{t}</div></div>;
function Titulo({ icon, children, sub }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 16 }}>
      <div style={{ width: 36, height: 36, borderRadius: 10, background: `linear-gradient(135deg, ${C.acc}, #123a86)`, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 2px 10px ${C.acc}44` }}><Ico name={icon} size={19} /></div>
      <div><div style={{ fontSize: 19, fontWeight: 800, lineHeight: 1.1 }}>{children}</div>{sub && <div style={{ fontSize: 12, color: C.dim }}>{sub}</div>}</div>
    </div>
  );
}
const th = { padding: "9px 12px", fontWeight: 600, fontSize: 12 };
const td = { padding: "9px 12px" };
const Modal = ({ children, onClose, w = 720 }) => <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}><div style={{ ...box, background: C.panel, width: w, maxHeight: "90vh", overflow: "auto", padding: 20 }}>{children}</div></div>;
const readFile = (file) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
function CarIcon({ size = 20, color = "#fff", wheel = "#123a86", glass = "#1e63d6" }) {
  const h = Math.round(size * 30 / 48);
  return (
    <svg viewBox="0 0 48 30" width={size} height={h} style={{ display: "block" }}>
      <path d="M4.5 19.6c0-1.9 1-3 2.9-3.3l2.8-.4 3.1-4.2c.9-1.2 1.9-1.9 3.1-1.9h9c1.3 0 2.5.6 3.3 1.6l3.4 4.4 3.5.7c1.9.4 3.1 1.7 3.1 3.5v1.3c0 .8-.6 1.4-1.4 1.4h-2.1a5 5 0 0 0-9.8 0H17.8a5 5 0 0 0-9.8 0H5.9c-.8 0-1.4-.6-1.4-1.4v-1.4z" fill={color} />
      <path d="M16.3 11.9c.5-.7 1.2-1.1 2.1-1.1h7.9c.9 0 1.7.4 2.3 1.1l2.6 3.2H13.8l2.5-3.2z" fill={glass} />
      <circle cx="13" cy="21.6" r="4.5" fill={color} /><circle cx="13" cy="21.6" r="2" fill={wheel} />
      <circle cx="33" cy="21.6" r="4.5" fill={color} /><circle cx="33" cy="21.6" r="2" fill={wheel} />
    </svg>
  );
}
function Ico({ name, size = 16 }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" };
  const paths = {
    inicio: <><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /></>,
    stock: <><path d="M5 13l1.4-3.8A2 2 0 018.3 8h7.4a2 2 0 011.9 1.2L19 13" /><rect x="3.5" y="13" width="17" height="4.5" rx="1.5" /><circle cx="7.5" cy="17.5" r="1.3" /><circle cx="16.5" cy="17.5" r="1.3" /></>,
    taller: <path d="M14.6 6.4a4 4 0 00-5.4 5.2L4 16.8 7.2 20l5.2-5.2a4 4 0 005.2-5.4l-2.4 2.4-2.2-.6-.6-2.2 2.2-2.6z" />,
    clientes: <><circle cx="12" cy="8" r="3.3" /><path d="M5 20c0-3.4 3.1-5.5 7-5.5s7 2.1 7 5.5" /></>,
    reservas: <path d="M6 4h12v16l-6-4-6 4z" />,
    ventas: <><path d="M4 6h15l-1.5 8.5h-11z" /><circle cx="9" cy="19" r="1.4" /><circle cx="16.5" cy="19" r="1.4" /></>,
    cobranza: <><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.6" /></>,
    caja: <><rect x="3" y="8" width="18" height="12" rx="2" /><path d="M7 8V6a2 2 0 012-2h6a2 2 0 012 2v2" /></>,
    cxp: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18" /></>,
    fact: <><path d="M6 3h9l3 3v15H6z" /><path d="M9 8.5h6M9 12h6M9 15.5h4" /></>,
    reportes: <path d="M5 20V12M10 20V5M15 20v-9M20 20V8" />,
    notas: <><rect x="6" y="4" width="12" height="16" rx="2" /><path d="M9 9h6M9 12.5h6M9 16h3.5" /></>,
    legal: <path d="M12 3l7 3v5c0 4-3 7.2-7 9-4-1.8-7-5-7-9V6z" />,
    log: <path d="M3 12h4l2.5 6 4-14 2.5 8H21" />,
    papelera: <><path d="M4 7h16" /><path d="M9.5 7V5h5v2" /><path d="M6.5 7l1 13h9l1-13" /></>,
    cfg: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" /></>,
  };
  return <svg viewBox="0 0 24 24" width={size} height={size} {...p}>{paths[name] || null}</svg>;
}
function Marca({ size = 22, tagline = false, center = false }) {
  const mark = Math.round(size * 1.05);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: center ? "center" : "flex-start" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <div style={{ width: Math.round(mark * 1.18), height: Math.round(mark * 1.18), borderRadius: 7, background: `linear-gradient(140deg, ${C.acc} 0%, #123a86 100%)`, boxShadow: `0 2px 10px ${C.acc}55`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <CarIcon size={Math.round(mark * 0.84)} />
        </div>
        <div style={{ fontWeight: 800, fontSize: size, letterSpacing: -0.5, lineHeight: 1 }}><span style={{ color: C.txt }}>Motor</span><span style={{ color: C.acc }}>Gestión</span></div>
      </div>
      {tagline && <div style={{ fontSize: Math.max(11, Math.round(size * 0.42)), color: C.dim, letterSpacing: 0.3 }}>Tu playa de autos, bajo control</div>}
    </div>
  );
}

// ============================================================ APP (router auth)
const DB0 = { suscriptores: [], vehiculos: [], clientes: [], ventas: [], usuarios: [], caja: [], reservas: [], pagosSusc: [], notas: [], actividad: [], cxp: [], papelera: [], cfgs: {} };
let AUDIT = { usuario: "", tid: null };
function auditar(setDb, accion, detalle) {
  const { usuario, tid } = AUDIT;
  setDb((s) => ({ ...s, actividad: [{ id: uid(), tenantId: tid, usuario: usuario || "—", accion, detalle: detalle || "", ts: new Date().toISOString() }, ...(s.actividad || [])].slice(0, 3000) }));
}

export default function App() {
  const [db, setDb] = useState(DB0);
  const [ready, setReady] = useState(false);
  const [auth, setAuth] = useState(null);
  const [mustChange, setMustChange] = useState(null);
  const [nube, setNube] = useState({ estado: "idle", fecha: null });
  const syncTimer = useRef();

  useEffect(() => { loadDB().then((d) => { if (d) setDb({ ...DB0, ...d }); setReady(true); }); }, []);
  useEffect(() => { if (ready) saveDB(db); }, [db, ready]);
  useEffect(() => {
    if (!ready) return;
    clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      setNube((n) => ({ ...n, estado: "subiendo" }));
      subirNube(db).then(() => setNube({ estado: "ok", fecha: new Date().toLocaleString("es-PY") })).catch(() => setNube((n) => ({ ...n, estado: "error" })));
    }, 4000);
    return () => clearTimeout(syncTimer.current);
  }, [db, ready]);
  const restaurarNube = async () => {
    try {
      const row = await bajarNube();
      if (!row || !row.data) { alert("No hay respaldo en la nube todavía."); return; }
      if (!confirm(`Restaurar los datos de la nube (última copia: ${row.updated ? new Date(row.updated).toLocaleString("es-PY") : "—"})? Reemplaza los datos actuales de este dispositivo.`)) return;
      setDb({ ...DB0, ...row.data });
      alert("Datos restaurados desde la nube.");
    } catch (e) { alert("No se pudo restaurar: " + e.message); }
  };
  const subirNubeManual = async () => {
    setNube((n) => ({ ...n, estado: "subiendo" }));
    try { await subirNube(db); setNube({ estado: "ok", fecha: new Date().toLocaleString("es-PY") }); alert("Copia subida a la nube."); }
    catch (e) { setNube((n) => ({ ...n, estado: "error" })); alert("No se pudo subir: " + e.message); }
  };
  const cloud = { nube, restaurarNube, subirNubeManual };

  if (!ready) return <div style={{ background: C.bg, color: C.dim, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>Cargando…</div>;
  if (!auth) return <Login db={db} onDev={() => setAuth({ modo: "dev" })} onSys={(a, temp, susc) => { setAuth(a); if (temp) setMustChange(susc); }} cloud={cloud} />;
  if (mustChange) return <CambiarPass suscriptor={mustChange} setDb={setDb} onDone={() => setMustChange(null)} />;
  if (auth.modo === "dev") return <DevApp db={db} setDb={setDb} onLogout={() => setAuth(null)} cloud={cloud} />;
  return <Sistema db={db} setDb={setDb} auth={auth} onLogout={() => setAuth(null)} cloud={cloud} />;
}

function Login({ db, onDev, onSys }) {
  const [modo, setModo] = useState("sistema");
  const [u, setU] = useState(""); const [p, setP] = useState(""); const [err, setErr] = useState("");
  const entrar = () => {
    setErr("");
    if (modo === "dev") { if (u === "admin" && p === "99147685") return onDev(); return setErr("Credenciales de desarrollador incorrectas"); }
    // dueño de empresa (suscriptor)
    const susc = db.suscriptores.find((x) => x.user === u && x.pass === p);
    if (susc) {
      if (susc.bloqueado) return setErr("Cuenta bloqueada. Contactá al proveedor del sistema.");
      if (susc.vence && susc.plan !== "Único pago" && susc.vence < today()) return setErr("Membresía vencida. Contactá al proveedor.");
      return onSys({ modo: "sistema", tenantId: susc.id, user: susc.user, nombre: susc.nombre, rol: "admin", permisos: allPerms() }, susc.temp, susc);
    }
    // funcionario / admin creado en el sistema
    const us = db.usuarios.find((x) => x.user === u && x.pass === p);
    if (us) {
      if (us.bloqueado) return setErr("Usuario bloqueado por el administrador.");
      const dueno = db.suscriptores.find((s) => s.id === us.tenantId);
      if (dueno && dueno.bloqueado) return setErr("La empresa está bloqueada. Contactá al proveedor.");
      return onSys({ modo: "sistema", tenantId: us.tenantId, user: us.user, nombre: us.nombre, rol: us.rol, permisos: us.rol === "admin" ? allPerms() : (us.permisos || {}) }, false, null);
    }
    setErr("Usuario o contraseña incorrectos");
  };
  return (
    <div style={{ background: BGGRAD, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Inter, system-ui, sans-serif" }}>
      <div style={{ ...box, padding: 30, width: 360, boxShadow: "0 20px 60px rgba(0,0,0,.45)" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}><Marca size={26} tagline center /></div>
        <div style={{ textAlign: "center", color: C.dim, fontSize: 12, marginBottom: 16 }}>{modo === "dev" ? "Panel del desarrollador" : "Acceso al sistema"}</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          <Btn small kind={modo === "sistema" ? "acc" : "ghost"} onClick={() => { setModo("sistema"); setErr(""); }} style={{ flex: 1 }}>Sistema</Btn>
          <Btn small kind={modo === "dev" ? "dev" : "ghost"} onClick={() => { setModo("dev"); setErr(""); }} style={{ flex: 1 }}>Desarrollador</Btn>
        </div>
        <div style={{ display: "grid", gap: 12 }}>
          <Field label="Usuario"><input style={inp} value={u} onChange={(e) => setU(e.target.value)} onKeyDown={(e) => e.key === "Enter" && entrar()} /></Field>
          <Field label="Contraseña"><input type="password" style={inp} value={p} onChange={(e) => setP(e.target.value)} onKeyDown={(e) => e.key === "Enter" && entrar()} /></Field>
          {err && <div style={{ color: C.bad, fontSize: 12 }}>{err}</div>}
          <Btn kind={modo === "dev" ? "dev" : "acc"} onClick={entrar} style={{ marginTop: 6 }}>Ingresar</Btn>
        </div>
      </div>
    </div>
  );
}
function CambiarPass({ suscriptor, setDb, onDone }) {
  const [p1, setP1] = useState(""); const [p2, setP2] = useState("");
  const guardar = () => {
    if (p1.length < 4) return alert("Mínimo 4 caracteres");
    if (p1 !== p2) return alert("Las contraseñas no coinciden");
    setDb((s) => ({ ...s, suscriptores: s.suscriptores.map((x) => (x.id === suscriptor.id ? { ...x, pass: p1, temp: false } : x)) }));
    onDone();
  };
  return (
    <div style={{ background: BGGRAD, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Inter, system-ui, sans-serif" }}>
      <div style={{ ...box, padding: 30, width: 360 }}>
        <div style={{ marginBottom: 12 }}><Marca size={18} /></div>
        <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 4 }}>Cambiá tu contraseña</div>
        <div style={{ color: C.dim, fontSize: 12, marginBottom: 18 }}>Tu contraseña es temporal. Definí una nueva para empezar a usar tu sistema.</div>
        <div style={{ display: "grid", gap: 12 }}>
          <Field label="Nueva contraseña"><input type="password" style={inp} value={p1} onChange={(e) => setP1(e.target.value)} /></Field>
          <Field label="Repetir contraseña"><input type="password" style={inp} value={p2} onChange={(e) => setP2(e.target.value)} /></Field>
          <Btn kind="acc" onClick={guardar} style={{ marginTop: 6 }}>Guardar y continuar</Btn>
        </div>
      </div>
    </div>
  );
}

// ============================================================ DESARROLLADOR (app aparte)
function DevApp({ db, setDb, onLogout }) {
  const [f, setF] = useState({ nombre: "", whatsapp: "", direccion: "", user: "", plan: "Mensual", monto: "", moneda: "Gs", inicio: today() });
  const [creada, setCreada] = useState(null);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const calcVence = (plan, inicio) => { const d = new Date(inicio); if (plan === "Mensual") d.setMonth(d.getMonth() + 1); else if (plan === "Anual") d.setFullYear(d.getFullYear() + 1); else return null; return d.toISOString().slice(0, 10); };
  const crear = () => {
    if (!f.nombre) return alert("Ingresá el nombre de la empresa/cliente");
    const user = (f.user || f.nombre.split(" ")[0].toLowerCase()).replace(/\s/g, "");
    if (!user) return alert("Definí un usuario");
    if (db.suscriptores.some((s) => s.user === user)) return alert("Ese usuario ya existe, elegí otro");
    const tp = tempPass(); const id = uid();
    setDb((s) => ({
      ...s,
      suscriptores: [{ id, nombre: f.nombre, whatsapp: f.whatsapp, direccion: f.direccion, user, pass: tp, temp: true, plan: f.plan, monto: +f.monto || 0, moneda: f.moneda, inicio: f.inicio, vence: calcVence(f.plan, f.inicio), bloqueado: false, creado: today() }, ...s.suscriptores],
      cfgs: { ...s.cfgs, [id]: { ...CFG0, empresa: { nombre: f.nombre, tel: f.whatsapp, dir: f.direccion, ciudad: "", logo: null } } },
    }));
    setCreada({ user, pass: tp });
    setF({ nombre: "", whatsapp: "", direccion: "", user: "", plan: "Mensual", monto: "", moneda: "Gs", inicio: today() });
  };
  const upd = (id, patch) => setDb((s) => ({ ...s, suscriptores: s.suscriptores.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  const cambiarClave = (susc) => { const np = prompt("Nueva contraseña para " + susc.nombre + ":"); if (np && np.length >= 4) { upd(susc.id, { pass: np, temp: true }); alert("Contraseña actualizada. El cliente deberá cambiarla al ingresar."); } else if (np) alert("Mínimo 4 caracteres"); };
  const eliminar = (susc) => { if (confirm(`¿Eliminar a "${susc.nombre}" y TODOS sus datos (autos, clientes, ventas)? No se puede deshacer.`)) setDb((s) => ({ ...s, suscriptores: s.suscriptores.filter((x) => x.id !== susc.id), vehiculos: s.vehiculos.filter((v) => v.tenantId !== susc.id), clientes: s.clientes.filter((c) => c.tenantId !== susc.id), ventas: s.ventas.filter((v) => v.tenantId !== susc.id), usuarios: s.usuarios.filter((u) => u.tenantId !== susc.id) })); };
  const activa = (s) => !s.bloqueado && (s.plan === "Único pago" || !s.vence || s.vence >= today());
  const ingresos = db.suscriptores.filter(activa).reduce((a, s) => a + toGs(s.monto, s.moneda, { cotizacion: 7300 }), 0);
  const [cobro, setCobro] = useState(null); const [histo, setHisto] = useState(null); const [uso, setUso] = useState(null);
  const pagos = db.pagosSusc || [];
  const pagosDe = (id) => pagos.filter((p) => p.suscriptorId === id).sort((a, b) => b.fecha.localeCompare(a.fecha));
  const cobradoMes = pagos.filter((p) => (p.fecha || "").slice(0, 7) === today().slice(0, 7)).reduce((a, p) => a + toGs(p.monto, p.moneda, { cotizacion: 7300 }), 0);
  const extenderVence = (s) => { if (s.plan === "Único pago") return s.vence; const base = new Date((s.vence && s.vence >= today()) ? s.vence : today()); if (s.plan === "Mensual") base.setMonth(base.getMonth() + 1); else base.setFullYear(base.getFullYear() + 1); return base.toISOString().slice(0, 10); };
  const registrarCobro = (susc, datos) => {
    setDb((s) => ({ ...s, pagosSusc: [{ id: uid(), suscriptorId: susc.id, fecha: datos.fecha, monto: +datos.monto || 0, moneda: datos.moneda, concepto: datos.concepto || `Suscripción ${susc.plan}` }, ...(s.pagosSusc || [])], suscriptores: s.suscriptores.map((x) => x.id === susc.id ? { ...x, vence: datos.renovar ? extenderVence(x) : x.vence } : x) }));
    reciboSuscPDF(susc, datos);
    setCobro(null);
  };
  const delPago = (id) => { if (confirm("¿Eliminar este cobro del historial?")) setDb((s) => ({ ...s, pagosSusc: (s.pagosSusc || []).filter((p) => p.id !== id) })); };
  const estadoVence = (s) => { if (s.plan === "Único pago" || !s.vence) return null; const dd = diasEntre(today(), s.vence); if (s.vence < today()) return { txt: "Vencida", c: C.bad }; if (dd <= 7) return { txt: `Vence en ${dd}d`, c: C.warn }; return null; };
  return (
    <div style={{ background: BGGRAD, color: C.txt, minHeight: "100vh", fontFamily: "Inter, system-ui, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 20px", borderBottom: `1px solid ${C.border}` }}>
        <Marca size={17} /><span style={{ color: C.dim, fontWeight: 600, fontSize: 13, borderLeft: `1px solid ${C.border}`, paddingLeft: 12 }}>Panel del desarrollador</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.dim }}>
          <Btn small kind="ghost" onClick={() => exportarDatos({ empresa: { nombre: "MotorGestion" } }, db, "motorgestion-backup-total")}>Exportar todo</Btn>
          <label style={{ cursor: "pointer" }}><Btn small kind="ghost" onClick={(e) => e.currentTarget.parentElement.querySelector("input").click()}>Importar</Btn><input type="file" accept="application/json" style={{ display: "none" }} onChange={(e) => importarDatos(e.target.files[0], setDb)} /></label>
          <span>admin</span><Btn small kind="ghost" onClick={onLogout}>Salir</Btn>
        </div>
      </div>
      <div style={{ padding: 20, maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 16 }}>
          <Kpi t="Empresas-cliente" v={db.suscriptores.length} /><Kpi t="Suscripciones activas" v={db.suscriptores.filter(activa).length} c={C.ok} /><Kpi t="Ingreso estimado (Gs eq.)" v={money(ingresos, "Gs")} c={C.dev} /><Kpi t="Cobrado este mes (Gs eq.)" v={money(cobradoMes, "Gs")} c={C.ok} />
        </div>
        <b>Registrar nueva empresa-cliente</b>
        <div style={{ ...box, padding: 16, marginTop: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
            <Field label="Nombre de empresa / cliente"><input style={inp} value={f.nombre} onChange={(e) => set("nombre", e.target.value)} /></Field>
            <Field label="WhatsApp"><input style={inp} value={f.whatsapp} onChange={(e) => set("whatsapp", e.target.value)} /></Field>
            <Field label="Dirección"><input style={inp} value={f.direccion} onChange={(e) => set("direccion", e.target.value)} /></Field>
            <Field label="Usuario (login)"><input style={inp} value={f.user} onChange={(e) => set("user", e.target.value)} placeholder="se genera solo" /></Field>
            <Field label="Plan"><select style={inp} value={f.plan} onChange={(e) => set("plan", e.target.value)}>{PLANES.map((p) => <option key={p}>{p}</option>)}</select></Field>
            <Field label="Monto de suscripción"><input type="number" style={inp} value={f.monto} onChange={(e) => set("monto", e.target.value)} /></Field>
            <Field label="Moneda"><select style={inp} value={f.moneda} onChange={(e) => set("moneda", e.target.value)}><option>Gs</option><option>USD</option></select></Field>
            <Field label="Inicio"><input type="date" style={inp} value={f.inicio} onChange={(e) => set("inicio", e.target.value)} /></Field>
          </div>
          <div style={{ marginTop: 12 }}><Btn kind="dev" onClick={crear}>Crear empresa + usuario temporal</Btn></div>
        </div>
        {creada && (
          <div style={{ ...box, padding: 14, marginTop: 12, borderColor: C.ok, background: "rgba(46,204,113,.08)" }}>
            <div style={{ color: C.ok, fontWeight: 700, marginBottom: 6 }}>✓ Empresa creada — entregá estas credenciales</div>
            <div style={{ display: "flex", gap: 24 }}><span>Usuario: <b>{creada.user}</b></span><span>Contraseña temporal: <b style={{ color: C.acc }}>{creada.pass}</b></span></div>
            <div style={{ fontSize: 12, color: C.dim, marginTop: 6 }}>Al ingresar al sistema por primera vez, se le pedirá cambiar la contraseña. Su sistema inicia vacío.</div>
          </div>
        )}
        <div style={{ marginTop: 18 }}>
          <b>Empresas-cliente y suscripciones ({db.suscriptores.length})</b>
          {db.suscriptores.length === 0 && <div style={{ marginTop: 8 }}><Empty t="Todavía no registraste ninguna empresa." /></div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
            {db.suscriptores.map((s) => (
              <div key={s.id} style={{ ...box, padding: 12, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", opacity: s.bloqueado ? 0.6 : 1 }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontWeight: 700 }}>{s.nombre} {s.bloqueado && <span style={{ color: C.bad, fontSize: 12 }}>· BLOQUEADO</span>} {estadoVence(s) && <span style={{ color: estadoVence(s).c, fontSize: 11, fontWeight: 700, marginLeft: 4 }}>· {estadoVence(s).txt}</span>}</div>
                  <div style={{ fontSize: 12, color: C.dim }}>@{s.user} · {s.whatsapp || "—"} · Plan {s.plan}{s.vence ? " · vence " + s.vence : ""} · cobrado {money(pagosDe(s.id).reduce((a, p) => a + toGs(p.monto, p.moneda, { cotizacion: 7300 }), 0), "Gs")}</div>
                  <div style={{ fontSize: 11, color: C.dim, marginTop: 2 }}>🚗 {db.vehiculos.filter((v) => v.tenantId === s.id).length}{s.limiteAutos ? "/" + s.limiteAutos : ""} autos · 🧾 {db.ventas.filter((v) => v.tenantId === s.id).length} ventas · 👥 {db.clientes.filter((c) => c.tenantId === s.id).length} clientes · 🔑 {db.usuarios.filter((u) => u.tenantId === s.id).length} usuarios</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 12, color: C.dim }}>Cobro:</span>
                  <input type="number" style={{ ...inp, width: 120 }} value={s.monto} onChange={(e) => upd(s.id, { monto: +e.target.value })} />
                  <select style={{ ...inp, width: 70 }} value={s.moneda} onChange={(e) => upd(s.id, { moneda: e.target.value })}><option>Gs</option><option>USD</option></select>
                </div>
                <span style={{ color: activa(s) ? C.ok : C.bad, fontSize: 12, fontWeight: 700 }}>{s.bloqueado ? "Bloqueada" : activa(s) ? "Activa" : "Vencida"}</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <Btn small kind="dev" onClick={() => setCobro(s)}>Cobrar / Renovar</Btn>
                  <Btn small kind="ghost" onClick={() => setHisto(s)}>Historial ({pagosDe(s.id).length})</Btn>
                  <Btn small kind="ghost" onClick={() => setUso(s)}>Uso / Plan</Btn>
                  <Btn small kind="ghost" onClick={() => cambiarClave(s)}>Clave</Btn>
                  <Btn small kind={s.bloqueado ? "ok" : "ghost"} onClick={() => upd(s.id, { bloqueado: !s.bloqueado })} style={!s.bloqueado ? { color: C.warn, borderColor: C.warn } : {}}>{s.bloqueado ? "Desbloquear" : "Bloquear"}</Btn>
                  <Btn small kind="ghost" onClick={() => eliminar(s)} style={{ color: C.bad, borderColor: C.bad }}>Eliminar</Btn>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {cobro && <CobroSuscModal susc={cobro} onClose={() => setCobro(null)} onConfirm={(d) => registrarCobro(cobro, d)} />}
      {histo && <HistorialSuscModal susc={histo} pagos={pagosDe(histo.id)} onClose={() => setHisto(null)} onDel={delPago} />}
      {uso && <UsoModal susc={uso} db={db} onClose={() => setUso(null)} onSetLimite={(lim) => { upd(uso.id, { limiteAutos: lim }); setUso({ ...uso, limiteAutos: lim }); }} />}
    </div>
  );
}
function CobroSuscModal({ susc, onClose, onConfirm }) {
  const [d, setD] = useState({ monto: susc.monto || "", moneda: susc.moneda || "Gs", fecha: today(), concepto: `Suscripción ${susc.plan}`, renovar: susc.plan !== "Único pago" });
  const set = (k, v) => setD((s) => ({ ...s, [k]: v }));
  return (
    <Modal onClose={onClose} w={440}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}><b>Cobrar suscripción — {susc.nombre}</b><Btn small kind="ghost" onClick={onClose}>✕</Btn></div>
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
          <Field label="Monto"><input type="number" style={inp} value={d.monto} onChange={(e) => set("monto", e.target.value)} /></Field>
          <Field label="Moneda"><select style={inp} value={d.moneda} onChange={(e) => set("moneda", e.target.value)}><option>Gs</option><option>USD</option></select></Field>
        </div>
        <Field label="Fecha"><input type="date" style={inp} value={d.fecha} onChange={(e) => set("fecha", e.target.value)} /></Field>
        <Field label="Concepto"><input style={inp} value={d.concepto} onChange={(e) => set("concepto", e.target.value)} /></Field>
        {susc.plan !== "Único pago" && <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.txt }}><input type="checkbox" checked={d.renovar} onChange={(e) => set("renovar", e.target.checked)} />Renovar vencimiento ({susc.plan})</label>}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}><Btn kind="ghost" onClick={onClose}>Cancelar</Btn><Btn kind="dev" onClick={() => onConfirm(d)}>Registrar cobro + recibo</Btn></div>
    </Modal>
  );
}
function HistorialSuscModal({ susc, pagos, onClose, onDel }) {
  const total = pagos.reduce((a, p) => a + toGs(p.monto, p.moneda, { cotizacion: 7300 }), 0);
  return (
    <Modal onClose={onClose} w={560}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><b>Historial de cobros — {susc.nombre}</b><Btn small kind="ghost" onClick={onClose}>✕</Btn></div>
      <div style={{ fontSize: 12, color: C.dim, marginBottom: 10 }}>Total cobrado: <b style={{ color: C.ok }}>{money(total, "Gs")}</b> (Gs eq.)</div>
      {pagos.length === 0 ? <Empty t="Sin cobros registrados." /> : (
        <div style={{ ...box, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ background: C.panel2, color: C.dim, textAlign: "left" }}><th style={th}>Fecha</th><th style={th}>Concepto</th><th style={{ ...th, textAlign: "right" }}>Monto</th><th style={th}></th></tr></thead>
            <tbody>{pagos.map((p) => (
              <tr key={p.id} style={{ borderTop: `1px solid ${C.border}` }}><td style={td}>{p.fecha}</td><td style={td}>{p.concepto}</td><td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{money(p.monto, p.moneda)}</td><td style={td}><Btn small kind="ghost" onClick={() => onDel(p.id)} style={{ color: C.bad, borderColor: C.bad }}>✕</Btn></td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
function Sistema({ db, setDb, auth, onLogout, cloud }) {
  const tid = auth.tenantId;
  const cfg = db.cfgs[tid] || CFG0;
  const setCfg = (c) => setDb((s) => ({ ...s, cfgs: { ...s.cfgs, [tid]: c } }));
  const sdb = {
    vehiculos: db.vehiculos.filter((v) => v.tenantId === tid),
    clientes: db.clientes.filter((c) => c.tenantId === tid),
    ventas: db.ventas.filter((v) => v.tenantId === tid),
    usuarios: db.usuarios.filter((u) => u.tenantId === tid),
    caja: (db.caja || []).filter((m) => m.tenantId === tid),
    reservas: (db.reservas || []).filter((r) => r.tenantId === tid),
    notas: (db.notas || []).filter((n) => n.tenantId === tid),
    actividad: (db.actividad || []).filter((a) => a.tenantId === tid),
    cxp: (db.cxp || []).filter((x) => x.tenantId === tid),
    papelera: (db.papelera || []).filter((p) => p.tenantId === tid),
  };
  AUDIT = { usuario: auth.nombre || auth.user, tid };
  useEffect(() => { auditar(setDb, "Inició sesión", `${auth.nombre || auth.user} (${auth.rol})`); }, []);
  const puede = (k) => auth.rol === "admin" || auth.permisos?.[k];
  const [tab, setTab] = useState(puede("inicio") ? "inicio" : (PERMS.find(([k]) => puede(k)) || ["cfg"])[0]);
  const [selVeh, setSelVeh] = useState(null);
  const [selCli, setSelCli] = useState(null);
  const [vehParaVenta, setVehParaVenta] = useState(null);

  const setVeh = (id, patch) => setDb((s) => ({ ...s, vehiculos: s.vehiculos.map((v) => (v.id === id ? { ...v, ...patch } : v)) }));
  const suscActual = db.suscriptores.find((s) => s.id === tid);
  const addVeh = (v) => { const lim = suscActual && suscActual.limiteAutos; const enStock = db.vehiculos.filter((x) => x.tenantId === tid && x.estado !== "Vendido").length; if (lim && enStock >= lim) return alert(`Alcanzaste el límite de ${lim} autos de tu plan. Contactá al proveedor del sistema para ampliarlo.`); setDb((s) => ({ ...s, vehiculos: [{ ...v, id: uid(), tenantId: tid }, ...s.vehiculos] })); auditar(setDb, "Cargó vehículo", `${v.marca || ""} ${v.modelo || ""} ${v.anio || ""}`.trim()); };
  const delVeh = (id) => { const v = db.vehiculos.find((x) => x.id === id); if (!v) return; setDb((s) => ({ ...s, vehiculos: s.vehiculos.filter((x) => x.id !== id), papelera: [{ id: uid(), tenantId: tid, tipo: "vehiculo", data: v, fecha: today(), nombre: `${v.marca || ""} ${v.modelo || ""} ${v.anio || ""}`.trim() }, ...(s.papelera || [])] })); auditar(setDb, "Eliminó vehículo", `${v.marca || ""} ${v.modelo || ""} ${v.anio || ""}`.trim()); };
  const alertas = useMemo(() => sdb.ventas.reduce((n, v) => n + (v.plan || []).filter((c) => !c.pagado && c.venc < today()).length, 0), [db.ventas, tid]);

  const TABS = [...PERMS.filter(([k]) => puede(k)), ...(auth.rol === "admin" ? [["log", "Actividad"], ["papelera", "Papelera"], ["cfg", "Ajustes"]] : [])];

  return (
    <div className={cfg.tema === "claro" ? "tema-claro" : ""} style={{ background: BGGRAD, color: C.txt, minHeight: "100vh", fontFamily: "Inter, system-ui, sans-serif", zoom: cfg.uiZoom || 1, filter: cfg.tema === "claro" ? "invert(1) hue-rotate(180deg)" : "none" }}>
      <style>{`*{scrollbar-width:thin;scrollbar-color:${C.border} transparent} input,select,textarea{outline:none;transition:border-color .15s,box-shadow .15s} input:focus,select:focus,textarea:focus{border-color:${C.acc};box-shadow:0 0 0 3px ${C.acc}22} button{transition:filter .15s,transform .1s,box-shadow .15s} button:hover{filter:brightness(1.09)} button:active{transform:translateY(1px)} a{cursor:pointer} tbody tr{transition:background .12s} tbody tr:hover{background:rgba(120,150,200,.06)} .kpi-click{transition:transform .12s,box-shadow .12s,border-color .12s} .kpi-click:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(0,0,0,.4)} .card-hover{transition:transform .12s,box-shadow .12s,border-color .12s} .card-hover:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(0,0,0,.32);border-color:${C.acc}55} @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}} .fade{animation:fadeIn .24s ease} @media print{.noprint{display:none!important}} .tema-claro img,.tema-claro canvas{filter:invert(1) hue-rotate(180deg)}`}</style>
      <div className="noprint" style={{ position: "sticky", top: 0, zIndex: 30, display: "flex", alignItems: "center", gap: 12, padding: "12px 20px", borderBottom: `1px solid ${C.border}`, flexWrap: "wrap", background: cfg.tema === "claro" ? "rgba(255,255,255,.9)" : "rgba(10,20,36,.88)", backdropFilter: "blur(8px)" }}>
        <Marca size={17} />
        <div style={{ display: "flex", alignItems: "center", gap: 8, borderLeft: `1px solid ${C.border}`, paddingLeft: 12 }}>{cfg.empresa.logo && <img src={cfg.empresa.logo} style={{ height: 24 }} />}<span style={{ color: C.dim, fontWeight: 600, fontSize: 13 }}>{cfg.empresa.nombre || "Mi playa de autos"}</span></div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{TABS.map(([k, l]) => <button key={k} onClick={() => setTab(k)} style={{ background: tab === k ? C.acc : "transparent", color: tab === k ? "#fff" : C.dim, border: "none", padding: "7px 11px", borderRadius: 8, cursor: "pointer", fontWeight: 600, fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6 }}><Ico name={k} size={15} />{l}</button>)}</div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12, fontSize: 12, color: C.dim }}>
          <BuscadorGlobal db={sdb} onCliente={(id) => { setSelCli(id); setTab(puede("clientes") ? "clientes" : "cobranza"); }} onVehiculo={() => setTab("stock")} onVenta={(vt) => { if (vt.plan) { setSelCli(vt.clienteId); setTab(puede("cobranza") ? "cobranza" : "clientes"); } else setTab("ventas"); }} />
          <span title="Cotización configurada">USD: Gs {nf.format(cfg.cotizacion)}</span>
          {cloud && (() => { const e = cloud.nube.estado; const cfg2 = { ok: [C.ok, "Nube ✓"], subiendo: [C.warn, "Guardando…"], error: [C.bad, "Sin conexión"], idle: [C.dim, "Nube"] }[e] || [C.dim, "Nube"]; return <span title={cloud.nube.fecha ? "Última sincronización: " + cloud.nube.fecha : "Respaldo en la nube"} onClick={cloud.subirNubeManual} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, color: cfg2[0], background: cfg2[0] + "1f", border: `1px solid ${cfg2[0]}55`, borderRadius: 20, padding: "3px 10px", cursor: "pointer" }}>☁ {cfg2[1]}</span>; })()}
          {alertas > 0 && puede("cobranza") && <button onClick={() => setTab("cobranza")} style={{ background: "rgba(255,92,98,.15)", color: C.bad, border: `1px solid ${C.bad}`, borderRadius: 20, padding: "4px 12px", cursor: "pointer", fontWeight: 700, fontSize: 12 }}>🔔 {alertas} vencida(s)</button>}
          <span>{auth.nombre || auth.user} · {auth.rol === "admin" ? "Admin" : "Funcionario"}</span>
          <Btn small kind="ghost" onClick={onLogout}>Salir</Btn>
        </div>
      </div>
      <div style={{ padding: 20, maxWidth: 1200, margin: "0 auto" }}>
        {auth.rol === "admin" && (!cfg.ultimoBackup || diasEntre(cfg.ultimoBackup, today()) >= 7) && (
          <div className="noprint" style={{ ...box, borderColor: C.warn, background: "rgba(245,166,35,.08)", padding: "10px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, color: C.warn }}>💾 {cfg.ultimoBackup ? `Tu última copia de seguridad fue el ${cfg.ultimoBackup}.` : "Todavía no descargaste una copia de seguridad."} Los datos viven en este navegador — descargá una copia para no perderlos.</span>
            <Btn small kind="acc" style={{ marginLeft: "auto" }} onClick={() => { exportarDatos(cfg, db); setCfg({ ...cfg, ultimoBackup: today() }); }}>Descargar copia ahora</Btn>
          </div>
        )}
        <div className="fade" key={tab}>
        {tab === "inicio" && puede("inicio") && <Inicio db={sdb} cfg={cfg} ir={setTab} puede={puede} />}
        {tab === "stock" && puede("stock") && <Stock db={sdb} cfg={cfg} addVeh={addVeh} setVeh={setVeh} delVeh={delVeh} vender={(id) => { setVehParaVenta(id); setTab(puede("ventas") ? "ventas" : "stock"); }} openLegal={(id) => { setSelVeh(id); setTab(puede("legal") ? "legal" : "stock"); }} />}
        {tab === "taller" && puede("taller") && <Taller db={sdb} cfg={cfg} setVeh={setVeh} />}
        {tab === "clientes" && puede("clientes") && <Clientes db={sdb} cfg={cfg} setDb={setDb} tid={tid} selCli={selCli} setSelCli={setSelCli} />}
        {tab === "reservas" && puede("reservas") && <Reservas db={sdb} cfg={cfg} setDb={setDb} tid={tid} irVenta={(vid) => { setVehParaVenta(vid); setTab(puede("ventas") ? "ventas" : "reservas"); }} />}
        {tab === "ventas" && puede("ventas") && <Ventas db={sdb} cfg={cfg} setDb={setDb} tid={tid} vendedor={auth.nombre || auth.user} vehParaVenta={vehParaVenta} setVehParaVenta={setVehParaVenta} setVeh={setVeh} />}
        {tab === "cobranza" && puede("cobranza") && <Cobranza db={sdb} cfg={cfg} setDb={setDb} selCli={selCli} setSelCli={setSelCli} />}
        {tab === "caja" && puede("caja") && <Caja db={sdb} cfg={cfg} setDb={setDb} tid={tid} />}
        {tab === "cxp" && puede("cxp") && <CuentasPorPagar db={sdb} cfg={cfg} setDb={setDb} tid={tid} />}
        {tab === "fact" && puede("fact") && <Facturacion db={sdb} cfg={cfg} selVeh={selVeh} setSelVeh={setSelVeh} />}
        {tab === "reportes" && puede("reportes") && <Reportes db={sdb} cfg={cfg} setDb={setDb} tid={tid} />}
        {tab === "notas" && puede("notas") && <Notas db={sdb} setDb={setDb} tid={tid} />}
        {tab === "legal" && puede("legal") && <Legal db={sdb} cfg={cfg} selVeh={selVeh} setSelVeh={setSelVeh} setVeh={setVeh} />}
        {tab === "cfg" && auth.rol === "admin" && <Config cfg={cfg} setCfg={setCfg} db={sdb} setDb={setDb} tid={tid} cloud={cloud} />}
        {tab === "log" && auth.rol === "admin" && <Actividad db={sdb} setDb={setDb} />}
        {tab === "papelera" && auth.rol === "admin" && <Papelera db={sdb} setDb={setDb} setVeh={setVeh} />}
        </div>
      </div>
    </div>
  );
}

// ============================================================ STOCK
function Stock({ db, cfg, addVeh, setVeh, delVeh, vender, openLegal }) {
  const [edit, setEdit] = useState(null);
  const [q, setQ] = useState(""); const [fEstado, setFEstado] = useState("");
  const todos = db.vehiculos;
  const vehs = todos.filter((v) => (`${v.marca} ${v.modelo} ${v.anio} ${v.chapa || ""} ${v.color || ""}`).toLowerCase().includes(q.toLowerCase())).filter((v) => !fEstado || (v.estado || "Disponible") === fEstado);
  const kpi = useMemo(() => { const disp = todos.filter((v) => v.estado !== "Vendido"); return { total: todos.length, disp: disp.length, capital: disp.reduce((a, v) => a + costoTotal(v), 0), margenPot: disp.reduce((a, v) => a + margen(v), 0) }; }, [todos]);
  return (
    <div>
      <Titulo icon="stock" sub="Inventario de vehículos">Stock</Titulo>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 16 }}><Kpi t="En stock" v={kpi.disp + " / " + kpi.total} /><Kpi t="Capital inmovilizado" v={money(kpi.capital, "Gs")} /><Kpi t="Margen potencial" v={money(kpi.margenPot, "Gs")} c={C.ok} /><Kpi t="Cotización USD" v={"Gs " + nf.format(cfg.cotizacion)} /></div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 10, flexWrap: "wrap" }}>
        <b>Ficha técnica y control de stock</b>
        <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
          <input style={{ ...inp, width: 200 }} placeholder="Buscar marca, modelo, chapa…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select style={{ ...inp, width: 140 }} value={fEstado} onChange={(e) => setFEstado(e.target.value)}><option value="">Todos los estados</option>{["Disponible", "Reservado", "En taller", "Vendido"].map((s) => <option key={s}>{s}</option>)}</select>
          <Btn onClick={() => catalogoWeb(todos, cfg)}>Catálogo web</Btn>
          <Btn kind="acc" onClick={() => setEdit("new")}>+ Nuevo vehículo</Btn>
        </div>
      </div>
      {vehs.length === 0 && <Empty t={todos.length ? "Ningún vehículo coincide con el filtro." : "Sin vehículos cargados. Agregá el primero."} />}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{vehs.map((v) => <VehCard key={v.id} v={v} cfg={cfg} onEdit={() => setEdit(v)} onDel={() => delVeh(v.id)} vender={() => vender(v.id)} openLegal={() => openLegal(v.id)} setVeh={setVeh} />)}</div>
      {edit && <VehModal veh={edit === "new" ? null : edit} cfg={cfg} onClose={() => setEdit(null)} onSave={(v) => { if (edit === "new") addVeh(v); else setVeh(edit.id, v); setEdit(null); }} />}
    </div>
  );
}
const estadoColor = (e) => ({ Disponible: C.ok, Reservado: C.warn, Vendido: C.dim, "En taller": C.acc }[e] || C.dim);
function VehCard({ v, cfg, onEdit, onDel, vender, openLegal, setVeh }) {
  const [open, setOpen] = useState(false);
  const m = margen(v); const foto = (v.fotosExt || v.fotos || [])[0];
  return (
    <div className="card-hover" style={box}>
      <div style={{ display: "flex", gap: 14, padding: 12, alignItems: "center" }}>
        <div style={{ width: 74, height: 56, borderRadius: 8, background: C.bg, border: `1px solid ${C.border}`, backgroundImage: foto ? `url(${foto})` : "none", backgroundSize: "cover", backgroundPosition: "center", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: C.dim, fontSize: 11 }}>{!foto && "sin foto"}</div>
        <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: 15 }}>{v.marca} {v.modelo} <span style={{ color: C.dim, fontWeight: 400, fontSize: 13 }}>· {v.anio} · {v.color}</span></div><div style={{ fontSize: 12, color: C.dim }}>Chapa {v.chapa || "—"} · {v.km ? nf.format(v.km) + " km" : "—"} · {v.condicion || "—"} · {v.procedencia}</div></div>
        <div style={{ textAlign: "right" }}><div style={{ fontWeight: 800, fontSize: 15, color: C.acc }}>{money(v.precioVenta, "Gs")}</div><div style={{ fontSize: 12, color: m >= 0 ? C.ok : C.bad }}>margen {money(m, "Gs")} ({margenPct(v).toFixed(0)}%)</div></div>
        <select value={v.estado || "Disponible"} onChange={(e) => setVeh(v.id, { estado: e.target.value })} style={{ ...inp, width: 120, color: estadoColor(v.estado), fontWeight: 600 }}>{["Disponible", "Reservado", "En taller", "Vendido"].map((s) => <option key={s}>{s}</option>)}</select>
        <Btn small kind="ghost" onClick={() => setOpen(!open)}>{open ? "▲" : "▼"}</Btn>
      </div>
      {open && (
        <div style={{ padding: "0 12px 12px", borderTop: `1px solid ${C.border}` }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16, paddingTop: 12 }}>
            <div>
              <SubT>Datos</SubT><Rows rows={[["VIN / Chasis", v.vin || "—"], ["Combustible", v.combustible], ["Condición", v.condicion || "—"], ["Procedencia", v.procedencia], ["Ingreso", v.fechaIngreso || "—"]]} />
              <SubT>Fotos exterior ({(v.fotosExt || []).length})</SubT><Galeria v={v} campo="fotosExt" setVeh={setVeh} />
              <SubT>Fotos interior ({(v.fotosInt || []).length})</SubT><Galeria v={v} campo="fotosInt" setVeh={setVeh} />
            </div>
            <div>
              <SubT>Costeo y margen</SubT>
              <Rows rows={[["Precio compra", money(v.precioCompra, "Gs")], ...GASTOS_FIJOS.map(([k, l]) => ["+ " + l, money(v.gastos?.[k], "Gs")]), ...(v.gastosExtra || []).map((g) => ["+ " + (g.concepto || "gasto"), money(g.monto, "Gs")])]} />
              <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 6, paddingTop: 6 }}>
                <Rows rows={[["COSTO TOTAL", money(costoTotal(v), "Gs")], ["Precio venta", money(v.precioVenta, "Gs")]]} />
                <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, color: m >= 0 ? C.ok : C.bad, marginTop: 4 }}><span>MARGEN REAL</span><span>{money(m, "Gs")} · {margenPct(v).toFixed(1)}%</span></div>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <Btn small onClick={onEdit}>Editar ficha</Btn>
            <Btn small kind="acc" onClick={vender}>Vender a crédito</Btn>
            <Btn small onClick={() => facturaPDF(v, cfg)}>Factura gastos PDF</Btn>
            <Btn small kind="ghost" onClick={() => waFactura(v, cfg)} style={{ color: "#25D366", borderColor: "#25D366" }}>WhatsApp</Btn>
            <Btn small kind="ok" onClick={() => fichaPDF(v, cfg)}>Ficha / Cartel</Btn>
            <Btn small onClick={openLegal}>Legal / Carta oferta</Btn>
            <Btn small kind="ghost" onClick={() => { if (confirm("¿Eliminar vehículo?")) onDel(); }} style={{ marginLeft: "auto", color: C.bad, borderColor: C.bad }}>Eliminar</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
function FotoUnica({ label, valor, onSet }) {
  const fileRef = useRef();
  const sub = (e) => { const file = e.target.files[0]; if (file) readFile(file).then((d) => { onSet(d); e.target.value = ""; }); };
  return (
    <div>
      <div style={{ fontSize: 12, color: C.dim, marginBottom: 6 }}>{label}</div>
      {valor ? (
        <div style={{ position: "relative", width: "fit-content" }}>
          <img src={valor} style={{ maxWidth: 160, maxHeight: 110, borderRadius: 8, display: "block" }} />
          <button onClick={() => onSet(null)} style={{ position: "absolute", top: -6, right: -6, background: C.bad, color: "#fff", border: "none", borderRadius: "50%", width: 20, height: 20, cursor: "pointer", fontSize: 12 }}>×</button>
        </div>
      ) : <button onClick={() => fileRef.current.click()} style={{ width: 160, height: 100, ...box, color: C.dim, cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}>+ Subir imagen</button>}
      <input ref={fileRef} type="file" accept="image/*" onChange={sub} style={{ display: "none" }} />
    </div>
  );
}
function FotosLocal({ label, arr, onAdd, onDel }) {
  const fileRef = useRef();
  const add = (e) => { Promise.all([...e.target.files].map(readFile)).then((imgs) => { onAdd(imgs); e.target.value = ""; }); };
  return (
    <div>
      <div style={{ fontSize: 12, color: C.dim, marginBottom: 6 }}>{label} ({arr.length})</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {arr.map((f, i) => <div key={i} style={{ position: "relative" }}><img src={f} style={{ width: 64, height: 48, objectFit: "cover", borderRadius: 6 }} /><button onClick={() => onDel(i)} style={{ position: "absolute", top: -6, right: -6, background: C.bad, color: "#fff", border: "none", borderRadius: "50%", width: 18, height: 18, cursor: "pointer", fontSize: 11 }}>×</button></div>)}
        <button onClick={() => fileRef.current.click()} style={{ width: 64, height: 48, ...box, color: C.dim, cursor: "pointer", fontSize: 22 }}>+</button>
      </div>
      <input ref={fileRef} type="file" accept="image/*" multiple onChange={add} style={{ display: "none" }} />
    </div>
  );
}
function Galeria({ v, campo, setVeh }) {
  const fileRef = useRef();
  const arr = v[campo] || [];
  const add = (e) => { Promise.all([...e.target.files].map(readFile)).then((imgs) => setVeh(v.id, { [campo]: [...arr, ...imgs] })); };
  const del = (i) => setVeh(v.id, { [campo]: arr.filter((_, k) => k !== i) });
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {arr.map((f, i) => <div key={i} style={{ position: "relative" }}><img src={f} style={{ width: 60, height: 45, objectFit: "cover", borderRadius: 6 }} /><button onClick={() => del(i)} style={{ position: "absolute", top: -6, right: -6, background: C.bad, color: "#fff", border: "none", borderRadius: "50%", width: 18, height: 18, cursor: "pointer", fontSize: 11 }}>×</button></div>)}
        <button onClick={() => fileRef.current.click()} style={{ width: 60, height: 45, ...box, color: C.dim, cursor: "pointer", fontSize: 20 }}>+</button>
      </div>
      <input ref={fileRef} type="file" accept="image/*" multiple onChange={add} style={{ display: "none" }} />
    </div>
  );
}

function VehModal({ veh, cfg, onClose, onSave }) {
  const [f, setF] = useState(veh || { marca: "", modelo: "", anio: "", color: "", vin: "", chapa: "", km: "", combustible: "Nafta", condicion: "Bueno", procedencia: PROCEDENCIA[0], fechaIngreso: today(), estado: "Disponible", precioCompra: "", precioVenta: "", gastos: {}, gastosExtra: [], fotosExt: [], fotosInt: [] });
  const set = (k, val) => setF((s) => ({ ...s, [k]: val }));
  const setG = (k, val) => setF((s) => ({ ...s, gastos: { ...s.gastos, [k]: val } }));
  const num = (v) => (v === "" ? "" : +v);
  const extra = f.gastosExtra || [];
  const setExtra = (i, k, val) => setF((s) => ({ ...s, gastosExtra: s.gastosExtra.map((g, j) => j === i ? { ...g, [k]: val } : g) }));
  const addExtra = () => setF((s) => ({ ...s, gastosExtra: [...(s.gastosExtra || []), { concepto: "", monto: "" }] }));
  const delExtra = (i) => setF((s) => ({ ...s, gastosExtra: s.gastosExtra.filter((_, j) => j !== i) }));
  return (
    <Modal onClose={onClose}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}><b>{veh ? "Editar" : "Nuevo"} vehículo</b><Btn small kind="ghost" onClick={onClose}>✕</Btn></div>
      <SubT>Datos del vehículo</SubT>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
        <Field label="Marca"><input style={inp} value={f.marca} onChange={(e) => set("marca", e.target.value)} /></Field>
        <Field label="Modelo"><input style={inp} value={f.modelo} onChange={(e) => set("modelo", e.target.value)} /></Field>
        <Field label="Año"><input style={inp} value={f.anio} onChange={(e) => set("anio", e.target.value)} /></Field>
        <Field label="Color"><input style={inp} value={f.color} onChange={(e) => set("color", e.target.value)} /></Field>
        <Field label="Chapa"><input style={inp} value={f.chapa} onChange={(e) => set("chapa", e.target.value)} /></Field>
        <Field label="Kilometraje"><input type="number" style={inp} value={f.km} onChange={(e) => set("km", num(e.target.value))} /></Field>
        <Field label="VIN / Chasis"><input style={inp} value={f.vin} onChange={(e) => set("vin", e.target.value)} /></Field>
        <Field label="Combustible"><select style={inp} value={f.combustible} onChange={(e) => set("combustible", e.target.value)}>{COMBUSTIBLE.map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Condición"><select style={inp} value={f.condicion} onChange={(e) => set("condicion", e.target.value)}>{CONDICION.map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Procedencia"><select style={inp} value={f.procedencia} onChange={(e) => set("procedencia", e.target.value)}>{PROCEDENCIA.map((c) => <option key={c}>{c}</option>)}</select></Field>
      </div>
      <SubT>Vencimientos (opcional — avisan en Inicio)</SubT>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
        <Field label="Habilitación vence"><input type="date" style={inp} value={f.vencHab || ""} onChange={(e) => set("vencHab", e.target.value)} /></Field>
        <Field label="Seguro vence"><input type="date" style={inp} value={f.vencSeg || ""} onChange={(e) => set("vencSeg", e.target.value)} /></Field>
        <Field label="RTV vence"><input type="date" style={inp} value={f.vencRtv || ""} onChange={(e) => set("vencRtv", e.target.value)} /></Field>
      </div>
      <SubT>Costeo (todo en Gs)</SubT>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
        <Field label="Precio de compra"><input type="number" style={inp} value={f.precioCompra} onChange={(e) => set("precioCompra", num(e.target.value))} /></Field>
        {GASTOS_FIJOS.map(([k, l]) => <Field key={k} label={l}><input type="number" style={inp} value={f.gastos?.[k] ?? ""} onChange={(e) => setG(k, num(e.target.value))} /></Field>)}
        <Field label="Precio de VENTA"><input type="number" style={{ ...inp, borderColor: C.acc }} value={f.precioVenta} onChange={(e) => set("precioVenta", num(e.target.value))} /></Field>
      </div>
      <SubT>Otros gastos (motivo + monto)</SubT>
      {extra.map((g, i) => (
        <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
          <input style={{ ...inp, flex: 1 }} placeholder="Motivo del gasto (ej. grúa, trámite, repuesto)" value={g.concepto} onChange={(e) => setExtra(i, "concepto", e.target.value)} />
          <input type="number" style={{ ...inp, width: 150 }} placeholder="Monto Gs" value={g.monto} onChange={(e) => setExtra(i, "monto", e.target.value)} />
          <Btn small kind="ghost" onClick={() => delExtra(i)}>✕</Btn>
        </div>
      ))}
      <Btn small onClick={addExtra}>+ Agregar gasto</Btn>
      <div style={{ ...box, background: C.panel2, padding: 10, marginTop: 12, display: "flex", justifyContent: "space-between" }}><span>Costo total: <b>{money(costoTotal(f), "Gs")}</b></span><span style={{ color: margen(f) >= 0 ? C.ok : C.bad }}>Margen: <b>{money(margen(f), "Gs")} ({margenPct(f).toFixed(1)}%)</b></span></div>
      <SubT>Fotos del vehículo</SubT>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <FotosLocal label="Exterior" arr={f.fotosExt || []} onAdd={(imgs) => setF((s) => ({ ...s, fotosExt: [...(s.fotosExt || []), ...imgs] }))} onDel={(i) => setF((s) => ({ ...s, fotosExt: s.fotosExt.filter((_, k) => k !== i) }))} />
        <FotosLocal label="Interior" arr={f.fotosInt || []} onAdd={(imgs) => setF((s) => ({ ...s, fotosInt: [...(s.fotosInt || []), ...imgs] }))} onDel={(i) => setF((s) => ({ ...s, fotosInt: s.fotosInt.filter((_, k) => k !== i) }))} />
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: 12 }}>
        <div style={{ display: "flex", gap: 8 }}><Btn kind="ghost" onClick={() => facturaPDF(f, cfg)}>Factura gastos PDF</Btn><Btn kind="ghost" onClick={() => waFactura(f, cfg)} style={{ color: "#25D366", borderColor: "#25D366" }}>WhatsApp</Btn></div>
        <div style={{ display: "flex", gap: 8 }}><Btn kind="ghost" onClick={onClose}>Cancelar</Btn><Btn kind="acc" onClick={() => onSave(f)}>Guardar</Btn></div>
      </div>
    </Modal>
  );
}

// ============================================================ CLIENTES
function Clientes({ db, cfg, setDb, tid, selCli, setSelCli }) {
  const [edit, setEdit] = useState(null); const [q, setQ] = useState("");
  const addCli = (c) => setDb((s) => ({ ...s, clientes: [{ ...c, id: uid(), tenantId: tid, fechaAlta: today() }, ...s.clientes] }));
  const updCli = (id, patch) => setDb((s) => ({ ...s, clientes: s.clientes.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  const delCli = (id) => { const c = db.clientes.find((x) => x.id === id); if (!c) return; setDb((s) => ({ ...s, clientes: s.clientes.filter((x) => x.id !== id), papelera: [{ id: uid(), tenantId: tid, tipo: "cliente", data: c, fecha: today(), nombre: c.nombre }, ...(s.papelera || [])] })); };
  const lista = db.clientes.filter((c) => (c.nombre + " " + (c.ci || "")).toLowerCase().includes(q.toLowerCase()));
  const deudaCli = (id) => db.ventas.filter((v) => v.clienteId === id).reduce((a, v) => a + toGs(deudaVenta(v, cfg.tasaMora, cfg.cotizacion).total, v.moneda, cfg), 0);
  const conDeuda = db.clientes.filter((c) => deudaCli(c.id) > 0).length;
  const deudaTotal = db.clientes.reduce((a, c) => a + deudaCli(c.id), 0);
  if (selCli) { const cli = db.clientes.find((c) => c.id === selCli); if (cli) return <ClienteDetalle cli={cli} db={db} cfg={cfg} setDb={setDb} volver={() => setSelCli(null)} />; }
  return (
    <div>
      <Titulo icon="clientes" sub="Registro y ficha de clientes">Clientes</Titulo>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 16 }}><Kpi t="Clientes" v={db.clientes.length} /><Kpi t="Con deuda" v={conDeuda} c={conDeuda ? C.warn : C.ok} /><Kpi t="Deuda total (Gs eq.)" v={money(deudaTotal, "Gs")} c={deudaTotal ? C.bad : C.ok} /></div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}><b style={{ marginRight: "auto" }}>Registro de clientes</b><input style={{ ...inp, width: 220 }} placeholder="Buscar por nombre o C.I." value={q} onChange={(e) => setQ(e.target.value)} /><Btn kind="acc" onClick={() => setEdit("new")}>+ Nuevo cliente</Btn></div>
      {lista.length === 0 && <Empty t="Sin clientes. Registrá el primero." />}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {lista.map((c) => { const d = deudaCli(c.id); return (
          <div key={c.id} className="card-hover" style={{ ...box, padding: 12, display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 36, height: 36, borderRadius: "50%", background: c.foto ? `center/cover url(${c.foto})` : `linear-gradient(135deg, ${C.acc}, #123a86)`, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, flexShrink: 0 }}>{!c.foto && (c.nombre || "?")[0]}</div>
            <div style={{ flex: 1 }}><div style={{ fontWeight: 700 }}>{c.nombre}</div><div style={{ fontSize: 12, color: C.dim }}>C.I./RUC {c.ci || "—"} · {c.tel || "—"} · {c.ciudad || ""}</div></div>
            <div style={{ textAlign: "right", fontSize: 13 }}>{d > 0 ? <span style={{ color: C.bad }}>Debe {money(d, "Gs")}</span> : <span style={{ color: C.ok }}>Sin deuda</span>}</div>
            <Btn small onClick={() => setSelCli(c.id)}>Ver / Cobrar</Btn><Btn small kind="ghost" onClick={() => setEdit(c)}>Editar</Btn><Btn small kind="ghost" onClick={() => { if (confirm("¿Eliminar cliente?")) delCli(c.id); }}>✕</Btn>
          </div>
        ); })}
      </div>
      {edit && <ClienteModal cli={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSave={(c) => { if (edit === "new") addCli(c); else updCli(edit.id, c); setEdit(null); }} />}
    </div>
  );
}
function ClienteModal({ cli, onClose, onSave }) {
  const [f, setF] = useState(cli || { nombre: "", ci: "", tel: "", email: "", direccion: "", ciudad: "Ciudad del Este", ocupacion: "", notas: "" });
  const [firmaOpen, setFirmaOpen] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  return (
    <Modal onClose={onClose} w={560}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}><b>{cli ? "Editar" : "Nuevo"} cliente</b><Btn small kind="ghost" onClick={onClose}>✕</Btn></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="Nombre y apellido"><input style={inp} value={f.nombre} onChange={(e) => set("nombre", e.target.value)} /></Field>
        <Field label="C.I. / RUC"><input style={inp} value={f.ci} onChange={(e) => set("ci", e.target.value)} /></Field>
        <Field label="Teléfono (WhatsApp)"><input style={inp} value={f.tel} onChange={(e) => set("tel", e.target.value)} placeholder="0991 436196" /></Field>
        <Field label="Email"><input style={inp} value={f.email} onChange={(e) => set("email", e.target.value)} /></Field>
        <Field label="Dirección"><input style={inp} value={f.direccion} onChange={(e) => set("direccion", e.target.value)} /></Field>
        <Field label="Ciudad"><input style={inp} value={f.ciudad} onChange={(e) => set("ciudad", e.target.value)} /></Field>
        <Field label="Ocupación"><input style={inp} value={f.ocupacion} onChange={(e) => set("ocupacion", e.target.value)} /></Field>
      </div>
      <Field label="Notas"><textarea style={{ ...inp, minHeight: 50, marginTop: 10 }} value={f.notas} onChange={(e) => set("notas", e.target.value)} /></Field>
      <SubT>Foto del cliente y del documento</SubT>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <FotoUnica label="Foto del cliente" valor={f.foto} onSet={(d) => set("foto", d)} />
        <FotoUnica label="Foto del documento / licencia" valor={f.docFoto} onSet={(d) => set("docFoto", d)} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
        <span style={{ fontSize: 12, color: C.dim }}>Firma del cliente (para contratos/actas):</span>
        <Btn small onClick={() => setFirmaOpen(true)}>{f.firma ? "Editar firma" : "Firmar"}</Btn>
        {f.firma && <><img src={f.firma} style={{ height: 34, background: "#fff", borderRadius: 4, padding: 2 }} /><Btn small kind="ghost" onClick={() => set("firma", null)}>Quitar</Btn></>}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}><Btn kind="ghost" onClick={onClose}>Cancelar</Btn><Btn kind="acc" onClick={() => f.nombre ? onSave(f) : alert("Ingresá el nombre")}>Guardar</Btn></div>
      {firmaOpen && <FirmaPad valor={f.firma} titulo="Firma del cliente" onSave={(d) => { set("firma", d || null); setFirmaOpen(false); }} onClose={() => setFirmaOpen(false)} />}
    </Modal>
  );
}

function PagoModal({ venta, cli, veh, cuota: c, cfg, onClose, onConfirm }) {
  const m = venta.moneda; const cot = cfg.cotizacion || 1;
  const vencida = c.venc < today(); const mora = vencida ? calcMora(c, cfg.tasaMora) : { dias: 0, monto: 0 };
  const [descMora, setDescMora] = useState("");
  const effMora = Math.max(0, mora.monto - (+descMora || 0));
  const total = (c.monto || 0) + effMora;
  const totalGs = m === "USD" ? total * cot : total;
  const abonadoGs = c.abonadoGs || 0;
  const saldoGs = Math.max(0, totalGs - abonadoGs); const saldoUSD = saldoGs / cot;
  const [pagoGs, setPagoGs] = useState(""); const [pagoUSD, setPagoUSD] = useState("");
  const gs = +pagoGs || 0, usd = +pagoUSD || 0;
  const pagadoGs = gs + usd * cot;
  const faltaGs = Math.max(0, saldoGs - pagadoGs); const faltaUSD = faltaGs / cot; const vueltoGs = Math.max(0, pagadoGs - saldoGs);
  const completo = pagadoGs + 1 >= saldoGs;
  const parcial = pagadoGs > 0 && !completo;
  const completarGs = () => setPagoGs(String(Math.round(Math.max(0, saldoGs - usd * cot))));
  const completarUSD = () => setPagoUSD((Math.max(0, saldoGs - gs) / cot).toFixed(2));
  const cuadro = { ...box, background: C.panel2, padding: 12 };
  return (
    <Modal onClose={onClose} w={440}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}><b>Registrar pago — Cuota {c.n}/{venta.plan.length}</b><Btn small kind="ghost" onClick={onClose}>✕</Btn></div>
      <div style={{ ...box, background: C.panel2, padding: 14 }}>
        <Rows rows={[["Cuota", money(c.monto, m)], ["Vencimiento", c.venc]]} />
        {vencida && <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 8, paddingTop: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", color: C.bad, fontSize: 13 }}><span>Atraso</span><span>{mora.dias} días</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", color: C.bad, fontSize: 13, fontWeight: 700 }}><span>Interés por mora ({cfg.tasaMora}%/mes)</span><span>{money(mora.monto, m)}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}><span style={{ fontSize: 12, color: C.dim }}>Descuento de intereses <a onClick={() => setDescMora(String(Math.round(mora.monto)))} style={{ color: C.acc, cursor: "pointer" }}>bonificar todo</a></span><input type="number" style={{ ...inp, width: 130 }} value={descMora} onChange={(e) => setDescMora(e.target.value)} placeholder="0" /></div>
          {effMora !== mora.monto && <div style={{ display: "flex", justifyContent: "space-between", color: C.ok, fontSize: 13, fontWeight: 700 }}><span>Interés a cobrar (con descuento)</span><span>{money(effMora, m)}</span></div>}
        </div>}
        {abonadoGs > 0 && <div style={{ display: "flex", justifyContent: "space-between", color: C.ok, fontSize: 13, marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.border}` }}><span>Ya abonado</span><span>Gs {nf.format(Math.round(abonadoGs))}</span></div>}
        <div style={{ borderTop: `2px solid ${C.acc}`, marginTop: 10, paddingTop: 10, display: "flex", justifyContent: "space-between", fontSize: 18, fontWeight: 800 }}><span>SALDO A PAGAR</span><span style={{ color: C.acc }}>{m === "USD" ? "US$ " + saldoUSD.toFixed(2) : money(saldoGs, "Gs")}</span></div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.dim, marginTop: 2 }}><span>Gs {nf.format(Math.round(saldoGs))}</span><span>US$ {saldoUSD.toFixed(2)}</span></div>
      </div>
      <SubT>Monto pagado (parcial o total, puede ser mixto)</SubT>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div style={cuadro}><div style={{ fontSize: 12, color: C.dim, marginBottom: 6, display: "flex", justifyContent: "space-between" }}>Guaraníes (Gs) <a onClick={completarGs} style={{ color: C.acc, cursor: "pointer" }}>completar</a></div><input type="number" style={{ ...inp, fontSize: 16 }} value={pagoGs} onChange={(e) => setPagoGs(e.target.value)} placeholder="0" /></div>
        <div style={cuadro}><div style={{ fontSize: 12, color: C.dim, marginBottom: 6, display: "flex", justifyContent: "space-between" }}>Dólares (US$) <a onClick={completarUSD} style={{ color: C.acc, cursor: "pointer" }}>completar</a></div><input type="number" style={{ ...inp, fontSize: 16 }} value={pagoUSD} onChange={(e) => setPagoUSD(e.target.value)} placeholder="0" /></div>
      </div>
      <div style={{ ...box, padding: 12, marginTop: 12, background: completo ? "rgba(34,211,154,.08)" : parcial ? "rgba(43,123,255,.08)" : "rgba(245,166,35,.08)", borderColor: completo ? C.ok : parcial ? C.acc : C.warn }}>
        {completo ? <div style={{ display: "flex", justifyContent: "space-between", color: C.ok, fontWeight: 700 }}><span>✓ Cuota cancelada</span>{vueltoGs > 1 && <span style={{ color: C.warn }}>Vuelto: Gs {nf.format(Math.round(vueltoGs))}</span>}</div>
          : parcial ? <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ fontSize: 13, color: C.acc, fontWeight: 700 }}>Abono parcial · queda saldo:</div><div style={{ textAlign: "right" }}><div style={{ fontWeight: 700 }}>Gs {nf.format(Math.round(faltaGs))}</div><div style={{ fontSize: 12, color: C.dim }}>o US$ {faltaUSD.toFixed(2)}</div></div></div>
          : <div style={{ fontSize: 13, color: C.dim }}>Ingresá el monto (podés abonar una parte).</div>}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}><Btn kind="ghost" onClick={onClose}>Cancelar</Btn><Btn kind="ok" onClick={() => pagadoGs > 0 ? onConfirm({ pagoGs: gs, pagoUSD: usd, moraMonto: effMora, diasAtraso: mora.dias }) : alert("Ingresá un monto mayor a 0.")}>{parcial ? "Registrar abono" : "Confirmar pago"}</Btn></div>
    </Modal>
  );
}
function ClienteDetalle({ cli, db, cfg, setDb, volver }) {
  const [pago, setPago] = useState(null);
  const [refin, setRefin] = useState(null);
  const ventas = db.ventas.filter((v) => v.clienteId === cli.id && v.plan);
  const veh = (id) => db.vehiculos.find((x) => x.id === id) || {};
  const registrarPago = (ventaId, n, extra) => {
    const venta = db.ventas.find((x) => x.id === ventaId); const vh = veh(venta.vehiculoId);
    const c = venta.plan.find((x) => x.n === n); const m = venta.moneda; const cot = cfg.cotizacion || 1;
    const total = (c.monto || 0) + (extra.moraMonto || 0);
    const totalGs = m === "USD" ? total * cot : total;
    const abonPrev = c.abonadoGs || 0;
    const saldoGs = Math.max(0, totalGs - abonPrev);
    const pagadoGs = (extra.pagoGs || 0) + (extra.pagoUSD || 0) * cot;
    const completo = pagadoGs + 1 >= saldoGs;
    const abonNuevo = abonPrev + pagadoGs;
    const nuevaCuota = completo
      ? { ...c, pagado: true, fechaPago: today(), moraPagada: extra.moraMonto, diasAtrasoPago: extra.diasAtraso, pagoGs: extra.pagoGs, pagoUSD: extra.pagoUSD, abonadoGs: abonNuevo }
      : { ...c, abonadoGs: abonNuevo, ultimoAbono: { pagoGs: extra.pagoGs, pagoUSD: extra.pagoUSD, fecha: today() } };
    setDb((s) => ({
      ...s,
      ventas: s.ventas.map((v) => v.id !== ventaId ? v : { ...v, plan: v.plan.map((x) => x.n !== n ? x : nuevaCuota) }),
      caja: [{ id: uid(), tenantId: venta.tenantId, fecha: today(), tipo: "ingreso", concepto: `${completo ? "Cobro" : "Abono"} cuota ${n} — ${cli.nombre} (${vh.marca || ""} ${vh.modelo || ""})`, monto: Math.round(pagadoGs), moneda: "Gs", ref: `pago:${ventaId}:${n}:${uid()}`, auto: true }, ...(s.caja || [])],
    }));
    setPago(null);
    auditar(setDb, completo ? "Registró cobro de cuota" : "Registró abono parcial", `${cli.nombre} · cuota ${n} · ${money(pagadoGs, "Gs")}`);
    if (completo) reciboPDF(cli, venta, vh, nuevaCuota, m, cfg);
    else abonoPDF(cli, venta, vh, c, { pagoGs: extra.pagoGs, pagoUSD: extra.pagoUSD, pagadoGs, saldoGs: Math.max(0, saldoGs - pagadoGs) }, m, cfg);
  };
  const anularPago = (ventaId, n) => setDb((s) => ({ ...s, ventas: s.ventas.map((v) => v.id !== ventaId ? v : { ...v, plan: v.plan.map((c) => c.n === n ? { ...c, pagado: false, fechaPago: null, moraPagada: 0, diasAtrasoPago: 0, pagoGs: 0, pagoUSD: 0, abonadoGs: 0, ultimoAbono: null } : c) }), caja: (s.caja || []).filter((m) => !(m.ref || "").startsWith(`pago:${ventaId}:${n}:`)) }));
  const refinanciar = (ventaId, datos) => {
    const venta = db.ventas.find((x) => x.id === ventaId); const vh = veh(venta.vehiculoId);
    const pagadas = venta.plan.filter((c) => c.pagado);
    const pend = venta.plan.filter((c) => !c.pagado);
    const capital = pend.reduce((a, c) => a + c.monto, 0);
    const mora = pend.filter((c) => c.venc < today()).reduce((a, c) => a + calcMora(c, cfg.tasaMora).monto, 0);
    const saldo = capital + mora; const entrega = +datos.entrega || 0;
    const r = generarPlan(saldo, entrega, +datos.nCuotas, +datos.tasa, datos.fecha);
    const startN = pagadas.reduce((mx, c) => Math.max(mx, c.n), 0);
    const nuevas = r.plan.map((c, i) => ({ ...c, n: startN + i + 1 }));
    const totalGs = toGs(entrega, venta.moneda, cfg);
    setDb((s) => ({
      ...s,
      ventas: s.ventas.map((v) => v.id !== ventaId ? v : { ...v, plan: [...pagadas, ...nuevas], cuota: r.cuota, capital: r.capital, tasa: +datos.tasa, refinanciaciones: [...(v.refinanciaciones || []), { fecha: datos.fecha, saldo, entrega, nCuotas: +datos.nCuotas, tasa: +datos.tasa }] }),
      caja: entrega > 0 ? [{ id: uid(), tenantId: venta.tenantId, fecha: datos.fecha, tipo: "ingreso", concepto: `Abono refinanciación — ${cli.nombre} (${vh.marca || ""} ${vh.modelo || ""})`, monto: Math.round(totalGs), moneda: "Gs", ref: `refin:${ventaId}:${uid()}`, auto: true }, ...(s.caja || [])] : (s.caja || []),
    }));
    refinPDF(cli, vh, { saldo, entrega, base: r.capital, nCuotas: +datos.nCuotas, cuota: r.cuota, tasa: +datos.tasa, fecha: datos.fecha, moneda: venta.moneda }, cfg);
    setRefin(null);
  };
  const deudaGs = ventas.reduce((a, v) => a + toGs(deudaVenta(v, cfg.tasaMora, cfg.cotizacion).total, v.moneda, cfg), 0);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <Btn small kind="ghost" onClick={volver}>← Volver</Btn>
        <div><div style={{ fontWeight: 800, fontSize: 18 }}>{cli.nombre}</div><div style={{ fontSize: 12, color: C.dim }}>C.I./RUC {cli.ci || "—"} · {cli.tel || "—"} · {cli.direccion || ""} {cli.ciudad || ""}</div></div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          {ventas.length > 0 && <Btn small onClick={() => estadoCuentaPDF(cli, ventas, db.vehiculos, cfg)}>Estado de cuenta PDF</Btn>}
          <div style={{ textAlign: "right" }}><div style={{ fontSize: 11, color: C.dim }}>DEUDA TOTAL (Gs eq.)</div><div style={{ fontWeight: 800, fontSize: 18, color: deudaGs ? C.bad : C.ok }}>{money(deudaGs, "Gs")}</div></div>
        </div>
      </div>
      {ventas.length === 0 && <Empty t="Este cliente no tiene compras a crédito registradas." />}
      {ventas.map((v) => { const vh = veh(v.vehiculoId); const m = v.moneda; const d = deudaVenta(v, cfg.tasaMora, cfg.cotizacion); return (
        <div key={v.id} style={{ ...box, marginBottom: 14 }}>
          <div style={{ padding: 12, borderBottom: `1px solid ${C.border}`, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontWeight: 700 }}>🚗 {vh.marca} {vh.modelo} {vh.anio} <span style={{ color: C.dim, fontWeight: 400 }}>· {vh.color} · chasis {vh.vin || "—"}</span></div>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
              <Btn small kind="ghost" onClick={() => pagarePDF(cli, v, vh, cfg)}>Pagaré</Btn>
              {v.plan.some((c) => !c.pagado) && <Btn small kind="ghost" onClick={() => setRefin(v)} style={{ color: C.warn, borderColor: C.warn }}>Refinanciar</Btn>}
              <span style={{ fontSize: 12, color: C.dim }}>Venta {v.fecha} · {v.plan.length} cuotas · {v.tasa}% anual{(v.refinanciaciones || []).length ? " · refinanciada" : ""}</span>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, padding: 12 }}>
            <Kpi t="Precio" v={money(v.precio, m)} /><Kpi t="Cuota mensual" v={money(v.cuota, m)} /><Kpi t="Saldo capital" v={money(d.capital, m)} /><Kpi t="Interés mora" v={money(d.mora, m)} c={d.mora ? C.bad : C.ok} />
          </div>
          {d.vencidas > 0 && <div style={{ margin: "0 12px 12px", padding: 10, ...box, borderColor: C.bad, background: "rgba(231,76,60,.10)", color: C.bad, fontSize: 13, fontWeight: 600 }}>🔔 {d.vencidas} cuota(s) atrasada(s) · Total exigible con interés: {money(d.total, m)}</div>}
          <div style={{ overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ background: C.panel2, color: C.dim, textAlign: "left" }}><th style={th}>Cuota</th><th style={th}>Vence</th><th style={th}>Monto</th><th style={th}>Atraso</th><th style={th}>Interés generado</th><th style={th}>Total a pagar</th><th style={th}>Estado</th><th style={th}>Acción</th></tr></thead>
              <tbody>{v.plan.map((c) => {
                const vencida = !c.pagado && c.venc < today(); const mora = vencida ? calcMora(c, cfg.tasaMora) : { dias: c.diasAtrasoPago || 0, monto: 0 };
                const interes = c.pagado ? (c.moraPagada || 0) : mora.monto; const total = (c.monto || 0) + interes;
                const cot = cfg.cotizacion || 1; const abonMon = (c.abonadoGs || 0) ? (m === "USD" ? (c.abonadoGs / cot) : c.abonadoGs) : 0; const saldoMon = Math.max(0, total - abonMon); const parcialRow = !c.pagado && (c.abonadoGs || 0) > 0;
                return (
                  <tr key={c.n} style={{ borderTop: `1px solid ${C.border}`, background: vencida ? "rgba(255,92,98,.06)" : "transparent" }}>
                    <td style={td}>{c.n}/{v.plan.length}</td><td style={td}>{c.venc}</td><td style={td}>{money(c.monto, m)}</td>
                    <td style={{ ...td, color: interes ? C.bad : C.dim }}>{c.pagado ? (c.diasAtrasoPago ? c.diasAtrasoPago + "d" : "—") : vencida ? mora.dias + "d" : "—"}</td>
                    <td style={{ ...td, color: interes ? C.bad : C.dim, fontWeight: interes ? 700 : 400 }}>{money(interes, m)}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{parcialRow ? money(saldoMon, m) : money(total, m)}{parcialRow && <div style={{ fontSize: 11, color: C.dim, fontWeight: 400 }}>abonó {money(abonMon, m)}</div>}</td>
                    <td style={{ ...td, color: c.pagado ? C.ok : parcialRow ? C.acc : vencida ? C.bad : C.dim }}>{c.pagado ? "✓ Pagada" : parcialRow ? "Parcial" : vencida ? "Vencida" : "Pendiente"}</td>
                    <td style={td}>{c.pagado ? <div style={{ display: "flex", gap: 6 }}><Btn small kind="ghost" onClick={() => reciboPDF(cli, v, vh, c, m, cfg)}>Recibo</Btn><Btn small kind="ghost" onClick={() => waRecibo(cli, v, vh, c, m, cfg)} style={{ color: "#25D366", borderColor: "#25D366" }}>WhatsApp</Btn><Btn small kind="ghost" onClick={() => anularPago(v.id, c.n)}>Anular</Btn></div> : <div style={{ display: "flex", gap: 6 }}><Btn small kind="ok" onClick={() => setPago({ ventaId: v.id, cuota: c })}>{parcialRow ? "Abonar más" : "Agregar pago"}</Btn>{parcialRow && <Btn small kind="ghost" onClick={() => anularPago(v.id, c.n)}>Anular</Btn>}</div>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        </div>
      ); })}
      {pago && (() => { const v = db.ventas.find((x) => x.id === pago.ventaId); return <PagoModal venta={v} cli={cli} veh={veh(v.vehiculoId)} cuota={pago.cuota} cfg={cfg} onClose={() => setPago(null)} onConfirm={(ex) => registrarPago(v.id, pago.cuota.n, ex)} />; })()}
      {refin && <RefinanciarModal venta={refin} cfg={cfg} onClose={() => setRefin(null)} onConfirm={(d) => refinanciar(refin.id, d)} />}
    </div>
  );
}

// ============================================================ VENTAS
function Ventas({ db, cfg, setDb, tid, vendedor, vehParaVenta, setVehParaVenta, setVeh }) {
  const disponibles = db.vehiculos.filter((v) => v.estado !== "Vendido");
  const [tipo, setTipo] = useState("credito");
  const [f, setF] = useState({ clienteId: "", vehiculoId: vehParaVenta || "", moneda: cfg.moneda, entrega: "", nCuotas: 12, tasa: 0, fecha: today() });
  const [precio, setPrecio] = useState("");
  const [permutaOn, setPermutaOn] = useState(false);
  const [pf, setPf] = useState({ marca: "", modelo: "", anio: "", chapa: "", color: "", valor: "" });
  const [garanteOn, setGaranteOn] = useState(false);
  const [gf, setGf] = useState({ nombre: "", ci: "", tel: "", direccion: "" });
  const setG = (k, v) => setGf((s) => ({ ...s, [k]: v }));
  const setP = (k, v) => setPf((s) => ({ ...s, [k]: v }));
  useEffect(() => { if (vehParaVenta) { setF((s) => ({ ...s, vehiculoId: vehParaVenta })); setVehParaVenta(null); } }, []);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const veh = db.vehiculos.find((v) => v.id === f.vehiculoId);
  const precioBase = veh ? (f.moneda === "USD" ? (veh.precioVenta || 0) / cfg.cotizacion : veh.precioVenta || 0) : 0;
  const precioFinal = precio === "" ? precioBase : +precio;
  const prev = veh && tipo === "credito" ? generarPlan(precioFinal, +f.entrega || 0, +f.nCuotas, +f.tasa, f.fecha) : null;
  const mkPermuta = () => {
    if (!permutaOn || !(+pf.valor)) return { veh: null, valorGs: 0 };
    const nv = { id: uid(), tenantId: tid, marca: pf.marca, modelo: pf.modelo, anio: pf.anio, chapa: pf.chapa, color: pf.color, vin: "", km: "", combustible: "Nafta", condicion: "Bueno", procedencia: "Recibido en permuta", fechaIngreso: today(), estado: "Disponible", precioCompra: +pf.valor, precioVenta: +pf.valor, gastos: {}, gastosExtra: [], fotosExt: [], fotosInt: [], nota: "Recibido en permuta" };
    return { veh: nv, valorGs: +pf.valor };
  };
  const limpiar = () => { setF({ clienteId: "", vehiculoId: "", moneda: cfg.moneda, entrega: "", nCuotas: 12, tasa: 0, fecha: today() }); setPrecio(""); setPermutaOn(false); setPf({ marca: "", modelo: "", anio: "", chapa: "", color: "", valor: "" }); setGaranteOn(false); setGf({ nombre: "", ci: "", tel: "", direccion: "" }); };
  const confirmarCredito = () => {
    if (!f.clienteId) return alert("Elegí un cliente"); if (!veh) return alert("Elegí un vehículo");
    const { veh: pv, valorGs } = mkPermuta();
    const permutaMon = f.moneda === "USD" ? valorGs / cfg.cotizacion : valorGs;
    const r = generarPlan(precioFinal, (+f.entrega || 0) + permutaMon, +f.nCuotas, +f.tasa, f.fecha);
    const id = uid();
    setDb((s) => ({
      ...s,
      ventas: [{ id, tenantId: tid, tipo: "credito", vendedor, clienteId: f.clienteId, vehiculoId: f.vehiculoId, fecha: f.fecha, moneda: f.moneda, precio: precioFinal, entrega: +f.entrega || 0, nCuotas: +f.nCuotas, tasa: +f.tasa, permuta: pv ? { vehiculoId: pv.id, valorGs, desc: `${pf.marca} ${pf.modelo} ${pf.anio}` } : null, garante: garanteOn && gf.nombre ? { ...gf } : null, ...r }, ...s.ventas],
      vehiculos: (pv ? [pv, ...s.vehiculos] : s.vehiculos).map((v) => v.id === f.vehiculoId ? { ...v, estado: "Vendido", clienteId: f.clienteId } : v),
    }));
    limpiar();
    auditar(setDb, "Registró venta a crédito", `${(db.clientes.find((c) => c.id === f.clienteId) || {}).nombre || ""} — ${veh.marca} ${veh.modelo} · ${money(precioFinal, f.moneda)}`);
    alert("Venta a crédito registrada." + (pv ? " Auto recibido en permuta agregado al stock." : "") + " Seguí el cobro en Cobranza.");
  };
  const confirmarContado = () => {
    if (!f.clienteId) return alert("Elegí un cliente"); if (!veh) return alert("Elegí un vehículo");
    const id = uid(); const cli = db.clientes.find((c) => c.id === f.clienteId) || {};
    const { veh: pv, valorGs } = mkPermuta();
    const permutaMon = f.moneda === "USD" ? valorGs / cfg.cotizacion : valorGs;
    const cashMon = Math.max(0, precioFinal - permutaMon);
    const cashGs = Math.round(toGs(cashMon, f.moneda, cfg));
    setDb((s) => ({
      ...s,
      ventas: [{ id, tenantId: tid, tipo: "contado", vendedor, clienteId: f.clienteId, vehiculoId: f.vehiculoId, fecha: f.fecha, moneda: f.moneda, precio: precioFinal, permuta: pv ? { vehiculoId: pv.id, valorGs, desc: `${pf.marca} ${pf.modelo} ${pf.anio}` } : null }, ...s.ventas],
      vehiculos: (pv ? [pv, ...s.vehiculos] : s.vehiculos).map((v) => v.id === f.vehiculoId ? { ...v, estado: "Vendido", clienteId: f.clienteId } : v),
      caja: cashGs > 0 ? [{ id: uid(), tenantId: tid, fecha: f.fecha, tipo: "ingreso", concepto: `Venta contado — ${cli.nombre} (${veh.marca} ${veh.modelo})${pv ? " [con permuta]" : ""}`, monto: cashGs, moneda: "Gs", ref: `venta:${id}`, auto: true }, ...(s.caja || [])] : (s.caja || []),
    }));
    reciboContadoPDF(cli, { precio: precioFinal, moneda: f.moneda, fecha: f.fecha, id }, veh, cfg);
    limpiar();
    auditar(setDb, "Registró venta al contado", `${cli.nombre || ""} — ${veh.marca} ${veh.modelo} · ${money(precioFinal, f.moneda)}`);
    alert("Venta al contado registrada." + (pv ? " Auto recibido en permuta agregado al stock." : ""));
  };
  const permutaUI = (
    <div style={{ marginTop: 12 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.txt }}><input type="checkbox" checked={permutaOn} onChange={(e) => setPermutaOn(e.target.checked)} />Recibe un auto en parte de pago (permuta)</label>
      {permutaOn && (
        <div style={{ ...box, background: C.panel2, padding: 12, marginTop: 8 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
            <Field label="Marca"><input style={inp} value={pf.marca} onChange={(e) => setP("marca", e.target.value)} /></Field>
            <Field label="Modelo"><input style={inp} value={pf.modelo} onChange={(e) => setP("modelo", e.target.value)} /></Field>
            <Field label="Año"><input style={inp} value={pf.anio} onChange={(e) => setP("anio", e.target.value)} /></Field>
            <Field label="Chapa"><input style={inp} value={pf.chapa} onChange={(e) => setP("chapa", e.target.value)} /></Field>
            <Field label="Color"><input style={inp} value={pf.color} onChange={(e) => setP("color", e.target.value)} /></Field>
            <Field label="Valor de toma (Gs)"><input type="number" style={{ ...inp, borderColor: C.acc }} value={pf.valor} onChange={(e) => setP("valor", e.target.value)} /></Field>
          </div>
          <div style={{ fontSize: 12, color: C.dim, marginTop: 6 }}>El auto entra al stock como Disponible (costo = valor de toma) y su valor se descuenta del pago.</div>
        </div>
      )}
    </div>
  );
  const delVenta = (v) => { if (confirm("¿Eliminar esta venta? El vehículo volverá a Disponible (podés restaurarla desde Papelera).")) { const cli = db.clientes.find((c) => c.id === v.clienteId) || {}; const vh = db.vehiculos.find((x) => x.id === v.vehiculoId) || {}; setDb((s) => ({ ...s, ventas: s.ventas.filter((x) => x.id !== v.id), caja: (s.caja || []).filter((m) => m.ref !== `venta:${v.id}` && !(m.ref || "").startsWith(`pago:${v.id}:`)), papelera: [{ id: uid(), tenantId: tid, tipo: "venta", data: v, fecha: today(), nombre: `${cli.nombre || ""} — ${vh.marca || ""} ${vh.modelo || ""}` }, ...(s.papelera || [])] })); setVeh(v.vehiculoId, { estado: "Disponible" }); } };
  return (
    <div>
      <Titulo icon="ventas" sub="Ventas a crédito y al contado">Ventas</Titulo>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <Btn kind={tipo === "credito" ? "acc" : "ghost"} onClick={() => setTipo("credito")}>Venta a crédito</Btn>
        <Btn kind={tipo === "contado" ? "acc" : "ghost"} onClick={() => setTipo("contado")}>Venta al contado</Btn>
      </div>
      {db.clientes.length === 0 && <div style={{ ...box, padding: 10, margin: "10px 0", color: C.warn, fontSize: 13 }}>⚠ Primero registrá un cliente.</div>}
      <div style={{ ...box, padding: 16, marginTop: 4 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Cliente"><select style={inp} value={f.clienteId} onChange={(e) => set("clienteId", e.target.value)}><option value="">— Elegir cliente —</option>{db.clientes.map((c) => <option key={c.id} value={c.id}>{c.nombre} · {c.ci}</option>)}</select></Field>
          <Field label="Vehículo (disponible)"><select style={inp} value={f.vehiculoId} onChange={(e) => set("vehiculoId", e.target.value)}><option value="">— Elegir vehículo —</option>{disponibles.map((v) => <option key={v.id} value={v.id}>{v.marca} {v.modelo} {v.anio} · {money(v.precioVenta, "Gs")}</option>)}</select></Field>
        </div>
        {tipo === "credito" ? (
          <>
            <SubT>Condiciones de financiación</SubT>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
              <Field label="Moneda"><select style={inp} value={f.moneda} onChange={(e) => { set("moneda", e.target.value); setPrecio(""); }}><option>Gs</option><option>USD</option></select></Field>
              <Field label={`Precio venta (${f.moneda})`}><input type="number" style={inp} value={precio} placeholder={veh ? Math.round(precioBase).toString() : ""} onChange={(e) => setPrecio(e.target.value)} /></Field>
              <Field label={`Entrega inicial (${f.moneda})`}><input type="number" style={inp} value={f.entrega} onChange={(e) => set("entrega", e.target.value)} /></Field>
              <Field label="N° de cuotas"><input type="number" style={inp} value={f.nCuotas} onChange={(e) => set("nCuotas", e.target.value)} /></Field>
              <Field label="Interés anual %"><input type="number" style={inp} value={f.tasa} onChange={(e) => set("tasa", e.target.value)} /></Field>
              <Field label="Fecha 1ª cuota (base)"><input type="date" style={inp} value={f.fecha} onChange={(e) => set("fecha", e.target.value)} /></Field>
            </div>
            {prev && <div style={{ ...box, background: C.panel2, padding: 12, marginTop: 12, display: "flex", gap: 24, flexWrap: "wrap" }}><span style={{ color: C.dim }}>Capital: <b style={{ color: C.txt }}>{money(prev.capital, f.moneda)}</b></span><span style={{ color: C.dim }}>Cuota: <b style={{ color: C.ok }}>{money(prev.cuota, f.moneda)}</b></span><span style={{ color: C.dim }}>Total: <b style={{ color: C.txt }}>{money(prev.cuota * f.nCuotas + (+f.entrega || 0), f.moneda)}</b></span></div>}
            <div style={{ marginTop: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.txt }}><input type="checkbox" checked={garanteOn} onChange={(e) => setGaranteOn(e.target.checked)} />Agregar garante / codeudor</label>
              {garanteOn && (
                <div style={{ ...box, background: C.panel2, padding: 12, marginTop: 8 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 10 }}>
                    <Field label="Nombre del garante"><input style={inp} value={gf.nombre} onChange={(e) => setG("nombre", e.target.value)} /></Field>
                    <Field label="C.I. / RUC"><input style={inp} value={gf.ci} onChange={(e) => setG("ci", e.target.value)} /></Field>
                    <Field label="Teléfono"><input style={inp} value={gf.tel} onChange={(e) => setG("tel", e.target.value)} /></Field>
                    <Field label="Dirección"><input style={inp} value={gf.direccion} onChange={(e) => setG("direccion", e.target.value)} /></Field>
                  </div>
                  <div style={{ fontSize: 12, color: C.dim, marginTop: 6 }}>El garante figura en el contrato como codeudor solidario, con su propia línea de firma.</div>
                </div>
              )}
            </div>
            {permutaUI}
            <div style={{ marginTop: 14 }}><Btn kind="acc" onClick={confirmarCredito}>Registrar venta a crédito</Btn></div>
          </>
        ) : (
          <>
            <SubT>Venta al contado</SubT>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
              <Field label="Moneda"><select style={inp} value={f.moneda} onChange={(e) => { set("moneda", e.target.value); setPrecio(""); }}><option>Gs</option><option>USD</option></select></Field>
              <Field label={`Precio (${f.moneda})`}><input type="number" style={inp} value={precio} placeholder={veh ? Math.round(precioBase).toString() : ""} onChange={(e) => setPrecio(e.target.value)} /></Field>
              <Field label="Fecha"><input type="date" style={inp} value={f.fecha} onChange={(e) => set("fecha", e.target.value)} /></Field>
            </div>
            {permutaUI}
            <div style={{ marginTop: 14 }}><Btn kind="ok" onClick={confirmarContado}>Registrar venta al contado + recibo</Btn></div>
          </>
        )}
      </div>
      <div style={{ marginTop: 20 }}>
        <b>Ventas registradas ({db.ventas.length})</b>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
          {db.ventas.map((v) => { const cli = db.clientes.find((c) => c.id === v.clienteId) || {}; const vh = db.vehiculos.find((x) => x.id === v.vehiculoId) || {}; const contado = v.tipo === "contado" || !v.plan; const d = contado ? null : deudaVenta(v, cfg.tasaMora, cfg.cotizacion); return (
            <div key={v.id} className="card-hover" style={{ ...box, padding: 12, display: "flex", gap: 12, alignItems: "center" }}>
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: contado ? "rgba(34,211,154,.15)" : "rgba(43,123,255,.15)", color: contado ? C.ok : C.acc }}>{contado ? "CONTADO" : "CRÉDITO"}</span>
              <div style={{ flex: 1 }}><div style={{ fontWeight: 700 }}>{cli.nombre} <span style={{ color: C.dim, fontWeight: 400 }}>— {vh.marca} {vh.modelo} {vh.anio}</span>{v.permuta && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 20, background: "rgba(124,108,255,.18)", color: C.dev }}>PERMUTA</span>}{v.garante && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 20, background: "rgba(245,166,35,.18)", color: C.warn }}>GARANTE</span>}</div><div style={{ fontSize: 12, color: C.dim }}>{v.fecha}{contado ? " · " + money(v.precio, v.moneda) : " · " + v.plan.length + " cuotas · cuota " + money(v.cuota, v.moneda)}{v.vendedor ? " · " + v.vendedor : ""}{v.permuta ? " · recibe " + v.permuta.desc : ""}</div></div>
              <div style={{ textAlign: "right", fontSize: 13 }}>{contado ? <span style={{ color: C.ok }}>Pagado</span> : d.total > 0 ? <span style={{ color: d.vencidas ? C.bad : C.warn }}>Saldo {money(d.total, v.moneda)}</span> : <span style={{ color: C.ok }}>Cancelada</span>}</div>
              {!contado && <Btn small kind="ghost" onClick={() => contratoPDF(cli, v, vh, cfg)}>Contrato PDF</Btn>}
              <Btn small kind="ghost" onClick={() => actaEntregaPDF(cli, v, vh, cfg)}>Acta entrega</Btn>
              <Btn small kind="ghost" onClick={() => delVenta(v)} style={{ color: C.bad, borderColor: C.bad }}>✕</Btn>
            </div>
          ); })}
        </div>
      </div>
    </div>
  );
}

// ============================================================ COBRANZA
function Cobranza({ db, cfg, setDb, selCli, setSelCli }) {
  const [q, setQ] = useState("");
  const ventasCred = (id) => db.ventas.filter((v) => v.clienteId === id && v.plan);
  const deudaCli = (id) => ventasCred(id).reduce((acc, v) => { const d = deudaVenta(v, cfg.tasaMora, cfg.cotizacion); return { total: acc.total + toGs(d.total, v.moneda, cfg), venc: acc.venc + d.vencidas }; }, { total: 0, venc: 0 });
  if (selCli) { const cli = db.clientes.find((c) => c.id === selCli); if (cli) return <ClienteDetalle cli={cli} db={db} cfg={cfg} setDb={setDb} volver={() => setSelCli(null)} />; }
  const lista = db.clientes.filter((c) => ventasCred(c.id).length > 0).filter((c) => (c.nombre + " " + (c.ci || "")).toLowerCase().includes(q.toLowerCase()));
  const recordar = (cli, e) => { e.stopPropagation(); waRecordatorio(cli, ventasCred(cli.id), db.vehiculos, cfg); };
  return (
    <div>
      <Titulo icon="cobranza" sub="Cobro de cuotas de ventas a crédito">Cobranza</Titulo>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}><b style={{ marginRight: "auto" }}>Seleccioná un cliente</b><input style={{ ...inp, width: 220 }} placeholder="Buscar cliente" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {lista.length === 0 && <Empty t="No hay clientes con ventas a crédito." />}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {lista.map((c) => { const d = deudaCli(c.id); return (
          <div key={c.id} className="card-hover" style={{ ...box, padding: 12, display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }} onClick={() => setSelCli(c.id)}>
            <div style={{ width: 40, height: 40, borderRadius: "50%", background: `linear-gradient(135deg, ${C.acc}, #123a86)`, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>{c.nombre[0]}</div>
            <div style={{ flex: 1 }}><div style={{ fontWeight: 700 }}>{c.nombre}</div><div style={{ fontSize: 12, color: C.dim }}>{c.tel || "—"} · {ventasCred(c.id).length} crédito(s)</div></div>
            {d.venc > 0 && <span style={{ background: "rgba(255,92,98,.15)", color: C.bad, border: `1px solid ${C.bad}`, borderRadius: 20, padding: "2px 10px", fontSize: 12, fontWeight: 700 }}>🔔 {d.venc} vencida(s)</span>}
            <div style={{ textAlign: "right" }}><div style={{ fontSize: 11, color: C.dim }}>Deuda (Gs eq.)</div><div style={{ fontWeight: 700, color: d.total ? C.bad : C.ok }}>{money(d.total, "Gs")}</div></div>
            {d.total > 0 && <Btn small kind="ghost" onClick={(e) => recordar(c, e)} style={{ color: "#25D366", borderColor: "#25D366" }}>Recordar</Btn>}
            <Btn small kind="acc">Entrar →</Btn>
          </div>
        ); })}
      </div>
    </div>
  );
}

// ============================================================ FACTURACIÓN / IVA
function Facturacion({ db, cfg, selVeh, setSelVeh }) {
  const veh = db.vehiculos.find((v) => v.id === selVeh);
  const baseEspecial = veh ? Math.max(0, margen(veh)) : 0;
  const ivaDebito = baseEspecial * (cfg.iva / (100 + cfg.iva));
  return (
    <div>
      <Titulo icon="fact" sub="IVA — régimen de bienes usados">Facturación</Titulo>
      <div style={{ margin: "10px 0" }}><select value={selVeh || ""} onChange={(e) => setSelVeh(e.target.value)} style={{ ...inp, maxWidth: 380 }}><option value="">— Elegí un vehículo —</option>{db.vehiculos.map((v) => <option key={v.id} value={v.id}>{v.marca} {v.modelo} {v.anio}</option>)}</select></div>
      {!veh ? <Empty t="Seleccioná un vehículo para calcular el IVA." /> : (
        <div style={{ ...box, padding: 16, maxWidth: 520 }}>
          <Rows rows={[["Precio de venta", money(veh.precioVenta, "Gs")], ["Costo del vehículo", money(costoTotal(veh), "Gs")], ["Base imponible especial (margen)", money(baseEspecial, "Gs")]]} />
          <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 8, paddingTop: 8 }}><Rows rows={[[`IVA débito (${cfg.iva}% s/ base especial, incluido)`, money(ivaDebito, "Gs")]]} /></div>
          <div style={{ marginTop: 12, fontSize: 12, color: C.warn, lineHeight: 1.5 }}>⚠ En autos usados el IVA suele tributar sobre la diferencia (margen). Validá con tu contador/SET.</div>
        </div>
      )}
    </div>
  );
}

// ============================================================ LEGAL
function Legal({ db, cfg, selVeh, setSelVeh, setVeh }) {
  const veh = db.vehiculos.find((v) => v.id === selVeh); const l = veh?.legal || {};
  const set = (patch) => setVeh(veh.id, { legal: { ...l, ...patch } });
  return (
    <div>
      <Titulo icon="legal" sub="Documentos, seguimiento y carta de oferta">Legal / Docs</Titulo>
      <div style={{ margin: "10px 0" }}><select value={selVeh || ""} onChange={(e) => setSelVeh(e.target.value)} style={{ ...inp, maxWidth: 380 }}><option value="">— Elegí un vehículo —</option>{db.vehiculos.map((v) => <option key={v.id} value={v.id}>{v.marca} {v.modelo} {v.anio}</option>)}</select></div>
      {!veh ? <Empty t="Seleccioná un vehículo." /> : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div style={{ ...box, padding: 16 }}>
            <SubT>Seguimiento de documentos</SubT>
            <div style={{ display: "grid", gap: 10 }}>
              <Field label="Estado del contrato"><select style={inp} value={l.contrato || "Pendiente"} onChange={(e) => set({ contrato: e.target.value })}>{["Pendiente", "Redactado", "Firmado", "Entregado"].map((s) => <option key={s}>{s}</option>)}</select></Field>
              <Field label="Título de propiedad"><select style={inp} value={l.titulo || "En trámite"} onChange={(e) => set({ titulo: e.target.value })}>{["En trámite", "En mano", "Transferido"].map((s) => <option key={s}>{s}</option>)}</select></Field>
              <Field label="Prenda"><select style={inp} value={l.prenda || "Sin prenda"} onChange={(e) => set({ prenda: e.target.value })}>{["Sin prenda", "Con prenda vigente", "Prenda levantada"].map((s) => <option key={s}>{s}</option>)}</select></Field>
              <Field label="Escribano/a a cargo"><input style={inp} value={l.escribano || ""} onChange={(e) => set({ escribano: e.target.value })} /></Field>
              <Field label="Estado transferencia"><select style={inp} value={l.transferencia || "Pendiente"} onChange={(e) => set({ transferencia: e.target.value })}>{["Pendiente", "Documentos firmados", "Documentos retirados", "Finalizada"].map((s) => <option key={s}>{s}</option>)}</select></Field>
            </div>
          </div>
          <CartaOferta veh={veh} cfg={cfg} l={l} set={set} db={db} />
        </div>
      )}
    </div>
  );
}
function CartaOferta({ veh, cfg, l, set, db }) {
  const o = l.oferta || { destinatario: "", solicitante: "", ci: "", tipo: "AUTOMOVIL", certificado: "", estadoImport: "RECIEN IMPORTADO", monto: veh.precioVenta || "", moneda: "Gs", gastosTransf: true, validez: 10 };
  const setO = (patch) => set({ oferta: { ...o, ...patch } });
  return (
    <div style={{ ...box, padding: 16 }}>
      <SubT>Carta de oferta (PDF)</SubT>
      <div style={{ fontSize: 11, color: C.dim, marginBottom: 8 }}>Marca, modelo, año, chasis y color se toman de la ficha. Membrete/logo en Ajustes.</div>
      <div style={{ display: "grid", gap: 10 }}>
        <Field label="Señor/es (destinatario)"><input style={inp} value={o.destinatario} onChange={(e) => setO({ destinatario: e.target.value })} placeholder="COOPERATIVA COOMECIPAR" /></Field>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
          <Field label="A pedido de (solicitante)"><input style={inp} list="cli-dl" value={o.solicitante} onChange={(e) => setO({ solicitante: e.target.value })} placeholder="CARLOS ALBERTO MARTINEZ" /><datalist id="cli-dl">{(db?.clientes || []).map((c) => <option key={c.id} value={c.nombre} />)}</datalist></Field>
          <Field label="C.I. / RUC"><input style={inp} value={o.ci} onChange={(e) => setO({ ci: e.target.value })} placeholder="1.350.466" /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Tipo"><input style={inp} value={o.tipo} onChange={(e) => setO({ tipo: e.target.value })} /></Field>
          <Field label="Estado (importación)"><input style={inp} value={o.estadoImport} onChange={(e) => setO({ estadoImport: e.target.value })} /></Field>
        </div>
        <Field label="Certificado de nacionalización"><input style={inp} value={o.certificado} onChange={(e) => setO({ certificado: e.target.value })} placeholder="AUT—26031IC04003255N-0001" /></Field>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
          <Field label="Precio contado"><input type="number" style={inp} value={o.monto} onChange={(e) => setO({ monto: +e.target.value })} /></Field>
          <Field label="Moneda"><select style={inp} value={o.moneda} onChange={(e) => setO({ moneda: e.target.value })}><option>Gs</option><option>USD</option></select></Field>
        </div>
        <Field label="Validez (días)"><input type="number" style={inp} value={o.validez} onChange={(e) => setO({ validez: +e.target.value })} /></Field>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.txt }}><input type="checkbox" checked={o.gastosTransf} onChange={(e) => setO({ gastosTransf: e.target.checked })} />Gastos de transferencia incluidos</label>
      </div>
      <Btn kind="acc" onClick={() => cartaPDF(veh, o, cfg)} style={{ marginTop: 12, width: "100%" }}>Generar carta de oferta PDF</Btn>
    </div>
  );
}

// ============================================================ AJUSTES (config + usuarios)
function Config({ cfg, setCfg, db, setDb, tid, cloud }) {
  const emp = cfg.empresa || {};
  const setEmp = (patch) => setCfg({ ...cfg, empresa: { ...emp, ...patch } });
  const logoRef = useRef();
  const [cargando, setCargando] = useState(false);
  const [firmaOpen, setFirmaOpen] = useState(false);
  const subirLogo = (e) => { const file = e.target.files[0]; if (file) readFile(file).then((d) => setEmp({ logo: d })); };
  const actualizarCot = async () => {
    setCargando(true);
    try { const pyg = await fetchCotizacion(); setCfg({ ...cfg, cotizacion: pyg, cotizacionFecha: ahora() }); }
    catch { alert("No se pudo obtener la cotización por internet. Verificá tu conexión o cargala manualmente."); }
    setCargando(false);
  };
  return (
    <div>
      <Titulo icon="cfg" sub="Empresa, cotización, usuarios y respaldo">Ajustes</Titulo>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <div style={{ ...box, padding: 16 }}>
        <b>Empresa · Membrete · Logo / Marca de agua</b>
        <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
          <Field label="Nombre"><input style={inp} value={emp.nombre || ""} onChange={(e) => setEmp({ nombre: e.target.value })} /></Field>
          <Field label="WhatsApp / Teléfono"><input style={inp} value={emp.tel || ""} onChange={(e) => setEmp({ tel: e.target.value })} /></Field>
          <Field label="Dirección"><input style={inp} value={emp.dir || ""} onChange={(e) => setEmp({ dir: e.target.value })} /></Field>
          <Field label="Ciudad"><input style={inp} value={emp.ciudad || ""} onChange={(e) => setEmp({ ciudad: e.target.value })} /></Field>
          <div>
            <div style={{ fontSize: 12, color: C.dim, marginBottom: 6 }}>Logo (encabezado + marca de agua en los PDF)</div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Btn small onClick={() => logoRef.current.click()}>Cargar logo</Btn>
              {emp.logo && <><img src={emp.logo} style={{ height: 40, borderRadius: 4, background: "#fff", padding: 3 }} /><Btn small kind="ghost" onClick={() => setEmp({ logo: null })}>Quitar</Btn></>}
              <input ref={logoRef} type="file" accept="image/*" onChange={subirLogo} style={{ display: "none" }} />
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: C.dim, marginBottom: 6 }}>Firma / sello de la empresa (aparece en contratos y actas)</div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Btn small onClick={() => setFirmaOpen(true)}>{emp.firma ? "Editar firma" : "Firmar"}</Btn>
              {emp.firma && <><img src={emp.firma} style={{ height: 40, background: "#fff", borderRadius: 4, padding: 3 }} /><Btn small kind="ghost" onClick={() => setEmp({ firma: null })}>Quitar</Btn></>}
            </div>
          </div>
        </div>
        {firmaOpen && <FirmaPad valor={emp.firma} titulo="Firma / sello de la empresa" onSave={(d) => { setEmp({ firma: d || null }); setFirmaOpen(false); }} onClose={() => setFirmaOpen(false)} />}
      </div>
      <div style={{ ...box, padding: 16 }}>
        <b>Parámetros y cotización</b>
        <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
          <Field label="Moneda por defecto"><select style={inp} value={cfg.moneda} onChange={(e) => setCfg({ ...cfg, moneda: e.target.value })}><option>Gs</option><option>USD</option></select></Field>
          <Field label="IVA %"><input type="number" style={inp} value={cfg.iva} onChange={(e) => setCfg({ ...cfg, iva: +e.target.value })} /></Field>
          <Field label="Interés por mora (% mensual)"><input type="number" style={inp} value={cfg.tasaMora ?? 0} onChange={(e) => setCfg({ ...cfg, tasaMora: +e.target.value })} /></Field>
          <Field label="Comisión por venta (%) — por defecto"><input type="number" style={inp} value={cfg.comision ?? 0} onChange={(e) => setCfg({ ...cfg, comision: +e.target.value })} /></Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Tema"><select style={inp} value={cfg.tema || "oscuro"} onChange={(e) => setCfg({ ...cfg, tema: e.target.value })}><option value="oscuro">Oscuro</option><option value="claro">Claro</option></select></Field>
            <Field label="Tamaño de letra"><select style={inp} value={cfg.uiZoom || 1} onChange={(e) => setCfg({ ...cfg, uiZoom: +e.target.value })}><option value={1}>Normal</option><option value={1.1}>Grande</option><option value={1.25}>Más grande</option></select></Field>
          </div>
          <div style={{ ...box, background: C.panel2, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div><div style={{ fontSize: 12, color: C.dim }}>Cotización actual USD → Gs</div><div style={{ fontSize: 20, fontWeight: 800 }}>Gs {nf.format(cfg.cotizacion)}</div>{cfg.cotizacionFecha && <div style={{ fontSize: 11, color: C.dim }}>Actualizada: {cfg.cotizacionFecha}</div>}</div>
              <Btn small kind="acc" onClick={actualizarCot}>{cargando ? "Actualizando…" : "Actualizar por internet"}</Btn>
            </div>
            <Field label="O ajustar manualmente"><input type="number" style={{ ...inp, marginTop: 6 }} value={cfg.cotizacion} onChange={(e) => setCfg({ ...cfg, cotizacion: +e.target.value })} /></Field>
          </div>
        </div>
      </div>
      <div style={{ ...box, padding: 16, gridColumn: "1 / -1" }}><UsuariosSistema db={db} setDb={setDb} tid={tid} /></div>
      {cloud && (() => { const est = cloud.nube.estado; const col = est === "ok" ? C.ok : est === "error" ? C.bad : est === "subiendo" ? C.warn : C.dim; const txt = est === "ok" ? "Sincronizado" : est === "subiendo" ? "Subiendo…" : est === "error" ? "Error al sincronizar" : "En espera"; return (
        <div style={{ ...box, padding: 16, gridColumn: "1 / -1", borderTop: `2px solid ${col}` }}>
          <b>☁ Respaldo en la nube (Supabase)</b>
          <div style={{ fontSize: 12, color: C.dim, margin: "6px 0 12px" }}>Además del navegador, se guarda una copia automática en la nube. Estado: <b style={{ color: col }}>{txt}</b>{cloud.nube.fecha ? ` · última: ${cloud.nube.fecha}` : ""}.</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn kind="acc" onClick={cloud.subirNubeManual}>☁ Subir a la nube ahora</Btn>
            <Btn kind="ghost" onClick={cloud.restaurarNube}>↓ Restaurar desde la nube</Btn>
          </div>
          <div style={{ fontSize: 11, color: C.dim, marginTop: 8 }}>La copia en la nube es única para todo el sistema. "Restaurar" reemplaza los datos de este dispositivo por los de la nube.</div>
        </div>
      ); })()}
      <div style={{ ...box, padding: 16, gridColumn: "1 / -1" }}>
        <b>Copia de seguridad y exportación</b>
        <div style={{ fontSize: 12, color: C.dim, margin: "6px 0 12px" }}>Los datos se guardan en este navegador. Descargá una copia periódicamente para no perderlos.</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn onClick={() => { exportarDatos(cfg, db); setCfg({ ...cfg, ultimoBackup: today() }); }}>Descargar copia (JSON)</Btn>
          <Btn kind="ghost" onClick={() => exportCSV("clientes", db.clientes.map((c) => ({ nombre: c.nombre, ci: c.ci, tel: c.tel, email: c.email, ciudad: c.ciudad })))}>Exportar clientes (CSV)</Btn>
          <Btn kind="ghost" onClick={() => exportCSV("stock", db.vehiculos.map((v) => ({ marca: v.marca, modelo: v.modelo, anio: v.anio, chapa: v.chapa, estado: v.estado, costo: Math.round(costoTotal(v)), precio: v.precioVenta })))}>Exportar stock (CSV)</Btn>
          <Btn kind="ghost" onClick={() => exportCSV("ventas", db.ventas.map((v) => { const cli = db.clientes.find((c) => c.id === v.clienteId) || {}; return { fecha: v.fecha, tipo: v.tipo || "credito", cliente: cli.nombre, precio: v.precio, moneda: v.moneda, vendedor: v.vendedor || "" }; }))}>Exportar ventas (CSV)</Btn>
          <Btn kind="ghost" onClick={() => catalogoWeb(db.vehiculos, cfg, true)}>Descargar catálogo web (HTML)</Btn>
        </div>
      </div>
      </div>
    </div>
  );
}
function UsuariosSistema({ db, setDb, tid }) {
  const [f, setF] = useState({ nombre: "", user: "", pass: "", rol: "funcionario", comision: "", permisos: {} });
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const togglePerm = (k) => setF((s) => ({ ...s, permisos: { ...s.permisos, [k]: !s.permisos[k] } }));
  const crear = () => {
    if (!f.nombre || !f.user || !f.pass) return alert("Completá nombre, usuario y contraseña");
    if (db.usuarios.some((u) => u.user === f.user)) return alert("Ese usuario ya existe");
    setDb((s) => ({ ...s, usuarios: [{ id: uid(), tenantId: tid, nombre: f.nombre, user: f.user, pass: f.pass, rol: f.rol, comision: f.comision === "" ? null : +f.comision, permisos: f.rol === "admin" ? allPerms() : f.permisos, bloqueado: false, creado: today() }, ...s.usuarios] }));
    setF({ nombre: "", user: "", pass: "", rol: "funcionario", comision: "", permisos: {} });
    alert("Usuario creado. Ya puede ingresar con esa contraseña.");
  };
  const upd = (id, patch) => setDb((s) => ({ ...s, usuarios: s.usuarios.map((u) => (u.id === id ? { ...u, ...patch } : u)) }));
  const cambiarClave = (u) => { const np = prompt("Nueva contraseña para " + u.nombre + ":"); if (np && np.length >= 4) upd(u.id, { pass: np }); else if (np) alert("Mínimo 4 caracteres"); };
  const editComision = (u) => { const c = prompt(`Comisión % para ${u.nombre} (vacío = usar el valor por defecto):`, u.comision ?? ""); if (c === null) return; upd(u.id, { comision: c === "" ? null : +c }); };
  const del = (id) => { if (confirm("¿Eliminar usuario?")) setDb((s) => ({ ...s, usuarios: s.usuarios.filter((u) => u.id !== id) })); };
  return (
    <div>
      <b>Usuarios del sistema (funcionarios / administradores)</b>
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr auto auto", gap: 10, marginTop: 12, alignItems: "end" }}>
        <Field label="Nombre del funcionario"><input style={inp} value={f.nombre} onChange={(e) => set("nombre", e.target.value)} /></Field>
        <Field label="Usuario (para ingresar)"><input style={inp} value={f.user} onChange={(e) => set("user", e.target.value)} /></Field>
        <Field label="Contraseña"><input style={inp} value={f.pass} onChange={(e) => set("pass", e.target.value)} /></Field>
        <Field label="Comisión %"><input type="number" style={{ ...inp, width: 90 }} value={f.comision} onChange={(e) => set("comision", e.target.value)} placeholder="def" /></Field>
        <Field label="Rol"><select style={inp} value={f.rol} onChange={(e) => set("rol", e.target.value)}><option value="funcionario">Funcionario</option><option value="admin">Administrador</option></select></Field>
      </div>
      {f.rol === "funcionario" ? (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, color: C.dim, marginBottom: 6 }}>Permisos del funcionario:</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>{PERMS.map(([k, l]) => <label key={k} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: C.txt, ...box, padding: "6px 10px" }}><input type="checkbox" checked={!!f.permisos[k]} onChange={() => togglePerm(k)} />{l}</label>)}</div>
        </div>
      ) : <div style={{ marginTop: 10, fontSize: 12, color: C.ok }}>✓ Administrador: todas las funciones activadas (incluye Ajustes).</div>}
      <div style={{ marginTop: 12 }}><Btn kind="acc" onClick={crear}>Crear usuario</Btn></div>
      <div style={{ ...box, overflow: "hidden", marginTop: 14 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ background: C.panel2, color: C.dim, textAlign: "left" }}><th style={th}>Nombre</th><th style={th}>Usuario</th><th style={th}>Rol</th><th style={th}>Comisión</th><th style={th}>Permisos</th><th style={th}>Estado</th><th style={th}>Acciones</th></tr></thead>
          <tbody>{db.usuarios.length === 0 ? <tr><td style={td} colSpan={7}><span style={{ color: C.dim }}>Sin usuarios adicionales. El dueño de la empresa siempre es administrador.</span></td></tr> : db.usuarios.map((u) => (
            <tr key={u.id} style={{ borderTop: `1px solid ${C.border}`, opacity: u.bloqueado ? 0.5 : 1 }}>
              <td style={td}>{u.nombre}</td><td style={td}>{u.user}</td><td style={td}>{u.rol === "admin" ? "Administrador" : "Funcionario"}</td>
              <td style={td}>{u.comision != null ? u.comision + "%" : <span style={{ color: C.dim }}>por defecto</span>}</td>
              <td style={{ ...td, fontSize: 12, color: C.dim }}>{u.rol === "admin" ? "Todo" : PERMS.filter(([k]) => u.permisos?.[k]).map(([, l]) => l).join(", ") || "—"}</td>
              <td style={{ ...td, color: u.bloqueado ? C.bad : C.ok }}>{u.bloqueado ? "Bloqueado" : "Activo"}</td>
              <td style={td}><div style={{ display: "flex", gap: 6 }}><Btn small kind="ghost" onClick={() => editComision(u)}>Comisión</Btn><Btn small kind="ghost" onClick={() => cambiarClave(u)}>Clave</Btn><Btn small kind="ghost" onClick={() => upd(u.id, { bloqueado: !u.bloqueado })}>{u.bloqueado ? "Activar" : "Bloquear"}</Btn><Btn small kind="ghost" onClick={() => del(u.id)} style={{ color: C.bad, borderColor: C.bad }}>✕</Btn></div></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================ PDFs / WhatsApp
function printHTML(html) { const w = window.open("", "_blank"); if (!w) return alert("Permití las ventanas emergentes para generar el PDF."); w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 400); }
const wmHTML = (cfg) => { const l = cfg?.empresa?.logo; return l ? `<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:-1;opacity:.07"><img src="${l}" style="max-width:65%"/></div>` : ""; };
const hdrLogo = (cfg) => { const l = cfg?.empresa?.logo; return l ? `<img src="${l}" style="height:64px"/>` : `<div class="logo">${(cfg?.empresa?.nombre || "AUTO").split(" ")[0]}<small>AUTOMOTORES</small></div>`; };
const waOpen = (tel, texto) => { const t = (tel || "").replace(/[^0-9]/g, ""); const base = t ? `https://wa.me/595${t.replace(/^0/, "")}?text=${encodeURIComponent(texto)}` : `https://wa.me/?text=${encodeURIComponent(texto)}`; window.open(base, "_blank"); };

function facturaPDF(v, cfg) {
  const emp = cfg.empresa || {}; const fecha = new Date().toLocaleDateString("es-PY");
  const items = [["Precio de compra", +v.precioCompra || 0], ...GASTOS_FIJOS.map(([k, l]) => [l, +v.gastos?.[k] || 0]), ...(v.gastosExtra || []).map((g) => [g.concepto || "Otro gasto", +g.monto || 0])].filter(([, m]) => m > 0);
  const filas = items.map(([c, m]) => `<tr><td>${c}</td><td style="text-align:right">Gs ${nf.format(m)}</td></tr>`).join("");
  printHTML(`<html><head><meta charset="utf-8"><title>Factura de gastos</title>
  <style>@page{margin:1.5cm}body{font-family:Arial,sans-serif;color:#000;max-width:700px;margin:0 auto;padding:20px 30px}
  .head{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #000;padding-bottom:12px;margin-bottom:16px}
  .logo{font-weight:800;font-size:22px;color:#1a4d8f;border:3px solid #1a4d8f;border-radius:8px;padding:4px 10px}.logo small{display:block;font-size:8px;letter-spacing:2px;text-align:center;color:#333}
  h1{font-size:16px;margin:0}table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13px}td,th{border:1px solid #ccc;padding:6px 8px}th{background:#f0f0f0}
  .tot td{font-weight:bold;font-size:15px}.foot{border-top:1px solid #000;margin-top:40px;padding-top:8px;font-size:11px;color:#444}</style></head>
  <body>${wmHTML(cfg)}
  <div class="head"><div>${hdrLogo(cfg)}</div><div style="text-align:right"><h1>FACTURA / COMPROBANTE DE GASTOS</h1><div>${emp.nombre || ""}</div><div>${fecha}</div></div></div>
  <p><b>Vehículo:</b> ${v.marca || ""} ${v.modelo || ""} ${v.anio || ""} · Chapa ${v.chapa || "—"} · Chasis ${v.vin || "—"}</p>
  <table><thead><tr><th>Concepto</th><th style="text-align:right">Monto</th></tr></thead><tbody>${filas}
  <tr class="tot"><td>COSTO TOTAL</td><td style="text-align:right">Gs ${nf.format(Math.round(costoTotal(v)))}</td></tr>
  <tr><td>Precio de venta</td><td style="text-align:right">Gs ${nf.format(+v.precioVenta || 0)}</td></tr>
  <tr><td>Margen</td><td style="text-align:right">Gs ${nf.format(Math.round(margen(v)))}</td></tr></tbody></table>
  <div class="foot">${emp.nombre || ""} · ${emp.tel || ""} · ${emp.dir || ""}</div></body></html>`);
}
function waFactura(v, cfg) {
  const items = [["Precio compra", +v.precioCompra || 0], ...GASTOS_FIJOS.map(([k, l]) => [l, +v.gastos?.[k] || 0]), ...(v.gastosExtra || []).map((g) => [g.concepto || "Otro", +g.monto || 0])].filter(([, m]) => m > 0);
  const lineas = items.map(([c, m]) => `• ${c}: Gs ${nf.format(m)}`).join("\n");
  waOpen(cfg.empresa?.tel, `${cfg.empresa?.nombre || ""}\nGastos ${v.marca || ""} ${v.modelo || ""} ${v.anio || ""}:\n${lineas}\nCOSTO TOTAL: Gs ${nf.format(Math.round(costoTotal(v)))}\nPrecio venta: Gs ${nf.format(+v.precioVenta || 0)}`);
}
function cartaPDF(veh, o, cfg) {
  const meses = ["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"];
  const d = new Date(); const emp = cfg.empresa || {};
  const fecha = `${emp.ciudad || "Ciudad del Este"}, ${d.getDate()} de ${meses[d.getMonth()]} del ${d.getFullYear()}`;
  const precio = o.moneda === "USD" ? "US$ " + new Intl.NumberFormat("en-US").format(o.monto) : nf.format(o.monto) + " GS";
  const row = (k, v) => `<li><b>${k}:</b> ${v || "—"}. -</li>`;
  printHTML(`<html><head><meta charset="utf-8"><title>Carta de Oferta</title>
  <style>@page{margin:2cm}body{font-family:'Times New Roman',Georgia,serif;color:#000;font-size:15px;line-height:1.55;max-width:760px;margin:0 auto;padding:20px 40px}
  .head{display:flex;align-items:center;gap:16px;border-bottom:2px solid #000;padding-bottom:14px;margin-bottom:30px}
  .logo{font-weight:800;font-size:26px;color:#1a4d8f;letter-spacing:1px;border:3px solid #1a4d8f;border-radius:8px;padding:4px 12px}.logo small{display:block;font-size:9px;letter-spacing:3px;color:#333;text-align:center}
  .fecha{text-align:right;margin-bottom:24px}.dest{font-weight:bold;text-transform:uppercase}.pres{text-decoration:underline;margin:10px 0}
  ul.datos{list-style:none;padding-left:20px;margin:22px 0}ul.datos li{margin:9px 0}.precio{font-weight:bold;margin-top:24px}
  ul.cond{margin:6px 0 0 10px;padding-left:20px}ul.cond li{margin:4px 0}
  .firma{margin-top:70px;text-align:right}.firma .line{display:inline-block;border-top:1px solid #000;width:230px;margin-bottom:6px}.firma b{display:block;text-align:center;width:230px;margin-left:auto}
  .foot{border-top:1px solid #000;margin-top:60px;padding-top:8px;font-size:12px;font-weight:bold}.wa{color:#25D366}</style></head>
  <body>${wmHTML(cfg)}<div class="head">${hdrLogo(cfg)}</div>
  <div class="fecha">${fecha}</div><p>Señor/es:</p><p class="dest">${o.destinatario || "________________________"}</p><p class="pres">Presente:</p>
  <p>Es un agrado dirigirnos a Ud. y por su intermedio a donde corresponda, a fin de someter a su estudio y consideración el siguiente presupuesto, a pedido de la <b>Sr. ${o.solicitante || "________________"}</b>,<br><b>C.I: ${o.ci || "____________"}</b></p>
  <ul class="datos">${row("MARCA", veh.marca)}${row("MODELO", veh.modelo)}${row("AÑO", veh.anio)}${row("TIPO", o.tipo)}${row("CERTIFICADO DE NACIONALIZACION", o.certificado)}${row("CHASSIS", veh.vin)}${row("ESTADO", o.estadoImport)}${row("COLOR", veh.color)}</ul>
  <p class="precio">PRECIO CONTADO: ${precio} . -</p>
  <ul class="cond">${o.gastosTransf ? "<li>Gastos de Transferencia INCLUIDAS. -</li>" : ""}<li>Oferta valida por ${o.validez || 10} días. -</li></ul>
  <div class="firma"><div class="line"></div><b>${emp.nombre || "AUTOMOTORES"}.</b></div>
  <div class="foot">${emp.tel || ""} <span class="wa">✆</span><br>${emp.dir || ""}</div></body></html>`);
}
function contratoPDF(cli, venta, veh, cfg) {
  const meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const d = new Date(); const emp = cfg.empresa || {};
  const fecha = `${d.getDate()} de ${meses[d.getMonth()]} de ${d.getFullYear()}`; const M = venta.moneda;
  const mon = (x) => M === "USD" ? "US$ " + new Intl.NumberFormat("en-US").format(Math.round(x)) : "Gs " + nf.format(Math.round(x));
  const totalFin = venta.entrega + venta.cuota * venta.plan.length;
  const filas = venta.plan.map((c) => `<tr><td>${c.n}</td><td>${c.venc}</td><td style="text-align:right">${mon(c.monto)}</td></tr>`).join("");
  printHTML(`<html><head><meta charset="utf-8"><title>Contrato de Compraventa</title>
  <style>@page{margin:2cm}body{font-family:'Times New Roman',Georgia,serif;color:#000;font-size:14px;line-height:1.6;max-width:760px;margin:0 auto;padding:20px 40px}
  .head{text-align:center;margin-bottom:10px}h1{text-align:center;font-size:18px;margin:6px 0}.sub{text-align:center;color:#555;margin-bottom:24px}
  h2{font-size:14px;border-bottom:1px solid #999;margin-top:22px;padding-bottom:3px}table{width:100%;border-collapse:collapse;margin:10px 0;font-size:13px}th,td{border:1px solid #ccc;padding:5px 8px}th{background:#f0f0f0}
  .firmas{display:flex;justify-content:space-between;flex-wrap:wrap;gap:20px;margin-top:60px}.fbox{width:30%;min-width:180px;text-align:center}.fimg{height:46px;display:flex;align-items:flex-end;justify-content:center}.fimg img{max-height:46px;max-width:100%}.flabel{border-top:1px solid #000;padding-top:6px}
  .foot{border-top:1px solid #000;margin-top:50px;padding-top:8px;font-size:11px;text-align:center;color:#444}</style></head>
  <body>${wmHTML(cfg)}<div class="head">${hdrLogo(cfg)}</div>
  <h1>CONTRATO DE COMPRAVENTA DE VEHÍCULO CON FINANCIACIÓN</h1><div class="sub">${emp.ciudad || "Ciudad del Este"}, ${fecha}</div>
  <p>Entre <b>${emp.nombre || "LA VENDEDORA"}</b> (“LA VENDEDORA”), con domicilio en ${emp.dir || "—"}, y el/la Sr./Sra. <b>${cli.nombre}</b>, C.I./RUC N° <b>${cli.ci || "—"}</b>, domiciliado/a en ${cli.direccion || "—"} ${cli.ciudad || ""} (“EL COMPRADOR”)${venta.garante ? `, y el/la Sr./Sra. <b>${venta.garante.nombre}</b>, C.I./RUC N° <b>${venta.garante.ci || "—"}</b> (“EL GARANTE”)` : ""}, se conviene:</p>
  <h2>PRIMERA — Objeto</h2><table><tr><th>Marca</th><td>${veh.marca || "—"}</td><th>Modelo</th><td>${veh.modelo || "—"}</td></tr><tr><th>Año</th><td>${veh.anio || "—"}</td><th>Color</th><td>${veh.color || "—"}</td></tr><tr><th>Chapa</th><td>${veh.chapa || "—"}</td><th>Chasis/VIN</th><td>${veh.vin || "—"}</td></tr></table>
  <h2>SEGUNDA — Precio y forma de pago</h2><p>Precio total: <b>${mon(venta.precio)}</b>. Forma de pago:</p><ul><li>Entrega inicial: <b>${mon(venta.entrega)}</b></li>${venta.permuta ? `<li>Recibe en permuta: <b>${venta.permuta.desc}</b> valuado en <b>Gs ${nf.format(Math.round(venta.permuta.valorGs))}</b>.</li>` : ""}<li>Saldo financiado: <b>${mon(venta.capital)}</b> en <b>${venta.plan.length} cuotas</b> mensuales de <b>${mon(venta.cuota)}</b>, interés anual ${venta.tasa}%.</li><li>Total financiado: <b>${mon(totalFin)}</b>.</li></ul>
  <h2>TERCERA — Plan de cuotas</h2><table><thead><tr><th>N°</th><th>Vencimiento</th><th style="text-align:right">Importe</th></tr></thead><tbody>${filas}</tbody></table>
  <h2>CUARTA — Mora</h2><p>El atraso genera interés moratorio del <b>${cfg.tasaMora}% mensual</b> por día de atraso, sin perjuicio de acciones legales.</p>
  <h2>QUINTA — Reserva de dominio</h2><p>LA VENDEDORA conserva la titularidad y/o prenda hasta la cancelación total del saldo.</p>
  ${venta.garante ? `<h2>SEXTA — Garantía / Codeudor solidario</h2><p>EL GARANTE, Sr./Sra. <b>${venta.garante.nombre}</b> (C.I./RUC ${venta.garante.ci || "—"}${venta.garante.tel ? ", tel. " + venta.garante.tel : ""}${venta.garante.direccion ? ", domicilio " + venta.garante.direccion : ""}), se constituye en <b>codeudor solidario y principal pagador</b> de todas las obligaciones asumidas por EL COMPRADOR en el presente contrato, renunciando a los beneficios de excusión y división.</p>` : ""}
  <p>En prueba de conformidad, se firman dos ejemplares.</p>
  <div class="firmas"><div class="fbox"><div class="fimg">${emp.firma ? `<img src="${emp.firma}"/>` : ""}</div><div class="flabel">LA VENDEDORA<br>${emp.nombre || ""}</div></div><div class="fbox"><div class="fimg">${cli.firma ? `<img src="${cli.firma}"/>` : ""}</div><div class="flabel">EL COMPRADOR<br>${cli.nombre}</div></div>${venta.garante ? `<div class="fbox"><div class="fimg"></div><div class="flabel">EL GARANTE<br>${venta.garante.nombre}</div></div>` : ""}</div>
  <div class="foot">${emp.nombre || ""} · ${emp.tel || ""} · ${emp.dir || ""}</div></body></html>`);
}
function reciboPDF(cli, venta, veh, c, m, cfg) {
  const emp = (cfg || {}).empresa || {};
  const fecha = c.fechaPago || new Date().toLocaleDateString("es-PY");
  const mon = (x) => m === "USD" ? "US$ " + new Intl.NumberFormat("en-US").format(x) : "Gs " + nf.format(x);
  const total = (c.monto || 0) + (c.moraPagada || 0);
  const des = [];
  if (c.pagoGs) des.push(`<tr><td>Recibido en guaraníes</td><td>Gs ${nf.format(Math.round(c.pagoGs))}</td></tr>`);
  if (c.pagoUSD) des.push(`<tr><td>Recibido en dólares</td><td>US$ ${new Intl.NumberFormat("en-US").format(c.pagoUSD)}</td></tr>`);
  printHTML(`<html><head><meta charset="utf-8"><title>Recibo</title>
  <style>body{font-family:Arial,sans-serif;color:#111;max-width:600px;margin:40px auto;padding:0 30px}
  .box{border:2px solid #e63946;border-radius:10px;padding:24px;position:relative}h1{color:#e63946;font-size:18px;margin:0 0 4px}
  table{width:100%;border-collapse:collapse;margin:14px 0}td{padding:6px 4px;border-bottom:1px solid #eee}.firma{margin-top:50px;border-top:1px solid #333;width:50%;text-align:center;padding-top:6px}</style></head>
  <body>${wmHTML(cfg)}<div class="box"><h1>RECIBO DE DINERO</h1><small>${emp.nombre || ""} · N° ${venta.id.toUpperCase()}-${c.n}</small>
  <table><tr><td>Fecha</td><td><b>${fecha}</b></td></tr><tr><td>Recibí de</td><td><b>${cli.nombre || "—"}</b> (C.I. ${cli.ci || "—"})</td></tr>
  <tr><td>Concepto</td><td>Cuota ${c.n}/${venta.plan.length} — ${veh.marca} ${veh.modelo} ${veh.anio}</td></tr><tr><td>Vencimiento</td><td>${c.venc}</td></tr>
  <tr><td>Cuota</td><td>${mon(c.monto)}</td></tr>${c.moraPagada ? `<tr><td>Interés por mora (${c.diasAtrasoPago}d)</td><td>${mon(c.moraPagada)}</td></tr>` : ""}${des.join("")}
  <tr><td><b>TOTAL</b></td><td><b style="color:#e63946;font-size:16px">${mon(total)}</b></td></tr></table><div class="firma">Firma y sello</div></div></body></html>`);
}
function waRecibo(cli, venta, veh, c, m, cfg) {
  const mon = (x) => m === "USD" ? "US$ " + new Intl.NumberFormat("en-US").format(x) : "Gs " + nf.format(Math.round(x));
  const total = (c.monto || 0) + (c.moraPagada || 0);
  const extra = [c.pagoGs ? `Gs ${nf.format(Math.round(c.pagoGs))}` : "", c.pagoUSD ? `US$ ${new Intl.NumberFormat("en-US").format(c.pagoUSD)}` : ""].filter(Boolean).join(" + ");
  waOpen(cli.tel, `${cfg.empresa?.nombre || ""}\nRecibo — ${cli.nombre}\nCuota ${c.n}/${venta.plan.length} · ${veh.marca} ${veh.modelo} ${veh.anio}\n${c.moraPagada ? "Incluye mora: " + mon(c.moraPagada) + "\n" : ""}TOTAL PAGADO: ${mon(total)}${extra ? "\nDetalle: " + extra : ""}\n¡Gracias por su pago!`);
}

// ============================================================ INICIO (dashboard)
function Inicio({ db, cfg, ir, puede }) {
  const mesActual = today().slice(0, 7);
  const disp = db.vehiculos.filter((v) => v.estado !== "Vendido");
  const vendidosMes = db.ventas.filter((v) => (v.fecha || "").slice(0, 7) === mesActual);
  const creditos = db.ventas.filter((v) => v.plan);
  const deuda = creditos.reduce((a, v) => a + toGs(deudaVenta(v, cfg.tasaMora, cfg.cotizacion).total, v.moneda, cfg), 0);
  const vencidas = creditos.reduce((n, v) => n + deudaVenta(v, cfg.tasaMora, cfg.cotizacion).vencidas, 0);
  const cobrosMes = (db.caja || []).filter((m) => m.tipo === "ingreso" && (m.fecha || "").slice(0, 7) === mesActual).reduce((a, m) => a + (m.monto || 0), 0);
  const proximas = [];
  creditos.forEach((v) => { const cli = db.clientes.find((c) => c.id === v.clienteId) || {}; v.plan.forEach((c) => { if (!c.pagado) { const dd = diasEntre(today(), c.venc); const venc = c.venc < today(); if (venc || dd <= 7) proximas.push({ cli: cli.nombre, venc: c.venc, monto: c.monto, moneda: v.moneda, atrasada: venc, n: c.n }); } }); });
  proximas.sort((a, b) => a.venc.localeCompare(b.venc));
  const meses6 = ult6();
  const serieVentas = meses6.map((m) => ({ label: m.label, value: db.ventas.filter((v) => (v.fecha || "").slice(0, 7) === m.key).length }));
  const serieCobros = meses6.map((m) => ({ label: m.label, value: (db.caja || []).filter((x) => x.tipo === "ingreso" && (x.fecha || "").slice(0, 7) === m.key).reduce((a, x) => a + (x.monto || 0), 0) }));
  const docsVenc = [];
  disp.forEach((v) => { [["Habilitación", v.vencHab], ["Seguro", v.vencSeg], ["RTV", v.vencRtv]].forEach(([tipo, f]) => { if (f) { const venc = f < today(); const dd = diasEntre(today(), f); if (venc || dd <= 30) docsVenc.push({ veh: `${v.marca || ""} ${v.modelo || ""} ${v.anio || ""}`.trim(), tipo, fecha: f, vencido: venc }); } }); });
  docsVenc.sort((a, b) => a.fecha.localeCompare(b.fecha));
  const tareasPend = (db.notas || []).filter((n) => n.tipo === "Tarea" && !n.hecha).sort((a, b) => (a.vence || "9999").localeCompare(b.vence || "9999"));
  const parados = disp.filter((v) => v.fechaIngreso && diasEntre(v.fechaIngreso, today()) >= 60).map((v) => ({ nombre: `${v.marca || ""} ${v.modelo || ""} ${v.anio || ""}`.trim(), dias: diasEntre(v.fechaIngreso, today()) })).sort((a, b) => b.dias - a.dias);
  return (
    <div>
      <h2 style={{ margin: "0 0 14px", fontSize: 20 }}>Resumen general</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
        <Kpi t="Autos en stock" v={disp.length} onClick={puede("stock") ? () => ir("stock") : undefined} /><Kpi t="Vendidos este mes" v={vendidosMes.length} c={C.ok} onClick={puede("ventas") ? () => ir("ventas") : undefined} /><Kpi t="Clientes" v={db.clientes.length} onClick={puede("clientes") ? () => ir("clientes") : undefined} /><Kpi t="Cobros del mes (Gs)" v={money(cobrosMes, "Gs")} c={C.ok} onClick={puede("caja") ? () => ir("caja") : undefined} />
        <Kpi t="Por cobrar (Gs eq.)" v={money(deuda, "Gs")} c={deuda ? C.warn : C.ok} onClick={puede("cobranza") ? () => ir("cobranza") : undefined} /><Kpi t="Cuotas vencidas" v={vencidas} c={vencidas ? C.bad : C.ok} onClick={puede("cobranza") ? () => ir("cobranza") : undefined} /><Kpi t="Capital en stock" v={money(disp.reduce((a, v) => a + costoTotal(v), 0), "Gs")} onClick={puede("stock") ? () => ir("stock") : undefined} /><Kpi t="Margen potencial" v={money(disp.reduce((a, v) => a + margen(v), 0), "Gs")} c={C.ok} onClick={puede("reportes") ? () => ir("reportes") : undefined} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <div style={{ ...box, padding: 16 }}><b>Ventas (últimos 6 meses)</b><Barras data={serieVentas} color={C.acc} /></div>
        <div style={{ ...box, padding: 16 }}><b>Cobros (últimos 6 meses)</b><Barras data={serieCobros} color={C.ok} fmt={montoCorto} /></div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <div style={{ ...box, padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><b>Próximas a vencer / atrasadas</b>{puede("cobranza") && <Btn small kind="ghost" onClick={() => ir("cobranza")}>Ir a Cobranza →</Btn>}</div>
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            {proximas.length === 0 ? <span style={{ color: C.dim, fontSize: 13 }}>Sin cuotas próximas ni atrasadas. 👌</span> : proximas.slice(0, 8).map((p, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "6px 0", borderBottom: `1px solid ${C.border}` }}>
                <span>{p.cli} <span style={{ color: C.dim }}>· cuota {p.n}</span></span>
                <span style={{ color: p.atrasada ? C.bad : C.warn }}>{money(p.monto, p.moneda)} · {p.venc}{p.atrasada ? " ⚠" : ""}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ ...box, padding: 16 }}>
          <b>Accesos rápidos</b>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
            {puede("stock") && <Btn onClick={() => ir("stock")}>+ Cargar vehículo</Btn>}
            {puede("ventas") && <Btn kind="acc" onClick={() => ir("ventas")}>Nueva venta</Btn>}
            {puede("clientes") && <Btn onClick={() => ir("clientes")}>Nuevo cliente</Btn>}
            {puede("caja") && <Btn onClick={() => ir("caja")}>Abrir Caja</Btn>}
            {puede("reportes") && <Btn kind="ghost" onClick={() => ir("reportes")}>Ver reportes</Btn>}
          </div>
        </div>
      </div>
      {docsVenc.length > 0 && (
        <div style={{ ...box, padding: 16, marginTop: 16, borderColor: C.warn }}>
          <b>Vencimientos de documentos del vehículo</b>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {docsVenc.slice(0, 10).map((x, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "5px 0", borderBottom: `1px solid ${C.border}` }}>
                <span>{x.veh} <span style={{ color: C.dim }}>· {x.tipo}</span></span>
                <span style={{ color: x.vencido ? C.bad : C.warn }}>{x.fecha}{x.vencido ? " · vencido" : " · próximo"}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {tareasPend.length > 0 && (
        <div style={{ ...box, padding: 16, marginTop: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><b>Tareas pendientes ({tareasPend.length})</b>{puede("notas") && <Btn small kind="ghost" onClick={() => ir("notas")}>Ver todas →</Btn>}</div>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {tareasPend.slice(0, 6).map((n) => { const venc = n.vence && n.vence < today(); return (
              <div key={n.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "5px 0", borderBottom: `1px solid ${C.border}` }}>
                <span>☐ {n.texto}</span>
                <span style={{ color: venc ? C.bad : C.dim }}>{n.vence ? n.vence + (venc ? " ⚠" : "") : ""}</span>
              </div>
            ); })}
          </div>
        </div>
      )}
      {parados.length > 0 && (
        <div style={{ ...box, padding: 16, marginTop: 16, borderColor: C.warn }}>
          <b>Autos parados (60+ días en stock)</b>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {parados.slice(0, 8).map((x, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "5px 0", borderBottom: `1px solid ${C.border}` }}>
                <span>🐌 {x.nombre}</span><span style={{ color: x.dias >= 120 ? C.bad : C.warn }}>{x.dias} días</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div style={{ marginTop: 16 }}><CotizadorCard cfg={cfg} /></div>
    </div>
  );
}
// ============================================================ CAJA
function Caja({ db, cfg, setDb, tid }) {
  const [f, setF] = useState({ tipo: "ingreso", concepto: "", monto: "", fecha: today() });
  const [desde, setDesde] = useState(today().slice(0, 8) + "01"); const [hasta, setHasta] = useState(today());
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const movs = (db.caja || []).filter((m) => m.fecha >= desde && m.fecha <= hasta).sort((a, b) => b.fecha.localeCompare(a.fecha));
  const ingresos = movs.filter((m) => m.tipo === "ingreso").reduce((a, m) => a + (m.monto || 0), 0);
  const egresos = movs.filter((m) => m.tipo === "egreso").reduce((a, m) => a + (m.monto || 0), 0);
  const agregar = () => { if (!f.concepto || !f.monto) return alert("Completá concepto y monto"); setDb((s) => ({ ...s, caja: [{ id: uid(), tenantId: tid, fecha: f.fecha, tipo: f.tipo, concepto: f.concepto, monto: Math.round(+f.monto), moneda: "Gs" }, ...(s.caja || [])] })); auditar(setDb, f.tipo === "ingreso" ? "Ingreso de caja" : "Egreso de caja", `${f.concepto} · ${money(+f.monto, "Gs")}`); setF({ tipo: "ingreso", concepto: "", monto: "", fecha: today() }); };
  const del = (id) => { if (confirm("¿Eliminar este movimiento?")) setDb((s) => ({ ...s, caja: (s.caja || []).filter((m) => m.id !== id) })); };
  return (
    <div>
      <Titulo icon="caja" sub="Ingresos, egresos y cierre de caja">Caja</Titulo>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 14 }}><Kpi t="Ingresos (rango)" v={money(ingresos, "Gs")} c={C.ok} /><Kpi t="Egresos (rango)" v={money(egresos, "Gs")} c={C.bad} /><Kpi t="Saldo" v={money(ingresos - egresos, "Gs")} c={ingresos - egresos >= 0 ? C.ok : C.bad} /></div>
      <div style={{ ...box, padding: 16 }}>
        <b>Registrar movimiento</b>
        <div style={{ display: "grid", gridTemplateColumns: "auto 2fr 1fr 1fr auto", gap: 10, marginTop: 10, alignItems: "end" }}>
          <Field label="Tipo"><select style={inp} value={f.tipo} onChange={(e) => set("tipo", e.target.value)}><option value="ingreso">Ingreso</option><option value="egreso">Egreso</option></select></Field>
          <Field label="Concepto"><input style={inp} value={f.concepto} onChange={(e) => set("concepto", e.target.value)} placeholder="Ej. gasto combustible, seña, sueldo…" /></Field>
          <Field label="Monto (Gs)"><input type="number" style={inp} value={f.monto} onChange={(e) => set("monto", e.target.value)} /></Field>
          <Field label="Fecha"><input type="date" style={inp} value={f.fecha} onChange={(e) => set("fecha", e.target.value)} /></Field>
          <Btn kind="acc" onClick={agregar}>Agregar</Btn>
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "end", margin: "16px 0 10px", flexWrap: "wrap" }}>
        <Field label="Desde"><input type="date" style={inp} value={desde} onChange={(e) => setDesde(e.target.value)} /></Field>
        <Field label="Hasta"><input type="date" style={inp} value={hasta} onChange={(e) => setHasta(e.target.value)} /></Field>
        <Btn onClick={() => cierreCajaPDF(movs, desde, hasta, cfg)}>Cierre de caja PDF</Btn>
      </div>
      <div style={{ ...box, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ background: C.panel2, color: C.dim, textAlign: "left" }}><th style={th}>Fecha</th><th style={th}>Concepto</th><th style={th}>Tipo</th><th style={{ ...th, textAlign: "right" }}>Monto</th><th style={th}></th></tr></thead>
          <tbody>{movs.length === 0 ? <tr><td style={td} colSpan={5}><span style={{ color: C.dim }}>Sin movimientos en el rango.</span></td></tr> : movs.map((m) => (
            <tr key={m.id} style={{ borderTop: `1px solid ${C.border}` }}>
              <td style={td}>{m.fecha}</td><td style={td}>{m.concepto}{m.auto && <span style={{ color: C.dim, fontSize: 11 }}> · auto</span>}</td>
              <td style={{ ...td, color: m.tipo === "ingreso" ? C.ok : C.bad }}>{m.tipo === "ingreso" ? "Ingreso" : "Egreso"}</td>
              <td style={{ ...td, textAlign: "right", fontWeight: 700, color: m.tipo === "ingreso" ? C.ok : C.bad }}>{m.tipo === "ingreso" ? "+" : "−"} {money(m.monto, "Gs")}</td>
              <td style={td}><Btn small kind="ghost" onClick={() => del(m.id)} style={{ color: C.bad, borderColor: C.bad }}>✕</Btn></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================ REPORTES
function Reportes({ db, cfg, setDb, tid }) {
  const [mes, setMes] = useState(today().slice(0, 7));
  const ventasMes = db.ventas.filter((v) => (v.fecha || "").slice(0, 7) === mes);
  const contado = ventasMes.filter((v) => v.tipo === "contado" || !v.plan);
  const credito = ventasMes.filter((v) => v.plan);
  const facturado = ventasMes.reduce((a, v) => a + toGs(v.precio, v.moneda, cfg), 0);
  const margenMes = ventasMes.reduce((a, v) => { const vh = db.vehiculos.find((x) => x.id === v.vehiculoId); return a + (vh ? margen(vh) : 0); }, 0);
  const cobrosMes = (db.caja || []).filter((m) => m.tipo === "ingreso" && (m.fecha || "").slice(0, 7) === mes).reduce((a, m) => a + (m.monto || 0), 0);
  const egresosMes = (db.caja || []).filter((m) => m.tipo === "egreso" && (m.fecha || "").slice(0, 7) === mes).reduce((a, m) => a + (m.monto || 0), 0);
  const cogs = ventasMes.reduce((a, v) => { const vh = db.vehiculos.find((x) => x.id === v.vehiculoId); return a + (vh ? costoTotal(vh) : 0); }, 0);
  const resultado = margenMes - egresosMes;
  const flujo = cobrosMes - egresosMes;
  const serieFact = ult6().map((m) => ({ label: m.label, value: db.ventas.filter((v) => (v.fecha || "").slice(0, 7) === m.key).reduce((a, v) => a + toGs(v.precio, v.moneda, cfg), 0) }));
  const cotR = cfg.cotizacion || 1;
  const remCuota = (v, c) => Math.max(0, (c.monto || 0) - (v.moneda === "USD" ? (c.abonadoGs || 0) / cotR : (c.abonadoGs || 0)));
  const serieProy = prox6().map((m) => ({ label: m.label, value: db.ventas.filter((v) => v.plan).reduce((a, v) => a + v.plan.filter((c) => !c.pagado && (c.venc || "").slice(0, 7) === m.key).reduce((s, c) => s + toGs(remCuota(v, c), v.moneda, cfg), 0), 0) }));
  const atrasado = db.ventas.filter((v) => v.plan).reduce((a, v) => a + v.plan.filter((c) => !c.pagado && c.venc < today()).reduce((s, c) => s + toGs(remCuota(v, c), v.moneda, cfg), 0), 0);
  const totalProy = serieProy.reduce((a, s) => a + s.value, 0);
  const mesAnt = ((y, mm) => { const d = new Date(+y, +mm - 2, 1); return d.toISOString().slice(0, 7); })(mes.slice(0, 4), mes.slice(5, 7));
  const ventasAnt = db.ventas.filter((v) => (v.fecha || "").slice(0, 7) === mesAnt);
  const factAnt = ventasAnt.reduce((a, v) => a + toGs(v.precio, v.moneda, cfg), 0);
  const margenAnt = ventasAnt.reduce((a, v) => { const vh = db.vehiculos.find((x) => x.id === v.vehiculoId); return a + (vh ? margen(vh) : 0); }, 0);
  const cobrosAnt = (db.caja || []).filter((x) => x.tipo === "ingreso" && (x.fecha || "").slice(0, 7) === mesAnt).reduce((a, x) => a + (x.monto || 0), 0);
  const delta = (act, ant) => { if (!ant) return act ? { txt: "nuevo", c: C.ok } : { txt: "—", c: C.dim }; const p = ((act - ant) / ant) * 100; return { txt: (p >= 0 ? "▲ " : "▼ ") + Math.abs(p).toFixed(0) + "%", c: p >= 0 ? C.ok : C.bad }; };
  const topCli = {};
  ventasMes.forEach((v) => { const c = db.clientes.find((x) => x.id === v.clienteId); const k = c ? c.nombre : "—"; topCli[k] = (topCli[k] || 0) + toGs(v.precio, v.moneda, cfg); });
  const rankCli = Object.entries(topCli).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const rentAuto = ventasMes.map((v) => { const vh = db.vehiculos.find((x) => x.id === v.vehiculoId) || {}; return { nombre: `${vh.marca || ""} ${vh.modelo || ""} ${vh.anio || ""}`.trim(), m: margen(vh), pct: margenPct(vh) }; }).sort((a, b) => b.m - a.m).slice(0, 6);
  const serieCobros6 = ult6().map((mm) => ({ label: mm.label, value: (db.caja || []).filter((x) => x.tipo === "ingreso" && (x.fecha || "").slice(0, 7) === mm.key).reduce((a, x) => a + (x.monto || 0), 0) }));
  const serieVend = rank.slice(0, 6).map(([v, d]) => ({ label: (v || "—").slice(0, 7), value: d.monto }));
  const pctDe = (vendedor) => { const u = db.usuarios.find((x) => x.nombre === vendedor || x.user === vendedor); return (u && u.comision != null) ? +u.comision : (+cfg.comision || 0); };
  const ranking = {};
  ventasMes.forEach((v) => { const k = v.vendedor || "—"; ranking[k] = ranking[k] || { n: 0, monto: 0 }; ranking[k].n++; ranking[k].monto += toGs(v.precio, v.moneda, cfg); });
  const rank = Object.entries(ranking).sort((a, b) => b[1].monto - a[1].monto);
  const comisiones = rank.map(([v, d]) => { const pct = pctDe(v); return { v, n: d.n, monto: d.monto, pct, comision: Math.round(d.monto * pct / 100) }; });
  const totalComision = comisiones.reduce((a, c) => a + c.comision, 0);
  const pagarComision = (c) => { if (c.comision <= 0) return alert("Sin comisión para pagar."); if (!confirm(`Registrar en Caja el pago de comisión a ${c.v}: ${money(c.comision, "Gs")}?`)) return; setDb((s) => ({ ...s, caja: [{ id: uid(), tenantId: tid, fecha: today(), tipo: "egreso", concepto: `Comisión ${c.v} — ${mes}`, monto: c.comision, moneda: "Gs", auto: true }, ...(s.caja || [])] })); alert("Registrado como egreso en Caja."); };
  return (
    <div>
      <Titulo icon="reportes" sub="Ventas, márgenes, comisiones y proyección">Reportes</Titulo>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}><span style={{ marginRight: "auto", fontSize: 13, color: C.dim }}>Período seleccionado:</span><input type="month" style={{ ...inp, width: 170 }} value={mes} onChange={(e) => setMes(e.target.value)} /></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 16 }}>
        <Kpi t="Ventas del mes" v={ventasMes.length} /><Kpi t="Contado / Crédito" v={`${contado.length} / ${credito.length}`} /><Kpi t="Facturado (Gs eq.)" v={money(facturado, "Gs")} c={C.acc} /><Kpi t="Margen (Gs)" v={money(margenMes, "Gs")} c={C.ok} />
      </div>
      <div style={{ ...box, padding: 16, marginBottom: 16 }}>
        <b>Comparativo con el mes anterior ({mesAnt})</b>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginTop: 10 }}>
          {[["Facturado", facturado, factAnt], ["Margen", margenMes, margenAnt], ["Cobros", cobrosMes, cobrosAnt]].map(([t, a, b], i) => { const d = delta(a, b); return (
            <div key={i} style={{ ...box, background: C.panel2, padding: 12 }}>
              <div style={{ fontSize: 11, color: C.dim, textTransform: "uppercase" }}>{t}</div>
              <div style={{ fontSize: 17, fontWeight: 700 }}>{money(a, "Gs")}</div>
              <div style={{ fontSize: 12, color: d.c }}>{d.txt} <span style={{ color: C.dim }}>vs {money(b, "Gs")}</span></div>
            </div>
          ); })}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <div style={{ ...box, padding: 16 }}>
          <b>Top clientes del mes</b>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 8 }}>
            <tbody>{rankCli.length === 0 ? <tr><td style={td}><span style={{ color: C.dim }}>Sin ventas.</span></td></tr> : rankCli.map(([n, v], i) => (
              <tr key={n} style={{ borderTop: i ? `1px solid ${C.border}` : "none" }}><td style={td}>{i + 1}. {n}</td><td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{money(v, "Gs")}</td></tr>
            ))}</tbody>
          </table>
        </div>
        <div style={{ ...box, padding: 16 }}>
          <b>Rentabilidad por auto (vendidos en el mes)</b>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 8 }}>
            <tbody>{rentAuto.length === 0 ? <tr><td style={td}><span style={{ color: C.dim }}>Sin ventas.</span></td></tr> : rentAuto.map((r, i) => (
              <tr key={i} style={{ borderTop: i ? `1px solid ${C.border}` : "none" }}><td style={td}>{r.nombre || "—"}</td><td style={{ ...td, textAlign: "right", fontWeight: 700, color: r.m >= 0 ? C.ok : C.bad }}>{money(r.m, "Gs")} <span style={{ color: C.dim, fontWeight: 400 }}>({r.pct.toFixed(0)}%)</span></td></tr>
            ))}</tbody>
          </table>
        </div>
      </div>
      <div style={{ ...box, padding: 16, marginBottom: 16 }}><b>Facturado por mes (últimos 6 meses)</b><Barras data={serieFact} color={C.acc} fmt={montoCorto} alto={160} /></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <div style={{ ...box, padding: 16 }}><b>Cobros por mes (últimos 6 meses)</b><Barras data={serieCobros6} color={C.ok} fmt={montoCorto} alto={150} /></div>
        <div style={{ ...box, padding: 16 }}><b>Ventas por vendedor ({mes})</b>{serieVend.length ? <Barras data={serieVend} color={C.dev} fmt={montoCorto} alto={150} /> : <div style={{ color: C.dim, fontSize: 13, marginTop: 8 }}>Sin ventas en el mes.</div>}</div>
      </div>
      <div style={{ ...box, padding: 16, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><b>Estado de resultados — {mes}</b><Btn small kind="ghost" onClick={() => estadoResultadosPDF({ mes, facturado, cogs, margenBruto: margenMes, egresosMes, resultado, cobrosMes, flujo }, cfg)}>Descargar PDF</Btn></div>
        <div style={{ marginTop: 10, maxWidth: 480 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, padding: "6px 0" }}><span style={{ color: C.dim }}>(+) Ventas del mes (facturado)</span><span>{money(facturado, "Gs")}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, padding: "6px 0" }}><span style={{ color: C.dim }}>(−) Costo de vehículos vendidos</span><span style={{ color: C.bad }}>{money(cogs, "Gs")}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, fontWeight: 700, padding: "8px 0", borderTop: `1px solid ${C.border}` }}><span>(=) Margen bruto</span><span style={{ color: C.acc }}>{money(margenMes, "Gs")}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, padding: "6px 0" }}><span style={{ color: C.dim }}>(−) Gastos y egresos del mes (Caja)</span><span style={{ color: C.bad }}>{money(egresosMes, "Gs")}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 18, fontWeight: 800, padding: "10px 0", borderTop: `2px solid ${resultado >= 0 ? C.ok : C.bad}` }}><span>(=) RESULTADO DEL MES</span><span style={{ color: resultado >= 0 ? C.ok : C.bad }}>{money(resultado, "Gs")}</span></div>
        </div>
        <div style={{ ...box, background: C.panel2, padding: 12, marginTop: 12, display: "flex", gap: 24, flexWrap: "wrap" }}>
          <span style={{ color: C.dim }}>Flujo de caja: <b style={{ color: C.ok }}>{money(cobrosMes, "Gs")}</b> ingresos − <b style={{ color: C.bad }}>{money(egresosMes, "Gs")}</b> egresos = <b style={{ color: flujo >= 0 ? C.ok : C.bad }}>{money(flujo, "Gs")}</b></span>
        </div>
        <div style={{ fontSize: 12, color: C.dim, marginTop: 8 }}>Nota: el "Resultado" usa el margen de los autos vendidos en el mes menos los egresos cargados en Caja. Evitá cargar en Caja gastos que ya incluiste en el costeo del vehículo (se contarían dos veces).</div>
      </div>
      <div style={{ ...box, padding: 16, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}><b>Proyección de cobros (próximos 6 meses)</b><span style={{ fontSize: 12, color: C.dim }}>{atrasado > 0 && <span style={{ color: C.bad }}>Atrasado por cobrar: {money(atrasado, "Gs")} · </span>}A vencer 6 meses: <b style={{ color: C.acc }}>{money(totalProy, "Gs")}</b></span></div>
        <div style={{ fontSize: 12, color: C.dim, marginTop: 2 }}>Suma de las cuotas pendientes (menos abonos) según su mes de vencimiento — sin contar interés por mora.</div>
        <Barras data={serieProy} color={C.acc} fmt={montoCorto} alto={160} />
      </div>
      <div style={{ ...box, padding: 16, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><b>Ranking de vendedores</b><span style={{ fontSize: 12, color: C.dim }}>Cobros del mes: {money(cobrosMes, "Gs")}</span></div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 10 }}>
          <thead><tr style={{ color: C.dim, textAlign: "left" }}><th style={th}>#</th><th style={th}>Vendedor</th><th style={th}>Ventas</th><th style={{ ...th, textAlign: "right" }}>Monto (Gs eq.)</th></tr></thead>
          <tbody>{rank.length === 0 ? <tr><td style={td} colSpan={4}><span style={{ color: C.dim }}>Sin ventas en el mes.</span></td></tr> : rank.map(([v, d], i) => (
            <tr key={v} style={{ borderTop: `1px solid ${C.border}` }}><td style={td}>{i + 1}</td><td style={td}>{v}</td><td style={td}>{d.n}</td><td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{money(d.monto, "Gs")}</td></tr>
          ))}</tbody>
        </table>
      </div>
      <div style={{ ...box, padding: 16, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><b>Comisiones del mes</b><span style={{ fontSize: 12, color: C.dim }}>Total: <b style={{ color: C.warn }}>{money(totalComision, "Gs")}</b></span></div>
        <div style={{ fontSize: 12, color: C.dim, margin: "4px 0 8px" }}>Se calcula sobre el monto vendido. Configurá el % por defecto en Ajustes, o uno propio por vendedor.</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ color: C.dim, textAlign: "left" }}><th style={th}>Vendedor</th><th style={th}>Vendido (Gs eq.)</th><th style={th}>%</th><th style={{ ...th, textAlign: "right" }}>Comisión</th><th style={th}></th></tr></thead>
          <tbody>{comisiones.length === 0 ? <tr><td style={td} colSpan={5}><span style={{ color: C.dim }}>Sin ventas en el mes.</span></td></tr> : comisiones.map((c) => (
            <tr key={c.v} style={{ borderTop: `1px solid ${C.border}` }}><td style={td}>{c.v}</td><td style={td}>{money(c.monto, "Gs")}</td><td style={td}>{c.pct}%</td><td style={{ ...td, textAlign: "right", fontWeight: 700, color: C.warn }}>{money(c.comision, "Gs")}</td><td style={td}><Btn small kind="ghost" onClick={() => pagarComision(c)}>Pagar (Caja)</Btn></td></tr>
          ))}</tbody>
        </table>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn kind="ghost" onClick={() => exportCSV(`ventas-${mes}`, ventasMes.map((v) => { const cli = db.clientes.find((c) => c.id === v.clienteId) || {}; return { fecha: v.fecha, tipo: v.tipo || "credito", cliente: cli.nombre, precio: v.precio, moneda: v.moneda, vendedor: v.vendedor || "" }; }))}>Exportar ventas del mes (CSV)</Btn>
        <Btn kind="ghost" onClick={() => exportCSV(`comisiones-${mes}`, comisiones.map((c) => ({ vendedor: c.v, ventas: c.n, vendido_gs: Math.round(c.monto), porcentaje: c.pct, comision_gs: c.comision })))}>Exportar comisiones (CSV)</Btn>
      </div>
    </div>
  );
}

// ============================================================ BACKUP / CSV / PDFs extra
function descargar(nombre, contenido, tipo) {
  try { const blob = new Blob([contenido], { type: tipo }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = nombre; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500); }
  catch { alert("No se pudo descargar en este entorno."); }
}
function exportarDatos(cfg, db, nombreBase) {
  const base = nombreBase || ("copia-" + ((cfg?.empresa?.nombre || "playa").replace(/\s/g, "-").toLowerCase()));
  descargar(`${base}-${today()}.json`, JSON.stringify(db, null, 2), "application/json");
}
function importarDatos(file, setDb) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => { try { const data = JSON.parse(r.result); if (!data || typeof data !== "object") throw new Error(); if (!confirm("Esto reemplazará TODOS los datos actuales por los del archivo. ¿Continuar?")) return; setDb((s) => ({ ...s, ...data })); alert("Copia restaurada correctamente."); } catch { alert("Archivo inválido."); } };
  r.readAsText(file);
}
function exportCSV(nombre, filas) {
  if (!filas || filas.length === 0) return alert("No hay datos para exportar.");
  const cols = Object.keys(filas[0]);
  const esc = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.join(","), ...filas.map((f) => cols.map((c) => esc(f[c])).join(","))].join("\n");
  descargar(`${nombre}-${today()}.csv`, "\uFEFF" + csv, "text/csv;charset=utf-8");
}
function estadoCuentaPDF(cli, ventas, vehiculos, cfg) {
  const emp = cfg.empresa || {};
  const bloques = ventas.map((v) => {
    const vh = vehiculos.find((x) => x.id === v.vehiculoId) || {};
    const filas = (v.plan || []).map((c) => { const int = c.pagado ? (c.moraPagada || 0) : (c.venc < today() ? calcMora(c, cfg.tasaMora).monto : 0); const mon = (x) => v.moneda === "USD" ? "US$ " + new Intl.NumberFormat("en-US").format(Math.round(x)) : "Gs " + nf.format(Math.round(x)); return `<tr><td>${c.n}</td><td>${c.venc}</td><td style="text-align:right">${mon(c.monto)}</td><td style="text-align:right">${int ? mon(int) : "—"}</td><td style="text-align:right">${mon((c.monto || 0) + int)}</td><td style="color:${c.pagado ? "#16a34a" : c.venc < today() ? "#dc2626" : "#666"}">${c.pagado ? "Pagada" : c.venc < today() ? "Vencida" : "Pendiente"}</td></tr>`; }).join("");
    const d = deudaVenta(v, cfg.tasaMora, cfg.cotizacion);
    return `<h3 style="margin:18px 0 4px">${vh.marca || ""} ${vh.modelo || ""} ${vh.anio || ""} — ${v.fecha}</h3>
    <table><thead><tr><th>Cuota</th><th>Vence</th><th style="text-align:right">Monto</th><th style="text-align:right">Interés</th><th style="text-align:right">Total</th><th>Estado</th></tr></thead><tbody>${filas}</tbody></table>
    <div style="text-align:right;font-weight:bold;margin-top:4px">Saldo: ${v.moneda === "USD" ? "US$ " + new Intl.NumberFormat("en-US").format(Math.round(d.total)) : "Gs " + nf.format(Math.round(d.total))}</div>`;
  }).join("");
  printHTML(`<html><head><meta charset="utf-8"><title>Estado de cuenta</title>
  <style>@page{margin:1.5cm}body{font-family:Arial,sans-serif;color:#000;max-width:760px;margin:0 auto;padding:20px 30px}
  .head{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #000;padding-bottom:12px}
  .logo{font-weight:800;font-size:20px;color:#1a4d8f;border:3px solid #1a4d8f;border-radius:8px;padding:4px 10px}.logo small{display:block;font-size:8px;letter-spacing:2px;text-align:center}
  h1{font-size:16px;margin:0}table{width:100%;border-collapse:collapse;margin:6px 0;font-size:12px}td,th{border:1px solid #ccc;padding:4px 6px}th{background:#f0f0f0}</style></head>
  <body>${wmHTML(cfg)}<div class="head"><div>${hdrLogo(cfg)}</div><div style="text-align:right"><h1>ESTADO DE CUENTA</h1><div>${emp.nombre || ""}</div><div>${new Date().toLocaleDateString("es-PY")}</div></div></div>
  <p><b>Cliente:</b> ${cli.nombre} · C.I./RUC ${cli.ci || "—"} · ${cli.tel || "—"}</p>${bloques}
  <div style="border-top:1px solid #000;margin-top:30px;padding-top:8px;font-size:11px;color:#444">${emp.nombre || ""} · ${emp.tel || ""} · ${emp.dir || ""}</div></body></html>`);
}
function reciboContadoPDF(cli, venta, veh, cfg) {
  const emp = cfg.empresa || {};
  const mon = (x) => venta.moneda === "USD" ? "US$ " + new Intl.NumberFormat("en-US").format(x) : "Gs " + nf.format(x);
  printHTML(`<html><head><meta charset="utf-8"><title>Recibo contado</title>
  <style>body{font-family:Arial,sans-serif;color:#111;max-width:600px;margin:40px auto;padding:0 30px}
  .box{border:2px solid #22a06b;border-radius:10px;padding:24px;position:relative}h1{color:#22a06b;font-size:18px;margin:0 0 4px}
  table{width:100%;border-collapse:collapse;margin:14px 0}td{padding:6px 4px;border-bottom:1px solid #eee}.firma{margin-top:50px;border-top:1px solid #333;width:50%;text-align:center;padding-top:6px}</style></head>
  <body>${wmHTML(cfg)}<div class="box"><h1>RECIBO — VENTA AL CONTADO</h1><small>${emp.nombre || ""} · N° ${venta.id.toUpperCase()}</small>
  <table><tr><td>Fecha</td><td><b>${venta.fecha}</b></td></tr><tr><td>Recibí de</td><td><b>${cli.nombre || "—"}</b> (C.I. ${cli.ci || "—"})</td></tr>
  <tr><td>Concepto</td><td>Compra al contado — ${veh.marca} ${veh.modelo} ${veh.anio} · Chasis ${veh.vin || "—"}</td></tr>
  <tr><td><b>TOTAL</b></td><td><b style="color:#22a06b;font-size:16px">${mon(venta.precio)}</b></td></tr></table><div class="firma">Firma y sello</div></div></body></html>`);
}
function cierreCajaPDF(movs, desde, hasta, cfg) {
  const emp = cfg.empresa || {};
  const ing = movs.filter((m) => m.tipo === "ingreso").reduce((a, m) => a + (m.monto || 0), 0);
  const egr = movs.filter((m) => m.tipo === "egreso").reduce((a, m) => a + (m.monto || 0), 0);
  const filas = movs.map((m) => `<tr><td>${m.fecha}</td><td>${m.concepto}</td><td style="text-align:right;color:${m.tipo === "ingreso" ? "#16a34a" : "#dc2626"}">${m.tipo === "ingreso" ? "+" : "−"} Gs ${nf.format(m.monto)}</td></tr>`).join("");
  printHTML(`<html><head><meta charset="utf-8"><title>Cierre de caja</title>
  <style>@page{margin:1.5cm}body{font-family:Arial,sans-serif;color:#000;max-width:700px;margin:0 auto;padding:20px 30px}
  .head{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #000;padding-bottom:12px}
  .logo{font-weight:800;font-size:20px;color:#1a4d8f;border:3px solid #1a4d8f;border-radius:8px;padding:4px 10px}.logo small{display:block;font-size:8px;letter-spacing:2px;text-align:center}
  h1{font-size:16px;margin:0}table{width:100%;border-collapse:collapse;margin:12px 0;font-size:12px}td,th{border:1px solid #ccc;padding:5px 8px}th{background:#f0f0f0}
  .tot{display:flex;justify-content:flex-end;gap:24px;font-weight:bold;margin-top:10px}</style></head>
  <body>${wmHTML(cfg)}<div class="head"><div>${hdrLogo(cfg)}</div><div style="text-align:right"><h1>CIERRE DE CAJA</h1><div>${emp.nombre || ""}</div><div>${desde} a ${hasta}</div></div></div>
  <table><thead><tr><th>Fecha</th><th>Concepto</th><th style="text-align:right">Monto</th></tr></thead><tbody>${filas || '<tr><td colspan="3">Sin movimientos</td></tr>'}</tbody></table>
  <div class="tot"><span style="color:#16a34a">Ingresos: Gs ${nf.format(ing)}</span><span style="color:#dc2626">Egresos: Gs ${nf.format(egr)}</span><span>SALDO: Gs ${nf.format(ing - egr)}</span></div>
  <div style="border-top:1px solid #000;margin-top:40px;padding-top:8px;font-size:11px;color:#444">${emp.nombre || ""} · ${emp.tel || ""}</div></body></html>`);
}
function waRecordatorio(cli, ventas, vehiculos, cfg) {
  const pend = [];
  ventas.forEach((v) => (v.plan || []).forEach((c) => { if (!c.pagado && (c.venc < today() || diasEntre(today(), c.venc) <= 7)) { const int = c.venc < today() ? calcMora(c, cfg.tasaMora).monto : 0; const mon = (x) => v.moneda === "USD" ? "US$ " + new Intl.NumberFormat("en-US").format(Math.round(x)) : "Gs " + nf.format(Math.round(x)); pend.push(`• Cuota ${c.n} vence ${c.venc}: ${mon((c.monto || 0) + int)}${int ? " (incluye mora)" : ""}`); } }));
  if (pend.length === 0) return alert("Este cliente no tiene cuotas próximas ni atrasadas.");
  waOpen(cli.tel, `${cfg.empresa?.nombre || ""}\nHola ${cli.nombre}, te recordamos tus cuotas:\n${pend.join("\n")}\n¡Gracias!`);
}

// ============================================================ RESERVAS / SEÑAS
function Reservas({ db, cfg, setDb, tid, irVenta }) {
  const disponibles = db.vehiculos.filter((v) => v.estado === "Disponible");
  const [f, setF] = useState({ vehiculoId: "", clienteId: "", monto: "", moneda: cfg.moneda, vence: "", nota: "" });
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const nomV = (id) => { const v = db.vehiculos.find((x) => x.id === id) || {}; return `${v.marca || ""} ${v.modelo || ""} ${v.anio || ""}`.trim(); };
  const nomC = (id) => (db.clientes.find((c) => c.id === id) || {}).nombre || "—";
  const crear = () => {
    if (!f.vehiculoId || !f.clienteId || !f.monto) return alert("Completá vehículo, cliente y monto de la seña");
    const id = uid(); const veh = db.vehiculos.find((v) => v.id === f.vehiculoId); const cli = db.clientes.find((c) => c.id === f.clienteId) || {};
    const totalGs = toGs(+f.monto, f.moneda, cfg);
    setDb((s) => ({
      ...s,
      reservas: [{ id, tenantId: tid, vehiculoId: f.vehiculoId, clienteId: f.clienteId, monto: +f.monto, moneda: f.moneda, fecha: today(), vence: f.vence, nota: f.nota, estado: "activa" }, ...(s.reservas || [])],
      vehiculos: s.vehiculos.map((v) => v.id === f.vehiculoId ? { ...v, estado: "Reservado", clienteId: f.clienteId } : v),
      caja: [{ id: uid(), tenantId: tid, fecha: today(), tipo: "ingreso", concepto: `Seña — ${cli.nombre} (${veh.marca} ${veh.modelo})`, monto: Math.round(totalGs), moneda: "Gs", ref: `sena:${id}`, auto: true }, ...(s.caja || [])],
    }));
    senaPDF(cli, veh, { monto: +f.monto, moneda: f.moneda, fecha: today(), vence: f.vence, id }, cfg);
    auditar(setDb, "Creó reserva", `${cli.nombre} — ${veh.marca} ${veh.modelo} · seña ${money(+f.monto, f.moneda)}`);
    setF({ vehiculoId: "", clienteId: "", monto: "", moneda: cfg.moneda, vence: "", nota: "" });
  };
  const cancelar = (r) => {
    if (!confirm("¿Cancelar la reserva? El vehículo vuelve a Disponible.")) return;
    const dev = confirm("¿Devolver la seña al cliente?\nAceptar = se quita el ingreso de la caja.\nCancelar = la seña queda como ingreso de la playa.");
    setDb((s) => ({ ...s, reservas: s.reservas.map((x) => x.id === r.id ? { ...x, estado: "cancelada" } : x), vehiculos: s.vehiculos.map((v) => v.id === r.vehiculoId ? { ...v, estado: "Disponible" } : v), caja: dev ? (s.caja || []).filter((m) => m.ref !== `sena:${r.id}`) : (s.caja || []) }));
  };
  const concretar = (r) => { setDb((s) => ({ ...s, reservas: s.reservas.map((x) => x.id === r.id ? { ...x, estado: "concretada" } : x) })); irVenta(r.vehiculoId); };
  const activas = (db.reservas || []).filter((r) => r.estado === "activa");
  const color = (e) => ({ activa: C.warn, concretada: C.ok, cancelada: C.dim }[e] || C.dim);
  return (
    <div>
      <Titulo icon="reservas" sub="Autos reservados con seña">Reservas</Titulo>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 14 }}>
        <Kpi t="Reservas activas" v={activas.length} c={activas.length ? C.warn : C.ok} />
        <Kpi t="Señas cobradas (activas, Gs eq.)" v={money(activas.reduce((a, r) => a + toGs(r.monto, r.moneda, cfg), 0), "Gs")} c={C.ok} />
        <Kpi t="Autos disponibles" v={disponibles.length} />
      </div>
      <b>Nueva reserva con seña</b>
      <div style={{ ...box, padding: 16, marginTop: 10 }}>
        {db.clientes.length === 0 && <div style={{ color: C.warn, fontSize: 13, marginBottom: 8 }}>⚠ Primero registrá un cliente.</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
          <Field label="Vehículo (disponible)"><select style={inp} value={f.vehiculoId} onChange={(e) => set("vehiculoId", e.target.value)}><option value="">— Elegir —</option>{disponibles.map((v) => <option key={v.id} value={v.id}>{v.marca} {v.modelo} {v.anio} · {money(v.precioVenta, "Gs")}</option>)}</select></Field>
          <Field label="Cliente"><select style={inp} value={f.clienteId} onChange={(e) => set("clienteId", e.target.value)}><option value="">— Elegir —</option>{db.clientes.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></Field>
          <Field label="Vence (opcional)"><input type="date" style={inp} value={f.vence} onChange={(e) => set("vence", e.target.value)} /></Field>
          <Field label="Monto de seña"><input type="number" style={inp} value={f.monto} onChange={(e) => set("monto", e.target.value)} /></Field>
          <Field label="Moneda"><select style={inp} value={f.moneda} onChange={(e) => set("moneda", e.target.value)}><option>Gs</option><option>USD</option></select></Field>
          <Field label="Nota (opcional)"><input style={inp} value={f.nota} onChange={(e) => set("nota", e.target.value)} /></Field>
        </div>
        <div style={{ marginTop: 12 }}><Btn kind="acc" onClick={crear}>Reservar + comprobante de seña</Btn></div>
      </div>
      <div style={{ marginTop: 18 }}>
        <b>Reservas ({(db.reservas || []).length})</b>
        <div style={{ ...box, overflow: "hidden", marginTop: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ background: C.panel2, color: C.dim, textAlign: "left" }}><th style={th}>Vehículo</th><th style={th}>Cliente</th><th style={th}>Seña</th><th style={th}>Fecha</th><th style={th}>Vence</th><th style={th}>Estado</th><th style={th}>Acciones</th></tr></thead>
            <tbody>{(db.reservas || []).length === 0 ? <tr><td style={td} colSpan={7}><span style={{ color: C.dim }}>Sin reservas.</span></td></tr> : (db.reservas || []).map((r) => (
              <tr key={r.id} style={{ borderTop: `1px solid ${C.border}`, opacity: r.estado === "cancelada" ? 0.55 : 1 }}>
                <td style={td}>{nomV(r.vehiculoId)}</td><td style={td}>{nomC(r.clienteId)}</td><td style={{ ...td, fontWeight: 700 }}>{money(r.monto, r.moneda)}</td><td style={td}>{r.fecha}</td><td style={td}>{r.vence || "—"}</td>
                <td style={{ ...td, color: color(r.estado), fontWeight: 700, textTransform: "capitalize" }}>{r.estado}</td>
                <td style={td}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <Btn small kind="ghost" onClick={() => { const veh = db.vehiculos.find((v) => v.id === r.vehiculoId) || {}; const cli = db.clientes.find((c) => c.id === r.clienteId) || {}; senaPDF(cli, veh, r, cfg); }}>Comprobante</Btn>
                    {r.estado === "activa" && <><Btn small kind="ok" onClick={() => concretar(r)}>Concretar venta</Btn><Btn small kind="ghost" onClick={() => cancelar(r)} style={{ color: C.bad, borderColor: C.bad }}>Cancelar</Btn></>}
                  </div>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <div style={{ fontSize: 12, color: C.dim, marginTop: 8 }}>Al "Concretar venta" te lleva a Ventas con el vehículo elegido. La seña ya quedó registrada en Caja: cargala como <b>entrega inicial</b> en la venta a crédito, o descontala del precio si es al contado.</div>
      </div>
    </div>
  );
}
function senaPDF(cli, veh, r, cfg) {
  const emp = cfg.empresa || {};
  const mon = (x) => r.moneda === "USD" ? "US$ " + new Intl.NumberFormat("en-US").format(x) : "Gs " + nf.format(x);
  printHTML(`<html><head><meta charset="utf-8"><title>Comprobante de seña</title>
  <style>body{font-family:Arial,sans-serif;color:#111;max-width:600px;margin:40px auto;padding:0 30px}
  .box{border:2px solid #2b7bff;border-radius:10px;padding:24px;position:relative}h1{color:#2b7bff;font-size:18px;margin:0 0 4px}
  table{width:100%;border-collapse:collapse;margin:14px 0}td{padding:6px 4px;border-bottom:1px solid #eee}.firma{margin-top:50px;border-top:1px solid #333;width:50%;text-align:center;padding-top:6px}
  .nota{font-size:12px;color:#555;margin-top:8px}</style></head>
  <body>${wmHTML(cfg)}<div class="box"><h1>COMPROBANTE DE SEÑA / RESERVA</h1><small>${emp.nombre || ""} · N° ${(r.id || "").toUpperCase()}</small>
  <table><tr><td>Fecha</td><td><b>${r.fecha}</b></td></tr><tr><td>Recibí de</td><td><b>${cli.nombre || "—"}</b> (C.I. ${cli.ci || "—"})</td></tr>
  <tr><td>En concepto de seña por</td><td>${veh.marca || ""} ${veh.modelo || ""} ${veh.anio || ""} · Chasis ${veh.vin || "—"}</td></tr>
  ${r.vence ? `<tr><td>Reserva válida hasta</td><td>${r.vence}</td></tr>` : ""}
  <tr><td><b>MONTO DE SEÑA</b></td><td><b style="color:#2b7bff;font-size:16px">${mon(r.monto)}</b></td></tr></table>
  <div class="nota">La presente seña se imputa como parte de pago al concretarse la operación. En caso de desistimiento del comprador, la retención de la seña se rige por lo acordado entre las partes.</div>
  <div class="firma">Firma y sello</div></div></body></html>`);
}

// ============================================================ RECIBO DE SUSCRIPCIÓN (MotorGestión)
function reciboSuscPDF(susc, datos) {
  const mon = (x) => datos.moneda === "USD" ? "US$ " + new Intl.NumberFormat("en-US").format(x) : "Gs " + nf.format(x);
  printHTML(`<html><head><meta charset="utf-8"><title>Recibo de suscripción</title>
  <style>body{font-family:Arial,sans-serif;color:#111;max-width:600px;margin:40px auto;padding:0 30px}
  .box{border:2px solid #2b7bff;border-radius:10px;padding:24px;position:relative}
  .brand{font-weight:800;font-size:22px;letter-spacing:-.5px;margin-bottom:2px}.brand span{color:#2b7bff}
  h1{color:#2b7bff;font-size:16px;margin:10px 0 4px}table{width:100%;border-collapse:collapse;margin:14px 0}td{padding:6px 4px;border-bottom:1px solid #eee}
  .firma{margin-top:50px;border-top:1px solid #333;width:50%;text-align:center;padding-top:6px}.tag{font-size:11px;color:#666}</style></head>
  <body><div class="box"><div class="brand">Motor<span>Gestión</span></div><div class="tag">Tu playa de autos, bajo control</div>
  <h1>RECIBO DE SUSCRIPCIÓN</h1>
  <table>
  <tr><td>Fecha</td><td><b>${datos.fecha}</b></td></tr>
  <tr><td>Cliente</td><td><b>${susc.nombre}</b> (@${susc.user})</td></tr>
  <tr><td>Plan</td><td>${susc.plan}</td></tr>
  <tr><td>Concepto</td><td>${datos.concepto || "Suscripción"}</td></tr>
  ${datos.renovar && susc.plan !== "Único pago" ? `<tr><td>Renovación hasta</td><td>${susc.vence || "—"}</td></tr>` : ""}
  <tr><td><b>TOTAL</b></td><td><b style="color:#2b7bff;font-size:16px">${mon(datos.monto)}</b></td></tr>
  </table><div class="firma">MotorGestión</div></div></body></html>`);
}

// ============================================================ FICHA / CARTEL DEL AUTO (con QR)
function fichaPDF(veh, cfg) {
  const emp = cfg.empresa || {};
  const fotos = [...(veh.fotosExt || []), ...(veh.fotosInt || [])];
  const hero = fotos[0];
  const thumbs = fotos.slice(1, 5);
  const tel = (emp.tel || "").replace(/[^0-9]/g, "");
  const waTxt = encodeURIComponent(`Hola, me interesa el ${veh.marca || ""} ${veh.modelo || ""} ${veh.anio || ""} publicado por ${emp.nombre || ""}. ¿Sigue disponible?`);
  const waLink = tel ? `https://wa.me/595${tel.replace(/^0/, "")}?text=${waTxt}` : `https://wa.me/?text=${waTxt}`;
  const qr = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&margin=0&data=${encodeURIComponent(waLink)}`;
  const spec = (k, v) => v ? `<div class="spec"><span>${k}</span><b>${v}</b></div>` : "";
  printHTML(`<html><head><meta charset="utf-8"><title>Ficha ${veh.marca || ""} ${veh.modelo || ""}</title>
  <style>@page{margin:1cm}*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#0f1a2e;max-width:800px;margin:0 auto;padding:0}
  .top{display:flex;justify-content:space-between;align-items:center;background:#0a1424;color:#fff;padding:16px 22px;border-radius:12px 12px 0 0}
  .brand{font-weight:800;font-size:20px}.brand small{display:block;font-size:11px;color:#8ea3c6;font-weight:400}
  .logo{max-height:52px}
  .hero{width:100%;height:340px;object-fit:cover;background:#e9eef7;display:block}
  .noimg{width:100%;height:340px;background:#e9eef7;display:flex;align-items:center;justify-content:center;color:#8ea3c6;font-size:16px}
  .body{border:1px solid #d9e1ef;border-top:none;border-radius:0 0 12px 12px;padding:20px 22px}
  h1{margin:0;font-size:26px}.sub{color:#5b6b86;margin:2px 0 12px;font-size:14px}
  .price{font-size:30px;font-weight:800;color:#2b7bff;margin:6px 0 16px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:12px 0}
  .spec{background:#f3f6fc;border-radius:8px;padding:8px 12px;font-size:13px;display:flex;flex-direction:column}.spec span{color:#7688a5;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
  .thumbs{display:flex;gap:8px;margin-top:10px}.thumbs img{width:120px;height:82px;object-fit:cover;border-radius:8px}
  .foot{display:flex;justify-content:space-between;align-items:center;margin-top:18px;padding-top:14px;border-top:2px solid #0a1424}
  .contact b{font-size:15px}.contact div{font-size:13px;color:#5b6b86}
  .qr{text-align:center}.qr img{width:120px;height:120px}.qr div{font-size:11px;color:#5b6b86;margin-top:4px;max-width:130px}</style></head>
  <body>
  <div class="top"><div class="brand">${emp.nombre || "MI PLAYA DE AUTOS"}<small>${emp.ciudad || ""}</small></div>${emp.logo ? `<img class="logo" src="${emp.logo}"/>` : ""}</div>
  ${hero ? `<img class="hero" src="${hero}"/>` : `<div class="noimg">Sin foto cargada</div>`}
  <div class="body">
    <h1>${veh.marca || ""} ${veh.modelo || ""}</h1>
    <div class="sub">${veh.anio || ""} · ${veh.color || ""} · ${veh.condicion || ""}</div>
    <div class="price">${money(veh.precioVenta, "Gs")}</div>
    <div class="grid">
      ${spec("Año", veh.anio)}${spec("Kilometraje", veh.km ? nf.format(veh.km) + " km" : "")}${spec("Combustible", veh.combustible)}
      ${spec("Color", veh.color)}${spec("Condición", veh.condicion)}${spec("Chapa", veh.chapa)}
    </div>
    ${thumbs.length ? `<div class="thumbs">${thumbs.map((t) => `<img src="${t}"/>`).join("")}</div>` : ""}
    <div class="foot">
      <div class="contact"><b>Consultá disponibilidad</b><div>📞 ${emp.tel || "—"}</div><div>📍 ${emp.dir || ""}</div></div>
      <div class="qr"><img src="${qr}"/><div>Escaneá para consultar por WhatsApp</div></div>
    </div>
  </div>
  </body></html>`);
}

// ============================================================ REFINANCIACIÓN
function RefinanciarModal({ venta, cfg, onClose, onConfirm }) {
  const m = venta.moneda;
  const pend = venta.plan.filter((c) => !c.pagado);
  const capital = pend.reduce((a, c) => a + c.monto, 0);
  const mora = pend.filter((c) => c.venc < today()).reduce((a, c) => a + calcMora(c, cfg.tasaMora).monto, 0);
  const vencidas = pend.filter((c) => c.venc < today()).length;
  const saldo = capital + mora;
  const [d, setD] = useState({ entrega: "", nCuotas: 6, tasa: venta.tasa || 0, fecha: today() });
  const set = (k, v) => setD((s) => ({ ...s, [k]: v }));
  const entrega = +d.entrega || 0;
  const prev = generarPlan(saldo, entrega, +d.nCuotas || 1, +d.tasa, d.fecha);
  return (
    <Modal onClose={onClose} w={460}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}><b>Refinanciar cuotas pendientes</b><Btn small kind="ghost" onClick={onClose}>✕</Btn></div>
      <div style={{ ...box, background: C.panel2, padding: 14 }}>
        <Rows rows={[["Cuotas pendientes", `${pend.length} (${vencidas} vencida${vencidas === 1 ? "" : "s"})`], ["Capital pendiente", money(capital, m)], ["Interés por mora acumulado", money(mora, m)]]} />
        <div style={{ borderTop: `2px solid ${C.acc}`, marginTop: 10, paddingTop: 10, display: "flex", justifyContent: "space-between", fontSize: 17, fontWeight: 800 }}><span>SALDO A REFINANCIAR</span><span style={{ color: C.acc }}>{money(saldo, m)}</span></div>
      </div>
      <SubT>Nuevo plan</SubT>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 10 }}>
        <Field label={`Abono ahora (${m}, opcional)`}><input type="number" style={inp} value={d.entrega} onChange={(e) => set("entrega", e.target.value)} /></Field>
        <Field label="N° de nuevas cuotas"><input type="number" style={inp} value={d.nCuotas} onChange={(e) => set("nCuotas", e.target.value)} /></Field>
        <Field label="Interés anual %"><input type="number" style={inp} value={d.tasa} onChange={(e) => set("tasa", e.target.value)} /></Field>
        <Field label="Fecha 1ª cuota"><input type="date" style={inp} value={d.fecha} onChange={(e) => set("fecha", e.target.value)} /></Field>
      </div>
      <div style={{ ...box, background: C.panel2, padding: 12, marginTop: 12, display: "flex", gap: 20, flexWrap: "wrap" }}>
        <span style={{ color: C.dim }}>A financiar: <b style={{ color: C.txt }}>{money(prev.capital, m)}</b></span>
        <span style={{ color: C.dim }}>Nueva cuota: <b style={{ color: C.ok }}>{money(prev.cuota, m)}</b></span>
        <span style={{ color: C.dim }}>Total nuevo: <b style={{ color: C.txt }}>{money(prev.cuota * (+d.nCuotas || 0) + entrega, m)}</b></span>
      </div>
      <div style={{ fontSize: 12, color: C.dim, marginTop: 8 }}>Las cuotas pendientes se reemplazan por el nuevo plan. Las ya pagadas se conservan. Si cargás un abono, entra a Caja.</div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}><Btn kind="ghost" onClick={onClose}>Cancelar</Btn><Btn kind="acc" onClick={() => (+d.nCuotas || 0) >= 1 ? onConfirm(d) : alert("Ingresá al menos 1 cuota")}>Confirmar refinanciación</Btn></div>
    </Modal>
  );
}
function refinPDF(cli, veh, r, cfg) {
  const emp = cfg.empresa || {};
  const mon = (x) => r.moneda === "USD" ? "US$ " + new Intl.NumberFormat("en-US").format(Math.round(x)) : "Gs " + nf.format(Math.round(x));
  printHTML(`<html><head><meta charset="utf-8"><title>Refinanciación</title>
  <style>@page{margin:2cm}body{font-family:'Times New Roman',Georgia,serif;color:#000;font-size:14px;line-height:1.6;max-width:720px;margin:0 auto;padding:20px 40px}
  .head{text-align:center;margin-bottom:8px}h1{text-align:center;font-size:17px;margin:6px 0}.sub{text-align:center;color:#555;margin-bottom:20px}
  table{width:100%;border-collapse:collapse;margin:10px 0;font-size:13px}td,th{border:1px solid #ccc;padding:6px 8px}th{background:#f0f0f0;text-align:left}
  .firmas{display:flex;justify-content:space-between;margin-top:70px}.firmas div{border-top:1px solid #000;width:42%;text-align:center;padding-top:6px}
  .foot{border-top:1px solid #000;margin-top:40px;padding-top:8px;font-size:11px;text-align:center;color:#444}</style></head>
  <body>${wmHTML(cfg)}<div class="head">${hdrLogo(cfg)}</div>
  <h1>ACUERDO DE REFINANCIACIÓN DE DEUDA</h1><div class="sub">${emp.ciudad || "Ciudad del Este"}, ${r.fecha}</div>
  <p>Entre <b>${emp.nombre || "LA VENDEDORA"}</b> y el/la Sr./Sra. <b>${cli.nombre}</b> (C.I./RUC ${cli.ci || "—"}), respecto del vehículo <b>${veh.marca || ""} ${veh.modelo || ""} ${veh.anio || ""}</b> (chasis ${veh.vin || "—"}), se acuerda reprogramar el saldo adeudado en las siguientes condiciones:</p>
  <table>
  <tr><th>Saldo refinanciado (incluye mora)</th><td>${mon(r.saldo)}</td></tr>
  <tr><th>Abono en este acto</th><td>${mon(r.entrega)}</td></tr>
  <tr><th>Nuevo capital a financiar</th><td>${mon(r.base)}</td></tr>
  <tr><th>Cantidad de cuotas</th><td>${r.nCuotas}</td></tr>
  <tr><th>Interés anual</th><td>${r.tasa}%</td></tr>
  <tr><th>Nueva cuota mensual</th><td><b>${mon(r.cuota)}</b></td></tr>
  <tr><th>Total a pagar (nuevo plan)</th><td>${mon(r.cuota * r.nCuotas + r.entrega)}</td></tr>
  </table>
  <p>Este acuerdo deja sin efecto las cuotas pendientes anteriores, que quedan reemplazadas por el presente plan. El atraso en las nuevas cuotas generará interés moratorio del ${cfg.tasaMora}% mensual.</p>
  <div class="firmas"><div>LA VENDEDORA<br>${emp.nombre || ""}</div><div>EL DEUDOR<br>${cli.nombre}</div></div>
  <div class="foot">${emp.nombre || ""} · ${emp.tel || ""} · ${emp.dir || ""}</div></body></html>`);
}

// ============================================================ ESTADO DE RESULTADOS PDF
function estadoResultadosPDF(r, cfg) {
  const emp = cfg.empresa || {};
  const g = (x) => "Gs " + nf.format(Math.round(x));
  printHTML(`<html><head><meta charset="utf-8"><title>Estado de resultados</title>
  <style>@page{margin:1.5cm}body{font-family:Arial,sans-serif;color:#000;max-width:680px;margin:0 auto;padding:20px 30px}
  .head{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #000;padding-bottom:12px;margin-bottom:16px}
  .logo{font-weight:800;font-size:20px;color:#1a4d8f;border:3px solid #1a4d8f;border-radius:8px;padding:4px 10px}.logo small{display:block;font-size:8px;letter-spacing:2px;text-align:center}
  h1{font-size:16px;margin:0}table{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px}td{padding:8px 6px;border-bottom:1px solid #eee}td:last-child{text-align:right}
  .sub td{color:#555}.tot td{font-weight:bold;font-size:15px;border-top:1px solid #999}.fin td{font-weight:bold;font-size:18px;border-top:2px solid #000}
  .caja{background:#f3f6fc;border-radius:8px;padding:12px;margin-top:14px;font-size:13px}</style></head>
  <body>${wmHTML(cfg)}<div class="head"><div>${hdrLogo(cfg)}</div><div style="text-align:right"><h1>ESTADO DE RESULTADOS</h1><div>${emp.nombre || ""}</div><div>Período: ${r.mes}</div></div></div>
  <table>
  <tr class="sub"><td>(+) Ventas del mes (facturado)</td><td>${g(r.facturado)}</td></tr>
  <tr class="sub"><td>(−) Costo de vehículos vendidos</td><td>${g(r.cogs)}</td></tr>
  <tr class="tot"><td>(=) Margen bruto</td><td>${g(r.margenBruto)}</td></tr>
  <tr class="sub"><td>(−) Gastos y egresos del mes</td><td>${g(r.egresosMes)}</td></tr>
  <tr class="fin"><td>(=) RESULTADO DEL MES</td><td style="color:${r.resultado >= 0 ? "#16a34a" : "#dc2626"}">${g(r.resultado)}</td></tr>
  </table>
  <div class="caja"><b>Flujo de caja:</b> Ingresos ${g(r.cobrosMes)} − Egresos ${g(r.egresosMes)} = <b>${g(r.flujo)}</b></div>
  <p style="font-size:11px;color:#666;margin-top:16px">Reporte generado el ${new Date().toLocaleDateString("es-PY")}. Valores en Gs (equivalente). Documento de gestión interna, no válido como comprobante tributario.</p>
  <div style="border-top:1px solid #000;margin-top:30px;padding-top:8px;font-size:11px;color:#444">${emp.nombre || ""} · ${emp.tel || ""} · ${emp.dir || ""}</div></body></html>`);
}

// ============================================================ GRÁFICOS (SVG, sin librerías)
const MES_ABR = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
function ult6() {
  const arr = []; const d = new Date(); d.setDate(1);
  for (let i = 5; i >= 0; i--) { const m = new Date(d.getFullYear(), d.getMonth() - i, 1); arr.push({ key: m.toISOString().slice(0, 7), label: MES_ABR[m.getMonth()] }); }
  return arr;
}
function prox6() {
  const arr = []; const d = new Date(); d.setDate(1);
  for (let i = 0; i < 6; i++) { const m = new Date(d.getFullYear(), d.getMonth() + i, 1); arr.push({ key: m.toISOString().slice(0, 7), label: MES_ABR[m.getMonth()] }); }
  return arr;
}
const montoCorto = (v) => v >= 1e6 ? (v / 1e6).toFixed(1).replace(".0", "") + "M" : v >= 1e3 ? Math.round(v / 1e3) + "k" : String(Math.round(v));
function Barras({ data, color = C.acc, alto = 150, fmt = (v) => String(v) }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const W = 320, H = alto, padX = 10, base = H - 22;
  const gap = (W - padX * 2) / Math.max(1, data.length);
  const bw = gap * 0.58;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: alto, marginTop: 8, display: "block" }} preserveAspectRatio="none">
      <line x1={padX} y1={base} x2={W - padX} y2={base} stroke={C.border} strokeWidth="1" />
      {data.map((d, i) => {
        const bh = max ? (d.value / max) * (base - 14) : 0;
        const x = padX + i * gap + (gap - bw) / 2; const y = base - bh;
        return (
          <g key={i}>
            <rect x={x} y={y} width={bw} height={Math.max(1, bh)} rx="3" fill={color} opacity={d.value ? 1 : 0.25} />
            {d.value > 0 && <text x={x + bw / 2} y={y - 4} textAnchor="middle" fontSize="9" fill={C.dim}>{fmt(d.value)}</text>}
            <text x={x + bw / 2} y={H - 6} textAnchor="middle" fontSize="10" fill={C.dim}>{d.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ============================================================ ACTA DE ENTREGA (checklist)
function actaEntregaPDF(cli, venta, veh, cfg) {
  const emp = cfg.empresa || {};
  const items = ["Rueda de auxilio", "Gato y llave de rueda", "Documentos del vehículo (cédula/título)", "Certificado de nacionalización", "Manual del propietario", "Segunda llave / control", "Matafuego vigente", "Triángulo / chaleco", "Estado de carrocería conforme", "Estado mecánico conforme", "Tapizados y accesorios internos", "Nivel de combustible informado"];
  const check = items.map((t) => `<tr><td style="width:26px;text-align:center;font-size:16px">☐</td><td>${t}</td></tr>`).join("");
  printHTML(`<html><head><meta charset="utf-8"><title>Acta de entrega</title>
  <style>@page{margin:1.5cm}body{font-family:Arial,sans-serif;color:#000;max-width:720px;margin:0 auto;padding:20px 30px}
  .head{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #000;padding-bottom:12px;margin-bottom:14px}
  .logo{font-weight:800;font-size:20px;color:#1a4d8f;border:3px solid #1a4d8f;border-radius:8px;padding:4px 10px}.logo small{display:block;font-size:8px;letter-spacing:2px;text-align:center}
  h1{font-size:16px;margin:0}table{width:100%;border-collapse:collapse;margin:10px 0;font-size:13px}td,th{border:1px solid #ccc;padding:6px 8px}th{background:#f0f0f0;text-align:left}
  .obs{border:1px solid #ccc;border-radius:6px;min-height:70px;padding:8px;margin-top:8px}
  .firmas{display:flex;justify-content:space-between;margin-top:50px}.fbox{width:42%;text-align:center}.fimg{height:44px;display:flex;align-items:flex-end;justify-content:center}.fimg img{max-height:44px;max-width:100%}.flabel{border-top:1px solid #000;padding-top:6px}
  .foot{border-top:1px solid #000;margin-top:30px;padding-top:8px;font-size:11px;text-align:center;color:#444}</style></head>
  <body>${wmHTML(cfg)}<div class="head"><div>${hdrLogo(cfg)}</div><div style="text-align:right"><h1>ACTA DE ENTREGA DE VEHÍCULO</h1><div>${emp.nombre || ""}</div><div>${new Date().toLocaleDateString("es-PY")}</div></div></div>
  <table><tr><th>Comprador</th><td>${cli.nombre} (C.I./RUC ${cli.ci || "—"})</td></tr>
  <tr><th>Vehículo</th><td>${veh.marca || ""} ${veh.modelo || ""} ${veh.anio || ""} · ${veh.color || ""}</td></tr>
  <tr><th>Chapa / Chasis</th><td>${veh.chapa || "—"} / ${veh.vin || "—"}</td></tr>
  <tr><th>Kilometraje al entregar</th><td>${veh.km ? nf.format(veh.km) + " km" : "____________"}</td></tr></table>
  <h1 style="font-size:14px;margin:16px 0 4px">Verificación de entrega</h1>
  <table>${check}</table>
  <div>Observaciones:</div><div class="obs"></div>
  <p style="font-size:12px;margin-top:12px">El comprador declara recibir el vehículo en el estado descripto, habiendo verificado los ítems detallados. La presente acta acredita la entrega conforme.</p>
  <div class="firmas"><div class="fbox"><div class="fimg">${emp.firma ? `<img src="${emp.firma}"/>` : ""}</div><div class="flabel">ENTREGA (Vendedor)<br>${emp.nombre || ""}</div></div><div class="fbox"><div class="fimg">${cli.firma ? `<img src="${cli.firma}"/>` : ""}</div><div class="flabel">RECIBE (Comprador)<br>${cli.nombre}</div></div></div>
  <div class="foot">${emp.nombre || ""} · ${emp.tel || ""} · ${emp.dir || ""}</div></body></html>`);
}

// ============================================================ COTIZADOR RÁPIDO
function CotizadorCard({ cfg }) {
  const [d, setD] = useState({ precio: "", entrega: "", nCuotas: 12, tasa: 0, moneda: cfg.moneda });
  const set = (k, v) => setD((s) => ({ ...s, [k]: v }));
  const r = +d.precio ? generarPlan(+d.precio, +d.entrega || 0, +d.nCuotas || 1, +d.tasa, today()) : null;
  return (
    <div style={{ ...box, padding: 16 }}>
      <b>Cotizador rápido de cuotas</b>
      <div style={{ fontSize: 12, color: C.dim, marginBottom: 10 }}>Simulá una financiación para mostrarle al cliente sin registrar la venta.</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10 }}>
        <Field label="Moneda"><select style={inp} value={d.moneda} onChange={(e) => set("moneda", e.target.value)}><option>Gs</option><option>USD</option></select></Field>
        <Field label="Precio"><input type="number" style={inp} value={d.precio} onChange={(e) => set("precio", e.target.value)} /></Field>
        <Field label="Entrega"><input type="number" style={inp} value={d.entrega} onChange={(e) => set("entrega", e.target.value)} /></Field>
        <Field label="Cuotas"><input type="number" style={inp} value={d.nCuotas} onChange={(e) => set("nCuotas", e.target.value)} /></Field>
        <Field label="Interés anual %"><input type="number" style={inp} value={d.tasa} onChange={(e) => set("tasa", e.target.value)} /></Field>
      </div>
      {r && <div style={{ ...box, background: C.panel2, padding: 12, marginTop: 12, display: "flex", gap: 24, flexWrap: "wrap" }}>
        <span style={{ color: C.dim }}>A financiar: <b style={{ color: C.txt }}>{money(r.capital, d.moneda)}</b></span>
        <span style={{ color: C.dim }}>Cuota mensual: <b style={{ color: C.ok, fontSize: 16 }}>{money(r.cuota, d.moneda)}</b></span>
        <span style={{ color: C.dim }}>Total a pagar: <b style={{ color: C.txt }}>{money(r.cuota * (+d.nCuotas || 0) + (+d.entrega || 0), d.moneda)}</b></span>
      </div>}
    </div>
  );
}

// ============================================================ TALLER
const ITEM_ESTADO = ["Pendiente", "En proceso", "Listo"];
const itemColor = (e) => ({ Pendiente: C.warn, "En proceso": C.acc, Listo: C.ok }[e] || C.dim);
function Taller({ db, cfg, setVeh }) {
  const [envId, setEnvId] = useState("");
  const enTaller = db.vehiculos.filter((v) => v.estado === "En taller" || (v.gastosExtra || []).some((g) => g.taller));
  const candidatos = db.vehiculos.filter((v) => v.estado !== "Vendido" && v.estado !== "En taller");
  const tallerCost = (v) => (v.gastosExtra || []).filter((g) => g.taller).reduce((a, g) => a + (+g.monto || 0), 0);
  const totalTaller = enTaller.reduce((a, v) => a + tallerCost(v), 0);
  const enviar = () => { if (!envId) return alert("Elegí un vehículo"); setVeh(envId, { estado: "En taller" }); setEnvId(""); };
  return (
    <div>
      <Titulo icon="taller" sub="Vehículos en reparación y sus costos">Taller</Titulo>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 14 }}>
        <Kpi t="Autos en taller" v={enTaller.length} c={enTaller.length ? C.acc : C.ok} />
        <Kpi t="Costo de reparación acumulado" v={money(totalTaller, "Gs")} c={C.warn} />
        <Kpi t="Autos disponibles" v={db.vehiculos.filter((v) => v.estado === "Disponible").length} />
      </div>
      <div style={{ ...box, padding: 14, marginBottom: 16, display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
        <Field label="Enviar vehículo a taller"><select style={{ ...inp, minWidth: 260 }} value={envId} onChange={(e) => setEnvId(e.target.value)}><option value="">— Elegir vehículo —</option>{candidatos.map((v) => <option key={v.id} value={v.id}>{v.marca} {v.modelo} {v.anio} · {v.estado}</option>)}</select></Field>
        <Btn kind="acc" onClick={enviar}>Enviar a taller</Btn>
      </div>
      {enTaller.length === 0 && <Empty t="No hay vehículos en taller." />}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {enTaller.map((v) => <TallerCard key={v.id} v={v} cfg={cfg} setVeh={setVeh} costo={tallerCost(v)} />)}
      </div>
    </div>
  );
}
function TallerCard({ v, cfg, setVeh, costo }) {
  const [it, setIt] = useState({ concepto: "", monto: "", estado: "Pendiente" });
  const set = (k, val) => setIt((s) => ({ ...s, [k]: val }));
  const items = (v.gastosExtra || []).map((g, i) => ({ ...g, _i: i })).filter((g) => g.taller);
  const addItem = () => { if (!it.concepto || !it.monto) return alert("Completá concepto y monto"); setVeh(v.id, { gastosExtra: [...(v.gastosExtra || []), { id: uid(), concepto: it.concepto, monto: +it.monto, taller: true, estadoItem: it.estado, fecha: today() }] }); setIt({ concepto: "", monto: "", estado: "Pendiente" }); };
  const setEstadoItem = (idx, est) => setVeh(v.id, { gastosExtra: v.gastosExtra.map((g, i) => i === idx ? { ...g, estadoItem: est } : g) });
  const delItem = (idx) => setVeh(v.id, { gastosExtra: v.gastosExtra.filter((_, i) => i !== idx) });
  const pendientes = items.filter((g) => g.estadoItem !== "Listo").length;
  return (
    <div className="card-hover" style={box}>
      <div style={{ padding: 12, borderBottom: `1px solid ${C.border}`, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700 }}>🔧 {v.marca} {v.modelo} {v.anio} <span style={{ color: C.dim, fontWeight: 400 }}>· chapa {v.chapa || "—"}</span></div>
        <span style={{ fontSize: 12, color: pendientes ? C.warn : C.ok }}>{pendientes ? `${pendientes} tarea(s) pendiente(s)` : "Todo listo"}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 13 }}>Reparación: <b style={{ color: C.warn }}>{money(costo, "Gs")}</b></span>
          {pendientes === 0 && <Btn small kind="ok" onClick={() => setVeh(v.id, { estado: "Disponible" })}>Marcar disponible</Btn>}
        </div>
      </div>
      <div style={{ padding: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr auto", gap: 8, alignItems: "end", marginBottom: 10 }}>
          <Field label="Trabajo / repuesto"><input style={inp} value={it.concepto} onChange={(e) => set("concepto", e.target.value)} placeholder="Ej. pastillas de freno, chapa y pintura…" /></Field>
          <Field label="Costo (Gs)"><input type="number" style={inp} value={it.monto} onChange={(e) => set("monto", e.target.value)} /></Field>
          <Field label="Estado"><select style={inp} value={it.estado} onChange={(e) => set("estado", e.target.value)}>{ITEM_ESTADO.map((s) => <option key={s}>{s}</option>)}</select></Field>
          <Btn kind="acc" onClick={addItem}>Agregar</Btn>
        </div>
        {items.length === 0 ? <div style={{ color: C.dim, fontSize: 13 }}>Sin trabajos cargados.</div> : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ color: C.dim, textAlign: "left" }}><th style={th}>Trabajo</th><th style={th}>Fecha</th><th style={{ ...th, textAlign: "right" }}>Costo</th><th style={th}>Estado</th><th style={th}></th></tr></thead>
            <tbody>{items.map((g) => (
              <tr key={g._i} style={{ borderTop: `1px solid ${C.border}` }}>
                <td style={td}>{g.concepto}</td><td style={td}>{g.fecha || "—"}</td><td style={{ ...td, textAlign: "right" }}>{money(g.monto, "Gs")}</td>
                <td style={td}><select value={g.estadoItem || "Pendiente"} onChange={(e) => setEstadoItem(g._i, e.target.value)} style={{ ...inp, width: 130, color: itemColor(g.estadoItem), fontWeight: 600 }}>{ITEM_ESTADO.map((s) => <option key={s}>{s}</option>)}</select></td>
                <td style={td}><Btn small kind="ghost" onClick={() => delItem(g._i)} style={{ color: C.bad, borderColor: C.bad }}>✕</Btn></td>
              </tr>
            ))}</tbody>
          </table>
        )}
        <div style={{ fontSize: 12, color: C.dim, marginTop: 8 }}>Los costos de taller se suman al costeo del vehículo y ajustan su margen automáticamente.</div>
      </div>
    </div>
  );
}

// ============================================================ BUSCADOR GLOBAL
function BuscadorGlobal({ db, onCliente, onVehiculo, onVenta }) {
  const [q, setQ] = useState(""); const [open, setOpen] = useState(false);
  const t = q.trim().toLowerCase();
  const activo = t.length >= 2;
  const cli = activo ? db.clientes.filter((c) => (`${c.nombre} ${c.ci || ""} ${c.tel || ""}`).toLowerCase().includes(t)).slice(0, 6) : [];
  const veh = activo ? db.vehiculos.filter((v) => (`${v.marca || ""} ${v.modelo || ""} ${v.anio || ""} ${v.chapa || ""} ${v.color || ""}`).toLowerCase().includes(t)).slice(0, 6) : [];
  const ventasR = activo ? db.ventas.filter((vt) => { const c = db.clientes.find((x) => x.id === vt.clienteId) || {}; const vh = db.vehiculos.find((x) => x.id === vt.vehiculoId) || {}; return (`${c.nombre || ""} ${vh.marca || ""} ${vh.modelo || ""}`).toLowerCase().includes(t); }).slice(0, 6) : [];
  const hay = cli.length || veh.length || ventasR.length;
  const nombreV = (id) => { const c = db.clientes.find((x) => x.id === id) || {}; return c.nombre || "—"; };
  const nombreVeh = (id) => { const v = db.vehiculos.find((x) => x.id === id) || {}; return `${v.marca || ""} ${v.modelo || ""} ${v.anio || ""}`.trim(); };
  const Grupo = ({ txt }) => <div style={{ padding: "6px 12px", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: C.acc, background: C.panel2 }}>{txt}</div>;
  const Item = ({ main, sub, onClick }) => <div onMouseDown={onClick} style={{ padding: "8px 12px", cursor: "pointer", borderTop: `1px solid ${C.border}` }}><div style={{ fontSize: 13, fontWeight: 600, color: C.txt }}>{main}</div><div style={{ fontSize: 11, color: C.dim }}>{sub}</div></div>;
  return (
    <div style={{ position: "relative" }}>
      <input style={{ ...inp, width: 210 }} placeholder="Buscar cliente, auto, venta…" value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 180)} />
      {open && activo && (
        <div style={{ position: "absolute", top: "115%", right: 0, width: 320, ...box, zIndex: 60, maxHeight: 380, overflow: "auto", boxShadow: "0 12px 34px rgba(0,0,0,.5)" }}>
          {!hay && <div style={{ padding: 12, color: C.dim, fontSize: 13 }}>Sin resultados para “{q}”.</div>}
          {cli.length > 0 && <Grupo txt="Clientes" />}
          {cli.map((c) => <Item key={c.id} main={c.nombre} sub={`C.I. ${c.ci || "—"}${c.tel ? " · " + c.tel : ""}`} onClick={() => { onCliente(c.id); setQ(""); setOpen(false); }} />)}
          {veh.length > 0 && <Grupo txt="Vehículos" />}
          {veh.map((v) => <Item key={v.id} main={`${v.marca || ""} ${v.modelo || ""} ${v.anio || ""}`} sub={`${v.estado || "Disponible"} · chapa ${v.chapa || "—"} · ${money(v.precioVenta, "Gs")}`} onClick={() => { onVehiculo(v.id); setQ(""); setOpen(false); }} />)}
          {ventasR.length > 0 && <Grupo txt="Ventas" />}
          {ventasR.map((vt) => <Item key={vt.id} main={`${nombreV(vt.clienteId)} — ${nombreVeh(vt.vehiculoId)}`} sub={`${vt.fecha} · ${vt.tipo === "contado" || !vt.plan ? "Contado" : "Crédito"} · ${money(vt.precio, vt.moneda)}`} onClick={() => { onVenta(vt); setQ(""); setOpen(false); }} />)}
        </div>
      )}
    </div>
  );
}

// ============================================================ RECIBO DE ABONO PARCIAL
function abonoPDF(cli, venta, veh, c, ab, m, cfg) {
  const emp = cfg.empresa || {};
  const cot = cfg.cotizacion || 1;
  const mon = (x) => m === "USD" ? "US$ " + new Intl.NumberFormat("en-US").format(x) : "Gs " + nf.format(Math.round(x));
  const pagadoMon = m === "USD" ? ab.pagadoGs / cot : ab.pagadoGs;
  const saldoMon = m === "USD" ? ab.saldoGs / cot : ab.saldoGs;
  const des = [];
  if (ab.pagoGs) des.push(`<tr><td>Recibido en guaraníes</td><td>Gs ${nf.format(Math.round(ab.pagoGs))}</td></tr>`);
  if (ab.pagoUSD) des.push(`<tr><td>Recibido en dólares</td><td>US$ ${new Intl.NumberFormat("en-US").format(ab.pagoUSD)}</td></tr>`);
  printHTML(`<html><head><meta charset="utf-8"><title>Recibo de abono</title>
  <style>body{font-family:Arial,sans-serif;color:#111;max-width:600px;margin:40px auto;padding:0 30px}
  .box{border:2px solid #2b7bff;border-radius:10px;padding:24px;position:relative}h1{color:#2b7bff;font-size:18px;margin:0 0 4px}
  table{width:100%;border-collapse:collapse;margin:14px 0}td{padding:6px 4px;border-bottom:1px solid #eee}.firma{margin-top:50px;border-top:1px solid #333;width:50%;text-align:center;padding-top:6px}</style></head>
  <body>${wmHTML(cfg)}<div class="box"><h1>RECIBO DE ABONO PARCIAL</h1><small>${emp.nombre || ""} · N° ${venta.id.toUpperCase()}-${c.n}</small>
  <table><tr><td>Fecha</td><td><b>${new Date().toLocaleDateString("es-PY")}</b></td></tr>
  <tr><td>Recibí de</td><td><b>${cli.nombre || "—"}</b> (C.I. ${cli.ci || "—"})</td></tr>
  <tr><td>Concepto</td><td>Abono a cuota ${c.n}/${venta.plan.length} — ${veh.marca} ${veh.modelo} ${veh.anio}</td></tr>
  ${des.join("")}
  <tr><td><b>ABONO RECIBIDO</b></td><td><b style="color:#2b7bff;font-size:16px">${mon(pagadoMon)}</b></td></tr>
  <tr><td>Saldo restante de la cuota</td><td><b>${mon(saldoMon)}</b></td></tr>
  </table><div class="firma">Firma y sello</div></div></body></html>`);
}

// ============================================================ NOTAS / TAREAS
function Notas({ db, setDb, tid }) {
  const [f, setF] = useState({ texto: "", tipo: "Tarea", vinTipo: "general", vinId: "", vence: "" });
  const [ver, setVer] = useState("pendientes");
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const add = () => { if (!f.texto.trim()) return alert("Escribí la nota o tarea"); setDb((s) => ({ ...s, notas: [{ id: uid(), tenantId: tid, texto: f.texto.trim(), tipo: f.tipo, hecha: false, fecha: today(), vence: f.vence, vinTipo: f.vinTipo, vinId: f.vinId }, ...(s.notas || [])] })); setF({ texto: "", tipo: "Tarea", vinTipo: "general", vinId: "", vence: "" }); };
  const toggle = (id) => setDb((s) => ({ ...s, notas: s.notas.map((n) => n.id === id ? { ...n, hecha: !n.hecha } : n) }));
  const del = (id) => setDb((s) => ({ ...s, notas: (s.notas || []).filter((n) => n.id !== id) }));
  const vinLabel = (n) => { if (n.vinTipo === "cliente") { const c = db.clientes.find((x) => x.id === n.vinId); return c ? "👤 " + c.nombre : ""; } if (n.vinTipo === "vehiculo") { const v = db.vehiculos.find((x) => x.id === n.vinId); return v ? "🚗 " + v.marca + " " + v.modelo : ""; } return ""; };
  const lista = (db.notas || []).filter((n) => ver === "todas" || !n.hecha).sort((a, b) => (a.vence || "9999").localeCompare(b.vence || "9999"));
  return (
    <div>
      <Titulo icon="notas" sub="Recordatorios y tareas internas">Notas y tareas</Titulo>
      <b>Nueva nota / tarea</b>
      <div style={{ ...box, padding: 16, marginTop: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr auto", gap: 10, alignItems: "end" }}>
          <Field label="Texto"><input style={inp} value={f.texto} onChange={(e) => set("texto", e.target.value)} placeholder="Ej. llamar a Pérez por transferencia…" /></Field>
          <Field label="Tipo"><select style={inp} value={f.tipo} onChange={(e) => set("tipo", e.target.value)}><option>Tarea</option><option>Nota</option></select></Field>
          <Field label="Vincular a"><select style={inp} value={f.vinTipo} onChange={(e) => { set("vinTipo", e.target.value); set("vinId", ""); }}><option value="general">General</option><option value="cliente">Cliente</option><option value="vehiculo">Vehículo</option></select></Field>
          <Field label="&nbsp;">{f.vinTipo === "cliente" ? <select style={inp} value={f.vinId} onChange={(e) => set("vinId", e.target.value)}><option value="">— Cliente —</option>{db.clientes.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select> : f.vinTipo === "vehiculo" ? <select style={inp} value={f.vinId} onChange={(e) => set("vinId", e.target.value)}><option value="">— Vehículo —</option>{db.vehiculos.map((v) => <option key={v.id} value={v.id}>{v.marca} {v.modelo} {v.anio}</option>)}</select> : <input style={{ ...inp, opacity: 0.4 }} disabled placeholder="—" />}</Field>
          <Btn kind="acc" onClick={add}>Agregar</Btn>
        </div>
        <div style={{ marginTop: 8 }}><Field label="Vencimiento (opcional)"><input type="date" style={{ ...inp, width: 180 }} value={f.vence} onChange={(e) => set("vence", e.target.value)} /></Field></div>
      </div>
      <div style={{ display: "flex", gap: 8, margin: "16px 0 10px" }}>
        {[["pendientes", "Pendientes"], ["todas", "Todas"]].map(([k, l]) => <Btn key={k} kind={ver === k ? "acc" : "ghost"} onClick={() => setVer(k)}>{l}</Btn>)}
      </div>
      {lista.length === 0 && <Empty t="Sin notas ni tareas." />}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {lista.map((n) => { const vencida = n.tipo === "Tarea" && !n.hecha && n.vence && n.vence < today(); return (
          <div key={n.id} style={{ ...box, padding: 12, display: "flex", alignItems: "center", gap: 12, opacity: n.hecha ? 0.55 : 1 }}>
            {n.tipo === "Tarea" ? <input type="checkbox" checked={n.hecha} onChange={() => toggle(n.id)} style={{ width: 18, height: 18 }} /> : <span style={{ color: C.acc }}>●</span>}
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, textDecoration: n.hecha ? "line-through" : "none" }}>{n.texto}</div>
              <div style={{ fontSize: 12, color: C.dim }}>{n.tipo} · creada {n.fecha}{n.vence ? " · vence " : ""}<span style={{ color: vencida ? C.bad : C.dim }}>{n.vence || ""}{vencida ? " ⚠" : ""}</span>{vinLabel(n) ? " · " + vinLabel(n) : ""}</div>
            </div>
            <Btn small kind="ghost" onClick={() => del(n.id)} style={{ color: C.bad, borderColor: C.bad }}>✕</Btn>
          </div>
        ); })}
      </div>
    </div>
  );
}

// ============================================================ CATÁLOGO WEB PÚBLICO
function catalogoWeb(vehiculos, cfg, download) {
  const emp = cfg.empresa || {};
  const disp = vehiculos.filter((v) => v.estado === "Disponible");
  const tel = (emp.tel || "").replace(/[^0-9]/g, "");
  const waBase = (v) => { const txt = encodeURIComponent(`Hola, me interesa el ${v.marca || ""} ${v.modelo || ""} ${v.anio || ""} (${money(v.precioVenta, "Gs")}). ¿Sigue disponible?`); return tel ? `https://wa.me/595${tel.replace(/^0/, "")}?text=${txt}` : `https://wa.me/?text=${txt}`; };
  const cards = disp.map((v) => {
    const foto = (v.fotosExt || v.fotosInt || [])[0];
    const specs = [v.km ? nf.format(v.km) + " km" : "", v.combustible, v.condicion, v.chapa ? "Chapa " + v.chapa : ""].filter(Boolean).join(" · ");
    return `<div class="card">
      <div class="ph" style="${foto ? `background-image:url('${foto}')` : ""}">${foto ? "" : "Sin foto"}</div>
      <div class="info">
        <div class="ttl">${v.marca || ""} ${v.modelo || ""}</div>
        <div class="meta">${v.anio || ""}${v.color ? " · " + v.color : ""}</div>
        <div class="price">${money(v.precioVenta, "Gs")}</div>
        <div class="specs">${specs || "&nbsp;"}</div>
        <a class="wa" href="${waBase(v)}" target="_blank" rel="noopener">Consultar por WhatsApp</a>
      </div>
    </div>`;
  }).join("");
  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${emp.nombre || "Catálogo"} — Autos disponibles</title>
  <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',Arial,sans-serif;background:#0a1424;color:#eaf0fb}
  .top{background:linear-gradient(135deg,#14345f,#0a1424);padding:22px 20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;border-bottom:1px solid #22334f}
  .brand{font-weight:800;font-size:22px}.brand small{display:block;font-weight:400;font-size:12px;color:#8ea3c6}
  .contact{font-size:13px;color:#8ea3c6;text-align:right}.contact b{color:#eaf0fb}
  .logo{height:52px}
  .bar{padding:14px 20px;color:#8ea3c6;font-size:14px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;padding:0 20px 40px}
  .card{background:#101d33;border:1px solid #22334f;border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
  .ph{height:180px;background:#16243d center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:#5b6b86;font-size:13px}
  .info{padding:14px}.ttl{font-weight:700;font-size:17px}.meta{color:#8ea3c6;font-size:13px;margin:2px 0 8px}
  .price{color:#2b7bff;font-weight:800;font-size:22px}.specs{color:#8ea3c6;font-size:12px;margin:6px 0 12px;min-height:16px}
  .wa{display:block;text-align:center;background:#25D366;color:#fff;text-decoration:none;padding:9px;border-radius:8px;font-weight:700;font-size:14px}
  .empty{padding:60px 20px;text-align:center;color:#8ea3c6}
  .foot{padding:20px;text-align:center;color:#5b6b86;font-size:12px;border-top:1px solid #22334f}
  .foot b{color:#2b7bff}
  @media print{.wa{border:1px solid #25D366}}</style></head>
  <body>
  <div class="top"><div class="brand">${emp.nombre || "MI PLAYA DE AUTOS"}<small>${emp.ciudad || ""}</small></div>${emp.logo ? `<img class="logo" src="${emp.logo}"/>` : ""}<div class="contact"><b>📞 ${emp.tel || ""}</b><br>📍 ${emp.dir || ""}</div></div>
  <div class="bar">${disp.length} vehículo(s) disponible(s) · Precios en guaraníes</div>
  ${disp.length ? `<div class="grid">${cards}</div>` : `<div class="empty">No hay vehículos disponibles en este momento.</div>`}
  <div class="foot">Catálogo generado con <b>MotorGestión</b> · Tu playa de autos, bajo control</div>
  </body></html>`;
  if (download) return descargar(`catalogo-${(emp.nombre || "playa").replace(/\s/g, "-").toLowerCase()}-${today()}.html`, html, "text/html");
  const w = window.open("", "_blank");
  if (!w) return alert("Permití las ventanas emergentes para ver el catálogo. También podés descargarlo desde Ajustes.");
  w.document.write(html); w.document.close();
}

// ============================================================ ACTIVIDAD (auditoría)
function Actividad({ db, setDb }) {
  const [q, setQ] = useState("");
  const acts = (db.actividad || []).filter((a) => (`${a.usuario} ${a.accion} ${a.detalle}`).toLowerCase().includes(q.toLowerCase()));
  const fmt = (ts) => { try { return new Date(ts).toLocaleString("es-PY"); } catch { return ts; } };
  const limpiar = () => { if (confirm("¿Borrar todo el registro de actividad? No se puede deshacer.")) setDb((s) => ({ ...s, actividad: (s.actividad || []).filter((a) => a.tenantId !== (AUDIT.tid)) })); };
  return (
    <div>
      <Titulo icon="log" sub="Quién hizo qué y cuándo">Actividad</Titulo>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <b style={{ marginRight: "auto" }}>Registro de actividad ({(db.actividad || []).length})</b>
        <input style={{ ...inp, width: 220 }} placeholder="Buscar usuario, acción…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Btn kind="ghost" onClick={() => exportCSV("actividad", (db.actividad || []).map((a) => ({ fecha: fmt(a.ts), usuario: a.usuario, accion: a.accion, detalle: a.detalle })))}>Exportar CSV</Btn>
        <Btn kind="ghost" onClick={limpiar} style={{ color: C.bad, borderColor: C.bad }}>Limpiar</Btn>
      </div>
      {acts.length === 0 ? <Empty t="Sin actividad registrada." /> : (
        <div style={{ ...box, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ background: C.panel2, color: C.dim, textAlign: "left" }}><th style={th}>Fecha y hora</th><th style={th}>Usuario</th><th style={th}>Acción</th><th style={th}>Detalle</th></tr></thead>
            <tbody>{acts.slice(0, 300).map((a) => (
              <tr key={a.id} style={{ borderTop: `1px solid ${C.border}` }}><td style={{ ...td, color: C.dim, whiteSpace: "nowrap" }}>{fmt(a.ts)}</td><td style={td}>{a.usuario}</td><td style={{ ...td, fontWeight: 600 }}>{a.accion}</td><td style={{ ...td, color: C.dim }}>{a.detalle}</td></tr>
            ))}</tbody>
          </table>
          {acts.length > 300 && <div style={{ padding: 10, textAlign: "center", color: C.dim, fontSize: 12 }}>Mostrando los 300 más recientes de {acts.length}.</div>}
        </div>
      )}
    </div>
  );
}

// ============================================================ FIRMA DIGITAL (canvas)
function FirmaPad({ valor, titulo, onSave, onClose }) {
  const ref = useRef(); const drawing = useRef(false);
  useEffect(() => {
    const cv = ref.current; const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = "#111"; ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (valor) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, cv.width, cv.height); img.src = valor; }
  }, []);
  const pos = (e) => { const cv = ref.current; const r = cv.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return { x: (t.clientX - r.left) * (cv.width / r.width), y: (t.clientY - r.top) * (cv.height / r.height) }; };
  const start = (e) => { drawing.current = true; const ctx = ref.current.getContext("2d"); const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
  const move = (e) => { if (!drawing.current) return; e.preventDefault(); const ctx = ref.current.getContext("2d"); const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); };
  const end = () => { drawing.current = false; };
  const limpiar = () => { const cv = ref.current; const ctx = cv.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height); };
  return (
    <Modal onClose={onClose} w={440}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><b>{titulo || "Firma"}</b><Btn small kind="ghost" onClick={onClose}>✕</Btn></div>
      <div style={{ fontSize: 12, color: C.dim, marginBottom: 8 }}>Dibujá la firma con el mouse o el dedo.</div>
      <canvas ref={ref} width={400} height={180} style={{ width: "100%", background: "#fff", borderRadius: 8, border: `1px solid ${C.border}`, touchAction: "none", cursor: "crosshair" }} onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end} onTouchStart={start} onTouchMove={move} onTouchEnd={end} />
      <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: 12 }}>
        <Btn kind="ghost" onClick={limpiar}>Limpiar</Btn>
        <div style={{ display: "flex", gap: 8 }}>{valor && <Btn kind="ghost" onClick={() => onSave("")}>Quitar</Btn>}<Btn kind="ghost" onClick={onClose}>Cancelar</Btn><Btn kind="acc" onClick={() => onSave(ref.current.toDataURL("image/png"))}>Guardar firma</Btn></div>
      </div>
    </Modal>
  );
}

// ============================================================ CUENTAS POR PAGAR
function CuentasPorPagar({ db, cfg, setDb, tid }) {
  const [f, setF] = useState({ proveedor: "", concepto: "", monto: "", moneda: "Gs", fecha: today(), vence: "" });
  const [ver, setVer] = useState("pendientes");
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const lista = (db.cxp || []).filter((c) => ver === "todas" ? true : c.estado !== "pagada").sort((a, b) => (a.vence || "9999").localeCompare(b.vence || "9999"));
  const pend = (db.cxp || []).filter((c) => c.estado !== "pagada");
  const totalPend = pend.reduce((a, c) => a + toGs(c.monto, c.moneda, cfg), 0);
  const vencidas = pend.filter((c) => c.vence && c.vence < today());
  const totalVenc = vencidas.reduce((a, c) => a + toGs(c.monto, c.moneda, cfg), 0);
  const add = () => { if (!f.proveedor || !f.monto) return alert("Completá proveedor y monto"); setDb((s) => ({ ...s, cxp: [{ id: uid(), tenantId: tid, proveedor: f.proveedor, concepto: f.concepto, monto: +f.monto, moneda: f.moneda, fecha: f.fecha, vence: f.vence, estado: "pendiente" }, ...(s.cxp || [])] })); auditar(setDb, "Registró cuenta por pagar", `${f.proveedor} · ${money(+f.monto, f.moneda)}`); setF({ proveedor: "", concepto: "", monto: "", moneda: "Gs", fecha: today(), vence: "" }); };
  const pagar = (c) => { if (!confirm(`Marcar como pagada y registrar egreso en Caja: ${c.proveedor} · ${money(c.monto, c.moneda)}?`)) return; const gs = Math.round(toGs(c.monto, c.moneda, cfg)); setDb((s) => ({ ...s, cxp: s.cxp.map((x) => x.id === c.id ? { ...x, estado: "pagada", fechaPago: today() } : x), caja: [{ id: uid(), tenantId: tid, fecha: today(), tipo: "egreso", concepto: `Pago a ${c.proveedor}${c.concepto ? " — " + c.concepto : ""}`, monto: gs, moneda: "Gs", ref: `cxp:${c.id}`, auto: true }, ...(s.caja || [])] })); auditar(setDb, "Pagó cuenta", `${c.proveedor} · ${money(c.monto, c.moneda)}`); };
  const del = (c) => { if (confirm("¿Eliminar esta cuenta?")) setDb((s) => ({ ...s, cxp: s.cxp.filter((x) => x.id !== c.id), caja: (s.caja || []).filter((m) => m.ref !== `cxp:${c.id}`) })); };
  return (
    <div>
      <Titulo icon="cxp" sub="Deudas con proveedores, despacho y taller">Cuentas por pagar</Titulo>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 14 }}>
        <Kpi t="Total por pagar (Gs eq.)" v={money(totalPend, "Gs")} c={totalPend ? C.warn : C.ok} />
        <Kpi t="Vencidas" v={vencidas.length} c={vencidas.length ? C.bad : C.ok} />
        <Kpi t="Monto vencido (Gs eq.)" v={money(totalVenc, "Gs")} c={totalVenc ? C.bad : C.ok} />
      </div>
      <b>Nueva cuenta por pagar</b>
      <div style={{ ...box, padding: 16, marginTop: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1.3fr 1fr auto 1fr auto", gap: 10, alignItems: "end" }}>
          <Field label="Proveedor"><input style={inp} value={f.proveedor} onChange={(e) => set("proveedor", e.target.value)} placeholder="Despacho, taller, proveedor…" /></Field>
          <Field label="Concepto"><input style={inp} value={f.concepto} onChange={(e) => set("concepto", e.target.value)} /></Field>
          <Field label="Monto"><input type="number" style={inp} value={f.monto} onChange={(e) => set("monto", e.target.value)} /></Field>
          <Field label="Moneda"><select style={inp} value={f.moneda} onChange={(e) => set("moneda", e.target.value)}><option>Gs</option><option>USD</option></select></Field>
          <Field label="Vence"><input type="date" style={inp} value={f.vence} onChange={(e) => set("vence", e.target.value)} /></Field>
          <Btn kind="acc" onClick={add}>Agregar</Btn>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, margin: "16px 0 10px" }}>{[["pendientes", "Pendientes"], ["todas", "Todas"]].map(([k, l]) => <Btn key={k} kind={ver === k ? "acc" : "ghost"} onClick={() => setVer(k)}>{l}</Btn>)}</div>
      {lista.length === 0 && <Empty t="Sin cuentas por pagar." />}
      <div style={{ ...box, overflow: "hidden" }}>
        {lista.length > 0 && <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ background: C.panel2, color: C.dim, textAlign: "left" }}><th style={th}>Proveedor</th><th style={th}>Concepto</th><th style={{ ...th, textAlign: "right" }}>Monto</th><th style={th}>Vence</th><th style={th}>Estado</th><th style={th}>Acciones</th></tr></thead>
          <tbody>{lista.map((c) => { const venc = c.estado !== "pagada" && c.vence && c.vence < today(); return (
            <tr key={c.id} style={{ borderTop: `1px solid ${C.border}`, opacity: c.estado === "pagada" ? 0.6 : 1, background: venc ? "rgba(255,92,98,.06)" : "transparent" }}>
              <td style={{ ...td, fontWeight: 600 }}>{c.proveedor}</td><td style={td}>{c.concepto || "—"}</td><td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{money(c.monto, c.moneda)}</td>
              <td style={{ ...td, color: venc ? C.bad : C.dim }}>{c.vence || "—"}{venc ? " ⚠" : ""}</td>
              <td style={{ ...td, color: c.estado === "pagada" ? C.ok : venc ? C.bad : C.warn }}>{c.estado === "pagada" ? "Pagada " + (c.fechaPago || "") : venc ? "Vencida" : "Pendiente"}</td>
              <td style={td}><div style={{ display: "flex", gap: 6 }}>{c.estado !== "pagada" && <Btn small kind="ok" onClick={() => pagar(c)}>Pagar</Btn>}<Btn small kind="ghost" onClick={() => del(c)} style={{ color: C.bad, borderColor: C.bad }}>✕</Btn></div></td>
            </tr>
          ); })}</tbody>
        </table>}
      </div>
    </div>
  );
}

// ============================================================ PAGARÉ (número en letras)
function enLetras(num) {
  num = Math.round(Math.abs(num));
  if (num === 0) return "cero";
  const u = ["", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve", "veinte", "veintiuno", "veintidós", "veintitrés", "veinticuatro", "veinticinco", "veintiséis", "veintisiete", "veintiocho", "veintinueve"];
  const d = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
  const c = ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"];
  const seccion = (n) => { if (n === 100) return "cien"; let t = ""; const cen = Math.floor(n / 100), res = n % 100; if (cen) t += c[cen] + (res ? " " : ""); if (res < 30) t += u[res]; else { const dec = Math.floor(res / 10), un = res % 10; t += d[dec] + (un ? " y " + u[un] : ""); } return t.trim(); };
  const miles = (n) => { const mil = Math.floor(n / 1000), res = n % 1000; let t = ""; if (mil) { t += (mil === 1 ? "mil" : seccion(mil) + " mil"); if (res) t += " "; } if (res) t += seccion(res); return t.trim(); };
  const millones = Math.floor(num / 1e6), resto = num % 1e6; let t = "";
  if (millones) { t += (millones === 1 ? "un millón" : miles(millones) + " millones"); if (resto) t += " "; }
  if (resto) t += miles(resto);
  return t.trim();
}
function pagarePDF(cli, venta, veh, cfg) {
  const emp = cfg.empresa || {}; const m = venta.moneda;
  const unidad = m === "USD" ? "dólares americanos" : "guaraníes";
  const simb = (x) => m === "USD" ? "US$ " + new Intl.NumberFormat("en-US").format(Math.round(x)) : "Gs. " + nf.format(Math.round(x));
  const cuotas = venta.plan.filter((c) => !c.pagado).length ? venta.plan.filter((c) => !c.pagado) : venta.plan;
  const gar = venta.garante;
  const pagares = cuotas.map((c) => `<div class="pg">
    <div class="hd"><div class="ttl">PAGARÉ</div><div class="num">N° ${venta.id.toUpperCase()}-${c.n}</div></div>
    <div class="monto">${simb(c.monto)}</div>
    <div class="lugarfecha">${emp.ciudad || "Ciudad del Este"}, ______ de ____________ de 20____</div>
    <p>Por el presente <b>PAGARÉ</b> a la vista / con vencimiento el día <b>${c.venc}</b>, me(nos) obligo(amos) a pagar incondicional y solidariamente a la orden de <b>${emp.nombre || "________________"}</b>, la cantidad de <b>${simb(c.monto)}</b> (<i>${enLetras(c.monto)} ${unidad}</i>), correspondiente a la cuota ${c.n} de ${venta.plan.length} por la compra del vehículo ${veh.marca || ""} ${veh.modelo || ""} ${veh.anio || ""} (chasis ${veh.vin || "—"}).</p>
    <p>El presente documento devengará, en caso de mora, un interés del ${cfg.tasaMora}% mensual. Sin protesto.</p>
    <div class="firmas"><div class="fb"><div class="fi">${cli.firma ? `<img src="${cli.firma}"/>` : ""}</div><div class="fl">Deudor: ${cli.nombre}<br>C.I. ${cli.ci || "—"}</div></div>${gar ? `<div class="fb"><div class="fi"></div><div class="fl">Garante: ${gar.nombre}<br>C.I. ${gar.ci || "—"}</div></div>` : ""}</div>
  </div>`).join("");
  printHTML(`<html><head><meta charset="utf-8"><title>Pagarés</title>
  <style>@page{margin:1.5cm}body{font-family:'Times New Roman',Georgia,serif;color:#000;font-size:14px;max-width:720px;margin:0 auto;padding:0}
  .pg{border:2px solid #111;border-radius:6px;padding:20px 24px;margin-bottom:22px;page-break-inside:avoid;position:relative}
  .hd{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #999;padding-bottom:6px}
  .ttl{font-weight:800;font-size:18px;letter-spacing:2px}.num{font-size:12px;color:#444}
  .monto{font-size:22px;font-weight:800;color:#1a4d8f;margin:12px 0}
  .lugarfecha{text-align:right;margin-bottom:10px}p{line-height:1.6;margin:8px 0;text-align:justify}
  .firmas{display:flex;justify-content:space-between;gap:20px;margin-top:44px}.fb{width:46%;text-align:center}.fi{height:40px;display:flex;align-items:flex-end;justify-content:center}.fi img{max-height:40px;max-width:100%}.fl{border-top:1px solid #000;padding-top:5px;font-size:12px}</style></head>
  <body>${wmHTML(cfg)}${pagares}</body></html>`);
}

// ============================================================ PAPELERA
function Papelera({ db, setDb, setVeh }) {
  const items = (db.papelera || []);
  const tipoLbl = (t) => ({ vehiculo: "Vehículo", cliente: "Cliente", venta: "Venta" }[t] || t);
  const restaurar = (p) => {
    setDb((s) => {
      const next = { ...s, papelera: (s.papelera || []).filter((x) => x.id !== p.id) };
      if (p.tipo === "vehiculo") next.vehiculos = [p.data, ...s.vehiculos];
      if (p.tipo === "cliente") next.clientes = [p.data, ...s.clientes];
      if (p.tipo === "venta") next.ventas = [p.data, ...s.ventas];
      return next;
    });
    if (p.tipo === "venta") setVeh(p.data.vehiculoId, { estado: "Vendido", clienteId: p.data.clienteId });
  };
  const eliminar = (p) => { if (confirm("¿Eliminar definitivamente? No se podrá recuperar.")) setDb((s) => ({ ...s, papelera: (s.papelera || []).filter((x) => x.id !== p.id) })); };
  const vaciar = () => { if (confirm("¿Vaciar la papelera por completo? No se podrá recuperar nada.")) setDb((s) => ({ ...s, papelera: (s.papelera || []).filter((x) => x.tenantId !== AUDIT.tid) })); };
  return (
    <div>
      <Titulo icon="papelera" sub="Elementos eliminados (recuperables)">Papelera</Titulo>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <b style={{ marginRight: "auto" }}>Papelera ({items.length})</b>
        {items.length > 0 && <Btn kind="ghost" onClick={vaciar} style={{ color: C.bad, borderColor: C.bad }}>Vaciar papelera</Btn>}
      </div>
      <div style={{ fontSize: 12, color: C.dim, marginBottom: 12 }}>Los vehículos, clientes y ventas eliminados quedan acá. Podés restaurarlos o borrarlos definitivamente. (Restaurar una venta no repone sus cobros en Caja.)</div>
      {items.length === 0 && <Empty t="La papelera está vacía." />}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items.map((p) => (
          <div key={p.id} style={{ ...box, padding: 12, display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: C.panel2, color: C.dim }}>{tipoLbl(p.tipo)}</span>
            <div style={{ flex: 1 }}><div style={{ fontWeight: 600 }}>{p.nombre || "—"}</div><div style={{ fontSize: 12, color: C.dim }}>Eliminado el {p.fecha}</div></div>
            <Btn small kind="ok" onClick={() => restaurar(p)}>Restaurar</Btn>
            <Btn small kind="ghost" onClick={() => eliminar(p)} style={{ color: C.bad, borderColor: C.bad }}>Eliminar definitivo</Btn>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================ USO POR EMPRESA + LÍMITE
function UsoModal({ susc, db, onClose, onSetLimite }) {
  const [lim, setLim] = useState(susc.limiteAutos || "");
  const autos = db.vehiculos.filter((v) => v.tenantId === susc.id);
  const enStock = autos.filter((v) => v.estado !== "Vendido").length;
  const ventas = db.ventas.filter((v) => v.tenantId === susc.id).length;
  const clientes = db.clientes.filter((c) => c.tenantId === susc.id).length;
  const usuarios = db.usuarios.filter((u) => u.tenantId === susc.id).length;
  const limN = +lim || 0;
  const pct = limN ? Math.min(100, (enStock / limN) * 100) : 0;
  const barColor = pct >= 100 ? C.bad : pct >= 80 ? C.warn : C.ok;
  return (
    <Modal onClose={onClose} w={460}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}><b>Uso — {susc.nombre}</b><Btn small kind="ghost" onClick={onClose}>✕</Btn></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 10 }}>
        <Kpi t="Autos totales" v={autos.length} /><Kpi t="Autos en stock" v={enStock} /><Kpi t="Ventas" v={ventas} /><Kpi t="Clientes" v={clientes} /><Kpi t="Usuarios" v={usuarios} /><Kpi t="Plan" v={susc.plan} />
      </div>
      <SubT>Límite de autos del plan</SubT>
      <div style={{ display: "flex", gap: 10, alignItems: "end" }}>
        <Field label="Máximo de autos en stock (0 = ilimitado)"><input type="number" style={inp} value={lim} onChange={(e) => setLim(e.target.value)} placeholder="0" /></Field>
        <Btn kind="dev" onClick={() => onSetLimite(limN || null)}>Guardar límite</Btn>
      </div>
      {limN > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.dim, marginBottom: 4 }}><span>{enStock} de {limN} autos</span><span>{pct.toFixed(0)}%</span></div>
          <div style={{ height: 10, background: C.panel2, borderRadius: 6, overflow: "hidden" }}><div style={{ width: pct + "%", height: "100%", background: barColor }} /></div>
          {enStock >= limN && <div style={{ color: C.bad, fontSize: 12, marginTop: 6 }}>⚠ La empresa alcanzó su límite: no podrá cargar más autos hasta ampliar el plan.</div>}
        </div>
      )}
      <div style={{ fontSize: 12, color: C.dim, marginTop: 10 }}>El límite cuenta los autos NO vendidos (en stock). Al alcanzarlo, el sistema de la empresa bloquea la carga de nuevos vehículos.</div>
    </Modal>
  );
}
