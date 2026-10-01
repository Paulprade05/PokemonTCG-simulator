"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { esNavegadorEmbebido, isIOS, isStandaloneDisplay } from "../../utils/platform";
import { esRaizDePestana } from "../nav-items";
import { IconoCerrar } from "../icons";
import { MUELLE_PANEL } from "../../utils/motion";

const DISMISS_KEY = "pwa-install-dismissed";
// Cuántas veces se ha cerrado ya. Va en una clave aparte para no cambiar el
// formato de la de arriba, que es una fecha a secas y puede estar ya escrita
// en el teléfono de alguien.
const DISMISS_COUNT_KEY = "pwa-install-dismissed-veces";
// Tras descartarlo no volvemos a insistir en dos semanas.
const DISMISS_DAYS = 14;
// Y a la segunda vez, nunca más: quien lo ha cerrado dos veces ya ha contestado,
// y un aviso que vuelve cada quincena para siempre deja de ser una invitación.
const MAX_DESCARTES = 2;

/* EL ALMACÉN PUEDE NO ESTAR. En Safari con las cookies bloqueadas, o con el
 * almacenamiento agotado, `localStorage` LANZA al tocarlo. Estos accesos iban a
 * pelo dentro del efecto de montaje de una pieza que cuelga de AppShell, o sea
 * de todas las pantallas: la excepción se llevaba la app entera a la frontera
 * de error. Sin almacén el aviso se trata como no descartado (se puede cerrar,
 * y simplemente no se recuerda). */
