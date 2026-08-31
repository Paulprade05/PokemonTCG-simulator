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
/* VEREDICTO                                                           */
/* ------------------------------------------------------------------ */

console.log("\n== VEREDICTO ==");
if (fallos > 0) {
  console.log(`  ${fallos} INVARIANTE(S) ROTA(S) de ${pasados + fallos}.`);
  process.exitCode = 1;
} else {
  console.log(`  OK · ${pasados} invariantes se mantienen.`);
}
