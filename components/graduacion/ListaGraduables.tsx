"use client";

// components/graduacion/ListaGraduables.tsx
//
// La lista de la que se elige QUÉ mandar a graduar y CUÁNTAS copias de cada
// carta. Es la mitad aburrida de la pantalla y la que más se usa, así que manda
// la densidad: nombre, valor, copias libres, precio de esa carta hoy y un
// contador con dos botones de 44px.
//
// ============================================================================
// TRES DECISIONES QUE PARECEN ARBITRARIAS Y NO LO SON
// ============================================================================
//
// 1. SE ORDENA POR VALOR DESCENDENTE DE SALIDA. Quien entra aquí no viene a
//    graduar una Common: viene a por su carta cara. Ordenar por nombre dejaría
//    lo que la gente busca en la página cuatro.
//
// 2. NO SE PINTAN LAS 300 FILAS. Una colección madura tiene cientos de cartas
//    con copias libres y cada fila monta una miniatura con su descarga. Se
//    pintan de TANDA en TANDA (`visibles`) con un botón de "ver más", que es lo
//    mismo que hace la colección con su paginación pero sin perder la selección
//    ya hecha al cambiar de página — aquí eso importa, porque la selección es
//    justo lo que se está construyendo.
//
// 3. EL PRECIO DE CADA FILA DEPENDE DEL ENVÍO ENTERO. `costeDeGraduar` recibe
//    el TOTAL de copias de la tacada, no las de esa carta: el descuento por
//    volumen se calcula sobre el conjunto (así lo cobra graduarCartasAction).
//    Por eso al añadir la quinta copia bajan de precio TODAS las filas a la vez.
//    Es el efecto que se quiere enseñar, no un fallo de pintado.

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import PokemonCard from "../PokemonCard";
import { costeDeGraduar } from "../../utils/graduacion";
import { formatNumber } from "../../utils/format";
import { useHaptics } from "../../hooks/useHaptics";
import type { CartaGraduable } from "./Comun";

interface Props {
  cartas: CartaGraduable[];
  /** cardId -> copias elegidas. Sólo entran las que tienen alguna. */
  seleccion: Record<string, number>;
  /** Fija (no suma) las copias de una carta. El padre acota contra el tope. */
  onFijar: (cardId: string, copias: number) => void;
  /** Copias ya elegidas en total, para calcular el precio con descuento. */
  totalCopias: number;
  /** Copias que aún caben en la tacada. Cero significa tope alcanzado. */
  hueco: number;
  /** Deshabilita los controles mientras hay un envío en vuelo. */
  bloqueado: boolean;
}

/** Cuántas filas se añaden cada vez que se pide "ver más". */
const TANDA = 24;

type Orden = "valor_desc" | "libres_desc" | "nombre_asc";

