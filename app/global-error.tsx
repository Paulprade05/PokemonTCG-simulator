"use client";

import { useEffect } from "react";

/**
 * Última red de seguridad: cubre los fallos lanzados en el propio RootLayout
 * (ClerkProvider, AppShell, TopBar…), que `app/error.tsx` no puede atrapar
 * porque vive por debajo de él.
 *
 * Sustituye al documento entero, así que tiene que pintar su propio <html> y
 * <body>. Por lo mismo no hay hoja de estilos garantizada ni variables del tema:
 * los colores van escritos a mano a propósito, sin depender de var(--…), y se
 * adaptan con prefers-color-scheme en vez de con el atributo data-theme.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="es">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem 1.5rem",
          background: "#14120c",
          color: "#eef1f5",
          fontFamily:
            "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Arial, sans-serif",
          WebkitFontSmoothing: "antialiased",
          textAlign: "center",
        }}
      >
        <div style={{ maxWidth: "22rem", display: "grid", gap: "1rem" }}>
          <h1 style={{ margin: 0, fontSize: "1.25rem", letterSpacing: "-0.01em" }}>
            La aplicación no ha podido arrancar
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: "0.875rem",
              lineHeight: 1.6,
              color: "#98a2b3",
            }}
          >
            Ha fallado algo básico al cargar. Vuelve a intentarlo; si sigue sin
            funcionar, cierra y abre la app.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              minHeight: 44,
              border: 0,
              borderRadius: 12,
              padding: "0 1.5rem",
              fontSize: "0.875rem",
              fontWeight: 600,
              color: "#04110c",
              background: "linear-gradient(135deg, #10b981, #06b6d4)",
              cursor: "pointer",
            }}
          >
            Reintentar
          </button>
          {error.digest && (
            <p
              style={{
                margin: 0,
                fontSize: "0.7rem",
                color: "#6b7484",
                wordBreak: "break-all",
              }}
            >
              Referencia: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
