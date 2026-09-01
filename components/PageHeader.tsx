"use client";

import Link from "next/link";
import { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  back?: string;
  logo?: string;
  actions?: ReactNode;
}

/**
 * UNA PANTALLA, UNA ENTRADA.
 *
 * Esta cabecera tenía su propia animación de entrada (fundido con 8px de bajada
 * en 0,4 s) ADEMÁS de la de la ruta, que ya mueve la pantalla completa desde
 * app/template.tsx. Dos animaciones anidadas se multiplican: el título recorría
 * un camino distinto al del contenido que tiene debajo, salían de sitios
 * distintos y llegaban en momentos distintos. Eso es exactamente lo que hace
 * que una app parezca "de web": las piezas de una misma pantalla se mueven cada
 * una por su cuenta.
 *
 * Quitarla no resta movimiento —la cabecera sigue entrando, empujada por la
 * transición de ruta— y además ahorra el envoltorio de framer en TODAS las
 * pantallas, porque esto lo monta casi cada página de la app.
 */
export default function PageHeader({ title, subtitle, back, logo, actions }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-3 mb-6 md:mb-8">
      <div className="flex items-center gap-3 min-w-0">
        {back && (
          <Link
            href={back}
            aria-label="Volver"
            className="touch-target w-11 h-11 rounded-xl btn-ghost press flex items-center justify-center shrink-0"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </Link>
        )}
        {logo ? (
          // El logotipo es decorativo: el <h1> se mantiene oculto para que la
          // página no se quede sin encabezado en el rotor de VoiceOver.
          <>
            <h1 className="sr-only">{title}</h1>
            <img src={logo} alt="" className="h-9 md:h-11 object-contain" />
          </>
        ) : (
          <div className="min-w-0">
            <h1 className="text-xl md:text-2xl font-bold tracking-tight truncate">{title}</h1>
            {subtitle && <p className="text-xs ink-soft mt-0.5 truncate">{subtitle}</p>}
          </div>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
