"use client";

import { useCallback, useEffect, useState, useMemo, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import {
  getFullCollection,
  sellCardAction,
  toggleFavorite,
  sellAllDuplicatesAction,
  sellAllDuplicatesBulkAction,
  getSetsFromDB,
  nombresDeCartas,
} from "../action";
import { getCollection, saveCollectionRaw } from "../../utils/storage";
import { useCurrency } from "../../hooks/useGameCurrency";
import { useHaptics } from "../../hooks/useHaptics";
import { useToast } from "../../components/ui/Toast";
import ConfirmSheet from "../../components/ui/ConfirmSheet";
import Sheet from "../../components/ui/Sheet";
import { RARITY_RANK, valorDeVenta } from "../../utils/constanst";
import { formatNumber } from "../../utils/format";
import PokemonCard from "../../components/PokemonCard";
import PageHeader from "../../components/PageHeader";
import Loader from "../../components/Loader";
import CardDetailModal from "../../components/CardDetailModal";
import Link from "next/link";
import type { CartaEnColeccion, Expansion } from "../../utils/tipos";

/**
 * Cartas del invitado con el rótulo y la ilustración del idioma ACTUAL.
 *
 * Su colección vive en localStorage y guarda el nombre y la imagen con los que
 * se abrió el sobre; ese almacén es su partida y no se reescribe. Al cambiar de
 * idioma, entonces, las cartas viejas seguirían con el nombre viejo: aquí se
 * repinta lo guardado pidiendo al servidor sólo el rótulo por id (unos pocos KB
 * y una única petición), sin tocar ni una clave del almacenamiento.
 *
 * Funciona en los dos sentidos: en español el rótulo sale del diccionario (sin
 * consultas), y en inglés del catálogo, que es el único sitio donde está el
 * nombre inglés de una carta que se guardó traducida.
 */
async function enIdiomaLocal(cartas: CartaEnColeccion[]): Promise<CartaEnColeccion[]> {
  if (cartas.length === 0) return cartas;
  try {
    const traducidas = await nombresDeCartas(cartas.map((c) => c.id));
    if (Object.keys(traducidas).length === 0) return cartas;
    return cartas.map((c) => {
      const t = traducidas[c.id];
      // Sin ilustración española (promos, Galerías...) se conserva la guardada.
      return t?.name ? { ...c, name: t.name, images: t.images ?? c.images } : c;
    });
  } catch {
    // Sin cobertura la colección local se pinta igual, con lo que hay guardado.
    return cartas;
  }
}

export default function CollectionPage() {
  const { isSignedIn, isLoaded } = useUser();
  // Tipadas: son las dos listas de las que cuelga la pantalla entera.
  const [cards, setCards] = useState<CartaEnColeccion[]>([]);
  const [dbSets, setDbSets] = useState<Expansion[]>([]);
  const { coins, addCoins, setCoins } = useCurrency();
  const [showStats, setShowStats] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState("rarity_desc");
  const [filterSet, setFilterSet] = useState("all");
  const [filterRarity, setFilterRarity] = useState("all");
  const [selectedCard, setSelectedCard] = useState<CartaEnColeccion | null>(null);
  const [actionCard, setActionCard] = useState<CartaEnColeccion | null>(null);
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

  /**
   * Carga inicial. Todo va dentro del mismo try: si se cae el transporte de una
   * server action (sin cobertura, 500, despliegue caducado) o el JSON del modo
   * invitado está corrupto, el `finally` apaga el spinner y `loadError` ofrece
   * reintentar, en vez de dejar la pantalla girando o fingir una colección
   * vacía a quien tiene cientos de cartas.
   */
  const loadCollection = useCallback(async () => {
    if (!isLoaded) return;
    setLoading(true);
    setLoadError(false);
    try {
      const sets = await getSetsFromDB();
      setDbSets(sets);
      if (isSignedIn) {
        // Ya viene traducida: la capa de idioma se aplica en el servidor.
        setCards(await getFullCollection());
      } else {
        setCards(await enIdiomaLocal(getCollection()));
      }
    } catch (error) {
      console.error("Error cargando colección:", error);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [isSignedIn, isLoaded]);

  useEffect(() => {
    loadCollection();
  }, [loadCollection]);

  /**
   * Progreso por expansión.
   *
   * DOS ARREGLOS AQUÍ:
   *
   * 1. EL DENOMINADOR. Era `set.total`, el que declara el set, que viene de la
   *    API y no coincide con las cartas que existen (la ingesta lo documenta y
   *    además es reanudable: un set a medio descargar declara de más). En esas
   *    expansiones el 100% era inalcanzable. Ahora manda `cardsCount`, el
   *    conteo real que devuelve getSetsFromDB; `total` queda de respaldo para
   *    el modo local, donde loadLocalSets no lo trae.
   *
   * 2. LA LISTA. Se mapeaba `dbSets` ENTERO. Con la base sincronizada por el
   *    cron son 171 tarjetas con 171 logos remotos, casi todas a 0%: la sección
   *    que debería decir "cómo voy" se convertía en un catálogo. Ahora sólo
   *    salen las expansiones en las que hay algo, ordenadas por progreso, y el
   *    resto queda tras el botón de "ver todas".
   *
   * `totalInSet` se calcula una vez y lo usan el porcentaje, el "n/N" y las que
   * faltan: antes el rótulo pintaba `set.total` crudo mientras el porcentaje
   * usaba el respaldo `|| 1`, así que un set sin total decía "5/" y un 100%.
   */
  const setStats = useMemo(() => {
    const conteoPorSet = new Map<string, number>();
    for (const c of cards) {
      const guion = String(c.id).lastIndexOf("-");
      if (guion <= 0) continue;
      const sid = String(c.id).slice(0, guion);
      conteoPorSet.set(sid, (conteoPorSet.get(sid) ?? 0) + 1);
    }
    return dbSets
      .map((set) => {
        const totalInSet = Number(set.cardsCount) || Number(set.total) || 1;
        // Acotado al catálogo, por lo mismo que en el álbum: el numerador cuenta
        // lo que hay en la colección y el denominador lo que existe hoy, y
        // pueden no cuadrar tras una resiembra.
        const uniqueCardsOwned = Math.min(conteoPorSet.get(set.id) ?? 0, totalInSet);
        const percentage = Math.min(100, Math.round((uniqueCardsOwned / totalInSet) * 100));
        const missing = Math.max(0, totalInSet - uniqueCardsOwned);
        const logoUrl = set.images?.logo || "";
        return {
          ...set,
          logo: logoUrl,
          owned: uniqueCardsOwned,
          totalInSet,
          percentage,
          missing,
        };
      })
      .sort((a, b) => b.percentage - a.percentage || b.owned - a.owned);
  }, [cards, dbSets]);

  /** Sólo las expansiones en las que el jugador tiene algo. */
  const setStatsEmpezados = useMemo(
    () => setStats.filter((s) => s.owned > 0),
    [setStats],
  );
  /** El resto sólo se monta si se piden expresamente. */
  const [verTodasLasExpansiones, setVerTodasLasExpansiones] = useState(false);
  const setStatsVisibles = verTodasLasExpansiones ? setStats : setStatsEmpezados;

  const processedCards = useMemo(() => {
    let result = [...cards];
    if (searchTerm) result = result.filter((c) => c.name.toLowerCase().includes(searchTerm.toLowerCase()));
    // Con el guion: los ids son `set-numero` y sin él "sv8" se llevaría también
    // las de "sv8pt5" (y "swsh1" las de swsh10/11/12).
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

  const totalPages = Math.max(1, Math.ceil(processedCards.length / PAGE_SIZE));
  // El reajuste de `page` vive en un efecto, que corre tras el pintado: sin
  // acotar aquí, escribir en el buscador desde la página 4 deja un frame con la
  // rejilla vacía y "4 / 2" en la paginación.
  const safePage = Math.min(page, totalPages);
  const pagedCards = useMemo(
    () => processedCards.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [processedCards, safePage],
  );

  // Reset page on filter/search change
  useEffect(() => { setPage(1); }, [searchTerm, filterSet, filterRarity, sortBy]);

  /**
   * Precio de vender UNA copia de una carta de la que se tienen `quantity`.
   *
   * Es la misma función que usa el servidor (utils/constanst.ts), y por eso el
   * número que se pinta en el botón es exactamente el que se acaba cobrando:
   * el precio ya no es una constante por rareza, baja con las copias que tienes.
   */
  const precioDeUna = (rarity: string, quantity: number) => valorDeVenta(rarity, quantity, 1);

  /** Duplicados vendibles (las favoritas quedan protegidas) y su valor. */
  const duplicateInfo = useMemo(() => {
    const list = cards.filter((card) => card.quantity > 1 && !card.is_favorite);
    let total = 0;
    let units = 0;
    list.forEach((card) => {
      // No es (copias − 1) × precio: cada copia vale menos que la anterior.
      total += valorDeVenta(card.rarity, card.quantity);
      units += card.quantity - 1;
    });
    return { list, total, units };
  }, [cards]);

  /**
   * Vende una copia suelta. La comparte el botón de la rejilla y la hoja de
   * acciones. La actualización es optimista pero con red: si el servidor
   * rechaza o revienta se devuelven la carta y las monedas.
   * Devuelve las monedas cobradas, o 0 si la venta no se consolidó (quien
   * avisa al jugador necesita el importe, y tras vender ya no se puede
   * recalcular: la carta tiene una copia menos y la tarifa ha cambiado).
   */
  const sellOneCopy = async (cardId: string, rarity: string) => {
    const card = cards.find((c) => c.id === cardId);
    if (!card || card.quantity <= 1) return 0;
    if (!beginSale(cardId)) return 0;

    // Con las copias que tiene AHORA: se va la más profunda, la más barata.
    const price = precioDeUna(rarity, card.quantity);
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
        // El precio lo pone el servidor; el cliente adopta el saldo real que
        // devuelve, en vez de fiarse de su propia suma optimista.
        const res = await sellCardAction(cardId);
        if (!res) throw new Error("venta rechazada");
        setCoins(res.coins);
      } else {
        saveCollectionRaw(updatedCards);
      }
      return price;
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
      return 0;
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

  /**
   * Vacía TODOS los duplicados con UNA sola petición.
   *
   * ANTES: `Promise.all(duplicates.map((c) => sellAllDuplicatesAction(c.id)))`,
   * una server action por carta lanzadas a la vez. Con una expansión completa
   * son cientos de POST simultáneos; el navegador sólo abre seis conexiones por
   * origen y encola el resto, así que la pantalla se quedaba colgada minutos
   * enteros y el saldo iba llegando a trompicones. Ahora es un único `await`
   * contra `sellAllDuplicatesBulkAction`, que vende todo en una sentencia
   * atómica y devuelve cuánto, cuáles y el saldo final.
   *
   * La lista NO se toca hasta que contesta el servidor: sin actualización
   * optimista no hay nada que deshacer si falla, y como el servidor dice
   * EXACTAMENTE qué ids vendió, lo que queda pintado es la verdad (si alguna
   * carta cambió entretanto, sigue con sus copias en vez de aparecer vaciada).
   */
  const handleSellAllDuplicates = async () => {
    const duplicates = duplicateInfo.list;
    if (duplicates.length === 0) return;
    if (!beginSale("duplicates")) return;

    const estimado = duplicateInfo.total;
    const units = duplicateInfo.units;

    try {
      if (!isSignedIn) {
        // Invitado: la colección vive en localStorage y el importe se calcula
        // con la misma función que usaría el servidor.
        const newCollection = cards.map((card) =>
          card.quantity > 1 && !card.is_favorite ? { ...card, quantity: 1 } : card,
        );
        setCards(newCollection);
        saveCollectionRaw(newCollection);
        addCoins(estimado);
        toast(`+${formatNumber(estimado)} monedas por ${formatNumber(units)} cartas`, "success");
        return;
      }

      const res = await sellAllDuplicatesBulkAction();
      if (!res.success) {
        toast("No se pudo completar la venta. Nada ha cambiado.", "error");
        return;
      }
      if (res.sold === 0) {
        toast("No había duplicados que vender.", "info");
        return;
      }

      // El saldo es el que devuelve el servidor, no una suma optimista.
      setCoins(res.coins);
      const vendidas = new Set(res.ids);
      setCards((prev) => prev.map((c) => (vendidas.has(c.id) ? { ...c, quantity: 1 } : c)));
      setSelectedCard((prev: any) =>
        prev && vendidas.has(prev.id) ? { ...prev, quantity: 1 } : prev,
      );
      haptic("success");

      if (res.sold < units) {
        toast(
          `Vendidas ${formatNumber(res.sold)} cartas por ${formatNumber(res.earned)} monedas · ${formatNumber(units - res.sold)} cambiaron y siguen en el álbum`,
          "info",
        );
      } else {
        toast(`+${formatNumber(res.earned)} monedas por ${formatNumber(res.sold)} cartas`, "success");
      }
    } catch {
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

    const duplicates = prevQuantity - 1;
    // Precio decreciente: la suma de las copias, no copias × tarifa.
    const totalValue = valorDeVenta(rarity, prevQuantity);
    const prevCards = cards;
    const updatedCards = cards.map((c) => (c.id === id ? { ...c, quantity: 1 } : c));
    addCoins(totalValue);
    setSelectedCard((prev: any) => (prev && prev.id === id ? { ...prev, quantity: 1 } : prev));
    setCards(updatedCards);

    try {
      if (isSignedIn) {
        const res: any = await sellAllDuplicatesAction(id);
        if (!res?.success) throw new Error(res?.error || "venta rechazada");
        if (typeof res.coins === "number") setCoins(res.coins);
      } else {
        saveCollectionRaw(updatedCards);
      }
      toast(`+${formatNumber(totalValue)} monedas por ${formatNumber(duplicates)} duplicadas`, "success");
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
    // !! porque la columna is_favorite admite NULL: el resto del código ya la
    // lee con COALESCE(..., false) y aquí tiene que valer lo mismo.
    await applyToggleFavorite(selectedCard.id, !!selectedCard.is_favorite);
  };

  // ── Pulsación larga en la rejilla ───────────────────────────────────────
  const cancelLongPress = () => {
    const lp = longPressRef.current;
    if (lp.timer != null) {
      window.clearTimeout(lp.timer);
      lp.timer = null;
    }
  };

  const startLongPress = (e: React.PointerEvent, card: CartaEnColeccion) => {
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

  const openDetail = (card: CartaEnColeccion) => {
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

  const openCardDetail = (card: CartaEnColeccion) => {
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

  // Sin esto, un fallo de carga se presentaba como "Aún no tienes cartas" y se
  // invitaba a gastar monedas a quien ya tiene la colección llena.
  if (loadError) {
    return (
      <div className="w-full">
        <PageHeader title="Mi Colección" subtitle="Tus cartas, progreso y estadísticas" />
        <div className="surface rounded-2xl py-16 md:py-20 px-6 text-center flex flex-col items-center gap-4">
          <div className="w-14 h-14 rounded-2xl surface-2 flex items-center justify-center">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-7 h-7 ink-faint">
              <circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5h.01" />
            </svg>
          </div>
          <div>
            <p className="ink font-medium">No se pudo cargar tu colección</p>
            <p className="ink-soft text-sm mt-1">Comprueba tu conexión e inténtalo de nuevo.</p>
          </div>
          <button
            onClick={() => { haptic("tap"); loadCollection(); }}
            className="btn-primary press touch-target px-5 py-2.5 rounded-xl text-sm font-medium"
          >
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="select-none w-full">
      <PageHeader
        title="Mi Colección"
        subtitle="Tus cartas, progreso y estadísticas"
        actions={
          <>
          {/* LAS DOS PUERTAS A LAS PANTALLAS NUEVAS.
              Están AQUÍ y no en la barra inferior a propósito: la barra tiene
              cuatro pestañas y meter dos más la deja apretada en un móvil
              estrecho. Las dos cuelgan de la colección —la vitrina la enseña y
              la graduación es un servicio sobre ella—, así que la pestaña de
              Colección cubre sus rutas (ver components/nav-items.tsx) y el
              acceso vive donde el jugador ya está mirando sus cartas.
              El rótulo se oculta en móvil como el del botón de al lado; el
              aria-label es lo que lo mantiene con nombre para un lector. */}
          <Link
            href="/vitrina"
            aria-label="Abrir la vitrina"
            className="flex items-center gap-2 chip ink-soft hover:ink px-3 py-2 rounded-xl text-xs font-medium transition press touch-target justify-center"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
            </svg>
            <span className="hidden sm:inline">Vitrina</span>
          </Link>
          <Link
            href="/graduacion"
            aria-label="Graduar cartas"
            className="flex items-center gap-2 chip ink-soft hover:ink px-3 py-2 rounded-xl text-xs font-medium transition press touch-target justify-center"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path d="M12 2 15 9l7 .6-5.3 4.6L18.2 21 12 17.3 5.8 21l1.5-6.8L2 9.6 9 9z" />
            </svg>
            <span className="hidden sm:inline">Graduar</span>
          </Link>
          <button
            onClick={requestSellAllDuplicates}
            disabled={isSelling}
            aria-busy={pendingSale === "duplicates"}
            // En móvil el texto va oculto con `hidden` (display:none), que lo
            // saca del árbol de accesibilidad: sin esta etiqueta el botón
            // quedaría sin nombre para un lector de pantalla.
            aria-label={pendingSale === "duplicates" ? "Vendiendo duplicados" : "Limpiar duplicados"}
            className="flex items-center gap-2 chip ink-soft hover:ink px-3 py-2 rounded-xl text-xs font-medium transition press touch-target justify-center disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {/* El vaciado es una sola petición, pero puede tardar un segundo
                largo con una colección enorme: sin un "Vendiendo…" visible el
                jugador vuelve a pulsar creyendo que no ha pasado nada. */}
            {pendingSale === "duplicates" ? (
              <span className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              </svg>
            )}
            <span className="hidden sm:inline">
              {pendingSale === "duplicates" ? "Vendiendo…" : "Limpiar duplicados"}
            </span>
          </button>
          </>
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
                {setStatsVisibles.length === 0 ? (
                  <p className="text-xs ink-faint text-center py-8">
                    Aún no tienes cartas de ninguna expansión. Abre un sobre para empezar.
                  </p>
                ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
                  {setStatsVisibles.map((stat, idx) => (
                    <motion.div
                      key={stat.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      // Con tope, como en el resumen del sobre: sin él, la
                      // expansión número 60 no aparecía hasta los dos segundos.
                      transition={{ delay: Math.min(idx, 12) * 0.03 }}
                    >
                      <Link href={`/album/${stat.id}`} className="block surface surface-hover rounded-2xl p-4 h-full">
                        <div className="flex items-center gap-3 mb-3">
                          {stat.logo && <img src={stat.logo} alt={stat.name} loading="lazy" decoding="async" className="h-7 object-contain opacity-90" />}
                          <div className="flex-1 min-w-0">
                            <h3 className="font-medium text-sm truncate">{stat.name}</h3>
                            <p className="text-[10px] ink-faint font-mono tnum">{stat.owned}/{stat.totalInSet}</p>
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
                )}

                {/* Las expansiones a cero no entran salvo que se pidan: con la
                    base sincronizada por el cron son más de ciento cincuenta
                    tarjetas con su logo remoto, y la sección dejaba de responder
                    a "cómo voy" para convertirse en un catálogo. */}
                {setStats.length > setStatsEmpezados.length && (
                  <button
                    type="button"
                    onClick={() => setVerTodasLasExpansiones((v) => !v)}
                    className="btn-ghost press touch-target mt-3 w-full rounded-xl text-xs font-medium"
                  >
                    {verTodasLasExpansiones
                      ? "Ver sólo las empezadas"
                      : `Ver las ${formatNumber(setStats.length - setStatsEmpezados.length)} expansiones sin empezar`}
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* TOOLBAR — SE VA CON EL SCROLL. NO ES PEGAJOSA, Y ES A PROPÓSITO.
         *
         * Aquí ha habido dos versiones equivocadas, así que conviene dejarlo
         * escrito para que nadie lo "arregle" otra vez:
         *
         *  1. Era `sticky` y se quedaba clavada bajo la TopBar.
         *  2. Se intentó mejorar ESO —un envoltorio a sangre y opaco, pegado
         *     sin hueco— porque las cartas se veían pasar por detrás.
         *
         * Las dos partían de leer mal lo que se pedía. Lo que molestaba no era
         * CÓMO se pegaba: era que se pegara. En un móvil, la TopBar ya ocupa
         * 64px fijos; sumarle una barra de búsqueda y tres desplegables se come
         * casi un tercio de la pantalla de forma permanente, justo cuando lo
         * que se está haciendo es mirar cartas.
         *
         * Así que la barra vive en el flujo normal: está arriba cuando llegas,
         * y desaparece en cuanto bajas. Para volver a ella se sube, que es
         * exactamente el gesto que ya hace todo el mundo.
         *
         * SI ALGÚN DÍA SE QUIERE RECUPERAR EL ACCESO RÁPIDO sin gastar espacio,
         * la salida NO es volver a `sticky`: es el buscador global que ya
         * existe en la TopBar (la lupa), que busca en todo el catálogo y no
         * ocupa nada. */}
        <div
          className="surface rounded-2xl px-3 py-3 flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:items-center"
        >
          {/* Etiqueta y no contenedor neutro: así tocar el icono o el relleno
              enfoca el campo. min-h-11 son los 44px mínimos de zona táctil. */}
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
                // El área táctil es de 44px, pero los márgenes negativos la
                // meten dentro del relleno del campo: sin ellos la barra da un
                // salto de 18px al escribir la primera letra.
                className="ink-faint hover:ink shrink-0 -mr-1.5 -my-2.5 press flex h-11 w-11 items-center justify-center rounded-full"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </label>

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
              <div key={card.id} className="relative group">
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
                {/* <button> y no un <div tabIndex>: aria-label no se anuncia en
                    un elemento de rol genérico, y así Enter y Espacio abren el
                    detalle por el mismo camino que el toque (que es quien
                    congela navIds), sin duplicar el manejo de teclado. */}
                <button
                  type="button"
                  aria-label={`Ver ${card.name}`}
                  className="block w-full cursor-zoom-in"
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
                    // Equivalente de teclado a la pulsación larga.
                    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                      e.preventDefault();
                      haptic("heavy");
                      setActionCard(card);
                    }
                  }}
                >
                  <div className="transition transform group-hover:-translate-y-1 duration-300 pointer-events-none">
                    <PokemonCard card={card} reveal={true} interactive={false} />
                  </div>
                </button>
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
                      className="chip ink text-[11px] min-h-11 px-4 rounded-full press hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100"
                    >
                      {pendingSale === card.id ? "Vendiendo…" : `Vender +${precioDeUna(card.rarity, card.quantity)}`}
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
              onClick={() => goToPage(Math.max(1, safePage - 1))}
              disabled={safePage === 1}
              className="btn-ghost press touch-target w-11 h-11 rounded-xl flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label="Anterior"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
            <span className="chip ink px-4 py-2 text-sm font-medium tnum">
              {safePage} / {totalPages}
              <span className="ink-soft text-xs ml-2">· {formatNumber(processedCards.length)} cartas</span>
            </span>
            <button
              onClick={() => goToPage(Math.min(totalPages, safePage + 1))}
              disabled={safePage === totalPages}
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
        // El importe se calcula con la misma función que cobra el servidor, y
        // se dice en voz alta por qué no es "repetidas × tarifa": si no, quien
        // haga la multiplicación de cabeza creerá que le han pagado de menos.
        description={`Se venderán ${formatNumber(duplicateInfo.units)} cartas repetidas por ${formatNumber(duplicateInfo.total)} monedas. Cada copia extra de una misma carta vale menos que la anterior. Las favoritas no se tocan.`}
        confirmLabel={`Vender por ${formatNumber(duplicateInfo.total)}`}
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
                    const cobrado = await sellOneCopy(id, rarity);
                    if (cobrado > 0) toast(`+${formatNumber(cobrado)} monedas por ${name}`, "success");
                  }}
                  disabled={isSelling}
                  className="btn-ghost press rounded-2xl py-3.5 text-sm font-medium flex items-center justify-center gap-2 touch-target disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                    <circle cx="12" cy="12" r="9" /><path d="M12 7v10M9.5 9.5h4a1.8 1.8 0 0 1 0 3.5h-3a1.8 1.8 0 0 0 0 3.5h4" />
                  </svg>
                  Vender una copia · +{precioDeUna(actionCardLive.rarity, actionCardLive.quantity)}
                </button>
              )}

              {/* Deseados sólo con sesión: al invitado la acción le fallaría
                  siempre («No estás logueado»), así que no se le ofrece. */}
              {isSignedIn && (
                <button
                  onClick={() => {
                    const { id, is_favorite } = actionCardLive;
                    setActionCard(null);
                    applyToggleFavorite(id, !!is_favorite);
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
              )}

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
        // El favorito/deseados vive en el servidor: al invitado (localStorage)
        // le fallaría siempre con «No estás logueado», así que se le oculta el
        // corazón, igual que ya se oculta el botón de deseos del modal.
        onToggleFavorite={isSignedIn ? handleToggleFavInModal : undefined}
        onSellAll={handleSellAllFromModal}
        cards={navIds}
        index={selectedIndex}
        onIndexChange={goToNavIndex}
      />
    </div>
  );
}
