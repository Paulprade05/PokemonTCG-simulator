"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { SignedIn } from "@clerk/nextjs";
import { NAV_ITEMS } from "./nav-items";

export default function BottomNav() {
  const pathname = usePathname();

  const renderItem = (it: (typeof NAV_ITEMS)[number]) => {
    const active = it.match(pathname);
    return (
      <Link
        key={it.href}
        href={it.href}
        className="relative flex flex-col items-center justify-center gap-1 flex-1 py-2 press"
      >
        <div className="relative">
          {active && (
            <motion.span
              layoutId="bottomnav-pill"
              className="absolute -inset-x-3 -inset-y-1.5 rounded-full bg-[color-mix(in_srgb,var(--accent)_16%,transparent)]"
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
            />
          )}
          <span className={`relative z-10 transition-colors ${active ? "accent" : "ink-faint"}`}>
            {it.icon}
          </span>
        </div>
        <span className={`text-[10px] font-medium transition-colors ${active ? "ink" : "ink-faint"}`}>
          {it.label}
        </span>
      </Link>
    );
  };

  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 glass border-t border-[var(--border)] flex items-stretch px-2"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {NAV_ITEMS.map((it) =>
        it.requireAuth ? <SignedIn key={it.href}>{renderItem(it)}</SignedIn> : renderItem(it),
      )}
    </nav>
  );
}
