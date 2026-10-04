/* Copycat · Impresiones y Copias — PWA que funciona sin internet
   Almacenamiento: IndexedDB (estado + respaldos internos). Todo el dinero se guarda en centavos (enteros)
   para evitar errores de redondeo: $12.50 => 1250. */

/* ---------- Utilidades ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const diaISO = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hoyISO = () => diaISO();
const sumarDias = (dia, n) => { const d = new Date(dia + 'T12:00'); d.setDate(d.getDate() + n); return diaISO(d); };
const mayus = s => s.charAt(0).toUpperCase() + s.slice(1);
const fechaLarga = dia => mayus(new Date(dia + 'T12:00').toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' }));
const fechaCorta = dia => new Date(dia + 'T12:00').toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
const hora = iso => new Date(iso).toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
const sinAcentos = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const suma = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

function dinero(c) {
  c = Math.round(c || 0);
  const n = Math.abs(c) / 100;
  return (c < 0 ? '-' : '') + '$' + n.toLocaleString('es-MX', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
}
// "12.5" / "12,50" / "$12" => centavos
function aCent(v) {
  const n = parseFloat(String(v ?? '').replace(',', '.').replace(/[^\d.]/g, ''));
  return isFinite(n) ? Math.round(n * 100) : 0;
}
const aPesos = c => (c ? String(Math.round(c) / 100) : '');
const entero = (v, min = 0) => Math.max(min, parseInt(v, 10) || 0);

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.innerHTML = msg;
  t.classList.add('ver');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('ver'), ms);
}

/* ---------- Base de datos (IndexedDB) ---------- */
const DB = {
  db: null,
  abrir() {
    return new Promise((ok, no) => {
      const r = indexedDB.open('copias-negocio', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('kv');
        r.result.createObjectStore('respaldos', { keyPath: 'id' });
      };
      r.onsuccess = () => { this.db = r.result; ok(); };
      r.onerror = () => no(r.error);
    });
  },
  tx(store, modo, fn) {
    return new Promise((ok, no) => {
      const t = this.db.transaction(store, modo);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => ok(req && req.result);
      t.onerror = () => no(t.error);
    });
  },
  get(k) { return this.tx('kv', 'readonly', s => s.get(k)); },
  set(k, v) { return this.tx('kv', 'readwrite', s => s.put(v, k)); },
  del(k) { return this.tx('kv', 'readwrite', s => s.delete(k)); },
  respaldos() { return this.tx('respaldos', 'readonly', s => s.getAll()); },
  guardarRespaldo(r) { return this.tx('respaldos', 'readwrite', s => s.put(r)); },
  borrarRespaldo(id) { return this.tx('respaldos', 'readwrite', s => s.delete(id)); },
};

/* ---------- Estado ---------- */
let S;

const nuevoEstado = () => ({
  config: {
    negocio: 'Copycat',
    horaCierre: '19:00',
    fondo: 0,            // dinero con el que se abre la caja
    limiteFiado: 20000,  // máximo que puede deber un cliente (0 = sin límite)
    pin: '',             // PIN de adulto (opcional)
    folio: 0,
    ultimoArchivo: '',   // último día en que se guardó un archivo de respaldo
    bienvenida: false,
  },
  productos: [],
  ventas: [],
  clientes: [],
  cierres: [],
  // Movimientos de los sobres: aporte (dinero que se invierte), compra, retiro y ajuste (sobrante/faltante de caja)
  dinero: [],
});

function migrar(d) {
  const base = nuevoEstado();
  d.config = { ...base.config, ...(d.config || {}) };
  if (['Mi Negocio de Copias', 'Impresiones y Copias'].includes(d.config.negocio)) d.config.negocio = 'Copycat';
  for (const k of ['productos', 'ventas', 'clientes', 'cierres', 'dinero']) if (!Array.isArray(d[k])) d[k] = [];
  for (const c of d.clientes) if (!Array.isArray(c.movs)) c.movs = [];
  return d;
}
const datosValidos = d => d && typeof d === 'object' && d.config && Array.isArray(d.productos) && Array.isArray(d.ventas) && Array.isArray(d.clientes);

function ejemplos() {
  const hojas = { id: uid(), nombre: 'Hoja blanca', emoji: '📄', tipo: 'producto', precio: 100, costo: 25, stock: 500, minimo: 100 };
  const p = (nombre, emoji, tipo, precio, costo, extra = {}) => ({ id: uid(), nombre, emoji, tipo, precio, costo, stock: 0, minimo: 0, ...extra });
  const conHoja = { insumoId: hojas.id, insumoCant: 1 };
  return [
    p('Copia blanco y negro', '📑', 'servicio', 100, 25, conHoja),
    p('Copia a color', '🎨', 'servicio', 500, 150, conHoja),
    p('Impresión blanco y negro', '🖨️', 'servicio', 200, 30, conHoja),
    p('Impresión a color', '🌈', 'servicio', 800, 200, conHoja),
    p('Escaneo', '📠', 'servicio', 500, 0),
    p('Engargolado', '📚', 'servicio', 2500, 1000),
    p('Enmicado', '🪪', 'servicio', 1500, 500),
    hojas,
    p('Lápiz', '✏️', 'producto', 700, 350, { stock: 24, minimo: 5 }),
    p('Pluma', '🖊️', 'producto', 800, 400, { stock: 24, minimo: 5 }),
    p('Folder', '📁', 'producto', 500, 250, { stock: 30, minimo: 5 }),
    p('Sobre manila', '✉️', 'producto', 600, 300, { stock: 20, minimo: 5 }),
    p('Cartulina', '🟧', 'producto', 1000, 500, { stock: 15, minimo: 3 }),
  ];
}

async function guardar() {
  await DB.set('estado', S);
}

const prod = id => S.productos.find(p => p.id === id);
const cliente = id => S.clientes.find(c => c.id === id);
// Lo que cuesta una unidad: su costo + lo que gasta del inventario (ej. la hoja de una copia)
function costoUnit(p) {
  const ins = p.insumoId && prod(p.insumoId);
  return (p.costo || 0) + (ins ? (ins.costo || 0) * (p.insumoCant || 1) : 0);
}
const deuda = c => suma(c.movs, m => (m.tipo === 'fiado' ? m.monto : -m.monto));
const pocas = p => p.tipo === 'producto' && p.stock <= (p.minimo || 0);

/* ---------- Navegación ---------- */
let vista = 'vender';
function ir(v) {
  vista = v;
  render();
  window.scrollTo(0, 0);
}
function render() {
  document.body.classList.toggle('vender-activa', vista === 'vender');
  $$('.nav button').forEach(b => b.classList.toggle('activo', b.dataset.vista === vista));
  $('#nombre-negocio').textContent = S.config.negocio;
  $('#fecha-hoy').textContent = fechaLarga(hoyISO());
  $('#vista').innerHTML = VISTAS[vista]();
  DESPUES[vista]?.();
  revisarHoraCierre();
}

/* ---------- Modales ---------- */
let modalId = 0;
const cab = t => `<div class="modal-cab"><h2>${t}</h2><button type="button" class="cerrar" data-action="cerrar-modal" aria-label="Cerrar">✕</button></div>`;

function abrirModal(html, alEnviar) {
  const m = $('#modal');
  const id = ++modalId;
  m.innerHTML = `<div class="caja" role="dialog" aria-modal="true">${html}</div>`;
  m.hidden = false;
  const f = m.querySelector('form');
  if (f && alEnviar) {
    f.onsubmit = async e => {
      e.preventDefault();
      const r = await alEnviar(Object.fromEntries(new FormData(f)), f);
      // Solo cierra si el manejador no abrió otro modal
      if (r !== false && modalId === id) cerrarModal();
    };
  }
  const primero = m.querySelector('[autofocus]');
  if (primero) setTimeout(() => primero.focus(), 60);
  return m.querySelector('.caja');
}
function cerrarModal() {
  modalId++;
  $('#modal').hidden = true;
  $('#modal').innerHTML = '';
}
function confirmar(titulo, html, siFn, { boton = 'Sí, continuar', clase = 'rojo' } = {}) {
  abrirModal(`${cab(titulo)}<p>${html}</p>
    <div class="botones"><button type="button" class="btn gris" data-action="cerrar-modal">No</button>
    <button type="button" class="btn ${clase}" id="btn-si">${boton}</button></div>`);
  $('#btn-si').onclick = () => { cerrarModal(); siFn(); };
}
// Acciones que un adulto debe autorizar (si configuró un PIN)
function conPin(motivo, fn) {
  if (!S.config.pin) return fn();
  abrirModal(`${cab('🔒 Pide permiso')}
    <p>${motivo}: esto necesita el <b>PIN de un adulto</b>.</p>
    <form><label class="campo">PIN<input type="password" inputmode="numeric" name="pin" autocomplete="off" required autofocus></label>
    <button class="btn grande">Continuar</button></form>`, d => {
    if (d.pin !== S.config.pin) { toast('❌ PIN incorrecto'); return false; }
    setTimeout(fn);
  });
}

/* =========================================================
   VENDER
   ========================================================= */
let carrito = [];
let filtroVenta = { texto: '', tipo: 'todos' };
let carritoAbierto = false;
const totalCarrito = () => suma(carrito, i => i.precio * i.cant);

function vVender() {
  const chips = [['todos', 'Todo'], ['servicio', '🖨️ Servicios'], ['producto', '✏️ Productos']];
  return `<div class="vender">
    <section>
      <div class="buscador"><input type="search" id="buscar" placeholder="🔎 Buscar…" value="${esc(filtroVenta.texto)}" autocomplete="off"></div>
      <div class="chips">${chips.map(([k, t]) => `<button class="chip ${filtroVenta.tipo === k ? 'activo' : ''}" data-action="filtro-venta" data-tipo="${k}">${t}</button>`).join('')}</div>
      <div class="productos" id="productos">${tilesHTML()}</div>
    </section>
    <aside class="carrito ${carritoAbierto ? 'abierto' : ''}" id="carrito">${carritoHTML()}</aside>
  </div>`;
}

function tilesHTML() {
  if (!S.productos.length) {
    return `<div class="vacio" style="grid-column:1/-1"><span class="grande">📦</span>Aún no tienes productos.<br><br>
      <button class="btn" data-action="ir" data-vista="inventario">Ir a Inventario</button></div>`;
  }
  const t = sinAcentos(filtroVenta.texto.trim());
  const lista = S.productos
    .filter(p => filtroVenta.tipo === 'todos' || p.tipo === filtroVenta.tipo)
    .filter(p => !t || sinAcentos(p.nombre).includes(t))
    .sort((a, b) => (a.tipo === b.tipo ? a.nombre.localeCompare(b.nombre) : a.tipo === 'servicio' ? -1 : 1));
  const libre = `<button class="prod libre" data-action="cobro-libre"><span class="em">✍️</span><span class="nom">Otro cobro</span><span class="muted small">escribe el precio</span></button>`;
  return libre + lista.map(p => {
    const enCarrito = carrito.find(i => i.pid === p.id)?.cant || 0;
    const agotado = p.tipo === 'producto' && p.stock <= 0;
    return `<button class="prod ${agotado ? 'agotado' : ''}" data-action="agregar" data-id="${p.id}">
      ${enCarrito ? `<span class="cnt">${enCarrito}</span>` : ''}
      ${p.tipo === 'producto' ? `<span class="stk badge ${pocas(p) ? 'rojo' : ''}">${p.stock}</span>` : ''}
      <span class="em">${p.emoji}</span><span class="nom">${esc(p.nombre)}</span><span class="pre">${dinero(p.precio)}</span></button>`;
  }).join('') + (lista.length ? '' : `<div class="vacio" style="grid-column:1/-1">No encontré "${esc(filtroVenta.texto)}"</div>`);
}

function carritoHTML() {
  const n = suma(carrito, i => i.cant);
  const vacio = !carrito.length;
  return `<div class="carrito-cab">
      <div><div class="total-chico">${vacio ? '🛒 Carrito vacío' : `🛒 ${n} ${n === 1 ? 'cosa' : 'cosas'}`}</div>
      <div class="total num">${dinero(totalCarrito())}</div></div>
      <div class="fila">${vacio ? '' : `
        <button class="btn chico gris toggle-carrito" data-action="toggle-carrito">${carritoAbierto ? '▼ Ocultar' : '▲ Ver'}</button>
        <button class="btn chico gris" data-action="vaciar" aria-label="Vaciar carrito">🗑️</button>`}</div>
    </div>
    ${vacio ? `<div class="carrito-vacio">Toca un producto para agregarlo. ¿Muchas copias? Toca una vez y escribe la cantidad aquí.</div>`
      : `<ul class="lista carrito-items">${carrito.map((it, i) => `<li>
        <span class="em">${it.emoji}</span>
        <div class="info"><b>${esc(it.nombre)}</b><span class="muted small">${dinero(it.precio)} c/u = <b style="display:inline">${dinero(it.precio * it.cant)}</b></span></div>
        <div class="cant"><button data-action="menos" data-i="${i}" aria-label="Menos">−</button>
        <input type="number" inputmode="numeric" min="1" value="${it.cant}" data-i="${i}" class="in-cant" aria-label="Cantidad">
        <button data-action="mas" data-i="${i}" aria-label="Más">+</button></div></li>`).join('')}</ul>`}
    <div class="carrito-acc">
      <button class="btn verde grande" data-action="cobrar" ${vacio ? 'disabled' : ''}>💵 Cobrar</button>
      <button class="btn naranja grande" data-action="fiar" ${vacio ? 'disabled' : ''}>📒 Fiado</button>
    </div>`;
}

function pintarVenta() {
  const c = $('#carrito');
  if (!c) return;
  c.innerHTML = carritoHTML();
  c.classList.toggle('abierto', carritoAbierto);
  $('#productos').innerHTML = tilesHTML();
}

// Revisa que haya suficientes piezas en inventario
function hayExistencia(p, cant) {
  if (p.tipo !== 'producto' || cant <= p.stock) return true;
  toast(p.stock <= 0
    ? `😕 Ya no hay "${esc(p.nombre)}". Si llegaron más, súmalos en 📦 Inventario.`
    : `😕 Solo hay ${p.stock} de "${esc(p.nombre)}". Si tienes más, actualiza el inventario.`, 3800);
  return false;
}

function agregar(id) {
  const p = prod(id);
  if (!p) return;
  const it = carrito.find(i => i.pid === id);
  if (!hayExistencia(p, (it?.cant || 0) + 1)) return;
  if (it) it.cant++;
  else carrito.push({ pid: id, nombre: p.nombre, emoji: p.emoji, precio: p.precio, cant: 1 });
  navigator.vibrate?.(15);
  pintarVenta();
  const tile = $(`.prod[data-id="${id}"]`);
  tile?.classList.add('pulso');
}

