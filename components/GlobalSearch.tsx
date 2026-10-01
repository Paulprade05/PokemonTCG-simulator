"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import { searchCardsInDB } from "../app/action";
import CardDetailModal from "./CardDetailModal";
import Portal from "./ui/Portal";
import { useFondoQuieto } from "../hooks/useBloqueoScroll";
import { useHaptics } from "../hooks/useHaptics";
import { getCollection } from "../utils/storage";
import { IconoAvanzar, IconoLupa, IconoVolver } from "./icons";
import { D, EASE_OUT } from "../utils/motion";

interface Hit {
  id: string;
  name: string;
  images?: { small?: string };
  set?: { id: string; name: string };
  rarity?: string;
  owned?: boolean;
}

const PAGE_SIZE = 10;

/* ==================================================================== *
 * LO QUE SE ENSEÑA CON EL CAMPO VACÍO
 * ====================================================================
 *
 * Aquí había cuatro "ejemplos" y tres no devolvían nada: `name:pikachu
 * subtypes:vmax`, `types:fire hp:[150 TO *]` y `nationalPokedexNumbers:[1 TO
 * 151]` son sintaxis de api.pokemontcg.io, y desde que la búsqueda va contra
 * la base propia (searchCardsInDB) el texto se compara tal cual con el NOMBRE
 * de la carta. Quien copiaba el segundo recibía «Sin resultados.» habiendo
 * cientos de Pikachu. Encima no se podían tocar: había que teclearlos.
 *
 * Ahora son nombres, que es lo único que el buscador entiende, y se tocan. Los
 * cuatro se escriben igual en inglés y en español, así que valen con la app en
 * cualquiera de los dos idiomas.
 */
const SUGERENCIAS = ["Charizard", "Pikachu", "Mewtwo", "Eevee"];

/* Las últimas búsquedas que acabaron en una carta abierta. Se apunta al ABRIR
   un resultado y no al teclear: así no se llena de prefijos a medio escribir
   ("pik", "pika", "pikac") ni de búsquedas que no encontraron nada. */
const CLAVE_RECIENTES = "tcg:busquedas";
const MAX_RECIENTES = 5;
const LARGO_RECIENTE = 40;

/** Lo guardado puede venir de otra versión o estar manipulado: sólo cadenas,
 *  recortadas y sin vacías. */
function leerRecientes(): string[] {
  try {
    const crudo = JSON.parse(localStorage.getItem(CLAVE_RECIENTES) || "[]");
    if (!Array.isArray(crudo)) return [];
    const limpias = crudo
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((x) => x.trim().slice(0, LARGO_RECIENTE));
    // Sin repetidas: cada una es la `key` de su chapa.
    return [...new Set(limpias)].slice(0, MAX_RECIENTES);
  } catch {
    return [];
  }
}

function guardarRecientes(lista: string[]): void {
  try {
    localStorage.setItem(CLAVE_RECIENTES, JSON.stringify(lista));
  } catch {
    /* modo privado o cuota agotada: las recientes son una comodidad, y sin
       ellas el buscador funciona exactamente igual. */
  }
}

