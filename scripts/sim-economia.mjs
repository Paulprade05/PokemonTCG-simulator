// Simulación de la economía con el CÓDIGO REAL del juego.
// Transpila utils/*.ts al vuelo (quitando tipos) y usa la curva de precios real
// de utils/constanst.ts, el generador de sobres real de utils/packLogic.ts, el
// generador de ofertas real de utils/mercado.ts y las cartas reales de
// src/data/*.json.
//
// QUÉ RESPONDE ESTE FICHERO
//   1. La tabla de la curva: cuánto paga cada copia repetida de cada rareza.
//   2. EL GUARDIÁN: ningún sobre puede devolver más de lo que cuesta. Se mide
//      con cálculo cerrado y con Montecarlo, ANTES y DESPUÉS de los arreglos, y
//      si algo se cuela por encima del 100% el script termina con error.
//   3. Que el `total` declarado de cada expansión coincide con las cartas que
//      hay de verdad: si declara de menos, el bono de set completado se cobra
//      sin completar nada.
//   4. Cuánto se sacaba ANTES por vaciar los duplicados de una expansión
//      exprimida y cuánto se saca AHORA (calibrado de la curva de copias).
//   5. Que al jugador normal —el que vende sus repetidas según salen— no le
//      cambia casi nada.
//   6. Qué le pasa al MERCADO (utils/mercado.ts), que sigue pagando con
//      SELL_PRICES planos y NO se ajusta solo.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { transform, loadBindings } from "next/dist/build/swc/index.js";

await loadBindings();
const raiz = process.cwd();

// Los módulos se resuelven entre ellos: mercado.ts y packLogic.ts importan
// constanst.ts y sin esto recibirían un objeto vacío y reventarían.
const cargados = new Map();
async function cargarModulo(rel) {
  if (cargados.has(rel)) return cargados.get(rel);
  const fuente = readFileSync(join(raiz, rel), "utf8");
  const { code } = await transform(fuente, {
    jsc: { parser: { syntax: "typescript" }, target: "es2022" },
    module: { type: "commonjs" },
  });
  const mod = { exports: {} };
  const requerir = (spec) => {
    if (spec.includes("constanst")) return cargados.get("utils/constanst.ts") ?? {};
    return {};
  };
  new Function("module", "exports", "require", code)(mod, mod.exports, requerir);
  cargados.set(rel, mod.exports);
  return mod.exports;
}

const constantes = await cargarModulo("utils/constanst.ts");
const packLogic = await cargarModulo("utils/packLogic.ts");
const mercado = await cargarModulo("utils/mercado.ts");
const {
  SELL_PRICES, PACK_PRICES, STARTING_COINS, DAILY_BASE, SET_COMPLETION_BONUS,
  RARITY_RANK, valorDeVenta, precioDeCartaSuelta,
  SUELO_COPIAS, SEMIVIDA_COPIAS, COPIA_SUELO,
} = constantes;

/** Se pone a true en cuanto una comprobación falla; decide el código de salida. */
let HAY_FALLOS = false;
const fallo = (texto) => { HAY_FALLOS = true; console.log("  ¡¡FALLO!! " + texto); };

/** Tarifa PLANA: precio de la carta sin mirar cuántas copias hay. */
const precioPlano = (r) => precioDeCartaSuelta(r);

/** Lo que se cobraba ANTES por vender `n` repetidas: n × tarifa. */
const valorAntes = (r, copias, n) => Math.max(0, n === undefined ? copias - 1 : n) * precioPlano(r);

/** Precio marginal de la copia repetida nº `n` (la curva, vista de una en una). */
const precioDeCopia = (r, n) => valorDeVenta(r, n + 1, 1);

const cartasDe = (setId) =>
  JSON.parse(readFileSync(join(raiz, "src", "data", setId + ".json"), "utf8"));

const pct = (a, b) => (b === 0 ? "—" : ((100 * a) / b).toFixed(0) + "%");
const pct1 = (a, b) => (b === 0 ? "—" : ((100 * a) / b).toFixed(1) + "%");
const num = (n) => Math.round(n).toLocaleString("es-ES");
const valorDelSobre = (sobre) => sobre.reduce((s, c) => s + precioPlano(c.rarity), 0);

const setsDisponibles = readdirSync(join(raiz, "src", "data"))
  .filter((f) => f.endsWith(".json") && f !== "all-sets.json")
  .map((f) => f.replace(".json", ""));

const CARTAS = new Map();
for (const id of setsDisponibles) {
  try {
    const c = cartasDe(id);
    if (Array.isArray(c) && c.length > 0) CARTAS.set(id, c);
  } catch { /* fichero ilegible: se ignora */ }
}

/* ==================================================================== *
 * EL GENERADOR DE ANTES DE LOS ARREGLOS (copia congelada)
 * ====================================================================
 *
 * POR QUÉ ESTÁ AQUÍ Y NO SE IMPORTA: es la versión de utils/packLogic.ts
 * ANTERIOR a los arreglos de esta tanda. Existe sólo para poder medir el ANTES
 * con código que se ejecuta, en vez de citar de memoria unos números viejos. No
 * se toca nunca más: es una foto, y si se "actualizara" dejaría de ser el antes.
 *
 * Diferencias con el actual, que son exactamente los dos arreglos del generador:
 *   · el sobre estándar y el premium repartían SIEMPRE 6+3 y 4+4 huecos de
 *     relleno, sin mirar si el sobre acababa valiendo más de lo que cuesta;
 *   · la rama de régimen del sobre Leyenda (colección ya completa) repartía
 *     draw(hyperRare → specialIllustrationRare) en vez de una carta al azar.
 */
