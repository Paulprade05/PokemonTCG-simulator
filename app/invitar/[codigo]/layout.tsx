import type { Metadata } from "next";

/**
 * page.tsx es "use client" y los componentes de cliente no pueden exportar
 * metadata: este layout mínimo existe sólo para dar título a la ruta.
 * Devuelve los children tal cual, así que no altera el árbol renderizado.
 *
 * TEXTO FIJO, SIN EL NOMBRE DE QUIEN INVITA. Este enlace acaba en chats de
 * grupo y la vista previa la pide el servidor del chat, sin sesión: poner ahí
 * el nombre sería dárselo a cualquiera que tenga el enlace. La propia página
 * tampoco lo enseña hasta que hay sesión.
 *
 * `noindex`: una invitación es de quien la recibe, no una página que un
 * buscador tenga que guardar con el código dentro.
 */
export const metadata: Metadata = {
  title: "Invitación · TCG Sim",
  description: "Te han invitado a TCG Sim. Añade a tu amigo e intercambiad cartas.",
  robots: { index: false, follow: false },
};

export default function InvitarLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
