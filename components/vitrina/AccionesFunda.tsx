"use client";

import PokemonCard from "../PokemonCard";
import Sheet from "../ui/Sheet";
import { useHaptics } from "../../hooks/useHaptics";
import type { FundaVitrina } from "./modelo";

/**
 * EL MENÚ DE UNA FUNDA OCUPADA: ver, cambiar o quitar.
 *
 * POR QUÉ UN MENÚ Y NO UN GESTO. Sobre una funda hay tres cosas que hacer y
 * sólo un toque disponible; repartirlas entre toque, toque largo y deslizar
 * dejaría dos de las tres sin descubrir (la vitrina no tiene tutorial, y el
 * deslizar horizontal ya es "pasar de hoja"). Tres filas con su verbo escrito
 * se entienden sin instrucciones, que es el listón de esta pantalla.
 *
 * QUITAR NO PIDE CONFIRMACIÓN, y es deliberado: `quitarDeRanura` vacía la funda
 * pero NO toca la carta —sigue en la colección— así que lo peor que puede pasar
 * es volver a colocarla, que son los dos toques que costaría confirmar. Los
 * diálogos de confirmación se reservan aquí para lo que no se puede deshacer
 * (vender, publicar en el bazar).
 *
 * La miniatura se pinta con el camino rápido de PokemonCard
 * (`interactive={false}` + `reveal`), igual que en el selector y por lo mismo:
 * ni capa compositada por carta ni ilustración borrosa en iPhone.
 */

interface AccionesFundaProps {
  /** La funda tocada; `null` cierra la hoja. */
  funda: FundaVitrina | null;
  onCerrar: () => void;
  /** Hay una escritura en vuelo: los botones se apagan. */
  guardando: boolean;
  onVer: () => void;
  onCambiar: () => void;
  onQuitar: () => void;
}

/** Una fila del menú. Icono, verbo y una línea de por qué. */
function Accion({
  icono,
  titulo,
  detalle,
  onClick,
  disabled,
  peligro = false,
}: {
  icono: React.ReactNode;
  titulo: string;
  detalle: string;
  onClick: () => void;
  disabled: boolean;
  peligro?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      /* `surface` pone el fondo y el borde; `surface-hover` sólo transiciona y
         realza el borde al pasar por encima. Nada de `press`, que escala: la
         miniatura de la carta está a dos dedos de aquí y esa clase no puede
         normalizarse en esta pantalla. */
      className="surface surface-hover flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        aria-hidden="true"
        className="surface-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
        style={{ color: peligro ? "var(--danger)" : "var(--ink-soft)" }}
      >
        {icono}
      </span>
      <span className="min-w-0">
        <span
          className="block text-[14px] font-medium"
          style={{ color: peligro ? "var(--danger)" : "var(--ink)" }}
        >
          {titulo}
        </span>
        <span className="ink-faint block text-[11px] leading-tight">
          {detalle}
        </span>
      </span>
    </button>
  );
}

export default function AccionesFunda({
  funda,
  onCerrar,
  guardando,
  onVer,
  onCambiar,
  onQuitar,
}: AccionesFundaProps) {
  const haptic = useHaptics();

  /* La carta se lee de `funda` en cada render y la hoja se cierra sola cuando
   * el padre la pone a null; así no hay una copia congelada de la carta que
   * pueda quedarse desfasada tras colocar otra encima. */
  const carta = funda?.carta ?? null;
  const huerfana = !!carta && carta.quantity <= 0;
  const nombre = carta?.name || "Carta sin datos";

  const con = (fn: () => void) => () => {
    haptic("tap");
    fn();
  };

  return (
    <Sheet open={funda !== null} onClose={onCerrar} label="Opciones de la funda">
      <div className="px-4 pt-1 pb-6 sm:px-5">
        {carta && funda && (
          <>
            <div className="flex items-center gap-4">
              {/* Ancho fijo y no una fracción: la miniatura tiene que medir lo
                  mismo con una carta apaisada rara o sin ilustración, o el
                  bloque de texto bailaría entre una funda y otra. */}
              <div className="w-20 shrink-0 sm:w-24">
                <PokemonCard card={carta} reveal interactive={false} />
              </div>
              <div className="min-w-0">
                <h2 className="ink truncate text-[16px] font-semibold">
                  {nombre}
                </h2>
                <p className="ink-soft mt-0.5 text-[12px]">
                  Hoja {funda.hoja + 1} · funda {funda.ranura + 1}
                </p>
                <p className="ink-faint tnum mt-0.5 text-[11px]">
                  {carta.rarity || "Sin rareza"}
                  {carta.quantity > 0 &&
                    ` · ${carta.quantity} ${carta.quantity === 1 ? "copia" : "copias"} en tu colección`}
                </p>
              </div>
            </div>

            {/* El aviso va con palabras y no sólo con la insignia de la funda:
                encontrarse una carta que ya no se tiene es lo bastante raro
                como para merecer una frase que explique que no es un error y
                que la funda no se ha vaciado sola a propósito. */}
            {huerfana && (
              <p
                className="mt-4 rounded-xl px-3 py-2.5 text-[11px] leading-relaxed"
                style={{
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  color: "var(--warn-ink)",
                }}
              >
                Ya no tienes esta carta en tu colección; la vendiste o la
                cambiaste después de colocarla. Se queda en la funda hasta que
                tú la quites.
              </p>
            )}

            <div className="mt-5 flex flex-col gap-2">
              <Accion
                onClick={con(onVer)}
                disabled={guardando}
                titulo="Ver la carta"
                detalle="Abre la ficha con todos sus datos"
                icono={
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    className="h-4 w-4"
                  >
                    <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" />
                    <circle cx="12" cy="12" r="2.6" />
                  </svg>
                }
              />
              <Accion
                onClick={con(onCambiar)}
                disabled={guardando}
                titulo="Cambiar la carta"
                detalle="Elige otra de tu colección para esta funda"
                icono={
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    className="h-4 w-4"
                  >
                    <path d="M3 8h13l-3.5-3.5M21 16H8l3.5 3.5" />
                  </svg>
                }
              />
              <Accion
                onClick={con(onQuitar)}
                disabled={guardando}
                peligro
                titulo="Quitar de la funda"
                detalle="La carta vuelve a la colección; no se pierde"
                icono={
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    className="h-4 w-4"
                  >
                    <path d="M5 12h14" />
                  </svg>
                }
              />
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
