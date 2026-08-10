"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import {
  getFullCollection,
  sellCardAction,
  toggleFavorite,
  sellAllDuplicatesAction,
  getSetsFromDB,
} from "../action";
import { getCollection, saveCollectionRaw } from "../../utils/storage";
import { useCurrency } from "../../hooks/useGameCurrency";
import { useHaptics } from "../../hooks/useHaptics";
import { useToast } from "../../components/ui/Toast";
import ConfirmSheet from "../../components/ui/ConfirmSheet";
import Sheet from "../../components/ui/Sheet";
import { RARITY_RANK, SELL_PRICES } from "../../utils/constanst";
import PokemonCard from "../../components/PokemonCard";
import PageHeader from "../../components/PageHeader";
import Loader from "../../components/Loader";
import CardDetailModal from "../../components/CardDetailModal";
import Link from "next/link";

export default function CollectionPage() {
  const { isSignedIn, isLoaded } = useUser();
  const [cards, setCards] = useState<any[]>([]);
  const [dbSets, setDbSets] = useState<any[]>([]);
  const { coins, addCoins } = useCurrency();
  const [showStats, setShowStats] = useState(false);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState("rarity_desc");
  const [filterSet, setFilterSet] = useState("all");
  const [filterRarity, setFilterRarity] = useState("all");
  const [selectedCard, setSelectedCard] = useState<any | null>(null);
  const [actionCard, setActionCard] = useState<any | null>(null);
  const [confirmDuplicates, setConfirmDuplicates] = useState(false);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 24;

  /**
   * Venta en vuelo. `pendingSale` guarda el id de la carta (o "duplicates"
   * para el lote) y sirve para deshabilitar los botones; el ref es el cerrojo
   * real, porque setState no se ve hasta el siguiente render y dos toques
   * seguidos entrarían los dos.
   */
  const [pendingSale, setPendingSale] = useState<string | null>(null);
  const saleLockRef = useRef(false);
  const isSelling = pendingSale !== null;

  /** Toma el cerrojo; devuelve false si ya hay una venta en curso. */
  const beginSale = (key: string) => {
    if (saleLockRef.current) return false;
    saleLockRef.current = true;
    setPendingSale(key);
    return true;
  };
  const endSale = () => {
    saleLockRef.current = false;
    setPendingSale(null);
  };

  /** Mismo cerrojo para el favorito: evita dos peticiones cruzadas. */
  const favLockRef = useRef<Set<string>>(new Set());

  // Estado de la pulsación larga sobre la rejilla. En un ref para no
  // re-renderizar 24 cartas en cada movimiento del dedo.
  const longPressRef = useRef<{ timer: number | null; x: number; y: number; fired: boolean }>({
    timer: null,
    x: 0,
    y: 0,
    fired: false,
  });
  const LONG_PRESS_MS = 450;
  const LONG_PRESS_SLOP = 10;

  const haptic = useHaptics();
  const toast = useToast();

  const rarityOptions = useMemo(() => {
    const set = new Set<string>();
    cards.forEach((c) => c.rarity && set.add(c.rarity));
    return Array.from(set).sort((a, b) => (RARITY_RANK[b] || 0) - (RARITY_RANK[a] || 0));
  }, [cards]);

  useEffect(() => {
    async function initCollection() {
      if (!isLoaded) return;
      setLoading(true);
      const sets = await getSetsFromDB();
      setDbSets(sets);
      if (isSignedIn) {
        try {
          const dbCards = await getFullCollection();
          setCards(dbCards);
        } catch (error) {
          console.error("Error cargando colección:", error);
        }
      } else {
        setCards(getCollection());
      }
      setLoading(false);
    }
    initCollection();
  }, [isSignedIn, isLoaded]);

  const setStats = useMemo(() => {
    return dbSets.map((set) => {
      const uniqueCardsOwned = cards.filter((c) => c.id.startsWith(set.id + "-")).length;
      const totalInSet = set.total || 1;
      const percentage = Math.min(100, Math.round((uniqueCardsOwned / totalInSet) * 100));
      const missing = Math.max(0, totalInSet - uniqueCardsOwned);
      const logoUrl = set.images?.logo || "";
      return { ...set, logo: logoUrl, owned: uniqueCardsOwned, percentage, missing };
    });
  }, [cards, dbSets]);

  const processedCards = useMemo(() => {
    let result = [...cards];
    if (searchTerm) result = result.filter((c) => c.name.toLowerCase().includes(searchTerm.toLowerCase()));
    if (filterSet !== "all") result = result.filter((c) => c.id.startsWith(filterSet));
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

  const totalPages = Math.max(1, Math.ceil(processedCards.length / PAGE_SIZE));
  const pagedCards = useMemo(
    () => processedCards.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [processedCards, page],
  );

  // Reset page on filter/search change
  useEffect(() => { setPage(1); }, [searchTerm, filterSet, filterRarity, sortBy]);

  const getPrice = (rarity: string) => SELL_PRICES[rarity] || 10;

  /** Duplicados vendibles (las favoritas quedan protegidas) y su valor. */
  const duplicateInfo = useMemo(() => {
    const list = cards.filter((card) => card.quantity > 1 && !card.is_favorite);
    let total = 0;
    let units = 0;
    list.forEach((card) => {
      total += (card.quantity - 1) * getPrice(card.rarity);
      units += card.quantity - 1;
    });
    return { list, total, units };
  }, [cards]);

  /**
   * Vende una copia suelta. La comparte el botón de la rejilla y la hoja de
   * acciones. La actualización es optimista pero con red: si el servidor
   * rechaza o revienta se devuelven la carta y las monedas.
   * Devuelve true sólo si la venta se consolidó.
   */
  const sellOneCopy = async (cardId: string, rarity: string) => {
    const card = cards.find((c) => c.id === cardId);
    if (!card || card.quantity <= 1) return false;
    if (!beginSale(cardId)) return false;

    const price = getPrice(rarity);
    const prevCards = cards; // instantánea para el modo invitado
    haptic("success");
    const updatedCards = cards.map((c) => (c.id === cardId ? { ...c, quantity: c.quantity - 1 } : c));
    setCards(updatedCards);
    setSelectedCard((prev: any) =>
      prev && prev.id === cardId ? { ...prev, quantity: prev.quantity - 1 } : prev,
    );
    addCoins(price);

    try {
      if (isSignedIn) {
        // sellCardAction devuelve false si la fila no se pudo actualizar.
        const ok = await sellCardAction(cardId, price);
        if (!ok) throw new Error("venta rechazada");
      } else {
        saveCollectionRaw(updatedCards);
      }
      return true;
    } catch {
      // Revertimos por id (no restaurando la instantánea) para no pisar otros
      // cambios que hayan ocurrido mientras tanto, como marcar una favorita.
      setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, quantity: c.quantity + 1 } : c)));
      setSelectedCard((prev: any) =>
        prev && prev.id === cardId ? { ...prev, quantity: prev.quantity + 1 } : prev,
      );
      addCoins(-price);
      if (!isSignedIn) saveCollectionRaw(prevCards);
      toast("No se pudo vender la carta. Nada ha cambiado.", "error");
      return false;
    } finally {
      endSale();
    }
  };

  const handleSellCard = async (e: React.MouseEvent, cardId: string, rarity: string) => {
    e.stopPropagation();
    await sellOneCopy(cardId, rarity);
  };

  /** Abre la hoja de confirmación (sustituye a confirm()). */
  const requestSellAllDuplicates = () => {
    haptic("tap");
    if (duplicateInfo.list.length === 0) {
      toast("No tienes duplicados (o están protegidos como favoritas).", "info");
      return;
    }
    setConfirmDuplicates(true);
  };

  const handleSellAllDuplicates = async () => {
    const duplicates = duplicateInfo.list;
    if (duplicates.length === 0) return;
    if (!beginSale("duplicates")) return;

    const totalGanancias = duplicateInfo.total;
    const units = duplicateInfo.units;
    const prevCards = cards;
    const newCollection = cards.map((card) =>
      card.quantity > 1 && !card.is_favorite ? { ...card, quantity: 1 } : card,
    );
    setCards(newCollection);
    addCoins(totalGanancias);

    try {
      if (!isSignedIn) {
        saveCollectionRaw(newCollection);
        toast(`+${totalGanancias} monedas por ${units} cartas`, "success");
        return;
      }

      // Cada carta es una petición independiente: con allSettled sabemos
      // exactamente cuáles fallaron y devolvemos sólo esas, en vez de
      // deshacer un lote que en su mayoría sí se vendió.
      const results = await Promise.allSettled(
        duplicates.map((c) => sellAllDuplicatesAction(c.id, getPrice(c.rarity))),
      );
      const failed = new Map<string, number>(); // id -> cantidad previa
      let refund = 0;
      let failedUnits = 0;
      results.forEach((res, i) => {
        const card = duplicates[i];
        const ok = res.status === "fulfilled" && (res.value as any)?.success;
        if (!ok) {
          failed.set(card.id, card.quantity);
          refund += (card.quantity - 1) * getPrice(card.rarity);
          failedUnits += card.quantity - 1;
        }
      });

      if (failed.size > 0) {
        setCards((prev) =>
          prev.map((c) => (failed.has(c.id) ? { ...c, quantity: failed.get(c.id)! } : c)),
        );
        setSelectedCard((prev: any) =>
          prev && failed.has(prev.id) ? { ...prev, quantity: failed.get(prev.id)! } : prev,
        );
        addCoins(-refund);
      }

      if (failed.size === duplicates.length) {
        toast("No se pudo completar la venta. Nada ha cambiado.", "error");
      } else if (failed.size > 0) {
        toast(
          `Vendidas ${units - failedUnits} cartas · ${failedUnits} no se pudieron vender`,
          "error",
        );
      } else {
        toast(`+${totalGanancias} monedas por ${units} cartas`, "success");
      }
    } catch {
      setCards(prevCards);
      addCoins(-totalGanancias);
      if (!isSignedIn) saveCollectionRaw(prevCards);
      toast("No se pudo completar la venta. Nada ha cambiado.", "error");
    } finally {
      endSale();
    }
  };

  const handleSellAllFromModal = async () => {
    if (!selectedCard || selectedCard.quantity <= 1) return;
    const { id, rarity } = selectedCard;
    const prevQuantity = selectedCard.quantity;
    if (!beginSale(id)) return;

    const unitPrice = getPrice(rarity);
    const duplicates = prevQuantity - 1;
    const totalValue = duplicates * unitPrice;
    const prevCards = cards;
    const updatedCards = cards.map((c) => (c.id === id ? { ...c, quantity: 1 } : c));
    addCoins(totalValue);
    setSelectedCard((prev: any) => (prev && prev.id === id ? { ...prev, quantity: 1 } : prev));
    setCards(updatedCards);

    try {
      if (isSignedIn) {
        const res: any = await sellAllDuplicatesAction(id, unitPrice);
        if (!res?.success) throw new Error(res?.error || "venta rechazada");
      } else {
        saveCollectionRaw(updatedCards);
      }
      toast(`+${totalValue} monedas por ${duplicates} duplicadas`, "success");
    } catch {
      setCards((prev) => prev.map((c) => (c.id === id ? { ...c, quantity: prevQuantity } : c)));
      setSelectedCard((prev: any) =>
        prev && prev.id === id ? { ...prev, quantity: prevQuantity } : prev,
      );
      addCoins(-totalValue);
      if (!isSignedIn) saveCollectionRaw(prevCards);
      toast("No se pudieron vender las duplicadas. Nada ha cambiado.", "error");
    } finally {
      endSale();
    }
  };

  /** Alterna deseada/favorita. La comparten el modal y la hoja de acciones. */
  const applyToggleFavorite = async (cardId: string, current: boolean) => {
    // Sin cerrojo, dos toques seguidos lanzan dos peticiones que se pisan y el
    // corazón acaba en el estado contrario al del servidor.
    if (favLockRef.current.has(cardId)) return;
    favLockRef.current.add(cardId);
    const newStatus = !current;
    haptic("select");
    setSelectedCard((prev: any) => (prev && prev.id === cardId ? { ...prev, is_favorite: newStatus } : prev));
    setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, is_favorite: newStatus } : c)));
    try {
      const res = await toggleFavorite(cardId);
      if (res?.error) {
        // Deshacemos el cambio optimista para no mentir sobre el estado real.
        setSelectedCard((prev: any) => (prev && prev.id === cardId ? { ...prev, is_favorite: !newStatus } : prev));
        setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, is_favorite: !newStatus } : c)));
        toast(res.error, "error");
      }
    } catch {
      setSelectedCard((prev: any) => (prev && prev.id === cardId ? { ...prev, is_favorite: !newStatus } : prev));
      setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, is_favorite: !newStatus } : c)));
      toast("No se pudo actualizar el favorito", "error");
    } finally {
      favLockRef.current.delete(cardId);
    }
  };

  const handleToggleFavInModal = async () => {
    if (!selectedCard) return;
    await applyToggleFavorite(selectedCard.id, selectedCard.is_favorite);
  };

  // ── Pulsación larga en la rejilla ───────────────────────────────────────
  const cancelLongPress = () => {
    const lp = longPressRef.current;
    if (lp.timer != null) {
      window.clearTimeout(lp.timer);
      lp.timer = null;
    }
  };

  const startLongPress = (e: React.PointerEvent, card: any) => {
    if (e.button !== 0) return;
    const lp = longPressRef.current;
    cancelLongPress();
    lp.fired = false;
    lp.x = e.clientX;
    lp.y = e.clientY;
    lp.timer = window.setTimeout(() => {
      lp.timer = null;
      lp.fired = true;
      haptic("heavy");
      setActionCard(card);
    }, LONG_PRESS_MS);
  };

  /** Más de 10px de recorrido es un scroll, no una pulsación. */
  const moveLongPress = (e: React.PointerEvent) => {
    const lp = longPressRef.current;
    if (lp.timer == null) return;
    if (Math.abs(e.clientX - lp.x) > LONG_PRESS_SLOP || Math.abs(e.clientY - lp.y) > LONG_PRESS_SLOP) {
      cancelLongPress();
    }
  };

  const openDetail = (card: any) => {
    // Tras una pulsación larga el navegador emite un click: lo ignoramos para
    // no abrir el detalle por debajo de la hoja de acciones.
    if (longPressRef.current.fired) {
      longPressRef.current.fired = false;
      return;
    }
    haptic("select");
    openCardDetail(card);
  };

  useEffect(() => () => cancelLongPress(), []);

  /**
   * Recorrido del modal: se congela al abrirlo. Si se leyera de processedCards
   * en vivo, marcar una favorita reordenaría la lista (las favoritas van
   * primero) y el gesto saltaría a una carta cualquiera. Se guardan sólo los
   * ids; la carta se re-lee de la colección viva al navegar.
   */
  const [navIds, setNavIds] = useState<string[]>([]);

  const openCardDetail = (card: any) => {
    setNavIds(processedCards.map((c) => c.id));
    setSelectedCard(card);
  };

  const selectedIndex = selectedCard ? navIds.indexOf(selectedCard.id) : -1;

  const goToNavIndex = (i: number) => {
    const id = navIds[i];
    if (!id) return;
    const live = cards.find((c) => c.id === id);
    if (live) setSelectedCard(live);
  };

  // La carta de la hoja de acciones se lee de la colección viva, para que
  // vender o marcar favorita se refleje sin cerrarla.
  const actionCardLive = actionCard
    ? cards.find((c) => c.id === actionCard.id) || actionCard
    : null;

  const goToPage = (next: number) => {
    haptic("tap");
    setPage(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (loading) return <Loader label="Cargando Colección" />;

  return (
    <div className="select-none w-full">
      <PageHeader
        title="Mi Colección"
        subtitle="Tus cartas, progreso y estadísticas"
        actions={
          <button
            onClick={requestSellAllDuplicates}
            disabled={isSelling}
            aria-busy={pendingSale === "duplicates"}
            // En móvil el texto va oculto con `hidden` (display:none), que lo
            // saca del árbol de accesibilidad: sin esta etiqueta el botón
            // quedaría sin nombre para un lector de pantalla.
            aria-label="Limpiar duplicados"
            className="flex items-center gap-2 chip ink-soft hover:ink px-3 py-2 rounded-xl text-xs font-medium transition press touch-target justify-center disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            </svg>
            <span className="hidden sm:inline">Limpiar duplicados</span>
          </button>
        }
      />

      <div className="w-full flex flex-col gap-6">
        {/* PROGRESS PANEL */}
        <div>
          <button
            onClick={() => { haptic("tap"); setShowStats(!showStats); }}
            aria-expanded={showStats}
            className="w-full surface surface-hover rounded-2xl px-5 py-4 flex justify-between items-center group"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl surface-2 flex items-center justify-center">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5 accent">
                  <path d="M3 3v18h18" />
                  <path d="M7 14l4-4 4 4 6-6" />
                </svg>
              </div>
              <div className="text-left">
                <h3 className="font-semibold text-sm">Progreso de colección</h3>
                <p className="text-xs ink-soft">{showStats ? "Ocultar detalles" : "Ver progreso por expansión"}</p>
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
                transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                className="overflow-hidden"
              >
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
                  {setStats.map((stat, idx) => (
                    <motion.div
                      key={stat.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.03 }}
                    >
                      <Link href={`/album/${stat.id}`} className="block surface surface-hover rounded-2xl p-4 h-full">
                        <div className="flex items-center gap-3 mb-3">
                          {stat.logo && <img src={stat.logo} alt={stat.name} className="h-7 object-contain opacity-90" />}
                          <div className="flex-1 min-w-0">
                            <h3 className="font-medium text-sm truncate">{stat.name}</h3>
                            <p className="text-[10px] ink-faint font-mono tnum">{stat.owned}/{stat.total}</p>
                          </div>
                          <span className="text-xs font-semibold ink-soft tnum">{stat.percentage}%</span>
                        </div>
                        <div className="w-full h-1.5 surface-2 rounded-full overflow-hidden">
                          <div
                            className={stat.percentage === 100 ? "progress-bar h-full" : "progress-bar-blue h-full"}
                            style={{ width: `${stat.percentage}%` }}
                          />
                        </div>
                      </Link>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* TOOLBAR — se queda pegada bajo la TopBar (y bajo el notch) al hacer scroll */}
        <div
          className="surface rounded-2xl px-3 py-3 flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:items-center sticky z-40"
          style={{ top: "calc(var(--sat) + var(--topbar-h) + 8px)" }}
        >
          <div className="input-field flex items-center gap-2 px-3 py-2 rounded-xl flex-1 sm:min-w-[180px]">
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
              aria-label="Buscar en tu colección"
              placeholder="Buscar..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              className="bg-transparent outline-none text-sm flex-1 min-w-0 placeholder:opacity-50 [&::-webkit-search-cancel-button]:hidden"
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => { haptic("tap"); setSearchTerm(""); }}
                aria-label="Limpiar búsqueda"
                className="ink-faint hover:ink shrink-0 -mr-1 press flex h-9 w-9 items-center justify-center rounded-full"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          {/* Rejilla en vez de tira desplazable: un <select> se estira hasta su
              opción más larga, así que con `shrink-0` en una fila horizontal el
              de expansiones (305px) echaba a los otros dos fuera de pantalla.
              Con w-full + min-w-0 el texto se recorta y todo cabe. */}
          <div className="grid grid-cols-2 gap-2 sm:contents">
            <select
              value={filterSet}
              onChange={(e) => { haptic("select"); setFilterSet(e.target.value); }}
              aria-label="Filtrar por expansión"
              className="input-field col-span-2 w-full min-w-0 px-3 py-2.5 rounded-xl text-xs cursor-pointer truncate sm:col-span-1 sm:w-auto"
            >
              <option value="all">Todas las expansiones</option>
              {dbSets.map((set) => (<option key={set.id} value={set.id}>{set.name}</option>))}
            </select>
            <select
              value={filterRarity}
              onChange={(e) => { haptic("select"); setFilterRarity(e.target.value); }}
              aria-label="Filtrar por rareza"
              className="input-field w-full min-w-0 px-3 py-2.5 rounded-xl text-xs cursor-pointer truncate sm:w-auto"
            >
              <option value="all">Toda rareza</option>
              {rarityOptions.map((r) => (<option key={r} value={r}>{r}</option>))}
            </select>
            <select
              value={sortBy}
              onChange={(e) => { haptic("select"); setSortBy(e.target.value); }}
              aria-label="Ordenar por"
              className="input-field w-full min-w-0 px-3 py-2.5 rounded-xl text-xs cursor-pointer truncate sm:w-auto"
            >
              <option value="rarity_desc">Rareza</option>
              <option value="quantity_desc">Cantidad</option>
              <option value="name_asc">Nombre</option>
            </select>
          </div>
        </div>

        {/* GRID */}
        {processedCards.length === 0 ? (
          <div className="surface rounded-2xl py-16 md:py-20 px-6 text-center flex flex-col items-center gap-4">
            <div className="w-14 h-14 rounded-2xl surface-2 flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-7 h-7 ink-faint">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
            </div>
            <div>
              <p className="ink font-medium">{cards.length === 0 ? "Aún no tienes cartas" : "Sin resultados"}</p>
              <p className="ink-soft text-sm mt-1">{cards.length === 0 ? "Abre tu primer sobre para empezar" : "Prueba otros filtros"}</p>
            </div>
            {cards.length === 0 && (
              <Link href="/" className="btn-primary press px-5 py-2.5 rounded-xl text-sm font-medium">Abrir sobres</Link>
            )}
          </div>
        ) : (
          // 3 columnas en móvil: a 2 las cartas salían enormes y apenas cabían
          // dos filas en pantalla.
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:gap-4 lg:grid-cols-6">
            {pagedCards.map((card) => (
              <div
                key={card.id}
                className="relative group cursor-zoom-in"
                tabIndex={0}
                aria-label={`Ver ${card.name}`}
                onClick={() => openDetail(card)}
                onPointerDown={(e) => startLongPress(e, card)}
                onPointerMove={moveLongPress}
                onPointerUp={cancelLongPress}
                onPointerCancel={cancelLongPress}
                onContextMenu={(e) => {
                  // Sólo tapamos el menú nativo cuando la pulsación larga es
                  // nuestra; con el ratón el menú del navegador sigue saliendo.
                  const lp = longPressRef.current;
                  if (lp.timer != null || lp.fired) e.preventDefault();
                }}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    haptic("select");
                    setSelectedCard(card);
                  }
                  // Equivalente de teclado a la pulsación larga.
                  if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                    e.preventDefault();
                    haptic("heavy");
                    setActionCard(card);
                  }
                }}
              >
                {card.quantity > 1 && (
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
                <div className="transition transform group-hover:-translate-y-1 duration-300 pointer-events-none">
                  <PokemonCard card={card} reveal={true} interactive={false} />
                </div>
                {/* En táctil no hay hover: la acción se muestra siempre en móvil */}
                <div className="mt-2 flex justify-center opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 transition-opacity duration-300">
                  {card.quantity > 1 ? (
                    <button
                      onClick={(e) => handleSellCard(e, card.id, card.rarity)}
                      // Deshabilitado mientras hay una venta en vuelo: dos
                      // toques seguidos vendían dos copias con una sola
                      // confirmación del servidor.
                      disabled={isSelling}
                      aria-busy={pendingSale === card.id}
                      // El botón no arma la pulsación larga de la carta.
                      onPointerDown={(e) => e.stopPropagation()}
                      className="chip ink text-[10px] min-h-8 px-3 rounded-full press hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100"
                    >
                      {pendingSale === card.id ? "Vendiendo…" : `Vender +${getPrice(card.rarity)}`}
                    </button>
                  ) : (
                    <span className="chip ink-soft text-[10px] px-2 py-1 rounded-full">Única</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* PAGINACIÓN */}
        {processedCards.length > PAGE_SIZE && (
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              onClick={() => goToPage(Math.max(1, page - 1))}
              disabled={page === 1}
              className="btn-ghost press touch-target w-11 h-11 rounded-xl flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label="Anterior"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
            <span className="chip ink px-4 py-2 text-sm font-medium tnum">
              {page} / {totalPages}
              <span className="ink-soft text-xs ml-2">· {processedCards.length} cartas</span>
            </span>
            <button
              onClick={() => goToPage(Math.min(totalPages, page + 1))}
              disabled={page === totalPages}
              className="btn-ghost press touch-target w-11 h-11 rounded-xl flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label="Siguiente"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          </div>
        )}
      </div>

      <ConfirmSheet
        open={confirmDuplicates}
        title="Vender duplicados"
        description={`Se venderán ${duplicateInfo.units} cartas repetidas por ${duplicateInfo.total} monedas. Las favoritas no se tocan.`}
        confirmLabel={`Vender por ${duplicateInfo.total}`}
        destructive
        onConfirm={handleSellAllDuplicates}
        onClose={() => setConfirmDuplicates(false)}
      />

      {/* ACCIONES RÁPIDAS (pulsación larga sobre una carta) */}
      <Sheet
        open={!!actionCardLive}
        onClose={() => setActionCard(null)}
        label={actionCardLive ? `Acciones para ${actionCardLive.name}` : "Acciones"}
      >
        {actionCardLive && (
          <div className="px-5 pt-1 pb-6">
            <div className="flex items-center gap-3">
              {actionCardLive.images?.small && (
                <img
                  src={actionCardLive.images.small}
                  alt=""
                  className="w-12 rounded-lg shrink-0"
                  style={{ boxShadow: "var(--shadow-sm)" }}
                />
              )}
              <div className="min-w-0">
                <p className="ink font-semibold text-[15px] truncate">{actionCardLive.name}</p>
                <p className="ink-faint text-[11px] truncate">
                  {actionCardLive.rarity || "Sin rareza"}
                  {actionCardLive.quantity > 1 ? ` · ${actionCardLive.quantity} copias` : " · copia única"}
                </p>
              </div>
            </div>

            <div className="mt-5 flex flex-col gap-2.5">
              <button
                onClick={() => {
                  haptic("select");
                  setActionCard(null);
                  openCardDetail(actionCardLive);
                }}
                className="btn-ghost press rounded-2xl py-3.5 text-sm font-medium flex items-center justify-center gap-2 touch-target"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                  <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3M11 8v6M8 11h6" />
                </svg>
                Ver detalle
              </button>

              {actionCardLive.quantity > 1 && (
                <button
                  onClick={async () => {
                    const { id, rarity, name } = actionCardLive;
                    setActionCard(null);
                    // Sólo celebramos si el servidor aceptó la venta.
                    const sold = await sellOneCopy(id, rarity);
                    if (sold) toast(`+${getPrice(rarity)} monedas por ${name}`, "success");
                  }}
                  disabled={isSelling}
                  className="btn-ghost press rounded-2xl py-3.5 text-sm font-medium flex items-center justify-center gap-2 touch-target disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                    <circle cx="12" cy="12" r="9" /><path d="M12 7v10M9.5 9.5h4a1.8 1.8 0 0 1 0 3.5h-3a1.8 1.8 0 0 0 0 3.5h4" />
                  </svg>
                  Vender una copia · +{getPrice(actionCardLive.rarity)}
                </button>
              )}

              <button
                onClick={() => {
                  const { id, is_favorite } = actionCardLive;
                  setActionCard(null);
                  applyToggleFavorite(id, is_favorite);
                }}
                className="btn-ghost press rounded-2xl py-3.5 text-sm font-medium flex items-center justify-center gap-2 touch-target"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill={actionCardLive.is_favorite ? "currentColor" : "none"}
                  stroke="currentColor"
                  strokeWidth="2"
                  className="w-4 h-4"
                >
                  <path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 5.5 5.5 5.5 0 0 1 21.5 12c-2.5 4.5-9.5 9-9.5 9z" />
                </svg>
                {actionCardLive.is_favorite ? "Quitar de deseados" : "Añadir a deseados"}
              </button>

              <button
                onClick={() => setActionCard(null)}
                className="btn-ghost press rounded-2xl py-3.5 text-sm font-medium ink-soft touch-target"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}
      </Sheet>

      <CardDetailModal
        card={selectedCard}
        onClose={() => setSelectedCard(null)}
        onToggleFavorite={handleToggleFavInModal}
        onSellAll={handleSellAllFromModal}
        cards={navIds}
        index={selectedIndex}
        onIndexChange={goToNavIndex}
      />
    </div>
  );
}
