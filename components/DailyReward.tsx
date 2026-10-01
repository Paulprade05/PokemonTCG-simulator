"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { claimDailyReward, getDailyStatus } from "../app/action";
import { useAlVolver } from "../hooks/useAlVolver";
import { useCurrency } from "../hooks/useGameCurrency";
import { useHaptics } from "../hooks/useHaptics";
import { useToast } from "./ui/Toast";
import Sheet from "./ui/Sheet";
import CabeceraDeHoja from "./ui/CabeceraDeHoja";
import { formatNumber } from "../utils/format";
import {
  DAILY_BASE,
  DAILY_ESPERA_H,
  DAILY_PLAZO_RACHA_H,
  DAILY_STREAK_CAP,
  DAILY_STREAK_STEP,
} from "../utils/constanst";
import { esAccionCaducada } from "../utils/versionApp";

/**
 * LA RECOMPENSA DIARIA: un botón en la barra superior y la hoja que lo explica.
 *
 * LO QUE HABÍA Y POR QUÉ SE HA IDO:
 *
 *  · `alert(res.error)` para los fallos. En una PWA instalada el alert enseña
 *    el nombre del dominio y corta la interacción (components/ui/Toast.tsx lo
 *    dice en su cabecera: existe justamente para sustituirlo). Ahora es un
 *    aviso más de la app, con el mismo tono que los del bazar o la colección.
 *
 *  · Un cartel propio "+N monedas reclamadas" montado AQUÍ, con `fixed` y
 *    z-[200]. Este componente vive dentro de la cabecera, que es `sticky` con
 *    z-30 y —cuando framer la desplaza— un ancestro transformado, o sea el
 *    bloque contenedor de cualquier `fixed` que cuelgue de ella: el cartel
 *    quedaba con z efectivo 30 y anclado a la barra, no a la ventana. El
 *    aviso de Toast ya vive fuera de la cabecera (lo monta ToastProvider como
 *    hermano del árbol entero, en AppShell), así que la recompensa se anuncia
 *    por ahí y no hay portal que inventar.
 *
 *  · Paleta literal de Tailwind (text-amber-300, text-emerald-200,
 *    text-gray-600). Están pensadas para fondo negro: sobre el papel claro del
 *    tema medían 1,26:1 y 1,12:1 de contraste, o sea invisibles. Los colores
 *    salen ahora de los tokens del tema: `--warn`/`--warn-ink` para "hay
 *    recompensa" (es un aviso que pide acción) y `--ink-soft` sobre `--border`
 *    para cuando todavía no toca.
 *
 * LAS TRES COSAS QUE FALLABAN EN EL IPHONE, Y QUE SON EL MOTIVO DE LA HOJA:
 *
 *  1. EL BOTÓN APAGADO ERA MUDO. En móvil el botón es sólo un icono (el texto
 *     va en `hidden md:inline`) y, sin recompensa, estaba `disabled`: gris y
 *     sin respuesta al dedo. No había forma de leer cuándo vuelve, cuánto dará
 *     ni cuándo se pierde la racha, porque `title` no existe en una pantalla
 *     táctil. Ya no se desactiva nunca: si hay recompensa, la reclama; si no,
 *     abre una hoja que lo cuenta. La hoja cuelga de un Portal (ui/Sheet), así
 *     que el ancestro transformado de la cabecera no la ancla a la barra.
 *
 *  2. EL ESTADO SE CONGELABA. Se pedía una sola vez, al montar, y este
 *     componente vive en la TopBar, que no se desmonta en toda la sesión: se
 *     reclamaba a las 22:00, la PWA se quedaba en segundo plano y al día
 *     siguiente a las 19:00 seguía gris hasta matar la app, porque iOS la
 *     devuelve tal cual estaba. Ahora se vuelve a preguntar al servidor cuando
 *     la app vuelve a verse (`visibilitychange`, `pageshow`), cuando vuelve la
 *     red (`online`) y con un temporizador armado para el momento en que toca.
 *     El temporizador solo no bastaría: iOS congela los de una app en segundo
 *     plano, y por eso el que manda de verdad es el regreso a primer plano.
 *
 *  3. EL "20h" ESCRITO A MANO tras reclamar. El momento en que vuelve se guarda
 *     como un instante (`vuelve.en`) y lo que se pinta se calcula contra el
 *     reloj, así que la cuenta atrás baja sola en vez de quedarse en la cifra
 *     del momento en que se consultó.
 */

