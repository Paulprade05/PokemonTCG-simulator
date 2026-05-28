"use client";

import { motion } from "framer-motion";

export default function Loader({ label = "Cargando" }: { label?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="min-h-screen flex flex-col items-center justify-center ink"
    >
      <div className="w-10 h-10 border-2 border-black/10 border-t-violet-600 rounded-full animate-spin mb-6" />
      <p className="text-xs font-medium ink-soft uppercase tracking-[0.3em]">{label}</p>
    </motion.div>
  );
}
