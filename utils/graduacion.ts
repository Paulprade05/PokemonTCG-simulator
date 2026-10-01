// utils/graduacion.ts
//
// EL SISTEMA DE GRADUACIÓN.
//
// Mandas una copia a graduar, pagas, y te la devuelven con una nota del 1 al 10
// que multiplica lo que vale. La gracia es que la nota YA ESTABA DECIDIDA desde
// que te tocó la carta: no se sortea al graduar, se REVELA. Por eso este fichero
// no tiene azar; todo sale de una semilla estable.
//
// SIN IMPORTS, A PROPÓSITO. Igual que utils/packLogic.ts, esto lo cargan los
// scripts de simulación con un `require` falso que sólo sabe resolver
// "constanst". Un import nuevo aquí rompe scripts/test-invariantes.mjs sin que
// TypeScript diga nada. El valor de la carta entra por parámetro justo por eso.

/* ==================================================================== *
 * LA SEMILLA: POR QUÉ LA NOTA NO SE SORTEA AL GRADUAR
 * ====================================================================
 *
 * Si la nota se tirase al pulsar el botón, graduar sería una tragaperras: el
 * que no queda contento vende, vuelve a comprar la carta en el mercado y vuelve
 * a tirar. Derivándola de (usuario, carta, nº de copia) la nota es un HECHO de
 * esa copia concreta desde que entró en la colección, y volver a intentarlo con
 * la MISMA copia da siempre lo mismo.
 *
 * Dos copias de la misma carta del mismo usuario tienen notas distintas porque
 * el índice entra en la semilla. Eso es lo que hace que elegir cuál gradúas
 * signifique algo.
 */

