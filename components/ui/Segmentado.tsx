"use client";

import { motion } from "framer-motion";
import { useHaptics } from "../../hooks/useHaptics";
import { formatNumber } from "../../utils/format";
import { MUELLE_PILDORA } from "../../utils/motion";

/**
 * EL INTERRUPTOR DE DOS O TRES POSICIONES.
 *
 * Estaba escrito CUATRO veces —el bazar (Escaparate / Mis anuncios), la hoja de
 * publicar (Sueltas / Graduadas), la graduación (Enviar / Mis graduadas), el
 * álbum (Todas / Tengo / Me faltan) y, con otra cara, las cinco pestañas de
 * social—. Todas hacen exactamente lo mismo: elegir cuál de dos o tres paneles
 * se ve debajo. Ninguna se parecía a la siguiente.
 *
 * LO QUE SE UNIFICA, Y POR QUÉ ESO IMPORTABA MÁS QUE EL RELLENO:
 *
 *  · CÓMO SE VE LO ACTIVO. Había TRES respuestas distintas en la misma
 *    aplicación: `btn-primary` (un bloque de tinta sólida) en el bazar, la hoja
 *    de publicar y la graduación; un fondo de tinta al 9% con borde en el
 *    álbum; y un tinte de acento con borde de acento en social. Eso significa
 *    que "esto es lo que está seleccionado" se decía de tres formas, y el
 *    jugador tiene que volver a aprenderlo en cada pantalla.
 *    Gana el TINTE DE ACENTO, y no por mayoría —era el de una sola copia— sino
 *    porque es el que ya usan las DOS piezas de navegación permanentes de la
 *    aplicación: la pastilla de la barra inferior y la del menú lateral. Ésas
 *    están siempre a la vista, así que son las que enseñan el idioma; que un
 *    interruptor de pantalla hable otro es la incoherencia, no al revés.
 *
 *  · EL RECUADRO. `surface` en la graduación y en el álbum, `surface-2` en el
 *    bazar; `p-1` aquí, `p-1.5` allá, `gap-1.5` en uno y `gap-2` en otro. Es
 *    descuido puro: se fija en `surface-2` (el interruptor es un control DENTRO
 *    de la página, no una tarjeta, y el papel más hundido lo dice) con 6px de
 *    relleno y 6px de separación.
 *
 *  · LA PASTILLA SE DESLIZA. Sólo lo hacía la de social. Es lo que convierte
 *    tres botones en UN interruptor: sin el desplazamiento, el fondo desaparece
 *    de un sitio y aparece en otro, y son dos cosas; con él, es una sola que se
 *    mueve. El muelle sale de utils/motion.ts, así que es literalmente el mismo
 *    con el que se mueven las otras pastillas de la aplicación. Con "reducir
 *    efectos" o con la preferencia del sistema, el MotionConfig de AppShell lo
 *    desactiva y la pastilla simplemente aparece: sigue informando igual.
 *
 * NO LLEVA role="tab"/"tablist" A PROPÓSITO. Ese patrón de ARIA obliga a mover
 * el foco con las flechas y a un tabindex rotatorio; anunciarse como pestañas
 * sin implementar eso deja al lector de pantalla diciendo "pestaña 1 de 2" y
 * esperando unas flechas que no hacen nada. `aria-pressed` sobre botones
 * describe exactamente lo que son, y era ya la decisión razonada de la
 * graduación.
 */

export interface OpcionSegmentado<T extends string> {
  id: T;
  rotulo: string;
  /**
   * SEGUNDA LÍNEA PEQUEÑA, para los RECUENTOS: cuántas cartas caen en este
   * filtro, cuántas copias hay en esta pestaña. Va DENTRO del botón para que el
   * número entre en la zona tocable, y en su propia línea para que el botón no
   * cambie de ancho cuando el número crece.
   *
   * Un recuento SE PINTA AUNQUE SEA CERO, y por eso va aquí y no en `insignia`:
   * "Sueltas · 0" es justo el dato que decide si merece la pena tocar la
   * pestaña, y esconderlo obliga a tocarla para descubrir que está vacía. Es un
   * número, así que se pasa como número y lo formatea este componente (`1.234`,
   * no `1234`, como en el resto de la aplicación).
   */
  detalle?: number;
  /**
   * PÍLDORA DE AVISO, que es otra cosa: peticiones de amistad pendientes,
   * ofertas sin leer. Aquí el cero SÍ se esconde, porque una insignia de aviso
   * a cero no informa de nada — dice "no hay nada nuevo", que es el estado
   * normal, y deja la pastilla encendida todo el rato. También se formatea.
   */
  insignia?: number;
}

