/**
 * MERCADO DE LOTES — lógica pura (sin estado, sin BD, sin React).
 *
 * El mercado compra LOTES de DUPLICADOS por encima de la suma de sus precios
 * sueltos: paga exactamente `multiplicador × Σ SELL_PRICES(cartas entregadas)`,
 * sin recortes ni presupuesto máximo. Cada oferta pide una combinación de
 * requisitos ("8 cartas Comunes o Infrecuentes de tipo Fuego", "una línea
 * evolutiva completa", "3 copias de una misma carta Rara"...).
 *
 * ------------------------------------------------------------------------
 * REGLA CENTRAL: SÓLO DUPLICADOS
 * ------------------------------------------------------------------------
 * Una carta sólo se puede entregar si al jugador le queda al menos una copia
 * después. Entregar N copias exige tener N+1 (ver COPIAS_RESERVADAS y
 * `copiasEntregables`, que son la ÚNICA definición de la regla: servidor y
 * pantalla tienen que llamar a esa función y no reimplementarla).
 *
 * POR QUÉ ESTO CAMBIA TODO EL DISEÑO, no es un filtro que se añade al final:
 *  - De lo que se acumulan duplicados es de MORRALLA. Medido con packLogic sobre
 *    las cartas reales: de los 9,6 duplicados que produce un sobre estándar,
 *    8,88 son Comunes o Infrecuentes, 0,63 Raras, 0,20 de Rara Holo a Doble
 *    Rara, 0,08 de Doble Rara a Radiante y 0,03 de Radiante a Ilustración Rara.
 *    De una Hyper Rare no hay dos ni abriendo cajas: 0,014 duplicados por sobre
 *    por encima de rango 70, y concentrados en las colecciones especiales.
 *  - Por eso TODOS los requisitos piden una BANDA DE RAREZA explícita, y la
 *    banda más alta que existe se corta en la Ilustración Rara (precio 70). El
 *    mercado NUNCA pide una Ilustración Secreta ni una Hyper Rare: no las
 *    tendrías repetidas, y si las tuvieras no querrías darlas.
 *  - Las cantidades y los esfuerzos de cada plantilla salen de los DUPLICADOS
 *    por sobre que produce su filtro, no del número de cartas a secas
 *    (scripts/sim-mercado.mjs vuelve a medirlos y avisa si un prior se ha
 *    quedado desfasado).
 *  - El PLAYSET pasó de "4 copias" a 2-4 copias con banda: pedir 4 exigiría
 *    tener 5, y eso son 14 sobres en morralla pero 59 en Raras y 107 en Rara
 *    Holo. Se pide 2-4 en morralla, 2-3 en Raras, 2 en Holo, y nada por encima.
 *
 * ------------------------------------------------------------------------
 * POR QUÉ UN GENERADOR Y NO UNA LISTA
 * ------------------------------------------------------------------------
 * Con una lista fija el jugador la aprende en una tarde y el mercado deja de
 * dar razones para abrir sobres. Aquí hay un catálogo de plantillas × rejilla de
 * parámetros × bandas de rareza × expansiones, y una semilla decide qué sale en
 * cada ciclo. Son cientos de miles de ofertas distintas.
 *
 * ------------------------------------------------------------------------
 * POR QUÉ NO HAY TOPE DE PAGO (y por qué ya no hace falta)
 * ------------------------------------------------------------------------
 * Antes existía un TECHO_PRIMA porque el pago proporcional invita a entregar las
 * cartas MÁS CARAS que cumplan el filtro: "5 cartas de tipo Fuego ×1,5" se
 * convertía en "cinco Hyper Rare de 250 y me llevo 1.875". Hoy ese ataque está
 * muerto por construcción, sin recortar el pago:
 *  1. sólo se entregan DUPLICADOS, y de las cartas caras casi no hay;
 *  2. cada requisito lleva una banda de rareza CERRADA, así que la carta más
 *     cara que puede entrar en un lote se conoce al generar la oferta;
 *  3. las bandas son ESTRECHAS en precio. Lo que se puede sacar "eligiendo
 *     bien" dentro de una banda es exactamente su precio máximo dividido por su
 *     precio mínimo REALES (x1,5 en morralla, x1,6 en Raras, x1,6 de Rara Holo a
 *     Doble Rara, x1,1 en la élite; la única ancha es la de la cadena de 3
 *     eslabones, x4,3). Sin bandas ese cociente era 125 (común de 2 contra Hyper
 *     Rare de 250) y ahí vivía la imprenta.
 *     NO lo cambia el precio de referencia con que se calcula el multiplicador:
 *     la prima es (multiplicador − 1) × valor real y el multiplicador es
 *     inversamente proporcional a la referencia, así que el cociente se cancela.
 *     Lo único que estrecha el abuso es estrechar la BANDA.
 * El apartado 7 de scripts/sim-mercado.mjs mide ese peor caso con las cartas
 * reales y con inventarios de duplicados de verdad.
 *
 * ------------------------------------------------------------------------
 * NOTA PARA QUIEN CONSUME ESTE MÓDULO
 * ------------------------------------------------------------------------
 * `cumpleFiltro` es carta a carta y ya aplica la banda de rareza. Las tres
 * categorías de CONJUNTO (playset, arcoiris, evolucion) necesitan además la
 * comprobación de conjunto que hace quien valida la entrega. Cualquier categoría
 * NUEVA que sea carta a carta funciona en el servidor y en la pantalla sin
 * tocarlos, porque las dos pasan por `cumpleFiltro`.
 */

import { AVAILABLE_SETS, RARITY_RANK, SELL_PRICES } from "./constanst";

/* ------------------------------------------------------------------ *
 * CONTRATO PÚBLICO
 * ------------------------------------------------------------------ */

export type Categoria =
  | "tipo"
  | "evolucion"
  | "rareza"
  | "artista"
  | "supertipo"
  | "hp"
  | "pokedex"
  | "playset"
  | "arcoiris"
  | "etapa"
  | "numero"
  | "inicial"
  | "set";

export interface Filtro {
  categoria: Categoria;
  /**
   * Valor de la categoría. En "tipo" (y en "supertipo" y "etapa") admite varios
   * separados por "|": "Fire|Water" = vale cualquiera de los dos.
   */
  valor?: string | number;
  min?: number;
  max?: number;
  /**
   * BANDA DE RAREZA (rangos de RARITY_RANK) que la carta debe cumplir ADEMÁS de
   * la categoría. Es lo que acota el precio de lo que puede entrar en el lote, y
   * por tanto lo que sustituye al viejo tope de pago. Todos los requisitos que
   * genera este módulo la traen.
   */
  rarMin?: number;
  rarMax?: number;
}

export interface Requisito {
  descripcion: string;
  cantidad: number;
  filtro: Filtro;
  /** null = vale cualquier set; si no, el id del set exigido. */
  setId: string | null;
}

export interface Oferta {
  id: string;
  titulo: string;
  descripcion: string;
  requisitos: Requisito[];
  multiplicador: number;
  dificultad: "facil" | "media" | "dificil";
  setId: string | null;
}

export interface CartaMinima {
  id: string;
  name: string;
  rarity?: string;
  supertype?: string;
  subtypes?: string[];
  types?: string[];
  evolvesFrom?: string;
  hp?: string | number;
  artist?: string;
  nationalPokedexNumbers?: number[];
  set?: { id?: string };
  setId?: string;
}

/* ------------------------------------------------------------------ *
 * LA REGLA DE LOS DUPLICADOS (única definición)
 * ------------------------------------------------------------------ */

/**
 * Copias que el jugador conserva SIEMPRE de cada carta. El mercado sólo compra
 * lo que sobra por encima de esto.
 */
export const COPIAS_RESERVADAS = 1;

/**
 * Copias de una carta que se pueden entregar al mercado teniendo `cantidad`.
 *
 * SERVIDOR: exige `cantidad >= copias entregadas + COPIAS_RESERVADAS`, es decir
 * `copiasEntregables(cantidad) >= copias entregadas`.
 * CLIENTE: proponer sólo estas copias y medir el progreso ("3/5") con ellas. Si
 * el progreso se midiera sobre las copias poseídas, la oferta se vería completa
 * y el cobro fallaría — el peor fallo posible en esta pantalla.
 */
export function copiasEntregables(cantidad: number): number {
  const n = Math.floor(Number(cantidad) || 0);
  return Math.max(0, n - COPIAS_RESERVADAS);
}

