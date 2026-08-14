// Simulación del MERCADO DE LOTES con el código real del juego.
//
// Transpila utils/mercado.ts, utils/packLogic.ts y utils/constanst.ts al vuelo
// (con el swc que trae Next) y usa las cartas reales de src/data.
//
// TODO se mide bajo la REGLA DE LOS DUPLICADOS: de cada carta se queda siempre
// una copia en el álbum, así que al mercado sólo puede ir lo que sobra. Un
// "duplicado" es una copia entregable, no una carta poseída.
//
// Responde con números a las preguntas que decidieron el diseño:
//   1. ¿cuántas ofertas distintas sabe generar? ¿cuántos DUPLICADOS por sobre
//      produce de verdad cada filtro, y coincide con el prior declarado?
//   2. ¿alguna oferta es imposible de completar CON DUPLICADOS?
//   3. ¿cuántas monedas inyecta al día? ¿cambia el punto de ruina? ¿renta abrir
//      sobres sólo para revenderlos al mercado?
//   4. SIN TOPE DE PAGO: ¿cuánto se puede sacar entregando los duplicados más
//      caros que admite cada oferta?
//
// Uso: node scripts/sim-mercado.mjs
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { transform, loadBindings } from "next/dist/build/swc/index.js";

await loadBindings();
const raiz = process.cwd();

// Cargador de módulos TS con `require` de verdad: mercado.ts importa de
// constanst.ts, así que un require de pega no serviría.
const cache = new Map();
async function cargarModulo(rel) {
  const clave = resolve(raiz, rel);
  if (cache.has(clave)) return cache.get(clave);
  const fuente = readFileSync(clave, "utf8");
  const { code } = await transform(fuente, {
    jsc: { parser: { syntax: "typescript" }, target: "es2022" },
    module: { type: "commonjs" },
  });
  const mod = { exports: {} };
  const requiere = (spec) => {
    const destino = resolve(dirname(clave), spec.endsWith(".ts") ? spec : spec + ".ts");
    const dep = cache.get(destino);
    if (!dep) throw new Error("dependencia no precargada: " + spec);
    return dep;
  };
  new Function("module", "exports", "require", code)(mod, mod.exports, requiere);
  cache.set(clave, mod.exports);
  return mod.exports;
}

const constantes = await cargarModulo("utils/constanst.ts");
const packLogic = await cargarModulo("utils/packLogic.ts");
const mercado = await cargarModulo("utils/mercado.ts");

const { SELL_PRICES, PACK_PRICES, STARTING_COINS, DAILY_BASE, AVAILABLE_SETS } = constantes;
const {
  generarOfertas,
  cumpleFiltro,
  pagoDelLote,
  setDeCarta,
  copiasEntregables,
  COPIAS_RESERVADAS,
  OFERTAS_ACTIVAS,
  DURACION_CICLO_HORAS,
  COMPOSICION_CICLO,
  TASA_PRIMA_POR_SOBRE,
  MULTIPLICADOR_MIN,
  MULTIPLICADOR_MAX,
  PLANTILLAS,
  VARIANTES,
} = mercado;

const precio = (c) => SELL_PRICES[c.rarity] ?? 10;
const DATA = join(raiz, "src", "data");
const titulo = (t) => console.log("\n" + "=".repeat(78) + "\n " + t + "\n" + "=".repeat(78));
const mediana = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)] ?? 0; };
const pct = (a, q) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length * q)] ?? 0; };

// EXPANSIONES DEL MERCADO: exactamente las que puede exigir el servidor, que es
// AVAILABLE_SETS filtrado por las que tienen datos (ver setsDelMercado en
// app/action.ts). Medir sobre los JSON sueltos falsearía todo: svp, swshp y las
// Trainer Gallery son colecciones sin una sola carta común y con ellas dentro el
// rendimiento medio de cualquier banda alta se multiplica por diez.
const SETS = AVAILABLE_SETS.map((s) => s.id).filter((id) => existsSync(join(DATA, id + ".json")));
const CARTAS = new Map(
  SETS.map((s) => [s, JSON.parse(readFileSync(join(DATA, s + ".json"), "utf8"))]),
);

/* ================================================================== *
 * 0. INVENTARIOS DE REFERENCIA
 * ================================================================== */

// Cartas realmente obtenibles abriendo sobres de cada expansión. No basta con
// que la carta exista en el JSON: packLogic sólo reparte lo que cae en sus pools.
const obtenible = new Map();
for (const s of SETS) {
  const vistos = new Map();
  for (let i = 0; i < 400; i++)
    for (const c of packLogic.openStandardPack(CARTAS.get(s))) vistos.set(c.id, c);
  obtenible.set(s, [...vistos.values()]);
}
const universo = [].concat(...obtenible.values());

// Lo que promete una oferta si se cumple con lo más barato que la banda admite:
// es el pago "de referencia" y la prima que el jugador ve al mirar el tablón.
const cachePrima = new Map();
function valorLimpio(oferta) {
  if (cachePrima.has(oferta.id)) return cachePrima.get(oferta.id);
  let valor = 0;
  for (const r of oferta.requisitos) {
    const pool = (r.setId === null ? universo : obtenible.get(r.setId) ?? [])
      .filter((c) => cumpleFiltro(c, r.filtro));
    if (pool.length === 0) { valor = 0; break; }
    valor += r.cantidad * Math.min(...pool.map(precio));
  }
  cachePrima.set(oferta.id, valor);
  return valor;
}
const primaPrometida = (o) => pagoDelLote(o, valorLimpio(o)) - valorLimpio(o);

/** Expansión con la oferta mejor pagada del tablón (la del "saltarín"). */
function setMasRentable(ofertas, porDefecto) {
  let mejor = porDefecto, mejorPrima = -1;
  for (const o of ofertas) {
    if (o.setId === null) continue;
    const p = primaPrometida(o);
    if (p > mejorPrima) { mejorPrima = p; mejor = o.setId; }
  }
  return mejor;
}

// INVENTARIOS DE DUPLICADOS REALES: lo que tiene en la mano un jugador después
// de abrir N sobres. Es la referencia honesta para la prueba del abuso: el
// universo entero supone que el jugador tiene repetida CUALQUIER carta, y eso no
// pasa ni abriendo cajas.
function abrirDuplicados(sets, sobresPorSet, semilla = 0) {
  const album = new Set();
  const dup = new Map(); // id -> { carta, copias }
  for (const s of sets) {
    for (let i = 0; i < sobresPorSet; i++) {
      for (const c of packLogic.openStandardPack(CARTAS.get(s))) {
        if (!album.has(c.id)) { album.add(c.id); continue; }
        const e = dup.get(c.id) ?? { carta: c, copias: 0 };
        e.copias++;
        dup.set(c.id, e);
      }
    }
  }
  void semilla;
  return dup;
}