/* Los dos plazos de la recompensa: 20 horas entre una y la siguiente, y la
 * racha sigue viva si la nueva se reclama a menos de 48 de la anterior. Son las
 * mismas constantes que usa `claimDailyReward` (utils/constanst.ts); antes eran
 * dos números copiados a mano. Quien decide sigue siendo el servidor, dentro de
 * la sentencia que abona: si esta hoja dijera una hora que no es, no se movería
 * ni una moneda. */
const ESPERA_H = DAILY_ESPERA_H;
const PLAZO_RACHA_H = DAILY_PLAZO_RACHA_H;

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;
/** Colchón tras la hora exacta: el reloj del móvil y el del servidor no van al
 *  milisegundo, y preguntar un instante antes devolvería "todavía no". */
const MARGEN = 1_500;
/** Cada cuánto se reintenta cuando el servidor no ha contestado nada útil. */
const REINTENTO = 5 * MINUTO;
/** Mínimo entre dos consultas provocadas por volver a primer plano: saltar
 *  entre dos apps no debería costar una consulta por salto. También es lo que
 *  se espera si el reloj de aquí dice que ya toca y el servidor dice que no. */
const ENTRE_CONSULTAS = 30_000;

/** Lo que devuelven las dos acciones, en lo que aquí se lee. */
type EstadoDiario = {
  available?: boolean;
  streak?: number;
  hoursLeft?: number;
  /** Instante exacto (ms) en que vuelve. Lo manda `getDailyStatus` junto a
   *  `hoursLeft`; es lo que permite decir "en 7 h 12 min, hoy a las 19:05" en
   *  vez de "en unas 7 h". Sigue siendo opcional: sin él se cae a las horas. */
  nextAt?: number;
} | null;
type RespuestaReclamo = {
  success?: boolean;
  reward?: number;
  streak?: number;
  /** El saldo que ha quedado en el servidor tras abonar. */
  coins?: number;
  error?: string;
} | null;

/** Cuándo vuelve. `exacto` distingue el instante de verdad de la cota superior
 *  que sale de un número de horas redondeado. */
type Vuelve = { en: number; exacto: boolean };

/** Lo que paga la recompensa con una racha dada: la misma cuenta del servidor. */
const premioCon = (racha: number) =>
  DAILY_BASE + Math.min(racha * DAILY_STREAK_STEP, DAILY_STREAK_CAP);

/** "7 h 12 min", "45 min". Redondea hacia arriba: nunca promete de menos. */
function duracion(ms: number): string {
  const minutos = Math.ceil(ms / MINUTO);
  if (minutos <= 1) return "un minuto";
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** "hoy a las 19:05", "mañana a las 09:12", "el jueves a las 23:05". Sólo se
 *  llama con la hoja abierta, o sea en el navegador: no entra en la hidratación,
 *  y por eso puede usar la zona horaria del dispositivo, que es la que importa. */
function cuando(ms: number, ahora: number): string {
  const d = new Date(ms);
  const h = new Date(ahora);
  const dias = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(h.getFullYear(), h.getMonth(), h.getDate()).getTime()) /
      DIA,
  );
  const hora = d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  if (dias <= 0) return `hoy a las ${hora}`;
  if (dias === 1) return `mañana a las ${hora}`;
  if (dias === 2) return `pasado mañana a las ${hora}`;
  return `el ${d.toLocaleDateString("es-ES", { weekday: "long" })} a las ${hora}`;
}

/** Fila de la ficha de la hoja: qué es, a la izquierda; cuánto, a la derecha. */
function Dato({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-[var(--border)] py-2.5 first:border-t-0">
      <dt className="ink-soft t-cuerpo-2 shrink-0">{rotulo}</dt>
      <dd className="ink t-cuerpo tnum min-w-0 text-right font-semibold">{children}</dd>
    </div>
  );
}

