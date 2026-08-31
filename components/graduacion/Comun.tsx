"use client";

// components/graduacion/Comun.tsx
//
// Lo que comparten las cuatro vistas de la graduación (selección, revelado,
// vitrina y la chuleta de probabilidades): las formas de los datos y el sello
// de la nota, que es el único elemento que aparece en todas.
//
// ============================================================================
// POR QUÉ LOS TIPOS ESTÁN ESCRITOS A MANO Y NO DERIVADOS DE LA SERVER ACTION
// ============================================================================
//
// Lo natural sería `Awaited<ReturnType<typeof getCartasGraduables>>` y olvidarse.
// No sirve: lo último que hace esa acción antes de devolver es pasar la lista
// por `enIdiomaUsuario`, que está declarada `(cartas: any[]) => Promise<any[]>`
// para poder traducir cualquier forma de carta. El tipo inferido, por tanto, es
// `any` y el `strict: true` del proyecto no comprobaría absolutamente nada aquí.
//
// CONSECUENCIA QUE HAY QUE TENER PRESENTE: si alguien añade o renombra un campo
// en getCartasGraduados/getVitrina (app/action.ts), TypeScript NO va a avisar en
// esta pantalla. Estas interfaces son un contrato copiado a mano y se comprueban
// leyendo el servidor, no compilando.

import {
  descuentoPorVolumen,
  etiquetaNota,
  type Desperfectos,
  type MarcasDeCarta,
} from "../../utils/graduacion";

/* ==================================================================== *
 * EL TOPE POR TACADA
 * ====================================================================
 *
 * ESPEJO A MANO de `MAX_GRADUAR_DE_UNA_VEZ` (app/action.ts). No se importa
 * porque no se puede: esa constante no se exporta, y aunque se exportara,
 * app/action.ts lleva 'use server' y un módulo de servidor sólo puede exportar
 * funciones asíncronas — cualquier otra cosa es un error de compilación de Next.
 *
 * QUÉ PASA SI SE DESINCRONIZAN: nada peligroso. Si aquí quedara más alto, el
 * servidor rechazaría el envío entero con "demasiadas" y la pantalla lo diría
 * sin cobrar nada; si quedara más bajo, se podría mandar menos de lo permitido.
 * Ninguno de los dos casos mueve dinero de más, pero los dos son molestos.
 */
export const TOPE_POR_TACADA = 40;

/**
 * Los escalones del descuento por volumen, SONDEANDO la función en vez de
 * copiar la tabla.
 *
 * `ESCALONES_DESCUENTO` es privado de utils/graduacion.ts; lo público es
 * `descuentoPorVolumen`. Preguntarle por cada cantidad hasta el tope y anotar
 * dónde cambia de respuesta cuesta cuarenta llamadas a una función de tres
 * comparaciones, una sola vez, y a cambio la pantalla sigue diciendo la verdad
 * si alguien añade un escalón, lo mueve o lo quita. Una tabla de reglas copiada
 * a mano acaba siempre mintiendo, y aquí mentir es que alguien se gaste las
 * monedas con una expectativa falsa.
 */
export function escalonesDeDescuento(tope: number): { desde: number; descuento: number }[] {
  const salida: { desde: number; descuento: number }[] = [];
  let anterior = descuentoPorVolumen(1);
  for (let n = 2; n <= tope; n++) {
    const d = descuentoPorVolumen(n);
    if (d !== anterior) {
      salida.push({ desde: n, descuento: d });
      anterior = d;
    }
  }
  return salida;
}

/* ==================================================================== *
 * LAS FORMAS QUE DEVUELVE EL SERVIDOR
 * ==================================================================== */

/** Una fila de `getCartasGraduables()`: una carta con copias sin nota. */
export interface CartaGraduable {
  id: string;
  name: string;
  rarity: string;
  images: { small: string; large: string };
  setId: string;
  /** Copias en propiedad, graduadas incluidas. */
  cantidad: number;
  /** Copias que ya tienen nota y viven en la vitrina. */
  graduadas: number;
  /** `cantidad - graduadas`. Son las únicas que se pueden mandar. */
  libres: number;
  /** Lo que vale UNA copia suelta hoy. Sobre esto multiplica la nota. */
  valor: number;
  /** Coste unitario SIN descuento por volumen: `costeDeGraduar(valor, 1)`. */
  coste: number;
}

/** Una fila de `getVitrina()`: una copia que ya tiene nota. */
export interface CopiaGraduada {
  gradedId: number;
  id: string;
  name: string;
  rarity: string;
  images: { small: string; large: string };
  setId: string;
  copia: number;
  nota: number;
  etiqueta: string;
  /**
   * El estado de la copia, YA CALCULADO POR EL SERVIDOR.
   *
   * Antes viajaba la semilla y el navegador derivaba de ella los desperfectos.
   * Ya no: la semilla lleva dentro el secreto de las notas (ver
   * utils/graduacion.ts) y con ella en la mano cualquiera podría calcular la
   * nota de sus copias SIN GRADUAR y mandar sólo los dieces. El servidor manda
   * el resultado y no la receta.
   */
  desperfectos: Desperfectos;
  marcas: MarcasDeCarta;
  /** Ya multiplicado por la nota: es lo que pagarían por ella. */
  valor: number;
  coste: number;
  /** Copias de esa carta en la colección. Con 1 no se puede vender. */
  copiasTotales: number;
}