export default function GlobalSearch({ variant = "icon" }: { variant?: "icon" | "bar" }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  /** Sube con cada "Reintentar": relanza la MISMA búsqueda sin tocar el texto. */
  const [intento, setIntento] = useState(0);
  const [selected, setSelected] = useState<any | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const haptic = useHaptics();
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { isSignedIn } = useUser();
  const [recientes, setRecientes] = useState<string[]>([]);
  /**
   * Ids que el INVITADO tiene en su colección local. Con sesión, `owned` lo
   * calcula el servidor; sin ella devuelve siempre false, y al invitado le
   * salían veladas como "no la posees" todas las cartas, también las suyas.
   */
  const [localesIds, setLocalesIds] = useState<ReadonlySet<string> | null>(null);
  /**
   * Se vuelve de una ficha en un dispositivo táctil: el campo NO se reenfoca.
   * Reenfocarlo subía el teclado encima de la rejilla de resultados justo
   * cuando el jugador volvía a ella para abrir otra carta. Con ratón o teclado
   * físico sí se reenfoca, que ahí no tapa nada y permite seguir escribiendo.
   */
  const [sinTeclado, setSinTeclado] = useState(false);

  // localStorage sólo dentro de un efecto, y sólo al abrir: lo que haya podido
  // cambiar con el buscador cerrado (un sobre abierto, por ejemplo) se relee.
  useEffect(() => {
    if (!open) return;
    setRecientes(leerRecientes());
    if (isSignedIn) {
      setLocalesIds(null);
      return;
    }
    try {
      setLocalesIds(
        new Set(getCollection().filter((c) => (c.quantity ?? 1) > 0).map((c) => c.id)),
      );
    } catch {
      setLocalesIds(null);
    }
  }, [open, isSignedIn]);

  const laTiene = (c: Hit) => !!c.owned || (localesIds?.has(c.id) ?? false);

  const recordar = (texto: string) => {
    const t = texto.trim().slice(0, LARGO_RECIENTE);
    // Una letra suelta no es una búsqueda que apetezca repetir.
    if (t.length < 2) return;
    const sig = [
      t,
      ...recientes.filter((r) => r.toLowerCase() !== t.toLowerCase()),
    ].slice(0, MAX_RECIENTES);
    setRecientes(sig);
    guardarRecientes(sig);
  };

  const olvidarRecientes = () => {
    haptic("tap");
    setRecientes([]);
    guardarRecientes([]);
  };

  const abrirCarta = (c: Hit) => {
    haptic("select");
    recordar(query);
    setSinTeclado(window.matchMedia("(pointer: coarse)").matches);
    // `owned` viaja ya resuelto: la ficha vela la carta si es false, y el
    // invitado vería velada una carta que tiene.
    setSelected({ ...c, owned: laTiene(c) });
  };

  // Keyboard: Ctrl/Cmd+K opens, Esc cierra, ← → paginan
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // La cabecera monta dos instancias (barra en escritorio, icono en
        // móvil) y sólo una está visible. Como el panel cuelga de <body>, el
        // atajo abriría los dos paneles a la vez si no se descarta la oculta:
        // offsetParent es null cuando un ancestro está en display:none.
        if (triggerRef.current?.offsetParent) setOpen(true);
      }
      if (!open) return;
      // Con una ficha abierta encima, el teclado es suyo: ella ya escucha
      // Escape para cerrarse y las flechas para pasar de carta. Sin esta línea
      // un solo Escape cerraba la ficha Y el buscador, y había que volver a
      // abrirlo y a buscar para mirar el resultado siguiente.
      if (selected) return;
      if (e.key === "Escape") { setOpen(false); return; }
      // Con el campo enfocado (el caso normal: se autoenfoca al abrir) las
      // flechas mueven el cursor del texto; no deben paginar la rejilla por
      // debajo ni relanzar la búsqueda con otra página.
      const target = e.target as HTMLElement | null;
      if (target && (target === inputRef.current || target.closest("input,textarea,[contenteditable]"))) return;
      if (e.key === "ArrowLeft" && total > PAGE_SIZE) setPage((p) => Math.max(1, p - 1));
      if (e.key === "ArrowRight" && total > PAGE_SIZE) setPage((p) => Math.min(Math.ceil(total / PAGE_SIZE), p + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, total, selected]);

  // La página de detrás, quieta mientras el buscador está abierto. El porqué
  // de no escribir `body.style.overflow` a mano: hooks/useBloqueoScroll.ts.
  useFondoQuieto(open);

  // iOS ignora autoFocus dentro de un elemento que acaba de aparecer: se
  // enfoca en el siguiente frame para que el teclado suba de verdad.
  useEffect(() => {
    if (!open || selected || sinTeclado) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.clearTimeout(id);
  }, [open, selected, sinTeclado]);

  // Reset page on query change
  useEffect(() => { setPage(1); }, [query]);

  // Debounced search (with pagination)
  useEffect(() => {
    // Al vaciar el campo hay que apagar «Buscando…»: si no, borrar el texto
    // antes de 250ms lo dejaba clavado con el campo vacío.
    if (!query.trim()) { setResults([]); setTotal(0); setLoading(false); setSearchError(false); return; }
    setLoading(true);
    setSearchError(false);
    // clearTimeout no cancela una petición ya lanzada: sin esta bandera, la
    // respuesta lenta de un texto anterior pisa los resultados del actual.
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const res: any = await searchCardsInDB(query, page, PAGE_SIZE);
        if (cancelled) return;
        setResults(res.data || []);
        setTotal(res.total || 0);
      } catch (err) {
        // Sin catch, un rechazo (sin conexión, el caso primario de la PWA)
        // dejaba el spinner eterno y una promesa sin gestionar.
        console.error(err);
        if (!cancelled) { setResults([]); setTotal(0); setSearchError(true); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [query, page, intento]);

  const openSearch = () => { haptic("tap"); setSinTeclado(false); setOpen(true); };
  /** Una sugerencia o una reciente: rellena el campo y la búsqueda arranca sola
   *  (el efecto de arriba la lanza al cambiar `query`). */
  const buscar = (texto: string) => {
    haptic("tap");
    setQuery(texto);
    // En iOS tocar un botón no le quita el foco al campo: sin esto el teclado
    // se quedaba abierto encima de los resultados que se acaban de pedir.
    inputRef.current?.blur();
  };
  const closeSearch = () => { setOpen(false); };
  const goToPage = (next: number) => { haptic("tap"); setPage(next); };

  return (
    <>
      {variant === "bar" ? (
        <button
          ref={triggerRef}
          onClick={openSearch}
          title="Buscar carta (Ctrl+K)"
          // `.control-44`: medía 42px de alto, dos por debajo de la zona tocable
          // mínima. Aquí no hay riesgo de descentrar nada porque el rótulo de
          // dentro es `flex-1`: se come el espacio libre y no queda nada que
          // repartir.
          className="input-field control-44 w-full flex items-center gap-2.5 px-4 py-2.5 rounded-xl t-cuerpo ink-soft hover:ink transition"
        >
          <IconoLupa tam={16} className="ink-faint" />
          <span className="flex-1 text-left">Buscar cualquier carta…</span>
          {/* Sin `.tnum`: aquí no hay ni un dígito, así que las cifras
              tabulares no hacían nada. La monoespaciada la pone el preflight
              por ser un <kbd>, igual que antes la ponía una clase de familia
              que sobraba. */}
          <kbd className="t-micro chip px-1.5 py-0.5">⌘K</kbd>
        </button>
      ) : (
        <button
          ref={triggerRef}
          onClick={openSearch}
          title="Buscar carta (Ctrl+K)"
          // Nacía a 36px (40 en escritorio) y la barra superior lo estiraba
          // desde fuera con `[&>button]:h-11`. Con `.control-44` el tamaño
          // correcto lo trae ya el propio botón.
          className="control-44 flex items-center justify-center rounded-xl btn-ghost press"
          aria-label="Buscar"
        >
          <IconoLupa tam={16} />
        </button>
      )}

      <Portal>
        <AnimatePresence>
          {open && !selected && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              /* Anclado sobre el teclado: en iOS el viewport de layout no encoge,
                 así que un inset-0 dejaría el panel (y el input) por debajo. */
              className="fixed inset-x-0 top-0 z-[110] flex md:items-start md:justify-center md:pt-24 md:p-4"
              style={{ bottom: "var(--keyboard)" }}
              onClick={closeSearch}
            >
              {/* El telón con el desenfoque es un HERMANO del panel, no este
                  contenedor: la rejilla de resultados pinta cartas y un
                  backdrop-filter en un ancestro las rasteriza (borrosas en
                  iPhone). Mismo --scrim que Sheet y que la ficha de carta. */}
              <div
                aria-hidden="true"
                className="absolute inset-0 backdrop-blur-md"
                // Un arrastre sobre el telón no tiene nada que desplazar: sin
                // esto, en iOS se lo quedaba la página de detrás.
                style={{ background: "var(--scrim)", touchAction: "none" }}
              />
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: D.base, ease: EASE_OUT }}
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="Buscar carta"
                // `relative` para pintarse por encima del telón absoluto.
                className="relative w-full h-full md:h-auto md:max-h-full md:max-w-3xl bg-[var(--surface)] md:border md:border-[var(--border)] md:rounded-2xl overflow-hidden flex flex-col"
              >
                {/* pt-safe deja libre el notch cuando el panel va a pantalla completa */}
                <div className="pt-safe md:pt-0 border-b border-[var(--border)] shrink-0">
                  <div className="px-4 py-3 flex items-center gap-3">
                    <IconoLupa tam={20} className="ink-faint" />
                    <input
                      ref={inputRef}
                      autoFocus={!sinTeclado}
                      type="search"
                      inputMode="search"
                      enterKeyHint="search"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                      placeholder="Buscar carta..."
                      aria-label="Buscar carta"
                      // `min-h-11`: el campo medía 24px de alto dentro de una
                      // fila de 44, y tocar 10px por encima o por debajo no lo
                      // enfocaba. Desde que en táctil no se reenfoca solo al
                      // volver de una ficha, hay que acertarle con el dedo. La
                      // fila no crece: el botón «Cerrar» ya mide 44.
                      className="bg-transparent ink outline-none flex-1 min-h-11 t-base placeholder:text-[var(--ink-faint)] min-w-0 [&::-webkit-search-cancel-button]:hidden"
                    />
                    <button
                      onClick={closeSearch}
                      // Medía 36px de alto: el botón para salir del buscador a
                      // pantalla completa era el más pequeño de la pantalla.
                      className="btn-ghost ink-soft hover:ink control-44 t-cuerpo-2 px-3 rounded-lg shrink-0 press"
                    >Cerrar</button>
                  </div>
                </div>

                <div
                  className="scroll-area custom-scrollbar p-4 flex-1"
                  data-lenis-prevent
                  style={{ paddingBottom: "max(1rem, calc(var(--sab) - var(--keyboard) + 1rem))" }}
                >
                  {loading && <p className="t-cuerpo-2 ink-faint text-center py-8">Buscando…</p>}
                  {/* CON SU "REINTENTAR". El error sólo decía que revisaras la
                      conexión: para volver a buscar había que borrar una letra
                      y escribirla otra vez, que es la única forma de mover el
                      efecto. En la app instalada, saliendo de un túnel, eso es
                      lo que se quiere hacer con un toque. */}
                  {!loading && searchError && (
                    <div className="flex flex-col items-center gap-3 py-8">
                      <p className="t-cuerpo-2 text-center" style={{ color: "var(--danger-ink)" }}>
                        No se pudo buscar. Revisa tu conexión.
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          haptic("tap");
                          setIntento((n) => n + 1);
                        }}
                        className="btn-ghost press control-44 t-cuerpo rounded-xl px-5 font-medium"
                      >
                        Reintentar
                      </button>
                    </div>
                  )}
                  {!loading && !searchError && query && results.length === 0 && (
                    <p className="t-cuerpo-2 ink-faint text-center py-8">Sin resultados.</p>
                  )}
                  {/* Campo vacío: qué se puede buscar, y atajos para hacerlo
                      sin teclear. Ver la nota de SUGERENCIAS, arriba. */}
                  {!loading && !searchError && !query && (
                    <div className="px-2 py-4">
                      <p className="t-cuerpo-2 ink-soft leading-relaxed">
                        Busca por el nombre de la carta. No hace falta
                        escribirlo entero.
                      </p>
                      {recientes.length > 0 && (
                        <>
                          <div className="mt-5 flex items-center justify-between gap-2">
                            <p className="t-etiqueta ink-soft">Recientes</p>
                            {/* Los márgenes negativos meten los 44 px de zona
                                tocable sin separar la fila de sus chapas. */}
                            <button
                              type="button"
                              onClick={olvidarRecientes}
                              className="control-44 -my-3 -mr-2 px-2 t-cuerpo-2 ink-soft hover:ink rounded-lg press"
                            >
                              Borrar
                            </button>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {recientes.map((r) => (
                              <button
                                key={r}
                                type="button"
                                onClick={() => buscar(r)}
                                // `max-w-full` + `truncate`: una reciente de 40
                                // caracteres no puede ensanchar el panel a 320.
                                className="chip control-44 max-w-full px-4 t-cuerpo press"
                              >
                                <span className="min-w-0 truncate">{r}</span>
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                      <p className="t-etiqueta ink-soft mt-5">Prueba con</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {SUGERENCIAS.map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => buscar(s)}
                            className="chip control-44 px-4 t-cuerpo press"
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
                    {results.map((c) => (
                      // `press-flat` y no `press`: la celda es ancestro de la
                      // carta y `.press` escala, que la rasteriza y la deja
                      // borrosa en iPhone (app/globals.css, junto a .press-flat).
                      <button
                        key={c.id}
                        onClick={() => abrirCarta(c)}
                        className="group surface-2 surface-hover border border-[var(--border)] rounded-xl p-1.5 transition text-left press-flat"
                        title={laTiene(c) ? "" : "No la posees"}
                      >
                        {c.images?.small && (
                          // La carta que no se posee se apaga con un velo
                          // HERMANO del color del papel, no con `grayscale`
                          // sobre la imagen: un filter sobre la carta la
                          // rasteriza. El velo se retira al pasar el ratón.
                          // EL HUECO DE LA CARTA, RESERVADO. La imagen iba con
                          // `h-auto`: hasta que cargaba, la celda medía 0 de
                          // alto, así que las treinta entraban "en pantalla" a
                          // la vez, el `loading="lazy"` las pedía todas de
                          // golpe y la rejilla saltaba según iban llegando.
                          <div className="relative aspect-[5/7] overflow-hidden rounded-[4.5%]">
                            <img
                              src={c.images.small}
                              alt={c.name}
                              loading="lazy"
                              decoding="async"
                              // Mantener el dedo no debe levantar la miniatura
                              // como imagen arrastrable (ver PokemonCard.tsx).
                              draggable={false}
                              // El radio de una carta es 4,5%, no 6px sueltos:
                              // es el mismo que pintan PokemonCard, el álbum y
                              // la vitrina, y el velo de debajo tiene que
                              // llevarlo igual para no asomar por las esquinas.
                              className="block h-full w-full rounded-[4.5%] object-cover"
                            />
                            {!laTiene(c) && (
                              <div
                                aria-hidden="true"
                                className="absolute inset-0 rounded-[4.5%] pointer-events-none transition-opacity opacity-55 group-hover:opacity-20"
                                style={{ background: "var(--surface)" }}
                              />
                            )}
                          </div>
                        )}
                        {/* ink-soft y no ink-faint: a 10px, ink-faint se queda
                            en 3,66:1 y la regla de la casa lo limita a 12px en
                            adelante. Es el mismo ajuste que ya lleva la
                            etiqueta de la barra de pestañas. */}
                        <p className={`t-micro truncate mt-1 ${laTiene(c) ? "ink" : "ink-soft"}`}>{c.name}</p>
                        <p className="t-micro ink-soft truncate">{c.set?.name}</p>
                      </button>
                    ))}
                  </div>

                  {/* PAGINACIÓN */}
                  {total > PAGE_SIZE && (
                    <div className="flex items-center justify-center gap-3 mt-5">
                      <button
                        onClick={() => goToPage(Math.max(1, page - 1))}
                        disabled={page === 1}
                        className="w-11 h-11 rounded-xl btn-ghost disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition press"
                        aria-label="Anterior"
                      >
                        <IconoVolver tam={16} className="ink-soft" />
                      </button>
                      <span className="t-cuerpo-2 ink-soft tnum chip px-3 py-2">
                        {page} / {totalPages}
                        <span className="ink-faint ml-2">· {total}</span>
                      </span>
                      <button
                        onClick={() => goToPage(Math.min(totalPages, page + 1))}
                        disabled={page === totalPages}
                        className="w-11 h-11 rounded-xl btn-ghost disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition press"
                        aria-label="Siguiente"
                      >
                        <IconoAvanzar tam={16} className="ink-soft" />
                      </button>
                    </div>
                  )}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </Portal>

      <CardDetailModal card={selected} onClose={() => setSelected(null)} readOnly />
    </>
  );
}