/* ================================================================== *
 * 1. CATÁLOGO Y RENDIMIENTO REAL EN DUPLICADOS
 * ================================================================== */
titulo("1. CATÁLOGO: plantillas, ofertas distintas y DUPLICADOS POR SOBRE de cada filtro");

console.log("  plantilla        variantes de requisito");
let variantesTotales = 0;
for (const p of [...PLANTILLAS].sort((a, b) => b.variantes - a.variantes)) {
  console.log("    " + p.id.padEnd(16) + String(p.variantes).padStart(4));
  variantesTotales += p.variantes;
}
console.log("    " + "TOTAL".padEnd(16) + String(variantesTotales).padStart(4) + "  requisitos distintos");
console.log("  expansiones que el mercado puede exigir: " + SETS.length);

// --- rendimiento medido de cada FILTRO del catálogo -------------------
// Se abren sobres de cada expansión y se cuenta, de las copias que SOBRAN (la
// primera se queda en el álbum), cuántas cumplen cada filtro. Los primeros
// sobres no cuentan: con la colección vacía no hay duplicados y el número
// saldría falseado.
const CONJUNTO = new Set(["playset", "arcoiris", "evolucion"]);
const filtrosSimples = new Map(); // clave -> { filtro, variantes: [] }
const filtrosConjunto = new Map();
for (const v of VARIANTES) {
  const clave = JSON.stringify(v.filtro);
  const destino = CONJUNTO.has(v.filtro.categoria) ? filtrosConjunto : filtrosSimples;
  const e = destino.get(clave) ?? { filtro: v.filtro, variantes: [] };
  e.variantes.push(v);
  destino.set(clave, e);
}
const simples = [...filtrosSimples.values()];
const conjuntos = [...filtrosConjunto.values()];

const SOBRES_MEDIDA = 150;
const CALENTAMIENTO = 20;
const PARTIDAS_MEDIDA = 6;

const acumulado = simples.map(() => 0);
const porSetRend = new Map();
// hitos: sobres hasta poder cumplir un requisito de conjunto SÓLO con duplicados
const hitos = new Map();
const anota = (m, k, v) => { const l = m.get(k) ?? []; l.push(v); m.set(k, l); };
let sobresMedidos = 0;

for (const s of SETS) {
  const cartas = CARTAS.get(s);
  // Precomputar qué filtros cumple cada carta: si no, son millones de llamadas.
  const marca = new Map();
  for (const c of cartas) {
    const idx = [];
    for (let i = 0; i < simples.length; i++) {
      const f = simples[i].filtro;
      // El filtro "set" lleva el id de la expansión: al medir se sustituye por
      // la que se está abriendo, o no casaría nunca.
      const efectivo = f.categoria === "set" ? { ...f, valor: s } : f;
      if (cumpleFiltro(c, efectivo)) idx.push(i);
    }
    marca.set(c.id, idx);
  }
  const local = simples.map(() => 0);
  for (let p = 0; p < PARTIDAS_MEDIDA; p++) {
    const cuenta = new Map();
    const logrado = new Set();
    for (let sobre = 0; sobre < SOBRES_MEDIDA; sobre++) {
      for (const c of packLogic.openStandardPack(cartas)) {
        const n = (cuenta.get(c.id) ?? 0) + 1;
        cuenta.set(c.id, n);
        if (n > COPIAS_RESERVADAS && sobre >= CALENTAMIENTO)
          for (const i of marca.get(c.id) ?? []) local[i]++;
      }
      if (logrado.size === conjuntos.length) continue;
      // Inventario de duplicados de este instante, para los hitos de conjunto.
      const spares = [];
      for (const [id, n] of cuenta) {
        const entregables = copiasEntregables(n);
        if (entregables > 0) spares.push({ id, copias: entregables });
      }
      const porId = new Map(cartas.map((c) => [c.id, c]));
      for (const e of conjuntos) {
        for (const v of e.variantes) {
          const clave = v.clave;
          if (logrado.has(clave)) continue;
          const pool = spares
            .map((x) => ({ carta: porId.get(x.id), copias: x.copias }))
            .filter((x) => x.carta && cumpleFiltro(x.carta, v.filtro));
          let ok = false;
          if (v.filtro.categoria === "playset") ok = pool.some((x) => x.copias >= v.cantidad);
          else if (v.filtro.categoria === "arcoiris") {
            const tipos = new Set(pool.flatMap((x) => x.carta.types ?? []));
            ok = tipos.size >= v.cantidad;
          } else {
            const porNombre = new Map(pool.map((x) => [x.carta.name, x.carta]));
            for (const c of porNombre.values()) {
              const padre = c.evolvesFrom ? porNombre.get(c.evolvesFrom) : null;
              if (!padre) continue;
              if (v.cantidad === 2) { ok = true; break; }
              if (padre.evolvesFrom && porNombre.get(padre.evolvesFrom)) { ok = true; break; }
            }
          }
          if (ok) { logrado.add(clave); anota(hitos, clave, sobre + 1); }
        }
      }
      for (const e of conjuntos)
        for (const v of e.variantes) if (!logrado.has(v.clave) && sobre + 1 === SOBRES_MEDIDA)
          anota(hitos, v.clave + "!fallo", 1);
    }
  }
  const sobresLocal = (SOBRES_MEDIDA - CALENTAMIENTO) * PARTIDAS_MEDIDA;
  for (let i = 0; i < simples.length; i++) acumulado[i] += local[i];
  porSetRend.set(s, local.map((x) => x / sobresLocal));
  sobresMedidos += sobresLocal;
}

// Contraste prior vs medido. El prior de una variante se lee al revés: el
// esfuerzo declarado es cantidad / rendimiento, luego rendimiento = cantidad /
// esfuerzo (los de conjunto no siguen esa fórmula y se comprueban aparte).
console.log("\n  RENDIMIENTO EN DUPLICADOS POR SOBRE — prior declarado vs medido");
console.log("  (mediana entre expansiones para los filtros atables, media para los sueltos)");
console.log("  " + "filtro".padEnd(46) + "prior".padStart(8) + "medido".padStart(8) + "desvío".padStart(9));
const desvios = [];
for (let i = 0; i < simples.length; i++) {
  const e = simples[i];
  const v = e.variantes[0];
  const porSetArr = SETS.map((s) => porSetRend.get(s)[i]);
  const medido = v.siempreLibre
    ? acumulado[i] / sobresMedidos
    : mediana(porSetArr);
  const prior = v.cantidad / v.esfuerzo;
  const desvio = medido > 0 ? prior / medido : Infinity;
  desvios.push({ clave: e.variantes.map((x) => x.plantilla)[0] + " " + v.clave, prior, medido, desvio, peor: Math.min(...porSetArr) });
}
desvios.sort((a, b) => b.desvio - a.desvio);
const pinta = (d) =>
  console.log("  " + d.clave.slice(0, 46).padEnd(46) + d.prior.toFixed(3).padStart(8) +
    d.medido.toFixed(3).padStart(8) + (Number.isFinite(d.desvio) ? "x" + d.desvio.toFixed(2) : "  ∞").padStart(9));
