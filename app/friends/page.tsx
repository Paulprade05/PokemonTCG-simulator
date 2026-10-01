"use client";

import { useEffect, useState, useCallback, useMemo, useRef, type ReactNode } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { motion } from "framer-motion";
import { syncUserName, getProfileStats } from "../action";
import {
  getSocialOverview, getPeticiones, getBloqueados,
  aceptarPeticion, rechazarPeticion, cancelarPeticion,
  eliminarAmigo, bloquearEntrenador, desbloquear,
  getIncomingTradeOffers, getOutgoingTradeOffers, getTradeHistory,
  acceptTradeOffer, declineTradeOffer, cancelTradeOffer,
} from "../social";
import PageHeader from "../../components/PageHeader";
import Loader from "../../components/Loader";
import TradeBuilder from "../../components/social/TradeBuilder";
import AnadirAmigoSheet from "../../components/social/AnadirAmigoSheet";
import AvatarEntrenador from "../../components/social/AvatarEntrenador";
import AvisoSinSesion from "../../components/social/AvisoSinSesion";
import FilaPeticion from "../../components/social/FilaPeticion";
import OpcionesDeAmigoSheet, { type AmigoConOpciones } from "../../components/social/OpcionesDeAmigoSheet";
import {
  DetalleDeOfertaSheet, ResumenDeOferta,
  type CartaDeOferta, type LadosDeOferta,
} from "../../components/social/Ofertas";
import { SIN_CONEXION } from "../../components/social/utilidades";
import ConfirmSheet from "../../components/ui/ConfirmSheet";
import { useToast } from "../../components/ui/Toast";
import EstadoError from "../../components/ui/EstadoError";
import EstadoVacio from "../../components/ui/EstadoVacio";
import Segmentado from "../../components/ui/Segmentado";
import { IconoCheck, IconoDesplegar, IconoMoneda } from "../../components/icons";
import { useHaptics } from "../../hooks/useHaptics";
import { useAlVolver } from "../../hooks/useAlVolver";
import { useSocialPendientes } from "../../hooks/useSocialPendientes";
import { useImmersive } from "../../components/AppShell";
import { cifraCorta, formatNumber } from "../../utils/format";
import { getCollection } from "../../utils/storage";
import { D, EASE_OUT } from "../../utils/motion";
import { useCurrency } from "../../hooks/useGameCurrency";
import { useIdentidad } from "../../hooks/useIdentidad";
import SinConexion from "../../components/ui/SinConexion";
import type { EntrenadorBloqueado, PeticionEnviada, PeticionRecibida, Peticiones } from "../../utils/tiposSocial";
import { esAccionCaducada } from "../../utils/versionApp";

/**
 * TRES SECCIONES, NO CINCO.
 *
 * Eran «Perfil», «Amigos», «Recibidas», «Enviadas» e «Historial» en una fila
 * que medía 388 px sin insignias y hasta 466 con ellas, dentro de un hueco de
 * 288 px (a 320) o 343 (a 375), con la barra de desplazamiento escondida y sin
 * nada que avisara de que había más: «Historial» no se veía en ningún iPhone,
 * y tras enviar una oferta la pantalla saltaba a «Enviadas», una pestaña que
 * quedaba cortada o fuera.
 *
 * Las tres de ahora caben a 320 px con sus insignias (medido: 72 px de rótulo
 * e insignia en un botón de 87), así que no hay fila que desplazar ni pestaña
 * activa que traer a la vista. Recibidas, enviadas e historial son la misma
 * cosa en tres momentos y van apiladas, con su rótulo, bajo «Ofertas».
 *
 * «OFERTAS» Y NO «INTERCAMBIOS»: la palabra larga mide 76 px y con la insignia
 * ya no entra en un tercio de la fila a 320 px. «Oferta» es además el nombre
 * que la pantalla ya le da a cada una («Oferta enviada», «Cancelar oferta»).
 */
type Tab = "amigos" | "ofertas" | "perfil";

/** Una fila de `getSocialOverview().friends`. La primera soy siempre yo. */
interface Amigo {
  friendship_id: number | "me";
  friend_id: string;
  friend_name: string;
  isMe: boolean;
  etiqueta?: string | null;
  stats: { value: number; cards: number; unique: number };
}

interface OfertaRecibida { id: number; senderName: string; offered: CartaDeOferta[]; requested: CartaDeOferta[] }
interface OfertaEnviada { id: number; receiverName: string; offered: CartaDeOferta[]; requested: CartaDeOferta[] }
interface Movimiento {
  id: number;
  status: string;
  iAmSender: boolean;
  otherName: string;
  offeredCount: number;
  requestedCount: number;
}
interface Ofertas { recibidas: OfertaRecibida[]; enviadas: OfertaEnviada[]; historial: Movimiento[] }

interface Estadisticas {
  totalValue: number;
  totalCards: number;
  totalUnique: number;
  setsCompleted: number;
  setsTotal: number;
  packsOpened: number;
  rareHits: number;
}

/** Lo que espera a un «sí» en la hoja de confirmar. */
interface Confirmacion {
  titulo: string;
  descripcion: string;
  rotulo: string;
  rotuloCancelar?: string;
  destructiva?: boolean;
  alConfirmar: () => void;
}

export default function SocialPage() {
  const { user, isSignedIn } = useUser();
  // `useIdentidad` y no `isLoaded` de Clerk: sin conexión, el script de Clerk
  // no resuelve nunca y la pantalla se quedaba en el esqueleto para siempre.
  // Con el plazo se deja de esperar, y la identidad dice A QUIÉN se ha dejado
  // de esperar (utils/identidad.ts): no es lo mismo un invitado que una cuenta
  // sin red.
  const identidad = useIdentidad();
  // El invitado no tiene servidor: sus monedas viven en este dispositivo.
  const { coins, loaded: coinsLoaded } = useCurrency();

  if (identidad === "resolviendo") return <Loader label="Cargando red social" />;

  // Tiene cuenta y no hay red: pedirle que inicie sesión —que es lo que salía—
  // era decirle que la había perdido, y enseñarle el progreso del invitado,
  // enseñarle el de otra partida.
  if (identidad === "cuenta-sin-conexion") {
    return (
      <div className="w-full">
        <PageHeader title="Social" subtitle="Perfil, amigos e intercambios" />
        <SinConexion detalle="No se ha podido comprobar tu sesión, y tus amigos y tus ofertas viven en tu cuenta. Se reintentará en cuanto vuelva la conexión." />
      </div>
    );
  }

  if (!isSignedIn || !user) {
    // Sin sesión no hay red social, pero sí progreso local: se enseña para que
    // la pantalla no quede vacía, con el aviso de inicio de sesión debajo.
    return (
      <div className="w-full">
        <PageHeader title="Social" subtitle="Perfil, amigos e intercambios" />
        <GuestStats coins={coins} coinsLoaded={coinsLoaded} />
        {/* El botón ABRE EL INICIO DE SESIÓN. Antes la tarjeta decía «Inicia
            sesión para conectar» y su única salida era «Volver al inicio»:
            quien llegaba por el atajo «Social» de la app instalada tenía que
            adivinar que se entraba por el icono de la barra superior. */}
        <AvisoSinSesion titulo="Inicia sesión para conectar" volverA="/friends">
          Añade amigos e intercambia cartas: los perfiles, las peticiones y las
          ofertas viven en el servidor, y como invitado tu progreso sólo existe
          en este dispositivo.
        </AvisoSinSesion>
      </div>
    );
  }

  /* `key` con el id de la cuenta: al cambiar de sesión sin recargar, todo el
   * estado de abajo (amigos, peticiones, ofertas) nace de cero en vez de
   * enseñar un momento los datos de la cuenta anterior. */
  return <SocialConSesion key={user.id} />;
}

