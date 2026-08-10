import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Página no encontrada · TCG Sim",
};

/**
 * 404 de la app. Igual que error.tsx, se pinta dentro de AppShell, así que el
 * alto mínimo descuenta TopBar, safe-area superior y el hueco de la barra de
 * pestañas (que ya incluye var(--sab)).
 */
export default function NotFound() {
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
            background: "color-mix(in srgb, var(--ink) 8%, transparent)",
            color: "var(--ink-soft)",
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
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
            <path d="M11 8v3.5" />
            <path d="M11 14.5h.01" />
          </svg>
        </div>

        <div className="flex flex-col gap-1.5">
          <h1 className="ink text-xl font-bold tracking-tight">
            Esta página no existe
          </h1>
          <p className="ink-soft text-sm leading-relaxed">
            El enlace puede haber caducado o la dirección estar mal escrita.
          </p>
        </div>

        <Link
          href="/"
          className="btn-accent touch-target w-full rounded-xl px-4 text-sm font-semibold flex items-center justify-center"
        >
          Ir a los sobres
        </Link>
      </div>
    </div>
  );
}
