// utils/packLogic.ts
//
// Genera el contenido de los sobres. Vive en el cliente (app/page.tsx lo llama
// para animar la apertura), así que NO es una fuente de verdad de seguridad: el
// servidor tiene que validar por su cuenta lo que se guarda. Lo que sí es
// fuente de verdad es la ECONOMÍA del sobre —qué rarezas caen y con qué
// probabilidad—, y de eso va este fichero.

import { PACK_PRICES, precioDeCartaSuelta } from "./constanst";

interface Card {
  id: string;
  name: string;
  rarity: string;
  images: { small: string; large: string };
}

// 1. Clasificador de Rarezas (He añadido protección '?' por si la rareza viene vacía de la BD)
//
// OJO, ESTO NO ES UNA TABLA COMPLETA Y NO LO ARREGLES A CIEGAS: hay rarezas
// reales de los JSON que no caen en NINGÚN cubo ('Rare Ultra' 347 cartas,
// 'Promo' 469, 'Shiny Rare' 120, 'Rare Shiny' 104, 'ACE SPEC Rare' 33,
// 'Radiant Rare' 12, 'Amazing Rare' 9, 'Shiny Ultra Rare' 12). Esas cartas no
// salen nunca en sobre estándar ni premium; sólo llegan por la carta garantizada
// del sobre Leyenda. Meterlas en su cubo "obvio" SUBE el valor del sobre y abre
// fugas nuevas: si 'Rare Ultra' (90 monedas) entrara en ultraRare, Evolving
// Skies pasaría de 49,3 a 51,0 por sobre de 50 —una imprenta— porque hoy esa
// rama cae por respaldo en doubleRare (48,6 de media). Medido en
// scripts/sim-economia.mjs. Si algún día se corrige, hay que recalibrar
// SELL_PRICES en la misma tacada.
const categorizeCards = (cards: Card[]) => {
  return {
    common: cards.filter(c => c.rarity === 'Common'),
    uncommon: cards.filter(c => c.rarity === 'Uncommon'),
    rare: cards.filter(c => c.rarity === 'Rare' || c.rarity === 'Rare Holo'),
    doubleRare: cards.filter(c => c.rarity === 'Double Rare' || c.rarity?.includes('V') || c.rarity?.includes('ex')),
    illustrationRare: cards.filter(c => c.rarity === 'Illustration Rare' || c.rarity?.includes('Trainer Gallery')),
    ultraRare: cards.filter(c => c.rarity === 'Ultra Rare' || c.rarity === 'Full Art'),
    specialIllustrationRare: cards.filter(c => c.rarity === 'Special Illustration Rare' || c.rarity?.includes('Secret')),
    hyperRare: cards.filter(c => c.rarity === 'Hyper Rare' || c.rarity === 'Secret Rare' || c.rarity?.includes('Rainbow')),
  };
};

type Pools = ReturnType<typeof categorizeCards>;
type NombreDePool = keyof Pools;

// 🛡️ FUNCIÓN DRAW BLINDADA (Ahora recibe 'allCards' como salvavidas final)
const draw = (
    pool: Card[],
    fallbackPool: Card[],
    currentPackIds: Set<string>,
    allCards: Card[] // 👈 AQUÍ ESTÁ LA MAGIA: El set completo como último recurso
): Card => {

  // 1. Si el pool principal y el fallback están vacíos (Sets Especiales), usamos TODAS las cartas
  const availableCards = pool.length > 0 ? pool : (fallbackPool.length > 0 ? fallbackPool : allCards);

  // Si a pesar de todo no hay cartas (BD vacía), lanzamos MissingNo
  if (!availableCards || availableCards.length === 0) {
    return { id: 'error', name: 'MissingNo', rarity: 'Common', images: { small: '', large: '' } } as Card;
  }

  // 2. Filtro anti-repetición
  const uniquePool = availableCards.filter(c => !currentPackIds.has(c.id));
  const finalPool = uniquePool.length > 0 ? uniquePool : availableCards;

  // 3. Elegimos la carta
  const selected = finalPool[Math.floor(Math.random() * finalPool.length)];
  currentPackIds.add(selected.id);

  return selected;
};