function SocialConSesion() {
  const [tab, setTab] = useState<Tab>("amigos");

  const toast = useToast();
  const haptic = useHaptics();
  const { fijar: fijarInsignia } = useSocialPendientes();

  /* CADA BLOQUE CARGA POR SU CUENTA.
   *
   * La pantalla esperaba primero a `syncUserName` (una llamada a la API de
   * Clerk) y luego a cuatro acciones a la vez, y hasta que no terminaban todas
   * sólo había un cargador: ni cabecera, ni botón de añadir. Con mala
   * cobertura eso era medio minuto mirando un esqueleto para, a lo mejor, sólo
   * querer compartir el código.
   *
   * Ahora la cabecera y «Añadir» están desde el primer render y cada sección
   * pinta en cuanto llega lo suyo. `null` es «todavía no ha contestado». */
  const [amigos, setAmigos] = useState<Amigo[] | null>(null);
  const [amigosError, setAmigosError] = useState(false);
  const [peticiones, setPeticiones] = useState<Peticiones | null>(null);
  const [bloqueados, setBloqueados] = useState<EntrenadorBloqueado[]>([]);
  const [ofertas, setOfertas] = useState<Ofertas | null>(null);
  const [ofertasError, setOfertasError] = useState(false);

  const [stats, setStats] = useState<Estadisticas | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState(false);
  const statsLoadedRef = useRef(false);

  const [tradeFriend, setTradeFriend] = useState<Amigo | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [opcionesDe, setOpcionesDe] = useState<AmigoConOpciones | null>(null);
  const [detalle, setDetalle] = useState<LadosDeOferta | null>(null);

  /* UNA hoja de confirmar para todo lo que se confirma aquí. Al confirmar,
   * ConfirmSheet cierra y el pendiente pasa a null con la hoja aún montada
   * durante la salida: se conserva el último valor (ajustado durante el
   * render, no en un efecto) para que el texto no cambie mientras se va. */
  const [confirmacion, setConfirmacion] = useState<Confirmacion | null>(null);
  const [ultimaConfirmacion, setUltimaConfirmacion] = useState<Confirmacion | null>(null);
  if (confirmacion && confirmacion !== ultimaConfirmacion) setUltimaConfirmacion(confirmacion);

  /* Acciones en vuelo, por clave («p:12» una petición, «o:7» una oferta…).
   * Sin cerrojo, dos toques rápidos en «Aceptar» lanzan dos acciones
   * concurrentes. El ref es el cerrojo real (setState no se ve hasta el
   * siguiente render) y el Set de estado apaga los botones.
   * Las claves llevan prefijo porque peticiones y ofertas salen de tablas
   * distintas: la petición 5 y la oferta 5 compartían cerrojo. */
  const [ocupados, setOcupados] = useState<ReadonlySet<string>>(new Set());
  const cerrojoRef = useRef<Set<string>>(new Set());
  const empezar = useCallback((clave: string) => {
    if (cerrojoRef.current.has(clave)) return false;
    cerrojoRef.current.add(clave);
    setOcupados(new Set(cerrojoRef.current));
    return true;
  }, []);
  const terminar = useCallback((clave: string) => {
    cerrojoRef.current.delete(clave);
    setOcupados(new Set(cerrojoRef.current));
  }, []);

  // Mientras hay una capa a pantalla completa encima, la barra de pestañas sobra.
  useImmersive(showAdd || !!tradeFriend);

  /* ---------- cargas ---------- */

  /* Las server actions capturan sus errores de SQL, pero un fallo de transporte
   * (sin cobertura, 500, despliegue caducado) sí rechaza: cada carga lleva su
   * catch. Si ya hay datos en pantalla (un refresco tras una acción) no se
   * vacía la vista: basta con avisar de que puede estar desactualizada. */
  const hayAmigosRef = useRef(false);
  const cargarAmigos = useCallback(async () => {
    try {
      const ov = await getSocialOverview();
      const lista = (ov?.friends ?? []) as Amigo[];
      // Con éxito la lista trae SIEMPRE mi propia fila. Vacía es que la acción
      // capturó un error de SQL y devolvió su valor de respaldo.
      if (lista.length === 0) throw new Error("getSocialOverview no devolvió datos");
      hayAmigosRef.current = true;
      setAmigos(lista);
      setAmigosError(false);
    } catch (err) {
      console.error(err);
      if (hayAmigosRef.current) toast("No se pudo actualizar la lista de amigos", "error");
      else setAmigosError(true);
    }
  }, [toast]);

  /* Peticiones: es la carga que se repite (el sondeo de la hoja, cada acción,
   * cada vuelta a la app), así que no puede solaparse consigo misma. Si llega
   * otra llamada con una en vuelo, se apunta y se repite al terminar: quien
   * llama DESPUÉS de una acción necesita una lectura posterior a esa acción,
   * no la que ya iba de camino. */
  const peticionesEnCursoRef = useRef<Promise<void> | null>(null);
  const repetirPeticionesRef = useRef(false);
  /** Ids de mis peticiones enviadas en la lectura anterior. */
  const enviadasVistasRef = useRef<Set<number> | null>(null);
  /** Enviadas que he retirado YO: que falten no significa que las aceptaran. */
  const retiradasRef = useRef<Set<number>>(new Set());

  const cargarPeticiones = useCallback((): Promise<void> => {
    if (peticionesEnCursoRef.current) {
      repetirPeticionesRef.current = true;
      return peticionesEnCursoRef.current;
    }
    const tanda = (async () => {
      do {
        repetirPeticionesRef.current = false;
        try {
          const p = await getPeticiones();
          // Lectura fallida: las listas vienen vacías por el fallo, no porque
          // no haya nada. Se trata como cualquier otro sondeo que no llegó.
          if (p.error) throw new Error("getPeticiones no pudo leer");
          const ahora = new Set(p.enviadas.map((e) => e.id));
          const antes = enviadasVistasRef.current;
          enviadasVistasRef.current = ahora;
          setPeticiones(p);
          fijarInsignia({ peticiones: p.recibidas.length });
          /* Una enviada que ya no está y que no cancelé yo es una petición
           * ACEPTADA (las rechazadas siguen saliendo: el rechazo es
           * silencioso). El servidor no avisa de otra forma, así que es aquí
           * donde se nota que hay un amigo nuevo y se relee la lista. */
          if (antes && [...antes].some((id) => !ahora.has(id) && !retiradasRef.current.has(id))) {
            void cargarAmigos();
          }
        } catch (err) {
          // Callado: esto se repite solo y un aviso por sondeo fallido sería
          // un aviso cada cinco segundos. Lo que hay en pantalla se queda.
          console.error(err);
        }
      } while (repetirPeticionesRef.current);
    })().finally(() => {
      peticionesEnCursoRef.current = null;
    });
    peticionesEnCursoRef.current = tanda;
    return tanda;
  }, [cargarAmigos, fijarInsignia]);

  const hayOfertasRef = useRef(false);
  const cargarOfertas = useCallback(async () => {
    try {
      const [inc, out, hist] = await Promise.all([
        getIncomingTradeOffers(), getOutgoingTradeOffers(), getTradeHistory(),
      ]);
      hayOfertasRef.current = true;
      setOfertas({
        recibidas: inc as OfertaRecibida[],
        enviadas: out as OfertaEnviada[],
        historial: hist as Movimiento[],
      });
      setOfertasError(false);
      fijarInsignia({ ofertas: inc.length });
    } catch (err) {
      console.error(err);
      if (hayOfertasRef.current) toast("No se pudieron actualizar las ofertas", "error");
      else setOfertasError(true);
    }
  }, [toast, fijarInsignia]);

  const cargarBloqueados = useCallback(async () => {
    try {
      setBloqueados(await getBloqueados());
    } catch (err) {
      // La lista de bloqueados es un pie de la pestaña: si no llega, no sale.
      console.error(err);
    }
  }, []);

  // getProfileStats devuelve null tanto si falla el SQL como sin sesión, y un
  // fallo de transporte rechaza: ambos casos acaban en el error con reintento.
  const loadStats = useCallback(async () => {
    // Los refrescos posteriores (tras un intercambio) van en silencio sobre
    // los datos ya en pantalla, sin volver a enseñar la carga ni un error.
    if (!statsLoadedRef.current) {
      setStatsLoading(true);
      setStatsError(false);
    }
    try {
      const s = (await getProfileStats()) as Estadisticas | null;
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
  }, []);

  /* EL ORDEN IMPORTA: Next manda las server actions de una en una, así que la
   * primera de la lista es la primera que pinta. Van de más barata y más
   * urgente (peticiones: una consulta) a más cara (la lista de amigos agrega
   * la colección de todos), y `syncUserName` —una llamada a la API de Clerk
   * que antes bloqueaba la pantalla entera— va la ÚLTIMA y sin que nadie la
   * espere: sólo refresca el nombre por si cambió, que desde que `getUserData`
   * lo siembra ya no es lo que hace encontrable a un jugador. */
  useEffect(() => {
    void cargarPeticiones();
    void cargarAmigos();
    void cargarOfertas();
    void loadStats();
    void cargarBloqueados();
    syncUserName().catch((err) => console.error(err));
  }, [cargarPeticiones, cargarAmigos, cargarOfertas, loadStats, cargarBloqueados]);

  /* iOS no recarga la PWA al reabrirla: sin esto, las peticiones y las ofertas
   * que llegaron con la app en segundo plano no salían hasta cambiar de
   * pestaña y volver. Sólo las dos lecturas ligeras; la lista de amigos se
   * relee sola si alguna petición enviada ha desaparecido. */
  useAlVolver(() => {
    void cargarPeticiones();
    void cargarOfertas();
  }, 30_000);

  /* Tras enviar una oferta se salta a su bloque, que es el segundo de la
   * sección: con varias recibidas encima quedaba fuera de pantalla y parecía
   * que la oferta no se había enviado. La bandera es un ref porque no pinta
   * nada; se gasta cuando el bloque existe (la oferta nueva llega con la
   * recarga) o al cambiar de sección. */
  const saltarAEnviadasRef = useRef(false);
  useEffect(() => {
    if (!saltarAEnviadasRef.current) return;
    if (tab !== "ofertas") {
      saltarAEnviadasRef.current = false;
      return;
    }
    const bloque = document.getElementById("social-ofertas-enviadas");
    if (!bloque) return;
    saltarAEnviadasRef.current = false;
    bloque.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [tab, ofertas]);

  /* ---------- acciones de amistad ---------- */

  /* TODAS con try/catch/finally. Antes aceptar llevaba try/finally sin catch y
   * eliminar ni eso: con mala cobertura el botón se quedaba en «Procesando…» o
   * el aviso decía «hecho» sin que hubiera pasado nada. Y ninguna dice éxito
   * por su cuenta: el aviso sale de lo que contesta el servidor, que ya no
   * responde «ok» si no cambió ninguna fila. */

  const aceptar = useCallback(async (p: PeticionRecibida) => {
    const clave = `p:${p.id}`;
    if (!empezar(clave)) return;
    haptic("select");
    try {
      const r = await aceptarPeticion(p.id);
      if (!r.ok) {
        toast(r.error, "error");
        await cargarPeticiones();
        return;
      }
      toast(`Ahora eres amigo de ${r.nombre}`, "success");
      // Aceptar es lo único de este bloque que cambia la lista de amigos.
      await Promise.all([cargarPeticiones(), cargarAmigos()]);
    } catch (err) {
      console.error(err);
      if (!esAccionCaducada(err)) toast(SIN_CONEXION, "error");
    } finally {
      terminar(clave);
    }
  }, [empezar, terminar, haptic, toast, cargarPeticiones, cargarAmigos]);

  const rechazar = useCallback(async (p: PeticionRecibida) => {
    const clave = `p:${p.id}`;
    if (!empezar(clave)) return;
    haptic("tap");
    try {
      const r = await rechazarPeticion(p.id);
      if (!r.ok) toast(r.error, "error");
      else toast(`Petición de ${p.nombre} rechazada`, "info");
      // Sólo las peticiones: rechazar no toca ni amigos ni intercambios.
      await cargarPeticiones();
    } catch (err) {
      console.error(err);
      if (!esAccionCaducada(err)) toast(SIN_CONEXION, "error");
    } finally {
      terminar(clave);
    }
  }, [empezar, terminar, haptic, toast, cargarPeticiones]);

  const cancelarEnviada = useCallback(async (p: PeticionEnviada) => {
    const clave = `p:${p.id}`;
    if (!empezar(clave)) return;
    haptic("tap");
    try {
      const r = await cancelarPeticion(p.id);
      if (!r.ok) {
        toast(r.error, "error");
      } else {
        // Que falte en la próxima lectura es cosa mía, no una aceptación.
        retiradasRef.current.add(p.id);
        toast(`Petición a ${p.nombre} cancelada`, "info");
      }
      await cargarPeticiones();
    } catch (err) {
      console.error(err);
      if (!esAccionCaducada(err)) toast(SIN_CONEXION, "error");
    } finally {
      terminar(clave);
    }
  }, [empezar, terminar, haptic, toast, cargarPeticiones]);

  const eliminar = useCallback(async (a: AmigoConOpciones) => {
    const clave = `a:${a.amistadId}`;
    if (!empezar(clave)) return;
    haptic("warning");
    try {
      const r = await eliminarAmigo(a.amistadId);
      if (!r.ok) {
        toast(r.error, "error");
      } else {
        const n = r.ofertasCanceladas;
        toast(
          n > 0
            ? `${a.nombre} ya no está en tus amigos · ${n} ${n === 1 ? "oferta cancelada" : "ofertas canceladas"}`
            : `${a.nombre} ya no está en tus amigos`,
          "info",
        );
      }
      // Eliminar cancela las ofertas pendientes entre los dos: se releen.
      await Promise.all([cargarAmigos(), cargarOfertas()]);
    } catch (err) {
      console.error(err);
      if (!esAccionCaducada(err)) toast(SIN_CONEXION, "error");
    } finally {
      terminar(clave);
    }
  }, [empezar, terminar, haptic, toast, cargarAmigos, cargarOfertas]);

  const bloquear = useCallback(async (a: AmigoConOpciones) => {
    const clave = `a:${a.amistadId}`;
    if (!empezar(clave)) return;
    haptic("warning");
    try {
      const r = await bloquearEntrenador({ entrenadorId: a.amigoId });
      if (!r.ok) toast(r.error, "error");
      else toast(`Has bloqueado a ${a.nombre}`, "info");
      await Promise.all([cargarAmigos(), cargarOfertas(), cargarBloqueados(), cargarPeticiones()]);
    } catch (err) {
      console.error(err);
      if (!esAccionCaducada(err)) toast(SIN_CONEXION, "error");
    } finally {
      terminar(clave);
    }
  }, [empezar, terminar, haptic, toast, cargarAmigos, cargarOfertas, cargarBloqueados, cargarPeticiones]);

  const levantarBloqueo = useCallback(async (b: EntrenadorBloqueado) => {
    const clave = `b:${b.id}`;
    if (!empezar(clave)) return;
    haptic("tap");
    try {
      const r = await desbloquear(b.id);
      if (!r.ok) toast(r.error, "error");
      else toast(`${b.nombre} ya no está bloqueado`, "info");
      await cargarBloqueados();
    } catch (err) {
      console.error(err);
      if (!esAccionCaducada(err)) toast(SIN_CONEXION, "error");
    } finally {
      terminar(clave);
    }
  }, [empezar, terminar, haptic, toast, cargarBloqueados]);

  /* ---------- acciones de intercambio ---------- */

  const aceptarOferta = useCallback(async (id: number) => {
    const clave = `o:${id}`;
    if (!empezar(clave)) return;
    haptic("select");
    try {
      const r = (await acceptTradeOffer(id)) as { error?: string } | null;
      if (r?.error) toast(r.error, "error");
      else {
        toast("Intercambio completado", "success");
        // El intercambio mueve cartas: el valor y los logros del perfil
        // cambian, y también las cifras de la lista de amigos.
        void loadStats();
        void cargarAmigos();
      }
      await cargarOfertas();
    } catch (err) {
      console.error(err);
      if (!esAccionCaducada(err)) toast(SIN_CONEXION, "error");
    } finally {
      terminar(clave);
    }
  }, [empezar, terminar, haptic, toast, cargarOfertas, cargarAmigos, loadStats]);

  const rechazarOferta = useCallback(async (id: number) => {
    const clave = `o:${id}`;
    if (!empezar(clave)) return;
    haptic("warning");
    try {
      const r = (await declineTradeOffer(id)) as { error?: string } | null;
      if (r?.error) toast(r.error, "error");
      else toast("Oferta rechazada", "info");
      await cargarOfertas();
    } catch (err) {
      console.error(err);
      if (!esAccionCaducada(err)) toast(SIN_CONEXION, "error");
    } finally {
      terminar(clave);
    }
  }, [empezar, terminar, haptic, toast, cargarOfertas]);

  const cancelarOferta = useCallback(async (id: number) => {
    const clave = `o:${id}`;
    if (!empezar(clave)) return;
    haptic("warning");
    try {
      const r = (await cancelTradeOffer(id)) as { error?: string } | null;
      if (r?.error) toast(r.error, "error");
      else toast("Oferta cancelada", "info");
      await cargarOfertas();
    } catch (err) {
      console.error(err);
      if (!esAccionCaducada(err)) toast(SIN_CONEXION, "error");
    } finally {
      terminar(clave);
    }
  }, [empezar, terminar, haptic, toast, cargarOfertas]);

  /* ACEPTAR UN INTERCAMBIO PIDE CONFIRMACIÓN; RECHAZARLO, NO.
   * «Aceptar» era un botón a todo lo ancho que movía las cartas en el acto y
   * sin vuelta atrás, justo donde cae el pulgar al desplazar la lista. Cancelar
   * una oferta propia —que no mueve nada— sí preguntaba. Rechazar se queda de
   * un toque: no entrega nada y el otro puede volver a ofrecer. */
  const pedirAceptarOferta = useCallback((o: OfertaRecibida) => {
    haptic("tap");
    const das = o.requested.length;
    const recibes = o.offered.length;
    setConfirmacion({
      titulo: "Aceptar intercambio",
      descripcion: `Entregas ${das} ${das === 1 ? "carta" : "cartas"} y recibes ${recibes} de ${o.senderName}. No se puede deshacer.`,
      rotulo: "Intercambiar",
      alConfirmar: () => void aceptarOferta(o.id),
    });
  }, [haptic, aceptarOferta]);

  const pedirCancelarOferta = useCallback((o: OfertaEnviada) => {
    haptic("tap");
    setConfirmacion({
      titulo: "Cancelar oferta",
      descripcion: `Retirarás el intercambio que enviaste a ${o.receiverName}.`,
      rotulo: "Cancelar oferta",
      rotuloCancelar: "Mantener",
      destructiva: true,
      alConfirmar: () => void cancelarOferta(o.id),
    });
  }, [haptic, cancelarOferta]);

  const recibidas = peticiones?.recibidas ?? [];
  const enviadas = peticiones?.enviadas ?? [];

  // Lo que la hoja de añadir necesita saber del cerrojo: qué peticiones tienen
  // una respuesta en vuelo.
  const peticionesOcupadas = useMemo(() => {
    const ids = new Set<number>();
    for (const clave of ocupados) if (clave.startsWith("p:")) ids.add(Number(clave.slice(2)));
    return ids;
  }, [ocupados]);

  const abrirAnadir = useCallback(() => {
    haptic("tap");
    setShowAdd(true);
  }, [haptic]);

  return (
    <div className="w-full">
      <PageHeader
        title="Social"
        subtitle="Perfil, amigos e intercambios"
        actions={
          <button
            onClick={abrirAnadir}
            aria-label="Añadir amigo"
            className="btn-accent press touch-target px-4 py-2 rounded-xl t-cuerpo font-semibold flex items-center justify-center gap-2"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 shrink-0" aria-hidden="true">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" />
            </svg>
            {/* El rótulo se ve a TODOS los anchos. Por debajo de 640 px el
                botón era un icono suelto, y el estado vacío mandaba a «pulsar
                Añadir»: una palabra que en el móvil no estaba en ningún
                sitio. Con el rótulo mide 101 px y a 320 px deja 175 al título. */}
            <span>Añadir</span>
          </button>
        }
      />

      {/* `columnas`: tres tercios exactos, para que el interruptor no baile
          cuando aparece o se va una insignia. */}
      <Segmentado
        id="social-tab"
        etiqueta="Sección de tu red social"
        valor={tab}
        onCambio={setTab}
        columnas
        className="mb-6"
        opciones={[
          { id: "amigos", rotulo: "Amigos", insignia: recibidas.length || undefined },
          { id: "ofertas", rotulo: "Ofertas", insignia: ofertas?.recibidas.length || undefined },
          { id: "perfil", rotulo: "Perfil" },
        ]}
      />

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
        {tab === "amigos" && (
          <AmigosTab
            amigos={amigos}
            error={amigosError}
            onReintentar={() => {
              setAmigosError(false);
              void cargarPeticiones();
              void cargarAmigos();
              void cargarBloqueados();
            }}
            recibidas={recibidas}
            enviadas={enviadas}
            bloqueados={bloqueados}
            ocupados={ocupados}
            onAceptar={aceptar}
            onRechazar={rechazar}
            onCancelarEnviada={cancelarEnviada}
            onDesbloquear={levantarBloqueo}
            onAnadir={abrirAnadir}
            onOpciones={(a) => {
              haptic("tap");
              setOpcionesDe(a);
            }}
            onTrade={(f) => {
              haptic("tap");
              setTradeFriend(f);
            }}
          />
        )}
        {tab === "ofertas" && (
          <OfertasTab
            ofertas={ofertas}
            error={ofertasError}
            onReintentar={() => {
              setOfertasError(false);
              void cargarOfertas();
            }}
            ocupados={ocupados}
            onAceptar={pedirAceptarOferta}
            onRechazar={(o) => void rechazarOferta(o.id)}
            onCancelar={pedirCancelarOferta}
            onDetalle={(lados) => {
              haptic("tap");
              setDetalle(lados);
            }}
            onVerAmigos={() => setTab("amigos")}
          />
        )}
        {tab === "perfil" && (
          <PerfilTab stats={stats} loading={statsLoading} error={statsError} onRetry={loadStats} />
        )}
      </motion.div>

      <TradeBuilder
        friend={tradeFriend}
        onClose={() => setTradeFriend(null)}
        onSent={() => {
          haptic("success");
          toast("Oferta enviada", "success");
          setTradeFriend(null);
          saltarAEnviadasRef.current = true;
          setTab("ofertas");
          void cargarOfertas();
        }}
      />

      <AnadirAmigoSheet
        open={showAdd}
        onClose={() => setShowAdd(false)}
        recibidas={recibidas}
        ocupadas={peticionesOcupadas}
        onAceptar={aceptar}
        onRechazar={rechazar}
        onSondear={() => void cargarPeticiones()}
        onCambio={(que) => {
          void cargarPeticiones();
          if (que === "amigos") void cargarAmigos();
        }}
      />

      <OpcionesDeAmigoSheet
        amigo={opcionesDe}
        onClose={() => setOpcionesDe(null)}
        onEliminar={eliminar}
        onBloquear={bloquear}
      />

      <DetalleDeOfertaSheet lados={detalle} onClose={() => setDetalle(null)} />

      <ConfirmSheet
        open={!!confirmacion}
        title={ultimaConfirmacion?.titulo ?? ""}
        description={ultimaConfirmacion?.descripcion}
        confirmLabel={ultimaConfirmacion?.rotulo}
        cancelLabel={ultimaConfirmacion?.rotuloCancelar}
        destructive={ultimaConfirmacion?.destructiva}
        onConfirm={() => ultimaConfirmacion?.alConfirmar()}
        onClose={() => setConfirmacion(null)}
      />
    </div>
  );
}

/* ---------- PERFIL ---------- */

/** Estadísticas y logros del entrenador (con sesión), con datos del servidor. */
function PerfilTab({
  stats,
  loading,
  error,
  onRetry,
}: {
  stats: Estadisticas | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  // Los logros se derivan de las estadísticas: no hay tabla propia en el
  // servidor, así que su definición vive en el cliente. Cada uno lleva lo que
  // se tiene y lo que pide, para poder decir cuánto falta.
  const achievements = useMemo(() => {
    const s: Partial<Estadisticas> = stats || {};
    return [
      { id: "first", name: "Primer sobre", desc: "Abre 1 sobre", actual: s.packsOpened || 0, meta: 1, icon: "📦" },
      { id: "collector", name: "Coleccionista", desc: "100 cartas únicas", actual: s.totalUnique || 0, meta: 100, icon: "🗂️" },
      { id: "hunter", name: "Cazador raro", desc: "10 cartas raras (IR+)", actual: s.rareHits || 0, meta: 10, icon: "💎" },
      { id: "rich", name: "Millonario", desc: "Colección por 10.000", actual: s.totalValue || 0, meta: 10000, icon: "💰" },
      { id: "setdone", name: "Maestro de set", desc: "Completa 1 set", actual: s.setsCompleted || 0, meta: 1, icon: "🏆" },
      { id: "veteran", name: "Veterano", desc: "Abre 100 sobres", actual: s.packsOpened || 0, meta: 100, icon: "⭐" },
    ].map((a) => ({ ...a, done: a.actual >= a.meta }));
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
        <div className="min-w-0">
          <p className="t-etiqueta ink-soft">Valor de tu colección</p>
          <p className="t-display font-bold text-gradient mt-1 tnum">
            {formatNumber(stats.totalValue)}
            <span className="t-base ink-faint font-normal ml-2">monedas</span>
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 md:gap-3 md:w-auto">
          {[
            { label: "Cartas", value: cifraCorta(stats.totalCards) },
            { label: "Únicas", value: cifraCorta(stats.totalUnique) },
            // "Sets" es la cadena "3/12", no una cifra.
            { label: "Sets", value: `${stats.setsCompleted}/${stats.setsTotal}` },
          ].map((s) => (
            // `min-w-0` + `truncate`: una tesela de rejilla no encoge por
            // debajo de su contenido, y una cifra de siete dígitos se salía.
            <div key={s.label} className="surface-2 min-w-0 rounded-2xl px-3 md:px-5 py-2.5 text-center md:text-left">
              <p className="t-etiqueta ink-soft truncate">{s.label}</p>
              <p className="t-base md:t-titulo font-bold tnum mt-0.5 truncate">{s.value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* LOGROS, CON NOMBRE Y CON CUÁNTO FALTA. Eran seis emojis, cuatro de
          ellos al 30 % de opacidad, y el nombre y la condición iban sólo en
          `title`, que al tacto no existe: en un iPhone no había forma de saber
          qué pedía cada uno. Ahora cada logro es una fila que se lee sin tocar
          nada. */}
      <div className="mt-5 pt-4 border-t border-[var(--border)] relative">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <span className="t-etiqueta ink-soft">Logros</span>
          <span className="tnum t-meta font-semibold ink-soft">
            {achievementsDone} de {achievements.length}
          </span>
        </div>
        <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {achievements.map((ach) => (
            <li key={ach.id} className="surface-2 flex items-center gap-3 rounded-xl px-3 py-2">
              <span
                aria-hidden="true"
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border t-base ${
                  ach.done ? "ring-accent border-transparent" : "border-[var(--border)] opacity-40 saturate-0"
                }`}
              >
                {ach.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="t-cuerpo block truncate font-medium">{ach.name}</span>
                <span className="ink-soft t-meta block truncate">{ach.desc}</span>
              </span>
              {ach.done ? (
                <span className="flex shrink-0 items-center gap-1 t-cuerpo-2 font-semibold [color:var(--ok)]">
                  <IconoCheck tam={16} />
                  <span className="sr-only">Conseguido</span>
                </span>
              ) : (
                <span className="ink-soft t-cuerpo-2 tnum shrink-0 font-medium">
                  {formatNumber(ach.actual)}/{formatNumber(ach.meta)}
                </span>
              )}
            </li>
          ))}
        </ul>
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
    // A PROPÓSITO: el estado sale de localStorage, que no existe en el render
    // del servidor; leerlo aquí, una vez y tras montar, es lo que evita el
    // desajuste de hidratación. No hay cascada: el efecto no tiene dependencias.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocal({
      cards: col.reduce((sum: number, c: { quantity?: number }) => sum + (c.quantity || 1), 0),
      unique: col.length,
    });
  }, []);

  // `cifraCorta` y no `formatNumber`: con 1.234.567 monedas el número medía
  // 81 px en una tesela de 77 (a 320 px) y se salía por la derecha.
  const tiles = [
    { label: "Cartas", value: local ? cifraCorta(local.cards) : "—" },
    { label: "Únicas", value: local ? cifraCorta(local.unique) : "—" },
    { label: "Monedas", value: coinsLoaded ? cifraCorta(coins) : "—" },
  ];

  return (
    <div className="surface rounded-3xl p-5 mb-6 relative overflow-hidden">
      <div className="absolute -top-20 -right-20 w-56 h-56 rounded-full blur-3xl pointer-events-none" style={{ background: "radial-gradient(circle, color-mix(in srgb, var(--accent) 22%, transparent), transparent 70%)" }} />
      <p className="t-etiqueta ink-soft relative">Tu progreso en este dispositivo</p>
      <div className="grid grid-cols-3 gap-2 mt-3 relative">
        {tiles.map((t) => (
          // px-1 y no px-3: «MONEDAS» mide 61 px con su espaciado y la tesela,
          // a 320 px, 77. Con el relleno de antes el rótulo vivía montado en
          // él; ahora cabe entero y el `truncate` es sólo la red.
          <div key={t.label} className="surface-2 min-w-0 rounded-2xl px-1 py-2.5 text-center">
            <p className="t-etiqueta ink-soft truncate">{t.label}</p>
            <p className="t-base font-bold tnum mt-0.5 truncate">{t.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- AMIGOS ---------- */

interface AmigosTabProps {
  amigos: Amigo[] | null;
  error: boolean;
  onReintentar: () => void;
  recibidas: PeticionRecibida[];
  enviadas: PeticionEnviada[];
  bloqueados: EntrenadorBloqueado[];
  ocupados: ReadonlySet<string>;
  onAceptar: (p: PeticionRecibida) => void;
  onRechazar: (p: PeticionRecibida) => void;
  onCancelarEnviada: (p: PeticionEnviada) => void;
  onDesbloquear: (b: EntrenadorBloqueado) => void;
  onAnadir: () => void;
  onOpciones: (a: AmigoConOpciones) => void;
  onTrade: (f: Amigo) => void;
}

const MEDALLAS = ["🥇", "🥈", "🥉"];

function AmigosTab({
  amigos, error, onReintentar, recibidas, enviadas, bloqueados, ocupados,
  onAceptar, onRechazar, onCancelarEnviada, onDesbloquear, onAnadir, onOpciones, onTrade,
}: AmigosTabProps) {
  const [verBloqueados, setVerBloqueados] = useState(false);

  const soloYo = amigos !== null && amigos.every((f) => f.isMe);
  /* LAS MEDALLAS SON DE UN PODIO, y un podio pide tres. Sin amigos, la única
   * tarjeta —la propia— salía con su 🥇: el primero de uno. */
  const hayPodio = amigos !== null && amigos.length >= 3;

  return (
    <div className="flex flex-col gap-5">
      {recibidas.length > 0 && (
        <div className="surface rounded-2xl p-4">
          <p className="t-etiqueta ink-soft mb-3">Peticiones · {recibidas.length}</p>
          <div className="flex flex-col gap-2">
            {recibidas.map((p) => (
              <FilaPeticion
                key={p.id}
                peticion={p}
                ocupada={ocupados.has(`p:${p.id}`)}
                onAceptar={() => onAceptar(p)}
                onRechazar={() => onRechazar(p)}
              />
            ))}
          </div>
        </div>
      )}

      {/* LO QUE HE PEDIDO YO. No existía: quien enviaba una petición no tenía
          dónde verla ni forma de retirarla, sólo un «Pendiente» en el
          buscador si repetía la búsqueda. */}
      {enviadas.length > 0 && (
        <div className="surface rounded-2xl p-4">
          <p className="t-etiqueta ink-soft mb-3">Enviadas · {enviadas.length}</p>
          <div className="flex flex-col gap-2">
            {enviadas.map((p) => {
              const ocupada = ocupados.has(`p:${p.id}`);
              return (
                <div key={p.id} className="surface-2 flex items-center gap-2.5 rounded-xl p-3">
                  <AvatarEntrenador nombre={p.nombre} etiqueta={p.etiqueta} tam="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="t-cuerpo truncate font-medium">{p.nombre}</p>
                    {/* La etiqueta baja a la segunda línea: a 320 px, en la
                        primera, dejaba al nombre en ocho caracteres. */}
                    <p className="ink-soft t-meta truncate">
                      {p.etiqueta ? `#${p.etiqueta} · ` : ""}Pendiente
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onCancelarEnviada(p)}
                    disabled={ocupada}
                    aria-busy={ocupada}
                    aria-label={`Cancelar la petición a ${p.nombre}`}
                    className="btn-ghost press control-44 t-cuerpo-2 shrink-0 rounded-lg px-3 font-medium disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Cancelar
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {amigos === null ? (
        error ? (
          <EstadoError titulo="No se pudo cargar tu lista de amigos" onReintentar={onReintentar} />
        ) : (
          // Tres huecos con el alto de una tarjeta de amigo: la sección tiene
          // su forma antes de tener sus datos y lo de debajo no salta.
          <div
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
            role="status"
            aria-label="Cargando amigos"
            aria-busy="true"
          >
            <div className="skeleton h-[164px] rounded-2xl" />
            <div className="skeleton h-[164px] rounded-2xl" />
            <div className="skeleton hidden h-[164px] rounded-2xl sm:block" />
          </div>
        )
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {amigos.map((f, i) => (
            // Sin entrada por tarjeta (fundido escalonado i × 0,03 s): la pantalla
            // ya entra entera desde app/template.tsx y la pestaña desde el bloque
            // de arriba —"una pantalla, una entrada", PageHeader.tsx—. Y framer
            // dejaba `opacity:0` escrito en el HTML servido hasta su primer rAF,
            // que en segundo plano no llega nunca.
            <div
              key={f.friend_id}
              className={`surface surface-hover rounded-2xl p-4 ${f.isMe ? "ring-accent" : ""}`}
            >
              <div className="flex items-center gap-3 mb-3">
                <AvatarEntrenador nombre={f.friend_name} etiqueta={f.etiqueta} destacado={f.isMe} />
                <div className="min-w-0 flex-1">
                  <p className="t-cuerpo flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate font-semibold">{f.friend_name}</span>
                    {!f.isMe && f.etiqueta && (
                      <span className="ink-soft t-cuerpo-2 shrink-0">#{f.etiqueta}</span>
                    )}
                  </p>
                  <p className="t-meta ink-soft tnum truncate">{formatNumber(f.stats.unique)} únicas · {formatNumber(f.stats.cards)} cartas</p>
                </div>
                {/* La medalla va EN la fila, sin encoger. Era un `absolute`
                    en la esquina y el nombre truncaba contra el borde de la
                    tarjeta, no contra ella: los puntos suspensivos quedaban
                    debajo del emoji. */}
                {hayPodio && i < 3 && (
                  <span className="t-titulo shrink-0" role="img" aria-label={`Puesto ${i + 1}`}>
                    {MEDALLAS[i]}
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between mb-3">
                <span className="t-etiqueta ink-soft">Valor</span>
                {/* --ok y no la clase de acento: el verde de marca es un token de
                    FONDO y como tinta da 2,4:1 sobre el papel del tema claro.
                    --ok es su pareja legible y no cambia el aspecto en oscuro. */}
                <span className="t-cuerpo font-bold [color:var(--ok)] tnum flex items-center gap-1">
                  {formatNumber(f.stats.value)}
                  <IconoMoneda tam={16} />
                </span>
              </div>
              <div className="flex gap-2">
                {/* `.control-44` en todos: son la salida de esta tarjeta hacia
                    el álbum del amigo y hacia el intercambio, o sea las dos
                    únicas cosas que se hacen aquí. */}
                <Link href={f.isMe ? "/collection" : `/trainer/${f.friend_id}`} className="min-w-0 flex-1 btn-ghost press control-44 text-center t-cuerpo-2 font-medium rounded-lg">
                  Ver álbum
                </Link>
                {!f.isMe && typeof f.friendship_id === "number" && (
                  <>
                    <button onClick={() => onTrade(f)} className="min-w-0 flex-1 btn-accent press control-44 t-cuerpo-2 font-semibold rounded-lg">Intercambiar</button>
                    {/* Tres puntos y no una papelera: detrás hay DOS acciones
                        (eliminar y bloquear) y las dos se confirman en la hoja
                        que abre. */}
                    <button
                      onClick={() =>
                        onOpciones({
                          amistadId: f.friendship_id as number,
                          amigoId: f.friend_id,
                          nombre: f.friend_name,
                          etiqueta: f.etiqueta,
                        })
                      }
                      disabled={ocupados.has(`a:${f.friendship_id}`)}
                      className="btn-ghost press control-44 shrink-0 rounded-lg disabled:opacity-50"
                      aria-label={`Más opciones de ${f.friend_name}`}
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                        <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
                      </svg>
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* EL VACÍO TRAE SU BOTÓN. Decía «Pulsa "Añadir" para buscar
          entrenadores», remitiendo a un botón de la cabecera que en el móvil
          era un icono sin esa palabra. */}
      {soloYo && recibidas.length === 0 && enviadas.length === 0 && (
        <EstadoVacio
          titulo="Aún no tienes amigos"
          detalle="Comparte tu código o busca a un entrenador por su nombre."
          accion={
            <button
              type="button"
              onClick={onAnadir}
              className="btn-accent press control-44 t-cuerpo rounded-xl px-6 font-semibold"
            >
              Añadir amigo
            </button>
          }
        />
      )}

      {/* BLOQUEADOS, plegado y al final: es una lista que casi nadie tiene y
          que quien la tiene no quiere ver cada vez que entra. */}
      {bloqueados.length > 0 && (
        <div className="surface rounded-2xl p-2">
          <button
            type="button"
            onClick={() => setVerBloqueados((v) => !v)}
            aria-expanded={verBloqueados}
            className="press-flat flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-2"
          >
            <span className="t-etiqueta ink-soft">Bloqueados · {bloqueados.length}</span>
            <IconoDesplegar tam={16} className={`ink-soft ${verBloqueados ? "rotate-180" : ""}`} />
          </button>
          {verBloqueados && (
            <div className="mt-1 flex flex-col gap-2 p-2 pt-1">
              {bloqueados.map((b) => {
                const ocupado = ocupados.has(`b:${b.id}`);
                return (
                  <div key={b.id} className="surface-2 flex items-center gap-2.5 rounded-xl p-3">
                    <AvatarEntrenador nombre={b.nombre} etiqueta={b.etiqueta} tam="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="t-cuerpo truncate font-medium">{b.nombre}</p>
                      {b.etiqueta && <p className="ink-soft t-meta truncate">#{b.etiqueta}</p>}
                    </div>
                    <button
                      type="button"
                      onClick={() => onDesbloquear(b)}
                      disabled={ocupado}
                      aria-busy={ocupado}
                      aria-label={`Desbloquear a ${b.nombre}`}
                      className="btn-ghost press control-44 t-cuerpo-2 shrink-0 rounded-lg px-3 font-medium disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Desbloquear
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- OFERTAS ---------- */

interface OfertasTabProps {
  ofertas: Ofertas | null;
  error: boolean;
  onReintentar: () => void;
  ocupados: ReadonlySet<string>;
  onAceptar: (o: OfertaRecibida) => void;
  onRechazar: (o: OfertaRecibida) => void;
  onCancelar: (o: OfertaEnviada) => void;
  onDetalle: (lados: LadosDeOferta) => void;
  onVerAmigos: () => void;
}

/** El rótulo de cada bloque de la sección: son tres listas en una pantalla. */
function TituloDeBloque({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2
      id={id}
      className="t-etiqueta ink-soft mb-3"
      // Al saltar a un bloque (ver `saltarAEnviadasRef`) no puede quedar
      // debajo de la barra superior, que es pegajosa.
      style={{ scrollMarginTop: "calc(var(--topbar-h) + var(--sat) + 16px)" }}
    >
      {children}
    </h2>
  );
}

function OfertasTab({
  ofertas, error, onReintentar, ocupados, onAceptar, onRechazar, onCancelar, onDetalle, onVerAmigos,
}: OfertasTabProps) {
  if (ofertas === null) {
    if (error) return <EstadoError titulo="No se pudieron cargar tus ofertas" onReintentar={onReintentar} />;
    return (
      <div className="flex flex-col gap-3" role="status" aria-label="Cargando ofertas" aria-busy="true">
        <div className="skeleton h-[212px] rounded-2xl" />
        <div className="skeleton h-[212px] rounded-2xl" />
      </div>
    );
  }

  const { recibidas, enviadas, historial } = ofertas;

  if (recibidas.length === 0 && enviadas.length === 0 && historial.length === 0) {
    return (
      <EstadoVacio
        titulo="Aún no hay intercambios"
        detalle="Elige a un amigo y pulsa «Intercambiar» para proponerle un cambio de cartas."
        accion={
          <button
            type="button"
            onClick={onVerAmigos}
            className="btn-accent press control-44 t-cuerpo rounded-xl px-6 font-semibold"
          >
            Ver amigos
          </button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section>
        <TituloDeBloque>Recibidas · {recibidas.length}</TituloDeBloque>
        {recibidas.length === 0 ? (
          <p className="surface ink-soft t-cuerpo rounded-2xl px-4 py-5 text-center">No tienes ofertas pendientes</p>
        ) : (
          <div className="flex flex-col gap-3">
            {recibidas.map((o) => {
              // Con una acción en vuelo se bloquean ambos botones de la oferta:
              // aceptar y rechazar la misma oferta a la vez no puede pasar.
              const busy = ocupados.has(`o:${o.id}`);
              const lados: LadosDeOferta = {
                titulo: `De ${o.senderName}`,
                primero: { rotulo: "Recibes", cartas: o.offered },
                segundo: { rotulo: "Entregas", cartas: o.requested },
              };
              return (
                <div key={o.id} className="surface rounded-2xl p-4">
                  <CabeceraDeOferta nombre={o.senderName} apoyo="Te propone un intercambio" />
                  <ResumenDeOferta sentido="cruce" lados={lados} onAbrir={() => onDetalle(lados)} />
                  {/* Los rótulos NO cambian mientras trabaja («Procesando…»
                      ensanchaba el botón): se apagan los dos. */}
                  <div className="flex gap-2">
                    <button
                      onClick={() => onAceptar(o)}
                      disabled={busy}
                      aria-busy={busy}
                      className="flex-1 btn-accent press touch-target py-2.5 rounded-xl t-cuerpo font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Aceptar
                    </button>
                    <button
                      onClick={() => onRechazar(o)}
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
        )}
      </section>

      {enviadas.length > 0 && (
        <section>
          <TituloDeBloque id="social-ofertas-enviadas">Enviadas · {enviadas.length}</TituloDeBloque>
          <div className="flex flex-col gap-3">
            {enviadas.map((o) => {
              const busy = ocupados.has(`o:${o.id}`);
              const lados: LadosDeOferta = {
                titulo: `Para ${o.receiverName}`,
                primero: { rotulo: "Ofreces", cartas: o.offered },
                segundo: { rotulo: "Pides", cartas: o.requested },
              };
              return (
                <div key={o.id} className="surface rounded-2xl p-4">
                  <CabeceraDeOferta nombre={o.receiverName} apoyo="Esperando su respuesta" chip="Pendiente" />
                  <ResumenDeOferta sentido="ida" lados={lados} onAbrir={() => onDetalle(lados)} />
                  <button
                    onClick={() => onCancelar(o)}
                    disabled={busy}
                    aria-busy={busy}
                    className="btn-ghost press touch-target w-full py-2.5 rounded-xl t-cuerpo disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Cancelar oferta
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {historial.length > 0 && (
        <section>
          <TituloDeBloque>Historial</TituloDeBloque>
          <Historial items={historial} />
        </section>
      )}
    </div>
  );
}

/**
 * Quién está al otro lado de una oferta. El nombre tiene su línea entera y
 * trunca: Clerk admite nombres de 64 caracteres sin espacios, y en una sola
 * frase («Marta te propone») uno de 38 se salía de la tarjeta a 375 px y de la
 * pantalla a 320.
 */
function CabeceraDeOferta({ nombre, apoyo, chip }: { nombre: string; apoyo: string; chip?: string }) {
  return (
    <div className="flex items-center gap-2.5 mb-3">
      <AvatarEntrenador nombre={nombre} tam="sm" />
      <div className="min-w-0 flex-1">
        <p className="t-cuerpo truncate font-semibold">{nombre}</p>
        <p className="ink-soft t-meta truncate">{apoyo}</p>
      </div>
      {chip && <span className="chip t-micro shrink-0 px-2 py-0.5 ink-soft">{chip}</span>}
    </div>
  );
}

function Historial({ items }: { items: Movimiento[] }) {
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
      {items.map((it) => (
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
