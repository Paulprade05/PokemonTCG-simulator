/**
 * Los tipos que cruzan pantallas.
 *
 * POR QUÉ EXISTE: el proyecto compila con `strict: true`, pero las tres
 * pantallas que pintan cartas —la tienda y la apertura (app/page.tsx), la
 * colección y el álbum— declaraban `any[]` para el catálogo, el sobre en curso
 * y la lista de expansiones. `strict` no sirve de nada sobre un `any`, y eso es
 * exactamente la clase de fallo que dejó pasar el peor error de la revisión: un
 * array vacío colándose por donde se esperaba una carta hacía que el sobre
 * sellado no llegara a montarse nunca.
 *
 * NO ES UN TIPO "COMPLETO" DE CARTA A PROPÓSITO. Las cartas llegan de tres
 * sitios con formas distintas —la tabla `cards`, los JSON del repositorio y la
 * colección de invitado en localStorage— y cada uno trae un subconjunto. Lo que
 * hay aquí es lo que TODOS garantizan más lo que algunos añaden, marcado como
 * opcional. Poner de obligatorio algo que un origen no trae sólo conseguiría
 * que se volviera a escribir `as any` para callarlo.
 *
 * Vive en utils/ y no en services/ porque lo importan tanto el cliente como el
 * servidor, y no arrastra ninguna dependencia.
 */

/** Lo mínimo que necesita packLogic para sortear y la interfaz para pintar. */
export interface CartaBase {
  id: string;
  name: string;
  rarity: string;
  images: { small: string; large: string };
}

/**
 * Una carta tal y como la ven las pantallas: la base más todo lo que el
 * catálogo del set añade cuando está disponible.
 */
export interface Carta extends CartaBase {
  /** Número impreso. Es texto: hay cartas "GG01", "TG12" o "SV107". */
  number?: string;
  artist?: string;
  flavorText?: string;
  supertype?: string;
  subtypes?: string[];
  /** También texto: la API sirve "120", y hay cartas sin PS. */
  hp?: string | null;
  types?: string[];
  evolvesFrom?: string;
  attacks?: unknown[];
  weaknesses?: unknown[];
  retreatCost?: unknown[];
  nationalPokedexNumbers?: number[];
  tcgplayer?: unknown;
  set?: { id?: string; name?: string };

  /* --- Sólo cuando la carta viene de la colección de alguien --- */
  /** Copias en propiedad. Ausente en el catálogo de un set. */
  quantity?: number;
  is_favorite?: boolean;

  /* --- Sólo cuando la carta es una COPIA CONCRETA, no el modelo --- *
   *
   * Estos tres separan "la carta" de "esta copia mía de la carta", y por eso
   * viven aquí y no en el catálogo: dos copias de la misma carta tienen el
   * mismo `id`, la misma ilustración y la misma rareza, pero su estado y su
   * nota son suyos.
   */

  /**
   * Estado físico de la copia: piques en los cantos, arañazos, manchas,
   * descentrado y decoloración. Lo pinta components/DesperfectosCarta.tsx.
   *
   * SÓLO LLEGA EN LAS COPIAS QUE DE VERDAD SE VEN MAL —aproximadamente el 5%—
   * y su ausencia significa "se ve limpia", nunca "no se sabe". Es una decisión
   * económica y está medida: el desgaste es coherente con la nota de
   * graduación, así que mandarlo siempre la delataría (una copia sin ni un
   * pique era SIEMPRE un 10, y graduar sólo ésas es beneficio garantizado). El
   * servidor filtra qué manda; el cliente pinta lo que le llega y NO lo deduce.
   */
  desperfectos?: unknown;
  /** Dónde va cada marca del desgaste. Viaja o falta junto a `desperfectos`. */
  marcas?: unknown;

  /* --- Sólo cuando la carta se ha graduado --- */
  /** Copias graduadas de esta carta que siguen en la vitrina. */
  graduadas?: number;
  /** La nota más alta entre ellas: la que se enseña. */
  mejor_nota?: number | null;
}

/**
 * Una carta que está EN la colección de alguien.
 *
 * La diferencia con `Carta` no es cosmética: media pantalla de colección hace
 * cuentas con `quantity` (cuánto vale, cuántas repetidas, si se puede vender) y
 * con `Carta` a secas el compilador obligaba a un `?? 0` en cada una de esas
 * cuentas — que es justo la forma de que un día se cuele un 0 donde debía haber
 * un número y nadie se entere. Aquí `quantity` está garantizada porque el
 * origen (la tabla `user_collection` o el localStorage del invitado) siempre la
 * trae.
 */
export interface CartaEnColeccion extends Carta {
  quantity: number;
  is_favorite?: boolean;
}

/**
 * Una expansión tal y como la devuelve `getSetsFromDB`.
 *
 * OJO A LOS DOS TOTALES, que no son lo mismo y confundirlos fue el fallo D-01:
 *  · `total` es lo que el set DECLARA. Viene de la API, suele venir inflado, y
 *    es el que usa la tienda para decidir si una expansión es "especial".
 *  · `cardsCount` son las cartas que EXISTEN en la base de datos. Es el
 *    denominador honesto del progreso: medir contra `total` hacía que el 100%
 *    fuera inalcanzable en toda expansión que declarase de más o que la ingesta
 *    hubiera dejado a medias.
 * Falta en el respaldo local (loadLocalSets no cuenta cartas), así que quien lo
 * lea tiene que caer a `total`.
 */
export interface Expansion {
  id: string;
  name: string;
  /** Nombre inglés, que conserva la capa de idioma. La tienda decide con él
   *  qué sobres vende, y eso no puede depender del idioma en que se mire. */
  nameEn?: string;
  series?: string | null;
  images?: { logo?: string; symbol?: string };
  total?: number;
  cardsCount?: number;
  /**
   * Sólo con la app en español: `false` marca una expansión sin diccionario,
   * que se verá en inglés. Ausente en inglés, donde no hay nada que avisar —por
   * eso se pregunta por `=== false` y no por `!tieneEs`.
   */
  tieneEs?: boolean;
  releaseDate?: string | null;
  release_date?: string | null;
  printed_total?: number;
}
