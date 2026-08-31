"use client";

import PokemonCard from "../PokemonCard";
import type { CartaEnColeccion } from "../../utils/tipos";

/**
 * UNA FUNDA del archivador: el bolsillo de plástico con (o sin) su carta.
 *
 * ES LA PIEZA QUE MÁS FÁCIL SE ROMPE, así que conviene decir de entrada qué NO
 * puede llevar. La carta se pinta con PokemonCard en su camino rápido
 * (`interactive={false}` + `reveal`), que existe justamente para que una
 * rejilla no cree una capa compositada por carta. Ese camino se anula si
 * ALGÚN ancestro promociona la capa, y aquí hay tres ancestros muy cerca (la
 * funda, la hoja y la ventana del pase de página). Por eso en todo este árbol
 * no hay `filter`, ni `drop-shadow`, ni `backdrop-filter`, ni `mix-blend-mode`,
 * ni `perspective`, ni `preserve-3d`, ni un solo `transform` con `scale`:
 * WebKit rasteriza esa capa a una escala fija y la ilustración sale borrosa en
 * iPhone (está documentado en components/PokemonCard.tsx:140-163 y en la
 * cabecera de components/MazoCartas.tsx).
 *
 * De ahí dos decisiones que parecen caprichos y no lo son:
 *  · El brillo del plástico es un `linear-gradient` con alfa, NO un
 *    `mix-blend-mode: overlay` —que es como se hace normalmente un reflejo—.
 *    Se pierde algo de riqueza y se gana que la carta se dibuje a resolución
 *    nativa.
 *  · El realce al pasar el ratón es `translate`, no `scale`. La rejilla de la
 *    colección hace exactamente lo mismo y por el mismo motivo; la clase
 *    `press` del tema, que sí escala, queda descartada para cualquier cosa que
 *    envuelva una carta.
 */

interface FundaCartaProps {
  /** `null` es un hueco: en un archivador de verdad la funda vacía se ve. */
  carta: CartaEnColeccion | null;
  onAbrir?: (carta: CartaEnColeccion) => void;
  /** Posición 1..9 dentro de la hoja. Sólo para el rótulo del lector. */
  posicion: number;
}

/* El bolsillo: papel de la hoja visto a través del plástico. El `inset` de
 * arriba es el canto iluminado del plástico y el de abajo la sombra que
 * proyecta la carta dentro de la funda; los dos con box-shadow, que pinta sin
 * rasterizar el contenido. */
const FUNDA: React.CSSProperties = {
  background:
    "linear-gradient(158deg, color-mix(in srgb, var(--ink) 5%, transparent) 0%, transparent 38%), var(--surface-2)",
  border: "1px solid var(--border)",
  boxShadow:
    "inset 0 1px 0 color-mix(in srgb, #fff 20%, transparent), inset 0 -7px 12px -9px rgba(0,0,0,0.45)",
};

/* Reflejo del plástico. Sólo cubre la esquina superior izquierda (se apaga al
 * 34% del recorrido) para no lavar la ilustración: un velo blanco sobre toda
 * la carta se nota mucho más de lo que aporta, sobre todo en tema claro. */
const BRILLO: React.CSSProperties = {
  background:
    "linear-gradient(118deg, rgba(255,255,255,0.20) 0%, rgba(255,255,255,0.07) 17%, rgba(255,255,255,0) 34%)",
};

export default function FundaCarta({ carta, onAbrir, posicion }: FundaCartaProps) {
  if (!carta) {
    return (
      /**
       * Hueco. `aria-hidden` porque para un lector de pantalla no hay nada que
       * anunciar: la hoja ya declara cuántas cartas lleva, y nueve "funda
       * vacía" seguidos son ruido. El interior mantiene el mismo
       * `aspect-[2.5/3.5]` que tendría la carta para que una fila entera de
       * huecos (la última página casi siempre lo es) mida exactamente igual
       * que una fila llena y la hoja no cambie de alto al pasar de página.
       */
      <div aria-hidden="true" className="rounded-[6%] p-[4%]" style={FUNDA}>
        <div
          className="w-full aspect-[2.5/3.5] rounded-[4.5%]"
          style={{
            border: "1px dashed var(--border-strong)",
            background:
              "linear-gradient(150deg, color-mix(in srgb, var(--ink) 3%, transparent), transparent 60%)",
          }}
        />
      </div>
    );
  }

  const copias = carta.quantity ?? 1;

  return (
    /* `group/funda` con nombre y no `group` a secas: la hoja y la vitrina
       también son contenedores, y un grupo anónimo dentro de otro engancha el
       hover al ancestro equivocado. */
    <div className="group/funda relative rounded-[6%] p-[4%]" style={FUNDA}>
      <button
        type="button"
        onClick={() => onAbrir?.(carta)}
        /* El rótulo dice las copias porque la insignia que las pinta es
         * decorativa: quien navega con lector no ve el "×3" de la esquina. */
        aria-label={
          copias > 1
            ? `Ver ${carta.name}, ${copias} copias, funda ${posicion} de 9`
            : `Ver ${carta.name}, funda ${posicion} de 9`
        }
        className="block w-full cursor-zoom-in rounded-[4.5%] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
      >
        {/* El realce va en un div interior y no en el <button> para que el
            transform no arrastre el anillo de foco fuera de sitio. Sólo
            translate: ver la cabecera. */}
        <div className="transition-transform duration-300 md:group-hover/funda:-translate-y-1 pointer-events-none">
          <PokemonCard card={carta} reveal={true} interactive={false} />
        </div>
      </button>

      {/* Reflejo del plástico. Va POR ENCIMA de la carta (si no, no es un
          reflejo) y por debajo de las insignias, y con pointer-events-none
          para no tragarse el toque que abre el detalle. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-10 rounded-[6%]"
        style={BRILLO}
      />

      {/* FAVORITA — arriba a la izquierda, que es la zona muerta del arte de
          casi toda carta (el nombre va arriba a la derecha o centrado). */}
      {carta.is_favorite && (
        <div
          aria-hidden="true"
          className="absolute left-[7%] top-[5%] z-20 flex h-5 w-5 items-center justify-center rounded-full bg-rose-500"
          style={{ boxShadow: "var(--shadow-sm)" }}
        >
          <svg viewBox="0 0 24 24" fill="white" className="h-3 w-3">
            <path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 5.5 5.5 5.5 0 0 1 21.5 12c-2.5 4.5-9.5 9-9.5 9z" />
          </svg>
        </div>
      )}

      {/* COPIAS — abajo a la derecha, encima del número impreso, que es la
          esquina de la carta con menos ilustración que tapar. Sólo si hay
          repetidas: un "×1" en las 258 fundas sería ruido puro. */}
      {copias > 1 && (
        <div
          aria-hidden="true"
          className="tnum absolute bottom-[5%] right-[6%] z-20 rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none"
          style={{
            background: "var(--ink)",
            color: "var(--bg)",
            border: "1px solid var(--border-strong)",
            boxShadow: "var(--shadow-sm)",
          }}
        >
          ×{copias}
        </div>
      )}
    </div>
  );
}
