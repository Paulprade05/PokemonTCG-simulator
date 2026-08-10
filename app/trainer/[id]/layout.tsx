import type { Metadata } from "next";

/**
 * page.tsx es "use client" y los componentes de cliente no pueden exportar
 * metadata: este layout mínimo existe sólo para dar título a la ruta.
 * Devuelve los children tal cual, así que no altera el árbol renderizado.
 *
 * El nombre del entrenador vive detrás de la sesión de Clerk, así que aquí se
 * queda un título fijo en lugar de pagar una consulta sólo para la pestaña.
 */
export const metadata: Metadata = {
  title: "Álbum de entrenador · TCG Sim",
  description: "La colección de otro entrenador",
};

export default function TrainerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
