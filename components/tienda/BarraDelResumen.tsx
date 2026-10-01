"use client";

import { formatNumber } from "../../utils/format";

/**
 * LO QUE SE REPITE SOBRE TRAS SOBRE, PEGADO ABAJO Y AL ALCANCE DEL PULGAR.
 *
 * "Vender repetidas" y "Otro sobre" estaban sólo en la cabecera del resumen.
 * Tras un ×10 son cien cartas —34 filas en un iPhone—: había que deshacer todo
 * el desplazamiento para repetir, y la acción principal era además la última
 * de una fila que partía en tres líneas.
 *
 * MISMO ANCLAJE QUE components/graduacion/BarraEnvio.tsx: `sticky` justo encima
 * de la barra de pestañas. EL FONDO ES `surface` OPACO Y SIN `backdrop-filter`,
 * a propósito: esta barra pasa por encima de las cartas del resumen, y aunque
 * es HERMANA de la rejilla y no su ancestro —que es lo que prohíben las reglas
 * de nitidez de WebKit—, un cristal desenfocado sobre cien ilustraciones en
 * movimiento es justo el trabajo de composición que el iPhone paga caro.
 *
 * LOS DOS BOTONES NO DICEN LO MISMO QUE ANTES:
 *   · Vender dice CUÁNTO DA antes de vender, que no se puede deshacer. La
 *     cifra la calcula la página (ver components/tienda/repetidas.ts); con
 *     sesión es aproximada y se rotula con "≈".
 *   · "Otro sobre" repite LO ÚLTIMO QUE SE COMPRÓ: tras un ×10 compraba un
 *     sobre suelto. El rótulo llega hecho ("Otros ×10 · 500").
 * Y si no hay saldo para repetir, lo dice en vez de parecer activo.
 */
interface BarraDelResumenProps {
  /** Repetidas del sobre. Con 0, o sin `puedeVender`, no hay botón de venta. */
  repetidas: number;
  puedeVender: boolean;
  /** Lo que darían, o null si no se puede estimar. */
  tasacion: { importe: number; exacta: boolean } | null;
  vendiendo: boolean;
  /** La venta ya hecha: sustituye al botón por su resultado. */
  vendido: { earned: number; sold: number } | null;
  onVender: () => void;
  /** Qué se repite y cuánto falta para pagarlo; null si no hay nada que repetir. */
  repetir: { rotulo: string; falta: number } | null;
  /** Hay una compra en vuelo. */
  ocupado: boolean;
  onRepetir: () => void;
}

const plural = (n: number) => (n === 1 ? "repetida" : "repetidas");

export default function BarraDelResumen({
  repetidas,
  puedeVender,
  tasacion,
  vendiendo,
  vendido,
  onVender,
  repetir,
  ocupado,
  onRepetir,
}: BarraDelResumenProps) {
  const hayVenta = repetidas > 0 && puedeVender && !vendido;
  if (!hayVenta && !vendido && !repetir) return null;

  return (
    <div
      className="surface sticky z-40 mt-6 flex w-full items-stretch gap-2 rounded-2xl p-2.5"
      style={{ bottom: "calc(var(--content-bottom) - 4px)", boxShadow: "var(--shadow-lg)" }}
    >
      {hayVenta && (
        <button
          type="button"
          onClick={onVender}
          disabled={vendiendo || ocupado}
          className="press touch-target min-w-0 flex-1 rounded-xl px-3 py-1.5 text-center t-cuerpo-2 font-medium leading-tight transition disabled:opacity-50"
          style={{
            background: "var(--ok-weak)",
            border: "1px solid color-mix(in srgb, var(--ok) 35%, transparent)",
            color: "var(--ok)",
          }}
        >
          {vendiendo ? (
            "Vendiendo..."
          ) : (
            <>
              Vender {repetidas} {plural(repetidas)}
              {/* En la misma frase y no en un renglón propio: a 320 px el
                  botón mide 126 px, "Vender 7 repetidas" ya parte en dos líneas
                  y con la cifra debajo eran tres, 59 px de botón en una barra
                  que tiene que estorbar lo menos posible. La cifra no se parte
                  por dentro. */}
              {tasacion && tasacion.importe > 0 && (
                <span className="tnum whitespace-nowrap font-semibold">
                  {" · "}
                  {tasacion.exacta ? "" : "≈ "}+{formatNumber(tasacion.importe)}
                </span>
              )}
            </>
          )}
        </button>
      )}
      {vendido && (
        <span
          className="flex min-w-0 flex-1 items-center justify-center px-2 text-center t-cuerpo-2 font-medium leading-tight"
          style={{ color: "var(--ok)" }}
        >
          +{formatNumber(vendido.earned)} por {vendido.sold} {plural(vendido.sold)}
        </span>
      )}
      {repetir && (
        // Espera también a la venta de repetidas: su respuesta escribe el
        // resultado en el resumen, y con otro sobre de por medio acababa
        // pintándose en el resumen del siguiente.
        <button
          type="button"
          onClick={onRepetir}
          disabled={ocupado || vendiendo}
          className={`btn-accent press touch-target flex-1 whitespace-nowrap rounded-xl px-4 py-2.5 t-cuerpo font-semibold disabled:opacity-60 ${
            repetir.falta > 0 && !ocupado ? "opacity-60" : ""
          }`}
        >
          {ocupado
            ? "Abriendo..."
            : repetir.falta > 0
              ? `Te faltan ${formatNumber(repetir.falta)}`
              : repetir.rotulo}
        </button>
      )}
    </div>
  );
}