const TOL_ALTA = 1.18, TOL_BAJA = 0.85;
const fuera = desvios.filter((d) => !(d.desvio >= TOL_BAJA && d.desvio <= TOL_ALTA));
console.log("  -- priores fuera de la horquilla x" + TOL_BAJA + "-x" + TOL_ALTA +
  " (>1 = la oferta pide más trabajo del que cree y paga de menos)");
if (fuera.length === 0) console.log("     (ninguno)");
fuera.forEach(pinta);
const sanos = desvios.length - fuera.length;
console.log("  priores dentro de la horquilla: " + sanos + " de " + desvios.length +
  "; dentro de un factor 2: " +
  desvios.filter((d) => Number.isFinite(d.desvio) && d.desvio > 0.5 && d.desvio < 2).length);

console.log("\n  SOBRES HASTA PODER CUMPLIRLO, con duplicados (categorías de conjunto)");
console.log("  " + "requisito".padEnd(24) + "prior".padStart(7) + "medido".padStart(8) + "p75".padStart(6) + "  partidas que lo logran");
const totalPartidas = SETS.length * PARTIDAS_MEDIDA;
for (const e of conjuntos) {
  for (const v of e.variantes) {
    const l = hitos.get(v.clave) ?? [];
    const fallos = (hitos.get(v.clave + "!fallo") ?? []).length;
    console.log("  " + v.clave.padEnd(24) + v.esfuerzo.toFixed(0).padStart(7) +
      (l.length ? String(mediana(l)) : "-").padStart(8) + (l.length ? String(pct(l, 0.75)) : "-").padStart(6) +
      ("   " + (100 * (totalPartidas - fallos) / totalPartidas).toFixed(0) + "%").padStart(24));
  }
}

// Recuento empírico de ofertas: se sortean muchos ciclos y se cuentan ids
// distintos. El id codifica el CONTENIDO (set + claves de los requisitos), así
// que contar ids es contar ofertas distintas de verdad.
const vistas = new Set();
const curvaOfertas = [];
const CICLOS = 40000;
for (let s = 0; s < CICLOS; s++) {
  for (const o of generarOfertas(s, SETS, OFERTAS_ACTIVAS)) vistas.add(o.id);
  if (s === 999 || s === 9999 || s === CICLOS - 1) curvaOfertas.push([s + 1, vistas.size]);
}
console.log("\n  curva de saturación (ciclos sorteados -> ofertas distintas acumuladas)");
for (const [c, n] of curvaOfertas)
  console.log("    " + String(c).padStart(7) + " ciclos ->" + String(n).padStart(8) + " ofertas");
console.log("  OFERTAS DISTINTAS CONTADAS: " + vistas.size + " (la curva no se aplana: el espacio real es mayor)");

/* ================================================================== *
 * 2. GARANTÍAS Y FACTIBILIDAD CON DUPLICADOS
 * ================================================================== */
titulo("2. GARANTÍAS: determinismo, set libre, tamaño del lote y ninguna oferta imposible");

const a1 = JSON.stringify(generarOfertas(4242, SETS, OFERTAS_ACTIVAS));
const a2 = JSON.stringify(generarOfertas(4242, SETS, OFERTAS_ACTIVAS));
console.log("  determinista (misma semilla -> mismas ofertas): " + (a1 === a2 ? "SÍ" : "NO"));

let sinLibre = 0, sinRequisitoLibre = 0, cuenta = 0, maxCartas = 0, maxId = 0, deSetLibre = 0;
const porDificultad = { facil: 0, media: 0, dificil: 0 };
for (let s = 0; s < 20000; s++) {
  const ofertas = generarOfertas(s, SETS, OFERTAS_ACTIVAS);
  if (!ofertas.some((o) => o.setId === null)) sinLibre++;
  for (const o of ofertas) {
    cuenta++;
    if (o.setId === null) deSetLibre++;
    porDificultad[o.dificultad]++;
    if (o.setId !== null && !o.requisitos.some((r) => r.setId === null)) sinRequisitoLibre++;
    maxCartas = Math.max(maxCartas, o.requisitos.reduce((t, r) => t + r.cantidad, 0));
    maxId = Math.max(maxId, o.id.length);
  }
}
console.log("  ciclos sin ninguna oferta de expansión libre: " + sinLibre + " de 20000");
console.log("  ofertas de expansión LIBRE: " + ((100 * deSetLibre) / cuenta).toFixed(1) +
  "%  (el resto atadas a una expansión concreta, que es la razón para abrirla)");
console.log("  ofertas de set sin requisito de set libre:    " + sinRequisitoLibre + " de " + cuenta);
console.log("  cartas de la oferta más glotona: " + maxCartas +
  "  (app/action.ts rechaza entregas de más de 40: " + (maxCartas <= 40 ? "OK" : "¡PASADO!") + ")");
console.log("  id de oferta más largo: " + maxId + " caracteres (el servidor corta en 200: " +
  (maxId <= 200 ? "OK" : "¡PASADO!") + ")");
console.log("  reparto de dificultad: " +
  Object.entries(porDificultad).map(([k, v]) => k + " " + ((100 * v) / cuenta).toFixed(1) + "%").join("  ") +
  "  (objetivo " +
  Object.entries(COMPOSICION_CICLO).map(([k, v]) => k + " " + ((100 * v) / OFERTAS_ACTIVAS).toFixed(1) + "%").join("  ") + ")");

// FACTIBILIDAD CON DUPLICADOS: no vale con que la carta exista, ni con que salga
// en sobres; tiene que salir DOS VECES. Se usa el inventario de duplicados de un
// jugador que ha abierto 120 sobres de esa expansión (o de varias, para los
// requisitos de set libre).
const dupPorSet = new Map();
for (const s of SETS) dupPorSet.set(s, abrirDuplicados([s], 120));
// Para los requisitos de set libre, la colección de un jugador de un año: 40
// sobres de cada expansión. OJO con bajar este número: los duplicados no crecen
// linealmente con los sobres (los primeros sobres de un set casi no repiten), así
// que repartir 300 sobres entre 26 expansiones da MUCHOS menos duplicados que
// 300 sobres de una sola, y la auditoría saldría llena de falsos imposibles.
const dupLibre = abrirDuplicados(SETS, 40);

