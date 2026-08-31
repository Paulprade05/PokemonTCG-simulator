"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import { getFullCollection, getSetsFromDB } from "../app/action";
import { getCollection } from "../utils/storage";
import { RARITY_RANK } from "../utils/constanst";
import { formatNumber } from "../utils/format";
import { useHaptics } from "../hooks/useHaptics";
import { useSwipe, touchActionFor } from "../hooks/useSwipe";
import PageHeader from "./PageHeader";
import Loader from "./Loader";
import CardDetailModal from "./CardDetailModal";
import PaginaArchivador from "./vitrina/PaginaArchivador";
import AnillasArchivador from "./vitrina/AnillasArchivador";
import type { CartaEnColeccion, Expansion } from "../utils/tipos";

/**
 * LA VITRINA — la colección vista como el archivador que se tiene en la mesa.
 *
 * NO ES OTRA REJILLA. /collection y /album ya pintan la colección con scroll y
 * paginación de 24; esto es deliberadamente lo contrario: nueve fundas por
 * hoja, ni una más, y se pasa de hoja. La diferencia no es estética. Con
 * scroll el jugador nunca sabe "dónde" está una carta; con hojas fijas de
 * nueve, la carta vive en un sitio —hoja 4, fila 2, tercera— y eso es lo que
 * convierte una lista en una colección. Por eso la última hoja se ve a medias,
 * con sus fundas vacías: rellenarlas o encoger la hoja rompería justamente lo
 * que se está imitando.
 *
 * ---------------------------------------------------------------------------
 * TRES TRAMPAS DEL REPOSITORIO QUE MANDAN SOBRE EL DISEÑO DE ESTA PANTALLA
 *
 * 1. NITIDEZ EN iPHONE. Las cartas se pintan con el camino rápido de
 *    PokemonCard (`interactive={false}` + `reveal`), que evita una capa
 *    compositada por carta. Ese camino se anula desde cualquier ancestro, así
 *    que en TODO el árbol de la vitrina no hay `filter`, `drop-shadow`,
 *    `backdrop-filter`, `mix-blend-mode`, `perspective`, `preserve-3d` ni un
 *    solo `transform` con `scale`. WebKit rasteriza esa capa a escala fija y
 *    la ilustración sale borrosa (PokemonCard.tsx:140-163 y 255-266).
 *    De ahí que el pase de hoja sea un DESPLAZAMIENTO con fundido y no un giro
 *    3D: un giro necesita `perspective` + `preserve-3d`, y aunque se pudiera
 *    salir del contexto 3D en reposo (el patrón `settled`/`flat` de
 *    PokemonCard), aquí no hay una carta en una capa sino nueve, y el reposo
 *    de una vitrina es el 99% del tiempo que se pasa en ella. El coste de la
 *    apuesta no compensa el rédito.
 *
 * 2. `will-change` SÓLO MIENTRAS DURA EL MOVIMIENTO. Un `will-change`
 *    permanente deja la textura rasterizada a una escala y emborrona igual.
 *    Lo lleva la bandera `pasando`, que se apaga sola con un temporizador
 *    (no con `onAnimationComplete`: si la pestaña se va a segundo plano a
 *    mitad del pase, esa llamada puede no llegar nunca y la propiedad se
 *    quedaría puesta para siempre. Es el mismo respaldo que usa PokemonCard
 *    para su `settled`).
 *
 * 3. EL GESTO DEL BORDE. `components/ui/EdgeBackGesture.tsx` se lleva
 *    cualquier arrastre que empiece a menos de 26px del borde izquierdo
 *    cuando la app está instalada. La solución está en el lomo: ver la
 *    cabecera de components/vitrina/AnillasArchivador.tsx.
 *
 * ---------------------------------------------------------------------------
 * Y UNA MÁS, DE MAQUETACIÓN: `app/template.tsx` envuelve cada ruta en un
 * `motion.div` CON TRANSFORM, y un ancestro transformado se convierte en el
 * bloque contenedor de sus descendientes `position: fixed`. Aquí no hay
 * ninguna capa a pantalla completa propia justamente por eso; la única que
 * aparece es la de CardDetailModal, que ya se cuelga de <body> con
 * components/ui/Portal.tsx.
 */

