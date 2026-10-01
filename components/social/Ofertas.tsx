"use client";

import { useState } from "react";
import CabeceraDeHoja from "../ui/CabeceraDeHoja";
import Sheet from "../ui/Sheet";
import { formatNumber } from "../../utils/format";

/**
 * LAS CARTAS DE UNA OFERTA DE INTERCAMBIO: EL RESUMEN Y EL DETALLE.
 *
 * Una oferta puede llevar 12 cartas por lado. La tarjeta las pintaba TODAS, en
 * miniaturas de 48 px con salto de línea: a 320 px cabía una por fila en cada
 * lado, o sea doce filas, y la oferta medía casi 900 px con «Aceptar» y
 * «Rechazar» dos pantallas más abajo. Y como las miniaturas no reservaban su
 * alto, cada imagen que terminaba de cargar empujaba esos dos botones bajo el
 * dedo: un toque en «Aceptar» mueve cartas sin vuelta atrás.
 *
 * AHORA SON DOS PIEZAS:
 *
 *  · EL RESUMEN (`ResumenDeOferta`): una fila de tres huecos por lado, y si
 *    hay más de tres cartas el tercero es un «+N». Mide SIEMPRE lo mismo, con
 *    las imágenes cargadas o sin cargar, porque cada hueco lleva la proporción
 *    de una carta. Es un botón: tocarlo abre el detalle.
 *  · EL DETALLE (`DetalleDeOfertaSheet`): una hoja con los dos lados enteros y
 *    el nombre de cada carta, que en una miniatura de 30 px no se lee.
 *
 * Las miniaturas son `<img>` a secas, no PokemonCard: aquí la carta es un
 * recordatorio de qué se cambia, no algo que se inspecciona, y el componente
 * de carta trae brillos y perspectiva que no pintan nada a este tamaño.
 */

/** Lo que llega de `getIncomingTradeOffers` / `getOutgoingTradeOffers`. */
export interface CartaDeOferta {
  id?: string;
  name?: string;
  images?: { small?: string };
}

/** Los dos lados, ya con el rótulo que les toca según quién mira. */
export interface LadosDeOferta {
  /** Quién es el otro: titula el detalle. */
  titulo: string;
  /** El lado que GANA quien mira (o lo que ofrece, si la oferta es suya). */
  primero: { rotulo: string; cartas: CartaDeOferta[] };
  segundo: { rotulo: string; cartas: CartaDeOferta[] };
}

/* LAS DOS TINTAS DE UN INTERCAMBIO son las de components/social/TradeBuilder:
   --ok para lo que entra y --warn-ink para lo que sale. Aquí se pinta ese
   mismo intercambio una vez enviado, y los dos lados tienen que llegar del
   mismo color en las dos pantallas. (El verde y el cian de marca, como TINTA,
   dan 2,4:1 y 2,1:1 sobre el papel del tema claro.) */
const TINTA_PRIMERO = "[color:var(--ok)]";
const TINTA_SEGUNDO = "[color:var(--warn-ink)]";

/** Huecos por lado en el resumen. Con más cartas, el último es el «+N». */
const HUECOS = 3;

/**
 * Un hueco con la proporción de una carta (245×342). El fondo se ve mientras
 * la imagen llega —o si no llega—, así que el resumen no cambia de alto.
 */
function Miniatura({ carta }: { carta: CartaDeOferta }) {
  return (
    <div className="aspect-[245/342] overflow-hidden rounded-md bg-[color-mix(in_srgb,var(--ink)_8%,transparent)]">
      {carta?.images?.small && (
        // <img> y no next/image, como todas las cartas de la app: vienen de un
        // CDN ajeno y las guarda el service worker tal cual llegan.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={carta.images.small}
          alt={carta.name ?? ""}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      )}
    </div>
  );
}

