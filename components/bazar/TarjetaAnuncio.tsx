"use client";

import PokemonCard from "../PokemonCard";
import NotaGraduada from "./NotaGraduada";
import { abrirFichaEntrenador } from "../social/fichaEntrenadorGlobal";
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
  /**
   * Sobres que le faltan por abrir para poder comprar (SOBRES_PARA_COMPRAR en
   * utils/bazar.ts). 0 o sin pasar = no le falta ninguno, o no se sabe.
   *
   * Con algo aquí el botón lo DICE en vez de decir «Comprar»: antes había que
   * tocar, leer la hoja de «Pagar 120», confirmar y esperar la respuesta del
   * servidor para enterarse. No se desactiva, por lo mismo que no se desactiva
   * por saldo (ver más abajo): el número viene de una lectura anterior y quien
   * decide es el servidor. Quien recibe el toque (app/bazar/page.tsx) explica
   * la norma y relee el dato en vez de abrir la hoja de pago.
   */
  faltanSobres?: number;
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
  faltanSobres = 0,
  enCurso,
  bloqueada,
  onComprar,
  onRetirar,
}: TarjetaAnuncioProps) {
  const cobraElVendedor = anuncio.precio - anuncio.comision;
  const faltan = anuncio.precio - saldo;
  /** La barrera de los sobres va antes que la del saldo: sin cruzarla, lo que
   *  tenga en el monedero da igual. */
  const novato = puedeComprar && !anuncio.esMio && faltanSobres > 0;
  // El aviso de saldo sólo tiene sentido con sesión: el saldo del invitado vive
  // en su navegador y no es el que se va a cobrar.
  const sinSaldo = puedeComprar && !anuncio.esMio && !novato && faltan > 0;
  /** Con sesión y en un anuncio ajeno, el vendedor es un botón: ver más abajo. */
  const verVendedor = puedeComprar && !anuncio.esMio;

  return (
    <article className="surface group flex flex-col gap-2 rounded-2xl p-2.5">
      <div className="relative">
        {anuncio.nota !== null && (
          <div className="absolute top-1.5 left-1.5 z-20">
            {/* En un anuncio propio la chapa comparte borde con «Tuyo», y a
                320 px de pantalla se pisaban 11 px: ahí pierde la palabra y se
                queda en la cifra. Los ajenos tienen el borde para ellos solos. */}
            <NotaGraduada
              nota={anuncio.nota}
              conRotulo={anuncio.esMio ? "ancho" : "siempre"}
            />
          </div>
        )}
        {anuncio.esMio && (
          <div
            className="absolute top-1.5 right-1.5 z-20 rounded-full px-2 py-1 t-micro leading-none font-bold"
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
        <div className="pointer-events-none transition-transform duration-[var(--d-base)] group-hover:-translate-y-1">
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
        {/* t-cuerpo y no t-cuerpo-2: el nombre es el título de la tarjeta, no
            un apoyo, y a 12px quedaría al mismo peso que el rótulo del botón. */}
        <p className="ink truncate t-cuerpo leading-tight font-semibold">
          {anuncio.name}
        </p>
        {/* ink-soft: por debajo de 12px, ink-faint no llega al mínimo de
            contraste (regla de la casa en app/globals.css). */}
        <p className="ink-soft mt-0.5 truncate t-micro">
          {anuncio.rarity}
          {!verVendedor && (
            <>
              {" · "}
              {anuncio.esMio ? "publicado por ti" : `de ${anuncio.vendedor}`}
            </>
          )}
        </p>
        {/* EL VENDEDOR ES LA PUERTA A SU FICHA. Era texto suelto: quien quería
            añadir a «Marta» para proponerle un trueque tenía que ir a Social y
            buscarla por nombre, esperando que no hubiera dos. Ahora abre la
            ficha común (components/social/FichaEntrenadorSheet), que el
            servidor resuelve a partir del ID DEL ANUNCIO: esta tarjeta no
            recibe ni el id ni el código del vendedor, porque el escaparate se
            sirve también sin sesión.
            EN SU PROPIA LÍNEA, y no al final de la de la rareza: esa línea
            trunca, y con una rareza larga («Special Illustration Rare») el
            botón quedaba detrás de los puntos suspensivos, inalcanzable.
            Los 44 px de dedo salen de relleno y margen negativos (el truco de
            components/ui/CampoBusqueda): la zona crece hacia el nombre y el
            precio, que no se tocan, y la tarjeta no gana alto. */}
        {verVendedor && (
          <button
            type="button"
            onClick={() => abrirFichaEntrenador({ anuncioId: anuncio.id })}
            aria-label={`Ver al vendedor: ${anuncio.vendedor}`}
            className="ink-soft press-flat -mx-1 -my-4 flex min-w-11 max-w-[calc(100%+0.5rem)] items-center px-1 py-4 text-left t-micro"
          >
            <span className="shrink-0">de&nbsp;</span>
            <span className="truncate underline underline-offset-2">{anuncio.vendedor}</span>
          </button>
        )}
      </div>

      <div className="mt-auto flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="tnum ink t-base leading-none font-bold">
            {formatNumber(anuncio.precio)}
          </span>
          <span className="ink-soft t-micro">monedas</span>
        </div>

        {/* En los anuncios propios la cifra que importa NO es el precio, es lo
            que se cobra: el vendedor recibe el precio menos la comisión y esa
            resta es la sorpresa número dos del bazar. Se dice aquí también, no
            sólo al publicar, porque el anuncio se mira muchas veces después. */}
        {anuncio.esMio ? (
          <>
            <p className="ink-soft t-meta leading-snug">
              Cobrarás{" "}
              <span className="tnum font-semibold" style={{ color: "var(--ok)" }}>
                {formatNumber(cobraElVendedor)}
              </span>{" "}
              {/* ink-soft, no ink-faint: esta línea mide 11px. */}
              <span className="ink-soft">
                (−{formatNumber(anuncio.comision)} de comisión)
              </span>
            </p>
            <button
              type="button"
              onClick={onRetirar}
              disabled={enCurso || bloqueada}
              aria-busy={enCurso}
              className="btn-ghost press control-44 ink-soft w-full rounded-xl t-cuerpo-2 font-medium disabled:cursor-not-allowed disabled:opacity-40"
            >
              {enCurso ? "Retirando…" : "Retirar"}
            </button>
          </>
        ) : (
          <>
            {sinSaldo && (
              <p
                className="t-meta leading-snug font-medium"
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
              // El rótulo corto cabe en la celda de dos columnas a 320 px; el
              // lector de pantalla oye la frase entera.
              aria-label={
                novato
                  ? `Te faltan ${faltanSobres} ${faltanSobres === 1 ? "sobre" : "sobres"} por abrir para poder comprar ${anuncio.name}`
                  : undefined
              }
              className={`press control-44 w-full rounded-xl px-1 t-cuerpo-2 leading-tight font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
                sinSaldo || novato ? "btn-ghost ink-soft" : "btn-accent"
              }`}
            >
              {enCurso
                ? "Comprando…"
                : !puedeComprar
                  ? "Inicia sesión"
                  : novato
                    ? `Faltan ${faltanSobres} ${faltanSobres === 1 ? "sobre" : "sobres"}`
                    : "Comprar"}
            </button>
          </>
        )}
      </div>
    </article>
  );
}