/** Nueve fundas por hoja. Es el formato del archivador real de 3×3. */
const POR_HOJA = 9;

/** Duración del pase, en segundos. La comparte el temporizador de will-change. */
const DURACION_PASE = 0.42;

/**
 * Recorrido del pase, en porcentaje del ancho de la hoja.
 *
 * NO es 100%. Una hoja que entra desde fuera del todo deja la ventana vacía a
 * mitad de animación y el pase se siente lento aunque dure lo mismo; con un
 * tercio y fundido cruzado, las dos hojas se solapan y la transición se lee
 * como papel deslizándose, no como un carrusel. Son porcentajes y no píxeles
 * para que el pase mida igual en un iPhone que en un monitor.
 */
const ENTRA = 38;
const SALE = 24;

const VARIANTES: Variants = {
  entra: (dir: number) => ({ x: `${dir > 0 ? ENTRA : -ENTRA}%`, opacity: 0 }),
  centro: { x: "0%", opacity: 1 },
  sale: (dir: number) => ({ x: `${dir > 0 ? -SALE : SALE}%`, opacity: 0 }),
};

/** Tapa del archivador: cartón/piel a partir de los tokens del tema. */
const TAPA: React.CSSProperties = {
  background:
    "var(--grain), linear-gradient(145deg," +
    " color-mix(in srgb, var(--ink) 9%, var(--surface)) 0%," +
    " var(--surface) 38%," +
    " color-mix(in srgb, var(--ink) 6%, var(--surface)) 100%)",
  border: "1px solid var(--border-strong)",
  boxShadow: "var(--shadow-lg)",
};

/** Hojas de debajo. Sólo asoma su canto, que es lo que da grosor al bloque. */
const CANTO: React.CSSProperties = {
  background: "color-mix(in srgb, var(--ink) 8%, var(--surface))",
  border: "1px solid var(--border)",
};

/** El id de una carta es `set-numero`: el set es todo lo anterior al ÚLTIMO guion. */
function setDeCarta(id: string): string {
  const guion = String(id).lastIndexOf("-");
  return guion > 0 ? String(id).slice(0, guion) : "";
}

/**
 * Orden del archivador para el invitado: favoritas, rareza y nombre.
 *
 * `getFullCollection` ya devuelve exactamente este orden hecho en SQL, así que
 * la lista del usuario con sesión NO se vuelve a ordenar: repetirlo aquí con
 * `localeCompare` cambiaría el desempate por nombre respecto a la colación de
 * Postgres y las cartas se moverían de funda entre una carga y otra, que en
 * una vitrina —donde el sitio de cada carta es el sentido de la pantalla— es
 * peor que cualquier orden. Al invitado sí hay que ordenarlo: su colección
 * vive en localStorage en el orden en que fue abriendo sobres.
 */
function ordenarComoElServidor(cartas: CartaEnColeccion[]): CartaEnColeccion[] {
  return [...cartas].sort((a, b) => {
    const favA = a.is_favorite ? 1 : 0;
    const favB = b.is_favorite ? 1 : 0;
    if (favA !== favB) return favB - favA;
    const rangoA = RARITY_RANK[a.rarity] || 0;
    const rangoB = RARITY_RANK[b.rarity] || 0;
    if (rangoA !== rangoB) return rangoB - rangoA;
    return a.name.localeCompare(b.name);
  });
}

