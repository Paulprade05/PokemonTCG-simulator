"use client";

import { etiquetaNota } from "../../utils/graduacion";
import { tintaDeNota } from "../graduacion/Comun";

/**
 * LA NOTA DE UNA CARTA GRADUADA, reducida a lo que cabe en la esquina de una
 * miniatura. La pintan la colección y el archivador.
 *
 * POR QUÉ NO SE REUTILIZA `SelloNota` (components/graduacion/Comun.tsx): ese
 * sello es de columna —cifra grande y rótulo debajo— y está hecho para la
 * ceremonia de revelado y para la vitrina, donde sobra sitio. Encima de una
 * miniatura no cabe: en la rejilla de tres columnas de un móvil la carta mide
 * unos 110px y "Gema Impecable" ocuparía media carta. Lo que SÍ se reutiliza es
 * lo único que no puede divergir, `tintaDeNota`: el verde de un 9 tiene que ser
 * el mismo verde en la ceremonia, en la vitrina y aquí. Dos escalas de color
 * para lo mismo es peor que ninguna.
 *
 * VIVE EN components/vitrina/ aunque también la use app/collection: es la misma
 * insignia en las dos pantallas, y tenerla dos veces las dejaría divergir a la
 * primera vez que alguien retoque una.
 *
 * ---------------------------------------------------------------------------
 * LA REGLA DE NITIDEZ MANDA TAMBIÉN AQUÍ
 *
 * Esta insignia se monta ENCIMA de una carta, y en el archivador además dentro
 * del árbol de la funda. Así que no lleva `filter`, ni `drop-shadow`, ni
 * `backdrop-filter`, ni `mix-blend-mode`, ni `opacity` sobre el contenedor, ni
 * un solo `transform` con `scale`: WebKit promociona esa capa y la ilustración
 * de debajo sale borrosa en iPhone (documentado en PokemonCard.tsx:140-163 y en
 * la cabecera de components/vitrina/FundaCarta.tsx). El relieve es `box-shadow`
 * y un borde, como el resto de insignias del proyecto.
 *
 * Por lo mismo el recuento de copias se apaga con `color-mix(... transparent)`
 * y no con `opacity`: el color con alfa no crea contexto de apilamiento.
 */

/**
 * Los dos campos que `getFullCollection()` añade por carta.
 *
 * EN snake_case Y SIN RENOMBRAR: esa consulta devuelve `{...row}` tal cual sale
 * de Postgres (app/action.ts), así que el nombre real de las columnas es el que
 * viaja hasta el navegador. Rebautizarlas aquí sería inventar un segundo nombre
 * para el mismo dato y obligar a traducir en cada pantalla que lo lea.
 */
export interface NotasDeCarta {
  /** Copias graduadas ACTIVAS de esa carta. 0 si ninguna. */
  graduadas?: number | null;
  /** La nota más alta de esas copias. `null` si no hay ninguna graduada. */
  mejor_nota?: number | null;
}

/** La nota ya validada, que es lo único que la insignia sabe pintar. */
export interface NotaGraduada {
  /** La MEJOR nota de las copias graduadas, de 1 a 10. */
  nota: number;
  /** Cuántas copias graduadas hay. Al menos 1 cuando hay nota. */
  copias: number;
}

/**
 * Lee la nota de una carta de la colección, o `null` si no tiene ninguna.
 *
 * EL PARÁMETRO ES `object` Y NO UN TIPO DE CARTA, y no es pereza:
 *  · `CartaEnColeccion` (utils/tipos.ts) NO declara estos dos campos, porque
 *    los trae sólo la consulta de la colección —ni el catálogo de un set ni el
 *    localStorage del invitado los tienen—. Exigir aquí un tipo que los tuviera
 *    obligaría a castear en cada llamada, que es la forma de que un día se
 *    castee mal.
 *  · Llegan atravesando una acción de servidor tipada `Promise<any[]>` (la capa
 *    de idioma), así que el compilador no ha comprobado NADA de lo que hay
 *    dentro. La validación tiene que ser de verdad, en tiempo de ejecución: de
 *    ahí el acotado a 1..10, para que una fila rara no pinte una insignia de un
 *    color que no está en la escala.
 *
 * `object` en vez de `unknown` conserva algo de red: pasar un número o una
 * cadena sigue siendo un error de compilación.
 */
