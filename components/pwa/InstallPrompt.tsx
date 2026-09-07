"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { isIOS, isStandaloneDisplay } from "../../utils/platform";
import { IconoCerrar } from "../icons";
import { MUELLE_PANEL } from "../../utils/motion";

const DISMISS_KEY = "pwa-install-dismissed";
// Tras descartarlo no volvemos a insistir en dos semanas.
const DISMISS_DAYS = 14;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const ShareIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="inline w-4 h-4 accent"
    aria-hidden="true"
  >
    <path d="M12 15V4M12 4 8.5 7.5M12 4l3.5 3.5" />
    <path d="M6 12H5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1h-1" />
  </svg>
);

const PlusSquareIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="inline w-4 h-4 accent"
    aria-hidden="true"
  >
    <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
    <path d="M12 8.5v7M8.5 12h7" />
  </svg>
);

/**
 * Banner de instalación de la PWA. En Android y escritorio usa el evento
 * nativo `beforeinstallprompt`; en iOS ese evento no existe, así que se
 * explica el gesto manual de Compartir → Añadir a pantalla de inicio.
 */
export default function InstallPrompt() {
  const [visible, setVisible] = useState(false);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosMode, setIosMode] = useState(false);

  useEffect(() => {
    if (isStandaloneDisplay()) return;

    const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) || 0);
    if (dismissedAt && Date.now() - dismissedAt < DISMISS_DAYS * 864e5) return;

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setVisible(true);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);

    // En iOS ningún navegador dispara el evento, pero desde iOS 16.4 Chrome,
    // Edge y Firefox también instalan con Compartir → Añadir a inicio (el mismo
    // gesto que Safari), así que las instrucciones se muestran en todos ellos.
    // Tras un momento, para no tapar la primera impresión de la app.
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (isIOS()) {
      timer = setTimeout(() => {
        setIosMode(true);
        setVisible(true);
      }, 3500);
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      if (timer) clearTimeout(timer);
    };
  }, []);

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setVisible(false);
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
    dismiss();
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ y: 140, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 140, opacity: 0 }}
          // Es un panel que sube desde abajo, igual que la hoja: el muelle sale
          // de utils/motion.ts en vez de ser un séptimo juego de números.
          transition={MUELLE_PANEL}
          className="fixed inset-x-0 z-50 flex justify-center px-3"
          // Se apoya en el hueco que el armazón ya reserva para la barra de
          // pestañas: así sigue su alto real y en escritorio, donde esa barra no
          // existe, la variable vale menos y el banner baja solo. Va en línea
          // porque una clase md:bottom-* nunca ganaría a este style.
          style={{ bottom: "calc(var(--content-bottom) + 12px)" }}
        >
          <div className="glass border border-[var(--border)] rounded-2xl shadow-[var(--shadow-lg)] p-3.5 w-full max-w-md flex items-start gap-3">
            <img
              src="/icons/icon-192.png"
              alt=""
              className="w-11 h-11 rounded-xl shrink-0"
            />
            <div className="flex-1 min-w-0">
              {/* t-cuerpo y no t-cuerpo-2: es el rótulo principal del aviso y
                  lo que tiene debajo son 11px. A 12 contra 11 no habría
                  jerarquía ninguna. */}
              <p className="t-cuerpo font-semibold ink">
                Instala el simulador
              </p>
              {iosMode ? (
                <p className="mt-0.5 t-meta leading-relaxed ink-soft flex flex-wrap items-center gap-x-1 gap-y-0.5">
                  Pulsa
                  <ShareIcon />
                  <span className="ink-soft">Compartir</span>y luego
                  <PlusSquareIcon />
                  <span className="ink-soft">Añadir a inicio</span>
                </p>
              ) : (
                <p className="mt-0.5 t-meta leading-relaxed ink-soft">
                  Pantalla completa, acceso directo y tus cartas disponibles sin
                  conexión.
                </p>
              )}
              {!iosMode && (
                <button
                  onClick={install}
                  className="btn-accent press control-44 mt-2.5 rounded-full px-4 t-cuerpo-2 font-semibold"
                >
                  Instalar
                </button>
              )}
            </div>
            <button
              onClick={dismiss}
              aria-label="Cerrar"
              // La zona tocable era de 24px. `control-44` la sube al mínimo y
              // el margen negativo de 14px devuelve el botón a la posición que
              // tenía: 44 - 2·14 = los 16px que ocupaba en la fila, con el aspa
              // en el mismo sitio y 44px de dedo alrededor.
              className="press control-44 shrink-0 -m-3.5 rounded-full ink-faint"
            >
              <IconoCerrar tam={16} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
