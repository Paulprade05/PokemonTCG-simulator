"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { AnimatePresence, motion } from "framer-motion";
import { syncUserName } from "../action";
import {
  getSocialOverview, addFriend, acceptFriend, removeFriendship, searchUsersByName,
  getIncomingTradeOffers, getOutgoingTradeOffers, getTradeHistory,
  acceptTradeOffer, declineTradeOffer, cancelTradeOffer,
} from "../social";
import PageHeader from "../../components/PageHeader";
import Loader from "../../components/Loader";
import TradeBuilder from "../../components/social/TradeBuilder";
import Sheet from "../../components/ui/Sheet";
import ConfirmSheet from "../../components/ui/ConfirmSheet";
import { useToast } from "../../components/ui/Toast";
import { useHaptics } from "../../hooks/useHaptics";
import { useImmersive } from "../../components/AppShell";

type Tab = "amigos" | "recibidas" | "enviadas" | "historial";

/** Baja pendiente de confirmar: una petición ignorada o una amistad eliminada. */
type PendingRemove = { id: number; name: string; kind: "friend" | "request" };
/** Oferta enviada pendiente de confirmar su cancelación. */
type PendingCancel = { id: number; name: string };

export default function SocialPage() {
  const { user, isLoaded, isSignedIn } = useUser();
  const [tab, setTab] = useState<Tab>("amigos");
  const [loading, setLoading] = useState(true);

  const [friends, setFriends] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [incoming, setIncoming] = useState<any[]>([]);
  const [outgoing, setOutgoing] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);

  const [tradeFriend, setTradeFriend] = useState<any | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<PendingRemove | null>(null);
  const [pendingCancel, setPendingCancel] = useState<PendingCancel | null>(null);

  const toast = useToast();
  const haptic = useHaptics();

  // Mientras hay una capa a pantalla completa encima, la barra de pestañas sobra.
  useImmersive(showAdd || !!tradeFriend);

  const refresh = useCallback(async () => {
    if (!isSignedIn) return;
    const [ov, inc, out, hist] = await Promise.all([
      getSocialOverview(), getIncomingTradeOffers(), getOutgoingTradeOffers(), getTradeHistory(),
    ]);
    setFriends(ov.friends);
    setRequests(ov.requests);
    setIncoming(inc as any[]);
    setOutgoing(out as any[]);
    setHistory(hist as any[]);
    setLoading(false);
  }, [isSignedIn]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) { setLoading(false); return; }
    syncUserName().then(refresh);
  }, [isLoaded, isSignedIn, refresh]);

  /* ---- acciones ---- */

  const handleAcceptFriend = useCallback(async (id: number, name: string) => {
    haptic("select");
    const r: any = await acceptFriend(id);
    if (r?.error) toast(r.error, "error");
    else toast(`Ahora eres amigo de ${name}`, "success");
    refresh();
  }, [haptic, toast, refresh]);

  const handleRemoveConfirmed = useCallback(async () => {
    if (!pendingRemove) return;
    const { id, name, kind } = pendingRemove;
    haptic("warning");
    const r: any = await removeFriendship(id);
    if (r?.error) toast(r.error, "error");
    else toast(kind === "request" ? `Petición de ${name} ignorada` : `${name} ya no está en tus amigos`, "info");
    refresh();
  }, [pendingRemove, haptic, toast, refresh]);

  const handleAcceptTrade = useCallback(async (id: number) => {
    haptic("select");
    const r: any = await acceptTradeOffer(id);
    if (r?.error) toast(r.error, "error");
    else toast("Intercambio completado", "success");
    refresh();
  }, [haptic, toast, refresh]);

  const handleDeclineTrade = useCallback(async (id: number) => {
    haptic("warning");
    const r: any = await declineTradeOffer(id);
    if (r?.error) toast(r.error, "error");
    else toast("Oferta rechazada", "info");
    refresh();
  }, [haptic, toast, refresh]);

  const handleCancelConfirmed = useCallback(async () => {
    if (!pendingCancel) return;
    haptic("warning");
    const r: any = await cancelTradeOffer(pendingCancel.id);
    if (r?.error) toast(r.error, "error");
    else toast("Oferta cancelada", "info");
    refresh();
  }, [pendingCancel, haptic, toast, refresh]);

  if (!isLoaded || loading) return <Loader label="Cargando red social" />;

  if (!isSignedIn) {
    return (
      <div className="flex flex-col items-center justify-center text-center py-24">
        <h2 className="text-xl font-bold mb-2">Inicia sesión para conectar</h2>
        <p className="ink-soft text-sm mb-5">Añade amigos e intercambia cartas.</p>
        <Link href="/" className="btn-accent press px-6 py-2.5 rounded-xl text-sm font-semibold">Volver al inicio</Link>
      </div>
    );
  }

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "amigos", label: "Amigos", badge: requests.length || undefined },
    { id: "recibidas", label: "Recibidas", badge: incoming.length || undefined },
    { id: "enviadas", label: "Enviadas", badge: outgoing.length || undefined },
    { id: "historial", label: "Historial" },
  ];

  return (
    <div className="w-full">
      <PageHeader
        title="Social"
        subtitle="Amigos e intercambios"
        actions={
          <button
            onClick={() => { haptic("tap"); setShowAdd(true); }}
            aria-label="Añadir amigo"
            className="btn-accent press touch-target px-4 py-2 rounded-xl text-sm font-semibold flex items-center justify-center gap-2"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" />
            </svg>
            <span className="hidden sm:inline">Añadir</span>
          </button>
        }
      />

      {/* Tabs — scroll horizontal propio, hay que apartar a Lenis */}
      <div data-lenis-prevent className="flex gap-1 p-1 surface rounded-2xl mb-6 overflow-x-auto no-scrollbar overscroll-x-contain">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => { if (t.id !== tab) haptic("select"); setTab(t.id); }}
            aria-pressed={tab === t.id}
            className={`relative flex-1 min-w-fit px-4 py-2.5 rounded-xl text-sm font-medium transition whitespace-nowrap ${tab === t.id ? "ink" : "ink-soft hover:ink"}`}
          >
            {tab === t.id && (
              <motion.span layoutId="social-tab" className="absolute inset-0 rounded-xl bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] border border-[color-mix(in_srgb,var(--accent)_28%,transparent)]" transition={{ type: "spring", stiffness: 400, damping: 32 }} />
            )}
            <span className="relative z-10 flex items-center justify-center gap-2">
              {t.label}
              {t.badge ? <span className="bg-[var(--accent)] text-[#04110c] text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center tnum">{t.badge}</span> : null}
            </span>
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.25 }}
        >
          {tab === "amigos" && (
            <AmigosTab
              friends={friends} requests={requests} myId={user?.id}
              onAccept={handleAcceptFriend}
              onRemove={(id: number, name: string, kind: "friend" | "request") => {
                haptic("tap");
                setPendingRemove({ id, name, kind });
              }}
              onTrade={(f: any) => { haptic("tap"); setTradeFriend(f); }}
            />
          )}
          {tab === "recibidas" && (
            <IncomingTab
              offers={incoming}
              onAccept={handleAcceptTrade}
              onDecline={handleDeclineTrade}
            />
          )}
          {tab === "enviadas" && (
            <OutgoingTab
              offers={outgoing}
              onCancel={(id: number, name: string) => { haptic("tap"); setPendingCancel({ id, name }); }}
            />
          )}
          {tab === "historial" && <HistoryTab items={history} />}
        </motion.div>
      </AnimatePresence>

      <TradeBuilder
        friend={tradeFriend}
        onClose={() => setTradeFriend(null)}
        onSent={() => {
          haptic("success");
          toast("Oferta enviada", "success");
          setTradeFriend(null);
          setTab("enviadas");
          refresh();
        }}
      />
      <AddFriendSheet open={showAdd} onClose={() => setShowAdd(false)} onChanged={refresh} myId={user?.id} />

      <ConfirmSheet
        open={!!pendingRemove}
        title={pendingRemove?.kind === "request" ? "Ignorar petición" : "Eliminar amigo"}
        description={
          pendingRemove?.kind === "request"
            ? `Se descartará la petición de ${pendingRemove?.name}. Podrá volver a enviarte otra más adelante.`
            : `${pendingRemove?.name} dejará de aparecer en tu lista de amigos. Tus cartas no se ven afectadas.`
        }
        confirmLabel={pendingRemove?.kind === "request" ? "Ignorar" : "Eliminar"}
        destructive
        onConfirm={handleRemoveConfirmed}
        onClose={() => setPendingRemove(null)}
      />

      <ConfirmSheet
        open={!!pendingCancel}
        title="Cancelar oferta"
        description={`Retirarás el intercambio que enviaste a ${pendingCancel?.name}.`}
        confirmLabel="Cancelar oferta"
        cancelLabel="Mantener"
        destructive
        onConfirm={handleCancelConfirmed}
        onClose={() => setPendingCancel(null)}
      />
    </div>
  );
}

