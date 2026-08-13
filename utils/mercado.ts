/**
 * MERCADO DE LOTES — lógica pura (sin estado, sin BD, sin React).
 *
 * El mercado compra LOTES de cartas por encima de la suma de sus precios
 * sueltos: paga `multiplicador × Σ SELL_PRICES(cartas entregadas)`, con un tope
 * de prima por oferta (ver TECHO_PRIMA y `pagoDelLote`). Cada oferta pide una
 * combinación de requisitos ("5 cartas de tipo Fuego", "una línea evolutiva
 * completa", "4 copias de la misma carta rara"...).
 *
 * POR QUÉ UN GENERADOR Y NO UNA LISTA: con una lista fija el jugador la aprende
 * en una tarde y el mercado deja de dar razones para abrir sobres. Aquí hay un
 * catálogo de plantillas × rejilla de parámetros × expansiones, y una semilla
 * decide qué sale en cada ciclo. Son cientos de miles de ofertas distintas
 * (scripts/sim-mercado.mjs las cuenta de verdad).
 *
 * POR QUÉ EL MULTIPLICADOR NO ES ALEATORIO: un mercado mal calibrado es una
 * imprenta de dinero. El multiplicador sale de un modelo explícito de esfuerzo
 * (cuántos sobres cuesta reunir el lote, medido sobre las cartas reales) y de
 * un TECHO de prima por oferta. Ver "ECONOMÍA" más abajo.
 *
 * IMPORTANTE para quien consume este módulo: las cartas que llegan de
 * services/pokemon.ts hoy NO traen `subtypes`, `evolvesFrom` ni
 * `nationalPokedexNumbers` (el mapeo de la BD los descarta aunque los JSON de
 * src/data sí los tienen). Sin esos campos los filtros "etapa", "evolucion" y
 * "pokedex" nunca casan: hay que añadirlos al SELECT/mapeo.
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
  | "set";

export interface Filtro {
  categoria: Categoria;
  valor?: string | number;
  min?: number;
  max?: number;
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
 * SEMÁNTICA DE CADA CATEGORÍA (léelo antes de escribir el validador)
 * ------------------------------------------------------------------ *
 *
 * `cumpleFiltro(carta, filtro)` responde a "¿esta carta SUELTA es candidata?".
 * Tres categorías necesitan además una comprobación de CONJUNTO que sólo puede
 * hacer quien valida la entrega, porque mirando una carta a la vez es
 * imposible:
 *
 *  - "playset":   `cantidad` = copias de LA MISMA carta (mismo `id`).
 *                 El validador agrupa por id y exige `cantidad` copias de uno
 *                 solo. `min` (opcional) = rango mínimo de rareza (RARITY_RANK).
 *  - "arcoiris":  `cantidad` = número de TIPOS DISTINTOS. El validador exige
 *                 que las cartas entregadas cubran `cantidad` tipos diferentes,
 *                 una por tipo. `min` (opcional) = rango mínimo de rareza.
 *  - "evolucion": `cantidad` = eslabones de la cadena. El validador exige que
 *                 las cartas encadenen por `evolvesFrom` → `name`
 *                 (A.evolvesFrom === B.name). `valor` (opcional) = tipo que
 *                 deben compartir todos los eslabones.
 *
 * El resto son filtros carta a carta:
 *  - "tipo":      `valor` = tipo en inglés ("Fire"), casa contra `types`.
 *  - "supertipo": `valor` = "Pokémon" | "Trainer" | "Energy".
 *  - "etapa":     `valor` = subtipo ("Basic", "Stage 1", "Stage 2", "ex"...).
 *  - "rareza":    `valor` = rareza exacta, o `min`/`max` sobre RARITY_RANK.
 *  - "artista":   `valor` = nombre del ilustrador.
 *  - "hp":        `min`/`max` sobre los PS.
 *  - "pokedex":   `min`/`max` sobre el número de la Pokédex nacional.
 *  - "set":       `valor` = id de expansión.
 *
 * `Requisito.setId` se comprueba APARTE del filtro: la carta entregada debe
 * pertenecer a ese set (usa `setDeCarta`). null = cualquier expansión.
 */

