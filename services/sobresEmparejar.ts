// services/sobresEmparejar.ts
//
// EMPAREJAR UNA EXPANSIÓN CON LA FOTO DE SU SOBRE EN BULBAPEDIA.
//
// ============================================================================
// POR QUÉ ESTO VIVE AQUÍ Y NO DENTRO DEL SCRIPT, QUE ES DONDE NACIÓ
// ============================================================================
//
// Hasta hoy esta lógica era código suelto dentro de
// scripts/bajar-sobres-bulbapedia.mjs, y sólo la ejecutaba una persona a mano.
// Ahora hay DOS consumidores: aquel script (que baja las 171 de golpe y las
// escribe en public/sobres) y el cron nocturno (services/sobresIngest.ts, que
// ve una expansión nueva cada varias semanas y la escribe en Postgres).
//
// LA RAZÓN DE COMPARTIRLO NO ES EL AHORRO DE LÍNEAS. Es que dos copias de esto
// se separan, y cuando se separan el fallo NO es un error: es UN SOBRE EN LA
// EXPANSIÓN EQUIVOCADA. El que falta se ve —queda el sobre dibujado, que para
// eso está— y el equivocado no lo mira nadie dos veces. La cabecera del script
// lo explica con el ejemplo real: "Arceus (TCG)" es la página del POKÉMON, con
// 60 ficheros y ni un sobre; la expansión vive en "Platinum: Arceus (TCG)".
// Un cron que reimplementase el emparejamiento "a la ligera" acabaría poniendo
// un Arceus suelto de sobre.
//
// ============================================================================
// TRES REGLAS QUE ESTE FICHERO NO PUEDE ROMPER
// ============================================================================
//
//   1. CERO IMPORTS. Ni uno. El script .mjs lo carga con el mismo truco que
//      scripts/test-invariantes.mjs (`cargarModulo`: transpila con el SWC de
//      Next y ejecuta con `new Function`), y ese cargador SÓLO resuelve rutas
//      relativas acabadas en ".ts", exige que la dependencia esté precargada a
//      mano y NO sabe resolver JSON. O sea: un `import ... from "./otro"` aquí
//      obliga a tocar el cargador, y un `import mapa from "../src/data/x.json"`
//      directamente no arranca. Por eso el mapa a mano de
//      src/data/sobres-bulbapedia.json entra POR PARÁMETRO y no por import.
//
//   2. TODO PURO. Sin fetch, sin fs, sin Date.now(). Lo impuro —pedir a la
//      API, bajar bytes, convertir con sharp, escribir— se queda en cada
//      consumidor, que son justo las partes en las que los dos difieren. Lo
//      que se comparte es la DECISIÓN, que es lo que tiene que ser idéntico.
//      De regalo: es la primera vez que este emparejamiento se puede probar
//      sin red, y por eso hay invariantes suyos en scripts/test-invariantes.mjs.
//
//   3. NADA DE ESTO CAMBIA DE COMPORTAMIENTO. Se movió tal cual. Si al leerlo
//      te parece que alguna decisión es discutible (y varias lo son), la
//      prueba de que no se ha tocado es que el informe del script
//      (`--solo-informe`) da el MISMO md5 que antes de la extracción.
//
// ============================================================================
// EL EMPAREJAMIENTO, EN CORTO
// ============================================================================
//
// Nuestro id es "sv8" y la página se llama "Surging Sparks (TCG)". Hacen falta
// DOS llaves y las dos:
//
//   1. LA PÁGINA: "<nombre> (TCG)" por defecto, con las redirecciones de la
//      wiki, y un mapa a mano para lo que no cuadra.
//   2. EL NOMBRE DEL FICHERO: que la página sea la buena NO basta, porque trae
//      31 ficheros y 27 son iconos de ataque. El fichero tiene que llamarse
//      "<algo nuestro> Booster <lo que sea>".
//
// Más tres cedazos que salen gratis: la proporción (un sobre es alto y
// estrecho), el idioma (fuera "… Chinese", "… ES", "… KO") y la unicidad (si
// dos expansiones se pelean por el mismo fichero, no se lo lleva ninguna).
//
// La unicidad es la única pieza que NO está aquí, y a propósito: es un barrido
// GLOBAL entre las 171 expansiones y el cron, que ve una o dos por noche, no
// puede reproducirlo. Cada consumidor pone su versión y services/sobresIngest.ts
// explica en qué se parece la suya y en qué no.

