"use client";

// components/DesperfectosCarta.tsx
//
// Pinta el estado de conservación de una copia ENCIMA de la ilustración:
// piques en los cantos, arañazos, manchas, decoloración y descentrado.
//
// ============================================================================
// LA RESTRICCIÓN QUE MANDA SOBRE TODO LO DEMÁS
// ============================================================================
//
// PROHIBIDO `filter`, `drop-shadow`, `backdrop-filter` y `mix-blend-mode` sobre
// la carta o cualquiera de sus ancestros. No es una preferencia: WebKit
// promociona a capa compositada todo lo que lleve uno de esos, y esa capa se
// rasteriza a una escala fija — la ilustración se ve BORROSA en un iPhone
// aunque la fuente sea la de alta resolución. Está medido y documentado en
// components/PokemonCard.tsx (140-163 y 255-266), en la cabecera de
// components/MazoCartas.tsx y en components/BoosterPack.tsx.
//
// Lo natural para "una carta descolorida por el sol" sería
// `filter: sepia(.3) saturate(.6)`. Aquí no se puede. Todo lo de abajo está
// hecho SÓLO con `background`, `box-shadow` y `opacity`, que es lo que el
// repositorio permite:
//
//   - la decoloración es una capa de color cálido a baja opacidad, que lava la
//     ilustración por encima en vez de desaturarla;
//   - los piques son cuadraditos de color de cartón pegados al canto;
//   - los arañazos son tiras finísimas con un degradado longitudinal, giradas;
//   - las manchas son degradados radiales.
//
// El único `transform` que se usa es `rotate` en los arañazos. NUNCA `scale`,
// que es el que dispara la rasterización.
//
// ============================================================================
// EL DESCENTRADO NO SE PINTA AQUÍ
// ============================================================================
//
// Una carta mal centrada tiene el marco más ancho por un lado que por el otro,
// y eso hay que hacerlo moviendo la ILUSTRACIÓN dentro de su marco, no pintando
// nada encima. Como este componente es una capa superpuesta y no envuelve a la
// imagen, el desplazamiento lo aplica quien monta la carta usando
// `estiloDescentrado()`, que se exporta aquí abajo para que la cuenta viva en
// un solo sitio.

import type { Desperfectos, MarcasDeCarta } from "../utils/graduacion";

interface Props {
  /**
   * El estado de la copia, YA CALCULADO POR EL SERVIDOR.
   *
   * NO se deriva aquí de una semilla, y no es un capricho: la semilla lleva
   * dentro el secreto de las notas (ver utils/graduacion.ts). Si bajara al
   * navegador, cualquiera podría calcular la nota de sus copias SIN GRADUAR y
   * mandar sólo los dieces, que multiplican por tres. Graduar pasaría de perder
   * dinero de media a ser beneficio garantizado.
   *
   * Por eso el servidor manda el resultado y no la receta. Cuesta un puñado de
   * bytes por carta y cierra el agujero entero.
   */
  desperfectos: Desperfectos;
  /** Dónde va cada marca. También calculado en el servidor, y por lo mismo. */
  marcas: MarcasDeCarta;
  /**
   * Apagar los desperfectos sin desmontar el componente. Lo usa la pantalla de
   * graduación para el "antes y después": la misma carta, con y sin marcas.
   */
  oculto?: boolean;
}

/**
 * Desplazamiento de la ilustración dentro de su marco, en CSS.
 *
 * Se devuelve como estilo y no como clase porque el valor es continuo. Va sobre
 * el contenedor de la imagen, que ya tiene `overflow: hidden`, así que lo que
 * se sale se recorta y por el lado contrario asoma el fondo del marco: es
 * exactamente lo que se ve en una carta mal cortada.
 */
