"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { usePathname } from "next/navigation";
import { RAICES_DE_PESTANA } from "../components/nav-items";

/**
 * TRANSICIÓN DE RUTA CON DIRECCIÓN.
 *
 * Antes todas las pantallas entraban igual: un fundido con 12px de subida y
 * 0,45 s, viniera de donde viniera. Eso convierte la navegación en una sucesión
 * de pantallas sin relación entre sí — el usuario no puede construir un mapa
 * mental de dónde está, porque nada le dice si ha avanzado, ha retrocedido o se
 * ha movido de lado. En una barra de pestañas eso se nota mucho: cambiar de
 * pestaña es un movimiento LATERAL y entrar en un detalle es un movimiento
 * HACIA DENTRO, y merecen leerse distinto.
 *
 * Aquí sólo se puede animar la ENTRADA: `template.tsx` monta la pantalla nueva
 * y desmonta la vieja sin que haya un momento en que convivan (no hay
 * AnimatePresence posible entre dos rutas). Por eso los recorridos son cortos:
 * sin una pantalla saliendo que empuje, un desplazamiento largo se lee como un
 * retardo, no como un empujón.
 *
 * POR QUÉ 22px Y NO MÁS: durante la animación la pantalla está desplazada hacia
 * la derecha, es decir, se sale del viewport por ese lado. Lo recorta el
 * `overflow-x: hidden` del body (globals.css), que se propaga al viewport, pero
 * cuanto menos haya que recortar, menos margen de error queda en iOS. 22px son
 * suficientes para que el ojo lea la dirección.
 *
 * ---------------------------------------------------------------------------
 * LA PRIMERA PINTURA DEL DOCUMENTO NO SE ANIMA.
 *
 * framer escribe el estado `initial` EN LÍNEA en el HTML que sirve el servidor
 * (`opacity:0; transform:translateY(10px)`) y sólo lo enciende en su primer
 * requestAnimationFrame. Eso está bien para una navegación dentro de la app,
 * pero es un desastre para la primera carga: en el arranque en frío de la PWA,
 * o al volver del segundo plano —donde rAF no corre—, el usuario ve el fondo
 * vacío y luego todo de golpe. Medido con la pestaña en segundo plano: las
 * tarjetas del mercado seguían a opacity:0 cuatro segundos después de servirse,
 * y la cabecera clavada 16px por encima de su sitio.
 *
 * Por eso el PRIMER montaje del documento va con `initial={false}`: la pantalla
 * se pinta ya en reposo, exactamente como llega del servidor, y no hay nada que
 * esperar. Las navegaciones siguientes remontan este componente y sí entran
 * animadas, que es donde la animación cuenta algo (la dirección de arriba).
 *
 * La bandera vive en el MÓDULO, como `rutaPrevia`: en el servidor ningún efecto
 * corre, así que allí es `true` para siempre y el HTML sale en reposo; en el
 * navegador la baja el primer efecto, y la hidratación —que es el primer
 * render— todavía la ve a `true`, o sea que servidor y cliente pintan lo mismo.
 */

/* Espejo en JavaScript de la escala de app/globals.css: framer-motion no lee
   variables CSS, así que --d-slow y --ease-ios se repiten aquí a propósito. Si
   se tocan allí, hay que tocarlos aquí. */
const D_SLOW = 0.34;
const EASE_IOS: [number, number, number, number] = [0.32, 0.72, 0, 1];

/**
 * Orden REAL de las pestañas en la barra inferior. Es lo que decide el signo del
 * desplazamiento: pasar de Inicio a Mercado va hacia la derecha, y al revés
 * hacia la izquierda. Sale de components/nav-items.tsx y no de una lista escrita
 * aquí a mano: la copia local y la de EdgeBackGesture no coincidían (a la del
 * gesto le faltaba "/mercado") y cada una fallaba a su manera.
 */
const PESTANAS = RAICES_DE_PESTANA;

/**
 * Rutas que NO son pestaña pero cuelgan de una. Se emparejan con su pestaña
 * (mismo criterio que `match` en nav-items.tsx, que es quien enciende el icono)
 * para poder distinguir "cambio de pestaña" de "entro en un detalle": entrar en
 * un álbum desde la colección no es un salto lateral, es bajar un nivel.
 */
const DETALLES: { prefijo: string; pestana: number }[] = [
  { prefijo: "/album", pestana: 1 },
  { prefijo: "/vitrina", pestana: 1 },
  { prefijo: "/graduacion", pestana: 1 },
  { prefijo: "/bazar", pestana: 2 },
  { prefijo: "/trainer", pestana: 3 },
];

