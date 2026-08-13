// Simulación del MERCADO DE LOTES con el código real del juego.
//
// Transpila utils/mercado.ts, utils/packLogic.ts y utils/constanst.ts al vuelo
// (con el swc que trae Next) y usa las cartas reales de src/data. Responde con
// números a las preguntas que decidieron el diseño:
//   1. ¿cuántas ofertas distintas sabe generar el generador?
//   2. ¿alguna oferta es imposible en su expansión?
//   3. ¿cuántas monedas inyecta al día? ¿cambia el punto de ruina?
//      ¿se vuelve rentable abrir sobres sólo para revenderlos al mercado?
//
// Uso: node scripts/sim-mercado.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { transform, loadBindings } from "next/dist/build/swc/index.js";

await loadBindings();
const raiz = process.cwd();

// Cargador de módulos TS con `require` de verdad: mercado.ts importa de
// constanst.ts, así que el require de pega de sim-economia.mjs no serviría.
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

const { SELL_PRICES, PACK_PRICES, STARTING_COINS, DAILY_BASE } = constantes;
const {
  generarOfertas,
  cumpleFiltro,
  pagoDelLote,
  setDeCarta,
  OFERTAS_ACTIVAS,
  DURACION_CICLO_HORAS,
  COMPOSICION_CICLO,
  TECHO_PRIMA,
  TASA_PRIMA_POR_SOBRE,
  PLANTILLAS,
} = mercado;

const precio = (c) => SELL_PRICES[c.rarity] ?? 10;
const DATA = join(raiz, "src", "data");
const cartasDe = (setId) => JSON.parse(readFileSync(join(DATA, setId + ".json"), "utf8"));
const titulo = (t) => console.log("\n" + "=".repeat(76) + "\n " + t + "\n" + "=".repeat(76));
const mediana = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const pct = (a, q) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length * q)]; };

// Expansiones abribles: las que tienen fichero y cartas suficientes.
const SETS = readdirSync(DATA)
  .filter((f) => f.endsWith(".json") && f !== "all-sets.json")
  .map((f) => f.replace(".json", ""))
  .filter((s) => { try { return cartasDe(s).length >= 60; } catch { return false; } });

// Cache de cartas por set: los JSON se leen una sola vez.
const CARTAS = new Map(SETS.map((s) => [s, cartasDe(s)]));

// Para las cuentas de economía sólo valen las expansiones cuyo sobre estándar
// está bien tarifado. Las colecciones especiales (svp, swshp, las Trainer
// Gallery...) son todo carta cara y a 50 monedas ya imprimen dinero SIN
// mercado: medir el mercado sobre ellas falsearía el resultado. Es un problema
// preexistente del catálogo de sobres, no del mercado.
// 1000 sobres por set y no 200: con menos, los sets que rondan justo las 50
// monedas entran y salen de la lista entre ejecuciones y las cifras bailan.
const evDeSet = new Map();
for (const s of SETS) {
  let total = 0;
  for (let i = 0; i < 1000; i++)
    total += packLogic.openStandardPack(CARTAS.get(s)).reduce((a, c) => a + precio(c), 0);
  evDeSet.set(s, total / 1000);
}
const SETS_SANOS = SETS.filter((s) => evDeSet.get(s) <= PACK_PRICES.STANDARD);

/* ================================================================== *
 * 1. CATÁLOGO: ¿cuántas ofertas distintas sabe generar?
 * ================================================================== */
titulo("1. CATÁLOGO DE PLANTILLAS Y RECUENTO REAL DE OFERTAS");

console.log("  plantilla        variantes de requisito");
let variantesTotales = 0;
for (const p of [...PLANTILLAS].sort((a, b) => b.variantes - a.variantes)) {
  console.log("    " + p.id.padEnd(16) + String(p.variantes).padStart(4));
  variantesTotales += p.variantes;
}
console.log("    " + "TOTAL".padEnd(16) + String(variantesTotales).padStart(4) + "  requisitos distintos");
const evSanos = SETS_SANOS.reduce((a, s) => a + evDeSet.get(s), 0) / SETS_SANOS.length;
console.log("  expansiones abribles: " + SETS.length + " (bien tarifadas para sobre estándar: " + SETS_SANOS.length + ")");
console.log("  reventa media de un sobre estándar en esas " + SETS_SANOS.length + " expansiones: " +
  evSanos.toFixed(1) + " monedas de coste " + PACK_PRICES.STANDARD +
  " (" + ((100 * evSanos) / PACK_PRICES.STANDARD).toFixed(0) + "%) -> el sobre pierde " +
  (PACK_PRICES.STANDARD - evSanos).toFixed(1) + " de media");

