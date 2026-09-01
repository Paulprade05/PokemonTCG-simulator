/**
 * ARTE DEL SOBRE POR EXPANSIÓN
 *
 * POR QUÉ EXISTE ESTE FICHERO Y NO UNA CARPETA DE IMÁGENES
 *
 * La petición original era descargar el sobre oficial de cada expansión. No se
 * ha hecho, y las tres razones son de fondo, no de gusto:
 *
 *   1. Son 171 expansiones y SUBIENDO SOLAS. `app/api/cron/sync-sets` añade
 *      cada noche lo que publique la API, así que una carpeta de imágenes
 *      nace incompleta el día siguiente a llenarla, y falla en silencio: la
 *      expansión nueva se queda sin sobre y nadie se entera hasta que alguien
 *      la compra. Todo lo que hay aquí es una FUNCIÓN TOTAL: para cualquier
 *      cadena que llegue devuelve un sobre razonable, incluida la expansión
 *      que aún no existe.
 *   2. El repositorio es público y esas ilustraciones son de terceros.
 *   3. El sobre está compuesto 100% en CSS justo para no depender de ningún
 *      recurso externo (components/BoosterPack.tsx). Meter un PNG por sobre
 *      tira ese diseño a la basura y añade una petición bloqueante en mitad
 *      de la apertura, que es el único momento de la app con presupuesto de
 *      milisegundos.
 *
 * QUÉ HACE ENTONCES: derivar la identidad visual de la expansión de datos que
 * YA viajan hasta el componente. Todo lo que sale de aquí son CUSTOM
 * PROPERTIES que se ponen inline en el elemento del sobre; el bloque CSS del
 * componente es UNA cadena constante, la misma para las 171 expansiones. Si
 * esto generase CSS por expansión, cada sobre inyectaría una hoja nueva en el
 * `<style>` de la apertura, que es exactamente lo que no queremos.
 *
 * DE DÓNDE SALE EL IDENTIFICADOR
 *
 * BoosterPack recibe `logo` y `nombreSet`, y nada más: no recibe el id de la
 * expansión ni su serie, y app/page.tsx (que sí los tiene) lo está tocando
 * otro agente. Pero la URL del logo LLEVA el id dentro, en las tres formas que
 * la app puede servir hoy:
 *
 *   https://images.pokemontcg.io/swsh12pt5/logo.png      -> "swsh12pt5"
 *   https://assets.tcgdex.net/es/sv/sv03.5/logo.png      -> "sv03.5", serie "sv"
 *   https://images.scrydex.com/pokemon/me2pt5-logo/logo  -> "me2pt5"
 *
 * La segunda es la del índice español (services/idioma.ts `construirLogoEs`),
 * y por eso la identificación NO puede quedarse en la primera: en español el
 * sobre se habría quedado con el color por defecto en las 46 expansiones
 * traducidas, que son justo las que más se abren.
 *
 * La tercera es una sola expansión de las 171 (me2pt5) y merece la pena mirarla
 * un segundo, porque es el futuro de este fichero: la trajo el cron, con un
 * host y una forma de ruta que no existían antes, y nadie la escribió a mano.
 * Habrá más. Por eso NADA de aquí abajo falla cuando no reconoce lo que ve:
 * hay respaldo en cada escalón —id, familia, símbolo— y el peor caso sigue
 * siendo un sobre completo.
 *
 * `normalizarId` existe por esas dos formas: el mismo set se llama "sv3pt5"
 * en inglés y "sv03.5" en español, y sin normalizar, cambiar de idioma
 * cambiaría el color del sobre. Con ella las dos caen en "sv3.5".
 *
 * LO QUE SÍ HAY EN DISCO. Desde que existe scripts/preparar-sobres.mjs hay un
 * puñado de sobres FOTOGRAFIADOS en public/sobres, y este fichero también
 * contesta a "¿tiene foto esta expansión?" (sección 6). No contradice nada de
 * lo de arriba: son 1 de 171 y el dibujo sigue siendo lo que se ve casi
 * siempre, así que la función total sigue siendo el suelo de todo esto.
 */