function LadoResumido({ rotulo, cartas, tinta }: { rotulo: string; cartas: CartaDeOferta[]; tinta: string }) {
  const visibles = cartas.length > HUECOS ? cartas.slice(0, HUECOS - 1) : cartas;
  const resto = cartas.length - visibles.length;
  return (
    <div className="min-w-0 flex-1">
      <p className={`t-etiqueta mb-1.5 truncate ${tinta}`}>{rotulo}</p>
      {/* Ancho máximo: en escritorio la tarjeta es ancha y tres columnas sin
          tope darían miniaturas de 150 px. */}
      <div className="grid max-w-[10.5rem] grid-cols-3 gap-1.5">
        {visibles.map((c, i) => (
          <Miniatura key={i} carta={c} />
        ))}
        {resto > 0 && (
          <div className="surface ink-soft t-cuerpo-2 tnum flex aspect-[245/342] items-center justify-center rounded-md font-semibold">
            +{resto}
          </div>
        )}
      </div>
    </div>
  );
}

interface ResumenDeOfertaProps {
  lados: LadosDeOferta;
  /** El dibujo entre los dos lados: una flecha (enviada) o dos (recibida). */
  sentido: "cruce" | "ida";
  onAbrir: () => void;
}

export function ResumenDeOferta({ lados, sentido, onAbrir }: ResumenDeOfertaProps) {
  const total = lados.primero.cartas.length + lados.segundo.cartas.length;
  return (
    <button
      type="button"
      onClick={onAbrir}
      aria-label={`Ver las ${total} cartas de la oferta: ${lados.titulo}`}
      // press-flat y no press: hay ilustraciones de cartas dentro y `press`
      // escala (la trampa de nitidez documentada en PokemonCard.tsx).
      className="surface-2 press-flat mb-3 block w-full rounded-xl p-3 text-left"
    >
      <span className="flex items-center gap-3">
        <LadoResumido rotulo={lados.primero.rotulo} cartas={lados.primero.cartas} tinta={TINTA_PRIMERO} />
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="ink-faint h-5 w-5 shrink-0"
          aria-hidden="true"
        >
          {sentido === "cruce" ? (
            <path d="M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4" />
          ) : (
            <path d="M5 12h14M13 6l6 6-6 6" />
          )}
        </svg>
        <LadoResumido rotulo={lados.segundo.rotulo} cartas={lados.segundo.cartas} tinta={TINTA_SEGUNDO} />
      </span>
      <span className="ink-soft t-meta mt-2.5 block text-center underline underline-offset-2">
        Ver las {formatNumber(total)} cartas
      </span>
    </button>
  );
}

function LadoEntero({ rotulo, cartas, tinta }: { rotulo: string; cartas: CartaDeOferta[]; tinta: string }) {
  return (
    <section>
      <p className={`t-etiqueta mb-2 ${tinta}`}>
        {rotulo} · {formatNumber(cartas.length)}
      </p>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
        {cartas.map((c, i) => (
          <div key={i} className="min-w-0">
            <Miniatura carta={c} />
            <p className="ink-soft t-micro mt-1 truncate text-center">{c?.name ?? "Carta"}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * La oferta entera. `lados` a `null` es la hoja cerrada; el último valor se
 * conserva para que la hoja no baje vacía mientras se cierra.
 */
export function DetalleDeOfertaSheet({ lados, onClose }: { lados: LadosDeOferta | null; onClose: () => void }) {
  const [ultimos, setUltimos] = useState<LadosDeOferta | null>(lados);
  if (lados && lados !== ultimos) setUltimos(lados);

  return (
    <Sheet open={lados !== null} onClose={onClose} label={ultimos?.titulo ?? "Oferta de intercambio"}>
      <div className="px-5 pt-3 pb-6">
        <CabeceraDeHoja titulo="Oferta de intercambio" descripcion={ultimos?.titulo} />
        {ultimos && (
          <div className="mt-5 flex flex-col gap-5">
            <LadoEntero rotulo={ultimos.primero.rotulo} cartas={ultimos.primero.cartas} tinta={TINTA_PRIMERO} />
            <LadoEntero rotulo={ultimos.segundo.rotulo} cartas={ultimos.segundo.cartas} tinta={TINTA_SEGUNDO} />
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          className="btn-ghost press mt-6 w-full rounded-2xl py-3.5 t-cuerpo font-medium"
        >
          Cerrar
        </button>
      </div>
    </Sheet>
  );
}