// Recuento empírico: se sortean muchos ciclos y se cuentan ids distintos.
// El id de una oferta codifica su CONTENIDO (set + claves de sus requisitos),
// así que contar ids distintos es contar ofertas distintas de verdad.
const vistas = new Set();
const hitos = [];
const CICLOS = 50000;
for (let s = 0; s < CICLOS; s++) {
  for (const o of generarOfertas(s, SETS, OFERTAS_ACTIVAS)) vistas.add(o.id);
  if (s === 999 || s === 9999 || s === 25000 - 1 || s === CICLOS - 1) hitos.push([s + 1, vistas.size]);
}
console.log("\n  curva de saturación (ciclos sorteados -> ofertas distintas acumuladas)");
for (const [c, n] of hitos)
  console.log("    " + String(c).padStart(7) + " ciclos ->" + String(n).padStart(8) + " ofertas");
console.log("  OFERTAS DISTINTAS CONTADAS: " + vistas.size +
  "  (la curva no se aplana: el espacio real es mayor)");

/* ================================================================== *
 * 2. GARANTÍAS DEL GENERADOR + AUDITORÍA DE FACTIBILIDAD
 * ================================================================== */
titulo("2. GARANTÍAS: determinismo, set libre y ninguna oferta imposible");

const a1 = JSON.stringify(generarOfertas(4242, SETS, OFERTAS_ACTIVAS));
const a2 = JSON.stringify(generarOfertas(4242, SETS, OFERTAS_ACTIVAS));
console.log("  determinista (misma semilla -> mismas ofertas): " + (a1 === a2 ? "SÍ" : "NO"));

let sinLibre = 0, sinRequisitoLibre = 0, cuenta = 0;
const porDificultad = { facil: 0, media: 0, dificil: 0 };
for (let s = 0; s < 20000; s++) {
  const ofertas = generarOfertas(s, SETS, OFERTAS_ACTIVAS);
  if (!ofertas.some((o) => o.setId === null)) sinLibre++;
  for (const o of ofertas) {
    cuenta++;
    porDificultad[o.dificultad]++;
    if (o.setId !== null && !o.requisitos.some((r) => r.setId === null)) sinRequisitoLibre++;
  }
}
console.log("  ciclos sin ninguna oferta de expansión libre: " + sinLibre + " de 20000");
console.log("  ofertas de set sin requisito de set libre:    " + sinRequisitoLibre + " de " + cuenta);
console.log("  reparto de dificultad: " +
  Object.entries(porDificultad).map(([k, v]) => k + " " + ((100 * v) / cuenta).toFixed(1) + "%").join("  ") +
  "  (objetivo " +
  Object.entries(COMPOSICION_CICLO).map(([k, v]) => k + " " + ((100 * v) / OFERTAS_ACTIVAS).toFixed(1) + "%").join("  ") + ")");

// Factibilidad: ¿se pueden conseguir las cartas ABRIENDO SOBRES? No basta con
// que la carta exista en el JSON: packLogic sólo reparte lo que cae en sus
// pools. Se simulan sobres de cada set y se guarda lo realmente obtenible.
const obtenible = new Map();
for (const s of SETS) {
  const vistos = new Map();
  for (let i = 0; i < 500; i++)
    for (const c of packLogic.openStandardPack(CARTAS.get(s))) vistos.set(c.id, c);
  obtenible.set(s, [...vistos.values()]);
}
const universo = [].concat(...obtenible.values());

// Memoizado: los 288 requisitos del catálogo se repiten miles de veces y cada
// comprobación recorre miles de cartas.
const cacheFactible = new Map();
function factible(req) {
  const clave = JSON.stringify(req.filtro) + "|" + req.cantidad + "|" + req.setId;
  const previo = cacheFactible.get(clave);
  if (previo !== undefined) return previo;
  const r = calcularFactible(req);
  cacheFactible.set(clave, r);
  return r;
}