function leerNumero(clave: string): number {
  try {
    return Number(localStorage.getItem(clave) || 0) || 0;
  } catch {
    return 0;
  }
}
function guardarNumero(clave: string, valor: number) {
  try {
    localStorage.setItem(clave, String(valor));
  } catch {
    /* Sin almacén no hay nada que recordar. */
  }
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Cómo se instala aquí: con el diálogo del navegador, a mano (iOS) o de
 *  ninguna forma hasta salir del navegador embebido. */
type Modo = "nativo" | "ios" | "embebido";

// Los dos iconos van EN LÍNEA con el texto: `align-[-3px]` los asienta sobre la
// línea base de una letra de 11px en vez de dejarlos colgando por arriba.
const ShareIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="inline w-4 h-4 align-[-3px] accent"
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
    className="inline w-4 h-4 align-[-3px] accent"
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
 *
 * DÓNDE SALE Y POR QUÉ NO TAPA NADA.
 *
 * Es una tarjeta fija sobre la barra de pestañas, y una capa fija tapa lo que
 * tenga debajo: medido, cubría por completo "Graduar por N monedas" en
 * /graduacion y los botones de compra de la tienda, sin scroll posible que los
 * descubriera, porque el hueco inferior de las páginas sólo reservaba la barra
 * de pestañas. Subirle o bajarle el z-index no arregla nada: es un choque de
 * POSICIÓN. Se resuelve por tres lados:
 *
 *  · RESERVA SU SITIO. Mientras se ve, publica su alto real en <html> como
 *    `--install-prompt-h`, y app/globals.css lo suma a `--content-bottom`. El
 *    final de cualquier página puede subir por encima del aviso.
 *  · SÓLO EN LAS RAÍCES DE PESTAÑA (Inicio, Colección, Mercado, Social). En
 *    una pantalla de detalle —graduar, el bazar, un álbum— se está a mitad de
 *    una tarea, y en /invitar el recién llegado tiene delante lo único que
 *    importa en ese momento: aceptar la invitación. Ahí no se ofrece instalar.
 *    Al volver a una pestaña, reaparece.
 *  · SE APARTA CON EL TECLADO (`oculto`, lo decide AppShell): la barra de
 *    pestañas ya se ha retirado y el aviso flotaría sobre lo que se escribe.
 */
export default function InstallPrompt({ oculto = false }: { oculto?: boolean }) {
  const [visible, setVisible] = useState(false);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [modo, setModo] = useState<Modo>("nativo");
  const pathname = usePathname();
  const tarjeta = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isStandaloneDisplay()) return;

    const dismissedAt = leerNumero(DISMISS_KEY);
    // Quien lo cerró antes de que existiera el contador lleva una fecha y
    // ningún recuento: eso cuenta como una vez.
    const veces = leerNumero(DISMISS_COUNT_KEY) || (dismissedAt ? 1 : 0);
    if (veces >= MAX_DESCARTES) return;
    if (dismissedAt && Date.now() - dismissedAt < DISMISS_DAYS * 864e5) return;

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setModo("nativo");
      setVisible(true);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);

    // En iOS ningún navegador dispara el evento, pero desde iOS 16.4 Chrome,
    // Edge y Firefox también instalan con Compartir → Añadir a pantalla de
    // inicio (el mismo gesto que Safari), así que las instrucciones se muestran
    // en todos ellos.
    // Tras un momento, para no tapar la primera impresión de la app.
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (isIOS()) {
      timer = setTimeout(() => {
        setModo(esNavegadorEmbebido() ? "embebido" : "ios");
        setVisible(true);
      }, 3500);
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      if (timer) clearTimeout(timer);
    };
  }, []);

  const mostrar = visible && !oculto && esRaizDePestana(pathname);

  /* EL ALTO, PUBLICADO. Se mide la tarjeta y no se supone: mide distinto con
   * las instrucciones de iOS (tres o cuatro líneas a 320px) que con el botón
   * de Android, y cambia si gira el teléfono. `offsetHeight` y no
   * getBoundingClientRect: la tarjeta entra animada, y aunque framer sólo la
   * desplaza, así la medida no depende de ningún transform. Los 8px son los
   * que la separan de la barra de pestañas (--install-prompt-bottom).
   * La limpieza retira la variable en cuanto deja de mostrarse —al cerrarla,
   * al cambiar a una pantalla de detalle, al abrir un sobre— y el hueco vuelve
   * a ser el de siempre. */
  useEffect(() => {
    if (!mostrar) return;
    const el = tarjeta.current;
    if (!el) return;
    const root = document.documentElement;
    const publicar = () =>
      root.style.setProperty("--install-prompt-h", `${el.offsetHeight + 8}px`);
    publicar();
    const observador =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(publicar) : null;
    observador?.observe(el);
    return () => {
      observador?.disconnect();
      root.style.removeProperty("--install-prompt-h");
    };
  }, [mostrar]);

  const dismiss = () => {
    const veces = leerNumero(DISMISS_COUNT_KEY) || (leerNumero(DISMISS_KEY) ? 1 : 0);
    guardarNumero(DISMISS_KEY, Date.now());
    guardarNumero(DISMISS_COUNT_KEY, veces + 1);
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
      {mostrar && (
        <motion.div
          initial={{ y: 140, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 140, opacity: 0 }}
          // Es un panel que sube desde abajo, igual que la hoja: el muelle sale
          // de utils/motion.ts en vez de ser un séptimo juego de números.
          transition={MUELLE_PANEL}
          // El contenedor ocupa todo el ancho pero NO recibe toques: lo que
          // quede a los lados de la tarjeta sigue siendo de la página. Sólo la
          // tarjeta los recoge. En escritorio se centra en la columna de
          // contenido (md:pl-63 = los 15rem del menú lateral + el margen), no
          // en la ventana: entre 768 y 900px caía encima del menú.
          className="pointer-events-none fixed inset-x-0 z-50 flex justify-center pl-[max(var(--sal),0.75rem)] pr-[max(var(--sar),0.75rem)] md:pl-63"
          // La posición sale de una variable de globals.css y no de un número
          // aquí: en móvil es "8px sobre la barra de pestañas" y en escritorio,
          // donde esa barra no existe, "1rem sobre el borde", y un style en
          // línea no puede llevar la media query que los separa.
          style={{ bottom: "var(--install-prompt-bottom)" }}
        >
          <div
            ref={tarjeta}
            className="pointer-events-auto glass border border-[var(--border)] rounded-2xl shadow-[var(--shadow-lg)] p-3.5 w-full max-w-md flex items-start gap-3"
          >
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
                {modo === "embebido" ? "Ábrelo en Safari para instalarlo" : "Instala el simulador"}
              </p>
              {modo === "ios" && (
                /* Texto corrido con los iconos en línea, no un flex de trozos:
                   en un flex cada fragmento era una caja y a 320px los saltos
                   de línea caían entre "Añadir a" e "inicio". Las dos palabras
                   que hay que buscar en la pantalla van en tinta fuerte, que
                   antes iban en el mismo gris que el resto. Y el rótulo es el
                   que pone iOS, "Añadir a pantalla de inicio": con "Añadir a
                   inicio" se buscaba una opción que no existe. */
                <p className="mt-0.5 t-meta leading-relaxed ink-soft">
                  Pulsa <ShareIcon />{" "}
                  <span className="ink font-semibold">Compartir</span> y elige{" "}
                  <PlusSquareIcon />{" "}
                  <span className="ink font-semibold">Añadir a pantalla de inicio</span>. Si no
                  ves Compartir, está en el menú ···
                </p>
              )}
              {modo === "embebido" && (
                <p className="mt-0.5 t-meta leading-relaxed ink-soft">
                  Desde dentro de otra app no se puede añadir a la pantalla de inicio. Abre el
                  menú ··· y elige{" "}
                  <span className="ink font-semibold">Abrir en el navegador</span>.
                </p>
              )}
              {modo === "nativo" && (
                <>
                  {/* Sin prometer "tus cartas disponibles sin conexión": la app
                      necesita red para casi todo y el aviso no puede vender lo
                      que todavía no hace. */}
                  <p className="mt-0.5 t-meta leading-relaxed ink-soft">
                    Pantalla completa y acceso directo, como una app más.
                  </p>
                  <button
                    onClick={install}
                    className="btn-accent press control-44 mt-2.5 rounded-full px-4 t-cuerpo-2 font-semibold"
                  >
                    Instalar
                  </button>
                </>
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
