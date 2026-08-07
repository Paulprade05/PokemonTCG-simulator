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
import { ToastProvider } from "./ui/Toast";
import { useViewport } from "../hooks/useViewport";

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
  const { isKeyboardOpen } = useViewport();

  const setImmersive = useCallback((v: boolean) => setImmersiveState(v), []);
  const value = useMemo(
    () => ({ immersive, setImmersive }),
    [immersive, setImmersive],
  );

  return (
    <ShellContext.Provider value={value}>
      {/* framer no lee la media query de CSS: hay que decírselo aquí para que
          quien tenga "reducir movimiento" activo salte a los estados finales. */}
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <div className="min-h-dvh-app">
            <Sidebar />
            {/* Content column offset by sidebar on desktop */}
            <div className="md:pl-60">
              <TopBar />
              <main className="px-4 md:px-8 pt-6 pb-nav md:pb-12 max-w-7xl mx-auto w-full">
                {children}
              </main>
            </div>
            <BottomNav hidden={immersive || isKeyboardOpen} />
            {!immersive && <InstallPrompt />}
          </div>
        </ToastProvider>
      </MotionConfig>
    </ShellContext.Provider>
  );
}
