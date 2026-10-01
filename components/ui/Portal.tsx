"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

// No hay nada a lo que suscribirse: "¿estamos en el navegador?" no cambia.
const sinSuscripcion = () => () => {};

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
 * Devuelve null en el servidor (y en la hidratación, que tiene que pintar lo
 * mismo que él) porque allí document.body no existe.
 *
 * CON useSyncExternalStore Y NO CON UN ESTADO QUE ENCIENDE UN EFECTO. El
 * `useState(false)` + `useEffect(() => setMounted(true))` de antes hacía dos
 * cosas de más: un render en cascada por cada portal de la app (lo que el
 * linter marca como set-state-in-effect), y —lo que se notaba— que una capa
 * montada YA ABIERTA en el navegador naciera vacía y sólo apareciera un commit
 * después, por un repintado que es del Portal y no de quien lo usa. Los efectos
 * del dueño ya habían corrido para entonces con sus refs vacíos: una hoja así
 * se quedaba sin gesto en el asa y sin foco. Ahora el servidor y la hidratación
 * leen `false`, y cualquier montaje posterior en el navegador lee `true` desde
 * el primer render, con el contenido en el mismo commit.
 */
export default function Portal({ children }: { children: ReactNode }) {
  const enNavegador = useSyncExternalStore(
    sinSuscripcion,
    () => true,
    () => false,
  );
  if (!enNavegador) return null;
  return createPortal(children, document.body);
}