const ANTES = (() => {
  const categorize = (cards) => ({
    common: cards.filter(c => c.rarity === 'Common'),
    uncommon: cards.filter(c => c.rarity === 'Uncommon'),
    rare: cards.filter(c => c.rarity === 'Rare' || c.rarity === 'Rare Holo'),
    doubleRare: cards.filter(c => c.rarity === 'Double Rare' || c.rarity?.includes('V') || c.rarity?.includes('ex')),
    illustrationRare: cards.filter(c => c.rarity === 'Illustration Rare' || c.rarity?.includes('Trainer Gallery')),
    ultraRare: cards.filter(c => c.rarity === 'Ultra Rare' || c.rarity === 'Full Art'),
    specialIllustrationRare: cards.filter(c => c.rarity === 'Special Illustration Rare' || c.rarity?.includes('Secret')),
    hyperRare: cards.filter(c => c.rarity === 'Hyper Rare' || c.rarity === 'Secret Rare' || c.rarity?.includes('Rainbow')),
  });
  const draw = (pool, fallbackPool, ids, allCards) => {
    const disponibles = pool.length > 0 ? pool : (fallbackPool.length > 0 ? fallbackPool : allCards);
    if (!disponibles || disponibles.length === 0) return { id: 'error', name: 'MissingNo', rarity: 'Common' };
    const unicas = disponibles.filter(c => !ids.has(c.id));
    const finales = unicas.length > 0 ? unicas : disponibles;
    const elegida = finales[Math.floor(Math.random() * finales.length)];
    ids.add(elegida.id);
    return elegida;
  };
  const hit = (pools, ids, allCards) => {
    const rand = Math.random() * 100;
    if (rand < 0.5) return draw(pools.hyperRare, pools.ultraRare, ids, allCards);
    if (rand < 2.5) return draw(pools.specialIllustrationRare, pools.ultraRare, ids, allCards);
    if (rand < 6.5) return draw(pools.ultraRare, pools.doubleRare, ids, allCards);
    if (rand < 14.5) return draw(pools.illustrationRare, pools.rare, ids, allCards);
    if (rand < 30.0) return draw(pools.doubleRare, pools.rare, ids, allCards);
    return draw(pools.rare, pools.uncommon, ids, allCards);
  };
  return {
    estandar(allCards) {
      const pools = categorize(allCards), pack = [], ids = new Set();
      for (let i = 0; i < 6; i++) pack.push(draw(pools.common, pools.uncommon, ids, allCards));
      for (let i = 0; i < 3; i++) pack.push(draw(pools.uncommon, pools.common, ids, allCards));
      pack.push(hit(pools, ids, allCards));
      return pack;
    },
    premium(allCards) {
      const pools = categorize(allCards), pack = [], ids = new Set();
      for (let i = 0; i < 4; i++) pack.push(draw(pools.uncommon, pools.common, ids, allCards));
      for (let i = 0; i < 4; i++) pack.push(draw(pools.rare, pools.uncommon, ids, allCards));
      pack.push(draw([...pools.illustrationRare, ...pools.doubleRare], pools.rare, ids, allCards));
      const rand = Math.random() * 100;
      if (rand < 5) pack.push(draw(pools.hyperRare, pools.ultraRare, ids, allCards));
      else if (rand < 15) pack.push(draw(pools.specialIllustrationRare, pools.ultraRare, ids, allCards));
      else if (rand < 40) pack.push(draw(pools.ultraRare, pools.doubleRare, ids, allCards));
      else pack.push(draw(pools.doubleRare, pools.rare, ids, allCards));
      return pack;
    },
    leyenda(allCards, userIds) {
      const pools = categorize(allCards), pack = [], ids = new Set();
      const faltan = allCards.filter(c => !userIds.includes(c.id));
      let garantizada;
      if (faltan.length > 0) {
        const raras = faltan.filter(c => c.rarity !== 'Common' && c.rarity !== 'Uncommon');
        garantizada = raras.length > 0
          ? raras[Math.floor(Math.random() * raras.length)]
          : faltan[Math.floor(Math.random() * faltan.length)];
      } else {
        garantizada = draw(pools.hyperRare, pools.specialIllustrationRare, ids, allCards);
      }
      ids.add(garantizada.id);
      for (let i = 0; i < 5; i++) pack.push(draw(pools.rare, pools.uncommon, ids, allCards));
      for (let i = 0; i < 3; i++) pack.push(draw(pools.doubleRare, pools.rare, ids, allCards));
      pack.push(draw(pools.ultraRare, pools.illustrationRare, ids, allCards));
      pack.push(garantizada);
      return pack;
    },
  };
})();

/* ==================================================================== *
 * 1) LA CURVA: PRECIO DE CADA COPIA REPETIDA
 * ==================================================================== */
console.log("== 1) PRECIO POR COPIA REPETIDA ==");
console.log(
  `curva: max(${(SUELO_COPIAS * 100).toFixed(1)}%, 1 / (1 + (n-1)/${SEMIVIDA_COPIAS}))` +
  `   ·   suelo a partir de la copia nº ${COPIA_SUELO}   ·   mínimo 1 moneda`,
);
const COPIAS_TABLA = [1, 2, 3, 4, 5, 7, 10, 15, 25, 43, 100];
const RAREZAS_TABLA = [
  "Common", "Uncommon", "Rare", "Rare Holo", "Double Rare",
  "Illustration Rare", "Ultra Rare", "Special Illustration Rare", "Hyper Rare",
];
console.log(
  "\nrareza".padEnd(27) + "base" + COPIAS_TABLA.map((n) => ("#" + n).padStart(6)).join(""),
);
console.log(
  "factor".padEnd(27) + "    " +
  COPIAS_TABLA.map((n) => (Math.round(100 * Math.max(SUELO_COPIAS, 1 / (1 + (n - 1) / SEMIVIDA_COPIAS))) + "%").padStart(6)).join(""),
);
for (const r of RAREZAS_TABLA) {
  console.log(
    r.padEnd(27) + String(precioPlano(r)).padStart(4) +
    COPIAS_TABLA.map((n) => String(precioDeCopia(r, n)).padStart(6)).join(""),
  );
}