// El manifiesto de las fotos. Se importa —no se pide por red— para que la
// pregunta "¿esta expansión tiene foto?" se pueda contestar en el primer
// render; el porqué largo está en la sección 6.
import manifiestoSobres from "../src/data/sobres.json";

/* ------------------------------------------------------------------ */
/* 1. ERAS: el PERFIL DE IMPRESIÓN, que no es el color                 */
/*                                                                     */
/* Dos expansiones de la misma serie comparten mucho más que la gama:   */
/* comparten la fábrica. Un sobre de Base es cartón impreso mate, con   */
/* un rayado grueso y casi sin brillo; uno de Escarlata y Púrpura es    */
/* film metalizado con lenticular fino que devuelve la luz entera. Esa  */
/* diferencia se nota antes que el color, y es la que hace que un sobre */
/* viejo "parezca viejo" sin escribir la fecha en ningún sitio.         */
/* ------------------------------------------------------------------ */

export interface EraImpresion {
  /**
   * Ángulo del rayado lenticular Y del cilindro del cuerpo. Van juntos a
   * propósito: son la misma impresión sobre el mismo plástico, y dos ángulos
   * distintos delatan el degradado como degradado (mismo razonamiento que la
   * variable `--luz` del sorteo de BoosterPack).
   */
  ang: number;
  /** Opacidad de la capa de rayado. */
  rayado: number;
  /**
   * Multiplicador del PASO del rayado. 1 = el periodo de 7px de siempre.
   * Por encima de 1 la raya engorda (impresión vieja, tramas gruesas), por
   * debajo se afina (lenticular moderno).
   */
  paso: number;
  /** Multiplicador de los reflejos y del barrido: mate abajo, foil arriba. */
  lustre: number;
  /** Cuánto tiñe el color de expansión el borde superior del cuerpo. */
  t1: number;
  /** Y el inferior. Siempre por debajo de t1: la luz cae de arriba. */
  t2: number;
}

/**
 * Los valores de "moderna" son EXACTAMENTE los que estaban escritos a mano en
 * el CSS antes de esta pieza (102deg, .55 de rayado, periodo de 7px, reflejos
 * al 100%, tintes 30%/22%). Están así para que el cambio sea auditable: un
 * sobre de la era Blanco y Negro / XY / Sol y Luna se ve hoy igual que ayer, y
 * lo que se mueva alrededor se mide contra él.
 *
 * Los tintes NO se suben más de 42%: los dos radiales tiñen las esquinas
 * (`at 50% 0%` y `at 50% 112%`, ambos apagándose antes del 62%), pero el
 * núcleo del cuerpo se queda en `--surface` y ahí es donde va el nombre de la
 * expansión en `--ink-soft`. Subirlos hasta teñir el centro se come ese
 * contraste, que es el único texto del sobre que hay que poder leer.
 */
const ERAS = {
  /** Base, Gym, Neo, e-Card: cartón, tinta plana y ningún foil. */
  vintage: { ang: 96, rayado: 0.16, paso: 1.8, lustre: 0.6, t1: 42, t2: 32 },
  /** EX, POP, Diamante y Perla, Platino, HGSS: ya hay plástico, aún poco brillo. */
  clasica: { ang: 99, rayado: 0.34, paso: 1.35, lustre: 0.82, t1: 36, t2: 27 },
  /** Blanco y Negro, XY, Sol y Luna: el sobre de referencia. */
  moderna: { ang: 102, rayado: 0.55, paso: 1, lustre: 1, t1: 30, t2: 22 },
  /** Espada y Escudo en adelante: film metalizado, lenticular fino y agresivo. */
  holo: { ang: 106, rayado: 0.74, paso: 0.78, lustre: 1.18, t1: 34, t2: 26 },
} satisfies Record<string, EraImpresion>;

type ClaveEra = keyof typeof ERAS;