/* ==================================================================== *
 * EL REPARTO DEL HUECO DE PREMIO, ESCRITO COMO DATO
 * ====================================================================
 *
 * POR QUÉ COMO DATO Y NO COMO CADENA DE `if`: el mismo reparto lo consumen dos
 * sitios, el generador (sacarPremio) y el cálculo de valor esperado que calibra
 * el sobre (valorDelPremio). Con dos copias, el sobre acabaría corrigiéndose
 * contra unas probabilidades que ya no son las que reparten, y la corrección
 * mentiría sin que nadie se enterase.
 *
 * `prob` es el % de sobres que caen en la rama; `respaldo` es el pool al que
 * baja draw() cuando el set no tiene cartas de ese escalón (pasa mucho: las
 * expansiones de Espada y Escudo no tienen ni Illustration Rare ni Ultra Rare).
 * Los cortes son los mismos de siempre: 0,5 / 2,5 / 6,5 / 14,5 / 30 / 100.
 */
interface RamaDePremio {
  prob: number;
  pool: NombreDePool;
  respaldo: NombreDePool;
}

const PREMIO_ESTANDAR: readonly RamaDePremio[] = [
  { prob:  0.5, pool: 'hyperRare',               respaldo: 'ultraRare'  },
  { prob:  2.0, pool: 'specialIllustrationRare', respaldo: 'ultraRare'  },
  { prob:  4.0, pool: 'ultraRare',               respaldo: 'doubleRare' },
  { prob:  8.0, pool: 'illustrationRare',        respaldo: 'rare'       },
  { prob: 15.5, pool: 'doubleRare',              respaldo: 'rare'       },
  { prob: 70.0, pool: 'rare',                    respaldo: 'uncommon'   },
];

const PREMIO_PREMIUM: readonly RamaDePremio[] = [
  { prob:  5.0, pool: 'hyperRare',               respaldo: 'ultraRare'  },
  { prob: 10.0, pool: 'specialIllustrationRare', respaldo: 'ultraRare'  },
  { prob: 25.0, pool: 'ultraRare',               respaldo: 'doubleRare' },
  { prob: 60.0, pool: 'doubleRare',              respaldo: 'rare'       },
];

/** Reparte el hueco de premio según la tabla. La última rama recoge el resto. */
const sacarPremio = (
  pools: Pools,
  ramas: readonly RamaDePremio[],
  currentPackIds: Set<string>,
  allCards: Card[],
): Card => {
  const rand = Math.random() * 100;
  let acumulado = 0;
  for (const rama of ramas) {
    acumulado += rama.prob;
    if (rand < acumulado) return draw(pools[rama.pool], pools[rama.respaldo], currentPackIds, allCards);
  }
  const ultima = ramas[ramas.length - 1];
  return draw(pools[ultima.pool], pools[ultima.respaldo], currentPackIds, allCards);
};

/* ==================================================================== *
 * CUÁNTO VALE UN SOBRE ANTES DE ABRIRLO
 * ====================================================================
 *
 * draw() elige UNIFORMEMENTE dentro del primer pool no vacío de su cadena, así
 * que el valor de venta esperado de un hueco es EXACTAMENTE la media de precios
 * de ese pool. El filtro anti-repetición cambia QUÉ carta sale, no de qué pool
 * sale, y los pools son disjuntos por rareza, así que no sesga el precio.
 *
 * Es un cálculo cerrado, sin Montecarlo: siempre da el mismo número, así que se
 * puede usar para DECIDIR la composición del sobre sin que la decisión dependa
 * de la suerte de una simulación.
 */
const valorMedio = (pool: Card[]): number =>
  pool.reduce((suma, c) => suma + precioDeCartaSuelta(c.rarity), 0) / pool.length;

/** Valor esperado de un hueco, siguiendo la misma cadena de respaldo que draw(). */
const valorDelHueco = (...cadena: Card[][]): number => {
  const pool = cadena.find(p => p.length > 0);
  return pool ? valorMedio(pool) : 0;
};

const valorDelPremio = (pools: Pools, ramas: readonly RamaDePremio[], allCards: Card[]): number =>
  ramas.reduce(
    (suma, r) => suma + (r.prob / 100) * valorDelHueco(pools[r.pool], pools[r.respaldo], allCards),
    0,
  );

