// Invariantes del juego. Esto es `npm test`.
//
// POR QUÉ EXISTE Y POR QUÉ NO BASTA CON LAS SIMULACIONES: sim-economia.mjs y
// sim-mercado.mjs ya calculan lo difícil, pero se ejecutan a mano y ninguna
// sirve como puerta de CI. sim-mercado es puramente informativa, y
// sim-economia es ESTADÍSTICA: contrasta ~90 filas de Montecarlo (20.000 sobres
// por set y tipo) contra el cálculo cerrado con márgenes en σ, y su propio
// comentario lo admite —"a 2σ un desvío legítimo salta solo por sorteo varias
// veces al día"—. Se ha visto saltar y no reproducirse en las tres pasadas
// siguientes. Un test que falla por azar acaba ignorándose, y entonces no
// protege de nada.
//
// Así que aquí va sólo lo DETERMINISTA: mismas entradas, mismo resultado,
// siempre. Incluye el guardián que de verdad importa —ningún sobre a la venta
// vale más de lo que cuesta— en su versión de cálculo cerrado, que es exacta y
// tarda segundos. El Montecarlo se queda en `npm run sim:economia` como
// contraste que se pasa a mano al tocar precios.
//
// Uso:  npm test
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { transform, loadBindings } from "next/dist/build/swc/index.js";

await loadBindings();
const raiz = process.cwd();

