"use client";

import { motion } from "framer-motion";

export default function Loader({ label = "Cargando" }: { label?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="min-h-screen bg-[#050505] flex flex-col items-center justify-center text-[#ededed]"
    >
      <div className="w-10 h-10 border-2 border-white/20 border-t-white rounded-full animate-spin mb-6" />
      <p className="text-xs font-medium text-gray-500 uppercase tracking-[0.3em]">{label}</p>
    </motion.div>
  );
}
