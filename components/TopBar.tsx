"use client";

import { SignedIn, SignedOut, SignInButton, UserButton, useUser } from "@clerk/nextjs";
import { motion } from "framer-motion";
import { useCurrency } from "../hooks/useGameCurrency";
import GlobalSearch from "./GlobalSearch";
import ThemeToggle from "./ThemeToggle";
import DailyReward from "./DailyReward";

export default function TopBar() {
  const { coins } = useCurrency();
  const { isLoaded } = useUser();

  return (
    <motion.header
      initial={{ y: -16, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="sticky top-0 z-30 flex items-center gap-2 md:gap-3 px-3 md:px-6 h-16 glass border-b border-[var(--border)]"
      // Con viewport-fit=cover el contenido pinta bajo la barra de estado:
      // desplazamos la cabecera para que no quede tapada por el notch.
      style={{
        paddingTop: "env(safe-area-inset-top)",
        height: "calc(4rem + env(safe-area-inset-top))",
      }}
    >
      {/* Brand on mobile — min-w-0 + truncate para que ceda el ancho en
          pantallas de 320px en lugar de desbordar la cabecera. */}
      <div className="md:hidden flex items-center gap-2 mr-auto min-w-0">
        <div className="w-8 h-8 shrink-0 rounded-lg btn-accent flex items-center justify-center">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="w-4 h-4 text-[#04110c]">
            <rect x="3" y="5" width="18" height="14" rx="3" /><path d="M3 12h18" /><circle cx="12" cy="12" r="2.4" fill="currentColor" />
          </svg>
        </div>
        {/* El nombre se cae por debajo de 420px: con la marca, buscador,
            monedas, recompensa, tema y avatar no cabe todo y acababa
            truncado a "Pokémo…". El icono ya identifica la app. */}
        <span className="hidden min-[420px]:inline text-sm font-bold tracking-tight truncate">
          Pokémon TCG
        </span>
      </div>

      {/* Search grows on desktop */}
      <div className="hidden md:block flex-1 max-w-md">
        <GlobalSearch variant="bar" />
      </div>
      <div className="md:hidden">
        <GlobalSearch />
      </div>

      <div className="flex items-center gap-1.5 md:gap-2.5 ml-auto md:ml-0 shrink-0">
        {/* Coins */}
        <div className="flex items-center gap-1.5 chip px-2.5 md:px-3.5 py-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 accent">
            <circle cx="12" cy="12" r="9" /><path d="M12 16v-8M9 12h6" />
          </svg>
          <span className="font-semibold text-xs md:text-sm tabular-nums">
            {!isLoaded ? "..." : coins.toLocaleString()}
          </span>
        </div>

        <SignedIn><DailyReward /></SignedIn>
        <ThemeToggle />

        <SignedOut>
          <SignInButton mode="modal">
            <button className="btn-accent press px-3 md:px-4 py-2 rounded-xl text-xs md:text-sm flex items-center gap-2">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
              </svg>
              <span className="hidden sm:inline">Entrar</span>
            </button>
          </SignInButton>
        </SignedOut>

        <SignedIn>
          <div className="chip p-1 flex items-center justify-center">
            <UserButton />
          </div>
        </SignedIn>
      </div>
    </motion.header>
  );
}
