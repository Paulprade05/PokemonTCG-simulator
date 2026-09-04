// src/app/layout.tsx
import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import SmoothScroll from "../components/SmoothScroll";
import AppShell from "../components/AppShell";

// Fija el tema antes del primer pintado y, con él, el color de la barra del
// navegador: si theme-color se dejara al valor estático, el tema claro saldría
// con la barra de Safari en negro.
const themeInit = `(function(){var t;try{t=localStorage.getItem('theme');if(!t){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}}catch(e){t='dark';}document.documentElement.setAttribute('data-theme',t);var m=document.querySelector('meta[name="theme-color"]');if(!m){m=document.createElement('meta');m.setAttribute('name','theme-color');document.head.appendChild(m);}m.setAttribute('content',t==='dark'?'#14120c':'#f4efe4');})();`;

// Idioma de las cartas, misma idea que el tema y por el mismo motivo: que no
// cambie a la vista. La diferencia es QUIÉN traduce: no es el CSS, es el
// servidor (services/idiomaServidor.ts), y decide leyendo la cookie. Este
// script la reescribe desde localStorage ANTES de la hidratación, así que la
// primera server action que sale del navegador ya pide las cartas en el idioma
// bueno y no hay un fogonazo de nombres en inglés. `data-idioma` es el espejo
// que observan las dos hojas de ajustes montadas a la vez.
// El `lang` del <html> NO se toca: la interfaz está en español siempre; esto
// sólo decide en qué idioma se leen los nombres de las cartas.
// Si localStorage no está disponible (modo privado agotado, ITP) la COOKIE es
// el respaldo, no el inglés: sin eso, la corrección que aplica la cuenta al
// iniciar sesión escribiría la cookie, esta línea la pisaría en la recarga y
// se entraría en un bucle de recargas.
const idiomaInit = `(function(){var l;try{l=localStorage.getItem('lang');}catch(e){}if(l!=='es'&&l!=='en'){var m=document.cookie.match(/(?:^|; )tcg-idioma=(en|es)/);l=m?m[1]:'en';}document.documentElement.setAttribute('data-idioma',l);try{document.cookie='tcg-idioma='+l+';path=/;max-age=31536000;samesite=lax';}catch(e){}})();`;

// Se carga como variable CSS (además de la clase) para que la utilidad
// font-sans resuelva a la webfont real y no a la familia literal "Inter", que
// en iOS/Android no existe como fuente del sistema.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

/** Pantallas de arranque de iOS. La media query debe coincidir exactamente con
 *  el tamaño lógico y el pixel ratio del dispositivo o iOS la ignora. */
const STARTUP_IMAGES = [
  { w: 440, h: 956, r: 3, file: "1320x2868" }, // iPhone 16 Pro Max
  { w: 420, h: 912, r: 3, file: "1260x2736" }, // iPhone Air (2025)
  { w: 402, h: 874, r: 3, file: "1206x2622" }, // iPhone 16 Pro
  { w: 430, h: 932, r: 3, file: "1290x2796" }, // 14 Pro Max · 15/16 Plus
  { w: 393, h: 852, r: 3, file: "1179x2556" }, // 14 Pro · 15/16
  { w: 428, h: 926, r: 3, file: "1284x2778" }, // 12/13 Pro Max · 14 Plus
  { w: 390, h: 844, r: 3, file: "1170x2532" }, // 12 · 13 · 14
  { w: 375, h: 812, r: 3, file: "1125x2436" }, // X · XS · 11 Pro
  { w: 414, h: 896, r: 3, file: "1242x2688" }, // XS Max · 11 Pro Max
  { w: 414, h: 896, r: 2, file: "828x1792" }, //  XR · 11
  { w: 375, h: 667, r: 2, file: "750x1334" }, //  SE 2/3 · 8
].map(({ w, h, r, file }) => ({
  url: `/splash/splash-${file}.png`,
  media: `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait)`,
}));

export const metadata: Metadata = {
  applicationName: "TCG Sim",
  title: "Pokémon TCG Simulator",
  description: "Abre sobres, colecciona e intercambia cartas Pokémon",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "TCG Sim",
    // Deja que el contenido pinte bajo la barra de estado: pantalla completa real.
    statusBarStyle: "black-translucent",
    startupImage: STARTUP_IMAGES,
  },
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  other: {
    // Next 16 sólo emite la variante estándar; iOS anterior a 16.4 sigue
    // necesitando la etiqueta con prefijo apple para abrir sin barra de Safari.
    // SÓLO la prefijada: `appleWebApp.capable` de arriba ya emite la estándar
    // (`mobile-web-app-capable`), y aquí se repetía — el HTML llevaba la misma
    // meta dos veces.
    "apple-mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // El zoom de página está apagado: la app debe sentirse nativa y el único
  // zoom con sentido es el de la carta, que CardZoom implementa con su propio
  // pellizco. El modo instalado de iOS respeta maximum-scale; en navegador,
  // el touch-action del body cubre el resto. El zoom de accesibilidad del
  // sistema (triple toque) no se ve afectado.
  maximumScale: 1,
  userScalable: false,
  // Un único valor, sin variantes por prefers-color-scheme: el tema depende de
  // data-theme (lo elige el usuario), así que la etiqueta la reescriben el
  // script de arranque y SettingsSheet. Con dos metas media-gated ese reemplazo
  // no funcionaría. Éste es sólo el valor de partida sin JS.
  themeColor: "#14120c",
  // Imprescindible para que env(safe-area-inset-*) devuelva valores reales en
  // iOS; sin esto el padding de safe-area de BottomNav siempre vale 0.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="es" className={inter.variable} suppressHydrationWarning>
        <head>
          <script dangerouslySetInnerHTML={{ __html: themeInit }} />
          <script dangerouslySetInnerHTML={{ __html: idiomaInit }} />
        </head>
        <body className={inter.className}>
          {/* El registro del service worker vive dentro de AppShell: necesita
              el proveedor de avisos para decir "hay una versión nueva". */}
          <SmoothScroll />
          <AppShell>{children}</AppShell>
        </body>
      </html>
    </ClerkProvider>
  );
}
