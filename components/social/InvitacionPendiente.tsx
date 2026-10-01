"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { borrarLocal, escribirLocal, leerLocal } from "../../utils/almacen";
import { esCodigoAmigo, rutaDeInvitacion } from "../../utils/codigoAmigo";

/**
 * RETOMAR UNA INVITACIÓN DESPUÉS DE INICIAR SESIÓN.
 *
 * Quien abre /invitar/CODIGO casi nunca tiene sesión: llega desde un chat, en
 * Safari. Toca «Iniciar sesión y añadir», y el modal de Clerk le devuelve a la
 * misma ruta… salvo cuando no: crear la cuenta con verificación por correo, o
 * entrar con un proveedor externo, pueden terminar en la portada. Ahí la
 * invitación se había perdido y el recién llegado no sabía ni a quién iba a
 * añadir.
 *
 * Al tocar el botón se apunta el código en este dispositivo; este componente,
 * montado en la cáscara, mira ese apunte cuando APARECE una sesión y devuelve a
 * la invitación.
 *
 * LO QUE NO HACE, a propósito: enviar la petición. Sólo navega. En la página de
 * la invitación sigue haciendo falta un toque en «Añadir a {nombre}», que es
 * la primera vez que se ve a quién se añade (sin sesión el nombre no se
 * enseña).
 *
 * UNA HORA de validez: lo que tarda, con margen, en crear una cuenta y
 * verificar el correo. Un apunte más viejo es de otra visita y devolver a él
 * sería llevar a alguien a una pantalla que ya no esperaba.
 *
 * El apunte se gasta al usarlo, llegue como llegue la sesión: si Clerk ya
 * devolvió a la invitación, se borra sin navegar.
 */

const CLAVE = "tcg:invitacion-pendiente";
const VALIDEZ_MS = 60 * 60 * 1000;

/** Apunta la invitación que hay que retomar. La llama el botón de entrar. */
export function recordarInvitacion(codigo: string): void {
  if (!esCodigoAmigo(codigo)) return;
  escribirLocal(CLAVE, JSON.stringify({ codigo, t: Date.now() }));
}

/**
 * El código apuntado, si sigue valiendo. Lo que haya caducado o no tenga la
 * forma esperada se retira aquí mismo: el almacén es del navegador y puede
 * traer cualquier cosa.
 */
function invitacionApuntada(): string | null {
  const crudo = leerLocal(CLAVE);
  if (!crudo) return null;
  try {
    const v = JSON.parse(crudo) as { codigo?: unknown; t?: unknown } | null;
    if (v && esCodigoAmigo(v.codigo) && typeof v.t === "number") {
      const edad = Date.now() - v.t;
      if (edad >= 0 && edad < VALIDEZ_MS) return v.codigo;
    }
  } catch {
    // JSON roto: se trata como caducado.
  }
  borrarLocal(CLAVE);
  return null;
}

export default function InvitacionPendiente() {
  const { isSignedIn } = useUser();
  const router = useRouter();

  useEffect(() => {
    if (!isSignedIn) return;
    const codigo = invitacionApuntada();
    if (!codigo) return;
    borrarLocal(CLAVE);
    // La ruta se lee del navegador y no de `usePathname`: esto sólo tiene que
    // correr cuando aparece la sesión, no en cada cambio de pantalla.
    const actual = window.location.pathname;
    // Si ya se está en UNA invitación —ésta u otra—, no se mueve a nadie: quien
    // dejó a medias la de un amigo y ahora entra desde la de otro está mirando
    // la que quiere, y el apunte viejo le sacaría de ella.
    if (actual.startsWith("/invitar/")) return;
    router.replace(rutaDeInvitacion(codigo));
  }, [isSignedIn, router]);

  return null;
}
