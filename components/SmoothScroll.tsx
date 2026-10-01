"use client";

import { useEffect } from "react";
// Sólo el TIPO: se borra al compilar y no arrastra la librería al paquete. La
// librería de verdad se pide dentro del efecto (ver abajo).
import type Lenis from "lenis";

export default function SmoothScroll() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Lenis 1.x no suaviza el scroll táctil (syncTouch off), así que en el
    // iPhone instalado no aporta nada; sin este corte, el requestAnimationFrame
    // correría para siempre gastando batería y compitiendo con framer-motion.
    if (window.matchMedia("(hover: none) and (pointer: coarse)").matches) return;

    /* LENIS SE DESCARGA SÓLO SI SE VA A USAR.
     *
     * Con el `import Lenis from "lenis"` de cabecera la librería viajaba en el
     * JavaScript del armazón de TODAS las rutas, también al iPhone, que es
     * justo el aparato donde las dos líneas de arriba la descartan sin
     * instanciarla nunca: se bajaba y se compilaba en el arranque en frío de la
     * PWA para nada. Pedida aquí, después de los dos cortes, es un trozo aparte
     * que sólo pide quien tiene ratón.
     *
     * `cancelado` cubre el desmontaje mientras la petición está en vuelo: sin
     * él se crearía una instancia que ya nadie destruye. Y si el trozo no
     * llega (sin red), no pasa nada: queda el scroll nativo. */
    let cancelado = false;
    let lenis: Lenis | null = null;
    let raf = 0;

    import("lenis")
      .then(({ default: LenisReal }) => {
        if (cancelado) return;
        const instancia = new LenisReal({
          duration: 0.6,
          easing: (t) => 1 - Math.pow(1 - t, 2.5),
          smoothWheel: true,
          touchMultiplier: 1.5,
          wheelMultiplier: 1,
        });
        lenis = instancia;

        const loop = (time: number) => {
          instancia.raf(time);
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      })
      .catch(() => {});

    return () => {
      cancelado = true;
      cancelAnimationFrame(raf);
      lenis?.destroy();
    };
  }, []);

  return null;
}
