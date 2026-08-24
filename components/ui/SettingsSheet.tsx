"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useUser } from "@clerk/nextjs";
import { getUserLang, getUserTheme, setUserLang, setUserTheme } from "../../app/action";
import { useCurrency } from "../../hooks/useGameCurrency";
import { useHaptics } from "../../hooks/useHaptics";
import { STARTING_COINS } from "../../utils/constanst";
import {
  aplicarIdioma,
  guardarAjustes,
  leerAjustes,
  leerIdioma,
  suscribirseAjustes,
  type Ajustes,
  type Idioma,
} from "../../utils/settings";
import { clearCollection } from "../../utils/storage";
import ConfirmSheet from "./ConfirmSheet";
import Sheet from "./Sheet";
import { useToast } from "./Toast";

type Tema = "light" | "dark";

// El tema lo elige el usuario con data-theme, no prefers-color-scheme, así que
// la etiqueta theme-color no puede declararse por media query: se reescribe a
// mano para que la barra del navegador acompañe al fondo (--bg de globals.css).
// Aquí es donde vive ya el único selector de tema; el otro sitio con estos dos
// valores es el script antiparpadeo de app/layout.tsx, que corre sin bundle.
const COLOR_BARRA: Record<Tema, string> = { light: "#f4efe4", dark: "#14120c" };

/**
 * Escribe el tema en las tres fuentes que lo leen: el atributo que pinta el
 * CSS, la meta que colorea la barra del navegador y localStorage, de donde lo
 * recupera el script de arranque en la siguiente carga.
 */
const aplicarTema = (t: Tema) => {
  document.documentElement.setAttribute("data-theme", t);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", COLOR_BARRA[t]);
  try {
    localStorage.setItem("theme", t);
  } catch {}
};

// Hay dos hojas montadas a la vez (la de la cabecera y la del menú lateral):
// sin este cerrojo de módulo, compartido por ambas, la preferencia de la cuenta
// se consultaría por duplicado en cada carga.
let temaDeLaNubeConsultado = false;
// El idioma tiene el suyo por lo mismo, y aquí duele más: consultarlo dos veces
// podría disparar dos recargas.
let idiomaDeLaNubeConsultado = false;

/**
 * Cambia el idioma de las cartas y RECARGA.
 *
 * POR QUÉ RECARGA: el tema es CSS y reacciona solo, pero los nombres y las
 * ilustraciones los traduce el servidor (la cookie que escribe `aplicarIdioma`
 * es lo que lee). Las cartas que ya están en pantalla —colección, álbum, sobre
 * a medio abrir, tablón del mercado— vinieron con el idioma anterior y no hay
 * forma de refrescarlas sin que cada pantalla se suscriba a un evento y vuelva
 * a pedir sus datos: doce sitios donde olvidarse de uno. Una recarga las deja
 * todas coherentes de una vez, y como la cookie ya está escrita, la página
 * vuelve directamente en el idioma nuevo. Cambiar de idioma es raro; una
 * pantalla a medias en dos idiomas, imperdonable.
 */
const cambiarIdiomaYRecargar = (idioma: Idioma, conSesion: boolean) => {
  aplicarIdioma(idioma);
  const recargar = () => window.location.reload();
  if (!conSesion) {
    recargar();
    return;
  }
  // Con sesión se guarda antes en la nube, para que el resto de dispositivos lo
  // hereden. Si la red falla, se recarga igual: la preferencia del dispositivo
  // ya está escrita y es la que manda en éste.
  setUserLang(idioma).catch(() => {}).then(recargar);
};

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

