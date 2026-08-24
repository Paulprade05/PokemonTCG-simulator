"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import { getSetsFromDB, getFullCollection } from "../../action";
import { getCardsFromSet } from "../../../services/pokemon";
import { getCollection } from "../../../utils/storage";
import PokemonCard from "../../../components/PokemonCard";
import PageHeader from "../../../components/PageHeader";
import Loader from "../../../components/Loader";
import Sheet from "../../../components/ui/Sheet";
import CardZoom from "../../../components/ui/CardZoom";
import { useHaptics } from "../../../hooks/useHaptics";
import { useSwipe, touchActionFor } from "../../../hooks/useSwipe";

type Filter = "all" | "owned" | "missing";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Todas" },
  { id: "owned", label: "Conseguidas" },
  { id: "missing", label: "Me faltan" },
];

/**
 * Cartas por tanda. Una expansión grande pasa de 250 cartas: montarlas todas de
 * golpe deja el hilo principal bloqueado y el scroll a tirones en iPhone.
 */
const BATCH = 60;

/** Número de carta normalizado a 3 dígitos (011, 004…) conservando sufijos. */
const padNumber = (n: unknown) => String(n ?? "").padStart(3, "0");

/** La ficha mezcla el blueprint del set con la copia del usuario. */
const mergeDetail = (blueprintCard: any, ownedCard: any) => ({
  ...blueprintCard,
  ...ownedCard,
  number: blueprintCard.number ?? ownedCard?.number,
});