/* ------------------------------------------------------------------ *
 * CONSTANTES DE ECONOMÍA (documentadas: son los mandos del grifo)
 * ------------------------------------------------------------------ */

/**
 * Ofertas simultáneas. Es el mando más importante: el dinero que el mercado
 * puede inyectar por ciclo es, como mucho, la suma de los TECHO_PRIMA de las
 * ofertas activas. Con la composición de abajo son 240 monedas por ciclo en el
 * caso imposible de completarlas todas (ver scripts/sim-mercado.mjs).
 */
export const OFERTAS_ACTIVAS = 6;

/** Horas que vive un ciclo de ofertas. Al caducar, se sortea otro tablón. */
export const DURACION_CICLO_HORAS = 24;

/** Lo mismo en milisegundos, para comparar contra Date.now() en el servidor. */
export const DURACION_CICLO_MS = DURACION_CICLO_HORAS * 60 * 60 * 1000;

/**
 * Reparto de dificultades dentro de un ciclo. Se fija a propósito en vez de
 * dejarlo al azar: así el tamaño del grifo por ciclo es predecible y no
 * aparecen tablones de seis ofertas difíciles que dupliquen la inyección.
 */
export const COMPOSICION_CICLO = { facil: 2, media: 3, dificil: 1 } as const;

/** Suelo y techo del multiplicador. El suelo evita ofertas que no compensen. */
export const MULTIPLICADOR_MIN = 1.15;
export const MULTIPLICADOR_MAX = 2.5;

/**
 * Monedas de PRIMA (pago por encima del valor de venta) que el mercado paga
 * por cada sobre de esfuerzo estimado. Es el "sueldo por hora" del mercado.
 * Un sobre estándar cuesta 50 y devuelve ~49,5 revendiéndolo: a 2,2 el sobre
 * de esfuerzo, farmear el mercado renta mientras haya ofertas y deja de rentar
 * en cuanto se agotan (el sobre marginal sigue perdiendo 0,5).
 */
export const TASA_PRIMA_POR_SOBRE = 2.2;

/**
 * PRESUPUESTO DEL COMPRADOR: prima máxima (monedas por encima del valor de
 * venta) que puede pagar UNA oferta, por dificultad.
 *
 * POR QUÉ EXISTE — es el cortafuegos que impide la imprenta de dinero. El pago
 * es `multiplicador × Σ precios`, y como al jugador le da igual vender que
 * entregar, siempre le conviene entregar las cartas MÁS CARAS que cumplan el
 * filtro. Sin tope, "5 cartas de tipo Fuego ×1,5" se convierte en "meto cinco
 * Hyper Rare de 250 y me llevo 1.875 monedas". Con tope, ese abuso rinde lo
 * mismo que entregar cartas normales, así que deja de ser abuso.
 *
 * Además fija el tamaño del grifo: la inyección máxima por ciclo es la suma de
 * los topes de las ofertas activas. Con COMPOSICION_CICLO son
 * 2×15 + 3×40 + 1×90 = 240 monedas/día en el caso imposible de completarlas
 * todas. Medido, el jugador diario real se queda en 4-14 monedas/día.
 */
export const TECHO_PRIMA: Record<Oferta["dificultad"], number> = {
  facil: 15,
  media: 40,
  dificil: 90,
};

/**
 * Esfuerzo máximo (en sobres) que se le permite pedir a una oferta. Por encima
 * de esto la oferta es contenido muerto: nadie la completa antes de que caduque.
 */
const ESFUERZO_MAXIMO = 70;

/** Fronteras de dificultad, en sobres de esfuerzo estimado. */
const ESFUERZO_FACIL = 8;
const ESFUERZO_MEDIO = 26;

/**
 * Los requisitos de set libre son más baratos de lo que dice su rendimiento por
 * sobre, porque el jugador puede tirar de TODA su colección y no sólo de lo que
 * saque de esa expansión. Descuento medido a ojo de buen cubero y validado
 * después contra la simulación.
 */
const FACTOR_LIBRE = 0.7;

