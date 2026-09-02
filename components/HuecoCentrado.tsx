import type { ReactNode } from "react";

/**
 * CENTRA UN CALLEJÓN SIN SALIDA EN LO QUE QUEDA DE PANTALLA.
 *
 * Las pantallas que sólo tienen algo que explicar —"eres invitado y aquí no
 * hay nada que graduar", "no se pudo cargar el escaparate"— colgaban su caja
 * del primer hijo del contenedor y se quedaban pegadas arriba, con 400-500px
 * de fondo vacío por debajo hasta la barra de pestañas. Medido a 375x812 en
 * /graduacion: aviso de y=168 a y=332 y 421px de vacío real debajo. El mensaje
 * era correcto; lo que parecía roto era la página.
 *
 * EL ALTO SALE DEL VIEWPORT REAL, no de 100vh: es la misma fórmula que usa
 * components/Loader.tsx para el círculo de carga —`--app-height` (que escribe
 * useViewport y sí acierta en iOS con la barra de direcciones retraída), menos
 * la TopBar, menos el inset superior, menos el hueco que reserva la barra de
 * pestañas, menos el `pt-6` del <main>—.
 *
 * `descuento` es lo que haya por ENCIMA de este bloque dentro del main, casi
 * siempre un PageHeader. Sin descontarlo, centrar el contenido crearía scroll
 * en una pantalla que cabía entera, que es cambiar un defecto por otro. El
 * valor por defecto (5.5rem) es lo que mide un PageHeader con su margen
 * inferior; pásale otro si encima hay más cosas.
 */
export default function HuecoCentrado({
  children,
  descuento = "5.5rem",
}: {
  children: ReactNode;
  descuento?: string;
}) {
  return (
    <div
      className="flex w-full items-center justify-center"
      style={{
        minHeight: `calc(var(--app-height) - var(--topbar-h) - var(--sat) - var(--content-bottom) - 1.5rem - ${descuento})`,
      }}
    >
      {children}
    </div>
  );
}