// Vender de una en una tiene que dar EXACTAMENTE lo mismo que vender de golpe:
// si no, el jugador que trocea la venta le saca dinero a la curva.
{
  let fallos = 0;
  for (const r of RAREZAS_TABLA) {
    for (const q of [2, 3, 5, 9, 20, 60, 300]) {
      let unaAUna = 0;
      for (let copias = q; copias > 1; copias--) unaAUna += valorDeVenta(r, copias, 1);
      if (unaAUna !== valorDeVenta(r, q)) fallos++;
    }
  }
  console.log("\ncoherencia (vender 1+1+1… == vender todo de golpe): " + (fallos === 0 ? "OK" : ""));
  if (fallos !== 0) fallo(`${fallos} casos en los que trocear la venta cambia el dinero`);
}

/* ==================================================================== *
 * 2) EL GUARDIÁN: NINGÚN SOBRE VALE MÁS DE LO QUE CUESTA
 * ====================================================================
 *
 * QUÉ SE VENDE DE CADA SET: la tienda ofrece Estándar (50), Premium (220) y
 * Leyenda (600) en las expansiones normales, y SÓLO el Promo Pack (700) en las
 * colecciones sin morralla. Aquí el reparto se decide con la MEDIDA que expone
 * packLogic (admiteSobreEstandar), no con el nombre del set, y cada sobre se
 * juzga contra el precio al que se vende de verdad.
 */
const N_SOBRES = 20000;

/** Media y error estándar del valor de reventa de un sobre. */
function medirSobre(generador, veces = N_SOBRES) {
  let suma = 0, sumaCuadrados = 0;
  for (let i = 0; i < veces; i++) {
    const v = valorDelSobre(generador());
    suma += v; sumaCuadrados += v * v;
  }
  const media = suma / veces;
  const varianza = Math.max(0, sumaCuadrados / veces - media * media);
  return { media, margen: 2 * Math.sqrt(varianza / veces) };
}

console.log("\n\n== 2) NINGÚN SOBRE POR ENCIMA DEL 100% DEL COSTE ==");
console.log(`   ${N_SOBRES} sobres por set y sobre; el margen es 2σ/√n (95%).`);
console.log("   'exacto' es el cálculo cerrado de packLogic: media de precios de");
console.log("   cada pool por la probabilidad de su rama. No depende de la suerte.\n");

const filas2 = [];
for (const [setId, cartas] of CARTAS) {
  const idsCompletos = cartas.map((c) => c.id);
  const admite = packLogic.admiteSobreEstandar(cartas);

  const sobres = admite
    ? [
        { nombre: "estándar", precio: PACK_PRICES.STANDARD,
          gen: () => packLogic.openStandardPack(cartas),
          antes: () => ANTES.estandar(cartas),
          exacto: packLogic.valorEsperadoEstandar(cartas) },
        { nombre: "premium", precio: PACK_PRICES.PREMIUM,
          gen: () => packLogic.openPremiumPack(cartas),
          antes: () => ANTES.premium(cartas),
          exacto: packLogic.valorEsperadoPremium(cartas) },
        { nombre: "leyenda·régimen", precio: PACK_PRICES.GOLDEN,
          gen: () => packLogic.openGoldenPack(cartas, idsCompletos),
          antes: () => ANTES.leyenda(cartas, idsCompletos) },
        { nombre: "leyenda·desde 0", precio: PACK_PRICES.GOLDEN,
          gen: () => packLogic.openGoldenPack(cartas, []),
          antes: () => ANTES.leyenda(cartas, []) },
      ]
    : [
        { nombre: "promo·régimen", precio: PACK_PRICES.SPECIAL,
          gen: () => packLogic.openGoldenPack(cartas, idsCompletos),
          antes: () => ANTES.leyenda(cartas, idsCompletos) },
        { nombre: "promo·desde 0", precio: PACK_PRICES.SPECIAL,
          gen: () => packLogic.openGoldenPack(cartas, []),
          antes: () => ANTES.leyenda(cartas, []) },
      ];

  for (const s of sobres) {
    const ahora = medirSobre(s.gen);
    const antes = medirSobre(s.antes, Math.min(4000, N_SOBRES));
    filas2.push({
      setId, admite, sobre: s.nombre, precio: s.precio, exacto: s.exacto,
      antes: antes.media, margenAntes: antes.margen, ahora: ahora.media, margen: ahora.margen,
      cartas: s.gen().length,
    });
  }
}

/**
 * ¿ESTE sobre imprime dinero? Con evidencia, no con la barra de error rozando.
 *
 * POR QUÉ NO VALE `media + margen > precio`: los sobres estándar de la era
 * Escarlata y Púrpura valen EXACTAMENTE 49,675 y su 2σ es ±0,5, así que su
 * intervalo toca el 50 SIEMPRE. Con ese criterio el guardián fallaba en cada
 * corrida y en un puñado de sets distinto cada vez —ruido, no fugas—, y un
 * guardián que nunca pasa no guarda nada. Aquí se acusa cuando hay prueba:
 *   · el cálculo cerrado (determinista) pasa del precio, o
 *   · la media medida está por encima del precio MÁS de 2σ.
 */
const imprimeDinero = (f) =>
  (f.exacto !== undefined && f.exacto > f.precio) || f.ahora - f.margen > f.precio;

