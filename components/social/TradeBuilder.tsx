"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import { getTradableCollection, createTradeOffer } from "../../app/social";
import { useToast } from "../ui/Toast";
import Portal from "../ui/Portal";

interface Friend { friend_id: string; friend_name: string; }
interface TradeBuilderProps {
  friend: Friend | null;
  onClose: () => void;
  onSent: () => void;
}

interface TCard { id: string; name: string; rarity: string; quantity: number; images?: { small?: string }; }

// El servidor rechaza las ofertas que pasen de aquí, así que se avisa antes de enviarlas.
const MAX_PER_SIDE = 12;

export default function TradeBuilder({ friend, onClose, onSent }: TradeBuilderProps) {
  const { user } = useUser();
  const toast = useToast();
  const [mine, setMine] = useState<TCard[]>([]);
  const [theirs, setTheirs] = useState<TCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [offer, setOffer] = useState<Record<string, number>>({});   // myCardId -> qty
  const [request, setRequest] = useState<Record<string, number>>({}); // theirCardId -> qty
  const [sending, setSending] = useState(false);
  const [qMine, setQMine] = useState("");
  const [qTheirs, setQTheirs] = useState("");

  useEffect(() => {
    if (!friend || !user) return;
    setLoading(true);
    setOffer({}); setRequest({});
    // Sin vaciar aquí, si la carga falla quedan a la vista las cartas del amigo anterior.
    setMine([]); setTheirs([]);
    Promise.all([
      getTradableCollection(user.id),
      getTradableCollection(friend.friend_id),
    ]).then(([a, b]) => {
      setMine(a as TCard[]);
      setTheirs(b as TCard[]);
    }).catch(() => {
      toast("No se pudieron cargar las cartas", "error");
      onClose();
    }).finally(() => setLoading(false));
    // onClose llega como función nueva en cada render del padre: incluirlo relanzaría la carga.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [friend, user]);

  useEffect(() => {
    if (!friend) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [friend]);

  useEffect(() => {
    if (!friend) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [friend, onClose]);

  const toggle = (side: "offer" | "request", card: TCard) => {
    const setter = side === "offer" ? setOffer : setRequest;
    setter((cur) => {
      const next = { ...cur };
      const have = card.quantity;
      const n = (next[card.id] || 0) + 1;
      if (n > have) delete next[card.id]; // ciclo: vuelve a 0 al pasar el máximo
      else next[card.id] = n;
      return next;
    });
  };

  const offeredIds = useMemo(() => Object.entries(offer).flatMap(([id, q]) => Array(q).fill(id)), [offer]);
  const requestedIds = useMemo(() => Object.entries(request).flatMap(([id, q]) => Array(q).fill(id)), [request]);

  const filteredMine = useMemo(
    () => mine.filter((c) => c.name.toLowerCase().includes(qMine.toLowerCase())),
    [mine, qMine],
  );
  const filteredTheirs = useMemo(
    () => theirs.filter((c) => c.name.toLowerCase().includes(qTheirs.toLowerCase())),
    [theirs, qTheirs],
  );

  const send = async () => {
    if (!friend || offeredIds.length === 0 || requestedIds.length === 0 || sending) return;
    setSending(true);
    const res: any = await createTradeOffer(friend.friend_id, offeredIds, requestedIds);
    setSending(false);
    if (res?.error) { toast(res.error, "error"); return; }
    onSent();
  };

  // Render como función (NO como <Column/>) para evitar remontaje y pérdida de foco al filtrar.
  const renderColumn = (
    title: string, cards: TCard[], selected: Record<string, number>,
    side: "offer" | "request", q: string, setQ: (v: string) => void, accent: string,
  ) => (
    <div className="surface-2 rounded-2xl p-3 flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-2 px-1">
        <h4 className="text-xs font-semibold uppercase tracking-wider ink-soft">{title}</h4>
        {/* `accent` es un color CSS del tema (--ok / --warn-ink), no una
            clase: `.accent` y text-cyan-400 daban 2,4:1 y 2,1:1 en claro. */}
        <span className="text-[10px] font-bold" style={{ color: accent }}>{Object.values(selected).reduce((a, b) => a + b, 0)}</span>
      </div>
      <div className="input-field rounded-xl px-3 py-2 flex items-center gap-2 mb-2">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5 ink-faint">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
        </svg>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrar…"
          className="bg-transparent outline-none text-sm flex-1 min-w-0" />
      </div>
      {/* La columna es celda de un grid de filas automáticas, así que sin tope crecería
          con todas las cartas: en móvil se reparte el alto real entre las dos columnas.
          El suelo de 96px evita que la rejilla desaparezca cuando el teclado deja
          --app-height por debajo del descuento; el contenedor del panel ya hace scroll. */}
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 overflow-y-auto custom-scrollbar pr-1 flex-1 max-h-[max(96px,calc((var(--app-height)_-_260px)_/_2))] md:max-h-[max(96px,calc(var(--app-height)_-_260px))]" data-lenis-prevent>
        {cards.length === 0 && <p className="col-span-full text-center text-xs ink-faint py-8">Sin cartas</p>}
        {cards.map((c) => {
          const sel = selected[c.id] || 0;
          return (
            // `press-flat` y no `press`: el botón es ancestro de la carta y
            // `.press` escala, que la rasteriza y la deja borrosa en iPhone.
            <button
              key={c.id}
              onClick={() => toggle(side, c)}
              className={`relative rounded-lg overflow-hidden border-2 transition press-flat ${sel > 0 ? "border-[var(--accent)] ring-accent" : "border-transparent hover:border-[var(--border-strong)]"}`}
              title={c.name}
            >
              {c.images?.small && <img src={c.images.small} alt={c.name} loading="lazy" className="w-full h-auto" />}
              {/* El contador va OPACO sobre la ilustración: llevaba un
                  backdrop-blur, y un backdrop-filter encima de la carta obliga
                  a leerla y desenfocarla en cada fotograma. Un relleno de
                  papel se lee igual y no cuesta nada. */}
              {c.quantity > 1 && (
                <span
                  className="absolute top-1 left-1 chip text-[9px] px-1.5 py-0.5 font-bold"
                  style={{ background: "var(--surface)" }}
                >×{c.quantity}</span>
              )}
              {sel > 0 && (
                <span className="absolute top-1 right-1 w-5 h-5 rounded-full btn-accent text-[10px] font-bold flex items-center justify-center">
                  {sel}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <Portal>
    <AnimatePresence>
      {friend && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-x-0 top-0 z-[100] flex items-end md:items-center justify-center md:p-6"
          // En iOS el viewport de layout no encoge con el teclado: sin esto el panel
          // quedaría debajo de él.
          style={{ bottom: "var(--keyboard)" }}
          onClick={onClose}
        >
          {/* El telón con el desenfoque es HERMANO del panel y no este
              contenedor: dentro se pintan dos rejillas de cartas, y un
              backdrop-filter en un ancestro las rasteriza (borrosas en
              iPhone). Mismo --scrim que Sheet y que la ficha de carta. */}
          <div
            aria-hidden="true"
            className="absolute inset-0 backdrop-blur-md"
            style={{ background: "var(--scrim)" }}
          />
          {/* Entra con opacidad y desplazamiento, sin `scale`: el panel es
              ancestro de las cartas y una escala, aunque dure 0,3 s, las
              rasteriza a otro tamaño. `relative` para quedar sobre el telón. */}
          <motion.div
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={`Nuevo intercambio con ${friend.friend_name}`}
            className="relative w-full max-w-4xl bg-[var(--surface)] border border-[var(--border)] rounded-t-3xl md:rounded-3xl shadow-2xl flex flex-col max-h-[calc(var(--app-height)_-_var(--sat)_-_16px)] md:max-h-[calc(var(--app-height)_-_64px)] overflow-hidden"
          >
            {/* Header */}
            <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wider ink-faint">Nuevo intercambio</p>
                <h3 className="text-lg font-bold tracking-tight truncate">con {friend.friend_name}</h3>
              </div>
              <button onClick={onClose} aria-label="Cerrar" className="touch-target shrink-0 rounded-xl btn-ghost press flex items-center justify-center">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {loading ? (
              <div className="flex-1 flex items-center justify-center py-20">
                <div className="w-8 h-8 border-2 border-[var(--border)] border-t-[var(--accent)] rounded-full animate-spin" />
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-4 grid grid-cols-1 md:grid-cols-2 gap-3" data-lenis-prevent>
                {renderColumn("Ofreces", filteredMine, offer, "offer", qMine, setQMine, "var(--ok)")}
                {renderColumn("Pides", filteredTheirs, request, "request", qTheirs, setQTheirs, "var(--warn-ink)")}
              </div>
            )}

            {/* Footer */}
            <div
              className="px-4 py-3 border-t border-[var(--border)] flex items-center gap-3"
              // Con el teclado desplegado ya no hay barra de gestos que esquivar.
              style={{ paddingBottom: "max(12px, calc(var(--sab) - var(--keyboard) + 12px))" }}
            >
              <div className="flex-1 text-xs ink-soft">
                <span
                  className="font-semibold"
                  style={{ color: offeredIds.length > MAX_PER_SIDE ? "var(--danger-ink)" : "var(--ok)" }}
                >
                  {offeredIds.length}/{MAX_PER_SIDE}
                </span> ofrecidas ·{" "}
                <span
                  className="font-semibold"
                  style={{ color: requestedIds.length > MAX_PER_SIDE ? "var(--danger-ink)" : "var(--warn-ink)" }}
                >
                  {requestedIds.length}/{MAX_PER_SIDE}
                </span> pedidas
              </div>
              <button
                onClick={send}
                disabled={
                  offeredIds.length === 0 || requestedIds.length === 0 || sending ||
                  offeredIds.length > MAX_PER_SIDE || requestedIds.length > MAX_PER_SIDE
                }
                className="btn-accent press px-6 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {sending ? "Enviando…" : "Enviar oferta"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
    </Portal>
  );
}
