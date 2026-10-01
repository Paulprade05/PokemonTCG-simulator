"use client";

import Link from "next/link";
import { IconoMoneda } from "../icons";
import { formatNumber } from "../../utils/format";

/**
 * SIN SALDO NO BASTA CON DECIR QUE FALTA.
 *
 * Los botones de compra parecían activos tuviera el jugador lo que tuviera, y
 * al pulsar salía "No tienes suficientes monedas" y nada más: ni cuánto falta
 * ni de dónde sacarlo. Lo que casi siempre hay son repetidas sin vender, y
 * cuántas son y cuánto valen sólo se veía en Colección, detrás de un icono y
 * dentro de una hoja de confirmación.
 *
 * Esto va BAJO los sobres y dice una de dos cosas:
 *   · hay repetidas que vender: cuántas, cuánto valen, y lleva a Colección,
 *     que es donde se venden (con sus favoritas respetadas);
 *   · no las hay y no llega ni para el sobre más barato: de dónde salen las
 *     monedas. Al invitado se le dice la verdad: sin cuenta no hay recompensa
 *     diaria ni se cobra en el Mercado.
 *
 * `aproximado`: con sesión la cifra la estima el navegador sin el ajuste por
 * precio real (ver components/tienda/repetidas.ts) y se dice "unas".
 */
interface AvisoSinSaldoProps {
  /** Repetidas vendibles de toda la colección, o null si no se sabe. */
  repetidas: { n: number; valor: number } | null;
  aproximado: boolean;
  /** No llega ni para el sobre más barato de esta expansión. */
  noLlegaParaNinguno: boolean;
  conSesion: boolean;
}

export default function AvisoSinSaldo({
  repetidas,
  aproximado,
  noLlegaParaNinguno,
  conSesion,
}: AvisoSinSaldoProps) {
  if (repetidas && repetidas.valor > 0) {
    const una = repetidas.n === 1;
    return (
      <Link
        href="/collection"
        className="surface surface-hover press-flat touch-target flex items-center gap-3 rounded-2xl px-4 py-3"
      >
        <IconoMoneda tam={20} className="[color:var(--warn)]" />
        <span className="ink-soft t-cuerpo-2 min-w-0 flex-1 leading-snug">
          Tienes{" "}
          <span className="ink tnum font-semibold">
            {formatNumber(repetidas.n)} {una ? "repetida" : "repetidas"}
          </span>{" "}
          que {una ? "vale" : "valen"}
          {aproximado ? " unas " : " "}
          <span className="ink tnum font-semibold">{formatNumber(repetidas.valor)}</span> monedas
        </span>
        {/* --ok y no --accent: es texto, y --accent sobre el papel claro se
            queda en 2:1. */}
        <span className="t-cuerpo-2 shrink-0 font-semibold" style={{ color: "var(--ok)" }}>
          Vender
        </span>
      </Link>
    );
  }
  if (!noLlegaParaNinguno) return null;
  return (
    <p className="surface ink-soft t-cuerpo-2 rounded-2xl px-4 py-3 leading-snug">
      {conSesion
        ? "No te llega para ningún sobre de esta expansión. La recompensa diaria y el Mercado dan monedas."
        : "No te llega para ningún sobre de esta expansión. Sin cuenta, las monedas salen de vender repetidas; con una cuenta hay además recompensa diaria y Mercado."}
    </p>
  );
}