/* ------------------------------------------------------------------ *
 * FORMA DE LA PROPORCIÓN
 * ------------------------------------------------------------------ */

/**
 * La proporción que components/BoosterPack.tsx da por hecha: 780/1426 = 1,828
 * de alto por ancho. No es un gusto: es el `aspect-ratio` del contenedor del
 * sobre (RATIO_ARTE allí), y la foto se pinta encima como fondo.
 */
export const RATIO = 1426 / 780;

/** Fuera de esta horquilla no es la foto de un sobre: es una caja, un
 *  expositor o un recorte del dibujo. */
export const RATIO_MIN = 1.65;
export const RATIO_MAX = 2.0;

/**
 * Por debajo de esto la imagen es un icono, no un escaneo.
 *
 * 140 px es BAJO a propósito y es la frontera entre dos males. Muchos escaneos
 * de 2005-2018 no llegan a 200 px de ancho (Ultra Prism tiene 144, Detective
 * Pikachu 187, Camino Campeón 187) y a 140 se aceptan: el sobre se pinta a
 * ~280 px, o sea que se ven blandos. La alternativa era dejar esas expansiones
 * con el sobre dibujado, y la petición era justo la contraria.
 */
export const ANCHO_MINIMO = 140;

/** Variantes por expansión. Con tres ya no se repite el dibujo dos sobres
 *  seguidos, que es todo lo que se le pedía a la variedad. */
export const MAX_VARIANTES = 3;

/** Cuántas candidatas de más se piden por si alguna cae por proporción. */
export const CANDIDATAS_EXTRA = 3;

/* ------------------------------------------------------------------ *
 * VOCABULARIO
 * ------------------------------------------------------------------ */

/** Palabras que descalifican un fichero aunque el nombre encaje. */
export const PALABRAS_NO: ReadonlySet<string> = new Set([
  // no es un sobre suelto
  "box", "case", "display", "bundle", "tin", "blister", "sleeve",
  // no es la foto del sobre sino el dibujo suelto o un montaje
  "art", "scan", "illustration", "logo", "mockup", "sampling",
]);

/* Marcas de idioma en el nombre del fichero. "EN" NO está: ése es el que
 * queremos, y hay expansiones (Rayo Negro) donde es la única forma de nombrar
 * la versión internacional. */
export const IDIOMAS_NO: ReadonlySet<string> = new Set([
  "br", "de", "es", "fr", "it", "ko", "zh", "jp", "ja", "cn", "kr", "tw", "ru",
  "pl", "nl", "pt",
  "chinese", "korean", "japanese", "indonesian", "thai", "german", "french",
  "spanish", "italian", "portuguese", "russian", "dutch", "polish",
  "taiwanese", "traditional", "simplified", "brazilian",
]);

/* Palabras de tirada, no de dibujo: "Base Set Booster Charizard Unlimited" y
 * "… Shadowless" son el MISMO sobre con otra marca de imprenta. Se quitan para
 * decidir si dos ficheros son la misma ilustración, no del nombre. */
export const TIRADAS: ReadonlySet<string> = new Set([
  "long", "shadowless", "unlimited", "1st", "edition", "copy", "new", "old",
]);

export const EXTENSIONES: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "webp"]);

/* ------------------------------------------------------------------ *
 * TIPOS
 * ------------------------------------------------------------------ */

/** Lo único que hace falta saber de una expansión para emparejarla. */
export interface SetParaSobre {
  id: string;
  name: string;
}

/** Una entrada del mapa a mano de src/data/sobres-bulbapedia.json ("manual"). */
export interface EntradaManual {
  /** Título de la página en Bulbapedia, cuando "<nombre> (TCG)" no vale. */
  pagina?: string;
  /** Prefijos extra con los que puede empezar el nombre del fichero. */
  prefijos?: string[];
  /** true: esta expansión no tuvo sobre suelto y no hay que preguntar por ella. */
  omitir?: boolean;
  /** Por qué. Se imprime y se guarda; nunca se decide con él. */
  motivo?: string;
}