/* ---------- AMIGOS ---------- */
function AmigosTab({ friends, requests, myId, onAccept, onRemove, onTrade }: any) {
  const medal = ["🥇", "🥈", "🥉"];
  return (
    <div className="flex flex-col gap-5">
      {requests.length > 0 && (
        <div className="surface rounded-2xl p-4">
          <p className="text-xs font-semibold uppercase tracking-wider ink-soft mb-3">Peticiones · {requests.length}</p>
          <div className="flex flex-col gap-2">
            {requests.map((r: any) => (
              <div key={r.id} className="surface-2 rounded-xl p-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar name={r.requester_name} />
                  <span className="font-medium text-sm truncate">{r.requester_name}</span>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => onAccept(r.id, r.requester_name)} className="btn-accent press px-3 py-2 rounded-lg text-xs font-semibold">Aceptar</button>
                  <button onClick={() => onRemove(r.id, r.requester_name, "request")} className="btn-ghost press px-3 py-2 rounded-lg text-xs">Ignorar</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {friends.map((f: any, i: number) => (
          <motion.div
            key={f.friend_id}
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.03, 0.3) }}
            className={`surface surface-hover rounded-2xl p-4 relative overflow-hidden ${f.isMe ? "ring-accent" : ""}`}
          >
            {i < 3 && <span className="absolute top-3 right-3 text-lg">{medal[i]}</span>}
            <div className="flex items-center gap-3 mb-3">
              <Avatar name={f.friend_name} highlight={f.isMe} />
              <div className="min-w-0">
                <p className="font-semibold text-sm truncate">{f.friend_name}{f.isMe && <span className="ink-faint font-normal"> · tú</span>}</p>
                <p className="text-[11px] ink-faint tnum">{f.stats.unique} únicas · {f.stats.cards} cartas</p>
              </div>
            </div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[10px] uppercase tracking-wider ink-faint">Valor</span>
              <span className="text-sm font-bold accent tabular-nums">{f.stats.value.toLocaleString()} 💰</span>
            </div>
            <div className="flex gap-2">
              <Link href={f.isMe ? "/collection" : `/trainer/${f.friend_id}`} className="flex-1 btn-ghost press text-center text-xs font-medium py-2.5 rounded-lg">
                Ver álbum
              </Link>
              {!f.isMe && (
                <>
                  <button onClick={() => onTrade(f)} className="flex-1 btn-accent press text-xs font-semibold py-2.5 rounded-lg">Intercambiar</button>
                  <button
                    onClick={() => onRemove(f.friendship_id, f.friend_name, "friend")}
                    className="btn-ghost press touch-target px-3 py-2 rounded-lg flex items-center justify-center"
                    title="Eliminar"
                    aria-label={`Eliminar a ${f.friend_name}`}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                    </svg>
                  </button>
                </>
              )}
            </div>
          </motion.div>
        ))}
      </div>

      {friends.length <= 1 && requests.length === 0 && (
        <div className="surface rounded-2xl py-16 text-center">
          <p className="font-medium">Aún no tienes amigos</p>
          <p className="ink-soft text-sm mt-1">Pulsa "Añadir" para buscar entrenadores.</p>
        </div>
      )}
    </div>
  );
}

/* ---------- OFFER CARDS ---------- */
function OfferCards({ cards, label, tint }: { cards: any[]; label: string; tint: string }) {
  return (
    <div className="flex-1 min-w-0">
      <p className={`text-[10px] uppercase tracking-wider font-semibold mb-1.5 ${tint}`}>{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {cards.map((c: any, i: number) => (
          <img key={i} src={c?.images?.small} alt={c?.name} title={c?.name} loading="lazy" className="w-12 rounded-md" />
        ))}
      </div>
    </div>
  );
}

function IncomingTab({ offers, onAccept, onDecline }: any) {
  if (offers.length === 0) return <EmptyState text="No tienes ofertas pendientes" />;
  return (
    <div className="flex flex-col gap-3">
      {offers.map((o: any) => (
        <div key={o.id} className="surface rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Avatar name={o.senderName} small />
            <p className="text-sm"><strong>{o.senderName}</strong> <span className="ink-soft">te propone</span></p>
          </div>
          <div className="flex items-center gap-3 surface-2 rounded-xl p-3 mb-3">
            <OfferCards cards={o.offered} label="Recibes" tint="accent" />
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5 ink-faint shrink-0">
              <path d="M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4" />
            </svg>
            <OfferCards cards={o.requested} label="Entregas" tint="text-cyan-400" />
          </div>
          <div className="flex gap-2">
            <button onClick={() => onAccept(o.id)} className="flex-1 btn-accent press touch-target py-2.5 rounded-xl text-sm font-semibold">Aceptar</button>
            <button onClick={() => onDecline(o.id)} className="btn-ghost press touch-target px-5 py-2.5 rounded-xl text-sm">Rechazar</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function OutgoingTab({ offers, onCancel }: any) {
  if (offers.length === 0) return <EmptyState text="No tienes ofertas enviadas" />;
  return (
    <div className="flex flex-col gap-3">
      {offers.map((o: any) => (
        <div key={o.id} className="surface rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Avatar name={o.receiverName} small />
            <p className="text-sm"><span className="ink-soft">Esperando a</span> <strong>{o.receiverName}</strong></p>
            <span className="ml-auto chip text-[10px] px-2 py-0.5 ink-soft">Pendiente</span>
          </div>
          <div className="flex items-center gap-3 surface-2 rounded-xl p-3 mb-3">
            <OfferCards cards={o.offered} label="Ofreces" tint="accent" />
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5 ink-faint shrink-0">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
            <OfferCards cards={o.requested} label="Pides" tint="text-cyan-400" />
          </div>
          <button onClick={() => onCancel(o.id, o.receiverName)} className="btn-ghost press touch-target w-full py-2.5 rounded-xl text-sm">Cancelar oferta</button>
        </div>
      ))}
    </div>
  );
}

function HistoryTab({ items }: any) {
  if (items.length === 0) return <EmptyState text="Sin intercambios todavía" />;
  const label: Record<string, { t: string; c: string }> = {
    accepted: { t: "Aceptado", c: "accent" },
    declined: { t: "Rechazado", c: "text-rose-400" },
    cancelled: { t: "Cancelado", c: "ink-faint" },
  };
  return (
    <div className="surface rounded-2xl divide-y divide-[var(--border)]">
      {items.map((it: any) => (
        <div key={it.id} className="flex items-center gap-3 p-4">
          <div className={`w-2 h-2 rounded-full shrink-0 ${it.status === "accepted" ? "bg-[var(--accent)]" : it.status === "declined" ? "bg-rose-400" : "bg-[var(--ink-faint)]"}`} />
          <div className="flex-1 min-w-0">
            <p className="text-sm truncate">
              {it.iAmSender ? "Enviaste a" : "Recibiste de"} <strong>{it.otherName}</strong>
            </p>
            <p className="text-[11px] ink-faint tnum">{it.offeredCount} ↔ {it.requestedCount} cartas</p>
          </div>
          <span className={`text-xs font-semibold shrink-0 ${label[it.status]?.c}`}>{label[it.status]?.t}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- ADD FRIEND ---------- */
function AddFriendSheet({ open, onClose, onChanged, myId }: any) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);

  const toast = useToast();
  const haptic = useHaptics();

  // Al cerrar dejamos la hoja limpia para la próxima vez que se abra.
  useEffect(() => {
    if (!open) { setQ(""); setResults([]); setSearching(false); setAdding(null); }
  }, [open]);

  useEffect(() => {
    if (!q.trim() || q.trim().length < 2) { setResults([]); setSearching(false); return; }
    setSearching(true);
    const h = setTimeout(async () => {
      const r = await searchUsersByName(q);
      setResults(r as any[]);
      setSearching(false);
    }, 300);
    return () => clearTimeout(h);
  }, [q]);

  const doAdd = async (identifier: string, name: string) => {
    haptic("select");
    setAdding(identifier);
    const r: any = await addFriend(identifier);
    setAdding(null);
    if (r?.error) { toast(r.error, "error"); return; }
    toast(`Petición enviada a ${name}`, "success");
    // Refleja el nuevo estado sin obligar a repetir la búsqueda.
    setResults((prev) => prev.map((u) => (u.id === identifier ? { ...u, relation: "pending" } : u)));
    onChanged();
  };

  const copyId = async () => {
    haptic("tap");
    try {
      await navigator.clipboard.writeText(myId || "");
      toast("ID copiado", "success");
    } catch {
      toast("No se pudo copiar, mantén pulsado el ID", "error");
    }
  };

  return (
    <Sheet open={open} onClose={onClose} label="Añadir amigo">
      {/* Sheet ya añade la safe area inferior (y la descuenta si sube el teclado),
          así que aquí basta con el respiro visual. */}
      <div className="px-5 pt-2 pb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold ink">Añadir amigo</h3>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="touch-target rounded-xl btn-ghost press flex items-center justify-center"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="input-field rounded-xl px-3 py-2.5 flex items-center gap-2 mb-3">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 ink-faint shrink-0">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
          </svg>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            placeholder="Nombre de entrenador…"
            aria-label="Buscar entrenador"
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="bg-transparent outline-none text-base flex-1 min-w-0 ink"
          />
          {q && (
            <button onClick={() => setQ("")} aria-label="Limpiar búsqueda" className="press ink-faint shrink-0 flex h-9 w-9 items-center justify-center rounded-full">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          )}
        </div>

        <div className="flex flex-col gap-1.5 min-h-[60px]">
          {searching && <p className="text-xs ink-faint text-center py-3">Buscando…</p>}
          {!searching && q.length >= 2 && results.length === 0 && (
            <p className="text-xs ink-faint text-center py-3">Sin resultados</p>
          )}
          {results.map((u: any) => (
            <div key={u.id} className="surface-2 rounded-xl p-2.5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <Avatar name={u.username} small />
                <span className="text-sm font-medium truncate">{u.username}</span>
              </div>
              {u.relation === "accepted" ? <span className="text-[10px] ink-faint shrink-0">Amigos</span>
                : u.relation === "pending" ? <span className="text-[10px] ink-faint shrink-0">Pendiente</span>
                : (
                  <button
                    onClick={() => doAdd(u.id, u.username)}
                    disabled={adding === u.id}
                    className="btn-accent press px-3 py-2 rounded-lg text-xs font-semibold shrink-0 disabled:opacity-60"
                  >
                    {adding === u.id ? "Enviando…" : "Añadir"}
                  </button>
                )}
            </div>
          ))}
        </div>

        <div className="mt-4 pt-4 border-t border-[var(--border)]">
          <p className="text-[10px] uppercase tracking-wider ink-faint mb-2">Tu ID</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 surface-2 rounded-lg px-3 py-2 text-[11px] ink-soft truncate font-mono select-all">{myId}</code>
            <button onClick={copyId} className="btn-ghost press touch-target px-3 py-2 rounded-lg text-xs shrink-0">Copiar</button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}

/* ---------- helpers ---------- */
function Avatar({ name, highlight, small }: { name: string; highlight?: boolean; small?: boolean }) {
  const letter = (name || "?").charAt(0).toUpperCase();
  const size = small ? "w-8 h-8 text-xs" : "w-10 h-10 text-sm";
  return (
    <div className={`${size} rounded-full flex items-center justify-center font-bold shrink-0 ${highlight ? "btn-accent" : "surface-2 ink-soft"}`}>
      {letter}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="surface rounded-2xl py-16 text-center">
      <p className="ink-soft text-sm">{text}</p>
    </div>
  );
}