export function estiloDescentrado(d: Desperfectos): React.CSSProperties {
  if (!d.descentrado.x && !d.descentrado.y) return {};
  return {
    // translate y NO scale: scale rasteriza la capa (ver cabecera).
    transform: `translate(${d.descentrado.x}%, ${d.descentrado.y}%)`,
  };
}

export default function DesperfectosCarta({ desperfectos, marcas, oculto = false }: Props) {
  if (oculto) return null;

  const { palidez } = desperfectos;
  const hayAlgo =
    marcas.piques.length > 0 ||
    marcas.aranazos.length > 0 ||
    marcas.manchas.length > 0 ||
    palidez > 0;
  if (!hayAlgo) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-30 overflow-hidden rounded-[4.5%]"
    >
      {/* DECOLORACIÓN POR SOL.
          Dos capas superpuestas en vez de un `filter`: una crema que lava los
          oscuros y un velo blanco que baja el contraste general. Juntas dan la
          sensación de carta que ha estado años en una ventana. */}
      {palidez > 0 && (
        <>
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(160deg, rgba(255,236,200,1) 0%, rgba(246,224,188,1) 55%, rgba(255,246,225,1) 100%)",
              opacity: 0.42 * palidez,
            }}
          />
          <div
            className="absolute inset-0"
            style={{ background: "#ffffff", opacity: 0.2 * palidez }}
          />
        </>
      )}

      {/* MANCHAS. Degradados radiales de un marrón muy diluido: marcas de dedo,
          humedad, roce. Se difuminan hacia fuera para que no parezcan pegatinas. */}
      {marcas.manchas.map((m, i) => (
        <div
          key={`m${i}`}
          className="absolute rounded-full"
          style={{
            left: `${m.x}%`,
            top: `${m.y}%`,
            width: `${m.tam}%`,
            height: `${m.tam * 1.25}%`,
            marginLeft: `-${m.tam / 2}%`,
            marginTop: `-${(m.tam * 1.25) / 2}%`,
            background:
              "radial-gradient(ellipse at 40% 35%, rgba(120,86,48,0.85) 0%, rgba(120,86,48,0.45) 45%, rgba(120,86,48,0) 72%)",
            opacity: m.fuerza,
          }}
        />
      ))}

      {/* ARAÑAZOS. Tiras de menos de un píxel de alto con un degradado que se
          apaga en los dos extremos, para que parezcan surcos y no rayas
          dibujadas. El giro es `rotate`, nunca `scale`. */}
      {marcas.aranazos.map((a, i) => (
        <div
          key={`a${i}`}
          className="absolute"
          style={{
            left: `${a.x}%`,
            top: `${a.y}%`,
            width: `${a.tam}%`,
            height: "1px",
            transform: `translate(-50%, -50%) rotate(${a.giro}deg)`,
            background:
              "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.95) 22%, rgba(255,255,255,0.75) 55%, rgba(255,255,255,0) 100%)",
            opacity: a.fuerza,
            // El realce oscuro por debajo es lo que da el relieve de surco.
            boxShadow: "0 1px 0 rgba(0,0,0,0.28)",
          }}
        />
      ))}

      {/* PIQUES.
          Son la marca que más pesa en una nota real: el cartón blanco que asoma
          donde la tinta del canto se ha descascarado. Van pegados al borde por
          construcción (marcasDeCopia los coloca ahí) y llevan un punto de
          sombra interior para que se lean como una mordida y no como un punto
          de pintura blanca. */}
      {marcas.piques.map((p, i) => (
        <div
          key={`p${i}`}
          className="absolute"
          style={{
            left: `${p.x}%`,
            top: `${p.y}%`,
            width: `${p.tam}%`,
            height: `${p.tam * 0.8}%`,
            marginLeft: `-${p.tam / 2}%`,
            marginTop: `-${(p.tam * 0.8) / 2}%`,
            borderRadius: "35%",
            background: "#f4f1e8",
            opacity: p.fuerza,
            boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.22)",
          }}
        />
      ))}
    </div>
  );
}