export default function Vitrina() {
  const { isSignedIn, isLoaded } = useUser();
  const haptic = useHaptics();

  const [cartas, setCartas] = useState<CartaEnColeccion[]>([]);
  const [sets, setSets] = useState<Expansion[]>([]);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState(false);

  const [filtroSet, setFiltroSet] = useState("todas");
  const [hoja, setHoja] = useState(0);
  /** +1 avanza, -1 retrocede. Decide por dónde entra y por dónde sale la hoja. */
  const [direccion, setDireccion] = useState(1);
  /** Verdadero SÓLO mientras el pase está en marcha: gobierna will-change. */
  const [pasando, setPasando] = useState(false);
  /** Carta abierta en el detalle. Se guarda el id, no el objeto: ver más abajo. */
  const [detalleId, setDetalleId] = useState<string | null>(null);

  /**
   * Carga. Mismo patrón que app/collection/page.tsx, y por el mismo motivo:
   * todo dentro de un try, para que una server action caída (PWA sin cobertura,
   * 500, despliegue caducado) o un localStorage corrupto acaben en "reintentar"
   * y no en una vitrina vacía que le diga a quien tiene 300 cartas que no tiene
   * ninguna.
   */
  const cargar = useCallback(async () => {
    if (!isLoaded) return;
    setCargando(true);
    setErrorCarga(false);
    try {
      const expansiones = await getSetsFromDB();
      setSets(expansiones);
      if (isSignedIn) {
        // Ya viene traducida y ordenada desde el servidor.
        setCartas(await getFullCollection());
      } else {
        setCartas(ordenarComoElServidor(getCollection()));
      }
    } catch (error) {
      console.error("Error cargando la vitrina:", error);
      setErrorCarga(true);
    } finally {
      setCargando(false);
    }
  }, [isSignedIn, isLoaded]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  /** Cuántas cartas distintas hay de cada expansión. */
  const conteoPorSet = useMemo(() => {
    const mapa = new Map<string, number>();
    for (const c of cartas) {
      const sid = setDeCarta(c.id);
      if (!sid) continue;
      mapa.set(sid, (mapa.get(sid) ?? 0) + 1);
    }
    return mapa;
  }, [cartas]);

  /**
   * El desplegable sólo lista expansiones EN LAS QUE HAY ALGO. Con la base
   * sincronizada por el cron son más de ciento cincuenta sets, y ofrecer
   * ciento cuarenta archivadores vacíos no es filtrar, es un catálogo. El
   * orden es el que trae getSetsFromDB (lanzamiento descendente), que es el
   * que ya conoce el jugador de la pantalla de colección.
   */
  const opcionesSet = useMemo(
    () => sets.filter((s) => (conteoPorSet.get(s.id) ?? 0) > 0),
    [sets, conteoPorSet],
  );

  const cartasFiltradas = useMemo(() => {
    if (filtroSet === "todas") return cartas;
    // Con el guion: los ids son `set-numero` y sin él "sv8" se llevaría también
    // las de "sv8pt5" (y "swsh1" las de swsh10/11/12).
    return cartas.filter((c) => c.id.startsWith(filtroSet + "-"));
  }, [cartas, filtroSet]);

  const totalHojas = Math.max(1, Math.ceil(cartasFiltradas.length / POR_HOJA));
  /**
   * El recorte va aquí y no en un efecto porque un efecto corre DESPUÉS de
   * pintar: al recargar con menos cartas de las que había, quedaría un
   * fotograma con la hoja 12 vacía y el rótulo diciendo "12 de 4".
   */
  const hojaSegura = Math.min(hoja, totalHojas - 1);

  /** Devuelve el estado real al rango cuando la colección encoge (una venta). */
  useEffect(() => {
    setHoja((h) => Math.min(h, totalHojas - 1));
  }, [totalHojas]);

  /**
   * Las nueve posiciones de la hoja, rellenando con `null`. Ver la cabecera de
   * PaginaArchivador: la hoja monta siempre nueve casillas.
   */
  const huecos = useMemo(() => {
    const inicio = hojaSegura * POR_HOJA;
    return Array.from(
      { length: POR_HOJA },
      (_, i) => cartasFiltradas[inicio + i] ?? null,
    );
  }, [cartasFiltradas, hojaSegura]);

  const irAHoja = useCallback(
    (destino: number) => {
      const limpio = Math.max(0, Math.min(destino, totalHojas - 1));
      if (limpio === hojaSegura) return;
      setDireccion(limpio > hojaSegura ? 1 : -1);
      setPasando(true);
      setHoja(limpio);
      haptic("tap");
    },
    [hojaSegura, totalHojas, haptic],
  );

  /**
   * Apagado de `will-change` por temporizador y no por `onAnimationComplete`.
   * Ver el punto 2 de la cabecera. Se reinicia también con `hojaSegura` para
   * que pasar tres hojas seguidas no lo apague en mitad del tercer pase.
   */
  useEffect(() => {
    if (!pasando) return;
    const t = window.setTimeout(
      () => setPasando(false),
      DURACION_PASE * 1000 + 140,
    );
    return () => window.clearTimeout(t);
  }, [pasando, hojaSegura]);

  /* ---------------------------------------------------------------- */
  /* GESTOS                                                            */
  /* ---------------------------------------------------------------- */

  /** Escucha el arrastre y recorta la hoja que se va. */
  const ventanaRef = useRef<HTMLDivElement>(null);
  /** Recibe el transform del dedo. Ver por qué son dos elementos, abajo. */
  const pilaRef = useRef<HTMLDivElement>(null);

  /**
   * El gesto se escucha en la VENTANA pero el transform va a la PILA.
   *
   * Si el elemento que sigue al dedo fuera el mismo que recorta, se movería el
   * recorte con él y la hoja no llegaría a asomar por el borde: se vería
   * arrastrar el marco entero, no el papel dentro del archivador. Con
   * `followTarget` el marco se queda quieto y lo que viaja es la pila de
   * hojas, que es lo que hace un archivador.
   *
   * Además evita que useSwipe y framer se peleen por el mismo `style.transform`:
   * useSwipe escribe en la pila y framer en la hoja de dentro, y los dos
   * transforms se componen sin pisarse.
   *
   * Los manejadores se pasan como `undefined` en los extremos a propósito: sin
   * manejador en esa dirección, useSwipe aplica resistencia al arrastre en vez
   * de moverse en balde, así que la primera y la última hoja se notan topes.
   */
  useSwipe(ventanaRef, {
    axis: "x",
    follow: true,
    followTarget: pilaRef,
    // El detalle se abre en un diálogo propio con su propio gesto lateral
    // (navega entre cartas): mientras está abierto, el archivador no escucha.
    enabled: !detalleId,
    onSwipeLeft:
      hojaSegura < totalHojas - 1 ? () => irAHoja(hojaSegura + 1) : undefined,
    onSwipeRight: hojaSegura > 0 ? () => irAHoja(hojaSegura - 1) : undefined,
  });

  /**
   * Teclado. En `window` y no en la vitrina para que funcione sin haber
   * enfocado nada, que es como se usa un archivador con las flechas.
   *
   * Tres exclusiones, y las tres han sido un fallo real en alguna app:
   *  · Campos de texto y desplegables — las flechas son suyas (mover el cursor,
   *    cambiar de opción); robárselas rompe el filtro de expansión.
   *  · Modificadores — ⌘←/Alt← es "atrás" del navegador.
   *  · Con un `[role="dialog"]` montado, las flechas pertenecen al diálogo
   *    (CardDetailModal navega entre cartas con ellas). Es la misma condición
   *    que usa EdgeBackGesture para rendirse, y se comprueba igual.
   */
  useEffect(() => {
    const alPulsar = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const destino = e.target as HTMLElement | null;
      const etiqueta = destino?.tagName;
      if (
        etiqueta === "INPUT" ||
        etiqueta === "SELECT" ||
        etiqueta === "TEXTAREA" ||
        destino?.isContentEditable
      ) {
        return;
      }
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      irAHoja(hojaSegura + (e.key === "ArrowRight" ? 1 : -1));
    };
    window.addEventListener("keydown", alPulsar);
    return () => window.removeEventListener("keydown", alPulsar);
  }, [irAHoja, hojaSegura]);

  /* ---------------------------------------------------------------- */
  /* DETALLE                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Se guarda el ID y la carta se re-lee de la lista viva en cada render.
   * Guardar el objeto congelaría la copia: si el jugador vende una repetida
   * desde otra pestaña o cambia un favorito, el detalle seguiría enseñando el
   * número viejo. Es el mismo criterio que `actionCardLive` en la colección.
   */
  const idsNavegables = useMemo(
    () => cartasFiltradas.map((c) => c.id),
    [cartasFiltradas],
  );
  const detalle = detalleId
    ? cartasFiltradas.find((c) => c.id === detalleId) ?? null
    : null;
  const indiceDetalle = detalleId ? idsNavegables.indexOf(detalleId) : -1;

  /**
   * Al deslizar dentro del detalle, el archivador de detrás pasa a la hoja de
   * esa carta. Así, al cerrar, el jugador se queda MIRANDO la funda de la que
   * acaba de salir en vez de volver a donde estaba hace diez cartas.
   */
  const irACartaDelDetalle = (i: number) => {
    const id = idsNavegables[i];
    if (!id) return;
    setDetalleId(id);
    irAHoja(Math.floor(i / POR_HOJA));
  };

  /* ---------------------------------------------------------------- */
  /* RENDER                                                            */
  /* ---------------------------------------------------------------- */

  if (cargando) return <Loader label="Abriendo la vitrina" />;

  if (errorCarga) {
    return (
      <div className="w-full">
        <PageHeader
          title="Vitrina"
          subtitle="Tu colección en un archivador de nueve"
          back="/collection"
        />
        <div className="surface flex flex-col items-center gap-4 rounded-2xl px-6 py-16 text-center md:py-20">
          <div className="surface-2 flex h-14 w-14 items-center justify-center rounded-2xl">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="ink-faint h-7 w-7"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7.5v5.5M12 16.5h.01" />
            </svg>
          </div>
          <div>
            <p className="ink font-medium">No se pudo abrir la vitrina</p>
            <p className="ink-soft mt-1 text-sm">
              Comprueba tu conexión e inténtalo de nuevo.
            </p>
          </div>
          <button
            onClick={() => {
              haptic("tap");
              cargar();
            }}
            className="btn-primary press touch-target rounded-xl px-5 py-2.5 text-sm font-medium"
          >
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  const vacia = cartasFiltradas.length === 0;

  return (
    <div className="w-full select-none">
      <PageHeader
        title="Vitrina"
        subtitle="Tu colección en un archivador de nueve"
        back="/collection"
      />

      {/* TOPE DE ANCHO. Un archivador no es una rejilla fluida: nueve cartas
          en 3×3 miden 1,4 veces de alto lo que midan de ancho, así que dejarlo
          crecer hasta los 1280px del <main> daría cartas de 380px y un bloque
          de más de dos pantallas de alto — habría que hacer scroll para ver
          una sola hoja, que es justo lo contrario de lo que hace un
          archivador. A 672px las cartas salen a ~180px (algo mayores que en la
          rejilla de la colección) y la hoja entera se abarca de un vistazo. */}
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
        {/* BARRA — filtro de expansión y de cuánto hay dentro. No se queda
            pegada al hacer scroll, al contrario que la de la colección: aquí
            el archivador entero cabe en pantalla y una barra flotante sólo
            robaría alto a las cartas. */}
        <div className="surface flex flex-col gap-2 rounded-2xl px-3 py-3 sm:flex-row sm:items-center">
          <select
            value={filtroSet}
            onChange={(e) => {
              haptic("select");
              setFiltroSet(e.target.value);
              // La hoja se reinicia AQUÍ y no en un efecto: hacerlo después
              // dejaría un pase de página fantasma (de la hoja 7 del set viejo
              // a la hoja 7 del nuevo, y de ésa a la 1) en cada cambio de
              // filtro.
              setDireccion(1);
              setPasando(true);
              setHoja(0);
            }}
            aria-label="Ver el archivador de una expansión"
            className="input-field w-full min-w-0 cursor-pointer truncate rounded-xl px-3 py-2.5 text-xs sm:w-auto sm:flex-1"
          >
            <option value="todas">
              Archivador completo · {formatNumber(cartas.length)} cartas
            </option>
            {opcionesSet.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {formatNumber(conteoPorSet.get(s.id) ?? 0)}
              </option>
            ))}
          </select>

          <span className="chip ink-soft tnum shrink-0 px-3 py-2 text-center text-[11px] font-medium">
            {formatNumber(cartasFiltradas.length)} cartas ·{" "}
            {formatNumber(totalHojas)} {totalHojas === 1 ? "hoja" : "hojas"}
          </span>
        </div>

        {vacia ? (
          <div className="surface flex flex-col items-center gap-4 rounded-2xl px-6 py-16 text-center md:py-20">
            <div className="surface-2 flex h-14 w-14 items-center justify-center rounded-2xl">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="ink-faint h-7 w-7"
              >
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
            </div>
            <div>
              <p className="ink font-medium">El archivador está vacío</p>
              <p className="ink-soft mt-1 text-sm">
                Abre tu primer sobre y las fundas se irán llenando de nueve en
                nueve.
              </p>
            </div>
            <Link
              href="/"
              className="btn-primary press rounded-xl px-5 py-2.5 text-sm font-medium"
            >
              Abrir sobres
            </Link>
          </div>
        ) : (
          <>
            {/* ARCHIVADOR */}
            <div className="rounded-3xl p-2.5 sm:p-4" style={TAPA}>
              <div className="flex items-stretch">
                <AnillasArchivador />

                {/* Bloque de hojas. `relative` y `min-w-0` (sin el segundo, un
                    hijo de flex no baja de su ancho de contenido y la rejilla
                    de tres columnas desbordaría en pantallas estrechas). */}
                <div className="relative min-w-0 flex-1">
                  {/* GROSOR — cantos de las hojas que quedan debajo. Son
                      hermanos decorativos, nunca ancestros de una carta, así
                      que su `translate` no afecta a la nitidez. */}
                  <div
                    aria-hidden="true"
                    className="absolute inset-0 rounded-2xl"
                    style={{ ...CANTO, transform: "translate(6px, 7px)" }}
                  />
                  <div
                    aria-hidden="true"
                    className="absolute inset-0 rounded-2xl"
                    style={{ ...CANTO, transform: "translate(3px, 3.5px)" }}
                  />

                  {/* VENTANA — recorta la hoja que entra y la que sale, y es el
                      ÚNICO elemento que escucha el arrastre (ver el punto 3 de
                      la cabecera). `touch-action: pan-y` le devuelve al
                      navegador el desplazamiento vertical de la página: sin
                      esto, arrastrar hacia abajo sobre el archivador no haría
                      scroll. */}
                  <div
                    ref={ventanaRef}
                    className="relative z-10 overflow-hidden rounded-2xl"
                    style={{ touchAction: touchActionFor("x") }}
                  >
                    {/* `grid-cols-1` y no `grid` a secas: una pista implícita
                        mide `auto`, cuyo mínimo es el `min-content` del
                        contenido, y el mínimo de una <img> es su ANCHO
                        INTRÍNSECO (245px por carta). Tres columnas de eso son
                        735px de mínimo y la hoja desbordaba en cualquier
                        móvil. `grid-cols-1` es `minmax(0, 1fr)`, que sí puede
                        encoger. Es la misma razón por la que la rejilla de la
                        hoja usa `grid-cols-3` de Tailwind y no un template a
                        mano. */}
                    <div ref={pilaRef} className="grid grid-cols-1">
                      <AnimatePresence initial={false} custom={direccion}>
                        <motion.div
                          /* La clave incluye el filtro: cambiar de expansión
                             es cambiar de archivador, no de hoja, y sin esto
                             React reutilizaría las mismas nueve fundas y las
                             cartas cambiarían de golpe sin pase. */
                          key={`${filtroSet}:${hojaSegura}`}
                          custom={direccion}
                          variants={VARIANTES}
                          initial="entra"
                          animate="centro"
                          exit="sale"
                          transition={{
                            duration: DURACION_PASE,
                            ease: [0.16, 1, 0.3, 1],
                          }}
                          /* Las dos hojas comparten celda de rejilla en vez de
                             apilarse en absoluto: así el bloque conserva alto
                             propio (una hoja absoluta no mide) y no hace falta
                             clavar una altura que dependería del ancho de la
                             carta. */
                          className="col-start-1 row-start-1"
                          style={{
                            willChange: pasando ? "transform, opacity" : "auto",
                          }}
                        >
                          <PaginaArchivador
                            huecos={huecos}
                            numero={hojaSegura + 1}
                            total={totalHojas}
                            onAbrir={(c) => {
                              haptic("select");
                              setDetalleId(c.id);
                            }}
                          />
                        </motion.div>
                      </AnimatePresence>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* MANDOS — botones, además del gesto y del teclado. El gesto no
                puede ser el único camino: en escritorio no hay dedo, y en la
                PWA el arrastre convive con el gesto de retroceso del sistema. */}
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => irAHoja(0)}
                disabled={hojaSegura === 0}
                aria-label="Primera hoja"
                className="btn-ghost press touch-target flex h-11 w-11 items-center justify-center rounded-xl disabled:cursor-not-allowed disabled:opacity-30"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="h-4 w-4"
                >
                  <path d="m17 18-6-6 6-6M7 18V6" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => irAHoja(hojaSegura - 1)}
                disabled={hojaSegura === 0}
                aria-label="Hoja anterior"
                className="btn-ghost press touch-target flex h-11 w-11 items-center justify-center rounded-xl disabled:cursor-not-allowed disabled:opacity-30"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="h-4 w-4"
                >
                  <path d="m15 18-6-6 6-6" />
                </svg>
              </button>

              {/* `aria-live` para que el pase de hoja se anuncie: con lector de
                  pantalla, el gesto y las flechas cambian nueve cartas sin
                  mover el foco, y sin esto no habría ni rastro de que ha
                  pasado algo. */}
              <span
                aria-live="polite"
                className="chip ink tnum min-w-[9.5rem] px-4 py-2 text-center text-sm font-medium"
              >
                Hoja {hojaSegura + 1} de {totalHojas}
              </span>

              <button
                type="button"
                onClick={() => irAHoja(hojaSegura + 1)}
                disabled={hojaSegura === totalHojas - 1}
                aria-label="Hoja siguiente"
                className="btn-ghost press touch-target flex h-11 w-11 items-center justify-center rounded-xl disabled:cursor-not-allowed disabled:opacity-30"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="h-4 w-4"
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => irAHoja(totalHojas - 1)}
                disabled={hojaSegura === totalHojas - 1}
                aria-label="Última hoja"
                className="btn-ghost press touch-target flex h-11 w-11 items-center justify-center rounded-xl disabled:cursor-not-allowed disabled:opacity-30"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="h-4 w-4"
                >
                  <path d="m7 6 6 6-6 6M17 6v12" />
                </svg>
              </button>
            </div>

            {/* Por dónde va el archivador. Decorativo: el dato ya está escrito
                al lado, en texto, y anunciado por aria-live. */}
            <div
              aria-hidden="true"
              className="surface-2 mx-auto h-1 w-full max-w-sm overflow-hidden rounded-full"
            >
              <div
                className="progress-bar-blue h-full"
                style={{ width: `${((hojaSegura + 1) / totalHojas) * 100}%` }}
              />
            </div>

            <p className="ink-faint text-center text-[11px]">
              Desliza sobre las hojas o usa las flechas ← → para pasar de página
            </p>
          </>
        )}
      </div>

      {/* El detalle va en modo lectura: la vitrina enseña la colección, y
          vender o marcar favoritas ya tiene su sitio en /collection. Añadirlo
          aquí duplicaría los cerrojos de venta y de favorito (y con ellos la
          posibilidad de que las dos pantallas se desincronicen) a cambio de
          nada que no se pueda hacer a un toque de distancia. */}
      <CardDetailModal
        card={detalle}
        readOnly
        onClose={() => setDetalleId(null)}
        cards={idsNavegables}
        index={indiceDetalle}
        onIndexChange={irACartaDelDetalle}
      />
    </div>
  );
}
