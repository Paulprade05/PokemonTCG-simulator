"use client";

import { useEffect, useMemo, useState } from "react";
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
import { useHaptics } from "../../../hooks/useHaptics";

type Filter = "all" | "owned" | "missing";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Todas" },
  { id: "owned", label: "Conseguidas" },
  { id: "missing", label: "Me faltan" },
];

/** Número de carta normalizado a 3 dígitos (011, 004…) conservando sufijos. */
const padNumber = (n: unknown) => String(n ?? "").padStart(3, "0");

export default function SetAlbumPage() {
  const params = useParams();
  const setId = params.setId as string;

  const { isSignedIn, isLoaded } = useUser();
  const haptic = useHaptics();

  const [setInfo, setSetInfo] = useState<any>(null);
  const [allSetCards, setAllSetCards] = useState<any[]>([]);
  const [ownedCards, setOwnedCards] = useState<Map<string, any>>(new Map());
  const [loading, setLoading] = useState(true);

  const [filter, setFilter] = useState<Filter>("all");
  const [detail, setDetail] = useState<any>(null);

  useEffect(() => {
    async function fetchAlbumData() {
      if (!isLoaded) return;
      setLoading(true);
      try {
        const sets = await getSetsFromDB();
        const currentSet = sets.find((s: any) => s.id === setId);
        if (currentSet) setSetInfo(currentSet);

        const blueprintCards = await getCardsFromSet(setId);
        setAllSetCards(blueprintCards);

        let userCards = [];
        if (isSignedIn) userCards = await getFullCollection();
        else userCards = getCollection();

        const ownedMap = new Map();
        userCards.forEach((card: any) => {
          if (card.id.startsWith(setId + "-")) ownedMap.set(card.id, card);
        });
        setOwnedCards(ownedMap);
      } catch (error) {
        console.error("Error cargando el álbum:", error);
      } finally {
        setLoading(false);
      }
    }
    fetchAlbumData();
  }, [setId, isSignedIn, isLoaded]);

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

  if (loading) return <Loader label="Abriendo álbum" />;

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
    setDetail({ ...blueprintCard, ...ownedCard, number: blueprintCard.number ?? ownedCard.number });
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
                className={`press touch-target relative rounded-xl px-1 py-2 flex flex-col items-center justify-center gap-0.5 transition-colors ${
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
            <p className="text-sm font-medium ink">
              {filter === "owned" ? "Aún no tienes cartas de esta expansión" : "¡Álbum completo!"}
            </p>
            <p className="text-xs ink-faint mt-1">
              {filter === "owned" ? "Abre sobres para empezar a rellenarlo" : "No te falta ninguna carta aquí"}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:gap-3 md:gap-5 max-w-4xl mx-auto w-full">
            {visibleCards.map((blueprintCard) => {
              const ownedCard = ownedCards.get(blueprintCard.id);

              if (ownedCard) {
                return (
                  <button
                    key={blueprintCard.id}
                    type="button"
                    onClick={() => openDetail(blueprintCard, ownedCard)}
                    aria-label={`Ver ${ownedCard.name || blueprintCard.name}`}
                    className="relative group text-left press rounded-2xl focus-visible:outline-none"
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
                <div
                  key={blueprintCard.id}
                  aria-label={`Carta ${padNumber(blueprintCard.number)}, no conseguida`}
                  className="w-full aspect-[2.5/3.5] border border-dashed rounded-2xl flex items-center justify-center transition"
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
      </div>

      {/* DETALLE DE CARTA POSEÍDA */}
      <Sheet
        open={!!detail}
        onClose={() => setDetail(null)}
        label={detail ? `Detalle de ${detail.name}` : "Detalle de carta"}
      >
        {detail && (
          <div className="px-4 pb-5 pt-2 sm:px-6">
            <AnimatePresence initial={false}>
              <motion.div
                key={detail.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                className="flex flex-col gap-4"
              >
                {detailImage && (
                  <img
                    src={detailImage}
                    alt={detail.name}
                    className="w-full max-w-[280px] sm:max-w-[320px] mx-auto rounded-2xl object-contain"
                    style={{ boxShadow: "var(--shadow-lg)" }}
                  />
                )}

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

                <button
                  type="button"
                  onClick={() => setDetail(null)}
                  className="btn-ghost press touch-target w-full rounded-xl py-3 text-sm font-medium"
                >
                  Cerrar
                </button>
              </motion.div>
            </AnimatePresence>
          </div>
        )}
      </Sheet>
    </div>
  );
}
