#!/usr/bin/env node
/**
 * Genera el diccionario español de cartas y expansiones en src/data/es/.
 *
 * POR QUÉ existe este fichero y no una llamada en caliente a TCGdex:
 * el id canónico de la app es el de pokemontcg.io (rareza, precios, sobres y
 * bonos de set cuelgan de él). El español es sólo una CAPA DE PRESENTACIÓN, así
 * que se resuelve una vez aquí, en frío, y se guarda indexado POR EL ID LOCAL
 * para que en tiempo de ejecución sea un acceso directo a un objeto, sin
 * normalizar ids ni pedir nada por red.
 *
 * Uso:  node scripts/generar-diccionario-es.mjs [--set sv3pt5] [--dry]
 * Es idempotente: no escribe marcas de tiempo, así que dos ejecuciones seguidas
 * producen ficheros byte a byte iguales y el diff queda limpio.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR_DATOS = path.join(RAIZ, "src", "data");
const DIR_SALIDA = path.join(DIR_DATOS, "es");
const API = "https://api.tcgdex.net/v2/es";

/**
 * Equivalencia de expansiones repo -> TCGdex. TCGdex rellena con ceros los
 * bloques SV y ME (sv1 -> sv01, me2 -> me02) y usa punto donde el repo usa "pt"
 * (sv3pt5 -> sv03.5).
 *
 * SE DECLARA A MANO Y NO SE DERIVA, y no es pereza: una regla de "pt" -> "." con
 * relleno de cero acierta 31 de 38 y falla en swsh35, swsh45, swsh45sv y las
 * cuatro Trainer Gallery. Y los dos casos de Fulgor Negro y Llama Blanca no los
 * adivina nadie: `zsv10pt5` pierde la "z" y gana una "b" (sv10.5b), y `rsv10pt5`
 * una "w". Un fallo silencioso aquí traduciría una carta con el nombre de otra,
 * así que además hay una guardia que lo comprueba (ver más abajo).
 *
 * LAS TRAINER GALLERY ESTABAN MAL: llevaban un ".5" (swsh9.5tg) que hoy devuelve
 * 404 en TCGdex —comprobados los cuatro—, así que el generador fallaba en ellas
 * y, como el índice se armaba sólo con las que salían bien, cada pasada completa
 * las dejaba fuera y las devolvía al inglés en silencio.
 */
// La tabla vive en JSON y NO aquí porque la comparten dos consumidores que no
// pueden importarse entre sí: este script es .mjs y no puede importar TypeScript,
// y el cron de traducciones (services/idiomaIngest.ts) es TypeScript y no puede
// importar este .mjs sin arrastrar fs al bundle. Ver services/mapaSetsEs.ts.
// Dos copias que se desincronizan traducen una carta con el nombre de otra.
const SETS = JSON.parse(
  await fs.readFile(path.join(DIR_DATOS, "es", "mapa-sets.json"), "utf8"),
);

const CONCURRENCIA = 6;
const REINTENTOS = 4;

const args = process.argv.slice(2);
const soloSet = args.includes("--set") ? args[args.indexOf("--set") + 1] : null;
const enSeco = args.includes("--dry");

/** Espera pasiva entre reintentos. */
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function pedirJson(url) {
  let ultimoFallo;
  for (let intento = 0; intento < REINTENTOS; intento++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (err) {
      ultimoFallo = err;
      // Espera creciente: la API aguantó 550 req/s sin 429, así que un fallo
      // aquí es casi siempre red local, no límite del servidor.
      await dormir(250 * 2 ** intento);
    }
  }
  throw new Error("No pude leer " + url + ": " + (ultimoFallo && ultimoFallo.message));
}

const API_EN = "https://api.pokemontcg.io/v2";
/** Tope de pokemontcg.io. me2pt5 tiene 295 cartas, así que hay que paginar. */
const PAGINA_EN = 250;

/**
 * Petición a pokemontcg.io, con su propia espera.
 *
 * No reutiliza `pedirJson` porque los dos servicios se portan distinto: TCGdex
 * aguantó 550 req/s sin un 429, mientras que pokemontcg.io devuelve 500 y 502
 * de forma intermitente. Los 3,75 s acumulados de `pedirJson` se quedan cortos;
 * services/ingest.ts usa 3000·2^i por la misma razón.
 *
 * La clave de API es opcional: sin ella los límites son más bajos, que es justo
 * lo que documenta el README.
 */
