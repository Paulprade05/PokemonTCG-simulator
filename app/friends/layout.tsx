import type { Metadata } from "next";

/**
 * page.tsx es "use client" y los componentes de cliente no pueden exportar
 * metadata: este layout mínimo existe sólo para dar título a la ruta.
 * Devuelve los children tal cual, así que no altera el árbol renderizado.
 */
export const metadata: Metadata = {
  title: "Amigos · TCG Sim",
  description: "Entrenadores, solicitudes e intercambios",
};

export default function FriendsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