function cambiarCant(i, cant) {
  const it = carrito[i];
  if (!it) return;
  if (cant <= 0) carrito.splice(i, 1);
  else {
    const p = it.pid && prod(it.pid);
    if (p && !hayExistencia(p, cant)) cant = Math.max(1, p.stock);
    it.cant = cant;
  }
  if (!carrito.length) carritoAbierto = false;
  pintarVenta();
}

function cobroLibre() {
  abrirModal(`${cab('✍️ Otro cobro')}
    <p class="muted small">Para algo que no está en la lista (ej. "impresión de tarea especial").</p>
    <form>
      <label class="campo">¿Qué es?<input type="text" name="nombre" required maxlength="60" placeholder="Ej. Tarjetas de presentación" autofocus></label>
      <label class="campo">¿Cuánto cuesta?<div class="dinero"><input type="text" inputmode="decimal" name="precio" required placeholder="0"></div></label>
      <button class="btn grande">Agregar al carrito</button>
    </form>`, d => {
    const precio = aCent(d.precio);
    if (precio <= 0) { toast('Escribe un precio mayor a $0'); return false; }
    carrito.push({ pid: null, nombre: d.nombre.trim(), emoji: '✍️', precio, cant: 1 });
    pintarVenta();
  });
}

/* ---------- Cobrar y dar cambio ---------- */
const DENOMINACIONES = [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50];
function desglose(c) {
  const out = [];
  for (const d of DENOMINACIONES) {
    const n = Math.floor(c / d);
    if (n) { out.push(`${n} × ${d >= 2000 ? '💵' : '🪙'} ${dinero(d)}`); c -= n * d; }
  }
  return out;
}

// Caja de "¿con cuánto te pagó?" + cambio. Se usa al cobrar y al recibir abonos.
function htmlPago() {
  return `<label class="campo">¿Con cuánto te pagó?
      <span class="ayuda">Escríbelo o toca los billetes que te dio (se van sumando).</span>
      <div class="dinero"><input type="text" inputmode="decimal" id="recibido" autocomplete="off" placeholder="0"></div></label>
    <div class="billetes">${[1000, 2000, 5000, 10000, 20000, 50000].map(b => `<button type="button" data-b="${b}">${dinero(b)}</button>`).join('')}
      <button type="button" class="exacto" data-b="exacto">Exacto</button><button type="button" data-b="borrar">↺ Borrar</button></div>
    <div id="cambio"></div>`;
}
function activarPago(caja, total, alCambiar, enfocar = true) {
  const inp = $('#recibido', caja);
  const pintar = () => {
    const rec = aCent(inp.value);
    const dif = rec - total;
    const div = $('#cambio', caja);
    let ok = false;
    if (!inp.value.trim()) div.innerHTML = `<div class="cambio nada"><div class="et">Escribe con cuánto te pagó</div></div>`;
    else if (dif < 0) div.innerHTML = `<div class="cambio falta"><div class="et">⚠️ Te faltan</div><div class="val num">${dinero(-dif)}</div><div class="small">Pídele lo que falta</div></div>`;
    else if (dif === 0) { ok = true; div.innerHTML = `<div class="cambio ok"><div class="et">Pagó exacto 👍</div><div class="val">Sin cambio</div></div>`; }
    else {
      ok = true;
      div.innerHTML = `<div class="cambio ok"><div class="et">Dale de cambio</div><div class="val num">${dinero(dif)}</div>
        <div class="desglose">${desglose(dif).map(x => `<span>${x}</span>`).join('')}</div>
        ${dif > 50000 ? '<div class="small" style="margin-top:8px">🧐 Es mucho cambio, revisa que el número esté bien</div>' : ''}</div>`;
    }
    alCambiar(ok, rec, Math.max(0, dif));
  };
  inp.addEventListener('input', pintar);
  $$('.billetes button', caja).forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.b;
    if (v === 'borrar') inp.value = '';
    else if (v === 'exacto') inp.value = aPesos(total) || '0';
    else inp.value = aPesos(aCent(inp.value) + Number(v));
    pintar();
  }));
  pintar();
  if (enfocar) setTimeout(() => inp.focus(), 80);
}

function modalCobrar() {
  if (!carrito.length) return;
  const total = totalCarrito();
  const caja = abrirModal(`${cab('💵 Cobrar')}
    <div class="gran-total"><div class="et">Total a cobrar</div><div class="val num">${dinero(total)}</div></div>
    ${htmlPago()}
    <button type="button" class="btn verde grande" id="btn-listo" disabled>✅ Ya cobré, registrar venta</button>`);
  let datos = null;
  activarPago(caja, total, (ok, recibido, cambio) => {
    $('#btn-listo').disabled = !ok;
    datos = ok ? { recibido, cambio } : null;
  });
  $('#btn-listo').onclick = async () => {
    if (!datos) return;
    const v = await registrarVenta('efectivo', datos);
    ventaLista(v);
  };
}

function ventaLista(v) {
  const caja = abrirModal(`<div class="centro">
    <div style="font-size:3.5rem">✅</div>
    <h2>¡Venta registrada!</h2>
    <p class="muted">Venta #${v.folio} · ${dinero(v.total)}${v.pago === 'fiado' ? ` · fiado a <b>${esc(cliente(v.clienteId)?.nombre)}</b>` : ''}</p>
    ${v.pago === 'efectivo' ? (v.cambio
      ? `<div class="cambio ok"><div class="et">Recuerda dar de cambio</div><div class="val num">${dinero(v.cambio)}</div></div>`
      : `<div class="cambio ok"><div class="et">Pagó exacto, no hay cambio</div></div>`) : ''}
    <div id="alerta-stock"></div>
    <button type="button" class="btn grande" data-action="cerrar-modal" autofocus>👉 Siguiente cliente</button></div>`);
  const bajos = [...new Set(v.items.flatMap(it => {
    const p = it.pid && prod(it.pid);
    return p ? [p, p.insumoId && prod(p.insumoId)] : [];
  }))].filter(p => p && pocas(p));
  if (bajos.length) {
    $('#alerta-stock', caja).innerHTML = `<div class="tip warn"><span class="ic">⚠️</span><div>Se está acabando: ${bajos.map(p => `<b>${esc(p.nombre)}</b> (quedan ${p.stock})`).join(', ')}. Avisa para comprar más.</div></div>`;
  }
}

// Suma (+1) o resta (-1) del inventario lo de una venta, incluyendo lo que gastan los servicios
function moverStock(items, signo) {
  for (const it of items) {
    const p = it.pid && prod(it.pid);
    if (!p) continue;
    if (p.tipo === 'producto') p.stock = Math.max(0, p.stock + signo * it.cant);
    const ins = p.insumoId && prod(p.insumoId);
    if (ins && ins.tipo === 'producto') ins.stock = Math.max(0, ins.stock + signo * it.cant * (p.insumoCant || 1));
  }
}

async function registrarVenta(pago, { recibido = 0, cambio = 0, clienteId = null } = {}) {
  const ahora = new Date();
  S.config.folio++;
  const items = carrito.map(it => {
    const p = it.pid && prod(it.pid);
    return { ...it, costo: p ? costoUnit(p) : 0 };
  });
  const v = {
    id: uid(), folio: S.config.folio, fecha: ahora.toISOString(), dia: diaISO(ahora),
    items, total: suma(items, i => i.precio * i.cant), pago, recibido, cambio, clienteId,
  };
  moverStock(items, -1);
  if (pago === 'fiado') {
    cliente(clienteId).movs.push({
      id: uid(), tipo: 'fiado', monto: v.total, fecha: v.fecha, dia: v.dia, ventaId: v.id,
      detalle: items.map(i => `${i.cant} ${i.nombre}`).join(', '),
    });
  }
  S.ventas.push(v);
  carrito = [];
  carritoAbierto = false;
  await guardar();
  pintarVenta();
  return v;
}

/* ---------- Fiado desde la venta ---------- */
function modalFiar() {
  if (!carrito.length) return;
  const total = totalCarrito();
  const clientes = [...S.clientes].sort((a, b) => a.nombre.localeCompare(b.nombre));
  const caja = abrirModal(`${cab('📒 Fiar esta venta')}
    <div class="gran-total"><div class="et">Va a quedar debiendo</div><div class="val num">${dinero(total)}</div></div>
    <form>
      ${clientes.length > 5 ? '<input type="search" id="buscar-cli" placeholder="🔎 Buscar cliente…" autocomplete="off">' : ''}
      <div class="opciones" id="lista-cli">
        ${clientes.map(c => `<label data-nombre="${esc(sinAcentos(c.nombre))}"><input type="radio" name="cli" value="${c.id}" required>
          <span style="flex:1">${esc(c.nombre)}</span>${deuda(c) > 0 ? `<span class="badge rojo">debe ${dinero(deuda(c))}</span>` : '<span class="badge verde">sin deuda</span>'}</label>`).join('')}
        <label><input type="radio" name="cli" value="nuevo" ${clientes.length ? '' : 'checked'} required><span>➕ Cliente nuevo</span></label>
      </div>
      <div id="cli-nuevo" ${clientes.length ? 'hidden' : ''} style="margin-top:12px">
        <label class="campo">Nombre del cliente<input type="text" name="nombre" maxlength="50" placeholder="Ej. Doña Lupe"></label>
        <label class="campo">Teléfono (opcional)<input type="tel" name="tel" maxlength="15" placeholder="10 dígitos"></label>
      </div>
      <div class="tip info" style="margin-top:12px"><span class="ic">💡</span><div>Solo fía a personas de confianza y anota bien el nombre.</div></div>
      <button class="btn naranja grande">📒 Registrar fiado</button>
    </form>`, d => {
    let c;
    if (d.cli === 'nuevo') {
      const nombre = (d.nombre || '').trim();
      if (!nombre) { toast('Escribe el nombre del cliente'); return false; }
      c = { id: uid(), nombre, tel: (d.tel || '').trim(), movs: [] };
    } else c = cliente(d.cli);
    if (!c) return false;
    const limite = S.config.limiteFiado;
    const fiar = async () => {
      if (!S.clientes.includes(c)) S.clientes.push(c);
      const v = await registrarVenta('fiado', { clienteId: c.id });
      ventaLista(v);
    };
    if (limite && deuda(c) + total > limite) {
      setTimeout(() => confirmar('⚠️ Ya debe mucho',
        `<b>${esc(c.nombre)}</b> ya debe ${dinero(deuda(c))}. Con esta venta debería <b>${dinero(deuda(c) + total)}</b>, más que el límite de ${dinero(limite)}.<br><br>¿Fiarle de todos modos?`,
        () => conPin('Fiar más del límite', fiar), { boton: 'Sí, fiarle', clase: 'naranja' }));
      return;
    }
    return fiar().then(() => false);
  });
  $$('input[name=cli]', caja).forEach(r => r.addEventListener('change', () => {
    $('#cli-nuevo', caja).hidden = r.value !== 'nuevo' || !r.checked;
    if (r.value === 'nuevo' && r.checked) $('[name=nombre]', caja).focus();
  }));
  $('#buscar-cli', caja)?.addEventListener('input', e => {
    const t = sinAcentos(e.target.value);
    $$('#lista-cli label[data-nombre]', caja).forEach(l => { l.hidden = !l.dataset.nombre.includes(t); });
  });
}

/* =========================================================
   INVENTARIO
   ========================================================= */
let filtroInv = 'todos';
const EMOJIS = ['📑', '📄', '🖨️', '🎨', '🌈', '📠', '📚', '🪪', '✏️', '🖊️', '🖍️', '📁', '✉️', '🟧', '📒', '📓', '📏', '📐', '✂️', '📎', '🧴', '🗂️', '🔖', '🎁', '🍬', '🥤', '📸', '🧾', '💾', '🎀', '🧸', '⭐'];

function vInventario() {
  const prods = S.productos;
  const bajos = prods.filter(pocas);
  const conStock = prods.filter(p => p.tipo === 'producto');
  const valorCosto = suma(conStock, p => p.stock * p.costo);
  const valorVenta = suma(conStock, p => p.stock * p.precio);
  const chips = [['todos', 'Todo'], ['servicio', '🖨️ Servicios'], ['producto', '✏️ Productos'], ['bajos', `⚠️ Se acaban (${bajos.length})`]];
  const lista = prods
    .filter(p => filtroInv === 'todos' || (filtroInv === 'bajos' ? pocas(p) : p.tipo === filtroInv))
    .sort((a, b) => (a.tipo === b.tipo ? a.nombre.localeCompare(b.nombre) : a.tipo === 'servicio' ? -1 : 1));
  return `
    <div class="fila" style="justify-content:space-between;margin-bottom:12px">
      <h2 style="margin:0">📦 Inventario</h2>
      <button class="btn" data-action="nuevo-producto">➕ Nuevo</button>
    </div>
    ${bajos.length ? `<div class="tip warn"><span class="ic">⚠️</span><div><b>Se están acabando:</b> ${bajos.map(p => `${esc(p.nombre)} (${p.stock})`).join(', ')}</div></div>` : ''}
    ${conStock.length ? `<div class="cuadros">
      <div class="cuadro"><div class="et">Tu mercancía te costó</div><div class="val num">${dinero(valorCosto)}</div></div>
      <div class="cuadro verde"><div class="et">Si vendes todo recibes</div><div class="val num">${dinero(valorVenta)}</div></div>
    </div>` : ''}
    ${paquetePendiente().length && !S.config.ocultarPaquete ? `<div class="tarjeta" style="border:2px dashed var(--rosa)">
      <h3>🖨️ Lista de precios de impresión</h3>
      <p class="small muted">${paquetePendiente().length} servicios en tamaño carta y oficio, listos para agregar: texto B/N, documento a color, imágenes y fotos.</p>
      <div class="fila"><button class="btn crece" data-action="ver-paquete">Ver y agregar</button>
      <button class="btn gris" data-action="ocultar-paquete">No, gracias</button></div></div>` : ''}
    <div class="chips">${chips.map(([k, t]) => `<button class="chip ${filtroInv === k ? 'activo' : ''}" data-action="filtro-inv" data-tipo="${k}">${t}</button>`).join('')}</div>
    <div class="tarjeta">
      ${lista.length ? `<ul class="lista">${lista.map(p => {
        const cu = costoUnit(p);
        const gan = p.precio - cu;
        return `<li>
          <span class="em">${p.emoji}</span>
          <div class="info"><b>${esc(p.nombre)}</b>
            <span class="small muted">Vendes a <b style="display:inline;color:var(--texto)">${dinero(p.precio)}</b> · te cuesta ${dinero(cu)}</span><br>
            ${gan > 0 ? `<span class="badge verde">ganas ${dinero(gan)}</span>` : `<span class="badge rojo">⚠️ ${gan === 0 ? 'no ganas nada' : 'pierdes ' + dinero(-gan)}</span>`}
            ${p.tipo === 'producto' ? `<span class="badge ${pocas(p) ? 'rojo' : 'azul'}">hay ${p.stock}</span>` : '<span class="badge">servicio</span>'}
          </div>
          <div class="der fila" style="gap:4px">
            ${p.tipo === 'producto' ? `<button class="btn chico sec" data-action="resurtir" data-id="${p.id}" title="Llegó mercancía">📥</button>` : ''}
            <button class="btn chico gris" data-action="editar-producto" data-id="${p.id}" aria-label="Editar">✏️</button>
          </div></li>`;
      }).join('')}</ul>` : `<div class="vacio"><span class="grande">📭</span>${prods.length ? 'Nada en esta lista' : 'Aún no hay productos. Toca ➕ Nuevo.'}</div>`}
    </div>
    <p class="muted small">📥 = llegó mercancía (suma piezas). ✏️ = cambiar nombre, precio o existencias.</p>
    ${paquetePendiente().length && S.config.ocultarPaquete ? '<button class="link-btn small" data-action="ver-paquete" style="color:var(--azul)">🖨️ Ver lista de precios de impresión</button>' : ''}`;
}

