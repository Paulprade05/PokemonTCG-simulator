"use client";

import { useMemo, useState } from "react";
import PokemonCard from "../PokemonCard";
import Sheet from "../ui/Sheet";
import { useHaptics } from "../../hooks/useHaptics";
import { formatNumber } from "../../utils/format";
import { setDeCarta, type Destino } from "./modelo";
import type { CartaEnColeccion, Expansion } from "../../utils/tipos";

/**
 * EL SELECTOR: qué carta va en esta funda.
 *
 * Se abre al tocar una funda vacía (o al pedir "cambiar" en una ocupada) y es
 * la mitad del encargo: sin él el archivador se quedaría vacío para siempre.
 *
 * ---------------------------------------------------------------------------
 * TRES COSAS QUE NO SON EVIDENTES
 *
 * 1. NO SE OFRECE LO QUE VA A FALLAR. La misma carta puede ir en varias fundas
 *    —quien tiene tres Pikachu puede enseñar los tres— pero nunca más veces
 *    que copias tenga. El servidor lo comprueba DENTRO de la sentencia y
 *    responde `sin-copias-libres` (ver `ponerEnRanura` en app/action.ts); aquí
 *    se repite la misma cuenta con el único fin de no enseñar un botón que
 *    sólo puede acabar en un error. La cuenta descuenta la funda que se está
 *    editando, igual que la CTE `puestas` del servidor: sustituir una carta por
 *    sí misma no consume una copia más.
 *
 * 2. NADA DE `press` NI DE `scale` SOBRE LAS CARTAS. Es la regla de toda la
 *    vitrina y aquí vuelve a aplicar: un ancestro con `transform: scale` manda
 *    la ilustración a una capa compositada y en iPhone se ve borrosa
 *    (components/PokemonCard.tsx:140-163). El realce es el borde, exactamente
 *    como en components/bazar/PublicarSheet.tsx, que resuelve este mismo
 *    problema para el bazar.
 *    Con una excepción que no es nuestra y conviene no "arreglar" por sorpresa:
 *    el panel de components/ui/Sheet.tsx lleva la clase `.glass`, que sí tiene
 *    `backdrop-filter`. Es el mismo trato que ya acepta PublicarSheet y aquí
 *    compensa por dónde ocurre: el selector es una pantalla de paso de unos
 *    segundos, no el reposo del archivador, que es donde la nitidez se juzga.
 *
 * 3. HAY UN TOPE DE CARTAS PINTADAS. Una colección madura son cientos de filas
 *    y cada una es una ilustración remota; montarlas todas de golpe dentro de
 *    una hoja es la trampa que la colección resuelve paginando de 24 en 24.
 *    Aquí se pinta por tandas y se conserva el orden que trae la colección
 *    (favoritas, rareza, nombre), que es el que el jugador ya conoce de
 *    /collection: la carta que quiere enseñar en su vitrina suele estar arriba.
 */

/** Cartas por tanda. Una tanda llena unas cuatro pantallas de la hoja. */
const TANDA = 36;

interface SelectorCartaProps {
  /** La funda que se está rellenando; `null` cierra la hoja. */
  destino: Destino | null;
  onCerrar: () => void;
  /** La colección del jugador, en el orden en que llega. */
  cartas: CartaEnColeccion[];
  /** Expansiones, para el filtro. Se listan sólo las que tengan algo. */
  sets: Expansion[];
  /** cardId → en cuántas fundas está YA (contando todas, esta incluida). */
  colocadas: Map<string, number>;
  /** Carta que ocupa ahora la funda, si se está cambiando. */
  actual: string | null;
  /** Hay una escritura en vuelo: no se puede elegir otra. */
  guardando: boolean;
  onElegir: (carta: CartaEnColeccion) => void;
}

