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
import { D } from "../../utils/motion";
import EstadoVacio from "../ui/EstadoVacio";

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
  /* EL BALANCE VA SOBRE EL VALOR DE REFERENCIA, no sobre lo que pagaría la
   * tienda hoy, y conviene dejar escrito por qué no es una incoherencia con el
   * botón de cada ficha (que sí dice lo que se abona):
   *
   * "Lo que pagarían hoy" vale 0 en toda copia que sea la última de su carta
   * —ésas no se pueden vender—, así que una vitrina entera de cartas únicas,
   * dieces incluidos, sumaría CERO frente a las tasas pagadas. Eso no es más
   * honesto que el número de antes: es una segunda mentira, y de las caras,
   * porque esas copias se pueden publicar en el bazar y ahí la banda de precio
   * la fija exactamente este valor de referencia.
   *
   * Así que aquí manda "cuánto valen" y en el botón manda "cuánto te pagan".
   * Cuando se separan, la ficha lo dice con todas sus letras. */
  const resumen = useMemo(() => {
    let valor = 0;
    let invertido = 0;
    let mejor = 0;
    for (const c of cartas) {
      valor += c.valorDeReferencia;
      invertido += c.coste;
      mejor = Math.max(mejor, c.nota);
    }
    return { valor, invertido, mejor };
  }, [cartas]);

  if (cartas.length === 0) {
    return (
      <EstadoVacio
        titulo="Todavía no has graduado nada"
        detalle="Manda una copia repetida al graduador y aquí aparecerá con su nota, sus marcas y lo que vale."
      />
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
          <p className="t-etiqueta ink-soft">Copias</p>
          <p className="t-cuerpo font-semibold tnum">{formatNumber(cartas.length)}</p>
        </div>
        <div>
          <p className="t-etiqueta ink-soft">Valen</p>
          <p className="t-cuerpo font-semibold tnum" style={{ color: "var(--ok)" }}>
            {formatNumber(resumen.valor)}
          </p>
        </div>
        <div>
          <p className="t-etiqueta ink-soft">Pagado en tasas</p>
          <p className="t-cuerpo font-semibold tnum ink-soft">{formatNumber(resumen.invertido)}</p>
        </div>
        <div>
          <p className="t-etiqueta ink-soft">Mejor nota</p>
          <p className="t-cuerpo font-semibold tnum">{resumen.mejor}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {cartas.map((c, i) => {
          const copias = copiasPorCarta[c.id] ?? c.copiasTotales;
          const esUltimaCopia = copias <= 1;
          /* "No vale nada" lo decide LA NOTA (un 1 multiplica por cero), así que
           * se mide sobre el valor de referencia. Sobre lo que paga la tienda no
           * se podría: eso también es 0 en la última copia, y entonces el aviso
           * culparía a la nota de una regla que es del álbum. */
          const noValeNada = c.valorDeReferencia <= 0;
          const enVuelo = vendiendo === c.gradedId;
          /* LO QUE SE VA A ABONAR, calculado por el servidor con la misma
           * función que cobra `venderGraduadaAction`. Aquí se pintaba `c.valor`
           * —la tarifa plana por la nota— y el aviso de después decía otra cosa:
           * medido, "Vender por 488" y "+417" con tres copias en la mano. */
          const seCobra = c.valorDeVentaAhora;

          return (
            <motion.div
              key={c.gradedId}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: D.base, delay: Math.min(i, 12) * 0.03 }}
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
                  <p className="t-cuerpo font-semibold truncate">{c.name}</p>
                  <p className="t-micro ink-soft truncate">
                    {c.rarity} · copia n.º {c.copia}
                  </p>
                </div>
                <div className="shrink-0">
                  <SelloNota nota={c.nota} tamano="sm" soloNumero />
                </div>
              </div>

              {/* LO QUE VALE, que no es lo que te pagan. Este renglón es el
                  valor de referencia de la copia —y el que manda en el bazar—;
                  el botón de abajo dice lo que abona la tienda. */}
              <p className="t-meta ink-soft tnum">
                {c.etiqueta} · vale {formatNumber(c.valorDeReferencia)}
              </p>

              {esUltimaCopia ? (
                // Mismo texto que en la ceremonia, y a propósito: quien lo lea
                // aquí tiene que reconocer la regla que ya leyó allí.
                <p className="t-micro ink-soft leading-snug">
                  Es la última copia que te queda de esta carta: hay que quedarse con una.
                </p>
              ) : noValeNada ? (
                <p className="t-micro ink-soft leading-snug">
                  Un {c.nota} multiplica por cero: nadie paga por ella.
                </p>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => onVender(c)}
                    disabled={enVuelo}
                    aria-busy={enVuelo}
                    className="btn-ghost press touch-target w-full rounded-xl t-cuerpo-2 font-medium flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {enVuelo ? (
                      <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                    ) : (
                      <>Vender por {formatNumber(seCobra)}</>
                    )}
                  </button>
                  {/* La explicación sólo aparece cuando las dos cifras de la
                      ficha se separan, o sea a partir de la tercera copia. Con
                      dos coinciden y una frase de más sobraría. */}
                  {seCobra < c.valorDeReferencia && (
                    <p className="t-micro ink-soft leading-snug">
                      Te pagan menos porque es una repetida: tienes {formatNumber(copias)} copias de
                      esta carta y cada una de más vale menos que la anterior.
                    </p>
                  )}
                </>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
