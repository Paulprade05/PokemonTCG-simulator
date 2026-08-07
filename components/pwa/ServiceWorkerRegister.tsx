"use client";

import { useEffect } from "react";

/**
 * Registra el service worker que da soporte offline y cachea las imágenes de
 * las cartas. En desarrollo se desregistra para no servir chunks obsoletos de
 * Turbopack.
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

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then((reg) => {
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
  }, []);

  return null;
}
