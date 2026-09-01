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

// Halo / acento por rareza
const RARITY_AURA: Record<string, { halo: string; chip: string }> = {
  "Hyper Rare":               { halo: "rgba(250,204,21,0.55)",  chip: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30" },
  "Rare Secret":              { halo: "rgba(250,204,21,0.45)",  chip: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30" },
  "Rare Rainbow":             { halo: "rgba(244,114,182,0.55)", chip: "bg-pink-500/20 text-pink-300 border-pink-500/30" },
  "Special Illustration Rare":{ halo: "rgba(217,70,239,0.5)",   chip: "bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30" },
  "Illustration Rare":        { halo: "rgba(168,85,247,0.45)",  chip: "bg-purple-500/20 text-purple-300 border-purple-500/30" },
  "Shiny Ultra Rare":         { halo: "rgba(56,189,248,0.5)",   chip: "bg-sky-500/20 text-sky-300 border-sky-500/30" },
  "Ultra Rare":               { halo: "rgba(99,102,241,0.5)",   chip: "bg-indigo-500/20 text-indigo-300 border-indigo-500/30" },
  "Rare Ultra":               { halo: "rgba(99,102,241,0.5)",   chip: "bg-indigo-500/20 text-indigo-300 border-indigo-500/30" },
  "Rare Holo VSTAR":          { halo: "rgba(34,211,238,0.5)",   chip: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30" },
  "Rare Holo VMAX":           { halo: "rgba(244,63,94,0.5)",    chip: "bg-rose-500/20 text-rose-300 border-rose-500/30" },
  "Double Rare":              { halo: "rgba(96,165,250,0.4)",   chip: "bg-blue-500/20 text-blue-300 border-blue-500/30" },
  "Rare Holo V":              { halo: "rgba(96,165,250,0.4)",   chip: "bg-blue-500/20 text-blue-300 border-blue-500/30" },
  "Rare Holo":                { halo: "rgba(250,204,21,0.3)",   chip: "bg-yellow-500/15 text-yellow-300 border-yellow-500/25" },
  "Radiant Rare":             { halo: "rgba(251,146,60,0.4)",   chip: "bg-orange-500/20 text-orange-300 border-orange-500/30" },
};
const auraFor = (rarity?: string) => (rarity && RARITY_AURA[rarity]) || null;

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
  /** Contenedor de la carta que recibe el balanceo 3D. */
  const tiltRef = useRef<HTMLDivElement>(null);
  /** Vista de sólo la carta, a pantalla completa. */
  const [zoomed, setZoomed] = useState(false);

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
  /**
   * Balanceo 3D de la carta mientras se arrastra: la carta gira sobre su eje
   * vertical siguiendo al dedo, como si la sostuvieras. Se pinta a mano en vez
   * de con el `follow` del hook porque eso sólo hace traslación y giro plano.
   */
  const applyTilt = useCallback((dx: number, dy: number) => {
    const el = tiltRef.current;
    if (!el) return;
    const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v));
    const rotY = clamp(dx * 0.2, 26);
    const rotX = clamp(-dy * 0.12, 14);
    el.style.transition = "";
    el.style.transform = `perspective(900px) rotateY(${rotY}deg) rotateX(${rotX}deg) translateX(${dx * 0.3}px)`;
  }, []);

  /** Al soltar vuelve al centro con un rebote: de ahí el balanceo. */
  const resetTilt = useCallback(() => {
    const el = tiltRef.current;
    if (!el) return;
    el.style.transition = "transform 0.55s cubic-bezier(0.22, 1.35, 0.36, 1)";
    el.style.transform = "";
    window.setTimeout(() => {
      if (el) el.style.transition = "";
    }, 580);
  }, []);

  const imageSwipedRef = useSwipe(imageColRef, {
    axis: "x",
    threshold: NAV_OFFSET,
    velocity: NAV_VELOCITY,
    // El movimiento lo pinta applyTilt, no el hook.
    follow: false,
    enabled: !!card,
    onMove: applyTilt,
    onEnd: resetTilt,
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
          className="fixed inset-0 z-[100] flex items-end justify-center md:items-center bg-black/85 backdrop-blur-md md:p-6"
          onClick={onClose}
        >
          <motion.div
            ref={panelRef}
            tabIndex={-1}
            onKeyDown={trapTab}
            role="dialog"
            aria-modal="true"
            aria-label={`Detalle de ${c.name}`}
            initial={isMobile ? { y: "100%" } : { scale: 0.97, opacity: 0, y: 8 }}
            animate={isMobile ? { y: 0 } : { scale: 1, opacity: 1, y: 0 }}
            exit={isMobile ? { y: "100%" } : { scale: 0.97, opacity: 0 }}
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

            {/* Ambient glow per rarity */}
            {aura && (
              <div
                className="absolute -top-32 -right-32 w-80 h-80 rounded-full pointer-events-none opacity-60 blur-3xl"
                style={{ background: `radial-gradient(circle, ${aura.halo}, transparent 70%)` }}
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
                  ? `radial-gradient(circle at 50% 35%, ${aura.halo.replace(/[\d.]+\)$/, "0.18)")}, transparent 70%), var(--surface-2)`
                  : "var(--surface-2)",
                // "pan-y": el gesto horizontal es nuestro y el scroll vertical
                // sigue siendo del navegador. El zoom vive en CardZoom.
                touchAction: hasNav ? touchActionFor("x") : undefined,
              }}
            >
              {/* Floating action buttons */}
              <div className="absolute top-4 left-4 z-40 flex flex-col gap-2">
                {!readOnly && onToggleFavorite && (
                  <button
                    onClick={afterSwipeGuard(onToggleFavorite)}
                    className={`w-10 h-10 rounded-full border transition flex items-center justify-center press ${
                      c.is_favorite
                        ? "bg-rose-500/25 border-rose-500/50 text-rose-300"
                        : "btn-ghost ink-soft hover:ink"
                    }`}
                    aria-label="Favorito"
                  >
                    <Heart filled={c.is_favorite} />
                  </button>
                )}
                {readOnly && c.is_favorite && (
                  <div className="w-10 h-10 rounded-full bg-rose-500/25 border border-rose-500/50 text-rose-300 flex items-center justify-center">
                    <Heart filled />
                  </div>
                )}
                {isSignedIn && (
                  <button
                    onClick={afterSwipeGuard(handleToggleWishlist)}
                    className={`w-10 h-10 rounded-full border transition flex items-center justify-center press ${
                      wishlisted
                        ? "bg-pink-500/25 border-pink-500/50 text-pink-300"
                        : "btn-ghost ink-soft hover:ink"
                    }`}
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
              <div
                className="relative w-full"
                style={{
                  maxWidth: isMobile
                    ? "calc(var(--panel-max) * 0.42 * 0.715)"
                    : "calc(var(--panel-max) * 0.82 * 0.715)",
                }}
              >
                {/* Halo de rareza: capa HERMANA fuera del contenedor 3D (un
                    filter dentro rasterizaría la carta y saldría borrosa) y
                    absoluta, para que nunca empuje el layout. */}
                {aura && (
                  <div
                    aria-hidden="true"
                    className="absolute -inset-6 rounded-[20%] blur-2xl opacity-70 pointer-events-none"
                    style={{ background: `radial-gradient(circle, ${aura.halo}, transparent 75%)` }}
                  />
                )}
                <div ref={tiltRef} className="relative w-full aspect-[2.5/3.5]">
                  {(() => {
                    const imagen = (
                      <motion.img
                        key={c.id}
                        initial={{ scale: 0.96, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
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
                        // Sombra con box-shadow y no drop-shadow: un filter dentro
                        // del contexto 3D del balanceo rasterizaría la carta.
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
                        className={`absolute inset-0 h-full w-full cursor-zoom-in object-cover ${c.owned === false ? "grayscale opacity-70" : ""}`}
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
                         nunca `scale`, que rasterizaría la capa (y aquí, dentro
                         del contexto 3D del balanceo, se notaría el doble).
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

                  {/* AQUÍ ESTABA LA INSIGNIA "ESTADO: DAÑADA", y no vuelve.
                      Las marcas se siguen pintando arriba: lo que se ha
                      quitado es el rótulo que las nombraba, no el desgaste.
                      El porqué entero está escrito unas líneas más abajo,
                      donde estaba el panel "Estado de la copia"; léelo antes
                      de reponer ninguna de las dos cosas. */}
                </div>
              </div>

              {/* Navegación explícita, para quien no descubra el gesto.
                  transform-gpu: la carta balanceándose vive en una capa 3D y
                  Safari la compone por encima del z-index normal; con capa
                  propia estos controles nunca quedan tapados por ella. */}
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
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-[10px] uppercase tracking-[0.25em] ink-faint font-semibold">{c.supertype || "Pokémon"}</span>
                    {c.subtypes?.slice(0, 3).map((s: string) => (
                      <span key={s} className="text-[10px] uppercase tracking-wider ink-soft chip px-2 py-0.5">{s}</span>
                    ))}
                    {c.rarity && aura && (
                      <span className={`text-[10px] uppercase tracking-wider font-semibold border rounded-full px-2 py-0.5 ${aura.chip}`}>
                        {c.rarity}
                      </span>
                    )}
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="text-2xl md:text-4xl font-bold tracking-tight">{c.name}</h2>
                    {c.hp && (
                      <span className="text-rose-400 font-mono text-base md:text-lg font-bold shrink-0">HP {c.hp}</span>
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
                <div className="grid grid-cols-2 gap-2">
                  <PriceTile
                    label={notaGraduada ? `Valor · ${etiquetaNota(notaGraduada)}` : "Valor de venta"}
                    value={`${getMarketPrice()}`}
                    unit="💰"
                    accent="accent"
                  />
                  {(() => {
                    const tcg = getTcgPrice();
                    return (
                      <PriceTile label="Valor real" value={tcg != null ? `$${tcg.toFixed(2)}` : "—"} accent={tcg != null ? "text-sky-400" : "ink-faint"} />
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
                  <div className="text-center text-[11px] uppercase tracking-wider ink-faint">
                    {c.quantity > 1 ? `Posee ${c.quantity} copias` : "Copia única"}
                  </div>
                )}

                {/* ABILITIES */}
                {c.abilities?.length > 0 && (
                  <div className="bg-gradient-to-br from-purple-500/10 to-transparent border border-purple-500/20 rounded-2xl p-4">
                    <p className="text-purple-400 text-[10px] font-semibold uppercase tracking-wider mb-3">Habilidades</p>
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
                    <p className="ink-faint text-[10px] font-semibold uppercase tracking-wider px-4 pt-3">Ataques</p>
                    <div className="flex flex-col divide-y divide-[var(--border)]">
                      {c.attacks.map((atk: any, i: number) => (
                        <div key={i} className="p-4 flex flex-col gap-2">
                          <div className="flex items-center gap-3">
                            <div className="shrink-0"><EnergyCost cost={atk.cost || []} /></div>
                            <span className="text-sm font-semibold truncate flex-1">{atk.name}</span>
                            {atk.damage && <span className="text-base font-mono font-bold text-rose-400 shrink-0">{atk.damage}</span>}
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
                            <span className="text-[11px] text-rose-400 font-semibold">{w.value}</span>
                          </div>
                        ))
                      : <span className="ink-faint text-xs">—</span>}
                  </StatTile>
                  <StatTile label="Resistencia">
                    {c.resistances?.length > 0
                      ? c.resistances.map((w: any, i: number) => (
                          <div key={i} className="flex items-center gap-1">
                            <TypeBadge type={w.type} size="xs" />
                            <span className="text-[11px] text-emerald-400 font-semibold">{w.value}</span>
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
                      <p className="ink-faint font-mono">
                        #{c.number || "—"}{c.set.printedTotal ? `/${c.set.printedTotal}` : ""}
                        {c.artist ? ` · ${c.artist}` : ""}
                      </p>
                    </div>
                  </div>
                )}

                {loadingEnrich && (
                  <p className="text-[9px] ink-faint uppercase tracking-wider animate-pulse text-center">Cargando detalles…</p>
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

function PriceTile({ label, value, unit, accent }: { label: string; value: string; unit?: string; accent: string }) {
  return (
    <div className="surface-2 rounded-2xl px-3 py-2.5">
      <p className="text-[9px] uppercase tracking-wider ink-faint font-semibold">{label}</p>
      <p className={`text-base md:text-lg font-bold ${accent} tabular-nums leading-tight mt-0.5`}>
        {value}{unit && <span className="text-xs ml-1">{unit}</span>}
      </p>
    </div>
  );
}

function StatTile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="surface-2 rounded-2xl p-3">
      <p className="text-[9px] uppercase tracking-wider ink-faint font-semibold mb-1.5">{label}</p>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}
