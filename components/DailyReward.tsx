"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { claimDailyReward, getDailyStatus } from "../app/action";
import { useCurrency } from "../hooks/useGameCurrency";

export default function DailyReward() {
  const [available, setAvailable] = useState(false);
  const [streak, setStreak] = useState(0);
  const [hoursLeft, setHoursLeft] = useState(0);
  const [claiming, setClaiming] = useState(false);
  const [reward, setReward] = useState<number | null>(null);
  const { addCoins } = useCurrency();

  useEffect(() => {
    (async () => {
      const s: any = await getDailyStatus();
      setAvailable(!!s?.available);
      setStreak(s?.streak || 0);
      setHoursLeft(s?.hoursLeft || 0);
    })();
  }, []);

  const handleClaim = async () => {
    if (!available || claiming) return;
    setClaiming(true);
    const res: any = await claimDailyReward();
    setClaiming(false);
    if (res?.success) {
      addCoins(res.reward);
      setReward(res.reward);
      setStreak(res.streak);
      setAvailable(false);
      setHoursLeft(20);
      setTimeout(() => setReward(null), 3000);
    } else if (res?.error) {
      alert(res.error);
    }
  };

  return (
    <>
      <button
        onClick={handleClaim}
        disabled={!available || claiming}
        title={available ? `Reclama recompensa diaria · racha ${streak}` : `Disponible en ~${hoursLeft}h`}
        className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium transition border ${
          available
            ? "bg-amber-500/15 hover:bg-amber-500/25 border-amber-500/30 text-amber-300"
            : "bg-white/[0.03] border-white/5 text-gray-600 cursor-not-allowed"
        }`}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
        <span className="hidden md:inline">{available ? "Diaria" : `${hoursLeft}h`}</span>
        {streak > 0 && (
          <span className="bg-white/10 text-[10px] px-1.5 py-0.5 rounded-full">×{streak}</span>
        )}
      </button>

      <AnimatePresence>
        {reward != null && (
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10 }}
            className="fixed top-24 left-1/2 -translate-x-1/2 z-[200] bg-emerald-500/20 border border-emerald-500/30 backdrop-blur-xl px-6 py-3 rounded-2xl text-emerald-200 font-semibold text-sm flex items-center gap-2"
          >
            <span>+{reward}</span>
            <span className="text-xs opacity-80">monedas reclamadas</span>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
