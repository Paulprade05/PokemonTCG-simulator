"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { SignedIn } from "@clerk/nextjs";
import { NAV_ITEMS } from "./nav-items";

export default function Sidebar() {
  const pathname = usePathname();

  const renderItem = (it: (typeof NAV_ITEMS)[number]) => {
    const active = it.match(pathname);
    return (
      <Link
        key={it.href}
        href={it.href}
        className="group relative flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors"
      >
        {active && (
          <motion.span
            layoutId="sidebar-active"
            className="absolute inset-0 rounded-xl bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] border border-[color-mix(in_srgb,var(--accent)_30%,transparent)]"
            transition={{ type: "spring", stiffness: 400, damping: 32 }}
          />
        )}
        <span className={`relative z-10 transition-colors ${active ? "accent" : "ink-faint group-hover:ink"}`}>
          {it.icon}
        </span>
        <span className={`relative z-10 text-sm font-medium transition-colors ${active ? "ink" : "ink-soft group-hover:ink"}`}>
          {it.label}
        </span>
      </Link>
    );
  };

  return (
    <aside className="hidden md:flex fixed left-0 top-0 bottom-0 z-40 w-60 flex-col px-3 py-5 border-r border-[var(--border)] bg-[var(--surface)]/60 backdrop-blur-xl">
      {/* Brand */}
      <Link href="/" className="flex items-center gap-2.5 px-3 mb-8">
        <div className="w-9 h-9 rounded-xl btn-accent flex items-center justify-center shrink-0">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="w-5 h-5 text-[#04110c]">
            <rect x="3" y="5" width="18" height="14" rx="3" /><path d="M3 12h18" /><circle cx="12" cy="12" r="2.4" fill="currentColor" />
          </svg>
        </div>
        <div className="leading-tight">
          <p className="text-sm font-bold tracking-tight ink">Aurora Deck</p>
          <p className="text-[10px] ink-faint">Pokémon TCG</p>
        </div>
      </Link>

      {/* Nav */}
      <nav className="flex flex-col gap-1">
        {NAV_ITEMS.map((it) =>
          it.requireAuth ? <SignedIn key={it.href}>{renderItem(it)}</SignedIn> : renderItem(it),
        )}
      </nav>

      <div className="mt-auto px-3">
        <p className="text-[10px] ink-faint">v2 · {new Date().getFullYear()}</p>
      </div>
    </aside>
  );
}