/* ==================================================================== *
 * UN SOBRE NUNCA VALE MÁS DE LO QUE CUESTA
 * ====================================================================
 *
 * EL PROBLEMA (medido con 20.000 sobres por set y confirmado con el cálculo
 * cerrado de arriba): el precio del sobre es único —50— pero la pirámide de
 * rarezas la pone cada expansión, así que el retorno varía. Casi todas caen
 * entre el 90% y el 99,4% del coste... menos Champion's Path (swsh35), que
 * devolvía 50,89 = el 101,8%. Cinco corridas de 30.000 sobres daban 101,7-102,1%
 * con 2σ = ±0,26%: no era ruido, era una imprenta. Y encima con botón ×10,
 * porque swsh35 tiene 20 comunes y 44 C+U de 80 cartas y pasa de sobra el filtro
 * de "colección especial" de la interfaz.
 *
 * POR QUÉ swsh35: es la ÚNICA expansión del repositorio cuyo escalón de rara no
 * tiene ni una sola 'Rare' (14 monedas) — sus 10 raras son todas 'Rare Holo'
 * (22). El 78% de los sobres (la rama del 70% más la del 8%, que cae por
 * respaldo en ese mismo pool) se lleva por tanto 22 en vez de los ~14-18 de una
 * expansión normal: +5,6 por sobre, +11 puntos de coste. El SUELO garantizado
 * del sobre pasa de 6×2 + 3×3 + 14 = 35 (70% del precio) a
 * 6×2 + 3×3 + 22 = 43 (86%), y el 30% de sobres que pegan algo mejor ya lo
 * empujan por encima de 100. Desglose contra una expansión normal (sv8, 49,675):
 *
 *   rama 70%    15,40 vs  9,80   +5,60   <-- el mecanismo
 *   rama 15,5%   6,42 vs  5,43   +1,00   (V/VMAX en doubleRare: media 41,4 vs 35)
 *   rama 2%      3,80 vs  3,00   +0,80   ('Rare Secret' 190 vs SIR 150)
 *   rama 8%      1,76 vs  5,60   -3,84   (sin Illustration Rare: cae en rare)
 *   rama 4%      1,66 vs  3,60   -1,94   (sin Ultra Rare: cae en doubleRare)
 *   rama 0,5%    0,85 vs  1,25   -0,40   ('Rare Rainbow' 170 vs Hyper Rare 250)
 *                                +1,21   -> 50,89
 *
 * POR QUÉ NO SE ARREGLA TOCANDO PRECIOS NI CATEGORÍAS: bajar 'Rare Holo' mueve
 * a las 17 expansiones que mezclan 'Rare' y 'Rare Holo' (Evolving Skies tiene 19
 * y 20), y meter 'Rare Ultra' en su cubo sube Evolving Skies por encima de 100.
 * El precio de una rareza es global; el desajuste es de UNA expansión.
 *
 * EL ARREGLO: que el sobre se calibre contra su propio precio. Si con la
 * composición estándar vale más de lo que cuesta, se le retiran huecos de
 * RELLENO —el más caro primero, para quitar las menos cartas posibles— hasta que
 * baje. Consecuencias medidas:
 *   · Las expansiones normales no se enteran: la más cara de todas vale 49,675
 *     < 50 y no entra nunca en la corrección. Cero cambios en sv3pt5, sv8,
 *     swsh7 y sv8pt5, ni en estándar ni en premium.
 *   · swsh35 pierde UN hueco de infrecuente: sobre de 9 cartas, 47,89 = 95,8%,
 *     justo donde ya vivía Shining Fates (91%).
 *   · Las colecciones sin morralla (Trainer Gallery, Galarian Gallery, Shiny
 *     Vault, promos) no bajan de 50 ni vaciando el relleno entero, porque su
 *     carta MÁS BARATA ya cuesta más que el sobre. Ahí la respuesta correcta no
 *     es un sobre más flaco sino no venderlo, y eso lo dice
 *     `admiteSobreEstandar`; mientras tanto la corrección deja el sobre en 1
 *     carta, que si el filtro de la interfaz fallara sería ~10 veces menos fuga
 *     que las 10 cartas de hoy.
 */

/** Huecos de relleno del sobre estándar antes de calibrar. */
export const RELLENO_ESTANDAR = { comunes: 6, infrecuentes: 3 };
/**
 * Huecos de relleno del sobre premium antes de calibrar.
 *
 * SE EXPORTA porque la tienda ANUNCIA este número ("N Raras aseguradas"): con
 * el texto escrito a mano en app/page.tsx ya se había separado del dato y
 * prometía 2 donde aquí pone 4.
 */
export const RELLENO_PREMIUM = { infrecuentes: 4, raras: 4 };