// Lista de precios de impresión de Copycat. El costo ya incluye hoja y tinta.
const PAQUETE_IMPRESION = [
  ['Texto B/N', '🖨️', 32, 150, 37, 200],
  ['Documento a color', '🌈', 40, 300, 47, 400],
  ['Imagen B/N media hoja', '📸', 85, 300, 100, 400],
  ['Hoja negra o imagen B/N grande', '🧾', 141, 500, 170, 600],
  ['Foto a color hoja completa', '🎨', 141, 800, 170, 1000],
].flatMap(([nombre, emoji, cCarta, pCarta, cOficio, pOficio]) => [
  { nombre: `${nombre} (carta)`, emoji, costo: cCarta, precio: pCarta },
  { nombre: `${nombre} (oficio)`, emoji, costo: cOficio, precio: pOficio },
]);
const paquetePendiente = () => PAQUETE_IMPRESION.filter(x => !S.productos.some(p => sinAcentos(p.nombre) === sinAcentos(x.nombre)));

function modalPaquete() {
  const pendientes = paquetePendiente();
  const caja = abrirModal(`${cab('🖨️ Lista de precios de impresión')}
    <p class="small muted">Quita la palomita de los que no quieras. Después puedes cambiar cualquier precio en ✏️.</p>
    <form>
      <ul class="lista">${PAQUETE_IMPRESION.map((x, i) => {
        const ya = !pendientes.includes(x);
        return `<li><label style="display:flex;align-items:center;gap:10px;flex:1;cursor:pointer">
          <input type="checkbox" name="p${i}" ${ya ? 'disabled' : 'checked'} style="width:22px;height:22px">
          <span class="em">${x.emoji}</span>
          <span class="info"><b>${esc(x.nombre)}</b><span class="small muted">${ya ? 'Ya lo tienes' : `te cuesta ${dinero(x.costo)} · ganas ${dinero(x.precio - x.costo)}`}</span></span>
          <b class="num">${dinero(x.precio)}</b></label></li>`;
      }).join('')}</ul>
      <div class="tip info"><span class="ic">💡</span><div>El costo ya incluye la hoja y la tinta, así que estas impresiones no descuentan hojas del inventario.</div></div>
      <button class="btn grande" id="btn-paquete">➕ Agregar ${pendientes.length} servicios</button>
    </form>`, d => {
    const elegidos = PAQUETE_IMPRESION.filter((x, i) => d['p' + i] && pendientes.includes(x));
    if (!elegidos.length) { toast('Elige al menos uno'); return false; }
    setTimeout(() => conPin('Agregar productos', () => {
      for (const x of elegidos) S.productos.push({ id: uid(), ...x, tipo: 'servicio', stock: 0, minimo: 0, insumoId: null, insumoCant: 1 });
      guardar();
      render();
      toast(`✅ Se agregaron ${elegidos.length} servicios de impresión`);
    }));
  });
  const actualizar = () => {
    const n = $$('input[type=checkbox]:checked:not(:disabled)', caja).length;
    $('#btn-paquete', caja).textContent = `➕ Agregar ${n} ${n === 1 ? 'servicio' : 'servicios'}`;
  };
  $('form', caja).addEventListener('change', actualizar);
}

function formProducto(p, pre = {}) {
  const nuevo = !p;
  p = p || { id: null, nombre: '', emoji: '📄', tipo: 'producto', precio: 0, costo: 0, stock: 0, minimo: 5, ...pre };
  const insumos = S.productos.filter(x => x.tipo === 'producto' && x.id !== p.id);
  const caja = abrirModal(`${cab(nuevo ? '➕ Nuevo producto' : '✏️ Editar producto')}
    <form>
      <label class="campo">Nombre<input type="text" name="nombre" required maxlength="40" value="${esc(p.nombre)}" placeholder="Ej. Copia a color" ${nuevo ? 'autofocus' : ''}></label>
      <div class="campo">Dibujito
        <div class="emojis">${EMOJIS.map(e => `<label><input type="radio" name="emoji" value="${e}" ${e === p.emoji ? 'checked' : ''}><span>${e}</span></label>`).join('')}</div>
      </div>
      <div class="campo">¿Qué es?
        <div class="opciones">
          <label><input type="radio" name="tipo" value="servicio" ${p.tipo === 'servicio' ? 'checked' : ''}> 🖨️ Un servicio (copias, impresiones, enmicado…)</label>
          <label><input type="radio" name="tipo" value="producto" ${p.tipo === 'producto' ? 'checked' : ''}> ✏️ Un producto que se acaba (lápices, folders…)</label>
        </div>
      </div>
      <label class="campo">¿A cuánto lo vendes?<div class="dinero"><input type="text" inputmode="decimal" name="precio" required value="${aPesos(p.precio)}" placeholder="0"></div></label>
      <label class="campo"><span data-solo="producto">¿Cuánto te costó cada uno?</span><span data-solo="servicio">¿Cuánto gastas en cada uno? (tinta, luz, material)</span>
        <span class="ayuda">¿No sabes? Usa la 🧮 calculadora de precios.</span>
        <div class="dinero"><input type="text" inputmode="decimal" name="costo" value="${aPesos(p.costo)}" placeholder="0"></div></label>
      <div data-solo="producto">
        <div class="fila">
          <label class="campo crece">¿Cuántos tienes?<input type="number" inputmode="numeric" name="stock" min="0" value="${p.stock || 0}"></label>
          <label class="campo crece">Avisarme cuando queden<input type="number" inputmode="numeric" name="minimo" min="0" value="${p.minimo || 0}"></label>
        </div>
      </div>
      <div data-solo="servicio">
        <label class="campo">¿Gasta algo del inventario?
          <span class="ayuda">Ej. cada copia gasta 1 hoja blanca: así se descuentan solas.</span>
          <select name="insumoId"><option value="">No, nada</option>
            ${insumos.map(x => `<option value="${x.id}" ${x.id === p.insumoId ? 'selected' : ''}>${x.emoji} ${esc(x.nombre)}</option>`).join('')}</select></label>
        <label class="campo" id="campo-insumo">¿Cuántas piezas gasta cada uno?<input type="number" inputmode="numeric" name="insumoCant" min="1" value="${p.insumoCant || 1}"></label>
      </div>
      <div id="vista-ganancia"></div>
      <button class="btn grande">💾 Guardar</button>
      ${nuevo ? '' : '<button type="button" class="btn rojo grande" id="btn-borrar" style="margin-top:10px">🗑️ Borrar producto</button>'}
    </form>`, d => {
    const precio = aCent(d.precio);
    if (precio <= 0) { toast('El precio debe ser mayor a $0'); return false; }
    const datos = {
      nombre: d.nombre.trim(), emoji: d.emoji || '📄', tipo: d.tipo, precio, costo: aCent(d.costo),
      stock: d.tipo === 'producto' ? entero(d.stock) : 0,
      minimo: d.tipo === 'producto' ? entero(d.minimo) : 0,
      insumoId: d.tipo === 'servicio' && d.insumoId ? d.insumoId : null,
      insumoCant: entero(d.insumoCant, 1),
    };
    if (nuevo) S.productos.push({ id: uid(), ...datos });
    else Object.assign(prod(p.id), datos);
    guardar();
    render();
    toast(nuevo ? '✅ Producto agregado' : '✅ Cambios guardados');
  });

  const f = $('form', caja);
  const actualizar = () => {
    const tipo = f.tipo.value;
    $$('[data-solo]', caja).forEach(el => { el.hidden = el.dataset.solo !== tipo; });
    $('#campo-insumo', caja).hidden = tipo !== 'servicio' || !f.insumoId.value;
    const ins = tipo === 'servicio' && f.insumoId.value && prod(f.insumoId.value);
    const costo = aCent(f.costo.value) + (ins ? ins.costo * entero(f.insumoCant.value, 1) : 0);
    const precio = aCent(f.precio.value);
    const gan = precio - costo;
    $('#vista-ganancia', caja).innerHTML = precio
      ? `<div class="tip ${gan > 0 ? 'ok' : 'mal'}"><span class="ic">${gan > 0 ? '🤑' : '⚠️'}</span><div>
          ${ins ? `Costo total: ${dinero(costo)} (incluye ${esc(ins.nombre)}).<br>` : ''}
          ${gan > 0 ? `Ganas <b>${dinero(gan)}</b> en cada uno${costo ? ` (${Math.round(gan / costo * 100)}% sobre lo que te cuesta)` : ''}.`
            : 'Con ese precio <b>pierdes dinero</b>. Súbele o revisa el costo.'}</div></div>`
      : '';
  };
  f.addEventListener('input', actualizar);
  f.addEventListener('change', actualizar);
  actualizar();

  $('#btn-borrar', caja)?.addEventListener('click', () => {
    confirmar('🗑️ Borrar producto', `¿Seguro que quieres borrar <b>${esc(p.nombre)}</b>? Las ventas que ya hiciste no se borran.`, () => {
      S.productos = S.productos.filter(x => x.id !== p.id);
      for (const x of S.productos) if (x.insumoId === p.id) x.insumoId = null;
      guardar();
      render();
      toast('Producto borrado');
    }, { boton: 'Sí, borrar' });
  });
}

function modalResurtir(p) {
  const caja = abrirModal(`${cab(`📥 Llegó ${esc(p.nombre)}`)}
    <p class="muted">Ahora tienes <b>${p.stock}</b>.</p>
    <form>
      <label class="campo">¿Cuántas piezas llegaron?<input type="number" inputmode="numeric" name="cant" min="1" required autofocus></label>
      <label class="campo">¿Cuánto pagaste por todas? (opcional)
        <span class="ayuda">Si lo escribes, se actualiza cuánto te cuesta cada una.</span>
        <div class="dinero"><input type="text" inputmode="decimal" name="pagado" placeholder="0"></div></label>
      <div id="info-resurtir"></div>
      <div id="origen-resurtir" hidden>${campoOrigen()}</div>
      <button class="btn verde grande">✅ Sumar al inventario</button>
    </form>`, d => {
    const cant = entero(d.cant);
    if (cant <= 0) { toast('Escribe cuántas piezas llegaron'); return false; }
    const pagado = aCent(d.pagado);
    p.stock += cant;
    if (pagado > 0) {
      p.costo = Math.round(pagado / cant);
      registrarCompra(`${cant} ${p.nombre}`, pagado, d.origen);
    }
    guardar();
    render();
    toast(`✅ Ahora tienes ${p.stock} de ${esc(p.nombre)}`);
  });
  const f = $('form', caja);
  f.addEventListener('input', () => {
    const cant = entero(f.cant.value);
    const pagado = aCent(f.pagado.value);
    const info = $('#info-resurtir', caja);
    $('#origen-resurtir', caja).hidden = !pagado;
    if (!cant || !pagado) { info.innerHTML = ''; return; }
    const cu = pagado / cant;
    const gan = p.precio - cu;
    info.innerHTML = `<div class="tip ${gan > 0 ? 'ok' : 'mal'}"><span class="ic">${gan > 0 ? '👍' : '⚠️'}</span><div>
      Cada pieza te costó <b>${dinero(cu)}</b>. La vendes a ${dinero(p.precio)}:
      ${gan > 0 ? `ganas <b>${dinero(gan)}</b> por pieza.` : '<b>¡pierdes dinero!</b> Pide a un adulto subir el precio.'}</div></div>`;
  });
}

/* =========================================================
   FIADO
   ========================================================= */
function vFiado() {
  const lista = [...S.clientes].sort((a, b) => deuda(b) - deuda(a) || a.nombre.localeCompare(b.nombre));
  const total = suma(S.clientes, c => Math.max(0, deuda(c)));
  const deudores = S.clientes.filter(c => deuda(c) > 0).length;
  return `
    <div class="fila" style="justify-content:space-between;margin-bottom:12px">
      <h2 style="margin:0">📒 Fiado</h2>
      <button class="btn" data-action="nuevo-cliente">➕ Cliente</button>
    </div>
    <div class="cuadros">
      <div class="cuadro rojo"><div class="et">Te deben en total</div><div class="val num">${dinero(total)}</div></div>
      <div class="cuadro"><div class="et">Personas que deben</div><div class="val num">${deudores}</div></div>
    </div>
    <div class="tarjeta">
      ${lista.length ? `<ul class="lista">${lista.map(c => {
        const d = deuda(c);
        const ult = c.movs[c.movs.length - 1];
        return `<li data-action="ver-cliente" data-id="${c.id}" style="cursor:pointer">
          <span class="em">👤</span>
          <div class="info"><b>${esc(c.nombre)}</b><span class="small muted">${ult ? `Último movimiento: ${fechaCorta(ult.dia)}` : 'Sin movimientos'}</span></div>
          <div class="der">${d > 0 ? `<span class="badge rojo">debe ${dinero(d)}</span>` : d < 0 ? `<span class="badge azul">a favor ${dinero(-d)}</span>` : '<span class="badge verde">al corriente</span>'}</div>
        </li>`;
      }).join('')}</ul>` : `<div class="vacio"><span class="grande">🤝</span>Nadie te debe. Para fiar, en 🛒 Vender toca <b>📒 Fiado</b>.</div>`}
    </div>`;
}

function formCliente(c) {
  const nuevo = !c;
  abrirModal(`${cab(nuevo ? '➕ Cliente nuevo' : '✏️ Editar cliente')}
    <form>
      <label class="campo">Nombre<input type="text" name="nombre" required maxlength="50" value="${esc(c?.nombre)}" autofocus></label>
      <label class="campo">Teléfono (opcional)<span class="ayuda">Para mandarle un recordatorio por WhatsApp.</span>
        <input type="tel" name="tel" maxlength="15" value="${esc(c?.tel)}" placeholder="10 dígitos"></label>
      <button class="btn grande">💾 Guardar</button>
      ${nuevo ? '' : `<button type="button" class="btn rojo grande" id="btn-borrar-cli" style="margin-top:10px">🗑️ Borrar cliente</button>`}
    </form>`, d => {
    const datos = { nombre: d.nombre.trim(), tel: d.tel.trim() };
    if (nuevo) S.clientes.push({ id: uid(), movs: [], ...datos });
    else Object.assign(c, datos);
    guardar();
    render();
  });
  $('#btn-borrar-cli')?.addEventListener('click', () => {
    if (deuda(c) > 0) return toast('No puedes borrar a alguien que todavía debe');
    conPin('Borrar un cliente', () => confirmar('🗑️ Borrar cliente', `¿Borrar a <b>${esc(c.nombre)}</b> y su historial?`, () => {
      S.clientes = S.clientes.filter(x => x !== c);
      guardar();
      render();
    }, { boton: 'Sí, borrar' }));
  });
}