/* ------------------------------------------------------------------ *
 * SEMÁNTICA DE CADA CATEGORÍA (léelo antes de escribir el validador)
 * ------------------------------------------------------------------ *
 *
 * `cumpleFiltro(carta, filtro)` responde a "¿esta carta SUELTA es candidata?",
 * banda de rareza incluida. Tres categorías necesitan además una comprobación
 * de CONJUNTO que sólo puede hacer quien valida la entrega:
 *
 *  - "playset":   `cantidad` = copias de LA MISMA carta (mismo `id`).
 *                 El validador agrupa por id y exige `cantidad` copias de una
 *                 sola carta. Con la regla de duplicados, el jugador necesita
 *                 `cantidad + 1` copias en la colección.
 *  - "arcoiris":  `cantidad` = número de TIPOS DISTINTOS. El validador exige que
 *                 las cartas entregadas cubran `cantidad` tipos diferentes.
 *  - "evolucion": `cantidad` = eslabones de la cadena. El validador exige que
 *                 encadenen por `evolvesFrom` → `name`. `valor` (opcional) =
 *                 tipo que deben compartir todos los eslabones.
 *
 * El resto son filtros carta a carta:
 *  - "tipo":      `valor` = tipo(s) en inglés ("Fire", "Fire|Water").
 *  - "supertipo": `valor` = "Pokémon" | "Trainer" | "Energy".
 *  - "etapa":     `valor` = subtipo ("Basic", "Stage 1", "Supporter"...).
 *  - "rareza":    la banda hace todo el trabajo; `valor` fuerza rareza exacta.
 *  - "artista":   `valor` = nombre del ilustrador.
 *  - "hp":        `min`/`max` sobre los PS.
 *  - "pokedex":   `min`/`max` sobre el número de la Pokédex nacional.
 *  - "numero":    `min`/`max` sobre el número de la carta DENTRO de su set
 *                 (los dígitos finales de su id: "sv3pt5-207" → 207).
 *  - "inicial":   `valor` = letras admitidas para la inicial del nombre ("ABC").
 *  - "set":       `valor` = id de expansión.
 *
 * `Requisito.setId` se comprueba APARTE del filtro: la carta entregada debe
 * pertenecer a ese set (usa `setDeCarta`). null = cualquier expansión.
 */

/* ------------------------------------------------------------------ *
 * CONSTANTES DE ECONOMÍA (documentadas: son los mandos del grifo)
 * ------------------------------------------------------------------ */

/**
 * Ofertas simultáneas. Siete y no seis porque con la regla de duplicados muchas
 * ofertas dejan de ser cumplibles el primer día y hace falta un tablón más ancho
 * para que siempre haya dos o tres al alcance de la mano.
 *
 * OJO: es el segundo mando del grifo. La prima que puede inyectar un ciclo es la
 * SUMA de las de su tablón, así que cada oferta de más sube el techo. Se probó
 * con ocho y el farmeo intensivo se disparaba.
 */
export const OFERTAS_ACTIVAS = 7;

/** Horas que vive un ciclo de ofertas. Al caducar, se sortea otro tablón. */
export const DURACION_CICLO_HORAS = 24;

/** Lo mismo en milisegundos, para comparar contra Date.now() en el servidor. */
export const DURACION_CICLO_MS = DURACION_CICLO_HORAS * 60 * 60 * 1000;

/**
 * Reparto de dificultades dentro de un ciclo. Se fija a propósito en vez de
 * dejarlo al azar: así el tamaño del grifo por ciclo es predecible y no aparecen
 * tablones de siete ofertas difíciles que multipliquen la inyección.
 */
export const COMPOSICION_CICLO = { facil: 3, media: 3, dificil: 1 } as const;

/**
 * Suelo y techo del multiplicador.
 *
 * El SUELO (1,3) es la promesa del mercado: entregar un lote nunca paga menos de
 * un 30% por encima de venderlo suelto. Antes era 1,15 y había ofertas que casi
 * no compensaban el clic.
 *
 * El TECHO (8) lo tocan los lotes BARATOS, que no es lo mismo que "lotes de
 * morralla": el multiplicador es 1 + prima/valor, así que sube cuando el lote
 * vale poco, y una cadena evolutiva de banda "Rara o inferior" (3 cartas) vale
 * tan poco como un puñado de comunes. Medido sobre 21.000 ofertas generadas:
 * 458 salen a ×8, la carta más cara que admite un lote a ×8 vale 14 monedas (no
 * 3) y el pago máximo de una oferta a ×8, entregando el techo de cada banda, es
 * 408. Sigue siendo seguro —el máximo absoluto del tablón entero es 484— pero
 * quien vuelva a tocar este número tiene que contar con esos 408, no con 288.
 * Es lo que convierte "tengo 200 comunes repetidas" en dinero de verdad. Para
 * llegar al techo con un lote grande harían falta más sobres de esfuerzo de los
 * que ESFUERZO_MAXIMO permite pedir, así que el techo sólo lo tocan lotes cortos.
 */
export const MULTIPLICADOR_MIN = 1.3;
export const MULTIPLICADOR_MAX = 8;

/**
 * Monedas de PRIMA (pago por encima del valor de venta) que el mercado paga por
 * cada sobre de esfuerzo estimado. Es el "sueldo por hora" del mercado y el
 * mando principal del grifo.
 *
 * 4 y no 2,2 (el valor viejo): con 2,2 y el tope de prima, una oferta fácil daba
 * 15 monedas y una difícil 90 — nada frente a los 150 de la recompensa diaria, y
 * el mercado era decorativo. A 4 (y sin tope) una fácil paga +20 de prima, una
 * media +60 y una difícil +125, con picos de +190.
 *
 * POR QUÉ NO MÁS: se probó con 7 y la simulación lo tumbó. La prima que puede
 * inyectar un ciclo es la SUMA de las de su tablón, y el esfuerzo de las ofertas
 * NO es aditivo: un solo sobre produce a la vez duplicados de tipo Fuego, de
 * número bajo, de inicial A-C y de Entrenador, así que paga varias ofertas de
 * golpe. A 7, abrir 12 sobres al día sólo para revender al mercado daba +342
 * monedas NETAS al día (una imprenta); a 4 la cosa queda en una ayuda al que
 * juega mucho, no en una fuente de dinero infinito. Es el mando a tocar si
 * hiciera falta ajustar, junto con OFERTAS_ACTIVAS.
 */
export const TASA_PRIMA_POR_SOBRE = 4;

/**
 * Esfuerzo máximo (en sobres) que se le permite pedir a una oferta. Por encima
 * de esto la oferta es contenido muerto: nadie la completa antes de que caduque.
 * Baja de 70 a 55 porque con la regla de duplicados el sobre rinde menos y
 * porque a 7 monedas de prima por sobre, 70 sobres serían 490 de prima en una
 * sola oferta.
 */
const ESFUERZO_MAXIMO = 55;

/** Fronteras de dificultad, en sobres de esfuerzo estimado. */
const ESFUERZO_FACIL = 8;
const ESFUERZO_MEDIO = 25;

/**
 * Cartas máximas que puede pedir una oferta entera.
 *
 * OJO: el servidor rechaza entregas de más de MAX_CARTAS_ENTREGA cartas
 * (app/action.ts). Este tope tiene que quedar POR DEBAJO de aquél o el generador
 * produciría ofertas imposibles de cobrar.
 */
const MAX_CARTAS_OFERTA = 30;

/**
 * Los requisitos de set libre son más baratos de lo que dice su rendimiento por
 * sobre, porque el jugador puede tirar de TODA su colección y no sólo de lo que
 * saque de esa expansión.
 */
const FACTOR_LIBRE = 0.7;

/* ------------------------------------------------------------------ *
 * BANDAS DE RAREZA
 *
 * Son la pieza que sustituye al tope de pago. Cada banda es un intervalo CERRADO
 * de RARITY_RANK con su precio mínimo y máximo reales (medidos sobre las cartas
 * de las 26 expansiones que el mercado puede exigir) y su rendimiento en
 * DUPLICADOS por sobre estándar.
 *
 * Invariante de diseño: precioMax / precioMin REALES de la banda <= 1,6 salvo en
 * B_BAJA. Ése —y no la referencia con la que se calcula el multiplicador— es el
 * factor por el que se puede inflar la prima entregando lo más caro que la banda
 * admite. Sin bandas era 125 (común de 2 contra Hyper Rare de 250).
 *
 * `precioMin` tiene DOS trabajos que conviene no confundir: fija la ESCALA del
 * pago (referencia del multiplicador) pero no acota nada. Cuando el suelo teórico
 * de la banda no es lo que el jugador entrega de verdad, aquí va el valor TÍPICO
 * medido sobre duplicados reales, no el suelo (ver B_BAJA y B_ELITE): con el
 * suelo, el multiplicador se calcula contra un lote que no existe y la prima real
 * se desvía de la prevista en ese mismo factor.
 * ------------------------------------------------------------------ */

interface Banda {
  clave: string;
  rarMin: number;
  rarMax: number;
  /**
   * Precio con el que se calcula el multiplicador: fija la ESCALA del pago, no
   * su tope. Es el de la carta más BARATA de la banda SIEMPRE QUE esa carta sea
   * algo que el jugador entregue de verdad; si no lo es (B_BAJA, B_ELITE), es el
   * precio TÍPICO medido sobre duplicados reales. Poner aquí un suelo que en la
   * práctica no se entrega desvía la prima real de la prevista exactamente en la
   * proporción del error, y en la dirección del error.
   */
  precioMin: number;
  /** Precio de venta de la carta más CARA de la banda: base de la auditoría. */
  precioMax: number;
  /** Duplicados por sobre estándar que produce la banda entera. */
  rend: number;
  /** Cómo se nombra en el texto del requisito (plural y singular). */
  etiqueta: string;
  etiquetaUna: string;
}

