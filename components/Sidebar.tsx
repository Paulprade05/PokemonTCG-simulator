"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { SignedIn } from "@clerk/nextjs";
import { useState, useSyncExternalStore } from "react";
import { NAV_ITEMS } from "./nav-items";
import { MUELLE_INDICADOR } from "./BottomNav";
import SettingsSheet from "./ui/SettingsSheet";
import SidebarExtras from "./SidebarExtras";

/* Nada a lo que suscribirse: el año no cambia mientras la página está abierta.
   Vive fuera del componente porque useSyncExternalStore exige que la función de
   suscripción sea estable entre renders. */
const SIN_SUSCRIPCION = () => () => {};

export default function Sidebar() {
  const pathname = usePathname();
  const [ajustesAbiertos, setAjustesAbiertos] = useState(false);

  // El año se calcula tras montar, nunca durante el render: el servidor de
  // Vercel corre en UTC y el navegador en la zona del usuario, así que en
  // Nochevieja emitirían años distintos y React abortaría la hidratación. Si
  // además la ruta se prerrenderiza, el año quedaría congelado al del build.
  //
  // Se lee con useSyncExternalStore y no con useState+useEffect —hace lo mismo:
  // el servidor y la hidratación ven null, y el navegador el año real— porque
  // aquel setState dentro de un efecto es una cascada de renders y lo marcaba
  // react-hooks como error. Es además el patrón que ya usa useInstallMode en
  // hooks/useViewport.ts para lo mismo: un dato que sólo existe en el cliente.
  const year = useSyncExternalStore(
    SIN_SUSCRIPCION,
    () => new Date().getFullYear(),
    () => null,
  );

  const renderItem = (it: (typeof NAV_ITEMS)[number]) => {
    const active = it.match(pathname);
    return (
      <Link
        key={it.href}
        href={it.href}
        aria-current={active ? "page" : undefined}
        // press-flat, igual que en la barra inferior: en escritorio se toca con
        // ratón, pero el hundimiento sirve de acuse de recibo en el clic y no
        // escala nada (ver la nota de .press-flat en globals.css).
        // (Sin transition-colors aquí: el color lo animan los dos spans de
        // dentro. Puesto en el enlace pisaría la transición de .press-flat, que
        // declara el atajo `transition` completo.)
        className="press-flat group relative flex items-center gap-3 px-3 py-2.5 rounded-xl"
      >
        {active && (
          <motion.span
            layoutId="sidebar-active"
            className="absolute inset-0 rounded-xl bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] border border-[color-mix(in_srgb,var(--accent)_30%,transparent)]"
            // El muelle es literalmente el mismo objeto que el de la barra
            // inferior: son el mismo indicador en dos tamaños de pantalla, y
            // que se movieran distinto se notaría al cambiar el ancho.
            transition={MUELLE_INDICADOR}
          />
        )}
        {/* CLASE CON VALOR ARBITRARIO Y NO `group-hover` sobre `ink`, que es lo
            que había: .ink y .ink-soft son CSS a mano dentro de @layer
            utilities de globals.css, NO utilidades de Tailwind, así que
            Tailwind nunca genera su variante de hover y la clase no pintaba
            nada. Comprobado en la hoja emitida: 10 reglas de variante de hover
            de grupo y ninguna de color de tinta. O sea que estos enlaces
            declaraban un hover que llevaba tiempo sin existir; esto no cambia
            la navegación, sólo cumple lo que el código ya prometía. */}
        <span className={`relative z-10 transition-colors ${active ? "accent" : "ink-faint group-hover:text-[var(--ink)]"}`}>
          {it.icon}
        </span>
        <span className={`relative z-10 text-sm font-medium transition-colors ${active ? "ink" : "ink-soft group-hover:text-[var(--ink)]"}`}>
          {it.label}
        </span>
      </Link>
    );
  };

  return (
    <aside className="hidden md:flex fixed left-0 top-0 bottom-0 z-40 w-60 flex-col px-3 py-5 border-r border-[var(--border)] bg-[var(--surface)]/60 backdrop-blur-xl">
      {/* Brand */}
      <Link href="/" className="press-flat flex items-center gap-2.5 px-3 mb-8">
        <div className="w-9 h-9 rounded-xl btn-accent flex items-center justify-center shrink-0">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="w-5 h-5 text-[#04110c]">
            <rect x="3" y="5" width="18" height="14" rx="3" /><path d="M3 12h18" /><circle cx="12" cy="12" r="2.4" fill="currentColor" />
          </svg>
        </div>
        <div className="leading-tight">
          <p className="text-sm font-bold tracking-tight ink">Pokémon TCG</p>
          <p className="text-[10px] ink-faint">Simulator</p>
        </div>
      </Link>

      {/* Nav + atajos.
          EL ENVOLTORIO CON SCROLL NO ES DECORATIVO: este <aside> es `fixed`
          entre top-0 y bottom-0 y no tenía desbordamiento en ninguna parte, así
          que todo lo que se añadiera entre la navegación y el pie empujaba el
          bloque de Ajustes fuera del borde inferior en una ventana baja, sin
          forma de llegar a él. Con `min-h-0 flex-1 overflow-y-auto` el que se
          desplaza es este trozo y el pie se queda siempre visible.
          El `flex-1` hace además el trabajo que hacía el `mt-auto` de abajo:
          este bloque crece y empuja el pie al fondo. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <nav className="flex flex-col gap-1">
          {NAV_ITEMS.map((it) =>
            it.requireAuth ? <SignedIn key={it.href}>{renderItem(it)}</SignedIn> : renderItem(it),
          )}
        </nav>

        <SidebarExtras />
      </div>

      <div className="mt-auto pt-4">
        <button
          onClick={() => setAjustesAbiertos(true)}
          className="press-flat touch-target group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left"
        >
          {/* Mismo caso que los enlaces de arriba: la variante de hover sobre
              .ink no se genera nunca. Ver la nota de renderItem. */}
          <span className="ink-faint transition-colors group-hover:text-[var(--ink)]">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-[22px] h-[22px]" aria-hidden="true">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </span>
          <span className="ink-soft text-sm font-medium transition-colors group-hover:text-[var(--ink)]">
            Ajustes
          </span>
        </button>
        <p className="px-3 pt-1 text-[10px] ink-faint">v2{year ? ` · ${year}` : ""}</p>
      </div>

      <SettingsSheet open={ajustesAbiertos} onClose={() => setAjustesAbiertos(false)} />
    </aside>
  );
}
