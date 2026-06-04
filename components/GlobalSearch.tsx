"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { searchCardsInDB } from "../app/action";
import CardDetailModal from "./CardDetailModal";

interface Hit {
  id: string;
  name: string;
  images?: { small?: string };
  set?: { id: string; name: string };
  rarity?: string;
  owned?: boolean;
}

const PAGE_SIZE = 10;

export default function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<any | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Keyboard: Ctrl/Cmd+K opens, Esc cierra, ← → paginan
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
      if (!open) return;
      if (e.key === "Escape") setOpen(false);
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

  // Reset page on query change
  useEffect(() => { setPage(1); }, [query]);

  // Debounced search (with pagination)
  useEffect(() => {
    if (!query.trim()) { setResults([]); setTotal(0); return; }
    setLoading(true);
    const handle = setTimeout(async () => {
      const res: any = await searchCardsInDB(query, page, PAGE_SIZE);
      setResults(res.data || []);
      setTotal(res.total || 0);
      setLoading(false);
    }, 250);
    return () => clearTimeout(handle);
  }, [query, page]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Buscar carta (Ctrl+K)"
        className="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/5 px-3 py-2 rounded-xl text-xs text-gray-400 transition"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
        </svg>
        <span className="hidden md:inline">Buscar</span>
        <kbd className="hidden lg:inline text-[9px] bg-white/5 border border-white/10 px-1.5 py-0.5 rounded font-mono">⌘K</kbd>
      </button>

      <AnimatePresence>
        {open && !selected && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[110] bg-black/80 backdrop-blur-xl flex md:items-start md:justify-center md:pt-24 md:p-4"
            onClick={() => setOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              onClick={(e) => e.stopPropagation()}
              className="w-full h-[100dvh] md:h-auto md:max-h-[80vh] md:max-w-3xl bg-[#0a0a0a] md:border md:border-white/10 md:rounded-2xl overflow-hidden flex flex-col"
            >
              <div className="px-4 py-3 border-b border-white/5 flex items-center gap-3 shrink-0">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5 text-gray-500 shrink-0">
                  <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
                </svg>
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar carta..."
                  className="bg-transparent text-white outline-none flex-1 text-base placeholder:text-gray-600 min-w-0"
                />
                <button
                  onClick={() => setOpen(false)}
                  className="text-gray-400 hover:text-white text-xs px-3 py-1.5 rounded-lg border border-white/10 shrink-0"
                >Cerrar</button>
              </div>

              <div className="overflow-y-auto custom-scrollbar p-4 flex-1" data-lenis-prevent>
                {loading && <p className="text-xs text-gray-500 text-center py-8">Buscando…</p>}
                {!loading && query && results.length === 0 && (
                  <p className="text-xs text-gray-500 text-center py-8">Sin resultados.</p>
                )}
                {!loading && !query && (
                  <div className="text-xs text-gray-500 px-2 py-4 leading-relaxed">
                    <p className="mb-2">Ejemplos:</p>
                    <ul className="space-y-1 font-mono">
                      <li>· <code className="text-gray-300">charizard</code></li>
                      <li>· <code className="text-gray-300">name:pikachu subtypes:vmax</code></li>
                      <li>· <code className="text-gray-300">types:fire hp:[150 TO *]</code></li>
                      <li>· <code className="text-gray-300">nationalPokedexNumbers:[1 TO 151]</code></li>
                    </ul>
                  </div>
                )}
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
                  {results.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => setSelected(c)}
                      className="group bg-white/[0.02] hover:bg-white/5 border border-white/5 hover:border-white/10 rounded-xl p-1.5 transition text-left press"
                      title={c.owned ? "" : "No la posees"}
                    >
                      {c.images?.small && (
                        <img
                          src={c.images.small}
                          alt={c.name}
                          loading="lazy"
                          decoding="async"
                          className={`w-full h-auto rounded-md transition ${c.owned ? "" : "grayscale opacity-60 group-hover:opacity-90"}`}
                        />
                      )}
                      <p className={`text-[10px] truncate mt-1 ${c.owned ? "text-gray-200" : "text-gray-500"}`}>{c.name}</p>
                      <p className="text-[9px] text-gray-600 truncate">{c.set?.name}</p>
                    </button>
                  ))}
                </div>

                {/* PAGINACIÓN */}
                {total > PAGE_SIZE && (
                  <div className="flex items-center justify-center gap-3 mt-5">
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page === 1}
                      className="w-9 h-9 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition press"
                      aria-label="Anterior"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-gray-300">
                        <path d="m15 18-6-6 6-6" />
                      </svg>
                    </button>
                    <span className="text-xs text-gray-300 tabular-nums bg-white/5 px-3 py-2 rounded-lg border border-white/10">
                      {page} / {totalPages}
                      <span className="text-gray-500 ml-2">· {total}</span>
                    </span>
                    <button
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={page === totalPages}
                      className="w-9 h-9 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition press"
                      aria-label="Siguiente"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-gray-300">
                        <path d="m9 18 6-6-6-6" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <CardDetailModal card={selected} onClose={() => setSelected(null)} readOnly />
    </>
  );
}
