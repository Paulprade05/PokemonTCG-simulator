/**
 * Esquema de la CAPA DE TRADUCCIONES.
 *
 * Vive en su propio módulo, sin importar nada, porque lo necesitan dos sitios:
 * `app/migrate-core/route.ts` (que crea el esquema al desplegar) y el propio
 * cron de traducciones (que se asegura de que la tabla existe antes de
 * escribir). Dos declaraciones copiadas que se desincronizan darían tablas
 * distintas en dos despliegues, y el fallo no aparecería hasta que alguien
 * consultara una columna que en su base no existe.
 *
 * Las marcas de tiempo van sin zona, como el resto del esquema: las funciones
 * de Vercel corren en UTC.
 */
export const SENTENCIAS_IDIOMA: readonly string[] = [
  /* ------------------------------------------------------------------ *
   * set_translations — el diccionario español de UNA expansión
   * ------------------------------------------------------------------
   *
   * QUÉ ES: el equivalente en base de datos de un `src/data/es/<set>.json`.
   * Los 46 ficheros estáticos siguen siendo el suelo y esta tabla es una CAPA
   * ENCIMA, para las expansiones que llegan después del despliegue. Hacía falta
   * porque en Vercel el sistema de ficheros es de sólo lectura: un cron puede
   * descubrir traducciones nuevas, pero no puede escribirlas en src/data.
   *
   * UNA FILA POR EXPANSIÓN Y NO POR CARTA, a propósito: `cargarDiccionario`
   * (services/idioma.ts) ya carga la expansión entera de golpe y la cachea, y
   * `traducirCartas` agrupa por expansión precisamente para eso. Con una fila
   * por set, el UPSERT del cron es UNA sentencia atómica —importa, porque el
   * cron se puede cortar por tiempo a mitad—, y el JSONB grande vive en TOAST,
   * así que la consulta que no pide `cartas` no lo lee.
   *
   * `cartas` guarda EXACTAMENTE la forma de `DiccionarioSet["cartas"]`:
   *     { "sv8-1": { "n": "Exeggcute", "i": "https://assets.tcgdex.net/..." } }
   * `i` es la URL BASE sin extensión; quien le pega /low.webp y /high.webp es
   * `construirImagenesEs`, y esa decisión está documentada allí, no aquí.
   *
   * NO HAY COLUMNA PARA rarity, number, precio NI PARA EL set_id CANÓNICO DE
   * UNA CARTA, y eso es la mitad del diseño: la regla dura de
   * services/idioma.ts —"este módulo nunca toca nada de lo que dependa la
   * economía"— no se puede violar desde aquí ni queriendo. Sólo nombre e
   * ilustración.
   *
   * SIN FOREIGN KEY contra `sets` ni `cards`: los dos crones son independientes
   * y el de ingesta se corta por tiempo, así que una expansión puede estar a
   * medias en `cards` cuando éste la visita. Con FK el UPSERT fallaría por una
   * carrera que no importa; sin ella la fila espera y se aplica sola. Y un
   * ON DELETE CASCADE dejaría que una resiembra de `cards` borrara en silencio
   * traducciones que costaron peticiones a TCGdex.
   *
   * `lang` en la clave aunque hoy siempre valga 'es': TCGdex es multilingüe por
   * segmento de URL, así que la columna cuesta cuatro bytes por fila y no
   * ponerla costaría rehacer la clave primaria. El CHECK prohíbe 'en' porque el
   * inglés es EL DATO, no una traducción: una fila 'en' aquí sería la puerta
   * para que un cron acabara pisando `cards.name`.
   *
   * `revisado_en` es NOT NULL con la fecha cero en vez de NULL para que "nunca
   * revisada" sea un VALOR: así la cola del cron es un recorrido de rango del
   * índice y no necesita NULLS FIRST.
   */
  `CREATE TABLE IF NOT EXISTS set_translations (
     set_id      TEXT NOT NULL,
     lang        TEXT NOT NULL DEFAULT 'es',
     tcgdex_id   TEXT,
     nombre      TEXT,
     logo        TEXT,
     serie       TEXT,
     cartas      JSONB NOT NULL DEFAULT '{}'::jsonb,
     traducidas  INT  NOT NULL DEFAULT 0,
     sin_pareja  INT  NOT NULL DEFAULT 0,
     huella      TEXT NOT NULL DEFAULT '',
     estado      TEXT NOT NULL DEFAULT 'pendiente',
     error       TEXT,
     revisado_en TIMESTAMP NOT NULL DEFAULT '1970-01-01 00:00:00',
     cambiado_en TIMESTAMP,
     PRIMARY KEY (set_id, lang),
     CONSTRAINT set_translations_lang_no_en
       CHECK (lang <> 'en' AND lang ~ '^[a-z]{2}$')
   )`,

  /* LA COLA DEL CRON, y por eso el índice va por (lang, revisado_en).
   *
   * El cron recorre las expansiones de más antigua a más recientemente
   * revisada, así que lo que se quedó fuera anoche por falta de tiempo tiene la
   * marca más vieja y sale primero mañana. Es reanudable sin cursor: no hay
   * ningún estado que se pueda corromper, la propia tabla es la cola. */
  `CREATE INDEX IF NOT EXISTS idx_set_translations_cola
     ON set_translations (lang, revisado_en)`,
];

/**
 * Estados posibles de `set_translations.estado`. SÓLO SE LEE `ok`: el resto son
 * anotaciones del cron para no repetir trabajo y para poder explicar por qué
 * una expansión sigue en inglés.
 */
export const ESTADOS_IDIOMA = {
  /** Hay traducción aplicable. Es el único que la capa de lectura mira. */
  OK: "ok",
  /** TCGdex la lista pero sirve `cards: []`. Pasa de verdad (p. ej. B1a). */
  VACIO: "vacio",
  /** Todavía no hay filas en `cards`: el otro cron aún no la ha ingerido. */
  SIN_INGLES: "sin_ingles",
  /** El emparejamiento no superó las guardias: casi seguro que es otro set. */
  GUARDIA: "guardia",
  /** TCGdex no conoce ese id. */
  NO_ENCONTRADO: "404",
  /** No hay ningún candidato plausible en la lista de TCGdex. */
  SIN_FUENTE: "sin_fuente",
} as const;

export type EstadoIdioma = (typeof ESTADOS_IDIOMA)[keyof typeof ESTADOS_IDIOMA];
