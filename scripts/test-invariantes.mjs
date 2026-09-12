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
// Los dos módulos nuevos. Igual que packLogic, no importan nada fuera de
// utils/, así que el cargador de arriba los resuelve sin tocar nada.
const graduacion = await cargarModulo("utils/graduacion.ts");
const bazar = await cargarModulo("utils/bazar.ts");
/* El reparto del lote del mercado. Vivía dentro de app/mercado/page.tsx, que
 * importa React, Clerk y framer-motion, así que este cargador NO podía abrirlo y
 * la parte más delicada de esa pantalla era la única de la que ningún invariante
 * podía decir nada. Se sacó a utils/ para poder escribir los de más abajo; la
 * cabecera del módulo explica por qué no puede volver a importar nada de app/. */
const repartoMercado = await cargarModulo("utils/repartoMercado.ts");
/* El emparejamiento de sobres con Bulbapedia. Vive en services/ y no en utils/
 * porque lo comparten un script y un cron, pero cumple la misma condición que
 * los de arriba —no importa NADA— y por eso este cargador lo resuelve.
 *
 * Que se pueda probar aquí es media razón de que se extrajera: mientras fue
 * código suelto dentro de scripts/bajar-sobres-bulbapedia.mjs, la única forma
 * de comprobarlo era ejecutar el script entero contra la wiki. */
const sobres = await cargarModulo("services/sobresEmparejar.ts");