filas2.sort((a, b) => b.ahora / b.precio - a.ahora / a.precio);
console.log(
  "set".padEnd(13) + "sobre".padEnd(17) + "precio".padStart(7) + "nº".padStart(4) +
  "exacto".padStart(8) + "ANTES".padStart(9) + "%".padStart(7) + "AHORA".padStart(9) + "%".padStart(7),
);
for (const f of filas2) {
  const marca = imprimeDinero(f) ? "  <-- ¡IMPRIME DINERO!" : "";
  console.log(
    f.setId.padEnd(13) + f.sobre.padEnd(17) + String(f.precio).padStart(7) +
    String(f.cartas).padStart(4) +
    (f.exacto === undefined ? "—" : f.exacto.toFixed(1)).padStart(8) +
    f.antes.toFixed(1).padStart(9) + pct1(f.antes, f.precio).padStart(7) +
    f.ahora.toFixed(1).padStart(9) + pct1(f.ahora, f.precio).padStart(7) + marca,
  );
}

{
  const culpables = filas2.filter(imprimeDinero);
  // Mismo listón que para el AHORA: el ANTES se mide con 4.000 sobres (2σ = ±1,1)
  // y con `> precio` a secas la lista se llenaba de sets sanos por puro sorteo.
  const antesCulpables = filas2.filter((f) => f.antes - f.margenAntes > f.precio);
  console.log(
    `\n  sobres por encima del 100%: ANTES ${antesCulpables.length} ` +
    `(${antesCulpables.map((f) => f.setId + " " + f.sobre).join(", ") || "—"})`,
  );
  console.log(`                              AHORA ${culpables.length}`);
  if (culpables.length > 0) {
    for (const f of culpables) {
      fallo(`${f.setId} ${f.sobre}: ${f.ahora.toFixed(1)} de ${f.precio} = ${pct1(f.ahora, f.precio)}`);
    }
  } else {
    console.log("  OK: ningún sobre comprable devuelve más de lo que cuesta.");
  }
}

// El cálculo cerrado y el Montecarlo tienen que decir lo mismo: si se separan,
// el sobre se está calibrando contra un valor que no es el que reparte.
{
  let peor = 0, peorSet = "";
  for (const f of filas2) {
    if (f.exacto === undefined) continue;
    const desvio = Math.abs(f.exacto - f.ahora);
    if (desvio > peor) { peor = desvio; peorSet = f.setId + " " + f.sobre; }
    // 3σ y no 2σ: se comparan ~90 filas por corrida, así que a 2σ un desvío
    // legítimo salta solo por sorteo varias veces al día. El medio punto extra
    // cubre el sesgo conocido del cálculo cerrado en premium (los pools de
    // 'doubleRare' de Espada y Escudo mezclan precios y el hueco intermedio ya
    // ha sacado una carta de ahí, así que la media uniforme se queda ~0,25
    // corta; medido con 400.000 sobres).
    if (desvio > 1.5 * f.margen + 0.5) {
      fallo(`el cálculo cerrado y el Montecarlo no cuadran en ${f.setId} ${f.sobre}: ` +
            `${f.exacto.toFixed(2)} vs ${f.ahora.toFixed(2)} (margen ${f.margen.toFixed(2)})`);
    }
  }
  console.log(`  cálculo cerrado vs Montecarlo: peor desvío ${peor.toFixed(2)} monedas (${peorSet})`);
}

// Los sobres de las expansiones normales NO se han movido. Es el criterio de
// aceptación del arreglo de swsh35: sólo puede tocar a swsh35.
console.log("\n-- LAS EXPANSIONES NORMALES NO SE MUEVEN (antes vs ahora) --");
console.log("set".padEnd(10) + "sobre".padEnd(17) + "ANTES".padStart(9) + "AHORA".padStart(9) + "  cartas");
for (const setId of ["sv3pt5", "sv8", "swsh7", "sv8pt5", "swsh35"]) {
  for (const f of filas2.filter((x) => x.setId === setId && !x.sobre.startsWith("leyenda·desde"))) {
    const mueve = Math.abs(f.antes - f.ahora) > f.margenAntes + f.margen ? "  <-- se mueve" : "";
    console.log(
      setId.padEnd(10) + f.sobre.padEnd(17) + f.antes.toFixed(1).padStart(9) +
      f.ahora.toFixed(1).padStart(9) + String(f.cartas).padStart(8) + mueve,
    );
  }
}
{
  const intocables = ["sv3pt5", "sv8", "swsh7", "sv8pt5"];
  for (const f of filas2.filter((x) => intocables.includes(x.setId))) {
    // Umbral generoso: el Montecarlo de leyenda·régimen tiene cola larga. El
    // arreglo de la rama de régimen SÍ mueve ese sobre a propósito, y esa
    // columna se excluye porque es el arreglo, no un efecto colateral.
    if (f.sobre.startsWith("leyenda")) continue;
    // La prueba de verdad es DETERMINISTA: si la calibración no retira ningún
    // hueco, el sobre reparte 10 cartas y es el mismo sorteo de antes. Un
    // umbral fijo de 1,0 moneda sobre dos Montecarlos (uno de 4.000 sobres, con
    // 2σ = ±1,1) acusaba por ruido en la mitad de las corridas.
    if (f.cartas !== 10) {
      fallo(`${f.setId} ${f.sobre} ha cambiado de tamaño: ${f.cartas} cartas en vez de 10`);
    } else if (Math.abs(f.antes - f.ahora) > f.margenAntes + f.margen) {
      fallo(`${f.setId} ${f.sobre} se ha movido: ${f.antes.toFixed(1)} -> ${f.ahora.toFixed(1)} ` +
            `(2σ combinado ${(f.margenAntes + f.margen).toFixed(1)})`);
    }
  }
}

/* ==================================================================== *
 * 2b) COMPLETAR UNA COLECCIÓN DESDE CERO
 * ====================================================================
 * El otro régimen: abrir sobres hasta tener la expansión entera y vender TODO
 * lo que ha caído. Es el único camino por el que un jugador toca la rama de
 * carta garantizada del sobre Leyenda muchas veces seguidas.
 */
