"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Frontera de error de la app. Vive dentro de RootLayout, así que se pinta
 * dentro de AppShell (TopBar + BottomNav siguen ahí): por eso el alto mínimo
 * descuenta el cromo y los insets en lugar de usar `min-h-dvh-app` a pelo, que
 * dejaría la pantalla más alta que el viewport y con scroll fantasma.
 */
export default function GlobalErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Sin esto el fallo se pierde: en producción React no lo imprime.
    console.error(error);
  }, [error]);

  return (
    <div
      className="flex flex-col items-center justify-center text-center"
      style={{
        minHeight:
          "calc(var(--app-height) - var(--topbar-h) - var(--sat) - var(--content-bottom) - 1.5rem)",
      }}
    >
      <div className="surface w-full max-w-sm rounded-[var(--radius)] px-6 py-8 flex flex-col items-center gap-4">
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center"
          style={{
            background: "color-mix(in srgb, var(--danger) 14%, transparent)",
            color: "var(--danger)",
          }}
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-7 h-7"
          >
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </svg>
        </div>

        <div className="flex flex-col gap-1.5">
          <h1 className="ink text-xl font-bold tracking-tight">
            Algo ha salido mal
          </h1>
          <p className="ink-soft text-sm leading-relaxed">
            No hemos podido cargar esta pantalla. Puedes reintentarlo o volver a
            los sobres.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-2.5 w-full pt-1">
          <button
            type="button"
            onClick={reset}
            className="btn-accent touch-target flex-1 rounded-xl px-4 text-sm font-semibold flex items-center justify-center"
          >
            Reintentar
          </button>
          <Link
            href="/"
            className="btn-ghost press touch-target flex-1 rounded-xl px-4 text-sm font-semibold flex items-center justify-center"
          >
            Ir a los sobres
          </Link>
        </div>

        {error.digest && (
          <p className="ink-faint text-[11px] tnum break-all">
            Referencia: {error.digest}
          </p>
        )}
      </div>
    </div>
  );
}