/** Hash de cadena a entero de 32 bits (xmur3). Determinista y estable. */
function semillaEntera(texto: string): number {
  let h = 1779033703 ^ texto.length;
  for (let i = 0; i < texto.length; i++) {
    h = Math.imul(h ^ texto.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Generador determinista (mulberry32) a partir de una semilla entera. Devuelve
 * una función que da números en [0,1) — misma semilla, misma secuencia, en el
 * navegador y en el servidor.
 */
function generador(semilla: number): () => number {
  let a = semilla >>> 0;
  return function siguiente() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ==================================================================== *
 * EL SECRETO: POR QUÉ LA SEMILLA NO PUEDE SER PÚBLICA
 * ====================================================================
 *
 * PRIMERA VERSIÓN, Y ERA UN AGUJERO DE LOS GORDOS: la semilla era
 * `idUsuario|idCarta|indice` a secas. Los tres datos los conoce el navegador —el
 * id de Clerk está en la sesión del cliente, el de la carta lo pinta la propia
 * pantalla y el índice es 1, 2, 3...— y `notaDeCopia` es una función exportada
 * de este fichero, que baja al navegador porque la pantalla de graduación
 * importa de aquí la tabla de probabilidades y los desperfectos.
 *
 * O sea: cualquiera podía abrir la consola y calcular LA NOTA DE TODAS SUS
 * COPIAS SIN GRADUAR. Y eso no es un fallo estético, es la ruina de la
 * economía: la tabla de multiplicadores está calibrada para que graduar salga
 * a perder de media (×1,048 frente al techo de ×1,40), pero eso sólo vale si el
 * jugador no sabe lo que le va a tocar. Sabiéndolo, gradúa SÓLO los dieces
 * —×1,95— y cada graduación es beneficio garantizado. Exactamente la imprenta
 * que los multiplicadores existen para cerrar.
 *
 * EL ARREGLO tiene dos mitades y hacen falta las dos:
 *   1. la semilla lleva un SECRETO que sólo está en el servidor (aquí);
 *   2. el servidor NO manda la semilla al cliente NUNCA. Manda la nota y los
 *      desperfectos ya calculados, y sólo de las copias YA graduadas, que son
 *      aquéllas cuya nota el jugador ya ha pagado por conocer.
 *
 * CAMBIAR EL SECRETO ES SEGURO. Las notas ya asignadas están guardadas en
 * `graded_cards.nota` y no se recalculan al leerlas; lo único que cambia es qué
 * nota les tocará a las copias que aún nadie ha graduado. Así que se puede
 * poner o rotar en cualquier momento sin romperle la vitrina a nadie.
 */

/**
 * Identidad de una copia concreta. `indice` empieza en 1.
 *
 * El id del usuario entra para que dos jugadores con la misma carta no tengan
 * la misma nota: si no, se filtraría en cuanto uno publicase la suya. Y el
 * `secreto` entra para que no la pueda calcular ni su propio dueño (ver arriba).
 *
 * NO LLAMES A ESTO DESDE EL CLIENTE. El secreto es de servidor; si esta función
 * se llamara en el navegador, el secreto no estaría y todas las copias
 * compartirían el mismo espacio de semillas público, que es justo el agujero.
 */
export function semillaDeCopia(
  idUsuario: string,
  idCarta: string,
  indice: number,
  secreto: string,
): string {
  return secreto + "|" + idUsuario + "|" + idCarta + "|" + indice;
}

/* ==================================================================== *
 * LA TABLA DE NOTAS
 * ====================================================================
 *
 * Dos tramos, como se pidió: un 5% de las copias cae en el tramo malo (1-6) y
 * el 95% restante en el bueno (7-10). Dentro de cada tramo, su propio reparto.
 *
 *   nota:  10      9      8      7      6      5      4      3      2      1
 *   prob: 14,25% 38,00% 19,00% 23,75%  1,40%  1,10%  1,00%  0,75%  0,50%  0,25%
 */
export const PROB_TRAMO_BAJO = 0.05;

const REPARTO_BAJO: readonly (readonly [number, number])[] = [
  [1, 0.05], [2, 0.10], [3, 0.15], [4, 0.20], [5, 0.22], [6, 0.28],
];
const REPARTO_ALTO: readonly (readonly [number, number])[] = [
  [7, 0.25], [8, 0.20], [9, 0.40], [10, 0.15],
];

/** Probabilidad final de cada nota, ya combinados los dos tramos. */
export const PROBABILIDAD_NOTA: Record<number, number> = (() => {
  const p: Record<number, number> = {};
  for (const [n, q] of REPARTO_BAJO) p[n] = PROB_TRAMO_BAJO * q;
  for (const [n, q] of REPARTO_ALTO) p[n] = (1 - PROB_TRAMO_BAJO) * q;
  return p;
})();

/* ==================================================================== *
 * LOS MULTIPLICADORES: POR QUÉ NO SON LOS DE LA IDEA ORIGINAL
 * ====================================================================
 *
 * La propuesta era 10→×3, 9→×2, 8→×1,5, 7→×1, y de ahí para abajo. Medido con
 * las probabilidades de arriba, eso da un MULTIPLICADOR MEDIO DE ×1,7415.
 *
 * Y ×1,74 con un coste fijo de 100 monedas es una imprenta: graduar sale a
 * cuenta en cuanto la carta pasa de 135 monedas, y como se pueden graduar las
 * REPETIDAS, el bucle no termina nunca. Una Hyper Rare (250) daba +85 monedas
 * de beneficio esperado POR COPIA. Eso rompe la promesa de utils/packLogic.ts
 * de que ningún sobre devuelve más de lo que cuesta, porque el sobre deja de
 * ser el único sitio donde se genera dinero.
 *
 * EL ARREGLO NO ES SÓLO BAJAR NÚMEROS. Con coste FIJO C sobre una carta de
 * valor V, graduar es neutral cuando EV·V = V + C, o sea EV = 1 + C/V: con
 * C=100 la neutralidad pide ×1,67 a 150 monedas y ×1,40 a 250. Una sola tabla
 * NO PUEDE ser neutral a los dos valores. Por eso el coste lleva un tramo
 * proporcional (ver COSTE_FRACCION): con coste = f·V la neutralidad pasa a ser
 * EV = 1+f, que ya no depende de V, y una sola tabla vale para todo el catálogo.
 *
 * Con f = 0,40 el techo es ×1,40. La tabla de abajo da ×1,048 de media (lo
 * imprime `npm test`): graduar es un sumidero salvo que salga el diez. Los
 * números que mandan son los de la tabla; el porqué de que el diez y el nueve
 * sean tan bajos está en el bloque siguiente.
 *
 * COMPROBADO EN scripts/test-invariantes.mjs: si alguien toca esta tabla y el
 * multiplicador medio se pasa del techo, el test falla.
 */
export const MULTIPLICADOR_NOTA: Record<number, number> = {
  1: 0.0, 2: 0.08, 3: 0.18, 4: 0.25, 5: 0.3,
  6: 0.55, 7: 0.7, 8: 0.9, 9: 1.1, 10: 1.95,
};

/* ==================================================================== *
 * POR QUÉ EL DIEZ VALE ×1,95 Y EL NUEVE ×1,1
 * ====================================================================
 *
 * LOS NÚMEROS QUE MANDAN SON LOS DE LA TABLA DE ARRIBA:
 *
 *   nota:   10     9     8     7     6     5     4     3     2     1
 *   mult:  ×1,95  ×1,1  ×0,9  ×0,7  ×0,55 ×0,3  ×0,25 ×0,18 ×0,08  ×0
 *
 * Aquí hubo dos bloques que contaban tablas anteriores (el diez a ×3 y luego a
 * ×1,8; el nueve a ×1,5 y luego a ×1,35) como si fueran la de hoy. No lo son.
 * Lo que sigue es el razonamiento que las fue bajando, que sí sigue valiendo.
 *
 * EL DESGASTE SE VE ANTES DE PAGAR, Y ESO CAMBIA LA CUENTA. Mientras la carta
 * llegaba sin marcas el jugador graduaba a ciegas, y bastaba con que la media
 * de TODA la tabla no pasara del techo (×1,40). Desde que el estado físico se
 * enseña —y se pidió que se notara también en las notas altas: un nueve con
 * una marca, un ocho con dos— el jugador gradúa lo que parece mejor. Lo que
 * hay que mantener por debajo del techo ya no es la media global, sino la
 * media de CADA ASPECTO que se puede distinguir a ojo, y el aspecto más limpio
 * arrastra a los dieces.
 *
 * Con el diez a ×3 ese grupo limpio imprimía (×1,72), y compensarlo hundiendo
 * el resto convertía graduar en un castigo. Por eso el premio gordo es ×1,95 y
 * no ×3, y por eso el nueve —que cae el 38 % de las veces— se queda en ×1,1.
 *
 * LO QUE DA HOY, medido por `npm test`:
 *   · la media de toda la tabla, ×1,048;
 *   · el mejor grupo que se puede distinguir con el estado EXACTO que manda el
 *     servidor, ×1,39 (techo ×1,40);
 *   · graduar sólo las copias que llegan impecables tampoco gana, a ningún
 *     valor ni con ningún descuento.
 *
 * SI ALGÚN DÍA SE QUIERE UN DIEZ MÁS GORDO: hay que dejar de enseñar el
 * desgaste de las notas altas (bajar UMBRAL_DESGASTE_VISIBLE) o bajar otra
 * nota a cambio. Las dos cosas van juntas, o el invariante "ningún estado
 * visible delata una nota" se pone rojo, que es exactamente su trabajo: agrupa
 * por lo que el jugador VE, no por la nota.
 */

/** Fracción del valor de la carta que cuesta graduarla por encima del suelo. */
export const COSTE_FRACCION = 0.4;

/** Suelo del coste: lo que se paga por cualquier carta de hasta 250 monedas. */
export const COSTE_BASE = 100;

/** Multiplicador medio de la tabla. Por encima de 1+COSTE_FRACCION, imprime. */
export const MULTIPLICADOR_MEDIO = Object.keys(PROBABILIDAD_NOTA).reduce(
  (suma, n) => suma + PROBABILIDAD_NOTA[Number(n)] * MULTIPLICADOR_NOTA[Number(n)],
  0,
);

/* ==================================================================== *
 * DESCUENTO POR VOLUMEN
 * ====================================================================
 *
 * Mandar muchas de golpe sale más barato, como en la vida real. El descuento
 * se aplica SÓLO al suelo de 100: el tramo proporcional (0,40 × valor) sigue
 * mandando en las caras, que son las únicas que podrían imprimir. Por eso ni
 * con el 75% de descuento se abre el agujero — comprobado en el invariante.
 */
const ESCALONES_DESCUENTO: readonly (readonly [number, number])[] = [
  [25, 0.3], // 25 o más: 30%
  [10, 0.2], // 10 o más: 20%
  [5, 0.1],  //  5 o más: 10%
];

/** Descuento (0-1) que corresponde a graduar `cuantas` copias de una tacada. */
export function descuentoPorVolumen(cuantas: number): number {
  for (const [minimo, descuento] of ESCALONES_DESCUENTO) {
    if (cuantas >= minimo) return descuento;
  }
  return 0;
}

/**
 * Lo que cuesta graduar UNA copia que hoy vale `valor` monedas.
 *
 * El suelo es lo que se paga de verdad en todo el catálogo actual: la carta más
 * cara son 250 monedas y 0,40 × 250 = 100 justo. El tramo proporcional sólo
 * entra en juego si algún día una carta pasa de ahí — que es exactamente lo que
 * hace el ajuste por precio real de Cardmarket.
 */
export function costeDeGraduar(valor: number, cuantasDeUnaVez = 1): number {
  const suelo = Math.round(COSTE_BASE * (1 - descuentoPorVolumen(cuantasDeUnaVez)));
  return Math.max(suelo, Math.round(COSTE_FRACCION * valor));
}

/* ==================================================================== *
 * LA NOTA Y LOS DESPERFECTOS
 * ==================================================================== */

/** Qué se le ve a la copia. Todo sale de la semilla; nada es aleatorio en vivo. */
export interface Desperfectos {
  /** Muescas blancas en el borde. Es lo que más pesa en la nota real. */
  piques: number;
  /** Arañazos en la superficie. */
  aranazos: number;
  /** Manchas / marcas de manoseo. */
  manchas: number;
  /** Descentrado, en % del ancho y del alto. 0 = perfecta. */
  descentrado: { x: number; y: number };
  /** Decoloración por sol, de 0 (color correcto) a 1 (muy pálida). */
  palidez: number;
}

/**
 * La nota de una copia. Determinista: misma semilla, misma nota, siempre.
 *
 * Se consume el PRIMER número del generador y sólo ése, para que añadir
 * desperfectos nuevos más abajo no cambie ninguna nota ya asignada.
 */
export function notaDeCopia(semilla: string): number {
  const azar = generador(semillaEntera(semilla));
  const tirada = azar();
  const enElBajo = tirada < PROB_TRAMO_BAJO;
  const reparto = enElBajo ? REPARTO_BAJO : REPARTO_ALTO;
  const dentro = enElBajo
    ? tirada / PROB_TRAMO_BAJO
    : (tirada - PROB_TRAMO_BAJO) / (1 - PROB_TRAMO_BAJO);

  let acumulado = 0;
  for (const [nota, prob] of reparto) {
    acumulado += prob;
    if (dentro < acumulado) return nota;
  }
  return reparto[reparto.length - 1][0];
}

/**
 * Cuántos piques tolera cada nota. Es la escala que se pidió, y la que hace que
 * un 10 se vea limpio y un 3 se vea destrozado:
 *
 *   10 → ninguno · 9 → uno · 8 → hasta dos · 7 → de uno a tres
 *    6 → varios en los bordes · 4-5 → arañazos y descentrado
 *    1-3 → manchas, arañazos, pálida y mal centrada
 */
const TOPE_PIQUES: Record<number, readonly [number, number]> = {
  /* LOS CUATRO TRAMOS ALTOS EMPIEZAN EN CERO, Y ES LO QUE HACE QUE ESTO SEA
   * SEGURO. Un diez está siempre impecable, pero un nueve TAMBIÉN puede salir
   * sin ninguna marca, y un ocho y un siete igual. Así, ver una carta limpia no
   * demuestra que sea un diez: es lo más probable que lo sea, no una certeza.
   *
   * Si el nueve empezara en 1 —como estaba— entonces "cero marcas" equivaldría
   * a "diez garantizado", y graduar sólo ésas sería beneficio asegurado. Fue el
   * primer diseño y lo cazó el invariante: cero piques era SIEMPRE un diez.
   *
   * De media sí se nota: un siete enseña 1,5 marcas y un diez ninguna. Lo que
   * no hay es una marca que delate una nota concreta. */
  10: [0, 0], 9: [0, 1], 8: [0, 2], 7: [0, 3], 6: [4, 7],
  5: [6, 10], 4: [8, 13], 3: [10, 16], 2: [13, 20], 1: [16, 26],
};

/**
 * Los desperfectos VISIBLES de una copia, derivados de la misma semilla que su
 * nota y coherentes con ella. Nunca contradicen la nota: un 10 no puede salir
 * con un arañazo.
 *
 * Se salta el primer número del generador (el que gastó notaDeCopia) para que
 * los desperfectos no queden correlacionados con la tirada de la nota.
 */
export function desperfectosDeCopia(semilla: string, nota?: number): Desperfectos {
  const n = nota ?? notaDeCopia(semilla);
  const azar = generador(semillaEntera(semilla));
  azar(); // el número que gastó la nota

  const entre = (min: number, max: number) => min + azar() * (max - min);
  const topes = TOPE_PIQUES[n] ?? [0, 0];

  // Los arañazos aparecen a partir del 5 hacia abajo; las manchas, del 3.
  const aranazos = n >= 6 ? 0 : Math.round(entre(1, 3 + (6 - n) * 1.6));
  const manchas = n >= 4 ? 0 : Math.round(entre(1, 2 + (4 - n) * 1.5));

  // El descentrado entra a partir del 6 y se dispara en el tramo bajo.
  const maxDesc = n >= 8 ? 0 : n >= 6 ? 1.2 : n >= 4 ? 3.0 : 5.5;
  const signo = () => (azar() < 0.5 ? -1 : 1);

  // La palidez es de sol: sólo el tramo 1-3, que es el que "tiene mal color".
  const palidez = n <= 3 ? Math.min(1, entre(0.35, 0.75) + (3 - n) * 0.08) : 0;

  return {
    piques: Math.round(entre(topes[0], topes[1])),
    aranazos,
    manchas,
    descentrado: {
      x: Number((signo() * entre(0, maxDesc)).toFixed(2)),
      y: Number((signo() * entre(0, maxDesc)).toFixed(2)),
    },
    palidez: Number(palidez.toFixed(3)),
  };
}

/* ==================================================================== *
 * DÓNDE ESTÁ CADA MARCA
 * ====================================================================
 *
 * `desperfectosDeCopia` dice CUÁNTOS piques, arañazos y manchas tiene la copia.
 * Esto dice DÓNDE, para que la interfaz pueda pintarlos.
 *
 * VA APARTE Y NO DENTRO DEL OTRO por dos razones. La primera es que las
 * posiciones sólo le hacen falta a quien pinta, y `desperfectosDeCopia` lo
 * llaman también el servidor y las pruebas, que no pintan nada. La segunda es
 * más importante: consume su PROPIO generador, sembrado con un sufijo distinto,
 * de modo que añadir o quitar marcas aquí NO puede mover la secuencia de la que
 * sale la nota. Una nota ya asignada no puede cambiar nunca porque alguien
 * retoque la decoración.
 */
export interface MarcaVisual {
  /** Posición en % de la cara de la carta. */
  x: number;
  y: number;
  /** Tamaño en % del ancho de la carta. */
  tam: number;
  /** Giro en grados. Sólo lo usan los arañazos. */
  giro: number;
  /** Opacidad relativa, para que no salgan todas igual de marcadas. */
  fuerza: number;
}

export interface MarcasDeCarta {
  /** Muescas blancas del borde: siempre pegadas a un canto. */
  piques: MarcaVisual[];
  aranazos: MarcaVisual[];
  manchas: MarcaVisual[];
}

/**
 * Las posiciones de todas las marcas de una copia. Determinista.
 *
 * Los piques van SIEMPRE pegados a un borde porque eso es lo que son en una
 * carta de verdad: el cartón blanco que asoma donde la tinta se ha descascarado
 * en el canto. Repartirlos por el centro los convertiría en confeti.
 */
export function marcasDeCopia(semilla: string, desperfectos: Desperfectos): MarcasDeCarta {
  // Sufijo propio: secuencia independiente de la de la nota.
  const azar = generador(semillaEntera(semilla + "|marcas"));
  const entre = (min: number, max: number) => min + azar() * (max - min);

  const piques: MarcaVisual[] = [];
  for (let i = 0; i < desperfectos.piques; i++) {
    // Se reparten por los cuatro cantos, con el lado elegido al azar.
    const lado = Math.floor(azar() * 4); // 0 arriba, 1 derecha, 2 abajo, 3 izquierda
    const a = entre(3, 97);
    const pegado = entre(-0.6, 1.2); // un pelo fuera para que muerda el canto
    const pos =
      lado === 0 ? { x: a, y: pegado }
      : lado === 1 ? { x: 100 - pegado, y: a }
      : lado === 2 ? { x: a, y: 100 - pegado }
      : { x: pegado, y: a };
    piques.push({ ...pos, tam: entre(0.8, 2.6), giro: 0, fuerza: entre(0.55, 1) });
  }

  const aranazos: MarcaVisual[] = [];
  for (let i = 0; i < desperfectos.aranazos; i++) {
    aranazos.push({
      x: entre(8, 92),
      y: entre(8, 92),
      tam: entre(12, 46), // longitud, en % del ancho
      giro: entre(-80, 80),
      fuerza: entre(0.25, 0.6),
    });
  }

  const manchas: MarcaVisual[] = [];
  for (let i = 0; i < desperfectos.manchas; i++) {
    manchas.push({
      x: entre(10, 90),
      y: entre(10, 90),
      tam: entre(8, 26),
      giro: 0,
      fuerza: entre(0.18, 0.42),
    });
  }

  return { piques, aranazos, manchas };
}

/* ==================================================================== *
 * QUÉ SE VE ANTES DE PAGAR
 * ====================================================================
 *
 * La carta llega del sobre con su estado físico a la vista: una copia
 * machacada se ve machacada desde el primer momento, en la apertura y en la
 * colección. Lo que NO se ve es la nota, que es justo lo que se paga por saber.
 *
 * EL UMBRAL VALE 10: SE PINTA EL DESGASTE DE TODAS LAS NOTAS. Lo que protege
 * la economía no es esconderlo, sino dos cosas que van juntas:
 *   · un 7, un 8 y un 9 también pueden salir sin una sola marca (TOPE_PIQUES
 *     empieza en cero en los cuatro tramos altos), así que "impecable" no
 *     quiere decir "diez";
 *   · la tabla de multiplicadores está bajada para que ni el aspecto más
 *     limpio compense graduarlo (ver "POR QUÉ EL DIEZ VALE ×1,95", arriba).
 *
 * DE DÓNDE VIENE: el desgaste está construido para ser coherente con la nota,
 * así que enseñarlo la delata en parte. En la primera versión una carta con
 * cero piques era SIEMPRE un 10, y por eso el umbral empezó en 6 (sólo se
 * pintaban las notas 1 a 6, el 5 % de las copias). Se pidió que el desgaste se
 * notara también en las notas altas, y se pagó con la tabla, no escondiéndolo.
 *
 * CAMBIAR ESTE NÚMERO O LA TABLA SIN EL OTRO REABRE LA FUGA. Lo comprueba el
 * invariante "ningún estado visible delata una nota" de
 * scripts/test-invariantes.mjs, que agrupa las copias por lo que se ve y exige
 * que ningún grupo compense graduarlo.
 */
export const UMBRAL_DESGASTE_VISIBLE = 10;

/** ¿Se pinta el estado de esta copia antes de graduarla? */
export function desgasteEsVisible(nota: number): boolean {
  return nota <= UMBRAL_DESGASTE_VISIBLE;
}

/**
 * A partir de cuánto descentrado (|x| + |y|, en %) una copia se ve torcida. Es
 * el mismo 1,5 con el que `firmaVisible` separa "torcida" de "recta" y con el
 * que la interfaz decide rotular "mal centrada" (components/DesperfectosCarta).
 */
export const DESCENTRADO_QUE_SE_NOTA = 1.5;

/**
 * Lo que el jugador puede DISTINGUIR de una copia sin graduarla.
 *
 * Existe para el invariante, no para la interfaz: agrupa las copias por lo que
 * se ve, de modo que se pueda comprobar que ningún grupo delata la nota. Si
 * algún día la pantalla enseña más detalle del que describe esta función, el
 * invariante dejará de proteger lo que cree proteger — así que las dos cosas se
 * cambian juntas.
 *
 * Los recuentos se agrupan en tramos ("pocos", "varios", "muchos") porque nadie
 * cuenta diecisiete piques de un vistazo: lo que se percibe es el tramo.
 */
export function firmaVisible(d: Desperfectos, nota: number): string {
  if (!desgasteEsVisible(nota)) return "limpia";
  const tramo = (n: number) => (n === 0 ? "0" : n <= 3 ? "pocos" : n <= 8 ? "varios" : "muchos");
  return [
    "p" + tramo(d.piques),
    "a" + tramo(d.aranazos),
    "m" + tramo(d.manchas),
    d.palidez > 0 ? "palida" : "color",
    Math.abs(d.descentrado.x) + Math.abs(d.descentrado.y) > DESCENTRADO_QUE_SE_NOTA
      ? "torcida"
      : "recta",
  ].join("|");
}

/**
 * ¿Se ve LIMPIA esta copia? O sea: ¿no hay nada que pintarle ni que nombrarle?
 *
 * Es el grupo "p0|a0|m0|color|recta" de `firmaVisible`, dicho con un sí o un
 * no. Lo usa el servidor para decidir si manda el estado físico de una copia:
 * de una copia que se ve limpia NO VIAJA NADA.
 *
 * POR QUÉ IMPORTA, MEDIDO sobre 200.000 copias: mandar el desgaste de una copia
 * limpia parece inocuo —la pantalla no pinta nada con él— pero el JSON lleva el
 * descentrado con dos decimales, y "descentrado exactamente (0, 0)" deja fuera
 * a los sietes (que casi siempre traen algo). Ese grupo "todo a cero exacto"
 * da ×1,3955, a tres milésimas del techo ×1,40; el grupo que de verdad se VE
 * limpio —el que mide el invariante— da ×1,3465. Sin mandar nada, lo que sabe
 * quien lee la respuesta es lo mismo que sabe quien mira la carta.
 */
export function seVeLimpia(d: Desperfectos): boolean {
  return (
    d.piques === 0 &&
    d.aranazos === 0 &&
    d.manchas === 0 &&
    d.palidez === 0 &&
    Math.abs(d.descentrado.x) + Math.abs(d.descentrado.y) <= DESCENTRADO_QUE_SE_NOTA
  );
}

/**
 * Cuánto desgaste se le VE a una copia, en un solo número: sirve para ordenar
 * copias de "la que mejor se ve" a "la que peor". Menos es mejor; 0 es intacta.
 *
 * SÓLO MIRA LO QUE SE VE. No recibe la nota a propósito: quien elige qué copia
 * enseñar con esta función no puede, ni queriendo, decir nada de las notas que
 * el jugador no supiera ya por haber visto las cartas.
 */
export function desgasteALaVista(d: Desperfectos): number {
  return (
    d.piques +
    d.aranazos +
    d.manchas +
    d.palidez * 10 +
    Math.abs(d.descentrado.x) +
    Math.abs(d.descentrado.y)
  );
}

/**
 * Lo que vale una copia YA GRADUADA, a partir de lo que valdría sin graduar.
 *
 * OJO AL ORDEN: `valorSinGraduar` tiene que venir ya con la curva de copias
 * aplicada (utils/constanst.ts, valorDeVenta). Si se multiplicase el precio
 * base y luego se aplicase la curva, graduar sería la forma de esquivar la
 * curva anti-acaparamiento: 400 repetidas graduadas cobrarían el precio de la
 * primera. Se multiplica AL FINAL, sobre el precio que de verdad se iba a pagar.
 */
export function valorGraduado(valorSinGraduar: number, nota: number): number {
  const m = MULTIPLICADOR_NOTA[nota] ?? 0;
  return Math.max(0, Math.round(valorSinGraduar * m));
}

/** Rótulo corto de la nota, para la interfaz. */
export function etiquetaNota(nota: number): string {
  if (nota === 10) return "Gema Impecable";
  if (nota === 9) return "Impecable";
  if (nota === 8) return "Casi Impecable";
  if (nota === 7) return "Excelente";
  if (nota >= 5) return "Muy Buena";
  if (nota >= 3) return "Buena";
  return "Dañada";
}
