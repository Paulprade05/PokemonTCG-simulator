"use client";

// components/graduacion/BarraEnvio.tsx
//
// La barra que resume el envío y lo manda. Aparece sólo cuando hay algo elegido
// y se queda pegada al borde inferior mientras se recorre la lista, porque el
// número que cambia al tocar un "+" está a treinta filas de distancia y sin esto
// no se ve el efecto.
//
// ============================================================================
// POR QUÉ `position: sticky` Y NO `fixed`
// ============================================================================
//
// app/template.tsx envuelve cada ruta en un motion.div CON TRANSFORM, y un
// ancestro transformado se convierte en el bloque contenedor de cualquier
// `position: fixed` que haya debajo: la barra no se anclaría al viewport, sino
// al alto de la página. Lo que sí funciona sin salirse del árbol es `sticky`,
// que no depende del bloque contenedor. La alternativa sería un portal a body
// (components/ui/Portal.tsx), pero para una barra que pertenece a esta sección
// y desaparece con ella, sacarla del árbol es más problema que solución.
//
// El desplazamiento inferior es `--content-bottom`: la altura de la barra de
// pestañas más la safe area. Sin eso, en un iPhone el botón de graduar quedaría
// justo debajo de la pestaña de "Colección".
//
// ============================================================================
// EL INCENTIVO
// ============================================================================
//
// Lo que de verdad hace esta barra es enseñar que mandar más sale más barato:
// el total tachado, el ahorro y, sobre todo, cuántas copias faltan para el
// siguiente escalón. Ese último dato es el que convierte "gradúo una" en
// "gradúo cinco", y el que hace falta que esté a la vista en el momento exacto
// en que se está decidiendo.

import { AnimatePresence, motion } from "framer-motion";
import { formatNumber } from "../../utils/format";
import { porcentaje } from "./Comun";

interface Props {
  totalCopias: number;
  /** Lo que se va a cobrar, ya con el descuento del tramo actual. */
  totalCoste: number;
  /** Lo que costaría lo mismo mandado de una en una. */
  totalSinDescuento: number;
  /** Descuento vigente (0-1) para el número de copias elegido. */
  descuento: number;
  /** El siguiente escalón, si queda alguno por encima del actual. */
  siguienteEscalon: { desde: number; descuento: number } | null;
  monedas: number;
  enCurso: boolean;
  onGraduar: () => void;
  onVaciar: () => void;
}

export default function BarraEnvio({
  totalCopias,
  totalCoste,
  totalSinDescuento,
  descuento,
  siguienteEscalon,
  monedas,
  enCurso,
  onGraduar,
  onVaciar,
}: Props) {
  const ahorro = totalSinDescuento - totalCoste;
  const sinSaldo = totalCoste > monedas;
  const faltan = siguienteEscalon ? siguienteEscalon.desde - totalCopias : 0;

  return (
    <AnimatePresence>
      {totalCopias > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
          className="sticky z-40 glass rounded-2xl p-3.5 flex flex-col gap-3"
          style={{ bottom: "calc(var(--content-bottom) - 4px)", boxShadow: "var(--shadow-lg)" }}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold tnum">
                {formatNumber(totalCopias)} {totalCopias === 1 ? "copia" : "copias"} al graduador
              </p>
              <p className="text-[11px] ink-soft tnum">
                {formatNumber(totalCoste)} monedas
                {ahorro > 0 && (
                  <>
                    {" · "}
                    <span className="line-through ink-faint">{formatNumber(totalSinDescuento)}</span>{" "}
                    <span style={{ color: "var(--ok)" }} className="font-semibold">
                      −{porcentaje(descuento, 0)}, ahorras {formatNumber(ahorro)}
                    </span>
                  </>
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={onVaciar}
              disabled={enCurso}
              className="chip ink-soft text-[11px] px-3 py-2 press shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Vaciar
            </button>
          </div>

          {/* EL EMPUJÓN. Sólo si queda escalón por encima; cuando ya se está en
              el último se dice, para que nadie siga añadiendo copias creyendo
              que va a bajar más. */}
          {siguienteEscalon ? (
            <p
              className="text-[11px] leading-snug rounded-xl px-3 py-2"
              style={{
                background: "var(--ok-weak)",
                color: "var(--ok)",
              }}
            >
              Añade {formatNumber(faltan)} {faltan === 1 ? "copia" : "copias"} más y todo el envío
              baja un {porcentaje(siguienteEscalon.descuento, 0)}.
            </p>
          ) : descuento > 0 ? (
            <p className="text-[11px] ink-faint">
              Descuento máximo aplicado: −{porcentaje(descuento, 0)} en todo el envío.
            </p>
          ) : null}

          {sinSaldo && (
            <p className="text-[11px] leading-snug" style={{ color: "var(--danger)" }}>
              Te faltan {formatNumber(totalCoste - monedas)} monedas. Quita alguna copia o vende
              repetidas en tu colección.
            </p>
          )}

          <button
            type="button"
            onClick={onGraduar}
            disabled={enCurso || sinSaldo}
            aria-busy={enCurso}
            className="btn-accent press touch-target w-full rounded-2xl py-3.5 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {enCurso ? (
              <>
                <span className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                Enviando al graduador…
              </>
            ) : (
              <>Graduar por {formatNumber(totalCoste)} monedas</>
            )}
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
