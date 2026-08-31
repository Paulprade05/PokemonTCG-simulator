"use client";

import PokemonCard from "../PokemonCard";
import NotaGraduada from "./NotaGraduada";
import { formatNumber } from "../../utils/format";
import type { AnuncioBazar } from "./tipos";

/**
 * UN ANUNCIO DEL ESCAPARATE: la carta, quién la vende y a cuánto.
 *
 * SIN ANIMACIÓN DE ENTRADA, Y ES DELIBERADO. La rejilla trae hasta 40 anuncios
 * de golpe (el tope de `getBazar`) y cada uno es una ilustración remota. Una
 * entrada escalonada con framer-motion pondría 40 elementos con `transform` y
 * `will-change` alrededor de 40 imágenes justo mientras el navegador las está
 * decodificando: es exactamente el escenario que components/PokemonCard.tsx
 * describe en su cabecera (una capa compositada por carta, rasterizada a escala
 * fija, ilustración borrosa en iPhone y scroll a tirones). La colección y el
 * álbum tampoco animan sus celdas, por lo mismo. Lo único que se mueve al pasar
 * el ratón es un `translate`, nunca un `scale`.
 *
 * LA CHAPA DE LA NOTA VA SUPERPUESTA sobre la carta y no debajo: en una rejilla
 * se compara de un vistazo, y es la nota lo que explica por qué esa carta cuesta
 * el triple que la de al lado.
 */

interface TarjetaAnuncioProps {
  anuncio: AnuncioBazar;
  /**
   * Saldo del comprador. Sólo para AVISAR antes de tiempo: la comprobación de
   * verdad la hace el servidor dentro de la misma sentencia que mueve el dinero.
   */
  saldo: number;
  /** Con sesión. El invitado ve el escaparate entero pero no puede comprar. */
  puedeComprar: boolean;
  /** Este anuncio tiene una compra o una retirada en vuelo. */
  enCurso: boolean;
  /** Hay otra operación en vuelo: todo lo demás se apaga hasta que termine. */
  bloqueada: boolean;
  onComprar: () => void;
  onRetirar: () => void;
}

export default function TarjetaAnuncio({
  anuncio,
  saldo,
  puedeComprar,
  enCurso,
  bloqueada,
  onComprar,
  onRetirar,
}: TarjetaAnuncioProps) {
  const cobraElVendedor = anuncio.precio - anuncio.comision;
  const faltan = anuncio.precio - saldo;
  // El aviso de saldo sólo tiene sentido con sesión: el saldo del invitado vive
  // en su navegador y no es el que se va a cobrar.
  const sinSaldo = puedeComprar && !anuncio.esMio && faltan > 0;

  return (
    <article className="surface group flex flex-col gap-2 rounded-2xl p-2.5">
      <div className="relative">
        {anuncio.nota !== null && (
          <div className="absolute top-1.5 left-1.5 z-20">
            <NotaGraduada nota={anuncio.nota} />
          </div>
        )}
        {anuncio.esMio && (
          <div
            className="absolute top-1.5 right-1.5 z-20 rounded-full px-2 py-1 text-[10px] leading-none font-bold"
            style={{
              background: "var(--ink)",
              color: "var(--bg)",
              boxShadow: "var(--shadow-sm)",
            }}
          >
            Tuyo
          </div>
        )}
        {/* `interactive={false}` + `reveal`: el camino rápido de PokemonCard,
            que pinta la carta como una imagen y ya, sin perspectiva ni reverso.
            El objeto se arma aquí porque el anuncio guarda el id de la carta en
            `cardId` y PokemonCard (y su memo) lo busca en `id`. */}
        {/* El realce cuelga del `group` de la tarjeta y no de este div: con
            `pointer-events-none` puesto (para que la ilustración no se pueda
            arrastrar) el `hover:` propio no llegaría a dispararse nunca. */}
        <div className="pointer-events-none transition-transform duration-300 group-hover:-translate-y-1">
          <PokemonCard
            card={{
              id: anuncio.cardId,
              name: anuncio.name,
              rarity: anuncio.rarity,
              images: anuncio.images,
            }}
            reveal
            interactive={false}
          />
        </div>
      </div>

      <div className="min-w-0">
        <p className="ink truncate text-[13px] leading-tight font-semibold">
          {anuncio.name}
        </p>
        <p className="ink-faint mt-0.5 truncate text-[10px]">
          {anuncio.rarity}
          {" · "}
          {anuncio.esMio ? "publicado por ti" : `de ${anuncio.vendedor}`}
        </p>
      </div>

      <div className="mt-auto flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="tnum ink text-base leading-none font-bold">
            {formatNumber(anuncio.precio)}
          </span>
          <span className="ink-faint text-[10px]">monedas</span>
        </div>

        {/* En los anuncios propios la cifra que importa NO es el precio, es lo
            que se cobra: el vendedor recibe el precio menos la comisión y esa
            resta es la sorpresa número dos del bazar. Se dice aquí también, no
            sólo al publicar, porque el anuncio se mira muchas veces después. */}
        {anuncio.esMio ? (
          <>
            <p className="ink-soft text-[11px] leading-snug">
              Cobrarás{" "}
              <span className="tnum font-semibold" style={{ color: "var(--ok)" }}>
                {formatNumber(cobraElVendedor)}
              </span>{" "}
              <span className="ink-faint">
                (−{formatNumber(anuncio.comision)} de comisión)
              </span>
            </p>
            <button
              type="button"
              onClick={onRetirar}
              disabled={enCurso || bloqueada}
              aria-busy={enCurso}
              className="btn-ghost press touch-target ink-soft flex w-full items-center justify-center rounded-xl text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-40"
            >
              {enCurso ? "Retirando…" : "Retirar"}
            </button>
          </>
        ) : (
          <>
            {sinSaldo && (
              <p
                className="text-[11px] leading-snug font-medium"
                style={{ color: "var(--warn-ink)" }}
              >
                Te faltan {formatNumber(faltan)} monedas
              </p>
            )}
            {/* NO se deshabilita por saldo, sólo se avisa. El saldo que se lee
                aquí es el del contexto de monedas, que se cachea en
                localStorage por identidad: si ese número se quedara corto por
                lo que sea, deshabilitar el botón dejaría al jugador sin poder
                comprar algo que sí puede pagar. Avisar es honesto; bloquear con
                un dato de segunda mano, no. Quien decide es el servidor. */}
            <button
              type="button"
              onClick={onComprar}
              disabled={!puedeComprar || enCurso || bloqueada}
              aria-busy={enCurso}
              className={`press touch-target flex w-full items-center justify-center rounded-xl text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
                sinSaldo ? "btn-ghost ink-soft" : "btn-accent"
              }`}
            >
              {enCurso
                ? "Comprando…"
                : !puedeComprar
                  ? "Inicia sesión"
                  : "Comprar"}
            </button>
          </>
        )}
      </div>
    </article>
  );
}