function verCliente(c) {
  const d = deuda(c);
  const movs = [...c.movs].reverse();
  const tel = (c.tel || '').replace(/\D/g, '');
  const msg = `Hola ${c.nombre}, te saluda ${S.config.negocio}. Te recordamos que tienes un saldo pendiente de ${dinero(d)}. ¡Gracias!`;
  abrirModal(`${cab(`👤 ${esc(c.nombre)}`)}
    <div class="gran-total"><div class="et">${d > 0 ? 'Debe' : d < 0 ? 'Tiene a favor' : 'No debe nada'}</div>
      <div class="val num" style="color:${d > 0 ? 'var(--rojo)' : 'var(--verde)'}">${dinero(Math.abs(d))}</div></div>
    <div class="botones">
      <button type="button" class="btn verde" data-action="abonar" data-id="${c.id}" ${d > 0 ? '' : 'disabled'}>💰 Pagó / abonó</button>
      <button type="button" class="btn gris" data-action="editar-cliente" data-id="${c.id}">✏️ Editar</button>
    </div>
    ${tel && d > 0 ? `<a class="btn sec grande" style="margin-top:10px;text-decoration:none" target="_blank" rel="noopener"
        href="https://wa.me/${tel.length === 10 ? '52' + tel : tel}?text=${encodeURIComponent(msg)}">📲 Recordarle por WhatsApp</a>` : ''}
    <h3 style="margin-top:18px">Historial</h3>
    ${movs.length ? `<ul class="lista">${movs.map(m => `<li>
      <span class="em">${m.tipo === 'fiado' ? '📒' : '💰'}</span>
      <div class="info"><b>${m.tipo === 'fiado' ? 'Se llevó fiado' : 'Pagó'}</b>
        <span class="small muted">${fechaCorta(m.dia)} ${hora(m.fecha)}${m.detalle ? ' · ' + esc(m.detalle) : ''}</span></div>
      <div class="der num" style="font-weight:800;color:${m.tipo === 'fiado' ? 'var(--rojo)' : 'var(--verde)'}">${m.tipo === 'fiado' ? '+' : '−'}${dinero(m.monto)}</div>
    </li>`).join('')}</ul>` : '<p class="muted">Sin movimientos.</p>'}`);
}

function modalAbono(c) {
  const d = deuda(c);
  const caja = abrirModal(`${cab(`💰 Pago de ${esc(c.nombre)}`)}
    <div class="gran-total"><div class="et">Debe</div><div class="val num">${dinero(d)}</div></div>
    <label class="campo">¿Cuánto va a pagar?
      <div class="dinero"><input type="text" inputmode="decimal" id="abono" value="${aPesos(d)}"></div></label>
    <div class="chips"><button type="button" class="chip" data-todo>Paga todo (${dinero(d)})</button></div>
    ${htmlPago()}
    <button type="button" class="btn verde grande" id="btn-abono" disabled>✅ Registrar pago</button>`);
  const inAbono = $('#abono', caja);
  let ok = false;
  const reactivar = (enfocar = false) => {
    const monto = Math.min(aCent(inAbono.value), d);
    activarPago(caja, monto, (bien, rec, cambio) => {
      ok = bien && monto > 0;
      $('#btn-abono').disabled = !ok;
      caja.dataset.cambio = cambio;
    }, enfocar);
  };
  // Al cambiar el monto se vuelve a calcular el cambio (clonar quita los eventos anteriores)
  inAbono.addEventListener('input', () => {
    const rec = $('#recibido', caja);
    const copia = rec.cloneNode(true);
    rec.replaceWith(copia);
    $$('.billetes button', caja).forEach(b => b.replaceWith(b.cloneNode(true)));
    reactivar();
  });
  $('[data-todo]', caja).onclick = () => { inAbono.value = aPesos(d); inAbono.dispatchEvent(new Event('input')); };
  reactivar(true);
  $('#btn-abono').onclick = async () => {
    const monto = Math.min(aCent(inAbono.value), d);
    if (!ok || monto <= 0) return;
    const ahora = new Date();
    c.movs.push({ id: uid(), tipo: 'abono', monto, costo: Math.round(monto * proporcionCosto(c)), fecha: ahora.toISOString(), dia: diaISO(ahora) });
    await guardar();
    const cambio = Number(caja.dataset.cambio) || 0;
    const resta = deuda(c);
    abrirModal(`<div class="centro"><div style="font-size:3.5rem">💰</div><h2>¡Pago registrado!</h2>
      <p>${esc(c.nombre)} pagó <b>${dinero(monto)}</b>. ${resta > 0 ? `Todavía debe <b>${dinero(resta)}</b>.` : '¡Ya no debe nada! 🎉'}</p>
      ${cambio ? `<div class="cambio ok"><div class="et">Dale de cambio</div><div class="val num">${dinero(cambio)}</div></div>` : ''}
      <button type="button" class="btn grande" data-action="cerrar-modal" autofocus>Listo</button></div>`);
    render();
  };
}

/* =========================================================
   CALCULADORA DE PRECIOS
   ========================================================= */
const calc = {
  modo: 'vender',
  compra: '', piezas: '1', extra: '', pct: 50,
  paquete: '120', hojas: '500', toner: '900', rinde: '3000', otros: '0.10', pctCopia: 150,
  precio: '', costo: '',
  redondeo: 'auto', // auto: a 50 centavos (menos de $10) o a peso · peso: a peso cerrado · no: sin redondear
};
const REDONDEOS = [['auto', 'A 50 centavos'], ['peso', 'A peso cerrado'], ['no', 'Sin redondear']];
// Redondea siempre hacia arriba, para no perder ganancia
function redondear(c, modo = calc.redondeo) {
  if (c <= 0) return 0;
  const paso = modo === 'no' ? 1 : modo === 'peso' || c >= 1000 ? 100 : 50;
  return Math.ceil(c / paso - 1e-9) * paso;
}
const campoCalc = (k, etiqueta, ayuda = '', esDinero = true) => `<label class="campo">${etiqueta}${ayuda ? `<span class="ayuda">${ayuda}</span>` : ''}
  ${esDinero ? `<div class="dinero"><input type="text" inputmode="decimal" data-k="${k}" value="${esc(calc[k])}" placeholder="0"></div>`
    : `<input type="number" inputmode="numeric" min="1" data-k="${k}" value="${esc(calc[k])}">`}</label>`;
const chipsPct = k => `<div class="campo">¿Cuánto quieres ganar?<span class="ayuda">Sobre lo que te cuesta. 100% = ganas lo mismo que te costó.</span>
  <div class="chips" style="margin-top:6px">${[30, 50, 100, 150, 200].map(n => `<button class="chip ${Number(calc[k]) === n ? 'activo' : ''}" data-action="calc-pct" data-k="${k}" data-n="${n}">${n}%</button>`).join('')}
  <input type="number" inputmode="numeric" min="0" data-k="${k}" value="${esc(calc[k])}" style="width:90px;margin:0;min-height:40px" aria-label="Otro porcentaje"></div></div>`;

function vCalculadora() {
  const modos = [['vender', '🏷️ ¿A cuánto lo vendo?'], ['copia', '🖨️ Precio de una copia'], ['ganancia', '🤑 ¿Cuánto gano?']];
  let campos = '';
  if (calc.modo === 'vender') {
    campos = campoCalc('compra', '¿Cuánto pagaste?', 'Lo que pagaste en la tienda (por el paquete o la caja).')
      + campoCalc('piezas', '¿Cuántas piezas trae?', 'Si compraste solo 1, deja 1.', false)
      + campoCalc('extra', 'Gastos extra por pieza (opcional)', 'Ej. la bolsita, el pasaje dividido entre las piezas.')
      + chipsPct('pct');
  } else if (calc.modo === 'copia') {
    campos = campoCalc('paquete', '¿Cuánto cuesta el paquete de hojas?')
      + campoCalc('hojas', '¿Cuántas hojas trae?', '', false)
      + campoCalc('toner', '¿Cuánto cuesta el tóner o la tinta?')
      + campoCalc('rinde', '¿Para cuántas copias alcanza?', 'Viene en la caja del tóner (ej. 3000 copias).', false)
      + campoCalc('otros', 'Luz y desgaste por copia', 'Si no sabes, deja 10 centavos.')
      + chipsPct('pctCopia');
  } else {
    campos = campoCalc('precio', '¿A cuánto lo vendes?') + campoCalc('costo', '¿Cuánto te cuesta?');
  }
  return `<h2>🧮 Calculadora de precios</h2>
    <div class="chips">${modos.map(([k, t]) => `<button class="chip ${calc.modo === k ? 'activo' : ''}" data-action="calc-modo" data-modo="${k}">${t}</button>`).join('')}</div>
    <div class="vender" style="padding-bottom:0">
      <div class="tarjeta" id="calc-form">${campos}
        <button class="btn gris grande" data-action="calc-limpiar">🧹 Limpiar</button></div>
      <div class="tarjeta" id="calc-res"></div>
    </div>`;
}

function pintarCalc() {
  const res = $('#calc-res');
  if (!res) return;
  if (calc.modo === 'ganancia') {
    const precio = aCent(calc.precio), costo = aCent(calc.costo);
    if (!precio || !costo) { res.innerHTML = '<div class="vacio"><span class="grande">🤔</span>Escribe el precio y el costo</div>'; return; }
    const g = precio - costo;
    const pct = Math.round(g / costo * 100);
    const cara = g <= 0 ? ['😱', 'Estás perdiendo dinero', 'mal'] : pct < 20 ? ['😟', 'Ganas muy poquito', 'warn'] : pct < 50 ? ['🙂', 'Está bien', 'ok'] : ['🤑', '¡Buena ganancia!', 'ok'];
    res.innerHTML = `<div class="resultado" style="${g <= 0 ? 'background:var(--rojo-claro)' : ''}"><div class="et">Ganas en cada uno</div>
      <div class="val num" style="${g <= 0 ? 'color:var(--rojo)' : ''}">${dinero(g)}</div></div>
      <div class="tip ${cara[2]}" style="margin-top:12px"><span class="ic">${cara[0]}</span><div><b>${cara[1]}</b><br>
      Ganas el ${pct}% de lo que te cuesta. Si vendes 10, ganas ${dinero(g * 10)}.</div></div>`;
    return;
  }
  let costo, pct, filas, piezas;
  if (calc.modo === 'vender') {
    piezas = entero(calc.piezas, 1);
    costo = aCent(calc.compra) / piezas + aCent(calc.extra);
    pct = Number(calc.pct) || 0;
  } else {
    const hoja = aCent(calc.paquete) / entero(calc.hojas, 1);
    const tinta = aCent(calc.toner) / entero(calc.rinde, 1);
    const otros = aCent(calc.otros);
    costo = hoja + tinta + otros;
    pct = Number(calc.pctCopia) || 0;
    filas = [['📄 Hoja', hoja], ['🖨️ Tóner', tinta], ['💡 Luz y desgaste', otros]];
  }
  if (!costo) { res.innerHTML = '<div class="vacio"><span class="grande">🤔</span>Llena los datos para ver el precio</div>'; return; }
  const exacto = costo * (1 + pct / 100);
  const precio = redondear(exacto);
  const gan = precio - costo;
  const redondeado = precio - exacto >= 1;
  const uno = calc.modo === 'copia' ? 'copia' : 'una';
  // Productos a los que se les puede poner este precio (en "copia", primero los servicios)
  const prods = [...S.productos].sort((a, b) => (a.tipo === b.tipo ? a.nombre.localeCompare(b.nombre)
    : (a.tipo === 'servicio') === (calc.modo === 'copia') ? -1 : 1));
  res.innerHTML = `<div class="resultado"><div class="et">Véndelo a</div><div class="val num">${dinero(precio)}</div>
      <div class="small muted">${calc.modo === 'copia' ? 'cada copia' : 'cada pieza'}</div>
      ${redondeado ? `<div class="small" style="margin-top:6px">La cuenta exacta da <b>${dinero(exacto)}</b>; lo subí a <b>${dinero(precio)}</b> para que sea fácil dar cambio.</div>` : ''}</div>
    <div class="campo" style="margin-top:12px">¿Cómo redondeo el precio?
      <div class="chips" style="margin-top:6px">${REDONDEOS.map(([k, t]) => `<button class="chip ${calc.redondeo === k ? 'activo' : ''}" data-action="calc-redondeo" data-r="${k}">${t}</button>`).join('')}</div></div>
    <table class="tabla">
      ${(filas || []).map(([t, v]) => `<tr><td>${t}</td><td>${dinero(v)}</td></tr>`).join('')}
      <tr><td>Te cuesta cada ${uno}</td><td>${dinero(costo)}</td></tr>
      <tr><td>La vendes a</td><td>${dinero(precio)}</td></tr>
      <tr><td>Ganas en cada ${uno}</td><td style="color:var(--verde)">${dinero(gan)} (${Math.round(gan / costo * 100)}%)</td></tr>
      ${calc.modo === 'vender' && piezas > 1 ? `<tr><td>Si vendes las ${piezas}</td><td style="color:var(--verde)">ganas ${dinero(gan * piezas)}</td></tr>` : ''}
      ${calc.modo === 'copia' ? `<tr><td>Si sacas 100 copias</td><td style="color:var(--verde)">ganas ${dinero(gan * 100)}</td></tr>` : ''}
    </table>
    <h3 style="margin-top:16px">¿Qué hago con este precio?</h3>
    ${prods.length ? `<label class="campo">Ponérselo a un producto que ya tengo
      <span class="ayuda">La calculadora no cambia tus productos sola: elige cuál y toca el botón.</span>
      <select id="calc-prod">${prods.map(p => `<option value="${p.id}">${p.emoji} ${esc(p.nombre)} — ahora a ${dinero(p.precio)}</option>`).join('')}</select></label>
    <button class="btn grande" data-action="calc-aplicar">✏️ Cambiar su precio a ${dinero(precio)}</button>
    <p class="centro muted small" style="margin:8px 0">o</p>` : ''}
    <button class="btn sec grande" data-action="calc-crear">➕ Crear un producto nuevo a ${dinero(precio)}</button>`;
  res.dataset.precio = precio;
  res.dataset.costo = Math.round(costo);
}

