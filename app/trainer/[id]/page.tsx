"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import { useParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import { getTrainerCollection, getSetsFromDB } from "../../action";
import { getSocialOverview } from "../../social";
import { RARITY_RANK, SELL_PRICES } from "../../../utils/constanst";
import PokemonCard from "../../../components/PokemonCard";
import PageHeader from "../../../components/PageHeader";
import Loader from "../../../components/Loader";
import CardDetailModal from "../../../components/CardDetailModal";

export default function TrainerProfilePage() {
  const params = useParams();
  const trainerId = params.id as string;
  const { isLoaded } = useUser();
  const [cards, setCards] = useState<any[]>([]);
  const [dbSets, setDbSets] = useState<any[]>([]);
  const [showStats, setShowStats] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [trainerName, setTrainerName] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState("rarity_desc");
  const [filterSet, setFilterSet] = useState("all");
  const [filterRarity, setFilterRarity] = useState("all");
  const [selectedCard, setSelectedCard] = useState<any | null>(null);

  const rarityOptions = useMemo(() => {
    const set = new Set<string>();
    cards.forEach((c) => c.rarity && set.add(c.rarity));
    return Array.from(set).sort((a, b) => (RARITY_RANK[b] || 0) - (RARITY_RANK[a] || 0));
  }, [cards]);

  // Todo dentro del mismo try/finally: si falla el transporte de cualquiera de
  // las dos peticiones (PWA sin cobertura, 500) la pantalla ofrece reintentar en
  // vez de quedarse con el Loader girando o fingir un álbum vacío.
  const loadTrainer = useCallback(async () => {
    if (!trainerId) return;
    setLoading(true);
    setLoadError(false);
    try {
      const sets = await getSetsFromDB();
      setDbSets(sets);
      const trainerCards = await getTrainerCollection(trainerId);
      setCards(trainerCards);
    } catch (e) {
      console.error(e);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [trainerId]);

  useEffect(() => { loadTrainer(); }, [loadTrainer]);

  // La ruta sólo lleva el id de Clerk, así que el nombre se busca en la lista
  // social. Va aparte para no retrasar la carga del álbum.
  useEffect(() => {
    if (!trainerId) return;
    let cancelled = false;
    getSocialOverview()
      .then((overview) => {
        if (cancelled) return;
        const match = (overview.friends as any[]).find((f) => f.friend_id === trainerId);
        if (match) setTrainerName(match.isMe ? "Tu álbum" : match.friend_name);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [trainerId]);

  const setStats = useMemo(() => dbSets.map((set) => {
    // Mismo criterio que /collection y /album: el progreso se mide contra las
    // cartas que EXISTEN (`cardsCount`), no contra el total que declara el set,
    // que viene inflado de la API. Sin esto la misma expansión daba dos
    // porcentajes distintos según por qué pantalla se mirara.
    const total = Number(set.cardsCount) || Number(set.total) || 1;
    const owned = Math.min(cards.filter((c) => c.id.startsWith(set.id + "-")).length, total);
    const percentage = Math.min(100, Math.round((owned / total) * 100));
    return { ...set, logo: set.images?.logo || "", owned, percentage };
  }), [cards, dbSets]);

  const processedCards = useMemo(() => {
    let result = [...cards];
    if (searchTerm) result = result.filter((c) => c.name.toLowerCase().includes(searchTerm.toLowerCase()));
    if (filterSet !== "all") result = result.filter((c) => c.id.startsWith(filterSet + "-"));
    if (filterRarity !== "all") result = result.filter((c) => c.rarity === filterRarity);
    result.sort((a, b) => {
      if (a.is_favorite && !b.is_favorite) return -1;
      if (!a.is_favorite && b.is_favorite) return 1;
      switch (sortBy) {
        case "name_asc": return a.name.localeCompare(b.name);
        case "quantity_desc": return (b.quantity || 1) - (a.quantity || 1);
        case "rarity_desc": return (RARITY_RANK[b.rarity] || 0) - (RARITY_RANK[a.rarity] || 0);
        default: return 0;
      }
    });
    return result;
  }, [cards, searchTerm, filterSet, filterRarity, sortBy]);

  const getPrice = (rarity: string) => SELL_PRICES[rarity] || 10;

  if (loading || !isLoaded) return <Loader label="Cargando entrenador" />;

  if (loadError) {
    return (
      <div className="select-none w-full">
        <PageHeader back="/friends" title="Álbum de entrenador" subtitle={trainerName || undefined} />
        <div className="surface rounded-2xl px-6 py-16 flex flex-col items-center gap-4 text-center">
          <p className="text-sm ink-soft">No se ha podido cargar este álbum. Comprueba tu conexión.</p>
          <button
            type="button"
            onClick={loadTrainer}
            className="btn-accent press touch-target rounded-xl px-5 text-sm font-semibold flex items-center justify-center"
          >
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="select-none w-full">
      <PageHeader back="/friends" title="Álbum de entrenador" subtitle={trainerName || undefined} />

      <div className="w-full flex flex-col gap-6">
        <div>
          <button
            onClick={() => setShowStats(!showStats)}
            aria-expanded={showStats}
            className="w-full surface surface-hover rounded-2xl px-5 py-4 flex justify-between items-center"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl surface-2 border border-[var(--border)] flex items-center justify-center">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5 text-blue-400">
                  <path d="M3 3v18h18" /><path d="M7 14l4-4 4 4 6-6" />
                </svg>
              </div>
              <div className="text-left">
                <h3 className="font-semibold text-sm ink">Progreso del entrenador</h3>
                <p className="text-xs ink-faint">{showStats ? "Ocultar detalles" : "Ver por expansión"}</p>
              </div>
            </div>
            <motion.svg
              animate={{ rotate: showStats ? 180 : 0 }}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className="w-4 h-4 ink-soft"
            >
              <path d="m6 9 6 6 6-6" />
            </motion.svg>
          </button>

          <AnimatePresence>
            {showStats && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
                  {setStats.map((stat) => (
                    <div key={stat.id} className="surface rounded-2xl p-4">
                      <div className="flex items-center gap-3 mb-3">
                        {stat.logo && <img src={stat.logo} alt={stat.name} className="h-7 object-contain opacity-90" />}
                        <div className="flex-1 min-w-0">
                          <h3 className="font-medium text-sm ink truncate">{stat.name}</h3>
                          <p className="text-[10px] ink-faint font-mono">{stat.owned}/{stat.total}</p>
                        </div>
                        <span className="text-xs font-semibold ink-soft">{stat.percentage}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-[color-mix(in_srgb,var(--ink)_8%,transparent)] rounded-full overflow-hidden">
                        <div className={stat.percentage === 100 ? "progress-bar h-full" : "progress-bar-blue h-full"} style={{ width: `${stat.percentage}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="surface rounded-2xl px-3 py-3 flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:items-center">
          {/* <label> y no <div>: tocar el icono o el relleno enfoca el campo. */}
          <label className="input-field flex min-h-11 items-center gap-2 px-3 py-2 rounded-xl flex-1 sm:min-w-[180px]">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 ink-faint shrink-0">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="search"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-label="Buscar en el álbum"
              placeholder="Buscar..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
              className="bg-transparent ink outline-none text-base flex-1 min-w-0 placeholder:text-[var(--ink-faint)] [&::-webkit-search-cancel-button]:hidden"
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => setSearchTerm("")}
                aria-label="Limpiar búsqueda"
                className="ink-faint hover:ink shrink-0 -mr-1.5 press flex h-11 w-11 items-center justify-center rounded-full"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </label>

          {/* Rejilla de dos columnas: con `w-full` en una fila flexible cada
              selector se llevaba una línea entera (cuatro filas apiladas). */}
          <div className="grid grid-cols-2 gap-2 sm:contents">
            <select
              value={filterSet}
              onChange={(e) => setFilterSet(e.target.value)}
              aria-label="Filtrar por expansión"
              className="input-field col-span-2 w-full min-w-0 truncate px-3 py-2.5 rounded-xl text-xs cursor-pointer sm:col-span-1 sm:w-auto"
            >
              <option value="all">Todas</option>
              {dbSets.map((set) => <option key={set.id} value={set.id}>{set.name}</option>)}
            </select>
            <select
              value={filterRarity}
              onChange={(e) => setFilterRarity(e.target.value)}
              aria-label="Filtrar por rareza"
              className="input-field w-full min-w-0 truncate px-3 py-2.5 rounded-xl text-xs cursor-pointer sm:w-auto"
            >
              <option value="all">Toda rareza</option>
              {rarityOptions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              aria-label="Ordenar por"
              className="input-field w-full min-w-0 truncate px-3 py-2.5 rounded-xl text-xs cursor-pointer sm:w-auto"
            >
              <option value="rarity_desc">Rareza</option>
              <option value="quantity_desc">Cantidad</option>
              <option value="name_asc">Nombre</option>
            </select>
          </div>
        </div>

        {processedCards.length === 0 ? (
          <div className="surface rounded-2xl py-20 text-center ink-faint text-sm">Este entrenador no tiene cartas.</div>
        ) : (
          // Misma rejilla que colección y álbum: las cartas miden igual en
          // las tres pantallas y en móvil caben tres por fila.
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:gap-4 lg:grid-cols-6">
            {processedCards.map((card) => (
              <div key={card.id} className="relative group">
                {card.quantity > 1 && (
                  // Variables de tema, no bg-white/text-black: el blanco fijo
                  // quedaba invisible en tema claro. Mismo badge que colección.
                  <div
                    className="absolute -top-2 -right-2 z-30 text-[10px] font-bold w-6 h-6 flex items-center justify-center rounded-full tnum"
                    style={{
                      background: "var(--ink)",
                      color: "var(--bg)",
                      border: "1px solid var(--border-strong)",
                      boxShadow: "var(--shadow-sm)",
                    }}
                  >
                    {card.quantity}
                  </div>
                )}
                {card.is_favorite && (
                  <div className="absolute -top-2 -left-2 z-30 bg-rose-500 w-5 h-5 rounded-full flex items-center justify-center shadow-lg">
                    <svg viewBox="0 0 24 24" fill="white" className="w-3 h-3">
                      <path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 5.5 5.5 5.5 0 0 1 21.5 12c-2.5 4.5-9.5 9-9.5 9z" />
                    </svg>
                  </div>
                )}
                {/* <button> y no <div onClick>: sin rol ni tabIndex la carta era
                    inalcanzable con teclado y un lector no anunciaba nada
                    accionable. Igual que la rejilla de colección. */}
                <button
                  type="button"
                  aria-label={`Ver ${card.name}`}
                  className="block w-full cursor-zoom-in text-left"
                  onClick={() => setSelectedCard(card)}
                >
                  <div className="transition transform group-hover:-translate-y-1 duration-300 pointer-events-none">
                    <PokemonCard card={card} reveal={true} interactive={false} />
                  </div>
                </button>
                {/* En táctil no hay hover: el contador se ve siempre en móvil */}
                <div className="mt-2 flex justify-center opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-300">
                  <span className="chip ink-soft text-[10px] px-2 py-1 rounded-full">
                    {card.quantity > 1 ? `${card.quantity} copias` : "Única"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <CardDetailModal card={selectedCard} onClose={() => setSelectedCard(null)} readOnly />
    </div>
  );
}
