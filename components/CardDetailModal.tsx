"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { useUser } from "@clerk/nextjs";
import TypeBadge, { EnergyCost } from "./TypeBadge";
// `desgasteEnPalabras` ya no se importa: era de los dos rótulos que se
// quitaron (ver el comentario largo donde estaba el panel "Estado de la
// copia"). Las marcas se siguen pintando, así que el resto sigue aquí.
import DesperfectosCarta, {
  estadoDeCopia,
  estiloDescentrado,
} from "./DesperfectosCarta";
import type { Desperfectos, MarcasDeCarta } from "../utils/graduacion";
import { precioDeCartaSuelta, valorDeVenta } from "../utils/constanst";
import { etiquetaNota, valorGraduado } from "../utils/graduacion";
import { getCardFromDB, toggleWishlist, getWishlistIds } from "../app/action";
import { useHaptics } from "../hooks/useHaptics";
import { useSwipe, touchActionFor } from "../hooks/useSwipe";
import { RARITY_GLOW } from "../utils/rarityGlow";
import CardZoom from "./ui/CardZoom";
import Portal from "./ui/Portal";
import { useToast } from "./ui/Toast";

// Umbrales del gesto de cierre (los mismos que usa components/ui/Sheet).
const CLOSE_OFFSET = 110;
const CLOSE_VELOCITY = 520;
// Umbrales del gesto de navegación entre cartas.
const NAV_OFFSET = 70;
const NAV_VELOCITY = 420;

interface CardDetailModalProps {
  card: any | null;
  onClose: () => void;
  readOnly?: boolean;
  onToggleFavorite?: () => void;
  onSellAll?: () => void;
  onNavigateToCard?: (cardId: string) => void;
  /** Lista visible desde la que se abrió la carta (para navegar deslizando). */
  cards?: any[];
  /** Índice de `card` dentro de `cards`. */
  index?: number;
  /** Se pide moverse a otra posición de `cards`. */
  onIndexChange?: (index: number) => void;
}

/**
 * El color de la rareza sale de utils/rarityGlow.ts, la misma tabla que usa la
 * carta de la rejilla y el aura de la apertura de sobres. Aquí había una copia
 * con catorce entradas (menos que la original: faltaban las Shiny, la ACE
 * SPEC, las promos…) y con un juego de clases de Tailwind por rareza para el
 * chip —text-yellow-300 sobre bg-yellow-500/20—, que en tema claro daba
 * 1,10:1 de contraste: invisible. Ahora el chip se tiñe con el halo y el
 * texto es tinta (11,5:1 a 13,4:1 en claro, 9,4:1 a 12:1 en oscuro).
 */
const auraFor = (rarity?: string) => (rarity && RARITY_GLOW[rarity]) || null;

/** El mismo color del halo con otra opacidad (los halos son `rgba(r, g, b, a)`). */
const conAlfa = (rgba: string, alfa: number) => rgba.replace(/[\d.]+\)$/, `${alfa})`);

/* ------------------------------------------------------------------ */
/* ESTADO FÍSICO DE LA COPIA                                           */
/* ------------------------------------------------------------------ */

/**
 * El estado de la copia, y SÓLO si viene con la carta.
 *
 * La nota larga —por qué el cliente pinta lo que le llega y NO lo deduce, y por
 * qué eso es una regla de economía y no de estilo— está sobre la función
 * gemela de components/MazoCartas.tsx. El resumen: el desgaste es coherente con
 * la nota de graduación, así que enseñarlo en las copias buenas la delataría y
 * graduar dejaría de ser una apuesta. El servidor decide qué manda; aquí no se
 * llama nunca a `desperfectosDeCopia` ni a `notaDeCopia`.
 *
 * Este modal recibe cartas de la colección, del álbum y del bazar, y algunas
 * llegan del localStorage de un invitado: de ahí el `unknown` en utils/tipos.ts
 * y la comprobación de forma antes de pintar nada.
 */

/**
 * El desgaste en palabras. QUÉ HAY, NUNCA CUÁNTO.
 *
 * `firmaVisible` (utils/graduacion.ts) describe lo que el jugador puede
 * distinguir sin graduar, y el invariante de scripts/test-invariantes.mjs
 * agrupa las copias por esa descripción para exigir que ningún grupo compense
 * graduarlo. Allí los recuentos van por tramos, así que decir "6 piques" sería
 * enseñar más de lo que el invariante protege. Nombrar la clase de defecto es
 * más grueso que un tramo. El 1,5 % del descentrado es el mismo umbral que usa
 * `firmaVisible` para llamar "torcida" a una copia.
 */

