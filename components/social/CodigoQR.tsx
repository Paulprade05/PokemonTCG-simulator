import { matrizQR, trazadoQR } from "../../utils/qr";

/**
 * EL QR DE UNA INVITACIÓN, PINTADO AQUÍ MISMO.
 *
 * Para quién es: quien usa la app instalada añade antes tecleando ocho
 * caracteres, así que el QR sirve a quien tiene al amigo DELANTE y aún no
 * tiene la app (la cámara abre /invitar/CODIGO en Safari). Va sin dependencias:
 * utils/qr.ts es un codificador propio, puro, y esto sólo lo dibuja.
 *
 * LAS CUATRO COSAS QUE UN LECTOR NECESITA, Y POR ESO NO SE TOCAN:
 *
 *  · NEGRO SOBRE BLANCO EN LOS DOS TEMAS. Un QR con los colores del tema
 *    oscuro (claro sobre oscuro) es un QR invertido, y muchas cámaras no lo
 *    leen. El fondo blanco es parte del dibujo, no del tema.
 *  · LA ZONA DE SILENCIO: cuatro módulos en blanco alrededor. La pone
 *    `trazadoQR` dentro del propio `viewBox`; sin ella el lector no encuentra
 *    las esquinas cuando el fondo de la hoja es oscuro.
 *  · MÓDULOS DE ANCHO ENTERO. El tamaño en pantalla es un múltiplo exacto del
 *    número de módulos; con un ancho cualquiera (200 px entre 37 módulos) salen
 *    módulos de 5 y de 6 píxeles alternados.
 *  · BORDES SIN SUAVIZAR (`crispEdges`): el suavizado deja una línea gris entre
 *    módulos vecinos.
 *
 * Y nada de `scale`, `filter` ni sombras: es un SVG a su tamaño, sin más.
 *
 * Devuelve `null` si el texto no cabe (más de 106 bytes): quien lo monta
 * pregunta antes con `cabeEnQR` para no ofrecer un botón que no pinta nada.
 */

/** Lado máximo en píxeles CSS. Cabe en la hoja a 320 px de pantalla (280 útiles). */
const LADO_MAXIMO = 222;

export const cabeEnQR = (texto: string): boolean => matrizQR(texto) !== null;

export default function CodigoQR({ texto, etiqueta }: { texto: string; etiqueta: string }) {
  const modulos = matrizQR(texto);
  if (!modulos) return null;
  const { lado, d } = trazadoQR(modulos, 4);
  // Píxeles por módulo, ENTERO. Con el tope de 106 bytes el dibujo más grande
  // es de versión 5 (45 módulos de lado con el margen) y sale a 4 px por
  // módulo; una invitación normal es de versión 4 y sale a 5. El suelo de 3
  // es sólo por si alguien sube VERSION_MAXIMA_QR: por debajo de eso una
  // cámara de móvil ya no separa los módulos a un palmo.
  const px = lado * Math.max(3, Math.floor(LADO_MAXIMO / lado));

  return (
    <svg
      role="img"
      aria-label={etiqueta}
      viewBox={`0 0 ${lado} ${lado}`}
      width={px}
      height={px}
      shapeRendering="crispEdges"
      className="block shrink-0 rounded-xl"
    >
      <rect width={lado} height={lado} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
