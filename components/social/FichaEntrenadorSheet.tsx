"use client";

import { useEffect, useState } from "react";
import type { Destino } from "../../utils/tiposSocial";
import CabeceraDeHoja from "../ui/CabeceraDeHoja";
import Sheet from "../ui/Sheet";
import { escucharFichaEntrenador } from "./fichaEntrenadorGlobal";
import PanelEntrenador from "./PanelEntrenador";

/**
 * LA FICHA DE UN ENTRENADOR, EN UNA HOJA.
 *
 * Es el envoltorio: la hoja, su título y el aspa. Todo lo que la ficha sabe y
 * hace está en components/social/PanelEntrenador.tsx, que es también lo que
 * pinta la página de una invitación.
 *
 * `destino` a `null` es la hoja cerrada. Se conserva el último destino para la
 * animación de salida: sin eso, al cerrar el contenido desaparecía antes que
 * la hoja y ésta bajaba vacía.
 */

const claveDe = (d: Destino | null): string =>
  d === null ? "" : "codigo" in d ? `c:${d.codigo}` : "anuncioId" in d ? `a:${d.anuncioId}` : `e:${d.entrenadorId}`;

interface FichaEntrenadorSheetProps {
  destino: Destino | null;
  onClose: () => void;
  /** Algo ha cambiado entre los dos (petición enviada, amistad, bloqueo). */
  onCambio?: () => void;
}

export default function FichaEntrenadorSheet({ destino, onClose, onCambio }: FichaEntrenadorSheetProps) {
  // Estado derivado de una prop, ajustado durante el render (el patrón que
  // React documenta para esto): un efecto lo dejaría un fotograma por detrás.
  // Se compara por CONTENIDO: quien pase el destino como objeto literal crea
  // uno nuevo en cada render, y comparando identidades esto sería un bucle.
  const [ultimo, setUltimo] = useState<Destino | null>(destino);
  if (destino && claveDe(destino) !== claveDe(ultimo)) setUltimo(destino);

  return (
    <Sheet open={destino !== null} onClose={onClose} label="Entrenador">
      <div className="px-5 pt-2 pb-6">
        {/* Con aspa: la ficha se abre desde una rejilla de anuncios y quien la
            abre por curiosidad quiere una salida que se vea, no un asa. */}
        <CabeceraDeHoja titulo="Entrenador" onCerrar={onClose} className="mb-4" />
        {ultimo && <PanelEntrenador destino={ultimo} onCambio={onCambio} onNavegar={onClose} />}
      </div>
    </Sheet>
  );
}

/**
 * La hoja ÚNICA de la cáscara, la que abre `abrirFichaEntrenador` desde
 * cualquier pantalla (ver components/social/fichaEntrenadorGlobal.ts para el
 * porqué de que sea una sola). La monta components/AppShell.tsx.
 *
 * No pinta nada hasta que alguien la abre: la hoja cerrada es un portal vacío.
 */
export function FichaEntrenadorGlobal() {
  const [destino, setDestino] = useState<Destino | null>(null);
  useEffect(() => escucharFichaEntrenador(setDestino), []);
  return <FichaEntrenadorSheet destino={destino} onClose={() => setDestino(null)} />;
}
