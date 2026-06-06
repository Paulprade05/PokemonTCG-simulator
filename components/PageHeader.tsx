"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  back?: string;
  logo?: string;
  actions?: ReactNode;
}

export default function PageHeader({ title, subtitle, back, logo, actions }: PageHeaderProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="flex items-center justify-between gap-3 mb-6 md:mb-8"
    >
      <div className="flex items-center gap-3 min-w-0">
        {back && (
          <Link
            href={back}
            aria-label="Volver"
            className="w-10 h-10 rounded-xl btn-ghost press flex items-center justify-center shrink-0"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </Link>
        )}
        {logo ? (
          <img src={logo} alt={title} className="h-9 md:h-11 object-contain" />
        ) : (
          <div className="min-w-0">
            <h1 className="text-xl md:text-2xl font-bold tracking-tight truncate">{title}</h1>
            {subtitle && <p className="text-xs ink-soft mt-0.5 truncate">{subtitle}</p>}
          </div>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </motion.div>
  );
}