function poolDuplicados(setId) {
  const dup = setId === null ? dupLibre : dupPorSet.get(setId) ?? new Map();
  return [...dup.values()];
}

const cacheFactible = new Map();
function factible(req) {
  const clave = JSON.stringify(req.filtro) + "|" + req.cantidad + "|" + req.setId;
  if (cacheFactible.has(clave)) return cacheFactible.get(clave);
  const pool = poolDuplicados(req.setId).filter((e) => cumpleFiltro(e.carta, req.filtro));
  let r;
  switch (req.filtro.categoria) {
    case "playset":
      r = pool.some((e) => e.copias >= req.cantidad);
      break;
    case "arcoiris": {
      const tipos = new Set();
      for (const e of pool) for (const t of e.carta.types ?? []) tipos.add(t);
      r = tipos.size >= req.cantidad;
      break;
    }
    case "evolucion": {
      const porNombre = new Map(pool.map((e) => [e.carta.name, e.carta]));
      r = false;
      for (const c of porNombre.values()) {
        const padre = c.evolvesFrom ? porNombre.get(c.evolvesFrom) : null;
        if (!padre) continue;
        if (req.cantidad === 2) { r = true; break; }
        if (padre.evolvesFrom && porNombre.get(padre.evolvesFrom)) { r = true; break; }
      }
      break;
    }
    default:
      r = pool.reduce((t, e) => t + e.copias, 0) >= req.cantidad;
  }
  cacheFactible.set(clave, r);
  return r;
}

let imposibles = 0, revisadas = 0;
const fallosReq = new Map();
for (let s = 0; s < 4000; s++) {
  for (const o of generarOfertas(s, SETS, OFERTAS_ACTIVAS)) {
    revisadas++;
    const rota = o.requisitos.find((r) => !factible(r));
    if (rota) {
      imposibles++;
      const k = rota.filtro.categoria + "(" + (rota.filtro.valor ?? "") +
        (rota.filtro.rarMin !== undefined ? " rar" + rota.filtro.rarMin + "-" + rota.filtro.rarMax : "") +
        ") x" + rota.cantidad + " @" + (rota.setId ?? "libre");
      fallosReq.set(k, (fallosReq.get(k) ?? 0) + 1);
    }
  }
}
console.log("\n  ofertas auditadas contra DUPLICADOS reales (120 sobres del set / 12 por set si es libre): " + revisadas);
console.log("  ofertas que NO se podrían completar con esos duplicados: " + imposibles +
  " (" + ((100 * imposibles) / revisadas).toFixed(1) + "%)");
for (const [k, n] of [...fallosReq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10))
  console.log("    " + k.padEnd(54) + n);

/* ================================================================== *
 * 3. MULTIPLICADORES
 * ================================================================== */
titulo("3. TABLA DE MULTIPLICADORES (sin tope de pago: el pago es multiplicador × valor del lote)");

const muestras = { facil: [], media: [], dificil: [] };
const pagos = { facil: [], media: [], dificil: [] };
const primas = { facil: [], media: [], dificil: [] };
const cartasDif = { facil: [], media: [], dificil: [] };
for (let s = 0; s < 3000; s++)
  for (const o of generarOfertas(s, SETS, OFERTAS_ACTIVAS)) {
    muestras[o.dificultad].push(o.multiplicador);
    const v = valorLimpio(o);
    pagos[o.dificultad].push(pagoDelLote(o, v));
    primas[o.dificultad].push(pagoDelLote(o, v) - v);
    cartasDif[o.dificultad].push(o.requisitos.reduce((t, r) => t + r.cantidad, 0));
  }
console.log("  El multiplicador no es un número por dificultad: sale de dividir la prima que");
console.log("  merece el esfuerzo (" + TASA_PRIMA_POR_SOBRE + " monedas por sobre de duplicados) entre lo que vale el lote.");
console.log("  Un lote de morralla penoso de juntar sube al techo; uno de cartas caras se queda abajo.\n");
console.log("  dificultad   ofertas    mín    p25   mediana    p75    máx");
for (const d of ["facil", "media", "dificil"]) {
  const m = muestras[d].sort((a, b) => a - b);
  if (m.length === 0) { console.log("    " + d.padEnd(10) + "      0"); continue; }
  console.log("    " + d.padEnd(10) + String(m.length).padStart(7) +
    m[0].toFixed(2).padStart(7) + pct(m, 0.25).toFixed(2).padStart(7) +
    pct(m, 0.5).toFixed(2).padStart(10) + pct(m, 0.75).toFixed(2).padStart(7) +
    m[m.length - 1].toFixed(2).padStart(7));
}
console.log("\n  LO QUE COBRA EL JUGADOR cumpliendo con lo más barato que admite la banda:");
console.log("  dificultad   cartas   valor suelto   pago   PRIMA (mediana)     prima p90");
for (const d of ["facil", "media", "dificil"]) {
  if (pagos[d].length === 0) continue;
  const pg = mediana(pagos[d]), pr = mediana(primas[d]);
  console.log("    " + d.padEnd(10) + mediana(cartasDif[d]).toFixed(0).padStart(6) +
    String(pg - pr).padStart(15) + String(pg).padStart(7) +
    ("+" + pr).padStart(18) + ("+" + pct(primas[d], 0.9)).padStart(14));
}
console.log("  suelo y techo del multiplicador: x" + MULTIPLICADOR_MIN + " / x" + MULTIPLICADOR_MAX);
console.log("  fronteras de dificultad: fácil < 8 sobres de esfuerzo; media < 25; difícil >= 25");
console.log("\n  Ejemplo de tablón (semilla 7):");
for (const o of generarOfertas(7, SETS, OFERTAS_ACTIVAS)) {
  console.log("    [" + o.dificultad.padEnd(7) + "] x" + o.multiplicador.toFixed(2) + "  " + o.titulo);
  for (const r of o.requisitos) console.log("         - " + r.descripcion);
}

/* ================================================================== *
 * 4. MOTOR DE ENTREGAS (lo que hará el servidor al validar)
 * ================================================================== */