/* ------------------------------------------------------------------ *
 * PRIORES: cuántas cartas por sobre estándar cumplen cada cosa.
 * Medidos con packLogic.ts sobre las cartas reales de src/data
 * (16.500 sobres simulados, todos los sets con >= 60 cartas).
 * De aquí sale el esfuerzo, y del esfuerzo el multiplicador.
 * ------------------------------------------------------------------ */

const REND_TIPO: Record<string, number> = {
  Grass: 1.2,
  Fire: 0.68,
  Water: 1.13,
  Lightning: 0.75,
  Psychic: 1.22,
  Fighting: 1.03,
  Darkness: 0.9,
  Metal: 0.52,
  Colorless: 1.0,
};

const REND_SUPERTIPO: Record<string, number> = {
  "Pokémon": 8.64,
  Trainer: 1.31,
  Energy: 0.05,
};

const REND_ETAPA: Record<string, number> = {
  Basic: 5.76,
  "Stage 1": 2.08,
  "Stage 2": 0.42,
  Item: 0.38,
  Supporter: 0.69,
  ex: 0.16,
  V: 0.47,
  VMAX: 0.28,
  VSTAR: 0.08,
};

/** PS mínimos → cartas por sobre que los alcanzan. */
const REND_HP: Record<number, number> = {
  90: 4.27,
  110: 3.13,
  130: 2.08,
  150: 1.41,
  200: 0.9,
  250: 0.47,
  300: 0.35,
};

/** Rango mínimo de RARITY_RANK → cartas por sobre, y precio de la más barata. */
const ESCALA_RAREZA: { rango: number; rend: number; precio: number; etiqueta: string }[] = [
  { rango: 10, rend: 2.09, precio: 14, etiqueta: "Rara" },
  { rango: 20, rend: 1.6, precio: 22, etiqueta: "Rara Holo" },
  { rango: 35, rend: 0.83, precio: 35, etiqueta: "Doble Rara / V" },
  { rango: 45, rend: 0.65, precio: 45, etiqueta: "Radiante / Asombrosa" },
  { rango: 55, rend: 0.4, precio: 55, etiqueta: "Galería de Entrenadores" },
  { rango: 60, rend: 0.25, precio: 65, etiqueta: "VMAX" },
  { rango: 70, rend: 0.14, precio: 70, etiqueta: "Ilustración Especial" },
  { rango: 75, rend: 0.11, precio: 90, etiqueta: "Ultra Rara" },
  { rango: 85, rend: 0.045, precio: 150, etiqueta: "Ilustración Secreta" },
];

const REGIONES: { nombre: string; min: number; max: number; rend: number }[] = [
  { nombre: "Kanto", min: 1, max: 151, rend: 1.64 },
  { nombre: "Johto", min: 152, max: 251, rend: 0.85 },
  { nombre: "Hoenn", min: 252, max: 386, rend: 1.05 },
  { nombre: "Sinnoh", min: 387, max: 493, rend: 0.81 },
  { nombre: "Teselia", min: 494, max: 649, rend: 1.05 },
  { nombre: "Kalos", min: 650, max: 721, rend: 0.48 },
  { nombre: "Alola", min: 722, max: 809, rend: 0.5 },
  { nombre: "Galar", min: 810, max: 905, rend: 1.4 },
  { nombre: "Paldea", min: 906, max: 1025, rend: 0.83 },
];

/**
 * Ilustradores prolíficos y su rendimiento medido. Los requisitos de artista
 * SIEMPRE son de set libre: hay expansiones enteras (sv7, sv8, sv9, sv10,
 * sv8pt5) cuyos JSON no traen `artist`, y atarlos a un set los haría imposibles.
 */
