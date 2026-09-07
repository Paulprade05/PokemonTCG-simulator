"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { SignedIn } from "@clerk/nextjs";
import { useState, useSyncExternalStore } from "react";
import { NAV_ITEMS } from "./nav-items";
import { CLASES_PILDORA_NAV } from "./BottomNav";
import SettingsSheet from "./ui/SettingsSheet";
import SidebarExtras from "./SidebarExtras";
import { IconoAjustes, IconoMarca } from "./icons";
import { MUELLE_PILDORA } from "../utils/motion";

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
        // `min-h-11` y no `.control-44`: medían 42px y les faltaban dos para la
        // zona tocable mínima, pero esto es una FILA de icono y texto alineada
        // a la izquierda, y `.control-44` además centra su contenido — que es
        // lo correcto en un botón cuadrado y lo contrario en un enlace de menú.
        className="press-flat group relative flex min-h-11 items-center gap-3 px-3 py-2.5 rounded-xl"
      >
        {active && (
          <motion.span
            layoutId="sidebar-active"
            // El aspecto y el muelle son literalmente los mismos objetos que los
            // de la barra inferior: son el mismo indicador en dos tamaños de
            // pantalla, y que se movieran o se pintaran distinto se notaría al
            // cambiar el ancho. El porqué largo, en BottomNav.tsx.
            className={`absolute inset-0 ${CLASES_PILDORA_NAV}`}
            transition={MUELLE_PILDORA}
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
        <span className={`relative z-10 t-cuerpo font-medium transition-colors ${active ? "ink" : "ink-soft group-hover:text-[var(--ink)]"}`}>
          {it.label}
        </span>
      </Link>
    );
  };

  return (
    // `glass` y no la receta a mano que había aquí (superficie al 60% con
    // `backdrop-blur-xl`, o sea 24px de desenfoque): el cristal de la casa está
    // declarado una sola vez en globals.css —78% de opacidad y 8px de
    // desenfoque, acabado mate— y es el que lleva la barra superior. Dos
    // recetas distintas para el mismo material se notan justo donde se tocan,
    // en la esquina de arriba a la izquierda. Aquí no hay ninguna carta debajo,
    // así que el backdrop-filter es seguro (la prohibición es sobre las cartas).
    <aside className="hidden md:flex fixed left-0 top-0 bottom-0 z-40 w-60 flex-col px-3 py-5 glass border-r border-[var(--border)]">
      {/* Brand */}
      <Link href="/" className="press-flat flex items-center gap-2.5 px-3 mb-8">
        <div className="w-9 h-9 rounded-xl btn-accent flex items-center justify-center shrink-0">
          <IconoMarca tam={20} className="text-[#04110c]" />
        </div>
        <div className="leading-tight">
          <p className="t-cuerpo font-bold tracking-tight ink">Pokémon TCG</p>
          <p className="t-micro ink-soft">Simulator</p>
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
            <IconoAjustes tam={20} />
          </span>
          <span className="ink-soft t-cuerpo font-medium transition-colors group-hover:text-[var(--ink)]">
            Ajustes
          </span>
        </button>
        <p className="px-3 pt-1 t-micro ink-soft">v2{year ? ` · ${year}` : ""}</p>
      </div>

      <SettingsSheet open={ajustesAbiertos} onClose={() => setAjustesAbiertos(false)} />
    </aside>
  );
}
