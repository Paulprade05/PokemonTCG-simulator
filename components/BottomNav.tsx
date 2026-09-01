"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { SignedIn } from "@clerk/nextjs";
import { NAV_ITEMS } from "./nav-items";
import { useHaptics } from "../hooks/useHaptics";

/* Muelle del indicador. Es el mismo que el de Sidebar a propósito: son el
   MISMO objeto en dos tamaños de pantalla y moverse distinto los delataría.
   Ratio de amortiguación ~1,05 (34 / 2·√(360·0,8)): llega y se para, sin
   rebote. Un indicador que rebota parece un juguete y, además, en un recorrido
   tan corto el rebote sólo se lee como imprecisión. */
export const MUELLE_INDICADOR = {
  type: "spring" as const,
  stiffness: 360,
  damping: 34,
  mass: 0.8,
};

export default function BottomNav({ hidden = false }: { hidden?: boolean }) {
  const pathname = usePathname();
  const haptic = useHaptics();

  const renderItem = (it: (typeof NAV_ITEMS)[number]) => {
    const active = it.match(pathname);
    return (
      <Link
        key={it.href}
        href={it.href}
        aria-current={active ? "page" : undefined}
        // press-flat y no press: `press` escala, y aquí el 3% de escala sobre un
        // objetivo de 44px no se ve (el dedo tapa justo el centro), mientras que
        // el hundimiento de 2px sí se percibe por los bordes. Además deja el
        // indicador tranquilo, que es lo que de verdad cuenta el cambio.
        className="press-flat relative flex flex-1 flex-col items-center justify-center gap-1 py-2 touch-target"
        onClick={() => {
          // Sólo al CAMBIAR de pestaña. Vibrar también al tocar la pestaña en la
          // que ya estás convierte el acuse de recibo en ruido.
          if (!active) haptic("select");
        }}
      >
        {active && (
          /* EL INDICADOR ABARCA LA PESTAÑA ENTERA, no sólo el icono.
             Antes era una píldora de ~40px pegada al icono: se desplazaba, sí,
             pero un recorrido de 40px entre dos posiciones separadas 90px se
             lee como un parpadeo de color, no como un movimiento. Ocupando toda
             la celda, el bloque viaja de verdad de una pestaña a la siguiente y
             ata la barra entera: se ve DE DÓNDE vienes, no sólo dónde estás. */
          <motion.span
            layoutId="bottomnav-pill"
            // Sin z-index propio: va primero en el DOM y el icono y la etiqueta
            // llevan z-10, así que queda detrás sin crear otro contexto de apilado.
            // inset-x-2/inset-y-1 y no inset-0: dejando aire alrededor sigue
            // siendo una píldora y no una celda rellena, que con este tamaño
            // pesaría demasiado sobre el cristal de la barra.
            className="absolute inset-x-2 inset-y-1 rounded-2xl bg-[color-mix(in_srgb,var(--accent)_13%,transparent)]"
            transition={MUELLE_INDICADOR}
          />
        )}
        <span className={`relative z-10 transition-colors ${active ? "accent" : "ink-faint"}`}>
          {it.icon}
        </span>
        {/* La etiqueta inactiva sube a ink-soft: a 10px, ink-faint (~3,6:1) no
            llega al mínimo AA de 4,5:1. El icono sí puede quedarse en ink-faint
            (gráfico: basta 3:1). */}
        <span className={`relative z-10 text-[10px] font-medium transition-colors ${active ? "ink" : "ink-soft"}`}>
          {it.label}
        </span>
      </Link>
    );
  };

  return (
    <nav
      aria-label="Principal"
      aria-hidden={hidden}
      // Sacarla de pantalla con transform no la saca del orden de tabulación:
      // sin inert el foco caería en enlaces invisibles dentro de un aria-hidden.
      inert={hidden}
      // La transición va con CSS en vez de framer: es trivial y así no depende
      // del bucle de animación. Los tiempos salen de la escala de globals.css:
      // --d-base para el recorrido y --ease-ios, la curva de todo lo que se
      // desliza. Antes eran 300ms sueltos con la misma curva escrita a mano.
      className={`md:hidden fixed bottom-0 left-0 right-0 z-40 glass border-t border-[var(--border)] flex items-stretch transition-[transform,opacity] duration-[var(--d-base)] ease-[var(--ease-ios)] ${
        hidden
          ? "translate-y-full opacity-0 pointer-events-none"
          : "translate-y-0 opacity-100"
      }`}
      // Los insets laterales sustituyen al px-2 de clase: en apaisado el
      // recorte de la pantalla se comería el primer y el último enlace.
      style={{
        paddingLeft: "max(var(--sal), 0.5rem)",
        paddingRight: "max(var(--sar), 0.5rem)",
        paddingBottom: "var(--sab)",
      }}
    >
      {NAV_ITEMS.map((it) =>
        it.requireAuth ? <SignedIn key={it.href}>{renderItem(it)}</SignedIn> : renderItem(it),
      )}
    </nav>
  );
}