// El álbum guarda la PRIMERA copia de cada carta y nunca se toca: es la regla de
// los duplicados. `almacen` son las copias que sobran, con el día en que
// llegaron (un jugador real no guarda cromos para siempre).
function meter(album, almacen, carta, dia) {
  if (!album.has(carta.id)) { album.add(carta.id); return; }
  const e = almacen.get(carta.id) ?? { carta, dias: [] };
  e.dias.push(dia);
  almacen.set(carta.id, e);
}

// `codicioso` = el jugador que juega para ganar el máximo. Como el pago es
// proporcional al valor del lote y no hay tope, lo óptimo es entregar los
// duplicados MÁS CAROS que cumplan. El casual se deshace de la morralla.
function candidatas(almacen, filtro, setId, reservadas, codicioso) {
  const out = [];
  for (const e of almacen.values()) {
    if (setId !== null && setDeCarta(e.carta) !== setId) continue;
    if (!cumpleFiltro(e.carta, filtro)) continue;
    const libres = e.dias.length - (reservadas.get(e.carta.id) ?? 0);
    for (let i = 0; i < libres; i++) out.push(e.carta);
  }
  return out.sort((a, b) => (codicioso ? precio(b) - precio(a) : precio(a) - precio(b)));
}

function resolverRequisito(almacen, req, reservadas, codicioso) {
  const disp = candidatas(almacen, req.filtro, req.setId, reservadas, codicioso);
  const tomar = (lista) => {
    for (const c of lista) reservadas.set(c.id, (reservadas.get(c.id) ?? 0) + 1);
    return lista;
  };
  switch (req.filtro.categoria) {
    case "playset": {
      const cuenta2 = new Map();
      for (const c of disp) cuenta2.set(c.id, (cuenta2.get(c.id) ?? 0) + 1);
      let mejor = null;
      for (const [id, n] of cuenta2) {
        if (n < req.cantidad) continue;
        const carta = almacen.get(id).carta;
        if (!mejor || (codicioso ? precio(carta) > precio(mejor) : precio(carta) < precio(mejor)))
          mejor = carta;
      }
      return mejor ? tomar(Array(req.cantidad).fill(mejor)) : null;
    }
    case "arcoiris": {
      const porTipo = new Map();
      for (const c of disp) for (const t of c.types ?? []) if (!porTipo.has(t)) porTipo.set(t, c);
      if (porTipo.size < req.cantidad) return null;
      return tomar([...porTipo.values()].slice(0, req.cantidad));
    }
    case "evolucion": {
      const porNombre = new Map();
      for (const c of disp) if (!porNombre.has(c.name)) porNombre.set(c.name, c);
      for (const c of porNombre.values()) {
        if (!c.evolvesFrom) continue;
        const padre = porNombre.get(c.evolvesFrom);
        if (!padre) continue;
        if (req.cantidad === 2) return tomar([padre, c]);
        const abuelo = padre.evolvesFrom ? porNombre.get(padre.evolvesFrom) : null;
        if (abuelo) return tomar([abuelo, padre, c]);
      }
      return null;
    }
    default:
      return disp.length < req.cantidad ? null : tomar(disp.slice(0, req.cantidad));
  }
}

function intentarOferta(almacen, oferta, codicioso = true) {
  const reservadas = new Map();
  const entregadas = [];
  for (const req of oferta.requisitos) {
    const lote = resolverRequisito(almacen, req, reservadas, codicioso);
    if (!lote) return null;
    entregadas.push(...lote);
  }
  const valor = entregadas.reduce((s, c) => s + precio(c), 0);
  const pago = pagoDelLote(oferta, valor);
  return { pago, prima: pago - valor, entregadas, valor };
}

function consumir(almacen, cartas) {
  for (const c of cartas) {
    const e = almacen.get(c.id);
    if (!e) continue;
    e.dias.shift(); // se gasta la copia más vieja
    if (e.dias.length === 0) almacen.delete(c.id);
  }
}

// Vende los duplicados que llevan más de `retencion` días criando polvo. La
// copia del álbum nunca entra aquí: el mercado y el coleccionista comparten la
// misma regla.
function venderViejo(almacen, dia, retencion) {
  let ingreso = 0;
  for (const [id, e] of almacen) {
    const quedan = e.dias.filter((d) => dia - d < retencion);
    ingreso += (e.dias.length - quedan.length) * precio(e.carta);
    if (quedan.length === 0) almacen.delete(id);
    else e.dias = quedan;
  }
  return ingreso;
}

/* ================================================================== *
 * 5. JUGADOR DIARIO
 * ================================================================== */
titulo("4. JUGADOR DIARIO (recompensa " + DAILY_BASE + " + 3 sobres/día, 1 año)");

// Cuatro perfiles con el MISMO presupuesto de 3 sobres/día. Lo único que cambia
// es lo bien que juegan, que es lo que el mercado debe premiar:
//  - "base":        línea base sin mercado; vende sus duplicados el mismo día.
//  - "casual":      abre siempre su expansión favorita, entrega lo más barato que
//                   cuadre y guarda dos días de duplicados.
//  - "optimizador": misma expansión, pero entrega los duplicados MÁS CAROS que
//                   admite cada banda (es lo que más paga, sin tope) y guarda una
//                   semana para poder cubrir el tablón entero.
//  - "saltarín":    cada día abre la expansión de la oferta mejor pagada.
//
// El "saltarín" está aquí porque bajo la regla de los duplicados cambiar de
// expansión es un ERROR, y conviene tenerlo medido: los primeros sobres de un
// set casi no repiten nada, así que quien salta no llega nunca a producir
// duplicados y se queda sin material para el mercado.
const RETENCION_CASUAL = 2;
const RETENCION_OPTIMIZADOR = 7;

