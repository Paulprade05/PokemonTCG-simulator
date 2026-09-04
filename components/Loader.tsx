"use client";

import type { CSSProperties } from "react";
import { usePathname } from "next/navigation";
import { ANCHO_MAX_ARCHIVADOR } from "./vitrina/LibroArchivador";

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
 * ---------------------------------------------------------------------------
 * UN ESQUELETO QUE NO MIDE LO QUE LLEGA ES PEOR QUE EL CÍRCULO.
 *
 * Había cuatro formas para nueve pantallas, y ninguna medía lo suyo: la
 * colección empezaba su rejilla a y=336 y el esqueleto a 212 (salto de 124px
 * al cargar); el álbum, 149px; la vitrina, la graduación, el mercado, el bazar
 * y el social pintaban una fila de filtros que no existe, tres columnas donde
 * hay dos o avatares donde hay cartas; y las celdas medían 108x151 cuando las
 * reales miden 108x203 (la carta y su botón de "Vender" de 44px). El efecto es
 * el contrario del buscado: la pantalla se reordena entera al llegar.
 *
 * Ahora hay UNA FORMA POR RUTA, y cada una reproduce la cabecera real, el
 * primer bloque real y celdas del tamaño real. Las medidas están tomadas del
 * DOM a 375px de ancho (iPhone) y, donde cambia, a 1280x800; van en un
 * comentario junto a cada forma, en píxeles desde el borde superior del
 * contenido de la ruta. Si una pantalla cambia de maqueta, hay que volver a
 * medir aquí: el esqueleto es una promesa de dónde va a caer cada cosa.
 *
 * El `label` no se pierde: deja de pintarse pero se sigue anunciando al lector
 * de pantalla, que es quien lo necesita. Para quien ve la pantalla, la forma ya
 * es el mensaje.
 *
 * LOS RADIOS los pone cada forma, no `.skeleton`: `rounded-full` para avatares
 * y píldoras, `rounded-[4.5%]` para las cartas (el mismo de PokemonCard),
 * `rounded-xl`/`rounded-2xl`/`rounded-3xl` para botones y superficies, y
 * `rounded-md` para un renglón de texto.
 */

type Forma =
  | "coleccion"
  | "album"
  | "vitrina"
  | "graduacion"
  | "mercado"
  | "bazar"
  | "social"
  | "entrenador"
  | "circulo";

/** Cada prefijo de ruta con la forma que tiene su contenido de verdad. */
const FORMAS: { prefijo: string; forma: Forma }[] = [
  { prefijo: "/collection", forma: "coleccion" },
  { prefijo: "/album", forma: "album" },
  { prefijo: "/vitrina", forma: "vitrina" },
  { prefijo: "/graduacion", forma: "graduacion" },
  { prefijo: "/mercado", forma: "mercado" },
  { prefijo: "/bazar", forma: "bazar" },
  { prefijo: "/friends", forma: "social" },
  { prefijo: "/trainer", forma: "entrenador" },
];

function formaDe(ruta: string): Forma {
  return FORMAS.find((f) => ruta.startsWith(f.prefijo))?.forma ?? "circulo";
}

/* Los tamaños de los huecos van en listas fijas y no en Math.random(): el
   servidor y el navegador tienen que pintar exactamente lo mismo o React
   aborta la hidratación. Variar los anchos evita que el bloque parezca una
   tabla, que es lo que delata a un esqueleto. */
const ANCHOS_NOMBRE = ["72%", "58%", "80%", "64%", "76%", "52%", "68%", "60%", "78%", "56%"];

/* ------------------------------------------------------------------ *
 * PIEZAS
 * ------------------------------------------------------------------ */

/**
 * Cabecera de página. Real (components/PageHeader.tsx): una fila de 44px
 * —lo que miden el botón de volver y las acciones— con el h1 de 28px (32 en
 * md); con subtítulo, 28 + 2 + 16 = 46 (50 en md); con logo, la imagen de 36
 * (44 en md). Margen inferior 24 (32 en md). Medido: /collection 44, /mercado
 * 46, /vitrina 46, /album 44, /trainer 44; /vitrina en escritorio 50.
 */
function CabeceraFalsa({
  atras = false,
  subtitulo = false,
  logo = false,
  acciones = 0,
}: {
  atras?: boolean;
  subtitulo?: boolean;
  logo?: boolean;
  acciones?: number;
}) {
  return (
    <div className="mb-6 flex min-h-11 items-center justify-between gap-3 md:mb-8">
      <div className="flex min-w-0 items-center gap-3">
        {atras && <div className="skeleton h-11 w-11 shrink-0 rounded-xl" />}
        {logo ? (
          <div className="skeleton h-9 w-32 rounded-lg md:h-11 md:w-40" />
        ) : (
          <div>
            <div className="skeleton h-7 w-40 rounded-md md:h-8 md:w-56" />
            {subtitulo && <div className="skeleton mt-0.5 h-4 w-52 rounded-md" />}
          </div>
        )}
      </div>
      {acciones > 0 && (
        <div className="flex shrink-0 items-center gap-2">
          {Array.from({ length: acciones }).map((_, i) => (
            <div key={i} className="skeleton h-11 w-11 rounded-xl" />
          ))}
        </div>
      )}
    </div>
  );
}