/* ------------------------------------------------------------------ */
/* 2. FAMILIAS: la tabla a mano                                        */
/*                                                                     */
/* Se busca por PREFIJO MÁS LARGO sobre el id normalizado, no por       */
/* igualdad: así una clave cubre la serie entera ("sv" son 18          */
/* expansiones) y las que merecen sobre propio se meten con una clave   */
/* más larga que gana a la de su serie ("sv10.5b" gana a "sv").         */
/*                                                                     */
/* Los colores son los del SOBRE, no los del logo ni los de la serie:   */
/* Espada y Escudo es azul y carmesí, Escarlata y Púrpura es rojo y     */
/* violeta, HeartGold y SoulSilver es oro y plata. Cuando el sobre real */
/* no tiene un color dominante claro (EX, POP) se coge el de la barra   */
/* superior de la caja, que es lo que uno recuerda del expositor.       */
/* ------------------------------------------------------------------ */

/**
 * Los colores son OPCIONALES y la era no. Es a propósito: hay expansiones
 * sueltas de las que sé perfectamente la fábrica —Islas del Sur es de 2001, o
 * sea cartón— y de las que no tengo ni idea de qué color era el sobre, si es
 * que llegó a venderse en sobre. Con los colores obligatorios habría que
 * inventárselos, y un color inventado a mano es peor que uno del hash: el del
 * hash al menos no finge ser un dato. Sin `a`/`b`, la entrada sólo corrige la
 * textura y el color lo sigue poniendo el hash.
 */
interface Familia {
  a?: string;
  b?: string;
  era: ClaveEra;
}

const FAMILIAS: Record<string, Familia> = {
  // --- WotC: la era de cartón. ---
  // Azul de la caja del Set Base con el amarillo de la marca. Cubre también
  // base6 (Legendary Collection), que la API clasifica en "Other" pero que
  // visualmente es de esta familia.
  base: { a: "#2f6fb8", b: "#f2c33c", era: "vintage" },
  gym: { a: "#2e7f6d", b: "#d9603a", era: "vintage" },
  neo: { a: "#35508f", b: "#c8a34a", era: "vintage" },
  ecard: { a: "#4c6a86", b: "#a9c3d6", era: "vintage" },
  np: { a: "#c0392b", b: "#e8d9b5", era: "vintage" },

  // --- EX / POP / DP / Platino / HGSS ---
  ex: { a: "#c2451f", b: "#f0a52a", era: "clasica" },
  // Los Trainer Kit (tk1a, tk2b…) son de la era EX y van con ella.
  tk: { a: "#c2451f", b: "#f0a52a", era: "clasica" },
  pop: { a: "#2a74b6", b: "#58c3e2", era: "clasica" },
  // Azul diamante y rosa perla, que es literalmente de dónde sale el nombre.
  dp: { a: "#2f6ec4", b: "#dda6cd", era: "clasica" },
  pl: { a: "#59697a", b: "#8fd2ea", era: "clasica" },
  hgss: { a: "#c99a1e", b: "#b6c2cb", era: "clasica" },
  // Promos HGSS: mismo sobre, otro prefijo.
  hsp: { a: "#c99a1e", b: "#b6c2cb", era: "clasica" },
  // Call of Legends cierra la era HGSS con sobre plateado.
  col: { a: "#3e6f9e", b: "#d8dee4", era: "clasica" },

  // --- BW / XY / SM: el sobre de referencia. ---
  // Negro y blanco puros dejarían un sobre gris sin identidad; el azul es el
  // acento con el que se imprimieron los sobres de la serie.
  bw: { a: "#26272d", b: "#6fb9df", era: "moderna" },
  xy: { a: "#1f57a8", b: "#d23046", era: "moderna" },
  // g1 (Generaciones) es XY sin llevar el prefijo.
  g1: { a: "#1f57a8", b: "#d23046", era: "moderna" },
  sm: { a: "#ef8a1f", b: "#3d3f93", era: "moderna" },
  det1: { a: "#c8a12c", b: "#35377f", era: "moderna" },

  // --- SWSH en adelante: foil. ---
  swsh: { a: "#1f66b0", b: "#c22a41", era: "holo" },
  cel: { a: "#d9b23c", b: "#33406f", era: "holo" },
  pgo: { a: "#1d84c4", b: "#f0c02f", era: "holo" },
  sv: { a: "#c33a2c", b: "#7c40bb", era: "holo" },
  me: { a: "#7b34c0", b: "#17bfa3", era: "holo" },
  // Rayo Negro y Llama Blanca son la misma expansión partida en dos sobres de
  // colores opuestos, y sale barato respetarlo. Las cuatro claves son el mismo
  // par de sobres visto desde los dos espacios de ids: "zsv10.5"/"rsv10.5" es
  // como los llama pokemontcg.io y "sv10.5b"/"sv10.5w" como los llama tcgdex,
  // así que el sobre no cambia al cambiar de idioma.
  zsv: { a: "#1b1f33", b: "#4f7fd1", era: "holo" },
  rsv: { a: "#e4e0d6", b: "#d4462f", era: "holo" },
  "sv10.5b": { a: "#1b1f33", b: "#4f7fd1", era: "holo" },
  "sv10.5w": { a: "#e4e0d6", b: "#d4462f", era: "holo" },

  // --- Promocionales de marca ---
  mcd: { a: "#d6242a", b: "#ffc42c", era: "moderna" },

  /*
   * SUELTAS, sólo para poner la era. Son las seis que no caen en ninguna serie
   * (comprobado contra las 171 de src/data/all-sets.json) y todas menos una son
   * anteriores al foil, así que sin esto se imprimirían como un sobre de 2024:
   * lenticular fino y brillo entero sobre Islas del Sur, de 2001. El color se
   * lo sigue dando el hash, que para una expansión de la que no recuerdo el
   * sobre es más honesto que un color puesto a ojo.
   *
   * fut20 (Futsal, 2020) no está aquí: la era por defecto ya es la suya.
   */
  si1: { era: "vintage" },
  bp: { era: "vintage" },
  ru1: { era: "clasica" },
  dv1: { era: "moderna" },
  dc1: { era: "moderna" },
};

