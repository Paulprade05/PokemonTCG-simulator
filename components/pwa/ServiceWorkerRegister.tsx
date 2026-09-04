"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useToast } from "../ui/Toast";

/**
 * Registra el service worker que da soporte offline y cachea las imágenes de
 * las cartas, y mantiene la app AL DÍA. En una PWA instalada la página puede
 * vivir días en memoria (iOS la suspende y la reanuda), así que sin esto el
 * usuario seguía ejecutando el JS de un despliegue antiguo aunque el service
 * worker nuevo ya hubiera tomado el control: veía features desaparecidas o a
 * medias. El ciclo completo es: buscar actualización al volver al primer
 * plano → SKIP_WAITING → controllerchange → aviso → recarga en la siguiente
 * navegación.
 *
 * POR QUÉ YA NO RECARGA EN EL ACTO. El relevo del service worker llega cuando
 * la app vuelve al primer plano, y ése es justo el momento en el que alguien
 * puede estar a mitad de algo: un sobre rasgado con las cartas sin dar la
 * vuelta, una carta elegida en el selector de la vitrina, una oferta a medio
 * componer en el bazar. Un `location.reload()` ahí se lo llevaba todo sin
 * avisar. Ahora se anuncia con un aviso ("Hay una versión nueva") y la recarga
 * se APLAZA A LA SIGUIENTE NAVEGACIÓN: el cambio de ruta es un momento en el
 * que, por definición, no hay nada a medias en la pantalla que se deja. Si el
 * usuario no navega, sigue con la versión que tiene, que es la que estaba
 * funcionando; la nueva entra en la próxima apertura.
 *
 * Por eso vive dentro de AppShell (bajo el ToastProvider) y no en el layout.
 *
 * En desarrollo se desregistra para no servir chunks obsoletos de Turbopack.
 */
export default function ServiceWorkerRegister() {
  const toast = useToast();
  const pathname = usePathname();

  /* Ruta en la que se detectó la versión nueva, o null si no hay nada
   * pendiente. Es la ruta y no un booleano para poder distinguir "ha cambiado
   * de pantalla" de "sigue en la misma": el efecto de abajo se ejecuta también
   * con el pathname con el que se montó. */
  const pendienteDesdeRef = useRef<string | null>(null);
  /* El aviso se dispara desde un oyente registrado una sola vez; se lee por
   * ref para no volver a registrar el service worker si `toast` cambiara. */
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  // LA RECARGA APLAZADA: en cuanto la ruta cambia con una versión pendiente.
  useEffect(() => {
    const desde = pendienteDesdeRef.current;
    if (desde !== null && desde !== pathname) window.location.reload();
  }, [pathname]);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
      return;
    }

    let disposed = false;
    let registration: ServiceWorkerRegistration | null = null;

    // La PRIMERA toma de control no es una actualización: en un usuario nuevo
    // (o tras un hard reload) la página llega sin controller, y el
    // clients.claim() de la primera instalación dispara controllerchange
    // igualmente — pero ese HTML/JS ya es el del despliegue vigente, no hay
    // nada viejo que refrescar. Sólo cuenta si otro service worker ya nos
    // servía al cargar.
    let hadController = !!navigator.serviceWorker.controller;
    const onControllerChange = () => {
      if (!hadController) {
        // A partir de aquí la página sí está controlada: el siguiente relevo
        // (una actualización real) ya cuenta.
        hadController = true;
        return;
      }
      // Un solo aviso por relevo: un SW que llamara a clients.claim() en bucle
      // no puede llenar la pantalla de avisos ni recargar sin fin.
      if (pendienteDesdeRef.current !== null) return;
      pendienteDesdeRef.current = window.location.pathname;
      toastRef.current(
        "Hay una versión nueva. Se aplicará al cambiar de pantalla.",
        "info",
      );
    };
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange,
    );

    // Al volver la app al primer plano se comprueba si hay versión nueva:
    // es el momento en el que un usuario de PWA "vuelve a abrir" la app.
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        registration?.update().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then((reg) => {
          if (disposed) return;
          registration = reg;
          // Si ya hay una versión esperando, que tome el control al instante.
          if (reg.waiting) reg.waiting.postMessage("SKIP_WAITING");
          reg.addEventListener("updatefound", () => {
            const next = reg.installing;
            if (!next) return;
            next.addEventListener("statechange", () => {
              if (next.state === "installed" && navigator.serviceWorker.controller) {
                next.postMessage("SKIP_WAITING");
              }
            });
          });
        })
        .catch(() => {
          /* sin service worker la app sigue funcionando online */
        });
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    return () => {
      disposed = true;
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange,
      );
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