// Mismo cargador que sim-mercado.mjs: `require` de verdad, porque packLogic.ts
// y mercado.ts importan de constanst.ts.
const cache = new Map();
async function cargarModulo(rel) {
  const clave = resolve(raiz, rel);
  if (cache.has(clave)) return cache.get(clave);
  const { code } = await transform(readFileSync(clave, "utf8"), {
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

const {
  SELL_PRICES, PACK_PRICES, RARITY_RANK, COPIAS_PROTEGIDAS,
  valorDeVenta, precioDeCartaSuelta,
} = constantes;
const {
  openStandardPack, openPremiumPack, openGoldenPack,
  composicionDelSobre, cartasDelSobre,
  admiteSobreEstandar, admiteSobrePremium,
  valorEsperadoEstandar, valorEsperadoPremium,
} = packLogic;
const { generarOfertas, OFERTAS_ACTIVAS, COPIAS_RESERVADAS } = mercado;

/* ------------------------------------------------------------------ */

let fallos = 0;
let pasados = 0;

const seccion = (t) => console.log("\n== " + t + " ==");
const ok = (t) => {
  pasados++;
  console.log("  ok    " + t);
};
const mal = (t, detalle) => {
  fallos++;
  console.log("  FALLO " + t + (detalle ? "\n          " + detalle : ""));
};
const comprueba = (cond, t, detalle) => (cond ? ok(t) : mal(t, detalle));

/* ------------------------------------------------------------------ */
/* CARTAS REALES                                                       */
/* ------------------------------------------------------------------ */

const DATA = join(raiz, "src", "data");
const setIds = readdirSync(DATA)
  .filter((f) => f.endsWith(".json") && f !== "all-sets.json")
  .map((f) => f.replace(/\.json$/, ""));

const CARTAS = new Map();
for (const id of setIds) {
  const crudo = JSON.parse(readFileSync(join(DATA, id + ".json"), "utf8"));
  const lista = Array.isArray(crudo) ? crudo : crudo.data || [];
  CARTAS.set(
    id,
    lista.map((c) => ({
      id: c.id,
      name: c.name,
      rarity: c.rarity || "Common",
      images: c.images ?? { small: "", large: "" },
    })),
  );
}

/* ------------------------------------------------------------------ */
seccion("Sobres: lo que se anuncia es lo que se reparte");
/* ------------------------------------------------------------------ */

/* Es el arreglo P-02/P-03/P-04: la tienda ANUNCIA número de cartas,
 * probabilidades y raras garantizadas derivándolos de composicionDelSobre. Si
 * esa función y los generadores se separaran, la tienda volvería a mentir sin
 * que nadie se enterase. Se comprueba en TODAS las expansiones. */
{
  const generadores = {
    STANDARD: (c) => openStandardPack(c),
    PREMIUM: (c) => openPremiumPack(c),
    GOLDEN: (c) => openGoldenPack(c, []),
    SPECIAL: (c) => openGoldenPack(c, []),
  };
  const malos = [];
  for (const [setId, cartas] of CARTAS) {
    for (const tipo of Object.keys(generadores)) {
      const anunciado = cartasDelSobre(cartas, tipo);
      const real = generadores[tipo](cartas).length;
      if (anunciado !== real) malos.push(`${setId} ${tipo}: anuncia ${anunciado}, reparte ${real}`);
    }
  }
  comprueba(
    malos.length === 0,
    `el número de cartas anunciado coincide con el repartido (${CARTAS.size} expansiones x 4 sobres)`,
    malos.slice(0, 5).join("\n          "),
  );
}

{
  // Las raras "aseguradas" del Premium que pinta la tienda salen del hueco
  // calibrado, no de una constante escrita a mano.
  const malos = [];
  for (const [setId, cartas] of CARTAS) {
    const comp = composicionDelSobre(cartas, "PREMIUM");
    const anunciadas = comp.huecos.find((h) => h.pool === "rare")?.cantidad ?? 0;
    const sobre = openPremiumPack(cartas);
    // Cuenta cuántas cartas del sobre salen del pool de raras. Sólo se puede
    // comprobar cuando el pool existe: si no, el hueco cae al respaldo.
    if (!comp.huecos.find((h) => h.pool === "rare")?.disponible) continue;
    const raras = sobre.filter((c) => c.rarity === "Rare" || c.rarity === "Rare Holo").length;
    if (raras < anunciadas) malos.push(`${setId}: anuncia ${anunciadas} raras y salieron ${raras}`);
  }
  comprueba(
    malos.length === 0,
    "el Premium reparte al menos las raras que anuncia",
    malos.slice(0, 5).join("\n          "),
  );
}

{
  // Una rama de premio marcada como disponible tiene que tener cartas de VERDAD
  // en ese pool: es lo que hace honesto el porcentaje que se pinta.
  const malos = [];
  for (const [setId, cartas] of CARTAS) {
    for (const tipo of ["STANDARD", "PREMIUM"]) {
      const comp = composicionDelSobre(cartas, tipo);
      const suma = comp.premio.reduce((s, r) => s + r.prob, 0);
      if (Math.abs(suma - 100) > 0.001) {
        malos.push(`${setId} ${tipo}: las ramas suman ${suma}%`);
      }
      for (const r of comp.premio) {
        if (r.disponible && r.real !== r.pool) {
          malos.push(`${setId} ${tipo}: ${r.pool} se dice disponible pero cae en ${r.real}`);
        }
      }
    }
  }
  comprueba(
    malos.length === 0,
    "las probabilidades del premio suman 100% y sólo se anuncian los escalones que existen",
    malos.slice(0, 5).join("\n          "),
  );
}

{
  // El sobre Leyenda garantiza una carta que NO tienes. Es su única promesa.
  const malos = [];
  for (const [setId, cartas] of CARTAS) {
    if (cartas.length < 12) continue;
    // Se simula tener todo menos las cinco últimas.
    const poseidas = cartas.slice(0, -5).map((c) => c.id);
    const tengo = new Set(poseidas);
    for (let i = 0; i < 40; i++) {
      const sobre = openGoldenPack(cartas, poseidas);
      const garantizada = sobre[sobre.length - 1];
      if (tengo.has(garantizada.id)) {
        malos.push(`${setId}: la garantizada (${garantizada.id}) ya estaba en la colección`);
        break;
      }
    }
  }
  comprueba(
    malos.length === 0,
    "el sobre Leyenda garantiza una carta que no tienes",
    malos.slice(0, 5).join("\n          "),
  );
}

/* ------------------------------------------------------------------ */
seccion("Sobres: ninguno devuelve más de lo que cuesta");
/* ------------------------------------------------------------------ */

/* Es el guardián de sim-economia.mjs, en su versión de cálculo cerrado: barata
 * y determinista, así que puede correr en cada commit. La versión Montecarlo,
 * más lenta, sigue allí. */
{
  const malos = [];
  for (const [setId, cartas] of CARTAS) {
    if (admiteSobreEstandar(cartas)) {
      const v = valorEsperadoEstandar(cartas);
      if (v > PACK_PRICES.STANDARD) {
        malos.push(`${setId} estándar: ${v.toFixed(2)} de ${PACK_PRICES.STANDARD}`);
      }
    }
    if (admiteSobrePremium(cartas)) {
      const v = valorEsperadoPremium(cartas);
      if (v > PACK_PRICES.PREMIUM) {
        malos.push(`${setId} premium: ${v.toFixed(2)} de ${PACK_PRICES.PREMIUM}`);
      }
    }
  }
  comprueba(
    malos.length === 0,
    "ningún sobre a la venta tiene valor esperado por encima de su precio",
    malos.join("\n          "),
  );
}

/* ------------------------------------------------------------------ */
seccion("Curva de precios de las repetidas");
/* ------------------------------------------------------------------ */

{
  // La promesa explícita de utils/constanst.ts: vender de una en una y vender
  // de golpe tienen que dar EXACTAMENTE lo mismo, o trocear la venta sería una
  // forma de sacarle más dinero a la curva.
  const malos = [];
  for (const rareza of Object.keys(SELL_PRICES)) {
    for (const copias of [2, 3, 5, 8, 13, 44, 120]) {
      const golpe = valorDeVenta(rareza, copias);
      let trozos = 0;
      for (let n = copias; n > COPIAS_PROTEGIDAS; n--) trozos += valorDeVenta(rareza, n, 1);
      if (golpe !== trozos) {
        malos.push(`${rareza} x${copias}: de golpe ${golpe}, de una en una ${trozos}`);
      }
    }
  }
  comprueba(
    malos.length === 0,
    "trocear la venta da el mismo dinero que venderlo de golpe",
    malos.slice(0, 5).join("\n          "),
  );
}

{
  const malos = [];
  for (const rareza of Object.keys(SELL_PRICES)) {
    let previo = Infinity;
    for (let n = 1; n <= 60; n++) {
      const precio = valorDeVenta(rareza, n + COPIAS_PROTEGIDAS, 1);
      if (precio > previo) malos.push(`${rareza}: la copia ${n} paga más que la anterior`);
      if (precio < 1) malos.push(`${rareza}: la copia ${n} se regala (${precio})`);
      previo = precio;
    }
  }
  comprueba(
    malos.length === 0,
    "cada copia repetida vale igual o menos que la anterior, y ninguna se regala",
    malos.slice(0, 5).join("\n          "),
  );
}

comprueba(
  valorDeVenta("Hyper Rare", 1) === 0 && valorDeVenta("Common", 1) === 0,
  "la copia única nunca se vende (el álbum no se vacía)",
);

/* ------------------------------------------------------------------ */
seccion("Tablas de rareza");
/* ------------------------------------------------------------------ */

{
  // Toda rareza con precio tiene que tener rango: si no, una carta cara se
  // revela con la misma ceremonia que una común (el respaldo de rankOf tapa el
  // agujero, pero el orden del álbum no).
  const sinRango = Object.keys(SELL_PRICES).filter((r) => !(r in RARITY_RANK));
  comprueba(sinRango.length === 0, "toda rareza con precio tiene rango en RARITY_RANK", sinRango.join(", "));

  const sinPrecio = Object.keys(RARITY_RANK).filter((r) => !(r in SELL_PRICES));
  comprueba(sinPrecio.length === 0, "toda rareza con rango tiene precio en SELL_PRICES", sinPrecio.join(", "));
}

{
  // El respaldo de precioDeCartaSuelta no puede quedarse por encima de una
  // rareza real barata: sería más rentable una rareza desconocida.
  const minimo = Math.min(...Object.values(SELL_PRICES));
  comprueba(
    precioDeCartaSuelta("rareza-que-no-existe") >= minimo,
    "el precio de respaldo de una rareza desconocida es coherente",
  );
}

{
  // Rarezas que aparecen en las cartas reales y no están en ninguna tabla.
  const vistas = new Set();
  for (const cartas of CARTAS.values()) for (const c of cartas) vistas.add(c.rarity);
  const huerfanas = [...vistas].filter((r) => !(r in SELL_PRICES));
  comprueba(
    huerfanas.length === 0,
    `las ${vistas.size} rarezas que existen en los datos tienen precio`,
    huerfanas.join(", "),
  );
}

/* ------------------------------------------------------------------ */
seccion("Mercado");
/* ------------------------------------------------------------------ */

{
  // El tablón es PURO: la misma semilla tiene que dar exactamente las mismas
  // ofertas, o lo que se pinta y lo que se cobra dejarían de coincidir.
  const ids = setIds.slice().sort((a, b) => a.localeCompare(b));
  let malos = [];
  for (const ciclo of [0, 1, 12345, 20486, 987654]) {
    const a = generarOfertas(ciclo, ids, OFERTAS_ACTIVAS);
    const b = generarOfertas(ciclo, ids, OFERTAS_ACTIVAS);
    if (JSON.stringify(a) !== JSON.stringify(b)) malos.push(`ciclo ${ciclo} no es determinista`);
    if (a.length !== OFERTAS_ACTIVAS) malos.push(`ciclo ${ciclo} generó ${a.length} ofertas`);
    for (const o of a) {
      const cartas = o.requisitos.reduce((s, r) => s + r.cantidad, 0);
      // El servidor rechaza entregas de más de 40 cartas (MAX_CARTAS_ENTREGA).
      if (cartas > 40) malos.push(`oferta ${o.id} pide ${cartas} cartas: no se puede cobrar`);
    }
  }
  comprueba(malos.length === 0, "el tablón es determinista y toda oferta es cobrable", malos.slice(0, 5).join("\n          "));
}

{
  // Pasar los rótulos de expansión NO puede cambiar el sorteo: sólo es texto.
  const ids = setIds.slice().sort((a, b) => a.localeCompare(b));
  const nombres = Object.fromEntries(ids.map((id) => [id, "NOMBRE-" + id]));
  const sin = generarOfertas(4242, ids, OFERTAS_ACTIVAS);
  const con = generarOfertas(4242, ids, OFERTAS_ACTIVAS, nombres);
  const mismosIds = JSON.stringify(sin.map((o) => o.id)) === JSON.stringify(con.map((o) => o.id));
  const mismosFiltros =
    JSON.stringify(sin.map((o) => o.requisitos.map((r) => [r.filtro, r.cantidad, r.setId]))) ===
    JSON.stringify(con.map((o) => o.requisitos.map((r) => [r.filtro, r.cantidad, r.setId])));
  comprueba(mismosIds && mismosFiltros, "los rótulos de expansión no alteran el tablón (sólo el texto)");
}

comprueba(
  COPIAS_RESERVADAS === COPIAS_PROTEGIDAS,
  "el mercado y la venta reservan el mismo número de copias",
  `mercado ${COPIAS_RESERVADAS} vs venta ${COPIAS_PROTEGIDAS}`,
);

/* NINGUNA OFERTA PUEDE SER IMPOSIBLE.
 *
 * Esta comprobación existe porque el fallo ya pasó: al derivar el catálogo del
 * mercado de los ficheros de datos en vez de una lista escrita a mano, entraron
 * nueve subsets sin pirámide de rarezas (Trainer Gallery, Shiny Vault, Galarian
 * Gallery, promos) y el 11,5% del tablón quedó sin poder cumplirse nunca. Es el
 * tipo de fallo que no rompe nada, no sale en ningún log y sólo lo ve el jugador
 * que se queda mirando una barra clavada en 0.
 *
 * Se replica el filtro de `admiteOfertaAtada` (app/action.ts) y se comprueba que
 * con él NO queda ni una oferta imposible. Si alguien cambia el filtro, las
 * bandas de utils/mercado.ts o la lista de expansiones, aquí salta. */
{
  const banda = (r) => RARITY_RANK[r ?? ""] ?? 1;
  const atable = (cartas) => {
    let morralla = false;
    let raras = false;
    for (const c of cartas) {
      const k = banda(c.rarity);
      if (k >= 1 && k <= 5) morralla = true;
      else if (k >= 10 && k <= 20) raras = true;
      if (morralla && raras) return true;
    }
    return false;
  };

  // El catálogo COMPLETO de cada set, no sólo id/rareza: cumpleFiltro mira
  // tipos, etapa, ilustrador y línea evolutiva.
  const completo = new Map();
  for (const id of setIds) {
    const crudo = JSON.parse(readFileSync(join(DATA, id + ".json"), "utf8"));
    const lista = Array.isArray(crudo) ? crudo : crudo.data || [];
    completo.set(
      id,
      lista.map((c) => ({
        id: c.id, name: c.name, rarity: c.rarity || "Common", supertype: c.supertype,
        subtypes: c.subtypes ?? [], types: c.types ?? [], evolvesFrom: c.evolvesFrom,
        hp: c.hp, artist: c.artist,
        nationalPokedexNumbers: c.nationalPokedexNumbers ?? [], set: { id },
      })),
    );
  }

  const admitidos = setIds
    .filter((id) => atable(completo.get(id)))
    .sort((a, b) => a.localeCompare(b));

  const { cumpleFiltro, setDeCarta } = mercado;
  const imposibles = new Map();
  let ofertas = 0;
  for (let ciclo = 0; ciclo < 200; ciclo++) {
    for (const o of generarOfertas(ciclo, admitidos, OFERTAS_ACTIVAS)) {
      ofertas++;
      for (const r of o.requisitos) {
        if (r.setId === null) continue;
        const pool = completo.get(r.setId) ?? [];
        const validas = pool.filter((c) => setDeCarta(c) === r.setId && cumpleFiltro(c, r.filtro));
        if (validas.length === 0) {
          imposibles.set(r.setId, (imposibles.get(r.setId) ?? 0) + 1);
          break;
        }
      }
    }
  }
  comprueba(
    imposibles.size === 0,
    `ninguna oferta atada es imposible de cumplir (${ofertas} ofertas, ${admitidos.length} expansiones)`,
    [...imposibles].map(([s, n]) => `${s}: ${n} ofertas`).join(", "),
  );
  comprueba(
    admitidos.length < setIds.length,
    `el filtro de expansiones atables deja fuera las que no tienen pirámide (${setIds.length - admitidos.length} de ${setIds.length})`,
  );
}

/* ------------------------------------------------------------------ */
/* VEREDICTO                                                           */
/* ------------------------------------------------------------------ */

console.log("\n== VEREDICTO ==");
if (fallos > 0) {
  console.log(`  ${fallos} INVARIANTE(S) ROTA(S) de ${pasados + fallos}.`);
  process.exitCode = 1;
} else {
  console.log(`  OK · ${pasados} invariantes se mantienen.`);
}