async function pedirJsonEn(url) {
  let ultimoFallo;
  for (let intento = 0; intento < 6; intento++) {
    try {
      const cabeceras = { accept: "application/json" };
      if (process.env.POKEMONTCG_API_KEY) {
        cabeceras["X-Api-Key"] = process.env.POKEMONTCG_API_KEY;
      }
      const res = await fetch(url, { headers: cabeceras });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (err) {
      ultimoFallo = err;
      await dormir(Math.min(30000, 1500 * 2 ** intento));
    }
  }
  throw new Error("No pude leer " + url + ": " + (ultimoFallo && ultimoFallo.message));
}

/**
 * Cartas inglesas de una expansión que sólo vive en Postgres. Se piden los tres
 * únicos campos que usa el emparejamiento: id, name y number.
 */
async function descargarCartasIngles(idSet) {
  const porId = new Map();
  for (let page = 1; page <= 20; page++) {
    /* SIN `orderBy`, Y ESTO IMPORTA MÁS DE LO QUE PARECE.
     *
     * Con `orderBy=number` la paginación de pokemontcg.io es INESTABLE: medido
     * sobre me2pt5 (295 cartas), la página 1 trae 250 y la 2 trae 45 que YA
     * venían en la 1 — 295 descargadas, 250 únicas, y 45 cartas que no se
     * descargan jamás. `orderBy=id` es peor todavía: corta en 250. Sin ordenar,
     * las 295 salen únicas. (Ordenar aquí no aporta nada: el emparejamiento es
     * por id, no por posición.) */
    const url =
      API_EN + "/cards?q=set.id:" + encodeURIComponent(idSet) +
      "&page=" + page + "&pageSize=" + PAGINA_EN + "&select=id,name,number";
    const lote = (await pedirJsonEn(url))?.data ?? [];
    const antes = porId.size;
    for (const c of lote) if (c?.id) porId.set(c.id, c);
    // Una página incompleta es la última. Y si una completa no aporta ni una
    // carta nueva, la API está repitiéndose: cortar es mejor que girar en vano.
    if (lote.length < PAGINA_EN || porId.size === antes) break;
  }
  if (porId.size === 0) throw new Error("pokemontcg.io no sirve cartas de " + idSet);
  return [...porId.values()];
}

/** Ejecuta `tarea` sobre cada elemento con un tope de trabajos en vuelo. */
async function enParalelo(items, limite, tarea) {
  const salida = new Array(items.length);
  let siguiente = 0;
  const obreros = Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (siguiente < items.length) {
      const i = siguiente++;
      salida[i] = await tarea(items[i], i);
    }
  });
  await Promise.all(obreros);
  return salida;
}

/**
 * Claves con las que buscar una carta local dentro del set de TCGdex.
 * El repo escribe el número sin ceros ("sv3pt5-1") y TCGdex con tres
 * ("sv03.5-001"), pero los promos alfanuméricos ("SWSH074", "TG01") coinciden
 * tal cual. Se prueban en orden de más fiable a menos.
 */
function candidatos(sufijo) {
  const vistos = new Set();
  const add = (v) => { if (v && !vistos.has(v)) vistos.add(v); };
  add(sufijo);
  if (/^\d+$/.test(sufijo)) {
    const n = String(Number(sufijo));
    for (const ancho of [1, 2, 3, 4]) add(n.padStart(ancho, "0"));
  }
  add(sufijo.toUpperCase());
  add(sufijo.toLowerCase());
  // Alfanuméricos tipo "SWSH74" frente a "SWSH074": se rellena la cola numérica.
  const m = /^([A-Za-z]+)(\d+)$/.exec(sufijo);
  if (m) for (const ancho of [2, 3]) add(m[1] + m[2].padStart(ancho, "0"));
  return [...vistos];
}

/**
 * Cartas inglesas contra las que indexar. Del fichero local si existe y, si no,
 * de pokemontcg.io.
 *
 * EL RESPALDO ES LA PIEZA QUE FALTABA: las expansiones que trae el cron viven
 * sólo en Postgres, no tienen fichero en src/data, y sin esto no se les podía
 * generar diccionario aunque TCGdex las tuviera. No se guarda el fichero
 * descargado a propósito (ver la nota de la cabecera de SETS): escribir en
 * src/data cambiaría la lista de expansiones del mercado, y traducir es
 * presentación, no economía.
 */
async function leerCartasLocales(idSet) {
  try {
    const crudo = await fs.readFile(path.join(DIR_DATOS, idSet + ".json"), "utf8");
    const parseado = JSON.parse(crudo);
    return Array.isArray(parseado) ? parseado : (parseado.data ?? []);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    console.warn("AVISO  " + idSet + ": sin fichero local, bajo las cartas de pokemontcg.io");
    return descargarCartasIngles(idSet);
  }
}

/** JSON estable: sin marcas de tiempo y con las cartas ordenadas por id. */
function serializar(obj) {
  return JSON.stringify(obj, null, 1) + "\n";
}

