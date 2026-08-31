"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Sheet from "../ui/Sheet";
import PokemonCard from "../PokemonCard";
import NotaGraduada from "./NotaGraduada";
import ReglasBazar from "./ReglasBazar";
import {
  getCartasGraduables,
  getVitrina,
  publicarEnBazarAction,
} from "../../app/action";
import {
  COMISION,
  bandaDePrecio,
  comisionDe,
  pagoAlVendedor,
} from "../../utils/bazar";
import { copiasEntregables } from "../../utils/mercado";
import { formatNumber } from "../../utils/format";
import { useHaptics } from "../../hooks/useHaptics";
import { useToast } from "../ui/Toast";
import type { Publicable } from "./tipos";

/* ==================================================================== *
 * PUBLICAR EN EL BAZAR
 * ====================================================================
 *
 * DE DÓNDE SALE EL VALOR DE LA CARTA, QUE ES LA DECISIÓN IMPORTANTE DE ESTE
 * FICHERO.
 *
 * El servidor no acepta cualquier precio: exige que caiga entre el 50 % y el
 * 150 % del VALOR de la carta, y ese valor lo calcula él con
 * `precioDeCartaSuelta(rareza, euros)` — la tarifa por rareza AJUSTADA con el
 * precio real de Cardmarket de esa carta concreta, que vive en otra tabla y que
 * refresca un cron (services/preciosBD.ts).
 *
 * Esa segunda mitad, los euros, el navegador NO LA TIENE. `getFullCollection`
 * devuelve las columnas de `cards` y ahí no hay precio en euros. Si la banda se
 * calculara aquí sólo con la rareza, saldría una banda MÁS BAJA que la de
 * verdad (el ajuste sólo suma: hasta +27 % medido en la carta más cara de sv08,
 * ver utils/constanst.ts:330-348), y el extremo inferior del deslizador caería
 * por debajo del mínimo real. O sea: la pantalla ofrecería un precio que el
 * servidor rechaza. Justo lo que no puede pasar, porque toda la gracia de este
 * diseño es que las reglas se vean ANTES y no en un mensaje de error.
 *
 * POR ESO EL CATÁLOGO SE PIDE A `getCartasGraduables()` Y NO A
 * `getFullCollection()`. No es la acción "de graduar": es la única que devuelve,
 * por carta, el `valor` YA CALCULADO POR EL SERVIDOR con el mismo
 * `precioDeCartaSuelta(rareza, euros)` que usará `publicarEnBazarAction` para
 * validar (app/action.ts:3120 y 3604). Con ella, la banda que se pinta y la que
 * comprueba el servidor son la misma por construcción. De regalo trae una
 * proyección ligera (id, nombre, rareza, imagen, cantidades) en vez de la
 * colección entera con ataques y debilidades, y ya excluye las cartas cuyas
 * copias están todas graduadas, que no se pueden publicar sueltas.
 *
 * Las graduadas salen de `getVitrina()`, que devuelve el valor YA multiplicado
 * por la nota — que es también el que usa el servidor para su banda cuando se
 * publica con `gradedId` (app/action.ts:3617). Si algún día alguna de las dos
 * acciones deja de devolver `valor`, esta pantalla tiene que dejar de pintar la
 * banda, no adivinarla.
 *
 * LO QUE SÍ SE COMPRUEBA DOS VECES, y está bien que así sea: el servidor vuelve
 * a validar precio, copias y antigüedad. Esto es una interfaz honesta, no una
 * autorización.
 */

/** Lo que devuelve `getCartasGraduables` por carta (llega tipado `any`). */
interface CartaGraduableCruda {
  id: string;
  name: string;
  rarity: string;
  images: { small: string; large: string };
  cantidad: number;
  graduadas: number;
  libres: number;
  valor: number;
}

/** Lo que devuelve `getVitrina` por copia graduada (llega tipado `any`). */
interface CopiaVitrinaCruda {
  gradedId: number;
  id: string;
  name: string;
  rarity: string;
  images: { small: string; large: string };
  nota: number;
  etiqueta: string;
  valor: number;
  copiasTotales: number;
}

