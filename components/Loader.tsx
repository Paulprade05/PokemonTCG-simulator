"use client";

import { usePathname } from "next/navigation";

/**
 * ESTADO DE CARGA DE LAS RUTAS.
 *
 * Antes era un círculo girando en mitad de la pantalla. Un círculo no dice
 * nada: mide el tiempo, no lo llena. Un esqueleto con la FORMA de lo que va a
 * llegar se percibe más rápido aunque la espera dure exactamente lo mismo, por
 * dos motivos medidos de sobra en móvil: el ojo ya sabe dónde va a caer cada
 * cosa, y cuando llegan los datos la pantalla no se reordena de golpe (el
 * spinner desaparece y todo aparece a la vez; el esqueleto simplemente se
 * rellena).
 *
 * LA FORMA SE DEDUCE DE LA RUTA, no de una prop. Las páginas que llaman aquí
 * son de otras piezas del proyecto y no se pueden tocar: todas hacen
 * `if (loading) return <Loader label="…" />`. Sacando la forma del pathname, el
 * esqueleto llega a las nueve pantallas sin cambiar ni una línea fuera de este
 * fichero. Una ruta desconocida cae al círculo de siempre, que sigue siendo la
 * respuesta correcta cuando no se sabe qué va a aparecer.
 *
 * El `label` no se pierde: deja de pintarse pero se sigue anunciando al lector
 * de pantalla, que es quien lo necesita. Para quien ve la pantalla, la forma ya
 * es el mensaje.
 */

type Forma = "cartas" | "fichas" | "personas" | "circulo";

/** Cada prefijo de ruta con la forma que tiene su contenido de verdad. */
const FORMAS: { prefijo: string; forma: Forma }[] = [
  { prefijo: "/collection", forma: "cartas" },
  { prefijo: "/album", forma: "cartas" },
  { prefijo: "/vitrina", forma: "cartas" },
  { prefijo: "/graduacion", forma: "cartas" },
  { prefijo: "/bazar", forma: "cartas" },
  { prefijo: "/mercado", forma: "fichas" },
  { prefijo: "/friends", forma: "personas" },
  { prefijo: "/trainer", forma: "personas" },
];

function formaDe(ruta: string): Forma {
  return FORMAS.find((f) => ruta.startsWith(f.prefijo))?.forma ?? "circulo";
}

/* Los tamaños de los huecos van en listas fijas y no en Math.random(): el
   servidor y el navegador tienen que pintar exactamente lo mismo o React
   aborta la hidratación. Variar los anchos evita que el bloque parezca una
   tabla, que es lo que delata a un esqueleto. */
const ANCHOS_NOMBRE = ["72%", "58%", "80%", "64%", "76%", "52%"];

/** Cabecera de página: el hueco del título y el del subtítulo de PageHeader. */
function CabeceraFalsa() {
  return (
    <div className="mb-6 md:mb-8">
      <div className="skeleton h-7 w-44 md:h-8 md:w-56" />
      <div className="skeleton mt-2 h-3 w-28" />
    </div>
  );
}

export default function Loader({ label = "Cargando" }: { label?: string }) {
  const pathname = usePathname();
  const forma = formaDe(pathname);

  // El aviso para el lector de pantalla es común a las cuatro formas: se anuncia
  // el texto que pasa la página ("Abriendo el bazar") y el dibujo se marca como
  // decorativo para que no se lea una ristra de huecos vacíos.
  const anuncio = (
    <span role="status" aria-live="polite" className="sr-only">
      {label}
    </span>
  );

  if (forma === "circulo") {
    return (
      <div
        className="flex flex-col items-center justify-center ink"
        // El alto mínimo descuenta el cromo (TopBar, inset superior, hueco de la
        // barra de pestañas y el pt-6 del main): con un alto de viewport
        // completo la página ganaría scroll fantasma y el círculo quedaría por
        // debajo del centro.
        style={{
          minHeight:
            "calc(var(--app-height) - var(--topbar-h) - var(--sat) - var(--content-bottom) - 1.5rem)",
        }}
      >
        {anuncio}
        <div
          aria-hidden="true"
          className="w-10 h-10 border-2 border-[var(--border)] border-t-[var(--accent)] rounded-full animate-spin mb-6"
        />
        <p className="text-xs font-medium ink-soft uppercase tracking-[0.3em]">{label}</p>
      </div>
    );
  }

  return (
    <div>
      {anuncio}
      <div aria-hidden="true">
        <CabeceraFalsa />

        {forma === "cartas" && (
          <>
            {/* La fila de filtros/chips que llevan encima la colección, el álbum
                y el bazar: sin ella la rejilla saltaría hacia arriba al cargar. */}
            <div className="mb-4 flex gap-2">
              <div className="skeleton h-9 flex-1 rounded-xl" />
              <div className="skeleton h-9 w-24 rounded-xl" />
            </div>
            {/* Mismas columnas y mismo hueco que la rejilla real de la colección
                y del álbum, y la proporción de una carta (63×88mm). */}
            <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:gap-4 lg:grid-cols-6">
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="skeleton aspect-[5/7] rounded-xl" />
              ))}
            </div>
          </>
        )}

        {forma === "fichas" && (
          <div className="grid gap-4 md:grid-cols-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="surface rounded-2xl p-4">
                <div className="flex items-center gap-3">
                  <div className="skeleton h-14 w-10 shrink-0 rounded-lg" />
                  <div className="min-w-0 flex-1">
                    <div className="skeleton h-4" style={{ width: ANCHOS_NOMBRE[i] }} />
                    <div className="skeleton mt-2 h-3 w-20" />
                  </div>
                  <div className="skeleton h-9 w-20 shrink-0 rounded-xl" />
                </div>
              </div>
            ))}
          </div>
        )}

        {forma === "personas" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="surface flex items-center gap-3 rounded-2xl p-3.5">
                <div className="skeleton h-11 w-11 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1">
                  <div className="skeleton h-3.5" style={{ width: ANCHOS_NOMBRE[i] }} />
                  <div className="skeleton mt-2 h-3 w-16" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
