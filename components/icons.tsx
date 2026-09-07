/**
 * LOS ICONOS QUE SALEN MÁS DE UNA VEZ.
 *
 * QUÉ HABÍA. Ciento once SVG escritos a mano dentro del JSX, con SEIS grosores
 * de trazo distintos (1,5 / 1,8 / 2 / 2,2 / 2,5 y alguno sin declarar, o sea 1),
 * NUEVE tamaños (12, 14, 16, 18, 20, 22, 24, 28…) y sin criterio de cabo: unos
 * con `strokeLinecap="round"`, otros con el corte recto de fábrica. Y no eran
 * ciento once dibujos: la lupa está copiada ONCE veces, la flecha de volver
 * DIEZ, la equis NUEVE, la de avanzar CINCO, la de recargar CUATRO. La misma
 * lupa, con el mismo `d`, pero una a 14px y otra a 16, una con los cabos
 * redondos y otra en pico.
 *
 * POR QUÉ IMPORTA MÁS DE LO QUE PARECE. Un icono con el trazo a 1,5 al lado de
 * uno a 2,2 se lee como dos pesos de tinta distintos: uno parece apagado y el
 * otro en negrita, aunque los dos sean grises. En una fila de acciones —la
 * cabecera del bazar, la barra de la colección— eso da la impresión de que uno
 * de los botones está deshabilitado cuando no lo está. Y el cabo recto contra
 * el cabo redondo, a 16px, es la diferencia entre un dibujo y un garabato.
 *
 * QUÉ HAY AQUÍ. Los iconos que salían REPETIDOS en varios ficheros. Casi todos
 * eran duplicados literales —el mismo `d` copiado y pegado—, y tres no lo eran
 * del todo; van señalados uno por uno más abajo, porque la diferencia entre
 * "esto estaba duplicado" y "esto se ha decidido unificar" importa a quien
 * venga después:
 *
 *   · `IconoAviso` juntó DOS dibujos parecidos pero distintos: la colección y
 *     la vitrina pintaban `M12 7.5v5.5` + `M12 16.5h.01` (dos copias) y el
 *     bazar, el mercado y la graduación `M12 9v4` + `M12 17h.01` (tres). El
 *     mismo círculo de exclamación con la barra empezando medio píxel más
 *     arriba en unas pantallas que en otras: eso no es una decisión, es la
 *     deriva de haberlo escrito cinco veces. Se queda la versión de las tres.
 *   · `IconoCheck` no estaba repetido —lo usaba sólo el aviso flotante— y vive
 *     aquí por ser la pareja de la equis; ver su nota.
 *   · `IconoMoneda` sí estaba repetido, pero de las tres copias sólo una era
 *     este SVG: las otras dos eran el emoji 💰. Ver su nota.
 *
 * Los iconos que sólo existen en una pantalla se quedan donde están: mudarlos
 * aquí convertiría este fichero en un almacén y no en un vocabulario.
 *
 * LA REGLA, UNA PARA TODOS: viewBox de 24, trazo 2, cabos y esquinas redondos,
 * `currentColor` (el color lo pone quien lo usa, con `accent`, `ink-faint` o lo
 * que toque) y tres tamaños. Tres y no nueve: 16 es el de una fila de texto o
 * un botón de icono, 20 el de una cabecera o un menú, 24 el de un hueco vacío o
 * un aviso. Cualquier medida intermedia que hubiera —14, 18, 22— se ha
 * redondeado al escalón de al lado; a 16px, dos píxeles de diferencia no son un
 * matiz, son ruido.
 *
 * DECORATIVOS POR DEFECTO. Van con `aria-hidden` salvo que se les pase
 * `titulo`, porque el 95% de las veces el icono acompaña a un texto o a un
 * botón que ya tiene `aria-label`: anunciarlo otra vez hace que el lector de
 * pantalla lea la acción dos veces. `titulo` es para el caso contrario — el
 * icono es lo ÚNICO que hay y su significado no está escrito en ningún sitio.
 */

import type { ReactNode } from "react";

/** Los tres escalones. Ver la cabecera: no hay un cuarto a propósito. */
export type TamIcono = 16 | 20 | 24;

export interface PropsIcono {
  /** 16 (fila de texto, botón de icono), 20 (cabecera, menú), 24 (hueco vacío). */
  tam?: TamIcono;
  /** Sólo para el COLOR y la posición (`accent`, `ink-faint`, `mt-0.5`…). El
   *  tamaño sale de `tam`; ponerlo aquí con un `w-*` volvería a abrir la puerta
   *  a los nueve tamaños de antes. */
  className?: string;
  /** Nombre accesible. Sólo cuando el icono es lo ÚNICO que informa; si va
   *  dentro de un botón con `aria-label` o al lado de un texto, se deja vacío
   *  y el icono queda oculto para el lector de pantalla. */
  titulo?: string;
}

/**
 * El envoltorio común. Es lo único que sabe de trazos, cabos y accesibilidad;
 * cada icono de abajo aporta sólo su dibujo.
 *
 * `shrink-0` va de serie porque casi todos estos iconos viven dentro de un flex
 * al lado de un texto que puede crecer: sin él, el icono es lo primero que se
 * aplasta y acaba convertido en una raya. Era ya la clase más repetida en las
 * copias que esto sustituye.
 */
