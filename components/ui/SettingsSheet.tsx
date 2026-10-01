"use client";

import {
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useUser } from "@clerk/nextjs";
import { getUserLang, getUserTheme, setUserLang, setUserTheme } from "../../app/action";
import { useCurrency } from "../../hooks/useGameCurrency";
import { useIdentidad } from "../../hooks/useIdentidad";
import { hayVibracion, useHaptics } from "../../hooks/useHaptics";
import { limpiarArchivadorLocal } from "../../utils/archivadorLocal";
import { STARTING_COINS } from "../../utils/constanst";
import {
  aplicarIdioma,
  hayIdiomaDeDispositivo,
  guardarAjustes,
  leerAjustes,
  leerIdioma,
  suscribirseAjustes,
  type Ajustes,
  type Idioma,
} from "../../utils/settings";
import { CLAVES_DE_QUIEN_JUEGA } from "../../utils/identidad";
import { borrarLocal } from "../../utils/almacen";
import { isIOS, isSafari, isStandaloneDisplay } from "../../utils/platform";
import { clearCollection } from "../../utils/storage";
import {
  EVENTO_APERTURA_RAPIDA,
  guardarAperturaRapida,
  leerAperturaRapida,
} from "../tienda/memoria";
import {
  BUILD_ID,
  buscarActualizacionYRecargar,
  versionDelServiceWorker,
} from "../../utils/versionApp";
import { IconoMarca, IconoRefrescar } from "../icons";
import CabeceraDeHoja from "./CabeceraDeHoja";
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

/** Que el dispositivo vibre o no no cambia mientras la página vive: no hay nada
 *  a lo que suscribirse. Es una constante de módulo porque useSyncExternalStore
 *  se vuelve a suscribir cada vez que cambia la identidad de esta función. */
const sinSuscripcion = () => () => {};

/** La apertura rápida avisa con un evento cuando cambia (la portada pinta el
 *  mismo interruptor): con esto las dos copias se mueven a la vez. */
const suscribirseAperturaRapida = (alCambiar: () => void) => {
  window.addEventListener(EVENTO_APERTURA_RAPIDA, alCambiar);
  return () => window.removeEventListener(EVENTO_APERTURA_RAPIDA, alCambiar);
};

/** Safari SIN instalar: es donde lo que guarda un sitio caduca a los siete días
 *  sin uso. La app instalada y los demás navegadores no tienen ese plazo. */