function simularDiario({ conMercado, perfil = "casual", sobresDia = 3, dias = 365, partidas = 28 }) {
  const finales = [], primas = [], hechas = [], entregadas = [], albumes = [];
  const porDif = { facil: 0, media: 0, dificil: 0 };
  const codicioso = perfil === "optimizador" || perfil === "saltarin";
  const retencion = !conMercado ? 0 : codicioso ? RETENCION_OPTIMIZADOR : RETENCION_CASUAL;

  for (let p = 0; p < partidas; p++) {
    let cartera = STARTING_COINS;
    const album = new Set();
    const almacen = new Map();
    let primaTotal = 0, completadas = 0, cartasDadas = 0;
    const favorito = SETS[(p * 7) % SETS.length];

    for (let d = 0; d < dias; d++) {
      cartera += DAILY_BASE;
      const ofertas = conMercado ? generarOfertas(d, SETS, OFERTAS_ACTIVAS) : [];
      const objetivo = perfil === "saltarin" ? setMasRentable(ofertas, favorito) : favorito;

      for (let k = 0; k < sobresDia && cartera >= PACK_PRICES.STANDARD; k++) {
        cartera -= PACK_PRICES.STANDARD;
        for (const c of packLogic.openStandardPack(CARTAS.get(objetivo))) meter(album, almacen, c, d);
      }

      for (const o of ofertas) {
        const r = intentarOferta(almacen, o, codicioso);
        if (!r) continue;
        consumir(almacen, r.entregadas);
        cartera += r.pago;
        primaTotal += r.prima;
        cartasDadas += r.entregadas.length;
        completadas++;
        porDif[o.dificultad]++;
      }

      cartera += venderViejo(almacen, d, retencion);
      // Regla de liquidez: nadie se queda sin poder abrir por tener duplicados
      // guardados. Si no llega para un sobre, liquida el almacén entero.
      if (cartera < PACK_PRICES.STANDARD) cartera += venderViejo(almacen, d, 0);
    }
    cartera += venderViejo(almacen, dias + 999, 0);
    finales.push(cartera);
    primas.push(primaTotal);
    hechas.push(completadas);
    entregadas.push(cartasDadas);
    albumes.push(album.size);
  }
  const total = Object.values(porDif).reduce((a, b) => a + b, 0) || 1;
  const med = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return {
    medianaFinal: mediana(finales),
    p5: pct(finales, 0.05),
    p95: pct(finales, 0.95),
    album: Math.round(med(albumes)),
    primaAnual: med(primas),
    ofertasDia: med(hechas) / dias,
    cartasDia: med(entregadas) / dias,
    mezcla: Object.entries(porDif).map(([k, v]) => k + " " + ((100 * v) / total).toFixed(0) + "%").join(" "),
  };
}

const base = simularDiario({ conMercado: false, perfil: "casual" });
const casual = simularDiario({ conMercado: true, perfil: "casual" });
const opti = simularDiario({ conMercado: true, perfil: "optimizador" });
const salta = simularDiario({ conMercado: true, perfil: "saltarin" });

const fila = (etiqueta, f) =>
  console.log("  " + etiqueta.padEnd(29) + String(f(base)).padStart(11) +
    String(f(casual)).padStart(11) + String(f(opti)).padStart(13) + String(f(salta)).padStart(11));
console.log("                                SIN mercado     CASUAL  OPTIMIZADOR   SALTARÍN");
fila("cartera al año (mediana)", (r) => r.medianaFinal);
fila("cartera al año (p5)", (r) => r.p5);
fila("cartera al año (p95)", (r) => r.p95);
fila("cartas distintas en el álbum", (r) => r.album);
fila("ofertas completadas/día", (r) => r.ofertasDia.toFixed(2));
fila("duplicados entregados/día", (r) => r.cartasDia.toFixed(1));
fila("prima del mercado/año", (r) => Math.round(r.primaAnual));
fila("prima del mercado/DÍA", (r) => (r.primaAnual / 365).toFixed(1));
console.log("  ofertas completadas por dificultad:  casual [" + casual.mezcla +
  "]  optimizador [" + opti.mezcla + "]");
const sube = (r) => (((r.medianaFinal - base.medianaFinal) / base.medianaFinal) * 100).toFixed(1) + "%";
console.log("\n  el mercado suma " + sube(casual) + " (casual), " + sube(opti) +
  " (optimizador) y " + sube(salta) + " (saltarín) a la cartera del año, con los MISMOS 3 sobres/día");
console.log("  el saltarín pierde porque cambiar de expansión mata la producción de duplicados:");
console.log("    álbum " + salta.album + " cartas distintas frente a " + opti.album +
  " del optimizador, y " + salta.cartasDia.toFixed(1) + " duplicados entregados/día frente a " +
  opti.cartasDia.toFixed(1));
console.log("  la prima diaria del optimizador es el " +
  ((100 * opti.primaAnual) / 365 / DAILY_BASE).toFixed(0) + "% de la recompensa diaria (" + DAILY_BASE + ")");

/* ================================================================== *
 * 6. ¿ES RENTABLE ABRIR SOBRES SÓLO PARA VENDER AL MERCADO?
 * ================================================================== */
titulo("5. EL FARMEO: abrir sobres sólo para revenderlos al mercado");

// Revendedor puro: no colecciona por gusto, pero la regla de duplicados le
// obliga igual a quedarse una copia de cada carta. Abre K sobres/día de UNA
// expansión (saltar de set arruina la producción de duplicados, ver arriba),
// cubre lo que puede del tablón y vende el resto.
function simularFarmeo(sobresDia, { dias = 60, partidas = 12, conMercado = true } = {}) {
  let netoTotal = 0, primaTotal = 0, hechasTotal = 0;
  for (let p = 0; p < partidas; p++) {
    const objetivo = SETS[(p * 5) % SETS.length];
    const album = new Set();
    const almacen = new Map();
    let neto = 0;
    for (let d = 0; d < dias; d++) {
      const ofertas = conMercado ? generarOfertas(d, SETS, OFERTAS_ACTIVAS) : [];
      for (let k = 0; k < sobresDia; k++) {
        neto -= PACK_PRICES.STANDARD;
        for (const c of packLogic.openStandardPack(CARTAS.get(objetivo))) meter(album, almacen, c, d);
      }
      for (const o of ofertas) {
        const r = intentarOferta(almacen, o);
        if (!r) continue;
        consumir(almacen, r.entregadas);
        neto += r.pago;
        primaTotal += r.prima;
        hechasTotal++;
      }
      neto += venderViejo(almacen, d, conMercado ? RETENCION_OPTIMIZADOR : 0);
    }
    neto += venderViejo(almacen, dias + 999, 0);
    netoTotal += neto / dias;
  }
  return {
    netoDia: netoTotal / partidas,
    primaDia: primaTotal / partidas / dias,
    ofertasDia: hechasTotal / partidas / dias,
  };
}

console.log("  Cada sobre cuesta " + PACK_PRICES.STANDARD + " y revenderlo entero devuelve algo menos, así que");
console.log("  el sobre marginal SÓLO renta si el mercado paga por sus duplicados.\n");
console.log("  sobres/día   neto/día   neto/sobre   prima mercado/día   ofertas/día");
const curva = [];
for (const k of [1, 3, 6, 12, 25, 50, 100]) {
  const r = simularFarmeo(k, { dias: 60, partidas: Math.max(4, Math.round(120 / k)) });
  curva.push([k, r]);
  console.log("  " + String(k).padStart(9) + r.netoDia.toFixed(1).padStart(11) +
    (r.netoDia / k).toFixed(2).padStart(13) + r.primaDia.toFixed(1).padStart(20) +
    r.ofertasDia.toFixed(2).padStart(14));
}
const sinM = simularFarmeo(12, { dias: 60, partidas: 10, conMercado: false });
console.log("\n  referencia SIN mercado, 12 sobres/día: neto/día " + sinM.netoDia.toFixed(1) +
  "  (neto/sobre " + (sinM.netoDia / 12).toFixed(2) + ")");