/**
 * Cuántos huecos de relleno se puede permitir perder un sobre y seguir siendo
 * un sobre. Con 2, swsh35 (que sólo pierde 1) sigue en la tienda y las
 * colecciones sin morralla —que pierden los 9— quedan fuera.
 *
 * POR QUÉ HACE FALTA UN LÍMITE Y NO BASTA "¿baja del precio?": los sets de
 * promos son 100% cartas 'Promo' de 26 monedas, así que quitándoles TODO el
 * relleno el sobre acaba en una sola carta de 26 y sí baja de 50. Un sobre de
 * una carta no es un producto: si un set necesita llegar a eso, lo que pasa es
 * que no se puede vender a este precio.
 */
const TOLERANCIA_RELLENO = 2;

interface Calibrado {
  /** Cuántos huecos quedan de cada clase de relleno, en el orden de entrada. */
  huecos: number[];
  /** Valor de venta esperado del sobre resultante. */
  valor: number;
  /** Huecos de relleno retirados para bajar del precio. */
  retirados: number;
  /** false = no hay sobre razonable por debajo del precio: este set no se vende así. */
  cabe: boolean;
}

/**
 * Retira huecos de relleno —el más caro primero— hasta que el sobre valga como
 * mucho `techo`. `fijo` es la parte que no se toca (los huecos de premio).
 */
const calibrar = (valores: number[], cantidades: number[], fijo: number, techo: number): Calibrado => {
  const huecos = [...cantidades];
  const total = cantidades.reduce((suma, n) => suma + n, 0);
  let valor = fijo + huecos.reduce((suma, n, i) => suma + n * valores[i], 0);
  let retirados = 0;
  while (valor > techo) {
    // El hueco más caro que aún quede: es el que más baja por carta retirada.
    let elegido = -1;
    for (let i = 0; i < huecos.length; i++) {
      if (huecos[i] > 0 && (elegido < 0 || valores[i] > valores[elegido])) elegido = i;
    }
    if (elegido < 0) break;
    huecos[elegido]--;
    valor -= valores[elegido];
    retirados++;
  }
  // Aunque no quepa se devuelve el sobre adelgazado: si el filtro de la
  // interfaz fallara, la fuga es la de un sobre flaco y no la de uno entero.
  return { huecos, valor, retirados, cabe: valor <= techo && retirados <= Math.min(TOLERANCIA_RELLENO, total) };
};

const calibrarEstandar = (pools: Pools, allCards: Card[]): Calibrado =>
  calibrar(
    [
      valorDelHueco(pools.common, pools.uncommon, allCards),
      valorDelHueco(pools.uncommon, pools.common, allCards),
    ],
    [RELLENO_ESTANDAR.comunes, RELLENO_ESTANDAR.infrecuentes],
    valorDelPremio(pools, PREMIO_ESTANDAR, allCards),
    PACK_PRICES.STANDARD,
  );

const calibrarPremium = (pools: Pools, allCards: Card[]): Calibrado =>
  calibrar(
    [
      valorDelHueco(pools.uncommon, pools.common, allCards),
      valorDelHueco(pools.rare, pools.uncommon, allCards),
    ],
    [RELLENO_PREMIUM.infrecuentes, RELLENO_PREMIUM.raras],
    valorDelHueco([...pools.illustrationRare, ...pools.doubleRare], pools.rare, allCards) +
      valorDelPremio(pools, PREMIO_PREMIUM, allCards),
    PACK_PRICES.PREMIUM,
  );

/**
 * Valor de venta esperado de un sobre estándar de este set, ya calibrado.
 * Determinista: no depende de la suerte de ninguna simulación.
 */
export const valorEsperadoEstandar = (allCards: Card[]): number =>
  calibrarEstandar(categorizeCards(allCards), allCards).valor;

/** Lo mismo para el sobre premium. */
export const valorEsperadoPremium = (allCards: Card[]): number =>
  calibrarPremium(categorizeCards(allCards), allCards).valor;

/**
 * ¿Se puede vender un sobre estándar de este set? False en las colecciones sin
 * morralla (Trainer Gallery, Galarian Gallery, Shiny Vault, promos), donde hasta
 * la carta más barata vale más que el sobre entero.
 *
 * Sustituye con una MEDIDA al filtro por nombre y por conteo de comunes que hace
 * hoy la interfaz (`composicionEspecial` en app/page.tsx): ese filtro dejaba
 * pasar swsh35, que sí imprimía dinero, y depende de que el nombre del set lleve
 * la palabra "gallery".
 */
