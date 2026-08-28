"use client";

import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import { motion } from "framer-motion";
import Link from "next/link";
import { useState } from "react";
import { useCurrency } from "../hooks/useGameCurrency";
import GlobalSearch from "./GlobalSearch";
import DailyReward from "./DailyReward";
import SettingsSheet from "./ui/SettingsSheet";
import { formatNumber } from "../utils/format";

export default function TopBar() {
  // `loaded` del proveedor, no `isLoaded` de Clerk: lo que hay que esperar es a
  // que el saldo se lea de su almacén, que ocurre después de saber la identidad.
  const { coins, loaded } = useCurrency();
  const [ajustesAbiertos, setAjustesAbiertos] = useState(false);

  return (
    <motion.header
      initial={{ y: -16, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      // Los insets laterales van DENTRO del padding, igual que en BottomNav:
      // con el móvil en apaisado el notch se va a un lado y con `px-4` fijo el
      // saldo y el botón de ajustes quedaban debajo del recorte. El max()
      // conserva los 16px (32 en escritorio) de siempre cuando no hay inset, y
      // va en clases y no en `style` para no perder el salto de md.
      className="sticky top-0 z-30 glass border-b border-[var(--border)] px-[max(var(--sal),1rem)] md:px-[max(var(--sal),2rem)]"
      // Con viewport-fit=cover el contenido pinta bajo la barra de estado:
      // desplazamos la cabecera para que no quede tapada por el notch. El alto
      // se declara sólo aquí (4rem + notch); una clase h-16 quedaría muerta.
      style={{
        paddingTop: "env(safe-area-inset-top)",
        height: "calc(4rem + env(safe-area-inset-top))",
      }}
    >
      {/* Misma rejilla que <main> (max-w-7xl y el mismo padding lateral): en
          pantallas anchas el buscador y el avatar caen a plomo con el contenido
          en lugar de irse a los bordes de la ventana. */}
      <div className="mx-auto flex h-full w-full max-w-7xl items-center gap-2 md:gap-3">
        {/* Marca sólo en móvil: en escritorio ya la lleva el menú lateral.
            Entra entera (icono y nombre) a partir de 420px y por debajo
            desaparece: con sesión, racha y un saldo de seis cifras el grupo de
            controles mide 327px, así que hasta ~397 no hay hueco para el icono.
            Dejarlo antes no lo encogía —el cuadro es shrink-0—: se salía de su
            caja y se montaba sobre el botón de buscar. Quitarla es lo único que
            no se echa en falta; el nombre ya lo lleva el menú lateral. */}
        <Link
          href="/"
          aria-label="Ir al inicio"
          className="press hidden h-11 min-w-0 items-center gap-2 rounded-xl min-[420px]:flex md:hidden"
        >
          <span className="btn-accent flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-4 w-4 text-[#04110c]" aria-hidden="true">
              <rect x="3" y="5" width="18" height="14" rx="3" /><path d="M3 12h18" /><circle cx="12" cy="12" r="2.4" fill="currentColor" />
            </svg>
          </span>
          {/* truncate: es lo primero que cede si el saldo crece, y al llegar a
              cero deja el icono intacto en lugar de empujar la fila. */}
          <span className="truncate text-sm font-bold tracking-tight">Pokémon TCG</span>
        </Link>

        {/* El buscador es la herramienta principal de la app: en escritorio se
            le deja crecer con el ancho en vez de dejar un hueco muerto en medio
            de la barra. Y su rótulo se corta con puntos suspensivos en vez de
            pasar a dos líneas: entre 768 y 1024, con el menú lateral comiendo
            240px, le quedan ~200 y la barra crecía a 82px de alto. */}
        <div className="hidden min-w-0 flex-1 md:block md:max-w-md lg:max-w-lg xl:max-w-xl [&>button>span]:truncate">
          <GlobalSearch variant="bar" />
        </div>

        {/* ml-auto también en escritorio: sin él los controles quedaban pegados
            al buscador, con la mitad derecha de la barra vacía. Y es el único
            margen automático de la fila, para que el grupo quede a ras del
            borde: con otro en la marca, el espacio libre se repartía entre los
            dos y el avatar se quedaba a medio camino. */}
        <div className="ml-auto flex shrink-0 items-center gap-1 min-[360px]:gap-1.5 md:gap-2.5">
          {/* En móvil el buscador es un icono más de la fila de acciones: suelto
              entre la marca y el grupo flotaba en mitad de la barra.
              El disparador nace a 36px y aquí manda la regla de 44: se estira
              desde fuera porque el componente es de otra pieza y su tamaño sólo
              se queda corto dentro de esta barra. */}
          <div className="md:hidden [&>button]:h-11 [&>button]:w-11">
            <GlobalSearch />
          </div>

          {/* Monedas: dato, no botón. El icono no dice nada a un lector de
              pantalla, así que la etiqueta va en texto. */}
          <div className="chip flex h-10 shrink-0 items-center gap-1.5 px-2.5 min-[360px]:px-3 md:h-11 md:px-3.5">
            {/* Por debajo de 360px la moneda se cae: con buscador, recompensa,
                ajustes y avatar, esos 22px son justo los que separan la barra
                de desbordar la pantalla. Se sacrifica el adorno, nunca la
                cifra, y el lector de pantalla sigue oyendo "Monedas". */}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="accent hidden h-4 w-4 shrink-0 min-[360px]:block" aria-hidden="true">
              <circle cx="12" cy="12" r="9" /><path d="M12 16v-8M9 12h6" />
            </svg>
            <span className="sr-only">Monedas:</span>
            {/* tabular-nums + ancho mínimo: al pasar de "…" al saldo, y al
                cambiar de cifras, la barra no da un salto. */}
            <span className="min-w-[2.5ch] text-xs font-semibold tabular-nums md:text-sm">
              {loaded ? formatNumber(coins) : "…"}
            </span>
          </div>

          {/* Mismo estirón que el buscador: su botón nace a 34px de alto. */}
          <SignedIn>
            <div className="[&>button]:h-11">
              <DailyReward />
            </div>
          </SignedIn>

          <button
            onClick={() => setAjustesAbiertos(true)}
            aria-label="Ajustes"
            title="Ajustes"
            className="touch-target press btn-ghost flex h-11 w-11 items-center justify-center rounded-xl"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" aria-hidden="true">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>

          <SignedOut>
            <SignInButton mode="modal">
              {/* min-w-11: por debajo de sm el rótulo se oculta y el botón se
                  quedaba en 40px de ancho, por debajo de la zona táctil. */}
              <button className="btn-accent press flex h-11 min-w-11 items-center justify-center gap-2 rounded-xl px-3 text-xs md:px-4 md:text-sm">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                </svg>
                <span className="hidden sm:inline">Entrar</span>
              </button>
            </SignInButton>
          </SignedOut>

          <SignedIn>
            <div className="chip flex items-center justify-center p-1">
              <UserButton />
            </div>
          </SignedIn>
        </div>
      </div>

      {/* La hoja monta en portal: dentro de la cabecera no ocupa sitio. */}
      <SettingsSheet open={ajustesAbiertos} onClose={() => setAjustesAbiertos(false)} />
    </motion.header>
  );
}
