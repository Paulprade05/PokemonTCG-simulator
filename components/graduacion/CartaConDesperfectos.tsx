"use client";

// components/graduacion/CartaConDesperfectos.tsx
//
// Una carta con el estado real de SU copia pintado encima: piques, arañazos,
// manchas, decoloración y el descentrado. Lo usan la ceremonia de revelado y la
// vitrina, que necesitan exactamente lo mismo a dos tamaños distintos.
//
// ============================================================================
// POR QUÉ HAY DOS ENVOLTORIOS Y NO UNO
// ============================================================================
//
// El descentrado de una carta mal cortada no se pinta: se MUEVE la ilustración
// dentro de su marco y se deja que el marco recorte. Como PokemonCard no admite
// hijos y no se puede tocar (es el camino rápido de todas las rejillas del
// proyecto), la única forma de conseguirlo desde fuera es:
//
//   marco   -> `relative` + `overflow-hidden` + el color del cartón de fondo
//     └ tira -> el `transform: translate(...)` que devuelve estiloDescentrado()
//         └ PokemonCard
//     └ DesperfectosCarta  (absolute inset-0 z-30, se coloca él solo)
//
// El marco es además el `relative` + `overflow-hidden` que DesperfectosCarta
// exige a su contenedor, así que sirve para las dos cosas.
//
// EL `transform` DE LA TIRA ES UN `translate` Y NUNCA UN `scale`. No es una
// preferencia de estilo: WebKit rasteriza a escala fija la capa de todo lo que
// lleve `scale`, `filter`, `drop-shadow`, `backdrop-filter` o `mix-blend-mode`,
// y la ilustración sale BORROSA en un iPhone aunque la fuente sea la de alta
// resolución. Está medido en components/PokemonCard.tsx (140-163 y 255-266) y es
// la razón de que DesperfectosCarta pinte los arañazos con degradados en vez de
// con un filtro. Aquí vale lo mismo: este componente es ancestro de la carta.

import { useMemo } from "react";
import { motion } from "framer-motion";
import PokemonCard from "../PokemonCard";
import DesperfectosCarta, { estiloDescentrado } from "../DesperfectosCarta";
import type { Desperfectos, MarcasDeCarta } from "../../utils/graduacion";

interface Props {
  /** Lo que necesita PokemonCard para pintar: id, name, rarity, images. */
  carta: { id: string; name: string; rarity: string; images: { small: string; large: string } };
  /** Identidad de la copia. De aquí salen los desperfectos, deterministas. */
  /** Estado de la copia, calculado en el servidor (ver DesperfectosCarta). */
  desperfectos: Desperfectos;
  marcas: MarcasDeCarta;
  nota: number;
  /**
   * Con `false` se ve la carta LIMPIA, sin marcas y sin descentrar. Es el
   * "antes" del antes y después: la misma copia como la recordaba el jugador,
   * y la misma copia como la vio el graduador.
   */
  mostrarMarcas?: boolean;
  /** La ilustración grande sólo donde la carta manda en la pantalla. */
  altaResolucion?: boolean;
}

export default function CartaConDesperfectos({
  carta,
  desperfectos,
  marcas,
  nota,
  mostrarMarcas = true,
  altaResolucion = false,
}: Props) {
  // Determinista y no del todo barato (dos generadores y un bucle por marca):
  // la vitrina puede pintar cientos de copias, así que se memoiza por copia.
  // DesperfectosCarta memoiza por su cuenta lo suyo; esto es sólo el
  // desplazamiento del marco, que él no aplica a propósito.
  const desplazamiento = useMemo(
    () => estiloDescentrado(desperfectos),
    [desperfectos],
  );

  return (
    <div
      className="relative w-full overflow-hidden rounded-[4.5%]"
      // El fondo es el que asoma por el lado del que se retira la ilustración:
      // el borde de cartón de una carta cortada de través.
      style={{ background: "var(--surface-2)" }}
    >
      <div style={mostrarMarcas ? desplazamiento : undefined}>
        <PokemonCard card={carta} reveal interactive={false} useHighRes={altaResolucion} />
      </div>

      {/* La capa de marcas ENTRA con una transición de opacidad y nada más. Es
          hermana de la carta, no ancestro suyo, así que una opacidad intermedia
          compone esta capa sola y no toca la ilustración.
          Al revés no hay transición y es deliberado: `oculto` desmonta las
          marcas en el mismo frame, así que el botón de "ver sin marcas" enseña
          la carta limpia AL INSTANTE —que es justo lo que se le está pidiendo—
          y de paso la vitrina no deja montados los divs de veintitantos piques
          por copia de las que están en modo limpio. */}
      <motion.div
        className="pointer-events-none absolute inset-0 z-30"
        initial={false}
        animate={{ opacity: mostrarMarcas ? 1 : 0 }}
        transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
        aria-hidden="true"
      >
        <DesperfectosCarta desperfectos={desperfectos} marcas={marcas} oculto={!mostrarMarcas} />
      </motion.div>
    </div>
  );
}