export function notaDeCarta(
  carta: object | null | undefined,
): NotaGraduada | null {
  if (!carta) return null;
  const { graduadas, mejor_nota } = carta as NotasDeCarta;
  // Number(null) da 0 y Number(undefined) da NaN: los dos se caen del rango, que
  // es exactamente lo que queremos para una carta sin graduar.
  const nota = Math.round(Number(mejor_nota));
  if (!Number.isFinite(nota) || nota < 1 || nota > 10) return null;
  // Si hay nota hay al menos una copia, aunque el recuento venga corrupto.
  const copias = Math.max(1, Math.round(Number(graduadas) || 0));
  return { nota, copias };
}

interface InsigniaNotaProps {
  /** La MEJOR nota de las copias graduadas, 1..10. */
  nota: number;
  /** Cuántas copias graduadas hay. Con más de una se escribe el recuento. */
  copias?: number;
  /** `sm` para la rejilla de la colección; `md` para la funda y las hojas. */
  tamano?: "sm" | "md";
  /** Colocación (la insignia no se posiciona sola: la ancla quien la monta). */
  className?: string;
}

/**
 * QUÉ HACE QUE UN 10 SE DISTINGA DE UN 7 SIN LEER LA CIFRA.
 *
 * El color lo pone `tintaDeNota` y son cuatro tramos, los mismos que separa
 * `etiquetaNota`: 9-10 en --ok, 7-8 en --ink, 4-6 en --warn-ink y 1-3 en
 * --danger. Eso ya separa un 7 de un 9 de un vistazo, pero deja al 10 y al 9
 * del mismo color, y el 10 —×3 sobre el valor, el premio gordo de todo el
 * sistema— no puede parecerse a nada.
 *
 * Por eso el peso: el 10 va MACIZO (la tinta de relleno y el papel de letra) y
 * el resto en pastilla clara con la tinta escrita. No es otra escala de color,
 * es la MISMA tinta con dos pesos; el hue sigue saliendo de `tintaDeNota` y
 * cambiar allí un tramo cambia también aquí.
 *
 * EL FONDO ES OPACO (--surface o la tinta), nunca el `fondoDeNota` del 12% que
 * usa el sello: eso se pinta sobre el papel de una pantalla, y esto se pinta
 * sobre una ilustración. Un relleno translúcido encima del arte de la carta
 * deja la cifra ilegible justo en la rejilla de móvil, que es donde más falta
 * hace poder leerla de reojo.
 */
export default function InsigniaNota({
  nota,
  copias = 1,
  tamano = "sm",
  className = "",
}: InsigniaNotaProps) {
  const tinta = tintaDeNota(nota);
  const rotulo = etiquetaNota(nota);
  const varias = copias > 1;
  const maciza = nota === 10;

  const medidas =
    tamano === "md"
      ? { caja: "gap-1 px-2 py-1", numero: "text-[15px]", extra: "text-[10px]" }
      : {
          caja: "gap-0.5 px-1.5 py-1",
          numero: "text-[12px]",
          extra: "text-[9px]",
        };

  return (
    <span
      /* `role="img"` y no un <div> a secas: `aria-label` NO se anuncia sobre un
         elemento de rol genérico, y el encargo pide que un lector diga
         "Impecable, nota 9" y no un "9" suelto. Con rol de imagen el rótulo
         sustituye al contenido, que es justo lo que hace falta: la cifra y el
         "×2" son la versión corta de esa misma frase. */
      role="img"
      aria-label={
        `${rotulo}, nota ${nota}` +
        (varias ? `, la mejor de ${copias} copias graduadas` : "")
      }
      /* `pointer-events-none` porque la insignia se monta sobre el botón que
         abre la carta: sin esto, tocarla no abriría nada y el jugador tocaría
         dos veces creyendo que la pantalla no responde. */
      className={`tnum pointer-events-none inline-flex items-center rounded-full font-bold leading-none ${medidas.caja} ${className}`}
      style={
        maciza
          ? {
              background: tinta,
              color: "var(--bg)",
              border: `1px solid ${tinta}`,
              boxShadow: "var(--shadow-sm)",
            }
          : {
              background: "var(--surface)",
              color: tinta,
              border: `1px solid color-mix(in srgb, ${tinta} 45%, transparent)`,
              boxShadow: "var(--shadow-sm)",
            }
      }
    >
      <span className={medidas.numero}>{nota}</span>
      {/* CUÁNTAS. Sólo con más de una: un "×1" en cada carta graduada sería
          ruido, igual que el "×1" que la funda tampoco escribe. La cifra grande
          es la MEJOR de todas, y por eso el recuento va detrás y más pequeño —
          si pesara igual, se leerían como dos notas. */}
      {varias && (
        <span
          className={`font-semibold ${medidas.extra}`}
          style={{ color: "color-mix(in srgb, currentColor 70%, transparent)" }}
        >
          ×{copias}
        </span>
      )}
    </span>
  );
}
