"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { useUser } from "@clerk/nextjs";
import TypeBadge, { EnergyCost } from "./TypeBadge";
import { SELL_PRICES } from "../utils/constanst";
import { getCardFromDB, toggleWishlist, getWishlistIds } from "../app/action";
import { useHaptics } from "../hooks/useHaptics";
import { useSwipe, touchActionFor } from "../hooks/useSwipe";
import CardZoom from "./ui/CardZoom";

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
  const detailsRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const imageColRef = useRef<HTMLDivElement>(null);
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
    getWishlistIds().then((ids: string[]) => setWishlisted(ids.includes(card.id)));
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

  const handleToggleWishlist = async () => {
    if (!card?.id) return;
    const prev = wishlisted;
    setWishlisted(!prev);
    const res: any = await toggleWishlist(card.id);
    if (res?.error) { setWishlisted(prev); alert(res.error); }
    else if (typeof res?.wishlisted === "boolean") setWishlisted(res.wishlisted);
  };

  useEffect(() => {
    setEnriched(null);
    if (!card?.id) return;
    setLoadingEnrich(true);
    getCardFromDB(card.id)
      .then((db) => { if (db) setEnriched(db); })
      .finally(() => setLoadingEnrich(false));
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

  const getMarketPrice = () => SELL_PRICES[c?.rarity as keyof typeof SELL_PRICES] || 10;
  const getTcgPrice = (): number | null => {
    const p = c?.tcgplayer?.prices;
    if (!p) return null;
    return p.holofoil?.market ?? p.holofoil?.mid ?? p.normal?.market ?? p.normal?.mid ?? p.reverseHolofoil?.market ?? p.reverseHolofoil?.mid
      ?? (Object.keys(p)[0] ? (p[Object.keys(p)[0]].market ?? p[Object.keys(p)[0]].mid) : null);
  };

  return (
    <>
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
              maxHeight: isMobile
                ? "calc(var(--app-height) - var(--sat) - 12px)"
                : "92vh",
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
            <div
              ref={imageColRef}
              className="relative w-full md:w-[44%] p-5 md:p-8 pt-14 md:pt-10 flex items-center justify-center"
              style={{
                background: aura
                  ? `radial-gradient(circle at 50% 35%, ${aura.halo.replace(/[\d.]+\)$/, "0.18)")}, transparent 70%), var(--surface-2)`
                  : "var(--surface-2)",
                // touchActionFor mantiene el pinch-zoom; el scroll vertical de
                // la página sigue siendo del navegador.
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

              {/* Card image with halo */}
              <div ref={tiltRef} className="relative">
                {aura && (
                  <div
                    className="absolute inset-0 -m-6 rounded-3xl blur-2xl opacity-70 pointer-events-none"
                    style={{ background: `radial-gradient(circle, ${aura.halo}, transparent 75%)` }}
                  />
                )}
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
                  className={`relative cursor-zoom-in object-contain max-h-[40vh] md:max-h-[68vh] drop-shadow-[0_25px_50px_rgba(0,0,0,0.6)] ${c.owned === false ? "grayscale opacity-70" : ""}`}
                />
              </div>

              {/* Navegación explícita, para quien no descubra el gesto */}
              {hasNav && (
                <>
                  <button
                    onClick={afterSwipeGuard(goPrev)}
                    disabled={!canPrev}
                    aria-label="Carta anterior"
                    className="absolute left-2 top-1/2 -translate-y-1/2 z-40 w-10 h-10 rounded-full btn-ghost press flex items-center justify-center disabled:opacity-25 disabled:cursor-not-allowed"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                      <path d="m15 18-6-6 6-6" />
                    </svg>
                  </button>
                  <button
                    onClick={afterSwipeGuard(goNext)}
                    disabled={!canNext}
                    aria-label="Carta siguiente"
                    className="absolute right-2 top-1/2 -translate-y-1/2 z-40 w-10 h-10 rounded-full btn-ghost press flex items-center justify-center disabled:opacity-25 disabled:cursor-not-allowed"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </button>
                  <span
                    aria-hidden="true"
                    className="absolute bottom-2 left-1/2 -translate-x-1/2 z-40 chip ink-soft text-[10px] px-2.5 py-1 rounded-full tnum pointer-events-none"
                  >
                    {navIndex + 1} / {navList!.length}
                  </span>
                </>
              )}
            </div>

            {/* RIGHT — DETAILS */}
            {/* Sin touchAction restringido: 'pan-y' excluye 'pinch-zoom' y
                anulaba el gesto de ampliar dentro del modal. */}
            <div
              ref={detailsRef}
              className="w-full md:w-[56%] flex flex-col bg-[var(--surface)] scroll-area custom-scrollbar relative"
              data-lenis-prevent
            >
              <div className="p-5 md:p-7 flex flex-col gap-4 relative">
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

                {/* PRICES */}
                <div className="grid grid-cols-2 gap-2">
                  <PriceTile label="Valor de venta" value={`${getMarketPrice()}`} unit="💰" accent="accent" />
                  {(() => {
                    const tcg = getTcgPrice();
                    return (
                      <PriceTile label="Valor real" value={tcg != null ? `$${tcg.toFixed(2)}` : "—"} accent={tcg != null ? "text-sky-400" : "ink-faint"} />
                    );
                  })()}
                </div>

                {/* SELL CTA */}
                {!readOnly && c.quantity > 1 && onSellAll && (
                  <button
                    onClick={onSellAll}
                    className="btn-accent press w-full py-3 rounded-2xl font-semibold text-sm"
                  >
                    Vender {c.quantity - 1} repetida{c.quantity - 1 > 1 ? "s" : ""} · +{(c.quantity - 1) * getMarketPrice()} 💰
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

      {/* Sólo la carta, a pantalla completa */}
      <CardZoom
        open={zoomed && !!c}
        src={c?.images?.large}
        alt={c?.name}
        caption={c?.name}
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