export const admiteSobreEstandar = (allCards: Card[]): boolean =>
  calibrarEstandar(categorizeCards(allCards), allCards).cabe;

/** Lo mismo para el sobre premium. */
export const admiteSobrePremium = (allCards: Card[]): boolean =>
  calibrarPremium(categorizeCards(allCards), allCards).cabe;

/* ==================================================================== *
 * QUÉ REPARTE DE VERDAD EL SOBRE DE ESTA EXPANSIÓN
 * ====================================================================
 *
 * EL PROBLEMA QUE CIERRA: la tienda (app/page.tsx) llevaba las probabilidades
 * y el número de cartas ESCRITOS A MANO en el JSX. Tres mentiras, todas
 * medibles:
 *
 *   1. "2 Raras aseguradas" en el Premium, que reparte 4 (RELLENO_PREMIUM).
 *   2. "Probabilidades oficiales: Illustration Rare 8%, Ultra Rare 4%" en el
 *      Estándar. En TODA la era Espada y Escudo no existe ninguno de esos dos
 *      escalones, así que `sacarPremio` cae por respaldo y ese 12% de sobres
 *      reparte una rara o una doble rara. El 8% y el 4% no salen JAMÁS ahí.
 *   3. "10 cartas" fijo, cuando `calibrar` puede retirar huecos de relleno para
 *      que el sobre no valga más de lo que cuesta (swsh35 se queda en 9).
 *
 * POR QUÉ AQUÍ Y NO EN LA INTERFAZ: las tres cifras son consecuencia del
 * reparto, y el reparto vive en este fichero. Calcularlas en el JSX es
 * exactamente lo que ya se hizo una vez y se separó del código en cuanto
 * PREMIO_ESTANDAR o RELLENO_PREMIUM cambiaron. Derivándolas de las mismas
 * constantes que reparten, no se pueden volver a separar.
 *
 * Es un cálculo puro sobre los pools: mismo set, mismo resultado, sin sorteo.
 */

/** Rótulo de cada escalón. Va con la tabla que reparte, no en la pantalla, para
 *  que renombrar un pool no deje el rótulo mintiendo. */
const ETIQUETA_POOL: Record<NombreDePool, string> = {
  common: "Común",
  uncommon: "Infrecuente",
  rare: "Rara",
  doubleRare: "Double Rare",
  illustrationRare: "Illustration Rare",
  ultraRare: "Ultra Rare",
  specialIllustrationRare: "Special Illustration Rare",
  hyperRare: "Hyper Rare",
};

/** Un hueco fijo del sobre (relleno o slot garantizado). */
export interface HuecoDelSobre {
  /** Escalón nominal, el que promete el sobre. */
  pool: NombreDePool;
  etiqueta: string;
  cantidad: number;
  /** Escalón del que sale DE VERDAD en esta expansión (puede ser el respaldo). */
  real: NombreDePool | "todas";
  etiquetaReal: string;
  /** false = esta expansión no tiene ese escalón y el hueco cae al respaldo. */
  disponible: boolean;
}

/** Una rama del hueco de premio, con su probabilidad. */
export interface RamaEfectiva extends HuecoDelSobre {
  /** % de sobres que caen en esta rama. */
  prob: number;
}

/** Composición completa de un sobre de esta expansión, ya calibrada. */
export interface ComposicionDelSobre {
  /** Cartas que trae de verdad (10 salvo que la calibración retire huecos). */
  cartas: number;
  /** Huecos fijos, en el orden en que se reparten. */
  huecos: HuecoDelSobre[];
  /** Reparto del hueco de premio. Vacío en el Leyenda, que no tiene. */
  premio: RamaEfectiva[];
  /** Huecos de relleno que la calibración retiró para no pasarse del precio. */
  retirados: number;
}

export type TipoDeSobre = "STANDARD" | "PREMIUM" | "GOLDEN" | "SPECIAL";

/**
 * A qué pool cae de verdad un hueco, siguiendo la MISMA cadena que `draw`:
 * el pool nominal, si no el respaldo, y si no el set entero.
 */
const poolReal = (
  pools: Pools,
  pool: NombreDePool,
  respaldo: NombreDePool,
): NombreDePool | "todas" => {
  if (pools[pool].length > 0) return pool;
  if (pools[respaldo].length > 0) return respaldo;
  return "todas";
};