export type MapaManual = Record<string, EntradaManual | undefined>;

export interface Prefijo {
  texto: string;
  /** Si además del patrón "<texto> Booster …" se acepta "<texto> pack" a secas. */
  permitePack: boolean;
}

/** Un fichero de la wiki que parece el sobre de esta expansión. */
export interface Candidata {
  /** Título completo, con "File:" delante, tal y como lo devuelve la API. */
  titulo: string;
  /** Lo que sigue a "<prefijo> Booster": "charizard", "" si no hay nada. */
  resto: string;
  /** `resto` sin las palabras de tirada: dos ficheros con la misma clave son
   *  el mismo dibujo con otra marca de imprenta. */
  clave: string;
  /** Con qué prefijo encajó. Sólo para depurar. */
  prefijo: string;
}

/** Lo que se sabe de una página de la wiki después de seguir sus alias. */
export interface PaginaDeSobre {
  /** El título FINAL, tras normalización y redirección. Es el que va a
   *  `prefijosDe` como prefijo, así que no es informativo. */
  titulo: string;
  existe: boolean;
  /** Títulos completos de sus ficheros, con "File:" delante. */
  ficheros: string[];
}

/**
 * El trozo de una respuesta de `action=query&prop=images` que aquí se mira.
 *
 * Escrito a mano y no como `any` porque viene de un tercero: si mañana la wiki
 * deja de mandar `redirects`, prefiero que el compilador obligue a mirar qué
 * pasa con el emparejamiento antes que enterarme por un sobre torcido. Todo
 * opcional porque la API omite lo que no aplica.
 */
export interface RespuestaDePaginas {
  query?: {
    normalized?: { from?: string; to?: string }[];
    redirects?: { from?: string; to?: string }[];
    pages?: { title?: string; missing?: boolean; images?: { title?: string }[] }[];
  };
}

/** Lo que la API cuenta de un fichero antes de bajarlo. */
export interface FormaFichero {
  url?: string | null;
  ancho?: number | null;
  alto?: number | null;
  mime?: string | null;
}

/* ------------------------------------------------------------------ *
 * NORMALIZACIÓN
 * ------------------------------------------------------------------ */

/**
 * Deja una cadena en minúsculas, sin acentos y con un solo espacio entre
 * palabras. Se aplica IGUAL al nombre de la expansión y al del fichero, que es
 * lo único que hace comparables "Pokémon GO" y "Pokémon_GO_Booster.jpg", o
 * "McDonald's Collection 2021" y "McDonalds Collection 2021 Booster.jpg".
 *
 * El apóstrofo se BORRA en vez de convertirse en espacio como el resto de la
 * puntuación, y no es un detalle: quien sube el fichero a la wiki escribe
 * "McDonalds", sin él. Convertido en espacio queda "mcdonald s collection"
 * contra "mcdonalds collection", y las dos colecciones de McDonald's que sí
 * tienen sobre se caían por una comilla.
 *
 * NADA DE MIRAR ATRÁS en las expresiones regulares de este fichero, aquí y en
 * utils/sobreArte.ts por el mismo motivo: el lookbehind revienta al PARSEAR en
 * Safari anterior a 16.4. Esto hoy sólo corre en servidor, pero es una regla
 * del repositorio y no cuesta nada respetarla.
 */
