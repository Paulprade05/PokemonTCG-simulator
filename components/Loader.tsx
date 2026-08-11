"use client";

import { motion } from "framer-motion";

/**
 * Pantalla de carga de las rutas. Se pinta dentro del <main> de AppShell, así
 * que el alto mínimo descuenta el cromo (TopBar, inset superior, hueco de la
 * barra de pestañas y el pt-6 del main): con un alto de viewport completo la
 * página ganaría scroll fantasma y el spinner quedaría por debajo del centro.
 */
export default function Loader({ label = "Cargando" }: { label?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex flex-col items-center justify-center ink"
      style={{
        minHeight:
          "calc(var(--app-height) - var(--topbar-h) - var(--sat) - var(--content-bottom) - 1.5rem)",
      }}
    >
      <div className="w-10 h-10 border-2 border-[var(--border)] border-t-[var(--accent)] rounded-full animate-spin mb-6" />
      <p className="text-xs font-medium ink-soft uppercase tracking-[0.3em]">{label}</p>
    </motion.div>
  );
}
