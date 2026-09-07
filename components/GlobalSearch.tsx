"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { searchCardsInDB } from "../app/action";
import CardDetailModal from "./CardDetailModal";
import Portal from "./ui/Portal";
import { useHaptics } from "../hooks/useHaptics";
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

export default function GlobalSearch({ variant = "icon" }: { variant?: "icon" | "bar" }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [selected, setSelected] = useState<any | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const haptic = useHaptics();
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

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
  }, [open, total]);

  // Bloquear scroll del fondo mientras el buscador está abierto
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // iOS ignora autoFocus dentro de un elemento que acaba de aparecer: se
  // enfoca en el siguiente frame para que el teclado suba de verdad.
  useEffect(() => {
    if (!open || selected) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.clearTimeout(id);
  }, [open, selected]);

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
  }, [query, page]);

  const openSearch = () => { haptic("tap"); setOpen(true); };
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
                style={{ background: "var(--scrim)" }}
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
                      autoFocus
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
                      className="bg-transparent ink outline-none flex-1 t-base placeholder:text-[var(--ink-faint)] min-w-0 [&::-webkit-search-cancel-button]:hidden"
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
                  {!loading && searchError && (
                    <p className="t-cuerpo-2 text-center py-8" style={{ color: "var(--danger-ink)" }}>
                      No se pudo buscar. Revisa tu conexión.
                    </p>
                  )}
                  {!loading && !searchError && query && results.length === 0 && (
                    <p className="t-cuerpo-2 ink-faint text-center py-8">Sin resultados.</p>
                  )}
                  {!loading && !searchError && !query && (
                    <div className="t-cuerpo-2 ink-faint px-2 py-4 leading-relaxed">
                      <p className="mb-2">Ejemplos:</p>
                      {/* Sin `.tnum` en la lista: esto es sintaxis de consulta,
                          no una columna de cifras, y unas cifras tabulares
                          sobre "name:pikachu" no hacían absolutamente nada. Los
                          ejemplos siguen saliendo en monoespaciada por estar en
                          un <code> —el preflight de Tailwind se la da—, y ahora
                          los puntos que hacen de viñeta ya no, que era lo único
                          que la clase de familia de la lista aportaba. */}
                      <ul className="space-y-1">
                        <li>· <code className="ink-soft">charizard</code></li>
                        <li>· <code className="ink-soft">name:pikachu subtypes:vmax</code></li>
                        <li>· <code className="ink-soft">types:fire hp:[150 TO *]</code></li>
                        <li>· <code className="ink-soft">nationalPokedexNumbers:[1 TO 151]</code></li>
                      </ul>
                    </div>
                  )}
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
                    {results.map((c) => (
                      // `press-flat` y no `press`: la celda es ancestro de la
                      // carta y `.press` escala, que la rasteriza y la deja
                      // borrosa en iPhone (app/globals.css, junto a .press-flat).
                      <button
                        key={c.id}
                        onClick={() => { haptic("select"); setSelected(c); }}
                        className="group surface-2 surface-hover border border-[var(--border)] rounded-xl p-1.5 transition text-left press-flat"
                        title={c.owned ? "" : "No la posees"}
                      >
                        {c.images?.small && (
                          // La carta que no se posee se apaga con un velo
                          // HERMANO del color del papel, no con `grayscale`
                          // sobre la imagen: un filter sobre la carta la
                          // rasteriza. El velo se retira al pasar el ratón.
                          <div className="relative">
                            <img
                              src={c.images.small}
                              alt={c.name}
                              loading="lazy"
                              decoding="async"
                              // El radio de una carta es 4,5%, no 6px sueltos:
                              // es el mismo que pintan PokemonCard, el álbum y
                              // la vitrina, y el velo de debajo tiene que
                              // llevarlo igual para no asomar por las esquinas.
                              className="w-full h-auto rounded-[4.5%]"
                            />
                            {!c.owned && (
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
                        <p className={`t-micro truncate mt-1 ${c.owned ? "ink" : "ink-soft"}`}>{c.name}</p>
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
