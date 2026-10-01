"use client";

import { useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useHaptics } from "../../hooks/useHaptics";
import { NAV_ITEMS, esRaizDePestana } from "../nav-items";
import { IconoVolver } from "../icons";

// Franja desde el borde izquierdo en la que arranca el gesto.
const EDGE_ZONE = 26;
// Recorrido necesario para confirmar la vuelta atrás.
const CONFIRM_DISTANCE = 84;
const CONFIRM_VELOCITY = 480;
// Recorrido mínimo para que la VELOCIDAD pueda confirmar. Es la misma guarda
// que FLICK_DISTANCE en hooks/useSwipe.ts y por el mismo motivo: unos pocos
// píxeles en unos pocos milisegundos dan una velocidad enorme (15 px en 25 ms
// son 600 px/s) y sin distancia mínima un roce en el borde volvía atrás.
const FLICK_DISTANCE = 30;

/**
 * ¿Hay una pantalla anterior a la que volver?
 *
 * `router.back()` sin historial no hace nada: salía la burbuja, vibraba y el
 * jugador seguía donde estaba. Pasa cuando la pantalla de detalle es la primera
 * entrada de la sesión (la app se reabre directamente en un álbum, o se recarga
 * sola tras una actualización).
 *
 * La API de navegación lo dice sin rodeos (`canGoBack`); donde no existe se cae
 * a `history.length`, que es una cota: 1 significa seguro que no hay atrás, y
 * más de 1 significa que probablemente sí.
 */
function hayAtras(): boolean {
  const nav = (window as unknown as { navigation?: { canGoBack?: boolean } }).navigation;
  if (typeof nav?.canGoBack === "boolean") return nav.canGoBack;
  return window.history.length > 1;
}

/** La pestaña de la que cuelga una ruta: su `match` es el mismo que enciende el
 *  icono en la barra, así que "arriba" es siempre la pestaña que se ve activa. */
const raizDe = (ruta: string) =>
  NAV_ITEMS.find((it) => it.match(ruta))?.href ?? "/";

/**
 * Volver atrás deslizando desde el borde izquierdo.
 *
 * Instalada en la pantalla de inicio, la app no tiene barra de Safari ni gesto
 * de retroceso del sistema: sin esto el usuario queda atrapado en cualquier
 * pantalla que no sea una pestaña. En el navegador NO se activa, porque ahí el
 * borde izquierdo ya pertenece al gesto nativo de iOS y competiríamos con él.
 *
 * EL INDICADOR SE ESCRIBE EN EL DOM A MANO, sin estado de React. `pointermove`
 * llega decenas de veces por segundo mientras el dedo arrastra, y un
 * `setProgress` por evento era un re-render de este componente por cada uno:
 * en iPhone se notaba como una burbuja que iba un fotograma por detrás del
 * dedo. Es el mismo criterio que usa components/ui/Sheet.tsx para aclarar el
 * fondo mientras se tira de la hoja (el `onMove` de su `useSwipe`): lo que corre en cada
 * evento de puntero escribe `style` directamente. Por eso la burbuja está
 * SIEMPRE montada (oculta con `visibility`, que no promociona ninguna capa) en
 * vez de montarse al empezar el gesto: montarla también costaría un render.
 */
export default function EdgeBackGesture({ disabled = false }: { disabled?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const haptic = useHaptics();
  const trackingRef = useRef(false);
  /** La franja fija que se desplaza con el dedo. */
  const indicadorRef = useRef<HTMLDivElement>(null);
  /** La burbuja de dentro, que se va encendiendo con el recorrido. */
  const burbujaRef = useRef<HTMLDivElement>(null);

  // En la raíz de cada pestaña no hay "atrás" que valga. La lista es la de
  // components/nav-items.tsx, derivada de las pestañas reales: la copia a mano
  // que había aquí no tenía "/mercado", y en la PWA instalada deslizar desde el
  // borde en el Mercado hacía router.back() y sacaba de la app.
  const isTabRoot = esRaizDePestana(pathname);

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

    /** Pinta el progreso (0..1) del gesto. 0 esconde el indicador. */
    const pintar = (p: number) => {
      const indicador = indicadorRef.current;
      const burbuja = burbujaRef.current;
      if (!indicador || !burbuja) return;
      if (p <= 0) {
        indicador.style.visibility = "hidden";
        indicador.style.transform = "translateX(-18px)";
        // Se limpia en vez de dejar `opacity: 0`: con `visibility: hidden` en
        // el padre ya no se ve, y así el HTML servido no lleva ningún
        // `opacity:0` en línea (es lo que se comprueba con curl para saber
        // que la primera pintura no espera a nadie).
        burbuja.style.opacity = "";
        return;
      }
      indicador.style.visibility = "visible";
      indicador.style.transform = `translateX(${p * 18 - 18}px)`;
      burbuja.style.opacity = String(p);
    };

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
      pintar(Math.max(0, Math.min(1, dx / CONFIRM_DISTANCE)));
    };

    const desarmar = () => {
      armed = false;
      trackingRef.current = false;
      pintar(0);
    };

    const onUp = (e: PointerEvent) => {
      if (!armed || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dt = Math.max(1, (e.timeStamp || performance.now()) - startT);
      const vx = (dx / dt) * 1000;

      if (
        trackingRef.current &&
        (dx >= CONFIRM_DISTANCE || (vx >= CONFIRM_VELOCITY && dx >= FLICK_DISTANCE))
      ) {
        haptic("select");
        // Sin historial, "atrás" es subir a la pestaña de la que cuelga esta
        // pantalla. `replace` y no `push`: el detalle no debe quedar DETRÁS de
        // su propia raíz en el historial.
        if (hayAtras()) router.back();
        else router.replace(raizDe(pathname));
      }
      desarmar();
    };

    /* CANCELAR NO ES SOLTAR, Y NUNCA NAVEGA.
     *
     * `pointercancel` iba al mismo manejador que `pointerup`. Lo manda el
     * NAVEGADOR cuando se queda él con el gesto: porque el dedo ha empezado un
     * scroll vertical, porque ha salido una hoja del sistema, o porque iOS ha
     * reconocido su propio gesto de borde. En todos esos casos el jugador no
     * ha terminado nada, pero `onUp` medía la velocidad con lo recorrido hasta
     * ahí y, si salía alta, llamaba a router.back(): un atrás fantasma. Y si
     * el sistema ya estaba volviendo por su cuenta, eran DOS pantallas atrás.
     */
    const onCancel = (e: PointerEvent) => {
      if (!armed || e.pointerId !== pointerId) return;
      desarmar();
    };

    document.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerup", onUp, { passive: true });
    document.addEventListener("pointercancel", onCancel, { passive: true });

    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      // Si la pantalla cambia a mitad de gesto, que no se quede una burbuja
      // encendida en la siguiente.
      trackingRef.current = false;
      pintar(0);
    };
  }, [disabled, isTabRoot, router, haptic, pathname]);

  return (
    <div
      ref={indicadorRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-y-0 left-0 z-[130] flex items-center"
      // Nace escondido; `pintar` lo enseña y lo mueve durante el gesto.
      style={{ visibility: "hidden", transform: "translateX(-18px)" }}
    >
      {/* Sin `opacity: 0` en línea: el padre ya está con visibility hidden, y
          `pintar` pone la opacidad sólo mientras dura el gesto. */}
      <div
        ref={burbujaRef}
        className="glass flex h-12 w-12 items-center justify-center rounded-r-full"
      >
        <IconoVolver tam={20} className="ink" />
      </div>
    </div>
  );
}
