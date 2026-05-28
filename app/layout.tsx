// src/app/layout.tsx
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
// 👇 1. IMPORTA ESTO
import { ClerkProvider } from '@clerk/nextjs';
import BottomNav from "../components/BottomNav";
import SmoothScroll from "../components/SmoothScroll";

const themeInit = `(function(){try{var t=localStorage.getItem('theme');if(!t){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Pokemon TCG Simulator",
  description: "Abre sobres y colecciona cartas",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#050505",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // 👇 2. ENVUELVE EL HTML CON EL PROVIDER
    <ClerkProvider>
      <html lang="es" suppressHydrationWarning>
        <head>
          <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        </head>
        <body className={`${inter.className} pb-20 md:pb-0`}>
          <SmoothScroll />
          {children}
          <BottomNav />
        </body>
      </html>
    </ClerkProvider>
  );
}