"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import { getUserTheme, setUserTheme } from "../app/action";

type Theme = "light" | "dark";

export default function ThemeToggle() {
  const { isSignedIn, isLoaded } = useUser();
  const [theme, setTheme] = useState<Theme>("light");

  // Cargar tema actual del DOM (puesto por script no-flash)
  useEffect(() => {
    const cur = (document.documentElement.getAttribute("data-theme") as Theme) || "light";
    setTheme(cur);
  }, []);

  // Si está logueado, sincronizar desde BD (sobrescribe localStorage si difiere)
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    getUserTheme().then((t) => {
      if (t && t !== theme) {
        setTheme(t);
        document.documentElement.setAttribute("data-theme", t);
        try { localStorage.setItem("theme", t); } catch {}
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn, isLoaded]);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("theme", next); } catch {}
    if (isSignedIn) setUserTheme(next).catch(() => {});
  };

  return (
    <button
      onClick={toggle}
      aria-label="Cambiar tema"
      title={theme === "dark" ? "Tema claro" : "Tema oscuro"}
      className="w-9 h-9 md:w-10 md:h-10 flex items-center justify-center rounded-xl btn-ghost press relative overflow-hidden"
    >
      <AnimatePresence mode="wait" initial={false}>
        {theme === "dark" ? (
          <motion.svg
            key="sun"
            initial={{ rotate: -90, opacity: 0 }}
            animate={{ rotate: 0, opacity: 1 }}
            exit={{ rotate: 90, opacity: 0 }}
            transition={{ duration: 0.2 }}
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-amber-300"
          >
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
          </motion.svg>
        ) : (
          <motion.svg
            key="moon"
            initial={{ rotate: 90, opacity: 0 }}
            animate={{ rotate: 0, opacity: 1 }}
            exit={{ rotate: -90, opacity: 0 }}
            transition={{ duration: 0.2 }}
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-indigo-500"
          >
            <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
          </motion.svg>
        )}
      </AnimatePresence>
    </button>
  );
}
