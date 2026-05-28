"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { SignedIn } from "@clerk/nextjs";

const items = [
  {
    href: "/",
    label: "Inicio",
    icon: (
      <>
        <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <path d="M9 22V12h6v10" />
      </>
    ),
  },
  {
    href: "/collection",
    label: "Colección",
    icon: (
      <>
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </>
    ),
  },
  {
    href: "/friends",
    label: "Amigos",
    requireAuth: true,
    icon: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </>
    ),
  },
];

export default function BottomNav() {
  const pathname = usePathname();

  const renderItem = (it: (typeof items)[number]) => {
    const active = it.href === "/" ? pathname === "/" : pathname.startsWith(it.href);
    return (
      <Link
        key={it.href}
        href={it.href}
        className="relative flex flex-col items-center justify-center gap-1 flex-1 py-2 press"
      >
        {active && (
          <motion.span
            layoutId="bottomnav-active"
            className="absolute -top-px h-0.5 w-8 rounded-full bg-violet-400"
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
          />
        )}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`w-5 h-5 transition-colors ${active ? "text-white" : "text-gray-500"}`}
        >
          {it.icon}
        </svg>
        <span className={`text-[10px] font-medium transition-colors ${active ? "text-white" : "text-gray-500"}`}>
          {it.label}
        </span>
      </Link>
    );
  };

  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-50 glass border-t border-white/5 flex items-stretch px-2"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {items.map((it) =>
        it.requireAuth ? (
          <SignedIn key={it.href}>{renderItem(it)}</SignedIn>
        ) : (
          renderItem(it)
        ),
      )}
    </nav>
  );
}