interface Ubicacion {
  /** Índice de pestaña, o -1 si la ruta no cuelga de ninguna. */
  pestana: number;
  /** 0 = raíz de pestaña, 1 = pantalla de detalle. */
  profundidad: number;
}

function ubicar(ruta: string): Ubicacion {
  const pestana = PESTANAS.indexOf(ruta);
  if (pestana !== -1) return { pestana, profundidad: 0 };
  const detalle = DETALLES.find((d) => ruta.startsWith(d.prefijo));
  if (detalle) return { pestana: detalle.pestana, profundidad: 1 };
  // Cualquier ruta que no conozcamos (páginas de servicio, /db-stats…) se trata
  // como detalle huérfano: entra como un detalle y no finge un lateral falso.
  return { pestana: -1, profundidad: 1 };
}

/**
 * Ruta de la que venimos. Vive en el MÓDULO y no en un estado de React porque
 * `template.tsx` se vuelve a montar entero en cada navegación: cualquier estado
 * del componente nacería vacío justo cuando hace falta. El módulo sí sobrevive.
 */
let rutaPrevia: string | null = null;

/**
 * ¿Todavía no se ha pintado ninguna pantalla en este documento? Ver la cabecera
 * ("LA PRIMERA PINTURA DEL DOCUMENTO NO SE ANIMA"). Mismo motivo que
 * `rutaPrevia` para vivir en el módulo: tiene que sobrevivir al remontaje.
 */
let primeraPintura = true;

/** Desplazamiento inicial en X. 0 = la pantalla entra sin lateral. */
function desplazamiento(desde: string | null, hasta: string): number {
  // Primera carga de la sesión: no hay "de dónde", así que no hay dirección que
  // contar. Se queda el fundido con subida de siempre (lo pone la variante).
  if (desde === null || desde === hasta) return 0;

  const a = ubicar(desde);
  const b = ubicar(hasta);

  // Mismo grupo, distinto nivel: entrar en el detalle empuja desde la derecha y
  // volver a la raíz devuelve desde la izquierda. Es el gesto de "atrás" que ya
  // implementa EdgeBackGesture, contado con imagen.
  if (a.pestana === b.pestana && a.profundidad !== b.profundidad) {
    return b.profundidad > a.profundidad ? 22 : -22;
  }

  // Dos pestañas distintas: la pantalla entra por el lado hacia el que se está
  // viajando en la barra. Si alguna de las dos rutas es huérfana (-1) no hay
  // orden que seguir y se cae al fundido.
  if (a.pestana !== -1 && b.pestana !== -1 && a.pestana !== b.pestana) {
    return b.pestana > a.pestana ? 22 : -22;
  }

  // Detalle → detalle de otra familia, o cualquier caso raro: sin lateral.
  return 0;
}

export default function Template({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Se calcula UNA vez por montaje, antes de que el efecto de abajo pise
  // `rutaPrevia`: en el primer render de esta pantalla, `rutaPrevia` todavía
  // guarda la anterior, que es justo lo que hace falta.
  const [x] = useState(() => desplazamiento(rutaPrevia, pathname));

  // Igual que `x`: se lee UNA vez, en el primer render, antes de que el efecto
  // la baje. En la hidratación sigue a `true` (el efecto aún no ha corrido) y
  // en cualquier montaje posterior ya está a `false`.
  const [esLaPrimera] = useState(() => primeraPintura);

  useEffect(() => {
    rutaPrevia = pathname;
    primeraPintura = false;
  }, [pathname]);

  // Sin lateral, la entrada es la de siempre: fundido con 10px de subida. Con
  // lateral no hay subida, porque mezclar los dos ejes convierte un empujón
  // limpio en una diagonal que no significa nada.
  const y = x === 0 ? 10 : 0;

  return (
    <motion.div
      // `false` en la primera pintura del documento: se sirve y se hidrata ya
      // en reposo (opacity 1, sin transform). Ver la cabecera.
      initial={esLaPrimera ? false : { opacity: 0, x, y }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      transition={{
        // La opacidad termina antes que el recorrido a propósito: el contenido
        // se lee mientras todavía se está colocando, así que la pantalla parece
        // llegar antes de lo que tarda. Al revés (opacidad lenta) se percibe
        // como una pantalla que va con retraso.
        opacity: { duration: 0.18, ease: "linear" },
        default: { duration: D_SLOW, ease: EASE_IOS },
      }}
      // El MotionConfig de AppShell lleva reducedMotion="user" (o "always" con
      // el ajuste "reducir efectos" de la app): en cualquiera de los dos casos
      // framer descarta x/y y deja sólo el fundido.
    >
      {children}
    </motion.div>
  );
}