function calcularFactible(req) {
  const pool = req.setId === null ? universo : obtenible.get(req.setId) ?? [];
  const candidatas = pool.filter((c) => cumpleFiltro(c, req.filtro));
  switch (req.filtro.categoria) {
    case "playset":
      // Basta con que exista UNA carta elegible: las copias salen repitiendo.
      return candidatas.length > 0;
    case "arcoiris": {
      const tipos = new Set();
      for (const c of candidatas) for (const t of c.types ?? []) tipos.add(t);
      return tipos.size >= req.cantidad;
    }
    case "evolucion": {
      const porNombre = new Map(candidatas.map((c) => [c.name, c]));
      for (const c of candidatas) {
        if (!c.evolvesFrom) continue;
        const padre = porNombre.get(c.evolvesFrom);
        if (!padre) continue;
        if (req.cantidad === 2) return true;
        if (padre.evolvesFrom && porNombre.get(padre.evolvesFrom)) return true;
      }
      return false;
    }
    default:
      return candidatas.length >= req.cantidad;
  }
}

let imposibles = 0, revisadas = 0;
const fallos = new Map();
for (let s = 0; s < 6000; s++) {
  for (const o of generarOfertas(s, SETS, OFERTAS_ACTIVAS)) {
    revisadas++;
    const rota = o.requisitos.find((r) => !factible(r));
    if (rota) {
      imposibles++;
      const k = rota.filtro.categoria + "(" + (rota.filtro.valor ?? "") +
        (rota.filtro.min !== undefined ? ">=" + rota.filtro.min : "") + ") x" +
        rota.cantidad + " @" + (rota.setId ?? "libre");
      fallos.set(k, (fallos.get(k) ?? 0) + 1);
    }
  }
}
console.log("  ofertas auditadas contra las cartas realmente obtenibles: " + revisadas);
console.log("  ofertas IMPOSIBLES: " + imposibles);
for (const [k, n] of [...fallos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12))
  console.log("    " + k.padEnd(46) + n);

/* ================================================================== *
 * 3. TABLA DE MULTIPLICADORES
 * ================================================================== */
titulo("3. TABLA DE MULTIPLICADORES");

const muestras = { facil: [], media: [], dificil: [] };
for (let s = 0; s < 8000; s++)
  for (const o of generarOfertas(s, SETS, OFERTAS_ACTIVAS)) muestras[o.dificultad].push(o.multiplicador);
console.log("  El multiplicador no es un número por dificultad: sale de dividir la prima que");
console.log("  merece el esfuerzo entre lo que vale el lote. Un lote caro necesita menos");
console.log("  multiplicador para pagar lo mismo, así que cada dificultad cubre un rango.\n");
console.log("  dificultad   ofertas    mín    p25   mediana    p75    máx   tope de prima");
for (const d of ["facil", "media", "dificil"]) {
  const m = muestras[d].sort((a, b) => a - b);
  console.log("    " + d.padEnd(10) + String(m.length).padStart(7) +
    m[0].toFixed(2).padStart(7) + pct(m, 0.25).toFixed(2).padStart(7) +
    pct(m, 0.5).toFixed(2).padStart(10) + pct(m, 0.75).toFixed(2).padStart(7) +
    m[m.length - 1].toFixed(2).padStart(7) + ("+" + TECHO_PRIMA[d]).padStart(15));
}
console.log("  fronteras de dificultad: fácil < 8 sobres de esfuerzo estimado; media < 26; difícil >= 26");
console.log("\n  Ejemplo de tablón (semilla 7):");
for (const o of generarOfertas(7, SETS, OFERTAS_ACTIVAS)) {
  console.log("    [" + o.dificultad.padEnd(7) + "] x" + o.multiplicador.toFixed(2) + "  " + o.titulo);
  for (const r of o.requisitos) console.log("         - " + r.descripcion);
}

/* ================================================================== *
 * 4. MOTOR DE ENTREGAS (lo que hará el servidor al validar)
 * ================================================================== */