const B_MORRALLA: Banda = {
  clave: "m",
  rarMin: 1,
  rarMax: 5,
  precioMin: 2,
  precioMax: 3,
  rend: 8.88,
  etiqueta: "Comunes o Infrecuentes",
  etiquetaUna: "Común o Infrecuente",
};
/**
 * Morralla + Raras. Es la única banda ancha que queda. Su precio de referencia
 * NO es el suelo (2) sino 4, porque lo que importa es el valor del lote que el
 * jugador entrega DE VERDAD, y está medido sobre duplicados reales: la cadena de
 * 3 eslabones más barata que se puede formar vale 7 (2+2+3) y la más cara 19,
 * con un máximo absoluto de 30. Referencia 4 ⇒ lote de referencia 12, en medio
 * de esa horquilla.
 *
 * OJO CON UN ESPEJISMO: cambiar esta referencia NO cambia cuánto se puede abusar
 * de la banda. La prima es (multiplicador − 1) × valor real, y el multiplicador
 * es inversamente proporcional a la referencia, así que el cociente
 * prima_máxima/prima_mínima vale siempre valorReal_máx/valorReal_mín (aquí 30/7
 * ≈ x4,3) haga lo que haga esta constante. Lo único que mueve la referencia es
 * la ESCALA: con 6 la cadena típica pagaba +28 después de 30 sobres de trabajo
 * —menos que una oferta fácil—; con 4 paga lo que dice el modelo. Quien quiera
 * estrechar el cociente tiene que estrechar la BANDA, no la referencia.
 *
 * La usa un único requisito, porque con morralla sola la cadena de 3 sólo se
 * completa el 42% de las veces (medido).
 */
const B_BAJA: Banda = {
  clave: "b",
  rarMin: 1,
  rarMax: 10,
  precioMin: 4,
  precioMax: 14,
  rend: 9.3,
  etiqueta: "de rareza Rara o inferior",
  etiquetaUna: "de rareza Rara o inferior",
};
const B_RARA: Banda = {
  clave: "r",
  rarMin: 10,
  rarMax: 20,
  precioMin: 14,
  precioMax: 22,
  rend: 0.63,
  etiqueta: "Raras o Rara Holo",
  etiquetaUna: "Rara o Rara Holo",
};
const B_HOLO: Banda = {
  clave: "h",
  rarMin: 20,
  rarMax: 40,
  precioMin: 22,
  precioMax: 35,
  rend: 0.201,
  etiqueta: "de Rara Holo a Doble Rara",
  etiquetaUna: "de Rara Holo a Doble Rara",
};
const B_DOBLE: Banda = {
  clave: "d",
  rarMin: 35,
  rarMax: 45,
  precioMin: 35,
  precioMax: 45,
  rend: 0.076,
  etiqueta: "de Doble Rara a Radiante",
  etiquetaUna: "de Doble Rara a Radiante",
};
/**
 * Radiante → Ilustración Rara. El precio de referencia es 65 y NO 45 (el suelo
 * teórico de la banda) por una razón medida: de las 328 cartas de esta banda que
 * reparte el sobre estándar, sólo DOS valen 45 (las Amazing Rare de swsh4), y de
 * ésas no hay duplicados ni abriendo 39.000 sobres. Lo que el jugador entrega de
 * verdad vale 65 o 70 (mediana medida sobre duplicados reales: 65 con 2.600
 * sobres, 70 con menos). Con la referencia en 45 el multiplicador salía calculado
 * contra un lote que no existe y la prima real era x1,44 la prevista: 30 sobres
 * de esfuerzo se pagaban +133 en vez de +85. Es la misma corrección que ya lleva
 * B_BAJA, y en la dirección contraria.
 */
const B_ELITE: Banda = {
  clave: "e",
  rarMin: 45,
  rarMax: 70,
  precioMin: 65,
  precioMax: 70,
  rend: 0.033,
  etiqueta: "de Radiante a Ilustración Rara",
  etiquetaUna: "de Radiante a Ilustración Rara",
};

/* ------------------------------------------------------------------ *
 * PRIORES: DUPLICADOS por sobre estándar que produce cada filtro.
 *
 * Medidos con packLogic.ts sobre las cartas reales de src/data, en las 26
 * expansiones que el mercado puede exigir (AVAILABLE_SETS con datos), abriendo
 * 170 sobres por partida y contando sólo las copias que sobran (la primera de
 * cada carta se queda en el álbum). Se descartan los 20 primeros sobres: con la
 * colección vacía no hay duplicados y el número saldría falseado.
 *
 * Se usa la MEDIANA entre expansiones para los filtros que se pueden atar a un
 * set (el jugador abre UNA expansión) y la MEDIA para los que siempre van
 * sueltos (tira de toda su colección, que abarca muchas). scripts/sim-mercado.mjs
 * los vuelve a medir y avisa si alguno se ha quedado desfasado.
 * ------------------------------------------------------------------ */

/** Tipo, dentro de la banda de morralla. */
const REND_TIPO: Record<string, number> = {
  Grass: 1.21,
  Fire: 0.59,
  Water: 1.03,
  Lightning: 0.625,
  Psychic: 0.96,
  Fighting: 0.99,
  Darkness: 0.63,
  Metal: 0.45,
  Colorless: 0.96,
};

/** Tipo, dentro de la banda de Raras. Un orden de magnitud menos. */
const REND_TIPO_RARA: Record<string, number> = {
  Grass: 0.072,
  Fire: 0.048,
  Water: 0.068,
  Lightning: 0.048,
  Psychic: 0.093,
  Fighting: 0.074,
  Darkness: 0.059,
  Metal: 0.044,
  Colorless: 0.052,
};

/** Supertipo, en morralla (Entrenador) o tal cual (Energía). */
const REND_TRAINER = 1.165;
const REND_ENERGY = 0.063;

/** Etapa (subtipo) en la banda de morralla. */
const REND_ETAPA: Record<string, number> = {
  Basic: 6.05,
  "Stage 1": 1.46,
  Item: 0.427,
  Supporter: 0.497,
  Stadium: 0.113,
  "Pokémon Tool": 0.228,
};
/**
 * Fase 2 en morralla: hay expansiones enteras donde ninguna Fase 2 es Común o
 * Infrecuente (mediana 0), así que este requisito va SIEMPRE suelto y su prior
 * es la media entre expansiones, que es lo que ve un jugador con colección de
 * varias.
 */
const REND_STAGE2 = 0.1;
const REND_EX = 0.04;
const REND_V = 0.035;

/** PS mínimos → duplicados por sobre en morralla. */
const REND_HP_MIN: Record<number, number> = { 90: 2.34, 110: 1.25 };
/** 130 PS en morralla: existen, pero no en todas las expansiones (media). */
const REND_HP_130 = 0.553;
/** 200 PS ya son sólo ex y V: van con banda de valor. */
const REND_HP_200_DOBLE = 0.066;
/** PS máximos ("canijos") → duplicados por sobre en morralla. */
const REND_HP_MAX: Record<number, number> = { 50: 0.904, 60: 2.659, 70: 4.585 };

/** Región de la Pokédex, en morralla. Siempre suelta: se usa la MEDIA. */
const REGIONES: { nombre: string; min: number; max: number; rend: number }[] = [
  { nombre: "Kanto", min: 1, max: 151, rend: 1.483 },
  { nombre: "Johto", min: 152, max: 251, rend: 0.792 },
  { nombre: "Hoenn", min: 252, max: 386, rend: 0.995 },
  { nombre: "Sinnoh", min: 387, max: 493, rend: 0.715 },
  { nombre: "Teselia", min: 494, max: 649, rend: 1.098 },
  { nombre: "Kalos", min: 650, max: 721, rend: 0.487 },
  { nombre: "Alola", min: 722, max: 809, rend: 0.454 },
  { nombre: "Galar", min: 810, max: 905, rend: 0.799 },
  { nombre: "Paldea", min: 906, max: 1025, rend: 0.721 },
];

/**
 * Ilustradores prolíficos y sus duplicados por sobre en morralla. Los requisitos
 * de artista SIEMPRE son de set libre: hay expansiones enteras (sv7, sv8,
 * sv8pt5...) cuyos JSON no traen `artist`, y atarlos a un set los haría
 * imposibles. 5ban Graphics se ha caído del catálogo: casi todo lo que firma son
 * full arts y secretas, de las que no hay duplicados.
 */
const ARTISTAS: { nombre: string; rend: number }[] = [
  { nombre: "Kouki Saitou", rend: 0.205 },
  { nombre: "sowsow", rend: 0.169 },
  { nombre: "HYOGONOSUKE", rend: 0.149 },
  { nombre: "Akira Komayama", rend: 0.128 },
  { nombre: "Toyste Beach", rend: 0.115 },
  { nombre: "nagimiso", rend: 0.107 },
  { nombre: "kirisAki", rend: 0.106 },
  { nombre: "Shin Nagasawa", rend: 0.099 },
  { nombre: "Kagemaru Himeno", rend: 0.084 },
  { nombre: "kawayoo", rend: 0.068 },
  { nombre: "Ryuta Fuse", rend: 0.06 },
  { nombre: "Mitsuhiro Arita", rend: 0.059 },
];

/**
 * Rangos de número dentro del set, en morralla. Los que empiezan por encima de
 * 80 van siempre sueltos: las expansiones pequeñas (swsh45 tiene 73 cartas) no
 * llegan a esos números y atarlos las volvería imposibles.
 */
const RANGOS_NUMERO: {
  min: number;
  max: number;
  rend: number;
  libre: boolean;
  texto: string;
}[] = [
  { min: 1, max: 40, rend: 2.234, libre: false, texto: "del 1 al 40" },
  { min: 41, max: 80, rend: 2.268, libre: false, texto: "del 41 al 80" },
  { min: 1, max: 60, rend: 3.438, libre: false, texto: "del 1 al 60" },
  { min: 61, max: 120, rend: 2.921, libre: false, texto: "del 61 al 120" },
  { min: 81, max: 120, rend: 1.928, libre: true, texto: "del 81 al 120" },
  { min: 121, max: 999, rend: 2.171, libre: true, texto: "a partir del 121" },
];

