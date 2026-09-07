/**
 * LA ESCALA DE MOVIMIENTO, EN JAVASCRIPT.
 *
 * POR QUÉ EXISTE ESTE FICHERO. La escala vive en app/globals.css como custom
 * properties (--d-tap, --d-fast, --d-base, --d-slow, --ease-out, --ease-ios) y
 * allí está su documentación larga: qué significa cada escalón y por qué son
 * cuatro y no nueve. Pero framer-motion NO LEE variables CSS: sus duraciones y
 * sus curvas son números de JavaScript que se evalúan antes de que exista un
 * elemento del que heredar nada. Así que cada componente animado se copiaba los
 * valores a mano.
 *
 * Lo que se encontró al contarlo: la curva `[0.16, 1, 0.3, 1]` está escrita
 * VEINTITRÉS veces a lo largo del código —en la portada, en el álbum, en la
 * colección, en la ficha de carta, en el buscador, en las cinco pantallas de
 * graduación, en la tesela de expansión, en el intercambio— y hay SIETE muelles
 * distintos para lo que en pantalla son tres o cuatro gestos. Ninguna de esas
 * copias sabe de las demás. Cambiar la curva de la casa hoy significa acertar
 * las veintitrés a mano; olvidar una deja una pantalla moviéndose distinto a
 * las otras, que es exactamente el defecto que nadie sabe señalar pero todo el
 * mundo nota. Y cuando el CSS y el JavaScript se desincronizan, la misma hoja
 * puede entrar con una curva y volver con otra.
 *
 * QUÉ HACE ESTE MÓDULO: ser el único sitio donde esos números están escritos
 * del lado de JavaScript. No sustituye a las variables CSS —lo que se anima por
 * CSS las sigue usando—; es su ESPEJO declarado, con la obligación explícita de
 * tocar los dos a la vez.
 *
 * ESTE ENCARGO NO HACE EL BARRIDO. Las 23 copias siguen donde estaban a
 * propósito: sustituirlas es trabajo de los barridos por pantalla, que revisan
 * cada animación con su contexto delante. Aquí sólo se crea la pieza y se
 * enchufa en dos sitios como ejemplo vivo de cómo se usa: app/template.tsx (la
 * transición de ruta, que es la animación más visible de la aplicación) y
 * components/ui/Sheet.tsx (la hoja inferior, que es la que más se repite).
 *
 * MÓDULO PURO: ni React, ni "use client", ni un solo import. Lo pueden leer un
 * componente de servidor, uno de cliente y un script de Node por igual.
 */

/**
 * Duraciones EN SEGUNDOS, que es la unidad de framer-motion (`duration: 0.22`).
 * El CSS las declara en milisegundos porque es la suya. Son los mismos cuatro
 * escalones, con el mismo significado que documenta app/globals.css:
 *
 *   tap   respuesta al dedo; el único valor que no se puede subir.
 *   fast  cambio de estado sin recorrido: color, borde, sombra.
 *   base  recorrido corto: un aviso que entra, una hoja que se va.
 *   slow  recorrido largo y visible: el cambio de pantalla.
 */
export const D = {
  tap: 0.08,
  fast: 0.14,
  base: 0.22,
  slow: 0.34,
} as const;

/**
 * Las dos curvas, como arrays de cuatro números: es la forma que framer espera
 * en `ease` y la que permite escribirlas una sola vez.
 *
 * El tipo va anotado a mano (y no `as const`) porque framer tipa `ease` como
 * una tupla de cuatro números: un array de longitud variable no le vale, y un
 * `readonly` tampoco encaja donde pide una tupla mutable.
 */

/** La de siempre en este tema: arranca disparada y frena mucho. Para lo que
 *  APARECE — llega y se posa. Espejo de --ease-out. */
export const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

/** La de iOS: sale con más cuerpo y frena antes. Para todo lo que el dedo
 *  puede empujar — hojas, transiciones de ruta, retorno de un arrastre.
 *  Espejo de --ease-ios. */
export const EASE_IOS: [number, number, number, number] = [0.32, 0.72, 0, 1];

/**
 * LOS MUELLES, que son la parte que NO cabe en una variable CSS.
 *
 * Un muelle no tiene duración: tiene rigidez, amortiguación y masa, y de esos
 * tres sale el tiempo que tarde. Por eso viven aquí y no en globals.css. Se
 * declaran DOS y no siete porque en pantalla sólo hay dos gestos de muelle:
 * algo grande que llega a su sitio y algo pequeño que se coloca.
 */

/**
 * PANELES: la hoja inferior y cualquier cosa grande que entra ocupando la
 * pantalla.
 *
 * NO REBOTA, y es deliberado. La amortiguación efectiva queda ligeramente por
 * encima de 1 (sobreamortiguado): un rebote en una hoja anclada al borde de
 * abajo la levantaría unos píxeles por encima de su sitio y dejaría ver una
 * franja de fondo por debajo. El razonamiento largo está en
 * components/ui/Sheet.tsx, que es de donde salen estos tres números.
 */
export const MUELLE_PANEL = {
  type: "spring",
  stiffness: 380,
  damping: 38,
  mass: 0.9,
} as const;

/**
 * PÍLDORAS E INDICADORES: la pastilla que se desliza bajo la pestaña activa,
 * una insignia que aparece, un chip que cambia de sitio.
 *
 * Un pelín menos rígido y menos amortiguado que el de los paneles: aquí el
 * recorrido es corto y el objeto pequeño, así que un frenado tan seco como el
 * del panel se lee como un salto en vez de como un desplazamiento.
 */
export const MUELLE_PILDORA = {
  type: "spring",
  stiffness: 360,
  damping: 34,
  mass: 0.8,
} as const;
