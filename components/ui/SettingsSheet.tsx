"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useUser } from "@clerk/nextjs";
import { setUserTheme } from "../../app/action";
import { useCurrency } from "../../hooks/useGameCurrency";
import { useHaptics } from "../../hooks/useHaptics";
import { STARTING_COINS } from "../../utils/constanst";
import {
  guardarAjustes,
  leerAjustes,
  suscribirseAjustes,
  type Ajustes,
} from "../../utils/settings";
import { clearCollection } from "../../utils/storage";
import ConfirmSheet from "./ConfirmSheet";
import Sheet from "./Sheet";
import { useToast } from "./Toast";

type Tema = "light" | "dark";

// Misma pareja de colores que ThemeToggle y el script de arranque: al cambiar
// el tema desde aquí, la barra del navegador debe acompañar al fondo igual.
const COLOR_BARRA: Record<Tema, string> = { light: "#f4efe4", dark: "#14120c" };

interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
}

function Seccion({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <section className="mt-5 first:mt-0">
      <h3 className="ink-faint px-1 pb-2 text-[11px] font-semibold uppercase tracking-[0.14em]">
        {titulo}
      </h3>
      {children}
    </section>
  );
}

interface FilaInterruptorProps {
  titulo: string;
  descripcion?: string;
  activo: boolean;
  onToggle: () => void;
}

function FilaInterruptor({ titulo, descripcion, activo, onToggle }: FilaInterruptorProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={activo}
      onClick={onToggle}
      className="touch-target flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--ink)_4%,transparent)]"
    >
      <span className="min-w-0">
        <span className="ink block text-[14px] font-medium">{titulo}</span>
        {descripcion && (
          <span className="ink-faint mt-0.5 block text-[12px] leading-snug">{descripcion}</span>
        )}
      </span>
      {/* La píldora es decorativa: el estado real lo anuncia aria-checked. */}
      <span
        aria-hidden="true"
        className="relative shrink-0 rounded-full"
        style={{
          width: 50,
          height: 30,
          background: activo
            ? "var(--accent)"
            : "color-mix(in srgb, var(--ink) 16%, transparent)",
          transition: "background-color .22s ease",
        }}
      >
        <span
          className="absolute top-1/2 -translate-y-1/2 rounded-full"
          style={{
            width: 24,
            height: 24,
            left: activo ? 23 : 3,
            // Blanco fijo: debe contrastar sobre el acento y sobre el gris en
            // los dos temas, como el pomo nativo de iOS.
            background: "#fff",
            boxShadow: "0 1px 3px rgba(0,0,0,.35)",
            transition: "left .22s cubic-bezier(0.16,1,0.3,1)",
          }}
        />
      </span>
    </button>
  );
}

const estiloOpcionTema = (activo: boolean): CSSProperties =>
  activo
    ? {
        background: "color-mix(in srgb, var(--accent) 14%, transparent)",
        border: "1px solid color-mix(in srgb, var(--accent) 32%, transparent)",
        color: "var(--accent)",
      }
    : { border: "1px solid transparent", color: "var(--ink-soft)" };

/**
 * Hoja de ajustes de la app: tema, sonido, vibración, efectos y datos locales.
 * Los ajustes viven en utils/settings.ts (localStorage) y el tema en el
 * atributo data-theme del <html>; aquí sólo se leen y se escriben esas fuentes,
 * sin estado paralelo que pueda desincronizarse.
 */