const ARTISTAS: { nombre: string; rend: number }[] = [
  { nombre: "5ban Graphics", rend: 0.236 },
  { nombre: "Kouki Saitou", rend: 0.228 },
  { nombre: "sowsow", rend: 0.165 },
  { nombre: "Akira Komayama", rend: 0.147 },
  { nombre: "Shin Nagasawa", rend: 0.138 },
  { nombre: "nagimiso", rend: 0.135 },
  { nombre: "HYOGONOSUKE", rend: 0.123 },
  { nombre: "Kagemaru Himeno", rend: 0.115 },
  { nombre: "kirisAki", rend: 0.113 },
  { nombre: "Toyste Beach", rend: 0.109 },
  { nombre: "Ryuta Fuse", rend: 0.079 },
  { nombre: "kawayoo", rend: 0.077 },
  { nombre: "Mitsuhiro Arita", rend: 0.077 },
  { nombre: "aky CG Works", rend: 0.06 },
  { nombre: "PLANETA Mochizuki", rend: 0.046 },
];

/** Sobres medianos hasta juntar 4 copias de una misma carta (medido). */
const ESFUERZO_PLAYSET: Record<number, number> = { 0: 11, 10: 40, 20: 55 };

/** Sobres medianos hasta poder formar una cadena evolutiva (medido). */
const ESFUERZO_CADENA: Record<number, number> = { 2: 2.5, 3: 11 };

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
  ex: "ex",
  V: "V",
  VMAX: "VMAX",
  VSTAR: "VSTAR",
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

/** Categorías que sin `valor` no significan nada. */
const EXIGEN_VALOR: Categoria[] = ["tipo", "supertipo", "etapa", "artista", "set"];