function Base({
  tam = 16,
  className = "",
  titulo,
  children,
}: PropsIcono & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={tam}
      height={tam}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      // Un SVG dentro de un <button> es enfocable en IE/Edge antiguos y sigue
      // apareciendo en el recorrido del tabulador de algún lector: con esto el
      // foco se queda en el botón, que es lo que se pulsa.
      focusable="false"
      role={titulo ? "img" : undefined}
      aria-hidden={titulo ? undefined : true}
    >
      {titulo ? <title>{titulo}</title> : null}
      {children}
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * NAVEGACIÓN
 * ------------------------------------------------------------------ */

/** Volver / anterior. Estaba copiado en 10 ficheros. */
export function IconoVolver(props: PropsIcono) {
  return (
    <Base {...props}>
      <path d="m15 18-6-6 6-6" />
    </Base>
  );
}

/** Avanzar / siguiente. La pareja del de arriba; 5 copias. */
export function IconoAvanzar(props: PropsIcono) {
  return (
    <Base {...props}>
      <path d="m9 18 6-6-6-6" />
    </Base>
  );
}

/** Desplegar: el que va pegado a un <select> o a un acordeón. 4 copias. */
export function IconoDesplegar(props: PropsIcono) {
  return (
    <Base {...props}>
      <path d="m6 9 6 6 6-6" />
    </Base>
  );
}

/* ------------------------------------------------------------------ *
 * ACCIONES
 * ------------------------------------------------------------------ */

/** Cerrar / limpiar el campo. Estaba copiado en 9 ficheros. */
export function IconoCerrar(props: PropsIcono) {
  return (
    <Base {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Base>
  );
}

/**
 * Confirmación. Sólo lo usaba el aviso flotante, pero vive aquí por ser la
 * pareja de `IconoCerrar`: el sí y el no de la aplicación no pueden estar
 * dibujados con dos criterios distintos, y tenerlos separados es justo cómo se
 * llega a eso.
 */
export function IconoCheck(props: PropsIcono) {
  return (
    <Base {...props}>
      <path d="m4.5 12.5 5 5 10-11" />
    </Base>
  );
}

/** Buscar. El campeón de las copias: 11, repartidas por 9 ficheros. */
export function IconoLupa(props: PropsIcono) {
  return (
    <Base {...props}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Base>
  );
}

/** Recargar / volver a intentar. 4 copias. */
export function IconoRefrescar(props: PropsIcono) {
  return (
    <Base {...props}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </Base>
  );
}

/** Añadir. 3 copias. */
export function IconoMas(props: PropsIcono) {
  return (
    <Base {...props}>
      <path d="M12 5v14M5 12h14" />
    </Base>
  );
}

/** Eliminar. 2 copias literales (la de ajustes lleva además las dos rayas de
 *  dentro, así que ésa no es la misma y se queda donde está). */
export function IconoPapelera(props: PropsIcono) {
  return (
    <Base {...props}>
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </Base>
  );
}

/* ------------------------------------------------------------------ *
 * ESTADO Y MARCA
 * ------------------------------------------------------------------ */

/**
 * Atención. El aviso de invitado, los estados de error y la colección: cinco
 * sitios que dibujaban DOS versiones de este mismo círculo (ver la cabecera).
 *
 * El triángulo de `app/error.tsx` NO es éste y se queda donde está: un error
 * fatal que se ha comido la pantalla entera y un aviso dentro de una pantalla
 * que funciona no deberían tener la misma silueta.
 */
export function IconoAviso(props: PropsIcono) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Base>
  );
}

/**
 * LA MONEDA, QUE SE DIBUJABA DE DOS FORMAS A LA VEZ.
 *
 * En la barra superior era este SVG; en Social y en la ficha de carta, el emoji
 * 💰. No es lo mismo con distinto estilo: son dos objetos distintos. El emoji
 * lo pinta el SISTEMA, así que en un iPhone es el saco de billetes de Apple, en
 * un PC el de Microsoft y en Android otro; no hereda el color de la tinta, no
 * responde al tema claro/oscuro y ni siquiera mide lo mismo que el texto que
 * tiene al lado. La misma pantalla enseñaba la moneda de la casa arriba y un
 * saco de dinero ajeno cuatro líneas más abajo.
 *
 * Se unifica al SVG, que es el que ya era de la marca: hereda `currentColor`
 * (por eso el saldo puede ir en `accent` y el precio en `--ok` sin tocar el
 * dibujo) y mide exactamente lo que se le pida en los dos aparatos.
 *
 * QUEDA UN 💰 VIVO, EN SOCIAL, Y ES CORRECTO: el del logro "Millonario". Ahí no
 * es la moneda del juego —no hay ninguna cantidad al lado—, es una de las seis
 * chapas de la rejilla de logros (📦 🗂️ 💎 💰 🏆 ⭐), que son emoji a propósito
 * y funcionan como conjunto. Cambiar sólo ésa por un trazo de línea dejaría
 * cinco pegatinas de colores y un icono de la interfaz metido entre ellas, que
 * es peor que el problema que esto arregla.
 */
export function IconoMoneda(props: PropsIcono) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-8M9 12h6" />
    </Base>
  );
}

/**
 * Ajustes. Estaba copiado en la barra superior (trazo 2, 18px) y en el menú
 * lateral (trazo 1,8, 22px): el mismo botón, en dos sitios, con dos pesos de
 * tinta y dos tamaños.
 */
export function IconoAjustes(props: PropsIcono) {
  return (
    <Base {...props}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </Base>
  );
}

/**
 * LA MARCA: el sobre con su franja. Va en el enlace al inicio de la barra
 * superior (móvil) y en el del menú lateral (escritorio), que son el mismo
 * enlace en dos anchos de pantalla.
 *
 * El punto central es el ÚNICO relleno de todo este fichero, y es a propósito:
 * sin él el sobre queda hueco y no se distingue de un icono de tarjeta
 * cualquiera. Va con `currentColor` como el trazo, así que sigue heredando el
 * color de quien lo monta.
 */
export function IconoMarca(props: PropsIcono) {
  return (
    <Base {...props}>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M3 12h18" />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" />
    </Base>
  );
}