export default function SelectorCarta({
  destino,
  onCerrar,
  cartas,
  sets,
  colocadas,
  actual,
  guardando,
  onElegir,
}: SelectorCartaProps) {
  const haptic = useHaptics();
  const [busqueda, setBusqueda] = useState("");
  const [filtroSet, setFiltroSet] = useState("todas");
  const [tope, setTope] = useState(TANDA);

  const abierto = destino !== null;

  /* EL FILTRO Y LA BÚSQUEDA SOBREVIVEN DE UNA FUNDA A LA SIGUIENTE, y es
   * deliberado. Una hoja se monta casi siempre con cartas de la misma
   * expansión, así que reiniciar el desplegable en cada funda obligaría a
   * repetir nueve veces el mismo filtro para montar una sola hoja. No es
   * estado escondido —el buscador y el desplegable están a la vista, con lo
   * que se escribió dentro— que es la única condición bajo la que conservar
   * algo así no confunde. */

  /** Cuántas cartas distintas hay de cada expansión. */
  const conteoPorSet = useMemo(() => {
    const mapa = new Map<string, number>();
    for (const c of cartas) {
      const sid = setDeCarta(c.id);
      if (!sid) continue;
      mapa.set(sid, (mapa.get(sid) ?? 0) + 1);
    }
    return mapa;
  }, [cartas]);

  /**
   * El desplegable sólo lista expansiones EN LAS QUE HAY ALGO. Con la base
   * sincronizada por el cron son más de ciento cincuenta sets, y ofrecer
   * ciento cuarenta expansiones vacías no es filtrar, es un catálogo. El orden
   * es el que trae getSetsFromDB (lanzamiento descendente), que es el que ya
   * conoce el jugador de la pantalla de colección.
   */
  const opcionesSet = useMemo(
    () => sets.filter((s) => (conteoPorSet.get(s.id) ?? 0) > 0),
    [sets, conteoPorSet],
  );

  const filtradas = useMemo(() => {
    const texto = busqueda.trim().toLowerCase();
    return cartas.filter((c) => {
      // Con el guion: los ids son `set-numero` y sin él "sv8" se llevaría
      // también las de "sv8pt5" (y "swsh1" las de swsh10/11/12).
      if (filtroSet !== "todas" && !c.id.startsWith(filtroSet + "-")) {
        return false;
      }
      if (texto && !c.name.toLowerCase().includes(texto)) return false;
      return true;
    });
  }, [cartas, filtroSet, busqueda]);

  const visibles = filtradas.slice(0, tope);

  /**
   * Copias que quedan libres de una carta.
   *
   * Negativo o cero significa que ya está toda colocada. El `-1` cuando la
   * carta es la que ocupa ESTA funda es el equivalente exacto del
   * `AND NOT (hoja = ... AND ranura = ...)` de la consulta del servidor.
   */
  const libresDe = (c: CartaEnColeccion) =>
    c.quantity - ((colocadas.get(c.id) ?? 0) - (c.id === actual ? 1 : 0));

  const rotulo = destino
    ? `Hoja ${destino.hoja + 1}, funda ${destino.ranura + 1}`
    : "";

  return (
    <Sheet
      open={abierto}
      onClose={onCerrar}
      label={actual ? "Cambiar la carta de la funda" : "Colocar una carta"}
    >
      <div className="px-4 pt-1 pb-6 sm:px-5">
        <h2 className="ink text-center text-[17px] font-semibold">
          {actual ? "Cambiar la carta" : "Colocar una carta"}
        </h2>
        {/* Mientras se escribe, el rótulo lo dice: la hoja no se cierra hasta
            que la acción confirma, y sin este aviso ese momento se lee como
            que el toque no ha hecho nada. */}
        <p
          aria-live="polite"
          className="ink-soft mt-1.5 text-center text-[12px] leading-relaxed"
        >
          {guardando ? (
            <span style={{ color: "var(--ok)" }}>Colocando la carta…</span>
          ) : (
            <>
              {rotulo}
              {" · "}
              {cartas.length === 0
                ? "todavía no tienes cartas"
                : "elige de tu colección"}
            </>
          )}
        </p>

        {/* SIN CARTAS: el archivador no se puede montar sin colección, y decir
            sólo "no hay resultados" dejaría al jugador buscando un filtro que
            no existe. */}
        {cartas.length === 0 ? (
          <p className="ink-soft py-12 text-center text-[12px] leading-relaxed">
            Tu colección está vacía. Abre un sobre y vuelve: las cartas que
            consigas podrán colocarse en cualquier funda.
          </p>
        ) : (
          <>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              {/* Etiqueta y no contenedor neutro: así tocar el icono o el
                  relleno enfoca el campo. min-h-11 son los 44px de zona
                  táctil mínima. */}
              <label className="input-field flex min-h-11 flex-1 items-center gap-2 rounded-xl px-3 py-2">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="ink-faint h-4 w-4 shrink-0"
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <input
                  type="search"
                  inputMode="search"
                  enterKeyHint="search"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-label="Buscar entre tus cartas"
                  placeholder="Buscar una carta…"
                  value={busqueda}
                  onChange={(e) => {
                    setBusqueda(e.target.value);
                    // Cada búsqueda empieza por su primera tanda: sin esto,
                    // buscar tras haber pedido tres tandas pintaría 108 cartas
                    // de golpe dentro de la hoja.
                    setTope(TANDA);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:opacity-50 [&::-webkit-search-cancel-button]:hidden"
                />
              </label>

              <select
                value={filtroSet}
                onChange={(e) => {
                  haptic("select");
                  setFiltroSet(e.target.value);
                  setTope(TANDA);
                }}
                aria-label="Filtrar por expansión"
                className="input-field w-full min-w-0 cursor-pointer truncate rounded-xl px-3 py-2.5 text-xs sm:w-auto sm:max-w-[45%]"
              >
                <option value="todas">
                  Todas · {formatNumber(cartas.length)}
                </option>
                {opcionesSet.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {formatNumber(conteoPorSet.get(s.id) ?? 0)}
                  </option>
                ))}
              </select>
            </div>

            {filtradas.length === 0 ? (
              <p className="ink-soft py-12 text-center text-[12px] leading-relaxed">
                Ninguna de tus cartas encaja con esa búsqueda.
              </p>
            ) : (
              <>
                <div className="mt-4 grid grid-cols-3 gap-2.5 sm:grid-cols-4">
                  {visibles.map((c) => {
                    const puestas = colocadas.get(c.id) ?? 0;
                    const libres = libresDe(c);
                    const agotada = libres <= 0;
                    const esLaDeAhora = c.id === actual;

                    return (
                      <button
                        key={c.id}
                        type="button"
                        disabled={agotada || guardando}
                        onClick={() => {
                          haptic("select");
                          onElegir(c);
                        }}
                        aria-label={
                          agotada
                            ? `${c.name}: ya tienes tus ${c.quantity} copias colocadas`
                            : `Colocar ${c.name} en ${rotulo.toLowerCase()}`
                        }
                        /* El realce es un borde. Ver el punto 2 de la
                           cabecera: nada que escale por encima de una carta. */
                        className="rounded-2xl border border-transparent p-1.5 text-left transition-colors enabled:hover:border-[var(--border-strong)] disabled:cursor-not-allowed"
                      >
                        <div className="relative">
                          <PokemonCard card={c} reveal interactive={false} />

                          {/* El velo de "agotada" es un ELEMENTO encima, no un
                              `opacity` en el contenedor: bajarle la opacidad a
                              un ancestro de la ilustración crea contexto de
                              apilamiento y nos devuelve al problema de la capa
                              compositada. */}
                          {agotada && (
                            <div
                              aria-hidden="true"
                              className="pointer-events-none absolute inset-0 rounded-[4.5%]"
                              style={{
                                background:
                                  "color-mix(in srgb, var(--surface) 62%, transparent)",
                              }}
                            />
                          )}

                          {esLaDeAhora && (
                            <span
                              aria-hidden="true"
                              className="absolute left-1 top-1 z-10 rounded-full px-1.5 py-0.5 text-[9px] font-bold leading-none"
                              style={{
                                background: "var(--ok-weak)",
                                color: "var(--ok)",
                                border: "1px solid var(--border-strong)",
                              }}
                            >
                              aquí
                            </span>
                          )}
                        </div>

                        <p className="ink mt-1.5 truncate text-[11px] font-medium">
                          {c.name}
                        </p>
                        <p
                          className="tnum truncate text-[10px]"
                          style={{
                            color: agotada
                              ? "var(--warn-ink)"
                              : "var(--ink-faint)",
                          }}
                        >
                          {agotada
                            ? "toda colocada"
                            : puestas > 0
                              ? `${puestas} de ${c.quantity} colocadas`
                              : `${c.quantity} ${c.quantity === 1 ? "copia" : "copias"}`}
                        </p>
                      </button>
                    );
                  })}
                </div>

                {filtradas.length > visibles.length && (
                  <button
                    type="button"
                    onClick={() => {
                      haptic("tap");
                      setTope((t) => t + TANDA);
                    }}
                    className="btn-ghost press touch-target mx-auto mt-4 block rounded-xl px-5 py-2.5 text-[12px] font-medium"
                  >
                    Ver más ({formatNumber(filtradas.length - visibles.length)}{" "}
                    restantes)
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
