"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { MotionConfig } from "framer-motion";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import BottomNav from "./BottomNav";
import InstallPrompt from "./pwa/InstallPrompt";
import ServiceWorkerRegister from "./pwa/ServiceWorkerRegister";
import { ToastProvider } from "./ui/Toast";
import EdgeBackGesture from "./ui/EdgeBackGesture";
import { useKeyboardOpen } from "../hooks/useViewport";
import { CurrencyProvider } from "../hooks/useGameCurrency";
import { SocialPendientesProvider } from "../hooks/useSocialPendientes";
import { FichaEntrenadorGlobal } from "./social/FichaEntrenadorSheet";
import InvitacionPendiente from "./social/InvitacionPendiente";
import { leerAjustes, suscribirseAjustes, type Ajustes } from "../utils/settings";

interface ShellContextValue {
  /** Oculta el cromo para las vistas a pantalla completa. */
  immersive: boolean;
  setImmersive: (value: boolean) => void;
}

const ShellContext = createContext<ShellContextValue>({
  immersive: false,
  setImmersive: () => {},
});

export const useShell = () => useContext(ShellContext);

/**
 * Pide modo inmersivo mientras el componente esté montado y `active` sea true.
 * La limpieza devuelve el cromo, así que navegar fuera lo restaura solo.
 */
export function useImmersive(active: boolean) {
  const { setImmersive } = useShell();
  useEffect(() => {
    setImmersive(active);
    return () => setImmersive(false);
  }, [active, setImmersive]);
}

