"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useHaptics } from "../../hooks/useHaptics";

// Franja desde el borde izquierdo en la que arranca el gesto.
const EDGE_ZONE = 26;
// Recorrido necesario para confirmar la vuelta atrás.
const CONFIRM_DISTANCE = 84;
const CONFIRM_VELOCITY = 480;

/**
 * Volver atrás deslizando desde el borde izquierdo.
 *
 * Instalada en la pantalla de inicio, la app no tiene barra de Safari ni gesto
 * de retroceso del sistema: sin esto el usuario queda atrapado en cualquier
 * pantalla que no sea una pestaña. En el navegador NO se activa, porque ahí el
 * borde izquierdo ya pertenece al gesto nativo de iOS y competiríamos con él.
 */
export default function EdgeBackGesture({ disabled = false }: { disabled?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const haptic = useHaptics();
  const [progress, setProgress] = useState(0);
  const trackingRef = useRef(false);

  // En la raíz de cada pestaña no hay "atrás" que valga.
  const isTabRoot = ["/", "/collection", "/friends"].includes(pathname);

  useEffect(() => {
    if (disabled || isTabRoot) return;
    if (typeof window === "undefined") return;

    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    if (!standalone) return;

    let startX = 0;
    let startY = 0;
    let startT = 0;
    let pointerId = -1;
    let armed = false;

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || trackingRef.current) return;
      if (e.clientX > EDGE_ZONE) return;
      // Con una hoja o un modal abiertos el borde izquierdo pertenece a sus
      // propios gestos (por ejemplo, deslizar a la carta anterior).
      if (document.querySelector('[role="dialog"]')) return;
      armed = true;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      startT = e.timeStamp || performance.now();
    };

    const onMove = (e: PointerEvent) => {
      if (!armed || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (!trackingRef.current) {
        // Sólo nos quedamos el gesto si es claramente horizontal.
        if (Math.abs(dx) < 10) return;
        if (Math.abs(dy) > Math.abs(dx)) {
          armed = false;
          return;
        }
        trackingRef.current = true;
      }
      setProgress(Math.max(0, Math.min(1, dx / CONFIRM_DISTANCE)));
    };

    const onUp = (e: PointerEvent) => {
      if (!armed || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dt = Math.max(1, (e.timeStamp || performance.now()) - startT);
      const vx = (dx / dt) * 1000;

      if (trackingRef.current && (dx >= CONFIRM_DISTANCE || vx >= CONFIRM_VELOCITY)) {
        haptic("select");
        router.back();
      }
      armed = false;
      trackingRef.current = false;
      setProgress(0);
    };

    document.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerup", onUp, { passive: true });
    document.addEventListener("pointercancel", onUp, { passive: true });

    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
  }, [disabled, isTabRoot, router, haptic]);

  if (progress <= 0) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-y-0 left-0 z-[130] flex items-center"
      style={{ transform: `translateX(${progress * 18 - 18}px)` }}
    >
      <div
        className="glass flex h-12 w-12 items-center justify-center rounded-r-full"
        style={{ opacity: progress }}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5 ink"
        >
          <path d="m15 18-6-6 6-6" />
        </svg>
      </div>
    </div>
  );
}