/**
 * Tope de cartas pintadas en el selector.
 *
 * Una colección madura son miles de filas y cada una es una ilustración remota:
 * montarlas todas de golpe dentro de una hoja es la misma trampa que la
 * colección resuelve paginando de 24 en 24. Aquí se ordena por valor —quien
 * vende busca su carta cara, no la número 1.800— y el buscador hace el resto.
 */
const MAX_EN_LISTA = 36;

const ERRORES_PUBLICAR: Record<string, string> = {
  "demasiados-anuncios":
    "Ya tienes el máximo de anuncios abiertos. Retira alguno para publicar otro.",
  // Cubre los dos motivos reales: no queda copia libre, o esa copia graduada ya
  // está en otro anuncio (lo impide un índice único en bazar_listings).
  "sin-copias":
    "Ya no te sobra ninguna copia de esa carta, o esa copia graduada ya está publicada.",
  "no-existe": "Esa carta ya no está en tu colección.",
  "sin-valor": "Esa carta no tiene valor de referencia, así que no se puede publicar.",
  "no-autorizado": "Inicia sesión para vender en el bazar.",
  peticion: "Esa publicación no es válida.",
  servidor: "No se pudo publicar. Inténtalo de nuevo.",
};

interface PublicarSheetProps {
  open: boolean;
  onClose: () => void;
  /**
   * Anuncios activos por id de carta. El servidor exige
   * `copias > anuncios_activos_de_esa_carta + 1` (la copia reservada del
   * álbum), así que sin esta cuenta el selector ofrecería copias ya
   * comprometidas y la publicación fallaría con "sin-copias".
   */
  activasPorCarta: Map<string, number>;
  /** Sobres abiertos, para contar la tercera regla con su número. */
  sobresAbiertos: number | null;
  /** Anuncios abiertos ahora mismo, para el aviso del tope. */
  anunciosAbiertos: number;
  /** Publicación conseguida: el padre recarga listas y cierra. */
  onPublicada: () => void;
  /** El servidor ha dicho que aún es novato: el padre apaga el botón. */
  onNovato: (faltan: number) => void;
}

