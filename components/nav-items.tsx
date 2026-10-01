import { ReactNode } from "react";

export interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  /**
   * Esta pestaña lleva la insignia de pendientes sociales (peticiones de
   * amistad y ofertas de intercambio sin contestar). La cuenta sale de
   * hooks/useSocialPendientes.tsx; aquí sólo se dice A QUÉ pestaña pertenece,
   * para que las dos barras no tengan que comparar rutas a mano.
   */
  pendientes?: boolean;
  match: (path: string) => boolean;
}

const I = (d: ReactNode) => (
  // Trazo 2 y 20px, como el resto del vocabulario de iconos. Eran 1,8 y 22px,
  // los únicos del proyecto: al salir de aquí los cinco iconos de la barra de
  // pestañas, la desviación se veía en las cinco a la vez.
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
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
    // El invitado puede mirar el tablón (la propia pantalla le explica que
    // para cobrar necesita sesión).
    // El bazar entre jugadores es la otra mitad del mercado: uno vende a la
    // máquina y el otro a personas. Comparten pestaña a propósito.
    match: (p) => p.startsWith("/mercado") || p.startsWith("/bazar"),
    icon: I(<><path d="M3 9h18l-1.5 10.5a2 2 0 0 1-2 1.5H6.5a2 2 0 0 1-2-1.5z" /><path d="M8 9V6a4 4 0 0 1 8 0v3" /></>),
  },
  {
    href: "/friends",
    label: "Social",
    /* SIN `requireAuth`, QUE YA NO EXISTE. La pestaña se pintaba sólo con
     * sesión, dentro de un <SignedIn> que no pinta nada hasta que Clerk
     * contesta: la barra nacía con TRES pestañas de un tercio y medio segundo
     * después pasaba a CUATRO de un cuarto, con Mercado saltando 78 px a la
     * izquierda y Social apareciendo bajo el dedo. Quien tocaba Mercado nada
     * más abrir la app acababa en Social. Y sin red Clerk no llega nunca, así
     * que la pestaña desaparecía aunque /friends sepa pintarse sin él.
     * Ahora las cuatro están desde el primer fotograma; al invitado, /friends
     * le enseña su progreso local y el botón de iniciar sesión. */
    pendientes: true,
    // /invitar es la página de una invitación de amistad: cuelga de Social
    // igual que el álbum de un entrenador.
    match: (p) => p.startsWith("/friends") || p.startsWith("/trainer") || p.startsWith("/invitar"),
    icon: I(<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>),
  },
];

// Se rellena aquí y no con un `NAV_ITEMS.map` en su declaración porque la
// lista se declara ANTES que NAV_ITEMS (para que el comentario que la explica
// quede arriba, donde se lee) y una const no se puede usar antes de existir.
RAICES_DE_PESTANA.push(...NAV_ITEMS.map((it) => it.href));
