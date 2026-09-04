"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { motion } from "framer-motion";
import { syncUserName, getProfileStats } from "../action";
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
import { formatNumber } from "../../utils/format";
import { getCollection } from "../../utils/storage";
import { useCurrency, useSesionResuelta } from "../../hooks/useGameCurrency";

type Tab = "perfil" | "amigos" | "recibidas" | "enviadas" | "historial";

/** Baja pendiente de confirmar: una petición ignorada o una amistad eliminada. */
type PendingRemove = { id: number; name: string; kind: "friend" | "request" };
/** Oferta enviada pendiente de confirmar su cancelación. */
type PendingCancel = { id: number; name: string };

export default function SocialPage() {
  const { user, isSignedIn } = useUser();
  // `useSesionResuelta` y no `isLoaded` de Clerk: sin conexión, el script de
  // Clerk no resuelve nunca y la pantalla se quedaba en el esqueleto para
  // siempre. Con el plazo (hooks/useGameCurrency.tsx) se sigue como invitado.
  const sesionResuelta = useSesionResuelta();
  const [tab, setTab] = useState<Tab>("amigos");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [friends, setFriends] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [incoming, setIncoming] = useState<any[]>([]);
  const [outgoing, setOutgoing] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);

  // El invitado no tiene servidor: sus monedas viven en este dispositivo.
  const { coins, loaded: coinsLoaded } = useCurrency();

  // Estadísticas del perfil, con carga y error PROPIOS: van en paralelo a la
  // carga social para que un fetch lento o caído de una no arrastre a la otra.
  const [stats, setStats] = useState<any>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState(false);
  const statsLoadedRef = useRef(false);

  const [tradeFriend, setTradeFriend] = useState<any | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<PendingRemove | null>(null);
  const [pendingCancel, setPendingCancel] = useState<PendingCancel | null>(null);

  // Acciones de intercambio/amistad en vuelo, por id. Sin cerrojo, dos toques
  // rápidos en «Aceptar» lanzan dos acceptTradeOffer concurrentes: el estado
  // pasa a 'accepted' al final de la acción, así que ambas pasan el filtro
  // 'pending' y las cartas se transfieren dos veces. Mismo patrón que el
  // saleLockRef de colección: el ref es el cerrojo real (setState no se ve
  // hasta el siguiente render) y el Set de estado deshabilita los botones.
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  const busyLockRef = useRef<Set<number>>(new Set());
  const beginBusy = useCallback((id: number) => {
    if (busyLockRef.current.has(id)) return false;
    busyLockRef.current.add(id);
    setBusyIds((prev) => { const next = new Set(prev); next.add(id); return next; });
    return true;
  }, []);
  const endBusy = useCallback((id: number) => {
    busyLockRef.current.delete(id);
    setBusyIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
  }, []);

  // Al confirmar, ConfirmSheet cierra y el pendiente pasa a null, pero la hoja
  // sigue montada durante la animación de salida: sin conservar el último valor
  // el texto se veía cambiar a "undefined" mientras se cierra.
  const lastRemove = useRef<PendingRemove | null>(null);
  if (pendingRemove) lastRemove.current = pendingRemove;
  const removeInfo = pendingRemove ?? lastRemove.current;

  const lastCancel = useRef<PendingCancel | null>(null);
  if (pendingCancel) lastCancel.current = pendingCancel;
  const cancelInfo = pendingCancel ?? lastCancel.current;

  const toast = useToast();
  const haptic = useHaptics();

  // Mientras hay una capa a pantalla completa encima, la barra de pestañas sobra.
  useImmersive(showAdd || !!tradeFriend);

  // Las server actions capturan sus errores de SQL, pero un fallo de transporte
  // (sin cobertura, 500, despliegue caducado) sí rechaza: sin este catch la
  // pantalla se quedaba girando para siempre.
  const loadedOnce = useRef(false);
  const refresh = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const [ov, inc, out, hist] = await Promise.all([
        getSocialOverview(), getIncomingTradeOffers(), getOutgoingTradeOffers(), getTradeHistory(),
      ]);
      setFriends(ov.friends);
      setRequests(ov.requests);
      setIncoming(inc as any[]);
      setOutgoing(out as any[]);
      setHistory(hist as any[]);
      loadedOnce.current = true;
      setLoadError(false);
    } catch (err) {
      console.error(err);
      // Si ya hay datos en pantalla (refresco tras una acción) no se vacía la
      // vista: basta con avisar de que la lista puede estar desactualizada.
      if (loadedOnce.current) toast("No se pudo actualizar la lista", "error");
      else setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [isSignedIn, toast]);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    syncUserName().then(refresh).catch((err) => {
      console.error(err);
      setLoadError(true);
      setLoading(false);
    });
  }, [refresh]);

  // getProfileStats devuelve null tanto si falla el SQL como sin sesión, y un
  // fallo de transporte rechaza: ambos casos acaban en el error con reintento.
  const loadStats = useCallback(async () => {
    if (!isSignedIn) return;
    // Los refrescos posteriores (tras un intercambio) van en silencio sobre
    // los datos ya en pantalla, sin volver a enseñar la carga ni un error.
    if (!statsLoadedRef.current) {
      setStatsLoading(true);
      setStatsError(false);
    }
    try {
      const s = await getProfileStats();
      if (s) {
        setStats(s);
        statsLoadedRef.current = true;
        setStatsError(false);
      } else if (!statsLoadedRef.current) {
        setStatsError(true);
      }
    } catch (err) {
      console.error(err);
      if (!statsLoadedRef.current) setStatsError(true);
    } finally {
      setStatsLoading(false);
    }
  }, [isSignedIn]);

  useEffect(() => {
    if (!sesionResuelta) return;
    if (!isSignedIn) { setLoading(false); return; }
    load();
    loadStats();
  }, [sesionResuelta, isSignedIn, load, loadStats]);

  /* ---- acciones ---- */

  const handleAcceptFriend = useCallback(async (id: number, name: string) => {
    if (!beginBusy(id)) return;
    haptic("select");
    try {
      const r: any = await acceptFriend(id);
      if (r?.error) toast(r.error, "error");
      else toast(`Ahora eres amigo de ${name}`, "success");
      await refresh();
    } finally {
      endBusy(id);
    }
  }, [haptic, toast, refresh, beginBusy, endBusy]);

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
    if (!beginBusy(id)) return;
    haptic("select");
    try {
      const r: any = await acceptTradeOffer(id);
      if (r?.error) toast(r.error, "error");
      else {
        toast("Intercambio completado", "success");
        // El intercambio mueve cartas: el valor y los logros del perfil cambian.
        loadStats();
      }
      await refresh();
    } finally {
      endBusy(id);
    }
  }, [haptic, toast, refresh, loadStats, beginBusy, endBusy]);

  const handleDeclineTrade = useCallback(async (id: number) => {
    if (!beginBusy(id)) return;
    haptic("warning");
    try {
      const r: any = await declineTradeOffer(id);
      if (r?.error) toast(r.error, "error");
      else toast("Oferta rechazada", "info");
      await refresh();
    } finally {
      endBusy(id);
    }
  }, [haptic, toast, refresh, beginBusy, endBusy]);

  const handleCancelConfirmed = useCallback(async () => {
    if (!pendingCancel) return;
    const { id } = pendingCancel;
    if (!beginBusy(id)) return;
    haptic("warning");
    try {
      const r: any = await cancelTradeOffer(id);
      if (r?.error) toast(r.error, "error");
      else toast("Oferta cancelada", "info");
      await refresh();
    } finally {
      endBusy(id);
    }
  }, [pendingCancel, haptic, toast, refresh, beginBusy, endBusy]);

  if (!sesionResuelta || loading) return <Loader label="Cargando red social" />;

  if (!isSignedIn) {
    // Sin sesión no hay red social, pero sí progreso local: se enseña para que
    // la pantalla no quede vacía, con el aviso de inicio de sesión debajo.
    return (
      <div className="w-full">
        <PageHeader title="Social" subtitle="Perfil, amigos e intercambios" />
        <GuestStats coins={coins} coinsLoaded={coinsLoaded} />
        <div className="surface rounded-2xl flex flex-col items-center justify-center text-center py-14 px-6">
          <h2 className="text-xl font-bold mb-2">Inicia sesión para conectar</h2>
          <p className="ink-soft text-sm mb-5">Añade amigos e intercambia cartas.</p>
          <Link href="/" className="btn-accent press touch-target px-6 py-2.5 rounded-xl text-sm font-semibold flex items-center justify-center">Volver al inicio</Link>
        </div>
      </div>
    );
  }

  if (loadError) {
    // Mismo patrón que el error de la colección, la vitrina y el álbum de
    // entrenador: la cabecera de la pantalla sigue ahí (se sabe dónde se está
    // y la pestaña de abajo sigue teniendo sentido) y el aviso va en una
    // superficie, no suelto en mitad del fondo.
    return (
      <div className="w-full">
        <PageHeader title="Social" subtitle="Perfil, amigos e intercambios" />
        <div className="surface rounded-2xl px-6 py-16 flex flex-col items-center gap-4 text-center">
          <p className="ink font-medium">No se pudo cargar tu red social</p>
          <p className="ink-soft text-sm -mt-2">Revisa tu conexión e inténtalo de nuevo.</p>
          <button
            onClick={load}
            className="btn-accent press touch-target px-6 rounded-xl text-sm font-semibold flex items-center justify-center"
          >
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "perfil", label: "Perfil" },
    { id: "amigos", label: "Amigos", badge: requests.length || undefined },
    { id: "recibidas", label: "Recibidas", badge: incoming.length || undefined },
    { id: "enviadas", label: "Enviadas", badge: outgoing.length || undefined },
    { id: "historial", label: "Historial" },
  ];

  return (
    <div className="w-full">
      <PageHeader
        title="Social"
        subtitle="Perfil, amigos e intercambios"
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

      {/* SIN ANIMACIÓN DE SALIDA. Iba en un AnimatePresence con mode="wait":
          la pestaña vieja se desvanecía durante 0,25 s y SÓLO ENTONCES entraba
          la nueva, o sea un cuarto de segundo con el hueco vacío en cada toque
          de pestaña, que se lee como una pantalla que se cuelga. Ahora la
          nueva ocupa el sitio en el acto (la `key` remonta el bloque) y entra
          con su fundido corto; la vieja simplemente se va, que es lo que hace
          el cambio de pestaña del sistema. */}
      <motion.div
        key={tab}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
      >
          {tab === "perfil" && (
            <PerfilTab
              stats={stats}
              loading={statsLoading}
              error={statsError}
              onRetry={loadStats}
            />
          )}
          {tab === "amigos" && (
            <AmigosTab
              friends={friends} requests={requests} myId={user?.id}
              onAccept={handleAcceptFriend}
              busyIds={busyIds}
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
              busyIds={busyIds}
            />
          )}
          {tab === "enviadas" && (
            <OutgoingTab
              offers={outgoing}
              busyIds={busyIds}
              onCancel={(id: number, name: string) => { haptic("tap"); setPendingCancel({ id, name }); }}
            />
          )}
          {tab === "historial" && <HistoryTab items={history} />}
      </motion.div>

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
        title={removeInfo?.kind === "request" ? "Ignorar petición" : "Eliminar amigo"}
        description={
          removeInfo?.kind === "request"
            ? `Se descartará la petición de ${removeInfo?.name ?? "este entrenador"}. Podrá volver a enviarte otra más adelante.`
            : `${removeInfo?.name ?? "Este entrenador"} dejará de aparecer en tu lista de amigos. Tus cartas no se ven afectadas.`
        }
        confirmLabel={removeInfo?.kind === "request" ? "Ignorar" : "Eliminar"}
        destructive
        onConfirm={handleRemoveConfirmed}
        onClose={() => setPendingRemove(null)}
      />

      <ConfirmSheet
        open={!!pendingCancel}
        title="Cancelar oferta"
        description={`Retirarás el intercambio que enviaste a ${cancelInfo?.name ?? "este entrenador"}.`}
        confirmLabel="Cancelar oferta"
        cancelLabel="Mantener"
        destructive
        onConfirm={handleCancelConfirmed}
        onClose={() => setPendingCancel(null)}
      />
    </div>
  );
}

