"use client";

// components/graduacion/ComoFunciona.tsx
//
// El desplegable discreto que explica las reglas: qué probabilidad tiene cada
// nota, por cuánto multiplica, cuánto cuesta mandar una copia y desde cuántas
// copias empieza a haber descuento.
//
// ============================================================================
// NADA DE ESTO ESTÁ ESCRITO A MANO, Y ÉSA ES TODA LA GRACIA DEL FICHERO
// ============================================================================
//
// Las cifras se DERIVAN de utils/graduacion.ts en tiempo de render. Si mañana
// alguien reparte de otra forma el tramo bajo, sube el multiplicador del 9 o
// añade un escalón de descuento a las 50 copias, esta tabla lo cuenta solo. Una
// pantalla de reglas que hay que acordarse de actualizar a mano es una pantalla
// que acaba mintiendo, y aquí mentir significa que el jugador se gasta las
// monedas con una expectativa falsa.
//
// Los escalones del descuento son el único caso que no es una lectura directa,
// y se resuelven sondeando `descuentoPorVolumen` — el porqué está en
// `escalonesDeDescuento` (./Comun).

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  COSTE_BASE,
  COSTE_FRACCION,
  MULTIPLICADOR_MEDIO,
  MULTIPLICADOR_NOTA,
  PROBABILIDAD_NOTA,
  PROB_TRAMO_BAJO,
  etiquetaNota,
} from "../../utils/graduacion";
import { useHaptics } from "../../hooks/useHaptics";
import { formatNumber } from "../../utils/format";
import {
  TOPE_POR_TACADA,
  escalonesDeDescuento,
  multiplicador,
  porcentaje,
  tintaDeNota,
} from "./Comun";