const rotuloReal = (real: NombreDePool | "todas"): string =>
  real === "todas" ? "cualquier carta del set" : ETIQUETA_POOL[real];

const hueco = (
  pools: Pools,
  pool: NombreDePool,
  respaldo: NombreDePool,
  cantidad: number,
): HuecoDelSobre => {
  const real = poolReal(pools, pool, respaldo);
  return {
    pool,
    etiqueta: ETIQUETA_POOL[pool],
    cantidad,
    real,
    etiquetaReal: rotuloReal(real),
    disponible: real === pool,
  };
};

const ramasEfectivas = (pools: Pools, ramas: readonly RamaDePremio[]): RamaEfectiva[] =>
  ramas.map((r) => ({ ...hueco(pools, r.pool, r.respaldo, 1), prob: r.prob }));

/**
 * Qué reparte de verdad un sobre de este tipo en esta expansión.
 *
 * Lo consume la tienda para pintar la tarjeta: número de cartas, descripción y
 * probabilidades salen todos de aquí, así que no pueden desmentir al reparto.
 */
export const composicionDelSobre = (
  allCards: Card[],
  tipo: TipoDeSobre,
): ComposicionDelSobre => {
  const pools = categorizeCards(allCards);

  if (tipo === "STANDARD") {
    const { huecos: [comunes, infrecuentes], retirados } = calibrarEstandar(pools, allCards);
    const huecos = [
      hueco(pools, "common", "uncommon", comunes),
      hueco(pools, "uncommon", "common", infrecuentes),
    ].filter((h) => h.cantidad > 0);
    return {
      cartas: comunes + infrecuentes + 1,
      huecos,
      premio: ramasEfectivas(pools, PREMIO_ESTANDAR),
      retirados,
    };
  }

  if (tipo === "PREMIUM") {
    const { huecos: [infrecuentes, raras], retirados } = calibrarPremium(pools, allCards);
    // El hueco de gama media del premium mezcla dos pools, así que no encaja en
    // `hueco()`: se describe por el que de verdad tenga cartas.
    const mediaDisponible =
      pools.illustrationRare.length > 0 || pools.doubleRare.length > 0;
    const media: HuecoDelSobre = {
      pool: "illustrationRare",
      etiqueta: "Illustration Rare o Double Rare",
      cantidad: 1,
      real: mediaDisponible
        ? pools.illustrationRare.length > 0
          ? "illustrationRare"
          : "doubleRare"
        : poolReal(pools, "rare", "uncommon"),
      etiquetaReal: mediaDisponible
        ? pools.illustrationRare.length > 0
          ? ETIQUETA_POOL.illustrationRare
          : ETIQUETA_POOL.doubleRare
        : rotuloReal(poolReal(pools, "rare", "uncommon")),
      disponible: mediaDisponible,
    };
    const huecos = [
      hueco(pools, "uncommon", "common", infrecuentes),
      hueco(pools, "rare", "uncommon", raras),
      media,
    ].filter((h) => h.cantidad > 0);
    return {
      cartas: infrecuentes + raras + 2,
      huecos,
      premio: ramasEfectivas(pools, PREMIO_PREMIUM),
      retirados,
    };
  }

  /* LEYENDA Y PROMO PACK: el mismo reparto a dos precios, sin calibrar y sin
   * hueco de premio (ver openGoldenPack). Su carta garantizada no es una
   * probabilidad, es una promesa, así que se describe como hueco de 1. */
  return {
    cartas: 10,
    huecos: [
      hueco(pools, "rare", "uncommon", 5),
      hueco(pools, "doubleRare", "rare", 3),
      hueco(pools, "ultraRare", "illustrationRare", 1),
    ],
    premio: [],
    retirados: 0,
  };
};

/** Cuántas cartas trae de verdad un sobre de esta expansión. */
export const cartasDelSobre = (allCards: Card[], tipo: TipoDeSobre): number =>
  composicionDelSobre(allCards, tipo).cartas;

// --- NIVEL 1: SOBRE ESTÁNDAR ---
export const openStandardPack = (allCards: Card[]): Card[] => {
  const pools = categorizeCards(allCards);
  const pack: Card[] = [];
  const existingIds = new Set<string>();

  const [comunes, infrecuentes] = calibrarEstandar(pools, allCards).huecos;

  // Pasamos 'allCards' a todas las llamadas de draw
  for (let i = 0; i < comunes; i++) pack.push(draw(pools.common, pools.uncommon, existingIds, allCards));
  for (let i = 0; i < infrecuentes; i++) pack.push(draw(pools.uncommon, pools.common, existingIds, allCards));

  pack.push(sacarPremio(pools, PREMIO_ESTANDAR, existingIds, allCards));

  return pack;
};