// Almacén de duplicados: id -> { carta, dias: [día de llegada por copia] }.
// La antigüedad importa porque un jugador real no guarda cromos para siempre.
function meter(almacen, carta, dia) {
  const e = almacen.get(carta.id) ?? { carta, dias: [] };
  e.dias.push(dia);
  almacen.set(carta.id, e);
}
function copias(e) { return e.dias.length; }

// `codicioso` = el jugador que juega para ganar el máximo. Como la prima crece
// con el valor del lote hasta tocar el tope, lo óptimo es entregar las cartas
// MÁS CARAS que cumplan (venderlas daría exactamente ese mismo valor, así que
// no pierde nada). El casual, en cambio, se deshace de la morralla.
function candidatas(almacen, filtro, setId, reservadas, codicioso) {
  const out = [];
  for (const e of almacen.values()) {
    if (setId !== null && setDeCarta(e.carta) !== setId) continue;
    if (!cumpleFiltro(e.carta, filtro)) continue;
    const libres = copias(e) - (reservadas.get(e.carta.id) ?? 0);
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
  return { pago, prima: pago - valor, entregadas };
}

function consumir(almacen, cartas) {
  for (const c of cartas) {
    const e = almacen.get(c.id);
    if (!e) continue;
    e.dias.shift(); // se gasta la copia más vieja
    if (e.dias.length === 0) almacen.delete(c.id);
  }
}

// Vende todo lo que lleve más de `retencion` días criando polvo.
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

// Un jugador que "juega bien" abre la expansión que más prima le puede dar hoy.
function setMasRentable(ofertas, porDefecto) {
  let mejor = porDefecto, mejorPrima = -1;
  for (const o of ofertas) {
    if (o.setId === null) continue;
    const p = TECHO_PRIMA[o.dificultad];
    if (p > mejorPrima) { mejorPrima = p; mejor = o.setId; }
  }
  return mejor;
}

/* ================================================================== *
 * 5. JUGADOR DIARIO
 * ================================================================== */
titulo("4. JUGADOR DIARIO (recompensa " + DAILY_BASE + " + 3 sobres/día, 1 año)");

// Tres perfiles, TODOS con el mismo presupuesto de 3 sobres/día. Lo único que
// cambia es lo bien que juegan, que es justo lo que el mercado debe premiar:
//  - "base":        línea base sin mercado; vende los duplicados el mismo día.
//  - "casual":      abre siempre su expansión favorita y entrega lo que le cuadre.
//  - "optimizador": abre la expansión que pide la oferta mejor pagada y guarda
//                   una semana de duplicados para poder cubrir el tablón.
const RETENCION_CASUAL = 2;
const RETENCION_OPTIMIZADOR = 7;

function simularDiario({ conMercado, perfil = "casual", sobresDia = 3, dias = 365, partidas = 32 }) {
  const finales = [], primas = [], hechas = [], entregadas = [];
  const porDif = { facil: 0, media: 0, dificil: 0 };
  const retencion = !conMercado ? 0 : perfil === "optimizador" ? RETENCION_OPTIMIZADOR : RETENCION_CASUAL;

  for (let p = 0; p < partidas; p++) {
    let cartera = STARTING_COINS;
    const album = new Set();
    const almacen = new Map();
    let primaTotal = 0, completadas = 0, cartasDadas = 0;
    const favorito = SETS_SANOS[(p * 7) % SETS_SANOS.length];

    for (let d = 0; d < dias; d++) {
      cartera += DAILY_BASE;
      const ofertas = conMercado ? generarOfertas(d, SETS_SANOS, OFERTAS_ACTIVAS) : [];
      const objetivo = perfil === "optimizador" ? setMasRentable(ofertas, favorito) : favorito;

      for (let k = 0; k < sobresDia && cartera >= PACK_PRICES.STANDARD; k++) {
        cartera -= PACK_PRICES.STANDARD;
        for (const c of packLogic.openStandardPack(CARTAS.get(objetivo))) {
          // Nadie colecciona 19 expansiones a la vez: el álbum es el del set
          // favorito, y lo que cae de los demás es material de mercado.
          const suSet = setDeCarta(c) === favorito;
          if (suSet && !album.has(c.id)) album.add(c.id);
          else meter(almacen, c, d);
        }
      }

      for (const o of ofertas) {
        const r = intentarOferta(almacen, o, perfil === "optimizador");
        if (!r) continue;
        consumir(almacen, r.entregadas);
        cartera += r.pago;
        primaTotal += r.prima;
        cartasDadas += r.entregadas.length;
        completadas++;
        porDif[o.dificultad]++;
      }

      cartera += venderViejo(almacen, d, retencion);
      // Regla de liquidez: nadie se queda sin poder abrir por tener cromos
      // guardados. Si no llega para un sobre, vende el almacén entero.
      if (cartera < PACK_PRICES.STANDARD) cartera += venderViejo(almacen, d, 0);
    }
    cartera += venderViejo(almacen, dias + 999, 0);
    finales.push(cartera);
    primas.push(primaTotal);
    hechas.push(completadas);
    entregadas.push(cartasDadas);
  }
  const total = Object.values(porDif).reduce((a, b) => a + b, 0) || 1;
  return {
    medianaFinal: mediana(finales),
    p5: pct(finales, 0.05),
    p95: pct(finales, 0.95),
    primaAnual: primas.reduce((a, b) => a + b, 0) / primas.length,
    ofertasDia: hechas.reduce((a, b) => a + b, 0) / hechas.length / 365,
    cartasDia: entregadas.reduce((a, b) => a + b, 0) / entregadas.length / 365,
    mezcla: Object.entries(porDif).map(([k, v]) => k + " " + ((100 * v) / total).toFixed(0) + "%").join(" "),
  };
}

const base = simularDiario({ conMercado: false, perfil: "casual" });
const casual = simularDiario({ conMercado: true, perfil: "casual" });
const opti = simularDiario({ conMercado: true, perfil: "optimizador" });

const fila = (etiqueta, f) =>
  console.log("  " + etiqueta.padEnd(28) + String(f(base)).padStart(12) +
    String(f(casual)).padStart(14) + String(f(opti)).padStart(16));
console.log("                                  SIN mercado       CASUAL   OPTIMIZADOR");
fila("cartera al año (mediana)", (r) => r.medianaFinal);
fila("cartera al año (p5)", (r) => r.p5);
fila("cartera al año (p95)", (r) => r.p95);
fila("ofertas completadas/día", (r) => r.ofertasDia.toFixed(2));
fila("cartas entregadas/día", (r) => r.cartasDia.toFixed(1));
fila("prima del mercado/año", (r) => Math.round(r.primaAnual));
fila("prima del mercado/DÍA", (r) => (r.primaAnual / 365).toFixed(1));
console.log("  ofertas completadas por dificultad:  casual [" + casual.mezcla +
  "]  optimizador [" + opti.mezcla + "]");
console.log("\n  el mercado suma un " +
  (((casual.medianaFinal - base.medianaFinal) / base.medianaFinal) * 100).toFixed(1) +
  "% (casual) y un " + (((opti.medianaFinal - base.medianaFinal) / base.medianaFinal) * 100).toFixed(1) +
  "% (optimizador) a la cartera del año, con los MISMOS 3 sobres al día");
console.log("  la prima diaria del optimizador es el " +
  ((100 * opti.primaAnual) / 365 / DAILY_BASE).toFixed(0) + "% de la recompensa diaria (" + DAILY_BASE + ")");

/* ================================================================== *
 * 6. ¿ES RENTABLE ABRIR SOBRES SÓLO PARA VENDER AL MERCADO?
 * ================================================================== */
titulo("5. EL FARMEO: abrir sobres sólo para revenderlos al mercado");

// Revendedor puro: no colecciona nada, abre K sobres/día de la expansión que
// pide el tablón, cubre lo que puede y vende el resto. Es el peor caso.
function simularFarmeo(sobresDia, { dias = 150, partidas = 24, conMercado = true } = {}) {
  let netoTotal = 0, primaTotal = 0, hechasTotal = 0;
  for (let p = 0; p < partidas; p++) {
    const favorito = SETS_SANOS[(p * 5) % SETS_SANOS.length];
    const almacen = new Map();
    let neto = 0;
    for (let d = 0; d < dias; d++) {
      const ofertas = conMercado ? generarOfertas(d, SETS_SANOS, OFERTAS_ACTIVAS) : [];
      const objetivo = conMercado ? setMasRentable(ofertas, favorito) : favorito;
      for (let k = 0; k < sobresDia; k++) {
        neto -= PACK_PRICES.STANDARD;
        for (const c of packLogic.openStandardPack(CARTAS.get(objetivo))) meter(almacen, c, d);
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

console.log("  sobres/día   neto/día   neto/sobre   prima mercado/día   ofertas/día");
const curva = [];
for (const k of [1, 3, 6, 12, 25, 50, 100]) {
  // Presupuesto constante de sobres simulados: con k grande bastan menos
  // partidas para que la media se estabilice.
  const r = simularFarmeo(k, { dias: 60, partidas: Math.max(6, Math.round(200 / k)) });
  curva.push([k, r]);
  console.log("  " + String(k).padStart(9) + r.netoDia.toFixed(1).padStart(11) +
    (r.netoDia / k).toFixed(2).padStart(13) + r.primaDia.toFixed(1).padStart(20) +
    r.ofertasDia.toFixed(2).padStart(14));
}
const sinM = simularFarmeo(12, { dias: 60, partidas: 25, conMercado: false });
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

// Coleccionista sin recompensa diaria: guarda la primera copia y vende el
// resto. Es el escenario en el que la ruina llega antes.
function simularRuina(conMercado, perfil = "casual", partidas = 150) {
  let quiebras = 0;
  const cuando = [], finales = [];
  for (let p = 0; p < partidas; p++) {
    const favorito = SETS_SANOS[(p * 3) % SETS_SANOS.length];
    const album = new Set();
    const almacen = new Map();
    let cartera = STARTING_COINS, quiebra = -1;
    for (let s = 0; s < 1000; s++) {
      if (cartera < PACK_PRICES.STANDARD) { quiebra = s; break; }
      // Un "día" son 3 sobres: el tablón se refresca al mismo ritmo que en el juego.
      const dia = Math.floor(s / 3);
      const ofertas = conMercado ? generarOfertas(dia, SETS_SANOS, OFERTAS_ACTIVAS) : [];
      // El casual abre siempre lo mismo, con y sin mercado: así la comparación
      // mide el mercado y no el hecho de cambiar de expansión.
      const objetivo = perfil === "optimizador" ? setMasRentable(ofertas, favorito) : favorito;
      cartera -= PACK_PRICES.STANDARD;
      for (const c of packLogic.openStandardPack(CARTAS.get(objetivo))) {
        if (setDeCarta(c) === favorito && !album.has(c.id)) album.add(c.id);
        else meter(almacen, c, dia);
      }
      if (conMercado && s % 3 === 2) {
        for (const o of ofertas) {
          const r = intentarOferta(almacen, o, perfil === "optimizador");
          if (!r) continue;
          consumir(almacen, r.entregadas);
          cartera += r.pago;
        }
      }
      cartera += venderViejo(almacen, dia, conMercado ? RETENCION_OPTIMIZADOR : 0);
      // Misma regla de liquidez que arriba: guardar cromos no puede ser lo que
      // arruine al jugador, o la comparación mediría eso y no el mercado.
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
 * 7bis. LA PRUEBA DEL ABUSO
 * ================================================================== */
titulo("7. PRUEBA DEL ABUSO: entregar las cartas MÁS CARAS que cumplen el filtro");

// Al jugador le da igual vender que entregar, así que sin tope le convendría
// meter Hyper Rares de 250 en un "5 cartas de tipo Fuego x1,5". Aquí se calcula,
// para cada oferta, el lote más caro que se puede montar con TODO el universo
// de cartas obtenibles y se comprueba que la prima sigue acotada.
function loteExtremo(req, caro) {
  const pool = (req.setId === null ? universo : obtenible.get(req.setId) ?? [])
    .filter((c) => cumpleFiltro(c, req.filtro))
    .sort((a, b) => (caro ? precio(b) - precio(a) : precio(a) - precio(b)));
  if (pool.length === 0) return null;
  switch (req.filtro.categoria) {
    case "playset":
      return Array(req.cantidad).fill(pool[0]);
    case "arcoiris": {
      const porTipo = new Map();
      for (const c of pool) for (const t of c.types ?? []) if (!porTipo.has(t)) porTipo.set(t, c);
      return porTipo.size < req.cantidad ? null : [...porTipo.values()].slice(0, req.cantidad);
    }
    case "evolucion": {
      const porNombre = new Map();
      for (const c of pool) if (!porNombre.has(c.name)) porNombre.set(c.name, c);
      for (const c of porNombre.values()) {
        const padre = c.evolvesFrom ? porNombre.get(c.evolvesFrom) : null;
        if (!padre) continue;
        if (req.cantidad === 2) return [padre, c];
        const abuelo = padre.evolvesFrom ? porNombre.get(padre.evolvesFrom) : null;
        if (abuelo) return [abuelo, padre, c];
      }
      return null;
    }
    default:
      return pool.length < req.cantidad ? null : pool.slice(0, req.cantidad);
  }
}

let peorPrima = 0, peorTexto = "", peorValor = 0, peorSinTope = 0;
let casos = 0, sumaHonesta = 0, sumaAbuso = 0, excesos = 0;
for (let s = 0; s < 400; s++) {
  for (const o of generarOfertas(s, SETS, OFERTAS_ACTIVAS)) {
    const barato = [], caro = [];
    let posible = true;
    for (const r of o.requisitos) {
      const b = loteExtremo(r, false), c = loteExtremo(r, true);
      if (!b || !c) { posible = false; break; }
      barato.push(...b); caro.push(...c);
    }
    if (!posible) continue;
    casos++;
    const vB = barato.reduce((a, c) => a + precio(c), 0);
    const vC = caro.reduce((a, c) => a + precio(c), 0);
    const primaB = pagoDelLote(o, vB) - vB;
    const primaC = pagoDelLote(o, vC) - vC;
    sumaHonesta += primaB;
    sumaAbuso += primaC;
    if (primaC > TECHO_PRIMA[o.dificultad]) excesos++;
    if (primaC > peorPrima || (primaC === peorPrima && vC > peorValor)) {
      peorPrima = primaC;
      peorValor = vC;
      peorSinTope = Math.round((o.multiplicador - 1) * vC);
      peorTexto = "x" + o.multiplicador + " [" + o.dificultad + "] " +
        o.requisitos.map((r) => r.descripcion).join(" + ") +
        "  (lote de " + vC + " monedas)";
    }
  }
}
console.log("  ofertas analizadas: " + casos);
console.log("  prima media jugando limpio (lote más barato): " + (sumaHonesta / casos).toFixed(1) + " monedas");
console.log("  prima media abusando  (lote más caro):        " + (sumaAbuso / casos).toFixed(1) + " monedas");
console.log("  ofertas donde el abuso supera su tope: " + excesos + " (debe ser 0)");
console.log("  peor caso encontrado: +" + peorPrima + " monedas");
console.log("    " + peorTexto);
console.log("  ese mismo lote SIN el tope habría pagado una prima de " + peorSinTope +
  " monedas: " + (peorSinTope / Math.max(peorPrima, 1)).toFixed(0) + " veces más.");
console.log("  Eso, y no el multiplicador, es lo que convertía el mercado en una imprenta.");

/* ================================================================== *
 * 8. RESUMEN
 * ================================================================== */
titulo("RESUMEN DE CALIBRADO");
const techoCiclo =
  COMPOSICION_CICLO.facil * TECHO_PRIMA.facil +
  COMPOSICION_CICLO.media * TECHO_PRIMA.media +
  COMPOSICION_CICLO.dificil * TECHO_PRIMA.dificil;
console.log("  ofertas activas por ciclo : " + OFERTAS_ACTIVAS + " (caducan cada " + DURACION_CICLO_HORAS + " h)");
console.log("  composición del ciclo     : " + JSON.stringify(COMPOSICION_CICLO));
console.log("  topes de prima por oferta : " + JSON.stringify(TECHO_PRIMA));
console.log("  tasa de prima por sobre   : " + TASA_PRIMA_POR_SOBRE);
console.log("  INYECCIÓN MÁXIMA TEÓRICA  : " + techoCiclo + " monedas/día (completándolas TODAS)");
console.log("  inyección real medida     : " + (casual.primaAnual / 365).toFixed(1) +
  " (casual) / " + (opti.primaAnual / 365).toFixed(1) + " (optimizador) monedas/día");
console.log("  recompensa diaria         : " + DAILY_BASE + " monedas/día");
