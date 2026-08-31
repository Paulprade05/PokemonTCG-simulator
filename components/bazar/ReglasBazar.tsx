"use client";

import {
  COMISION,
  MAX_ANUNCIOS_ABIERTOS,
  PRECIO_MAXIMO_FRACCION,
  PRECIO_MINIMO_FRACCION,
  SOBRES_PARA_VENDER,
} from "../../utils/bazar";

/**
 * LAS TRES REGLAS DEL BAZAR, DICHAS ANTES DE QUE PASE NADA.
 *
 * ESTO NO ES DECORACIÓN Y NO SE PUEDE QUITAR PARA GANAR SITIO. El bazar tiene
 * tres comportamientos que sorprenden —el precio está acotado, hay comisión, y
 * hasta 25 sobres no se puede vender— y los tres son DEFENSAS de economía: están
 * ahí para que dos cuentas de la misma persona no puedan pasarse dinero (el
 * porqué medido está en utils/bazar.ts). Como el jugador honesto las sufre
 * igual, la única salida decente es que las lea ANTES de tocar nada, no en el
 * mensaje de error que le devuelve el servidor cuando ya ha elegido carta y
 * precio. Un error que se podía haber contado antes es una pantalla mintiendo
 * por omisión.
 *
 * NINGÚN NÚMERO ESTÁ ESCRITO A MANO. El 50 %, el 150 %, el 15 % y los 25 sobres
 * salen de las constantes de utils/bazar.ts, que son las MISMAS que aplica el
 * servidor. Si mañana la comisión sube al 20 %, este texto sube solo; escrito a
 * mano, la pantalla seguiría prometiendo un 15 % que ya no se cobra, que es la
 * peor forma posible de mentir sobre dinero.
 */

/** "15 %", "50 %"... Redondeado: las fracciones son 0,15 / 0,5 / 1,5 exactas. */
const pct = (fraccion: number) => `${Math.round(fraccion * 100)} %`;

interface ReglasBazarProps {
  /**
   * Versión larga (dentro de la hoja de publicar) frente a la tira de tres
   * fichas del escaparate. La corta existe porque el comprador también tiene
   * que ver de qué va esto, pero no necesita el manual entero para comprar.
   */
  detallado?: boolean;
  /**
   * Sobres abiertos por el jugador. `null` = todavía no se sabe (o es un
   * invitado): entonces la regla se cuenta en genérico, sin prometer un estado
   * que no se ha comprobado.
   */
  sobresAbiertos?: number | null;
  /** Anuncios propios abiertos ahora mismo, para el aviso del tope. */
  anunciosAbiertos?: number;
}

/** Ficha de una regla en la versión corta. */
function Ficha({ titulo, detalle }: { titulo: string; detalle: string }) {
  return (
    <div className="surface-2 min-w-0 flex-1 rounded-2xl px-3 py-2.5">
      <p className="ink text-[12px] leading-tight font-semibold">{titulo}</p>
      <p className="ink-soft mt-1 text-[11px] leading-snug">{detalle}</p>
    </div>
  );
}

/** Fila de una regla en la versión larga: icono, título y explicación. */
function Regla({
  icono,
  titulo,
  children,
}: {
  icono: React.ReactNode;
  titulo: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-3">
      <div
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
        style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
      >
        {icono}
      </div>
      <div className="min-w-0">
        <p className="ink text-[13px] leading-tight font-semibold">{titulo}</p>
        <p className="ink-soft mt-1 text-[12px] leading-relaxed">{children}</p>
      </div>
    </li>
  );
}

const ICONO = "w-4 h-4 ink-soft";

export default function ReglasBazar({
  detallado = false,
  sobresAbiertos = null,
  anunciosAbiertos = 0,
}: ReglasBazarProps) {
  const faltan =
    sobresAbiertos === null ? null : Math.max(0, SOBRES_PARA_VENDER - sobresAbiertos);

  if (!detallado) {
    return (
      <div className="flex flex-col gap-2 sm:flex-row">
        <Ficha
          titulo="Precio acotado"
          detalle={`Entre el ${pct(PRECIO_MINIMO_FRACCION)} y el ${pct(PRECIO_MAXIMO_FRACCION)} de lo que vale la carta.`}
        />
        <Ficha
          titulo={`Comisión del ${pct(COMISION)}`}
          detalle="El vendedor cobra menos de lo que paga el comprador."
        />
        <Ficha
          titulo={`${SOBRES_PARA_VENDER} sobres para vender`}
          detalle={
            // Con `faltan === null` (invitado, o todavía sin comprobar) no se
            // promete nada sobre comprar: el invitado tampoco puede, y decirle
            // aquí que sí contradiría el aviso que tiene justo encima.
            faltan === null
              ? "Sólo hace falta para publicar, no para comprar."
              : faltan > 0
                ? `Te faltan ${faltan} para poder publicar.`
                : "Ya puedes publicar tus cartas."
          }
        />
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-4">
      <Regla
        titulo="El precio no lo eliges del todo"
        icono={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={ICONO} aria-hidden="true">
            <path d="M4 12h16" /><path d="M7 8v8" /><path d="M17 8v8" />
          </svg>
        }
      >
        Tiene que caer entre el {pct(PRECIO_MINIMO_FRACCION)} y el{" "}
        {pct(PRECIO_MAXIMO_FRACCION)} de lo que vale la carta. El valor lo calcula
        el servidor con la rareza y el precio real del día, así que el deslizador
        ya viene topado: dentro de él, cualquier precio vale.
      </Regla>

      <Regla
        titulo={`La casa se queda el ${pct(COMISION)}`}
        icono={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={ICONO} aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v10M9.5 9.5h4a1.8 1.8 0 0 1 0 3.5h-3a1.8 1.8 0 0 0 0 3.5h4" />
          </svg>
        }
      >
        El comprador paga el precio del anuncio y tú cobras ese precio menos la
        comisión. Verás siempre las dos cifras juntas antes de publicar: aquí no
        se enseña un precio a secas.
      </Regla>

      <Regla
        titulo={`Hacen falta ${SOBRES_PARA_VENDER} sobres abiertos`}
        icono={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={ICONO} aria-hidden="true">
            <path d="M4 7h16v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
            <path d="M4 7 7 3h10l3 4" /><path d="M12 3v18" />
          </svg>
        }
      >
        {faltan === null
          ? `Para publicar hay que llevar ${SOBRES_PARA_VENDER} sobres abiertos. Para comprar no se pide nada.`
          : faltan > 0
            ? `Te faltan ${faltan} ${faltan === 1 ? "sobre" : "sobres"} para poder publicar. Comprar sí puedes desde ya.`
            : "Ya los llevas: puedes publicar cuando quieras."}
      </Regla>

      {/* Estas dos no son "reglas del bazar" sino las dos formas en que una
          publicación se cae SIN que el jugador entienda por qué. Van aquí, en
          letra pequeña, porque el mensaje del servidor ("sin-copias",
          "demasiados-anuncios") no se explica solo. */}
      <li
        className="ink-faint pt-1 text-[11px] leading-relaxed"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        <span className="pt-3 block">
          De cada carta te queda siempre una copia en el álbum: sólo se publican
          las que te sobran, graduadas incluidas. Y no puedes tener más de{" "}
          {MAX_ANUNCIOS_ABIERTOS} anuncios abiertos a la vez
          {anunciosAbiertos > 0 ? ` (ahora tienes ${anunciosAbiertos})` : ""}.
        </span>
      </li>
    </ul>
  );
}