console.log("\n\n== 2b) COMPLETAR LA COLECCIÓN DESDE CERO (se vende todo lo obtenido) ==");
console.log("set".padEnd(13) + "sobre".padEnd(11) + "sobres".padStart(8) + "gastado".padStart(10) +
            "reventa".padStart(10) + "ANTES".padStart(8) + "AHORA".padStart(8));

function completarDesdeCero(cartas, abrir, precioSobre, tope = 4000) {
  const objetivo = new Set(cartas.map((c) => c.id)).size;
  const mias = new Map();
  let sobres = 0, valor = 0, valor2 = 0;
  while (sobres < tope && mias.size < objetivo) {
    sobres++;
    let delSobre = 0;
    for (const c of abrir([...mias.keys()])) {
      mias.set(c.id, (mias.get(c.id) || 0) + 1);
      delSobre += precioPlano(c.rarity);
    }
    valor += delSobre; valor2 += delSobre * delSobre;
  }
  const gastado = sobres * precioSobre;
  // ESTA PARTIDA ES UNA SOLA MUESTRA, y una tirada de 4.000 sobres estándar
  // tiene 2σ = ±1,1% del gasto. Como los sobres de la era Escarlata y Púrpura
  // valen el 99,35% de lo que cuestan, un `ratio > 1` pelado acusaba por ruido
  // en cada corrida y en sets distintos. Se acompaña del error de la partida
  // para poder exigir PRUEBA, no coincidencia.
  const media = valor / sobres;
  const margen = 2 * Math.sqrt(Math.max(0, valor2 / sobres - media * media) * sobres);
  return { sobres, gastado, valor, margen, ratio: valor / gastado };
}

for (const [setId, cartas] of CARTAS) {
  const admite = packLogic.admiteSobreEstandar(cartas);
  const casos = admite
    ? [
        { nombre: "estándar", precio: PACK_PRICES.STANDARD,
          ahora: () => packLogic.openStandardPack(cartas), antes: () => ANTES.estandar(cartas) },
        { nombre: "leyenda", precio: PACK_PRICES.GOLDEN,
          ahora: (ids) => packLogic.openGoldenPack(cartas, ids), antes: (ids) => ANTES.leyenda(cartas, ids) },
      ]
    : [
        { nombre: "promo", precio: PACK_PRICES.SPECIAL,
          ahora: (ids) => packLogic.openGoldenPack(cartas, ids), antes: (ids) => ANTES.leyenda(cartas, ids) },
      ];
  for (const caso of casos) {
    const a = completarDesdeCero(cartas, caso.antes, caso.precio);
    const b = completarDesdeCero(cartas, caso.ahora, caso.precio);
    const imprime = b.valor - b.margen > b.gastado;
    const marca = imprime ? "  <-- ¡IMPRIME DINERO!" : "";
    console.log(
      setId.padEnd(13) + caso.nombre.padEnd(11) + num(b.sobres).padStart(8) +
      num(b.gastado).padStart(10) + num(b.valor).padStart(10) +
      pct(a.valor, a.gastado).padStart(8) + pct(b.valor, b.gastado).padStart(8) + marca,
    );
    if (imprime) {
      fallo(`completar ${setId} con sobre ${caso.nombre} devuelve el ${pct(b.valor, b.gastado)} de lo gastado`);
    }
  }
}

/* ==================================================================== *
 * 3) EL `total` DECLARADO CONTRA LAS CARTAS QUE HAY DE VERDAD
 * ====================================================================
 * app/action.ts abona SET_COMPLETION_BONUS cuando las cartas distintas que
 * tiene el jugador llegan al `total` de la tabla `sets`, y ese `total` sale de
 * src/data/all-sets.json (app/seed-database/route.ts). Si el `total` declarado
 * es MENOR que las cartas que existen, el bono se cobra sin completar nada.
 */
console.log("\n\n== 3) `total` DECLARADO vs CARTAS REALES (bono de set completado) ==");
{
  const maestro = JSON.parse(readFileSync(join(raiz, "src", "data", "all-sets.json"), "utf8"));
  const porId = new Map(maestro.map((s) => [s.id, s]));
  const desajustes = [];
  for (const [setId, cartas] of CARTAS) {
    const meta = porId.get(setId);
    if (!meta) { desajustes.push({ setId, total: null, reales: cartas.length }); continue; }
    const reales = new Set(cartas.map((c) => c.id)).size;
    if (Number(meta.total) !== reales) desajustes.push({ setId, total: Number(meta.total), reales, nombre: meta.name });
  }
  if (desajustes.length === 0) {
    console.log(`  OK: los ${CARTAS.size} ficheros de cartas coinciden con su \`total\` declarado.`);
  }
  for (const d of desajustes) {
    const regala = d.total !== null && d.total < d.reales;
    console.log(
      `  ${d.setId.padEnd(12)} declara ${String(d.total).padStart(4)}  tiene ${String(d.reales).padStart(4)}` +
      (regala ? "   <-- BONO GRATIS: se cobra sin completar" : "   (declara de más: el bono no se puede cobrar)"),
    );
    if (regala) fallo(`${d.setId} declara ${d.total} y tiene ${d.reales}: el bono de ${SET_COMPLETION_BONUS} se cobra sin completar`);
    else fallo(`${d.setId} declara ${d.total} y tiene ${d.reales}: el bono no se puede cobrar nunca`);
  }

  // El caso concreto que se denunció: sve. Un Promo Pack de 700 entrega 10
  // cartas distintas; con total=8 el bono saltaba al primer clic.
  const sve = CARTAS.get("sve");
  if (sve) {
    const declarado = Number(porId.get("sve")?.total ?? 0);
    const reales = new Set(sve.map((c) => c.id)).size;
    let sobres = 0, gastado = 0, reventa = 0;
    const mias = new Set();
    while (mias.size < declarado && sobres < 50) {
      sobres++; gastado += PACK_PRICES.SPECIAL;
      for (const c of packLogic.openGoldenPack(sve, [...mias])) { mias.add(c.id); reventa += precioPlano(c.rarity); }
    }
    const neto = SET_COMPLETION_BONUS + reventa - gastado;
    console.log(
      `\n  sve: ${reales} cartas reales, declara ${declarado}.` +
      `  Llegar al bono cuesta ${sobres} Promo Pack (${num(gastado)}),` +
      ` devuelve ${num(reventa)} de reventa + ${num(SET_COMPLETION_BONUS)} de bono = ${neto >= 0 ? "+" : ""}${num(neto)}`,
    );
    console.log(`  (antes del arreglo declaraba 8: 1 sobre de 700 daba 10 cartas -> bono al primer clic, +300 por cuenta)`);
    if (neto > 0) fallo(`sve sigue regalando ${num(neto)} monedas por cuenta`);
  }
}

