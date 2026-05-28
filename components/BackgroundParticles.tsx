"use client";

import { motion } from "framer-motion";
import { useEffect, useState } from "react";

export default function BackgroundParticles() {
  const [particles, setParticles] = useState<any[]>([]);

  useEffect(() => {
    const count = window.innerWidth < 640 ? 14 : 25;
    const newParticles = Array.from({ length: count }).map((_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 100,
      size: Math.random() * 3 + 1,
      duration: Math.random() * 20 + 10,
      delay: Math.random() * 5,
    }));
    setParticles(newParticles);
  }, []);

  return (
    <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
      {/* Aurora blobs */}
      <div
        className="aurora-blob"
        style={{
          width: 520, height: 520, top: "-10%", left: "-8%",
          background: "radial-gradient(circle, #6d28d9, transparent 70%)",
          animation: "aurora-float 22s ease-in-out infinite",
        }}
      />
      <div
        className="aurora-blob"
        style={{
          width: 460, height: 460, bottom: "-12%", right: "-6%",
          background: "radial-gradient(circle, #0ea5e9, transparent 70%)",
          animation: "aurora-float 28s ease-in-out infinite reverse",
        }}
      />
      <div
        className="aurora-blob"
        style={{
          width: 380, height: 380, top: "40%", left: "55%",
          background: "radial-gradient(circle, #10b981, transparent 70%)",
          opacity: 0.12,
          animation: "aurora-float 34s ease-in-out infinite",
        }}
      />

      {/* Floating particles (violeta sutil sobre fondo claro) */}
      {particles.map((p) => (
        <motion.div
          key={p.id}
          className="absolute rounded-full"
          style={{
            left: `${p.x}%`,
            top: `${p.y}%`,
            width: p.size + 1,
            height: p.size + 1,
            background: "rgba(124,58,237,0.5)",
            opacity: 0.15,
          }}
          animate={{
            y: ["0%", "-30%", "0%"],
            x: ["0%", "10%", "0%"],
            opacity: [0.1, 0.35, 0.1],
          }}
          transition={{
            duration: p.duration,
            repeat: Infinity,
            ease: "easeInOut",
            delay: p.delay,
          }}
        />
      ))}
    </div>
  );
}