// --- NIVEL 2: SOBRE PREMIUM ---
export const openPremiumPack = (allCards: Card[]): Card[] => {
  const pools = categorizeCards(allCards);
  const pack: Card[] = [];
  const existingIds = new Set<string>();

  const [infrecuentes, raras] = calibrarPremium(pools, allCards).huecos;

  for (let i = 0; i < infrecuentes; i++) pack.push(draw(pools.uncommon, pools.common, existingIds, allCards));
  for (let i = 0; i < raras; i++) pack.push(draw(pools.rare, pools.uncommon, existingIds, allCards));

  const midTierPool = [...pools.illustrationRare, ...pools.doubleRare];
  pack.push(draw(midTierPool, pools.rare, existingIds, allCards));

  pack.push(sacarPremio(pools, PREMIO_PREMIUM, existingIds, allCards));

  return pack;
};

// --- NIVEL 3: SOBRE LEYENDA ---
//
// SIN CALIBRAR A PROPÓSITO: es el único sobre que se vende a dos precios (600
// como Leyenda, 700 como Promo Pack en las colecciones especiales) y la función
// no sabe cuál le toca, así que calibrarlo contra uno rompería el otro. Su fuga
// se cierra en origen, en la rama `else` de aquí abajo, y con eso queda por
// debajo del 100% a los dos precios; scripts/sim-economia.mjs lo comprueba.
export const openGoldenPack = (allCards: Card[], userIds: string[]): Card[] => {
  const pools = categorizeCards(allCards);
  const pack: Card[] = [];
  const existingIds = new Set<string>();

  // Set y no includes(): con una colección de miles de ids el filtro era
  // O(cartas × colección) y se notaba al abrir un ×10.
  const yaLasTengo = new Set(userIds);
  const missingCards = allCards.filter(card => !yaLasTengo.has(card.id));
  let guaranteedCard: Card;

  if (missingCards.length > 0) {
    // La promesa del sobre, intacta: si te falta algo, la garantizada es algo
    // que NO tienes, y a poder ser del escalón bueno.
    const missingRares = missingCards.filter(c => c.rarity !== 'Common' && c.rarity !== 'Uncommon');
    if (missingRares.length > 0) {
        guaranteedCard = missingRares[Math.floor(Math.random() * missingRares.length)];
    } else {
        guaranteedCard = missingCards[Math.floor(Math.random() * missingCards.length)];
    }
  } else {
    /* RÉGIMEN (colección completa): ya no queda ninguna carta nueva que dar, así
     * que la garantizada sale AL AZAR DE TODO EL SET.
     *
     * ANTES: draw(hyperRare, -> specialIllustrationRare). En una colección de
     * galería eso caía SIEMPRE en una 'Rare Secret' de 190 monedas, porque
     * 'Rare Secret'.includes('Secret') la mete en specialIllustrationRare. Con
     * la colección completa, el Promo Pack de 700 devolvía: Galarian Gallery
     * 106% del coste, Brilliant Stars TG 101%, Lost Origin TG y Silver Tempest
     * TG 100%, Astral Radiance TG 95%, Shiny Vault 91%. Un bucle infinito para
     * quien ya había completado la colección, que es justo quien más abre.
     *
     * AHORA (20.000 sobres por set): 88%, 84%, 82%, 83%, 77% y 72%. Cero cambio
     * de precios y cero impacto en quien está completando —ése entra por la rama
     * de arriba y hoy sólo recupera el 43-68% en sus primeros sobres.
     */
    guaranteedCard = draw(allCards, allCards, existingIds, allCards);
  }

  existingIds.add(guaranteedCard.id);

  for (let i = 0; i < 5; i++) pack.push(draw(pools.rare, pools.uncommon, existingIds, allCards));
  for (let i = 0; i < 3; i++) pack.push(draw(pools.doubleRare, pools.rare, existingIds, allCards));
  for (let i = 0; i < 1; i++) pack.push(draw(pools.ultraRare, pools.illustrationRare, existingIds, allCards));

  pack.push(guaranteedCard);

  return pack;
};
