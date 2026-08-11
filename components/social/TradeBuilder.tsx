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
    Promise.all([
      getTradableCollection(user.id),
      getTradableCollection(friend.friend_id),
    ]).then(([a, b]) => {
      setMine(a as TCard[]);
      setTheirs(b as TCard[]);
    }).finally(() => setLoading(false));
  }, [friend, user]);

  useEffect(() => {
    if (!friend) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [friend]);

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
        <span className={`text-[10px] font-bold ${accent}`}>{Object.values(selected).reduce((a, b) => a + b, 0)}</span>
      </div>
      <div className="input-field rounded-xl px-3 py-2 flex items-center gap-2 mb-2">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5 ink-faint">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
        </svg>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrar…"
          className="bg-transparent outline-none text-sm flex-1 min-w-0" />
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 overflow-y-auto custom-scrollbar pr-1 flex-1" data-lenis-prevent style={{ maxHeight: "44vh" }}>
        {cards.length === 0 && <p className="col-span-full text-center text-xs ink-faint py-8">Sin cartas</p>}
        {cards.map((c) => {
          const sel = selected[c.id] || 0;
          return (
            <button
              key={c.id}
              onClick={() => toggle(side, c)}
              className={`relative rounded-lg overflow-hidden border-2 transition press ${sel > 0 ? "border-[var(--accent)] ring-accent" : "border-transparent hover:border-[var(--border-strong)]"}`}
              title={c.name}
            >
              {c.images?.small && <img src={c.images.small} alt={c.name} loading="lazy" className="w-full h-auto" />}
              {c.quantity > 1 && (
                <span className="absolute top-1 left-1 chip text-[9px] px-1.5 py-0.5 font-bold backdrop-blur">×{c.quantity}</span>
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
          className="fixed inset-0 z-[100] flex items-end md:items-center justify-center bg-black/80 backdrop-blur-md md:p-6"
          onClick={onClose}
        >
          <motion.div
            initial={{ y: 40, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-4xl bg-[var(--surface)] border border-[var(--border)] rounded-t-3xl md:rounded-3xl shadow-2xl flex flex-col max-h-[94vh] md:max-h-[88vh] overflow-hidden"
          >
            {/* Header */}
            <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between">
              <div>
                <p className="text-[10px] uppercase tracking-wider ink-faint">Nuevo intercambio</p>
                <h3 className="text-lg font-bold tracking-tight">con {friend.friend_name}</h3>
              </div>
              <button onClick={onClose} className="w-9 h-9 rounded-xl btn-ghost press flex items-center justify-center">
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
                {renderColumn("Ofreces", filteredMine, offer, "offer", qMine, setQMine, "accent")}
                {renderColumn("Pides", filteredTheirs, request, "request", qTheirs, setQTheirs, "text-cyan-400")}
              </div>
            )}

            {/* Footer */}
            <div className="px-4 py-3 border-t border-[var(--border)] flex items-center gap-3">
              <div className="flex-1 text-xs ink-soft">
                <span className="accent font-semibold">{offeredIds.length}</span> ofrecidas ·{" "}
                <span className="text-cyan-400 font-semibold">{requestedIds.length}</span> pedidas
              </div>
              <button
                onClick={send}
                disabled={offeredIds.length === 0 || requestedIds.length === 0 || sending}
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
