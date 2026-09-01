// services/sobresEsquema.ts
//
// Esquema del ALMACÉN DE FOTOS DE SOBRE que llena el cron nocturno.
//
// Vive en su propio módulo y sin importar nada, por el mismo motivo que
// services/idiomaEsquema.ts: lo necesitan dos sitios —la ruta de migración
// app/migrate-sobres, que se ejecuta a mano, y el propio cron, que se asegura
// de que las tablas existen antes de escribir—. Dos declaraciones copiadas se
// desincronizan, y el fallo no aparece hasta que alguien consulta una columna
// que en su base no existe.
//
// ============================================================================
// POR QUÉ LAS FOTOS VAN A POSTGRES Y NO A public/sobres
// ============================================================================
//
// Porque en Vercel `public/` es DE SÓLO LECTURA en ejecución: se hornea en el
// build y un cron no puede escribir un fichero ahí. Y aunque pudiera, no
// serviría: utils/sobreArte.ts importa el manifiesto
// (`import manifiestoSobres from "../src/data/sobres.json"`) en TIEMPO DE
// COMPILACIÓN, así que una foto nueva en disco seguiría sin existir para la
// aplicación hasta el siguiente despliegue.
//
// Es exactamente el mismo problema que ya resolvieron dos veces las
// traducciones (`set_translations`) y los precios (`card_prices`), y se
// resuelve igual: el cron escribe en Postgres y la aplicación lo lee. No hay
// patrón nuevo que inventar aquí.
//
// ============================================================================
// POR QUÉ SON DOS TABLAS Y NO UNA
// ============================================================================
//
// Porque una de ellas guarda BYTEA de 30 KB a 1,3 MB por fila y la otra se
// consulta EN CADA CARGA DE LA TIENDA. Mezclarlas obligaría a que la consulta de la
// tienda tocase la tabla pesada; separadas, `set_pack_art_estado` es una tabla
// de texto de ~170 filas que cabe entera en memoria. Es el mismo argumento que
// services/idiomaBD.ts escribe sobre su "consulta deliberadamente flaca", sólo
// que allí se resolvía no seleccionando la columna gorda y aquí se resuelve no
// teniéndola delante.
//
// Y hay un segundo motivo, que es el que de verdad manda: LA TABLA DE ESTADO
// GUARDA TAMBIÉN LOS NEGATIVOS. De las 171 expansiones, 41 no tienen sobre
// suelto y no lo van a tener nunca (promos Black Star, Trainer Gallery, Shiny
// Vault, Trainer Kits, energías, McDonald's, POP Series). Sin una fila que
// diga "ya pregunté y no hay", el cron volvería a preguntar por las 41 cada
// noche: 40 peticiones diarias eternas contra una wiki que se paga con
// donaciones, para un trabajo útil de ~3 peticiones AL MES. Guardar el
// negativo no es un adorno: es casi todo el ahorro.
//
// TIMESTAMP SIN ZONA, como el resto del esquema: las funciones de Vercel
// corren en UTC.