/**
 * Una copia recién graduada, tal y como la pinta la ceremonia de revelado.
 *
 * NO ES EXACTAMENTE LO QUE DEVUELVE `graduarCartasAction`: esa acción devuelve
 * {cardId, copia, nota, desperfectos, marcas} — la nota y el estado de la copia,
 * que sólo el servidor puede calcular. El nombre, la ilustración y lo que vale
 * ahora se rellenan en el cliente cruzando esa respuesta con la lista de
 * graduables que ya estaba cargada: es información que el navegador YA TENÍA, y
 * pedirla otra vez añadiría un viaje de red justo en el momento de la función.
 */
export interface Resultado {
  cardId: string;
  copia: number;
  nota: number;
  /** Instantánea de la carta en el momento del envío, sólo para pintar. */
  carta: CartaGraduable;
  /** Estado de la copia, calculado por el servidor. Ver CopiaGraduada. */
  desperfectos: Desperfectos;
  marcas: MarcasDeCarta;
  /** `valorGraduado(carta.valor, nota)`: lo que vale ya graduada. */
  valor: number;
  /**
   * Identificador de la fila de `graded_cards`. Llega DESPUÉS que el resto,
   * cuando vuelve la vitrina: es el único dato que la respuesta de graduar no
   * trae y sin él no se puede vender. Mientras es `undefined`, el botón de
   * vender espera en vez de mentir.
   */
  gradedId?: number;
}

/** Clave estable de una copia concreta. Las copias no tienen id propio aquí. */
export const claveCopia = (cardId: string, copia: number) => `${cardId}#${copia}`;

/** Qué se ha decidido con una copia ya revelada. */
export type Decision = "guardada" | "vendida";

/* ==================================================================== *
 * COLOR DE LA NOTA
 * ====================================================================
 *
 * Los cuatro tramos son los mismos que separa `etiquetaNota`, para que el color
 * y el rótulo no puedan contradecirse.
 *
 * SE USAN --ok, --warn-ink y --danger Y NO --accent NI --warn: los dos últimos
 * son colores de MARCA y viven fuera del tema, así que sobre el papel crema del
 * modo claro dan 2,2:1 — valen para un relleno, no para un número que hay que
 * leer. --ok y --warn-ink existen exactamente para esto y tienen un valor
 * propio en cada tema (ver la nota de app/globals.css).
 */
export function tintaDeNota(nota: number): string {
  if (nota >= 9) return "var(--ok)";
  if (nota >= 7) return "var(--ink)";
  if (nota >= 4) return "var(--warn-ink)";
  return "var(--danger)";
}

/** Fondo tenue a juego con la tinta, para el sello y los distintivos. */
export function fondoDeNota(nota: number): string {
  return `color-mix(in srgb, ${tintaDeNota(nota)} 12%, transparent)`;
}

/* ==================================================================== *
 * EL SELLO
 * ==================================================================== */

interface SelloProps {
  nota: number;
  /** `lg` es el de la ceremonia; `sm`, el de las rejillas. */
  tamano?: "sm" | "md" | "lg";
  /** Oculta el rótulo cuando el sitio no da para más que el número. */
  soloNumero?: boolean;
}

/**
 * La nota, con su rótulo. Es lo que se ha pagado por saber, así que se pinta
 * como un sello de laboratorio y no como una etiqueta más.
 *
 * SIN `transform: scale` NI `filter`, aunque este componente casi siempre está
 * al lado de una carta: el realce es un `box-shadow` y un borde. La regla del
 * repositorio (components/PokemonCard.tsx:140-163) prohíbe esas dos propiedades
 * sobre la carta y sobre cualquier ancestro suyo, y el sello se monta unas veces
 * como hermano y otras encima; mantenerlo limpio evita tener que acordarse de
 * cuál es cuál.
 */
export function SelloNota({ nota, tamano = "md", soloNumero = false }: SelloProps) {
  const tinta = tintaDeNota(nota);
  const medidas =
    tamano === "lg"
      ? { numero: "text-[56px] leading-none", rotulo: "text-[13px]", caja: "px-5 py-4 rounded-3xl" }
      : tamano === "md"
        ? { numero: "text-[30px] leading-none", rotulo: "text-[11px]", caja: "px-3.5 py-2.5 rounded-2xl" }
        : { numero: "text-[17px] leading-none", rotulo: "text-[10px]", caja: "px-2.5 py-1.5 rounded-xl" };

  return (
    <div
      className={`inline-flex flex-col items-center gap-1 ${medidas.caja}`}
      style={{
        background: fondoDeNota(nota),
        border: `1px solid color-mix(in srgb, ${tinta} 34%, transparent)`,
      }}
    >
      {/* tnum: los números de nota se pintan uno detrás de otro en las rejillas
          y sin cifras de ancho fijo la columna baila. */}
      <span className={`font-bold tnum ${medidas.numero}`} style={{ color: tinta }}>
        {nota}
      </span>
      {!soloNumero && (
        <span className={`font-semibold uppercase tracking-[0.14em] ${medidas.rotulo}`} style={{ color: tinta }}>
          {etiquetaNota(nota)}
        </span>
      )}
    </div>
  );
}

/* ==================================================================== *
 * FORMATO
 * ==================================================================== */

/**
 * Porcentajes con locale FIJO, por el mismo motivo que utils/format.ts: esta
 * pantalla es un componente de cliente, así que también se pre-renderiza en el
 * servidor. Con el locale del entorno, Vercel escribiría "14.25%" y el
 * navegador español "14,25%": el HTML dejaría de coincidir y React abortaría la
 * hidratación con el error #418.
 */
export const porcentaje = (valor: number, decimales = 2): string =>
  `${(valor * 100).toLocaleString("es-ES", {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
  })} %`;

/** Multiplicadores: "×1,5", "×0" — con coma decimal y sin ceros de relleno. */
export const multiplicador = (valor: number): string =>
  `×${valor.toLocaleString("es-ES", { maximumFractionDigits: 2 })}`;
