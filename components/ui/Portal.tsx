"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Saca su contenido del árbol de la página y lo cuelga de <body>.
 *
 * Es imprescindible para cualquier capa `position: fixed`. `app/template.tsx`
 * envuelve cada ruta en un motion.div con `transform` para la transición de
 * entrada, y un ancestro transformado pasa a ser el BLOQUE CONTENEDOR de sus
 * descendientes fijos: `inset-0` deja de significar "toda la pantalla" y pasa a
 * significar "toda la caja de la página", que además cambia con el scroll y con
 * el alto del contenido. De ahí que un modal encajara bien unas veces y otras
 * apareciera desplazado y con el tamaño equivocado.
 *
 * Devuelve null hasta montar porque document.body no existe al renderizar en el
 * servidor.
 */
export default function Portal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}