export default function CardDetailModal({
  card,
  onClose,
  readOnly,
  onToggleFavorite,
  onSellAll,
  cards,
  index,
  onIndexChange,
}: CardDetailModalProps) {
  const { isSignedIn } = useUser();
  const [enriched, setEnriched] = useState<any | null>(null);
  const [loadingEnrich, setLoadingEnrich] = useState(false);
  const [wishlisted, setWishlisted] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const haptic = useHaptics();
  const toast = useToast();
  const detailsRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const imageColRef = useRef<HTMLDivElement>(null);
  /** Panel del diálogo: recibe el foco al abrir y atrapa el Tab. */
  const panelRef = useRef<HTMLDivElement>(null);
  /** Cerrojo del toggle de deseos: dos toques rápidos cruzaban dos peticiones
   *  cuyo orden de respuesta dejaba el marcador al revés. */
  const wishBusyRef = useRef(false);
  /** Contenedor de la carta que acompaña al dedo (translate + rotate, 2D). */
  const tiltRef = useRef<HTMLDivElement>(null);
  /** Vista de sólo la carta, a pantalla completa. */
  const [zoomed, setZoomed] = useState(false);
  /**
   * Id de la carta cuya imagen YA está cargada. La ilustración se funde a la
   * vista sólo cuando el navegador la tiene: sin esto, al navegar con red
   * lenta se veía un fotograma en blanco y luego un fundido sobre nada.
   */
  const [cargadaId, setCargadaId] = useState<string | null>(null);
  const marcarCargada = useCallback((id: string) => {
    setCargadaId((prev) => (prev === id ? prev : id));
  }, []);

  // El gesto de arrastre sólo existe en móvil; en md+ el diálogo sigue centrado.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // ── Navegación entre las cartas de la lista que abrió el modal ──────────
  const navList = cards ?? null;
  const navIndex =
    navList && typeof index === "number" && index >= 0 && index < navList.length
      ? index
      : -1;
  const hasNav = navIndex >= 0 && navList!.length > 1 && !!onIndexChange;
  const canPrev = hasNav && navIndex > 0;
  const canNext = hasNav && navIndex < navList!.length - 1;

  const goPrev = useCallback(() => {
    if (!canPrev) return;
    haptic("tap");
    onIndexChange?.(navIndex - 1);
  }, [canPrev, haptic, navIndex, onIndexChange]);

  const goNext = useCallback(() => {
    if (!canNext) return;
    haptic("tap");
    onIndexChange?.(navIndex + 1);
  }, [canNext, haptic, navIndex, onIndexChange]);

  // El gesto de cierre sale del asa, no del panel entero: si escuchara en todo
  // el panel se comería el scroll vertical de la columna de detalles y su
  // contenido por debajo del pliegue quedaría inalcanzable.
  useSwipe(handleRef, {
    axis: "y",
    threshold: CLOSE_OFFSET,
    velocity: CLOSE_VELOCITY,
    follow: false,
    enabled: isMobile && !!card,
    onSwipeDown: () => {
      haptic("tap");
      onClose();
    },
  });

  // Deslizar sobre la imagen cambia de carta. Va en la columna izquierda y no
  // en el panel de detalles para no robarle su scroll. En los extremos el
  // manejador queda sin definir y el hook aplica resistencia.
  /* ==================================================================== *
   * EL BALANCEO ES 2D, Y ES EL MISMO QUE EL DEL ÁLBUM
   * ====================================================================
   *
   * Aquí había un balanceo 3D pintado a mano: en cada movimiento se escribía
   * `perspective(900px) rotateY() rotateX()` sobre tiltRef, que es el PADRE de
   * la carta. Un `perspective` en un ancestro de la carta la manda a una capa
   * rasterizada a escala fija y en iPhone la ilustración salía borrosa
   * (la trampa documentada en components/PokemonCard.tsx:140-163). Y el
   * retorno se hacía con una transición de 0,55 s y un setTimeout(580) sin
   * guardar el id: dos arrastres seguidos hacían que el primer temporizador
   * borrara la transición a mitad del rebote del segundo y la carta saltaba
   * a su sitio en seco — la carta "pillada".
   *
   * Ahora lo pinta el propio hook con `follow` sobre tiltRef: translate más un
   * giro plano de 4° por cada 100 px, lo mismo que hace la ficha del álbum. El
   * hook guarda el id de su temporizador de retorno y lo cancela al empezar
   * cada gesto, así que el salto desaparece sin código extra aquí. Y sólo
   * escribe translate, rotate y un will-change que quita al soltar: nada que
   * rasterice la carta.
   */
  const imageSwipedRef = useSwipe(imageColRef, {
    axis: "x",
    threshold: NAV_OFFSET,
    velocity: NAV_VELOCITY,
    follow: true,
    followTarget: tiltRef,
    rotate: 4,
    resistance: 0.3,
    enabled: !!card,
    onSwipeLeft: canNext ? goNext : undefined,
    onSwipeRight: canPrev ? goPrev : undefined,
  });

  /** Los botones viven dentro de la zona del gesto: ignoran el click sintético. */
  const afterSwipeGuard = (fn?: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (imageSwipedRef.current) return;
    fn?.();
  };

  useEffect(() => {
    if (!card?.id || !isSignedIn) return;
    // Guardia de obsolescencia: al deslizar rápido entre cartas, la respuesta
    // de una carta anterior no debe pisar el marcador de la que se ve ahora.
    let cancelled = false;
    getWishlistIds()
      .then((ids: string[]) => { if (!cancelled) setWishlisted(ids.includes(card.id)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [card?.id, isSignedIn]);

  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [card, onClose]);

  // Flechas del teclado: el equivalente de escritorio al deslizamiento.
  // Va en su propio efecto para no reenganchar el de Escape (que guarda y
  // restaura el overflow del body) en cada render.
  useEffect(() => {
    if (!card || !hasNav) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") { e.preventDefault(); goPrev(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); goNext(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [card, hasNav, goPrev, goNext]);

  // Gestión del foco del diálogo. Sin esto, al abrir con Enter desde la rejilla
  // el foco se queda en la carta de fondo: Tab recorre la página tapada (con el
  // scroll bloqueado) y un lector de pantalla no entra en el diálogo pese al
  // aria-modal. Se ancla a la PRESENCIA del modal (no a la identidad de la
  // carta) para no re-enfocar al navegar entre cartas.
  const modalOpen = !!card;
  useEffect(() => {
    if (!modalOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    // Al cerrar, el foco vuelve al elemento que abrió el diálogo.
    return () => { previouslyFocused?.focus?.(); };
  }, [modalOpen]);

  /** Atrapa el Tab dentro del panel mientras el diálogo está abierto. */
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) { e.preventDefault(); panel.focus({ preventScroll: true }); return; }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || active === panel) { e.preventDefault(); last.focus(); }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const handleToggleWishlist = async () => {
    if (!card?.id) return;
    if (wishBusyRef.current) return;
    wishBusyRef.current = true;
    const prev = wishlisted;
    setWishlisted(!prev);
    try {
      const res: any = await toggleWishlist(card.id);
      // toast en vez de alert(): en la PWA instalada alert() muestra el dominio
      // en la cabecera nativa y congela la interacción.
      if (res?.error) { setWishlisted(prev); toast(res.error, "error"); }
      else if (typeof res?.wishlisted === "boolean") setWishlisted(res.wishlisted);
    } catch {
      setWishlisted(prev);
      toast("No se pudo actualizar deseos. Revisa tu conexión.", "error");
    } finally {
      wishBusyRef.current = false;
    }
  };

  useEffect(() => {
    setEnriched(null);
    if (!card?.id) return;
    setLoadingEnrich(true);
    // Sin guardia, abrir A y deslizar a B antes de que resuelva A hacía que
    // setEnriched(A) llegara mientras se muestra B (mergeCard rellenaba B con
    // datos de A). Descartamos toda respuesta que ya no corresponde a la carta.
    let cancelled = false;
    getCardFromDB(card.id)
      .then((db) => { if (!cancelled && db) setEnriched(db); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingEnrich(false); });
    return () => { cancelled = true; };
  }, [card?.id]);

  const isEmpty = (v: any) =>
    v == null ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) ||
    v === "";

  const mergeCard = (local: any, api: any) => {
    if (!api) return local;
    const out: any = { ...api, ...local };
    const richKeys = [
      "attacks", "weaknesses", "resistances", "retreatCost", "convertedRetreatCost",
      "types", "subtypes", "abilities", "rules", "ancientTrait",
      "legalities", "regulationMark", "cardmarket", "tcgplayer",
      "evolvesFrom", "evolvesTo", "nationalPokedexNumbers",
      "flavorText", "hp", "supertype", "level", "artist", "rarity", "number", "set", "images",
    ];
    richKeys.forEach((k) => {
      if (isEmpty(out[k]) && !isEmpty(api[k])) out[k] = api[k];
    });
    return out;
  };

  const c = card ? mergeCard(card, enriched) : null;
  const aura = auraFor(c?.rarity);
  /**
   * El estado sale de `c` y no de `card` porque `mergeCard` es quien decide qué
   * gana: la carta local manda sobre la enriquecida, así que el estado de LA
   * COPIA nunca lo pisa el modelo de la carta que devuelve la base de datos
   * (que no tiene copias, sólo cartas). No es un hook: es un objeto pequeño y
   * el modal pinta una carta, no una rejilla de trescientas.
   */
  const estado = c ? estadoDeCopia(c) : null;

  /* ==================================================================== *
   * EL VALOR DE VENTA, Y POR QUE ANTES MENTIA CON LAS GRADUADAS
   * ====================================================================
   *
   * Esto devolvia `SELL_PRICES[rareza]` a pelo, o sea la tarifa plana de la
   * rareza. Consecuencia: una carta graduada seguia diciendo 150 aunque le
   * hubiera salido un diez y valiera casi el doble. El jugador pagaba por
   * graduarla, veia la nota en la insignia... y el precio no se movia.
   *
   * Ahora salen las tres cosas que de verdad deciden lo que paga la tienda:
   *   · la tarifa de la rareza,
   *   · el ajuste por el precio real de Cardmarket, si el cron ya lo trajo,
   *   · y el multiplicador de la nota, si la carta esta graduada.
   *
   * `mejor_nota` la sirve getFullCollection (la nota mas alta de las copias
   * graduadas), y llega en snake_case porque esa consulta hace {...row}. */
  const notaGraduada = (() => {
    const n = Number((c as { mejor_nota?: unknown } | null)?.mejor_nota);
    return Number.isInteger(n) && n >= 1 && n <= 10 ? n : null;
  })();
  const precioBase = () => precioDeCartaSuelta(c?.rarity, (c as { precioEur?: number | null } | null)?.precioEur);
  const getMarketPrice = () =>
    notaGraduada ? valorGraduado(precioBase(), notaGraduada) : precioBase();
  const getTcgPrice = (): number | null => {
    const p = c?.tcgplayer?.prices;
    if (!p) return null;
    return p.holofoil?.market ?? p.holofoil?.mid ?? p.normal?.market ?? p.normal?.mid ?? p.reverseHolofoil?.market ?? p.reverseHolofoil?.mid
      ?? (Object.keys(p)[0] ? (p[Object.keys(p)[0]].market ?? p[Object.keys(p)[0]].mid) : null);
  };

  return (
    <>
      <Portal>
      <AnimatePresence>
      {c && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] flex items-end justify-center md:items-center md:p-6"
          onClick={onClose}
        >
          {/* El telón, con el desenfoque, es HERMANO del panel y no la raíz.
              Antes el backdrop-blur iba en la raíz, que es ancestro del panel
              y de la carta: un backdrop-filter en un ancestro rasteriza la
              carta a escala fija y en iPhone salía borrosa. Como hermano
              absoluto detrás del panel desenfoca la página de fondo y no
              toca nada de lo que hay encima. Mismo --scrim que Sheet. */}
          <div
            aria-hidden="true"
            className="absolute inset-0 backdrop-blur-md"
            style={{ background: "var(--scrim)" }}
          />
          <motion.div
            ref={panelRef}
            tabIndex={-1}
            onKeyDown={trapTab}
            role="dialog"
            aria-modal="true"
            aria-label={`Detalle de ${c.name}`}
            /* En md+ el diálogo entra con opacidad y un desplazamiento corto,
               nunca con `scale`: el panel es ancestro de la carta y una escala
               —aunque sea transitoria— la rasteriza a otro tamaño y queda
               borrosa hasta que el navegador la repinta. */
            initial={isMobile ? { y: "100%" } : { opacity: 0, y: 12 }}
            animate={isMobile ? { y: 0 } : { opacity: 1, y: 0 }}
            exit={isMobile ? { y: "100%" } : { opacity: 0, y: 12 }}
            transition={
              isMobile
                ? { type: "spring", stiffness: 380, damping: 38, mass: 0.9 }
                : { duration: 0.3, ease: [0.16, 1, 0.3, 1] }
            }
            /* Móvil: hoja inferior que se cierra arrastrando el asa (useSwipe).
               md+: diálogo centrado, sin gesto. */
            className="relative w-full max-w-5xl bg-[var(--surface)] overflow-hidden border border-[var(--border)] shadow-2xl flex flex-col md:flex-row"
            style={{
              borderRadius: isMobile ? "28px 28px 0 0" : "1.5rem",
              /**
               * El alto disponible se publica como variable para que la imagen
               * se mida CONTRA EL PANEL y no contra el viewport.
               *
               * Antes el panel se limitaba con --app-height (el alto real,
               * medido) pero la imagen con 40vh/68vh. En iOS `vh` es el
               * viewport grande, con la barra de Safari oculta, así que la
               * imagen se calculaba sobre un alto que no existía y empujaba al
               * resto: de ahí que a veces no cuadrara nada.
               */
              ["--panel-max" as string]: isMobile
                ? "calc(var(--app-height) - var(--sat) - 12px)"
                : "min(92vh, calc(var(--app-height) - 48px))",
              maxHeight: "var(--panel-max)",
              // Con el teclado desplegado ya no hay barra de gestos que esquivar.
              paddingBottom: isMobile
                ? "max(0px, calc(var(--sab) - var(--keyboard)))"
                : undefined,
            }}
            data-lenis-prevent
            onClick={(e) => e.stopPropagation()}
          >
            {/* Asa del gesto (sólo móvil): es el único punto que inicia el
                arrastre, con una zona táctil holgada alrededor. */}
            {isMobile && (
              <div
                ref={handleRef}
                role="button"
                aria-label="Arrastra hacia abajo para cerrar"
                className="absolute top-0 left-1/2 -translate-x-1/2 z-50 flex h-7 w-24 cursor-grab items-center justify-center active:cursor-grabbing"
                style={{ touchAction: touchActionFor("y") }}
              >
                <div
                  className="h-1.5 w-11 rounded-full"
                  style={{ background: "var(--border-strong)" }}
                />
              </div>
            )}

            {/* Resplandor de la rareza en la esquina. Es un degradado radial,
                que ya es suave por sí mismo: llevaba además un blur(64px)
                PERMANENTE, y un filtro que vive todo el rato le cuesta caro
                al iPhone aunque sea en una capa hermana. */}
            {aura && (
              <div
                className="absolute -top-32 -right-32 w-80 h-80 rounded-full pointer-events-none opacity-60"
                style={{ background: `radial-gradient(circle, ${aura}, transparent 70%)` }}
              />
            )}

            {/* CLOSE */}
            <button
              onClick={onClose}
              className="absolute top-3 right-3 md:top-4 md:right-4 w-9 h-9 flex items-center justify-center z-50 btn-ghost rounded-full transition press"
              aria-label="Cerrar"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>

            {/* LEFT — CARD IMAGE PANEL */}
            {/* shrink-0: la caja de la carta es fija; si esta columna pudiera
                encogerse al competir con la ficha, la carta desbordaría sobre
                ella. El pb-12 reserva sitio para el contador de posición, que
                antes quedaba montado sobre la carta. */}
            <div
              ref={imageColRef}
              className={`relative w-full md:w-[44%] shrink-0 p-5 md:p-8 pt-14 md:pt-10 ${hasNav ? "pb-12" : ""} flex items-center justify-center`}
              style={{
                background: aura
                  ? `radial-gradient(circle at 50% 35%, ${conAlfa(aura, 0.18)}, transparent 70%), var(--surface-2)`
                  : "var(--surface-2)",
                // "pan-y": el gesto horizontal es nuestro y el scroll vertical
                // sigue siendo del navegador. El zoom vive en CardZoom.
                touchAction: hasNav ? touchActionFor("x") : undefined,
              }}
            >
              {/* Floating action buttons */}
              <div className="absolute top-4 left-4 z-40 flex flex-col gap-2">
                {/* Los estados activos siguen la regla del tema: el RELLENO
                    lleva el color de marca (--danger / --warn, rebajados) y
                    la TINTA es su versión legible (--danger-ink / --warn-ink).
                    Con text-rose-300 sobre rose-500/25 el corazón daba
                    2,5:1 en tema claro; ahora 5,1:1 y 4,9:1. */}
                {!readOnly && onToggleFavorite && (
                  <button
                    onClick={afterSwipeGuard(onToggleFavorite)}
                    className={`w-10 h-10 rounded-full border transition flex items-center justify-center press ${
                      c.is_favorite ? "" : "btn-ghost ink-soft hover:ink"
                    }`}
                    style={c.is_favorite ? ESTILO_FAVORITO : undefined}
                    aria-label="Favorito"
                  >
                    <Heart filled={c.is_favorite} />
                  </button>
                )}
                {readOnly && c.is_favorite && (
                  <div
                    className="w-10 h-10 rounded-full border flex items-center justify-center"
                    style={ESTILO_FAVORITO}
                  >
                    <Heart filled />
                  </div>
                )}
                {isSignedIn && (
                  <button
                    onClick={afterSwipeGuard(handleToggleWishlist)}
                    className={`w-10 h-10 rounded-full border transition flex items-center justify-center press ${
                      wishlisted ? "" : "btn-ghost ink-soft hover:ink"
                    }`}
                    style={wishlisted ? ESTILO_DESEADA : undefined}
                    aria-label="Deseos"
                    title={wishlisted ? "Quitar de deseos" : "Añadir a deseos"}
                  >
                    <svg viewBox="0 0 24 24" fill={wishlisted ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Caja de proporción FIJA de carta (2.5/3.5). Las imágenes de
                  la API no comparten proporción exacta: sueltas, cada carta
                  medía distinto y navegar recolocaba todo el panel. El ancho
                  deriva del alto del panel (--panel-max, nunca vh): la caja es
                  idéntica para todas las cartas. */}
              {/* En móvil la carta se lleva la mitad del alto del panel (antes
                  el 42 %): esta ficha es ahora también la del álbum, que
                  enseñaba la carta más grande, y el dueño quiere un solo
                  tamaño. La ficha de debajo sigue haciendo scroll. */}
              <div
                className="relative w-full"
                style={{
                  maxWidth: isMobile
                    ? "calc(var(--panel-max) * 0.5 * 0.715)"
                    : "calc(var(--panel-max) * 0.82 * 0.715)",
                }}
              >
                {/* Halo de rareza: capa HERMANA de la carta (nunca ancestro) y
                    absoluta, para que no empuje el layout. Es un box-shadow
                    con el color del halo y no un div con blur(40px): un
                    filtro permanente, aunque sea en un hermano, se paga en
                    cada fotograma en iPhone; la sombra la pinta la GPU sin
                    rasterizar nada. Con la silueta de la carta (mismo radio)
                    para que el resplandor salga de sus cantos. */}
                {aura && (
                  <div
                    aria-hidden="true"
                    className="absolute inset-0 rounded-[4.5%] pointer-events-none"
                    style={{ boxShadow: `0 0 48px 14px ${aura}` }}
                  />
                )}
                <div ref={tiltRef} className="relative w-full aspect-[2.5/3.5]">
                  {/* AnimatePresence + onLoad: la imagen entra cuando ESTÁ,
                      no cuando se monta. Antes el <img> se remontaba por `key`
                      y arrancaba su fundido en el acto: con red lenta, un
                      fotograma en blanco y un fundido sobre nada. Ahora la
                      carta anterior se retira mientras la nueva se queda
                      transparente hasta que el navegador la tiene, y sólo
                      entonces se funde. Y sólo opacidad, nunca `scale`: la
                      escala rasteriza la ilustración a otro tamaño. */}
                  <AnimatePresence initial={false}>
                  <motion.div
                    key={c.id}
                    className="absolute inset-0"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: cargadaId === c.id ? 1 : 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                  >
                  {(() => {
                    const imagen = (
                      <img
                        // Con la imagen en caché el `load` también dispara,
                        // pero si el elemento ya está completo al montarse se
                        // marca aquí y no se espera a nadie.
                        ref={(el) => {
                          if (el && el.complete && el.naturalWidth > 0) marcarCargada(c.id);
                        }}
                        onLoad={() => marcarCargada(c.id)}
                        // Si la imagen falla, que al menos se vea el texto
                        // alternativo y no un hueco transparente para siempre.
                        onError={() => marcarCargada(c.id)}
                        src={c.images?.large}
                        alt={c.name}
                        loading="eager"
                        onClick={(e) => {
                          e.stopPropagation();
                          // Un arrastre acaba en click sintético: no abrir el zoom.
                          if (imageSwipedRef.current) return;
                          haptic("tap");
                          setZoomed(true);
                        }}
                        // Sombra con box-shadow y no drop-shadow: un filter
                        // sobre la carta la rasterizaría.
                        style={{ borderRadius: "4.5%", boxShadow: "var(--shadow-lg)" }}
                        /* `cover` y no `contain`, por lo mismo que en
                           components/PokemonCard.tsx (allí está la cuenta
                           entera): el hueco es aspect-[2.5/3.5] = 0,71429, la
                           proporción FÍSICA de una carta, y ningún escaneo de
                           la API la tiene — las modernas son 734x1024 (0,71680)
                           y las de 1999-2009, 600x825 (0,72727). Con `contain`
                           quedaba banda arriba y abajo. Medido en catorce
                           expansiones: ninguna imagen es más estrecha de
                           proporción que el hueco, así que el recorte es
                           siempre lateral y nunca se come el nombre ni los PS.

                           AQUÍ ADEMÁS ARREGLA UNA SEGUNDA COSA que en la
                           rejilla no se notaba: la capa de DesperfectosCarta se
                           posiciona con `absolute inset-0`, o sea contra el
                           CONTENEDOR. Con `contain` la imagen no llenaba el
                           contenedor, así que los piques y los arañazos caían
                           unos píxeles desplazados respecto a la ilustración
                           sobre la que dicen estar. Con `cover` las dos cajas
                           son la misma y las marcas caen donde tienen que caer. */
                        className="absolute inset-0 h-full w-full cursor-zoom-in object-cover"
                      />
                    );
                    // Copia limpia: el árbol se queda EXACTAMENTE como estaba.
                    // La rama de abajo mete dos divs entre el balanceo y la
                    // imagen, y no hay razón para que los pague el 95% de las
                    // cartas que no tienen nada que enseñar.
                    if (!estado) return imagen;
                    return (
                      /* Marco + tira, el mismo montaje que
                         components/graduacion/CartaConDesperfectos.tsx: el
                         descentrado no se pinta, se MUEVE la ilustración dentro
                         del marco y el marco recorta; por el lado del que se
                         retira asoma el cartón, que es el fondo. `translate` y
                         nunca `scale`, que rasterizaría la capa.
                         La sombra sube al marco: la de la imagen queda dentro
                         del overflow-hidden y no se vería. */
                      <div
                        className="absolute inset-0 overflow-hidden rounded-[4.5%]"
                        style={{
                          background: "var(--surface-2)",
                          boxShadow: "var(--shadow-lg)",
                        }}
                      >
                        <div
                          className="absolute inset-0"
                          style={estiloDescentrado(estado.desperfectos)}
                        >
                          {imagen}
                        </div>
                        <DesperfectosCarta
                          desperfectos={estado.desperfectos}
                          marcas={estado.marcas}
                        />
                      </div>
                    );
                  })()}
                  </motion.div>
                  </AnimatePresence>

                  {/* Carta que NO se posee (llega así desde el buscador
                      global): un velo HERMANO del color del papel, con
                      opacidad, en vez de `grayscale` sobre la propia imagen.
                      Un filter sobre la carta la rasteriza y en iPhone sale
                      borrosa; el velo apaga la ilustración igual y no toca
                      la capa de la imagen. */}
                  {c.owned === false && (
                    <div
                      aria-hidden="true"
                      className="absolute inset-0 rounded-[4.5%] pointer-events-none"
                      style={{ background: "var(--surface)", opacity: 0.55 }}
                    />
                  )}

                  {/* AQUÍ ESTABA LA INSIGNIA "ESTADO: DAÑADA", y no vuelve.
                      Las marcas se siguen pintando arriba: lo que se ha
                      quitado es el rótulo que las nombraba, no el desgaste.
                      El porqué entero está escrito unas líneas más abajo,
                      donde estaba el panel "Estado de la copia"; léelo antes
                      de reponer ninguna de las dos cosas. */}
                </div>
              </div>

              {/* Navegación explícita, para quien no descubra el gesto.
                  transform-gpu: mientras se arrastra, la carta lleva un
                  will-change y Safari la compone en capa propia por encima
                  del z-index normal; con capa propia estos controles nunca
                  quedan tapados por ella. (Va en los botones, que no son
                  ancestros de la carta: a ellos sí se les puede promover.) */}
              {hasNav && (
                <>
                  <button
                    onClick={afterSwipeGuard(goPrev)}
                    disabled={!canPrev}
                    aria-label="Carta anterior"
                    className="absolute left-2 top-1/2 -translate-y-1/2 z-40 transform-gpu w-10 h-10 rounded-full btn-ghost press flex items-center justify-center disabled:opacity-25 disabled:cursor-not-allowed"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                      <path d="m15 18-6-6 6-6" />
                    </svg>
                  </button>
                  <button
                    onClick={afterSwipeGuard(goNext)}
                    disabled={!canNext}
                    aria-label="Carta siguiente"
                    className="absolute right-2 top-1/2 -translate-y-1/2 z-40 transform-gpu w-10 h-10 rounded-full btn-ghost press flex items-center justify-center disabled:opacity-25 disabled:cursor-not-allowed"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </button>
                  {/* Contador en el hueco reservado bajo la carta (pb-12):
                      misma fila de posición que la hoja del álbum. */}
                  <span
                    aria-hidden="true"
                    className="absolute bottom-3 left-1/2 -translate-x-1/2 z-40 transform-gpu chip ink-soft text-[11px] px-3 py-1 rounded-full tnum pointer-events-none"
                  >
                    {navIndex + 1} de {navList!.length}
                  </span>
                </>
              )}
            </div>

            {/* RIGHT — DETAILS */}
            {/* min-h-0 explícito: sin él, algunos motores no dejan encoger la
                columna dentro del panel (overflow-hidden) y la fila del pie se
                recorta en vez de quedar alcanzable con scroll. */}
            <div
              ref={detailsRef}
              className="w-full md:w-[56%] min-h-0 flex flex-col bg-[var(--surface)] scroll-area custom-scrollbar relative"
              data-lenis-prevent
            >
              <div className="p-5 md:p-7 pb-7 md:pb-8 flex flex-col gap-4 relative">
                {/* HEADER */}
                <div>
                  {/* Rótulos de 9-11 px en ink-soft, no en ink-faint: a ese
                      tamaño la tinta tenue (3,66:1) no llega al mínimo. */}
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-[10px] uppercase tracking-[0.25em] ink-soft font-semibold">{c.supertype || "Pokémon"}</span>
                    {c.subtypes?.slice(0, 3).map((s: string) => (
                      <span key={s} className="text-[10px] uppercase tracking-wider ink-soft chip px-2 py-0.5">{s}</span>
                    ))}
                    {/* Fondo teñido con el halo de la rareza, texto en tinta. */}
                    {c.rarity && aura && (
                      <span
                        className="text-[10px] uppercase tracking-wider font-semibold border rounded-full px-2 py-0.5 ink"
                        style={{ background: conAlfa(aura, 0.18), borderColor: conAlfa(aura, 0.4) }}
                      >
                        {c.rarity}
                      </span>
                    )}
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="text-2xl md:text-4xl font-bold tracking-tight">{c.name}</h2>
                    {c.hp && (
                      <span className="font-mono text-base md:text-lg font-bold shrink-0" style={{ color: "var(--danger-ink)" }}>HP {c.hp}</span>
                    )}
                  </div>
                  {c.types?.length > 0 && (
                    <div className="flex gap-1.5 mt-3 flex-wrap">
                      {c.types.map((t: string) => <TypeBadge key={t} type={t} />)}
                    </div>
                  )}
                </div>

                {/* ==================================================== *
                 * AQUÍ ESTABA EL PANEL "ESTADO DE LA COPIA". NO VUELVE.
                 * ====================================================
                 *
                 * Decía «Dañada. Se le ven piques en los cantos, arañazos»
                 * debajo del nombre, y arriba, sobre la ilustración, iba la
                 * insignia corta "Estado: dañada" (también quitada). Las dos
                 * se han ido a petición del dueño del juego: «cuando una
                 * carta esté dañada no quiero que se me informe de ninguna
                 * manera, sólo cuando esté graduada». LAS MARCAS PINTADAS SE
                 * QUEDAN — se le preguntó expresamente y eligió que sí.
                 *
                 * PERO EL MOTIVO DE FONDO NO ES EL GUSTO, ES QUE EL TEXTO
                 * MENTÍA, y por eso no puede volver ni siquiera "sólo si la
                 * carta está graduada":
                 *
                 *   · `desperfectos`/`marcas` los pone estadoDeLaMejorCopia()
                 *     (app/action.ts), que recorre las copias 1..N y devuelve
                 *     el desgaste de la de NOTA MÁS ALTA.
                 *   · `mejor_nota` sale de un LEFT JOIN con graded_cards en
                 *     getFullCollection: el máximo de las copias GRADUADAS
                 *     activas. Y se gradúan las copias LIBRES MÁS BAJAS, por
                 *     índice y sin mirar la nota (app/action.ts, el bucle de
                 *     graduarCartasAction).
                 *
                 * Los dos criterios son opuestos, así que casi nunca es la
                 * misma copia.
                 *
                 * OJO AL EJEMPLO, PORQUE AQUÍ HUBO UNO MAL Y CONVIENE NO
                 * REPETIRLO: el caso que se escribió primero era «notas 4, 9 y
                 * 10, graduada la copia 1: la ficha decía GEM MINT 10 sobre los
                 * piques de otra». ESE CASO NO EXISTE, por dos motivos
                 * independientes. Si la única graduada es la del 4, la insignia
                 * dice 4 y no 10, porque `mejor_nota` es el MÁXIMO de las
                 * graduadas. Y si existiera una copia de nota 10, el desgaste
                 * que se pinta sería el suyo — y un 10 no tiene ni un pique
                 * (TOPE_PIQUES[10] = [0,0] en utils/graduacion.ts), así que
                 * `estadoDeCopia` devuelve null y no se pinta nada. «GEM MINT
                 * 10 sobre una carta con piques» no puede pasar.
                 *
                 * EL CASO REAL ES MÁS PEQUEÑO, PERO ES REAL: dos copias, notas
                 * 3 y 6, graduada la copia 1 (la del 3). Se pinta el desgaste
                 * del 6 —4 a 7 piques, sin manchas ni decoloración— y el panel
                 * decía «Dañada. Se le ven piques en los cantos» junto a la
                 * insignia de un 3, cuya copia real tiene de 10 a 16 piques,
                 * manchas y decoloración. Desgaste de la copia A con la nota de
                 * la copia B: la mentira es de grado, no de existencia, y sigue
                 * siendo la peor clase — la que parece un dato.
                 *
                 * En general se cumple que `mejor_nota` <= la nota de la copia
                 * cuyo desgaste se pinta, porque graduar no baja `quantity` y
                 * el barrido cubre 1..min(quantity, 60). O sea que el error
                 * siempre va en la misma dirección: la insignia enseña una nota
                 * PEOR que la copia que se está viendo. (Hay dos desajustes
                 * más: el barrido para a las 60 copias y el JOIN sólo cuenta
                 * estado='activa'.)
                 *
                 * DÓNDE SÍ ESTÁN EMPAREJADOS, por si lo que buscas es enseñar
                 * el desgaste de una copia graduada: en /graduacion. Allí
                 * getVitrina() calcula la semilla y los desperfectos FILA A
                 * FILA de graded_cards, con la nota de esa misma fila, y ya lo
                 * dice en texto (components/graduacion/Revelacion.tsx). Ése es
                 * el sitio, y ya está hecho: no hay nada que reponer aquí.
                 *
                 * CONSECUENCIA DE ACCESIBILIDAD, Y ES DELIBERADA: este panel
                 * era la ÚNICA vía textual del estado en el detalle. La
                 * insignia iba aria-hidden y la capa de DesperfectosCarta
                 * también lo va. Sin él, las marcas quedan como DECORACIÓN
                 * PURA y un lector de pantalla no se entera de nada.
                 *
                 * ESO ES LO PEDIDO. Si has llegado hasta aquí pensando que
                 * falta un `aria-label` o un `title` que lo cuente: no falta,
                 * se quitó a propósito, y reponerlo deshace el encargo y
                 * vuelve a emparejar el desgaste de una copia con la nota de
                 * otra. No lo pongas sin volver a preguntar al dueño. */}

                {/* PRICES */}
                {/* --ok y no --accent para el dinero: --accent es color de
                    marca y sobre el papel claro da 2,4:1 (app/globals.css lo
                    avisa); --ok es su versión de tinta, 6,1:1. */}
                <div className="grid grid-cols-2 gap-2">
                  <PriceTile
                    label={notaGraduada ? `Valor · ${etiquetaNota(notaGraduada)}` : "Valor de venta"}
                    value={`${getMarketPrice()}`}
                    unit="💰"
                    color="var(--ok)"
                  />
                  {(() => {
                    const tcg = getTcgPrice();
                    return (
                      <PriceTile label="Valor real" value={tcg != null ? `$${tcg.toFixed(2)}` : "—"} color={tcg != null ? "var(--ink)" : "var(--ink-soft)"} />
                    );
                  })()}
                </div>

                {/* SELL CTA */}
                {/* El importe sale de valorDeVenta, la misma función que cobra el
                    servidor: el precio por copia baja con las copias que tienes, así
                    que "repetidas × tarifa" prometía más de lo que se acaba pagando. */}
                {!readOnly && c.quantity > 1 && onSellAll && (
                  <button
                    onClick={onSellAll}
                    className="btn-accent press w-full py-3 rounded-2xl font-semibold text-sm"
                  >
                    Vender {c.quantity - 1} repetida{c.quantity - 1 > 1 ? "s" : ""} · +{valorDeVenta(c.rarity, c.quantity)} 💰
                  </button>
                )}
                {readOnly && c.quantity != null && (
                  <div className="text-center text-[11px] uppercase tracking-wider ink-soft">
                    {c.quantity > 1 ? `Posee ${c.quantity} copias` : "Copia única"}
                  </div>
                )}

                {/* ABILITIES. El fondo malva se queda (un relleno puede ser
                    de color); el rótulo va en tinta, que text-purple-400
                    daba 2,6:1 en claro. */}
                {c.abilities?.length > 0 && (
                  <div className="bg-gradient-to-br from-purple-500/10 to-transparent border border-purple-500/20 rounded-2xl p-4">
                    <p className="ink-soft text-[10px] font-semibold uppercase tracking-wider mb-3">Habilidades</p>
                    <div className="flex flex-col gap-3">
                      {c.abilities.map((ab: any, i: number) => (
                        <div key={i}>
                          <span className="text-sm font-semibold">{ab.name}</span>
                          <p className="text-[12px] ink-soft leading-relaxed mt-0.5">{ab.text}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ATTACKS */}
                {c.attacks?.length > 0 && (
                  <div className="surface-2 rounded-2xl overflow-hidden">
                    <p className="ink-soft text-[10px] font-semibold uppercase tracking-wider px-4 pt-3">Ataques</p>
                    <div className="flex flex-col divide-y divide-[var(--border)]">
                      {c.attacks.map((atk: any, i: number) => (
                        <div key={i} className="p-4 flex flex-col gap-2">
                          <div className="flex items-center gap-3">
                            <div className="shrink-0"><EnergyCost cost={atk.cost || []} /></div>
                            <span className="text-sm font-semibold truncate flex-1">{atk.name}</span>
                            {atk.damage && <span className="text-base font-mono font-bold shrink-0" style={{ color: "var(--danger-ink)" }}>{atk.damage}</span>}
                          </div>
                          {atk.text && <p className="text-[12px] ink-soft leading-snug">{atk.text}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* WEAK / RES / RETREAT */}
                <div className="grid grid-cols-3 gap-2">
                  <StatTile label="Debilidad">
                    {c.weaknesses?.length > 0
                      ? c.weaknesses.map((w: any, i: number) => (
                          <div key={i} className="flex items-center gap-1">
                            <TypeBadge type={w.type} size="xs" />
                            <span className="text-[11px] font-semibold" style={{ color: "var(--danger-ink)" }}>{w.value}</span>
                          </div>
                        ))
                      : <span className="ink-faint text-xs">—</span>}
                  </StatTile>
                  <StatTile label="Resistencia">
                    {c.resistances?.length > 0
                      ? c.resistances.map((w: any, i: number) => (
                          <div key={i} className="flex items-center gap-1">
                            <TypeBadge type={w.type} size="xs" />
                            <span className="text-[11px] font-semibold" style={{ color: "var(--ok)" }}>{w.value}</span>
                          </div>
                        ))
                      : <span className="ink-faint text-xs">—</span>}
                  </StatTile>
                  <StatTile label="Retirada">
                    {c.retreatCost?.length > 0
                      ? <EnergyCost cost={c.retreatCost} />
                      : <span className="ink-faint text-xs">—</span>}
                  </StatTile>
                </div>

                {/* FOOTER compacto: set + número + artista */}
                {c.set && (
                  <div className="border-t border-[var(--border)] pt-4 mt-1 flex items-center gap-3">
                    {c.set.images?.logo && (
                      <img src={c.set.images.logo} alt="" loading="lazy" className="h-7 object-contain opacity-90" />
                    )}
                    <div className="flex-1 min-w-0 text-[11px]">
                      <p className="font-medium truncate">{c.set.name}</p>
                      <p className="ink-soft font-mono">
                        #{c.number || "—"}{c.set.printedTotal ? `/${c.set.printedTotal}` : ""}
                        {c.artist ? ` · ${c.artist}` : ""}
                      </p>
                    </div>
                  </div>
                )}

                {loadingEnrich && (
                  <p className="text-[9px] ink-soft uppercase tracking-wider animate-pulse text-center">Cargando detalles…</p>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
      </AnimatePresence>
      </Portal>

      {/* Sólo la carta, a pantalla completa.

          EL ESTADO VIAJA AL ZOOM. Hasta ahora CardZoom recibía una URL y nada
          más, así que la carta ampliada salía IMPECABLE aunque la rejilla y
          esta misma ficha la estuvieran enseñando con piques: ampliar una
          carta dañada la "curaba". Es el mismo `estado` que se pinta arriba
          (el de la mejor copia, calculado en el servidor), y va suelto en dos
          props opcionales para que el otro sitio que abre el visor —el
          catálogo de app/album/[setId], donde no hay copia y por tanto no hay
          desgaste— no tenga que cambiar ni enterarse. */}
      <CardZoom
        open={zoomed && !!c}
        src={c?.images?.large}
        alt={c?.name}
        caption={c?.name}
        desperfectos={estado?.desperfectos}
        marcas={estado?.marcas}
        onClose={() => setZoomed(false)}
        onPrev={canPrev ? goPrev : undefined}
        onNext={canNext ? goNext : undefined}
      />
    </>
  );
}

function Heart({ filled }: { filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" className="w-4 h-4">
      <path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 5.5 5.5 5.5 0 0 1 21.5 12c-2.5 4.5-9.5 9-9.5 9z" />
    </svg>
  );
}

/**
 * Estados activos de los botones flotantes: relleno con el color de marca
 * rebajado y tinta legible encima (ver la regla junto a --danger-ink en
 * app/globals.css). Fuera del componente para no crear los objetos en cada
 * render.
 */
const ESTILO_FAVORITO: React.CSSProperties = {
  background: "color-mix(in srgb, var(--danger) 20%, var(--surface))",
  borderColor: "color-mix(in srgb, var(--danger) 45%, transparent)",
  color: "var(--danger-ink)",
};
const ESTILO_DESEADA: React.CSSProperties = {
  background: "color-mix(in srgb, var(--warn) 20%, var(--surface))",
  borderColor: "color-mix(in srgb, var(--warn) 45%, transparent)",
  color: "var(--warn-ink)",
};

/** `color` es un color CSS (un token del tema), no una clase de Tailwind. */
function PriceTile({ label, value, unit, color }: { label: string; value: string; unit?: string; color: string }) {
  return (
    <div className="surface-2 rounded-2xl px-3 py-2.5">
      <p className="text-[9px] uppercase tracking-wider ink-soft font-semibold">{label}</p>
      <p className="text-base md:text-lg font-bold tabular-nums leading-tight mt-0.5" style={{ color }}>
        {value}{unit && <span className="text-xs ml-1">{unit}</span>}
      </p>
    </div>
  );
}

function StatTile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="surface-2 rounded-2xl p-3">
      <p className="text-[9px] uppercase tracking-wider ink-soft font-semibold mb-1.5">{label}</p>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}
