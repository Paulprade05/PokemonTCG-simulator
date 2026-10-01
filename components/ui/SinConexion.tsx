"use client";

import { useCallback, useRef, useState } from "react";
import { nombresDeCartas } from "../../app/action";
import { useAlVolver } from "../../hooks/useAlVolver";
import { recargarApp } from "../../utils/versionApp";
import AvisoInvitado from "./AvisoInvitado";
import EstadoError from "./EstadoError";
import { useToast } from "./Toast";

/**
 * "SIN CONEXIÓN", PARA QUIEN TIENE CUENTA Y CLERK NO HA PODIDO DECIRLO.
 *
 * Es la pantalla del estado "cuenta-sin-conexion" de utils/identidad.ts: sus
 * cartas viven en el servidor, así que no hay nada local que enseñar, y
 * enseñarle la colección de invitado (casi siempre vacía) o un "Inicia sesión"
 * sería decirle que ha perdido su partida. Lo honesto es decir qué pasa y cómo
 * se sale.
 *
 * POR QUÉ REINTENTAR ES RECARGAR, y no volver a llamar a la carga de la
 * pantalla: lo que falta no es la colección, es la SESIÓN. clerk-js no vuelve a
 * intentar resolverla por su cuenta, y sin él las server actions no saben
 * quién pregunta (el token de sesión caduca en un minuto y es clerk-js quien
 * lo renueva). Recargar es lo único que le da otra oportunidad.
 *
 * Y RECARGA CON `recargarApp`, no con `location.reload()` a secas: la recarga
 * pasa por el service worker, que con cobertura lenta sirve la copia guardada
 * a los cuatro segundos (public/sw.js). Era volver a la misma pantalla de la
 * que se intentaba salir. `recargarApp` le pide que para esta vez espere a la
 * red.
 *
 * POR QUÉ SE COMPRUEBA LA RED ANTES DE RECARGAR: recargar sin cobertura cambia
 * una pantalla que explica lo que pasa por la página sin conexión del service
 * worker, de la que no se vuelve sola. `navigator.onLine` no vale para esto
 * —dice "hay wifi", no "hay internet"—, así que se hace una petición de verdad:
 * `nombresDeCartas([])` es una server action que contesta sin tocar la base de
 * datos, y al ser un POST el service worker no puede responderla de caché.
 *
 * Y SE REINTENTA SOLA cuando el navegador avisa de que ha vuelto la red o la
 * app vuelve del segundo plano (hooks/useAlVolver.ts), que es cuando el jugador
 * sale del túnel. Cada uno de esos avisos dispara UNA comprobación; si falla,
 * no pasa nada y la pantalla sigue donde estaba (no hay bucle de recargas
 * posible: tras recargar hace falta otro aviso del sistema para volver a
 * intentarlo).
 *
 * DOS FORMAS, con el mismo criterio que AvisoInvitado: "hueco" cuando la
 * pantalla no tiene nada más que enseñar (la colección, Social), y "tira"
 * cuando debajo hay contenido que sí se puede mirar sin sesión (la lista de
 * expansiones de la portada, el escaparate del bazar).
 */
export default function SinConexion({
  detalle = "No se ha podido comprobar tu sesión y tus cartas están guardadas en tu cuenta. Se reintentará en cuanto vuelva la conexión.",
  variante = "hueco",
}: {
  /** Qué no se puede abrir y por qué, con las palabras de cada pantalla. */
  detalle?: string;
  /** "hueco": el aviso es la pantalla. "tira": encabeza contenido que sí se ve. */
  variante?: "hueco" | "tira";
}) {
  const toast = useToast();
  const [probando, setProbando] = useState(false);
  // Cerrojo de ref: `online` y `visibilitychange` pueden llegar en el mismo
  // tick, y el estado no se ve hasta el siguiente render.
  const probandoRef = useRef(false);

  const reintentar = useCallback(
    async (avisar: boolean) => {
      if (probandoRef.current) return;
      probandoRef.current = true;
      setProbando(true);
      try {
        await nombresDeCartas([]);
        recargarApp();
      } catch {
        if (avisar) toast("Sigues sin conexión. Inténtalo en un momento.", "error");
      } finally {
        probandoRef.current = false;
        setProbando(false);
      }
    },
    [toast],
  );

  useAlVolver(() => {
    void reintentar(false);
  });

  if (variante === "tira") {
    return (
      <AvisoInvitado
        variante="tira"
        titulo="Sin conexión"
        accion={
          <button
            type="button"
            onClick={() => reintentar(true)}
            disabled={probando}
            aria-busy={probando}
            className="-mb-3 inline-flex min-h-11 items-center t-cuerpo-2 font-semibold underline underline-offset-2 [color:var(--ok)] disabled:opacity-60"
          >
            {probando ? "Comprobando…" : "Reintentar"}
          </button>
        }
      >
        {detalle}
      </AvisoInvitado>
    );
  }

  return (
    <EstadoError
      titulo="Sin conexión"
      detalle={detalle}
      rotulo={probando ? "Comprobando…" : "Reintentar"}
      onReintentar={() => reintentar(true)}
    />
  );
}