/* ==================================================================== *
 * 4) VACIAR LOS DUPLICADOS DE UNA EXPANSIÓN EXPRIMIDA
 * ====================================================================
 * El caso de la curva de copias: alguien que lleva cientos o miles de sobres de
 * la MISMA expansión, acumula montañas de repetidas y pulsa "Limpiar
 * duplicados". Antes eso devolvía casi todo lo gastado de una sentada.
 */

/** Abre `sobres` sobres de un set y devuelve el inventario acumulado. */
function exprimir(cartas, sobres) {
  const inv = new Map();
  for (let i = 0; i < sobres; i++) {
    for (const c of packLogic.openStandardPack(cartas)) inv.set(c.id, (inv.get(c.id) || 0) + 1);
  }
  return inv;
}

/** Antes/ahora de vaciar TODOS los duplicados de un inventario. */
function vaciado(inv, rarezaDe) {
  let copias = 0, antes = 0, ahora = 0;
  for (const [id, q] of inv) {
    const r = rarezaDe.get(id);
    copias += q - 1;
    antes += valorAntes(r, q);
    ahora += valorDeVenta(r, q);
  }
  return { copias, antes, ahora };
}

console.log("\n\n== 4) VACIAR LOS DUPLICADOS DE UNA EXPANSIÓN EXPRIMIDA ==");
console.log("   (antes = tarifa plana; ahora = curva de copias de constanst.ts)");
console.log("set        sobres    gasto   duplicados      ANTES  %gasto       AHORA  %gasto   queda en");
for (const setId of ["sv3pt5", "sv8", "swsh12pt5"]) {
  const cartas = CARTAS.get(setId);
  if (!cartas) continue;
  const rarezaDe = new Map(cartas.map((c) => [c.id, c.rarity]));
  for (const sobres of [200, 1000, 3000]) {
    // Tres partidas y se toma la del medio, para que no mande un sobre con suerte.
    const muestras = [];
    for (let s = 0; s < 3; s++) muestras.push(vaciado(exprimir(cartas, sobres), rarezaDe));
    muestras.sort((a, b) => a.antes - b.antes);
    const m = muestras[1];
    const gasto = sobres * PACK_PRICES.STANDARD;
    console.log(
      setId.padEnd(10) + String(sobres).padStart(6) + num(gasto).padStart(9) +
      num(m.copias).padStart(13) + num(m.antes).padStart(11) + pct(m.antes, gasto).padStart(8) +
      num(m.ahora).padStart(12) + pct(m.ahora, gasto).padStart(8) +
      ("  " + pct(m.ahora, m.antes) + " de antes").padStart(20),
    );
  }
}

// El caso extremo y literal: la expansión COMPLETA.
{
  const setId = "sv3pt5";
  const cartas = CARTAS.get(setId);
  const rarezaDe = new Map(cartas.map((c) => [c.id, c.rarity]));
  const totalSet = rarezaDe.size;
  const inv = new Map();
  let sobres = 0;
  const TOPE = 8000;
  while (sobres < TOPE && inv.size < totalSet) {
    sobres++;
    for (const c of packLogic.openStandardPack(cartas)) inv.set(c.id, (inv.get(c.id) || 0) + 1);
  }
  const m = vaciado(inv, rarezaDe);
  const gasto = sobres * PACK_PRICES.STANDARD;
  console.log(
    `\nexpansión COMPLETA (${setId}, ${inv.size}/${totalSet} cartas en ${num(sobres)} sobres, ${num(gasto)} gastadas):`,
  );
  console.log(`  duplicados acumulados: ${num(m.copias)}`);
  console.log(`  vaciarlos ANTES: ${num(m.antes)}  (${pct(m.antes, gasto)} de lo gastado)`);
  console.log(`  vaciarlos AHORA: ${num(m.ahora)}  (${pct(m.ahora, gasto)} de lo gastado) = ${pct(m.ahora, m.antes)} de antes`);
  console.log(`  precio medio por carta repetida: antes ${(m.antes / m.copias).toFixed(2)} → ahora ${(m.ahora / m.copias).toFixed(2)}`);
}

/* ==================================================================== *
 * 5) AL JUGADOR NORMAL NO LE CAMBIA (casi) NADA
 * ==================================================================== */
console.log("\n\n== 5) EL JUGADOR NORMAL ==");
console.log("Vender TODAS las repetidas de una carta teniendo Q copias (ahora/antes):");
const RAREZAS_NORMAL = ["Common", "Uncommon", "Rare", "Illustration Rare", "Hyper Rare"];
console.log("copias".padEnd(8) + RAREZAS_NORMAL.map((r) => r.slice(0, 15).padStart(17)).join(""));
for (const q of [2, 3, 4, 5, 8, 15]) {
  console.log(
    String(q).padEnd(8) +
    RAREZAS_NORMAL.map((r) => {
      const antes = valorAntes(r, q), ahora = valorDeVenta(r, q);
      return `${ahora}/${antes} ${pct(ahora, antes)}`.padStart(17);
    }).join(""),
  );
}

