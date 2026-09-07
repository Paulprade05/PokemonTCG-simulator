import type { ReactNode } from "react";

/**
 * "AQUÍ NO HAY NADA", CON LA MISMA CARA EN LAS OCHO PANTALLAS QUE LO DICEN.
 *
 * Estaba reescrito OCHO veces: la rejilla de la colección, el álbum de una
 * expansión, mis anuncios del bazar, dos sitios de social, el álbum de otro
 * entrenador, la lista de graduables y la vitrina de graduadas. Y ninguna se
 * parecía del todo a la de al lado: `py-14` frente a `py-16` frente a `py-20`,
 * `gap-3` frente a `gap-4`, unas con el icono dentro de un cuadrado de 56px y
 * otras sin icono, el título en `text-sm font-medium` aquí y en `font-medium`
 * a secas (16px) allá, el texto de apoyo en `text-xs` o en `text-sm` según la
 * pantalla, y una de ellas —el álbum de entrenador— sin caja siquiera: una
 * línea de texto suelta en el hueco.
 *
 * Un vacío es de las pocas cosas que un jugador ve en CASI TODAS las pantallas
 * el primer día, cuando todavía no tiene nada. Que las ocho se vean distintas
 * es lo que hace que la aplicación parezca ocho aplicaciones justo el día que
 * más importa que parezca una.
 *
 * LA FORMA, FIJADA: caja `surface` a todo lo ancho, contenido centrado, y de
 * arriba abajo icono (opcional), titular, apoyo (opcional) y salida (opcional).
 * El icono va dentro de un cuadrado `surface-2` de 56px porque un glifo de 24px
 * flotando en una caja de 250px de alto no se lee como un dibujo, se lee como
 * una mota.
 *
 * NO CENTRA VERTICALMENTE, y es a propósito: si la pantalla no tiene nada más,
 * quien lo monta lo envuelve en `HuecoCentrado`, que es quien sabe descontar la
 * cabecera y la barra de pestañas. Meter ese cálculo aquí obligaría a esta caja
 * a saber qué tiene encima, que es justo lo que no puede saber.
 */

interface EstadoVacioProps {
  /** La frase que dice qué falta. Una línea, en positivo. */
  titulo: string;
  /** El apoyo: qué hacer para que deje de estar vacío. */
  detalle?: ReactNode;
  /** El glifo, ya dibujado y a tamaño 24 (`<IconoLupa tam={24} />`). */
  icono?: ReactNode;
  /** La salida: un botón o un enlace. Opcional — hay vacíos que no tienen
   *  ninguna acción sensata ("no hay más anuncios"). */
  accion?: ReactNode;
}

export default function EstadoVacio({
  titulo,
  detalle,
  icono,
  accion,
}: EstadoVacioProps) {
  return (
    <div className="surface flex w-full flex-col items-center gap-4 rounded-2xl px-6 py-16 text-center">
      {icono && (
        <div className="surface-2 ink-faint flex h-14 w-14 items-center justify-center rounded-2xl">
          {icono}
        </div>
      )}
      <div className="min-w-0">
        <p className="ink t-base font-semibold">{titulo}</p>
        {detalle && (
          <p className="ink-soft t-cuerpo mx-auto mt-1 max-w-xs">{detalle}</p>
        )}
      </div>
      {accion}
    </div>
  );
}
