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
import AvisoInvitado from "../../components/ui/AvisoInvitado";
import CabeceraDeHoja from "../../components/ui/CabeceraDeHoja";
import CampoBusqueda from "../../components/ui/CampoBusqueda";
import EstadoError from "../../components/ui/EstadoError";
import EstadoVacio from "../../components/ui/EstadoVacio";
import Segmentado from "../../components/ui/Segmentado";
import { IconoMoneda, IconoPapelera } from "../../components/icons";
import { useHaptics } from "../../hooks/useHaptics";
import { useImmersive } from "../../components/AppShell";
import { formatNumber } from "../../utils/format";
import { getCollection } from "../../utils/storage";
import { D, EASE_OUT } from "../../utils/motion";
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
        {/* La misma pieza que en el mercado, el bazar y la graduación: es el
            mismo aviso —"esto necesita cuenta"— y no tiene por qué verse
            distinto sólo porque aquí se llegara escrito de otra manera. */}
        <AvisoInvitado
          variante="hueco"
          titulo="Inicia sesión para conectar"
          rotuloDestino="Volver al inicio"
        >
          Añade amigos e intercambia cartas: los perfiles, las peticiones y las
          ofertas viven en el servidor, y como invitado tu progreso sólo existe
          en este dispositivo.
        </AvisoInvitado>
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
        <EstadoError titulo="No se pudo cargar tu red social" onReintentar={load} />
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
            className="btn-accent press touch-target px-4 py-2 rounded-xl t-cuerpo font-semibold flex items-center justify-center gap-2"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" />
            </svg>
            <span className="hidden sm:inline">Añadir</span>
          </button>
        }
      />

      {/* LAS CINCO SECCIONES. Es el mismo control que el bazar, la hoja de
          publicar, la graduación y el álbum, y de hecho ERA ÉSTE el que estaba
          bien: la pastilla que se desliza y el tinte de acento salieron de aquí
          y ahora los llevan los cinco.
          `data-lenis-prevent` para que el scroll suave global no se coma el
          desplazamiento horizontal propio de la fila. */}
      <div data-lenis-prevent className="mb-6 overflow-x-auto no-scrollbar overscroll-x-contain">
        <Segmentado
          id="social-tab"
          etiqueta="Sección de tu red social"
          valor={tab}
          onCambio={setTab}
          className="min-w-max"
          opciones={tabs.map((t) => ({
            id: t.id,
            rotulo: t.label,
            insignia: t.badge,
          }))}
        />
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
        // D.base y EASE_OUT de utils/motion.ts: los 0,25 s sueltos y la curva
        // por defecto de framer eran el único fundido de la app que no salía de
        // la escala de la casa.
        transition={{ duration: D.base, ease: EASE_OUT }}
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
        <p className="ink-soft t-cuerpo">Cargando tu perfil…</p>
      </div>
    );
  }

  if (error || !stats) {
    return (
      <EstadoError
        titulo="No se pudieron cargar tus estadísticas"
        onReintentar={onRetry}
      />
    );
  }

  return (
    <div className="surface rounded-3xl p-5 md:p-6 overflow-hidden relative">
      <div className="absolute -top-20 -right-20 w-56 h-56 rounded-full blur-3xl pointer-events-none" style={{ background: "radial-gradient(circle, color-mix(in srgb, var(--accent) 22%, transparent), transparent 70%)" }} />

      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-5 relative">
        <div>
          <p className="t-etiqueta ink-soft">Valor de tu colección</p>
          <p className="t-display font-bold text-gradient mt-1 tnum">
            {formatNumber(stats.totalValue)}
            <span className="t-base ink-faint font-normal ml-2">monedas</span>
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 md:gap-3 md:w-auto">
          {[
            { label: "Cartas", value: stats.totalCards },
            { label: "Únicas", value: stats.totalUnique },
            { label: "Sets", value: `${stats.setsCompleted}/${stats.setsTotal}` },
          ].map((s) => (
            <div key={s.label} className="surface-2 rounded-2xl px-3 md:px-5 py-2.5 text-center md:text-left">
              <p className="t-etiqueta ink-soft">{s.label}</p>
              {/* "Sets" es la cadena "3/12" y no debe pasar por formatNumber. */}
              <p className="t-base md:t-titulo font-bold tnum mt-0.5">
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
          <span className="t-etiqueta ink-soft">Logros</span>
          <span className="tnum t-meta font-semibold ink-soft">
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
              className={`flex aspect-square items-center justify-center rounded-xl border t-base transition sm:aspect-auto sm:h-9 sm:w-9 sm:t-titulo ${
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
      <p className="t-etiqueta ink-soft relative">Tu progreso en este dispositivo</p>
      <div className="grid grid-cols-3 gap-2 mt-3 relative">
        {tiles.map((t) => (
          <div key={t.label} className="surface-2 rounded-2xl px-3 py-2.5 text-center">
            <p className="t-etiqueta ink-soft">{t.label}</p>
            <p className="t-base font-bold tnum mt-0.5">{t.value}</p>
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
          <p className="t-etiqueta ink-soft mb-3">Peticiones · {requests.length}</p>
          <div className="flex flex-col gap-2">
            {requests.map((r: any) => (
              <div key={r.id} className="surface-2 rounded-xl p-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar name={r.requester_name} />
                  <span className="font-medium t-cuerpo truncate">{r.requester_name}</span>
                </div>
                <div className="flex gap-3 shrink-0">
                  <button
                    onClick={() => onAccept(r.id, r.requester_name)}
                    disabled={busyIds?.has(r.id)}
                    className="btn-accent press touch-target px-3 py-2 rounded-lg t-cuerpo-2 font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {busyIds?.has(r.id) ? "Procesando…" : "Aceptar"}
                  </button>
                  <button onClick={() => onRemove(r.id, r.requester_name, "request")} className="btn-ghost press touch-target px-3 py-2 rounded-lg t-cuerpo-2">Ignorar</button>
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
            {i < 3 && <span className="absolute top-3 right-3 t-titulo">{medal[i]}</span>}
            <div className="flex items-center gap-3 mb-3">
              <Avatar name={f.friend_name} highlight={f.isMe} />
              <div className="min-w-0">
                <p className="font-semibold t-cuerpo truncate">{f.friend_name}{f.isMe && <span className="ink-faint font-normal"> · tú</span>}</p>
                <p className="t-meta ink-soft tnum">{formatNumber(f.stats.unique)} únicas · {formatNumber(f.stats.cards)} cartas</p>
              </div>
            </div>
            <div className="flex items-center justify-between mb-3">
              <span className="t-etiqueta ink-soft">Valor</span>
              {/* La moneda deja de ser el emoji 💰 —que lo dibuja el sistema y
                  sale distinto en iPhone y en PC, sin heredar la tinta— y pasa
                  a ser el icono de la casa, el mismo de la barra superior. */}
              {/* --ok y no la clase de acento: el verde de marca es un token de
                  FONDO y como tinta da 2,4:1 sobre el papel del tema claro.
                  --ok es su pareja legible y no cambia el aspecto en oscuro. */}
              <span className="t-cuerpo font-bold [color:var(--ok)] tnum flex items-center gap-1">
                {formatNumber(f.stats.value)}
                <IconoMoneda tam={16} />
              </span>
            </div>
            <div className="flex gap-2">
              {/* `.control-44` en los dos: medían 36px de alto y son la salida
                  de esta tarjeta hacia el álbum del amigo y hacia el
                  intercambio, o sea las dos únicas cosas que se hacen aquí. */}
              <Link href={f.isMe ? "/collection" : `/trainer/${f.friend_id}`} className="flex-1 btn-ghost press control-44 text-center t-cuerpo-2 font-medium rounded-lg">
                Ver álbum
              </Link>
              {!f.isMe && (
                <>
                  <button onClick={() => onTrade(f)} className="flex-1 btn-accent press control-44 t-cuerpo-2 font-semibold rounded-lg">Intercambiar</button>
                  <button
                    onClick={() => onRemove(f.friendship_id, f.friend_name, "friend")}
                    className="btn-ghost press control-44 px-3 rounded-lg"
                    title="Eliminar"
                    aria-label={`Eliminar a ${f.friend_name}`}
                  >
                    <IconoPapelera tam={16} />
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {friends.length <= 1 && requests.length === 0 && (
        <EstadoVacio
          titulo="Aún no tienes amigos"
          detalle='Pulsa "Añadir" para buscar entrenadores.'
        />
      )}
    </div>
  );
}

/* ---------- OFFER CARDS ---------- */
/**
 * LAS DOS TINTAS DE UN INTERCAMBIO, y por qué ya no son las que eran.
 *
 * Los dos lados llegaban con `accent` (el verde de marca) y con el cian de la
 * paleta de Tailwind, que como TINTA dan 2,4:1 y 2,1:1 sobre el papel del tema
 * claro. Son las mismas dos tintas que components/social/TradeBuilder.tsx ya
 * había cambiado por --ok y --warn-ink al montar el intercambio: aquí se pinta
 * ese mismo intercambio una vez enviado, así que los dos lados tienen que
 * llegar del mismo color en las dos pantallas o parecen dos cosas distintas.
 */
function OfferCards({ cards, label, tint }: { cards: any[]; label: string; tint: string }) {
  return (
    <div className="flex-1 min-w-0">
      <p className={`t-etiqueta mb-1.5 ${tint}`}>{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {cards.map((c: any, i: number) => (
          <img key={i} src={c?.images?.small} alt={c?.name} title={c?.name} loading="lazy" className="w-12 rounded-lg" />
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
            <p className="t-cuerpo"><strong>{o.senderName}</strong> <span className="ink-soft">te propone</span></p>
          </div>
          <div className="flex items-center gap-3 surface-2 rounded-xl p-3 mb-3">
            <OfferCards cards={o.offered} label="Recibes" tint="[color:var(--ok)]" />
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5 ink-faint shrink-0" aria-hidden="true">
              <path d="M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4" />
            </svg>
            <OfferCards cards={o.requested} label="Entregas" tint="[color:var(--warn-ink)]" />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => onAccept(o.id)}
              disabled={busy}
              className="flex-1 btn-accent press touch-target py-2.5 rounded-xl t-cuerpo font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? "Procesando…" : "Aceptar"}
            </button>
            <button
              onClick={() => onDecline(o.id)}
              disabled={busy}
              className="btn-ghost press touch-target px-5 py-2.5 rounded-xl t-cuerpo disabled:opacity-50 disabled:cursor-not-allowed"
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
            <p className="t-cuerpo"><span className="ink-soft">Esperando a</span> <strong>{o.receiverName}</strong></p>
            <span className="ml-auto chip t-micro px-2 py-0.5 ink-soft">Pendiente</span>
          </div>
          <div className="flex items-center gap-3 surface-2 rounded-xl p-3 mb-3">
            <OfferCards cards={o.offered} label="Ofreces" tint="[color:var(--ok)]" />
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5 ink-faint shrink-0" aria-hidden="true">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
            <OfferCards cards={o.requested} label="Pides" tint="[color:var(--warn-ink)]" />
          </div>
          <button
            onClick={() => onCancel(o.id, o.receiverName)}
            disabled={busyIds?.has(o.id)}
            className="btn-ghost press touch-target w-full py-2.5 rounded-xl t-cuerpo disabled:opacity-50 disabled:cursor-not-allowed"
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
  /* Las tres tintas del estado salen de los tokens: --ok y --danger-ink son las
     variantes LEGIBLES del verde y del rojo de marca (los de marca valen para un
     relleno, no para texto), y el rojo de la paleta de Tailwind que había aquí
     no sabía nada del tema claro ni del oscuro. */
  const label: Record<string, { t: string; c: string }> = {
    accepted: { t: "Aceptado", c: "[color:var(--ok)]" },
    declined: { t: "Rechazado", c: "[color:var(--danger-ink)]" },
    cancelled: { t: "Cancelado", c: "ink-faint" },
  };
  return (
    <div className="surface rounded-2xl divide-y divide-[var(--border)]">
      {items.map((it: any) => (
        <div key={it.id} className="flex items-center gap-3 p-4">
          {/* El punto es un RELLENO, así que aquí sí mandan los tokens de fondo
              --accent y --danger; lo que se va es el rojo literal de Tailwind. */}
          <div className={`w-2 h-2 rounded-full shrink-0 ${it.status === "accepted" ? "bg-[var(--accent)]" : it.status === "declined" ? "bg-[var(--danger)]" : "bg-[var(--ink-faint)]"}`} />
          <div className="flex-1 min-w-0">
            <p className="t-cuerpo truncate">
              {it.iAmSender ? "Enviaste a" : "Recibiste de"} <strong>{it.otherName}</strong>
            </p>
            <p className="t-meta ink-soft tnum">{it.offeredCount} ↔ {it.requestedCount} cartas</p>
          </div>
          <span className={`t-cuerpo-2 font-semibold shrink-0 ${label[it.status]?.c}`}>{label[it.status]?.t}</span>
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
        {/* Es la ÚNICA hoja con aspa de cerrar, y sigue siéndolo: con el
            teclado abierto (esta hoja lo abre sola al montarse) el asa de
            arrastre queda a media pantalla y el fondo casi no se ve, así que
            aquí el aspa es la única salida evidente. Ver la nota de
            components/ui/CabeceraDeHoja. */}
        <CabeceraDeHoja titulo="Añadir amigo" onCerrar={onClose} />

        <CampoBusqueda
          className="mt-4 mb-3"
          autoFocus
          etiqueta="Buscar entrenador"
          marcador="Nombre de entrenador…"
          valor={q}
          onCambio={setQ}
        />

        <div className="flex flex-col gap-1.5 min-h-[60px]">
          {searching && <p className="t-cuerpo-2 ink-faint text-center py-3">Buscando…</p>}
          {!searching && searchError && (
            // --danger-ink: esto es texto, y --danger es el token de fondo. Es
            // el mismo mensaje que ya pinta así el buscador global.
            <p className="t-cuerpo-2 text-center py-3" style={{ color: "var(--danger-ink)" }}>
              No se pudo buscar. Revisa tu conexión.
            </p>
          )}
          {!searching && !searchError && q.length >= 2 && results.length === 0 && (
            <p className="t-cuerpo-2 ink-faint text-center py-3">Sin resultados</p>
          )}
          {results.map((u: any) => (
            <div key={u.id} className="surface-2 rounded-xl p-2.5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <Avatar name={u.username} small />
                <span className="t-cuerpo font-medium truncate">{u.username}</span>
              </div>
              {u.relation === "accepted" ? <span className="t-micro ink-soft shrink-0">Amigos</span>
                : u.relation === "pending" ? <span className="t-micro ink-soft shrink-0">Pendiente</span>
                : (
                  <button
                    onClick={() => doAdd(u.id, u.username)}
                    disabled={adding === u.id}
                    className="btn-accent press touch-target px-3 py-2 rounded-lg t-cuerpo-2 font-semibold shrink-0 disabled:opacity-60"
                  >
                    {adding === u.id ? "Enviando…" : "Añadir"}
                  </button>
                )}
            </div>
          ))}
        </div>

        <div className="mt-4 pt-4 border-t border-[var(--border)]">
          <p className="t-etiqueta ink-soft mb-2">Tu ID</p>
          <div className="flex items-center gap-2">
            {/* Sin `.tnum`: esto no es una cifra, es un identificador que se lee
                y se dicta carácter a carácter, y las cifras tabulares no tocan
                las letras. Tampoco hace falta pedir la monoespaciada: es un
                <code>, y el preflight de Tailwind ya se la da (ver la nota de
                `.tnum` en globals.css). Medido: 11px en ui-monospace, que es
                exactamente lo que se veía antes. */}
            <code className="flex-1 surface-2 rounded-lg px-3 py-2 t-meta ink-soft truncate select-all">{myId}</code>
            <button onClick={copyId} className="btn-ghost press touch-target px-3 py-2 rounded-lg t-cuerpo-2 shrink-0">Copiar</button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}

/* ---------- helpers ---------- */
function Avatar({ name, highlight, small }: { name: string; highlight?: boolean; small?: boolean }) {
  const letter = (name || "?").charAt(0).toUpperCase();
  const size = small ? "w-8 h-8 t-cuerpo-2" : "w-10 h-10 t-cuerpo";
  return (
    <div className={`${size} rounded-full flex items-center justify-center font-bold shrink-0 ${highlight ? "btn-accent" : "surface-2 ink-soft"}`}>
      {letter}
    </div>
  );
}

/** Envoltorio local: las listas de esta pantalla pasan una sola frase, y
 *  EstadoVacio la quiere como titular. Se conserva el nombre para no tocar los
 *  cuatro sitios que ya lo llaman. */
function EmptyState({ text }: { text: string }) {
  return <EstadoVacio titulo={text} />;
}