export default function SettingsSheet({ open, onClose }: SettingsSheetProps) {
  const { isSignedIn, isLoaded } = useUser();
  const { setCoins } = useCurrency();
  const toast = useToast();
  const haptic = useHaptics();

  const [ajustes, setAjustes] = useState<Ajustes>(() => leerAjustes());
  useEffect(() => suscribirseAjustes(setAjustes), []);

  // El tema se refleja observando el <html>: así el selector también se
  // actualiza si se cambia con el conmutador de la cabecera estando abierta.
  const [tema, setTema] = useState<Tema>("light");
  useEffect(() => {
    const leer = () =>
      setTema((document.documentElement.getAttribute("data-theme") as Tema) || "light");
    leer();
    const observador = new MutationObserver(leer);
    observador.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observador.disconnect();
  }, []);

  const cambiarTema = (t: Tema) => {
    if (t === tema) return;
    haptic("select");
    document.documentElement.setAttribute("data-theme", t);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", COLOR_BARRA[t]);
    try {
      localStorage.setItem("theme", t);
    } catch {}
    // La preferencia en la nube viaja por el mismo canal que usa ThemeToggle.
    if (isSignedIn) setUserTheme(t).catch(() => {});
  };

  const alternar = (clave: "sonido" | "hapticos" | "reducirEfectos") => {
    guardarAjustes({ [clave]: !ajustes[clave] });
    // El toque va después de guardar: al encender la vibración sirve de
    // demostración y al apagarla useHaptics ya queda en silencio.
    haptic("select");
  };

  const [confirmarBorrado, setConfirmarBorrado] = useState(false);
  const borrarDatosLocales = () => {
    clearCollection();
    // Reponer el saldo inicial equivale a empezar de cero: si sólo se borrara
    // la clave, el proveedor en memoria reescribiría el saldo viejo al persistir.
    setCoins(STARTING_COINS);
    toast("Datos de este dispositivo borrados", "success");
  };

  const porcentajeVolumen = Math.round(ajustes.volumen * 100);

  return (
    <>
      {/* Con la confirmación abierta, Escape debe cerrar sólo esa hoja: ambas
          escuchan la misma tecla y sin este freno se cerrarían las dos a la vez. */}
      <Sheet
        open={open}
        onClose={() => {
          if (!confirmarBorrado) onClose();
        }}
        label="Ajustes"
      >
        <div className="px-5 pb-8">
          <h2 className="ink pb-1 text-center text-[17px] font-semibold">Ajustes</h2>

          <Seccion titulo="Apariencia">
            <div
              className="surface rounded-2xl p-1.5"
              role="group"
              aria-label="Tema de la interfaz"
            >
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  aria-pressed={tema === "light"}
                  onClick={() => cambiarTema("light")}
                  className="touch-target press flex items-center justify-center gap-2 rounded-xl py-2.5 text-[13px] font-medium transition-colors"
                  style={estiloOpcionTema(tema === "light")}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
                  </svg>
                  Claro
                </button>
                <button
                  type="button"
                  aria-pressed={tema === "dark"}
                  onClick={() => cambiarTema("dark")}
                  className="touch-target press flex items-center justify-center gap-2 rounded-xl py-2.5 text-[13px] font-medium transition-colors"
                  style={estiloOpcionTema(tema === "dark")}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
                  </svg>
                  Oscuro
                </button>
              </div>
            </div>
          </Seccion>

          <Seccion titulo="Sonido">
            <div className="surface overflow-hidden rounded-2xl">
              <FilaInterruptor
                titulo="Efectos de sonido"
                descripcion="Apertura de sobres y avisos de la interfaz"
                activo={ajustes.sonido}
                onToggle={() => alternar("sonido")}
              />
              <div className="flex items-center gap-3 border-t border-[var(--border)] px-4 py-1.5">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="ink-faint h-[18px] w-[18px] shrink-0" aria-hidden="true">
                  <path d="M11 5 6 9H2v6h4l5 4z" />
                  <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />
                </svg>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={ajustes.volumen}
                  disabled={!ajustes.sonido}
                  aria-label="Volumen"
                  onChange={(e) => guardarAjustes({ volumen: Number(e.target.value) })}
                  className="ajustes-rango min-w-0 flex-1"
                  style={{ "--_lleno": `${porcentajeVolumen}%` } as CSSProperties}
                />
                <span
                  className={`w-10 shrink-0 text-right text-[12px] font-medium tabular-nums ${
                    ajustes.sonido ? "ink-soft" : "ink-faint"
                  }`}
                >
                  {porcentajeVolumen}%
                </span>
              </div>
            </div>
          </Seccion>

          <Seccion titulo="Vibración">
            <div className="surface overflow-hidden rounded-2xl">
              <FilaInterruptor
                titulo="Respuesta háptica"
                descripcion="Vibración breve al tocar y al abrir sobres"
                activo={ajustes.hapticos}
                onToggle={() => alternar("hapticos")}
              />
            </div>
          </Seccion>

          <Seccion titulo="Efectos">
            <div className="surface overflow-hidden rounded-2xl">
              <FilaInterruptor
                titulo="Reducir efectos visuales"
                descripcion="Menos brillos, auras y animaciones pesadas"
                activo={ajustes.reducirEfectos}
                onToggle={() => alternar("reducirEfectos")}
              />
            </div>
          </Seccion>

          {/* Hasta saber si hay sesión no se pinta nada: evita ofrecer el
              borrado local a un usuario que en realidad tiene cuenta. */}
          {isLoaded && (
            <Seccion titulo="Datos">
              <div className="surface overflow-hidden rounded-2xl">
                {isSignedIn ? (
                  <div className="flex items-start gap-3 px-4 py-3.5">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="accent mt-0.5 h-[18px] w-[18px] shrink-0" aria-hidden="true">
                      <path d="M17.5 19a4.5 4.5 0 0 0 .42-8.98 7 7 0 0 0-13.6 1.8A4 4 0 0 0 6 19z" />
                    </svg>
                    <p className="ink-soft text-[13px] leading-relaxed">
                      Tu colección y tus monedas se guardan en la nube con tu
                      cuenta, disponibles en cualquier dispositivo.
                    </p>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmarBorrado(true)}
                    className="touch-target flex w-full items-center gap-3 px-4 py-3.5 text-left text-[14px] font-medium transition-colors hover:bg-[color-mix(in_srgb,var(--danger)_6%,transparent)]"
                    style={{ color: "var(--danger)" }}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px] shrink-0" aria-hidden="true">
                      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6M14 11v6" />
                    </svg>
                    Borrar datos de este dispositivo
                  </button>
                )}
              </div>
            </Seccion>
          )}

          <Seccion titulo="Acerca de">
            <div className="surface flex items-center gap-3 rounded-2xl px-4 py-3.5">
              <div className="btn-accent flex h-9 w-9 shrink-0 items-center justify-center rounded-xl">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-5 w-5 text-[#04110c]" aria-hidden="true">
                  <rect x="3" y="5" width="18" height="14" rx="3" />
                  <path d="M3 12h18" />
                  <circle cx="12" cy="12" r="2.4" fill="currentColor" />
                </svg>
              </div>
              <div className="min-w-0">
                <p className="ink text-[14px] leading-tight font-semibold">
                  Pokémon TCG Simulator
                </p>
                <p className="ink-faint mt-0.5 text-[12px]">
                  Datos e imágenes de pokemontcg.io
                </p>
              </div>
            </div>
          </Seccion>
        </div>

        {/* Los pseudoelementos del deslizador no se pueden estilar en línea y
            globals.css pertenece a otra pieza: el estilo viaja con la hoja. */}
        <style>{`
          .ajustes-rango{
            -webkit-appearance:none; appearance:none;
            height:44px; background:transparent; cursor:pointer;
          }
          .ajustes-rango:disabled{ opacity:.35; cursor:default; }
          .ajustes-rango::-webkit-slider-runnable-track{
            height:6px; border-radius:999px;
            background:linear-gradient(to right,
              var(--accent) 0%, var(--accent) var(--_lleno),
              color-mix(in srgb, var(--ink) 14%, transparent) var(--_lleno),
              color-mix(in srgb, var(--ink) 14%, transparent) 100%);
          }
          .ajustes-rango::-webkit-slider-thumb{
            -webkit-appearance:none; appearance:none;
            width:24px; height:24px; margin-top:-9px; border-radius:999px;
            background:#fff; border:1px solid var(--border-strong);
            box-shadow:0 1px 4px rgba(0,0,0,.3);
          }
          .ajustes-rango::-moz-range-track{
            height:6px; border-radius:999px;
            background:color-mix(in srgb, var(--ink) 14%, transparent);
          }
          .ajustes-rango::-moz-range-progress{
            height:6px; border-radius:999px; background:var(--accent);
          }
          .ajustes-rango::-moz-range-thumb{
            width:24px; height:24px; border-radius:999px;
            background:#fff; border:1px solid var(--border-strong);
            box-shadow:0 1px 4px rgba(0,0,0,.3);
          }
          .ajustes-rango:focus-visible{
            outline:2px solid var(--accent); outline-offset:4px; border-radius:999px;
          }
        `}</style>
      </Sheet>

      <ConfirmSheet
        open={confirmarBorrado}
        onClose={() => setConfirmarBorrado(false)}
        title="¿Borrar los datos locales?"
        description="Se eliminarán la colección y las monedas guardadas en este dispositivo. Esta acción no se puede deshacer."
        confirmLabel="Borrar datos"
        cancelLabel="Cancelar"
        destructive
        onConfirm={borrarDatosLocales}
      />
    </>
  );
}
