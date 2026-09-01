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
 * HAY UN SEGUNDO SCRIPT, y no lo sustituye: scripts/bajar-sobres-bulbapedia.mjs
 * saca de Bulbapedia el sobre de las expansiones que lo tengan publicado (hoy
 * 129 de 171). Éste sigue siendo el bueno para lo que se traiga a mano: una
 * imagen mejor que la de la wiki, una expansión que la wiki no tiene todavía
 * —las nuevas tardan— o una que se llame distinto en los dos sitios. Los dos
 * escriben en public/sobres y en el mismo manifiesto, y por eso el manifiesto
 * se cuenta del disco al final de este fichero. Léelo antes de tocar nada.
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

/* ------------------------------------------------------------------ *
 * EL MANIFIESTO SE CUENTA DEL DISCO, NO DE LO QUE ACABO DE CONVERTIR
 *
 * Desde que existe scripts/bajar-sobres-bulbapedia.mjs hay DOS scripts
 * escribiendo en public/sobres: éste, con lo que trae una persona a mano, y
 * aquél, con lo que baja de Bulbapedia para las 171 expansiones. Si cada uno
 * escribiese el manifiesto con las suyas, el último en ejecutarse borraría del
 * manifiesto el trabajo del otro. Y sería un fallo de los malos: las imágenes
 * seguirían en el disco, la aplicación no volvería a mirarlas y no lo notaría
 * nadie, porque un sobre sin foto no es un hueco, es el sobre dibujado.
 *
 * Contando lo que HAY en la carpeta, los dos scripts conmutan: da igual el
 * orden en que se ejecuten y da igual cuántos sean mañana.
 *
 * OJO al añadir aquí una expansión que ya hubiera bajado el otro: quítala
 * también de la sección "generado" de src/data/sobres-bulbapedia.json, o su
 * próxima ejecución te volverá a pisar la carpeta. Lo que trae una persona
 * manda sobre lo que baja un script, pero eso hay que decírselo.
 * ------------------------------------------------------------------ */
const enDisco = {};
if (existsSync(DESTINO)) {
  for (const carpeta of readdirSync(DESTINO, { withFileTypes: true })) {
    if (!carpeta.isDirectory()) continue;
    // Las variantes van SEGUIDAS desde 1.webp: es el contrato que da por hecho
    // utils/sobreArte.ts al sortear cuál le toca a cada sobre.
    let n = 0;
    while (existsSync(join(DESTINO, carpeta.name, `${n + 1}.webp`))) n++;
    if (n > 0) enDisco[carpeta.name] = { variantes: n };
  }
}

/* El manifiesto va ORDENADO por id para que el fichero no cambie de orden entre
 * ejecuciones y el diff de git sea legible. */
const ordenado = {};
for (const id of Object.keys(enDisco).sort()) ordenado[id] = enDisco[id];
writeFileSync(MANIFIESTO, JSON.stringify(ordenado, null, 2) + "\n");

if (totalEntrada > 0) {
  console.log(
    "\n" +
      Object.keys(manifiesto).length +
      " expansión(es) convertida(s) aquí  ·  " +
      (totalEntrada / 1024 / 1024).toFixed(2) +
      " MB -> " +
      (totalSalida / 1024 / 1024).toFixed(2) +
      " MB  (" +
      (100 - (100 * totalSalida) / totalEntrada).toFixed(0) +
      "% menos)",
  );
} else {
  console.log("\nNo se ha convertido nada: ninguna carpeta de origen estaba mapeada.");
}
console.log(
  Object.keys(ordenado).length + " expansión(es) con sobre propio en total (contando public/sobres)",
);
console.log("Manifiesto: " + MANIFIESTO);