export default function SetAlbumPage() {
  const params = useParams();
  const setId = params.setId as string;

  const { isSignedIn, isLoaded } = useUser();
  const haptic = useHaptics();

  const [setInfo, setSetInfo] = useState<any>(null);
  const [allSetCards, setAllSetCards] = useState<any[]>([]);
  const [ownedCards, setOwnedCards] = useState<Map<string, any>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [filter, setFilter] = useState<Filter>("all");
  const [detail, setDetail] = useState<any>(null);
  /** Visor a pantalla completa: el único sitio de la app con zoom (pellizco). */
  const [zoomOpen, setZoomOpen] = useState(false);

  // Pantalla baja y ancha: el móvil girado. La ficha se reparte en dos columnas
  // y el tope de la carta cambia, así que hace falta saberlo también en JS.
  // Empieza en false para que servidor y cliente rendericen lo mismo.
  const [landscape, setLandscape] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-height: 560px) and (min-width: 640px)");
    const sync = () => setLandscape(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // En useCallback para poder reintentar desde el estado de error. Todo va
  // dentro del mismo try: si getCardsFromSet o getSetsFromDB fallan (PWA sin
  // cobertura, 500) o el setId de la URL no existe, `loadError` ofrece
  // reintentar en vez de dejar el álbum vacío disfrazado de «¡Álbum completo!».
  const fetchAlbumData = useCallback(async () => {
    if (!isLoaded) return;
    setLoading(true);
    setLoadError(false);
    try {
      const sets = await getSetsFromDB();
      const currentSet = sets.find((s: any) => s.id === setId);
      if (currentSet) setSetInfo(currentSet);

      const blueprintCards = await getCardsFromSet(setId);
      setAllSetCards(blueprintCards);

      let userCards = [];
      if (isSignedIn) userCards = await getFullCollection();
      else userCards = getCollection();

      // Rótulo e ilustración salen SIEMPRE del blueprint, que ya viene en el
      // idioma elegido. Importa para el invitado: su colección vive en
      // localStorage y guardó el nombre con el que se abrió el sobre, así que
      // tras cambiar de idioma sus cartas se verían en el idioma viejo. El
      // almacenamiento no se toca —es su partida—; sólo se repinta. Cantidad,
      // favorito y lo demás siguen siendo suyos.
      const porId = new Map(blueprintCards.map((c: any) => [c.id, c]));
      const ownedMap = new Map();
      userCards.forEach((card: any) => {
        if (!card.id.startsWith(setId + "-")) return;
        const bp: any = porId.get(card.id);
        ownedMap.set(
          card.id,
          bp ? { ...card, name: bp.name ?? card.name, images: bp.images ?? card.images } : card,
        );
      });
      setOwnedCards(ownedMap);
    } catch (error) {
      console.error("Error cargando el álbum:", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [setId, isSignedIn, isLoaded]);

  useEffect(() => {
    fetchAlbumData();
  }, [fetchAlbumData]);

  // Blueprint ordenado por número de carta cuando es numérico.
  const sortedCards = useMemo(
    () =>
      [...allSetCards].sort((a, b) => {
        const na = parseInt(String(a.number).replace(/\D/g, ""), 10) || 0;
        const nb = parseInt(String(b.number).replace(/\D/g, ""), 10) || 0;
        return na - nb;
      }),
    [allSetCards],
  );

  const visibleCards = useMemo(() => {
    if (filter === "owned") return sortedCards.filter((c) => ownedCards.has(c.id));
    if (filter === "missing") return sortedCards.filter((c) => !ownedCards.has(c.id));
    return sortedCards;
  }, [sortedCards, ownedCards, filter]);

  // Recorrido de la hoja de detalle: sólo cartas poseídas y sólo las que el
  // filtro activo deja a la vista, para que el gesto no salte a algo que no
  // está en pantalla.
  const navCards = useMemo(
    () => visibleCards.filter((c) => ownedCards.has(c.id)),
    [visibleCards, ownedCards],
  );

  const detailIndex = useMemo(
    () => (detail ? navCards.findIndex((c) => c.id === detail.id) : -1),
    [detail, navCards],
  );

  const canPrev = detailIndex > 0;
  const canNext = detailIndex >= 0 && detailIndex < navCards.length - 1;

  /** Avanza (+1) o retrocede (-1) por `navCards`. En los extremos no hace nada. */
  const step = useCallback(
    (delta: number) => {
      if (detailIndex < 0) return;
      const nextCard = navCards[detailIndex + delta];
      if (!nextCard) return;
      haptic("tap");
      setDetail(mergeDetail(nextCard, ownedCards.get(nextCard.id)));
    },
    [detailIndex, navCards, ownedCards, haptic],
  );

  // El gesto se engancha sólo a la imagen: si escuchara en toda la hoja se
  // comería el scroll vertical de la ficha.
  const detailImageRef = useRef<HTMLDivElement>(null);
  const detailSwipeRef = useSwipe(detailImageRef, {
    axis: "x",
    threshold: 64,
    velocity: 420,
    follow: true,
    rotate: 4,
    resistance: 0.3,
    enabled: !!detail,
    // Sin manejador en el extremo: el hook aplica resistencia y no dispara nada.
    ...(canNext ? { onSwipeLeft: () => step(1) } : {}),
    ...(canPrev ? { onSwipeRight: () => step(-1) } : {}),
  });

  // Mismo recorrido con teclado, para quien no tiene pantalla táctil.
  useEffect(() => {
    if (!detail) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, step]);

  // ── RENDER POR TANDAS ─────────────────────────────────────────────────────
  // Sólo se monta el principio de la lista; el centinela del final pide la
  // siguiente tanda antes de llegar a él.
  const [limit, setLimit] = useState(BATCH);

  // Cambiar de filtro (o recargar el set) rehace la lista: se vuelve al corte
  // inicial para no montar 250 cartas de una tacada.
  useEffect(() => {
    setLimit(BATCH);
  }, [visibleCards]);

  const hasMore = limit < visibleCards.length;

  // El total vive en un ref para que el observador no dependa de él y no haya
  // que recrearlo en cada tanda.
  const totalRef = useRef(0);
  totalRef.current = visibleCards.length;
  const observerRef = useRef<IntersectionObserver | null>(null);

  /**
   * Callback ref en vez de useEffect a propósito.
   *
   * Mientras se cargan los datos la página devuelve el Loader, así que el
   * centinela no existe todavía: un efecto se ejecutaría, encontraría el ref a
   * null y se iría. Y como sus dependencias ya no vuelven a cambiar, el
   * observador no llegaba a engancharse nunca y el álbum se quedaba congelado
   * en las primeras 60 cartas. Con un callback ref se conecta justo cuando el
   * nodo entra en el DOM, sea cuando sea.
   */
  const sentinelRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    if (!node) return;

    // Degradado seguro: sin IntersectionObserver se muestra todo de una vez.
    if (typeof IntersectionObserver === "undefined") {
      setLimit(totalRef.current);
      return;
    }

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setLimit((current) => Math.min(current + BATCH, totalRef.current));
        }
      },
      // Margen generoso: la tanda siguiente ya está montada cuando el usuario
      // llega al final de la actual.
      { rootMargin: "600px 0px" },
    );
    observerRef.current.observe(node);
  }, []);

  // Al desmontar la página, soltar el observador.
  useEffect(() => () => observerRef.current?.disconnect(), []);

  const renderedCards = useMemo(() => visibleCards.slice(0, limit), [visibleCards, limit]);

  if (loading) return <Loader label="Abriendo álbum" />;

  if (loadError) {
    return (
      <div className="select-none w-full">
        <PageHeader
          back="/collection"
          logo={setInfo?.images?.logo}
          title={setInfo?.name || "Álbum"}
        />
        <div className="surface rounded-2xl px-6 py-16 flex flex-col items-center gap-4 text-center">
          <p className="text-sm ink-soft">No se pudo cargar esta expansión. Comprueba tu conexión.</p>
          <button
            type="button"
            onClick={() => { haptic("tap"); fetchAlbumData(); }}
            className="btn-accent press touch-target rounded-xl px-5 text-sm font-semibold flex items-center justify-center"
          >
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  const total = setInfo?.total || allSetCards.length || 1;
  const owned = ownedCards.size;
  const percent = Math.round((owned / total) * 100);

  // Contadores del selector: sobre el blueprint real, no sobre `total` del set.
  const ownedInBlueprint = sortedCards.filter((c) => ownedCards.has(c.id)).length;
  const counts: Record<Filter, number> = {
    all: sortedCards.length,
    owned: ownedInBlueprint,
    missing: sortedCards.length - ownedInBlueprint,
  };

  const changeFilter = (next: Filter) => {
    if (next === filter) return;
    haptic("select");
    setFilter(next);
  };

  const openDetail = (blueprintCard: any, ownedCard: any) => {
    haptic("tap");
    setDetail(mergeDetail(blueprintCard, ownedCard));
  };

  const detailImage = detail?.images?.large || detail?.images?.small;

  return (
    <div className="select-none w-full">
      <PageHeader
        back="/collection"
        logo={setInfo?.images?.logo}
        title={setInfo?.name || "Álbum"}
      />

      <div className="w-full flex flex-col gap-4 sm:gap-6">
        {/* PROGRESS */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="surface rounded-2xl p-4 sm:p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-3 md:gap-4"
        >
          <div className="min-w-0">
            <h2 className="text-base sm:text-lg font-semibold ink truncate">
              {setInfo?.name || "Expansión"}
            </h2>
            <p className="text-[11px] sm:text-xs ink-faint mt-1">
              <span className="tnum">{owned}</span> de <span className="tnum">{total}</span> cartas coleccionadas
              {setInfo?.releaseDate && <span className="ml-2">· {setInfo.releaseDate}</span>}
            </p>
          </div>
          <div className="flex items-center gap-3 sm:gap-4 w-full md:w-auto">
            <div
              className="flex-1 min-w-0 md:w-64 h-2 rounded-full overflow-hidden"
              style={{ background: "color-mix(in srgb, var(--ink) 8%, transparent)" }}
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Progreso de la colección"
            >
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${percent}%` }}
                transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                className={percent === 100 ? "progress-bar h-full" : "progress-bar-blue h-full"}
              />
            </div>
            <span className="text-xl sm:text-2xl font-semibold ink tnum shrink-0">{percent}%</span>
          </div>
        </motion.div>

        {/* FILTRO SEGMENTADO */}
        <div
          className="surface rounded-2xl p-1 grid grid-cols-3 gap-1"
          role="group"
          aria-label="Filtrar cartas del álbum"
        >
          {FILTERS.map((f) => {
            const active = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => changeFilter(f.id)}
                aria-pressed={active}
                className={`press touch-target relative min-w-0 rounded-xl px-0.5 py-2 flex flex-col items-center justify-center gap-0.5 transition-colors ${
                  active ? "ink" : "ink-soft"
                }`}
                style={
                  active
                    ? {
                        background: "color-mix(in srgb, var(--ink) 9%, transparent)",
                        border: "1px solid var(--border-strong)",
                      }
                    : { border: "1px solid transparent" }
                }
              >
                <span className="text-[11px] sm:text-xs font-medium leading-tight">{f.label}</span>
                <span className="text-[10px] tnum ink-faint leading-none">{counts[f.id]}</span>
              </button>
            );
          })}
        </div>

        {/* GRID 3x3 BLUEPRINT */}
        {visibleCards.length === 0 ? (
          <div className="surface rounded-2xl py-14 px-6 text-center">
            {/* «¡Álbum completo!» sólo es cierto con el filtro «Me faltan» vacío.
                Con «Todas» vacío el blueprint no llegó (o el set no existe): no
                se puede afirmar que esté completo. */}
            <p className="text-sm font-medium ink">
              {filter === "owned"
                ? "Aún no tienes cartas de esta expansión"
                : filter === "missing"
                  ? "¡Álbum completo!"
                  : "No hay cartas para mostrar"}
            </p>
            <p className="text-xs ink-faint mt-1">
              {filter === "owned"
                ? "Abre sobres para empezar a rellenarlo"
                : filter === "missing"
                  ? "No te falta ninguna carta aquí"
                  : "Vuelve a intentarlo más tarde"}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:gap-4 lg:grid-cols-6 w-full">
            {renderedCards.map((blueprintCard) => {
              const ownedCard = ownedCards.get(blueprintCard.id);

              if (ownedCard) {
                return (
                  <button
                    key={blueprintCard.id}
                    type="button"
                    onClick={() => openDetail(blueprintCard, ownedCard)}
                    aria-label={`Ver ${ownedCard.name || blueprintCard.name}`}
                    className="relative group text-left press rounded-[4.5%]"
                  >
                    {ownedCard.quantity > 1 && (
                      <div
                        className="absolute -top-1.5 -right-1.5 sm:-top-2 sm:-right-2 z-30 text-[10px] font-bold w-5 h-5 sm:w-6 sm:h-6 flex items-center justify-center rounded-full tnum"
                        style={{
                          background: "var(--ink)",
                          color: "var(--bg)",
                          boxShadow: "var(--shadow-md)",
                        }}
                      >
                        {ownedCard.quantity}
                      </div>
                    )}
                    <div className="transition transform group-hover:-translate-y-1 duration-300 pointer-events-none">
                      <PokemonCard card={ownedCard} reveal={true} interactive={false} />
                    </div>
                  </button>
                );
              }

              return (
                // No lleva aria-hidden: el número es la única pista de qué
                // carta falta, y un lector de pantalla debe poder leerlo.
                // Misma proporción y mismo radio que PokemonCard
                // (aspect-[2.5/3.5] + rounded-[4.5%]): el hueco ocupa
                // exactamente lo que ocuparía la carta y la rejilla no baila al
                // ir consiguiéndolas.
                <div
                  key={blueprintCard.id}
                  aria-label={`Carta ${padNumber(blueprintCard.number)}, no conseguida`}
                  className="w-full aspect-[2.5/3.5] border border-dashed rounded-[4.5%] flex items-center justify-center transition"
                  style={{
                    background: "color-mix(in srgb, var(--ink) 3%, transparent)",
                    borderColor: "var(--border-strong)",
                  }}
                >
                  <span className="ink-soft font-mono text-base sm:text-lg md:text-2xl tnum">
                    {padNumber(blueprintCard.number)}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* CENTINELA + CUÁNTAS SE ESTÁN VIENDO */}
        {hasMore && (
          <div
            ref={sentinelRef}
            className="flex flex-col items-center justify-center gap-2 py-3"
          >
            <p className="text-[11px] ink-faint">
              Mostrando <span className="tnum">{renderedCards.length}</span> de{" "}
              <span className="tnum">{visibleCards.length}</span>
            </p>
            {/* Salida manual: la carga al llegar al final depende de
                IntersectionObserver, y si por lo que sea no dispara, sin este
                botón las cartas restantes quedarían inalcanzables. También es
                la vía para quien navegue con teclado. */}
            <button
              type="button"
              onClick={() =>
                setLimit((current) =>
                  Math.min(current + BATCH, visibleCards.length),
                )
              }
              className="btn-ghost press touch-target rounded-xl px-5 text-xs font-medium"
            >
              Ver más cartas
            </button>
          </div>
        )}
      </div>

      {/* DETALLE DE CARTA POSEÍDA */}
      <Sheet
        open={!!detail}
        onClose={() => setDetail(null)}
        label={detail ? `Detalle de ${detail.name}` : "Detalle de carta"}
      >
        {detail && (
          // En apaisado (pantalla baja y ancha, p. ej. el móvil girado) el
          // contenido pasa a dos columnas: si no, la carta se queda en una
          // miniatura ridícula porque el alto disponible es mínimo.
          <div className="px-4 pb-5 pt-2 sm:px-6 flex flex-col gap-4 [@media(max-height:560px)_and_(min-width:640px)]:flex-row [@media(max-height:560px)_and_(min-width:640px)]:items-start [@media(max-height:560px)_and_(min-width:640px)]:gap-6">
            {/* Contenedor estable del gesto: no lleva `key`, así los listeners
                sobreviven al cambio de carta. */}
            <div
              ref={detailImageRef}
              className="relative mx-auto w-full aspect-[2.5/3.5] [@media(max-height:560px)_and_(min-width:640px)]:mx-0 [@media(max-height:560px)_and_(min-width:640px)]:shrink-0"
              // El límite se pone al ANCHO, no al alto de la imagen: junto con
              // la proporción FIJA de carta (aspect 2.5/3.5) la caja mide lo
              // mismo para todas las cartas, aunque las imágenes de la API no
              // compartan proporción exacta: navegar no recoloca la hoja. Se
              // convierte el alto disponible a ancho con esa proporción
              // (2.5/3.5 ≈ 0.715) y así encaja exacta en pantallas bajas sin
              // deformarse ni desbordar la hoja.
              style={{
                touchAction: touchActionFor("x"),
                maxWidth:
                  "min(320px, calc((var(--app-height) - var(--sat) - var(--sab) - 260px) * 0.715))",
                // En apaisado no hay 260px de fichas debajo que descontar: la
                // carta ocupa la columna izquierda y sólo esquiva el asa.
                ...(landscape
                  ? {
                      maxWidth:
                        "min(320px, calc((var(--app-height) - var(--sat) - var(--sab) - 56px) * 0.715))",
                    }
                  : null),
              }}
            >
              {detailImage && (
                <motion.img
                  key={detail.id}
                  src={detailImage}
                  alt={detail.name}
                  draggable={false}
                  role="button"
                  tabIndex={0}
                  aria-label={`Ampliar ${detail.name}`}
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                  onClick={() => {
                    // Un arrastre de navegación acaba en click sintético: no
                    // debe abrir el visor.
                    if (detailSwipeRef.current) return;
                    haptic("tap");
                    setZoomOpen(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      setZoomOpen(true);
                    }
                  }}
                  // Mismo radio que PokemonCard y que los huecos de la
                  // rejilla (4.5% del ancho), para que abrir la ficha no
                  // cambie la silueta de la carta.
                  className="absolute inset-0 h-full w-full cursor-zoom-in rounded-[4.5%] object-contain"
                  style={{ boxShadow: "var(--shadow-lg)" }}
                />
              )}
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-4">
            {/* POSICIÓN EN EL RECORRIDO */}
            {detailIndex >= 0 && (
              <div className="flex items-center justify-center gap-2 sm:gap-3">
                {navCards.length > 1 && (
                  <button
                    type="button"
                    onClick={() => canPrev && step(-1)}
                    aria-disabled={!canPrev}
                    aria-label="Carta anterior"
                    className={`press ink-soft shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${canPrev ? "" : "opacity-35"}`}
                    style={{ border: "1px solid var(--border)" }}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                  </button>
                )}

                <p className="text-[11px] ink-faint text-center min-w-0" aria-live="polite">
                  <span className="tnum">{detailIndex + 1}</span> de{" "}
                  <span className="tnum">{navCards.length}</span> conseguidas
                </p>

                {navCards.length > 1 && (
                  <button
                    type="button"
                    onClick={() => canNext && step(1)}
                    aria-disabled={!canNext}
                    aria-label="Carta siguiente"
                    className={`press ink-soft shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${canNext ? "" : "opacity-35"}`}
                    style={{ border: "1px solid var(--border)" }}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                  </button>
                )}
              </div>
            )}

            <AnimatePresence initial={false}>
              <motion.div
                key={detail.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                className="flex flex-col gap-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] ink-faint font-mono tnum">
                      #{padNumber(detail.number)}
                      {setInfo?.total ? ` / ${setInfo.total}` : ""}
                    </p>
                    <h3 className="text-lg font-semibold ink truncate">{detail.name}</h3>
                  </div>
                  <span className="chip px-3 py-1.5 text-[11px] ink-soft shrink-0">
                    x<span className="tnum">{detail.quantity || 1}</span>
                  </span>
                </div>

                <dl className="surface-2 rounded-2xl overflow-hidden">
                  <div className="flex items-center justify-between gap-3 px-4 py-3">
                    <dt className="text-xs ink-faint shrink-0">Rareza</dt>
                    <dd className="text-xs font-medium ink text-right truncate">
                      {detail.rarity || "Desconocida"}
                    </dd>
                  </div>
                  <div
                    className="flex items-center justify-between gap-3 px-4 py-3"
                    style={{ borderTop: "1px solid var(--border)" }}
                  >
                    <dt className="text-xs ink-faint shrink-0">Artista</dt>
                    <dd className="text-xs font-medium ink text-right truncate">
                      {detail.artist || "Desconocido"}
                    </dd>
                  </div>
                  <div
                    className="flex items-center justify-between gap-3 px-4 py-3"
                    style={{ borderTop: "1px solid var(--border)" }}
                  >
                    <dt className="text-xs ink-faint shrink-0">Copias</dt>
                    <dd className="text-xs font-medium ink text-right tnum">{detail.quantity || 1}</dd>
                  </div>
                </dl>
              </motion.div>
            </AnimatePresence>

            <button
              type="button"
              onClick={() => setDetail(null)}
              className="btn-ghost press touch-target w-full rounded-xl py-3 text-sm font-medium"
            >
              Cerrar
            </button>
            </div>
          </div>
        )}
      </Sheet>

      {/* Visor con pellizco. Se cierra solo si la ficha desaparece debajo. */}
      <CardZoom
        open={zoomOpen && !!detail}
        src={detailImage}
        alt={detail?.name}
        caption={detail?.name}
        onClose={() => setZoomOpen(false)}
        onPrev={canPrev ? () => step(-1) : undefined}
        onNext={canNext ? () => step(1) : undefined}
      />
    </div>
  );
}
