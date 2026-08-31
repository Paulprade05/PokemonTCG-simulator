"use client";

import NotaGraduada from "./NotaGraduada";
import { formatNumber } from "../../utils/format";
import { MAX_ANUNCIOS_ABIERTOS } from "../../utils/bazar";
import type { MiAnuncio } from "./tipos";

/**
 * MIS ANUNCIOS: lo que he puesto a la venta, lo que se ha vendido y lo que
 * retiré.
 *
 * ES UNA LISTA Y NO UNA REJILLA DE CARTAS, a propósito. `getMisAnunciosBazar`
 * devuelve hasta 100 filas, historial incluido; pintarlas con PokemonCard serían
 * 100 ilustraciones a tamaño carta para responder a preguntas que son de texto
 * ("¿se ha vendido?", "¿cuánto cobré?"). Se pinta la miniatura `images.small`
 * —la misma que usa la hoja de acciones de la colección— y el dinero grande.
 *
 * LA CIFRA QUE MANDA AQUÍ ES `cobrarias`, NO `precio`. Es la segunda sorpresa
 * del bazar: el vendedor cobra el precio MENOS la comisión. Enseñar sólo el
 * precio en la pantalla donde el vendedor mira sus ventas sería justo la
 * omisión que hace que alguien cuente sus monedas y crea que le han robado.
 */

/** Rótulo del estado. El `default` existe porque la columna es texto libre. */
function rotuloEstado(estado: string): string {
  if (estado === "activa") return "En venta";
  if (estado === "vendida") return "Vendida";
  if (estado === "retirada") return "Retirada";
  return "Cerrada";
}

/** Tinta del estado: sólo la venta merece color, el resto es información. */
function tintaEstado(estado: string): string {
  if (estado === "vendida") return "var(--ok)";
  if (estado === "activa") return "var(--ink-soft)";
  return "var(--ink-faint)";
}

interface MisAnunciosProps {
  anuncios: MiAnuncio[];
  /** Id del anuncio con una retirada en vuelo. */
  enCurso: number | null;
  /** Hay otra operación de dinero en marcha en la pantalla. */
  bloqueada: boolean;
  onRetirar: (anuncio: MiAnuncio) => void;
  onPublicar: () => void;
  /** Falso mientras no lleve los sobres mínimos: el botón vacío no engaña. */
  puedePublicar: boolean;
}

export default function MisAnuncios({
  anuncios,
  enCurso,
  bloqueada,
  onRetirar,
  onPublicar,
  puedePublicar,
}: MisAnunciosProps) {
  const activos = anuncios.filter((a) => a.estado === "activa").length;
  // Sólo el histórico de ventas: lo que se ha cobrado de verdad. Las retiradas
  // no pagan nada y sumarlas aquí inflaría la cifra.
  const cobrado = anuncios
    .filter((a) => a.estado === "vendida")
    .reduce((total, a) => total + a.cobrarias, 0);

  if (anuncios.length === 0) {
    return (
      <div className="surface flex flex-col items-center gap-4 rounded-2xl px-6 py-16 text-center">
        <div className="surface-2 flex h-14 w-14 items-center justify-center rounded-2xl">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="ink-faint h-7 w-7" aria-hidden="true">
            <path d="M3 9h18l-1.5 10.5a2 2 0 0 1-2 1.5H6.5a2 2 0 0 1-2-1.5z" />
            <path d="M8 9V6a4 4 0 0 1 8 0v3" />
          </svg>
        </div>
        <div>
          <p className="ink font-medium">No has puesto nada a la venta</p>
          <p className="ink-soft mt-1 text-sm">
            Publica una carta que te sobre y espera a que alguien la compre.
          </p>
        </div>
        <button
          type="button"
          onClick={onPublicar}
          disabled={!puedePublicar}
          className="btn-accent press touch-target flex items-center justify-center rounded-xl px-5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
        >
          Publicar una carta
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="surface-2 flex flex-wrap items-center justify-between gap-2 rounded-2xl px-4 py-3">
        <p className="ink-soft text-[12px]">
          <span className="tnum ink font-semibold">{activos}</span> de{" "}
          <span className="tnum">{MAX_ANUNCIOS_ABIERTOS}</span> anuncios abiertos
        </p>
        {cobrado > 0 && (
          <p className="ink-soft text-[12px]">
            Cobrado en el bazar:{" "}
            <span className="tnum font-semibold" style={{ color: "var(--ok)" }}>
              {formatNumber(cobrado)}
            </span>
          </p>
        )}
      </div>

      <ul className="flex flex-col gap-2.5">
        {anuncios.map((a) => {
          const activo = a.estado === "activa";
          return (
            <li
              key={a.id}
              className={`surface flex items-center gap-3 rounded-2xl p-3 ${activo ? "" : "opacity-70"}`}
            >
              {a.images?.small && (
                // `images.small` (245px de ancho) y no la grande: es la misma
                // miniatura que usa la hoja de acciones de la colección, y aquí
                // se pinta a 48px. La lista puede traer 100 filas de historial,
                // así que van perezosas y descodificando fuera del hilo.
                <img
                  src={a.images.small}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="w-12 shrink-0 rounded-lg"
                  style={{ boxShadow: "var(--shadow-sm)" }}
                />
              )}

              <div className="min-w-0 flex-1">
                <p className="ink truncate text-[14px] leading-tight font-semibold">
                  {a.name}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span
                    className="text-[11px] font-semibold"
                    style={{ color: tintaEstado(a.estado) }}
                  >
                    {rotuloEstado(a.estado)}
                  </span>
                  <span className="ink-faint text-[11px]">· {a.rarity}</span>
                  {a.nota !== null && <NotaGraduada nota={a.nota} variante="linea" />}
                </div>
                <p className="ink-soft mt-1.5 text-[11px] leading-snug">
                  {a.estado === "vendida" ? "Cobraste" : "Cobrarás"}{" "}
                  <span
                    className="tnum font-semibold"
                    style={{ color: a.estado === "retirada" ? "var(--ink-soft)" : "var(--ok)" }}
                  >
                    {formatNumber(a.cobrarias)}
                  </span>
                  <span className="ink-faint">
                    {" "}
                    · el comprador paga {formatNumber(a.precio)}
                  </span>
                </p>
              </div>

              {activo && (
                <button
                  type="button"
                  onClick={() => onRetirar(a)}
                  disabled={enCurso === a.id || bloqueada}
                  aria-busy={enCurso === a.id}
                  aria-label={`Retirar ${a.name} del bazar`}
                  className="btn-ghost press touch-target ink-soft flex shrink-0 items-center justify-center rounded-xl px-3 text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {enCurso === a.id ? "…" : "Retirar"}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {/* Publicar NO toca `user_collection`: la carta no se mueve hasta que
          alguien compra. Lo único que hace el anuncio es contar como copia
          comprometida en el guard del INSERT (app/action.ts:3630-3643), o sea
          que gasta una de las copias que te sobran para futuras publicaciones.
          Se dice tal cual para que nadie abra el álbum a comprobar si su carta
          ha desaparecido. */}
      <p className="ink-faint mx-auto mt-1 max-w-md text-center text-[11px] leading-relaxed">
        Mientras un anuncio está en venta, la carta sigue en tu álbum: lo único
        que cambia es que esa copia ya no cuenta como libre para publicar otra
        vez. Retirar un anuncio no cuesta nada ni pierde nada.
      </p>
    </div>
  );
}
