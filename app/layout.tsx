// src/app/layout.tsx
import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import SmoothScroll from "../components/SmoothScroll";
import AppShell from "../components/AppShell";
import ServiceWorkerRegister from "../components/pwa/ServiceWorkerRegister";

// Fija el tema antes del primer pintado y, con él, el color de la barra del
// navegador: si theme-color se dejara al valor estático, el tema claro saldría
// con la barra de Safari en negro.
const themeInit = `(function(){var t;try{t=localStorage.getItem('theme');if(!t){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}}catch(e){t='dark';}document.documentElement.setAttribute('data-theme',t);var m=document.querySelector('meta[name="theme-color"]');if(m){m.setAttribute('content',t==='dark'?'#14120c':'#f4efe4');}})();`;

const inter = Inter({ subsets: ["latin"] });

/** Pantallas de arranque de iOS. La media query debe coincidir exactamente con
 *  el tamaño lógico y el pixel ratio del dispositivo o iOS la ignora. */
const STARTUP_IMAGES = [
  { w: 440, h: 956, r: 3, file: "1320x2868" }, // iPhone 16 Pro Max
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
    "apple-mobile-web-app-capable": "yes",
    "mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Un único valor, sin variantes por prefers-color-scheme: el tema depende de
  // data-theme (lo elige el usuario), así que la etiqueta la reescriben el
  // script de arranque y ThemeToggle. Con dos metas media-gated ese reemplazo
  // no funcionaría. Éste es sólo el valor de partida sin JS.
  themeColor: "#14120c",
  // Imprescindible para que env(safe-area-inset-*) devuelva valores reales en
  // iOS; sin esto el padding de safe-area de BottomNav siempre vale 0.
  // No se restringe la escala: el pinch-zoom sigue disponible.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="es" suppressHydrationWarning>
        <head>
          <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        </head>
        <body className={inter.className}>
          <ServiceWorkerRegister />
          <SmoothScroll />
          <AppShell>{children}</AppShell>
        </body>
      </html>
    </ClerkProvider>
  );
}