export default function AppShell({ children }: { children: ReactNode }) {
  const [immersive, setImmersiveState] = useState(false);
  /* Sólo el booleano, no las medidas enteras: el visualViewport dispara
   * `scroll` con cada desplazamiento del dedo en iOS y con `useViewport()` este
   * componente —y con él Sidebar, TopBar y BottomNav— se repintaba en cada uno.
   * useKeyboardOpen sólo avisa cuando el teclado aparece o se va. */
  const isKeyboardOpen = useKeyboardOpen();

  /* "REDUCIR EFECTOS", EL AJUSTE PROPIO DE LA APP, APLICADO A TODA LA APP.
   *
   * De los treinta ficheros con framer-motion sólo seis leían
   * `ajustes.reducirEfectos`; el resto sólo obedecía a la preferencia del
   * sistema, así que el interruptor de la hoja de ajustes apagaba el confeti
   * de la apertura y poco más. Aquí se resuelve de una vez para todos:
   *
   *  · MotionConfig con reducedMotion="always" hace que framer descarte los
   *    transforms y deje sólo los fundidos, en TODOS los motion.* que cuelgan
   *    de la cáscara, sin que ninguno tenga que leer el ajuste. Con el ajuste
   *    apagado vuelve a "user", que es respetar la preferencia del sistema.
   *
   *  · `data-efectos="off"` en <html> es el mismo interruptor para el CSS:
   *    las animaciones y transiciones declaradas en hojas de estilo no pasan
   *    por framer. La regla que lo consume vive en app/globals.css (al lado
   *    de la media query de prefers-reduced-motion, que es su gemela); aquí
   *    sólo se escribe el atributo. El nombre es ese, `data-efectos`, con el
   *    valor `off`; ausente cuando el ajuste está apagado.
   *
   * Se lee en un efecto y no en el useState inicial: leer localStorage durante
   * el render daría un HTML distinto al del servidor y rompería la hidratación.
   * El primer fotograma sale con los efectos encendidos y se corrige antes de
   * que nada se mueva. */
  const [efectosApagados, setEfectosApagados] = useState(false);
  useEffect(() => {
    const aplicar = (a: Ajustes) => setEfectosApagados(a.reducirEfectos);
    aplicar(leerAjustes());
    return suscribirseAjustes(aplicar);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (efectosApagados) root.setAttribute("data-efectos", "off");
    else root.removeAttribute("data-efectos");
  }, [efectosApagados]);

  const setImmersive = useCallback((v: boolean) => setImmersiveState(v), []);
  const value = useMemo(
    () => ({ immersive, setImmersive }),
    [immersive, setImmersive],
  );

  return (
    <ShellContext.Provider value={value}>
      {/* framer no lee la media query de CSS: hay que decírselo aquí para que
          quien tenga "reducir movimiento" activo salte a los estados finales.
          Y "always" cuando lo pide el ajuste propio de la app (ver arriba). */}
      <MotionConfig reducedMotion={efectosApagados ? "always" : "user"}>
        <ToastProvider>
          {/* Vive aquí y no en app/layout.tsx porque AVISA: cuando hay una
              versión nueva (o este cliente ha caducado) pinta su propia tira
              persistente con "Actualizar", que no se va sola como un Toast, y
              necesita el contexto de AppShell para saber si hay una apertura a
              pantalla completa delante. */}
          <ServiceWorkerRegister />
          {/* El saldo vive aquí para que la barra superior, la home, la
              colección y la recompensa diaria compartan el mismo número. */}
          <CurrencyProvider>
          {/* Lo que hay esperando en Social (peticiones y ofertas), una vez
              para toda la cáscara: lo leen la barra de pestañas y el menú
              lateral para su insignia, y /friends lo pone al día tras cada
              acción. Va aquí arriba para que las dos barras lo compartan. */}
          <SocialPendientesProvider>
          {/* En modo inmersivo (apertura de sobres) el resto de la app queda
              inerte: ni foco de teclado ni lector de pantalla pueden escaparse
              a lo que hay detrás de la capa. Los avisos de Toast viven fuera
              de este div (son hermanos, arriba), así que siguen anunciándose. */}
          <div className="min-h-dvh-app" inert={immersive || undefined}>
            <Sidebar />
            {/* Content column offset by sidebar on desktop */}
            <div className="md:pl-60">
              <TopBar />
              {/* El hueco inferior lo pone SÓLO `pb-nav`. Llevaba además un
                  `md:pb-12` que nunca ha pintado nada: globals.css declara
                  .pb-nav después de las utilidades de Tailwind y dentro de la
                  misma capa, así que gana por orden de cascada y cualquier
                  md:pb-* encima es letra muerta —está explicado allí, junto a la
                  media query que baja --content-bottom en escritorio, que es
                  donde de verdad se corrige—. Se quita para que nadie lo lea
                  como que en escritorio manda otra cosa. */}
              {/* `isolate`: EL CONTENIDO VIVE EN SU PROPIO CONTEXTO DE APILADO.
               *
               * Sin él no había NADA entre <body> y las cartas que creara uno
               * (app/template.tsx queda en reposo con `transform: none`), así
               * que cualquier `z-30` de una página competía en la raíz con la
               * barra superior, que también es z-30, y a igual z-index gana lo
               * que va después en el DOM: la página. Al desplazar una rejilla,
               * las chapas de las cartas (contador de copias, corazón de
               * favorita, nota de graduación, marcas de desgaste) pasaban POR
               * ENCIMA de la barra, tapaban el saldo y además se quedaban con
               * el toque que iba para la lupa o los ajustes.
               *
               * Con esto los z-index de las páginas son locales: pueden usar
               * los que quieran entre ellos y el bloque entero queda por debajo
               * del cromo (barra superior 30, pestañas 40, aviso de instalar
               * 50). La escala completa está escrita en app/globals.css.
               *
               * POR QUÉ ES SEGURO: `isolation: isolate` no es transform, ni
               * filter, ni perspective, ni will-change —no promociona capa, así
               * que no toca la nitidez de las cartas en WebKit—, no cambia el
               * bloque contenedor de los `fixed` y no afecta a los `sticky`.
               * Y nada de lo que tiene que salir por encima del cromo vive
               * aquí dentro: hojas, ficha, zoom, buscador, intercambio y
               * apertura de sobre cuelgan de <body> por Portal. La barra de
               * coste de la graduación (sticky z-40) sí vive aquí, y está bien
               * que quede por debajo: se ancla POR ENCIMA de la barra de
               * pestañas, no se solapa con ella, y dentro de la página sigue
               * ganando a todo lo demás.
               *
               * Si algún día una capa de página tiene que tapar el cromo, la
               * salida es un Portal, no subirle el z-index: aquí dentro ya no
               * hay número que valga.
               *
               * LOS LADOS, CON EL RECORTE DE LA PANTALLA: en apaisado el notch
               * se va a un lado y con `px-4` fijo la primera columna de
               * cualquier rejilla quedaba debajo. Mismo max() que la barra
               * superior: sin inset siguen siendo los 16px (32 en escritorio)
               * de siempre. */}
              <main className="isolate pl-[max(var(--sal),1rem)] pr-[max(var(--sar),1rem)] md:pl-[max(var(--sal),2rem)] md:pr-[max(var(--sar),2rem)] pt-6 pb-nav max-w-7xl mx-auto w-full">
                {children}
              </main>
            </div>
            <BottomNav hidden={immersive || isKeyboardOpen} />
            <EdgeBackGesture disabled={immersive} />
            {/* Con el teclado abierto se esconde (no se desmonta: perdería la
                cuenta atrás de iOS): la barra de pestañas se ha retirado y el
                aviso se quedaría flotando sobre el campo en el que se escribe. */}
            {!immersive && <InstallPrompt oculto={isKeyboardOpen} />}
            {/* Dos piezas del flujo de amigos que no son de ninguna pantalla:
                la que devuelve a una invitación cuando aparece la sesión (no
                pinta nada), y la hoja con la ficha de un entrenador, que es
                UNA para toda la app y se abre desde cualquier sitio (hoy, el
                vendedor de un anuncio del bazar). Las dos salen por Portal o
                no pintan, así que su sitio aquí no afecta al apilado. */}
            <InvitacionPendiente />
            <FichaEntrenadorGlobal />
          </div>
          </SocialPendientesProvider>
          </CurrencyProvider>
        </ToastProvider>
      </MotionConfig>
    </ShellContext.Provider>
  );
}
