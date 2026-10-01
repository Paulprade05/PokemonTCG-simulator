"use client";

import { useCurrency } from "./useGameCurrency";

export type { Identidad } from "../utils/identidad";

/**
 * Quién está mirando: "resolviendo", "cuenta", "invitado" o
 * "cuenta-sin-conexion". Qué significa cada una y de dónde sale la última está
 * en utils/identidad.ts.
 *
 * Es lo que tiene que mirar una pantalla en lugar de `useUser().isLoaded` o de
 * `useSesionResuelta()` a secas: esos dos dicen CUÁNDO dejar de esperar, y éste
 * dice además A QUIÉN se deja de esperar. La respuesta la calcula el proveedor
 * del saldo, una vez para toda la app, y por eso aquí sólo se lee: dos pantallas
 * no pueden opinar distinto sobre quién es el jugador.
 */
export const useIdentidad = () => useCurrency().identidad;