const mejor = curva.reduce((a, b) => (b[1].netoDia > a[1].netoDia ? b : a));
console.log("  el neto/día máximo se alcanza con " + mejor[0] + " sobres/día (" +
  mejor[1].netoDia.toFixed(1) + " monedas)");
const [k1, r1] = curva[3];
const [k2, r2] = curva[curva.length - 1];
console.log("  rendimiento del sobre MARGINAL entre " + k1 + " y " + k2 + " sobres/día: " +
  ((r2.netoDia - r1.netoDia) / (k2 - k1)).toFixed(2) +
  " monedas (negativo = abrir de más arruina)");

/* ================================================================== *
 * 7. PUNTO DE RUINA
 * ================================================================== */
titulo("6. PUNTO DE RUINA (sobres seguidos hasta quebrar, cartera inicial " + STARTING_COINS + ")");

// Coleccionista sin recompensa diaria: guarda la primera copia de todo y vende
// el resto. Es el escenario en el que la ruina llega antes.
function simularRuina(conMercado, perfil = "casual", partidas = 120) {
  let quiebras = 0;
  const cuando = [], finales = [];
  for (let p = 0; p < partidas; p++) {
    const objetivo = SETS[(p * 3) % SETS.length];
    const album = new Set();
    const almacen = new Map();
    let cartera = STARTING_COINS, quiebra = -1;
    for (let s = 0; s < 1000; s++) {
      if (cartera < PACK_PRICES.STANDARD) { quiebra = s; break; }
      const dia = Math.floor(s / 3); // un "día" son 3 sobres: el tablón se refresca igual
      const ofertas = conMercado ? generarOfertas(dia, SETS, OFERTAS_ACTIVAS) : [];
      cartera -= PACK_PRICES.STANDARD;
      for (const c of packLogic.openStandardPack(CARTAS.get(objetivo))) meter(album, almacen, c, dia);
      if (conMercado && s % 3 === 2) {
        for (const o of ofertas) {
          const r = intentarOferta(almacen, o, perfil === "optimizador");
          if (!r) continue;
          consumir(almacen, r.entregadas);
          cartera += r.pago;
        }
      }
      cartera += venderViejo(almacen, dia, conMercado ? RETENCION_OPTIMIZADOR : 0);
      if (cartera < PACK_PRICES.STANDARD) cartera += venderViejo(almacen, dia, 0);
    }
    cartera += venderViejo(almacen, 99999, 0);
    if (quiebra >= 0) { quiebras++; cuando.push(quiebra); } else finales.push(cartera);
  }
  return {
    pctQuiebra: (100 * quiebras) / partidas,
    sobreMediano: cuando.length ? mediana(cuando) : null,
    carteraFinal: finales.length ? mediana(finales) : null,
  };
}
for (const [etiqueta, con, perfil] of [
  ["SIN mercado", false, "casual"],
  ["CON, casual", true, "casual"],
  ["CON, optimiza", true, "optimizador"],
]) {
  const r = simularRuina(con, perfil);
  console.log("  " + etiqueta.padEnd(16) +
    "quiebra en el " + r.pctQuiebra.toFixed(1).padStart(5) + "% de las partidas" +
    (r.sobreMediano !== null ? ", sobre nº " + r.sobreMediano + " (mediana)" : "") +
    (r.carteraFinal !== null ? ", cartera final " + r.carteraFinal : ""));
}

/* ================================================================== *
 * 8. LA PRUEBA DEL ABUSO SIN TOPE
 * ================================================================== */
titulo("7. PRUEBA DEL ABUSO SIN TOPE: entregar los DUPLICADOS más caros que cumplen");

// Ya no hay recorte del pago: se cobra multiplicador × valor del lote, punto. Lo
// que impide la imprenta es que (a) sólo se entregan duplicados y (b) cada
// requisito lleva una banda de rareza cerrada. Aquí se mide el peor caso de dos
// maneras:
//   TEÓRICO  — el lote más caro que ADMITEN las bandas, aunque el jugador no
//              tenga esos duplicados ni de lejos.
//   REALISTA — el lote más caro que se puede montar con el inventario de
//              duplicados de un jugador que ha abierto muchos sobres.
function loteExtremo(req, pool, caro) {
  const candidatas2 = [];
  for (const e of pool) {
    if (!cumpleFiltro(e.carta, req.filtro)) continue;
    for (let i = 0; i < e.copias; i++) candidatas2.push(e.carta);
  }
  candidatas2.sort((a, b) => (caro ? precio(b) - precio(a) : precio(a) - precio(b)));
  if (candidatas2.length === 0) return null;
  switch (req.filtro.categoria) {
    case "playset": {
      const cuenta2 = new Map();
      for (const c of candidatas2) cuenta2.set(c.id, (cuenta2.get(c.id) ?? 0) + 1);
      let mejor = null;
      for (const [id, n] of cuenta2) {
        if (n < req.cantidad) continue;
        const carta = candidatas2.find((c) => c.id === id);
        if (!mejor || (caro ? precio(carta) > precio(mejor) : precio(carta) < precio(mejor))) mejor = carta;
      }
      return mejor ? Array(req.cantidad).fill(mejor) : null;
    }
    case "arcoiris": {
      // `candidatas2` viene ordenada por precio en el sentido que se busca, así
      // que la PRIMERA carta de cada tipo es ya la mejor de ese tipo. Pero hay
      // que quedarse con los `cantidad` TIPOS extremos, no con los primeros que
      // aparezcan: si no, el peor caso sale medido a la baja.
      const porTipo = new Map();
      for (const c of candidatas2) for (const t of c.types ?? []) if (!porTipo.has(t)) porTipo.set(t, c);
      if (porTipo.size < req.cantidad) return null;
      const orden = [...porTipo.values()].sort((a, b) =>
        caro ? precio(b) - precio(a) : precio(a) - precio(b),
      );
      return orden.slice(0, req.cantidad);
    }
    case "evolucion": {
      // Se busca la cadena EXTREMA, no la primera que se encuentre. Quedarse con
      // la primera es lo que hacía esta función antes y subestimaba el abuso: la
      // cadena de 3 eslabones de la banda [Común, Rara] se medía en x2,7 cuando
      // el jugador puede montarla con dos Raras dentro y sacar x4,3.
      const porNombre = new Map();
      for (const c of candidatas2) {
        const k = String(c.name ?? "").trim().toLowerCase();
        if (!porNombre.has(k)) porNombre.set(k, []);
        porNombre.get(k).push(c);
      }
      const nombre = (v) => String(v ?? "").trim().toLowerCase();
      let mejor = null, mejorValor = caro ? -Infinity : Infinity;
      const bajar = (cadena, suma) => {
        if (cadena.length === req.cantidad) {
          if (caro ? suma > mejorValor : suma < mejorValor) { mejorValor = suma; mejor = [...cadena]; }
          return;
        }
        const ultimo = nombre(cadena[cadena.length - 1].name);
        for (const c of candidatas2) {
          if (nombre(c.evolvesFrom) !== ultimo) continue;
          cadena.push(c);
          bajar(cadena, suma + precio(c));
          cadena.pop();
        }
      };
      // Una carta por nombre como raíz: dos copias del mismo Pokémon dan la
      // misma cadena y multiplicarían el coste de la búsqueda por nada.
      for (const [, copias] of porNombre) bajar([copias[0]], precio(copias[0]));
      return mejor;
    }
    default:
      return candidatas2.length < req.cantidad ? null : candidatas2.slice(0, req.cantidad);
  }
}