/** Grupos de inicial del nombre, en morralla. */
const INICIALES: { letras: string; rend: number; texto: string }[] = [
  { letras: "ABC", rend: 1.608, texto: "A, B o C" },
  { letras: "DEFG", rend: 1.847, texto: "D, E, F o G" },
  { letras: "HIJKLM", rend: 1.6, texto: "H, I, J, K, L o M" },
  { letras: "NOPQR", rend: 1.393, texto: "N, O, P, Q o R" },
  { letras: "STUVWXYZ", rend: 2.359, texto: "S, T, U, V, W, X, Y o Z" },
];

/**
 * SOBRES HASTA LOGRARLO de las categorías de conjunto, medidos directamente
 * sobre duplicados (mediana de 208 partidas). No se pueden derivar dividiendo
 * por un rendimiento: juntar 3 copias de la MISMA carta o cubrir 6 tipos
 * DISTINTOS es un problema de coleccionista de cupones.
 *
 * `cantidad` es lo que se ENTREGA, así que el jugador necesita `cantidad + 1`
 * copias: estos números ya lo tienen en cuenta.
 */
const ESFUERZO_PLAYSET: Record<string, Record<number, number>> = {
  m: { 2: 6, 3: 9, 4: 14 },
  r: { 2: 23, 3: 40 },
  h: { 2: 45 },
};

const ESFUERZO_ARCO: Record<string, Record<number, number>> = {
  m: { 4: 5, 5: 6, 6: 7, 7: 8 },
  r: { 3: 22, 4: 27, 5: 35, 6: 42 },
};

/** Cadenas evolutivas formables con duplicados. */
const ESFUERZO_CADENA_2 = 9;
/** Tres eslabones necesitan Raras: en morralla sólo se logra el 42% de veces. */
const ESFUERZO_CADENA_3 = 30;
/** Exigir además un tipo concreto multiplica por dos los sobres (medido). */
const ESFUERZO_CADENA_2_TIPO = 19;

const TIPO_ES: Record<string, string> = {
  Grass: "Planta",
  Fire: "Fuego",
  Water: "Agua",
  Lightning: "Rayo",
  Psychic: "Psíquico",
  Fighting: "Lucha",
  Darkness: "Siniestro",
  Metal: "Metal",
  Colorless: "Incoloro",
};

const ETAPA_ES: Record<string, string> = {
  Basic: "Básicos",
  "Stage 1": "de Fase 1",
  "Stage 2": "de Fase 2",
  Item: "de Objeto",
  Supporter: "de Partidario",
  Stadium: "de Estadio",
  "Pokémon Tool": "de Herramienta",
  ex: "ex",
  V: "V",
};

/* ------------------------------------------------------------------ *
 * UTILIDADES PÚBLICAS
 * ------------------------------------------------------------------ */

/** Set al que pertenece una carta. El id ("sv3pt5-207") es el último recurso. */
export function setDeCarta(carta: CartaMinima): string | null {
  if (carta.set?.id) return carta.set.id;
  if (carta.setId) return carta.setId;
  const corte = carta.id?.lastIndexOf("-") ?? -1;
  return corte > 0 ? carta.id.slice(0, corte) : null;
}

/** Rango de rareza; las rarezas desconocidas caen al suelo, no al techo. */
export function rangoDeRareza(carta: CartaMinima): number {
  return RARITY_RANK[carta.rarity ?? ""] ?? 1;
}

/** Mismo respaldo que usa la app al vender (getPrice): 10 si no hay tarifa. */
export function precioDeVenta(carta: CartaMinima): number {
  return SELL_PRICES[carta.rarity ?? ""] ?? 10;
}

/**
 * Número de la carta DENTRO de su expansión, sacado de los dígitos finales de su
 * id ("sv3pt5-207" → 207, "swsh12pt5gg-GG01" → 1). NaN si no se puede leer: un
 * filtro de número nunca acepta una carta cuyo número no se conoce.
 */
export function numeroEnSet(carta: CartaMinima): number {
  const id = carta.id ?? "";
  const corte = id.lastIndexOf("-");
  if (corte < 0) return NaN;
  const digitos = id.slice(corte + 1).match(/(\d+)/);
  return digitos ? Number(digitos[1]) : NaN;
}

/**
 * Semilla del ciclo vigente en un instante dado. Cliente y servidor la calculan
 * igual, así que el tablón que se pinta y el que se valida son el mismo sin
 * necesidad de guardarlo en ninguna parte.
 */
export function semillaDelCiclo(ahoraMs: number): number {
  return Math.floor(ahoraMs / DURACION_CICLO_MS);
}

/** Instante en que caduca el ciclo al que pertenece `semilla`. */
export function caducidadDelCiclo(semilla: number): number {
  return (semilla + 1) * DURACION_CICLO_MS;
}

const igual = (a: unknown, b: unknown): boolean =>
  String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/** ¿La carta encaja en alguno de los valores que pide el filtro ("a|b")? */
function alguno(valor: unknown, candidatos: (string | undefined)[]): boolean {
  const pedidos = String(valor ?? "").split("|");
  return candidatos.some((c) => pedidos.some((p) => igual(c, p)));
}

/** Categorías que sin `valor` no significan nada. */
const EXIGEN_VALOR: Categoria[] = [
  "tipo",
  "supertipo",
  "etapa",
  "artista",
  "inicial",
  "set",
];

export function cumpleFiltro(carta: CartaMinima, f: Filtro): boolean {
  // Sin esta guarda, un filtro corrupto con `valor` vacío casaría con las cartas
  // que tampoco tienen el campo (undefined === undefined) y regalaría el lote.
  // Un filtro incompleto no acepta nada.
  if (f.valor === undefined && EXIGEN_VALOR.includes(f.categoria)) return false;

  // BANDA DE RAREZA: se aplica a TODAS las categorías, antes que nada. Es lo que
  // garantiza que el lote no pueda llenarse de cartas caras, y por eso el pago
  // ya no necesita tope.
  if (f.rarMin !== undefined || f.rarMax !== undefined) {
    const r = rangoDeRareza(carta);
    if (f.rarMin !== undefined && r < f.rarMin) return false;
    if (f.rarMax !== undefined && r > f.rarMax) return false;
  }

  switch (f.categoria) {
    case "tipo":
      return alguno(f.valor, carta.types ?? []);

    case "supertipo":
      return alguno(f.valor, [carta.supertype]);

    case "etapa":
      return alguno(f.valor, carta.subtypes ?? []);

    case "artista":
      return igual(carta.artist, f.valor);

    case "set":
      return setDeCarta(carta) === String(f.valor);

    case "rareza": {
      if (f.valor !== undefined) return igual(carta.rarity, f.valor);
      const r = rangoDeRareza(carta);
      if (f.min !== undefined && r < f.min) return false;
      if (f.max !== undefined && r > f.max) return false;
      return true;
    }

    case "hp": {
      const hp = Number(carta.hp);
      if (!Number.isFinite(hp)) return false;
      if (f.min !== undefined && hp < f.min) return false;
      if (f.max !== undefined && hp > f.max) return false;
      return true;
    }

    case "pokedex": {
      const nums = carta.nationalPokedexNumbers ?? [];
      return nums.some(
        (n) =>
          (f.min === undefined || n >= f.min) && (f.max === undefined || n <= f.max),
      );
    }

    case "numero": {
      const n = numeroEnSet(carta);
      if (!Number.isFinite(n)) return false;
      if (f.min !== undefined && n < f.min) return false;
      if (f.max !== undefined && n > f.max) return false;
      return true;
    }

    case "inicial": {
      const letra = (carta.name ?? "").trim().charAt(0).toUpperCase();
      return letra !== "" && String(f.valor ?? "").toUpperCase().includes(letra);
    }

    // --- categorías de CONJUNTO: aquí sólo se filtra la elegibilidad ---
    case "playset":
      // Cualquier carta de la banda vale como base de un playset; que haya
      // `cantidad` copias entregables lo comprueba el validador.
      return true;

    case "arcoiris":
      // Tiene que tener tipo para poder aportar un color al arcoíris.
      return (carta.types ?? []).length > 0;

    case "evolucion": {
      // Elegible = Pokémon (el encadenado por evolvesFrom lo valida quien recibe
      // la entrega); si hay `valor`, además del tipo pedido.
      if (!igual(carta.supertype, "Pokémon")) return false;
      if (f.valor === undefined) return true;
      return alguno(f.valor, carta.types ?? []);
    }

    default:
      return false;
  }
}

/* ------------------------------------------------------------------ *
 * CATÁLOGO DE PLANTILLAS
 * ------------------------------------------------------------------ */

interface Variante {
  /** Clave estable: entra en el id de la oferta y permite contarlas. */
  clave: string;
  plantilla: string;
  cantidad: number;
  filtro: Filtro;
  /** Texto del requisito, sin la coletilla de expansión. */
  texto: string;
  /** Sobres estimados para reunir los DUPLICADOS abriendo la expansión. */
  esfuerzo: number;
  /** Precio de la carta más barata que cumple: base del pago. */
  precioUnidad: number;
  /** Precio de la carta más cara que cumple: base de la auditoría de abuso. */
  precioTecho: number;
  /** "valor" paga de verdad; "sabor" tematiza y cuesta poco. */
  familia: "valor" | "sabor";
  /** true = nunca se ata a un set (o sería imposible en algunas expansiones). */
  siempreLibre: boolean;
  /** true = sólo vale como ancla (primer requisito de una oferta de set). */
  soloAncla?: boolean;
  /** Nombre corto para componer títulos con gracia. */
  mote: string;
}

