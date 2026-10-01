"use client";

import type { ReactNode } from "react";
import { SignInButton } from "@clerk/nextjs";
import AvisoInvitado from "../ui/AvisoInvitado";

/**
 * «ESTO NECESITA CUENTA», CON EL BOTÓN QUE ABRE LA CUENTA.
 *
 * Social sin sesión titulaba «Inicia sesión para conectar» y su única salida
 * era un enlace «Volver al inicio»: la pantalla pedía una cosa y el botón hacía
 * otra. Para entrar había que descubrir el icono de persona, sin rótulo, de la
 * barra superior. Quien llega por el atajo «Social» de la app instalada, o por
 * un enlace de invitación, se quedaba en un callejón.
 *
 * ES LA MISMA CAJA que la variante «hueco» de components/ui/AvisoInvitado.tsx
 * —borde ámbar, icono en su cuadrado de 56 px, titular y apoyo— y sólo cambia
 * la salida: aquí es `SignInButton` en modo modal, que abre el inicio de sesión
 * encima de la pantalla y vuelve A ESTA MISMA RUTA (`volverA`), no a la
 * portada. La caja ya no se copia: AvisoInvitado tiene la prop `accion` y esto
 * sólo le pasa el botón.
 *
 * `alPulsar` corre ANTES de abrir el modal (Clerk llama primero al `onClick`
 * del hijo): la página de invitación lo usa para apuntar qué invitación hay
 * que retomar cuando aparezca la sesión.
 */

interface AvisoSinSesionProps {
  titulo: string;
  children: ReactNode;
  /** Ruta a la que se vuelve tras iniciar sesión o crear la cuenta. */
  volverA: string;
  rotulo?: string;
  alPulsar?: () => void;
}

export default function AvisoSinSesion({
  titulo,
  children,
  volverA,
  rotulo = "Iniciar sesión",
  alPulsar,
}: AvisoSinSesionProps) {
  return (
    <AvisoInvitado
      variante="hueco"
      titulo={titulo}
      accion={<BotonIniciarSesion volverA={volverA} rotulo={rotulo} alPulsar={alPulsar} />}
    >
      {children}
    </AvisoInvitado>
  );
}

/**
 * El botón suelto, para quien ya tiene su propia caja (la invitación).
 *
 * Los DOS destinos, y no sólo el de iniciar sesión: quien llega por una
 * invitación casi nunca tiene cuenta, así que acaba en «Crear cuenta» dentro
 * del mismo modal, y sin `signUpFallbackRedirectUrl` ese camino terminaba en la
 * portada con la invitación perdida.
 */
export function BotonIniciarSesion({
  volverA,
  rotulo = "Iniciar sesión",
  alPulsar,
  className = "btn-accent press control-44 t-cuerpo rounded-xl px-6 font-semibold",
}: {
  volverA: string;
  rotulo?: string;
  alPulsar?: () => void;
  className?: string;
}) {
  return (
    <SignInButton mode="modal" fallbackRedirectUrl={volverA} signUpFallbackRedirectUrl={volverA}>
      <button type="button" onClick={alPulsar} className={className}>
        {rotulo}
      </button>
    </SignInButton>
  );
}
