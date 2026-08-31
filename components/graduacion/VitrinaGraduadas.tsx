"use client";

// components/graduacion/VitrinaGraduadas.tsx
//
// Todo lo que ya tiene nota, con sus desperfectos pintados y el botón de
// vender. Es la pestaña a la que se vuelve cuando la ceremonia se acabó.
//
// ============================================================================
// POR QUÉ ESTA PESTAÑA NO SE LLAMA "VITRINA" EN LA INTERFAZ
// ============================================================================
//
// El servidor la llama vitrina (`getVitrina`) y aquí también, en el código. Pero
// en la pantalla pone "Mis graduadas", porque en esta app ya existe /vitrina y
// es otra cosa completamente distinta: el archivador de nueve cartas por hoja
// (components/Vitrina.tsx), que está en la barra de navegación. Dos sitios con
// el mismo rótulo y contenidos distintos es el tipo de detalle que hace que la
// gente crea que se ha perdido.
//
// ============================================================================
// EL ORDEN LO PONE EL SERVIDOR
// ============================================================================
//
// `getVitrina` devuelve ya ordenado por nota descendente y, a igual nota, por
// nombre. No se reordena aquí: el criterio es el mismo que se pidió y tenerlo
// en un solo sitio evita que la lista salte al recargar. Lo único que se calcula
// en el cliente es el total, que es una suma de lo que ya viene.

import { useMemo } from "react";
import { motion } from "framer-motion";
import CartaConDesperfectos from "./CartaConDesperfectos";
import { SelloNota, type CopiaGraduada } from "./Comun";
import { formatNumber } from "../../utils/format";

interface Props {
  cartas: CopiaGraduada[];
  /** Copias vivas de cada carta; con una sola no se puede vender. */
  copiasPorCarta: Record<string, number>;
  /** gradedId de la venta en vuelo, o null. */
  vendiendo: number | null;
  onVender: (copia: CopiaGraduada) => void;
}

export default function VitrinaGraduadas({
  cartas,
  copiasPorCarta,
  vendiendo,
  onVender,
}: Props) {
  const resumen = useMemo(() => {
    let valor = 0;
    let invertido = 0;
    let mejor = 0;
    for (const c of cartas) {
      valor += c.valor;
      invertido += c.coste;
      mejor = Math.max(mejor, c.nota);
    }
    return { valor, invertido, mejor };
  }, [cartas]);

  if (cartas.length === 0) {
    return (
      <div className="surface rounded-2xl py-14 px-6 text-center flex flex-col items-center gap-3">
        <p className="ink font-medium text-sm">Todavía no has graduado nada</p>
        <p className="ink-soft text-xs max-w-xs leading-relaxed">
          Manda una copia repetida al graduador y aquí aparecerá con su nota, sus marcas y lo que
          vale.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* EL BALANCE. Se enseña lo pagado en tasas al lado de lo que valen: es el
          dato que dice si graduar ha salido a cuenta, y esconderlo sería vender
          la graduación como algo que siempre gana. No lo es (ver la tabla de
          "¿cómo funciona?"). */}
      <div className="surface rounded-2xl px-5 py-4 flex flex-wrap items-center gap-x-6 gap-y-2">
        <div>
          <p className="text-[10px] ink-faint uppercase tracking-[0.14em]">Copias</p>
          <p className="text-sm font-semibold tnum">{formatNumber(cartas.length)}</p>
        </div>
        <div>
          <p className="text-[10px] ink-faint uppercase tracking-[0.14em]">Valen</p>
          <p className="text-sm font-semibold tnum" style={{ color: "var(--ok)" }}>
            {formatNumber(resumen.valor)}
          </p>
        </div>
        <div>
          <p className="text-[10px] ink-faint uppercase tracking-[0.14em]">Pagado en tasas</p>
          <p className="text-sm font-semibold tnum ink-soft">{formatNumber(resumen.invertido)}</p>
        </div>
        <div>
          <p className="text-[10px] ink-faint uppercase tracking-[0.14em]">Mejor nota</p>
          <p className="text-sm font-semibold tnum">{resumen.mejor}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {cartas.map((c, i) => {
          const copias = copiasPorCarta[c.id] ?? c.copiasTotales;
          const esUltimaCopia = copias <= 1;
          const noValeNada = c.valor <= 0;
          const enVuelo = vendiendo === c.gradedId;

          return (
            <motion.div
              key={c.gradedId}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: Math.min(i, 12) * 0.03 }}
              className="surface rounded-2xl p-3 flex flex-col gap-2.5"
            >
              <CartaConDesperfectos
                carta={c}
                desperfectos={c.desperfectos}
                marcas={c.marcas}
                nota={c.nota}
              />

              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold truncate">{c.name}</p>
                  <p className="text-[10px] ink-faint truncate">
                    {c.rarity} · copia n.º {c.copia}
                  </p>
                </div>
                <div className="shrink-0">
                  <SelloNota nota={c.nota} tamano="sm" soloNumero />
                </div>
              </div>

              <p className="text-[11px] ink-soft tnum">
                {c.etiqueta} · vale {formatNumber(c.valor)}
              </p>

              {esUltimaCopia ? (
                // Mismo texto que en la ceremonia, y a propósito: quien lo lea
                // aquí tiene que reconocer la regla que ya leyó allí.
                <p className="text-[10px] ink-faint leading-snug">
                  Es la última copia que te queda de esta carta: hay que quedarse con una.
                </p>
              ) : noValeNada ? (
                <p className="text-[10px] ink-faint leading-snug">
                  Un {c.nota} multiplica por cero: nadie paga por ella.
                </p>
              ) : (
                <button
                  type="button"
                  onClick={() => onVender(c)}
                  disabled={enVuelo}
                  aria-busy={enVuelo}
                  className="btn-ghost press touch-target w-full rounded-xl text-[12px] font-medium flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {enVuelo ? (
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                  ) : (
                    <>Vender por {formatNumber(c.valor)}</>
                  )}
                </button>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