export default function ListaGraduables({
  cartas,
  seleccion,
  onFijar,
  totalCopias,
  hueco,
  bloqueado,
}: Props) {
  const [busqueda, setBusqueda] = useState("");
  const [orden, setOrden] = useState<Orden>("valor_desc");
  const [visibles, setVisibles] = useState(TANDA);
  const haptic = useHaptics();

  const filtradas = useMemo(() => {
    const texto = busqueda.trim().toLowerCase();
    const lista = texto
      ? cartas.filter((c) => c.name.toLowerCase().includes(texto))
      : [...cartas];

    lista.sort((a, b) => {
      // Lo ya elegido sube al principio pase lo que pase con el orden: si no,
      // buscar una carta nueva esconde lo que llevas seleccionado y da la
      // sensación de que se ha perdido.
      const ea = seleccion[a.id] ? 1 : 0;
      const eb = seleccion[b.id] ? 1 : 0;
      if (ea !== eb) return eb - ea;
      switch (orden) {
        case "libres_desc":
          return b.libres - a.libres || b.valor - a.valor;
        case "nombre_asc":
          return a.name.localeCompare(b.name, "es");
        default:
          return b.valor - a.valor || a.name.localeCompare(b.name, "es");
      }
    });
    return lista;
  }, [cartas, busqueda, orden, seleccion]);

  const mostradas = filtradas.slice(0, visibles);

  if (cartas.length === 0) {
    return (
      <div className="surface rounded-2xl py-14 px-6 text-center flex flex-col items-center gap-3">
        <p className="ink font-medium text-sm">No te queda nada por graduar</p>
        <p className="ink-soft text-xs max-w-xs leading-relaxed">
          Todas tus copias tienen ya su nota, o aún no tienes cartas. Abre sobres para conseguir
          copias nuevas: cada una llega con su propia nota esperando.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* BUSCADOR Y ORDEN. Mismo patrón que la barra de la colección: la
          etiqueta envuelve al campo para que tocar el icono enfoque el input. */}
      <div className="flex flex-col sm:flex-row gap-2">
        <label className="input-field flex min-h-11 items-center gap-2 px-3 py-2 rounded-xl flex-1">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 ink-faint shrink-0" aria-hidden="true">
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
            aria-label="Buscar entre tus cartas graduables"
            placeholder="Buscar carta..."
            value={busqueda}
            onChange={(e) => {
              setBusqueda(e.target.value);
              // La tanda se reinicia al filtrar: si no, buscar desde la fila 90
              // dejaría "ver más" pintado sobre una lista de tres resultados.
              setVisibles(TANDA);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="bg-transparent outline-none text-sm flex-1 min-w-0 placeholder:opacity-50 [&::-webkit-search-cancel-button]:hidden"
          />
        </label>
        <select
          value={orden}
          onChange={(e) => {
            haptic("select");
            setOrden(e.target.value as Orden);
          }}
          aria-label="Ordenar las cartas"
          className="input-field w-full sm:w-auto min-w-0 px-3 py-2.5 rounded-xl text-xs cursor-pointer truncate"
        >
          <option value="valor_desc">Las más valiosas</option>
          <option value="libres_desc">Las que más copias tengo</option>
          <option value="nombre_asc">Por nombre</option>
        </select>
      </div>

      {filtradas.length === 0 && (
        <p className="ink-soft text-xs text-center py-8">
          Ninguna carta con copias libres se llama así.
        </p>
      )}

      <ul className="flex flex-col gap-2.5">
        {mostradas.map((carta, i) => {
          const elegidas = seleccion[carta.id] ?? 0;
          // Con descuento: es lo que se va a cobrar de verdad por esta copia si
          // el envío se manda tal y como está ahora mismo.
          const precio = costeDeGraduar(carta.valor, totalCopias);
          const sinDescuento = carta.coste;
          const rebajada = precio < sinDescuento;
          // El tope es del envío entero, así que una carta con diez copias
          // libres puede quedarse sin poder subir porque otras llenaron la caja.
          const puedeSubir = !bloqueado && elegidas < carta.libres && hueco > 0;

          return (
            <motion.li
              key={carta.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              // Tope al retardo, como en el resumen del sobre: sin él la fila
              // veinticuatro no aparecería hasta pasado un segundo largo.
              transition={{ duration: 0.28, delay: Math.min(i, 10) * 0.025 }}
              className="surface rounded-2xl p-3 flex flex-wrap items-center gap-3"
              style={
                elegidas > 0
                  ? { borderColor: "color-mix(in srgb, var(--accent) 45%, transparent)" }
                  : undefined
              }
            >
              {/* La miniatura va por PokemonCard con interactive={false} y
                  reveal: es el camino rápido, una imagen dentro de un marco, sin
                  motion values ni capa compositada. */}
              <div className="w-14 shrink-0">
                <PokemonCard card={carta} reveal interactive={false} />
              </div>

              <div className="flex-1 min-w-[7.5rem]">
                <p className="text-sm font-semibold truncate">{carta.name}</p>
                <p className="text-[11px] ink-soft truncate">
                  {carta.rarity} · vale {formatNumber(carta.valor)}
                </p>
                <p className="text-[11px] ink-faint tnum mt-0.5">
                  {formatNumber(carta.libres)} {carta.libres === 1 ? "copia libre" : "copias libres"}
                  {carta.graduadas > 0 && ` · ${formatNumber(carta.graduadas)} ya en la vitrina`}
                </p>
              </div>

              <div className="flex items-center gap-2 ml-auto">
                <div className="text-right">
                  <p className="text-[10px] ink-faint uppercase tracking-[0.12em]">Por copia</p>
                  <p className="text-sm font-semibold tnum" style={rebajada ? { color: "var(--ok)" } : undefined}>
                    {formatNumber(precio)}
                  </p>
                  {rebajada && (
                    // El precio de tarifa tachado al lado del rebajado es la
                    // forma más corta de enseñar que el descuento existe sin
                    // tener que explicarlo en cada fila.
                    <p className="text-[10px] ink-faint tnum line-through">
                      {formatNumber(sinDescuento)}
                    </p>
                  )}
                </div>

                <div
                  role="group"
                  aria-label={`Copias de ${carta.name} a graduar`}
                  className="flex items-center gap-1"
                >
                  <button
                    type="button"
                    onClick={() => {
                      haptic("tap");
                      onFijar(carta.id, elegidas - 1);
                    }}
                    disabled={bloqueado || elegidas === 0}
                    aria-label={`Quitar una copia de ${carta.name}`}
                    className="btn-ghost press touch-target w-11 h-11 rounded-xl flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="w-4 h-4" aria-hidden="true">
                      <path d="M5 12h14" />
                    </svg>
                  </button>
                  <span className="w-7 text-center text-sm font-bold tnum" aria-hidden="true">
                    {elegidas}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      haptic("tap");
                      onFijar(carta.id, elegidas + 1);
                    }}
                    disabled={!puedeSubir}
                    aria-label={`Añadir una copia de ${carta.name}`}
                    className="btn-ghost press touch-target w-11 h-11 rounded-xl flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="w-4 h-4" aria-hidden="true">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Atajo para las repetidas de verdad: con nueve copias libres,
                  llegar a nueve a base de toques es un castigo. */}
              {carta.libres > 1 && (
                <button
                  type="button"
                  onClick={() => {
                    haptic("select");
                    onFijar(carta.id, Math.min(carta.libres, elegidas + hueco));
                  }}
                  disabled={!puedeSubir}
                  className="chip ink-soft text-[11px] px-3 py-1.5 press disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Todas las que quepan
                </button>
              )}
            </motion.li>
          );
        })}
      </ul>

      {visibles < filtradas.length && (
        <button
          type="button"
          onClick={() => {
            haptic("tap");
            setVisibles((v) => v + TANDA);
          }}
          className="btn-ghost press touch-target w-full rounded-xl text-xs font-medium py-3"
        >
          Ver {formatNumber(Math.min(TANDA, filtradas.length - visibles))} cartas más ·{" "}
          {formatNumber(filtradas.length - visibles)} sin mostrar
        </button>
      )}
    </div>
  );
}
