#!/usr/bin/env node
/**
 * PREPARA LAS ILUSTRACIONES DE SOBRE PARA LA WEB.
 *
 * Lee la carpeta de originales (PNG grandes, uno o varios por expansión),
 * los convierte a WebP del tamaño que de verdad se pinta y escribe el
 * manifiesto que la aplicación consulta para saber qué expansiones tienen
 * sobre de verdad y cuántas variantes.
 *
 *   node scripts/preparar-sobres.mjs
 *   node scripts/preparar-sobres.mjs --origen "C:/ruta/a/ImagenesSobres"
 *
 * ============================================================================
 * POR QUÉ ESTO ES UN PASO MANUAL Y NO UN CRON
 * ============================================================================
 *
 * Las ilustraciones de sobre no salen de ninguna API: las trae una persona.
 * Por eso el proceso es "deja los PNG en una carpeta y ejecuta esto", y por eso
 * el resultado se commitea: en producción no hay ni carpeta de originales ni
 * sharp instalado, sólo los WebP de public/ y el manifiesto.
 *
 * ============================================================================
 * POR QUÉ WEBP Y NO LOS PNG TAL CUAL
 * ============================================================================
 *
 * Los cuatro originales de Pitch Black suman 6,0 MB. Eso se descarga JUSTO en
 * el momento de abrir el sobre, que es el único de la aplicación con
 * presupuesto en milisegundos, y encima en móvil. En WebP con calidad 82 y
 * transparencia bajan a una fracción sin diferencia visible al tamaño al que
 * se pintan (~280 px de ancho, ~560 en pantallas de doble densidad).
 *
 * Es la misma decisión, y por el mismo motivo, que ya se tomó con las
 * ilustraciones españolas: 24,7 MB de PNG frente a 1,75 MB de WebP.
 *
 * ============================================================================
 * EL MAPA DE CARPETAS
 * ============================================================================
 *
 * La carpeta de originales se organiza por NOMBRE de expansión, que es como las
 * nombra quien las descarga, pero la aplicación trabaja con IDS. El mapa de
 * abajo une las dos cosas y es lo único que hay que tocar al añadir una
 * expansión nueva.
 *
 * Los ids son los de pokemontcg.io, que es la fuente del catálogo: me1, me2,
 * me2pt5, me3... OJO, NO son los de TCGdex, que escribe me01, me02, me02.5.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";

/* ------------------------------------------------------------------ *
 * EL MAPA. Una línea por carpeta.
 * ------------------------------------------------------------------ */
const MAPA_CARPETAS = {
  // Carpeta            id del set   nombre para el informe
  PitchBlack: { setId: "me5", nombre: "Pitch Black / Oscuridad Absoluta" },
};

/** Ancho de salida. El sobre se pinta a ~280 px; 780 cubre pantallas 2x y 3x. */
const ANCHO = 780;
/** Calidad WebP. A 82 no se distingue del original al tamaño al que se ve. */
const CALIDAD = 82;

const raiz = process.cwd();
const argOrigen = process.argv.indexOf("--origen");
const ORIGEN =
  argOrigen > 0 && process.argv[argOrigen + 1]
    ? resolve(process.argv[argOrigen + 1])
    : resolve(raiz, "..", "ImagenesSobres");
const DESTINO = join(raiz, "public", "sobres");
const MANIFIESTO = join(raiz, "src", "data", "sobres.json");

if (!existsSync(ORIGEN)) {
  console.error("No existe la carpeta de originales: " + ORIGEN);
  console.error("Pásala con --origen si está en otro sitio.");
  process.exit(1);
}

console.log("Origen:  " + ORIGEN);
console.log("Destino: " + DESTINO + "\n");

const manifiesto = {};
let totalEntrada = 0;
let totalSalida = 0;
const sinMapear = [];

for (const carpeta of readdirSync(ORIGEN, { withFileTypes: true })) {
  if (!carpeta.isDirectory()) continue;

  const entrada = MAPA_CARPETAS[carpeta.name];
  if (!entrada) {
    // NO se adivina el id: un sobre puesto en la expansión equivocada es peor
    // que un sobre que no está, porque nadie lo mira dos veces.
    sinMapear.push(carpeta.name);
    continue;
  }

  const dirOrigen = join(ORIGEN, carpeta.name);
  const ficheros = readdirSync(dirOrigen)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    // Orden estable: el índice de la variante tiene que ser el mismo en cada
    // ejecución, o el sobre de una expansión cambiaría de dibujo sin motivo.
    .sort((a, b) => a.localeCompare(b, "en"));

  if (ficheros.length === 0) continue;

  const dirDestino = join(DESTINO, entrada.setId);
  mkdirSync(dirDestino, { recursive: true });

  console.log(entrada.setId + "  (" + entrada.nombre + ")");
  for (let i = 0; i < ficheros.length; i++) {
    const origen = join(dirOrigen, ficheros[i]);
    const destino = join(dirDestino, i + 1 + ".webp");
    const antes = readFileSync(origen).length;

    await sharp(origen)
      // `withoutEnlargement` por si algún original llega más pequeño que ANCHO:
      // ampliarlo sólo añadiría peso y desenfoque.
      .resize({ width: ANCHO, withoutEnlargement: true })
      .webp({ quality: CALIDAD, alphaQuality: 100, effort: 6 })
      .toFile(destino);

    const despues = readFileSync(destino).length;
    totalEntrada += antes;
    totalSalida += despues;
    console.log(
      "   " +
        ficheros[i].padEnd(34) +
        "-> " +
        (i + 1) +
        ".webp   " +
        (antes / 1024).toFixed(0).padStart(5) +
        " KB -> " +
        (despues / 1024).toFixed(0).padStart(4) +
        " KB",
    );
  }

  manifiesto[entrada.setId] = { variantes: ficheros.length };
}

if (sinMapear.length > 0) {
  console.log(
    "\nCarpetas SIN MAPEAR (no se han convertido): " + sinMapear.join(", "),
  );
  console.log(
    "Añádelas a MAPA_CARPETAS en este mismo fichero con el id de su expansión.",
  );
}

/* El manifiesto va ORDENADO por id para que el fichero no cambie de orden entre
 * ejecuciones y el diff de git sea legible. */
const ordenado = {};
for (const id of Object.keys(manifiesto).sort()) ordenado[id] = manifiesto[id];
writeFileSync(MANIFIESTO, JSON.stringify(ordenado, null, 2) + "\n");

console.log(
  "\n" +
    Object.keys(ordenado).length +
    " expansión(es) con sobre propio  ·  " +
    (totalEntrada / 1024 / 1024).toFixed(2) +
    " MB -> " +
    (totalSalida / 1024 / 1024).toFixed(2) +
    " MB  (" +
    (100 - (100 * totalSalida) / totalEntrada).toFixed(0) +
    "% menos)",
);
console.log("Manifiesto: " + MANIFIESTO);