/**
 * Parejas de tipos que se piden juntas ("cartas de tipo Fuego o Agua"). Duplican
 * el rendimiento del filtro, así que permiten lotes grandes de morralla sin que
 * el esfuerzo se dispare — justo lo que pidió el usuario.
 */
const PAREJAS_TIPO: [string, string][] = [
  ["Fire", "Water"],
  ["Grass", "Lightning"],
  ["Psychic", "Darkness"],
  ["Fighting", "Metal"],
  ["Water", "Colorless"],
  ["Fire", "Fighting"],
  ["Grass", "Psychic"],
  ["Darkness", "Metal"],
  ["Lightning", "Colorless"],
  ["Water", "Psychic"],
  ["Grass", "Fighting"],
  ["Fire", "Metal"],
];

function conBanda(filtro: Filtro, banda: Banda): Filtro {
  return { ...filtro, rarMin: banda.rarMin, rarMax: banda.rarMax };
}

/** "una carta" / "8 cartas": los textos se leen en la pantalla, no en un log. */
function cuenta(n: number, singular: string, plural: string): string {
  return n === 1 ? `una ${singular}` : `${n} ${plural}`;
}

/** Etiqueta de la banda concordada en número. */
function etiquetaBanda(n: number, banda: Banda): string {
  return n === 1 ? banda.etiquetaUna : banda.etiqueta;
}