/* ------------------------------------------------------------------ */
/* 3. IDENTIFICACIÓN                                                   */
/* ------------------------------------------------------------------ */

/** Un id de expansión sano: sólo letras, dígitos y el punto de las medias. */
const ID_SANO = /^[a-z0-9][a-z0-9.]{0,23}$/;

/**
 * Dónde vive el símbolo, por host de la ilustración.
 *
 * No es una lista de "hosts amigos" sino la lista de los que sabemos LEER, y
 * está construida mirando src/data/all-sets.json, no adivinando:
 *
 *   images.pokemontcg.io  170 expansiones  .../<id>/logo.png     .../<id>/symbol.png
 *   images.scrydex.com      1 expansión    .../<id>-logo/logo    .../<id>-symbol/symbol
 *
 * Esa expansión suelta (me2pt5, Héroes Ascendentes) es la prueba de que el
 * catálogo se mueve solo: la trajo el cron con un host que no existía cuando
 * se escribió el resto del fichero, y así seguirá. Un host desconocido no es
 * un error, es lo normal el día que cambien de proveedor: se queda sin sello
 * —que es un adorno— y conserva color y textura, que se sacan del id.
 *
 * assets.tcgdex.net (el logo español) NO está: ahí el símbolo puede o no
 * existir y no hay nada en el repositorio que lo diga. Inventar la URL sale
 * caro de verdad —una petición fallida por cada sobre abierto en español— y
 * la alternativa buena ya está escrita: que page.tsx pase `simbolo`, que en
 * español sigue siendo el inglés y siempre está.
 */
const SIMBOLO_POR_HOST: Record<string, (id: string) => string> = {
  "images.pokemontcg.io": (id) => `https://images.pokemontcg.io/${id}/symbol.png`,
  "images.scrydex.com": (id) => `https://images.scrydex.com/pokemon/${id}-symbol/symbol`,
};

interface Identidad {
  /** Id normalizado de la expansión. */
  id: string;
  /** Segmento de serie, si la URL lo trae (sólo las de tcgdex). */
  serie: string | null;
  /** URL del símbolo del set, sólo si se puede construir con certeza. */
  simbolo: string | null;
}