export function normaliza(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ *
 * LLAVE 1: LA PÁGINA
 * ------------------------------------------------------------------ */

/**
 * El título de la página de Bulbapedia por la que hay que preguntar.
 *
 * Por defecto "<nombre> (TCG)". El mapa a mano manda cuando lo hay, y es lo
 * que salva los casos en que el nombre del repositorio y el de la wiki no
 * coinciden ("HS—Unleashed" es "Unleashed (TCG)") o en que el título obvio es
 * OTRA COSA ("Dragon (TCG)" existe y no es EX Dragon).
 *
 * Devuelve null si la expansión está marcada `omitir`: entonces no hay que
 * preguntar nada, ni hoy ni nunca. Son promos, Trainer Gallery, Shiny Vault,
 * kits y energías — productos que jamás se vendieron en sobre suelto.
 */
export function tituloDePagina(
  set: SetParaSobre,
  manual?: EntradaManual,
): string | null {
  if (manual?.omitir) return null;
  return manual?.pagina ?? `${set.name} (TCG)`;
}

/**
 * QUÉ PÁGINA CONTESTÓ DE VERDAD LA WIKI, que es la otra mitad de la llave 1.
 *
 * ============================================================================
 * POR QUÉ ESTO TAMBIÉN TIENE QUE ESTAR AQUÍ
 * ============================================================================
 *
 * `tituloDePagina` dice por cuál PREGUNTAR; esto dice cuál CONTESTÓ. La wiki
 * tiene dos formas de decir "lo que has pedido en realidad se llama de otra
 * manera" —`normalized` (mayúsculas, guiones bajos) y `redirects` (una página
 * que apunta a otra)— y sin seguirlas "Base (TCG)" no encuentra
 * "Base Set (TCG)".
 *
 * Y EL TÍTULO FINAL NO ES DECORATIVO: entra en `prefijosDe` como PREFIJO —la
 * regla "sólo si es más específico que nuestro nombre"—, o sea que decide qué
 * ficheros se aceptan. Estaba escrito dos veces (el script y el cron) y era el
 * único trozo del emparejamiento que se había quedado fuera de este módulo. Dos
 * copias de esto no divergen en un mensaje de log: divergen en un prefijo, y un
 * prefijo distinto es UN SOBRE EN LA EXPANSIÓN EQUIVOCADA, que es el fallo caro.
 *
 * LO QUE NO ESTÁ AQUÍ, y a propósito: pedir. El script tiene caché en disco,
 * lotes de 50 y persigue el `continue` hasta 8 rondas; el cron no tiene disco,
 * va de 6 en 6 y se corta por presupuesto. Eso es transporte y difiere. Lo que
 * comparten es qué hacer con la respuesta, que es esto.
 *
 * MUTA LOS DOS MAPAS que recibe (`destinoDe`: pedido -> título actual;
 * `acumulado`: título final -> lo que se sabe de esa página) porque se llama una
 * vez por ronda de `continue` y lo que llega es acumulativo.
 */
export function acumularPaginas(
  respuesta: RespuestaDePaginas,
  destinoDe: Map<string, string>,
  acumulado: Map<string, PaginaDeSobre>,
): void {
  for (const n of respuesta.query?.normalized ?? []) {
    if (!n.from || !n.to) continue;
    for (const [k, v] of destinoDe) if (v === n.from) destinoDe.set(k, n.to);
  }
  for (const rd of respuesta.query?.redirects ?? []) {
    if (!rd.from || !rd.to) continue;
    for (const [k, v] of destinoDe) if (v === rd.from) destinoDe.set(k, rd.to);
  }
  for (const p of respuesta.query?.pages ?? []) {
    const titulo = p.title;
    if (!titulo) continue;
    const previo = acumulado.get(titulo) ?? {
      titulo,
      existe: !p.missing,
      ficheros: [] as string[],
    };
    for (const im of p.images ?? []) if (im.title) previo.ficheros.push(im.title);
    acumulado.set(titulo, previo);
  }
}

/**
 * Cierra el paso anterior: por cada título PEDIDO, qué se sabe de la página a
 * la que llevó.
 *
 * Un título que no aparezca en `acumulado` sale como `existe: false` con su
 * título final y sin ficheros. OJO A QUIEN LLAME: eso significa "la wiki
 * contestó que no hay tal página", no "la wiki no contestó". Los dos casos se
 * parecen mucho desde fuera y NO son lo mismo —uno es un negativo bueno para
 * meses y el otro es un martes por la noche—, así que quien pida tiene que
 * saber si la respuesta llegó entera antes de creerse esto.
 */
export function resolverPaginas(
  titulos: readonly string[],
  destinoDe: ReadonlyMap<string, string>,
  acumulado: ReadonlyMap<string, PaginaDeSobre>,
): Map<string, PaginaDeSobre> {
  const salida = new Map<string, PaginaDeSobre>();
  for (const t of titulos) {
    const final = destinoDe.get(t) ?? t;
    salida.set(t, acumulado.get(final) ?? { titulo: final, existe: false, ficheros: [] });
  }
  return salida;
}

/* ------------------------------------------------------------------ *
 * LLAVE 2: EL NOMBRE DEL FICHERO
 * ------------------------------------------------------------------ */

/**
 * Los prefijos con los que puede empezar el nombre de un fichero para que se
 * acepte como sobre de ESTA expansión.
 *
 * `permitePack` distingue dos cosas que parecen la misma. Bulbapedia llama
 * "<algo> Booster <lo que sea>" a los sobres internacionales y "<código>
 * <nombre japonés> pack" a los japoneses. El problema es que algunos códigos
 * japoneses COINCIDEN con nuestros ids: "SV3 pack.png" es el sobre japonés de
 * Obsidian Flames y "SV3 Booster Charizard.png" el internacional. Por eso el
 * patrón "… pack" sólo se acepta detrás del NOMBRE completo de la expansión
 * (que es lo que hace falta para POP Series, cuyos sobres se llaman así) y
 * nunca detrás del id.
 */
export function prefijosDe(
  set: SetParaSobre,
  tituloPagina?: string | null,
  extra?: readonly string[] | null,
): Prefijo[] {
  const lista: Prefijo[] = [];
  const mete = (texto: string | null | undefined, permitePack: boolean) => {
    const t = normaliza(texto ?? "");
    if (t && !lista.some((p) => p.texto === t)) lista.push({ texto: t, permitePack });
  };

  mete(set.name, true);
  mete(set.id, false);

  /* El título de la página sólo vale si es MÁS ESPECÍFICO que nuestro nombre.
   * "Base" -> "Base Set" sí (la wiki completa el nombre). "McDonald's
   * Collection 2011" -> "McDonald's Collection" NO: ahí la wiki junta nueve
   * colecciones en una página y su sobre no es el de 2011. */
  const limpio = (tituloPagina ?? "").replace(/\s*\(TCG\)\s*$/i, "");
  const nom = normaliza(set.name);
  const pag = normaliza(limpio);
  if (pag && nom && pag.startsWith(nom)) mete(limpio, true);

  for (const p of extra ?? []) mete(p, false);
  return lista;
}

/**
 * ¿Es este fichero el sobre de la expansión de esos prefijos? Devuelve null si
 * no, y si sí, con qué se queda y bajo qué clave de "misma ilustración".
 */
export function analizarFichero(
  tituloFichero: string,
  prefijos: readonly Prefijo[],
): Candidata | null {
  const sinEspacio = tituloFichero.replace(/^File:/i, "");
  const m = /^(.*)\.([A-Za-z0-9]+)$/.exec(sinEspacio);
  if (!m) return null;
  if (!EXTENSIONES.has(m[2].toLowerCase())) return null;

  const nombre = normaliza(m[1]);

  for (const p of prefijos) {
    // "… pack" a secas y nada más: ni una palabra detrás. Es el caso de "POP
    // Series 1 pack.png", y ser tan estricto es lo que impide que se cuele
    // "SV2a Pokémon Card 151 pack.png" por un prefijo demasiado corto.
    if (p.permitePack && nombre === p.texto + " pack") {
      return { titulo: tituloFichero, resto: "", clave: "", prefijo: p.texto };
    }

    const cabeza = p.texto + " booster";
    if (nombre !== cabeza && !nombre.startsWith(cabeza + " ")) continue;

    const resto = nombre.slice(cabeza.length).trim();
    const palabras = resto ? resto.split(" ") : [];
    if (palabras.some((w) => PALABRAS_NO.has(w))) return null;
    if (palabras.some((w) => IDIOMAS_NO.has(w))) return null;

    // Dos ficheros con la misma clave son el mismo dibujo con otra marca de
    // imprenta; sólo se guarda uno.
    const clave = palabras.filter((w) => !TIRADAS.has(w)).join(" ");
    return { titulo: tituloFichero, resto, clave, prefijo: p.texto };
  }
  return null;
}

/**
 * Las candidatas de una expansión, ya deduplicadas, ordenadas y cortadas.
 *
 * ERA CÓDIGO SUELTO EN MITAD DEL PROGRAMA del script, y es la parte que más
 * fácil se pierde al extraer: no se veía como una función, así que un segundo
 * consumidor la habría reescrito "mirando lo que hace" y se habría dejado el
 * orden, que es lo que menos parece importar y más importa.
 *
 * EL ORDEN ES PARTE DEL CONTRATO, no una preferencia estética. Primero los
 * nombres con menos palabras detrás de "Booster" ("Crown Zenith Booster" antes
 * que "… Booster Pikachu Full"), luego alfabético. Que sea BUENO importa
 * —el sobre genérico suele ser el más representativo—, pero que sea ESTABLE
 * importa igual: la variante 1 de una expansión tiene que ser la misma en la
 * próxima ejecución, porque el número de variante es lo que acaba en la URL
 * que sirve la foto, y en el CDN.
 */
export function candidatasDe(
  set: SetParaSobre,
  ficherosDeLaPagina: readonly string[],
  tituloPagina?: string | null,
  manual?: EntradaManual,
): Candidata[] {
  const prefijos = prefijosDe(set, tituloPagina, manual?.prefijos);
  const vistas = new Set<string>();
  const candidatas: Candidata[] = [];

  for (const f of ficherosDeLaPagina) {
    const a = analizarFichero(f, prefijos);
    if (!a) continue;
    if (vistas.has(a.clave)) continue; // el mismo dibujo con otra marca de imprenta
    vistas.add(a.clave);
    candidatas.push(a);
  }

  candidatas.sort((a, b) => {
    const na = a.resto ? a.resto.split(" ").length : 0;
    const nb = b.resto ? b.resto.split(" ").length : 0;
    return na - nb || a.titulo.localeCompare(b.titulo, "en");
  });

  return candidatas.slice(0, MAX_VARIANTES + CANDIDATAS_EXTRA);
}

/* ------------------------------------------------------------------ *
 * CEDAZO DE FORMA
 * ------------------------------------------------------------------ */

/**
 * ¿Tiene esta imagen forma de sobre? Devuelve null si pasa, y si no, el motivo
 * EN EL MISMO TEXTO que el script lleva imprimiendo desde siempre (va al
 * informe, y el informe se compara md5 a md5 para saber que nada ha cambiado).
 *
 * Se decide con los números que da la API SIN BAJAR la imagen, que es la parte
 * amable con una wiki que se paga con donaciones: un descarte que cuesta cero
 * bytes es un descarte gratis.
 *
 * OJO AL ANCHO ÚTIL: no se mide `ancho` a secas sino `min(ancho, alto/RATIO)`,
 * o sea el ancho que QUEDARÁ después de recortar a la proporción del sobre.
 * Una imagen de 300x500 tiene 300 px de ancho y sólo 273 útiles.
 */
export function pasaElFiltro(info?: FormaFichero | null): string | null {
  if (!info?.url) return "la API no da URL";

  /* HAY URL PERO NO MEDIDAS: la API contestó a medias. Sale por la rama de la
   * proporción y con el texto "proporción NaN", que es LITERALMENTE lo que el
   * script imprimía antes de que esto se extrajera a una función (`i.alto /
   * i.ancho` con un `undefined` da NaN, y `!(NaN >= RATIO_MIN)` es cierto).
   *
   * Se deja así aposta y merece las cuatro líneas: devolver aquí "la API no da
   * URL" —que es lo que parecía razonable al mover el código— sería MENTIR
   * sobre lo que pasó (la URL sí estaba) y, sobre todo, sería una diferencia de
   * comportamiento dentro de una función que este fichero promete haber movido
   * TAL CUAL. Ningún caso de la caché lo toca hoy, o sea que el informe salía
   * idéntico igualmente: la clase de divergencia que no se ve venir. */
  const ancho = info.ancho ?? NaN;
  const alto = info.alto ?? NaN;

  const ratio = alto / ancho;
  if (!(ratio >= RATIO_MIN && ratio <= RATIO_MAX)) {
    return `proporción ${ratio.toFixed(2)}, no tiene forma de sobre`;
  }
  if (Math.min(ancho, alto / RATIO) < ANCHO_MINIMO) {
    return `sólo ${ancho}px de ancho`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * LO QUE LA HOJA DE ESTILOS NECESITA SABER DE LA FOTO
 * ------------------------------------------------------------------ */

/**
 * El `background-size` con el que hay que pintar una foto de proporción
 * cualquiera dentro del sobre.
 *
 * ============================================================================
 * ESTO ES LO QUE SUSTITUYE A `sharp`, Y POR QUÉ NO ES `cover`
 * ============================================================================
 *
 * El script recorta cada foto a 780/1426 exactos con sharp
 * (`fit:"cover", position:"top"`). El cron NO PUEDE hacer eso: sharp no es
 * dependencia de este proyecto —sólo llega prestado por Next— y meter un
 * binario nativo en una función serverless por un recorte es desproporcionado.
 * Así que el recorte se hace en CSS. Hasta aquí, el plan.
 *
 * LA TENTACIÓN ERA PONER `cover` Y YA. Es falso, y falla justo donde se ve.
 * La foto se pinta en DOS elementos que se separan al rasgar: `.sobre__cuerpo`
 * (inset:0, o sea W x 1,8282·W) y `.sobre__tapa-dedo` (dentro de una tapa que
 * mide `--tapa-h` = 5,2%, o sea W x 0,0951·W). `cover` se calcula POR
 * ELEMENTO, con `max(elemW/imgW, elemH/imgH)`, y esas dos cajas NO tienen la
 * misma proporción:
 *
 *     r = alto/ancho de la foto
 *     el CUERPO escala por ancho  <=>  r >= 1,8282
 *     la TAPA   escala por ancho  <=>  r >= 0,0951   -> SIEMPRE
 *
 * O sea que con r >= 1,8282 las dos coinciden y `cover` sería idéntico a lo de
 * hoy... y con r < 1,8282 el cuerpo escala por ALTO y la tapa por ANCHO: la
 * MISMA imagen a DOS tamaños distintos en las dos mitades que se separan, y el
 * desajuste cae exactamente en la línea de rasgado. Medido: a r = 1,75 la tapa
 * enseña la foto un 4,5% más pequeña; a r = 1,65 —que el filtro de aquí arriba
 * ACEPTA— un 11%, con el crimpado y la insignia descuadrados a ojo. Y no es un
 * caso raro: de las 481 candidatas que hay en la caché del script, 161 (un
 * tercio) están por debajo de 1,8282 EN CRUDO. Lo que hay hoy en disco no lo
 * está sólo porque sharp ya las normalizó.
 *
 * LO QUE SÍ VALE: una anchura EXPLÍCITA, la misma para las dos cajas, que es
 * lo que reproduce el resultado de `cover` del cuerpo en los dos sitios.
 * Como las dos cajas miden lo mismo de ancho, un porcentaje de anchura ya es
 * un valor común, y `auto` en vertical deja que mande la proporción del
 * fichero (que es la misma imagen en los dos).
 *
 *     X% = 100 · max(1, RATIO / r)
 *
 *   · r >= RATIO (foto alargada):  X = 100  ->  "100% auto", que es LA REGLA
 *     DE SIEMPRE, literalmente la misma cadena. Sobra por abajo y lo recorta
 *     el `overflow:hidden` que ya tienen los dos elementos.
 *   · r <  RATIO (foto chata):     X > 100  ->  la foto se pinta más ancha que
 *     el sobre, sobra por los lados, y `background-position: 50% 0` la centra
 *     y la ancla arriba. Que es exactamente lo que hace sharp con
 *     `position:"top"`: lo que se pierde nunca es el crimpado.
 *
 * Devuelve null cuando X sale 100, para que en ese caso NO se emita ninguna
 * variable y la regla caiga en su valor por defecto: así la rama de siempre no
 * pasa por aquí ni de casualidad.
 */
export function tamanoDeFondo(ancho: number, alto: number): string | null {
  if (!(ancho > 0) || !(alto > 0)) return null;
  const r = alto / ancho;
  if (!(r < RATIO)) return null; // r >= RATIO (o NaN): la regla de siempre
  const x = (100 * RATIO) / r;
  // Tres decimales: a 360 px de sobre eso es una milésima de píxel, y evita
  // meter un flotante largo dentro de un atributo style.
  return `${x.toFixed(3)}% auto`;
}