/** Estilo de una opción de segmento (tema, idioma): activa o apagada. */
const estiloOpcion = (activo: boolean): CSSProperties =>
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

  // El tema se refleja observando el <html>: así el selector se actualiza sea
  // quien sea el que cambie el atributo (la otra hoja montada, la preferencia
  // que llega de la cuenta o el script de arranque), sin estado paralelo.
  const [tema, setTema] = useState<Tema>("light");
  // El idioma se refleja igual y por el mismo motivo: la otra hoja montada, o
  // la preferencia que llega de la cuenta, pueden cambiarlo por debajo.
  const [idioma, setIdioma] = useState<Idioma>("en");
  useEffect(() => {
    const leer = () => {
      setTema((document.documentElement.getAttribute("data-theme") as Tema) || "light");
      setIdioma(leerIdioma());
    };
    leer();
    const observador = new MutationObserver(leer);
    observador.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-idioma"],
    });
    return () => observador.disconnect();
  }, []);

  // Con sesión, la preferencia de la cuenta manda sobre la del dispositivo: el
  // script de arranque sólo conoce localStorage, así que al entrar desde otro
  // navegador el tema se corrige aquí en cuanto Clerk confirma la identidad.
  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      // Al cerrar sesión se rearma: si luego entra otra cuenta, se vuelve a leer.
      temaDeLaNubeConsultado = false;
      return;
    }
    if (temaDeLaNubeConsultado) return;
    temaDeLaNubeConsultado = true;
    getUserTheme()
      // Sin catch, un fallo de red dejaba una promesa rechazada sin gestionar.
      .catch(() => null)
      .then((t) => {
        if (t && t !== document.documentElement.getAttribute("data-theme")) aplicarTema(t);
      });
  }, [isLoaded, isSignedIn]);

  // Mismo trato que el tema: el script de arranque sólo conoce este navegador,
  // así que al entrar desde otro dispositivo la preferencia de la cuenta se
  // impone aquí en cuanto Clerk confirma la identidad. Si difiere hay recarga
  // (las cartas ya pintadas vinieron en el idioma equivocado); si coincide no
  // pasa nada, así que no hay bucle posible.
  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      idiomaDeLaNubeConsultado = false;
      return;
    }
    if (idiomaDeLaNubeConsultado) return;
    idiomaDeLaNubeConsultado = true;
    getUserLang()
      .catch(() => null)
      .then((l) => {
        if (l && l !== leerIdioma()) {
          aplicarIdioma(l);
          window.location.reload();
        }
      });
  }, [isLoaded, isSignedIn]);

  const cambiarTema = (t: Tema) => {
    if (t === tema) return;
    haptic("select");
    aplicarTema(t);
    // Y en la nube, para que el resto de dispositivos de la cuenta lo hereden.
    if (isSignedIn) setUserTheme(t).catch(() => {});
  };

  const cambiarIdioma = (i: Idioma) => {
    if (i === idioma) return;
    haptic("select");
    cambiarIdiomaYRecargar(i, Boolean(isSignedIn));
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
                  style={estiloOpcion(tema === "light")}
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
                  style={estiloOpcion(tema === "dark")}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
                  </svg>
                  Oscuro
                </button>
              </div>
            </div>
          </Seccion>

          <Seccion titulo="Idioma de las cartas">
            <div className="surface overflow-hidden rounded-2xl">
              <div className="p-1.5" role="group" aria-label="Idioma de las cartas">
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    aria-pressed={idioma === "en"}
                    onClick={() => cambiarIdioma("en")}
                    className="touch-target press flex items-center justify-center gap-2 rounded-xl py-2.5 text-[13px] font-medium transition-colors"
                    style={estiloOpcion(idioma === "en")}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
                    </svg>
                    Inglés
                  </button>
                  <button
                    type="button"
                    aria-pressed={idioma === "es"}
                    onClick={() => cambiarIdioma("es")}
                    className="touch-target press flex items-center justify-center gap-2 rounded-xl py-2.5 text-[13px] font-medium transition-colors"
                    style={estiloOpcion(idioma === "es")}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
                    </svg>
                    Español
                  </button>
                </div>
              </div>
              {/* Sin promesas de más: hay expansiones enteras sin ilustración
                  española y detalles que sólo existen en inglés. */}
              <p className="ink-faint border-t border-[var(--border)] px-4 py-3 text-[12px] leading-relaxed">
                En español verás el nombre y, donde exista, la ilustración
                española de la carta. Algunas expansiones (promos, Galerías de
                Entrenadores, Shiny Vault) sólo tienen ilustración en inglés, y
                el texto de ambientación, el ilustrador y la rareza se quedan
                siempre en inglés. Al cambiarlo se recarga la página.
              </p>
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
