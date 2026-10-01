"use client";

import { useEffect, useRef } from "react";

/**
 * Ejecuta `cb` cuando la app VUELVE: al pasar a primer plano, al restaurarse
 * desde la caché de páginas del navegador y al recuperar la red.
 *
 * POR QUÉ EXISTE. iOS no recarga una PWA instalada al reabrirla: la reanuda tal
 * cual la dejó, horas o días después. Todo lo que se pedía "al montar" se pedía
 * entonces una sola vez por documento, y el saldo, la recompensa diaria o la
 * versión de la app se quedaban en lo que valían al cerrar. Montar no es la
 * señal de "el jugador ha vuelto"; estos tres eventos sí.
 *
 * `minMs` es el mínimo entre dos disparos: saltar entre dos apps diez veces en
 * un minuto no puede costar diez consultas al servidor. El primer regreso tras
 * montar siempre dispara.
 *
 * `cb` se lee por ref: puede cambiar en cada render sin que los oyentes se
 * quiten y se vuelvan a poner.
 */
export function useAlVolver(cb: () => void, minMs = 0): void {
  const cbRef = useRef(cb);
  useEffect(() => {
    cbRef.current = cb;
  }, [cb]);

  useEffect(() => {
    let ultimo = 0;
    const disparar = () => {
      const ahora = Date.now();
      if (ahora - ultimo < minMs) return;
      ultimo = ahora;
      cbRef.current();
    };
    const alVerse = () => {
      if (document.visibilityState === "visible") disparar();
    };
    // `pageshow` con `persisted` es la restauración desde la caché de páginas
    // (bfcache): el documento vuelve sin recargarse y sin `visibilitychange`.
    const alMostrarse = (e: PageTransitionEvent) => {
      if (e.persisted) disparar();
    };
    document.addEventListener("visibilitychange", alVerse);
    window.addEventListener("pageshow", alMostrarse);
    window.addEventListener("online", disparar);
    return () => {
      document.removeEventListener("visibilitychange", alVerse);
      window.removeEventListener("pageshow", alMostrarse);
      window.removeEventListener("online", disparar);
    };
  }, [minMs]);
}