interface SegmentadoProps<T extends string> {
  /**
   * Identificador ÚNICO en toda la pantalla. Es el `layoutId` de la pastilla:
   * si dos interruptores montados a la vez comparten uno, framer los toma por
   * el mismo objeto y la pastilla vuela de un control al otro.
   */
  id: string;
  /** Para qué sirve el grupo. Va al `aria-label` del contenedor. */
  etiqueta: string;
  opciones: readonly OpcionSegmentado<T>[];
  valor: T;
  onCambio: (id: T) => void;
  /**
   * Reparto del ancho. `false` (por defecto) da a cada opción lo que necesita y
   * las estira a partes iguales; `true` fuerza columnas exactamente iguales,
   * que es lo que pide el álbum para que sus tres rótulos de distinta longitud
   * no bailen al cambiar los recuentos.
   */
  columnas?: boolean;
  /** Espacio alrededor (`mb-6`, `mt-4`…). Nada de estilo interno. */
  className?: string;
}

export default function Segmentado<T extends string>({
  id,
  etiqueta,
  opciones,
  valor,
  onCambio,
  columnas = false,
  className = "",
}: SegmentadoProps<T>) {
  const haptic = useHaptics();

  return (
    <div
      role="group"
      aria-label={etiqueta}
      className={`surface-2 rounded-2xl p-1.5 ${
        columnas
          ? `grid gap-1.5 ${opciones.length === 3 ? "grid-cols-3" : "grid-cols-2"}`
          : "flex gap-1.5"
      } ${className}`}
    >
      {opciones.map((op) => {
        const activa = op.id === valor;
        return (
          <button
            key={op.id}
            type="button"
            aria-pressed={activa}
            onClick={() => {
              // La vibración vive AQUÍ y no en cada consumidor: las cuatro
              // copias la disparaban por su cuenta y dos usaban "tap" y dos
              // "select", que se sienten distinto. Elegir es "select".
              if (!activa) haptic("select");
              onCambio(op.id);
            }}
            /* `press-flat` y no `press`: la hoja de publicar y el álbum tienen
               cartas en la misma pantalla, y `.press` escala — la trampa
               documentada en PokemonCard.tsx. El hundimiento de 2px da el mismo
               acuse de recibo sin tocar la escala de nada. */
            /* Sin `min-w-0` A PROPÓSITO, y ahora sí que cambiaría algo: desde
               que `.control-44` es una `@utility` de verdad, Tailwind la emite
               ANTES que `.min-w-0` y el cero ganaría. Que no gane es lo que se
               quiere aquí: el `min-width` de 44px ya permite que el botón se
               encoja por debajo de su contenido —que es lo que hace falta para
               que el rótulo se recorte con puntos suspensivos— y bajarlo a cero
               dejaría el interruptor apretarse hasta ser intocable. */
            className={`press-flat control-44 relative flex-1 flex-col rounded-xl px-3 ${
              activa ? "ink" : "ink-soft"
            }`}
          >
            {activa && (
              <motion.span
                layoutId={id}
                aria-hidden="true"
                className="absolute inset-0 rounded-xl bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] border border-[color-mix(in_srgb,var(--accent)_30%,transparent)]"
                transition={MUELLE_PILDORA}
              />
            )}
            {/* `relative` para quedar por encima de la pastilla absoluta. */}
            <span className="relative z-10 flex items-center justify-center gap-2">
              <span className="t-cuerpo-2 truncate font-semibold">{op.rotulo}</span>
              {op.insignia ? (
                <span className="tnum t-micro flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--accent)] px-1 font-bold text-[#04110c]">
                  {formatNumber(op.insignia)}
                </span>
              ) : null}
            </span>
            {/* `!== undefined` y no un `&&` a secas: un recuento de CERO tiene
                que pintarse (ver la nota de `detalle` arriba), y `0 && …` no
                pinta nada. */}
            {op.detalle !== undefined && (
              // Sin `ink-soft`: sobre la pastilla activa hereda la tinta del
              // botón y se apaga con opacidad, que funciona en los dos estados
              // y en los dos temas sin tener que elegir un color por estado.
              <span className="tnum t-micro relative z-10 opacity-70">
                {formatNumber(op.detalle)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
