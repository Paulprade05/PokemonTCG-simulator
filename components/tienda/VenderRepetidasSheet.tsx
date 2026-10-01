"use client";

import CabeceraDeHoja from "../ui/CabeceraDeHoja";
import Sheet from "../ui/Sheet";

/**
 * ANTES DE VENDER LAS REPETIDAS DEL SOBRE, SI ENTRE ELLAS HAY ALGO QUE MIRAR.
 *
 * "Vender N repetidas" vendía al toque y no se puede deshacer. Casi siempre
 * está bien: son comunes. Pero en un ×10 Premium entre las veintitantas puede
 * ir la segunda copia de una Special Illustration Rare que el jugador quería
 * graduar (graduar GASTA repetidas), publicar en el Bazar o entregar en un
 * encargo; o la segunda copia de una favorita, que "Limpiar duplicados" de la
 * Colección sí respeta y este botón no (`sellPackDuplicates` no mira
 * `is_favorite`).
 *
 * Esta hoja sólo aparece en ese caso —sin cartas delicadas el botón sigue
 * siendo un toque— y ofrece lo que falta: vender todas, o vender sólo las
 * demás. No cambia ningún precio ni toca el servidor: lo único que hace es
 * decidir QUÉ ids se le mandan a la venta de siempre.
 *
 * NO ES `ConfirmSheet` porque aquélla tiene dos salidas (confirmar o cancelar)
 * y aquí hacen falta tres. Comparte con ella la caja, la cabecera y el orden
 * "primero se va la hoja, después se hace el trabajo" (el porqué está allí).
 */
export interface RepetidaDelicada {
  id: string;
  nombre: string;
  /** Por qué se avisa: rareza alta o marcada como favorita. */
  motivo: string;
}

interface VenderRepetidasSheetProps {
  open: boolean;
  onClose: () => void;
  /** Las repetidas del sobre que merecen una segunda mirada. */
  delicadas: RepetidaDelicada[];
  /** Cuántas repetidas hay en total, delicadas incluidas. */
  total: number;
  /** Cuántas quedan si se apartan las delicadas. Con 0 no se ofrece la opción. */
  demas: number;
  onVenderTodas: () => void;
  onVenderDemas: () => void;
}

/** Más de cinco nombres convierten la hoja en una lista: se resumen. */
const MAX_NOMBRES = 5;

export default function VenderRepetidasSheet({
  open,
  onClose,
  delicadas,
  total,
  demas,
  onVenderTodas,
  onVenderDemas,
}: VenderRepetidasSheetProps) {
  const visibles = delicadas.slice(0, MAX_NOMBRES);
  const resto = delicadas.length - visibles.length;
  const despues = (fn: () => void) => () => {
    onClose();
    requestAnimationFrame(() => fn());
  };

  return (
    <Sheet open={open} onClose={onClose} label="Vender repetidas del sobre">
      <div className="px-5 pt-3 pb-6">
        <CabeceraDeHoja titulo="¿Vender también éstas?" />
        <p className="ink-soft t-cuerpo mt-2 text-center leading-relaxed">
          Entre las repetidas hay cartas que quizá quieras conservar: graduar gasta repetidas, y
          el Bazar y los encargos también las piden. La venta no se puede deshacer.
        </p>
        <ul className="surface-2 mt-4 space-y-1.5 rounded-xl p-3">
          {visibles.map((c) => (
            <li key={c.id} className="flex items-baseline justify-between gap-3">
              <span className="ink t-cuerpo min-w-0 truncate font-medium">{c.nombre}</span>
              <span className="ink-soft t-meta shrink-0">{c.motivo}</span>
            </li>
          ))}
          {resto > 0 && <li className="ink-soft t-meta">y {resto} más</li>}
        </ul>
        <div className="mt-6 flex flex-col gap-2.5">
          {demas > 0 && (
            <button
              type="button"
              onClick={despues(onVenderDemas)}
              className="btn-accent press rounded-2xl py-3.5 t-cuerpo font-semibold"
            >
              Vender sólo las demás ({demas})
            </button>
          )}
          <button
            type="button"
            onClick={despues(onVenderTodas)}
            className="press rounded-2xl py-3.5 t-cuerpo font-semibold"
            style={{
              background: "color-mix(in srgb, var(--danger) 16%, transparent)",
              border: "1px solid color-mix(in srgb, var(--danger) 35%, transparent)",
              // --danger-ink: el rótulo es texto y --danger es el token de fondo
              // (el mismo criterio que el botón destructivo de ConfirmSheet).
              color: "var(--danger-ink)",
            }}
          >
            Vender las {total}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost press rounded-2xl py-3.5 t-cuerpo font-medium"
          >
            Cancelar
          </button>
        </div>
      </div>
    </Sheet>
  );
}