/**
 * Unifica los dos espacios de identificadores que puede traer la URL del logo.
 *
 *   "sv3pt5"  (pokemontcg.io) ─┐
 *                              ├─► "sv3.5"
 *   "sv03.5"  (tcgdex, es)    ─┘
 *
 * El "pt" sólo se sustituye cuando le sigue un dígito (siempre es "point"),
 * y los ceros a la izquierda sólo se comen cuando van pegados a una letra:
 * con un `/0+(\d)/` a secas, "sv100" se convertiría en "sv10" y dos
 * expansiones distintas compartirían color.
 *
 * Nada de mirar atrás en la expresión regular: el lookbehind revienta al
 * PARSEAR el script en Safari anterior a 16.4, no al ejecutarlo, así que se
 * llevaría por delante la página entera en un iPhone viejo.
 */
export function normalizarId(bruto: string): string {
  return bruto
    .toLowerCase()
    .replace(/pt(?=\d)/g, ".")
    .replace(/([a-z])0+(\d)/g, "$1$2");
}

/**
 * Saca la expansión de la URL del logo. Devuelve null en cuanto algo no cuadra
 * (URL relativa, ruta corta, id con caracteres raros): quien llama ya tiene un
 * respaldo, y adivinar aquí sería peor que no saber.
 */
