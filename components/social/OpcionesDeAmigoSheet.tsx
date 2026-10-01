"use client";

import { useState } from "react";
import CabeceraDeHoja from "../ui/CabeceraDeHoja";
import Sheet from "../ui/Sheet";

/**
 * LO QUE SE PUEDE HACER CON UN AMIGO ADEMÁS DE VER SU ÁLBUM E INTERCAMBIAR:
 * ELIMINARLE Y BLOQUEARLE.
 *
 * Antes la tarjeta del amigo llevaba una papelera, y eliminar era lo único que
 * había. Bloquear no existía: a quien insistía sólo se le podía «Ignorar», que
 * borraba la petición y le dejaba volver a enviarla en el acto.
 *
 * UNA HOJA CON DOS PASOS, no una hoja que abre otra. El primer paso dice qué
 * se puede hacer; el segundo CONFIRMA lo elegido, con sus consecuencias
 * escritas, porque las dos acciones cortan algo que el otro puede notar (y
 * eliminar cancela además las ofertas pendientes entre los dos). Abrir una
 * segunda hoja mientras la primera se cierra enseña dos telones a la vez y
 * mueve el foco dos veces; aquí sólo cambia el contenido, y la flecha de la
 * cabecera vuelve al primer paso.
 *
 * El trabajo de verdad lo hace quien la monta: aquí no se llama a ninguna
 * acción de servidor. Como en components/ui/ConfirmSheet.tsx, primero se va la
 * hoja y un fotograma después empieza el trabajo, para que el botón no se
 * quede clavado bajo el dedo lo que tarde el servidor.
 */

export interface AmigoConOpciones {
  /** Id de la fila de la amistad: lo que recibe `eliminarAmigo`. */
  amistadId: number;
  /** Id de Clerk del amigo: lo que recibe `bloquearEntrenador`. */
  amigoId: string;
  nombre: string;
  etiqueta?: string | null;
}

interface OpcionesDeAmigoSheetProps {
  amigo: AmigoConOpciones | null;
  onClose: () => void;
  onEliminar: (amigo: AmigoConOpciones) => void;
  onBloquear: (amigo: AmigoConOpciones) => void;
}

type Paso = "opciones" | "eliminar" | "bloquear";

const ESTILO_PELIGRO = {
  background: "color-mix(in srgb, var(--danger) 16%, transparent)",
  border: "1px solid color-mix(in srgb, var(--danger) 35%, transparent)",
  // --danger-ink y no --danger: el rótulo es texto y --danger es de fondo.
  color: "var(--danger-ink)",
} as const;

export default function OpcionesDeAmigoSheet({ amigo, onClose, onEliminar, onBloquear }: OpcionesDeAmigoSheetProps) {
  const [paso, setPaso] = useState<Paso>("opciones");
  // El último amigo se conserva para la animación de salida: al cerrar, `amigo`
  // pasa a null con la hoja todavía a la vista. Se ajusta durante el render
  // (estado derivado de una prop), no en un efecto. Se compara por el id de
  // la amistad y no por identidad: un objeto recién creado en cada render de
  // quien la monta convertiría esto en un bucle.
  const [ultimo, setUltimo] = useState<AmigoConOpciones | null>(amigo);
  if (amigo && amigo.amistadId !== ultimo?.amistadId) {
    setUltimo(amigo);
    // Otro amigo empieza siempre por el primer paso.
    setPaso("opciones");
  }

  const cerrar = () => {
    setPaso("opciones");
    onClose();
  };

  const confirmar = () => {
    if (!ultimo) return;
    const hacer = paso === "eliminar" ? onEliminar : onBloquear;
    cerrar();
    requestAnimationFrame(() => hacer(ultimo));
  };

  const nombre = ultimo?.nombre ?? "este entrenador";

  return (
    <Sheet open={amigo !== null} onClose={cerrar} label={`Opciones de ${nombre}`}>
      <div className="px-5 pt-3 pb-6">
        {paso === "opciones" ? (
          <>
            <CabeceraDeHoja titulo={nombre} descripcion={ultimo?.etiqueta ? `#${ultimo.etiqueta}` : undefined} />
            <div className="mt-5 flex flex-col gap-2.5">
              <button
                type="button"
                onClick={() => setPaso("eliminar")}
                className="btn-ghost press rounded-2xl py-3.5 t-cuerpo font-medium"
              >
                Eliminar de mis amigos
              </button>
              <button
                type="button"
                onClick={() => setPaso("bloquear")}
                className="btn-ghost press rounded-2xl py-3.5 t-cuerpo font-medium"
              >
                Bloquear
              </button>
              <button type="button" onClick={cerrar} className="press rounded-2xl py-3.5 t-cuerpo ink-soft font-medium">
                Cancelar
              </button>
            </div>
          </>
        ) : (
          <>
            <CabeceraDeHoja
              titulo={paso === "eliminar" ? "Eliminar amigo" : "Bloquear"}
              onVolver={() => setPaso("opciones")}
              rotuloVolver="Volver a las opciones"
            />
            {/* Párrafo y no subtítulo de la cabecera: es la explicación que se
                lee antes de algo que el otro va a notar. Mismo criterio que
                components/ui/ConfirmSheet.tsx. */}
            <p className="ink-soft t-cuerpo mt-2 text-center leading-relaxed">
              {paso === "eliminar"
                ? `${nombre} dejará de aparecer en tu lista de amigos y las ofertas de intercambio pendientes entre los dos se cancelarán. Tus cartas no se ven afectadas.`
                : `${nombre} dejará de ser tu amigo, las ofertas pendientes entre los dos se cancelarán y no podrá enviarte peticiones ni ofertas. Puedes deshacerlo en la lista de bloqueados.`}
            </p>
            <div className="mt-6 flex flex-col gap-2.5">
              <button
                type="button"
                onClick={confirmar}
                className="press rounded-2xl py-3.5 t-cuerpo font-semibold"
                style={ESTILO_PELIGRO}
              >
                {paso === "eliminar" ? "Eliminar" : "Bloquear"}
              </button>
              <button type="button" onClick={cerrar} className="btn-ghost press rounded-2xl py-3.5 t-cuerpo font-medium">
                Cancelar
              </button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