export function cumpleFiltro(carta: CartaMinima, f: Filtro): boolean {
  // Sin esta guarda, un filtro corrupto con `valor` vacío casaría con las
  // cartas que tampoco tienen el campo (undefined === undefined) y regalaría
  // el lote. Un filtro incompleto no acepta nada.
  if (f.valor === undefined && EXIGEN_VALOR.includes(f.categoria)) return false;

  switch (f.categoria) {
    case "tipo":
      return (carta.types ?? []).some((t) => igual(t, f.valor));

    case "supertipo":
      return igual(carta.supertype, f.valor);

    case "etapa":
      return (carta.subtypes ?? []).some((s) => igual(s, f.valor));

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

    // --- categorías de CONJUNTO: aquí sólo se filtra la elegibilidad ---
    case "playset": {
      // Cualquier carta vale como base de un playset; `min` recorta por rareza.
      const r = rangoDeRareza(carta);
      return f.min === undefined || r >= f.min;
    }

    case "arcoiris": {
      // Tiene que tener tipo para poder aportar un color al arcoíris.
      if ((carta.types ?? []).length === 0) return false;
      const r = rangoDeRareza(carta);
      return f.min === undefined || r >= f.min;
    }

    case "evolucion": {
      // Elegible = Pokémon (el encadenado por evolvesFrom lo valida quien
      // recibe la entrega); si hay `valor`, además del tipo pedido.
      if (!igual(carta.supertype, "Pokémon")) return false;
      if (f.valor === undefined) return true;
      return (carta.types ?? []).some((t) => igual(t, f.valor));
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
  /** Sobres estimados para reunirlo abriendo la expansión adecuada. */
  esfuerzo: number;
  /** Precio de venta de la carta más barata que cumple: base del pago. */
  precioUnidad: number;
  /** "valor" paga de verdad; "sabor" tematiza y cuesta poco. */
  familia: "valor" | "sabor";
  /** true = nunca se ata a un set (o sería imposible en algunas expansiones). */
  siempreLibre: boolean;
  /** true = sólo vale como ancla (primer requisito de una oferta de set). */
  soloAncla?: boolean;
  /** Nombre corto para componer títulos con gracia. */
  mote: string;
}

const CANTIDADES_TIPO = [3, 4, 5, 6, 8, 10];
const CANTIDADES_RAREZA = [2, 3, 4, 5, 6];
const CANTIDADES_MEDIA = [2, 3, 4, 5];

function construirCatalogo(): Variante[] {
  const v: Variante[] = [];

  // 1) N cartas de un TIPO -------------------------------------------------
  for (const [tipo, rend] of Object.entries(REND_TIPO)) {
    for (const n of CANTIDADES_TIPO) {
      v.push({
        clave: `tipo:${tipo}:${n}`,
        plantilla: "tipo",
        cantidad: n,
        filtro: { categoria: "tipo", valor: tipo },
        texto: `${n} cartas de tipo ${TIPO_ES[tipo]}`,
        esfuerzo: n / rend,
        precioUnidad: 2,
        familia: "sabor",
        // Hay sets sin una sola carta de algún tipo (sv3pt5 y swsh7 no tienen
        // Metal): atarlo al set volvería la oferta imposible.
        siempreLibre: true,
        mote: TIPO_ES[tipo].toLowerCase(),
      });
    }
  }

  // 2) N cartas de RAREZA X o mejor ---------------------------------------
  for (const r of ESCALA_RAREZA) {
    for (const n of CANTIDADES_RAREZA) {
      const esfuerzo = n / r.rend;
      if (esfuerzo > ESFUERZO_MAXIMO) continue;
      v.push({
        clave: `rareza:${r.rango}:${n}`,
        plantilla: "rareza",
        cantidad: n,
        filtro: { categoria: "rareza", min: r.rango },
        texto: `${n} cartas de rareza ${r.etiqueta} o superior`,
        esfuerzo,
        precioUnidad: r.precio,
        familia: "valor",
        // Sólo los dos primeros escalones se pueden atar a un set: svp y swshp
        // son enteramente "Promo" (rango 30) y no tienen nada por encima, y
        // otras expansiones pequeñas se quedan sin material de rango 45+.
        siempreLibre: r.rango > 20,
        mote: r.etiqueta.toLowerCase(),
      });
    }
  }

  // 3) N Pokémon con PS por encima de un umbral ---------------------------
  for (const [umbralStr, rend] of Object.entries(REND_HP)) {
    const umbral = Number(umbralStr);
    for (const n of CANTIDADES_MEDIA) {
      const esfuerzo = n / rend;
      if (esfuerzo > ESFUERZO_MAXIMO) continue;
      v.push({
        clave: `hp:${umbral}:${n}`,
        plantilla: "hp",
        cantidad: n,
        filtro: { categoria: "hp", min: umbral },
        texto: `${n} Pokémon con ${umbral} PS o más`,
        esfuerzo,
        // A partir de 200 PS ya casi todo son ex/V, y eso vale dinero.
        precioUnidad: umbral >= 250 ? 35 : umbral >= 200 ? 22 : umbral >= 130 ? 3 : 2,
        familia: umbral >= 200 ? "valor" : "sabor",
        // 200+ PS son cartas de moda: las expansiones antiguas apenas tienen.
        siempreLibre: umbral >= 200,
        mote: `moles de ${umbral} PS`,
      });
    }
  }

  // 4) N cartas de un SUPERTIPO -------------------------------------------
  for (const n of [3, 4, 5, 6]) {
    v.push({
      clave: `super:Trainer:${n}`,
      plantilla: "supertipo",
      cantidad: n,
      filtro: { categoria: "supertipo", valor: "Trainer" },
      texto: `${n} cartas de Entrenador`,
      esfuerzo: n / REND_SUPERTIPO.Trainer,
      precioUnidad: 2,
      familia: "sabor",
      // swsh45sv no tiene ni una carta de Entrenador.
      siempreLibre: true,
      mote: "papeleo",
    });
  }
  for (const n of [1, 2]) {
    v.push({
      clave: `super:Energy:${n}`,
      plantilla: "supertipo",
      cantidad: n,
      filtro: { categoria: "supertipo", valor: "Energy" },
      texto: `${n} ${n === 1 ? "carta" : "cartas"} de Energía`,
      esfuerzo: n / REND_SUPERTIPO.Energy,
      precioUnidad: 2,
      familia: "sabor",
      // Las Energías casi no salen en sobres (0,05 por sobre): sólo sueltas.
      siempreLibre: true,
      mote: "combustible",
    });
  }

  // 5) N Pokémon de una REGIÓN (rango de Pokédex) -------------------------
  for (const reg of REGIONES) {
    for (const n of CANTIDADES_MEDIA) {
      v.push({
        clave: `dex:${reg.min}:${n}`,
        plantilla: "pokedex",
        cantidad: n,
        filtro: { categoria: "pokedex", min: reg.min, max: reg.max },
        texto: `${n} Pokémon de ${reg.nombre} (Pokédex ${reg.min}-${reg.max})`,
        esfuerzo: n / reg.rend,
        precioUnidad: 2,
        familia: "sabor",
        siempreLibre: true,
        mote: reg.nombre.toLowerCase(),
      });
    }
  }

  // 6) N cartas de una ETAPA ----------------------------------------------
  for (const [etapa, rend] of Object.entries(REND_ETAPA)) {
    for (const n of CANTIDADES_MEDIA) {
      const esfuerzo = n / rend;
      if (esfuerzo > ESFUERZO_MAXIMO) continue;
      const caro = etapa === "VMAX" || etapa === "VSTAR" || etapa === "ex" || etapa === "V";
      v.push({
        clave: `etapa:${etapa}:${n}`,
        plantilla: "etapa",
        cantidad: n,
        filtro: { categoria: "etapa", valor: etapa },
        texto: `${n} cartas ${ETAPA_ES[etapa]}`,
        esfuerzo,
        precioUnidad: etapa === "VSTAR" ? 70 : etapa === "VMAX" ? 65 : caro ? 35 : 2,
        familia: caro ? "valor" : "sabor",
        // Sólo Básico y Fase 1 existen en TODAS las expansiones abribles: las
        // etapas modernas faltan en las antiguas, y hay sets promocionales sin
        // una sola carta de Objeto o Partidario.
        siempreLibre: etapa !== "Basic" && etapa !== "Stage 1",
        mote: ETAPA_ES[etapa].toLowerCase(),
      });
    }
  }

  // 7) PLAYSET: 4 copias de la misma carta --------------------------------
  for (const min of [0, 10, 20]) {
    for (const n of [3, 4]) {
      const esfuerzo = ESFUERZO_PLAYSET[min] * (n / 4);
      const rar = ESCALA_RAREZA.find((r) => r.rango === min);
      v.push({
        clave: `playset:${min}:${n}`,
        plantilla: "playset",
        cantidad: n,
        filtro: min === 0 ? { categoria: "playset" } : { categoria: "playset", min },
        texto:
          `${n} copias de una misma carta` +
          (rar ? ` de rareza ${rar.etiqueta} o superior` : ""),
        esfuerzo,
        precioUnidad: rar ? rar.precio : 2,
        familia: min === 0 ? "sabor" : "valor",
        siempreLibre: false,
        mote: "playset",
      });
    }
  }

  // 8) ARCOÍRIS: N cartas de N tipos distintos ----------------------------
  for (const min of [0, 10, 35]) {
    for (const n of [4, 5, 6, 7]) {
      const rar = ESCALA_RAREZA.find((r) => r.rango === min);
      // Factor 1,5: juntar tipos DISTINTOS es un coleccionista de cupones, no
      // basta con dividir por el rendimiento.
      const rend = rar ? rar.rend : 8.0;
      const esfuerzo = (n / rend) * 1.5;
      if (esfuerzo > ESFUERZO_MAXIMO) continue;
      v.push({
        clave: `arco:${min}:${n}`,
        plantilla: "arcoiris",
        cantidad: n,
        filtro: min === 0 ? { categoria: "arcoiris" } : { categoria: "arcoiris", min },
        texto:
          `${n} cartas de ${n} tipos DISTINTOS` +
          (rar ? `, todas de rareza ${rar.etiqueta} o superior` : ""),
        esfuerzo,
        precioUnidad: rar ? rar.precio : 2,
        familia: min === 0 ? "sabor" : "valor",
        siempreLibre: min >= 35,
        mote: "arcoíris",
      });
    }
  }

  // 9) LÍNEA EVOLUTIVA completa -------------------------------------------
  for (const eslabones of [2, 3]) {
    v.push({
      clave: `evo:${eslabones}:libre`,
      plantilla: "evolucion",
      cantidad: eslabones,
      filtro: { categoria: "evolucion" },
      texto: `una línea evolutiva completa de ${eslabones} eslabones`,
      esfuerzo: ESFUERZO_CADENA[eslabones],
      precioUnidad: 2,
      familia: "sabor",
      // Una cadena de 3 no existe en todas las expansiones (la Galarian
      // Gallery tiene dos Fase 2 y ningún prevolutivo suyo).
      siempreLibre: eslabones >= 3,
      mote: "árbol genealógico",
    });
    for (const tipo of Object.keys(REND_TIPO)) {
      v.push({
        clave: `evo:${eslabones}:${tipo}`,
        plantilla: "evolucion",
        cantidad: eslabones,
        filtro: { categoria: "evolucion", valor: tipo },
        texto: `una línea evolutiva completa de ${eslabones} eslabones de tipo ${TIPO_ES[tipo]}`,
        // Exigir tipo multiplica por ~3 los sobres: hay 9 tipos y no todas las
        // familias del set son del tipo pedido.
        esfuerzo: ESFUERZO_CADENA[eslabones] * 3,
        precioUnidad: 2,
        familia: "sabor",
        siempreLibre: true,
        mote: `familia ${TIPO_ES[tipo].toLowerCase()}`,
      });
    }
  }

  // 10) N cartas de un ARTISTA (siempre libre) ----------------------------
  for (const a of ARTISTAS) {
    for (const n of [2, 3, 4]) {
      const esfuerzo = n / a.rend;
      if (esfuerzo > ESFUERZO_MAXIMO) continue;
      v.push({
        clave: `art:${a.nombre}:${n}`,
        plantilla: "artista",
        cantidad: n,
        filtro: { categoria: "artista", valor: a.nombre },
        texto: `${n} cartas ilustradas por ${a.nombre}`,
        esfuerzo,
        precioUnidad: 2,
        familia: "sabor",
        siempreLibre: true,
        mote: `firmas de ${a.nombre}`,
      });
    }
  }

  // 11) N cartas CUALESQUIERA de la expansión ------------------------------
  // Es el ancla infalible: existe en cualquier set y da la excusa más directa
  // para abrir esa expansión ("ábrelo y tráeme diez cartas").
  for (const n of [6, 8, 10, 12]) {
    v.push({
      clave: `set:${n}`,
      plantilla: "set",
      cantidad: n,
      // `valor` se rellena con el set de la oferta al montar el requisito.
      filtro: { categoria: "set" },
      texto: `${n} cartas cualesquiera`,
      esfuerzo: n / 10,
      precioUnidad: 2,
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
  playset: ["Cuatro iguales", "Manía del duplicado", "El coleccionista repetitivo"],
  arcoiris: ["Encargo arcoíris", "Toda la paleta", "Un poco de cada"],
  evolucion: ["Reunión familiar", "Árbol genealógico", "La familia al completo"],
  artista: ["Capricho de galerista", "Cuestión de firma", "Fan del ilustrador"],
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

function nombreDeSet(setId: string): string {
  return AVAILABLE_SETS.find((s) => s.id === setId)?.name ?? setId.toUpperCase();
}

function dificultadDe(esfuerzo: number): Oferta["dificultad"] {
  if (esfuerzo < ESFUERZO_FACIL) return "facil";
  if (esfuerzo < ESFUERZO_MEDIO) return "media";
  return "dificil";
}

/**
 * El multiplicador sale de un modelo, no de un dado:
 *   prima objetivo = TASA_PRIMA_POR_SOBRE × sobres de esfuerzo  (con techo)
 *   multiplicador  = 1 + prima objetivo / valor de venta del lote
 * Es decir: el mercado paga por el TRABAJO, no por el precio de la carta. Un
 * lote caro y fácil se queda en el suelo (1,15) y uno barato y penoso sube al
 * techo (2,5) sin por eso inyectar mucho dinero, porque el lote vale poco.
 */
function calcularMultiplicador(
  esfuerzo: number,
  valorLote: number,
  dificultad: Oferta["dificultad"],
): number {
  const primaObjetivo = Math.min(TASA_PRIMA_POR_SOBRE * esfuerzo, TECHO_PRIMA[dificultad]);
  const bruto = 1 + primaObjetivo / Math.max(valorLote, 1);
  const acotado = Math.min(Math.max(bruto, MULTIPLICADOR_MIN), MULTIPLICADOR_MAX);
  // Redondeo a 0,05 para que el número quede legible en la interfaz.
  return Math.round(acotado * 20) / 20;
}

/**
 * PAGO DEFINITIVO de un lote. Úsala en el servidor: es la única fórmula válida.
 *
 * `valorLote` = suma de SELL_PRICES de las cartas entregadas, calculada EN EL
 * SERVIDOR a partir de la base de datos. Nunca aceptes ni el valor ni el pago
 * del cliente.
 */
export function pagoDelLote(oferta: Oferta, valorLote: number): number {
  const bruto = oferta.multiplicador * valorLote;
  const conTope = Math.min(bruto, valorLote + TECHO_PRIMA[oferta.dificultad]);
  return Math.max(0, Math.round(conTope));
}

interface Candidata extends Oferta {
  esfuerzo: number;
  valorLote: number;
}

function montarOferta(rng: Rng, setId: string | null): Candidata | null {
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

  unicas.forEach((p, i) => {
    // El primero de una oferta de set va atado; el resto, sueltos.
    const atado = setId !== null && i === 0;
    // Se clona el filtro: el catálogo es compartido entre todas las ofertas y
    // devolverlo por referencia invitaría a mutarlo desde fuera.
    const filtro: Filtro = { ...p.filtro };
    if (filtro.categoria === "set" && setId !== null) filtro.valor = setId;
    requisitos.push({
      descripcion: p.texto + (atado ? ` de ${nombreDeSet(setId)}` : " (cualquier expansión)"),
      cantidad: p.cantidad,
      filtro,
      setId: atado ? setId : null,
    });
    esfuerzo += atado ? p.esfuerzo : p.esfuerzo * FACTOR_LIBRE;
    valorLote += p.cantidad * p.precioUnidad;
  });

  if (esfuerzo > ESFUERZO_MAXIMO) return null;

  const principal = unicas[0];
  const dificultad = dificultadDe(esfuerzo);
  const titulo = elegir(rng, TITULOS[principal.plantilla] ?? ["Encargo del mercado"]);
  const gancho =
    setId === null
      ? `Alguien busca ${unicas.map((p) => p.mote).join(" y ")} de cualquier expansión: ${elegir(rng, REMATES)}.`
      : `El comprador quiere ${principal.mote} de ${nombreDeSet(setId)}: ${elegir(rng, REMATES)}.`;
  // El tope va en la descripción a propósito: si no se ve, el jugador entrega
  // sus mejores cartas esperando cobrar el multiplicador entero y se enfada.
  const descripcion = `${gancho} Presupuesto máximo: +${TECHO_PRIMA[dificultad]} monedas sobre el precio de venta del lote.`;

  return {
    id: `${setId ?? "libre"}|${unicas.map((p) => p.clave).join("+")}`,
    titulo,
    descripcion,
    requisitos,
    multiplicador: calcularMultiplicador(esfuerzo, valorLote, dificultad),
    dificultad,
    setId,
    esfuerzo,
    valorLote,
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
 *  - el reparto de dificultades sigue COMPOSICION_CICLO mientras haya sitio.
 */
export function generarOfertas(
  semilla: number,
  setIds: string[],
  cuantas: number,
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
  // La primera siempre es de expansión libre: es la red de seguridad del
  // tablón (siempre hay algo que se puede completar con lo que ya tienes), así
  // que entra aunque su dificultad no cuadre con el cupo.
  let toca: "libre" | "set" = "libre";
  const sobrantes: Candidata[] = [];

  for (let intento = 0; intento < cuantas * 240 && elegidas.length < cuantas; intento++) {
    const setId = toca === "libre" ? null : sets.length ? elegir(rng, sets) : null;
    const cand = montarOferta(rng, setId);
    if (!cand || ids.has(cand.id)) continue;

    if (toca === "libre" || cupo[cand.dificultad] > 0) {
      cupo[cand.dificultad] = Math.max(0, cupo[cand.dificultad] - 1);
      ids.add(cand.id);
      elegidas.push(cand);
      toca = "set";
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

  return elegidas.map(({ esfuerzo: _e, valorLote: _v, ...oferta }) => oferta);
}