function crearDesdeCalc() {
  const res = $('#calc-res');
  const precio = Number(res.dataset.precio);
  if (calc.modo === 'copia') {
    const hojas = S.productos.find(p => p.tipo === 'producto' && sinAcentos(p.nombre).includes('hoja'));
    const costoHoja = aCent(calc.paquete) / entero(calc.hojas, 1);
    // Si hay "hojas" en el inventario, la copia las descuenta y su costo propio es solo tóner + luz
    conPin('Crear un producto', () => formProducto(null, {
      nombre: 'Copia', emoji: '📑', tipo: 'servicio', precio,
      costo: Math.round(Number(res.dataset.costo) - (hojas ? costoHoja : 0)),
      insumoId: hojas?.id || null, insumoCant: 1,
    }));
  } else {
    conPin('Crear un producto', () => formProducto(null, {
      precio, costo: Number(res.dataset.costo), tipo: 'producto', stock: calc.modo === 'vender' ? entero(calc.piezas, 1) : 0,
    }));
  }
}

// Pone el precio (y el costo) calculado a un producto existente
function aplicarDesdeCalc() {
  const res = $('#calc-res');
  const p = prod($('#calc-prod').value);
  if (!p) return;
  const precio = Number(res.dataset.precio);
  // Si el producto ya descuenta algo del inventario (ej. la hoja), su costo propio es el resto
  const ins = p.insumoId && prod(p.insumoId);
  const costo = Math.max(0, Math.round(Number(res.dataset.costo) - (ins ? ins.costo * (p.insumoCant || 1) : 0)));
  conPin('Cambiar un precio', () => confirmar('✏️ Cambiar precio',
    `<b>${p.emoji} ${esc(p.nombre)}</b><br>Precio: ${dinero(p.precio)} → <b>${dinero(precio)}</b><br>
     Costo: ${dinero(costoUnit(p))} → <b>${dinero(costo + (ins ? ins.costo * (p.insumoCant || 1) : 0))}</b>${ins ? ` (incluye ${esc(ins.nombre)})` : ''}`, () => {
      p.precio = precio;
      p.costo = costo;
      guardar();
      render();
      toast(`✅ ${esc(p.nombre)} ahora cuesta ${dinero(precio)}`);
    }, { boton: 'Sí, cambiar', clase: 'verde' }));
}

/* =========================================================
   MI DINERO: inversión y los dos sobres
   Cada peso que se cobra se reparte: lo que costó la mercancía regresa al
   sobre de INVERSIÓN (para recuperar lo invertido y volver a surtir) y el
   resto va al sobre de GANANCIA.
   ========================================================= */
const costoVenta = v => suma(v.items, i => (i.costo || 0) * i.cant);

// Qué parte de lo que fía un cliente es costo (para repartir sus pagos)
function proporcionCosto(c) {
  const vs = S.ventas.filter(v => v.pago === 'fiado' && v.clienteId === c.id && !v.cancelada);
  const total = suma(vs, v => v.total);
  return total ? Math.min(1, suma(vs, costoVenta) / total) : 0;
}
const costoAbono = (c, m) => m.costo ?? Math.round(m.monto * proporcionCosto(c));

// Reparto de lo cobrado (ventas en efectivo + pagos de fiado). periodo: "2026-10-03" (día), "2026-10" (mes) o null (siempre).
function repartoDia(periodo) {
  let total = 0, costo = 0;
  for (const v of S.ventas) {
    if (v.cancelada || v.pago !== 'efectivo' || (periodo && !v.dia.startsWith(periodo))) continue;
    total += v.total;
    costo += costoVenta(v);
  }
  for (const c of S.clientes) for (const m of c.movs) {
    if (m.tipo !== 'abono' || (periodo && !m.dia.startsWith(periodo))) continue;
    total += m.monto;
    costo += costoAbono(c, m);
  }
  return { inversion: costo, ganancia: total - costo };
}

function sobres() {
  const r = repartoDia(null);
  let inv = r.inversion, gan = r.ganancia;
  for (const m of S.dinero) {
    if (m.tipo === 'aporte' && m.uso === 'sobre') inv += m.monto;
    if (m.tipo === 'compra' || m.tipo === 'retiro') {
      if (m.sobre === 'inversion') inv -= m.monto;
      if (m.sobre === 'ganancia') gan -= m.monto;
    }
    if (m.tipo === 'ajuste') gan += m.monto;
  }
  return { inv, gan, ganTotal: r.ganancia };
}

function infoInversion() {
  const aportes = S.dinero.filter(m => m.tipo === 'aporte');
  const invertido = suma(aportes, m => m.monto);
  const equipo = suma(aportes.filter(m => m.uso === 'equipo'), m => m.monto);
  const devuelto = suma(S.dinero.filter(m => m.tipo === 'retiro' && m.devolver), m => m.monto);
  const mercancia = suma(S.productos.filter(p => p.tipo === 'producto'), p => p.stock * p.costo);
  const { inv } = sobres();
  const recuperado = devuelto + Math.max(0, inv);
  return { invertido, equipo, devuelto, mercancia, recuperado, enSobre: inv, falta: Math.max(0, invertido - recuperado) };
}

const ORIGENES = [
  ['inversion', '🟪 Del sobre de inversión'],
  ['ganancia', '💗 Del sobre de ganancia'],
  ['nuevo', '💼 Dinero nuevo (nueva inversión)'],
];
function campoOrigen(sel = 'inversion') {
  const s = sobres();
  const saldo = { inversion: s.inv, ganancia: s.gan };
  return `<div class="campo">¿Con qué dinero lo pagaste?<div class="opciones">${ORIGENES.map(([k, t]) => `<label>
    <input type="radio" name="origen" value="${k}" ${k === sel ? 'checked' : ''}> <span style="flex:1">${t}</span>
    ${k in saldo ? `<span class="badge ${saldo[k] > 0 ? 'azul' : 'rojo'}">hay ${dinero(saldo[k])}</span>` : ''}</label>`).join('')}</div></div>`;
}
function registrarCompra(concepto, monto, origen = 'inversion') {
  const base = { id: uid(), monto, concepto, fecha: new Date().toISOString(), dia: hoyISO() };
  if (origen === 'nuevo') S.dinero.push({ ...base, tipo: 'aporte', uso: 'mercancia' });
  else {
    S.dinero.push({ ...base, tipo: 'compra', sobre: origen });
    const s = sobres();
    if ((origen === 'inversion' ? s.inv : s.gan) < 0) toast('⚠️ En ese sobre no alcanzaba: quedó en negativo', 4000);
  }
}

function vDinero() {
  const s = sobres();
  const inv = infoInversion();
  const pct = inv.invertido ? Math.min(100, Math.round(inv.recuperado / inv.invertido * 100)) : 0;
  const mes = hoyISO().slice(0, 7);
  const ganMes = repartoDia(mes).ganancia + suma(S.dinero.filter(m => m.tipo === 'ajuste' && m.dia.startsWith(mes)), m => m.monto);
  const debenFiado = suma(S.clientes, c => Math.max(0, deuda(c)));
  const movs = [...S.dinero].sort((a, b) => b.fecha.localeCompare(a.fecha)).slice(0, 40);
  const icono = m => m.tipo === 'aporte' ? '💼' : m.tipo === 'compra' ? '🛍️' : m.tipo === 'retiro' ? (m.devolver ? '↩️' : '💸') : m.monto > 0 ? '➕' : '➖';
  const titulo = m => m.tipo === 'aporte' ? `Inversión${m.uso === 'equipo' ? ' en equipo' : m.uso === 'mercancia' ? ' en mercancía' : ' al sobre'}`
    : m.tipo === 'compra' ? `Compra (${m.sobre === 'inversion' ? 'sobre inversión' : 'sobre ganancia'})`
    : m.tipo === 'retiro' ? (m.devolver ? 'Se regresó inversión' : 'Se sacó dinero') + ` (sobre ${m.sobre === 'inversion' ? 'inversión' : 'ganancia'})`
    : 'Ajuste de caja';
  const resta = m => m.tipo === 'compra' || m.tipo === 'retiro' || (m.tipo === 'ajuste' && m.monto < 0);

  return `<h2>💼 Mi dinero</h2>
    <div class="sobres">
      <div class="sobre sobre-inv"><div class="et">🟪 Sobre de INVERSIÓN</div><div class="val num">${dinero(s.inv)}</div>
        <div class="small">Para recuperar lo invertido y volver a comprar mercancía, hojas y tóner.</div></div>
      <div class="sobre sobre-gan"><div class="et">💗 Sobre de GANANCIA</div><div class="val num">${dinero(s.gan)}</div>
        <div class="small">Lo que de verdad ganaste. Este mes: <b>${dinero(ganMes)}</b>.</div></div>
    </div>
    ${debenFiado ? `<p class="small muted">📒 Además te deben ${dinero(debenFiado)} en fiados: cuando te paguen, se reparte en los sobres.</p>` : ''}
    <div class="fila" style="margin:12px 0 16px">
      <button class="btn crece" data-action="aporte">💼 Invertí dinero</button>
      <button class="btn sec crece" data-action="compra">🛍️ Compré algo</button>
      <button class="btn gris crece" data-action="retiro">💸 Saqué dinero</button>
    </div>

    <div class="tarjeta">
      <h3>📈 Mi inversión</h3>
      ${inv.invertido ? `
        <div class="cuadros">
          <div class="cuadro"><div class="et">💼 Invertiste</div><div class="val num">${dinero(inv.invertido)}</div></div>
          <div class="cuadro azul"><div class="et">✅ Ya recuperaste</div><div class="val num">${dinero(inv.recuperado)}</div></div>
          <div class="cuadro naranja"><div class="et">⏳ Falta recuperar</div><div class="val num">${dinero(inv.falta)}</div></div>
        </div>
        <div class="progreso"><div style="width:${pct}%"></div><span>${pct}%</span></div>
        <p class="small muted" style="margin-top:6px">Recuperado = lo que hay en el sobre de inversión${inv.devuelto ? ` + lo que ya se regresó (${dinero(inv.devuelto)})` : ''}.</p>
        ${pct >= 100 ? '<div class="tip ok"><span class="ic">🎉</span><div><b>¡Ya recuperaste todo lo que invertiste!</b> Puedes regresar ese dinero a quien lo puso, o usarlo para surtir más.</div></div>' : ''}
        <h3 style="margin-top:14px">¿Dónde está tu inversión ahora?</h3>
        <table class="tabla">
          <tr><td>🟪 En el sobre de inversión (efectivo)</td><td>${dinero(s.inv)}</td></tr>
          <tr><td>📦 En mercancía (lo que tienes en inventario)</td><td>${dinero(inv.mercancia)}</td></tr>
          ${inv.equipo ? `<tr><td>🖨️ En equipo (impresora, engargoladora…)</td><td>${dinero(inv.equipo)}</td></tr>` : ''}
          ${inv.devuelto ? `<tr><td>↩️ Ya se regresó</td><td>${dinero(inv.devuelto)}</td></tr>` : ''}
        </table>
        ${inv.equipo ? '<p class="small muted">El equipo no se recupera con lo que cuesta cada copia: se paga con la ganancia. Cuando quieras, usa <b>💸 Saqué dinero → Regresar inversión</b> desde el sobre de ganancia.</p>' : ''}`
      : `<div class="tip info"><span class="ic">💡</span><div>Anota cuánto dinero se puso para empezar el negocio (mercancía, hojas, impresora…). Así sabrás cuánto falta para recuperarlo.</div></div>
        <button class="btn grande" data-action="aporte-inicial">💼 Anotar inversión inicial</button>`}
    </div>

    <div class="tarjeta">
      <h3>🤔 ¿Cómo funciona?</h3>
      <p class="small">Si vendes un folder en <b>$5</b> que te costó <b>$2.50</b>:</p>
      <div class="sobre-fila sobre-inv"><span>🟪 $2.50 regresan a tu inversión</span><b>$2.50</b></div>
      <div class="sobre-fila sobre-gan"><span>💗 $2.50 son tu ganancia</span><b>$2.50</b></div>
      <p class="small muted">Al <b>cerrar el día</b> la app te dice cuánto meter en cada sobre. Para volver a surtir usa el sobre de inversión, así nunca te comes tu negocio. 😉</p>
    </div>

    <div class="tarjeta">
      <h3>🧾 Movimientos</h3>
      ${movs.length ? `<ul class="lista">${movs.map(m => `<li>
        <span class="em">${icono(m)}</span>
        <div class="info"><b>${esc(m.concepto || titulo(m))}</b><span class="small muted">${titulo(m)} · ${fechaCorta(m.dia)}</span></div>
        <div class="der"><b class="num" style="color:${resta(m) ? 'var(--rojo)' : 'var(--verde)'}">${resta(m) ? '−' : '+'}${dinero(Math.abs(m.monto))}</b><br>
          ${m.tipo === 'ajuste' ? '' : `<button class="link-btn small" data-action="borrar-dinero" data-id="${m.id}" aria-label="Borrar">🗑️</button>`}</div>
      </li>`).join('')}</ul>` : '<p class="muted">Todavía no hay movimientos. Las ventas se reparten solas en los sobres.</p>'}
    </div>`;
}

function modalAporte(pre = {}) {
  abrirModal(`${cab('💼 Invertí dinero')}
    <p class="small muted">Dinero <b>nuevo</b> que se pone en el negocio (no el de las ventas).</p>
    <form>
      <label class="campo">¿Qué fue?<input type="text" name="concepto" maxlength="60" required value="${esc(pre.concepto || '')}" placeholder="Ej. Paquete de hojas, impresora…" autofocus></label>
      <label class="campo">¿Cuánto dinero?<div class="dinero"><input type="text" inputmode="decimal" name="monto" required value="${aPesos(pre.monto)}" placeholder="0"></div></label>
      <div class="campo">¿En qué se usó?<div class="opciones">
        <label><input type="radio" name="uso" value="mercancia" ${(pre.uso || 'mercancia') === 'mercancia' ? 'checked' : ''}> 📦 Compré mercancía (ya está en el inventario)</label>
        <label><input type="radio" name="uso" value="equipo" ${pre.uso === 'equipo' ? 'checked' : ''}> 🖨️ Equipo (impresora, engargoladora, mueble…)</label>
        <label><input type="radio" name="uso" value="sobre" ${pre.uso === 'sobre' ? 'checked' : ''}> 🟪 Lo guardé en el sobre para comprar después</label>
      </div></div>
      <button class="btn grande">💾 Guardar</button>
    </form>`, d => {
    const monto = aCent(d.monto);
    if (monto <= 0) { toast('Escribe cuánto dinero'); return false; }
    S.dinero.push({ id: uid(), tipo: 'aporte', uso: d.uso, monto, concepto: d.concepto.trim(), fecha: new Date().toISOString(), dia: hoyISO() });
    guardar();
    render();
    toast('✅ Inversión anotada');
  });
}

