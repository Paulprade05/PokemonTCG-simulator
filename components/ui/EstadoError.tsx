"use client";

import EstadoVacio from "./EstadoVacio";
import { IconoAviso } from "../icons";

/**
 * "NO SE PUDO CARGAR", CON UN SOLO BOTÓN DE REINTENTAR.
 *
 * Estaba reescrito en NUEVE sitios (el álbum, el bazar, la colección, social
 * dos veces, el mercado, el álbum de entrenador, la vitrina y la graduación) y
 * lo que más se notaba era el botón: SIETE lo pintaban con `btn-accent` —el
 * degradado esmeralda de la marca— y DOS con `btn-primary` —el bloque de tinta
 * sólida—. Los dos son botones buenos de la casa; el problema es que un mismo
 * "Reintentar" cambiaba de color según por qué pantalla se hubiera llegado
 * hasta él, y el color de un botón es lo que enseña a la gente cuál es la
 * acción principal. Si a veces es verde y a veces negro, deja de enseñar nada.
 *
 * SE UNIFICA EN `btn-accent`, que era el de la mayoría y el que la casa reserva
 * para "la acción principal de esta pantalla" — y en un error, reintentar es
 * literalmente la única acción que hay.
 *
 * SE UNIFICA TAMBIÉN EL ICONO. Dos de las nueve copias (colección y vitrina)
 * traían el círculo de exclamación dentro de un cuadrado de 56px y las otras
 * siete no traían nada. Eso no era una decisión de cada pantalla: era el orden
 * en que se fueron escribiendo. Con el icono, el bloque se identifica como
 * "algo ha ido mal" antes de leer una palabra, que es la mitad del trabajo de
 * un estado de error.
 *
 * COMPARTE CAJA CON `EstadoVacio` a propósito: un error y un vacío son la misma
 * situación desde el punto de vista del jugador —una pantalla sin contenido que
 * explica por qué— y la única diferencia real es que del error se puede salir
 * probando otra vez. Que se vean iguales es correcto.
 */

interface EstadoErrorProps {
  /** Qué ha fallado, en una línea y sin jerga ("No se pudo abrir el bazar"). */
  titulo: string;
  /** El apoyo. Por defecto apunta a lo que casi siempre es: la conexión. */
  detalle?: string;
  /** Volver a intentarlo. */
  onReintentar: () => void;
  /** Por si alguna pantalla necesita otro verbo. */
  rotulo?: string;
}

export default function EstadoError({
  titulo,
  detalle = "Comprueba tu conexión e inténtalo de nuevo.",
  onReintentar,
  rotulo = "Reintentar",
}: EstadoErrorProps) {
  return (
    <EstadoVacio
      titulo={titulo}
      detalle={detalle}
      icono={<IconoAviso tam={24} />}
      accion={
        <button
          type="button"
          onClick={onReintentar}
          className="btn-accent press control-44 t-cuerpo rounded-xl px-6 font-semibold"
        >
          {rotulo}
        </button>
      }
    />
  );
}