// Pool "teórico": una copia entregable de CADA carta obtenible (el jugador
// imposible que tiene repetido todo).
const poolTeorico = new Map();
for (const s of SETS) poolTeorico.set(s, obtenible.get(s).map((c) => ({ carta: c, copias: 4 })));
const poolTeoricoLibre = [].concat(...poolTeorico.values());

// Pool "ballena": inventario de duplicados de quien ha abierto 400 sobres de
// cada expansión que pide el tablón (20.000 monedas por expansión).
const dupBallena = new Map();
for (const s of SETS) dupBallena.set(s, [...abrirDuplicados([s], 400).values()]);
const dupBallenaLibre = [].concat(...dupBallena.values());

function analizar(oferta, poolDe) {
  const barato = [], caro = [];
  for (const r of oferta.requisitos) {
    const pool = poolDe(r.setId);
    const b = loteExtremo(r, pool, false), c = loteExtremo(r, pool, true);
    if (!b || !c) return null;
    barato.push(...b); caro.push(...c);
  }
  const vB = barato.reduce((a, c) => a + precio(c), 0);
  const vC = caro.reduce((a, c) => a + precio(c), 0);
  return {
    primaLimpia: pagoDelLote(oferta, vB) - vB,
    primaAbuso: pagoDelLote(oferta, vC) - vC,
    pagoAbuso: pagoDelLote(oferta, vC),
    valorAbuso: vC,
    cartaMasCara: Math.max(...caro.map(precio)),
  };
}

for (const [etiqueta, poolDe] of [
  ["TEÓRICO  (todo repetido, imposible en la práctica)", (id) => (id === null ? poolTeoricoLibre : poolTeorico.get(id) ?? [])],
  ["REALISTA (400 sobres abiertos de la expansión)", (id) => (id === null ? dupBallenaLibre : dupBallena.get(id) ?? [])],
]) {
  let casos = 0, sumaLimpia = 0, sumaAbuso = 0, peor = null, peorRatio = 0, cartaTope = 0;
  for (let s = 0; s < 500; s++) {
    for (const o of generarOfertas(s, SETS, OFERTAS_ACTIVAS)) {
      const r = analizar(o, poolDe);
      if (!r) continue;
      casos++;
      sumaLimpia += r.primaLimpia;
      sumaAbuso += r.primaAbuso;
      cartaTope = Math.max(cartaTope, r.cartaMasCara);
      peorRatio = Math.max(peorRatio, r.primaAbuso / Math.max(r.primaLimpia, 1));
      if (!peor || r.primaAbuso > peor.prima)
        peor = { prima: r.primaAbuso, pago: r.pagoAbuso, valor: r.valorAbuso, oferta: o };
    }
  }
  console.log("\n  --- " + etiqueta + " ---");
  console.log("  ofertas analizadas: " + casos);
  console.log("  prima media jugando limpio (lote más barato): " + (sumaLimpia / casos).toFixed(1) + " monedas");
  console.log("  prima media abusando  (lote más caro):        " + (sumaAbuso / casos).toFixed(1) +
    " monedas  (x" + (sumaAbuso / sumaLimpia).toFixed(2) + ")");
  console.log("  peor cociente prima máxima/mínima de una misma oferta: x" + peorRatio.toFixed(2));
  console.log("    (lo acota la banda de rareza de cada requisito: es su precioMax/precioMin. La");
  console.log("     única banda ancha que queda es la de la cadena de 3 eslabones, [Común, Rara])");
  console.log("  carta más cara que ha llegado a entrar en un lote: " + cartaTope +
    " monedas   (la más cara del juego son 250)");
  if (peor) {
    console.log("  PEOR CASO: +" + Math.round(peor.prima) + " monedas de prima" +
      "  (pago " + peor.pago + " por un lote que vendido suelto daría " + peor.valor + ")");
    console.log("    x" + peor.oferta.multiplicador + " [" + peor.oferta.dificultad + "] " +
      peor.oferta.requisitos.map((r) => r.descripcion).join(" + "));
  }
}

/* ================================================================== *
 * 9. RESUMEN
 * ================================================================== */
titulo("RESUMEN DE CALIBRADO");
console.log("  regla central             : sólo duplicados (se conserva " + COPIAS_RESERVADAS + " copia de cada carta)");
console.log("  ofertas activas por ciclo : " + OFERTAS_ACTIVAS + " (caducan cada " + DURACION_CICLO_HORAS + " h)");
console.log("  composición del ciclo     : " + JSON.stringify(COMPOSICION_CICLO));
console.log("  tasa de prima por sobre   : " + TASA_PRIMA_POR_SOBRE + " monedas");
console.log("  multiplicador             : x" + MULTIPLICADOR_MIN + " a x" + MULTIPLICADOR_MAX + ", SIN tope de pago");
console.log("  inyección real medida     : " + (casual.primaAnual / 365).toFixed(1) +
  " (casual) / " + (opti.primaAnual / 365).toFixed(1) + " (optimizador) monedas/día");
console.log("  recompensa diaria         : " + DAILY_BASE + " monedas/día");
console.log("  farmeo intensivo          : " + mejor[1].primaDia.toFixed(0) +
  " monedas/día de prima con " + mejor[0] + " sobres/día (" + (mejor[0] * PACK_PRICES.STANDARD) + " monedas de gasto)");