function construirCatalogo(): Variante[] {
  const v: Variante[] = [];
  const meter = (x: Variante) => {
    // Un requisito que pide más cartas que la oferta entera no cabe, y uno que
    // pide más esfuerzo que el máximo es contenido muerto.
    if (x.cantidad > MAX_CARTAS_OFERTA) return;
    if (x.esfuerzo > ESFUERZO_MAXIMO) return;
    v.push(x);
  };

  // 1) N cartas de UN TIPO, en morralla ------------------------------------
  for (const [tipo, rend] of Object.entries(REND_TIPO)) {
    for (const n of [4, 6, 8, 10, 12]) {
      meter({
        clave: `tipo:${tipo}:m:${n}`,
        plantilla: "tipo",
        cantidad: n,
        filtro: conBanda({ categoria: "tipo", valor: tipo }, B_MORRALLA),
        texto: `${n} cartas ${B_MORRALLA.etiqueta} de tipo ${TIPO_ES[tipo]}`,
        esfuerzo: n / rend,
        precioUnidad: B_MORRALLA.precioMin,
        precioTecho: B_MORRALLA.precioMax,
        familia: "sabor",
        // Hay sets sin una sola carta de algún tipo (sv3pt5 y swsh7 no tienen
        // Metal): atarlo al set volvería la oferta imposible.
        siempreLibre: true,
        mote: TIPO_ES[tipo].toLowerCase(),
      });
    }
  }

  // 2) N cartas de DOS TIPOS a elegir, en morralla -------------------------
  for (const [a, b] of PAREJAS_TIPO) {
    // Rendimiento aditivo con un 2% de descuento: hay cartas de doble tipo que
    // se contarían dos veces. Verificado contra la medición real.
    const rend = (REND_TIPO[a] + REND_TIPO[b]) * 0.98;
    for (const n of [8, 10, 12, 15, 18]) {
      meter({
        clave: `tipo:${a}+${b}:m:${n}`,
        plantilla: "tipo",
        cantidad: n,
        filtro: conBanda({ categoria: "tipo", valor: `${a}|${b}` }, B_MORRALLA),
        texto: `${n} cartas ${B_MORRALLA.etiqueta} de tipo ${TIPO_ES[a]} o ${TIPO_ES[b]}`,
        esfuerzo: n / rend,
        precioUnidad: B_MORRALLA.precioMin,
        precioTecho: B_MORRALLA.precioMax,
        familia: "sabor",
        siempreLibre: true,
        mote: `${TIPO_ES[a].toLowerCase()} y ${TIPO_ES[b].toLowerCase()}`,
      });
    }
  }

  // 3) N cartas RARAS de un tipo ------------------------------------------
  for (const [tipo, rend] of Object.entries(REND_TIPO_RARA)) {
    for (const n of [2, 3]) {
      meter({
        clave: `tipo:${tipo}:r:${n}`,
        plantilla: "tipo",
        cantidad: n,
        filtro: conBanda({ categoria: "tipo", valor: tipo }, B_RARA),
        texto: `${n} cartas ${B_RARA.etiqueta} de tipo ${TIPO_ES[tipo]}`,
        esfuerzo: n / rend,
        precioUnidad: B_RARA.precioMin,
        precioTecho: B_RARA.precioMax,
        familia: "valor",
        siempreLibre: true,
        mote: `${TIPO_ES[tipo].toLowerCase()} de calidad`,
      });
    }
  }

  // 4) N cartas de una BANDA DE RAREZA -------------------------------------
  const REJILLA_BANDAS: { banda: Banda; cantidades: number[]; libre: boolean }[] = [
    // La morralla a granel es el corazón del mercado nuevo: es de lo que
    // cualquiera tiene duplicados a montones.
    { banda: B_MORRALLA, cantidades: [10, 12, 15, 18, 20], libre: false },
    { banda: B_RARA, cantidades: [2, 3, 4, 5], libre: false },
    // [20,40] no existe en las expansiones de Escarlata y Púrpura (no imprimen
    // Rara Holo): atada a un set moderno sería imposible.
    { banda: B_HOLO, cantidades: [2, 3, 4], libre: true },
    { banda: B_DOBLE, cantidades: [2, 3, 4], libre: true },
    { banda: B_ELITE, cantidades: [1, 2], libre: true },
  ];
  for (const { banda, cantidades, libre } of REJILLA_BANDAS) {
    for (const n of cantidades) {
      meter({
        clave: `rar:${banda.clave}:${n}`,
        plantilla: "rareza",
        cantidad: n,
        filtro: conBanda({ categoria: "rareza" }, banda),
        texto: `${cuenta(n, "carta", "cartas")} ${etiquetaBanda(n, banda)}`,
        esfuerzo: n / banda.rend,
        precioUnidad: banda.precioMin,
        precioTecho: banda.precioMax,
        familia: banda.precioMin >= 14 ? "valor" : "sabor",
        siempreLibre: libre,
        mote: banda.etiqueta.replace(/^de /, "").toLowerCase(),
      });
    }
  }

  // 5) N cartas de un SUPERTIPO -------------------------------------------
  for (const n of [3, 4, 5, 6, 8]) {
    meter({
      clave: `super:Trainer:${n}`,
      plantilla: "supertipo",
      cantidad: n,
      filtro: conBanda({ categoria: "supertipo", valor: "Trainer" }, B_MORRALLA),
      texto: `${cuenta(n, "carta", "cartas")} de Entrenador ${etiquetaBanda(n, B_MORRALLA)}`,
      esfuerzo: n / REND_TRAINER,
      precioUnidad: B_MORRALLA.precioMin,
      precioTecho: B_MORRALLA.precioMax,
      familia: "sabor",
      siempreLibre: false,
      mote: "papeleo",
    });
  }
  for (const n of [1, 2]) {
    meter({
      clave: `super:Energy:${n}`,
      plantilla: "supertipo",
      cantidad: n,
      filtro: conBanda({ categoria: "supertipo", valor: "Energy" }, B_MORRALLA),
      texto: `${cuenta(n, "carta", "cartas")} de Energía ${etiquetaBanda(n, B_MORRALLA)}`,
      esfuerzo: n / REND_ENERGY,
      precioUnidad: B_MORRALLA.precioMin,
      precioTecho: B_MORRALLA.precioMax,
      familia: "sabor",
      // Las Energías casi no salen en sobres (0,042 duplicados por sobre).
      siempreLibre: true,
      mote: "combustible",
    });
  }

  // 6) N cartas de una ETAPA ----------------------------------------------
  for (const [etapa, rend] of Object.entries(REND_ETAPA)) {
    // Cantidades proporcionadas al rendimiento: pedir 10 Estadios (0,124 por
    // sobre) serían 80 sobres, y pedir 3 Básicos (6 por sobre) es un chiste.
    const cantidades =
      rend > 4 ? [10, 12, 15, 18] : rend > 1 ? [4, 5, 6, 8] : rend > 0.3 ? [2, 3, 4] : [1, 2];
    for (const n of cantidades) {
      meter({
        clave: `etapa:${etapa}:m:${n}`,
        plantilla: "etapa",
        cantidad: n,
        filtro: conBanda({ categoria: "etapa", valor: etapa }, B_MORRALLA),
        texto: `${cuenta(n, "carta", "cartas")} ${ETAPA_ES[etapa]} ${etiquetaBanda(n, B_MORRALLA)}`,
        esfuerzo: n / rend,
        precioUnidad: B_MORRALLA.precioMin,
        precioTecho: B_MORRALLA.precioMax,
        familia: "sabor",
        // Sólo Básico y Fase 1 existen en TODAS las expansiones abribles; los
        // Estadios y las Herramientas faltan en varias.
        siempreLibre: etapa !== "Basic" && etapa !== "Stage 1",
        mote: ETAPA_ES[etapa].toLowerCase(),
      });
    }
  }
  for (const n of [2, 3]) {
    meter({
      clave: `etapa:Stage 2:m:${n}`,
      plantilla: "etapa",
      cantidad: n,
      filtro: conBanda({ categoria: "etapa", valor: "Stage 2" }, B_MORRALLA),
      texto: `${cuenta(n, "carta", "cartas")} de Fase 2 ${etiquetaBanda(n, B_MORRALLA)}`,
      esfuerzo: n / REND_STAGE2,
      precioUnidad: B_MORRALLA.precioMin,
      precioTecho: B_MORRALLA.precioMax,
      familia: "sabor",
      siempreLibre: true,
      mote: "fases finales",
    });
  }
  for (const [etapa, rend] of [["ex", REND_EX], ["V", REND_V]] as const) {
    meter({
      clave: `etapa:${etapa}:d:1`,
      plantilla: "etapa",
      cantidad: 1,
      filtro: conBanda({ categoria: "etapa", valor: etapa }, B_DOBLE),
      texto: `una carta ${ETAPA_ES[etapa]} ${B_DOBLE.etiquetaUna}`,
      esfuerzo: 1 / rend,
      precioUnidad: B_DOBLE.precioMin,
      precioTecho: B_DOBLE.precioMax,
      familia: "valor",
      siempreLibre: true,
      mote: `una ${etapa}`,
    });
  }

  // 7) PS: moles y canijos ------------------------------------------------
  for (const [umbralStr, rend] of Object.entries(REND_HP_MIN)) {
    const umbral = Number(umbralStr);
    for (const n of [3, 4, 5, 6]) {
      meter({
        clave: `hp:${umbral}:m:${n}`,
        plantilla: "hp",
        cantidad: n,
        filtro: conBanda({ categoria: "hp", min: umbral }, B_MORRALLA),
        texto: `${n} Pokémon ${B_MORRALLA.etiqueta} con ${umbral} PS o más`,
        esfuerzo: n / rend,
        precioUnidad: B_MORRALLA.precioMin,
        precioTecho: B_MORRALLA.precioMax,
        familia: "sabor",
        siempreLibre: false,
        mote: `moles de ${umbral} PS`,
      });
    }
  }
  for (const n of [2, 3, 4]) {
    meter({
      clave: `hp:130:m:${n}`,
      plantilla: "hp",
      cantidad: n,
      filtro: conBanda({ categoria: "hp", min: 130 }, B_MORRALLA),
      texto: `${n} Pokémon ${B_MORRALLA.etiqueta} con 130 PS o más`,
      esfuerzo: n / REND_HP_130,
      precioUnidad: B_MORRALLA.precioMin,
      precioTecho: B_MORRALLA.precioMax,
      familia: "sabor",
      // No todas las expansiones tienen Pokémon de 130 PS entre su morralla.
      siempreLibre: true,
      mote: "moles de 130 PS",
    });
  }
  for (const n of [1, 2]) {
    meter({
      clave: `hp:200:d:${n}`,
      plantilla: "hp",
      cantidad: n,
      filtro: conBanda({ categoria: "hp", min: 200 }, B_DOBLE),
      texto: `${n === 1 ? "un Pokémon" : n + " Pokémon"} ${etiquetaBanda(n, B_DOBLE)} con 200 PS o más`,
      esfuerzo: n / REND_HP_200_DOBLE,
      precioUnidad: B_DOBLE.precioMin,
      precioTecho: B_DOBLE.precioMax,
      familia: "valor",
      siempreLibre: true,
      mote: "titanes",
    });
  }
  for (const [umbralStr, rend] of Object.entries(REND_HP_MAX)) {
    const umbral = Number(umbralStr);
    const cantidades = rend > 3 ? [8, 10, 12] : rend > 1 ? [5, 6, 8] : [3, 4];
    for (const n of cantidades) {
      meter({
        clave: `hpmax:${umbral}:m:${n}`,
        plantilla: "hp",
        cantidad: n,
        filtro: conBanda({ categoria: "hp", max: umbral }, B_MORRALLA),
        texto: `${n} Pokémon ${B_MORRALLA.etiqueta} con ${umbral} PS o menos`,
        esfuerzo: n / rend,
        precioUnidad: B_MORRALLA.precioMin,
        precioTecho: B_MORRALLA.precioMax,
        familia: "sabor",
        siempreLibre: false,
        mote: `canijos de ${umbral} PS`,
      });
    }
  }

  // 8) N Pokémon de una REGIÓN (rango de Pokédex) -------------------------
  for (const reg of REGIONES) {
    for (const n of [3, 4, 5, 6]) {
      meter({
        clave: `dex:${reg.min}:m:${n}`,
        plantilla: "pokedex",
        cantidad: n,
        filtro: conBanda(
          { categoria: "pokedex", min: reg.min, max: reg.max },
          B_MORRALLA,
        ),
        texto: `${n} Pokémon ${B_MORRALLA.etiqueta} de ${reg.nombre} (Pokédex ${reg.min}-${reg.max})`,
        esfuerzo: n / reg.rend,
        precioUnidad: B_MORRALLA.precioMin,
        precioTecho: B_MORRALLA.precioMax,
        familia: "sabor",
        siempreLibre: true,
        mote: reg.nombre.toLowerCase(),
      });
    }
  }

  // 9) N cartas de un ARTISTA (siempre libre) -----------------------------
  for (const a of ARTISTAS) {
    for (const n of [2, 3, 4]) {
      meter({
        clave: `art:${a.nombre}:m:${n}`,
        plantilla: "artista",
        cantidad: n,
        filtro: conBanda({ categoria: "artista", valor: a.nombre }, B_MORRALLA),
        texto: `${n} cartas ${B_MORRALLA.etiqueta} ilustradas por ${a.nombre}`,
        esfuerzo: n / a.rend,
        precioUnidad: B_MORRALLA.precioMin,
        precioTecho: B_MORRALLA.precioMax,
        familia: "sabor",
        siempreLibre: true,
        mote: `firmas de ${a.nombre}`,
      });
    }
  }

  // 10) N cartas por NÚMERO dentro del set --------------------------------
  for (const r of RANGOS_NUMERO) {
    for (const n of [5, 6, 8, 10]) {
      meter({
        clave: `num:${r.min}-${r.max}:m:${n}`,
        plantilla: "numero",
        cantidad: n,
        filtro: conBanda({ categoria: "numero", min: r.min, max: r.max }, B_MORRALLA),
        texto: `${n} cartas ${B_MORRALLA.etiqueta} numeradas ${r.texto}`,
        esfuerzo: n / r.rend,
        precioUnidad: B_MORRALLA.precioMin,
        precioTecho: B_MORRALLA.precioMax,
        familia: "sabor",
        siempreLibre: r.libre,
        mote: "cartas de una página del álbum",
      });
    }
  }

  // 11) N cartas por INICIAL del nombre -----------------------------------
  for (const g of INICIALES) {
    for (const n of [5, 6, 8, 10]) {
      meter({
        clave: `ini:${g.letras}:m:${n}`,
        plantilla: "inicial",
        cantidad: n,
        filtro: conBanda({ categoria: "inicial", valor: g.letras }, B_MORRALLA),
        texto: `${n} cartas ${B_MORRALLA.etiqueta} cuyo nombre empiece por ${g.texto}`,
        esfuerzo: n / g.rend,
        precioUnidad: B_MORRALLA.precioMin,
        precioTecho: B_MORRALLA.precioMax,
        familia: "sabor",
        siempreLibre: false,
        mote: "cartas por orden alfabético",
      });
    }
  }

  // 12) PLAYSET: N copias de la misma carta -------------------------------
  // Con la regla de duplicados, pedir N copias exige tener N+1. Los esfuerzos
  // están medidos así, y por eso no hay playsets por encima de Rara Holo: tener
  // 3 copias de una Rara Holo son 82 sobres y sólo se logra el 92% de las veces.
  for (const banda of [B_MORRALLA, B_RARA, B_HOLO]) {
    const tabla = ESFUERZO_PLAYSET[banda.clave] ?? {};
    for (const [nStr, esfuerzo] of Object.entries(tabla)) {
      const n = Number(nStr);
      meter({
        clave: `playset:${banda.clave}:${n}`,
        plantilla: "playset",
        cantidad: n,
        filtro: conBanda({ categoria: "playset" }, banda),
        texto: `${n} copias de una misma carta ${banda.etiqueta} (te quedará una)`,
        esfuerzo,
        precioUnidad: banda.precioMin,
        precioTecho: banda.precioMax,
        familia: banda.precioMin >= 14 ? "valor" : "sabor",
        // La banda [20,40] no existe en las expansiones de Escarlata y Púrpura y
        // escasea en varias de Espada y Escudo: atada, sale imposible.
        siempreLibre: banda === B_HOLO,
        mote: "montón de la misma carta",
      });
    }
  }

  // 13) ARCOÍRIS: N cartas de N tipos distintos ---------------------------
  for (const banda of [B_MORRALLA, B_RARA]) {
    const tabla = ESFUERZO_ARCO[banda.clave] ?? {};
    for (const [nStr, esfuerzo] of Object.entries(tabla)) {
      const n = Number(nStr);
      meter({
        clave: `arco:${banda.clave}:${n}`,
        plantilla: "arcoiris",
        cantidad: n,
        filtro: conBanda({ categoria: "arcoiris" }, banda),
        texto: `${n} cartas ${banda.etiqueta} de ${n} tipos DISTINTOS`,
        esfuerzo,
        precioUnidad: banda.precioMin,
        precioTecho: banda.precioMax,
        familia: banda.precioMin >= 14 ? "valor" : "sabor",
        // Con 7 tipos distintos en morralla ya hay expansiones que se quedan
        // cortas, y la banda de Raras no cubre 9 tipos en ninguna.
        siempreLibre: banda === B_RARA || n >= 7,
        mote: "arcoíris",
      });
    }
  }

  // 14) LÍNEA EVOLUTIVA completa ------------------------------------------
  meter({
    clave: "evo:m:2",
    plantilla: "evolucion",
    cantidad: 2,
    filtro: conBanda({ categoria: "evolucion" }, B_MORRALLA),
    texto: `una línea evolutiva completa de 2 eslabones ${B_MORRALLA.etiqueta}`,
    esfuerzo: ESFUERZO_CADENA_2,
    precioUnidad: B_MORRALLA.precioMin,
    precioTecho: B_MORRALLA.precioMax,
    familia: "sabor",
    siempreLibre: false,
    mote: "una familia",
  });
  meter({
    clave: "evo:b:3",
    plantilla: "evolucion",
    cantidad: 3,
    // Con morralla sola la cadena de 3 sólo se completa el 42% de las veces: las
    // Fase 2 repetidas casi siempre son Raras.
    filtro: conBanda({ categoria: "evolucion" }, B_BAJA),
    texto: `una línea evolutiva completa de 3 eslabones ${B_BAJA.etiqueta}`,
    esfuerzo: ESFUERZO_CADENA_3,
    precioUnidad: B_BAJA.precioMin,
    precioTecho: B_BAJA.precioMax,
    familia: "sabor",
    siempreLibre: true,
    mote: "árbol genealógico",
  });
  for (const tipo of Object.keys(REND_TIPO)) {
    meter({
      clave: `evo:m:2:${tipo}`,
      plantilla: "evolucion",
      cantidad: 2,
      filtro: conBanda({ categoria: "evolucion", valor: tipo }, B_MORRALLA),
      texto: `una línea evolutiva de 2 eslabones ${B_MORRALLA.etiqueta} de tipo ${TIPO_ES[tipo]}`,
      esfuerzo: ESFUERZO_CADENA_2_TIPO,
      precioUnidad: B_MORRALLA.precioMin,
      precioTecho: B_MORRALLA.precioMax,
      familia: "sabor",
      siempreLibre: true,
      mote: `familia ${TIPO_ES[tipo].toLowerCase()}`,
    });
  }

  // 15) N cartas CUALESQUIERA de la expansión -----------------------------
  // Es el ancla infalible: existe en cualquier set y da la excusa más directa
  // para abrir esa expansión ("ábrelo y tráeme quince repetidas").
  for (const n of [10, 12, 15, 18, 20]) {
    meter({
      clave: `set:m:${n}`,
      plantilla: "set",
      cantidad: n,
      // `valor` se rellena con el set de la oferta al montar el requisito.
      filtro: conBanda({ categoria: "set" }, B_MORRALLA),
      texto: `${n} cartas ${B_MORRALLA.etiqueta} cualesquiera`,
      esfuerzo: n / B_MORRALLA.rend,
      precioUnidad: B_MORRALLA.precioMin,
      precioTecho: B_MORRALLA.precioMax,
      familia: "sabor",
      siempreLibre: false,
      soloAncla: true,
      mote: "cartas a granel",
    });
  }

  return v;
}