export default function PublicarSheet({
  open,
  onClose,
  activasPorCarta,
  sobresAbiertos,
  anunciosAbiertos,
  onPublicada,
  onNovato,
}: PublicarSheetProps) {
  const toast = useToast();
  const haptic = useHaptics();

  const [estado, setEstado] = useState<"cargando" | "listo" | "error">("cargando");
  const [sueltasCrudas, setSueltasCrudas] = useState<CartaGraduableCruda[]>([]);
  const [vitrinaCruda, setVitrinaCruda] = useState<CopiaVitrinaCruda[]>([]);
  const [pestana, setPestana] = useState<"sueltas" | "graduadas">("sueltas");
  const [busqueda, setBusqueda] = useState("");
  const [elegida, setElegida] = useState<Publicable | null>(null);
  const [precio, setPrecio] = useState(0);
  const [enviando, setEnviando] = useState(false);
  /** Cerrojo real del envío: setState no se ve hasta el siguiente render. */
  const envioLockRef = useRef(false);

  /**
   * Se recarga en CADA apertura, no una sola vez. Entre una publicación y la
   * siguiente han cambiado las copias libres y los anuncios abiertos; una lista
   * cacheada ofrecería copias que ya no existen. Son dos consultas ligeras y
   * sólo se pagan al abrir la hoja, nunca al entrar en el bazar.
   */
  useEffect(() => {
    if (!open) return;
    let vivo = true;
    setEstado("cargando");
    setElegida(null);
    setBusqueda("");
    (async () => {
      try {
        const [libres, vitrina] = await Promise.all([
          getCartasGraduables(),
          getVitrina(),
        ]);
        if (!vivo) return;
        // Con que falle una de las dos, la hoja no puede prometer una banda
        // correcta: se muestra el error en vez de media pantalla a medias.
        if (!libres.ok || !vitrina.ok) {
          setEstado("error");
          return;
        }
        setSueltasCrudas(libres.cartas as CartaGraduableCruda[]);
        setVitrinaCruda(vitrina.cartas as CopiaVitrinaCruda[]);
        setEstado("listo");
      } catch (e) {
        console.error("Error cargando lo publicable:", e);
        if (vivo) setEstado("error");
      }
    })();
    return () => {
      vivo = false;
    };
  }, [open]);

  /**
   * Copias sueltas publicables.
   *
   * `sobrantes` es el MÍNIMO de dos cuentas distintas y las dos hacen falta:
   *  · `copiasEntregables(cantidad) - activas` es la del servidor (la copia
   *    reservada del álbum más lo que ya está publicado). `copiasEntregables`
   *    es la misma función que usa el mercado; la regla no se reescribe aquí.
   *  · `libres` son las copias que no tienen nota. Una copia graduada está en
   *    la vitrina y no es la que se vende en un anuncio suelto.
   */
  const sueltas = useMemo<Publicable[]>(() => {
    return sueltasCrudas
      .map((c) => {
        const activas = activasPorCarta.get(c.id) ?? 0;
        const sobrantes = Math.min(copiasEntregables(c.cantidad) - activas, c.libres);
        return {
          clave: `suelta:${c.id}`,
          cardId: c.id,
          gradedId: null,
          name: c.name,
          rarity: c.rarity,
          images: c.images,
          nota: null,
          etiqueta: null,
          valor: c.valor,
          copias: c.cantidad,
          sobrantes,
        };
      })
      .filter((p) => p.sobrantes > 0 && p.valor > 0)
      .sort((a, b) => b.valor - a.valor || a.name.localeCompare(b.name));
  }, [sueltasCrudas, activasPorCarta]);

  /**
   * Copias graduadas publicables.
   *
   * DOS FILTROS QUE PARECEN DE MÁS Y NO LO SON:
   *  · `valor > 0`. El multiplicador de la nota 1 es 0,0 (MULTIPLICADOR_NOTA en
   *    utils/graduacion.ts), así que una copia con un 1 vale cero y el servidor
   *    la rechaza con "sin-valor". Ofrecerla sería ofrecer un callejón sin
   *    salida.
   *  · La copia reservada TAMBIÉN aplica a las graduadas: publicar exige que
   *    sobre una copia de esa carta en la colección, esté graduada o no. Con una
   *    sola copia, aunque sea un 10, no se puede vender — la misma promesa que
   *    protege el álbum en venderGraduadaAction.
   */
  const graduadas = useMemo<Publicable[]>(() => {
    return vitrinaCruda
      .map((v) => {
        const activas = activasPorCarta.get(v.id) ?? 0;
        return {
          clave: `graduada:${v.gradedId}`,
          cardId: v.id,
          gradedId: v.gradedId,
          name: v.name,
          rarity: v.rarity,
          images: v.images,
          nota: v.nota,
          etiqueta: v.etiqueta,
          valor: v.valor,
          copias: v.copiasTotales,
          sobrantes: copiasEntregables(v.copiasTotales) - activas,
        };
      })
      .filter((p) => p.sobrantes > 0 && p.valor > 0)
      .sort((a, b) => (b.nota ?? 0) - (a.nota ?? 0) || b.valor - a.valor);
  }, [vitrinaCruda, activasPorCarta]);

  const lista = pestana === "sueltas" ? sueltas : graduadas;
  const filtradas = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return lista;
    return lista.filter((p) => p.name.toLowerCase().includes(q));
  }, [lista, busqueda]);
  const visibles = filtradas.slice(0, MAX_EN_LISTA);

  const banda = elegida ? bandaDePrecio(elegida.valor) : null;
  const comision = comisionDe(precio);
  const cobras = pagoAlVendedor(precio);

  /** Deja el precio dentro de la banda pase lo que pase. */
  const ajustar = (n: number) => {
    if (!banda) return;
    setPrecio(Math.min(banda.max, Math.max(banda.min, Math.round(n))));
  };

  const elegir = (p: Publicable) => {
    haptic("select");
    const b = bandaDePrecio(p.valor);
    // Arranca en el valor de referencia, que siempre cae dentro de su propia
    // banda: es el precio "de mercado" y el punto neutro para moverse.
    setPrecio(Math.min(b.max, Math.max(b.min, p.valor)));
    setElegida(p);
  };

  const publicar = async () => {
    if (!elegida || envioLockRef.current) return;
    envioLockRef.current = true;
    setEnviando(true);
    try {
      const res = await publicarEnBazarAction(elegida.cardId, precio, elegida.gradedId);
      if (!res.ok) {
        haptic("warning");
        if (res.error === "precio") {
          /* El servidor devuelve la banda buena cuando rechaza por precio. Se
           * adopta y se recoloca el deslizador en vez de limitarse a protestar:
           * con el valor que manda `getCartasGraduables` esto no debería pasar
           * nunca, y si pasa (el cron de precios ha corrido entre la carga y el
           * envío) el jugador se encuentra el control ya arreglado. */
          const banda = "banda" in res ? res.banda : null;
          if (banda) {
            setPrecio(Math.min(banda.max, Math.max(banda.min, precio)));
            toast(
              `El precio de esa carta va de ${formatNumber(banda.min)} a ${formatNumber(banda.max)}. Ajustado.`,
              "info",
            );
          } else {
            toast("Ese precio no vale para esa carta.", "error");
          }
          return;
        }
        if (res.error === "novato") {
          // Con número, no con un "todavía no puedes": lo que el jugador
          // necesita saber es cuánto le queda.
          onNovato(res.faltan);
          toast(
            `Te faltan ${res.faltan} ${res.faltan === 1 ? "sobre" : "sobres"} para poder vender.`,
            "error",
          );
          return;
        }
        toast(ERRORES_PUBLICAR[res.error] ?? "No se pudo publicar.", "error");
        return;
      }
      haptic("success");
      // Las DOS cifras, también al confirmar: el precio a secas volvería a
      // esconder la comisión justo en el momento en que se cierra el trato.
      toast(
        `Publicada por ${formatNumber(res.precio)} · cobrarás ${formatNumber(res.cobrarias)}`,
        "success",
      );
      onPublicada();
    } catch (e) {
      console.error("Error publicando en el bazar:", e);
      toast("No se pudo publicar. Revisa tu conexión.", "error");
    } finally {
      envioLockRef.current = false;
      setEnviando(false);
    }
  };

  const porcentajeLleno =
    banda && banda.max > banda.min
      ? ((precio - banda.min) / (banda.max - banda.min)) * 100
      : 100;

  return (
    <Sheet open={open} onClose={onClose} label="Publicar una carta en el bazar">
      <div className="px-5 pt-1 pb-6">
        {/* ── PASO 1: QUÉ VENDO ─────────────────────────────────────────── */}
        {!elegida && (
          <>
            <h2 className="ink text-center text-[17px] font-semibold">
              Publicar una carta
            </h2>
            <p className="ink-soft mt-1.5 text-center text-[12px] leading-relaxed">
              Sólo salen las copias que te sobran: de cada carta se queda siempre
              una en tu álbum.
            </p>

            <div className="mt-4 flex gap-2">
              {(["sueltas", "graduadas"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    haptic("tap");
                    setPestana(p);
                  }}
                  aria-pressed={pestana === p}
                  className={`press touch-target flex-1 rounded-xl text-[12px] font-semibold ${
                    pestana === p ? "btn-primary" : "btn-ghost ink-soft"
                  }`}
                >
                  {p === "sueltas"
                    ? `Sueltas · ${sueltas.length}`
                    : `Graduadas · ${graduadas.length}`}
                </button>
              ))}
            </div>

            <label className="input-field mt-3 flex min-h-11 items-center gap-2 rounded-xl px-3 py-2">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ink-faint h-4 w-4 shrink-0" aria-hidden="true">
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
                onChange={(e) => setBusqueda(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:opacity-50 [&::-webkit-search-cancel-button]:hidden"
              />
            </label>

            <div className="mt-4">
              {estado === "cargando" && (
                <p className="ink-faint py-10 text-center text-[12px]">
                  Buscando lo que puedes vender…
                </p>
              )}

              {estado === "error" && (
                <p className="ink-soft py-10 text-center text-[12px] leading-relaxed">
                  No se pudo leer tu colección, así que no se puede calcular el
                  precio permitido. Cierra y vuelve a abrir.
                </p>
              )}

              {estado === "listo" && filtradas.length === 0 && (
                <p className="ink-soft py-10 text-center text-[12px] leading-relaxed">
                  {busqueda.trim()
                    ? "Ninguna de tus cartas publicables se llama así."
                    : pestana === "sueltas"
                      ? "No te sobra ninguna copia. Hace falta tener dos o más de una carta para poder vender una."
                      : "No tienes cartas graduadas con una copia de sobra."}
                </p>
              )}

              {estado === "listo" && filtradas.length > 0 && (
                <>
                  <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
                    {visibles.map((p) => (
                      // Sin `press`: esa clase escala el elemento y aquí dentro
                      // hay una ilustración. Un ancestro con `transform: scale`
                      // la manda a una capa compositada y se ve borrosa en
                      // iPhone (components/PokemonCard.tsx:140-163). El realce
                      // es un borde, no un escalado.
                      <button
                        key={p.clave}
                        type="button"
                        onClick={() => elegir(p)}
                        aria-label={`Vender ${p.name}${p.nota !== null ? `, nota ${p.nota}` : ""}, valor ${p.valor} monedas`}
                        className="rounded-2xl border border-transparent p-1.5 text-left transition-colors hover:border-[var(--border-strong)]"
                      >
                        <div className="relative">
                          {p.nota !== null && (
                            <div className="absolute top-1 left-1 z-20">
                              <NotaGraduada nota={p.nota} etiqueta={p.etiqueta} />
                            </div>
                          )}
                          <PokemonCard
                            card={{
                              id: p.cardId,
                              name: p.name,
                              rarity: p.rarity,
                              images: p.images,
                            }}
                            reveal
                            interactive={false}
                          />
                        </div>
                        <p className="ink mt-1.5 truncate text-[11px] font-medium">
                          {p.name}
                        </p>
                        <p className="ink-faint tnum truncate text-[10px]">
                          vale {formatNumber(p.valor)} · te sobran {p.sobrantes}
                        </p>
                      </button>
                    ))}
                  </div>
                  {filtradas.length > visibles.length && (
                    <p className="ink-faint mt-3 text-center text-[11px]">
                      Se muestran {MAX_EN_LISTA} de{" "}
                      {formatNumber(filtradas.length)}
                      {pestana === "sueltas"
                        ? ", las de más valor"
                        : ", las de mejor nota"}
                      . Busca por nombre para ver el resto.
                    </p>
                  )}
                </>
              )}
            </div>

            {/* Las tres reglas, en la misma pantalla en la que se elige y ANTES
                de tocar el precio. No es un pie de página decorativo: es lo que
                impide que la primera noticia de la comisión llegue en un toast
                de error. */}
            <div
              className="mt-6 pt-5"
              style={{ borderTop: "1px solid var(--border)" }}
            >
              <ReglasBazar
                detallado
                sobresAbiertos={sobresAbiertos}
                anunciosAbiertos={anunciosAbiertos}
              />
            </div>
          </>
        )}

        {/* ── PASO 2: A CUÁNTO ──────────────────────────────────────────── */}
        {elegida && banda && (
          <>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  haptic("tap");
                  setElegida(null);
                }}
                disabled={enviando}
                aria-label="Elegir otra carta"
                className="btn-ghost press touch-target flex h-11 w-11 shrink-0 items-center justify-center rounded-xl disabled:opacity-40"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
                  <path d="m15 18-6-6 6-6" />
                </svg>
              </button>
              <h2 className="ink flex-1 text-center text-[17px] font-semibold">
                Ponle precio
              </h2>
              {/* Hueco simétrico al botón de volver para que el título quede
                  centrado de verdad. */}
              <div className="h-11 w-11 shrink-0" aria-hidden="true" />
            </div>

            <div className="mt-4 flex items-center gap-3.5">
              <div className="w-[86px] shrink-0">
                <PokemonCard
                  card={{
                    id: elegida.cardId,
                    name: elegida.name,
                    rarity: elegida.rarity,
                    images: elegida.images,
                  }}
                  reveal
                  interactive={false}
                />
              </div>
              <div className="min-w-0">
                <p className="ink text-[15px] leading-tight font-semibold">
                  {elegida.name}
                </p>
                <p className="ink-faint mt-0.5 text-[11px]">{elegida.rarity}</p>
                {elegida.nota !== null && (
                  <div className="mt-1.5">
                    <NotaGraduada
                      nota={elegida.nota}
                      etiqueta={elegida.etiqueta}
                      variante="linea"
                    />
                  </div>
                )}
                <p className="ink-soft mt-2 text-[11px] leading-relaxed">
                  Tienes {elegida.copias}{" "}
                  {elegida.copias === 1 ? "copia" : "copias"} y te{" "}
                  {elegida.sobrantes === 1 ? "sobra" : "sobran"}{" "}
                  {elegida.sobrantes}.
                </p>
              </div>
            </div>

            {/* EL PRECIO. Grande, editable con el deslizador y con los dos
                extremos de la banda siempre a la vista. */}
            <div className="surface-2 mt-5 rounded-2xl px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => ajustar(precio - 1)}
                  disabled={precio <= banda.min}
                  aria-label="Bajar el precio una moneda"
                  className="btn-ghost press touch-target flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-lg leading-none font-semibold disabled:opacity-30"
                >
                  −
                </button>
                <div className="min-w-0 text-center">
                  <p className="ink tnum text-2xl leading-none font-bold">
                    {formatNumber(precio)}
                  </p>
                  <p className="ink-faint mt-1 text-[10px]">
                    monedas que paga el comprador
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => ajustar(precio + 1)}
                  disabled={precio >= banda.max}
                  aria-label="Subir el precio una moneda"
                  className="btn-ghost press touch-target flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-lg leading-none font-semibold disabled:opacity-30"
                >
                  +
                </button>
              </div>

              <input
                type="range"
                min={banda.min}
                max={banda.max}
                step={1}
                value={precio}
                onChange={(e) => ajustar(Number(e.target.value))}
                aria-label="Precio del anuncio"
                aria-valuetext={`${precio} monedas; tú recibirías ${cobras}`}
                disabled={enviando}
                className="bazar-rango mt-3 w-full"
                style={{ "--_lleno": `${porcentajeLleno}%` } as CSSProperties}
              />

              <div className="ink-faint flex items-center justify-between gap-2 text-[10px]">
                <span className="tnum">mín {formatNumber(banda.min)}</span>
                <span className="tnum">
                  vale {formatNumber(elegida.valor)}
                </span>
                <span className="tnum">máx {formatNumber(banda.max)}</span>
              </div>

              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => ajustar(banda.min)}
                  className="btn-ghost press ink-soft flex-1 rounded-xl py-2 text-[11px] font-medium"
                >
                  Al mínimo
                </button>
                <button
                  type="button"
                  onClick={() => ajustar(elegida.valor)}
                  className="btn-ghost press ink-soft flex-1 rounded-xl py-2 text-[11px] font-medium"
                >
                  Lo que vale
                </button>
                <button
                  type="button"
                  onClick={() => ajustar(banda.max)}
                  className="btn-ghost press ink-soft flex-1 rounded-xl py-2 text-[11px] font-medium"
                >
                  Al máximo
                </button>
              </div>
            </div>

            {/* LAS DOS CIFRAS, SIEMPRE JUNTAS. Nunca el precio a secas: lo que
                el vendedor cobra es otra cosa y enterarse después es lo que hace
                que una comisión honesta parezca un timo. */}
            <div className="surface mt-3 flex flex-col gap-2 rounded-2xl px-4 py-3.5">
              <div className="flex items-baseline justify-between gap-2 text-[12px]">
                <span className="ink-soft">El comprador paga</span>
                <span className="tnum ink font-semibold">
                  {formatNumber(precio)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-2 text-[12px]">
                <span className="ink-soft">
                  Comisión del bazar ({Math.round(COMISION * 100)} %)
                </span>
                <span className="tnum ink-soft">−{formatNumber(comision)}</span>
              </div>
              <div
                className="mt-0.5 flex items-baseline justify-between gap-2 pt-2"
                style={{ borderTop: "1px solid var(--border)" }}
              >
                <span className="ink text-[13px] font-semibold">Tú recibes</span>
                <span
                  className="tnum text-lg leading-none font-bold"
                  style={{ color: "var(--ok)" }}
                >
                  {formatNumber(cobras)}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={publicar}
              disabled={enviando}
              aria-busy={enviando}
              className="btn-accent press touch-target mt-4 flex w-full items-center justify-center rounded-2xl py-3.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
            >
              {enviando
                ? "Publicando…"
                : `Publicar por ${formatNumber(precio)} y cobrar ${formatNumber(cobras)}`}
            </button>

            <button
              type="button"
              onClick={onClose}
              disabled={enviando}
              className="btn-ghost press touch-target ink-soft mt-2.5 w-full rounded-2xl py-3.5 text-sm font-medium disabled:opacity-40"
            >
              Cancelar
            </button>
          </>
        )}
      </div>

      {/* Los pseudoelementos de un deslizador no se pueden estilar en línea y
          app/globals.css es de otra pieza: el estilo viaja con la hoja, igual
          que en components/ui/SettingsSheet.tsx.

          `touch-action: none` NO es un adorno. El <body> declara
          `touch-action: pan-x pan-y` (app/globals.css) y esa restricción se
          hereda por intersección hasta aquí: con el desplazamiento horizontal
          permitido, iOS puede quedarse el arrastre del dedo como si fuera un
          scroll y el deslizador no se movería. Apagando los gestos de scroll
          SÓLO sobre el control, el arrastre le llega entero. */}
      <style>{`
        .bazar-rango{
          -webkit-appearance:none; appearance:none;
          height:44px; background:transparent; cursor:pointer;
          touch-action:none;
        }
        .bazar-rango:disabled{ opacity:.4; cursor:default; }
        .bazar-rango::-webkit-slider-runnable-track{
          height:6px; border-radius:999px;
          background:linear-gradient(to right,
            var(--accent) 0%, var(--accent) var(--_lleno),
            color-mix(in srgb, var(--ink) 14%, transparent) var(--_lleno),
            color-mix(in srgb, var(--ink) 14%, transparent) 100%);
        }
        .bazar-rango::-webkit-slider-thumb{
          -webkit-appearance:none; appearance:none;
          width:26px; height:26px; margin-top:-10px; border-radius:999px;
          background:#fff; border:1px solid var(--border-strong);
          box-shadow:0 1px 4px rgba(0,0,0,.3);
        }
        .bazar-rango::-moz-range-track{
          height:6px; border-radius:999px;
          background:color-mix(in srgb, var(--ink) 14%, transparent);
        }
        .bazar-rango::-moz-range-progress{
          height:6px; border-radius:999px; background:var(--accent);
        }
        .bazar-rango::-moz-range-thumb{
          width:26px; height:26px; border-radius:999px;
          background:#fff; border:1px solid var(--border-strong);
          box-shadow:0 1px 4px rgba(0,0,0,.3);
        }
        .bazar-rango:focus-visible{
          outline:2px solid var(--accent); outline-offset:4px; border-radius:999px;
        }
      `}</style>
    </Sheet>
  );
}