const {
  SELL_PRICES, PACK_PRICES, RARITY_RANK, COPIAS_PROTEGIDAS,
  valorDeVenta, precioDeCartaSuelta,
} = constantes;
const {
  openStandardPack, openPremiumPack, openGoldenPack,
  composicionDelSobre, cartasDelSobre,
  admiteSobreEstandar, admiteSobrePremium,
  RELLENO_ESTANDAR, eraDeSerie,
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
/* EL REPARTO DEL MERCADO                                              */
/* ------------------------------------------------------------------ */
/*
 * POR QUÉ ESTA SECCIÓN: la pantalla del mercado decide, sin preguntar a nadie,
 * qué copias del álbum van a cada requisito de una oferta. Esa decisión no es un
 * detalle de presentación: es lo que hace que el botón se ponga verde o gris, y
 * el jugador no tiene forma de discutirla.
 *
 * El fallo que se vigila aquí no lanza excepción, no rompe nada y no deja hueco
 * en ningún sitio: con dos requisitos que compiten por las mismas cartas
 * —"8 cartas de tipo Fuego o Lucha" + "3 cartas de Kalos"—, si el reparto gasta
 * las tres de Kalos más baratas y resultan ser además de Fuego, el requisito
 * exigente se queda sin material que sólo él podía usar y LA OFERTA SE VE
 * INCOMPLETA TENIÉNDOLO TODO. El juego le dice al jugador que no puede hacer
 * algo que sí puede.
 *
 * Contra eso existen las dos defensas de `repartir`: PRIORIDAD (los requisitos
 * que menos alternativas admiten se sirven primero) y "utilidad" (dentro de cada
 * requisito se gastan antes las cartas que menos sirven a los que faltan). Ni
 * una ni otra se notan cuando funcionan, así que sin invariantes se pueden
 * borrar por "simplificar" y nadie se entera hasta que un jugador se queda
 * mirando una barra clavada.
 *
 * Y desde que el jugador puede CLAVAR cartas a mano hay un segundo fallo, peor,
 * porque parece culpa suya: que su elección deje la oferta incompleta, o que le
 * deje un chip que no puede soltar.
 */
{
  seccion("Mercado: el reparto del lote entre los requisitos");

  const {
    repartir, candidatasPara, normalizarFijadas, podarFijadas,
    coloresDistintos, ordenDeRequisitos, PRIORIDAD, sirve, comparar, esFijable,
  } = repartoMercado;
  const { copiasEntregables, setDeCarta } = mercado;

  /* Constructores mínimos. Una CartaMercado es una CartaMinima más las dos cosas
   * que el mercado necesita: cuántas copias tiene el jugador y cuánto vale cada
   * una. El id lleva el set delante ("xy1-3") porque `setDeCarta` lo deduce de
   * ahí cuando la carta no trae `set`. */
  const carta = (id, o = {}) => ({
    id,
    name: o.name ?? id,
    rarity: o.rarity ?? "Common",
    supertype: o.supertype ?? "Pokémon",
    subtypes: o.subtypes ?? [],
    types: o.types ?? [],
    evolvesFrom: o.evolvesFrom,
    cantidad: o.cantidad ?? 2,
    precio: o.precio ?? 5,
  });
  const req = (categoria, cantidad, filtro = {}, setId = null) => ({
    descripcion: `${cantidad} de ${categoria}`,
    cantidad,
    filtro: { categoria, ...filtro },
    setId,
  });
  const oferta = (id, requisitos) => ({
    id, titulo: id, descripcion: id, requisitos,
    multiplicador: 2, dificultad: "media", setId: null,
  });
  /* Lo que el jugador tiene clavado AHORA MISMO, leído de un reparto ya hecho:
   * una entrada por hueco, con el id en los que él fijó y null en los demás. Es
   * exactamente lo que guarda la pantalla. */
  const fijadasDe = (reparto) =>
    new Map(reparto.partes.map((p, i) => [i, p.elegidas.map((c, j) => (p.fijas[j] ? c.id : null))]));
  const marcador = (r) => r.partes.map((p) => `${p.elegidas.length}/${p.requisito.cantidad}`).join(" ");

  /* CUÁNTOS COLORES DISTINTOS cubre un grupo, contado A LO BRUTO: se prueban
   * todas las asignaciones carta→tipo y se queda la mejor. Es exponencial y aquí
   * da igual (los arcoíris son de dos a cuatro cartas), pero tiene que ser
   * código INDEPENDIENTE de `coloresDistintos`: un validador que llama a la
   * misma función que vigila comparte con ella cualquier defecto que tenga, así
   * que se pondría verde justo en el caso que debería cazar. */
  function coloresAMano(cartas) {
    const tiposDe = cartas.map((c) =>
      [...new Set((c.types ?? []).map((t) => String(t).trim().toLowerCase()))].filter(Boolean));
    let mejor = 0;
    const rec = (i, usados) => {
      if (i === tiposDe.length) { mejor = Math.max(mejor, usados.size); return; }
      rec(i + 1, usados); // esta carta se queda sin color
      for (const t of tiposDe[i]) {
        if (usados.has(t)) continue;
        usados.add(t);
        rec(i + 1, usados);
        usados.delete(t);
      }
    };
    rec(0, new Set());
    return mejor;
  }

  /* ----------------------------------------------------------------
   * EL VALIDADOR DEL LOTE
   * ----------------------------------------------------------------
   * Lo que un reparto no puede hacer NUNCA, pase lo que pase con la oferta, la
   * colección o lo que el jugador haya clavado. Devuelve la lista de pegas para
   * que el invariante pueda decir cuál ha saltado y en qué caso.
   */
  function pegasDelLote(of, cartas, reparto) {
    const pegas = [];
    const porId = new Map(cartas.map((c) => [c.id, c]));

    // Ninguna copia se entrega dos veces, y la copia del álbum no se entrega
    // nunca: el servidor exige `entregadas + COPIAS_RESERVADAS` y rechazaría el
    // lote con el botón ya en verde.
    const entregadas = new Map();
    for (const id of reparto.ids) entregadas.set(id, (entregadas.get(id) ?? 0) + 1);
    for (const [id, n] of entregadas) {
      const c = porId.get(id);
      if (!c) { pegas.push(`entrega ${id}, que no está en la colección`); continue; }
      if (n > copiasEntregables(c.cantidad)) {
        pegas.push(`entrega ${n} de ${id} teniendo ${c.cantidad} (entregables ${copiasEntregables(c.cantidad)})`);
      }
    }

    // `ids`, `valor` y `completa` son lo que hay en las partes, no otra cuenta.
    const todas = reparto.partes.flatMap((p) => p.elegidas);
    if (reparto.ids.join("|") !== todas.map((c) => c.id).join("|")) {
      pegas.push("reparto.ids no es lo que hay en las partes");
    }
    if (reparto.valor !== todas.reduce((t, c) => t + c.precio, 0)) pegas.push("el valor del lote no suma");
    if (reparto.completa !== reparto.partes.every((p) => p.completo)) {
      pegas.push("`completa` no es que lo estén todos los requisitos");
    }
    // Una oferta completa entrega EXACTAMENTE lo que pide: ni una carta de más
    // (que sería regalarla) ni de menos (que el servidor rechaza).
    if (reparto.completa) {
      const pedidas = of.requisitos.reduce((t, r) => t + r.cantidad, 0);
      if (reparto.ids.length !== pedidas) {
        pegas.push(`oferta completa con ${reparto.ids.length} cartas cuando pide ${pedidas}`);
      }
    }

    reparto.partes.forEach((p, i) => {
      const r = of.requisitos[i];
      if (p.fijas.length !== p.elegidas.length) pegas.push(`r${i}: fijas y elegidas no van a la par`);
      if (p.elegidas.length > r.cantidad) pegas.push(`r${i}: ${p.elegidas.length} cartas para ${r.cantidad} huecos`);
      // Misma comprobación que hace el servidor: si una carta apartada no cumple
      // su requisito, el lote se rechaza al cobrar.
      for (const c of p.elegidas) {
        if (!sirve(c, r)) pegas.push(`r${i}: ${c.id} no cumple "${r.descripcion}"`);
        // La expansión, APARTE Y A MANO. `sirve` es del módulo que se está
        // probando y es una composición de dos cosas (el set y el filtro): si se
        // le cae la mitad del set, este validador se cae con ella y el lote
        // llegaría al servidor con cartas de otra expansión y el botón en verde.
        // El filtro sí se deja en `cumpleFiltro`, que es de utils/mercado.ts y
        // tiene su propia sección más arriba.
        if (r.setId !== null && setDeCarta(c) !== r.setId) {
          pegas.push(`r${i}: ${c.id} es de ${setDeCarta(c)} y el requisito pide ${r.setId}`);
        }
      }
      if (p.completo) {
        if (p.elegidas.length !== r.cantidad) pegas.push(`r${i}: completo con ${p.elegidas.length}/${r.cantidad}`);
        // Las tres categorías de CONJUNTO: `sirve` mira carta a carta y no puede
        // ver esto, que es justo lo que el servidor comprueba aparte.
        if (r.filtro.categoria === "playset" && new Set(p.elegidas.map((c) => c.id)).size !== 1) {
          pegas.push(`r${i}: playset con cartas distintas`);
        }
        if (r.filtro.categoria === "arcoiris" && coloresAMano(p.elegidas) < r.cantidad) {
          pegas.push(`r${i}: arcoíris de ${r.cantidad} con sólo ${coloresAMano(p.elegidas)} colores`);
        }
        if (r.filtro.categoria === "evolucion") {
          for (let k = 1; k < p.elegidas.length; k++) {
            const viene = String(p.elegidas[k].evolvesFrom ?? "").trim().toLowerCase();
            if (viene !== String(p.elegidas[k - 1].name ?? "").trim().toLowerCase()) {
              pegas.push(`r${i}: la cadena no encadena (${p.elegidas[k - 1].name} -> ${p.elegidas[k].name})`);
            }
          }
        }
      } else {
        // Un requisito a medias devuelve al fondo común TODO lo automático: si
        // retuviera algo, se lo estaría quitando a un requisito que sí se
        // completa. Lo clavado sí se queda, y por eso se mira `fijas`.
        p.fijas.forEach((f, j) => { if (!f) pegas.push(`r${i}: retiene ${p.elegidas[j].id} sin completarse`); });
      }
    });
    return pegas;
  }

  /* Y las dos cuentas de colores tienen que coincidir, o el validador de arriba
   * estaría midiendo con otra vara que el reparto. El caso es el que documenta
   * `coloresDistintos`: cuatro cartas de DOBLE TIPO que entre las cuatro cubren
   * cuatro colores. Un voraz que le da a cada carta el primer color libre saca
   * sólo tres si Exeggcute entra la primera —se lleva Planta y deja a Riolu sin
   * color—, y entonces la oferta se ve incompleta teniéndolo todo. Por eso el
   * módulo hace un emparejamiento de verdad y por eso hay que vigilar que lo
   * siga haciendo: el voraz es más corto y parece equivalente. */
  {
    const dobles = [
      carta("base1-mac", { name: "Machop", types: ["Fighting"] }),
      carta("base1-rio", { name: "Riolu", types: ["Fighting", "Grass"] }),
      carta("base1-exe", { name: "Exeggcute", types: ["Grass", "Psychic"] }),
      carta("base1-chi", { name: "Chikorita", types: ["Grass", "Lightning"] }),
    ];
    const conExeggcuteDelante = [dobles[2], dobles[0], dobles[1], dobles[3]];
    comprueba(
      coloresDistintos(dobles) === 4 && coloresDistintos(conExeggcuteDelante) === 4,
      "cuatro cartas de doble tipo cubren cuatro colores, entren en el orden que entren",
      `en orden ${coloresDistintos(dobles)}, con Exeggcute delante ${coloresDistintos(conExeggcuteDelante)}`,
    );
    const desacuerdos = [];
    // El grupo de dos Machop está para que la lista incluya un caso donde
    // sobran cartas para los colores que hay: sin él, un conteo que devolviera
    // "una por carta" pasaría por todos los demás.
    for (const grupo of [dobles, conExeggcuteDelante, dobles.slice(0, 2), dobles.slice(1),
                         [dobles[0], dobles[0]], [dobles[1], dobles[1]], [dobles[2], dobles[3]]]) {
      if (coloresDistintos(grupo) !== coloresAMano(grupo)) {
        desacuerdos.push(`${grupo.map((c) => c.name).join("+")}: el módulo dice ${coloresDistintos(grupo)} y a lo bruto salen ${coloresAMano(grupo)}`);
      }
    }
    comprueba(desacuerdos.length === 0,
      "y el módulo cuenta lo mismo que el conteo a lo bruto con el que se validan los lotes",
      desacuerdos.join(" · "));
  }

  /* ================================================================
   * A. EL ATASCO, QUE ES EL MOTIVO DE TODO
   * ================================================================ */

  /* El reparto SIN las dos defensas, para tener contra qué medir: los requisitos
   * en el orden en que vienen y las candidatas ordenadas sólo por precio. Es una
   * réplica deliberada —como la de `admiteOfertaAtada` más arriba— y está aquí
   * por una razón: un caso de prueba que el algoritmo ingenuo TAMBIÉN resuelve
   * no vigila nada, y esa comprobación no se puede hacer sin él. */
  function repartoIngenuo(of, cartas, conUtilidad = false) {
    const libres = new Map(cartas.map((c) => [c.id, copiasEntregables(c.cantidad)]));
    const partes = [];
    for (const r of of.requisitos) {
      // Las dos defensas se pueden quitar por separado, y hace falta poder
      // hacerlo: si el ingenuo no tiene ninguna de las dos, un caso que se cae
      // no dice CUÁL de ellas lo salvaba. Con `conUtilidad` se conserva la
      // utilidad y se pierde sólo PRIORIDAD (los requisitos en el orden en que
      // vienen), que es lo que aísla el orden.
      const pendientes = of.requisitos.slice(of.requisitos.indexOf(r) + 1);
      const util = (c) => (conUtilidad ? pendientes.filter((p) => sirve(c, p)).length : 0);
      const cand = cartas
        .filter((c) => (libres.get(c.id) ?? 0) > 0 && sirve(c, r))
        .sort((a, b) => util(a) - util(b) || comparar(a, b));
      let elegidas = [];
      if (r.filtro.categoria === "playset") {
        const base = cand.find((c) => libres.get(c.id) >= r.cantidad);
        if (base) {
          elegidas = Array.from({ length: r.cantidad }, () => base);
          libres.set(base.id, libres.get(base.id) - r.cantidad);
        }
      } else {
        for (const c of cand) {
          while (libres.get(c.id) > 0 && elegidas.length < r.cantidad) {
            elegidas.push(c);
            libres.set(c.id, libres.get(c.id) - 1);
          }
          if (elegidas.length >= r.cantidad) break;
        }
        if (elegidas.length < r.cantidad) for (const c of elegidas) libres.set(c.id, libres.get(c.id) + 1);
      }
      partes.push({ requisito: r, elegidas, completo: elegidas.length === r.cantidad });
    }
    return { partes, completa: partes.every((p) => p.completo) };
  }

  /* --- El caso literal del encargo: las tres cartas de Kalos son ADEMÁS de
   *     Fuego y son las más baratas de la colección, así que el requisito de
   *     tipo se las lleva si nadie lo impide. --- */
  const CARTAS_ATASCO = [
    ...[1, 2, 3].map((i) => carta("xy1-" + i, { types: ["Fire"], cantidad: 2, precio: 1 })),
    ...Array.from({ length: 8 }, (_, i) =>
      carta("base1-" + (i + 1), { types: ["Fire"], cantidad: 2, precio: 9 })),
  ];
  const OFERTA_ATASCO = oferta("atasco", [
    req("tipo", 8, { valor: "Fire|Fighting" }),
    req("set", 3, { valor: "xy1" }),
  ]);
  {
    const r = repartir(OFERTA_ATASCO, CARTAS_ATASCO);
    comprueba(
      r.completa,
      "el atasco se resuelve: la oferta que se puede cumplir se ve completa",
      `"8 de Fuego o Lucha" + "3 de Kalos" sale ${marcador(r)}`,
    );
    comprueba(
      !repartoIngenuo(OFERTA_ATASCO, CARTAS_ATASCO).completa &&
      repartoIngenuo(OFERTA_ATASCO, CARTAS_ATASCO, true).completa,
      "y el caso prueba algo, y prueba la UTILIDAD: sin ella se atasca y con ella sale",
      "aquí PRIORIDAD no pinta nada (tipo ya va antes que expansión): si el ingenuo también lo resolviera, este caso no vigilaría nada",
    );
  }

  /* --- La otra defensa, PRIORIDAD, con un caso que la utilidad no salva: las
   *     cuatro cartas sirven igual a los dos requisitos, así que la utilidad las
   *     empata y sólo el ORDEN decide. El playset es el requisito que menos
   *     alternativas admite (necesita 3 copias de la MISMA carta) y sólo hay una
   *     carta con tres; si va detrás, el requisito de tipo se las come. --- */
  {
    const cartas = [
      carta("base1-p", { types: ["Fire"], cantidad: 4, precio: 1 }),
      ...["r", "s", "t"].map((k) => carta("base1-" + k, { types: ["Fire"], cantidad: 2, precio: 2 })),
    ];
    const of = oferta("prio", [req("tipo", 3, { valor: "Fire" }), req("playset", 3)]);
    const r = repartir(of, cartas);
    comprueba(r.completa, "PRIORIDAD: el requisito con menos alternativas se sirve primero", marcador(r));
    comprueba(
      !repartoIngenuo(of, cartas, true).completa,
      "y ahí la utilidad no salva nada: CON utilidad pero sin PRIORIDAD el caso se cae igual",
      "las cuatro cartas sirven a los dos requisitos, así que la utilidad las empata y sólo el ORDEN decide",
    );
    comprueba(
      ordenDeRequisitos(of).map((x) => x.indice).join(",") === "1,0",
      "y la cola la reparte `ordenDeRequisitos`, la misma que llaman el reparto y el selector",
      "aquí el playset (índice 1) tiene que servirse antes que el requisito de tipo (índice 0)",
    );
    comprueba(
      PRIORIDAD.evolucion < PRIORIDAD.playset &&
      PRIORIDAD.playset < PRIORIDAD.arcoiris &&
      PRIORIDAD.arcoiris < PRIORIDAD.tipo &&
      PRIORIDAD.tipo < PRIORIDAD.set,
      "y va de lo que menos alternativas admite a lo que las admite todas",
      "cadena < playset < arcoíris < tipo < expansión",
    );
  }

  /* ================================================================
   * B. EL LOTE ES VÁLIDO, PASE LO QUE PASE
   * ================================================================ */

  /* Una batería determinista: colecciones y ofertas sorteadas con una semilla
   * fija, para que el mismo fallo salga siempre en la misma pasada. Cubre las
   * cuatro ramas de `repartir` (playset, arcoíris, cadena evolutiva y el resto)
   * y se corre dos veces cada caso, con y sin cartas clavadas. */
  const rng = (semilla) => () => (semilla = (semilla * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const CADENAS = [["Charmander", "Charmeleon", "Charizard"], ["Bulbasaur", "Ivysaur", "Venusaur"],
                   ["Machop", "Machoke", "Machamp"], ["Pichu", "Pikachu", "Raichu"]];
  const TIPOS = ["Fire", "Water", "Grass", "Psychic", "Fighting", "Lightning"];
  const SETS = ["base1", "xy1", "sv3"];

  function coleccion(azar, cuantas) {
    const cartas = [];
    for (let i = 0; i < cuantas; i++) {
      const cadena = CADENAS[Math.floor(azar() * CADENAS.length)];
      const eslabon = Math.floor(azar() * 3);
      const tipos = [TIPOS[Math.floor(azar() * TIPOS.length)]];
      if (azar() < 0.3) tipos.push(TIPOS[Math.floor(azar() * TIPOS.length)]);
      cartas.push(carta(SETS[Math.floor(azar() * SETS.length)] + "-" + (i + 1), {
        name: cadena[eslabon],
        evolvesFrom: eslabon > 0 ? cadena[eslabon - 1] : undefined,
        types: Array.from(new Set(tipos)),
        // Con `cantidad` 1 la carta NO tiene copias entregables: entra a
        // propósito para que el lote tenga que saber esquivarla.
        cantidad: 1 + Math.floor(azar() * 4),
        precio: [1, 2, 5, 9, 20][Math.floor(azar() * 5)],
      }));
    }
    return cartas;
  }
  function requisitoAlAzar(azar) {
    const n = 1 + Math.floor(azar() * 3);
    switch (Math.floor(azar() * 6)) {
      case 0: return req("tipo", n + 1, { valor: TIPOS[Math.floor(azar() * TIPOS.length)] + "|" + TIPOS[Math.floor(azar() * TIPOS.length)] });
      case 1: return req("set", n, { valor: SETS[Math.floor(azar() * SETS.length)] });
      case 2: return req("playset", 1 + n);
      case 3: return req("arcoiris", 1 + n);
      case 4: return req("evolucion", 2 + Math.floor(azar() * 2));
      default: return req("supertipo", n + 1, { valor: "Pokémon" }, SETS[Math.floor(azar() * SETS.length)]);
    }
  }

  const CASOS = [];
  {
    const azar = rng(20486);
    for (let i = 0; i < 300; i++) {
      const cartas = coleccion(azar, 6 + Math.floor(azar() * 20));
      const cuantos = 1 + Math.floor(azar() * 3);
      CASOS.push({
        of: oferta("f" + i, Array.from({ length: cuantos }, () => requisitoAlAzar(azar))),
        cartas,
        // Clavadas sorteadas: ids que pueden servir o no, porque el estado de la
        // pantalla puede traer cualquier cosa y `normalizarFijadas` es la red.
        fijadas: new Map(Array.from({ length: cuantos }, (_, k) => [
          k,
          Array.from({ length: 4 }, () =>
            azar() < 0.4 ? cartas[Math.floor(azar() * cartas.length)].id : null),
        ])),
      });
    }
  }

  {
    const malos = [];
    let conFijadas = 0, completas = 0;
    for (const { of, cartas, fijadas } of CASOS) {
      for (const f of [undefined, fijadas]) {
        const r = repartir(of, cartas, f);
        if (f && r.partes.some((p) => p.fijas.some(Boolean))) conFijadas++;
        if (r.completa) completas++;
        for (const pega of pegasDelLote(of, cartas, r)) malos.push(`${of.id}${f ? " (clavadas)" : ""}: ${pega}`);
      }
    }
    comprueba(
      malos.length === 0,
      `el lote siempre es válido (${CASOS.length} colecciones × 2, ${completas} ofertas completas)`,
      malos.slice(0, 4).join("\n          "),
    );
    // Que la batería EJERCITE lo que dice ejercitar: si un cambio en los
    // generadores dejara de producir clavadas, los invariantes de arriba
    // seguirían en verde sin mirar nada.
    comprueba(conFijadas > 100 && completas > 100,
      "la batería ejercita de verdad las dos mitades (clavadas y ofertas completas)",
      `${conFijadas} repartos con clavadas, ${completas} completos`);
  }

  /* LA BARRA DICE LA VERDAD. `progreso` es el número que el jugador lee encima
   * de cada requisito y el ancho de la barra, y NO entra en el lote: se puede
   * estropear entero —ponerlo a cero, contarlo después de devolver las cartas al
   * fondo— sin que ningún lote salga inválido y sin que nada se ponga rojo. Lo
   * único que promete es contar en las mismas unidades que `completo`, así que
   * lo que se ata es eso: nunca pasa de lo que pide el requisito, y llega al
   * tope exactamente cuando el requisito está servido. */
  {
    const malos = [];
    for (const { of, cartas, fijadas } of CASOS) {
      for (const f of [undefined, fijadas]) {
        const r = repartir(of, cartas, f);
        r.partes.forEach((p, i) => {
          const n = p.requisito.cantidad;
          if (!(p.progreso >= 0 && p.progreso <= n)) malos.push(`${of.id} r${i}: la barra marca ${p.progreso} de ${n}`);
          if (p.completo !== (p.progreso === n)) {
            malos.push(`${of.id} r${i}: ${p.completo ? "completo" : "a medias"} con la barra en ${p.progreso}/${n}`);
          }
        });
      }
    }
    comprueba(malos.length === 0,
      "la barra va con el requisito: nunca pasa de lo pedido y llega al tope justo cuando está servido",
      malos.slice(0, 4).join("\n          "));
  }

  /* Y CUANDO EL REQUISITO NO SE COMPLETA, la barra enseña hasta dónde se llega
   * con los duplicados que sobran. Es el único sitio donde el jugador ve si le
   * falta una carta o le faltan cinco, y no se puede sacar del lote: un
   * requisito a medias devuelve sus cartas al fondo común y `elegidas` se queda
   * vacío, así que la barra es lo ÚNICO que queda de esa cuenta. Cada rama la
   * mide en su unidad, y las tres son código distinto. */
  {
    const gen = repartir(oferta("barra", [req("tipo", 3, { valor: "Fire" })]), [
      carta("base1-1", { types: ["Fire"], cantidad: 2, precio: 1 }),
      carta("base1-2", { types: ["Fire"], cantidad: 2, precio: 2 }),
    ]);
    comprueba(
      gen.partes[0].progreso === 2 && gen.partes[0].elegidas.length === 0,
      "un requisito a medias enseña los duplicados que sí tiene, aunque haya soltado el lote",
      `2 duplicados para "3 de Fuego" -> barra ${gen.partes[0].progreso}/3 con ${gen.partes[0].elegidas.length} cartas apartadas`,
    );
    // El playset cuenta COPIAS de la misma carta: de "base1-k" sobran dos y el
    // playset pide cuatro, así que la barra tiene que decir 2 y no 0.
    const play = repartir(oferta("barrap", [req("playset", 4)]),
      [carta("base1-k", { types: ["Fire"], cantidad: 3, precio: 1 })]);
    // La cadena cuenta ESLABONES: con Charmander y Charmeleon pero sin
    // Charizard, una cadena de tres se queda en 2 y así se pinta.
    const evo = repartir(oferta("barrae", [req("evolucion", 3)]), [
      carta("base1-e1", { name: "Charmander", types: ["Fire"], cantidad: 2, precio: 1 }),
      carta("base1-e2", { name: "Charmeleon", evolvesFrom: "Charmander", types: ["Fire"], cantidad: 2, precio: 2 }),
    ]);
    comprueba(
      play.partes[0].progreso === 2 && evo.partes[0].progreso === 2,
      "y cada rama cuenta en su unidad: copias sueltas en el playset, eslabones en la cadena",
      `playset ${play.partes[0].progreso}/4 · cadena ${evo.partes[0].progreso}/3`,
    );
  }

  /* SE ENTREGAN LAS BARATAS. El pago es multiplicador × precio del lote y el
   * multiplicador ya viene fijado en la oferta, así que meter la carta cara que
   * también cumple sube el cobro unas monedas y REGALA la carta buena. Es una
   * decisión de diseño y no un detalle de orden: darle la vuelta a `comparar` no
   * deja ningún lote inválido —el servidor lo aceptaría igual, cumple el
   * requisito— y el jugador se quedaría sin sus cartas caras sin que nada se
   * pusiera rojo. */
  {
    const escala = [1, 2, 9, 20].map((precio, i) =>
      carta("base1-" + (i + 1), { types: ["Fire"], cantidad: 2, precio }));
    const r = repartir(oferta("barato", [req("tipo", 2, { valor: "Fire" })]), escala);
    comprueba(
      r.completa && r.valor === 3 && [...r.ids].sort().join(",") === "base1-1,base1-2",
      "se entregan las copias más baratas que cumplen: la carta buena se queda en el álbum",
      `lote ${r.ids.join(",")} por ${r.valor}, pudiendo ser 3`,
    );
    // A igual precio, primero la que MÁS copias tiene de sobra: gastar la que
    // sólo tenía una de repuesto la deja fuera del próximo lote, y para este
    // requisito las dos son intercambiables.
    const empate = repartir(oferta("empate", [req("tipo", 1, { valor: "Fire" })]), [
      carta("base1-poca", { types: ["Fire"], cantidad: 2, precio: 5 }),
      carta("base1-mucha", { types: ["Fire"], cantidad: 5, precio: 5 }),
    ]);
    comprueba(
      empate.ids.join(",") === "base1-mucha",
      "y a igual precio se gasta la que más copias tiene de sobra",
      `entrega ${empate.ids.join(",")}`,
    );
  }

  /* LA AMARRA DE LA RÉPLICA INGENUA. Los dos guardianes de la sección A miden
   * `repartir` contra `repartoIngenuo`, que es una copia a mano de sus ramas: en
   * cuanto `repartir` cambie de forma, la copia se queda vieja y los dos
   * guardianes siguen en verde comparando contra un algoritmo que ya no se
   * parece al de producción — confianza falsa, que es justo lo que esta sección
   * existe para evitar.
   *
   * Así que se atan: cuando la oferta tiene UN SOLO requisito no hay orden que
   * elegir ni requisitos detrás a los que reservar cartas, o sea que las dos
   * defensas no pintan nada y los dos repartos tienen que dar EL MISMO LOTE. Si
   * dejan de darlo, o la réplica se ha quedado atrás o `repartir` ha cambiado
   * algo que nadie pidió. Se comparan sólo las ofertas que se completan: la
   * réplica no imita el paso de devolver lo automático al fondo común, ni las
   * ramas de arcoíris y cadena. */
  {
    const malos = [];
    let atados = 0;
    for (const { of, cartas } of CASOS) {
      if (of.requisitos.length !== 1) continue;
      const cat = of.requisitos[0].filtro.categoria;
      if (cat === "arcoiris" || cat === "evolucion") continue;
      const real = repartir(of, cartas);
      if (!real.completa) continue;
      atados++;
      const copia = repartoIngenuo(of, cartas, true);
      const suyo = copia.partes.flatMap((p) => p.elegidas).map((c) => c.id).join("|");
      if (real.ids.join("|") !== suyo) malos.push(`${of.id} (${cat}): real ${real.ids.join(",")} · réplica ${suyo}`);
    }
    comprueba(malos.length === 0 && atados > 30,
      `con un solo requisito la réplica ingenua da el mismo lote que el reparto (${atados} ofertas)`,
      malos.slice(0, 3).join("\n          ") || `sólo se han podido atar ${atados}`,
    );
  }

  /* ================================================================
   * C. LAS FIJADAS SE RESPETAN
   * ================================================================ */

  /* CLAVAR LA PROPUESTA NO PUEDE CAMBIARLA. Es la forma más fuerte de decir que
   * las clavadas se respetan: si el jugador fija exactamente lo que la pantalla
   * ya le había propuesto, tiene que salir el mismo lote. Cualquier trato
   * distinto entre "esta carta la puso el algoritmo" y "esta carta la puso el
   * jugador" —un orden, un descuento del fondo hecho dos veces, un requisito que
   * arranca sin lo suyo— se ve aquí. */
  {
    const malos = [];
    let probados = 0;
    for (const { of, cartas } of CASOS) {
      const antes = repartir(of, cartas);
      if (!antes.completa) continue;
      probados++;
      const despues = repartir(of, cartas, new Map(
        antes.partes.map((p, i) => [i, p.elegidas.map((c) => c.id)]),
      ));
      if (!despues.completa) malos.push(`${of.id}: clavar la propuesta la deja incompleta (${marcador(despues)})`);
      else if (despues.ids.join("|") !== antes.ids.join("|")) malos.push(`${of.id}: clavar la propuesta cambia el lote`);
    }
    comprueba(malos.length === 0,
      `clavar la propuesta automática no la cambia (${probados} ofertas)`,
      malos.slice(0, 4).join("\n          "));
  }

  /* LO CLAVADO SE APARTA ANTES DE REPARTIR NADA, no requisito a requisito. El
   * playset va antes que el tipo por PRIORIDAD y "base1-p" es la única carta con
   * tres copias, así que si el fondo se descontara sobre la marcha el playset se
   * llevaría las tres y la elección del jugador se evaporaría sin que él tocara
   * nada — que es el peor final posible para una elección a mano. */
  {
    const cartas = [
      carta("base1-p", { types: ["Fire"], cantidad: 4, precio: 1 }),
      carta("base1-q", { types: ["Fire"], cantidad: 4, precio: 2 }),
    ];
    const of = oferta("clavada", [req("playset", 3), req("tipo", 2, { valor: "Fire" })]);
    const r = repartir(of, cartas, new Map([[1, ["base1-p", null]]]));
    comprueba(
      r.completa && r.partes[1].elegidas[0]?.id === "base1-p" && r.partes[1].fijas[0] === true,
      "lo clavado se aparta antes de repartir: no se lo lleva un requisito de más prioridad",
      `${marcador(r)} · el requisito de tipo empieza por ${r.partes[1].elegidas[0]?.id}`,
    );
    comprueba(
      r.partes[0].elegidas.every((c) => c.id === "base1-q"),
      "y el requisito de más prioridad se apaña con lo que queda",
    );
  }

  /* CLAVAR UNA CARTA QUE CABÍA NO PUEDE ROMPER EL RESTO. En el atasco, fijar
   * cualquiera de las de Fuego caras es una elección que deja la oferta
   * cumplible; si el reparto del RESTO se hiciera sin saber qué copias ya no
   * están, volvería a gastar las de Kalos y la oferta caería — pareciendo culpa
   * del jugador. */
  {
    const malos = [];
    for (let i = 1; i <= 8; i++) {
      const r = repartir(OFERTA_ATASCO, CARTAS_ATASCO, new Map([[0, ["base1-" + i]]]));
      if (!r.completa) malos.push(`clavar base1-${i} deja ${marcador(r)}`);
      if (!r.partes[0].elegidas.some((c) => c.id === "base1-" + i)) malos.push(`base1-${i} clavada y no sale en el lote`);
    }
    comprueba(malos.length === 0,
      "clavar una carta que cabía no rompe el reparto del resto",
      malos.slice(0, 3).join("\n          "));
  }

  /* CADA CLAVADA SE PINTA EN SU HUECO. Dentro del algoritmo las clavadas van
   * todas delante —es lo que deja separar lo automático con un `slice`—, pero
   * PINTARLAS así reordenaba la fila de chips entera cada vez que el jugador
   * soltaba una copia: el chip que acababa de tocar dejaba de estar donde lo
   * tocó y el alfiler aparecía en otro. Eso no rompe ningún lote y ningún
   * invariante que mire conjuntos lo ve, así que aquí se mira la POSICIÓN: se
   * clavan las dos caras en los huecos 1 y 3 —los que el algoritmo jamás
   * elegiría, porque va por precio— y tienen que salir ahí, con el relleno
   * automático cayendo en los libres. */
  {
    const seis = Array.from({ length: 6 }, (_, i) =>
      carta("base1-" + (i + 1), { types: ["Fire"], cantidad: 2, precio: i + 1 }));
    const of = oferta("huecos", [req("tipo", 4, { valor: "Fire" })]);
    const r = repartir(of, seis, new Map([[0, [null, "base1-5", null, "base1-6"]]]));
    const p = r.partes[0];
    comprueba(
      p.completo &&
      p.elegidas.map((c) => c.id).join(",") === "base1-1,base1-5,base1-2,base1-6" &&
      p.fijas.join(",") === "false,true,false,true",
      "cada clavada se pinta en SU hueco y el relleno automático cae en los que quedan libres",
      p.elegidas.map((c, j) => c.id + (p.fijas[j] ? "*" : "")).join(" "),
    );
  }

  /* CLAVAR DOS DEL MISMO COLOR NO PONE LA TARJETA VERDE. Es el peor fallo que
   * puede tener esta pantalla y el único que el jugador se puede provocar solo:
   * el arcoíris pide N cartas Y N COLORES, y desde que se elige a mano puede
   * llegar con sus N huecos llenos y un color repetido. Si `completo` se midiera
   * por cartas —que es lo que parece razonable y lo que hacía antes— el botón se
   * pondría verde, el servidor rechazaría el lote y encima parecería culpa suya.
   * El selector ya no ofrece la repetida (sección E), pero el estado puede
   * traerla igual —una recarga, otra pestaña— y aquí es donde tiene que frenar. */
  {
    const arco = [
      carta("base1-w1", { types: ["Water"], cantidad: 2, precio: 1 }),
      carta("base1-w2", { types: ["Water"], cantidad: 2, precio: 2 }),
      carta("base1-f", { types: ["Fire"], cantidad: 2, precio: 9 }),
    ];
    const of = oferta("dosagua", [req("arcoiris", 2)]);
    const r = repartir(of, arco, new Map([[0, ["base1-w1", "base1-w2"]]]));
    const p = r.partes[0];
    comprueba(
      !p.completo && !r.completa && p.elegidas.length === 2 && p.fijas.every(Boolean) &&
      pegasDelLote(of, arco, r).length === 0,
      "dos cartas del mismo color no completan un arcoíris de dos, aunque llenen los dos huecos",
      `${p.elegidas.map((c) => c.id).join(",")} -> ${p.completo ? "COMPLETO" : "a medias"} (${p.progreso}/2)`,
    );
  }

  /* ================================================================
   * D. NO SE PUEDE ATASCAR SIN SALIDA
   * ================================================================ */

  /* Un jugador que no sabe cómo salir es peor que uno que no puede elegir. Si el
   * requisito se queda a medias, la carta clavada TIENE que seguir pintada y
   * marcada como clavada: es el chip que hay que tocar para soltarla. Si
   * desapareciera del reparto, la pantalla no tendría dónde enseñar el alfiler y
   * la única salida sería recargar. */
  {
    // El peor rincón: el requisito pide tres y de la única carta que sirve sólo
    // sobra una copia, que además es la que el jugador clavó. El requisito NO se
    // va a completar haga lo que haga, así que todo lo que la pantalla le puede
    // dar es el chip.
    const cartas = [carta("base1-x", { types: ["Fire"], cantidad: 2, precio: 9 })];
    const of = oferta("sinsalida", [req("tipo", 3, { valor: "Fire" })]);
    const fijadas = new Map([[0, ["base1-x", null, null]]]);
    const r = repartir(of, cartas, fijadas);
    const parte = r.partes[0];
    const hueco = parte.elegidas.findIndex((c) => c.id === "base1-x");
    comprueba(
      !parte.completo && hueco >= 0 && parte.fijas[hueco] === true,
      "un requisito que no se completa sigue enseñando lo clavado, para poder soltarlo",
      `elegidas: ${parte.elegidas.map((c) => c.id).join(",") || "(vacío)"}`,
    );
    // Y el chip se puede tocar: el selector de un hueco clavado se ofrece SIEMPRE
    // a sí mismo, porque la copia que ocupa el hueco vuelve a la cuenta al
    // cambiarla. Sin eso, la única carta que hay sale de la lista por estar ya
    // comprometida, el selector se abre vacío y el jugador se queda sin salida.
    comprueba(
      hueco >= 0 && candidatasPara(of, cartas, r, 0, hueco).some((o) => o.carta.id === "base1-x"),
      "el selector de un hueco clavado nunca sale vacío: la copia que lo ocupa cuenta como libre",
      `opciones: ${candidatasPara(of, cartas, r, 0, Math.max(hueco, 0)).map((o) => o.carta.id).join(",") || "(ninguna)"}`,
    );
    // La poda tampoco puede borrar la clavada que atasca: si la tirase, el
    // estado se quedaría sin ella y el chip desaparecería sin que él lo suelte.
    const podado = podarFijadas(new Map([[of.id, fijadas]]), [of], cartas);
    comprueba(
      podado.get(of.id)?.get(0)?.includes("base1-x") === true,
      "y la poda no borra la clavada que atasca: el chip sigue ahí para soltarlo",
      `poda: ${JSON.stringify([...(podado.get(of.id)?.entries() ?? [])])}`,
    );
  }

  /* Y AL FONDO COMÚN SÓLO VUELVE LO AUTOMÁTICO. Un requisito que se queda a
   * medias suelta lo que puso el algoritmo, pero lo clavado se queda donde está;
   * si volviera, el requisito de detrás se lo comería —y aquí sólo hay una copia
   * entregable de esa carta— así que el mismo hueco quedaría prometido dos veces
   * y el chip que el jugador tiene que tocar para salir estaría pintando una
   * copia que ya no es suya. */
  {
    const cartas = [carta("base1-z", { types: ["Fire"], cantidad: 2, precio: 1 })];
    const of = oferta("nodevuelve", [
      req("tipo", 3, { valor: "Fire" }),       // no se va a completar: pide tres
      req("set", 1, { valor: "base1" }),       // va detrás y le vale la misma carta
    ]);
    const r = repartir(of, cartas, new Map([[0, ["base1-z", null, null]]]));
    const pegas = pegasDelLote(of, cartas, r);
    comprueba(
      pegas.length === 0 && r.ids.filter((id) => id === "base1-z").length === 1,
      "lo clavado en un requisito a medias no vuelve al fondo: nadie más se lo come",
      pegas.join(" · ") || `ids: ${r.ids.join(",")}`,
    );
  }

  /* En toda la batería: allí donde el jugador clavó algo que se sostiene, sale
   * en el lote marcado como clavado, se complete el requisito o no. */
  {
    const malos = [];
    for (const { of, cartas, fijadas } of CASOS) {
      const r = repartir(of, cartas, fijadas);
      for (const [i, lista] of normalizarFijadas(of, cartas, fijadas)) {
        const puestas = r.partes[i].elegidas.filter((_, j) => r.partes[i].fijas[j]).map((c) => c.id).sort();
        const esperadas = lista.filter(Boolean).map((c) => c.id).sort();
        if (puestas.join("|") !== esperadas.join("|")) {
          malos.push(`${of.id} r${i}: clavadas ${esperadas.join(",")} y pintadas ${puestas.join(",") || "(ninguna)"}`);
        }
      }
    }
    comprueba(malos.length === 0,
      "ninguna clavada válida se pierde por el camino",
      malos.slice(0, 4).join("\n          "));
  }

  /* ================================================================
   * E. EL SELECTOR NO OFRECE LO QUE NO PUEDE DAR
   * ================================================================ */

  /* Ofrecer una carta que no cabe es peor que no ofrecer ninguna: el jugador la
   * elige, el lote sale mal y el error le llega del servidor. Así que de cada
   * carta que `candidatasPara` ofrece se comprueba lo único que de verdad
   * importa: que CLAVARLA FUNCIONE. Se clava, se vuelve a repartir y tiene que
   * salir en su requisito, marcada, y con el lote entero todavía válido. */
  {
    const malos = [];
    let ofrecidas = 0, huecos = 0;
    for (const { of, cartas } of CASOS) {
      const base = repartir(of, cartas);
      of.requisitos.forEach((r, i) => {
        const parte = base.partes[i];
        for (let pos = 0; pos < parte.elegidas.length; pos++) {
          const opciones = candidatasPara(of, cartas, base, i, pos);
          if (!esFijable(r)) {
            if (opciones.length > 0) malos.push(`${of.id} r${i}: la cadena evolutiva no admite elección a mano`);
            continue;
          }
          huecos++;
          for (const o of opciones) {
            ofrecidas++;
            if (!sirve(o.carta, r)) { malos.push(`${of.id} r${i}: ofrece ${o.carta.id}, que no cumple el requisito`); continue; }
            const necesita = r.filtro.categoria === "playset" ? r.cantidad : 1;
            if (copiasEntregables(o.carta.cantidad) < necesita) {
              malos.push(`${of.id} r${i}: ofrece ${o.carta.id} con ${o.carta.cantidad} copias (necesita ${necesita} entregables)`);
              continue;
            }
            // La prueba de fuego: clavarla de verdad, dejando el resto del lote
            // clavado como estaba para que el cambio sea sólo este hueco.
            const ranuras = fijadasDe(base);
            ranuras.set(i, r.filtro.categoria === "playset"
              ? Array.from({ length: r.cantidad }, () => o.carta.id)
              : parte.elegidas.map((c, j) => (j === pos ? o.carta.id : (base.partes[i].fijas[j] ? c.id : null))));
            const tras = repartir(of, cartas, ranuras);
            const puesta = tras.partes[i].elegidas.some((c, j) => c.id === o.carta.id && tras.partes[i].fijas[j]);
            if (!puesta) malos.push(`${of.id} r${i}[${pos}]: ofrece ${o.carta.id} y al clavarla no entra`);
            for (const pega of pegasDelLote(of, cartas, tras)) malos.push(`${of.id} r${i} tras clavar ${o.carta.id}: ${pega}`);
          }
        }
      });
    }
    comprueba(malos.length === 0,
      `todo lo que el selector ofrece se puede clavar (${ofrecidas} opciones en ${huecos} huecos)`,
      malos.slice(0, 4).join("\n          "));
    comprueba(ofrecidas > 500 && huecos > 200, "el selector se ha ejercitado de verdad", `${ofrecidas} opciones / ${huecos} huecos`);
  }

  /* Y LA PRIMERA DE LA LISTA ES LA QUE EL ALGORITMO YA HABÍA PUESTO. La hoja se
   * abre con las opciones ordenadas y arriba del todo va, según promete el
   * módulo, la misma carta que la pantalla había elegido sola. Eso sólo se
   * cumple si el selector ordena con la MISMA utilidad que el reparto, y la
   * utilidad depende de qué requisitos quedan detrás en la cola: si el selector
   * la calculara por su cuenta —o simplemente ordenara por precio— la primera
   * opción sería otra, y el jugador que abre la hoja y toca la de arriba se
   * cambiaría el lote creyendo que lo deja como estaba. Darle la vuelta a ese
   * orden no rompe ningún lote, así que hace falta mirarlo aquí.
   *
   * Se compara en el requisito que se sirve PRIMERO y en su hueco inicial, que
   * es el único sitio donde las dos listas son comparables carta a carta: ahí el
   * fondo común está entero y ninguna copia se la ha llevado nadie todavía. El
   * arcoíris queda fuera a propósito (filtra por color contra el resto del
   * grupo, así que su lista es de otra cosa) y la cadena también (no admite
   * elección a mano). */
  {
    const malos = [];
    let mirados = 0;
    for (const { of, cartas } of CASOS) {
      const base = repartir(of, cartas);
      const { requisito: r, indice } = ordenDeRequisitos(of)[0];
      if (r.filtro.categoria === "arcoiris" || !esFijable(r)) continue;
      const puesta = base.partes[indice].elegidas[0];
      if (!puesta) continue; // requisito a medias: soltó el lote y no hay con qué comparar
      mirados++;
      const primera = candidatasPara(of, cartas, base, indice, 0)[0];
      if (primera?.carta.id !== puesta.id) {
        malos.push(`${of.id} r${indice}: el lote empieza por ${puesta.id} y el selector ofrece ${primera?.carta.id ?? "(nada)"}`);
      }
    }
    comprueba(malos.length === 0,
      `la primera opción del selector es la que el algoritmo ya había puesto (${mirados} huecos)`,
      malos.slice(0, 4).join("\n          "));
    comprueba(mirados > 100, "y se ha comprobado en bastantes huecos", `${mirados} huecos comparados`);
  }

  /* Las dos exclusiones que no se ven en el lote pero sí en la lista: el playset
   * necesita las N copias de la MISMA carta, y el arcoíris sólo admite lo que
   * aporta un color que las demás no cubren. Fuera de eso el selector enseñaría
   * cartas que al tocarlas no hacen nada, o peor, que deshacen el requisito. */
  {
    const cartas = [
      carta("base1-a", { types: ["Fire"], cantidad: 4, precio: 1 }),   // 3 entregables
      carta("base1-b", { types: ["Fire"], cantidad: 3, precio: 2 }),   // 2
      carta("base1-c", { types: ["Water"], cantidad: 2, precio: 3 }),  // 1
      carta("base1-d", { types: ["Fire"], cantidad: 1, precio: 1 }),   // 0: sólo la del álbum
    ];
    const ofPlayset = oferta("psel", [req("playset", 3)]);
    const rPlayset = repartir(ofPlayset, cartas);
    const opsPlayset = candidatasPara(ofPlayset, cartas, rPlayset, 0, 0);
    comprueba(
      opsPlayset.length > 0 && opsPlayset.every((o) => copiasEntregables(o.carta.cantidad) >= 3),
      "playset: sólo se ofrecen cartas con copias suficientes para el playset entero",
      opsPlayset.map((o) => `${o.carta.id}(${o.carta.cantidad})`).join(" "),
    );
    comprueba(
      !opsPlayset.some((o) => o.carta.id === "base1-d") &&
      !candidatasPara(oferta("t", [req("tipo", 2, { valor: "Fire" })]), cartas,
        repartir(oferta("t", [req("tipo", 2, { valor: "Fire" })]), cartas), 0, 0)
        .some((o) => o.carta.id === "base1-d"),
      "una carta de la que sólo se tiene la copia del álbum no se ofrece nunca",
      "copiasEntregables(1) = 0: entregarla dejaría al jugador sin la carta",
    );

    // "base1-w2" es la que de verdad prueba esto: es de Agua, le sobran copias y
    // el otro hueco del arcoíris ya tiene el Agua cubierta. Ofrecerla sería
    // enseñar una carta que, al tocarla, DESHACE el requisito: dos cartas, un
    // color, tarjeta verde y lote que el servidor rechaza.
    const arco = [
      carta("base1-f", { types: ["Fire"], cantidad: 2, precio: 1 }),
      carta("base1-w", { types: ["Water"], cantidad: 2, precio: 1 }),
      carta("base1-w2", { types: ["Water"], cantidad: 3, precio: 2 }),
      carta("base1-g", { types: ["Grass"], cantidad: 2, precio: 9 }),
    ];
    const ofArco = oferta("arco", [req("arcoiris", 2)]);
    const rArco = repartir(ofArco, arco);
    const opsArco = candidatasPara(ofArco, arco, rArco, 0, 0);
    const otras = rArco.partes[0].elegidas.filter((_, j) => j !== 0);
    comprueba(
      rArco.partes[0].completo &&
      opsArco.length > 0 &&
      !opsArco.some((o) => o.carta.id === "base1-w2") &&
      opsArco.every((o) => coloresDistintos([...otras, o.carta]) > coloresDistintos(otras)),
      "arcoíris: sólo se ofrece lo que aporta un color que el resto no cubre",
      `hueco 0 de [${rArco.partes[0].elegidas.map((c) => c.id).join(",")}] -> ${opsArco.map((o) => o.carta.id).join(" ")}`,
    );
  }

  /* Ni una copia que otro requisito de la MISMA oferta ya tiene apartada: no
   * están libres aunque la carta las tenga, y ofrecerlas sería prometer una
   * copia que ya está prometida. */
  {
    const cartas = [
      carta("base1-u", { types: ["Fire"], cantidad: 2, precio: 1 }),
      carta("base1-v", { types: ["Fire"], cantidad: 2, precio: 2 }),
    ];
    const of = oferta("compartida", [req("tipo", 1, { valor: "Fire" }), req("set", 1, { valor: "base1" })]);
    const r = repartir(of, cartas);
    const yaEn0 = r.partes[0].elegidas[0].id;
    comprueba(
      r.completa && !candidatasPara(of, cartas, r, 1, 0).some((o) => o.carta.id === yaEn0),
      "una copia que ya usa otro requisito de la oferta no se ofrece",
      `el hueco del segundo requisito no puede ofrecer ${yaEn0}`,
    );
  }

  /* ================================================================
   * F. LA ELECCIÓN CADUCA SOLA
   * ================================================================ */

  /* El jugador clava una carta y luego la vende en otra pestaña, o abre sobres y
   * la colección cambia bajo la pantalla. `normalizarFijadas` es la red que
   * impide que una elección que ya no se sostiene llegue al servidor, y
   * `podarFijadas` la que impide que se quede en el estado: una entrada muerta
   * deja un botón de "volver a la propuesta automática" que no hace nada, y peor
   * —si el jugador vuelve a tener duplicados de esa carta— RESUCITA sin que él
   * la haya vuelto a elegir. */
  {
    const of = oferta("caduca", [req("tipo", 2, { valor: "Fire" })]);
    const antes = [
      carta("base1-m", { types: ["Fire"], cantidad: 3, precio: 1 }),
      carta("base1-n", { types: ["Fire"], cantidad: 3, precio: 2 }),
    ];
    // La otra pestaña vende las dos copias que sobraban de "base1-m".
    const despues = [carta("base1-m", { types: ["Fire"], cantidad: 1, precio: 1 }), antes[1]];
    const fijadas = new Map([[0, ["base1-m", null]]]);

    comprueba(
      normalizarFijadas(of, antes, fijadas).get(0)?.[0]?.id === "base1-m" &&
      normalizarFijadas(of, despues, fijadas).get(0) === undefined,
      "una carta clavada que se ha vendido en otra pestaña deja de estar clavada",
    );
    const r = repartir(of, despues, fijadas);
    comprueba(
      pegasDelLote(of, despues, r).length === 0 && !r.ids.includes("base1-m"),
      "y el lote que sale de ahí sigue siendo válido: no entrega lo que ya no hay",
      pegasDelLote(of, despues, r).join(" · "),
    );
    comprueba(
      podarFijadas(new Map([[of.id, fijadas]]), [of], despues).size === 0,
      "la poda saca del estado la elección muerta, para que no resucite",
    );

    // El tablón caduca cada ciclo: las ofertas de ayer ya no existen y sus
    // elecciones tampoco pueden sobrevivir, o se validarían contra otro tablón.
    comprueba(
      podarFijadas(new Map([["oferta-de-ayer", fijadas]]), [of], antes).size === 0,
      "cuando el tablón caduca, las elecciones de las ofertas que ya no están se van con ellas",
    );
    // Misma referencia si nada ha cambiado: el reparto vive en un useMemo que
    // depende de este mapa, y devolver un mapa nuevo repintaría el tablón entero
    // en cada tic de la cuenta atrás.
    const vivas = new Map([[of.id, fijadas]]);
    comprueba(
      podarFijadas(vivas, [of], antes) === vivas,
      "y si no ha cambiado nada devuelve el MISMO mapa, para no repintar el tablón",
    );
  }

  /* El playset es indivisible: son N copias de la MISMA carta, y media docena de
   * copias sueltas no es un playset. Si al volver quedan menos de las que hacen
   * falta, se cae ENTERO; dejar tres de cuatro serviría un lote que el servidor
   * no empareja. */
  {
    const of = oferta("playsetcaduca", [req("playset", 4)]);
    const cuatro = [carta("base1-k", { types: ["Fire"], cantidad: 5, precio: 1 })];
    const tres = [carta("base1-k", { types: ["Fire"], cantidad: 4, precio: 1 })];
    const fijadas = new Map([[0, ["base1-k", "base1-k", "base1-k", "base1-k"]]]);
    comprueba(
      normalizarFijadas(of, cuatro, fijadas).get(0)?.length === 4 &&
      normalizarFijadas(of, tres, fijadas).get(0) === undefined,
      "un playset clavado al que le falta una copia se cae entero, no a medias",
      "tres de cuatro no es un playset: el servidor lo rechazaría",
    );
  }

  /* Dos reglas más de la red, que sólo se ven desde fuera: una copia no se puede
   * clavar dos veces (la cuenta es por CARTA y a lo largo de toda la oferta, no
   * dentro de cada requisito), y la cadena evolutiva no admite elección a mano
   * aunque alguien meta la elección en el estado — `mejorCadena` no sabe
   * resolver cadenas con un eslabón impuesto y devolvería una cadena rota. */
  {
    const of = oferta("dosveces", [req("tipo", 1, { valor: "Fire" }), req("set", 1, { valor: "base1" })]);
    const cartas = [
      carta("base1-z", { types: ["Fire"], cantidad: 2, precio: 1 }),   // 1 sola entregable
      carta("base1-w2", { types: ["Fire"], cantidad: 2, precio: 2 }),
    ];
    const dosVeces = normalizarFijadas(of, cartas, new Map([[0, ["base1-z"]], [1, ["base1-z"]]]));
    comprueba(
      dosVeces.get(0)?.[0]?.id === "base1-z" && dosVeces.get(1) === undefined,
      "la misma copia no se puede clavar en dos requisitos de la misma oferta",
    );
    const ofEvo = oferta("evo", [req("evolucion", 2)]);
    const evoCartas = [
      carta("base1-e1", { name: "Charmander", types: ["Fire"], cantidad: 2, precio: 1 }),
      carta("base1-e2", { name: "Charmeleon", evolvesFrom: "Charmander", types: ["Fire"], cantidad: 2, precio: 2 }),
      carta("base1-e3", { name: "Machop", types: ["Fighting"], cantidad: 2, precio: 1 }),
    ];
    const rEvo = repartir(ofEvo, evoCartas, new Map([[0, ["base1-e3", null]]]));
    comprueba(
      normalizarFijadas(ofEvo, evoCartas, new Map([[0, ["base1-e3"]]])).size === 0 &&
      rEvo.partes[0].fijas.every((f) => !f) &&
      rEvo.partes[0].completo,
      "una elección metida en una cadena evolutiva se ignora: la cadena se propone entera o nada",
      `cadena: ${rEvo.partes[0].elegidas.map((c) => c.name).join(" -> ")}`,
    );
  }
}


/* ------------------------------------------------------------------ */
/* GRADUACIÓN                                                          */
/* ------------------------------------------------------------------ */
/*
 * POR QUÉ ESTOS INVARIANTES Y NO OTROS: la graduación multiplica el valor de
 * una carta a cambio de un pago fijo. La propuesta original (10→×3, 9→×2,
 * 8→×1,5, 7→×1) daba un multiplicador MEDIO de ×1,7415, y con un coste de 100
 * monedas eso convertía graduar en beneficio garantizado para cualquier carta
 * de más de 135 monedas. Como se pueden graduar las REPETIDAS, el bucle no
 * terminaba nunca: era una imprenta con un botón.
 *
 * El arreglo no fue sólo bajar números —ver el razonamiento completo en
 * utils/graduacion.ts—, así que lo que se comprueba aquí es la CONCLUSIÓN, no
 * los números concretos: se puede cambiar la tabla entera mientras siga sin
 * imprimir dinero. Si alguien la sube y se pasa, estos invariantes fallan.
 */
{
  seccion("Graduación: ninguna nota imprime dinero");

  const {
    PROBABILIDAD_NOTA, MULTIPLICADOR_NOTA, MULTIPLICADOR_MEDIO,
    COSTE_FRACCION, COSTE_BASE,
    costeDeGraduar, descuentoPorVolumen, notaDeCopia, desperfectosDeCopia,
    valorGraduado, semillaDeCopia,
  } = graduacion;

  const notas = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  // 1. El reparto es un reparto: suma 100% y no hay notas fuera de la escala.
  const suma = notas.reduce((a, n) => a + (PROBABILIDAD_NOTA[n] ?? 0), 0);
  comprueba(
    Math.abs(suma - 1) < 1e-9 && Object.keys(PROBABILIDAD_NOTA).length === 10,
    "las probabilidades de las diez notas suman 100%",
    `suman ${(100 * suma).toFixed(4)}% en ${Object.keys(PROBABILIDAD_NOTA).length} notas`,
  );

  // 2. Más nota, más valor. Sin esto se podría dar el caso absurdo de que un 6
  //    valiera más que un 7, que fue justo lo que pasó al bajar el 7 para
  //    cerrar la fuga sin tocar la parte baja de la escalera.
  let monotona = true;
  const rompe = [];
  for (let n = 2; n <= 10; n++) {
    if (!(MULTIPLICADOR_NOTA[n] > MULTIPLICADOR_NOTA[n - 1])) {
      monotona = false;
      rompe.push(`${n - 1}→${n}`);
    }
  }
  comprueba(monotona, "la escalera de multiplicadores es estrictamente creciente", rompe.join(", "));

  // 3. EL INVARIANTE CENTRAL. Con coste = max(BASE, FRACCION·V), graduar es
  //    neutral cuando el multiplicador medio vale 1 + FRACCION. Por encima de
  //    ahí imprime dinero a cualquier valor por encima del suelo.
  const techo = 1 + COSTE_FRACCION;
  comprueba(
    MULTIPLICADOR_MEDIO <= techo,
    `el multiplicador medio (×${MULTIPLICADOR_MEDIO.toFixed(4)}) no pasa del techo ×${techo.toFixed(2)}`,
    `se pasa en ${(MULTIPLICADOR_MEDIO - techo).toFixed(4)}: graduar sería beneficio garantizado`,
  );

  // 4. Y comprobado a la fuerza bruta sobre todo el rango de valores y todos
  //    los descuentos por volumen, que es donde de verdad se podría colar: un
  //    descuento generoso sobre el suelo podría reabrir el agujero.
  const imprime = [];
  for (const cuantas of [1, 5, 10, 25, 100]) {
    for (let v = 1; v <= 20000; v += v < 400 ? 1 : 37) {
      const coste = costeDeGraduar(v, cuantas);
      const neto = v * MULTIPLICADOR_MEDIO - v - coste;
      if (neto > 0) {
        imprime.push(`v=${v} n=${cuantas} neto=+${neto.toFixed(1)}`);
        break;
      }
    }
  }
  comprueba(
    imprime.length === 0,
    "graduar no da beneficio esperado a ningún valor ni con ningún descuento",
    imprime.slice(0, 4).join(" | "),
  );

  // 5. El descuento por volumen nunca puede bajar del tramo proporcional: es lo
  //    que hace que el punto 4 se sostenga por muy generoso que se ponga.
  let sueloRespetado = true;
  for (const cuantas of [1, 5, 10, 25, 1000]) {
    for (const v of [10, 100, 250, 1000, 10000]) {
      if (costeDeGraduar(v, cuantas) < Math.round(COSTE_FRACCION * v)) sueloRespetado = false;
    }
  }
  comprueba(
    sueloRespetado && descuentoPorVolumen(1) === 0,
    "el descuento por volumen nunca baja del tramo proporcional del coste",
  );

  seccion("Graduación: la nota es un hecho, no una tirada");

  // 6. DETERMINISMO. Es la promesa de la que cuelga todo el diseño: si la nota
  //    se sorteara al graduar, quien no quedara contento vendería la carta, la
  //    volvería a conseguir y volvería a tirar.
  // El cuarto argumento es el SECRETO DE SERVIDOR, y no es opcional: sin él la
  // semilla sería `idUsuario|idCarta|indice`, los tres datos que el navegador
  // ya tiene, y cualquiera podría calcular la nota de sus copias sin graduar
  // (utils/graduacion.ts lo explica entero). Aquí se usa uno de prueba.
  const SECRETO = "secreto-de-prueba-para-los-invariantes";
  const semilla = semillaDeCopia("user_prueba", "sv8-32", 3, SECRETO);
  const unaVez = notaDeCopia(semilla);
  let estable = true;
  for (let i = 0; i < 200; i++) if (notaDeCopia(semilla) !== unaVez) estable = false;
  comprueba(estable, "la misma copia da SIEMPRE la misma nota");

  // 7. Copias distintas de la misma carta tienen notas independientes: si no,
  //    elegir cuál gradúas no significaría nada.
  const porCopia = new Set();
  for (let c = 1; c <= 60; c++) porCopia.add(notaDeCopia(semillaDeCopia("user_prueba", "sv8-32", c, SECRETO)));
  comprueba(porCopia.size > 1, "dos copias de la misma carta pueden sacar notas distintas");

  // 8. Y usuarios distintos también, o la nota se filtraría en cuanto alguien
  //    publicase la suya.
  let difieren = 0;
  for (let c = 1; c <= 100; c++) {
    if (
      notaDeCopia(semillaDeCopia("user_a", "sv8-32", c, SECRETO)) !==
      notaDeCopia(semillaDeCopia("user_b", "sv8-32", c, SECRETO))
    ) difieren++;
  }
  comprueba(difieren > 0, "la nota depende del usuario, no sólo de la carta");

  // 9. La distribución empírica se parece a la declarada. 40.000 tiradas dan
  //    margen de sobra para detectar una tabla mal implementada sin ser
  //    quisquilloso con el ruido.
  const N = 40000;
  const cuenta = {};
  for (let i = 0; i < N; i++) {
    const n = notaDeCopia(semillaDeCopia("u", "c", i, SECRETO));
    cuenta[n] = (cuenta[n] ?? 0) + 1;
  }
  let peor = 0, peorNota = 0;
  for (const n of notas) {
    const esperado = (PROBABILIDAD_NOTA[n] ?? 0) * N;
    const visto = cuenta[n] ?? 0;
    // Desviación en sigmas de una binomial.
    const sigma = Math.sqrt(Math.max(1, esperado * (1 - (PROBABILIDAD_NOTA[n] ?? 0))));
    const d = Math.abs(visto - esperado) / sigma;
    if (d > peor) { peor = d; peorNota = n; }
  }
  comprueba(
    peor < 5,
    `las notas salen con la frecuencia declarada (peor desvío ${peor.toFixed(1)}σ en la nota ${peorNota})`,
  );

  /* EL SECRETO TIENE QUE CAMBIAR LAS NOTAS DE VERDAD.
   *
   * Es el invariante que protege el arreglo del agujero: si alguien
   * "simplificara" semillaDeCopia y dejara de usar el secreto, todo lo demás
   * seguiría pasando —las notas seguirían siendo deterministas y bien
   * repartidas— y nadie se enteraría de que el jugador ha vuelto a poder
   * calcularlas antes de pagar. Esto lo caza. */
  let cambian = 0;
  for (let c = 1; c <= 300; c++) {
    const a = notaDeCopia(semillaDeCopia("u", "sv8-32", c, "secreto-A"));
    const b = notaDeCopia(semillaDeCopia("u", "sv8-32", c, "secreto-B"));
    if (a !== b) cambian++;
  }
  comprueba(
    cambian > 150,
    `el secreto del servidor cambia las notas (${cambian} de 300 copias cambian al rotarlo)`,
    "semillaDeCopia parece estar ignorando el secreto: el jugador podría calcular sus notas",
  );

  // 10. Los desperfectos NUNCA contradicen la nota: un 10 no puede salir con un
  //     arañazo, y un 3 no puede salir impecable. Es lo que hace creíble que la
  //     nota se "revele" en vez de inventarse.
  let coherentes = true;
  const incoherencias = [];
  for (let i = 0; i < 4000; i++) {
    const s = semillaDeCopia("u", "c", i, SECRETO);
    const n = notaDeCopia(s);
    const d = desperfectosDeCopia(s, n);
    if (n === 10 && (d.piques > 0 || d.aranazos > 0 || d.manchas > 0 || d.palidez > 0)) {
      coherentes = false; incoherencias.push(`nota 10 con desperfectos`);
    }
    if (n >= 6 && d.aranazos > 0) { coherentes = false; incoherencias.push(`nota ${n} con arañazos`); }
    if (n >= 4 && d.manchas > 0) { coherentes = false; incoherencias.push(`nota ${n} con manchas`); }
    if (n >= 4 && d.palidez > 0) { coherentes = false; incoherencias.push(`nota ${n} descolorida`); }
    if (n >= 8 && (d.descentrado.x !== 0 || d.descentrado.y !== 0)) {
      coherentes = false; incoherencias.push(`nota ${n} descentrada`);
    }
    if (n <= 3 && d.piques < 6) { coherentes = false; incoherencias.push(`nota ${n} casi limpia`); }
  }
  comprueba(
    coherentes,
    "los desperfectos visibles nunca contradicen la nota",
    [...new Set(incoherencias)].slice(0, 4).join(", "),
  );

  // 11. Una carta graduada no puede valer menos que cero ni más de lo que dice
  //     su multiplicador. Suena obvio; es la barrera contra un redondeo que se
  //     escape hacia arriba.
  let acotado = true;
  for (const base of [1, 2, 14, 70, 150, 250, 1000]) {
    for (const n of notas) {
      const v = valorGraduado(base, n);
      if (v < 0 || v > Math.round(base * MULTIPLICADOR_NOTA[n]) + 1) acotado = false;
    }
  }
  comprueba(acotado, "el valor de una carta graduada nunca se sale de su multiplicador");

  /* ------------------------------------------------------------------ *
   * LO QUE SE VE NO PUEDE DELATAR LA NOTA
   * ------------------------------------------------------------------
   *
   * ESTE INVARIANTE NACIÓ AL ENSEÑAR EL DESGASTE AL ABRIR EL SOBRE.
   *
   * Mientras la carta llegaba limpia, graduar era a ciegas y lo único que
   * importaba era el multiplicador medio de toda la tabla. En cuanto el estado
   * físico se ve ANTES de pagar, el jugador deja de graduar al azar: gradúa lo
   * que parece bueno. Y entonces lo que hay que mantener por debajo del techo
   * ya no es la media global, sino la media de CADA GRUPO QUE SE PUEDE
   * DISTINGUIR A OJO.
   *
   * MEDIDO cuando se intentó enseñarlo todo: las copias con CERO piques eran
   * siempre un 10. Un jugador con dos dedos de frente gradúa sólo ésas y se
   * lleva ×3 garantizado — +400 monedas por copia en una Hyper Rare, repetible
   * hasta vaciar el montón. La tabla entera dejaba de significar nada.
   *
   * Por eso el desgaste sólo se pinta para las notas de UMBRAL_DESGASTE_VISIBLE
   * hacia abajo: todo lo que sale limpio (el 95%) es un 7, un 8, un 9 o un 10 y
   * no hay forma de distinguirlos. Este invariante comprueba justo eso, y lo
   * hace agrupando por LO QUE SE VE y no por la nota.
   *
   * SI ALGÚN DÍA SE QUIERE ENSEÑAR MÁS DETALLE, esto se pondrá rojo y dirá qué
   * grupo delata la nota. El arreglo entonces no es tapar el invariante: es
   * bajar el multiplicador de ese grupo hasta que graduarlo deje de compensar.
   */
  {
    const {
      MULTIPLICADOR_NOTA, COSTE_FRACCION, UMBRAL_DESGASTE_VISIBLE,
      notaDeCopia, desperfectosDeCopia, semillaDeCopia, firmaVisible,
    } = graduacion;

    const TECHO = 1 + COSTE_FRACCION;
    const N = 40000;
    const SECRETO = "secreto-de-prueba-para-los-invariantes";

    /* Se agrupa por la FIRMA de lo que el jugador ve. Para una nota alta la
     * firma es "limpia" —no se pinta nada— y para una baja es lo que se puede
     * contar de un vistazo. */
    const grupos = new Map();
    for (let i = 0; i < N; i++) {
      const s = semillaDeCopia("u", "c", i, SECRETO);
      const nota = notaDeCopia(s);
      const firma = firmaVisible(desperfectosDeCopia(s, nota), nota);
      if (!grupos.has(firma)) grupos.set(firma, []);
      grupos.get(firma).push(nota);
    }

    const delatan = [];
    for (const [firma, notas] of grupos) {
      // Los grupos minúsculos son ruido de muestreo, no una estrategia: con
      // menos de cincuenta copias en 40.000 nadie construye nada.
      if (notas.length < 50) continue;
      const ev = notas.reduce((a, n) => a + MULTIPLICADOR_NOTA[n], 0) / notas.length;
      if (ev > TECHO) {
        const cuales = [...new Set(notas)].sort((a, b) => a - b).join(",");
        delatan.push(`"${firma}" (${notas.length} copias, notas {${cuales}}) da x${ev.toFixed(3)}`);
      }
    }

    comprueba(
      delatan.length === 0,
      `ningún estado visible de la carta delata una nota que compense graduar (${grupos.size} estados distintos)`,
      delatan.slice(0, 3).join(" · ") +
        ". Enseñar ese detalle deja elegir: el jugador gradúa sólo ese grupo y" +
        " el multiplicador medio de la tabla deja de proteger nada.",
    );

    /* Y la otra mitad del trato: lo que se ve tiene que ser SUFICIENTE para que
     * una carta destrozada se note. Si el umbral se bajara a cero, el
     * invariante de arriba pasaría siempre —no se ve nada, no se delata nada—
     * pero la función que pidió el dueño del juego habría desaparecido. */
    let seVenLasMalas = 0;
    for (let i = 0; i < 4000; i++) {
      const s = semillaDeCopia("u", "d", i, SECRETO);
      const nota = notaDeCopia(s);
      if (nota > UMBRAL_DESGASTE_VISIBLE) continue;
      const f = firmaVisible(desperfectosDeCopia(s, nota), nota);
      if (f !== "limpia") seVenLasMalas++;
    }
    comprueba(
      seVenLasMalas > 0,
      `las cartas en mal estado se ven marcadas al abrir el sobre (${seVenLasMalas} de la muestra)`,
      "no se distingue ninguna: el desgaste visible se ha quedado en nada",
    );
  }


  /* ------------------------------------------------------------------ *
   * GRADUAR NO PUEDE ESQUIVAR LA CURVA DE REPETIDAS
   * ------------------------------------------------------------------
   *
   * ESTE INVARIANTE NACIÓ DE UN FALLO REAL, y merece la pena contarlo porque
   * es sutil y volvería a colarse igual.
   *
   * Las rutas de venta protegen las copias graduadas descontándolas de lo
   * vendible. La primera versión hacía eso pasándole a `valorDeVenta` las
   * copias LIBRES como si fueran todo el montón — y eso REINICIA LA CURVA: lo
   * que quedaba libre se cobraba como si fueran las primeras copias, que es
   * donde la curva paga el 100%.
   *
   * Resultado medido: con 300 copias de una Hyper Rare, graduar parte del
   * montón y vender el resto daba +785 monedas frente a venderlo todo por la
   * vía normal. Graduar era la forma de esquivar la curva anti-acaparamiento,
   * que es justo lo que la curva existe para impedir.
   *
   * El arreglo: la curva se calcula sobre el montón ENTERO (las graduadas
   * siguen siendo copias en propiedad) y lo que se acota es CUÁNTAS se venden.
   *
   * Lo que se comprueba aquí es la CONCLUSIÓN, no la implementación: se recorre
   * cada estrategia posible de "graduar G copias y vender el resto" y se exige
   * que ninguna gane a vender por la vía normal. Si alguien vuelve a pasarle a
   * valorDeVenta un montón recortado, esto se pone rojo.
   */
  {
    const RAREZAS = [
      "Rare", "Rare Holo", "Double Rare", "Illustration Rare",
      "Ultra Rare", "Special Illustration Rare", "Hyper Rare",
    ];
    let peor = -Infinity;
    let peorCaso = "";
    for (const rareza of RAREZAS) {
      for (const N of [2, 3, 5, 10, 20, 50, 100, 300]) {
        // Estrategia honesta: vender todas las repetidas de una tacada.
        const normal = valorDeVenta(rareza, N);

        for (let g = 1; g <= N - 1; g++) {
          const libres = N - g;
          // Las libres, con la curva del montón ENTERO (que es el arreglo).
          const porLibres = valorDeVenta(rareza, N, libres - 1);
          // Las graduadas, una a una, al multiplicador medio de la tabla.
          let porGraduadas = 0;
          let q = N - (libres - 1);
          for (let k = 0; k < g && q > 1; k++) {
            porGraduadas += valorDeVenta(rareza, q, 1) * graduacion.MULTIPLICADOR_MEDIO;
            q--;
          }
          const coste = g * graduacion.costeDeGraduar(precioDeCartaSuelta(rareza), g);
          const ventaja = porLibres + porGraduadas - coste - normal;
          if (ventaja > peor) {
            peor = ventaja;
            peorCaso = `${rareza} con ${N} copias, graduando ${g}`;
          }
        }
      }
    }
    comprueba(
      peor <= 0,
      `graduar parte del montón nunca gana a venderlo (peor caso ${peor.toFixed(1)} monedas)`,
      `sale a cuenta graduar: +${peor.toFixed(1)} monedas en ${peorCaso}.` +
        " Casi seguro que alguna ruta de venta ha vuelto a pasarle a valorDeVenta" +
        " las copias LIBRES en vez del montón entero, y eso reinicia la curva.",
    );
  }

}

/* ------------------------------------------------------------------ */
/* BAZAR ENTRE JUGADORES                                               */
/* ------------------------------------------------------------------ */
/*
 * LO QUE SE PROTEGE AQUÍ es lo único que de verdad importa del bazar: que no
 * sea un canal para pasar monedas entre dos cuentas de la misma persona.
 *
 * Hasta que existió el bazar, las monedas NO SE PODÍAN MOVER entre cuentas por
 * ninguna vía: toda escritura sobre users.coins filtra por el id de la sesión y
 * el trueque de app/social.ts es carta por carta, sin dinero. El bazar rompe
 * eso por diseño, así que lo que queda es que cada pase PIERDA valor.
 */
{
  seccion("Bazar: pasar monedas entre cuentas siempre pierde valor");

  const {
    PRECIO_MINIMO_FRACCION, PRECIO_MAXIMO_FRACCION, COMISION,
    SOBRES_PARA_VENDER, SOBRES_PARA_COMPRAR, MAX_ANUNCIOS_ABIERTOS,
    bandaDePrecio, precioValido, comisionDe, pagoAlVendedor,
  } = bazar;

  // 1. La banda existe y es una banda: sin techo, publicar un Common a 10.000
  //    convertiría el bazar en una transferencia bancaria.
  comprueba(
    PRECIO_MAXIMO_FRACCION > PRECIO_MINIMO_FRACCION &&
      PRECIO_MAXIMO_FRACCION < Infinity &&
      PRECIO_MINIMO_FRACCION > 0,
    `el precio está acotado entre el ${(100 * PRECIO_MINIMO_FRACCION).toFixed(0)}% y el ${(100 * PRECIO_MAXIMO_FRACCION).toFixed(0)}% del valor real`,
  );

  // 2. Nadie puede publicar fuera de la banda. A la fuerza bruta sobre todo el
  //    catálogo de valores posibles.
  let fuera = 0;
  for (let v = 1; v <= 5000; v += 7) {
    const { min, max } = bandaDePrecio(v);
    if (precioValido(min - 1, v)) fuera++;
    if (precioValido(max + 1, v)) fuera++;
    if (!precioValido(min, v) || !precioValido(max, v)) fuera++;
    if (precioValido(0, v) || precioValido(-100, v) || precioValido(1e9, v)) fuera++;
  }
  comprueba(fuera === 0, "ningún precio fuera de la banda se acepta, a ningún valor");

  // 3. LA COMISIÓN SIEMPRE MUERDE, incluso en las ventas de una moneda. Un
  //    bazar de cartas de 2 monedas sin comisión volvería a ser un canal libre.
  let sinComision = 0;
  for (let p = 1; p <= 20000; p += p < 100 ? 1 : 19) {
    if (comisionDe(p) < 1) sinComision++;
    if (pagoAlVendedor(p) >= p) sinComision++;
  }
  comprueba(
    sinComision === 0 && COMISION > 0,
    `la comisión (${(100 * COMISION).toFixed(0)}%) se cobra siempre y nunca es cero`,
  );

  // 4. EL INVARIANTE DE VERDAD: el mejor caso posible para quien intenta lavar
  //    monedas —publicar al máximo de la banda— sigue perdiendo dinero en cada
  //    pase. Se mide el ciclo completo: la cuenta A paga `precio`, la cuenta B
  //    recibe `pagoAlVendedor(precio)`, y entre las dos manos hay una carta que
  //    vale `valor`. Lo que importa es que el DINERO trasladado sea menor que
  //    el dinero gastado.
  const fugas = [];
  for (let v = 1; v <= 5000; v += 3) {
    const { max } = bandaDePrecio(v);
    const trasladado = pagoAlVendedor(max);
    if (trasladado >= max) fugas.push(`v=${v}`);
    // Y el traslado nunca puede superar el valor real de la carta por más del
    // margen de la banda: es lo que impide mover 10.000 monedas con un Common.
    if (trasladado > v * PRECIO_MAXIMO_FRACCION) fugas.push(`v=${v} traslado desbocado`);
  }
  comprueba(
    fugas.length === 0,
    "mover monedas por el bazar siempre cuesta la comisión, a cualquier valor",
    fugas.slice(0, 3).join(", "),
  );

  // 5. Las barreras de entrada existen. No comprueban un número concreto, sólo
  //    que alguien no las haya puesto a cero sin darse cuenta.
  /* LAS DOS BARRERAS, y la del comprador es la importante: el lavado va de la
   * cuenta alternativa (que tiene las monedas del grifo) a la principal, o sea
   * que la alternativa es quien COMPRA. Con la barrera sólo en la venta se
   * estaba protegiendo la dirección equivocada, y el test no lo habría notado. */
  comprueba(
    SOBRES_PARA_VENDER > 0 && SOBRES_PARA_COMPRAR > 0 && MAX_ANUNCIOS_ABIERTOS > 0,
    `hay barrera de antigüedad en las DOS direcciones (vender ${SOBRES_PARA_VENDER} sobres, comprar ${SOBRES_PARA_COMPRAR}) y tope de anuncios (${MAX_ANUNCIOS_ABIERTOS})`,
    "una barrera a cero deja abierto el lavado de monedas entre cuentas",
  );
}

/* ------------------------------------------------------------------ */
/* PERFILES POR ERA                                                    */
/* ------------------------------------------------------------------ */
/*
 * Las eras suben las probabilidades de premio de las expansiones modernas. Eso
 * NO puede abrir una fuga —`calibrar` reacciona sola quitando relleno— pero sí
 * puede tirar expansiones fuera de la tienda: en cuanto una era obliga a
 * retirar más de TOLERANCIA_RELLENO huecos, el sobre deja de considerarse un
 * sobre. El primer intento de perfil hacía exactamente eso con TRECE de las
 * dieciséis expansiones modernas, y no lo habría visto nadie hasta producción.
 */
{
  seccion("Eras: ninguna era rompe la tienda");

  const { eraDeSerie } = packLogic;
  const serieDe = new Map(
    JSON.parse(readFileSync(join(raiz, "src", "data", "all-sets.json"), "utf8"))
      .map((s) => [s.id, s.series]),
  );

  const eras = new Set();
  const imprimen = [];
  const caidas = [];
  for (const [setId, cartas] of CARTAS) {
    const era = eraDeSerie(serieDe.get(setId));
    eras.add(era);

    // Con la era de verdad no puede pasar de su precio.
    if (admiteSobreEstandar(cartas, era)) {
      const v = valorEsperadoEstandar(cartas, era);
      if (v > PACK_PRICES.STANDARD + 1e-9) imprimen.push(`${setId} estándar ${v.toFixed(2)}`);
    }
    if (admiteSobrePremium(cartas, era)) {
      const v = valorEsperadoPremium(cartas, era);
      if (v > PACK_PRICES.PREMIUM + 1e-9) imprimen.push(`${setId} premium ${v.toFixed(2)}`);
    }

    // Y no puede caerse de la tienda por culpa de la era: lo que se vendía con
    // el reparto de siempre se sigue vendiendo.
    if (admiteSobreEstandar(cartas) && !admiteSobreEstandar(cartas, era)) {
      caidas.push(`${setId} estándar (${era})`);
    }
    if (admiteSobrePremium(cartas) && !admiteSobrePremium(cartas, era)) {
      caidas.push(`${setId} premium (${era})`);
    }
  }

  comprueba(
    imprimen.length === 0,
    `ningún sobre pasa de su precio con las probabilidades de su era (${eras.size} eras en juego)`,
    imprimen.slice(0, 4).join(", "),
  );
  comprueba(
    caidas.length === 0,
    "subir las probabilidades por era no tira ninguna expansión fuera de la tienda",
    caidas.slice(0, 6).join(", "),
  );

  /* ------------------------------------------------------------------ *
   * UN SOBRE A LA VENTA REPARTE TODAS SUS CARTAS
   * ------------------------------------------------------------------
   *
   * ESTE INVARIANTE EXISTE POR UN FALLO QUE LLEGÓ A PRODUCCIÓN, y es el
   * ejemplo perfecto de por qué comprobar lo que se anuncia no basta.
   *
   * Al subir las probabilidades de premio de las expansiones modernas, el
   * sobre pasó a valer más de lo que cuesta, y `calibrar` compensó como tiene
   * que compensar: RETIRANDO huecos de relleno. Trece expansiones pasaron de
   * repartir diez cartas a repartir OCHO.
   *
   * Y no lo cazó nadie. El invariante de arriba —"lo que se anuncia es lo que
   * se reparte"— seguía en verde, porque la tienda anunciaba ocho y el
   * generador entregaba ocho: eran coherentes entre sí y las dos estaban mal.
   * El de "ningún sobre por encima de su precio" también, porque quitar cartas
   * es justo lo que lo mantiene. Y el de "no se cae de la tienda" también,
   * porque TOLERANCIA_RELLENO permite perder hasta dos huecos.
   *
   * Faltaba comprobar el número en sí. Un sobre estándar son seis comunes,
   * tres infrecuentes y un premio: DIEZ. Si un cambio lo baja, se entera aquí
   * y no el jugador.
   *
   * SI ALGÚN DÍA SE SUBE EL PRECIO DEL SOBRE para pagar mejores tiradas, esto
   * sigue valiendo tal cual: lo que exige es que el sobre reparta lo que su
   * relleno declara, sea cual sea el precio.
   */
  {
    /* SE MIDE CONTRA EL REPARTO DE SIEMPRE, NO CONTRA UN NÚMERO FIJO.
     *
     * La primera versión de esto exigía diez cartas clavadas y se puso roja con
     * swsh35, que reparte NUEVE — y ese caso es CORRECTO y anterior a todo
     * esto: Champion's Path es la única expansión del repositorio cuyo escalón
     * de rara no tiene ni una 'Rare' barata, devolvía el 101,8% de su precio y
     * el calibrado le quita un hueco a propósito (está contado entero en el
     * comentario largo de utils/packLogic.ts).
     *
     * Lo que hay que impedir no es que un sobre tenga menos de diez cartas por
     * un motivo medido y documentado. Es que un cambio de PROBABILIDADES le
     * quite cartas al jugador de tapadillo. Por eso la referencia es el mismo
     * sobre con el reparto de siempre: la era puede cambiar QUÉ sale, nunca
     * CUÁNTAS salen. */
    const cortos = [];
    for (const [setId, cartas] of CARTAS) {
      const era = eraDeSerie(serieDe.get(setId));
      if (!admiteSobreEstandar(cartas, era)) continue;
      const conSuEra = cartasDelSobre(cartas, "STANDARD", era);
      const deSiempre = cartasDelSobre(cartas, "STANDARD");
      if (conSuEra < deSiempre) {
        cortos.push(setId + " (" + era + "): " + deSiempre + " -> " + conSuEra);
      }
    }
    comprueba(
      cortos.length === 0,
      "las probabilidades por era no le quitan ni una carta al sobre",
      cortos.length +
        " expansiones reparten de menos: " + cortos.slice(0, 6).join(", ") +
        ". Alguien ha subido las probabilidades de premio sin subir el precio del" +
        " sobre, y calibrar lo está pagando con cartas del jugador. El sobre" +
        " estándar sólo tiene 0,33 monedas de margen sobre sus 50.",
    );
  }

  // Una serie desconocida —una expansión recién ingerida por el cron, o el
  // respaldo local sin ficha— tiene que caer en el reparto de SIEMPRE. Si no,
  // el juego cambiaría solo cada vez que TCGdex inventara un nombre de serie.
  comprueba(
    eraDeSerie(null) === eraDeSerie(undefined) &&
      eraDeSerie("") === eraDeSerie("Una Serie Que No Existe"),
    "una expansión sin serie conocida usa el reparto de siempre",
  );
}

/* ------------------------------------------------------------------ */
/* EL ESTADO FÍSICO NO SE PIERDE POR EL CAMINO                         */
/* ------------------------------------------------------------------ */
/*
 * ESTE INVARIANTE EXISTE PORQUE EL FALLO YA HA PASADO DOS VECES, en dos
 * pantallas distintas y con dos meses de diferencia:
 *
 *   · en la rejilla de la colección, donde `hidratarCartas` sustituía la carta
 *     del servidor por la del catálogo y se llevaba por delante el desgaste;
 *   · en el archivador, donde `fundasDelServidor` reconstruía la carta con
 *     cinco campos exactos y dejaba fuera `desperfectos` y `marcas`.
 *
 * Las dos veces el síntoma fue el mismo y es de los que no se ven revisando
 * código: la MISMA copia salía dañada en una pantalla e impecable en otra. No
 * falla nada, no hay excepción, no hay hueco. Simplemente una pantalla miente,
 * y el jugador lo descubre antes que nosotros.
 *
 * Que haya pasado dos veces dice que el riesgo no es el despiste sino la FORMA:
 * cada vez que alguien escribe un objeto carta campo a campo —y hay motivos
 * buenos para hacerlo, la normalización defensiva es uno— se está decidiendo en
 * silencio qué se queda fuera. Por eso esto se comprueba y no se confía.
 */
{
  seccion("Estado físico: lo que calcula el servidor tiene que llegar a la pantalla");

  await cargarModulo("utils/archivadorLocal.ts");
  const modeloVitrina = await cargarModulo("components/vitrina/modelo.ts");

  // Una copia bien fea, para que no haya duda de que hay algo que perder.
  const desperfectos = {
    piques: 7, aranazos: 3, manchas: 2, palidez: 0.4,
    descentrado: { x: 2.2, y: -1.4 },
  };
  const marcas = {
    piques: [{ x: 4, y: 9, tam: 2.5, fuerza: 0.8 }],
    aranazos: [{ x: 50, y: 30, tam: 18, giro: 24, fuerza: 0.5 }],
    manchas: [{ x: 70, y: 60, tam: 9, fuerza: 0.35 }],
  };

  const fundas = modeloVitrina.fundasDelServidor(
    [{
      hoja: 0, ranura: 0, id: "sv8-1", name: "Goldeen", rarity: "Common",
      images: { small: "s.png", large: "l.png" }, copias: 3,
      desperfectos, marcas,
    }],
    4,
  );
  const carta = fundas[0] && fundas[0].carta;

  comprueba(
    !!carta && carta.desperfectos === desperfectos && carta.marcas === marcas,
    "el archivador no pierde el estado físico al normalizar",
    "fundasDelServidor ha devuelto una carta sin `desperfectos` o sin `marcas`." +
      " El servidor los calcula (app/action.ts, estadoDeLaMejorCopia) y" +
      " FundaCarta sabe pintarlos, así que perderlos aquí no rompe nada: hace" +
      " que la MISMA copia salga dañada en la colección e impecable en la" +
      " funda. Campos que llegaron: " + (carta ? Object.keys(carta).join(", ") : "(ninguna carta)"),
  );

  // Y la otra mitad del trato: si el servidor NO manda estado —que es el caso
  // normal, la mayoría de las copias están bien— no puede aparecer uno de la
  // nada. Un `desperfectos: {}` vacío haría que estadoDeCopia se pusiera a
  // mirar dentro y que una carta sana se rotulara como dañada.
  const limpia = modeloVitrina.fundasDelServidor(
    [{
      hoja: 0, ranura: 1, id: "sv8-2", name: "Seaking", rarity: "Common",
      images: { small: "s.png", large: "l.png" }, copias: 1,
    }],
    4,
  );
  const sana = limpia[0] && limpia[0].carta;
  comprueba(
    !!sana && sana.desperfectos === undefined && sana.marcas === undefined,
    "una copia sana sigue llegando sin estado, y no con uno vacío",
    "fundasDelServidor se ha inventado un estado para una carta que no lo traía.",
  );
}

/* ==================================================================== *
 * EMPAREJAR UNA EXPANSIÓN CON EL SOBRE DE BULBAPEDIA
 * ====================================================================
 *
 * POR QUÉ ESTO ES UN INVARIANTE Y NO UN TEST CUALQUIERA: el fallo que se
 * previene aquí no se ve. Si el emparejamiento se tuerce, la expansión no se
 * queda sin foto —eso se notaría, quedaría el sobre dibujado— sino CON LA FOTO
 * DE OTRA, y a un sobre equivocado no le mira nadie dos veces.
 *
 * Y ahora hay DOS consumidores de esta lógica: scripts/bajar-sobres-bulbapedia.mjs
 * (a mano, escribe en public/sobres) y services/sobresIngest.ts (el cron, escribe
 * en Postgres). Comparten módulo justo para que no se separen; esto comprueba
 * que el módulo dice lo que los dos creen que dice.
 *
 * Los casos no son inventados: cada uno es una expansión real que rompió algo.
 */
{
  seccion("Sobres: emparejar expansión con su foto en Bulbapedia");

  const { normaliza, prefijosDe, analizarFichero, candidatasDe, pasaElFiltro,
          tituloDePagina, tamanoDeFondo, RATIO,
          acumularPaginas, resolverPaginas } = sobres;

  /* --- El apóstrofo. Quien sube el fichero a la wiki escribe "McDonalds" sin
   *     él; si se convirtiera en espacio como el resto de la puntuación,
   *     "mcdonald s collection" no casaría con "mcdonalds collection" y las dos
   *     colecciones que sí tienen sobre se caerían por una comilla. --- */
  comprueba(
    normaliza("McDonald's Collection 2021") === normaliza("McDonalds Collection 2021"),
    "el apóstrofo no separa palabras al normalizar (McDonald's)",
    "normaliza() ha vuelto a convertir la comilla en espacio.",
  );
  comprueba(
    normaliza("Pokémon GO") === "pokemon go",
    "los acentos se pierden al normalizar (Pokémon GO)",
  );

  /* --- "<algo> pack" SÓLO detrás del nombre completo, nunca detrás del id.
   *     "SV3 pack.png" es el sobre JAPONÉS de Obsidian Flames y "SV3 Booster
   *     Charizard.png" el internacional: aceptar el primero por el id sería
   *     poner el producto equivocado. --- */
  const obsidian = { id: "sv3", name: "Obsidian Flames" };
  const prefObsidian = prefijosDe(obsidian, "Obsidian Flames (TCG)", null);
  comprueba(
    analizarFichero("File:SV3 pack.png", prefObsidian) === null,
    "el sobre japonés (\"SV3 pack.png\") no se acepta por el id",
    "un patrón '… pack' detrás del id deja entrar el producto japonés.",
  );
  comprueba(
    analizarFichero("File:SV3 Booster Charizard.png", prefObsidian) !== null,
    "el sobre internacional (\"SV3 Booster Charizard.png\") sí se acepta",
  );
  comprueba(
    analizarFichero("File:POP Series 1 pack.png",
      prefijosDe({ id: "pop1", name: "POP Series 1" }, "POP Series 1 (TCG)", null)) !== null,
    "\"POP Series 1 pack.png\" sí, porque va detrás del NOMBRE completo",
  );

  /* --- El idioma. "S12a VSTAR Universe Booster Chinese.png" cuelga de la
   *     página de Zenit Supremo y es otro producto con otro dibujo. --- */
  const zenit = { id: "swsh12pt5", name: "Crown Zenith" };
  const prefZenit = prefijosDe(zenit, "Crown Zenith (TCG)", null);
  comprueba(
    analizarFichero("File:Crown Zenith Booster Chinese.png", prefZenit) === null,
    "un fichero marcado con idioma no es el sobre internacional",
  );
  comprueba(
    analizarFichero("File:Crown Zenith Booster Display.png", prefZenit) === null,
    "un display no es un sobre suelto",
  );

  /* --- El título de la página sólo aporta prefijo si es MÁS ESPECÍFICO. "Base"
   *     -> "Base Set" sí; "McDonald's Collection 2011" -> "McDonald's
   *     Collection" no, porque ahí la wiki junta nueve colecciones y su sobre
   *     no es el de 2011. --- */
  const conBaseSet = prefijosDe({ id: "base1", name: "Base" }, "Base Set (TCG)", null);
  comprueba(
    conBaseSet.some((p) => p.texto === "base set"),
    "un título de página más específico añade prefijo (Base -> Base Set)",
  );
  const mcd = prefijosDe(
    { id: "mcd11", name: "McDonald's Collection 2011" },
    "McDonald's Collection (TCG)",
    null,
  );
  comprueba(
    !mcd.some((p) => p.texto === "mcdonalds collection"),
    "un título de página MENOS específico no añade prefijo (McDonald's)",
    "aceptarlo daría a la colección de 2011 el sobre de otro año.",
  );

  /* --- El orden de las candidatas es parte del contrato, no una preferencia:
   *     el número de variante acaba en la URL que sirve la foto y en el CDN, así
   *     que la variante 1 tiene que ser la misma hoy, mañana, en el script y en
   *     el cron. --- */
  const ficheros = [
    "File:Crown Zenith Booster Pikachu Full Art.png",
    "File:Crown Zenith Booster.png",
    "File:Crown Zenith Booster Arceus.png",
    "File:Crown Zenith Logo.png",
    "File:Crown Zenith Booster Chinese.png",
  ];
  const cands = candidatasDe(zenit, ficheros, "Crown Zenith (TCG)", undefined);
  comprueba(
    cands[0] && cands[0].titulo === "File:Crown Zenith Booster.png",
    "primero el nombre más corto (\"… Booster\" antes que \"… Booster Arceus\")",
  );
  comprueba(
    JSON.stringify(candidatasDe(zenit, [...ficheros].reverse(), "Crown Zenith (TCG)", undefined)
      .map((c) => c.titulo)) === JSON.stringify(cands.map((c) => c.titulo)),
    "el orden no depende de cómo venga la lista de la wiki",
    "si depende, la misma expansión saca fotos distintas en dos ejecuciones.",
  );
  comprueba(
    !cands.some((c) => /Logo|Chinese/.test(c.titulo)),
    "ni el logo ni el sobre chino llegan a ser candidatas",
  );

  /* --- Las dos marcas de imprenta del mismo dibujo son UNA candidata. --- */
  const base = { id: "base1", name: "Base Set" };
  const dosTiradas = candidatasDe(
    base,
    ["File:Base Set Booster Charizard.jpg", "File:Base Set Booster Charizard Shadowless.jpg"],
    "Base Set (TCG)",
    undefined,
  );
  comprueba(
    dosTiradas.length === 1,
    "el mismo dibujo con otra marca de imprenta cuenta una vez",
  );

  /* --- Nunca más candidatas de las que caben. --- */
  comprueba(
    candidatasDe(
      base,
      Array.from({ length: 20 }, (_, i) => `File:Base Set Booster P${i} A B C.jpg`),
      "Base Set (TCG)",
      undefined,
    ).length <= 6,
    "las candidatas se cortan (3 variantes + 3 de repuesto)",
  );

  /* --- `omitir` no gasta ni una petición: es el mecanismo que impide que el
   *     cron le pregunte cada noche por las que nunca tuvieron sobre. --- */
  comprueba(
    tituloDePagina({ id: "sve", name: "Scarlet & Violet Energies" },
      { omitir: true, motivo: "energías" }) === null,
    "una expansión marcada \"omitir\" no produce título que consultar",
    "sin esto el cron preguntaría a la wiki por ella todas las noches.",
  );
  comprueba(
    tituloDePagina({ id: "ex3", name: "EX Dragon" }, { pagina: "EX Dragon (TCG)" })
      === "EX Dragon (TCG)" &&
    tituloDePagina({ id: "sv8", name: "Surging Sparks" }, undefined)
      === "Surging Sparks (TCG)",
    "el mapa a mano manda sobre el título por defecto",
  );

  /* --- El cedazo de forma, con los mismos textos que salen en el informe. --- */
  comprueba(
    pasaElFiltro({ url: "u", ancho: 560, alto: 1024 }) === null,
    "una foto con forma de sobre pasa el filtro",
  );
  comprueba(
    /proporción 1\.46/.test(pasaElFiltro({ url: "u", ancho: 500, alto: 730 }) ?? ""),
    "una foto chata se descarta diciendo su proporción",
  );
  comprueba(
    /109px/.test(pasaElFiltro({ url: "u", ancho: 109, alto: 200 }) ?? ""),
    "un icono se descarta diciendo su ancho",
  );
  comprueba(
    pasaElFiltro(null) !== null && pasaElFiltro({ ancho: 500, alto: 900 }) !== null,
    "sin URL no hay foto que valorar",
  );
  /* Con URL pero sin medidas el texto es "proporción NaN", que es LITERALMENTE
   * el que imprimía el script antes de que esto se extrajera a una función.
   * Ningún caso de la caché lo toca, o sea que el informe salía idéntico aunque
   * el texto cambiara: la clase de divergencia que sólo caza un invariante. */
  comprueba(
    /proporción NaN/.test(pasaElFiltro({ url: "u" }) ?? ""),
    "con URL y sin medidas se descarta por proporción, no por falta de URL",
    "el texto tiene que ser el mismo que imprimía el script antes de extraerlo.",
  );

  /* ==================================================================
   * LA OTRA MITAD DE LA LLAVE 1: QUÉ PÁGINA CONTESTÓ LA WIKI
   * ==================================================================
   *
   * El título final no es informativo: entra en `prefijosDe` como PREFIJO, o
   * sea que decide qué ficheros se aceptan. Estaba escrito dos veces —el script
   * y el cron— y ahora lo hacen `acumularPaginas` y `resolverPaginas`.
   *
   * El caso es real: Rayo Negro y Llama Blanca son DOS expansiones nuestras y
   * UNA página de la wiki, a la que las dos llegan por redirección.
   */
  {
    const titulos = ["Black Bolt (TCG)", "White Flare (TCG)"];
    const destinoDe = new Map(titulos.map((t) => [t, t]));
    const acumulado = new Map();
    acumularPaginas(
      { query: {
          redirects: [
            { from: "Black Bolt (TCG)", to: "Black Bolt & White Flare (TCG)" },
            { from: "White Flare (TCG)", to: "Black Bolt & White Flare (TCG)" },
          ],
          pages: [{ title: "Black Bolt & White Flare (TCG)", images: [{ title: "File:ZSV10 Booster.png" }] }],
      } },
      destinoDe,
      acumulado,
    );
    const r = resolverPaginas(titulos, destinoDe, acumulado);
    comprueba(
      r.get("Black Bolt (TCG)")?.titulo === "Black Bolt & White Flare (TCG)" &&
        r.get("White Flare (TCG)")?.titulo === "Black Bolt & White Flare (TCG)" &&
        r.get("Black Bolt (TCG)")?.ficheros.length === 1,
      "se siguen las redirecciones de la wiki hasta el título final",
      "sin esto el prefijo de la página no es el bueno y cambia qué ficheros se aceptan.",
    );
  }
  {
    // Una respuesta partida por `continue`: los ficheros de la segunda ronda se
    // SUMAN a los de la primera. Perderlos deja una lista incompleta, que es lo
    // que convierte "aún no la han subido" en un negativo de 180 días.
    const destinoDe = new Map([["Grande (TCG)", "Grande (TCG)"]]);
    const acumulado = new Map();
    acumularPaginas({ query: { pages: [{ title: "Grande (TCG)", images: [{ title: "File:1.png" }] }] } }, destinoDe, acumulado);
    acumularPaginas({ query: { pages: [{ title: "Grande (TCG)", images: [{ title: "File:2.png" }] }] } }, destinoDe, acumulado);
    const r = resolverPaginas(["Grande (TCG)"], destinoDe, acumulado);
    comprueba(
      r.get("Grande (TCG)")?.ficheros.join(",") === "File:1.png,File:2.png",
      "las rondas de `continue` se acumulan en vez de pisarse",
    );
  }
  {
    // "No hay tal página" tiene que ser distinguible, porque es lo único que
    // justifica un negativo largo. Que la wiki no conteste NO cae aquí: eso lo
    // decide `fallo` en services/sobresIngest.ts, no esta función.
    const r = resolverPaginas(["Nope (TCG)"], new Map([["Nope (TCG)", "Nope (TCG)"]]), new Map());
    comprueba(
      r.get("Nope (TCG)")?.existe === false && r.get("Nope (TCG)")?.ficheros.length === 0,
      "un título del que no se sabe nada sale como que no existe",
    );
  }

  /* ==================================================================
   * EL RECORTE EN CSS, QUE ES LO QUE SUSTITUYE A `sharp`
   * ==================================================================
   *
   * La foto se pinta en DOS elementos que se separan al rasgar: el cuerpo
   * (W x 1,8282·W) y la tapa (W x 0,0951·W). `background-size: cover` se
   * calcula POR ELEMENTO, así que con una foto más chata que 1,8282 el cuerpo
   * escalaría por alto y la tapa por ancho: la misma imagen a dos tamaños
   * distintos, y el desajuste justo en la línea de rasgado. `tamanoDeFondo`
   * devuelve una ANCHURA explícita, que es común a las dos cajas porque las dos
   * miden lo mismo de ancho.
   */
  comprueba(
    tamanoDeFondo(780, 1426) === null,
    "una foto ya recortada a 780/1426 no lleva recorte: cae en \"100% auto\"",
    "emitir la variable aquí cambiaría el pintado de las 130 que ya funcionan.",
  );
  comprueba(
    tamanoDeFondo(500, 1000) === null,
    "una foto MÁS alargada tampoco: \"100% auto\" ya la recorta por abajo",
  );
  {
    // r = 1,65 es el límite que acepta el filtro, y el caso que rompía `cover`.
    const v = tamanoDeFondo(1000, 1650);
    const x = parseFloat(String(v));
    comprueba(
      v !== null && Math.abs(x - (100 * RATIO) / 1.65) < 0.01,
      "una foto chata se agranda justo lo que hace falta para llenar el sobre",
      `tamanoDeFondo(1000,1650) = ${v}`,
    );
    comprueba(
      v !== null && / auto$/.test(String(v)) && !/[()"']/.test(String(v)),
      "el valor es un \"X% auto\" limpio: nada que pueda cerrar la declaración CSS",
    );
  }
  comprueba(
    tamanoDeFondo(0, 100) === null && tamanoDeFondo(100, 0) === null,
    "sin medidas no se inventa un recorte",
  );
}

/* ==================================================================== *
 * LAS TRES FUGAS DE MONEDAS QUE SE CERRARON EN app/action.ts
 * ====================================================================
 *
 * POR QUÉ ESTA SECCIÓN NO SE PARECE A NINGUNA DE LAS DE ARRIBA. Todo lo demás
 * de este fichero se puede EJECUTAR: se llama a la función, se mira lo que
 * devuelve y se acabó. Las tres fugas que se vigilan aquí no viven en
 * JavaScript sino DENTRO DE SENTENCIAS SQL, y para ejecutarlas haría falta un
 * Postgres —dos sesiones a la vez, además, porque dos de las tres son
 * carreras—. Esto es `npm test`: catorce segundos, sin red, sin base de datos
 * y sin reloj. Aquí no se puede ejecutar ese SQL, y no se va a poder.
 *
 * ASÍ QUE LO QUE SE COMPRUEBA ES LA FORMA DEL CÓDIGO FUENTE, y conviene decirlo
 * en voz alta: UN INVARIANTE ESTÁTICO NO DEMUESTRA NADA. No prueba que Postgres
 * bloquee la fila, ni que el planificador tome los candados en el orden que
 * promete el comentario, ni que la sentencia haga lo que dice. Sólo prueba que
 * la FORMA de la que depende ese razonamiento sigue estando ahí. Es una red, no
 * un teorema.
 *
 * Y MERECE LA PENA IGUALMENTE, por cómo vuelven estas tres cosas: no vuelven
 * porque alguien decida reabrirlas, vuelven de una limpieza. Un FOR UPDATE que
 * "sobra porque el UPDATE de abajo ya comprueba el saldo". Un UPDATE que le
 * cambia el user_id a la fila porque es lo obvio —la carta cambia de dueño,
 * ¿no?—. Dos sentencias que se separan al meter un `if` en medio. Los tres son
 * cambios que se leen bien, que pasan una revisión, que no rompen ningún test y
 * que dejan el código EXACTAMENTE como estaba antes del arreglo. Contra eso una
 * red vale, porque el agujero no se abre de nuevo: se REABRE, y reabrirlo tiene
 * una forma reconocible.
 *
 * Lo que sí es una demostración está al final de la sección: un invariante
 * CERRADO que ejecuta las funciones de verdad —`semillaDeCopia` y
 * `notaDeCopia`— y enseña que un hueco de copia reciclado devuelve la MISMA
 * nota, que es la propiedad económica entera. Los estáticos son el suelo.
 */
{
  seccion("Servidor: las tres fugas de monedas no se pueden reabrir");

  /* ------------------------------------------------------------------ *
   * EL ESCÁNER DE SQL
   * ------------------------------------------------------------------
   *
   * Un grep de una línea no vale aquí, y no por pereza:
   *
   *   · el SQL vive en plantillas de VARIAS LÍNEAS y la cláusula SET se parte
   *     donde caiga ("SET user_id = $2,\n  copia = (…)");
   *   · app/action.ts está lleno de comentarios que NOMBRAN la fuga que
   *     cerraron ("antes esta fila se movía y se le cambiaba el user_id"), así
   *     que un grep ingenuo caza el comentario y no la sentencia;
   *   · y mencionar `user_id` a la derecha del igual —dentro de un WHERE o de
   *     una subconsulta— no es asignarlo.
   *
   * Así que se saca el SQL de verdad: se recorre el fichero saltándose
   * comentarios, cadenas y expresiones regulares, se quedan las plantillas que
   * son SQL, se les quitan sus propios comentarios, se normalizan los espacios
   * y sólo entonces se mira la cláusula SET, coma a coma y con las paréntesis
   * contadas. Más abajo hay una autoprueba con fugas escritas a mano, porque un
   * escáner que no cazara nada también saldría en verde.
   *
   * SE MIRA EL ÁRBOL VIVO (app, services, utils, components, hooks) y no la
   * raíz entera: en la raíz hay dos copias descomprimidas de ramas viejas
   * (PokemonTCG-simulator-*) que no son el juego y que nadie ejecuta.
   */
  const DIRS_CON_SQL = ["app", "services", "utils", "components", "hooks"];

  function ficherosDeCodigo() {
    const salida = [];
    const anda = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".next") continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) anda(p);
        else if (/\.tsx?$/.test(e.name)) salida.push(p);
      }
    };
    for (const d of DIRS_CON_SQL) anda(join(raiz, d));
    return salida.sort();
  }
  const rotulo = (f) => f.slice(raiz.length + 1).replace(/\\/g, "/");

  /* Las plantillas `…` de un fichero TypeScript. La barra puede abrir una
   * expresión regular o ser una división, y hay que distinguirlas: sin eso, el
   * /['’]/ de services/sobresEmparejar.ts abre una cadena que se come el resto
   * del fichero y el escáner se queda ciego sin decirlo. */
  const ABRE_REGEXP = /[([{,;:=!&|?+\-*%^~<>]$/;
  const PALABRA_REGEXP = /\b(return|typeof|case|in|of|delete|void|instanceof|yield|await|do|else)$/;

  function plantillasDe(codigo) {
    const salida = [];
    const n = codigo.length;
    let i = 0;
    let previo = ""; // cola de lo último que cuenta, para decidir la barra
    while (i < n) {
      const c = codigo[i];
      const d = codigo[i + 1];
      if (c === "/" && d === "/") {
        while (i < n && codigo[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && d === "*") {
        i += 2;
        while (i < n && !(codigo[i] === "*" && codigo[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      if (c === "'" || c === '"') {
        i++;
        while (i < n && codigo[i] !== c) {
          if (codigo[i] === "\\") i++;
          i++;
        }
        i++;
        previo = c;
        continue;
      }
      if (c === "/" && (previo === "" || ABRE_REGEXP.test(previo) || PALABRA_REGEXP.test(previo))) {
        i++;
        let clase = false;
        while (i < n) {
          const x = codigo[i];
          if (x === "\\") { i += 2; continue; }
          if (x === "\n") break;
          if (x === "[") clase = true;
          else if (x === "]") clase = false;
          else if (x === "/" && !clase) break;
          i++;
        }
        i++;
        previo = "/";
        continue;
      }
      if (c === "`") {
        i++;
        const desde = i;
        let llaves = 0; // las ${…} pueden traer llaves y backticks dentro
        while (i < n) {
          const x = codigo[i];
          if (x === "\\") { i += 2; continue; }
          if (x === "$" && codigo[i + 1] === "{") { llaves++; i += 2; continue; }
          if (llaves > 0 && x === "}") { llaves--; i++; continue; }
          if (llaves === 0 && x === "`") break;
          i++;
        }
        salida.push(codigo.slice(desde, i));
        i++;
        previo = "`";
        continue;
      }
      if (!/\s/.test(c)) previo = (previo + c).slice(-12);
      i++;
    }
    return salida;
  }

  /* Las interpolaciones se sustituyen por "?": lo que hay dentro es JavaScript
   * y puede traer comas y paréntesis que descuadrarían el recuento del SET. */
  function sinInterpolaciones(t) {
    let salida = "";
    let i = 0;
    while (i < t.length) {
      if (t[i] === "$" && t[i + 1] === "{") {
        let prof = 1;
        i += 2;
        while (i < t.length && prof > 0) {
          if (t[i] === "{") prof++;
          else if (t[i] === "}") prof--;
          i++;
        }
        salida += "?";
        continue;
      }
      salida += t[i++];
    }
    return salida;
  }

  const normalizaSql = (t) =>
    sinInterpolaciones(t)
      .replace(/--[^\n]*/g, " ")          // comentario SQL de línea
      .replace(/\/\*[\s\S]*?\*\//g, " ")  // comentario SQL de bloque
      .replace(/\s+/g, " ")
      .trim();

  const ESSQL = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE)\b/i;
  const sentenciasSql = (codigo) =>
    plantillasDe(codigo).filter((p) => ESSQL.test(p)).map(normalizaSql);

  /* La cláusula SET que empieza en `desde`, cortada donde de verdad acaba: en
   * el primer WHERE / FROM / RETURNING / ON CONFLICT de primer nivel, o en el
   * paréntesis que cierra el CTE. Los de dentro de una subconsulta no cuentan. */
  function clausulaSet(sql, desde) {
    let prof = 0;
    let i = desde;
    while (i < sql.length) {
      const c = sql[i];
      if (c === "(") prof++;
      else if (c === ")") {
        if (prof === 0) break;
        prof--;
      } else if (prof === 0 && /[A-Za-z]/.test(c) && !/[\w$]/.test(sql[i - 1] ?? " ")) {
        if (/^(WHERE|FROM|RETURNING|ON\s+CONFLICT)\b/i.test(sql.slice(i))) break;
      }
      i++;
    }
    return sql.slice(desde, i);
  }

  /* Los DESTINOS de una cláusula SET: se parte por las comas de primer nivel y
   * de cada trozo se toma lo que hay ANTES del igual. Así "nota = (SELECT …
   * WHERE user_id = $1)" no cuenta como tocar user_id, y la forma de lista
   * "(user_id, copia) = (…)" sí. */
  function destinosSet(clausula) {
    const trozos = [];
    let prof = 0;
    let ini = 0;
    for (let i = 0; i < clausula.length; i++) {
      const c = clausula[i];
      if (c === "(") prof++;
      else if (c === ")") prof--;
      else if (c === "," && prof === 0) {
        trozos.push(clausula.slice(ini, i));
        ini = i + 1;
      }
    }
    trozos.push(clausula.slice(ini));
    return trozos.map((t) => {
      let p = 0;
      for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (c === "(") p++;
        else if (c === ")") p--;
        else if (c === "=" && p === 0 && t[i + 1] !== "=" && !"!<>".includes(t[i - 1] ?? "")) {
          return t.slice(0, i).trim();
        }
      }
      return t.trim();
    });
  }

  /* Toda asignación de una sentencia: el UPDATE de siempre y también el
   * "ON CONFLICT … DO UPDATE SET", que es la puerta de atrás para reescribir
   * una fila sin escribir la palabra UPDATE delante de la tabla. */
  function asignacionesDe(sql) {
    const salida = [];
    let m;
    const reUpdate = /\bUPDATE\s+(?:ONLY\s+)?([A-Za-z_][\w$]*)\s+(?:(?:AS\s+)?(?!SET\b)[A-Za-z_][\w$]*\s+)?SET\b/gi;
    while ((m = reUpdate.exec(sql))) {
      salida.push({ tabla: m[1].toLowerCase(), destinos: destinosSet(clausulaSet(sql, m.index + m[0].length)) });
    }
    const reUpsert = /\bINSERT\s+INTO\s+([A-Za-z_][\w$]*)\b(?:(?!\bINSERT\s+INTO\b)[\s\S])*?\bDO\s+UPDATE\s+SET\b/gi;
    while ((m = reUpsert.exec(sql))) {
      salida.push({ tabla: m[1].toLowerCase(), destinos: destinosSet(clausulaSet(sql, m.index + m[0].length)) });
    }
    return salida;
  }

  /* Los CTE de una sentencia y lo que queda después de ellos. Se recorre la
   * lista en orden contando paréntesis, en vez de buscar ", algo AS (" por todo
   * el texto: una coma dentro del cuerpo de un CTE no abre otro CTE. */
  function ctesDe(sql) {
    const lista = new Map();
    const cabecera = /^\s*WITH\s+(?:RECURSIVE\s+)?/i.exec(sql);
    if (!cabecera) return { lista, principal: sql };
    let i = cabecera[0].length;
    for (;;) {
      const cab = /^\s*([A-Za-z_][\w$]*)\s*(?:\([^)]*\)\s*)?AS\s+(?:(?:NOT\s+)?MATERIALIZED\s+)?\(/i.exec(sql.slice(i));
      if (!cab) break;
      const desde = i + cab[0].length;
      let j = desde;
      let prof = 1;
      while (j < sql.length && prof > 0) {
        if (sql[j] === "(") prof++;
        else if (sql[j] === ")") prof--;
        j++;
      }
      lista.set(cab[1].toLowerCase(), sql.slice(desde, j - 1));
      i = j;
      const coma = /^\s*,/.exec(sql.slice(i));
      if (!coma) break;
      i += coma[0].length;
    }
    return { lista, principal: sql.slice(i) };
  }

  /* El cuerpo de una server action, para poder decir "en ESTA función" y no
   * "en algún sitio del fichero". Va de su declaración al siguiente `export`. */
  function cuerpoDeFuncion(codigo, nombre) {
    const m = new RegExp("^export\\s+async\\s+function\\s+" + nombre + "\\b", "m").exec(codigo);
    if (!m) return null;
    const resto = codigo.slice(m.index + m[0].length);
    const fin = /^export\s/m.exec(resto);
    return resto.slice(0, fin ? fin.index : resto.length);
  }

  /* Una fuga es: una asignación sobre graded_cards cuyo destino es user_id o
   * copia. Se usa igual sobre el repositorio y sobre los casos de mentira de la
   * autoprueba, que es lo que hace que la autoprueba signifique algo. */
  const sueltaElHueco = (sql) =>
    asignacionesDe(sql)
      .filter((a) => a.tabla === "graded_cards")
      .flatMap((a) => a.destinos.filter((d) => /\b(user_id|copia)\b/i.test(d)));

  const SENTENCIAS = [];
  const FICHEROS = ficherosDeCodigo();
  for (const f of FICHEROS) {
    for (const sql of sentenciasSql(readFileSync(f, "utf8"))) {
      SENTENCIAS.push({ fichero: rotulo(f), sql });
    }
  }

  /* ------------------------------------------------------------------ *
   * AUTOPRUEBA DEL ESCÁNER
   * ------------------------------------------------------------------
   * Sin esto, un escáner roto —una plantilla que no se extrae, un SET que se
   * corta donde no— pasaría el invariante de abajo en verde para siempre y sin
   * mirar nada. Los casos son la fuga REAL que se cerró y sus dos disfraces. */
  {
    const FUGAS = [
      // La que hubo: el bazar movía la fila de la graduada al comprador.
      `UPDATE graded_cards g
          SET user_id = $2,
              copia = (SELECT COALESCE(MAX(copia), 0) + 1
                         FROM graded_cards WHERE user_id = $2)
         FROM anuncio a
        WHERE g.id = a.graded_id
        RETURNING 1`,
      // La misma, en forma de lista de columnas.
      `UPDATE graded_cards SET (user_id, copia) = (SELECT $2, 1) WHERE id = $1`,
      // Y por la puerta de atrás, sin escribir UPDATE delante de la tabla.
      `INSERT INTO graded_cards (user_id, card_id, copia, nota, coste)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, card_id, copia) DO UPDATE
         SET copia = graded_cards.copia + 1
       RETURNING 1`,
    ];
    const LIMPIAS = [
      // Lo que hace hoy el bazar: marcar, conservando user_id y copia.
      `UPDATE graded_cards g SET estado = 'vendida', closed_at = NOW()
         FROM anuncio a
        WHERE g.id = a.graded_id AND g.user_id = a.seller_id AND g.estado = 'activa'
        RETURNING g.card_id, g.nota, g.coste`,
      // Nombrar la columna a la DERECHA del igual no es asignarla.
      `UPDATE graded_cards SET nota = (SELECT nota FROM graded_cards g2
          WHERE g2.user_id = $1 AND g2.copia = 1) WHERE id = $2`,
      // Y la regla es sobre graded_cards, no sobre cualquier tabla.
      `UPDATE binder_slots SET user_id = $2 WHERE id = $1`,
    ];
    const ciegas = FUGAS.filter((s) => sueltaElHueco(normalizaSql(s)).length === 0).length;
    const falsas = LIMPIAS.filter((s) => sueltaElHueco(normalizaSql(s)).length > 0);
    comprueba(
      ciegas === 0,
      `el escáner caza las ${FUGAS.length} formas de la fuga: SET partido en varias líneas, lista de columnas y ON CONFLICT DO UPDATE`,
      `${ciegas} se le escapan. El invariante de abajo estaría en verde sin mirar nada.`,
    );
    comprueba(
      falsas.length === 0,
      "y no confunde con una fuga ni la baja de hoy ni un user_id mencionado a la derecha del igual",
      falsas.map((s) => normalizaSql(s).slice(0, 90)).join(" · "),
    );
  }

  // Y que haya leído el repositorio de verdad: un escáner que no encuentra SQL
  // no encuentra fugas tampoco.
  {
    const conSql = new Set(SENTENCIAS.map((s) => s.fichero));
    const deGraduadas = SENTENCIAS.filter((s) => /\bgraded_cards\b/i.test(s.sql)).length;
    const bajas = SENTENCIAS.filter((s) => asignacionesDe(s.sql).some((a) => a.tabla === "graded_cards")).length;
    comprueba(
      SENTENCIAS.length > 100 && conSql.size >= 8 && deGraduadas >= 10 && bajas >= 2,
      `el escáner ve el SQL del repositorio (${SENTENCIAS.length} sentencias en ${conSql.size} ficheros, ${deGraduadas} tocan graded_cards)`,
      `sentencias ${SENTENCIAS.length}, ficheros ${conSql.size}, con graduadas ${deGraduadas}, con UPDATE sobre graduadas ${bajas}.` +
        " Faltan las dos bajas de una graduada (venderGraduadaAction y comprarEnBazarAction): o se han quitado, o el escáner se ha quedado ciego y hay que arreglarlo ANTES de fiarse del invariante siguiente.",
    );
  }

  /* ------------------------------------------------------------------ *
   * FUGA 1 · NINGÚN ÍNDICE DE COPIA SE RECICLA
   * ------------------------------------------------------------------
   *
   * La nota de una copia graduada NO se sortea al graduar: se deriva de la
   * semilla `secreto|usuario|carta|ÍNDICE` (utils/graduacion.ts). O sea que el
   * hueco (usuario, carta, copia) no es un detalle de almacenamiento: ES la
   * nota. Si una fila lo suelta —porque se borra, o porque cambia de user_id o
   * de copia— el hueco vuelve a estar libre, `graduarCartasAction` vuelve a
   * tomar el índice libre más bajo y sale OTRA VEZ LA MISMA NOTA. Un 10 se
   * repite indefinidamente: se vende, se consigue otra copia y se regradúa.
   *
   * Por eso la regla no es "el bazar no mueve la fila", que es sólo el sitio
   * donde estuvo la fuga: es que NINGUNA sentencia del repositorio puede
   * cambiarle a una fila de graded_cards el user_id o la copia. La fila que se
   * va se MARCA ('vendida' + closed_at) conservando las dos, y al que la recibe
   * se le da una fila NUEVA con el siguiente índice suyo.
   */
  {
    const reciclan = [];
    for (const { fichero, sql } of SENTENCIAS) {
      for (const destino of sueltaElHueco(sql)) {
        reciclan.push(`${fichero}: SET ${destino} …`);
      }
    }
    comprueba(
      reciclan.length === 0,
      "ninguna sentencia del repositorio cambia el user_id ni la copia de una graduada",
      reciclan.join("\n          ") +
        "\n          Eso suelta el hueco (usuario, carta, copia), y el hueco ES la nota:" +
        " la semilla es secreto|usuario|carta|índice, así que el dueño vuelve a graduar," +
        " graduarCartasAction toma otra vez el índice libre más bajo y sale la MISMA nota." +
        " Un 10 se reimprime sin límite. QUÉ TOCAR: esa sentencia — la fila de una" +
        " graduada que cambia de manos se marca 'vendida' conservando user_id y copia," +
        " y al comprador se le INSERTA una fila nueva (CTE 'entrega' de comprarEnBazarAction).",
    );

    // Borrarla suelta el hueco igual de bien, y sin escribir un SET.
    const borran = SENTENCIAS.filter((s) =>
      /\b(DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+(ONLY\s+)?graded_cards\b/i.test(s.sql));
    comprueba(
      borran.length === 0,
      "ni ninguna borra la fila, que es la otra forma de soltar el hueco",
      borran.map((s) => s.fichero + ": " + s.sql.slice(0, 80)).join("\n          ") +
        "\n          La fila de una graduada no se borra NUNCA, ni al venderla ni al" +
        " retirarla: ocupa su índice para siempre. Si sobran filas cerradas, se filtran" +
        " por estado='activa' al leer, que es lo que ya hacen todas las lecturas que" +
        " cuentan copias vivas en app/action.ts.",
    );
  }

  /* ------------------------------------------------------------------ *
   * FUGA 2 · EL ALTA DE UNA GRADUADA CUELGA DE UNA LECTURA CON CANDADO
   * ------------------------------------------------------------------
   *
   * El INSERT en graded_cards de `graduarCartasAction` cuelga por EXISTS de un
   * CTE que comprueba el saldo. Mientras ese CTE fue un SELECT a secas, leía la
   * INSTANTÁNEA del principio de la sentencia: dos peticiones simultáneas veían
   * las dos el mismo saldo, las dos insertaban, y el UPDATE del cobro —que sí
   * relee la fila que bloquea— sólo cobraba a una. La otra graduaba gratis.
   *
   * Lo que lo cierra es el FOR UPDATE de esa puerta, y es una línea: se quita
   * "simplificando" y no se nota en nada. Así que el invariante sigue la cadena
   * de verdad —qué CTE tiene el INSERT, de qué CTE cuelga, cuál de ésos mira
   * users.coins— y exige el candado en el que hace de puerta. No comprueba que
   * el fichero contenga las palabras FOR UPDATE en algún sitio, que es lo que
   * un grep podría decir y no significaría nada.
   */
  {
    const codigoAccion = readFileSync(join(raiz, "app", "action.ts"), "utf8");
    const cuerpo = cuerpoDeFuncion(codigoAccion, "graduarCartasAction");
    const altas = cuerpo === null
      ? []
      : sentenciasSql(cuerpo).filter((s) => /\bINSERT\s+INTO\s+graded_cards\b/i.test(s));

    let pega = "";
    let puertas = [];
    if (cuerpo === null) {
      pega = "graduarCartasAction ya no está en app/action.ts (¿se ha renombrado?)";
    } else if (altas.length !== 1) {
      pega = `se esperaba UNA sentencia que dé de alta graduadas en graduarCartasAction y hay ${altas.length}`;
    } else {
      const { lista } = ctesDe(altas[0]);
      const alta = [...lista].find(([, c]) => /\bINSERT\s+INTO\s+graded_cards\b/i.test(c));
      if (!alta) {
        pega = "el INSERT ya no está dentro de un CTE, así que no cuelga de ninguna comprobación";
      } else {
        const refs = [...alta[1].matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][\w$]*)/gi)].map((m) => m[1].toLowerCase());
        puertas = [...new Set(refs)].filter(
          (r) => lista.has(r) && /\busers\b/i.test(lista.get(r)) && /\bcoins\b/i.test(lista.get(r)),
        );
        if (puertas.length === 0) {
          pega = `el CTE "${alta[0]}" ya no cuelga de ninguna puerta de saldo:` +
            ` de los CTE que lee (${[...new Set(refs)].join(", ") || "ninguno"}) ninguno mira users.coins`;
        } else {
          const sinCandado = puertas.filter((p) => !/\bFOR\s+UPDATE\b/i.test(lista.get(p)));
          if (sinCandado.length > 0) {
            pega = `la puerta de saldo "${sinCandado.join('", "')}" ya no lleva FOR UPDATE`;
          }
        }
      }
    }
    comprueba(
      pega === "",
      `el alta de una graduada cuelga de una lectura de saldo CON candado (${puertas.join(", ") || "—"})`,
      pega +
        ". Sin FOR UPDATE esa puerta lee la instantánea del principio de la sentencia:" +
        " dos peticiones a la vez la pasan las dos, las dos insertan la fila y el cobro" +
        " sólo se le hace a una — la otra gradúa gratis, y la sentencia se confirma igual." +
        " QUÉ TOCAR: el CTE de graduarCartasAction que mira users.coins (hoy 'solvente')" +
        " tiene que seguir siendo un SELECT … FROM users … FOR UPDATE OF u, y el INSERT" +
        " tiene que seguir colgando de él por EXISTS.",
    );
  }

  /* ------------------------------------------------------------------ *
   * FUGA 3 · EL BONO SE PAGA EN LA MISMA SENTENCIA EN QUE SE QUEMA
   * ------------------------------------------------------------------
   *
   * La fila de `set_rewards` es lo que impide cobrar dos veces el bono de una
   * expansión. Mientras el INSERT y el pago fueron dos sentencias, entre una y
   * otra no había transacción: si la petición moría ahí, el premio quedaba
   * quemado y las monedas no se pagaban NUNCA — y como la marca ya estaba, el
   * jugador no podía volver a cobrarlo. Perdía el bono para siempre.
   *
   * El arreglo es de forma pura: el INSERT es un CTE, el UPDATE del pago cuelga
   * de él por EXISTS, todo en una llamada. Eso se deshace solo con separarlo
   * otra vez —por ejemplo al meter un `if` en medio del bucle—, así que lo que
   * se comprueba es la cadena entera: que el premio sea un CTE, que el pago vaya
   * en la sentencia principal y que nombre al CTE del premio.
   */
  {
    const codigoAccion = readFileSync(join(raiz, "app", "action.ts"), "utf8");
    const cuerpo = cuerpoDeFuncion(codigoAccion, "claimSetCompletionBonuses");
    const todas = cuerpo === null ? [] : sentenciasSql(cuerpo);
    const conPremio = todas.filter((s) => /\bINSERT\s+INTO\s+set_rewards\b/i.test(s));
    const paga = (sql) =>
      asignacionesDe(sql).some((a) => a.tabla === "users" && a.destinos.some((d) => /\bcoins\b/i.test(d)));

    let pega = "";
    if (cuerpo === null) {
      pega = "claimSetCompletionBonuses ya no está en app/action.ts (¿se ha renombrado?)";
    } else if (conPremio.length !== 1) {
      pega = `se esperaba UNA sentencia que escriba en set_rewards y hay ${conPremio.length}`;
    } else {
      const { lista, principal } = ctesDe(conPremio[0]);
      const premio = [...lista].find(([, c]) => /\bINSERT\s+INTO\s+set_rewards\b/i.test(c));
      if (!premio) {
        pega = "el INSERT en set_rewards ya no es un CTE, así que el pago no puede colgar de él";
      } else if (!paga(principal)) {
        pega = "la sentencia que quema el premio ya no paga: no hay UPDATE de users.coins colgando del INSERT";
      } else if (!new RegExp("EXISTS\\s*\\(\\s*SELECT[^()]*FROM\\s+" + premio[0] + "\\b", "i").test(principal)) {
        pega = `el pago va en la misma sentencia pero no cuelga del premio: falta EXISTS (SELECT 1 FROM ${premio[0]})`;
      } else {
        const sueltos = todas.filter((s) => !/\bset_rewards\b/i.test(s) && paga(s));
        if (sueltos.length > 0) {
          pega = `hay ${sueltos.length} pago(s) de users.coins en OTRA sentencia dentro de claimSetCompletionBonuses`;
        }
      }
    }
    comprueba(
      pega === "",
      "el bono de expansión se paga en la misma sentencia en la que se quema",
      pega +
        ". Separarlos deja una ventana sin transacción: si la petición muere entre las" +
        " dos, la fila de set_rewards queda escrita y las monedas no se pagan — y esa" +
        " fila es justo la que impide volver a cobrarlo, así que el bono se pierde PARA" +
        " SIEMPRE. QUÉ TOCAR: el INSERT en set_rewards tiene que seguir siendo el CTE" +
        " ('premio') del que cuelga por EXISTS el UPDATE de users.coins, en una sola" +
        " llamada a sql`…`, y no puede quedar ningún abono suelto fuera del bucle.",
    );
  }

  /* ------------------------------------------------------------------ *
   * Y LA PROPIEDAD ECONÓMICA, ESTA VEZ DEMOSTRADA
   * ------------------------------------------------------------------
   *
   * Los tres de arriba son forma. Éste no: ejecuta `semillaDeCopia` y
   * `notaDeCopia` de verdad y enseña qué se lleva el jugador según el hueco de
   * copia se recicle o no.
   *
   * Lo único replicado aquí es el REPARTO DE ÍNDICES —"el índice libre más bajo
   * que quepa en las copias que tienes"—, que en producción es un bucle dentro
   * de graduarCartasAction y no se puede importar (app/action.ts arrastra Next
   * y Clerk). Es una réplica deliberada, como la de `admiteOfertaAtada` o la de
   * `repartoIngenuo` más arriba; lo que impide que se quede vieja mintiendo es
   * el invariante estático de la FUGA 1, que vigila la otra mitad: que la fila
   * vendida siga ocupando su hueco en la base.
   */
  {
    const { notaDeCopia, semillaDeCopia, MULTIPLICADOR_NOTA, COSTE_FRACCION,
            costeDeGraduar, valorGraduado } = graduacion;

    const SECRETO = "secreto-de-prueba-para-los-invariantes";
    const CARTA = "sv8-32";
    const VUELTAS = 200;
    const TECHO = 1 + COSTE_FRACCION; // el mismo de la sección de graduación

    // El reparto de índices de graduarCartasAction, replicado.
    const indiceLibre = (ocupadas, copias) => {
      for (let i = 1; i <= copias; i++) if (!ocupadas.has(i)) return i;
      return null;
    };

    /* El jugador que va a explotarlo no es cualquiera: es el que sacó un 10 en
     * su primera copia. Se busca con el generador real para que el caso siga
     * valiendo si cambian la tabla o el secreto. */
    let elegido = null;
    for (let k = 0; k < 5000 && elegido === null; k++) {
      const u = "jugador_" + k;
      if (notaDeCopia(semillaDeCopia(u, CARTA, 1, SECRETO)) === 10) elegido = u;
    }

    const vueltas = (recicla) => {
      const ocupadas = new Set();
      const salida = [];
      for (let v = 0; v < VUELTAS; v++) {
        // Con reciclaje le basta UNA copia siempre: la vende y consigue otra.
        // Sin reciclaje su hueco sigue ocupado, así que para volver a graduar
        // necesita una copia más — y la nota sale de un índice nuevo.
        const copias = recicla ? 1 : v + 1;
        const indice = indiceLibre(ocupadas, copias);
        salida.push({ indice, nota: notaDeCopia(semillaDeCopia(elegido, CARTA, indice, SECRETO)) });
        if (!recicla) ocupadas.add(indice);
      }
      return salida;
    };
    const medio = (l) => l.reduce((t, x) => t + MULTIPLICADOR_NOTA[x.nota], 0) / l.length;

    const conFuga = elegido === null ? [] : vueltas(true);
    const comoEsta = elegido === null ? [] : vueltas(false);

    comprueba(
      elegido !== null,
      "hay un jugador cuya primera copia de una carta saca un 10 (el que explotaría la fuga)",
      "no se ha encontrado ninguno en 5.000: la tabla de notas o la semilla han cambiado" +
        " tanto que este caso ya no prueba lo que dice; hay que rehacerlo.",
    );

    /* LO QUE PASABA CON EL HUECO RECICLADO, medido: las 200 vueltas dan el
     * MISMO índice y por tanto la MISMA nota. El jugador deja de tirar y pasa a
     * ELEGIR, y la tabla de multiplicadores —que es lo único que sostiene que
     * graduar no imprima dinero— deja de significar nada. */
    const notasConFuga = new Set(conFuga.map((x) => x.nota));
    comprueba(
      conFuga.length === VUELTAS &&
        new Set(conFuga.map((x) => x.indice)).size === 1 &&
        notasConFuga.size === 1 && notasConFuga.has(10) &&
        medio(conFuga) > TECHO,
      `reciclar el hueco convierte la nota en una ELECCIÓN: ${VUELTAS} vueltas, ${VUELTAS} dieces (×${medio(conFuga).toFixed(2)} contra un techo de ×${TECHO.toFixed(2)})`,
      `índices distintos ${new Set(conFuga.map((x) => x.indice)).size}, notas distintas ${notasConFuga.size}.` +
        " Si esto deja de cumplirse, el caso ya no demuestra la fuga y el invariante" +
        " de abajo se queda sin contraste: hay que rehacerlo, no borrarlo.",
    );

    /* Y CON LA FILA VENDIDA OCUPANDO SU HUECO —que es lo que hace hoy el
     * código— cada vuelta es un índice nuevo, o sea una tirada nueva. */
    const dieces = comoEsta.filter((x) => x.nota === 10).length;
    comprueba(
      new Set(comoEsta.map((x) => x.indice)).size === VUELTAS &&
        new Set(comoEsta.map((x) => x.nota)).size > 1,
      `conservando el hueco, cada vuelta es una tirada nueva: ${VUELTAS} índices distintos y ${new Set(comoEsta.map((x) => x.nota)).size} notas distintas`,
      `índices distintos ${new Set(comoEsta.map((x) => x.indice)).size} de ${VUELTAS}.` +
        " El reparto de índices ha dejado de avanzar: si vuelve a repetir uno, la nota" +
        " se repite con él.",
    );
    comprueba(
      medio(comoEsta) <= TECHO,
      `y lo que se lleva de verdad no pasa del techo (×${medio(comoEsta).toFixed(3)} de ×${TECHO.toFixed(2)}, ${dieces} dieces en ${VUELTAS} vueltas)`,
      `×${medio(comoEsta).toFixed(3)} contra el techo ×${TECHO.toFixed(2)}: graduar en bucle vuelve a salir a cuenta.`,
    );

    /* El precio de la fuga, en monedas, para que el número esté escrito: una
     * Hyper Rare vale 250 y con un 10 garantizado cada vuelta deja limpio
     * valorGraduado(250,10) - 250 - coste. Por eso esto no era un detalle de
     * almacenamiento. */
    const V = precioDeCartaSuelta("Hyper Rare");
    const porVuelta = valorGraduado(V, 10) - V - costeDeGraduar(V, 1);
    comprueba(
      porVuelta > 0,
      `y la cuenta de la fuga está escrita: con un 10 garantizado, cada vuelta dejaba +${porVuelta.toFixed(0)} monedas limpias sobre una Hyper Rare (${V})`,
      "con la tabla de hoy repetir un 10 ya no sale a cuenta, así que este número ha" +
        " dejado de medir la fuga; el invariante de arriba (el del hueco) sigue siendo" +
        " el que importa.",
    );
  }
}

/* ==================================================================== *
 * LO QUE LA PANTALLA PROMETE Y LO QUE EL SERVIDOR CUMPLE
 * ====================================================================
 *
 * POR QUÉ HACE FALTA OTRA SECCIÓN Y NO BASTA CON LAS DE ARRIBA. Todo lo de
 * este fichero vigila que el juego no se rompa ni imprima dinero. Lo que se
 * vigila aquí es distinto y no lo cazaba nada: que el número que el jugador LEE
 * antes de pulsar sea el que va a recibir después.
 *
 * Ese fallo no rompe nada. No hay excepción, no hay fuga, no hay hueco: las dos
 * mitades funcionan perfectamente, cada una con su cuenta. Sólo que una de las
 * dos se pinta y la otra se cobra. Se ha colado CUATRO veces seguidas y siempre
 * con la misma forma —dos sitios calculando por su cuenta lo que uno solo sabe—:
 *
 *   · la tienda anunciaba el Premium con la tabla de la era 'media' y el
 *     servidor lo repartía con la de la expansión (14 expansiones afectadas);
 *   · la vitrina decía "Vender por 488" y la venta abonaba 417;
 *   · la lista de graduables ofrecía copias que la acción rechazaba;
 *   · el mercado colocaba una rareza desconocida en la banda de la morralla y
 *     le pagaba cinco veces su precio.
 *
 * Y todos se arreglaron igual: EL QUE SABE MANDA EL NÚMERO YA HECHO, y la
 * pantalla lo pinta. Lo que se ata aquí es eso, con el criterio del fichero: lo
 * cerrado antes que lo estático. Lo estático es la red para las dos cosas que no
 * se pueden ejecutar desde aquí —app/action.ts arrastra Next y Clerk, y
 * app/social.ts la base— y no demuestra nada por sí solo; lo dice también la
 * sección anterior y vale igual aquí.
 */
{
  seccion("Anuncio contra realidad: la tienda dice lo que el servidor reparte");

  /* ------------------------------------------------------------------ *
   * HERRAMIENTAS DE ESTA SECCIÓN
   * ------------------------------------------------------------------
   * `sinComentarios` es lo que separa mirar el CÓDIGO de mirar lo que alguien
   * escribió SOBRE el código, y aquí no es un detalle: app/action.ts explica en
   * un comentario la llamada sin era que causó el fallo ("openStandardPack
   * (allCards) a secas") y app/page.tsx hace lo mismo. Un grep las caza y cree
   * haber encontrado el fallo que ya está arreglado.
   *
   * Los saltos de línea de los comentarios SÍ se conservan: si no, el número de
   * línea del mensaje de fallo no sería el del fichero y habría que buscar a
   * mano justo lo que el mensaje promete.
   *
   * No se comparte con el escáner de SQL de la sección anterior porque hace
   * otra cosa: aquél extrae plantillas `…` y éste devuelve el fichero entero.
   */
  const ABRE_EXPRESION = /[([{,;:=!&|?+\-*%^~<>]$/;
  const PALABRA_EXPRESION = /\b(return|typeof|case|in|of|delete|void|instanceof|yield|await|do|else)$/;

  function sinComentarios(codigo) {
    let salida = "";
    const n = codigo.length;
    let i = 0;
    let previo = ""; // lo último que cuenta, para decidir si una barra abre regexp
    while (i < n) {
      const c = codigo[i];
      const d = codigo[i + 1];
      if (c === "/" && d === "/") {
        while (i < n && codigo[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && d === "*") {
        const desde = i;
        i += 2;
        while (i < n && !(codigo[i] === "*" && codigo[i + 1] === "/")) i++;
        i += 2;
        salida += codigo.slice(desde, i).replace(/[^\n]/g, "");
        continue;
      }
      if (c === "'" || c === '"') {
        const desde = i;
        i++;
        while (i < n && codigo[i] !== c) {
          if (codigo[i] === "\\") i++;
          i++;
        }
        i++;
        salida += codigo.slice(desde, i);
        previo = c;
        continue;
      }
      if (c === "`") {
        const desde = i;
        i++;
        let llaves = 0;
        while (i < n) {
          const x = codigo[i];
          if (x === "\\") { i += 2; continue; }
          if (x === "$" && codigo[i + 1] === "{") { llaves++; i += 2; continue; }
          if (llaves > 0 && x === "}") { llaves--; i++; continue; }
          if (llaves === 0 && x === "`") break;
          i++;
        }
        i++;
        salida += codigo.slice(desde, i);
        previo = "`";
        continue;
      }
      if (c === "/" && (previo === "" || ABRE_EXPRESION.test(previo) || PALABRA_EXPRESION.test(previo))) {
        const desde = i;
        i++;
        let clase = false;
        while (i < n) {
          const x = codigo[i];
          if (x === "\\") { i += 2; continue; }
          if (x === "\n") break;
          if (x === "[") clase = true;
          else if (x === "]") clase = false;
          else if (x === "/" && !clase) break;
          i++;
        }
        i++;
        salida += codigo.slice(desde, i);
        previo = "/";
        continue;
      }
      salida += c;
      if (!/\s/.test(c)) previo = (previo + c).slice(-12);
      i++;
    }
    return salida;
  }

  /* El cuerpo de una server action. Mismo corte que el `cuerpoDeFuncion` de la
   * sección anterior —de su declaración al siguiente `export`—, repetido porque
   * aquél vive dentro de su bloque y no se ve desde aquí. */
  function cuerpoDeAccion(codigo, nombre) {
    const m = new RegExp("^export\\s+async\\s+function\\s+" + nombre + "\\b", "m").exec(codigo);
    if (!m) return null;
    const resto = codigo.slice(m.index + m[0].length);
    const fin = /^export\s/m.exec(resto);
    return resto.slice(0, fin ? fin.index : resto.length);
  }

  /* Cuántos argumentos lleva cada llamada a `nombre(`. Se cuentan las comas de
   * PRIMER NIVEL saltando cadenas y paréntesis anidados: `f(a, g(b, c))` son
   * dos, no tres. Las definiciones no salen aquí, y es gratis: se escriben
   * `export const composicionDelSobre = (`, con el igual en medio. */
  function llamadasA(codigo, nombre) {
    const salida = [];
    const re = new RegExp("\\b" + nombre + "\\(", "g");
    let m;
    while ((m = re.exec(codigo))) {
      let i = m.index + m[0].length;
      let prof = 1;
      let comas = 0;
      let vacio = true;
      while (i < codigo.length && prof > 0) {
        const c = codigo[i];
        if (c === "'" || c === '"' || c === "`") {
          i++;
          while (i < codigo.length && codigo[i] !== c) {
            if (codigo[i] === "\\") i++;
            i++;
          }
          vacio = false;
          i++;
          continue;
        }
        if (c === "(" || c === "[" || c === "{") prof++;
        else if (c === ")" || c === "]" || c === "}") prof--;
        else if (c === "," && prof === 1) comas++;
        if (prof > 0 && !/\s/.test(c)) vacio = false;
        i++;
      }
      salida.push({ desde: m.index, argumentos: vacio ? 0 : comas + 1 });
    }
    return salida;
  }

  const DIRS_VIVOS = ["app", "services", "utils", "components", "hooks"];
  function ficherosVivos() {
    const salida = [];
    const anda = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".next") continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) anda(p);
        else if (/\.tsx?$/.test(e.name)) salida.push(p);
      }
    };
    for (const d of DIRS_VIVOS) anda(join(raiz, d));
    return salida.sort();
  }
  const nombreCorto = (f) => f.slice(raiz.length + 1).replace(/\\/g, "/");
  const codigoDe = (rel) => sinComentarios(readFileSync(join(raiz, rel), "utf8"));

  const ERAS = ["moderna", "media", "clasica"];

  /* ================================================================
   * A. EL SOBRE: SE ANUNCIA CON LA ERA CON LA QUE SE REPARTE
   * ================================================================
   *
   * EL FALLO, MEDIDO: app/page.tsx llamaba a `composicionDelSobre(cartas, tipo)`
   * sin el tercer argumento. La era no es un adorno: es la tabla del hueco de
   * premio del Premium, y son tres distintas (utils/packLogic.ts):
   *
   *     moderna  8 / 15 / 30 / 47      <- Escarlata y Púrpura, Mega Evolución
   *     media    5 / 10 / 25 / 60      <- lo que anunciaba la tienda SIEMPRE
   *     clasica  3 /  7 / 20 / 70      <- XY hacia atrás
   *
   * En una expansión moderna la tienda prometía un 5% de dorada y el servidor
   * repartía un 8%; en una clásica prometía 5% y repartía 3%.
   *
   * Y EL INVARIANTE DE MÁS ARRIBA NO LO VIO, porque compara el anuncio y el
   * reparto SIN ERA: los dos caen entonces en la tabla por defecto, coinciden, y
   * la comprobación se pone verde mirando justo el caso que no fallaba. Por eso
   * esto no sustituye a aquél, lo completa: aquél mide el reparto de siempre y
   * éste las tres eras.
   */

  {
    // Lo primero, el número de cartas, que es lo que promete la tarjeta: en las
    // TRES eras. La era puede cambiar QUÉ sale; cuántas salen lo decide el
    // calibrado, y el calibrado también mira la era.
    const generadores = {
      STANDARD: (c, era) => openStandardPack(c, era),
      PREMIUM: (c, era) => openPremiumPack(c, era),
      GOLDEN: (c) => openGoldenPack(c, []),
      SPECIAL: (c) => openGoldenPack(c, []),
    };
    const malos = [];
    for (const [setId, cartas] of CARTAS) {
      for (const era of ERAS) {
        for (const tipo of Object.keys(generadores)) {
          const anunciado = cartasDelSobre(cartas, tipo, era);
          const real = generadores[tipo](cartas, era).length;
          if (anunciado !== real) {
            malos.push(`${setId} ${tipo} (${era}): anuncia ${anunciado} y reparte ${real}`);
          }
        }
      }
    }
    comprueba(
      malos.length === 0,
      `el número de cartas anunciado es el repartido en las tres eras (${CARTAS.size} expansiones x 4 sobres x ${ERAS.length})`,
      malos.slice(0, 5).join("\n          ") +
        "\n          QUÉ TOCAR: `composicionDelSobre` y el generador del mismo tipo tienen" +
        " que calibrar con los MISMOS argumentos. Si uno recibe la era y el otro no, la" +
        " tarjeta promete diez cartas donde el sobre trae ocho.",
    );
  }

  /* EL PORCENTAJE ANUNCIADO ES EL QUE REPARTE, Y ESTO SÍ SE EJECUTA.
   *
   * Cómo se mide sin azar: `sacarPremio` hace `Math.random() * 100` y va
   * acumulando probabilidades, así que el sorteo es una PARTICIÓN del intervalo
   * [0,100). Se barre ese intervalo con 400 puntos fijos —nunca sobre un borde,
   * para que ningún redondeo decida por nosotros— y se cuenta en qué escalón cae
   * cada uno. Con las probabilidades declaradas, cada rama tiene que llevarse
   * EXACTAMENTE su parte de los 400: es una igualdad, no una estimación, y no
   * hace falta ni una tirada al azar.
   *
   * El catálogo es de mentira a propósito: UNA carta por escalón, así que la
   * carta que sale dice de qué pool salió sin tener que replicar el
   * clasificador de rarezas. Y se corre también con catálogos MUTILADOS, que es
   * donde vive la otra promesa de la tienda: cuando una expansión no tiene ese
   * escalón, el desplegable pinta "(no hay) → Ultra Rare", y eso es una
   * afirmación sobre a dónde cae de verdad el sobre.
   */
  {
    const POOLS = [
      ["common", "Common"],
      ["uncommon", "Uncommon"],
      ["rare", "Rare"],
      ["doubleRare", "Double Rare"],
      ["illustrationRare", "Illustration Rare"],
      ["ultraRare", "Ultra Rare"],
      ["specialIllustrationRare", "Special Illustration Rare"],
      ["hyperRare", "Hyper Rare"],
    ];
    const deMentira = ([pool, rarity]) => ({
      id: "pool-" + pool, name: pool, rarity, images: { small: "", large: "" },
    });
    const salvo = (...fuera) => POOLS.filter(([p]) => !fuera.includes(p)).map(deMentira);
    const CATALOGOS = [
      ["con todos los escalones", POOLS.map(deMentira)],
      ["sin Hyper Rare (la rama cae a Ultra)", salvo("hyperRare")],
      ["a la manera de Espada y Escudo (sin Ultra ni Illustration)", salvo("ultraRare", "illustrationRare")],
    ];
    const PASOS = 400;
    const ANCHO = 100 / PASOS;
    const malos = [];
    let ramas = 0;

    for (const [mote, catalogo] of CATALOGOS) {
      for (const era of ERAS) {
        for (const tipo of ["STANDARD", "PREMIUM"]) {
          const comp = composicionDelSobre(catalogo, tipo, era);
          // "todas" es el tercer respaldo de draw() —ni el escalón ni su
          // respaldo existen— y entonces sale cualquier carta del set: no hay
          // nada que predecir. Los tres catálogos están elegidos para no caer
          // ahí; si alguien los cambia, esto lo dice en vez de mentir.
          if (comp.premio.some((r) => r.real === "todas")) {
            malos.push(`${mote} · ${tipo}: alguna rama cae en "cualquier carta del set"`);
            continue;
          }
          // Varias ramas pueden caer en el MISMO escalón real (es justo lo que
          // pasa en los catálogos mutilados), así que se suman.
          const esperado = new Map();
          for (const r of comp.premio) {
            esperado.set(r.real, (esperado.get(r.real) ?? 0) + Math.round((r.prob / 100) * PASOS));
          }
          const cuenta = new Map();
          const azarDeVerdad = Math.random;
          try {
            for (let k = 0; k < PASOS; k++) {
              const punto = (k + 0.5) * ANCHO;
              Math.random = () => punto / 100;
              const sobre = tipo === "STANDARD"
                ? openStandardPack(catalogo, era)
                : openPremiumPack(catalogo, era);
              // El premio es SIEMPRE el último que se empuja (ver open*Pack).
              const pool = String(sobre[sobre.length - 1].id).slice("pool-".length);
              cuenta.set(pool, (cuenta.get(pool) ?? 0) + 1);
            }
          } finally {
            Math.random = azarDeVerdad;
          }
          ramas += comp.premio.length;
          for (const [pool, n] of esperado) {
            const visto = cuenta.get(pool) ?? 0;
            if (visto !== n) {
              malos.push(`${mote} · ${tipo} (${era}) ${pool}: anuncia ${n} de cada ${PASOS} y salen ${visto}`);
            }
          }
          for (const [pool, n] of cuenta) {
            if (!esperado.has(pool)) {
              malos.push(`${mote} · ${tipo} (${era}): ${n} de cada ${PASOS} premian ${pool}, que no se anuncia`);
            }
          }
        }
      }
    }
    comprueba(
      malos.length === 0,
      `el premio anunciado es el que sale, escalón a escalón y era por era (${ramas} ramas, ${PASOS} puntos del sorteo cada una)`,
      malos.slice(0, 5).join("\n          ") +
        "\n          QUÉ TOCAR: la tabla con la que se ANUNCIA y la tabla con la que se" +
        " SORTEA son la misma (PREMIO_*_POR_ERA de utils/packLogic.ts) y las dos las elige" +
        " el argumento `era`. Este fallo vuelve en cuanto uno de los dos lados deja de" +
        " pasarla: `composicionDelSobre(cartas, tipo)` anuncia la era por defecto y" +
        " `openPremiumPack(cartas, era)` reparte la de la expansión.",
    );
  }

  /* Y EL CASO PRUEBA ALGO. Si las tres eras repartieran igual —como hoy pasa en
   * el sobre ESTÁNDAR, a propósito y explicado en packLogic— el invariante de
   * arriba seguiría verde sin vigilar nada, porque olvidarse de la era no
   * cambiaría ningún número. Esto mide cuántas expansiones REALES anuncian otra
   * cosa si se olvida, que es el tamaño de lo que se está protegiendo. */
  {
    const serieDe = new Map(
      JSON.parse(readFileSync(join(raiz, "src", "data", "all-sets.json"), "utf8"))
        .map((s) => [s.id, s.series]),
    );
    const cambian = [];
    for (const [setId, cartas] of CARTAS) {
      const era = eraDeSerie(serieDe.get(setId));
      const conSuEra = JSON.stringify(composicionDelSobre(cartas, "PREMIUM", era).premio);
      const sinEra = JSON.stringify(composicionDelSobre(cartas, "PREMIUM").premio);
      if (conSuEra !== sinEra) cambian.push(`${setId} (${era})`);
    }
    comprueba(
      cambian.length > 0,
      `olvidarse de la era cambia lo que se anuncia en ${cambian.length} de las ${CARTAS.size} expansiones (${cambian.slice(0, 3).join(", ")}…)`,
      "ninguna expansión cambia de anuncio al pasarle su era, así que el invariante de" +
        " arriba ya no vigila nada: alguien ha igualado las tres tablas de" +
        " PREMIO_PREMIUM_POR_ERA. Si es a propósito, este invariante hay que rehacerlo" +
        " contra lo que se quiera vigilar ahora; taparlo deja el de arriba de adorno.",
    );
  }

  /* LA RED ESTÁTICA: NADIE ANUNCIA NI SORTEA SIN DECIR CON QUÉ ERA.
   *
   * Es la forma exacta que tenía el fallo —una llamada con un argumento de
   * menos— y es la que vuelve, porque el argumento es opcional y omitirlo
   * compila, pasa la revisión y no rompe ningún test. Vale para las dos
   * mitades: el que reparte, el que anuncia y también el que DECIDE SI SE VENDE
   * (`admiteSobre*` calibra contra el precio, y una era mejor sube el valor
   * esperado: midiendo con una era y repartiendo con otra, la tienda ofrecería
   * sobres que el calibrado ya había rechazado).
   */
  {
    const EXIGEN_ERA = {
      composicionDelSobre: 3,
      cartasDelSobre: 3,
      openStandardPack: 2,
      openPremiumPack: 2,
      admiteSobreEstandar: 2,
      admiteSobrePremium: 2,
      valorEsperadoEstandar: 2,
      valorEsperadoPremium: 2,
    };
    const malos = [];
    let llamadas = 0;
    for (const f of ficherosVivos()) {
      const codigo = sinComentarios(readFileSync(f, "utf8"));
      for (const [nombre, minimo] of Object.entries(EXIGEN_ERA)) {
        for (const ll of llamadasA(codigo, nombre)) {
          llamadas++;
          if (ll.argumentos < minimo) {
            const linea = codigo.slice(0, ll.desde).split("\n").length;
            malos.push(`${nombreCorto(f)}:${linea} → ${nombre} con ${ll.argumentos} argumento(s)`);
          }
        }
      }
    }
    comprueba(
      malos.length === 0 && llamadas >= 10,
      `ninguna pantalla anuncia ni sortea un sobre sin decir con qué era (${llamadas} llamadas en el árbol vivo)`,
      (malos.join("\n          ") || `sólo se han encontrado ${llamadas} llamadas: el escáner se ha quedado ciego`) +
        "\n          La era es un argumento OPCIONAL, así que omitirla compila y cae en la" +
        " era por defecto en silencio. QUÉ TOCAR: pasarle la era a esa llamada. Si es una" +
        " pantalla, la era tiene que ser la MISMA variable que usa el sorteo de esa misma" +
        " pantalla (app/page.tsx la llama `eraDelReparto` justo para eso); si es el" +
        " servidor, `eraDeSerie(ficha.series)`.",
    );
  }

  /* ================================================================
   * B. "VENDER POR X" ES LO QUE PAGA LA VENTA
   * ================================================================
   *
   * EL FALLO, MEDIDO: el botón de la vitrina decía "Vender por 488" y el
   * servidor abonaba 417. No era un redondeo: eran dos fórmulas distintas en dos
   * funciones distintas. La vitrina pintaba la TARIFA PLANA por el multiplicador
   * de la nota, y la venta cobraba la CURVA DE REPETIDAS por ese mismo
   * multiplicador. Con 2 copias coincidían —la curva aún no ha empezado a
   * bajar—, con 3 decía 488 y pagaba 417, y con 20 decía 488 y pagaba 123.
   *
   * Y LAS DOS CIFRAS HACEN FALTA, que es lo que hace que esto no se arregle
   * borrando una: la banda de precio del bazar y el coste de graduar se calculan
   * contra la tarifa PLANA a propósito (si dependieran de cuántas copias tiene
   * el vendedor, la misma carta valdría cosas distintas según quién la
   * publique). Lo que no se puede es prometer un pago con la que no paga.
   */

  const codigoAccion = codigoDe("app/action.ts");
  const { valorGraduado, MULTIPLICADOR_NOTA } = graduacion;
  const NOTAS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const RAREZAS_CON_PRECIO = Object.keys(SELL_PRICES);

  /* LAS DOS EXPRESIONES DEL SERVIDOR, REPLICADAS. Son las de
   * `valorDeVenderGraduada` y `valorDeReferenciaGraduada` (app/action.ts), que
   * no se pueden importar desde aquí. Es una réplica deliberada, como la de
   * `admiteOfertaAtada` o la de `repartoIngenuo`, y NO se queda vieja en
   * silencio: el invariante de más abajo saca la expresión del fichero y la
   * compara carácter a carácter con éstas. */
  const valorDeVenderGraduada = (rareza, copiasQueTengo, nota, euros) =>
    valorGraduado(valorDeVenta(rareza, copiasQueTengo, 1, euros), nota);
  const valorDeReferenciaGraduada = (rareza, nota, euros) =>
    valorGraduado(precioDeCartaSuelta(rareza, euros), nota);

  {
    // Los dos números no son intercambiables, y en qué dirección: el de
    // referencia NUNCA es menor, así que pintarlo donde se promete un pago es
    // prometer de más. Barrido completo de rarezas, notas y montones.
    const malos = [];
    let peor = 0;
    let peorCaso = "";
    for (const rareza of RAREZAS_CON_PRECIO) {
      for (const nota of NOTAS) {
        for (const copias of [1, 2, 3, 5, 10, 20, 50]) {
          const paga = valorDeVenderGraduada(rareza, copias, nota);
          const referencia = valorDeReferenciaGraduada(rareza, nota);
          if (paga > referencia) {
            malos.push(`${rareza} nota ${nota} x${copias}: paga ${paga} y la referencia es ${referencia}`);
          }
          // Con dos copias la curva todavía paga el 100%, así que las dos
          // cifras tienen que ser LA MISMA. Es lo que hacía que el fallo
          // pareciera un redondeo y no una fórmula distinta.
          if (copias === 2 && paga !== referencia) {
            malos.push(`${rareza} nota ${nota}: con 2 copias tenían que coincidir (${paga} y ${referencia})`);
          }
          if (copias > 1 && referencia - paga > peor) {
            peor = referencia - paga;
            peorCaso = `${rareza} nota ${nota} con ${copias} copias: la referencia dice ${referencia} y se cobran ${paga}`;
          }
        }
      }
    }
    comprueba(
      malos.length === 0 && peor > 0,
      `la tarifa de referencia y lo que se cobra se separan hasta ${peor} monedas (${peorCaso})`,
      malos.slice(0, 4).join("\n          ") +
        "\n          QUÉ TOCAR: `valorDeVentaAhora` es lo que abona la tienda y" +
        " `valorDeReferencia` la tarifa plana. Toda PROMESA DE PAGO (el botón, el" +
        " \"Vendida por\") pinta el primero; toda afirmación de cuánto vale (la banda del" +
        " bazar, el coste de graduar) el segundo. Si se separan al revés —la curva pagando" +
        " más que la tarifa— lo roto es la curva de utils/constanst.ts.",
    );
  }

  {
    /* EL BOTÓN ENSEÑA 0 EXACTAMENTE DONDE LA ACCIÓN SE NIEGA A PAGAR.
     *
     * `venderGraduadaAction` tiene dos negativas: "ultima-copia" (queda una
     * copia, y el álbum no se vacía) y "sin-valor" (el importe sale 0, que es lo
     * que pasa con un 1, que multiplica por cero). Las dos tienen que verse
     * ANTES de pulsar, y la única forma de que se vean es que el número del
     * botón sea 0 justo ahí: un botón que dice "Vender por 1" y contesta que no
     * se puede es el mismo fallo con otra cara. */
    const malos = [];
    for (const rareza of RAREZAS_CON_PRECIO) {
      for (const nota of NOTAS) {
        const ultima = valorDeVenderGraduada(rareza, 1, nota);
        if (ultima !== 0) malos.push(`${rareza} nota ${nota}: la última copia promete ${ultima} y la acción contesta "ultima-copia"`);
        if (MULTIPLICADOR_NOTA[nota] === 0) {
          const conNotaCero = valorDeVenderGraduada(rareza, 5, nota);
          if (conNotaCero !== 0) malos.push(`${rareza} nota ${nota}: multiplica por 0 y el botón promete ${conNotaCero}`);
        }
      }
    }
    comprueba(
      malos.length === 0,
      "el botón enseña 0 exactamente en los dos casos en que la venta se niega (última copia y nota sin valor)",
      malos.slice(0, 4).join("\n          ") +
        "\n          QUÉ TOCAR: `valorGraduado` tiene que poder valer 0 y `valorDeVenta`" +
        " tiene que devolver 0 con una sola copia. Un suelo de 1 en cualquiera de las dos" +
        " pone precio a un botón que el servidor va a rechazar.",
    );
  }

  {
    /* LA AMARRA DE LA RÉPLICA. Las dos expresiones de arriba son una copia a
     * mano de app/action.ts; en cuanto el servidor cambie una, la copia se queda
     * vieja y los dos invariantes anteriores seguirían en verde midiendo una
     * fórmula que ya no cobra nadie. Así que se saca del fichero la expresión de
     * verdad y se comparan sin espacios. */
    const expresionDe = (nombre) => {
      const m = new RegExp("function\\s+" + nombre + "\\b[\\s\\S]*?\\breturn\\s+([^;]+);").exec(codigoAccion);
      return m ? m[1].replace(/\s+/g, "") : null;
    };
    const replicaDe = (f) => String(f).slice(String(f).indexOf("=>") + 2).replace(/\s+/g, "");

    const servidorVende = expresionDe("valorDeVenderGraduada");
    const servidorReferencia = expresionDe("valorDeReferenciaGraduada");
    comprueba(
      servidorVende === replicaDe(valorDeVenderGraduada) &&
        servidorReferencia === replicaDe(valorDeReferenciaGraduada),
      "y las dos fórmulas replicadas aquí son, carácter a carácter, las del servidor",
      `servidor:  ${servidorVende ?? "(no se encuentra valorDeVenderGraduada)"}\n` +
        `          réplica:   ${replicaDe(valorDeVenderGraduada)}\n` +
        `          servidor:  ${servidorReferencia ?? "(no se encuentra valorDeReferenciaGraduada)"}\n` +
        `          réplica:   ${replicaDe(valorDeReferenciaGraduada)}\n` +
        "          QUÉ TOCAR: si la fórmula del servidor ha cambiado a propósito, hay que" +
        " traer el cambio a la réplica de scripts/test-invariantes.mjs — si no, los dos" +
        " invariantes de arriba se quedan midiendo una fórmula que ya no existe.",
    );
  }

  {
    /* Y QUE SIGAN SALIENDO DE UNA SOLA FUNCIÓN. Mientras el botón y el cobro
     * fueron dos expresiones copiadas, se separaron. Ahora cada número sale de
     * UNA función y la vigilancia es doble: que los cuatro sitios llamen a la
     * que les toca, y que `valorGraduado` —la pieza con la que se montan las
     * dos— no se llame desde ningún otro sitio de app/action.ts, que es como
     * nace la tercera copia. */
    const vitrina = cuerpoDeAccion(codigoAccion, "getVitrina");
    const venta = cuerpoDeAccion(codigoAccion, "venderGraduadaAction");
    const bazar = cuerpoDeAccion(codigoAccion, "publicarEnBazarAction");
    const graduables = cuerpoDeAccion(codigoAccion, "getCartasGraduables");

    const pegas = [];
    if (!vitrina) pegas.push("getVitrina ya no está en app/action.ts");
    if (!venta) pegas.push("venderGraduadaAction ya no está en app/action.ts");
    if (!bazar) pegas.push("publicarEnBazarAction ya no está en app/action.ts");
    if (!graduables) pegas.push("getCartasGraduables ya no está en app/action.ts");
    if (vitrina && !vitrina.includes("valorDeVenderGraduada(")) {
      pegas.push("getVitrina ya no pinta el botón con `valorDeVenderGraduada`");
    }
    if (venta && !venta.includes("valorDeVenderGraduada(")) {
      pegas.push("venderGraduadaAction ya no cobra con `valorDeVenderGraduada`");
    }
    if (vitrina && !vitrina.includes("valorDeReferenciaGraduada(")) {
      pegas.push("getVitrina ya no manda el valor de referencia que necesita la banda del bazar");
    }
    if (bazar && !bazar.includes("valorDeReferenciaGraduada(")) {
      pegas.push("publicarEnBazarAction ya no valida la banda contra el valor de referencia");
    }
    if (graduables && !graduables.includes("costeDeGraduar(valorDeReferencia)")) {
      pegas.push("el coste de graduar ha dejado de salir de la tarifa plana");
    }
    const sueltas = [...codigoAccion.matchAll(/\bvalorGraduado\(/g)].length;
    if (sueltas !== 2) {
      pegas.push(`valorGraduado se llama ${sueltas} veces en app/action.ts y tenían que ser 2 (las dos funciones compartidas)`);
    }

    comprueba(
      pegas.length === 0,
      "el botón y el cobro salen de la misma función, y la banda del bazar de la otra",
      pegas.join("\n          ") +
        "\n          QUÉ TOCAR: `valorDeVenderGraduada` la llaman getVitrina (para pintar) y" +
        " venderGraduadaAction (para cobrar); `valorDeReferenciaGraduada` la llaman" +
        " getVitrina (para la banda) y publicarEnBazarAction (para validarla). Escribir la" +
        " fórmula por tercera vez es exactamente como volvió el \"Vender por 488\" que" +
        " abonaba 417.",
    );
  }

  /* ================================================================
   * C. UNA RAREZA QUE EL JUEGO NO CONOCE NO COBRA COMO SI LA CONOCIERA
   * ================================================================
   *
   * EL FALLO, MEDIDO: los dos respaldos del mercado se contradecían.
   * `rangoDeRareza` mandaba lo desconocido al rango 1 —la banda de la morralla,
   * con las Comunes, precio de referencia 2— y `precioDeVenta` le ponía una
   * tarifa de 10. Como el pago es multiplicador × Σ precios y el multiplicador
   * se calcula contra el precio de referencia de la banda, la prima se
   * multiplicaba igual: una oferta que paga 72 entregando Comunes pagaba 361
   * entregando cartas de rareza desconocida.
   *
   * NO ES UN CASO DE LABORATORIO, y por eso las rarezas de la lista de abajo son
   * REALES: en los JSON del repositorio no hay ninguna —hay un invariante más
   * arriba que lo exige— pero la base de producción la llena el cron con 171
   * expansiones, y ahí viven 'Rare Holo LV.X', 'LEGEND', 'Rare Prime'… Ninguna
   * está en RARITY_RANK ni en SELL_PRICES, que se consultan por nombre EXACTO.
   * O sea que este invariante vigila algo que SÓLO pasa en producción, que es
   * justo lo que ningún test de los datos locales puede ver.
   */

  const RAREZAS_DE_LA_API = [
    "Rare Holo LV.X", "Rare Holo EX", "LEGEND", "Rare Prime", "Rare Holo GX",
    "Rare Holo Star", "Rare BREAK", "Rare ACE", "Shining Rare",
  ];

  comprueba(
    RAREZAS_DE_LA_API.every((r) => !(r in RARITY_RANK) && !(r in SELL_PRICES)),
    `las ${RAREZAS_DE_LA_API.length} rarezas de la API con las que se prueba esto siguen sin estar en las tablas`,
    "alguna ya tiene rango y precio: " +
      RAREZAS_DE_LA_API.filter((r) => r in RARITY_RANK || r in SELL_PRICES).join(", ") +
      ". Eso es una BUENA noticia (entra por la puerta buena y cobra lo que vale), pero" +
      " deja de servir para probar esto: hay que sacarla de la lista y poner otra que el" +
      " juego siga sin conocer.",
  );

  {
    /* NINGUNA CUMPLE NINGUNA BANDA, y se prueba con el catálogo REAL: se busca
     * una carta que SÍ cumple el requisito y se le cambia SOLO la rareza. Todo
     * lo demás —tipo, etapa, ilustrador, expansión, HP— se queda igual, así que
     * si deja de cumplir es por la rareza y por nada más. */
    const { cumpleFiltro, VARIANTES } = mercado;

    const catalogoEntero = [];
    for (const id of setIds) {
      const crudo = JSON.parse(readFileSync(join(DATA, id + ".json"), "utf8"));
      const lista = Array.isArray(crudo) ? crudo : crudo.data || [];
      for (const c of lista) {
        catalogoEntero.push({
          id: c.id, name: c.name, rarity: c.rarity || "Common", supertype: c.supertype,
          subtypes: c.subtypes ?? [], types: c.types ?? [], evolvesFrom: c.evolvesFrom,
          hp: c.hp, artist: c.artist,
          nationalPokedexNumbers: c.nationalPokedexNumbers ?? [], set: { id },
        });
      }
    }

    const malos = [];
    let probadas = 0;
    let conBanda = 0;
    for (const v of VARIANTES) {
      const filtro = { ...v.filtro };
      // Los requisitos de expansión llevan el set puesto al montar la oferta.
      if (filtro.categoria === "set") filtro.valor = setIds[0];
      if (filtro.rarMin !== undefined || filtro.rarMax !== undefined) conBanda++;
      const cumple = catalogoEntero.find((c) => cumpleFiltro(c, filtro));
      if (!cumple) continue;
      for (const rareza of RAREZAS_DE_LA_API) {
        probadas++;
        if (cumpleFiltro({ ...cumple, rarity: rareza }, filtro)) {
          malos.push(`${v.clave}: ${cumple.id} sigue cumpliendo con la rareza "${rareza}"`);
        }
      }
    }
    comprueba(
      malos.length === 0 && probadas > 100,
      `ninguna rareza desconocida cumple ningún requisito del tablón (${probadas} pruebas sobre ${VARIANTES.length} variantes, ${conBanda} con banda)`,
      malos.slice(0, 4).join("\n          ") +
        "\n          QUÉ TOCAR: la primera línea de la banda en `cumpleFiltro`" +
        " (utils/mercado.ts): `if (!rarezaConocida(carta)) return false`. Sin ella lo" +
        " desconocido cae al rango 1 por respaldo, entra en la banda de la morralla y" +
        " cobra la prima de la morralla con una tarifa que no es la de la morralla.",
    );
  }

  {
    /* LA SEGUNDA CERRADURA, que es la que aguanta si alguien escribe una
     * plantilla nueva SIN banda: aunque entre, cobra el suelo del rango en el
     * que se la coloca y no una tarifa inventada. Se compara con la tarifa de la
     * TIENDA a propósito: son dos respaldos distintos para dos preguntas
     * distintas, y separarlos fue exactamente el fallo. */
    const { precioDeVenta, rangoDeRareza, rarezaConocida } = mercado;
    const rango = rangoDeRareza({ id: "x-1", rarity: RAREZAS_DE_LA_API[0] });
    const delRango = Object.keys(RARITY_RANK).filter((r) => RARITY_RANK[r] === rango);
    const suelo = Math.min(...delRango.map((r) => precioDeVenta({ id: "y-1", rarity: r })));
    const enLaTienda = precioDeCartaSuelta(RAREZAS_DE_LA_API[0]);

    const malos = [];
    for (const rareza of RAREZAS_DE_LA_API) {
      const carta = { id: "z-1", rarity: rareza };
      if (rarezaConocida(carta)) malos.push(`${rareza} se da por conocida`);
      const precio = precioDeVenta(carta);
      if (!(precio <= suelo)) malos.push(`${rareza} cobra ${precio} y el suelo del rango ${rango} es ${suelo}`);
    }
    comprueba(
      malos.length === 0,
      `en el mercado una rareza desconocida cobra el suelo de su banda (${suelo}), no el respaldo de la tienda (${enLaTienda}, que es x${(enLaTienda / suelo).toFixed(0)})`,
      malos.join("\n          ") +
        "\n          QUÉ TOCAR: `PRECIO_RAREZA_DESCONOCIDA` (utils/mercado.ts) se DERIVA de" +
        " las tablas —el mínimo de las rarezas que comparten el rango de respaldo— justo" +
        " para que no se pueda volver a separar del rango. Escribirlo a mano es como" +
        " empezó esto. Y ojo con bajarlo por debajo del suelo: el reparto del lote entrega" +
        " lo más barato primero (utils/repartoMercado.ts), así que una tarifa de saldo" +
        " haría que el juego propusiera regalar una LEGEND.",
    );
  }

  {
    /* Y LA TRAMPA DEL `in`. RARITY_RANK y SELL_PRICES son objetos literales: una
     * carta con rareza "constructor" o "toString" pasa un `in` por la cadena de
     * prototipos y entra con un "rango" que ni siquiera es un número. No hace
     * falta que exista esa carta para que importe: lo que se afirma aquí es que
     * la pregunta se hace bien, y hacerla con `in` costaba una comparación con
     * `undefined` que siempre sale a favor de quien la trae. */
    const { precioDeVenta, rarezaConocida, cumpleFiltro } = mercado;
    const suelo = Math.min(...Object.values(SELL_PRICES));
    const malos = [];
    for (const nombre of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      const carta = { id: "t-1", rarity: nombre, types: ["Fire"] };
      if (rarezaConocida(carta)) malos.push(`"${nombre}" pasa por rareza conocida`);
      const precio = precioDeVenta(carta);
      if (typeof precio !== "number" || !Number.isFinite(precio) || precio > suelo) {
        malos.push(`"${nombre}" cobra ${JSON.stringify(precio)}`);
      }
      if (cumpleFiltro(carta, { categoria: "tipo", valor: "Fire", rarMin: 1, rarMax: 5 })) {
        malos.push(`"${nombre}" cumple una banda`);
      }
    }
    comprueba(
      malos.length === 0,
      "una rareza que se llama como un método de Object no se cuela por la cadena de prototipos",
      malos.join("\n          ") +
        "\n          QUÉ TOCAR: `rarezaConocida` tiene que preguntar" +
        ' `typeof RARITY_RANK[...] === "number"`, no `in`.',
    );
  }

  /* ================================================================
   * D. LA GRADUACIÓN OFRECE LAS COPIAS QUE LUEGO ADMITE
   * ================================================================
   *
   * EL FALLO, REPRODUCIDO: el bucle que elige índices de copia tenía tope
   * `copia <= cantidad`. Y cada graduada VENDIDA se come un índice de ese rango
   * —su fila conserva el índice para siempre, porque el índice ES la nota, pero
   * `quantity` baja—, así que con 3 copias: gradúas la 1 y la vendes, gradúas la
   * 2 y la vendes, y te quedas con 1 copia libre, los índices {1,2} ocupados y
   * el rango mirando sólo {1}. La pantalla ofrecía esa copia —cuenta
   * `quantity - activas`, y una vendida no es activa— y la acción contestaba
   * "nada-que-graduar". Sin salida: ni graduando ni vendiendo se recupera un
   * índice, porque no se recupera NUNCA ninguno.
   *
   * LAS DOS COSAS QUE HAY QUE SOSTENER A LA VEZ, y son las que se atan aquí:
   *   (1) lo que la pantalla OFRECE es lo que la acción SIRVE;
   *   (2) ningún índice se reutiliza jamás, porque reutilizarlo repite la nota
   *       (la sección anterior mide lo que costaría: un 10 reimprimible).
   * La tentación de arreglar (1) es tocar (2), y por eso van juntas.
   *
   * SE REPLICAN DOS COSAS, y las dos a propósito: el reparto de índices (un
   * bucle dentro de graduarCartasAction, que no se puede importar) y el corte
   * del CTE `posibles` —`c.puesto <= b.quantity - activas`—, que es quien decide
   * de verdad cuántas entran. La mitad que no se puede replicar —que la fila
   * vendida siga ocupando su hueco en la base— la vigila el invariante estático
   * de la FUGA 1 de la sección anterior.
   */
  {
    const { notaDeCopia, semillaDeCopia } = graduacion;
    const SECRETO = "secreto-de-prueba-para-los-invariantes";
    const CARTA = "sv8-32";

    // El reparto de índices de hoy: se sube por los enteros saltando los
    // ocupados hasta reunir los que se piden.
    const indicesLibres = (tomadas, quiere) => {
      const salida = [];
      const tope = tomadas.size + quiere;
      for (let copia = 1; copia <= tope && salida.length < quiere; copia++) {
        if (tomadas.has(copia)) continue;
        salida.push(copia);
      }
      return salida;
    };
    // El de antes, con su tope `copia <= cantidad`. Está aquí por lo mismo que
    // `repartoIngenuo` en la sección del mercado: sin él, un caso que el bucle
    // viejo TAMBIÉN resolvía no vigilaría nada.
    const indicesAlaVieja = (tomadas, quiere, cantidad) => {
      const salida = [];
      for (let copia = 1; copia <= cantidad && salida.length < quiere; copia++) {
        if (tomadas.has(copia)) continue;
        salida.push(copia);
      }
      return salida;
    };
    // El corte del CTE `posibles`: de las candidatas entran las que quepan en el
    // RECUENTO, no en el índice.
    const lasQueEntran = (candidatas, cantidad, activas) =>
      candidatas.slice(0, Math.max(0, cantidad - activas));

    const malos = [];
    let estados = 0;
    let atascados = 0;
    // Barrido exhaustivo del estado de un montón: `graduadas` copias graduadas
    // alguna vez (índices 1..graduadas, que es lo que reparte el bucle),
    // `vendidas` de ellas ya vendidas, y `cantidad` copias en propiedad ahora.
    for (let graduadas = 0; graduadas <= 8; graduadas++) {
      for (let vendidas = 0; vendidas <= graduadas; vendidas++) {
        const activas = graduadas - vendidas;
        for (let cantidad = Math.max(1, activas); cantidad <= 8; cantidad++) {
          const libres = cantidad - activas; // lo que anuncia getCartasGraduables
          if (libres <= 0) continue;
          estados++;
          const tomadas = new Set(Array.from({ length: graduadas }, (_, i) => i + 1));
          const mote = `${cantidad} copias, ${activas} en vitrina, ${vendidas} vendidas`;

          const candidatas = indicesLibres(tomadas, libres);
          if (candidatas.length !== libres) malos.push(`${mote}: se ofrecen ${libres} y el bucle propone ${candidatas.length}`);
          if (candidatas.some((i) => tomadas.has(i))) malos.push(`${mote}: propone un índice ya usado`);
          if (new Set(candidatas).size !== candidatas.length) malos.push(`${mote}: repite un índice dentro de la misma tanda`);
          if (lasQueEntran(candidatas, cantidad, activas).length !== libres) {
            malos.push(`${mote}: se ofrecen ${libres} y entran ${lasQueEntran(candidatas, cantidad, activas).length}`);
          }
          // Y pedir de más no gradúa de más: quien corta es el recuento de la
          // base, no el bucle que propone.
          const pidiendoDeMas = lasQueEntran(indicesLibres(tomadas, libres + 3), cantidad, activas);
          if (pidiendoDeMas.length !== libres) {
            malos.push(`${mote}: pidiendo ${libres + 3} entran ${pidiendoDeMas.length} y sólo caben ${libres}`);
          }

          if (lasQueEntran(indicesAlaVieja(tomadas, libres, cantidad), cantidad, activas).length < libres) atascados++;
        }
      }
    }
    comprueba(
      malos.length === 0,
      `la graduación sirve exactamente las copias que la pantalla ofrece (${estados} estados de un montón)`,
      malos.slice(0, 4).join("\n          ") +
        "\n          Las dos cuentas tienen que ser la MISMA: `getCartasGraduables` anuncia" +
        " `quantity - graduadas activas` y el CTE `posibles` corta por" +
        " `c.puesto <= b.quantity - activas`. QUÉ TOCAR: el bucle de índices de" +
        " `graduarCartasAction` propone candidatas y nada más; si sirve de menos, es que le" +
        " han vuelto a poner un tope que cuenta POSICIONES en vez de saltar ocupados.",
    );

    {
      // El caso literal, para que el número esté escrito: tres copias, dos
      // graduadas y vendidas, una copia libre y ningún índice recuperable.
      const tomadas = new Set([1, 2]);
      const hoy = indicesLibres(tomadas, 1);
      const antes = indicesAlaVieja(tomadas, 1, 1);
      comprueba(
        hoy.length === 1 && hoy[0] === 3 && antes.length === 0 && atascados > 0,
        `y el caso prueba algo: con los índices {1,2} vendidos y 1 copia libre hoy sale el índice ${hoy[0]} y con el tope viejo no salía ninguno (${atascados} de ${estados} estados servían de menos)`,
        `hoy propone ${hoy.join(",") || "(nada)"} y el bucle viejo ${antes.join(",") || "(nada)"}, y se atascaban ${atascados}.` +
          " Si el bucle viejo resolviera lo mismo que el nuevo, el invariante de arriba no" +
          " estaría vigilando nada y habría que rehacerlo.",
      );
    }

    {
      /* LA VIDA ENTERA DE UN MONTÓN, con sus ventas y sus copias nuevas: 300
       * vueltas de graduar y vender. Lo que se mira es que ningún índice vuelva
       * JAMÁS —porque volvería con su nota— y que la nota de cada índice siga
       * siendo la suya al final del recorrido. */
      const notaDe = new Map();
      let repetidos = 0;
      let cantidad = 3;
      const tomadas = new Set();
      const activas = new Set();
      for (let vuelta = 0; vuelta < 300; vuelta++) {
        const libres = cantidad - activas.size;
        if (libres > 0) {
          for (const i of indicesLibres(tomadas, Math.min(libres, 2))) {
            if (notaDe.has(i)) repetidos++;
            else notaDe.set(i, notaDeCopia(semillaDeCopia("u", CARTA, i, SECRETO)));
            tomadas.add(i);
            activas.add(i);
          }
        }
        // Vende la graduada más baja (su fila conserva el índice) y de vez en
        // cuando consigue otra copia.
        const laMasBaja = [...activas].sort((a, b) => a - b)[0];
        if (laMasBaja !== undefined) {
          activas.delete(laMasBaja);
          cantidad--;
        }
        if (vuelta % 2 === 0) cantidad++;
        if (cantidad < 1) cantidad = 1;
      }
      let cambiadas = 0;
      for (const [i, nota] of notaDe) {
        if (notaDeCopia(semillaDeCopia("u", CARTA, i, SECRETO)) !== nota) cambiadas++;
      }
      comprueba(
        repetidos === 0 && cambiadas === 0 && notaDe.size > 50,
        `en 300 vueltas de graduar y vender no se repite ni un índice (${notaDe.size} índices, ${new Set(notaDe.values()).size} notas distintas)`,
        `${repetidos} índices repetidos y ${cambiadas} notas cambiadas.` +
          " Un índice que vuelve es una nota que vuelve: la semilla es" +
          " secreto|usuario|carta|índice. QUÉ TOCAR: `ocupadas` se llena con TODAS las filas" +
          " de graded_cards de esa carta, sin filtrar por estado — una fila 'vendida' sigue" +
          " ocupando su hueco, y por eso no se borra nunca.",
      );
    }
  }

  /* ================================================================
   * E. LO QUE SÓLO SE PUEDE MIRAR EN EL CÓDIGO
   * ================================================================
   *
   * Las dos últimas promesas de este grupo viven en sitios que desde aquí no se
   * pueden ejecutar: app/social.ts habla con la base en cada función y
   * app/seed-database/route.ts es una ruta de Next. Así que esto es forma, con
   * la misma advertencia que la sección anterior: un invariante estático no
   * demuestra nada, sólo impide que la forma de la que depende el razonamiento
   * desaparezca en una limpieza.
   */

  {
    /* UN ID DE CARTA ES EL MISMO EN TODO EL REPOSITORIO. `app/social.ts` valida
     * los ids de un trueque con una copia literal de la expresión de
     * `app/action.ts` (no puede importarla: action.ts es "use server" y no
     * exporta constantes). Dos copias de una regla se separan, y separadas
     * significan que el trueque acepta ids que el mercado rechaza o al revés:
     * una oferta que se crea y no se puede aceptar nunca. */
    const deFichero = (rel) => {
      const m = /const\s+ID_CARTA\s*=\s*(\/.*?\/[a-z]*)\s*;/.exec(codigoDe(rel));
      return m ? m[1] : null;
    };
    const enAccion = deFichero("app/action.ts");
    const enSocial = deFichero("app/social.ts");
    comprueba(
      enAccion !== null && enAccion === enSocial,
      `el trueque acepta exactamente los ids de carta que aceptan el mercado y el bazar (${enAccion ?? "?"})`,
      `app/action.ts: ${enAccion ?? "(no se encuentra ID_CARTA)"}\n` +
        `          app/social.ts: ${enSocial ?? "(no se encuentra ID_CARTA)"}\n` +
        "          QUÉ TOCAR: las dos son la misma regla escrita dos veces, y esto existe" +
        " para que no se separen. Si hace falta cambiarla, se cambian las dos; si alguien" +
        " la mueve a utils/, este invariante sobra y se quita con ella.",
    );
  }

  {
    /* LA PUERTA DEL TRUEQUE SE CIERRA ANTES DE TOCAR LA BASE. `createTradeOffer`
     * es una server action: la firma la escribe TypeScript para el compilador,
     * pero al otro lado hay HTTP y ahí cabe cualquier cosa. El agujero concreto
     * era de ORDEN: se miraba `offeredIds.length` antes de saber si era un
     * array, y una cadena tiene `.length` — "x" pasaba el guard, se guardaba, y
     * la fila corrupta cegaba la bandeja del destinatario ENTERA. */
    const cuerpo = cuerpoDeAccion(codigoDe("app/social.ts"), "createTradeOffer");
    const pegas = [];
    if (!cuerpo) {
      pegas.push("createTradeOffer ya no está en app/social.ts (¿se ha renombrado?)");
    } else {
      for (const lista of ["offeredIds", "requestedIds"]) {
        const esArray = cuerpo.indexOf(`Array.isArray(${lista})`);
        const mideLargo = cuerpo.indexOf(`${lista}.length`);
        if (esArray < 0) pegas.push(`no se comprueba Array.isArray(${lista})`);
        else if (mideLargo >= 0 && esArray > mideLargo) {
          pegas.push(`se mira ${lista}.length antes de saber si es un array: una cadena lo pasa`);
        }
      }
      if (!/ID_CARTA\.test\(/.test(cuerpo)) pegas.push("los ids ya no se validan uno a uno");
      if (!/MAX_CARTAS_POR_LADO/.test(cuerpo)) pegas.push("no queda tope de cartas por lado");
      if (!/MAX_MENSAJE/.test(cuerpo)) pegas.push("el mensaje ha vuelto a quedarse sin tope");
    }
    comprueba(
      pegas.length === 0,
      "la oferta de trueque se valida entera antes de escribir una fila",
      pegas.join("\n          ") +
        "\n          QUÉ TOCAR: el orden de los guards de `createTradeOffer`. `Array.isArray`" +
        " va ANTES de `.length` —ése fue el agujero— y los ids, el tope por lado y el tope" +
        " del mensaje van todos antes del primer sql`…`. Una fila corrupta en trade_offers" +
        " no es un error que se ve: es una bandeja de entrada que desaparece.",
    );
  }

  {
    /* LA SIEMBRA ESCRIBE LAS MISMAS COLUMNAS QUE LA INGESTA, y la única forma de
     * garantizarlo es que no tenga una lista propia. La tuvo: escribía 14 de las
     * 28 columnas de `cards` y tiraba `supertype` y `subtypes`, que los 6.779
     * JSON locales SÍ traen. Eso no era cosmético — los requisitos del mercado
     * por supertipo, etapa y evolución no casaban con NINGUNA carta, o sea
     * ofertas imposibles de cumplir, que es justo lo que otro invariante de este
     * fichero da por sentado. */
    const codigo = codigoDe("app/seed-database/route.ts");
    const pegas = [];
    if (!/upsertCards\s*\(/.test(codigo)) pegas.push("la siembra ya no escribe las cartas con `upsertCards`");
    if (!/upsertSets\s*\(/.test(codigo)) pegas.push("la siembra ya no escribe las fichas con `upsertSets`");
    const propias = [...codigo.matchAll(/INSERT\s+INTO\s+(cards|sets)\b/gi)].map((m) => m[1]);
    if (propias.length > 0) pegas.push(`la siembra tiene ${propias.length} INSERT propio(s) sobre ${[...new Set(propias)].join(" y ")}`);
    comprueba(
      pegas.length === 0,
      "la siembra escribe por la ingesta, así que escribe sus mismas columnas",
      pegas.join("\n          ") +
        "\n          QUÉ TOCAR: app/seed-database/route.ts tiene que seguir escribiendo por" +
        " `upsertCards`/`upsertSets` (services/ingest.ts). Una segunda lista de columnas es" +
        " una lista que se queda atrás: la anterior perdió 14 y nadie lo vio hasta que el" +
        " mercado empezó a repartir ofertas imposibles.",
    );
  }

  {
    /* Y LA PREMISA DE LA QUE DEPENDE ESA REUTILIZACIÓN: `valoresCarta` lee
     * `c.set?.id`, y los JSON locales NO traen el campo `set`. Sin inyectarlo,
     * reutilizar la ingesta escribiría `set_id` NULL en TODO el catálogo —peor
     * que la lista corta que había—, así que el `set: { id: setId }` de la ruta
     * no es un adorno: es la condición para que lo de arriba funcione. */
    let conSet = 0;
    let total = 0;
    for (const id of setIds) {
      const crudo = JSON.parse(readFileSync(join(DATA, id + ".json"), "utf8"));
      const lista = Array.isArray(crudo) ? crudo : crudo.data || [];
      for (const c of lista) {
        total++;
        if (c?.set?.id) conSet++;
      }
    }
    const inyecta = /set:\s*\{\s*id:/.test(codigoDe("app/seed-database/route.ts"));
    comprueba(
      conSet === 0 && inyecta,
      `los JSON locales no traen expansión (${conSet} de ${total} cartas) y la siembra se la pone`,
      (conSet > 0
        ? `${conSet} de ${total} cartas SÍ traen \`set\`: la inyección ya no es imprescindible, pero tampoco estorba.`
        : "la ruta ya no inyecta `set: { id: setId }`.") +
        " QUÉ TOCAR: `valoresCarta` (services/ingest.ts) lee `c.set?.id`, así que sin esa" +
        " inyección la siembra deja `set_id` NULL en las 6.779 cartas y ninguna aparece en" +
        " su expansión.",
    );
  }

  /* ================================================================
   * G. LA COLECCIÓN ENSEÑA LO QUE LA VENTA PAGA
   * ================================================================
   *
   * EL FALLO, MEDIDO: el botón "Vender +X" de la colección llamaba a
   * `valorDeVenta(rareza, copias, 1)` SIN el cuarto argumento —el precio real de
   * Cardmarket—, porque `getFullCollection` no devolvía ningún dato de euros. El
   * servidor sí lo aplica (`euroDeCarta` en las tres rutas de venta). Con una
   * Hyper Rare y 3 copias: sin precio conocido decía 214 y pagaba 214; con la
   * carta a 50 € decía 214 y abonaba 225; con 200 €, decía 214 y abonaba 257.
   *
   * ES EL MISMO FALLO QUE LA SECCIÓN B, con otra cara: dos cuentas del dinero en
   * dos sitios, una en la pantalla y otra en quien cobra. Allí eran dos fórmulas
   * distintas; aquí es la misma fórmula con un argumento de menos, que es la
   * variante que compila, pasa la revisión y no rompe ningún test.
   *
   * LA FORMA DEL ARREGLO, Y POR QUÉ SE VIGILA ASÍ: `getFullCollection` manda los
   * IMPORTES ya hechos —no `precioEur` en crudo, que sería la fórmula escrita
   * dos veces otra vez— y la pantalla los pinta. Así que hay tres cosas que
   * comprobar y las tres están abajo, en un solo invariante porque son una sola
   * promesa: que los números cuadren con los de las tres rutas de venta, que la
   * réplica de aquí siga siendo la del servidor, y que nadie haya vuelto a
   * calcular el dinero en la pantalla.
   */
  {
    seccion("Colección: lo que enseña el botón es lo que paga la venta");

    /* El cuerpo LITERAL de una función, con sus llaves, emparejándolas. Hace
     * falta uno propio y no el `cuerpoDeAccion` de más arriba: aquél corta hasta
     * el siguiente `export` de la primera columna, y estas funciones viven en la
     * mitad indentada de app/action.ts con funciones sueltas (`euroDeCarta`,
     * `copiasGraduadas`) entre medias — el recorte se comería justo el
     * `preciosEnEuros([cardId])` de otra función y daría por buena una
     * colección que ya no pide precios. */
    function cuerpoLiteral(codigo, nombre) {
      const m = new RegExp("function\\s+" + nombre + "\\s*\\(").exec(codigo);
      if (!m) return null;
      let i = m.index + m[0].length;
      let prof = 1;
      while (i < codigo.length && prof > 0) {
        if (codigo[i] === "(") prof++;
        else if (codigo[i] === ")") prof--;
        i++;
      }
      const abre = codigo.indexOf("{", i);
      if (abre < 0) return null;
      let j = abre;
      prof = 0;
      do {
        if (codigo[j] === "{") prof++;
        else if (codigo[j] === "}") prof--;
        j++;
      } while (j < codigo.length && prof > 0);
      return { texto: codigo.slice(abre, j), desde: abre, hasta: j };
    }

    /* LA RÉPLICA DE LO QUE MANDA EL SERVIDOR. Es `valoresDeVentaDelMonton` de
     * app/action.ts, que este cargador no puede importar (app/action.ts arrastra
     * Clerk y Next). SIN COMENTARIOS DENTRO a propósito: la amarra de más abajo
     * compara este cuerpo con el del fichero carácter a carácter, y el del
     * fichero llega ya sin comentarios. */
    const valoresDeVentaDelMonton = (rareza, copiasQueTengo, graduadas, euros) => {
      const repetidasLibres = Math.max(0, copiasQueTengo - graduadas - 1);
      return {
        valorDeVentaAhora: valorDeVenta(rareza, copiasQueTengo, Math.min(1, repetidasLibres), euros),
        valorDeVentaRepetidas: valorDeVenta(rareza, copiasQueTengo, repetidasLibres, euros),
      };
    };

    /* LAS TRES RUTAS DE VENTA, REPLICADAS DESDE SU PROPIO CÓDIGO. Cada una
     * decide con sus palabras cuántas copias vende y cuándo se niega, y las tres
     * tienen que acabar en el mismo número que enseña la colección:
     *
     *   · sellCardAction        vendibles = quantity - graduadas; si <= 1
     *                           devuelve null (0 monedas), si no cobra UNA copia.
     *   · sellAllDuplicatesAction  duplicates = vendibles - 1; si <= 0 contesta
     *                           "No tienes duplicados", si no cobra esas copias.
     *   · sellAllDuplicatesBulkAction  selecciona quantity > 1 + graduadas y
     *                           cobra quantity - 1 - graduadas por carta.
     */
    const pagaVenderUna = (rareza, copias, graduadas, eur) =>
      copias - graduadas <= 1 ? 0 : valorDeVenta(rareza, copias, 1, eur);
    const pagaVenderRepetidas = (rareza, copias, graduadas, eur) =>
      copias - graduadas - 1 <= 0 ? 0 : valorDeVenta(rareza, copias, copias - graduadas - 1, eur);
    const pagaElLote = (rareza, copias, graduadas, eur) =>
      copias > 1 + graduadas ? valorDeVenta(rareza, copias, copias - 1 - graduadas, eur) : 0;

    const RAREZAS_DE_LA_TIENDA = Object.keys(SELL_PRICES);
    const MONTONES = [1, 2, 3, 4, 5, 7, 8, 12, 20, 43, 50, 120];
    const GRADUADAS = [0, 1, 2, 5];
    /* Precios reales del catálogo, de la carta de céntimos a la más cara medida
     * (271 €, +27%). El `undefined` es el caso NORMAL —179 de 252 cartas de sv08
     * no llegan al euro y la inmensa mayoría no ha pasado nunca por el cron— y
     * es justo el que hacía que el fallo pareciera inexistente: sin euro las dos
     * cuentas coinciden y el botón parece honrado. */
    const EUROS = [undefined, 0.15, 1, 5, 20, 50, 120, 200, 271];

    const malos = [];
    let combinaciones = 0;
    /* El desvío se mide en MONEDAS y no en porcentaje: sobre una Common de 1
     * moneda cualquier redondeo es un 100% y no dice nada, mientras que las
     * monedas dicen exactamente cuánto se estaba prometiendo de menos. */
    let peorMonedas = 0;
    let peorCaso = "";

    for (const rareza of RAREZAS_DE_LA_TIENDA) {
      for (const copias of MONTONES) {
        for (const graduadas of GRADUADAS) {
          if (graduadas > copias) continue;
          for (const eur of EUROS) {
            combinaciones++;
            const enseña = valoresDeVentaDelMonton(rareza, copias, graduadas, eur);
            const una = pagaVenderUna(rareza, copias, graduadas, eur);
            const todas = pagaVenderRepetidas(rareza, copias, graduadas, eur);
            const lote = pagaElLote(rareza, copias, graduadas, eur);
            const caso = `${rareza} x${copias} (${graduadas} graduadas, ${eur ?? "sin"} €)`;
            if (enseña.valorDeVentaAhora !== una) {
              malos.push(`${caso}: el botón dice ${enseña.valorDeVentaAhora} y sellCardAction abona ${una}`);
            }
            if (enseña.valorDeVentaRepetidas !== todas) {
              malos.push(`${caso}: "vender repetidas" dice ${enseña.valorDeVentaRepetidas} y sellAllDuplicatesAction abona ${todas}`);
            }
            /* El total de la hoja de "Limpiar duplicados" es la SUMA de estos
             * sumandos, así que cuadra con el lote si y sólo si cuadra carta a
             * carta. Las favoritas y las cartas sin repetidas no entran en la
             * suma, y tampoco en el SELECT del servidor: mismo filtro. */
            if (todas !== lote) {
              malos.push(`${caso}: la venta de una carta abona ${todas} y el lote ${lote} por las mismas copias`);
            }
            // Y cuánto se dejaba en el camino el botón sin el cuarto argumento.
            const sinEuro = valoresDeVentaDelMonton(rareza, copias, graduadas).valorDeVentaRepetidas;
            const desvio = enseña.valorDeVentaRepetidas - sinEuro;
            if (eur && sinEuro > 0 && desvio > peorMonedas) {
              peorMonedas = desvio;
              const porcentaje = ((desvio / sinEuro) * 100).toFixed(0);
              peorCaso = `${caso}: enseñaría ${sinEuro} y la tienda abona ${enseña.valorDeVentaRepetidas}, +${porcentaje}%`;
            }
          }
        }
      }
    }

    /* LA AMARRA DE LA RÉPLICA, igual que en la sección B: en cuanto el servidor
     * cambie la fórmula, la copia de aquí arriba se queda vieja y el barrido
     * seguiría en verde midiendo un dinero que ya no paga nadie. */
    const codigoColeccion = codigoDe("app/action.ts");
    const enElServidor = cuerpoLiteral(codigoColeccion, "valoresDeVentaDelMonton");
    const replica = String(valoresDeVentaDelMonton);
    const sinEspacios = (s) => String(s).replace(/\s+/g, "");
    const cuerpoReplica = sinEspacios(replica.slice(replica.indexOf("{")));
    const cuerpoServidor = enElServidor ? sinEspacios(enElServidor.texto) : null;
    if (cuerpoServidor !== cuerpoReplica) {
      malos.push(
        "la réplica ya no es la del servidor\n          servidor: " +
          (cuerpoServidor ?? "(no se encuentra valoresDeVentaDelMonton en app/action.ts)") +
          "\n          réplica:  " +
          cuerpoReplica,
      );
    }

    /* LA RED ESTÁTICA. El barrido de arriba mide fórmulas; esto mide que sigan
     * conectadas, que es la mitad por la que el fallo entró: la fórmula estaba
     * bien y lo que faltaba era el DATO. */
    const coleccion = cuerpoLiteral(codigoColeccion, "getFullCollection");
    const ventaDeUna = cuerpoLiteral(codigoColeccion, "sellCardAction");
    if (!coleccion) malos.push("getFullCollection ya no está en app/action.ts");
    if (!ventaDeUna) malos.push("sellCardAction ya no está en app/action.ts");
    if (coleccion && !coleccion.texto.includes("preciosEnEuros(")) {
      malos.push("getFullCollection ya no pide los precios reales: es EXACTAMENTE el fallo, la fórmula sin el dato");
    }
    if (coleccion && !coleccion.texto.includes("valoresDeVentaDelMonton(")) {
      malos.push("getFullCollection ya no manda los importes de venta calculados");
    }
    if (coleccion && !coleccion.texto.includes("precioDeCartaSuelta(")) {
      malos.push("getFullCollection ya no manda `valorDeReferencia`, que es la casilla \"Valor de la carta\"");
    }
    if (coleccion && coleccion.texto.includes("precioEur")) {
      malos.push("getFullCollection manda `precioEur` en crudo: eso devuelve la fórmula a la pantalla");
    }
    if (ventaDeUna && !ventaDeUna.texto.includes("valoresDeVentaDelMonton(")) {
      malos.push("sellCardAction ya no devuelve los importes del montón que queda: tras vender una copia el botón se queda con el precio viejo");
    }

    /* Y QUE LA PANTALLA NO VUELVA A CALCULAR EL DINERO. En la colección sólo
     * puede quedar `valorDeVenta` dentro de los dos respaldos del modo invitado;
     * cualquier otra llamada es la cuenta de la pantalla volviendo. */
    const codigoPantalla = codigoDe("app/collection/page.tsx");
    const respaldos = ["ventaDeUnaCopia", "ventaDeRepetidas"]
      .map((n) => cuerpoLiteral(codigoPantalla, n))
      .filter(Boolean);
    if (respaldos.length !== 2) {
      malos.push("app/collection/page.tsx ya no tiene los dos respaldos (`ventaDeUnaCopia` y `ventaDeRepetidas`)");
    }
    let llamadasEnLaPantalla = 0;
    for (const ll of llamadasA(codigoPantalla, "valorDeVenta")) {
      llamadasEnLaPantalla++;
      if (!respaldos.some((r) => ll.desde > r.desde && ll.desde < r.hasta)) {
        const linea = codigoPantalla.slice(0, ll.desde).split("\n").length;
        malos.push(`app/collection/page.tsx:${linea} calcula el precio por su cuenta, fuera de los respaldos del invitado`);
      }
    }
    /* El detalle de la carta pinta dos cosas que también manda el servidor: el
     * botón de repetidas y la casilla "Valor de la carta". Si dejara de leer
     * esos campos volvería a pintar la tarifa sin ajuste. */
    const codigoModal = codigoDe("components/CardDetailModal.tsx");
    if (!codigoModal.includes("valorDeVentaRepetidas")) {
      malos.push("components/CardDetailModal.tsx ya no lee el importe del servidor para el botón de repetidas");
    }
    if (!codigoModal.includes("valorDeReferencia")) {
      malos.push("components/CardDetailModal.tsx ya no lee `valorDeReferencia` para la casilla \"Valor de la carta\"");
    }

    comprueba(
      malos.length === 0 && combinaciones > 1000 && llamadasEnLaPantalla > 0 && peorMonedas > 0,
      `la colección enseña lo que pagan las tres rutas de venta (${combinaciones} combinaciones de rareza, copias, graduadas y euros; sin el precio real se quedaría corta hasta ${peorMonedas} monedas — ${peorCaso})`,
      (malos.slice(0, 6).join("\n          ") ||
        (peorMonedas === 0
          ? "ninguna combinación cambia al conocer el precio real, así que el barrido ya no vigila nada:" +
            " alguien ha desactivado el ajuste (DIVISOR_EUROS de utils/constanst.ts). Si es a propósito," +
            " este invariante hay que rehacerlo; dejarlo así lo deja de adorno."
          : `sólo se han encontrado ${llamadasEnLaPantalla} llamadas y ${combinaciones} combinaciones: el escáner se ha quedado ciego`)) +
        "\n          QUÉ TOCAR: el dinero lo calcula quien lo paga. `getFullCollection` manda" +
        " `valorDeVentaAhora` (una copia), `valorDeVentaRepetidas` (todas las libres) y" +
        " `valorDeReferencia` (la tarifa), los tres con el precio real de Cardmarket ya" +
        " dentro; la pantalla los PINTA. Mandar `precioEur` para que el navegador rehaga la" +
        " cuenta es el mismo fallo con otra ropa: la fórmula acaba escrita dos veces y se" +
        " separan, que es lo que documenta la sección B.",
    );
  }
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