export const SENTENCIAS_SOBRES: readonly string[] = [
  /* ------------------------------------------------------------------ *
   * set_pack_art — LOS BYTES
   * ------------------------------------------------------------------
   *
   * Una fila por (expansión, variante). Las variantes van SEGUIDAS DESDE 1,
   * que es el contrato que utils/sobreArte.ts da por hecho para componer la
   * URL, y por eso quien escribe aquí las numera 1..N sin huecos.
   *
   * `bytes` es la MINIATURA que sirve la wiki (`iiurlwidth`), no el original.
   *
   * CUÁNTO PESA DE VERDAD, MEDIDO Y NO ESTIMADO, porque la primera versión de
   * este comentario decía "20-120 KB" y con ese número se puso un tope que
   * rechazaba la era moderna entera. Sobre las 363 miniaturas de 560 px que el
   * script tiene en caché —las mismas URLs que pide el cron—: mediana 138 KB,
   * percentil 90 888 KB, máximo 1.287 KB. La diferencia es el FORMATO: los
   * escaneos viejos son JPEG y los sobres de 2023 en adelante se suben en PNG
   * con transparencia, y un PNG de 560 px de un sobre pesa lo que pesa. O sea
   * que una expansión moderna son ~2,7 MB en tres filas, y el almacén crece
   * unos 20-30 MB al año (salen 6-10 expansiones anuales). Postgres los guarda
   * fuera de la fila (TOAST), así que ninguna consulta que no pida `bytes` los
   * lee, y del CDN salen una vez por imagen y región.
   *
   * `ancho` y `alto` NO son decorativos y no se pueden quitar: la foto llega
   * CRUDA de la wiki, con la proporción que tenga, y el recorte a 780/1426 lo
   * hace la hoja de estilos (`tamanoDeFondo` en services/sobresEmparejar.ts
   * explica cómo y por qué no vale `cover`). Sin estos dos números no hay
   * forma de calcular ese recorte. Aquí no hay `sharp` que valga: no es
   * dependencia del proyecto y meter un binario nativo en una función
   * serverless por un recorte es desproporcionado.
   *
   * `pagina`, `fichero` y `origen` son LA AUDITORÍA, y en este problema la
   * auditoría es media solución. El fallo temido de todo esto no es un error
   * sino UN SOBRE EN LA EXPANSIÓN EQUIVOCADA, que no salta en ningún log y no
   * lo mira nadie dos veces; cuando alguien lo vea, la única pregunta útil
   * será "¿de dónde salió esta foto?" y la respuesta tiene que estar en la
   * misma fila.
   *
   * SIN FOREIGN KEY contra `sets`, igual que `set_translations` y por lo
   * mismo: los crones son independientes y el de ingesta se corta por tiempo,
   * así que una expansión puede estar a medias cuando éste la visita. Y un
   * ON DELETE CASCADE dejaría que una resiembra borrase en silencio fotos que
   * costaron peticiones a la wiki.
   */
  `CREATE TABLE IF NOT EXISTS set_pack_art (
     set_id    TEXT  NOT NULL,
     variante  INT   NOT NULL,
     mime      TEXT  NOT NULL,
     ancho     INT   NOT NULL,
     alto      INT   NOT NULL,
     bytes     BYTEA NOT NULL,
     pagina    TEXT,
     fichero   TEXT,
     origen    TEXT,
     creado_en TIMESTAMP NOT NULL DEFAULT NOW(),
     PRIMARY KEY (set_id, variante),
     CONSTRAINT set_pack_art_variante_desde_1 CHECK (variante >= 1),
     CONSTRAINT set_pack_art_forma_valida CHECK (ancho > 0 AND alto > 0)
   )`,

  /* UN FICHERO, UNA EXPANSIÓN — y aquí es la BASE DE DATOS quien lo impone.
   *
   * El script de descarga hace este cedazo con un barrido global: junta las
   * candidatas de las 171 expansiones y, si dos se pelean por el mismo
   * fichero, no se lo lleva ninguna. El cron NO PUEDE hacer ese barrido: ve
   * una expansión por noche y no tiene con qué compararla.
   *
   * Este índice es lo más parecido que hay, y en un sentido es MEJOR: el
   * barrido del script sólo compara las de esa ejecución, y esto compara
   * contra todo lo que se haya escrito desde el principio de los tiempos. Si
   * el mapa a mano se equivoca y dos expansiones acaban apuntando al mismo
   * "File:… Booster …", la segunda no entra y el cron lo anota como conflicto
   * en vez de pisar la foto de la primera.
   *
   * Parcial (`WHERE fichero IS NOT NULL`) porque una fila puesta a mano sin
   * procedencia no debe bloquear a nadie. */
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_set_pack_art_fichero
     ON set_pack_art (fichero) WHERE fichero IS NOT NULL`,

  /* ------------------------------------------------------------------ *
   * set_pack_art_estado — LA COLA Y EL DIARIO
   * ------------------------------------------------------------------
   *
   * Una fila por expansión VISITADA, tenga foto o no. Es a la vez:
   *
   *   · la cola del cron (se visita siempre lo más viejo primero, así la
   *     sincronización es reanudable y no necesita saber por dónde iba), y
   *   · la memoria de los NEGATIVOS, que es lo que impide repreguntar por las
   *     41 que nunca van a tener sobre.
   *
   * `revisado_en` es NOT NULL con la fecha cero en vez de NULL para que
   * "nunca revisada" sea un VALOR: así la cola es un recorrido de rango del
   * índice y no necesita NULLS FIRST. Copiado tal cual de `set_translations`,
   * donde ya funciona.
   *
   * `motivo` es TEXTO LIBRE y `estado` es el enumerado. El estado decide
   * cuándo se vuelve a preguntar; el motivo es lo que lee una persona cuando
   * quiere arreglarlo a mano en src/data/sobres-bulbapedia.json. No se decide
   * nunca con el motivo.
   *
   * `variantes` es informativo. LA VERDAD DE CUÁNTAS FOTOS HAY ES
   * `set_pack_art`, y services/sobresBD.ts la cuenta allí a propósito: dos
   * tablas que dicen lo mismo acaban diciendo cosas distintas, y de las dos
   * prefiero que mande la que tiene los bytes.
   */
  `CREATE TABLE IF NOT EXISTS set_pack_art_estado (
     set_id      TEXT PRIMARY KEY,
     estado      TEXT NOT NULL DEFAULT 'pendiente',
     motivo      TEXT,
     pagina      TEXT,
     variantes   INT  NOT NULL DEFAULT 0,
     intentos    INT  NOT NULL DEFAULT 0,
     revisado_en TIMESTAMP NOT NULL DEFAULT '1970-01-01 00:00:00',
     cambiado_en TIMESTAMP
   )`,

  // La cola: lo más viejo primero.
  `CREATE INDEX IF NOT EXISTS idx_set_pack_art_cola
     ON set_pack_art_estado (revisado_en)`,
];

/**
 * Estados de `set_pack_art_estado.estado`.
 *
 * SÓLO SE LEE `OK` desde la aplicación —y ni eso: la tienda cuenta filas de
 * `set_pack_art`—. El resto son anotaciones del cron para no repetir trabajo y
 * para poder explicarle a una persona por qué una expansión sigue con el sobre
 * dibujado.
 */
export const ESTADOS_SOBRE = {
  /** Tiene foto: hay filas en `set_pack_art`. */
  OK: "ok",
  /**
   * El mapa a mano dice que esta expansión NO tuvo sobre suelto. Promos,
   * Trainer Gallery, Shiny Vault, kits, energías. No se pregunta NUNCA MÁS:
   * cero peticiones a la wiki, ni hoy ni dentro de diez años.
   */
  OMITIDA: "omitida",
  /** No existe la página "<nombre> (TCG)" ni la que dice el mapa a mano. */
  SIN_PAGINA: "sin_pagina",
  /** La página existe pero ninguno de sus ficheros parece su sobre. */
  SIN_CANDIDATAS: "sin_candidatas",
  /** Había candidatas y ninguna tiene forma de sobre (proporción o tamaño). */
  FILTRO_FORMA: "filtro_forma",
  /** Sus candidatas ya son de otra expansión. Esto SÍ quiere una persona. */
  CONFLICTO: "conflicto",
  /** La wiki no respondió, o falló la descarga. Es transitorio. */
  ERROR: "error",
} as const;

export type EstadoSobre = (typeof ESTADOS_SOBRE)[keyof typeof ESTADOS_SOBRE];

/**
 * CADA CUÁNTO SE VUELVE A PREGUNTAR POR UNA EXPANSIÓN, según cómo acabó la
 * última vez. En días; `null` significa NUNCA MÁS.
 *
 * ============================================================================
 * ESTA TABLA ES LA PIEZA QUE HACE QUE EL CRON SEA BUEN VECINO
 * ============================================================================
 *
 * El reparto real del trabajo no es el que uno se imagina. Salen 6-10
 * expansiones nuevas AL AÑO (contadas en src/data/all-sets.json: 2019:9,
 * 2020:6, 2021:9, 2022:10, 2023:9, 2024:6, 2025:7), o sea que casi todas las
 * noches el cron no tiene nada que hacer. El coste que hay que evitar no es el
 * de las expansiones nuevas —son tres peticiones al mes— sino el de volver a
 * preguntar por las 41 imposibles.
 *
 * Los números:
 *   · OMITIDA -> null. Son las 9 que una persona ya marcó a mano en
 *     src/data/sobres-bulbapedia.json. Si un humano ha escrito "esto no tuvo
 *     sobre", preguntárselo a la wiki no aporta nada.
 *   · SIN_PAGINA y SIN_CANDIDATAS -> 180 días. No es "nunca" porque la wiki SÍ
 *     crece: una expansión recién salida puede no tener aún subida la foto de
 *     su sobre, y esas dos son justo el estado en el que caería. Dos consultas
 *     al año por expansión (64 peticiones anuales por las 32 que caen aquí
 *     solas) es un precio ridículo por no dejar tirada a la única que importa.
 *   · FILTRO_FORMA -> 180 días, por lo mismo: mañana pueden subir un escaneo
 *     decente donde hoy sólo hay un recorte.
 *   · CONFLICTO -> 180 días. Esto no se arregla solo, lo arregla una persona
 *     tocando el mapa a mano; y cuando lo toque, `?setId=` fuerza la revisión
 *     sin esperar.
 *   · ERROR -> 1 día. Es una wiki caída o un timeout: mañana se reintenta.
 *
 * Y por encima de todo esto hay un filtro que ahorra más que la tabla entera:
 * las expansiones que YA TIENEN foto estática en public/sobres (130 de 171) no
 * entran nunca en la cola. Eso está en services/sobresIngest.ts.
 */
export const DIAS_PARA_REPREGUNTAR: Readonly<Record<string, number | null>> = {
  [ESTADOS_SOBRE.OK]: null,
  [ESTADOS_SOBRE.OMITIDA]: null,
  [ESTADOS_SOBRE.SIN_PAGINA]: 180,
  [ESTADOS_SOBRE.SIN_CANDIDATAS]: 180,
  [ESTADOS_SOBRE.FILTRO_FORMA]: 180,
  [ESTADOS_SOBRE.CONFLICTO]: 180,
  [ESTADOS_SOBRE.ERROR]: 1,
};

/* ============================================================================
 * Y LA EXCEPCIÓN QUE JUSTIFICA TODO EL INVENTO: LA EXPANSIÓN RECIÉN SALIDA
 * ============================================================================
 *
 * La tabla de arriba es la buena para las 32 expansiones que no van a tener
 * sobre NUNCA, que son las que costaban peticiones. Pero aplicada a pelo se
 * come justo el caso que motivó esto:
 *
 *   sync-sets mete la expansión la MISMA noche en que pokemontcg.io la publica.
 *   Bulbapedia puede tardar días en que alguien suba la foto de su sobre. El
 *   cron pregunta esa noche, la wiki contesta la verdad —"todavía no hay
 *   fichero que parezca un sobre"—, se anota SIN_CANDIDATAS... y no se vuelve a
 *   mirar hasta dentro de SEIS MESES. La expansión que más se abre pasa medio
 *   año con el sobre dibujado por haber preguntado demasiado pronto.
 *
 * Así que el plazo depende de la EDAD de la expansión, no sólo del estado: por
 * debajo de DIAS_RECIENTE se repregunta cada DIAS_PARA_REPREGUNTAR_RECIENTE.
 *
 * LO QUE CUESTA, que es lo único que hay que vigilar: una expansión joven que
 * de verdad no tenga sobre son ~52 visitas en su primer año en vez de 2. Como
 * las visitas viajan en el lote de la noche (LOTE_SETS = 6 títulos en UNA
 * petición) y a la vez sólo hay una o dos expansiones jóvenes, eso son unas 50
 * peticiones al año MÁS, sobre las ~20 que costaba todo lo demás. Sigue siendo
 * dos órdenes de magnitud menos que preguntar por las 41 cada noche (14.965), y
 * es la diferencia entre que esto sirva para lo que se pidió o no.
 *
 * NO SE APLICA A `null`. Una expansión OMITIDA a mano o ya resuelta con OK no
 * vuelve a la cola por ser joven: en la primera lo ha dicho una persona y en la
 * segunda ya tiene la foto.
 */
export const DIAS_RECIENTE = 365;
export const DIAS_PARA_REPREGUNTAR_RECIENTE = 7;

/**
 * Tipos de imagen que se aceptan al guardar y que se sirven de vuelta.
 *
 * ES UNA LISTA BLANCA Y NO UNA NEGRA a propósito: lo que sale de aquí acaba
 * como `Content-Type` de una respuesta con bytes de terceros dentro. Un
 * `image/svg+xml` colado en esta lista sería un documento con scripts servido
 * desde nuestro dominio; no está, y no puede estar.
 */
export const MIMES_SOBRE: ReadonlySet<string> = new Set([
  "image/webp",
  "image/png",
  "image/jpeg",
]);