export default function DailyReward() {
  const [available, setAvailable] = useState(false);
  const [streak, setStreak] = useState(0);
  const [vuelve, setVuelve] = useState<Vuelve | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [consultando, setConsultando] = useState(false);
  const [hojaAbierta, setHojaAbierta] = useState(false);
  /** El reloj contra el que se pinta la cuenta atrás. Es estado y no un
   *  `Date.now()` en el render para que el servidor y el navegador pinten lo
   *  mismo al hidratar: arranca en 0 y sólo se mueve en efectos y manejadores. */
  const [ahora, setAhora] = useState(0);
  /** Consultas seguidas sin respuesta útil. Sólo existe para rearmar el
   *  reintento: un fallo no cambia ningún otro estado, y sin esto nadie
   *  volvería a preguntar. */
  const [fallos, setFallos] = useState(0);
  const { addCoins, setCoins } = useCurrency();
  const toast = useToast();
  const haptic = useHaptics();

  /** Sólo vale la respuesta de la última consulta lanzada. */
  const turnoRef = useRef(0);
  const ultimaConsultaRef = useRef(0);
  /** Cerrojo del reclamo. Ref y no estado: dos toques en el mismo fotograma
   *  verían los dos `claiming === false`. */
  const reclamoLockRef = useRef(false);

  const consultar = useCallback(async () => {
    // Con un reclamo en vuelo no se pregunta: la respuesta podría haberse leído
    // ANTES del abono y llegar DESPUÉS, y volvería a encender el botón.
    if (reclamoLockRef.current) return;
    const turno = ++turnoRef.current;
    ultimaConsultaRef.current = Date.now();
    setConsultando(true);
    try {
      const s = (await getDailyStatus()) as EstadoDiario;
      if (turno !== turnoRef.current) return;
      const disponible = !!s?.available;
      const horas = typeof s?.hoursLeft === "number" ? s.hoursLeft : 0;
      const instante =
        typeof s?.nextAt === "number" && Number.isFinite(s.nextAt) ? s.nextAt : null;

      if (!disponible && instante === null && horas <= 0) {
        // Ni disponible ni con fecha: es lo que devuelve la acción cuando su
        // propia consulta falla. No se pisa lo que ya se sabía; se reintenta.
        setFallos((n) => n + 1);
        return;
      }

      setAvailable(disponible);
      setStreak(s?.streak || 0);
      setVuelve(
        instante !== null
          ? { en: instante, exacto: true }
          : disponible
            ? null
            : { en: Date.now() + horas * HORA, exacto: false },
      );
      setAhora(Date.now());
      setFallos(0);
    } catch {
      // Sin respuesta (sin conexión) se conserva lo último que se supo: si el
      // botón estaba apagado sigue apagado, que es el estado que no promete
      // nada, y la hoja sigue pudiendo decir cuándo volvía.
      if (turno === turnoRef.current) setFallos((n) => n + 1);
    } finally {
      if (turno === turnoRef.current) setConsultando(false);
    }
  }, []);

  useEffect(() => {
    consultar();
  }, [consultar]);

  /* VOLVER A PREGUNTAR AL REGRESAR. Es lo que descongela el estado en una PWA
   * que iOS ha tenido dormida toda la noche: al volver a primer plano no se
   * remonta nada, sólo cambia la visibilidad. Los tres avisos (primer plano,
   * caché de páginas de Safari, red recuperada) los pone hooks/useAlVolver.ts,
   * que es quien los tiene para toda la app; aquí estaban escritos otra vez a
   * mano. El mínimo entre consultas se mira aquí y no con su `minMs` porque el
   * reloj de la cuenta atrás se pone en hora en CADA regreso, se consulte o no. */
  useAlVolver(() => {
    setAhora(Date.now());
    if (Date.now() - ultimaConsultaRef.current < ENTRE_CONSULTAS) return;
    consultar();
  });

  /* EL TEMPORIZADOR, para quien tiene la app abierta cuando toca.
   *
   * Con la hora exacta se pregunta justo después. Con sólo las horas
   * redondeadas hacia arriba, el momento real cae en la última hora antes de
   * `vuelve.en`: se espera hasta el principio de esa hora y, dentro de ella, se
   * pregunta cada diez minutos. Son seis consultas como mucho, y a cambio el
   * botón se enciende con diez minutos de retraso en el peor caso y no con una
   * hora.
   *
   * Si el reloj de aquí dice que ya toca y el servidor acaba de decir que no
   * (un móvil con la hora adelantada), se espera ENTRE_CONSULTAS y no el
   * margen: si no, serían dos consultas cada tres segundos hasta que los dos
   * relojes coincidieran. */
  useEffect(() => {
    if (available) return;
    let espera = REINTENTO;
    if (vuelve && fallos === 0) {
      const falta = vuelve.en - Date.now();
      if (vuelve.exacto) espera = falta > 0 ? falta + MARGEN : ENTRE_CONSULTAS;
      else espera = falta > HORA ? falta - HORA + MARGEN : 10 * MINUTO;
    }
    const id = window.setTimeout(consultar, espera);
    return () => window.clearTimeout(id);
  }, [available, vuelve, fallos, consultar]);

  /* El reloj de la cuenta atrás. Sólo corre mientras hay algo que contar, y a
   * medio minuto por paso: lo que se pinta va en minutos. */
  useEffect(() => {
    if (available || !vuelve) return;
    const id = window.setInterval(() => setAhora(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [available, vuelve]);

  const handleClaim = async () => {
    if (!available || reclamoLockRef.current) return;
    reclamoLockRef.current = true;
    // Cualquier consulta que estuviera en vuelo queda descartada (ver
    // `consultar`), y con ella su "consultando", que ya no apagaría nadie.
    turnoRef.current++;
    setConsultando(false);
    setClaiming(true);
    let releer = false;
    try {
      const res = (await claimDailyReward()) as RespuestaReclamo;
      if (res?.success) {
        const premio = res.reward ?? 0;
        const racha = res.streak ?? 0;
        // EL SALDO DEL SERVIDOR, no "lo que había más el premio". La acción
        // devuelve cuánto ha quedado tras abonar: sumarle el premio al número
        // de pantalla arrastraba cualquier desfase que éste ya tuviera (un
        // sobre abierto en el ordenador, un anuncio vendido en el bazar). La
        // suma queda de respaldo por si la respuesta no trajera la cifra.
        if (typeof res.coins === "number" && Number.isFinite(res.coins)) setCoins(res.coins);
        else addCoins(premio);
        setStreak(racha);
        setAvailable(false);
        // El servidor acaba de escribir `last_daily_claim = NOW()`: la
        // siguiente es dentro de ESPERA_H contadas desde este instante.
        setVuelve({ en: Date.now() + ESPERA_H * HORA, exacto: true });
        setAhora(Date.now());
        setFallos(0);
        haptic("success");
        toast(
          racha > 1
            ? `+${formatNumber(premio)} monedas · racha de ${formatNumber(racha)} días`
            : `+${formatNumber(premio)} monedas reclamadas`,
          "success",
        );
      } else if (res?.error) {
        haptic("warning");
        toast(res.error, "error");
        // Si el servidor dice que no, lo pintado mentía (se reclamó desde otro
        // dispositivo, o el reloj de aquí iba adelantado): se relee.
        releer = true;
      }
    } catch (e) {
      // La acción rechaza sin conexión o con el despliegue caducado: antes esto
      // dejaba el botón en "reclamando" para siempre.
      console.error("Error reclamando la recompensa diaria:", e);
      // Versión caducada: el servidor ya no conoce esta acción. El aviso de
      // "hay una versión nueva" ya está en pantalla (utils/versionApp.ts);
      // decir además "revisa tu conexión" era mandar al jugador a mirar la
      // cobertura con la cobertura perfecta.
      if (!esAccionCaducada(e)) {
        toast("No se pudo reclamar la recompensa. Revisa tu conexión.", "error");
      }
    } finally {
      reclamoLockRef.current = false;
      setClaiming(false);
    }
    if (releer) consultar();
  };

  const alPulsar = () => {
    if (claiming) return;
    if (available) {
      handleClaim();
      return;
    }
    haptic("tap");
    setAhora(Date.now());
    setHojaAbierta(true);
    // Abrir la hoja es pedir el dato: si lo que hay tiene ya un rato, se
    // refresca por detrás mientras se lee.
    if (Date.now() - ultimaConsultaRef.current >= ENTRE_CONSULTAS) consultar();
  };

  /* ---------------- lo que se pinta ---------------- */

  const falta = vuelve ? Math.max(0, vuelve.en - ahora) : 0;
  /** No se sabe nada todavía: ni hay recompensa ni hay fecha. */
  const sinDatos = !available && !vuelve;

  // Versión corta, para el rótulo del botón y el texto de escritorio.
  const faltaCorta = !vuelve
    ? ""
    : falta >= HORA || !vuelve.exacto
      ? `${Math.max(1, Math.ceil(falta / HORA))}h`
      : `${Math.max(1, Math.ceil(falta / MINUTO))}min`;

  const rotulo = available
    ? `Reclama la recompensa diaria · racha ${streak}`
    : vuelve
      ? `Recompensa diaria: vuelve en ${vuelve.exacto ? "" : "unas "}${faltaCorta}. Toca para ver los detalles`
      : "Recompensa diaria. Toca para ver los detalles";

  /* LA RACHA, CONTADA COMO LA CUENTA EL SERVIDOR. La siguiente recompensa suma
   * un día si se reclama a menos de PLAZO_RACHA_H de la anterior, y la anterior
   * fue ESPERA_H antes de `vuelve.en`. Sin la hora exacta no se da una fecha
   * límite: una cota con una hora de holgura, puesta como plazo, haría perder
   * la racha a quien se fiara de ella. */
  const limiteRacha = vuelve?.exacto
    ? vuelve.en + (PLAZO_RACHA_H - ESPERA_H) * HORA
    : null;
  const rachaViva = limiteRacha === null ? true : ahora < limiteRacha;
  const proximaRacha = rachaViva ? streak + 1 : 1;
  const proximoPremio = premioCon(proximaRacha);
  const enElTope = proximaRacha * DAILY_STREAK_STEP >= DAILY_STREAK_CAP;
  /* "HASTA +N" CUANDO NO SE PUEDE JURAR LA CIFRA. Con la recompensa ya
   * disponible y sin la hora exacta no se sabe si han pasado las 48 horas, o
   * sea si la racha sigue viva: la cifra pintada es la de la racha intacta y se
   * dice como techo. Un botón es una promesa de pago; el importe de verdad lo
   * pone el servidor y sale en el aviso. */
  const cifraSegura = !available || limiteRacha !== null;
  const textoPremio = `${cifraSegura ? "" : "hasta "}+${formatNumber(proximoPremio)}`;

  return (
    <>
      <button
        type="button"
        onClick={alPulsar}
        aria-busy={claiming}
        // Sin recompensa abre una hoja: se anuncia como tal, y no como el botón
        // apagado que era.
        aria-haspopup={available ? undefined : "dialog"}
        // El texto va oculto en móvil (`hidden md:inline`), así que sin esto el
        // botón se quedaría sin nombre para un lector de pantalla.
        aria-label={rotulo}
        title={rotulo}
        // `control-44` porque el botón medía 34 px de alto y vive en la barra
        // superior, pegado a otros controles: es el sitio donde un fallo del dedo
        // toca lo de al lado. El `flex` propio gana al del `:where()` de la
        // utilidad, así que sólo añade las dos medidas mínimas.
        className="press control-44 relative flex items-center gap-2 rounded-xl border px-3 py-2 t-cuerpo-2 font-medium transition"
        style={
          available
            ? {
                background: "color-mix(in srgb, var(--warn) 14%, transparent)",
                borderColor: "color-mix(in srgb, var(--warn) 38%, transparent)",
                color: "var(--warn-ink)",
              }
            : {
                // --ink-soft y no --ink-faint: el botón ya no está desactivado,
                // y un icono a 3,6:1 seguiría diciendo "aquí no se toca".
                background: "color-mix(in srgb, var(--ink) 4%, transparent)",
                borderColor: "var(--border)",
                color: "var(--ink-soft)",
              }
        }
      >
        {/* EL PUNTO DE "HAY ALGO". En móvil no hay texto y el tinte ámbar del
            botón pasa por adorno: el punto es la señal que se lee de reojo. Es
            un círculo plano de 8 px, sin `scale` ni animación: no hace falta
            mover nada para que se vea. */}
        {available && !claiming && (
          <span
            aria-hidden="true"
            className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full"
            style={{ background: "var(--warn)" }}
          />
        )}
        {/* No hay icono de calendario en components/icons.tsx, así que este se
            queda inline; lo que se unifica es el trazo (redondeado, como el
            resto de la familia) y el tamaño, que ya era uno de la escala. */}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
        <span className="hidden md:inline">
          {claiming ? "Reclamando…" : available ? "Diaria" : faltaCorta || "Diaria"}
        </span>
        {/* LA RACHA NO SE PINTA POR DEBAJO DE 360 px. El botón vive en la barra
            superior, que a 320 con sesión va justa: con "×12" y un saldo de
            cinco cifras sobraba una décima de píxel, y con una racha de tres
            cifras el grupo de controles se salía 6 px de la fila. La racha no
            se pierde: está en la hoja que abre este mismo botón y en su
            etiqueta. */}
        {streak > 0 && (
          <span
            className="tnum hidden rounded-full px-1.5 py-0.5 t-micro min-[360px]:inline"
            style={{ background: "color-mix(in srgb, var(--ink) 10%, transparent)" }}
          >
            ×{streak}
          </span>
        )}
      </button>

      <Sheet
        open={hojaAbierta}
        onClose={() => setHojaAbierta(false)}
        label="Recompensa diaria"
      >
        <div className="px-5 pt-3 pb-6">
          <CabeceraDeHoja titulo="Recompensa diaria" />

          {/* LA RESPUESTA, EN GRANDE: es lo único que se venía a preguntar. La
              región es viva porque cambia sola con la hoja abierta (la cuenta
              atrás llega a cero y pasa a "ya está lista"). */}
          <div className="mt-4 text-center" aria-live="polite">
            {available ? (
              <>
                <p className="t-etiqueta ink-soft">Ya está lista</p>
                <p
                  className="t-display tnum mt-1 font-bold"
                  style={{ color: "var(--warn-ink)" }}
                >
                  {textoPremio}
                </p>
                <p className="ink-soft t-cuerpo-2 mt-1">monedas esperándote</p>
              </>
            ) : !vuelve ? (
              <>
                <p className="ink t-cuerpo font-semibold">
                  {consultando ? "Comprobando…" : "No se ha podido comprobar"}
                </p>
                <p className="ink-soft t-cuerpo-2 mt-1 leading-relaxed">
                  {consultando
                    ? "Preguntando cuándo te toca la siguiente."
                    : "No ha llegado respuesta del servidor. Revisa tu conexión y vuelve a intentarlo."}
                </p>
              </>
            ) : (
              <>
                <p className="t-etiqueta ink-soft">Vuelve en</p>
                <p className="ink t-display tnum mt-1 font-bold">
                  {vuelve.exacto
                    ? falta <= 0
                      ? "un momento"
                      : duracion(falta)
                    : falta > HORA
                      ? `unas ${Math.ceil(falta / HORA)} h`
                      : "menos de 1 h"}
                </p>
                {vuelve.exacto && falta > 0 && (
                  <p className="ink-soft t-cuerpo-2 mt-1">{cuando(vuelve.en, ahora)}</p>
                )}
              </>
            )}
          </div>

          {!sinDatos && (
            <>
              <dl className="surface-2 mt-5 rounded-2xl px-4">
                <Dato rotulo="Tu racha">
                  {streak > 0
                    ? `${formatNumber(streak)} ${streak === 1 ? "día seguido" : "días seguidos"}`
                    : "sin empezar"}
                </Dato>
                <Dato rotulo={available ? "Si la reclamas ahora" : "La próxima da"}>
                  <span style={{ color: "var(--ok)" }}>{textoPremio}</span>
                  {enElTope && (
                    <span className="ink-soft t-meta font-normal"> · el máximo</span>
                  )}
                </Dato>
                {streak > 0 && rachaViva && (
                  <Dato rotulo="La racha se pierde">
                    {limiteRacha !== null
                      ? cuando(limiteRacha, ahora)
                      : `a las ${PLAZO_RACHA_H} h de la última`}
                  </Dato>
                )}
              </dl>

              {/* La regla entera, con los números del servidor (utils/constanst):
                  si mañana cambia el paso de la racha, esta frase cambia sola. */}
              <p className="ink-soft t-meta mt-3 text-center leading-relaxed">
                Son {formatNumber(DAILY_BASE)} monedas de base y{" "}
                {formatNumber(DAILY_STREAK_STEP)} más por cada día seguido, hasta{" "}
                {formatNumber(DAILY_BASE + DAILY_STREAK_CAP)}. Se puede reclamar cada{" "}
                {ESPERA_H} horas, y si pasan más de {PLAZO_RACHA_H} desde la última la
                racha vuelve a empezar.
              </p>
            </>
          )}

          <div className="mt-6 flex flex-col gap-2.5">
            {available ? (
              <button
                type="button"
                onClick={handleClaim}
                disabled={claiming}
                aria-busy={claiming}
                className="btn-accent press rounded-2xl py-3.5 t-cuerpo font-semibold disabled:opacity-40"
              >
                {claiming
                  ? "Reclamando…"
                  : cifraSegura
                    ? `Reclamar +${formatNumber(proximoPremio)}`
                    : "Reclamar"}
              </button>
            ) : (
              sinDatos && (
                <button
                  type="button"
                  onClick={() => {
                    haptic("tap");
                    consultar();
                  }}
                  disabled={consultando}
                  aria-busy={consultando}
                  className="btn-accent press rounded-2xl py-3.5 t-cuerpo font-semibold disabled:opacity-40"
                >
                  Reintentar
                </button>
              )
            )}
            <button
              type="button"
              onClick={() => setHojaAbierta(false)}
              className="btn-ghost press rounded-2xl py-3.5 t-cuerpo font-medium"
            >
              {available || sinDatos ? "Cerrar" : "Entendido"}
            </button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