export function identificarExpansion(logo?: string): Identidad | null {
  if (!logo) return null;

  let u: URL;
  try {
    // Sin base a propósito: una ruta relativa no lleva id de expansión dentro,
    // así que preferimos que reviente aquí y caer al respaldo.
    u = new URL(logo);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;

  const segs = u.pathname.split("/").filter(Boolean);
  // Hace falta al menos ".../<id>/logo.png".
  if (segs.length < 2) return null;

  const fichero = segs[segs.length - 1].toLowerCase();
  /*
   * El sufijo "-logo" es de scrydex, que mete el uso en el nombre de la
   * carpeta (".../me2pt5-logo/logo") en vez de en el del fichero. Se quita
   * ANTES de validar: con el guión dentro, ID_SANO rechaza el segmento y la
   * expansión se queda sin color de familia por un detalle de formato del
   * proveedor. Fue exactamente lo que le pasaba a me2pt5, que salía con un
   * verde de hash mientras su gemela española salía violeta.
   */
  const bruto = segs[segs.length - 2].toLowerCase().replace(/-logo$/, "");
  if (!ID_SANO.test(bruto)) return null;
  // Sólo se sigue si el fichero de verdad es el logo ("logo.png" o "logo" a
  // secas): si la URL tiene otra forma, el segmento anterior no tiene por qué
  // ser un id y todo lo que viene después sería inventado.
  if (!/^logo(\.|$)/.test(fichero)) return null;

  const serieCruda = segs.length >= 3 ? segs[segs.length - 3].toLowerCase() : null;
  const serie = serieCruda && ID_SANO.test(serieCruda) ? serieCruda : null;

  /*
   * El host se busca en la tabla y el id ya ha pasado por ID_SANO ANTES de
   * construir la cadena, porque esto acaba dentro de un url() en un style
   * inline: con un segmento que pudiera traer comillas o paréntesis, la
   * cadena deja de ser una URL y pasa a ser CSS. Ojo con el id que se le
   * pasa: el CRUDO, no el normalizado. La normalización existe para comparar
   * ids entre proveedores ("sv3pt5" y "sv03.5" son el mismo set), pero la URL
   * quiere el que el proveedor escribió.
   */
  const construir = SIMBOLO_POR_HOST[u.hostname];
  const simbolo = construir ? construir(bruto) : null;

  return { id: normalizarId(bruto), serie, simbolo };
}

/** Busca la familia por prefijo más largo; la serie de la URL es el segundo intento. */
function familiaDe(id: string, serie: string | null): Familia | null {
  let mejor = "";
  for (const clave of Object.keys(FAMILIAS)) {
    if (clave.length > mejor.length && id.startsWith(clave)) mejor = clave;
  }
  if (mejor) return FAMILIAS[mejor];
  if (serie && FAMILIAS[serie]) return FAMILIAS[serie];
  return null;
}

/* ------------------------------------------------------------------ */
/* 4. RESPALDO POR HASH                                                */
/* ------------------------------------------------------------------ */

/**
 * FNV-1a. Está copiado (no importado) de `semillaDeSobre` en BoosterPack a
 * conciencia: aquella mezcla el número de apertura en la semilla para que dos
 * sobres seguidos del mismo set salgan distintos, que es lo CONTRARIO de lo
 * que hace falta aquí. El color de una expansión tiene que ser el mismo en la
 * apertura número uno y en la número cuarenta. Y un `utils` que importa de un
 * componente cliente es una dependencia al revés.
 */
function hashDeClave(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * El sobre de una expansión que no está en la tabla. Esto NO es el caso raro:
 * es el caso que se da cada vez que el cron nocturno mete una expansión nueva,
 * y por eso tiene que salir presentable sin que nadie toque nada.
 *
 * Saturación y luminosidad FIJAS (62%/48%): con ellas libres, un tercio de los
 * matices salía lodo y otro tercio flúor. Lo único que sortea el hash es el
 * matiz y la RELACIÓN entre los dos colores: análoga (+34º, sobre de una sola
 * gama) o casi complementaria (+152º, sobre de dos colores en pelea). Sin esa
 * bifurcación todos los sobres desconocidos serían el mismo sobre repintado.
 *
 * Sintaxis con comas en hsl() y no la moderna separada por espacios: no cuesta
 * nada y no depende de qué versión de Safari haya debajo.
 */
function paletaPorHash(clave: string): { a: string; b: string } {
  const h = hashDeClave(clave);
  const tono = h % 360;
  const giro = (h >>> 9) & 1 ? 34 : 152;
  return {
    a: `hsl(${tono}, 62%, 48%)`,
    b: `hsl(${(tono + giro) % 360}, 58%, 54%)`,
  };
}

/* ------------------------------------------------------------------ */
/* 5. LA SALIDA                                                        */
/* ------------------------------------------------------------------ */

export interface ArteSobre {
  /**
   * Custom properties para el elemento del sobre. Todas empiezan por `--sb-`
   * para no chocar con las del sorteo del envoltorio (`--pl-`, `--gl-`,
   * `--br-`, `--sm-`, `--dt-`, `--luz`), que son otra cosa: aquéllas cambian
   * en cada apertura, éstas son la identidad de la expansión y no se mueven.
   *
   * `--sb-sello` NO está aquí: lo compone el componente con `selloCss`, porque
   * un símbolo pasado por prop tiene que ganarle al deducido y no quiero dos
   * sitios distintos construyendo el mismo `url()`.
   */
  vars: Record<string, string>;
  /** URL del símbolo para el sello impreso, o null si no se pudo derivar. */
  sello: string | null;
  /** Id normalizado, o null si no se pudo identificar. Sirve para depurar. */
  id: string | null;
}

/**
 * El arte del sobre de UNA expansión.
 *
 * Es una función total y determinista: la misma expansión da el mismo sobre en
 * cualquier recarga, en cualquier dispositivo y en los dos idiomas, y una
 * expansión desconocida da un sobre razonable en vez de un hueco.
 *
 * `setId` es opcional y hoy nadie lo pasa. Está porque app/page.tsx SÍ tiene
 * el id de la expansión (`currentSetObj.id`) y el día que lo pase, la
 * identificación deja de depender de la forma de la URL del logo. Mientras
 * tanto, el orden de preferencia es: id explícito, id sacado de la URL,
 * nombre de la expansión.
 */
export function arteDeSobre(logo?: string, nombreSet?: string, setId?: string): ArteSobre {
  const ident = identificarExpansion(logo);
  const id = setId ? normalizarId(setId) : (ident?.id ?? null);
  const fam = id ? familiaDe(id, ident?.serie ?? null) : null;

  /*
   * Sin familia, la era por defecto es la MÁS MODERNA y no la media. No es
   * pereza: la única fuente de expansiones desconocidas es el cron, que trae
   * lo que se publica ahora, y lo que se publica ahora es foil.
   */
  const era: EraImpresion = ERAS[fam ? fam.era : "holo"];

  /*
   * El hash cae sobre el id normalizado y sólo usa el nombre cuando no hay
   * logo del que sacarlo (page.tsx pinta entonces el nombre en el sobre, así
   * que algo hay). Ojo: el nombre está traducido y el id no, de modo que una
   * expansión sin logo cambiaría de matiz al cambiar de idioma. Es cosmético y
   * afecta a un caso que hoy no se da; el arreglo de verdad es pasar `setId`.
   */
  const pal =
    fam?.a && fam.b ? { a: fam.a, b: fam.b } : paletaPorHash(id ?? nombreSet?.toLowerCase() ?? "?");

  const vars: Record<string, string> = {
    "--sb-a": pal.a,
    "--sb-b": pal.b,
    "--sb-ang": `${era.ang}deg`,
    "--sb-rayado": era.rayado.toFixed(2),
    "--sb-paso": era.paso.toFixed(2),
    "--sb-lustre": era.lustre.toFixed(2),
    "--sb-t1": `${era.t1}%`,
    "--sb-t2": `${era.t2}%`,
  };

  return { vars, sello: ident?.simbolo ?? null, id };
}

/* ------------------------------------------------------------------ */
/* 6. LA ILUSTRACIÓN REAL, CUANDO LA HAY                               */
/*                                                                     */
/* Todo lo de arriba DIBUJA el sobre. Esto de aquí dice cuándo hay una  */
/* FOTO del sobre de verdad con la que sustituir el dibujo.             */
/*                                                                     */
/* Las dos cosas conviven y van a seguir conviviendo: hoy hay foto de   */
/* UNA expansión de ~171, así que el sobre CSS no es el caso degradado  */
/* sino el NORMAL, y las cuatro secciones anteriores —color, era,       */
/* sello, respaldo por hash— siguen siendo lo que se ve casi siempre.   */
/* Ojo con la tentación de "ya que hay fotos, quitemos el dibujo": las  */
/* ilustraciones no salen de ninguna API, las trae una persona a mano   */
/* (scripts/preparar-sobres.mjs lo explica), mientras que expansiones   */
/* las mete el cron cada noche él solo. La distancia entre las dos      */
/* listas se ensancha, no se estrecha.                                  */
/*                                                                     */
/* EL MANIFIESTO SE IMPORTA, NO SE PIDE (el import va arriba del todo). */
/* src/data/sobres.json lo genera el script y se commitea; importarlo   */
/* lo mete en el bundle (hoy son 38 bytes) y, sobre todo, hace que la    */
/* respuesta sea SÍNCRONA: en el primer render ya se sabe si esta        */
/* expansión tiene foto. Con un fetch habría que pintar el sobre sin     */
/* saberlo y cambiarle la cara después, que es justo lo que no puede     */
/* pasar en esta pantalla.                                               */
/* ------------------------------------------------------------------ */

interface Ilustracion {
  /** Nombre de la carpeta en public/sobres, que es el id TAL CUAL lo escribió el script. */
  carpeta: string;
  /** Cuántos ficheros hay: 1.webp .. N.webp. */
  variantes: number;
}

/**
 * El manifiesto reindexado por id NORMALIZADO.
 *
 * LOS DOS ESPACIOS DE IDS, OTRA VEZ (ver `normalizarId`). Las claves del
 * manifiesto son las carpetas de public/sobres, y ésas son ids de
 * pokemontcg.io: "me5", pero también "me2pt5". Aquí, en cambio, se busca con
 * el id normalizado ("me5", "me2.5"), que es el único que vale para las dos
 * formas de nombrar la misma expansión y por tanto para los dos idiomas.
 * Comparar el normalizado contra la clave cruda funciona de chiripa con "me5"
 * y falla en silencio con "me2pt5": la expansión tendría foto en el disco y no
 * se vería nunca. Por eso la tabla se reconstruye al cargar el módulo con la
 * clave NORMALIZADA y la carpeta CRUDA guardada aparte: se busca por una y se
 * construye la ruta con la otra.
 *
 * Sin prototipo (`Object.create(null)`): la clave viene de un id de expansión,
 * y un id que se llamase "constructor" o "toString" devolvería una función en
 * vez de undefined y reventaría dos líneas más abajo. Cuesta cero evitarlo.
 */
const ILUSTRACIONES: Record<string, Ilustracion> = (() => {
  const tabla: Record<string, Ilustracion> = Object.create(null);
  const crudo = manifiestoSobres as Record<string, { variantes?: number } | undefined>;
  for (const carpeta of Object.keys(crudo)) {
    const variantes = Math.floor(crudo[carpeta]?.variantes ?? 0);
    // ID_SANO no es paranoia repetida: esta carpeta acaba dentro de un `url()`
    // en un atributo style, igual que el sello, y además es un trozo de ruta.
    // Un manifiesto mal generado no puede convertirse en CSS.
    if (variantes > 0 && ID_SANO.test(carpeta)) {
      tabla[normalizarId(carpeta)] = { carpeta, variantes };
    }
  }
  return tabla;
})();

/**
 * La foto que le toca a ESTE sobre, o null si su expansión no tiene ninguna
 * (el caso de ~170 de 171: quien llama tiene que seguir pintando el sobre CSS).
 *
 * LA VARIANTE NO SE SORTEA CON Math.random(). El sobre se re-renderiza tres
 * veces mientras está en pantalla (los setFase de la coreografía) y una
 * variante al azar cambiaría de dibujo A MITAD DEL RASGADO. Sale del mismo
 * hash de cadena que usa el respaldo de color, alimentado con la semilla del
 * sobre, que es estable para un sobre concreto y distinta en el siguiente:
 * dos sobres seguidos de la misma expansión salen con dibujos distintos, que
 * es lo que pasa al abrir una caja de verdad.
 *
 * El resto (`%`) reparte bien pese a que 4 sea potencia de dos, que es cuando
 * los bits bajos de un FNV suelen delatarse: medido sobre 2000 aperturas
 * seguidas de me5 sale 505/495/483/517, un 3,4% de desvío máximo. En una
 * tirada corta sí se agrupa —diez unos en las veinte primeras—, pero eso es
 * el azar, no el hash: desplazar los bits altos antes del resto da la misma
 * foto a lo largo y no arregla la racha.
 *
 * La ruta se compone con una carpeta que ya pasó ID_SANO y con un entero, así
 * que no hay forma de que traiga un carácter que se coma el `url()`.
 */
export function ilustracionDeSobre(id: string | null | undefined, semilla: number): string | null {
  if (!id) return null;
  const entrada = ILUSTRACIONES[id];
  if (!entrada) return null;
  const variante = hashDeClave(`${entrada.carpeta}#${semilla}`) % entrada.variantes;
  return `/sobres/${entrada.carpeta}/${variante + 1}.webp`;
}

/**
 * La URL del sello convertida en el valor de `--sb-sello`, o null si no se
 * puede meter en un CSS con la conciencia tranquila.
 *
 * Esto acaba dentro de un `url()` en un atributo style, o sea que la cadena
 * deja de ser un dato y pasa a ser CSS. Una comilla, un paréntesis o un salto
 * de línea ahí dentro cierran el `url()` y abren una declaración nueva. La
 * derivada de `identificarExpansion` ya viene de una lista blanca de host,
 * pero esta función es también la puerta de las que lleguen por prop desde la
 * base de datos, y ésas no las ha validado nadie.
 *
 * Se valida, no se escapa: una URL de imagen legítima no lleva ninguno de esos
 * caracteres, así que rechazar es gratis y colarse es imposible.
 */
export function selloCss(url?: string | null): string | null {
  if (!url) return null;
  if (!/^https?:\/\/[^\s"'()\\<>]+$/.test(url)) return null;
  return `url("${url}")`;
}