function modalCompra() {
  abrirModal(`${cab('🛍️ Compré algo')}
    <div class="tip info"><span class="ic">💡</span><div>¿Compraste piezas que vendes (lápices, folders, hojas)? Mejor regístralo en <b>📦 Inventario → 📥</b> para que también se sumen las piezas.
      Aquí anota lo demás: tóner, tinta, grapas, bolsas…</div></div>
    <form>
      <label class="campo">¿Qué compraste?<input type="text" name="concepto" maxlength="60" required placeholder="Ej. Tóner" autofocus></label>
      <label class="campo">¿Cuánto pagaste?<div class="dinero"><input type="text" inputmode="decimal" name="monto" required placeholder="0"></div></label>
      ${campoOrigen()}
      <button class="btn grande">💾 Guardar</button>
    </form>`, d => {
    const monto = aCent(d.monto);
    if (monto <= 0) { toast('Escribe cuánto pagaste'); return false; }
    registrarCompra(d.concepto.trim(), monto, d.origen);
    guardar();
    render();
    toast('✅ Compra anotada');
  });
}

function modalRetiro() {
  const s = sobres();
  const caja = abrirModal(`${cab('💸 Saqué dinero')}
    <form>
      <div class="campo">¿De qué sobre?<div class="opciones">
        <label><input type="radio" name="sobre" value="ganancia" checked> <span style="flex:1">💗 Ganancia</span><span class="badge verde">hay ${dinero(s.gan)}</span></label>
        <label><input type="radio" name="sobre" value="inversion"> <span style="flex:1">🟪 Inversión</span><span class="badge azul">hay ${dinero(s.inv)}</span></label>
      </div></div>
      <div class="campo">¿Para qué?<div class="opciones">
        <label><input type="radio" name="para" value="gasto" checked> 💸 Me lo llevo o lo gasto</label>
        <label><input type="radio" name="para" value="devolver"> ↩️ Regresar la inversión a quien puso el dinero</label>
      </div></div>
      <label class="campo">¿Cuánto?<div class="dinero"><input type="text" inputmode="decimal" name="monto" required placeholder="0"></div></label>
      <label class="campo">Nota (opcional)<input type="text" name="concepto" maxlength="60" placeholder="Ej. Para mis ahorros"></label>
      <div id="aviso-retiro"></div>
      <button class="btn grande">💾 Guardar</button>
    </form>`, d => {
    const monto = aCent(d.monto);
    if (monto <= 0) { toast('Escribe cuánto sacaste'); return false; }
    const guardarRetiro = () => {
      S.dinero.push({ id: uid(), tipo: 'retiro', sobre: d.sobre, devolver: d.para === 'devolver', monto,
        concepto: d.concepto.trim(), fecha: new Date().toISOString(), dia: hoyISO() });
      guardar();
      render();
      toast('✅ Anotado');
    };
    // Sacar dinero de la inversión para gastarlo descapitaliza el negocio: lo autoriza un adulto
    if (d.sobre === 'inversion' && d.para !== 'devolver') setTimeout(() => conPin('Sacar dinero del sobre de inversión', guardarRetiro));
    else guardarRetiro();
  });
  const f = $('form', caja);
  const avisar = () => {
    const saldo = f.sobre.value === 'inversion' ? s.inv : s.gan;
    const monto = aCent(f.monto.value);
    $('#aviso-retiro', caja).innerHTML =
      f.sobre.value === 'inversion' && f.para.value === 'gasto'
        ? '<div class="tip warn"><span class="ic">⚠️</span><div>El dinero de inversión es para volver a surtir. Si lo gastas, después no tendrás con qué comprar. Mejor sácalo de la ganancia.</div></div>'
        : monto > saldo ? `<div class="tip mal"><span class="ic">😕</span><div>En ese sobre solo hay ${dinero(saldo)}.</div></div>` : '';
  };
  f.addEventListener('input', avisar);
  f.addEventListener('change', avisar);
}

/* =========================================================
   MI DÍA (resumen, ventas y cierre)
   ========================================================= */
let diaSel = hoyISO();

function resumenDia(dia) {
  const vs = S.ventas.filter(v => v.dia === dia && !v.cancelada);
  const abonos = S.clientes.flatMap(c => c.movs).filter(m => m.tipo === 'abono' && m.dia === dia);
  const top = {};
  for (const v of vs) for (const it of v.items) {
    const t = (top[it.nombre] ||= { nombre: it.nombre, emoji: it.emoji, cant: 0, total: 0 });
    t.cant += it.cant;
    t.total += it.cant * it.precio;
  }
  const r = {
    ventas: vs.length,
    total: suma(vs, v => v.total),
    efectivo: suma(vs.filter(v => v.pago === 'efectivo'), v => v.total),
    fiado: suma(vs.filter(v => v.pago === 'fiado'), v => v.total),
    abonos: suma(abonos, m => m.monto),
    ganancia: suma(vs, v => suma(v.items, i => (i.precio - (i.costo || 0)) * i.cant)),
    top: Object.values(top).sort((a, b) => b.total - a.total),
  };
  r.entro = r.efectivo + r.abonos; // dinero que entró a la caja
  return r;
}
const cierreDe = dia => S.cierres.find(c => c.dia === dia);

function vHoy() {
  const hoy = hoyISO();
  const r = resumenDia(diaSel);
  const rep = repartoDia(diaSel);
  const cierre = cierreDe(diaSel);
  const ventas = S.ventas.filter(v => v.dia === diaSel).reverse();
  const semana = Array.from({ length: 7 }, (_, i) => sumarDias(diaSel, i - 6)).map(d => ({ d, t: resumenDia(d).total }));
  const maxSem = Math.max(1, ...semana.map(x => x.t));
  const maxTop = Math.max(1, ...r.top.map(x => x.total));
  const cambiosTrasCierre = cierre && cierre.ventas !== r.ventas;
  return `
    <div class="fila" style="justify-content:space-between;margin-bottom:12px">
      <button class="btn chico gris" data-action="dia" data-n="-1" aria-label="Día anterior">◀</button>
      <div class="centro"><h2 style="margin:0">${diaSel === hoy ? '📊 Hoy' : '📊 ' + fechaLarga(diaSel)}</h2>
        <span class="small muted">${diaSel === hoy ? fechaLarga(hoy) : ''}</span></div>
      <button class="btn chico gris" data-action="dia" data-n="1" ${diaSel >= hoy ? 'disabled' : ''} aria-label="Día siguiente">▶</button>
    </div>

    ${cierre && !cambiosTrasCierre
      ? `<div class="tip ok"><span class="ic">✅</span><div><b>Día cerrado</b> a las ${hora(cierre.fecha)}${cierre.auto ? ' (automático)' : ''}
          ${cierre.contado != null ? (cierre.diferencia === 0 ? ' · La caja cuadró perfecto.' : ` · En la caja ${cierre.diferencia > 0 ? 'sobraron' : 'faltaron'} ${dinero(Math.abs(cierre.diferencia))}.`) : ''}</div></div>`
      : r.ventas || r.abonos
        ? `<button class="btn grande" style="margin-bottom:14px" data-action="cerrar-dia">🌙 ${cambiosTrasCierre ? 'Volver a cerrar el día (hubo cambios)' : 'Cerrar el día y guardar respaldo'}</button>`
        : ''}

    <div class="cuadros">
      <div class="cuadro azul"><div class="et">🧾 Vendiste</div><div class="val num">${dinero(r.total)}</div><div class="small muted">${r.ventas} ${r.ventas === 1 ? 'venta' : 'ventas'}</div></div>
      <div class="cuadro verde"><div class="et">🤑 Ganancia de lo vendido</div><div class="val num">${dinero(r.ganancia)}</div></div>
      <div class="cuadro sobre-inv"><div class="et">🟪 Para recuperar inversión</div><div class="val num">${dinero(rep.inversion)}</div><div class="small muted">lo que costó lo cobrado</div></div>
      <div class="cuadro sobre-gan"><div class="et">💗 Ganancia cobrada</div><div class="val num">${dinero(rep.ganancia)}</div><div class="small muted">ya en efectivo</div></div>
      <div class="cuadro"><div class="et">💵 Cobrado en efectivo</div><div class="val num">${dinero(r.efectivo)}</div></div>
      <div class="cuadro naranja"><div class="et">📒 Fiado</div><div class="val num">${dinero(r.fiado)}</div></div>
      <div class="cuadro verde"><div class="et">💰 Te pagaron de fiados</div><div class="val num">${dinero(r.abonos)}</div></div>
      <div class="cuadro"><div class="et">🗃️ Debe haber en la caja</div><div class="val num">${dinero((cierre?.fondo ?? S.config.fondo) + r.entro)}</div>
        <div class="small muted">fondo ${dinero(cierre?.fondo ?? S.config.fondo)} + lo cobrado</div></div>
    </div>

    <div class="vender" style="padding-bottom:0">
      <div class="tarjeta">
        <h3>🏆 Lo más vendido</h3>
        ${r.top.length ? `<ul class="lista barras">${r.top.slice(0, 6).map(t => `<li>
          <span>${t.emoji} ${esc(t.nombre)} <span class="muted small">× ${t.cant}</span></span><b class="num">${dinero(t.total)}</b>
          <div class="barra-fondo"><div style="width:${Math.round(t.total / maxTop * 100)}%"></div></div></li>`).join('')}</ul>`
          : '<p class="muted">Todavía no hay ventas este día.</p>'}
      </div>
      <div class="tarjeta">
        <h3>📅 Últimos 7 días</h3>
        <div class="semana">${semana.map(x => `<div class="col ${x.d === diaSel ? 'hoy' : ''}" title="${fechaCorta(x.d)}: ${dinero(x.t)}">
          <span class="num">${x.t ? dinero(x.t) : ''}</span><div style="height:${Math.round(x.t / maxSem * 80)}%"></div>
          <span>${new Date(x.d + 'T12:00').toLocaleDateString('es-MX', { weekday: 'short' }).slice(0, 3)}</span></div>`).join('')}</div>
      </div>
    </div>

    <div class="tarjeta">
      <div class="fila" style="justify-content:space-between"><h3 style="margin:0">🧾 Ventas del día</h3>
        ${S.ventas.length ? '<button class="btn chico sec" data-action="csv">📤 Excel</button>' : ''}</div>
      ${ventas.length ? `<ul class="lista">${ventas.map(v => `<li class="${v.cancelada ? 'tachada' : ''}">
        <span class="em">${v.pago === 'fiado' ? '📒' : '💵'}</span>
        <div class="info"><b>#${v.folio} · ${hora(v.fecha)}${v.cancelada ? ' · CANCELADA' : ''}</b>
          <span class="small muted">${esc(v.items.map(i => `${i.cant} ${i.nombre}`).join(', '))}${v.pago === 'fiado' ? ` · fiado a ${esc(cliente(v.clienteId)?.nombre || '¿?')}` : ''}</span></div>
        <div class="der"><b class="num">${dinero(v.total)}</b><br>
          ${v.cancelada ? '' : `<button class="link-btn small" data-action="cancelar-venta" data-id="${v.id}" style="color:var(--rojo);font-size:.82rem">Cancelar</button>`}</div>
      </li>`).join('')}</ul>` : '<p class="muted">Sin ventas.</p>'}
    </div>`;
}

function cancelarVenta(v) {
  conPin('Cancelar una venta', () => confirmar('❌ Cancelar venta', `¿Cancelar la venta <b>#${v.folio}</b> de ${dinero(v.total)}?<br><br>
    Lo vendido regresa al inventario${v.pago === 'fiado' ? ' y se quita de la cuenta del cliente' : ''}.${v.pago === 'efectivo' ? ' Recuerda devolver el dinero.' : ''}
    ${v.pago === 'fiado' && cliente(v.clienteId) && deuda(cliente(v.clienteId)) < v.total ? '<br><br>⚠️ Este cliente ya había pagado algo: le quedará <b>saldo a favor</b> para su próxima compra o devuélvele el dinero.' : ''}`, () => {
    v.cancelada = true;
    v.canceladaEn = new Date().toISOString();
    moverStock(v.items, +1);
    if (v.pago === 'fiado') {
      const c = cliente(v.clienteId);
      if (c) c.movs = c.movs.filter(m => m.ventaId !== v.id);
    }
    guardar();
    render();
    toast('Venta cancelada');
  }, { boton: 'Sí, cancelar' }));
}

function modalCierre(dia = hoyISO()) {
  const r = resumenDia(dia);
  const rep = repartoDia(dia);
  // Si el día ya se había cerrado, solo se reparte lo que entró después
  const antes = cierreDe(dia);
  const aInv = rep.inversion - (antes?.aInversion || 0);
  const aGan = rep.ganancia - (antes?.aGanancia || 0);
  const caja = abrirModal(`${cab('🌙 Cerrar el día')}
    <p class="muted">${fechaLarga(dia)}</p>
    <table class="tabla">
      <tr><td>🧾 Ventas</td><td>${r.ventas}</td></tr>
      <tr><td>Vendiste en total</td><td>${dinero(r.total)}</td></tr>
      <tr><td>💵 Cobrado en efectivo</td><td>${dinero(r.efectivo)}</td></tr>
      <tr><td>💰 Te pagaron de fiados</td><td>${dinero(r.abonos)}</td></tr>
      <tr><td>📒 Fiaste</td><td>${dinero(r.fiado)}</td></tr>
      <tr><td>🤑 Ganancia aproximada</td><td style="color:var(--verde)">${dinero(r.ganancia)}</td></tr>
    </table>
    <form style="margin-top:14px">
      <label class="campo">¿Con cuánto dinero empezó la caja?<span class="ayuda">El cambio que tenías al abrir (fondo).</span>
        <div class="dinero"><input type="text" inputmode="decimal" name="fondo" value="${aPesos(S.config.fondo)}" placeholder="0"></div></label>
      <label class="campo">Cuenta el dinero de la caja: ¿cuánto hay?<span class="ayuda">Cuenta billetes y monedas con calma. Si no puedes contar ahora, déjalo vacío.</span>
        <div class="dinero"><input type="text" inputmode="decimal" name="contado" placeholder="0" autofocus></div></label>
      <div id="cuadre"></div>
      <div id="reparto"></div>
      <button class="btn grande">💾 Cerrar día y guardar respaldo</button>
    </form>`, async d => {
    const fondo = aCent(d.fondo);
    const debe = fondo + r.entro;
    const contado = d.contado.trim() ? aCent(d.contado) : null;
    const diferencia = contado == null ? null : contado - debe;
    S.config.fondo = fondo;
    S.cierres = S.cierres.filter(c => c.dia !== dia);
    const { top, ...totales } = r;
    S.cierres.push({ dia, fecha: new Date().toISOString(), ...totales, fondo, debe, contado, diferencia, aInversion: rep.inversion, aGanancia: rep.ganancia });
    // Lo que sobra o falta en la caja se suma o se descuenta de la ganancia
    S.dinero = S.dinero.filter(m => !(m.tipo === 'ajuste' && m.dia === dia));
    if (diferencia) {
      S.dinero.push({ id: uid(), tipo: 'ajuste', sobre: 'ganancia', monto: diferencia, dia, fecha: new Date().toISOString(),
        concepto: diferencia > 0 ? 'Sobró dinero en la caja' : 'Faltó dinero en la caja' });
    }
    const donde = await guardarArchivo();
    await guardar();
    await respaldoInterno('Cierre del día');
    render();
    terminado(donde);
    return false;
  });
  const f = $('form', caja);
  const pintar = () => {
    const fondo = aCent(f.fondo.value);
    const debe = fondo + r.entro;
    const div = $('#cuadre', caja);
    const dif = f.contado.value.trim() ? aCent(f.contado.value) - debe : 0;
    const gan = aGan + dif;
    $('#reparto', caja).innerHTML = aInv || aGan || dif ? `<div class="reparto">
      <h3>📮 Ahora reparte el dinero de la caja</h3>
      ${antes ? '<p class="small muted">Ya habías cerrado este día: aquí solo sale lo nuevo.</p>' : ''}
      <div class="sobre-fila sobre-inv"><span>🟪 Al sobre de <b>INVERSIÓN</b><br><span class="small muted">lo que costó lo que vendiste</span></span><b class="num">${dinero(aInv)}</b></div>
      <div class="sobre-fila sobre-gan"><span>💗 Al sobre de <b>GANANCIA</b><br><span class="small muted">${dif ? `tu ganancia ${dif > 0 ? '+ lo que sobró' : '− lo que faltó'}` : 'lo que ganaste'}</span></span><b class="num">${dinero(gan)}</b></div>
      <div class="sobre-fila"><span>🗃️ Se queda en la caja<br><span class="small muted">el fondo para dar cambio mañana</span></span><b class="num">${dinero(fondo)}</b></div>
      ${gan < 0 ? '<p class="small" style="color:var(--rojo)">Faltó más dinero de lo que ganaste hoy: lo que falta sale del sobre de ganancia.</p>' : ''}
    </div>` : '';
    if (!f.contado.value.trim()) { div.innerHTML = `<div class="tip info"><span class="ic">🗃️</span><div>Debe haber <b>${dinero(debe)}</b> en la caja.</div></div>`; return; }
    div.innerHTML = dif === 0
      ? `<div class="tip ok"><span class="ic">🎉</span><div><b>¡Cuadra perfecto!</b> Hay ${dinero(debe)}, justo lo que debe haber.</div></div>`
      : `<div class="tip ${Math.abs(dif) <= 500 ? 'warn' : 'mal'}"><span class="ic">${dif > 0 ? '🤔' : '😟'}</span><div>
          Debería haber ${dinero(debe)}: <b>${dif > 0 ? 'sobran' : 'faltan'} ${dinero(Math.abs(dif))}</b>.<br>
          <span class="small">Revisa si olvidaste registrar alguna venta, si diste mal un cambio o vuelve a contar.</span></div></div>`;
  };
  f.addEventListener('input', pintar);
  pintar();
}