/** El catálogo es inmutable: se construye una vez por proceso. */
const CATALOGO: Variante[] = construirCatalogo();

/** Metadatos del catálogo (los usa scripts/sim-mercado.mjs para contar). */
export const PLANTILLAS: { id: string; variantes: number }[] = Object.entries(
  CATALOGO.reduce<Record<string, number>>((acc, v) => {
    acc[v.plantilla] = (acc[v.plantilla] ?? 0) + 1;
    return acc;
  }, {}),
).map(([id, variantes]) => ({ id, variantes }));

/**
 * Vista de sólo lectura del catálogo. Existe para que scripts/sim-mercado.mjs
 * pueda MEDIR el rendimiento real en duplicados de cada filtro y compararlo con
 * el prior declarado aquí: si un prior se queda desfasado, el multiplicador de
 * media docena de ofertas se va con él, y sin este contraste no se notaría.
 */
export const VARIANTES: ReadonlyArray<{
  clave: string;
  plantilla: string;
  cantidad: number;
  filtro: Filtro;
  esfuerzo: number;
  precioUnidad: number;
  precioTecho: number;
  siempreLibre: boolean;
  texto: string;
}> = CATALOGO.map((v) => ({
  clave: v.clave,
  plantilla: v.plantilla,
  cantidad: v.cantidad,
  filtro: { ...v.filtro },
  esfuerzo: v.esfuerzo,
  precioUnidad: v.precioUnidad,
  precioTecho: v.precioTecho,
  siempreLibre: v.siempreLibre,
  texto: v.texto,
}));

const ATABLES = CATALOGO.filter((v) => !v.siempreLibre);
const ATABLES_VALOR = ATABLES.filter((v) => v.familia === "valor" && !v.soloAncla);
// Los "sólo ancla" no pueden salir como requisito de set libre: sin set no
// significan nada.
const DE_VALOR = CATALOGO.filter((v) => v.familia === "valor" && !v.soloAncla);
const DE_SABOR = CATALOGO.filter((v) => v.familia === "sabor" && !v.soloAncla);

/* ------------------------------------------------------------------ *
 * TÍTULOS
 * ------------------------------------------------------------------ */

const TITULOS: Record<string, string[]> = {
  tipo: ["Pedido monocromo", "Todo de un color", "Cuestión de elemento"],
  rareza: ["Sólo material noble", "Nada de morralla", "El comprador es exigente"],
  hp: ["Se buscan moles", "Kilos de Pokémon", "Peso pesado"],
  supertipo: ["Encargo de oficina", "Material de apoyo", "El banquillo"],
  pokedex: ["Nostalgia regional", "Postales de casa", "Turismo Pokémon"],
  etapa: ["Cuestión de fase", "Escalafón evolutivo", "Por etapas"],
  playset: ["Todas iguales", "Manía del duplicado", "El coleccionista repetitivo"],
  arcoiris: ["Encargo arcoíris", "Toda la paleta", "Un poco de cada"],
  evolucion: ["Reunión familiar", "Árbol genealógico", "La familia al completo"],
  artista: ["Capricho de galerista", "Cuestión de firma", "Fan del ilustrador"],
  numero: ["Rellenando el álbum", "Por orden de aparición", "Cuestión de numeración"],
  inicial: ["Manía alfabética", "Por orden de nombre", "El comprador es del gremio"],
  set: ["Compra al peso", "Pedido a granel", "Vaciando la expansión"],
};

const REMATES = [
  "y pagan por encima de mercado",
  "pagan bien si lo juntas entero",
  "el lote completo o nada",
  "sólo aceptan el pedido al completo",
];

/* ------------------------------------------------------------------ *
 * GENERADOR
 * ------------------------------------------------------------------ */

type Rng = () => number;

/** mulberry32: determinista, rápido y de sobra para sortear un tablón. */
function crearRng(semilla: number): Rng {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function elegir<T>(rng: Rng, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)];
}

/**
 * Rótulo de una expansión dentro de la prosa de la oferta.
 *
 * `nombres` es opcional y llega desde el servidor con el catálogo REAL (ver
 * `catalogoDelMercado` en app/action.ts). Sin él quedaba sólo AVAILABLE_SETS,
 * una lista escrita a mano que no incluye las expansiones que trae el cron: sus
 * ofertas decían "de SV10" en mayúsculas. La cadena de respaldo se conserva
 * entera para que las dos simulaciones —que llaman a generarOfertas con tres
 * argumentos— sigan dando exactamente lo mismo.
 */
function nombreDeSet(setId: string, nombres?: Record<string, string>): string {
  return (
    nombres?.[setId] ??
    AVAILABLE_SETS.find((s) => s.id === setId)?.name ??
    setId.toUpperCase()
  );
}

function dificultadDe(esfuerzo: number): Oferta["dificultad"] {
  if (esfuerzo < ESFUERZO_FACIL) return "facil";
  if (esfuerzo < ESFUERZO_MEDIO) return "media";
  return "dificil";
}

/**
 * El multiplicador sale de un modelo, no de un dado:
 *   prima objetivo = TASA_PRIMA_POR_SOBRE × sobres de esfuerzo (en duplicados)
 *   multiplicador  = 1 + prima objetivo / valor del lote más barato que cumple
 *
 * Es decir: el mercado paga por el TRABAJO de acumular duplicados, no por el
 * precio de la carta. Un lote de morralla penoso de juntar sube al techo (×6) y
 * uno de cartas caras se queda cerca del suelo, porque el lote ya vale mucho.
 *
 * Lo que evita que esto sea una imprenta no es un recorte al pago: es que la
 * banda de rareza del requisito acota lo que puede entrar en el lote, así que
 * `multiplicador × valor real` no puede pasar de `multiplicador × valor techo`.
 */
