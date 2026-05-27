"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { SignedIn, SignedOut, SignInButton, UserButton, useUser } from "@clerk/nextjs";
import { useCurrency } from "../hooks/useGameCurrency";
import DailyReward from "./DailyReward";
import GlobalSearch from "./GlobalSearch";
import { ReactNode } from "react";

interface AppHeaderProps {
  back?: { href: string; label?: string };
  title?: string;
  subtitle?: string;
  centerLogo?: string;
  rightExtra?: ReactNode;
  showCollectionLink?: boolean;
  showFriendsLink?: boolean;
}

export default function AppHeader({
  back,
  title,
  subtitle,
  centerLogo,
  rightExtra,
  showCollectionLink = true,
  showFriendsLink = true,
}: AppHeaderProps) {
  const { coins } = useCurrency();
  const { user, isLoaded } = useUser();

  return (
    <motion.div
      initial={{ y: -30, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className="w-full max-w-7xl mx-auto sticky top-4 z-50 glass px-4 md:px-6 py-3 rounded-2xl shadow-2xl mb-12 flex justify-between items-center"
    >
      <div className="flex items-center gap-3 md:gap-4 min-w-0">
        {back && (
          <Link
            href={back.href}
            aria-label={back.label || "Volver"}
            className="w-10 h-10 flex items-center justify-center rounded-xl bg-white/5 hover:bg-white/10 border border-white/5 transition shrink-0"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </Link>
        )}

        {centerLogo ? (
          <img src={centerLogo} alt="" className="h-8 md:h-10 object-contain" />
        ) : title ? (
          <div className="min-w-0">
            <h1 className="text-base md:text-lg font-semibold text-white tracking-wide truncate">{title}</h1>
            {subtitle && (
              <p className="text-[10px] text-gray-500 font-mono truncate max-w-[180px] sm:max-w-xs">{subtitle}</p>
            )}
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2 md:gap-3">
        <div className="flex items-center gap-2 bg-white/5 px-3 md:px-4 py-2 rounded-xl border border-white/5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 md:w-5 md:h-5 text-emerald-400">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-8M9 12h6" />
          </svg>
          <span className="font-semibold tracking-wide text-xs md:text-sm">
            {!isLoaded ? "..." : coins.toLocaleString()}
          </span>
        </div>

        <GlobalSearch />

        {rightExtra}

        <SignedIn>
          <DailyReward />
        </SignedIn>

        <SignedOut>
          <SignInButton mode="modal">
            <button className="btn-primary px-4 md:px-5 py-2 rounded-xl font-medium text-xs md:text-sm flex items-center gap-2">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              <span className="hidden sm:inline">Iniciar Sesión</span>
            </button>
          </SignInButton>
        </SignedOut>

        <SignedIn>
          {showFriendsLink && (
            <Link
              href="/friends"
              className="text-gray-400 hover:text-white px-2 md:px-3 py-2 rounded-xl text-sm font-medium transition flex items-center gap-2 hover:bg-white/5"
              aria-label="Amigos"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              <span className="hidden lg:inline">Amigos</span>
            </Link>
          )}
        </SignedIn>

        {showCollectionLink && (
          <Link
            href="/collection"
            className="btn-ghost text-white px-3 md:px-5 py-2 rounded-xl text-xs md:text-sm font-medium flex items-center gap-2"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <span className="hidden sm:inline">Colección</span>
          </Link>
        )}

        <SignedIn>
          <div className="bg-white/5 p-1 rounded-xl border border-white/5">
            <UserButton />
          </div>
          {user && (
            <span className="hidden xl:inline text-xs font-medium text-gray-400 max-w-[100px] truncate">
              {user.username || user.firstName}
            </span>
          )}
        </SignedIn>
      </div>
    </motion.div>
  );
}