const esSafariSinInstalar = () => (isIOS() || isSafari()) && !isStandaloneDisplay();

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
      <h3 className="ink-soft t-etiqueta px-1 pb-2">
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
        <span className="ink block t-cuerpo font-medium">{titulo}</span>
        {descripcion && (
          <span className="ink-faint mt-0.5 block t-cuerpo-2 leading-snug">{descripcion}</span>
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
          transition: "background-color var(--d-base) var(--ease-out)",
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
            // SOMBRA A MANO, Y NO ES UN OLVIDO DEL BARRIDO: --shadow-sm cambia
            // con el tema porque está calculada para una superficie que también
            // cambia, y este pomo es blanco fijo en los dos. En tema claro esa
            // sombra es marrón al 7% y bajo un pomo blanco sobre el verde del
            // acento no se vería: el pomo perdería su borde. Se queda el negro
            // al 35%, que es lo único que le da relieve en los dos temas.
            boxShadow: "0 1px 3px rgba(0,0,0,.35)",
            // Los .22s y la curva escritos a mano eran una copia de --d-base y
            // --ease-out; aquí sí se pueden leer las variables porque esto es
            // CSS de verdad, no framer.
            transition: "left var(--d-base) var(--ease-out)",
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
        // --ok y no --accent: el rótulo de la opción activa es TEXTO, y el verde
        // del acento sobre este relleno al 14% se queda en 2,2:1 en tema claro.
        // --ok es la pareja legible del mismo verde y no cambia el fondo.
        color: "var(--ok)",
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
  /* QUIÉN MIRA, también sin red (utils/identidad.ts). `isLoaded` sigue mandando
   * en lo que NECESITA a Clerk —leer y guardar el tema y el idioma de la
   * cuenta—; la identidad decide lo que se enseña. Con `isLoaded` a secas, sin
   * conexión el idioma se quedaba con los dos botones apagados y la sección
   * Datos no salía nunca, también para el invitado, que no depende de Clerk
   * para nada. */
  const identidad = useIdentidad();
  /** Cuenta confirmada o invitado: se sabe con quién se habla. */
  const identidadFirme = identidad === "cuenta" || identidad === "invitado";
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
    /* MANDA EL DISPOSITIVO SI AQUÍ SE HA ELEGIDO ALGO.
     *
     * Antes la cuenta se imponía SIEMPRE, y eso era lo que hacía que poner
     * español no "cuajara": bastaba con que `users.lang` siguiera en "en"
     * —porque el guardado no llegó a salir, ver `cambiarIdioma`— para que al
     * recargar este efecto leyera "en", lo aplicara y RECARGARA otra vez,
     * dejando la app en inglés. Y como `aplicarIdioma` también escribe
     * localStorage, la vuelta atrás quedaba grabada: el español no volvía ni
     * insistiendo.
     *
     * La regla correcta es la que espera cualquiera: la preferencia de la
     * cuenta SIEMBRA un dispositivo que no ha elegido nada (entrar desde otro
     * navegador), pero no pisa una elección hecha aquí. */
    if (hayIdiomaDeDispositivo()) return;
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
    // `isLoaded` importa: con Clerk sin resolver, `isSignedIn` es undefined y la
    // preferencia no llegaría a guardarse nunca en la cuenta.
    if (isLoaded && isSignedIn) setUserTheme(t).catch(() => {});
  };

  /**
   * ESPERA A CLERK ANTES DE DECIDIR SI HAY SESIÓN.
   *
   * `Boolean(isSignedIn)` con Clerk a medio cargar da `false`, así que a un
   * usuario con sesión se le trataba como invitado: se le escribía la cookie y
   * se recargaba, pero `setUserLang` no llegaba a llamarse y `users.lang` se
   * quedaba en el idioma viejo. Combinado con el efecto de sincronización de
   * arriba —que antes hacía ganar siempre a la cuenta— el resultado era que
   * poner español no servía de nada: la página volvía sola a inglés.
   *
   * Los botones están desactivados mientras la identidad no es firme, así que
   * esta guarda es el segundo cerrojo, no el único. Firme es "cuenta" o
   * "invitado": a una cuenta sin red no se la trata como invitado —sería el
   * mismo fallo de arriba—, pero al invitado sin red sí se le deja cambiar.
   */
  const cambiarIdioma = (i: Idioma) => {
    if (!identidadFirme) return;
    if (i === idioma) return;
    haptic("select");
    cambiarIdiomaYRecargar(i, identidad === "cuenta");
  };

  const alternar = (clave: "sonido" | "hapticos" | "reducirEfectos") => {
    guardarAjustes({ [clave]: !ajustes[clave] });
    // El toque va después de guardar: al encender la vibración sirve de
    // demostración y al apagarla useHaptics ya queda en silencio.
    haptic("select");
  };

  const [confirmarBorrado, setConfirmarBorrado] = useState(false);
  const borrarDatosLocales = () => {
    // La vitrina del invitado también: si se quedara, tras borrar habría
    // "20 fundas ocupadas" con 20 huecos en blanco y ninguna carta. Va ANTES
    // que la colección porque `clearCollection` es quien avisa del cambio: quien
    // escuche ese aviso y relea, que encuentre ya las dos cosas vacías.
    limpiarArchivadorLocal();
    clearCollection();
    // Y lo que la app recuerda de quien juega (búsquedas recientes, filtros de
    // la colección): "borrar mis datos" que deja mis búsquedas no es borrar.
    for (const clave of CLAVES_DE_QUIEN_JUEGA) borrarLocal(clave);
    // Reponer el saldo inicial equivale a empezar de cero: si sólo se borrara
    // la clave, el proveedor en memoria reescribiría el saldo viejo al persistir.
    setCoins(STARTING_COINS);
    toast("Datos de este dispositivo borrados", "success");
  };

  /* LA VIBRACIÓN SÓLO SE OFRECE DONDE EXISTE. Safari en iOS no implementa
   * `navigator.vibrate`, así que en un iPhone —el dispositivo principal de la
   * app— el interruptor "Respuesta háptica" se encendía y se apagaba sin que
   * pasara nada: un ajuste que promete algo que no ocurre. Se lee con
   * useSyncExternalStore y no directamente en el render porque el servidor no
   * tiene `navigator`: así el servidor y la hidratación dicen "no" los dos, y
   * la respuesta de verdad entra justo después, sin desajuste. */
  const puedeVibrar = useSyncExternalStore(sinSuscripcion, hayVibracion, () => false);

  /* SALTAR LA ANIMACIÓN DEL SOBRE. El interruptor nació en la tienda, dentro de
   * una expansión, que es donde se usa; pero un ajuste que cambia cómo se
   * comporta la app se busca en Ajustes, y aquí no estaba. Es la misma
   * preferencia (components/tienda/memoria.ts), no una copia: se lee del mismo
   * sitio y el evento mantiene las dos filas de acuerdo. Con
   * useSyncExternalStore, como la vibración: el servidor dice "no" y el valor
   * de verdad entra tras hidratar, sin desajuste. */
  const aperturaRapida = useSyncExternalStore(
    suscribirseAperturaRapida,
    leerAperturaRapida,
    () => false,
  );
  const avisoDeSafari = useSyncExternalStore(sinSuscripcion, esSafariSinInstalar, () => false);

  /* QUÉ VERSIÓN CORRE Y CÓMO RECARGARLA. En la app instalada no hay barra de
   * direcciones ni gesto de recargar: si algo se quedaba raro tras un
   * despliegue, la única salida era matar la app desde el selector, que mucha
   * gente no sabe hacer. Y cuando alguien cuenta un fallo, no había forma de
   * saber con qué versión lo estaba viendo.
   *
   * La versión del service worker se pregunta al abrir la hoja, no al montar:
   * hay dos hojas montadas a la vez y casi nunca se abre ninguna. */
  const [versionSw, setVersionSw] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let vigente = true;
    versionDelServiceWorker().then((v) => {
      if (vigente) setVersionSw(v);
    });
    return () => {
      vigente = false;
    };
  }, [open]);
  const [buscandoVersion, setBuscandoVersion] = useState(false);
  const recargar = () => {
    if (buscandoVersion) return;
    haptic("select");
    setBuscandoVersion(true);
    // No hace falta volver a poner el estado en false: lo siguiente que ocurre
    // es la recarga de la página.
    buscarActualizacionYRecargar();
  };
  // Siete caracteres, como el hash corto de git: lo que cabe en un mensaje.
  const versionVisible = [
    BUILD_ID ? `Versión ${BUILD_ID.slice(0, 7)}` : null,
    versionSw ? `caché ${versionSw}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

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
          {/* `pb-1`: la primera <Seccion> lleva `first:mt-0`, así que sin este
              respiro el rótulo "APARIENCIA" queda pegado al título. */}
          <CabeceraDeHoja titulo="Ajustes" className="pb-1" />

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
                  className="touch-target press flex items-center justify-center gap-2 rounded-xl py-2.5 t-cuerpo-2 font-medium transition-colors"
                  style={estiloOpcion(tema === "light")}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
                  </svg>
                  Claro
                </button>
                <button
                  type="button"
                  aria-pressed={tema === "dark"}
                  onClick={() => cambiarTema("dark")}
                  className="touch-target press flex items-center justify-center gap-2 rounded-xl py-2.5 t-cuerpo-2 font-medium transition-colors"
                  style={estiloOpcion(tema === "dark")}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
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
                    disabled={!identidadFirme}
                    onClick={() => cambiarIdioma("en")}
                    className="touch-target press flex items-center justify-center gap-2 rounded-xl py-2.5 t-cuerpo-2 font-medium transition-colors"
                    style={estiloOpcion(idioma === "en")}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
                    </svg>
                    Inglés
                  </button>
                  <button
                    type="button"
                    aria-pressed={idioma === "es"}
                    disabled={!identidadFirme}
                    onClick={() => cambiarIdioma("es")}
                    className="touch-target press flex items-center justify-center gap-2 rounded-xl py-2.5 t-cuerpo-2 font-medium transition-colors"
                    style={estiloOpcion(idioma === "es")}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
                    </svg>
                    Español
                  </button>
                </div>
              </div>
              {/* Sin promesas de más: hay expansiones enteras sin ilustración
                  española y detalles que sólo existen en inglés. */}
              <p className="ink-faint border-t border-[var(--border)] px-4 py-3 t-cuerpo-2 leading-relaxed">
                En español verás el nombre y, donde exista, la ilustración
                española de la carta. Las expansiones recién salidas tardan un
                tiempo en traducirse y se ven enteras en inglés: en la lista van
                marcadas con «EN». En otras (promos, Galerías de Entrenadores,
                Shiny Vault) sólo la ilustración es inglesa. El texto de
                ambientación, el ilustrador y la rareza se quedan siempre en
                inglés. Al cambiarlo se recarga la página.
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
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="ink-faint h-5 w-5 shrink-0" aria-hidden="true">
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
                  className={`w-10 shrink-0 text-right t-cuerpo-2 font-medium tnum ${
                    ajustes.sonido ? "ink-soft" : "ink-faint"
                  }`}
                >
                  {porcentajeVolumen}%
                </span>
              </div>
            </div>
          </Seccion>

          {/* Sólo donde el dispositivo vibra: ver `puedeVibrar`. */}
          {puedeVibrar && (
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
          )}

          <Seccion titulo="Efectos">
            <div className="surface overflow-hidden rounded-2xl">
              <FilaInterruptor
                titulo="Reducir efectos visuales"
                descripcion="Menos brillos, auras y animaciones pesadas"
                activo={ajustes.reducirEfectos}
                onToggle={() => alternar("reducirEfectos")}
              />
              <div className="border-t border-[var(--border)]">
                <FilaInterruptor
                  titulo="Saltar la animación del sobre"
                  descripcion="Un sobre suelto va directo al resumen, como el ×10"
                  activo={aperturaRapida}
                  onToggle={() => {
                    guardarAperturaRapida(!aperturaRapida);
                    haptic("select");
                  }}
                />
              </div>
            </div>
          </Seccion>

          {/* Hasta saber quién mira no se pinta nada: evita ofrecer el borrado
              local a un usuario que en realidad tiene cuenta. Por lo mismo, el
              botón de borrar sólo sale para el invitado FIRME: una cuenta sin
              red ve el texto de la nube, no una papelera sobre la partida de
              invitado de este dispositivo. */}
          {identidad !== "resolviendo" && (
            <Seccion titulo="Datos">
              <div className="surface overflow-hidden rounded-2xl">
                {identidad !== "invitado" ? (
                  <div className="flex items-start gap-3 px-4 py-3.5">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="accent mt-0.5 h-5 w-5 shrink-0" aria-hidden="true">
                      <path d="M17.5 19a4.5 4.5 0 0 0 .42-8.98 7 7 0 0 0-13.6 1.8A4 4 0 0 0 6 19z" />
                    </svg>
                    {/* t-cuerpo y no t-cuerpo-2: son dos frases que se leen de
                        corrido, no un pie de una línea. */}
                    <p className="ink-soft t-cuerpo leading-relaxed">
                      Tu colección y tus monedas se guardan en la nube con tu
                      cuenta, disponibles en cualquier dispositivo.
                    </p>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmarBorrado(true)}
                    className="touch-target flex w-full items-center gap-3 px-4 py-3.5 text-left t-cuerpo font-medium transition-colors hover:bg-[color-mix(in_srgb,var(--danger)_6%,transparent)]"
                    // --danger-ink y no --danger: esto es texto sobre la
                    // superficie, y --danger es el token de FONDO.
                    style={{ color: "var(--danger-ink)" }}
                  >
                    {/* Esta papelera NO es IconoPapelera: lleva además las dos
                        rayas de dentro, y así queda dicho en components/icons.tsx.
                        Se le unifica el trazo y el tamaño y se queda aquí. */}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 shrink-0" aria-hidden="true">
                      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6M14 11v6" />
                    </svg>
                    Borrar datos de este dispositivo
                  </button>
                )}
                {/* EL PLAZO DE SAFARI, dicho donde se habla de los datos. Safari
                    borra lo que guarda un sitio NO instalado si pasan siete días
                    sin abrirlo, y la partida del invitado vive entera ahí: quien
                    volvía a las dos semanas la encontraba vacía sin que nadie le
                    hubiera avisado. Sólo al invitado y sólo en Safari sin
                    instalar: a los demás no les pasa. */}
                {identidad === "invitado" && avisoDeSafari && (
                  <p className="ink-faint border-t border-[var(--border)] px-4 py-3 t-cuerpo-2 leading-relaxed">
                    Como invitado, tu partida se guarda sólo en este navegador, y Safari
                    la borra si pasas siete días sin abrir la app. Para conservarla,
                    añádela a la pantalla de inicio o juega con una cuenta.
                  </p>
                )}
              </div>
            </Seccion>
          )}

          <Seccion titulo="Acerca de">
            <div className="surface overflow-hidden rounded-2xl">
              <div className="flex items-center gap-3 px-4 py-3.5">
                <div className="btn-accent flex h-9 w-9 shrink-0 items-center justify-center rounded-xl">
                  {/* Era el sobre de la marca copiado a mano, con trazo 2,2 y sin
                      cabos redondos: es exactamente IconoMarca, el mismo que ya
                      montan la barra superior y el menú lateral. */}
                  <IconoMarca tam={20} className="text-[#04110c]" />
                </div>
                <div className="min-w-0">
                  <p className="ink t-cuerpo leading-tight font-semibold">
                    Pokémon TCG Simulator
                  </p>
                  <p className="ink-faint mt-0.5 t-cuerpo-2">
                    Datos e imágenes de pokemontcg.io
                  </p>
                  {/* Sólo si se sabe algo: en desarrollo no hay ni build ni
                      service worker, y una línea "Versión —" no informa. */}
                  {versionVisible && (
                    <p className="ink-faint mt-0.5 t-cuerpo-2 tnum">
                      {versionVisible}
                    </p>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={recargar}
                disabled={buscandoVersion}
                className="touch-target flex w-full items-center gap-3 border-t border-[var(--border)] px-4 py-3 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--ink)_4%,transparent)] disabled:opacity-60"
              >
                <IconoRefrescar tam={20} className="ink-soft" />
                <span className="min-w-0">
                  <span className="ink block t-cuerpo font-medium">
                    {buscandoVersion ? "Buscando actualización…" : "Buscar actualización y recargar"}
                  </span>
                  <span className="ink-faint mt-0.5 block t-cuerpo-2 leading-snug">
                    Vuelve a cargar la app con la última versión
                  </span>
                </span>
              </button>
            </div>
          </Seccion>
        </div>

        {/* Los pseudoelementos del deslizador no se pueden estilar en línea y
            globals.css pertenece a otra pieza: el estilo viaja con la hoja.

            `touch-action:none`, como en el deslizador del bazar
            (components/bazar/PublicarSheet.tsx): el <body> declara
            `touch-action: pan-x pan-y` y esta hoja se desplaza en vertical, así
            que iOS podía quedarse el arrastre del dedo como scroll y el volumen
            no se movía, o se movía la hoja. Declarado SÓLO sobre el control, el
            arrastre le llega entero y el resto de la hoja sigue desplazándose. */}
        <style>{`
          .ajustes-rango{
            -webkit-appearance:none; appearance:none;
            height:44px; background:transparent; cursor:pointer;
            touch-action:none;
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
        description="Se eliminarán la colección, la vitrina y las monedas guardadas en este dispositivo. Esta acción no se puede deshacer."
        confirmLabel="Borrar datos"
        cancelLabel="Cancelar"
        destructive
        onConfirm={borrarDatosLocales}
      />
    </>
  );
}