/* ---------- PERFIL ---------- */

/** Estadísticas y logros del entrenador (con sesión), con datos del servidor. */
function PerfilTab({ stats, loading, error, onRetry }: any) {
  // Los logros se derivan de las estadísticas: no hay tabla propia en el
  // servidor, así que su definición vive en el cliente.
  const achievements = useMemo(() => {
    const s = stats || {};
    return [
      { id: "first", name: "Primer sobre", desc: "Abre 1 sobre", done: (s.packsOpened || 0) >= 1, icon: "📦" },
      { id: "collector", name: "Coleccionista", desc: "100 cartas únicas", done: (s.totalUnique || 0) >= 100, icon: "🗂️" },
      { id: "hunter", name: "Cazador raro", desc: "10 cartas raras (IR+)", done: (s.rareHits || 0) >= 10, icon: "💎" },
      { id: "rich", name: "Millonario", desc: "Colección por 10.000", done: (s.totalValue || 0) >= 10000, icon: "💰" },
      { id: "setdone", name: "Maestro de set", desc: "Completa 1 set", done: (s.setsCompleted || 0) >= 1, icon: "🏆" },
      { id: "veteran", name: "Veterano", desc: "Abre 100 sobres", done: (s.packsOpened || 0) >= 100, icon: "⭐" },
    ];
  }, [stats]);
  const achievementsDone = achievements.filter((a) => a.done).length;

  if (loading) {
    return (
      <div className="surface rounded-2xl py-16 flex flex-col items-center gap-4">
        <div
          className="w-8 h-8 border-2 rounded-full animate-spin"
          style={{ borderColor: "var(--border)", borderTopColor: "var(--accent)" }}
        />
        <p className="ink-soft text-sm">Cargando tu perfil…</p>
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="surface rounded-2xl py-16 px-6 flex flex-col items-center text-center">
        <p className="font-medium">No se pudieron cargar tus estadísticas</p>
        <p className="ink-soft text-sm mt-1 mb-5">Revisa tu conexión e inténtalo de nuevo.</p>
        <button
          onClick={onRetry}
          className="btn-accent press touch-target px-6 rounded-xl text-sm font-semibold flex items-center justify-center"
        >
          Reintentar
        </button>
      </div>
    );
  }

  return (
    <div className="surface rounded-3xl p-5 md:p-6 overflow-hidden relative">
      <div className="absolute -top-20 -right-20 w-56 h-56 rounded-full blur-3xl pointer-events-none" style={{ background: "radial-gradient(circle, color-mix(in srgb, var(--accent) 22%, transparent), transparent 70%)" }} />

      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-5 relative">
        <div>
          <p className="text-[10px] uppercase tracking-[0.3em] ink-faint">Valor de tu colección</p>
          <p className="text-3xl md:text-4xl font-bold text-gradient mt-1 tabular-nums">
            {formatNumber(stats.totalValue)}
            <span className="text-base ink-faint font-normal ml-2">monedas</span>
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 md:gap-3 md:w-auto">
          {[
            { label: "Cartas", value: stats.totalCards },
            { label: "Únicas", value: stats.totalUnique },
            { label: "Sets", value: `${stats.setsCompleted}/${stats.setsTotal}` },
          ].map((s) => (
            <div key={s.label} className="surface-2 rounded-2xl px-3 md:px-5 py-2.5 text-center md:text-left">
              <p className="text-[9px] uppercase tracking-wider ink-faint">{s.label}</p>
              {/* "Sets" es la cadena "3/12" y no debe pasar por formatNumber. */}
              <p className="text-base md:text-xl font-bold tabular-nums mt-0.5">
                {typeof s.value === "number" ? formatNumber(s.value) : s.value}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Logros compactos. La etiqueta se muestra también en móvil: sin ella la
          fila queda como seis cuadrados grises sin explicación. */}
      <div className="mt-5 pt-4 border-t border-[var(--border)]">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wider ink-faint">Logros</span>
          <span className="tnum text-[11px] font-semibold ink-soft">
            {achievementsDone} de {achievements.length}
          </span>
        </div>
        <div className="grid grid-cols-6 gap-1.5 sm:flex sm:gap-2">
          {achievements.map((ach) => (
            <div
              key={ach.id}
              title={`${ach.name} — ${ach.desc}`}
              // Sin rol el div es genérico y ARIA descarta su aria-label: el
              // lector de pantalla sólo leería el emoji.
              role="img"
              aria-label={`${ach.name}: ${ach.done ? "conseguido" : "pendiente"}`}
              className={`flex aspect-square items-center justify-center rounded-xl border text-base transition sm:aspect-auto sm:h-9 sm:w-9 sm:text-lg ${
                ach.done ? "ring-accent border-transparent" : "surface-2 opacity-30 saturate-0"
              }`}
            >
              {ach.icon}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Resumen local del invitado: lo que hay guardado en este dispositivo. */
function GuestStats({ coins, coinsLoaded }: { coins: number; coinsLoaded: boolean }) {
  // localStorage no existe en el render del servidor: leerlo en un efecto
  // evita un desajuste de hidratación.
  const [local, setLocal] = useState<{ cards: number; unique: number } | null>(null);
  useEffect(() => {
    const col = getCollection();
    setLocal({
      cards: col.reduce((sum: number, c: any) => sum + (c.quantity || 1), 0),
      unique: col.length,
    });
  }, []);

  const tiles = [
    { label: "Cartas", value: local ? formatNumber(local.cards) : "—" },
    { label: "Únicas", value: local ? formatNumber(local.unique) : "—" },
    { label: "Monedas", value: coinsLoaded ? formatNumber(coins) : "—" },
  ];

  return (
    <div className="surface rounded-3xl p-5 mb-6 relative overflow-hidden">
      <div className="absolute -top-20 -right-20 w-56 h-56 rounded-full blur-3xl pointer-events-none" style={{ background: "radial-gradient(circle, color-mix(in srgb, var(--accent) 22%, transparent), transparent 70%)" }} />
      <p className="text-[10px] uppercase tracking-[0.3em] ink-faint relative">Tu progreso en este dispositivo</p>
      <div className="grid grid-cols-3 gap-2 mt-3 relative">
        {tiles.map((t) => (
          <div key={t.label} className="surface-2 rounded-2xl px-3 py-2.5 text-center">
            <p className="text-[9px] uppercase tracking-wider ink-faint">{t.label}</p>
            <p className="text-base font-bold tabular-nums mt-0.5">{t.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- AMIGOS ---------- */
function AmigosTab({ friends, requests, myId, onAccept, onRemove, onTrade, busyIds }: any) {
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
                <div className="flex gap-3 shrink-0">
                  <button
                    onClick={() => onAccept(r.id, r.requester_name)}
                    disabled={busyIds?.has(r.id)}
                    className="btn-accent press touch-target px-3 py-2 rounded-lg text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {busyIds?.has(r.id) ? "Procesando…" : "Aceptar"}
                  </button>
                  <button onClick={() => onRemove(r.id, r.requester_name, "request")} className="btn-ghost press touch-target px-3 py-2 rounded-lg text-xs">Ignorar</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {friends.map((f: any, i: number) => (
          // Sin entrada por tarjeta (fundido escalonado i × 0,03 s): la pantalla
          // ya entra entera desde app/template.tsx y la pestaña desde el bloque
          // de arriba —"una pantalla, una entrada", PageHeader.tsx—. Y framer
          // dejaba `opacity:0` escrito en el HTML servido hasta su primer rAF,
          // que en segundo plano no llega nunca.
          <div
            key={f.friend_id}
            className={`surface surface-hover rounded-2xl p-4 relative overflow-hidden ${f.isMe ? "ring-accent" : ""}`}
          >
            {i < 3 && <span className="absolute top-3 right-3 text-lg">{medal[i]}</span>}
            <div className="flex items-center gap-3 mb-3">
              <Avatar name={f.friend_name} highlight={f.isMe} />
              <div className="min-w-0">
                <p className="font-semibold text-sm truncate">{f.friend_name}{f.isMe && <span className="ink-faint font-normal"> · tú</span>}</p>
                <p className="text-[11px] ink-faint tnum">{formatNumber(f.stats.unique)} únicas · {formatNumber(f.stats.cards)} cartas</p>
              </div>
            </div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[10px] uppercase tracking-wider ink-faint">Valor</span>
              <span className="text-sm font-bold accent tabular-nums">{formatNumber(f.stats.value)} 💰</span>
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
          </div>
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

function IncomingTab({ offers, onAccept, onDecline, busyIds }: any) {
  if (offers.length === 0) return <EmptyState text="No tienes ofertas pendientes" />;
  return (
    <div className="flex flex-col gap-3">
      {offers.map((o: any) => {
        // Con una acción en vuelo se bloquean ambos botones de la oferta:
        // aceptar y rechazar la misma oferta a la vez la transferiría dos veces.
        const busy = busyIds?.has(o.id);
        return (
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
            <button
              onClick={() => onAccept(o.id)}
              disabled={busy}
              className="flex-1 btn-accent press touch-target py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? "Procesando…" : "Aceptar"}
            </button>
            <button
              onClick={() => onDecline(o.id)}
              disabled={busy}
              className="btn-ghost press touch-target px-5 py-2.5 rounded-xl text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Rechazar
            </button>
          </div>
        </div>
        );
      })}
    </div>
  );
}

function OutgoingTab({ offers, onCancel, busyIds }: any) {
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
          <button
            onClick={() => onCancel(o.id, o.receiverName)}
            disabled={busyIds?.has(o.id)}
            className="btn-ghost press touch-target w-full py-2.5 rounded-xl text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busyIds?.has(o.id) ? "Procesando…" : "Cancelar oferta"}
          </button>
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
  const [searchError, setSearchError] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);

  const toast = useToast();
  const haptic = useHaptics();

  // Al cerrar dejamos la hoja limpia para la próxima vez que se abra.
  useEffect(() => {
    if (!open) { setQ(""); setResults([]); setSearching(false); setSearchError(false); setAdding(null); }
  }, [open]);

  useEffect(() => {
    if (!q.trim() || q.trim().length < 2) { setResults([]); setSearching(false); setSearchError(false); return; }
    setSearching(true);
    setSearchError(false);
    // Cancelar el temporizador no cancela la petición ya lanzada: sin esta
    // bandera, una consulta lenta de un texto anterior pisaba los resultados
    // del texto actual.
    let cancelled = false;
    const h = setTimeout(async () => {
      try {
        const r = await searchUsersByName(q);
        if (!cancelled) setResults(r as any[]);
      } catch (err) {
        console.error(err);
        if (!cancelled) { setResults([]); setSearchError(true); }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(h); };
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
          {!searching && searchError && (
            <p className="text-xs text-center py-3" style={{ color: "var(--danger)" }}>
              No se pudo buscar. Revisa tu conexión.
            </p>
          )}
          {!searching && !searchError && q.length >= 2 && results.length === 0 && (
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
                    className="btn-accent press touch-target px-3 py-2 rounded-lg text-xs font-semibold shrink-0 disabled:opacity-60"
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