function terminado(donde) {
  const puedeCompartir = !!navigator.canShare;
  abrirModal(`<div class="centro"><div style="font-size:3.5rem">🌙</div><h2>¡Día cerrado!</h2>
    <p>${donde === 'carpeta' ? '💾 El respaldo se guardó en tu carpeta de respaldos.'
      : donde === 'descarga' ? '💾 El respaldo se descargó (búscalo en <b>Descargas</b>).'
      : '⚠️ No se pudo guardar el archivo, pero sí quedó un respaldo dentro de la app.'}</p>
    ${puedeCompartir ? '<button type="button" class="btn sec grande" data-action="compartir-respaldo" style="margin-bottom:10px">📤 Mandar respaldo a mamá/papá</button>' : ''}
    <button type="button" class="btn grande" data-action="cerrar-modal">¡Buen trabajo! 👋</button></div>`);
}

/* =========================================================
   RESPALDOS
   ========================================================= */
const MAX_INTERNOS = 30;

async function respaldoInterno(tipo) {
  await DB.guardarRespaldo({ id: uid(), fecha: new Date().toISOString(), dia: hoyISO(), tipo, datos: structuredClone(S) });
  const lista = (await DB.respaldos()).sort((a, b) => b.fecha.localeCompare(a.fecha));
  for (const r of lista.slice(MAX_INTERNOS)) await DB.borrarRespaldo(r.id);
}
// Uno al abrir la app cada día: guarda cómo quedó todo el día anterior
async function respaldoDiario() {
  const lista = await DB.respaldos();
  if (!lista.some(r => r.dia === hoyISO())) await respaldoInterno('Automático');
}

function archivoRespaldo() {
  const nombre = `respaldo-copias-${hoyISO()}.json`;
  const contenido = JSON.stringify({ app: 'copias-negocio', version: VERSION, fecha: new Date().toISOString(), datos: S });
  return { nombre, blob: new Blob([contenido], { type: 'application/json' }) };
}
function descargar(blob, nombre) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
// Guarda en la carpeta elegida (Chrome/Edge en computadora) o lo descarga
async function guardarArchivo() {
  const { nombre, blob } = archivoRespaldo();
  let donde = null;
  try {
    const dir = await DB.get('carpeta');
    if (dir) {
      let perm = await dir.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') perm = await dir.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        const fh = await dir.getFileHandle(nombre, { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
        donde = 'carpeta';
      }
    }
  } catch (e) { console.warn('No se pudo escribir en la carpeta', e); }
  if (!donde) {
    try { descargar(blob, nombre); donde = 'descarga'; } catch { donde = null; }
  }
  if (donde) { S.config.ultimoArchivo = hoyISO(); await guardar(); }
  return donde;
}
async function compartirRespaldo() {
  const { nombre, blob } = archivoRespaldo();
  const file = new File([blob], nombre, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Respaldo ' + S.config.negocio, text: `Respaldo del ${fechaLarga(hoyISO())}` });
      return;
    }
  } catch (e) { if (e.name === 'AbortError') return; }
  descargar(blob, nombre);
  toast('Tu teléfono no permite compartir el archivo; se descargó.');
}
function restaurar(datos, cuando) {
  conPin('Restaurar un respaldo', () => confirmar('♻️ Restaurar respaldo',
    `Se cambiarán TODOS los datos actuales por los del respaldo <b>${esc(cuando)}</b>.<br><br>Antes guardaré un respaldo de lo que tienes ahora, por si acaso.`, async () => {
      await respaldoInterno('Antes de restaurar');
      S = migrar(structuredClone(datos));
      carrito = [];
      await guardar();
      render();
      toast('✅ Respaldo restaurado');
    }, { boton: 'Sí, restaurar', clase: 'naranja' }));
}
function importarArchivo() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.onchange = async () => {
    try {
      const j = JSON.parse(await inp.files[0].text());
      const datos = j.datos || j;
      if (!datos || !datosValidos(datos)) throw new Error('inválido');
      restaurar(datos, j.fecha ? new Date(j.fecha).toLocaleString('es-MX') : inp.files[0].name);
    } catch {
      toast('⚠️ Ese archivo no es un respaldo de esta app');
    }
  };
  inp.click();
}

function exportarCSV() {
  const filas = [['Folio', 'Fecha', 'Hora', 'Productos', 'Total', 'Ganancia', 'Pago', 'Cliente', 'Estado']];
  for (const v of S.ventas) {
    filas.push([v.folio, v.dia, hora(v.fecha), v.items.map(i => `${i.cant} ${i.nombre}`).join(' + '),
      (v.total / 100).toFixed(2), (suma(v.items, i => (i.precio - (i.costo || 0)) * i.cant) / 100).toFixed(2),
      v.pago, v.clienteId ? cliente(v.clienteId)?.nombre || '' : '', v.cancelada ? 'Cancelada' : 'OK']);
  }
  const csv = '﻿' + filas.map(f => f.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  descargar(new Blob([csv], { type: 'text/csv' }), `ventas-copias-${hoyISO()}.csv`);
}

/* =========================================================
   AJUSTES Y AYUDA
   ========================================================= */
let eventoInstalar = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); eventoInstalar = e; if (vista === 'ajustes' || vista === 'ayuda') render(); });

function vAjustes() {
  const c = S.config;
  const diasSinArchivo = c.ultimoArchivo ? Math.round((new Date(hoyISO()) - new Date(c.ultimoArchivo)) / 864e5) : null;
  const soportaCarpeta = 'showDirectoryPicker' in window;
  return `<h2>⚙️ Ajustes</h2>
    ${eventoInstalar ? '<button class="btn verde grande" data-action="instalar" style="margin-bottom:14px">📲 Instalar la app en este dispositivo</button>' : ''}
    <div class="tarjeta">
      <h3>🏪 Mi negocio</h3>
      <form id="form-negocio">
        <label class="campo">Nombre del negocio<input type="text" name="negocio" maxlength="40" value="${esc(c.negocio)}" required></label>
        <div class="fila">
          <label class="campo crece">Hora de cerrar<span class="ayuda">A esta hora te recuerdo cerrar el día.</span><input type="time" name="horaCierre" value="${esc(c.horaCierre)}" required></label>
          <label class="campo crece">Fondo de caja<span class="ayuda">Cambio con el que abres.</span><div class="dinero"><input type="text" inputmode="decimal" name="fondo" value="${aPesos(c.fondo)}" placeholder="0"></div></label>
        </div>
        <label class="campo">Lo máximo que puede deber un cliente<span class="ayuda">Si alguien quiere fiar más, se pide el PIN. Pon 0 para no tener límite.</span>
          <div class="dinero"><input type="text" inputmode="decimal" name="limiteFiado" value="${aPesos(c.limiteFiado)}" placeholder="0"></div></label>
        <button class="btn">💾 Guardar</button>
      </form>
    </div>

    <div class="tarjeta">
      <h3>🔒 PIN de adulto</h3>
      <p class="small muted">Si pones un PIN, se pedirá para: crear, editar o borrar productos y precios, cancelar ventas, fiar más del límite, borrar clientes y restaurar respaldos.</p>
      <p>${c.pin ? '✅ El PIN está activado.' : 'Sin PIN: todos pueden cambiar todo.'}</p>
      <div class="fila"><button class="btn sec" data-action="pin">${c.pin ? 'Cambiar o quitar PIN' : 'Poner PIN'}</button></div>
    </div>

    <div class="tarjeta">
      <h3>💾 Respaldos</h3>
      ${diasSinArchivo == null || diasSinArchivo > 1
        ? `<div class="tip warn"><span class="ic">⚠️</span><div>${diasSinArchivo == null ? 'Aún no has guardado ningún archivo de respaldo.' : `Hace ${diasSinArchivo} días que no guardas un archivo de respaldo.`}</div></div>`
        : `<div class="tip ok"><span class="ic">✅</span><div>Último archivo de respaldo: ${fechaLarga(c.ultimoArchivo)}.</div></div>`}
      <div class="tip info"><span class="ic">🔄</span><div>La app guarda sola un respaldo interno cada día y al cerrar el día (los últimos ${MAX_INTERNOS}).
        Al <b>cerrar el día</b> además se guarda un <b>archivo</b>: guárdalo fuera del teléfono (mándalo por WhatsApp o súbelo a Drive) por si se pierde o se borra la app.</div></div>
      ${soportaCarpeta ? `<p class="small"><b>📁 Carpeta automática:</b> <span id="nombre-carpeta" class="muted">revisando…</span></p>
        <div class="fila" style="margin-bottom:10px"><button class="btn sec chico" data-action="elegir-carpeta">📁 Elegir carpeta</button>
        <button class="btn gris chico" data-action="quitar-carpeta" id="btn-quitar-carpeta" hidden>Quitar</button></div>` : ''}
      <div class="botones">
        <button class="btn" data-action="guardar-respaldo">💾 Guardar archivo ahora</button>
        <button class="btn sec" data-action="compartir-respaldo">📤 Enviar respaldo</button>
        <button class="btn gris" data-action="importar">♻️ Restaurar archivo</button>
        <button class="btn gris" data-action="csv">📊 Ventas a Excel</button>
      </div>
      <h3 style="margin-top:18px">Respaldos dentro de la app</h3>
      <ul class="lista" id="lista-respaldos"><li class="muted small">Cargando…</li></ul>
    </div>

    <div class="tarjeta">
      <h3>🧨 Empezar de cero</h3>
      <p class="small muted">Borra productos, ventas, clientes y fiados. Guarda antes un archivo de respaldo.</p>
      <button class="btn rojo" data-action="borrar-todo">Borrar todo</button>
    </div>
    <p class="centro small muted">Versión ${VERSION} · Tus datos se guardan solo en este dispositivo.</p>`;
}

async function pintarAjustes() {
  const ul = $('#lista-respaldos');
  const lista = (await DB.respaldos()).sort((a, b) => b.fecha.localeCompare(a.fecha)).slice(0, 12);
  if (ul) {
    ul.innerHTML = lista.length ? lista.map(r => `<li><span class="em">🗂️</span>
      <div class="info"><b>${fechaCorta(r.dia)} · ${hora(r.fecha)}</b><span class="small muted">${esc(r.tipo)} · ${r.datos.ventas.length} ventas</span></div>
      <button class="btn chico gris" data-action="restaurar-interno" data-id="${r.id}">♻️ Usar</button></li>`).join('')
      : '<li class="muted small">Aún no hay respaldos internos.</li>';
  }
  const nom = $('#nombre-carpeta');
  if (nom) {
    const dir = await DB.get('carpeta');
    nom.textContent = dir ? dir.name : 'no elegida (los respaldos se descargan)';
    $('#btn-quitar-carpeta').hidden = !dir;
  }
}

function modalPin() {
  const tiene = !!S.config.pin;
  const pedir = () => abrirModal(`${cab('🔒 PIN de adulto')}
    <form>
      <label class="campo">PIN nuevo (4 a 8 números)<input type="password" inputmode="numeric" name="pin" pattern="[0-9]{4,8}" autocomplete="new-password" autofocus ${tiene ? '' : 'required'}></label>
      <label class="campo">Repite el PIN<input type="password" inputmode="numeric" name="pin2" autocomplete="new-password"></label>
      ${tiene ? '<p class="small muted">Deja los dos vacíos para quitar el PIN.</p>' : ''}
      <button class="btn grande">💾 Guardar PIN</button>
    </form>`, d => {
    if (d.pin !== d.pin2) { toast('Los PIN no son iguales'); return false; }
    S.config.pin = d.pin;
    guardar();
    render();
    toast(d.pin ? '🔒 PIN guardado' : 'PIN quitado');
  });
  conPin('Cambiar el PIN', pedir);
}

