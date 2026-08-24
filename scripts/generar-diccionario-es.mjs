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
 * bloques SV (sv1 -> sv01) y usa punto donde el repo usa "pt" (sv3pt5 ->
 * sv03.5); las Trainer Gallery además cambian de número (swsh9tg -> swsh9.5tg).
 * Se declara a mano en vez de derivarla: hay demasiadas excepciones y un fallo
 * silencioso aquí traduciría una carta con el nombre de otra.
 */
const SETS = {
  sv1: "sv01", sv2: "sv02", sv3: "sv03", sv3pt5: "sv03.5", sv4: "sv04",
  sv4pt5: "sv04.5", sv5: "sv05", sv6: "sv06", sv6pt5: "sv06.5", sv7: "sv07",
  sv8: "sv08", sv8pt5: "sv08.5", sv9: "sv09", sv10: "sv10",
  swsh1: "swsh1", swsh2: "swsh2", swsh3: "swsh3", swsh4: "swsh4",
  swsh5: "swsh5", swsh6: "swsh6", swsh7: "swsh7", swsh8: "swsh8",
  swsh9: "swsh9", swsh10: "swsh10", swsh11: "swsh11", swsh12: "swsh12",
  swsh12pt5: "swsh12.5", swsh12pt5gg: "swsh12.5gg",
  swsh35: "swsh3.5", swsh45: "swsh4.5", swsh45sv: "swsh4.5sv",
  swsh9tg: "swsh9.5tg", swsh10tg: "swsh10.5tg", swsh11tg: "swsh11.5tg",
  swsh12tg: "swsh12.5tg",
  sve: "sve", svp: "svp", swshp: "swshp",
};

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

async function leerCartasLocales(idSet) {
  const crudo = await fs.readFile(path.join(DIR_DATOS, idSet + ".json"), "utf8");
  const parseado = JSON.parse(crudo);
  return Array.isArray(parseado) ? parseado : (parseado.data ?? []);
}

/** JSON estable: sin marcas de tiempo y con las cartas ordenadas por id. */
function serializar(obj) {
  return JSON.stringify(obj, null, 1) + "\n";
}

async function main() {
  const ficheros = (await fs.readdir(DIR_DATOS))
    .filter((f) => f.endsWith(".json") && f !== "all-sets.json")
    .map((f) => f.replace(/\.json$/, ""));

  const idsLocales = (soloSet ? [soloSet] : ficheros).filter((id) => {
    if (SETS[id]) return true;
    console.warn("AVISO  " + id + ": sin equivalencia declarada en TCGdex, lo salto.");
    return false;
  });

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

    const locales = await leerCartasLocales(idLocal);
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
  if (!enSeco) {
    const indice = {};
    for (const i of ok.slice().sort((a, b) => a.idLocal.localeCompare(b.idLocal))) {
      indice[i.idLocal] = {
        idEs: i.conjunto.idEs,
        nombre: i.conjunto.nombre,
        logo: i.conjunto.logo,
        serie: i.conjunto.serie,
        traducidas: i.traducidas,
      };
    }
    await fs.writeFile(path.join(DIR_SALIDA, "indice.json"), serializar(indice), "utf8");
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
