import { ReactNode } from "react";

export interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  requireAuth?: boolean;
  match: (path: string) => boolean;
}

const I = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-[22px] h-[22px]">
    {d}
  </svg>
);

export const NAV_ITEMS: NavItem[] = [
  {
    href: "/",
    label: "Inicio",
    match: (p) => p === "/",
    icon: I(<><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M9 22V12h6v10" /></>),
  },
  {
    href: "/collection",
    label: "Colección",
    match: (p) => p.startsWith("/collection") || p.startsWith("/album"),
    icon: I(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>),
  },
  {
    href: "/friends",
    label: "Social",
    requireAuth: true,
    match: (p) => p.startsWith("/friends") || p.startsWith("/trainer"),
    icon: I(<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>),
  },
];