function calcularMultiplicador(esfuerzo: number, valorLote: number): number {
  const primaObjetivo = TASA_PRIMA_POR_SOBRE * esfuerzo;
  const bruto = 1 + primaObjetivo / Math.max(valorLote, 1);
  const acotado = Math.min(Math.max(bruto, MULTIPLICADOR_MIN), MULTIPLICADOR_MAX);
  // Redondeo a 0,05 para que el número quede legible en la interfaz.
  return Math.round(acotado * 20) / 20;
}

/**
 * PAGO DEFINITIVO de un lote. Úsala en el servidor: es la única fórmula válida.
 *
 * SIN TOPE NI PRESUPUESTO: es exactamente el multiplicador por la suma de los
 * precios de venta de TODAS las cartas entregadas. Si el jugador entrega cartas
 * mejores dentro de la banda que pide el requisito, cobra proporcionalmente más,
 * y eso es lo que se quería.
 *
 * `valorLote` = suma de SELL_PRICES de las cartas entregadas, calculada EN EL
 * SERVIDOR a partir de la base de datos. Nunca aceptes ni el valor ni el pago
 * del cliente.
 */
export function pagoDelLote(oferta: Oferta, valorLote: number): number {
  const bruto = oferta.multiplicador * Math.max(0, valorLote);
  return Math.max(0, Math.round(bruto));
}

interface Candidata extends Oferta {
  esfuerzo: number;
  valorLote: number;
  /** Valor del lote si se entrega lo más caro que admite cada banda. */
  valorTecho: number;
}

function montarOferta(
  rng: Rng,
  setId: string | null,
  nombres?: Record<string, string>,
): Candidata | null {
  const partes: Variante[] = [];

  if (setId === null) {
    // Oferta de expansión libre: 1 o 2 requisitos, todos sueltos.
    const cuantos = rng() < 0.55 ? 1 : 2;
    partes.push(rng() < 0.6 ? elegir(rng, DE_VALOR) : elegir(rng, DE_SABOR));
    if (cuantos === 2) partes.push(elegir(rng, DE_SABOR));
  } else {
    // Oferta de set: el primer requisito ATA la oferta a esa expansión (por eso
    // sale de ATABLES) y al menos uno de los siguientes es de set libre, para
    // que la oferta nunca sea imposible.
    partes.push(rng() < 0.7 ? elegir(rng, ATABLES_VALOR) : elegir(rng, ATABLES));
    partes.push(rng() < 0.35 ? elegir(rng, DE_VALOR) : elegir(rng, DE_SABOR));
    if (rng() < 0.22) partes.push(elegir(rng, DE_SABOR));
  }

  // Dos requisitos de la misma plantilla en la misma oferta quedan ridículos
  // ("5 de tipo Fuego" + "3 de tipo Agua") y encima se pisan al validar.
  const vistas = new Set<string>();
  const unicas = partes.filter((p) => {
    if (vistas.has(p.plantilla)) return false;
    vistas.add(p.plantilla);
    return true;
  });
  if (setId !== null && unicas.length < 2) return null;

  const requisitos: Requisito[] = [];
  let esfuerzo = 0;
  let valorLote = 0;
  let valorTecho = 0;
  let cartas = 0;

  unicas.forEach((p, i) => {
    // El primero de una oferta de set va atado; el resto, sueltos.
    const atado = setId !== null && i === 0;
    // Se clona el filtro: el catálogo es compartido entre todas las ofertas y
    // devolverlo por referencia invitaría a mutarlo desde fuera.
    const filtro: Filtro = { ...p.filtro };
    if (filtro.categoria === "set" && setId !== null) filtro.valor = setId;
    requisitos.push({
      descripcion: p.texto + (atado ? ` de ${nombreDeSet(setId, nombres)}` : " (cualquier expansión)"),
      cantidad: p.cantidad,
      filtro,
      setId: atado ? setId : null,
    });
    esfuerzo += atado ? p.esfuerzo : p.esfuerzo * FACTOR_LIBRE;
    valorLote += p.cantidad * p.precioUnidad;
    valorTecho += p.cantidad * p.precioTecho;
    cartas += p.cantidad;
  });

  if (esfuerzo > ESFUERZO_MAXIMO) return null;
  // El servidor rechaza entregas demasiado largas: una oferta que pida más
  // cartas que su tope sería imposible de cobrar.
  if (cartas > MAX_CARTAS_OFERTA) return null;

  const principal = unicas[0];
  const dificultad = dificultadDe(esfuerzo);
  const titulo = elegir(rng, TITULOS[principal.plantilla] ?? ["Encargo del mercado"]);
  const gancho =
    setId === null
      ? `Alguien busca ${unicas.map((p) => p.mote).join(" y ")} de cualquier expansión: ${elegir(rng, REMATES)}.`
      : `El comprador quiere ${principal.mote} de ${nombreDeSet(setId, nombres)}: ${elegir(rng, REMATES)}.`;
  // La regla de los duplicados va en la descripción a propósito: es la primera
  // pregunta que se hace el jugador al ver el lote ("¿me quedo sin la carta?").
  const descripcion = `${gancho} Sólo duplicados: de cada carta que entregues te quedará una copia en el álbum.`;

  return {
    id: `${setId ?? "libre"}|${unicas.map((p) => p.clave).join("+")}`,
    titulo,
    descripcion,
    requisitos,
    multiplicador: calcularMultiplicador(esfuerzo, valorLote),
    dificultad,
    setId,
    esfuerzo,
    valorLote,
    valorTecho,
  };
}

/**
 * Sortea el tablón de ofertas de un ciclo.
 *
 * Garantías (las verifica scripts/sim-mercado.mjs):
 *  - determinista: misma semilla + mismos setIds ⇒ mismas ofertas.
 *  - al menos una oferta de expansión libre (setId null).
 *  - toda oferta atada a un set tiene al menos un requisito de set libre, así
 *    que siempre hay un camino para completarla.
 *  - ninguna pide más cartas de las que el servidor acepta en una entrega.
 *  - el reparto de dificultades sigue COMPOSICION_CICLO mientras haya sitio.
 */
export function generarOfertas(
  semilla: number,
  setIds: string[],
  cuantas: number,
  /**
   * Rótulos de expansión, opcionales. Sólo cambian TEXTO: el sorteo depende de
   * `semilla`, `setIds` y `cuantas`, así que pasarlos o no da exactamente las
   * mismas ofertas con los mismos ids. Va al final y opcional porque las dos
   * simulaciones (scripts/sim-*.mjs) llaman con tres argumentos.
   */
  nombres?: Record<string, string>,
): Oferta[] {
  if (cuantas <= 0) return [];
  const sets = setIds.filter(Boolean);
  const rng = crearRng(semilla * 2654435761 + cuantas);

  // Cupos proporcionales a COMPOSICION_CICLO (definida para OFERTAS_ACTIVAS).
  const base = COMPOSICION_CICLO.facil + COMPOSICION_CICLO.media + COMPOSICION_CICLO.dificil;
  const cupo: Record<Oferta["dificultad"], number> = {
    facil: Math.max(1, Math.round((COMPOSICION_CICLO.facil * cuantas) / base)),
    dificil: Math.max(1, Math.round((COMPOSICION_CICLO.dificil * cuantas) / base)),
    media: 0,
  };
  cupo.media = Math.max(0, cuantas - cupo.facil - cupo.dificil);

  const elegidas: Candidata[] = [];
  const ids = new Set<string>();
  const sobrantes: Candidata[] = [];
  // La primera siempre es de expansión libre: es la red de seguridad del tablón
  // (siempre hay algo que se puede completar con lo que ya tienes), así que
  // entra aunque su dificultad no cuadre con el cupo.
  let primera = true;

  for (let intento = 0; intento < cuantas * 240 && elegidas.length < cuantas; intento++) {
    // La mitad del tablón va de expansión libre. Con la regla de los duplicados,
    // una oferta atada a una expansión sólo la puede cumplir quien lleve DECENAS
    // de sobres de ESA expansión: si el tablón fuera casi todo atado (como
    // antes), al jugador centrado en un set le quedaría una oferta al día y el
    // mercado volvería a ser decorativo. Medido: pasar de 1 de cada 8 a la mitad
    // multiplica por tres las ofertas que completa un jugador normal.
    //
    // El 0,35 no es el 50% que sale: las ofertas atadas se descartan más a
    // menudo (exigen dos requisitos de plantillas distintas), así que con 0,35
    // el tablón acaba mitad y mitad. La otra mitad, atada, es la que da razones
    // para abrir una expansión concreta.
    const libre = primera || rng() < 0.35 || sets.length === 0;
    const setId = libre ? null : elegir(rng, sets);
    const cand = montarOferta(rng, setId, nombres);
    if (!cand || ids.has(cand.id)) continue;

    if (primera || cupo[cand.dificultad] > 0) {
      cupo[cand.dificultad] = Math.max(0, cupo[cand.dificultad] - 1);
      ids.add(cand.id);
      elegidas.push(cand);
      primera = false;
    } else if (sobrantes.length < cuantas * 3) {
      sobrantes.push(cand);
    }
  }

  // Si algún cupo no se pudo llenar (catálogo corto, pocos sets), se completa
  // con lo que hubiera salido: más vale un tablón lleno que un hueco.
  for (const s of sobrantes) {
    if (elegidas.length >= cuantas) break;
    if (ids.has(s.id)) continue;
    ids.add(s.id);
    elegidas.push(s);
  }

  return elegidas.map(({ esfuerzo: _e, valorLote: _v, valorTecho: _t, ...oferta }) => oferta);
}