/** Una carta: la proporción física (63×88 mm = 5/7) y el radio de PokemonCard. */
function Carta() {
  return <div className="skeleton aspect-[5/7] w-full rounded-[4.5%]" />;
}

/**
 * La rejilla de cartas que comparten colección, álbum y álbum de entrenador:
 * tres columnas en móvil con hueco de 10px (celda de 108px a 375), cuatro en
 * sm y seis en lg con hueco de 16. Debajo de cada carta, lo que lleve la
 * pantalla: el botón "Vender" de 44px de la colección, el chip de 25px de
 * copias del álbum de entrenador, o nada.
 */
function RejillaCartas({ pie, celdas = 12 }: { pie?: "vender" | "chip"; celdas?: number }) {
  return (
    <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:gap-4 lg:grid-cols-6">
      {Array.from({ length: celdas }).map((_, i) => (
        <div key={i}>
          <Carta />
          {pie === "vender" && <div className="skeleton mx-auto mt-2 h-11 w-24 rounded-full" />}
          {pie === "chip" && <div className="skeleton mx-auto mt-2 h-[25px] w-12 rounded-full" />}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * FORMAS
 * ------------------------------------------------------------------ */

/**
 * /collection — medido a 375: cabecera 44 (+24) → botón de progreso a y=68,
 * 62px (px-4 py-3; 74 en sm con px-5 py-4) → +24 → barra de búsqueda y
 * filtros a y=154, 70px (py-3 + campo de 44 + borde) → +24 → rejilla a y=248
 * (336 contando los 88 de barra superior y pt-6) con celdas de 108x203: carta
 * 151 + 8 + botón "Vender" de 44.
 */
function Coleccion() {
  return (
    <>
      <CabeceraFalsa acciones={3} />
      <div className="flex flex-col gap-6">
        <div className="skeleton h-[62px] rounded-2xl sm:h-[74px]" />
        <div className="skeleton h-[70px] rounded-2xl" />
        <RejillaCartas pie="vender" />
      </div>
    </>
  );
}

/**
 * /album/[setId] — medido a 375: cabecera 44 (volver 44 + logo de 36) (+24) →
 * bloque de progreso a y=68, 119px (p-4 + título + texto + barra; en md se
 * pone en fila y baja a ~79) → +16 → filtro segmentado a y=203, 54px (p-1 +
 * botones de 44) → +16 → rejilla a y=273 con celdas de 108x151 (sólo carta).
 */
function Album() {
  return (
    <>
      <CabeceraFalsa atras logo />
      <div className="flex flex-col gap-4 sm:gap-6">
        <div className="skeleton h-[119px] rounded-2xl md:h-[79px]" />
        <div className="skeleton h-[54px] rounded-2xl" />
        <RejillaCartas />
      </div>
    </>
  );
}

/**
 * /vitrina — medido a 375: cabecera 46 (+24) → barra de aviso a y=70, 88px
 * (en sm pasa a una fila de 61) → +20 → tapa a y=178, 343x409 (p-2.5; en sm
 * p-4, y en escritorio 672x823 con el tope de siempre) → +20 → mandos a y=607,
 * 44px (dos botones, el chip "Hoja 1 de 3" de 152x38, dos botones). La tapa
 * es un marco con el canto de las anillas a la izquierda y la hoja de 3×3
 * dentro, con el mismo tope de ancho que la real (ANCHO_MAX_ARCHIVADOR) para
 * que en escritorio no cambie de tamaño al llegar.
 */
function Vitrina() {
  return (
    <>
      <CabeceraFalsa atras subtitulo />
      <div
        className="mx-auto flex w-full max-w-2xl flex-col gap-5 md:max-w-[var(--archivador-max)]"
        style={{ "--archivador-max": ANCHO_MAX_ARCHIVADOR } as CSSProperties}
      >
        <div className="skeleton h-[88px] rounded-2xl sm:h-[61px]" />
        <div className="rounded-3xl p-2.5 sm:p-4" style={{ border: "1px solid var(--border)" }}>
          <div className="flex items-stretch gap-2 sm:gap-3">
            <div className="skeleton w-5 shrink-0 rounded-full sm:w-7" />
            <div
              className="grid min-w-0 flex-1 grid-cols-3 gap-2 rounded-2xl p-2 sm:gap-3 sm:p-3"
              style={{ border: "1px solid var(--border)" }}
            >
              {Array.from({ length: 9 }).map((_, i) => (
                <Carta key={i} />
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-center gap-2">
          <div className="skeleton h-11 w-11 rounded-xl" />
          <div className="skeleton h-11 w-11 rounded-xl" />
          <div className="skeleton h-[38px] w-[9.5rem] rounded-full" />
          <div className="skeleton h-11 w-11 rounded-xl" />
          <div className="skeleton h-11 w-11 rounded-xl" />
        </div>
      </div>
    </>
  );
}

/**
 * /graduacion — cabecera 46 (+24) → dos secciones a y=70, 58px (p-1.5 +
 * botones de 44) → +16 → "¿Cómo funciona?" plegado, 72px (px-5 py-4 + título
 * 20 + texto 16) → +16 → buscador (44) y orden (38; a la derecha en sm) →
 * +12 → filas de la lista, 104px cada una (p-3 + miniatura de 56x78 + nombre,
 * rareza y copias + precio y los dos botones de 44), con 10 de hueco. Es la
 * pestaña "Enviar a graduar", que es con la que se abre.
 */
function Graduacion() {
  return (
    <>
      <CabeceraFalsa atras subtitulo />
      <div className="flex flex-col gap-4">
        <div className="skeleton h-[58px] rounded-2xl" />
        <div className="skeleton h-[72px] rounded-2xl" />
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="skeleton h-11 flex-1 rounded-xl" />
            <div className="skeleton h-[38px] rounded-xl sm:w-48" />
          </div>
          <div className="flex flex-col gap-2.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="surface flex items-center gap-3 rounded-2xl p-3">
                <div className="w-14 shrink-0">
                  <Carta />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="skeleton h-5 rounded-md" style={{ width: ANCHOS_NOMBRE[i] }} />
                  <div className="skeleton mt-1 h-4 w-28 rounded-md" />
                  <div className="skeleton mt-1 h-4 w-20 rounded-md" />
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <div className="skeleton h-9 w-12 rounded-md" />
                  <div className="skeleton h-11 w-11 rounded-xl" />
                  <div className="skeleton h-11 w-11 rounded-xl" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * /mercado — medido a 375: cabecera 46 con dos acciones (+24) → rejilla de
 * ofertas a y=70 (una columna; dos en md) con hueco de 16. Cada oferta es una
 * superficie rounded-3xl p-5 con gap-4: cabecera (chips de dificultad y
 * expansión + título de 24 a la izquierda; multiplicador 28 + 15 a la
 * derecha) → descripción de cuatro renglones (78) → los requisitos (surface-2
 * de 112 a 240 según las miniaturas) → el botón de cobrar (46). Medidas
 * reales de las cinco ofertas del tablón: 626 a 876; el esqueleto se queda en
 * el tramo bajo, que es el de una oferta con dos requisitos.
 */
function FichaMercado() {
  return (
    <div className="surface flex flex-col gap-4 rounded-3xl p-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex gap-2">
            <div className="skeleton h-5 w-14 rounded-full" />
            <div className="skeleton h-5 w-24 rounded-full" />
          </div>
          <div className="skeleton h-6 w-3/4 rounded-md" />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="skeleton h-7 w-16 rounded-md" />
          <div className="skeleton h-3 w-24 rounded-md" />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="skeleton h-[15px] rounded-md" />
        <div className="skeleton h-[15px] rounded-md" />
        <div className="skeleton h-[15px] rounded-md" />
        <div className="skeleton h-[15px] w-3/5 rounded-md" />
      </div>
      <div className="flex flex-col gap-2.5">
        {[3, 5].map((miniaturas, i) => (
          <div key={i} className="surface-2 rounded-2xl px-3.5 py-3">
            <div className="mb-2 flex items-start justify-between gap-3">
              <div className="skeleton h-4 w-2/3 rounded-md" />
              <div className="skeleton h-4 w-8 rounded-md" />
            </div>
            <div className="skeleton h-1 rounded-full" />
            <div className="mt-3 flex flex-wrap gap-1.5">
              {Array.from({ length: miniaturas }).map((_, j) => (
                <div key={j} className="w-11">
                  <Carta />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="skeleton h-[46px] rounded-xl" />
    </div>
  );
}

function Mercado() {
  return (
    <>
      <CabeceraFalsa subtitulo acciones={2} />
      <div className="grid gap-4 md:grid-cols-2">
        <FichaMercado />
        <FichaMercado />
        <FichaMercado />
        <FichaMercado />
      </div>
    </>
  );
}

/**
 * /bazar — cabecera 46 con una acción (+24) → las tres reglas a y=70
 * (fichas surface-2 de ~56, en columna en móvil y en fila desde sm) → +16 →
 * rejilla de anuncios: DOS columnas en móvil con hueco de 12 (tres en sm,
 * cinco en lg), celdas de 165x~337: superficie p-2.5 con la carta (145x204),
 * nombre y vendedor (dos renglones), precio y el botón de 44. El aviso de
 * invitado y las pestañas "Escaparate / Mis anuncios" dependen de la sesión,
 * que aquí todavía no se conoce: se dejan fuera a propósito.
 */
function Bazar() {
  return (
    <>
      <CabeceraFalsa subtitulo acciones={1} />
      <div className="flex w-full flex-col gap-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="skeleton h-14 flex-1 rounded-2xl" />
          <div className="skeleton h-14 flex-1 rounded-2xl" />
          <div className="skeleton h-14 flex-1 rounded-2xl" />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:gap-4 lg:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="surface flex flex-col gap-2 rounded-2xl p-2.5">
              <Carta />
              <div>
                <div className="skeleton h-[15px] rounded-md" style={{ width: ANCHOS_NOMBRE[i] }} />
                <div className="skeleton mt-1 h-3 w-2/3 rounded-md" />
              </div>
              <div className="flex items-baseline justify-between">
                <div className="skeleton h-4 w-12 rounded-md" />
                <div className="skeleton h-3 w-10 rounded-md" />
              </div>
              <div className="skeleton h-11 rounded-xl" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * /friends — cabecera 46 con el botón de añadir (+24) → pestañas a y=70,
 * 50px (p-1 + cinco botones de 40) con margen de 24 → tarjetas de amigo en
 * una columna (dos en sm, tres en lg) con hueco de 12: p-4 con avatar de 40 y
 * dos renglones (mb-3), la fila de valor (mb-3) y los dos botones de 36; 154
 * en total. Es la forma con sesión: la del invitado (resumen local + aviso)
 * llega en el acto y no pasa por aquí.
 */
function Social() {
  return (
    <>
      <CabeceraFalsa subtitulo acciones={1} />
      <div className="surface mb-6 flex gap-1 rounded-2xl p-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="skeleton h-10 flex-1 rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="surface rounded-2xl p-4">
            <div className="mb-3 flex items-center gap-3">
              <div className="skeleton h-10 w-10 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1">
                <div className="skeleton h-5 rounded-md" style={{ width: ANCHOS_NOMBRE[i] }} />
                <div className="skeleton mt-1 h-3.5 w-28 rounded-md" />
              </div>
            </div>
            <div className="mb-3 flex items-center justify-between">
              <div className="skeleton h-3 w-10 rounded-md" />
              <div className="skeleton h-4 w-16 rounded-md" />
            </div>
            <div className="flex gap-2">
              <div className="skeleton h-9 flex-1 rounded-lg" />
              <div className="skeleton h-9 flex-1 rounded-lg" />
              <div className="skeleton h-9 w-11 rounded-lg" />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * /trainer/[id] — medido a 375: cabecera 44 con volver (+24) → botón de
 * progreso a y=68, 74px (px-5 py-4) → +24 → filtros a y=166, 174px (px-3 py-3:
 * buscador de 44, expansión a ancho completo y rareza + orden en dos columnas,
 * todos de 44 con hueco de 8; en sm se ponen en fila) → +24 → rejilla a
 * y=364, celdas de 108x184: carta 151 + 8 + chip de copias de 25.
 */
function Entrenador() {
  return (
    <>
      <CabeceraFalsa atras />
      <div className="flex flex-col gap-6">
        <div className="skeleton h-[74px] rounded-2xl" />
        <div className="surface flex flex-col gap-2 rounded-2xl px-3 py-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="skeleton h-11 flex-1 rounded-xl sm:min-w-[180px]" />
          <div className="grid grid-cols-2 gap-2 sm:contents">
            <div className="skeleton col-span-2 h-11 rounded-xl sm:col-span-1 sm:w-40" />
            <div className="skeleton h-11 rounded-xl sm:w-32" />
            <div className="skeleton h-11 rounded-xl sm:w-32" />
          </div>
        </div>
        <RejillaCartas pie="chip" />
      </div>
    </>
  );
}

const CUERPOS: Record<Exclude<Forma, "circulo">, () => React.JSX.Element> = {
  coleccion: Coleccion,
  album: Album,
  vitrina: Vitrina,
  graduacion: Graduacion,
  mercado: Mercado,
  bazar: Bazar,
  social: Social,
  entrenador: Entrenador,
};

export default function Loader({ label = "Cargando" }: { label?: string }) {
  const pathname = usePathname();
  const forma = formaDe(pathname);

  // El aviso para el lector de pantalla es común a todas las formas: se anuncia
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

  const Cuerpo = CUERPOS[forma];

  return (
    <div className="w-full">
      {anuncio}
      <div aria-hidden="true">
        <Cuerpo />
      </div>
    </div>
  );
}
