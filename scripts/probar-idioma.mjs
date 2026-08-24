#!/usr/bin/env node
/**
 * Prueba de services/idioma.ts sobre los datos reales del repositorio.
 *
 * Comprueba lo que de verdad importa:
 *   1. cuántas cartas traduce cada expansión,
 *   2. que NINGUNA carta pierde id, rarity ni set.id (de ahí cuelga la economía),
 *   3. que las 448 sin ilustración española conservan la inglesa.
 *
 * POR QUÉ el gancho de módulos: idioma.ts importa JSON como lo hace Next
 * (sin `with { type: "json" }`), que es lo correcto para el empaquetador pero
 * Node en crudo rechaza. El gancho sirve esos .json como módulos normales para
 * poder ejecutar el fichero DE VERDAD, sin copiar su lógica en la prueba.
 *
 * Uso:  node scripts/probar-idioma.mjs
 */

import { register } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      import { readFileSync } from "node:fs";
      import { fileURLToPath } from "node:url";
      export async function load(url, ctx, next) {
        if (url.endsWith(".json")) {
          const texto = readFileSync(fileURLToPath(url), "utf8");
          return {
            format: "module",
            shortCircuit: true,
            source: "export default " + texto + ";",
          };
        }
        return next(url, ctx);
      }
    `),
  import.meta.url,
);

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR_DATOS = path.join(RAIZ, "src", "data");

const idioma = await import(pathToFileURL(path.join(RAIZ, "services", "idioma.ts")).href);
const {
  traducirCarta,
  traducirCartas,
  traducirSet,
  traducirSets,
  SETS_CON_ES,
  normalizarIdioma,
} = idioma;

let fallos = 0;
function exigir(condicion, mensaje) {
  if (!condicion) {
    fallos++;
    console.error("  FALLO: " + mensaje);
  }
}

/** Misma forma con la que services/pokemon.ts y localData.ts sirven las cartas. */
async function cartasDeSet(idSet) {
  const crudo = JSON.parse(
    await fs.readFile(path.join(DIR_DATOS, idSet + ".json"), "utf8"),
  );
  const lista = Array.isArray(crudo) ? crudo : (crudo.data ?? []);
  return lista.map((c) => ({
    id: c.id,
    name: c.name,
    rarity: c.rarity || "Common",
    set: { id: idSet },
    images: c.images,
    number: String(c.number ?? ""),
  }));
}

const setsLocales = [...SETS_CON_ES].sort();

console.log("\n== 1. Cobertura por expansión (idioma \"es\") ==");
console.log("set            cartas  traduc   %   img.ES  img.EN");

let totCartas = 0, totTrad = 0, totImgEs = 0, totImgEn = 0;
const problemas = [];

for (const idSet of setsLocales) {
  const originales = await cartasDeSet(idSet);
  const traducidas = await traducirCartas(originales, "es");

  exigir(
    traducidas.length === originales.length,
    idSet + ": la lista cambia de tamaño (" + originales.length + " -> " + traducidas.length + ")",
  );

  let nTrad = 0, nImgEs = 0, nImgEn = 0;
  for (let i = 0; i < originales.length; i++) {
    const o = originales[i];
    const t = traducidas[i];

    // (2) La economía es intocable.
    if (t.id !== o.id) problemas.push(idSet + " " + o.id + ": cambió el id");
    if (t.rarity !== o.rarity) problemas.push(idSet + " " + o.id + ": cambió la rareza");
    if (t.set?.id !== o.set.id) problemas.push(idSet + " " + o.id + ": cambió el set");
    if (t.number !== o.number) problemas.push(idSet + " " + o.id + ": cambió el número");

    if (t === o) continue; // Sin traducción: misma referencia, intacta.
    nTrad++;

    // (3) Sin ilustración española se conserva la inglesa, tal cual.
    const esEs = typeof t.images?.small === "string" && t.images.small.includes("tcgdex");
    if (esEs) {
      nImgEs++;
      if (!t.images.small.endsWith("/low.webp") || !t.images.large.endsWith("/high.png")) {
        problemas.push(idSet + " " + o.id + ": URL de imagen mal compuesta");
      }
    } else {
      nImgEn++;
      if (t.images?.small !== o.images?.small || t.images?.large !== o.images?.large) {
        problemas.push(idSet + " " + o.id + ": perdió la imagen inglesa");
      }
    }
    // El respaldo inglés siempre queda accesible.
    if (t.nameEn !== o.name) problemas.push(idSet + " " + o.id + ": falta nameEn");
    if (t.imagesEn?.small !== o.images?.small) problemas.push(idSet + " " + o.id + ": falta imagesEn");
  }

  totCartas += originales.length; totTrad += nTrad; totImgEs += nImgEs; totImgEn += nImgEn;
  const pct = ((nTrad / originales.length) * 100).toFixed(0);
  console.log(
    idSet.padEnd(13) + String(originales.length).padStart(7) +
    String(nTrad).padStart(8) + (pct + "%").padStart(5) +
    String(nImgEs).padStart(8) + String(nImgEn).padStart(8),
  );
}

console.log("-".repeat(49));
console.log(
  "TOTAL".padEnd(13) + String(totCartas).padStart(7) + String(totTrad).padStart(8) +
  ((totTrad / totCartas * 100).toFixed(0) + "%").padStart(5) +
  String(totImgEs).padStart(8) + String(totImgEn).padStart(8),
);

exigir(problemas.length === 0, problemas.length + " incidencias: " + problemas.slice(0, 5).join(" | "));
// De las 448 cartas sin ilustración española, 303 tampoco cambian de nombre y
// el generador las omite (vuelven intactas, misma referencia). Quedan 145 que
// sí cambian de nombre y por tanto están traducidas pero con imagen inglesa.
exigir(
  totImgEn === 145,
  "traducidas que caen a imagen inglesa: " + totImgEn + " (se esperaban 145 = 448 sin imagen - 303 omitidas)",
);
exigir(
  totCartas - totTrad === 311,
  "sin traducir: " + (totCartas - totTrad) + " (se esperaban 311 = 303 omitidas + 8 sin pareja)",
);

console.log("\n== 2. Identidad con idioma \"en\" ==");
const muestra = await cartasDeSet("sv3pt5");
const enIngles = await traducirCartas(muestra, "en");
exigir(enIngles === muestra, "con \"en\" traducirCartas debe devolver el MISMO array");
exigir((await traducirCarta(muestra[0], "en")) === muestra[0], "con \"en\" traducirCarta debe devolver la MISMA carta");
console.log("  traducirCartas/traducirCarta con \"en\": misma referencia, sin cargar diccionarios. OK");

console.log("\n== 3. Carta sin pareja en TCGdex (queda en inglés) ==");
for (const [idSet, idCarta] of [["svp", "svp-85"], ["swshp", "swshp-SWSH074"]]) {
  const todas = await cartasDeSet(idSet);
  const original = todas.find((c) => c.id === idCarta);
  const t = await traducirCarta(original, "es");
  exigir(t === original, idCarta + " debería volver TAL CUAL (misma referencia)");
  console.log("  " + idCarta.padEnd(16) + '"' + t.name + '" con imagen ' + (t.images?.small ?? "-").slice(0, 42) + " OK");
}

console.log("\n== 4. Expansión sin ninguna ilustración española (swsh45sv) ==");
const sv = await cartasDeSet("swsh45sv");
const svT = await traducirCartas(sv, "es");
const conEs = svT.filter((c, i) => c !== sv[i]);
const conservanIngles = conEs.filter((c) => c.images?.small?.includes("pokemontcg.io"));
console.log("  " + conEs.length + " traducidas, " + conservanIngles.length + " conservan la imagen inglesa");
exigir(conEs.length === conservanIngles.length, "alguna carta de swsh45sv perdió la imagen inglesa");

console.log("\n== 5. Expansiones (traducirSet, síncrono) ==");
const todosLosSets = JSON.parse(await fs.readFile(path.join(DIR_DATOS, "all-sets.json"), "utf8"))
  .filter((s) => SETS_CON_ES.has(s.id));
const setsEs = traducirSets(todosLosSets, "es");
let cambianNombre = 0, conLogoEs = 0;
for (let i = 0; i < todosLosSets.length; i++) {
  exigir(setsEs[i].id === todosLosSets[i].id, "traducirSet cambió el id de " + todosLosSets[i].id);
  if (setsEs[i].name !== todosLosSets[i].name) cambianNombre++;
  if (setsEs[i].images?.logo?.includes("tcgdex")) conLogoEs++;
}
console.log("  " + todosLosSets.length + " expansiones: " + cambianNombre + " cambian de nombre, " + conLogoEs + " tienen logo español");
for (const id of ["sv3", "sv8", "swsh12pt5", "swsh45sv"]) {
  const s = setsEs.find((x) => x.id === id);
  console.log("    " + id.padEnd(11) + s.nameEn + "  ->  " + s.name);
}
exigir(traducirSets(todosLosSets, "en") === todosLosSets, "con \"en\" traducirSets debe devolver el MISMO array");
exigir(normalizarIdioma("fr") === "en", "normalizarIdioma debe caer a inglés");

console.log(fallos === 0 ? "\nTODO CORRECTO\n" : "\n" + fallos + " COMPROBACIONES FALLIDAS\n");
process.exitCode = fallos === 0 ? 0 : 1;
