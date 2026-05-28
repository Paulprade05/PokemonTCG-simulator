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
}

export default function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<any | null>(null);

  // Keyboard: Ctrl/Cmd+K opens
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Bloquear scroll del fondo mientras el buscador está abierto
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    setLoading(true);
    const handle = setTimeout(async () => {
      const dbHits = await searchCardsInDB(query, 50);
      setResults(dbHits as any);
      setLoading(false);
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

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

              <div className="overflow-y-auto custom-scrollbar p-4 flex-1">
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
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                  {results.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => setSelected(c)}
                      className="group bg-white/[0.02] hover:bg-white/5 border border-white/5 hover:border-white/10 rounded-xl p-1.5 transition text-left"
                    >
                      {c.images?.small && (
                        <img src={c.images.small} alt={c.name} className="w-full h-auto rounded-md" />
                      )}
                      <p className="text-[10px] text-gray-300 truncate mt-1">{c.name}</p>
                      <p className="text-[9px] text-gray-600 truncate">{c.set?.name}</p>
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <CardDetailModal card={selected} onClose={() => setSelected(null)} readOnly />
    </>
  );
}
