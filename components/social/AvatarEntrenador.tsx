import { matizDeCodigo } from "../../utils/codigoAmigo";

/**
 * EL AVATAR DE UN ENTRENADOR: SU INICIAL SOBRE SU COLOR.
 *
 * Antes era la inicial sobre gris, igual para todos: dos «Paul» en la lista de
 * resultados eran la misma fila dos veces y no había forma de saber a cuál se
 * estaba añadiendo. El color sale de la ETIQUETA (los cuatro últimos caracteres
 * del código de amigo, utils/codigoAmigo.ts), que viaja en todas las respuestas
 * del servidor: la misma persona sale del mismo color en la búsqueda, en las
 * peticiones, en la lista de amigos, en la ficha y en la invitación.
 *
 * EL COLOR ES UN FONDO OSCURO CON LETRA BLANCA, y los dos números están
 * elegidos: con 46 % de saturación y 32 % de luminosidad, el matiz más claro
 * de la rueda (el amarillo, 60°) da 4,7:1 contra el blanco, y el resto más. Con
 * una luminosidad «bonita» del 45-50 % los amarillos y los verdes se quedaban
 * en 3:1. Y como no depende del tema, se lee igual en claro que en oscuro.
 *
 * Sin etiqueta (una respuesta vieja, o `friend_codes` sin crear) se queda en
 * el gris de siempre: un color inventado sería un color que luego cambia.
 *
 * SIN "use client": no tiene estado ni efectos, así que lo puede pintar
 * cualquiera.
 */

const TAMANOS = {
  sm: "h-8 w-8 t-cuerpo-2",
  md: "h-10 w-10 t-cuerpo",
  lg: "h-16 w-16 t-display",
} as const;

interface AvatarEntrenadorProps {
  nombre: string;
  /** Los cuatro últimos del código. Semilla del color. */
  etiqueta?: string | null;
  tam?: keyof typeof TAMANOS;
  /** «Soy yo»: lleva el acento de la casa en lugar de su color. */
  destacado?: boolean;
}

export default function AvatarEntrenador({
  nombre,
  etiqueta,
  tam = "md",
  destacado = false,
}: AvatarEntrenadorProps) {
  // Array.from y no charAt: un nombre que empieza por un emoji o por una letra
  // fuera del plano básico son DOS unidades UTF-16, y media letra se pinta como
  // un rombo con interrogación.
  const inicial = (Array.from((nombre || "").trim())[0] || "?").toUpperCase();
  const conColor = !destacado && Boolean(etiqueta);

  return (
    <div
      aria-hidden="true"
      className={`${TAMANOS[tam]} flex shrink-0 items-center justify-center rounded-full font-bold ${
        destacado ? "btn-accent" : conColor ? "" : "surface-2 ink-soft"
      }`}
      style={
        conColor
          ? { background: `hsl(${matizDeCodigo(etiqueta as string)} 46% 32%)`, color: "#fff" }
          : undefined
      }
    >
      {inicial}
    </div>
  );
}
