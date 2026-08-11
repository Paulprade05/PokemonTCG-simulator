"use client";

import { useEffect } from "react";

/**
 * Registra el service worker que da soporte offline y cachea las imágenes de
 * las cartas, y mantiene la app AL DÍA. En una PWA instalada la página puede
 * vivir días en memoria (iOS la suspende y la reanuda), así que sin esto el
 * usuario seguía ejecutando el JS de un despliegue antiguo aunque el service
 * worker nuevo ya hubiera tomado el control: veía features desaparecidas o a
 * medias. El ciclo completo es: buscar actualización al volver al primer
 * plano → SKIP_WAITING → controllerchange → recarga única.
 *
 * En desarrollo se desregistra para no servir chunks obsoletos de Turbopack.
 */
export default function ServiceWorkerRegister() {
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

    // Una sola recarga por relevo de service worker. Sin el guard, un SW que
    // llamara a clients.claim() en bucle recargaría la página sin fin.
    let reloading = false;
    const onControllerChange = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
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
