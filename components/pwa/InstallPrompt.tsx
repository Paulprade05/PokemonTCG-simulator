"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { isIOS, isSafari, isStandaloneDisplay } from "../../utils/platform";

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
    strokeWidth={1.9}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="inline w-3.5 h-3.5 accent"
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
    strokeWidth={1.9}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="inline w-3.5 h-3.5 accent"
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

    // iOS nunca dispara el evento: mostramos las instrucciones tras un momento
    // para no tapar la primera impresión de la app.
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (isIOS() && isSafari()) {
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
          transition={{ type: "spring", stiffness: 380, damping: 36 }}
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
              <p className="text-[13px] font-semibold ink">
                Instala el simulador
              </p>
              {iosMode ? (
                <p className="mt-0.5 text-[11px] leading-relaxed ink-faint flex flex-wrap items-center gap-x-1 gap-y-0.5">
                  Pulsa
                  <ShareIcon />
                  <span className="ink-soft">Compartir</span>y luego
                  <PlusSquareIcon />
                  <span className="ink-soft">Añadir a inicio</span>
                </p>
              ) : (
                <p className="mt-0.5 text-[11px] leading-relaxed ink-faint">
                  Pantalla completa, acceso directo y tus cartas disponibles sin
                  conexión.
                </p>
              )}
              {!iosMode && (
                <button
                  onClick={install}
                  className="btn-accent press mt-2.5 rounded-full px-4 py-1.5 text-xs font-semibold"
                >
                  Instalar
                </button>
              )}
            </div>
            <button
              onClick={dismiss}
              aria-label="Cerrar"
              className="press shrink-0 -m-1 p-1 rounded-full ink-faint"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                className="w-4 h-4"
                aria-hidden="true"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