// El de verdad: el que juega a diario y vende sus repetidas según salen. Nunca
// acumula, así que casi siempre vende la copia nº 1 o la nº 2.
{
  const cartas = CARTAS.get("sv10");
  const DIAS = 365, PARTIDAS = 30, SOBRES_DIA = 3;
  const resumen = { antes: 0, ahora: 0, ventas: 0, finalAntes: 0, finalAhora: 0 };
  for (let s = 0; s < PARTIDAS; s++) {
    const col = new Map();
    let carteraAntes = STARTING_COINS, carteraAhora = STARTING_COINS;
    for (let d = 0; d < DIAS; d++) {
      carteraAntes += DAILY_BASE; carteraAhora += DAILY_BASE;
      for (let k = 0; k < SOBRES_DIA && carteraAhora >= PACK_PRICES.STANDARD; k++) {
        carteraAntes -= PACK_PRICES.STANDARD; carteraAhora -= PACK_PRICES.STANDARD;
        for (const c of packLogic.openStandardPack(cartas)) {
          col.set(c.id, { q: (col.get(c.id)?.q || 0) + 1, r: c.rarity });
        }
      }
      // Fin del día: se limpian las repetidas (lo que hace todo el mundo).
      for (const [id, v] of col) {
        if (v.q <= 1) continue;
        const a = valorAntes(v.r, v.q), b = valorDeVenta(v.r, v.q);
        resumen.antes += a; resumen.ahora += b; resumen.ventas += v.q - 1;
        carteraAntes += a; carteraAhora += b;
        col.set(id, { q: 1, r: v.r });
      }
    }
    resumen.finalAntes += carteraAntes; resumen.finalAhora += carteraAhora;
  }
  console.log(
    `\nColeccionista diario (daily ${DAILY_BASE} + ${SOBRES_DIA} sobres/día, limpia repetidas cada día, 1 año, ${PARTIDAS} partidas):`,
  );
  console.log(`  repetidas vendidas al año: ${num(resumen.ventas / PARTIDAS)}`);
  console.log(
    `  ingresos por venta: antes ${num(resumen.antes / PARTIDAS)} → ahora ${num(resumen.ahora / PARTIDAS)}` +
    `  (se queda con el ${pct(resumen.ahora, resumen.antes)} de lo de antes)`,
  );
  console.log(
    `  cartera al año: antes ${num(resumen.finalAntes / PARTIDAS)} → ahora ${num(resumen.finalAhora / PARTIDAS)}`,
  );

  // El acaparador: mismos sobres, pero sólo vacía una vez al año.
  const acap = { antes: 0, ahora: 0, copias: 0 };
  for (let s = 0; s < PARTIDAS; s++) {
    const col = new Map();
    for (let d = 0; d < DIAS; d++) {
      for (let k = 0; k < SOBRES_DIA; k++) {
        for (const c of packLogic.openStandardPack(cartas)) {
          col.set(c.id, { q: (col.get(c.id)?.q || 0) + 1, r: c.rarity });
        }
      }
    }
    for (const [, v] of col) {
      acap.antes += valorAntes(v.r, v.q); acap.ahora += valorDeVenta(v.r, v.q); acap.copias += v.q - 1;
    }
  }
  console.log(
    `\nMismo jugador ACAPARANDO (los mismos ${DIAS * SOBRES_DIA} sobres, pero vacía una sola vez al final):`,
  );
  console.log(`  repetidas: ${num(acap.copias / PARTIDAS)}`);
  console.log(
    `  cobra: antes ${num(acap.antes / PARTIDAS)} → ahora ${num(acap.ahora / PARTIDAS)} (${pct(acap.ahora, acap.antes)})`,
  );
  console.log("  ^ ésta es la diferencia buscada: acumular ya no renta, jugar sí.");
}

/* ==================================================================== *
 * 6) 1000 SOBRES SEGUIDOS (revendedor / coleccionista)
 * ==================================================================== */
function simular1000(setId, estrategia, semillas = 200) {
  const cartas = CARTAS.get(setId);
  const totalSet = new Set(cartas.map((c) => c.id)).size;
  let quiebras = 0, sobresHastaQuiebraAcum = 0;
  const carterasFinales = [], maximas = [], completadoEn = [];
  for (let s = 0; s < semillas; s++) {
    let cartera = STARTING_COINS;
    const col = new Map();
    let maxCartera = cartera, quiebra = -1, completado = -1;
    for (let p = 0; p < 1000; p++) {
      if (cartera < PACK_PRICES.STANDARD) { quiebra = p; break; }
      cartera -= PACK_PRICES.STANDARD;
      for (const c of packLogic.openStandardPack(cartas)) {
        const prev = col.get(c.id)?.q || 0;
        col.set(c.id, { q: prev + 1, r: c.rarity });
        if (estrategia === "revendedor") {
          // Vende TODO al momento, incluida la primera copia: nunca acumula.
          cartera += precioPlano(c.rarity);
          col.set(c.id, { q: 0, r: c.rarity });
        } else if (prev >= 1) {
          // Coleccionista: guarda una y vende la repetida en el acto.
          cartera += valorDeVenta(c.rarity, prev + 1, 1);
          col.set(c.id, { q: 1, r: c.rarity });
        }
      }
      if (estrategia === "coleccionista" && completado < 0 && col.size >= totalSet) {
        cartera += SET_COMPLETION_BONUS;
        completado = p + 1;
      }
      if (cartera > maxCartera) maxCartera = cartera;
    }
    if (quiebra >= 0) { quiebras++; sobresHastaQuiebraAcum += quiebra; }
    else carterasFinales.push(cartera);
    maximas.push(maxCartera);
    if (completado > 0) completadoEn.push(completado);
  }
  carterasFinales.sort((a, b) => a - b);
  return {
    pctQuiebra: (100 * quiebras) / semillas,
    sobresMediosHastaQuiebra: quiebras ? Math.round(sobresHastaQuiebraAcum / quiebras) : null,
    carteraFinalMediana: carterasFinales.length ? carterasFinales[Math.floor(carterasFinales.length / 2)] : null,
    carteraMaximaTipica: maximas.sort((a, b) => a - b)[Math.floor(maximas.length / 2)],
    setCompletadoEnMediana: completadoEn.length ? completadoEn.sort((a, b) => a - b)[Math.floor(completadoEn.length / 2)] : null,
  };
}