function vAyuda() {
  return `<img class="logo-grande" src="icons/logo.png" alt="Copycat" style="width:min(200px,55%)">
    <h2>❓ ¿Cómo se usa?</h2>
    ${eventoInstalar ? '<button class="btn verde grande" data-action="instalar" style="margin-bottom:14px">📲 Instalar la app</button>' : ''}
    <div class="tarjeta"><ol class="pasos">
      <li><b>🛒 Vender:</b> toca lo que se lleva el cliente. Si son muchas copias, tócala una vez y escribe la cantidad en el carrito.</li>
      <li><b>💵 Cobrar:</b> escribe con cuánto te pagó (o toca los billetes). La app te dice <b>cuánto cambio dar</b> y con qué billetes y monedas.</li>
      <li><b>📒 Fiado:</b> si el cliente paga después, toca <b>Fiado</b> y elige su nombre. Cuando te pague, ve a 📒 Fiado, toca su nombre y luego <b>Pagó</b>.</li>
      <li><b>📦 Inventario:</b> cuando llegue mercancía toca 📥 y escribe cuántas piezas llegaron. La app avisa cuando algo se está acabando.</li>
      <li><b>🧮 Precios:</b> si compras algo nuevo, la calculadora te dice a cuánto venderlo para ganar.</li>
      <li><b>💼 Dinero:</b> lo que costó lo que vendes va al <b>sobre de INVERSIÓN</b> (para recuperar lo invertido y volver a surtir) y el resto al <b>sobre de GANANCIA</b>. Ahí ves cuánto se invirtió y cuánto falta por recuperar.</li>
      <li><b>🌙 Cerrar el día:</b> al terminar, ve a 📊 Mi día y toca <b>Cerrar el día</b>. Cuenta el dinero de la caja, reparte el dinero en los dos sobres y se guarda el respaldo.</li>
    </ol></div>
    <div class="tarjeta">
      <h3>⭐ Reglas de oro del negocio</h3>
      <ul class="lista">
        <li><span class="em">📝</span><div class="info">Registra <b>todas</b> las ventas, hasta la de $1. Si no, la caja no cuadra.</div></li>
        <li><span class="em">🪙</span><div class="info">Cuenta el cambio dos veces antes de darlo, y deja el billete del cliente afuera hasta terminar.</div></li>
        <li><span class="em">🤝</span><div class="info">Fía solo a gente de confianza, y no a quien ya debe mucho.</div></li>
        <li><span class="em">💾</span><div class="info">Cierra el día siempre y manda el respaldo a un adulto.</div></li>
        <li><span class="em">❓</span><div class="info">Si te equivocas en una venta, pide a un adulto cancelarla en 📊 Mi día.</div></li>
      </ul>
    </div>
    <div class="tarjeta"><h3>📴 ¿Sin internet?</h3><p class="muted">No pasa nada: la app funciona igual. Todo se guarda en este dispositivo.</p></div>`;
}

/* ---------- Vistas ---------- */
const VISTAS = { vender: vVender, inventario: vInventario, fiado: vFiado, dinero: vDinero, calculadora: vCalculadora, hoy: vHoy, ajustes: vAjustes, ayuda: vAyuda };
const DESPUES = {
  calculadora: pintarCalc,
  ajustes: () => {
    pintarAjustes();
    $('#form-negocio').onsubmit = e => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target));
      Object.assign(S.config, { negocio: d.negocio.trim(), horaCierre: d.horaCierre, fondo: aCent(d.fondo), limiteFiado: aCent(d.limiteFiado) });
      guardar();
      render();
      toast('✅ Guardado');
    };
  },
};

/* ---------- Acciones (clics) ---------- */
const ACC = {
  ir: el => ir(el.dataset.vista),
  'cerrar-modal': cerrarModal,
  'filtro-venta': el => { filtroVenta.tipo = el.dataset.tipo; render(); },
  agregar: el => agregar(el.dataset.id),
  menos: el => cambiarCant(+el.dataset.i, carrito[+el.dataset.i].cant - 1),
  mas: el => cambiarCant(+el.dataset.i, carrito[+el.dataset.i].cant + 1),
  vaciar: () => { carrito = []; carritoAbierto = false; pintarVenta(); },
  'toggle-carrito': () => { carritoAbierto = !carritoAbierto; pintarVenta(); },
  'cobro-libre': cobroLibre,
  cobrar: modalCobrar,
  fiar: modalFiar,
  'filtro-inv': el => { filtroInv = el.dataset.tipo; render(); },
  'nuevo-producto': () => conPin('Crear un producto', () => formProducto(null)),
  'editar-producto': el => conPin('Cambiar un producto', () => formProducto(prod(el.dataset.id))),
  resurtir: el => modalResurtir(prod(el.dataset.id)),
  'ver-paquete': modalPaquete,
  'ocultar-paquete': () => { S.config.ocultarPaquete = true; guardar(); render(); },
  'nuevo-cliente': () => formCliente(null),
  'ver-cliente': el => verCliente(cliente(el.dataset.id)),
  'editar-cliente': el => formCliente(cliente(el.dataset.id)),
  abonar: el => modalAbono(cliente(el.dataset.id)),
  'calc-modo': el => { calc.modo = el.dataset.modo; render(); },
  'calc-pct': el => { calc[el.dataset.k] = Number(el.dataset.n); render(); },
  'calc-crear': crearDesdeCalc,
  'calc-aplicar': aplicarDesdeCalc,
  'calc-redondeo': el => { calc.redondeo = el.dataset.r; pintarCalc(); },
  // Borra los datos de la calculadora que se está usando (las demás no se tocan)
  'calc-limpiar': () => {
    const campos = { vender: { compra: '', piezas: '1', extra: '', pct: 50 },
      copia: { paquete: '', hojas: '', toner: '', rinde: '', otros: '', pctCopia: 150 },
      ganancia: { precio: '', costo: '' } }[calc.modo];
    Object.assign(calc, campos);
    render();
    $('#calc-form input')?.focus();
  },
  aporte: () => modalAporte(),
  'aporte-inicial': () => modalAporte({ concepto: 'Inversión inicial', monto: infoInversion().mercancia, uso: 'mercancia' }),
  compra: modalCompra,
  retiro: modalRetiro,
  'borrar-dinero': el => conPin('Borrar un movimiento de dinero', () => confirmar('🗑️ Borrar movimiento', '¿Borrar este movimiento? Los sobres se recalculan.', () => {
    S.dinero = S.dinero.filter(m => m.id !== el.dataset.id);
    guardar();
    render();
  }, { boton: 'Sí, borrar' })),
  dia: el => { diaSel = sumarDias(diaSel, +el.dataset.n); if (diaSel > hoyISO()) diaSel = hoyISO(); render(); },
  'cerrar-dia': () => modalCierre(diaSel),
  'cancelar-venta': el => cancelarVenta(S.ventas.find(v => v.id === el.dataset.id)),
  csv: exportarCSV,
  'guardar-respaldo': async () => {
    const donde = await guardarArchivo();
    toast(donde === 'carpeta' ? '💾 Guardado en tu carpeta' : donde === 'descarga' ? '💾 Descargado (revisa Descargas)' : '⚠️ No se pudo guardar');
    if (vista === 'ajustes') render();
  },
  'compartir-respaldo': compartirRespaldo,
  importar: importarArchivo,
  'restaurar-interno': async el => {
    const r = (await DB.respaldos()).find(x => x.id === el.dataset.id);
    if (r) restaurar(r.datos, `${fechaCorta(r.dia)} ${hora(r.fecha)}`);
  },
  'elegir-carpeta': async () => {
    try {
      const dir = await window.showDirectoryPicker({ id: 'respaldos-copias', mode: 'readwrite' });
      await DB.set('carpeta', dir);
      toast(`📁 Los respaldos se guardarán en "${esc(dir.name)}"`);
      pintarAjustes();
    } catch (e) { if (e.name !== 'AbortError') toast('No se pudo usar esa carpeta'); }
  },
  'quitar-carpeta': async () => { await DB.del('carpeta'); pintarAjustes(); },
  pin: modalPin,
  instalar: async () => {
    if (!eventoInstalar) return;
    eventoInstalar.prompt();
    await eventoInstalar.userChoice;
    eventoInstalar = null;
    render();
  },
  'borrar-todo': () => conPin('Borrar todo', () => abrirModal(`${cab('🧨 Borrar todo')}
    <p>Se borrarán productos, ventas, clientes y fiados. <b>No se puede deshacer</b> (pero queda un respaldo interno).</p>
    <form><label class="campo">Escribe BORRAR para confirmar<input type="text" name="ok" autocomplete="off" required autofocus></label>
    <button class="btn rojo grande">Borrar todo</button></form>`, async d => {
    if (d.ok.trim().toUpperCase() !== 'BORRAR') { toast('Escribe BORRAR'); return false; }
    await respaldoInterno('Antes de borrar todo');
    S = nuevoEstado();
    S.config.bienvenida = true;
    carrito = [];
    await guardar();
    ir('inventario');
  })),
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el) {
    const fn = ACC[el.dataset.action];
    if (fn) { e.preventDefault(); fn(el, e); }
    return;
  }
  if (e.target.id === 'modal') cerrarModal();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) cerrarModal(); });
document.addEventListener('input', e => {
  if (e.target.id === 'buscar') { filtroVenta.texto = e.target.value; $('#productos').innerHTML = tilesHTML(); }
  if (e.target.dataset.k && vista === 'calculadora') {
    calc[e.target.dataset.k] = e.target.value;
    if (e.target.type === 'number' && e.target.closest('.chips')) $$('.chip', e.target.closest('.chips')).forEach(c => c.classList.toggle('activo', c.dataset.n === e.target.value));
    pintarCalc();
  }
});
document.addEventListener('change', e => {
  if (e.target.classList.contains('in-cant')) cambiarCant(+e.target.dataset.i, entero(e.target.value));
});

/* ---------- Recordatorio de cierre del día ---------- */
let diaActual = hoyISO();
let avisoMostrado = '';
function hayMovimientos(dia) {
  return S.ventas.some(v => v.dia === dia) || S.clientes.some(c => c.movs.some(m => m.tipo === 'abono' && m.dia === dia));
}
function revisarHoraCierre() {
  if (!S) return;
  const hoy = hoyISO();
  if (hoy !== diaActual) { diaActual = hoy; diaSel = hoy; revisarDiasSinCerrar(); render(); return; }
  const [h, m] = (S.config.horaCierre || '19:00').split(':').map(Number);
  const ahora = new Date();
  const yaEsHora = ahora.getHours() * 60 + ahora.getMinutes() >= h * 60 + m;
  const pendiente = yaEsHora && !cierreDe(hoy) && hayMovimientos(hoy);
  const aviso = $('#aviso-cierre');
  aviso.hidden = !pendiente;
  if (pendiente) aviso.innerHTML = `<span>🌙 Ya es hora de cerrar el día</span><button data-action="cerrar-hoy">Cerrar día</button>`;
  if (pendiente && avisoMostrado !== hoy && $('#modal').hidden && !carrito.length) {
    avisoMostrado = hoy;
    abrirModal(`<div class="centro"><div style="font-size:3.5rem">🌙</div><h2>¡Ya son las ${esc(S.config.horaCierre)}!</h2>
      <p>Cuando termines de atender, cierra el día: cuentas la caja y se guarda el respaldo.</p>
      <div class="botones"><button type="button" class="btn gris" data-action="cerrar-modal">Más tarde</button>
      <button type="button" class="btn" data-action="cerrar-hoy">Cerrar ahora</button></div></div>`);
  }
}
ACC['cerrar-hoy'] = () => { cerrarModal(); diaSel = hoyISO(); ir('hoy'); modalCierre(diaSel); };

// Si un día con ventas no se cerró, se cierra solo y se pide guardar el archivo
async function revisarDiasSinCerrar() {
  const hoy = hoyISO();
  const dias = [...new Set(S.ventas.map(v => v.dia))].filter(d => d < hoy && !cierreDe(d)).sort();
  if (!dias.length) return;
  for (const dia of dias) {
    const { top, ...totales } = resumenDia(dia);
    const rep = repartoDia(dia);
    S.cierres.push({ dia, fecha: new Date().toISOString(), auto: true, ...totales, aInversion: rep.inversion, aGanancia: rep.ganancia, fondo: S.config.fondo, debe: S.config.fondo + totales.entro, contado: null, diferencia: null });
  }
  await guardar();
  await respaldoInterno('Cierre automático');
  const ultimo = dias[dias.length - 1];
  if ((S.config.ultimoArchivo || '') < ultimo) {
    abrirModal(`<div class="centro"><div style="font-size:3.5rem">💾</div><h2>No se cerró el día</h2>
      <p>${dias.length === 1 ? `El <b>${fechaLarga(ultimo).toLowerCase()}</b> no se cerró.` : `${dias.length} días no se cerraron.`}
      Ya lo cerré yo y guardé un respaldo dentro de la app. Ahora guarda también el archivo de respaldo.</p>
      <button type="button" class="btn grande" data-action="respaldo-pendiente">💾 Guardar respaldo</button>
      <button type="button" class="btn gris grande" data-action="cerrar-modal" style="margin-top:10px">Ahora no</button></div>`);
  }
}
ACC['respaldo-pendiente'] = async () => {
  const donde = await guardarArchivo();
  terminado(donde);
};

/* ---------- Bienvenida ---------- */
function bienvenida() {
  abrirModal(`<div class="centro"><img class="logo-grande" src="icons/logo.png" alt="Copycat"><h2>¡Bienvenido a tu negocio!</h2>
    <p class="muted">Esta app te ayuda a vender, dar cambio, llevar el inventario y los fiados. Funciona sin internet.</p></div>
    <form>
      <label class="campo">¿Cómo se llama tu negocio?<input type="text" name="negocio" maxlength="40" required value="Copycat"></label>
      <div class="opciones">
        <label><input type="radio" name="inicio" value="ejemplos" checked> 📋 Empezar con productos de ejemplo (copias, impresiones, lápices…) y cambiar los precios</label>
        <label><input type="radio" name="inicio" value="vacio"> ✨ Empezar sin productos</label>
      </div>
      <button class="btn grande" style="margin-top:14px">¡Empezar! 🚀</button>
    </form>`, d => {
    S.config.negocio = d.negocio.trim();
    S.config.bienvenida = true;
    if (d.inicio === 'ejemplos') S.productos = ejemplos();
    guardar();
    ir(d.inicio === 'ejemplos' ? 'vender' : 'inventario');
    toast(d.inicio === 'ejemplos' ? '👉 Revisa los precios en 📦 Inventario' : '👉 Agrega tu primer producto con ➕ Nuevo', 4000);
  });
}

/* ---------- Conexión ---------- */
function pintarRed() {
  $('#estado-red').textContent = navigator.onLine ? '🟢 En línea' : '📴 Sin internet';
}
window.addEventListener('online', pintarRed);
window.addEventListener('offline', pintarRed);

/* ---------- Inicio ---------- */
(async function iniciar() {
  try {
    await DB.abrir();
    const guardado = await DB.get('estado');
    S = guardado ? migrar(guardado) : nuevoEstado();
  } catch (e) {
    console.error(e);
    S = nuevoEstado();
    toast('⚠️ No se pudo abrir el almacenamiento. Los datos no se guardarán.', 6000);
  }
  navigator.storage?.persist?.();
  pintarRed();
  render();
  if (!S.config.bienvenida) bienvenida();
  else {
    await respaldoDiario();
    await revisarDiasSinCerrar();
  }
  setInterval(revisarHoraCierre, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) revisarHoraCierre(); });
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
  }
})();
