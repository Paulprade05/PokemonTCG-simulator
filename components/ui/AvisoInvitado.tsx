import Link from "next/link";
import type { ReactNode } from "react";
import { IconoAviso } from "../icons";

/**
 * "ESTÁS JUGANDO COMO INVITADO", UNA SOLA VEZ.
 *
 * Estaba escrito CUATRO veces —mercado, bazar, graduación y social— y las
 * cuatro decían lo mismo con distinta letra: dos tiras horizontales con el
 * icono a la izquierda (una con `p-4 mb-5`, la otra con `p-4` y sin margen),
 * una caja centrada con el icono dentro de un cuadrado de 56px, y en social ni
 * icono ni el título: sólo un "Inicia sesión para conectar" con otro tamaño de
 * letra. El mismo aviso, en el mismo juego, con cuatro caras.
 *
 * LAS DOS FORMAS SON UNA DIFERENCIA REAL, y por eso son una prop y no un
 * descuido que unificar:
 *
 *   "tira"   cuando DEBAJO hay contenido de verdad. En el mercado y en el
 *            bazar el invitado sí puede mirar el tablón y el escaparate: el
 *            aviso encabeza la pantalla y se aparta. Una caja de 300px de alto
 *            ahí sería un muro delante de algo que sí se puede usar.
 *   "hueco"  cuando la pantalla NO tiene nada más. En graduación y en social
 *            sin sesión no hay absolutamente nada debajo, y una tira pegada
 *            arriba dejaba medio metro de fondo vacío (medido a 375x812:
 *            421px). Ahí el aviso ES la pantalla, así que se pinta centrado y
 *            con el icono grande, que es el patrón de vacío de la casa.
 *
 * EL BORDE ÁMBAR NO ES DECORACIÓN: --warn es lo que en esta aplicación
 * significa "esto no está roto, pero hay algo que saber". Va en el borde y no
 * en el fondo porque el aviso no es un error: no debe gritar.
 */

interface AvisoInvitadoProps {
  /** El texto, que es lo único que cambia de una pantalla a otra. */
  children: ReactNode;
  /** "tira" (hay contenido debajo) o "hueco" (el aviso es la pantalla). */
  variante?: "tira" | "hueco";
  /** El titular. Se deja por prop porque social lo cambia por su propia
   *  llamada a la acción ("Inicia sesión para conectar"), que dice lo mismo
   *  desde el otro lado. */
  titulo?: string;
  /** La salida. En las cuatro copias era la portada; sigue siéndolo por
   *  defecto, pero la puerta queda abierta. */
  destino?: string;
  rotuloDestino?: string;
  /**
   * Otra salida en lugar del enlace: un botón que inicia sesión, un
   * "Reintentar"… Por no tenerla, Social tuvo que copiar esta caja entera en
   * components/social/AvisoSinSesion.tsx sólo para cambiar el botón, y la
   * pantalla "sin conexión" iba a ser la tercera copia. Con ella, quien quiera
   * otra acción la pasa y la caja sigue siendo una.
   */
  accion?: ReactNode;
}

export default function AvisoInvitado({
  children,
  variante = "tira",
  titulo = "Estás jugando como invitado",
  destino = "/",
  rotuloDestino = "Ir al inicio",
  accion,
}: AvisoInvitadoProps) {
  // El ámbar del borde es el mismo en las dos formas: es lo que identifica al
  // aviso de un vistazo, antes de leerlo.
  const borde = { borderColor: "color-mix(in srgb, var(--warn) 40%, transparent)" };

  if (variante === "hueco") {
    return (
      <div
        className="surface flex w-full flex-col items-center gap-4 rounded-2xl px-6 py-14 text-center"
        style={borde}
      >
        {/* El cuadrado de 56px es el mismo que usan los estados vacíos: a un
            icono suelto de 24px en mitad de una caja de 300px de alto no se le
            ve la intención, y el cuadrado le da peso sin agrandar el dibujo. */}
        <div className="surface-2 flex h-14 w-14 items-center justify-center rounded-2xl">
          <IconoAviso tam={24} className="[color:var(--warn)]" />
        </div>
        <div className="min-w-0">
          <p className="t-base font-semibold">{titulo}</p>
          <p className="ink-soft t-cuerpo mx-auto mt-1 max-w-sm">{children}</p>
        </div>
        {/* El enlace sale del párrafo y se convierte en botón: en una pantalla
            que es un callejón sin salida, la salida tiene que verse sin leer. */}
        {accion ?? (
          <Link
            href={destino}
            className="btn-primary press control-44 t-cuerpo rounded-xl px-5 font-medium"
          >
            {rotuloDestino}
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="surface flex items-start gap-3 rounded-2xl p-4" style={borde}>
      <IconoAviso tam={20} className="mt-0.5 [color:var(--warn)]" />
      <div className="min-w-0">
        <p className="t-cuerpo font-semibold">{titulo}</p>
        <p className="ink-soft t-cuerpo-2 mt-1">{children}</p>
        {/* EL ENLACE, EN SU PROPIA LÍNEA Y CON 44px DE DEDO. Iba dentro del
            párrafo y medía 55×15px: tres palabras subrayadas en mitad de un
            texto de 12px, que es de lo más difícil de acertar con el pulgar.
            Fuera del párrafo puede tener el alto mínimo sin deformar el
            interlineado; los márgenes negativos devuelven a la tira casi todo
            lo que el alto le añade (se come el relleno inferior de la caja).
            --ok y no `accent`: es texto, y el verde de marca sobre el papel
            claro da 2,2:1 (ver la nota de TINTA SEMÁNTICA en globals.css). */}
        {accion ?? (
          <Link
            href={destino}
            className="-mb-3 inline-flex min-h-11 items-center t-cuerpo-2 font-semibold underline underline-offset-2 [color:var(--ok)]"
          >
            {rotuloDestino}
          </Link>
        )}
      </div>
    </div>
  );
}
