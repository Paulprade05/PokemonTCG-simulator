import type { Metadata } from "next";

/**
 * page.tsx es "use client" y los componentes de cliente no pueden exportar
 * metadata: este layout mínimo existe sólo para dar título a la ruta.
 * Devuelve los children tal cual, así que no altera el árbol renderizado.
 */
export const metadata: Metadata = {
  title: "Mi álbum · TCG Sim",
  description: "Todas las cartas que has conseguido, ordenadas por expansión",
};

export default function CollectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