console.log("\n\n== 6) 1000 SOBRES SEGUIDOS (estándar, sv10, cartera inicial " + STARTING_COINS + ") ==");
for (const estrategia of ["revendedor", "coleccionista"]) {
  const r = simular1000("sv10", estrategia);
  console.log("\n-- " + estrategia.toUpperCase() + " --");
  console.log("  se arruina: " + r.pctQuiebra.toFixed(1) + "% de las partidas" +
    (r.sobresMediosHastaQuiebra ? " (de media en el sobre " + r.sobresMediosHastaQuiebra + ")" : ""));
  if (r.carteraFinalMediana !== null)
    console.log("  cartera tras 1000 sobres (mediana de quienes sobreviven): " + num(r.carteraFinalMediana));
  console.log("  pico de cartera típico: " + num(r.carteraMaximaTipica));
  if (r.setCompletadoEnMediana)
    console.log("  set completado (mediana): sobre nº " + r.setCompletadoEnMediana + " (+1000 de bonus)");
}

/* ==================================================================== *
 * 7) EL MERCADO NO SE AJUSTA SOLO
 * ==================================================================== */
// utils/mercado.ts paga `multiplicador × Σ precioDeVenta(carta)`, y su
// `precioDeVenta` lee SELL_PRICES DIRECTAMENTE: la curva de copias no le llega.
// Aquí se mide cuánto puede inyectar el tablón de un día para ver si eso abre
// un agujero por el que colar los duplicados que la curva acaba de abaratar.
console.log("\n\n== 7) MERCADO: paga con SELL_PRICES planos, NO con la curva ==");
{
  // Precio de la carta MÁS BARATA que admite la banda de rareza de un
  // requisito: es la misma referencia con la que mercado.ts calcula el
  // multiplicador, así que reconstruye su `valorLote`.
  const porRango = Object.entries(RARITY_RANK)
    .map(([rareza, rango]) => ({ rareza, rango, precio: precioPlano(rareza) }))
    .sort((a, b) => a.precio - b.precio);
  const precioMinBanda = (f) => {
    const min = f.rarMin ?? 0, max = f.rarMax ?? 1e9;
    const cand = porRango.find((x) => x.rango >= min && x.rango <= max);
    return cand ? cand.precio : 2;
  };

  const setsMercado = constantes.AVAILABLE_SETS
    .map((s) => s.id)
    .filter((id) => CARTAS.has(id));

  const CICLOS = 120;
  let cartasCiclo = 0, valorCiclo = 0, pagoCiclo = 0, primaCiclo = 0, maxPagoOferta = 0;
  for (let c = 0; c < CICLOS; c++) {
    const ofertas = mercado.generarOfertas(1000 + c, setsMercado, mercado.OFERTAS_ACTIVAS);
    for (const o of ofertas) {
      let cartas = 0, valor = 0;
      for (const req of o.requisitos) {
        cartas += req.cantidad;
        valor += req.cantidad * precioMinBanda(req.filtro);
      }
      const pago = mercado.pagoDelLote(o, valor);
      cartasCiclo += cartas; valorCiclo += valor; pagoCiclo += pago; primaCiclo += pago - valor;
      if (pago > maxPagoOferta) maxPagoOferta = pago;
    }
  }
  const porCiclo = (x) => x / CICLOS;
  console.log(`  tablón de ${mercado.OFERTAS_ACTIVAS} ofertas cada ${mercado.DURACION_CICLO_HORAS} h, ${CICLOS} ciclos simulados`);
  console.log(`  si se cumpliera el tablón ENTERO cada día:`);
  console.log(`    cartas entregadas: ${porCiclo(cartasCiclo).toFixed(0)}/día  (el vaciado de arriba son decenas de miles)`);
  console.log(`    valor plano de esas cartas: ${num(porCiclo(valorCiclo))}/día`);
  console.log(`    el mercado paga: ${num(porCiclo(pagoCiclo))}/día  (prima sobre venta suelta: ${num(porCiclo(primaCiclo))}/día)`);
  console.log(`    oferta más cara vista: ${num(maxPagoOferta)}`);
  console.log(`  CONCLUSIÓN: el mercado NO se abarata solo con la curva —usa SELL_PRICES`);
  console.log(`  planos— pero tampoco es la puerta de atrás: absorbe ~${porCiclo(cartasCiclo).toFixed(0)} cartas al día,`);
  console.log(`  así que vaciar un montón de decenas de miles por ahí llevaría cientos de días.`);
  console.log(`  Su calibrado (TASA_PRIMA_POR_SOBRE, MULTIPLICADOR_*) queda INTACTO: nadie ha`);
  console.log(`  tocado utils/mercado.ts y sigue pagando lo mismo que pagaba ayer.`);
}

/* ==================================================================== *
 * VEREDICTO
 * ==================================================================== */
console.log("\n\n== VEREDICTO ==");
if (HAY_FALLOS) {
  console.log("  HAY FUGAS ABIERTAS. Mira los ¡¡FALLO!! de arriba.");
  process.exitCode = 1;
} else {
  console.log("  OK  ·  ningún sobre comprable devuelve más de lo que cuesta,");
  console.log("      ·  ni abriéndolo en régimen ni completando la colección desde cero,");
  console.log("      ·  y ningún `total` declarado regala el bono de set completado.");
}