export default function ComoFunciona() {
  const [abierto, setAbierto] = useState(false);
  const haptic = useHaptics();

  /** Las notas de mayor a menor, sacadas de la propia tabla de probabilidades. */
  const filas = useMemo(() => {
    return Object.keys(PROBABILIDAD_NOTA)
      .map(Number)
      .sort((a, b) => b - a)
      .map((nota) => ({
        nota,
        etiqueta: etiquetaNota(nota),
        prob: PROBABILIDAD_NOTA[nota] ?? 0,
        mult: MULTIPLICADOR_NOTA[nota] ?? 0,
      }));
  }, []);

  /** La probabilidad más alta, para que las barras se lean unas contra otras. */
  const probMaxima = useMemo(
    () => filas.reduce((m, f) => Math.max(m, f.prob), 0) || 1,
    [filas],
  );

  const escalones = useMemo(() => escalonesDeDescuento(TOPE_POR_TACADA), []);

  return (
    <div className="surface rounded-2xl overflow-hidden">
      <button
        type="button"
        onClick={() => {
          haptic("tap");
          setAbierto((v) => !v);
        }}
        aria-expanded={abierto}
        className="w-full px-5 py-4 flex items-center justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">¿Cómo funciona la graduación?</h3>
          <p className="text-xs ink-soft mt-0.5">
            Probabilidades, multiplicadores y precio. Sin letra pequeña.
          </p>
        </div>
        <motion.svg
          animate={{ rotate: abierto ? 180 : 0 }}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="w-4 h-4 ink-soft shrink-0"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </motion.svg>
      </button>

      <AnimatePresence initial={false}>
        {abierto && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="px-5 pb-5 flex flex-col gap-5">
              <p className="text-xs ink-soft leading-relaxed">
                La nota de cada copia <strong className="ink">ya estaba decidida</strong> desde que
                entró en tu colección: graduar no la sortea, la revela. Volver a intentarlo con la
                misma copia daría siempre lo mismo, así que no hay nada que reintentar. Dos copias
                de la misma carta sí tienen notas distintas.
              </p>

              {/* LA TABLA. Cabecera con scope para que un lector de pantalla
                  relacione cada celda con su columna; sin eso, en una tabla de
                  cuatro columnas se oyen cuarenta números sueltos. */}
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <caption className="sr-only">
                    Probabilidad y multiplicador de cada nota
                  </caption>
                  <thead>
                    <tr className="ink-faint text-[10px] uppercase tracking-[0.14em]">
                      <th scope="col" className="py-2 pr-3 font-semibold">Nota</th>
                      <th scope="col" className="py-2 pr-3 font-semibold">Estado</th>
                      <th scope="col" className="py-2 pr-3 font-semibold">Probabilidad</th>
                      <th scope="col" className="py-2 font-semibold text-right">Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filas.map(({ nota, etiqueta, prob, mult }) => (
                      <tr key={nota} style={{ borderTop: "1px solid var(--border)" }}>
                        <td className="py-2 pr-3">
                          <span
                            className="tnum text-sm font-bold"
                            style={{ color: tintaDeNota(nota) }}
                          >
                            {nota}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-[11px] ink-soft whitespace-nowrap">
                          {etiqueta}
                        </td>
                        <td className="py-2 pr-3">
                          <div className="flex items-center gap-2">
                            {/* La barra es ancho de un div, no un `scale`: en
                                esta pantalla hay cartas por todas partes y un
                                `scale` suelto es justo lo que no puede haber. */}
                            <div
                              className="h-1.5 rounded-full min-w-[2px]"
                              style={{
                                width: `${Math.max(2, (prob / probMaxima) * 100)}%`,
                                maxWidth: "84px",
                                background: `color-mix(in srgb, ${tintaDeNota(nota)} 55%, transparent)`,
                              }}
                            />
                            <span className="tnum text-[11px] ink-soft whitespace-nowrap">
                              {porcentaje(prob)}
                            </span>
                          </div>
                        </td>
                        <td
                          className="py-2 text-right tnum text-[12px] font-semibold whitespace-nowrap"
                          style={{ color: tintaDeNota(nota) }}
                        >
                          {multiplicador(mult)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="text-[11px] ink-faint leading-relaxed">
                {porcentaje(PROB_TRAMO_BAJO, 0)} de las copias cae en el tramo dañado (del 1 al 6);
                el resto, en el bueno. Un 1 multiplica por cero: esa copia no la compra nadie.
              </p>

              {/* EL PRECIO. Se dice el suelo y la fracción tal y como los
                  declara utils/graduacion.ts, no "100 monedas": el suelo sólo
                  manda por debajo de cierto valor y esconderlo haría que la
                  primera carta cara pareciera un error de la pantalla. */}
              <div className="surface-2 rounded-xl px-4 py-3.5 flex flex-col gap-2">
                <h4 className="text-xs font-semibold">Lo que cuesta</h4>
                <p className="text-[11px] ink-soft leading-relaxed">
                  Graduar una copia cuesta {formatNumber(COSTE_BASE)} monedas o el{" "}
                  {porcentaje(COSTE_FRACCION, 0)} de lo que vale la carta, lo que sea más alto. Y de
                  media la nota multiplica {multiplicador(MULTIPLICADOR_MEDIO)}: por debajo de lo que
                  cuesta. <strong className="ink">Graduar no es una forma de hacer dinero</strong>,
                  es una apuesta al 10 y una forma de saber qué copia tienes.
                </p>
              </div>

              {escalones.length > 0 && (
                <div className="surface-2 rounded-xl px-4 py-3.5 flex flex-col gap-2.5">
                  <h4 className="text-xs font-semibold">Descuento por volumen</h4>
                  <p className="text-[11px] ink-soft leading-relaxed">
                    El descuento se aplica al suelo del precio y se calcula sobre el total del
                    envío, no carta por carta: mandar muchas de una tacada sale más barato que
                    mandarlas de una en una.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {escalones.map(({ desde, descuento }) => (
                      <span
                        key={desde}
                        className="chip ink-soft text-[11px] px-3 py-1.5 tnum"
                      >
                        {formatNumber(desde)}+ copias · −{porcentaje(descuento, 0)}
                      </span>
                    ))}
                  </div>
                  <p className="text-[11px] ink-faint">
                    Máximo {formatNumber(TOPE_POR_TACADA)} copias por envío.
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