async function main() {
  const ficheros = (await fs.readdir(DIR_DATOS))
    .filter((f) => f.endsWith(".json") && f !== "all-sets.json")
    .map((f) => f.replace(/\.json$/, ""));

  /* LA TABLA MANDA, NO EL DISCO.
   *
   * Antes la lista de trabajo salía de `readdir`, así que sólo se visitaban las
   * expansiones con fichero en src/data. Y eso es exactamente por lo que el
   * español se quedó atrás: el cron trae expansiones nuevas a Postgres sin
   * fichero local, así que aunque estuvieran declaradas en SETS el bucle no
   * llegaba a mirarlas nunca. Sus cartas se bajan de pokemontcg.io (ver
   * `leerCartasLocales`).
   */
  for (const f of ficheros) {
    if (!SETS[f]) {
      console.warn("AVISO  " + f + ": fichero sin equivalencia en TCGdex, lo salto.");
    }
  }
  if (soloSet && !SETS[soloSet]) {
    console.error("ERROR  " + soloSet + ": no está en la tabla SETS.");
    process.exit(1);
  }
  const idsLocales = soloSet ? [soloSet] : Object.keys(SETS);

  const setsIngles = JSON.parse(
    await fs.readFile(path.join(DIR_DATOS, "all-sets.json"), "utf8"),
  );
  const porIdIngles = new Map(setsIngles.map((s) => [s.id, s]));

  await fs.mkdir(DIR_SALIDA, { recursive: true });

  const informes = await enParalelo(idsLocales, CONCURRENCIA, async (idLocal) => {
    const idRemoto = SETS[idLocal];
    const remoto = await pedirJson(API + "/sets/" + idRemoto);
    if (!remoto) return { idLocal, error: "TCGdex no conoce el set " + idRemoto };
    // La equivalencia se verifica de verdad: si el id que responde no es el que
    // pedimos, la tabla está mal y traduciríamos con el set equivocado.
    if (remoto.id !== idRemoto) {
      return { idLocal, error: "pedí " + idRemoto + " y respondió " + remoto.id };
    }

    // Un fallo aquí es de UNA expansión, no de la pasada. Sin este try, un 502
    // de pokemontcg.io —que los da a menudo— reventaba `main` entera y no se
    // generaba ni una de las 46, incluidas las 38 que sólo leen del disco.
    let locales;
    try {
      locales = await leerCartasLocales(idLocal);
    } catch (err) {
      return { idLocal, error: "no pude leer sus cartas inglesas: " + err.message };
    }
    const porLocalId = new Map();
    for (const c of remoto.cards ?? []) {
      if (!porLocalId.has(c.localId)) porLocalId.set(c.localId, c);
    }

    const cartas = {};
    const sinPareja = [];
    let sinImagen = 0;
    let nombresCambiados = 0;
    let omitidas = 0;

    for (const local of locales) {
      const sufijo = local.id.startsWith(idLocal + "-")
        ? local.id.slice(idLocal.length + 1)
        : String(local.number ?? "");

      let pareja = null;
      for (const clave of candidatos(sufijo)) {
        const encontrada = porLocalId.get(clave);
        if (encontrada) { pareja = encontrada; break; }
      }
      if (!pareja) { sinPareja.push(local.id); continue; }

      const nombreEs = pareja.name;
      const cambia = nombreEs !== local.name;
      if (cambia) nombresCambiados++;
      if (!pareja.image) sinImagen++;

      // Sin nombre nuevo y sin ilustración española la entrada no aporta nada:
      // el consumidor devolvería la carta igual. No la escribimos.
      if (!cambia && !pareja.image) { omitidas++; continue; }

      const entrada = { n: nombreEs };
      // `i` es la URL BASE, sin extensión: TCGdex sirve <base>/low.webp y
      // <base>/high.png. Se omite cuando no hay ilustración española, y esa
      // ausencia es la señal de que hay que caer a la imagen inglesa.
      if (pareja.image) entrada.i = pareja.image;
      cartas[local.id] = entrada;
    }

    /* GUARDIA ANTIMAPEO CRUZADO.
     *
     * Que TCGdex responda 200 al id que le pides NO prueba que sea el mismo
     * set. Medido: emparejar sv10 contra sv08 casa el 100% de las 244 cartas
     * por localId —los números existen en las dos— y escribiría 244 nombres de
     * OTRAS cartas. El porcentaje de emparejadas, por tanto, no protege de nada.
     *
     * Lo que sí separa los dos casos es cuántos nombres NO cambian: dos sets
     * distintos comparten poquísimos nombres. Medido sobre las 38 expansiones
     * correctas va del 33,2% (sv10) al 89,6% (sv3); nueve emparejamientos
     * falsos probados a mano dieron 0,0% los nueve. El 15% deja margen ancho
     * por los dos lados.
     *
     * `sve` está exento: son las 16 energías básicas y sus 16 nombres cambian
     * en español ("Grass Energy" -> "Energía Planta"), así que da 0% siendo
     * correcto.
     */
    const emparejadas = locales.length - sinPareja.length;
    const identicas = emparejadas - nombresCambiados;
    const fEmparejadas = locales.length ? emparejadas / locales.length : 0;
    const fIdenticas = emparejadas ? identicas / emparejadas : 0;
    const pct = (x) => (100 * x).toFixed(1) + "%";
    if (idLocal !== "sve") {
      if (fEmparejadas < 0.9) {
        return {
          idLocal,
          error: `sólo empareja ${pct(fEmparejadas)} de las cartas con ${idRemoto}`,
        };
      }
      if (fIdenticas < 0.15) {
        return {
          idLocal,
          error:
            `sólo ${pct(fIdenticas)} de los nombres coincide con ${idRemoto}: ` +
            "casi seguro que es OTRO set",
        };
      }
    }

    const ingles = porIdIngles.get(idLocal);
    const salida = {
      set: {
        id: idLocal,
        idEs: remoto.id,
        nombre: remoto.name,
        nombreEn: ingles?.name ?? null,
        logo: remoto.logo ?? null,
        serie: remoto.serie?.name ?? null,
      },
      // Los ids que TCGdex no tiene quedan escritos: son datos, no un fallo a
      // esconder, y el consumidor cae a inglés para ellos.
      sinPareja,
      resumen: {
        locales: locales.length,
        traducidas: Object.keys(cartas).length,
        sinPareja: sinPareja.length,
        sinImagenEs: sinImagen,
        nombresCambiados,
        identicasOmitidas: omitidas,
      },
      cartas: Object.fromEntries(
        Object.keys(cartas).sort().map((k) => [k, cartas[k]]),
      ),
    };

    if (!enSeco) {
      await fs.writeFile(
        path.join(DIR_SALIDA, idLocal + ".json"),
        serializar(salida),
        "utf8",
      );
    }
    return { idLocal, ...salida.resumen, sinParejaIds: sinPareja, conjunto: salida.set };
  });

  const fallos = informes.filter((i) => i.error);
  const ok = informes.filter((i) => !i.error);

  // Índice pequeño: services/idioma.ts lo importa de forma estática para saber
  // qué sets tienen español sin lanzar imports dinámicos que fallarían.
  //
  // SE FUSIONA CUANDO LA PASADA ES PARCIAL, y esto no es un detalle: con `--set`
  // sólo se procesa una expansión, así que reconstruir el índice desde cero
  // dejaba dentro esa sola y APAGABA EL ESPAÑOL DE LAS OTRAS 37 —el índice es la
  // lista blanca que consulta `tieneEspanol`—. Una pasada completa sí lo
  // reescribe entero, que es lo que permite que una expansión retirada del mapa
  // desaparezca del índice.
  if (!enSeco) {
    let indice = {};
    if (soloSet) {
      try {
        indice = JSON.parse(
          await fs.readFile(path.join(DIR_SALIDA, "indice.json"), "utf8"),
        );
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    }
    for (const i of ok) {
      indice[i.idLocal] = {
        idEs: i.conjunto.idEs,
        nombre: i.conjunto.nombre,
        logo: i.conjunto.logo,
        serie: i.conjunto.serie,
        traducidas: i.traducidas,
      };
    }
    const ordenado = Object.fromEntries(
      Object.keys(indice)
        .sort((a, b) => a.localeCompare(b))
        .map((k) => [k, indice[k]]),
    );
    await fs.writeFile(path.join(DIR_SALIDA, "indice.json"), serializar(ordenado), "utf8");
  }

  const t = (n) => String(n).padStart(7);
  console.log("\nset            locales traduc  s/par  s/img nombres   omit");
  for (const i of ok.slice().sort((a, b) => a.idLocal.localeCompare(b.idLocal))) {
    console.log(
      i.idLocal.padEnd(13) + t(i.locales) + t(i.traducidas) + t(i.sinPareja) +
      t(i.sinImagenEs) + t(i.nombresCambiados) + t(i.identicasOmitidas),
    );
  }
  const suma = (k) => ok.reduce((a, i) => a + i[k], 0);
  console.log("-".repeat(55));
  console.log(
    "TOTAL".padEnd(13) + t(suma("locales")) + t(suma("traducidas")) +
    t(suma("sinPareja")) + t(suma("sinImagenEs")) + t(suma("nombresCambiados")) +
    t(suma("identicasOmitidas")),
  );

  const huerfanas = ok.flatMap((i) => i.sinParejaIds);
  if (huerfanas.length) console.log("\nSin pareja en TCGdex: " + huerfanas.join(", "));
  for (const f of fallos) console.error("ERROR " + f.idLocal + ": " + f.error);
  if (fallos.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
