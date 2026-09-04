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

/**
 * LAS RAÍCES DE PESTAÑA, en el orden de la barra. UNA lista, derivada de la de
 * abajo, para los dos sitios que necesitan saber "esta ruta es una pestaña":
 *
 *  · app/template.tsx, que decide el signo del desplazamiento de entrada por
 *    la posición de la pestaña en la barra;
 *  · components/ui/EdgeBackGesture.tsx, que en la raíz de una pestaña no
 *    ofrece "atrás".
 *
 * Cada uno tenía la suya escrita a mano y no coincidían: al gesto le faltaba
 * "/mercado", así que en la PWA instalada deslizar desde el borde en el
 * Mercado hacía router.back() y sacaba de la app. Derivándola de NAV_ITEMS no
 * puede volver a pasar: una pestaña nueva entra aquí y se entera todo el mundo.
 */
export const RAICES_DE_PESTANA: string[] = [];
export const esRaizDePestana = (ruta: string) => RAICES_DE_PESTANA.includes(ruta);

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
    /* La pestaña cubre TODO lo que es "mis cartas": el álbum, la vitrina (el
     * archivador 3x3) y la graduación, que es un servicio que se presta sobre
     * la colección. Si alguna de esas rutas faltara aquí, la pestaña se apagaría
     * al entrar en ella y la barra inferior parecería rota. */
    match: (p) =>
      p.startsWith("/collection") ||
      p.startsWith("/album") ||
      p.startsWith("/vitrina") ||
      p.startsWith("/graduacion"),
    icon: I(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>),
  },
  {
    href: "/mercado",
    label: "Mercado",
    // Sin requireAuth a propósito: el invitado puede mirar el tablón (la propia
    // pantalla le explica que para cobrar necesita sesión).
    // El bazar entre jugadores es la otra mitad del mercado: uno vende a la
    // máquina y el otro a personas. Comparten pestaña a propósito.
    match: (p) => p.startsWith("/mercado") || p.startsWith("/bazar"),
    icon: I(<><path d="M3 9h18l-1.5 10.5a2 2 0 0 1-2 1.5H6.5a2 2 0 0 1-2-1.5z" /><path d="M8 9V6a4 4 0 0 1 8 0v3" /></>),
  },
  {
    href: "/friends",
    label: "Social",
    requireAuth: true,
    match: (p) => p.startsWith("/friends") || p.startsWith("/trainer"),
    icon: I(<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>),
  },
];

// Se rellena aquí y no con un `NAV_ITEMS.map` en su declaración porque la
// lista se declara ANTES que NAV_ITEMS (para que el comentario que la explica
// quede arriba, donde se lee) y una const no se puede usar antes de existir.
RAICES_DE_PESTANA.push(...NAV_ITEMS.map((it) => it.href));
