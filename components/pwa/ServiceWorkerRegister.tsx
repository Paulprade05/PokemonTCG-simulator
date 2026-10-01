"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useShell } from "../AppShell";
import { IconoCerrar } from "../icons";
import { useAlVolver } from "../../hooks/useAlVolver";
import { isStandaloneDisplay } from "../../utils/platform";
import {
  BUILD_ID,
  EVENTO_VERSION_CADUCADA,
  buildDelServidor,
  recargarApp,
  vigilarAccionesCaducadas,
} from "../../utils/versionApp";

/**
 * Por qué hay algo pendiente:
 *  · "nueva": hay un despliegue más reciente que el que corre aquí. La app
 *    sigue funcionando; se puede esperar.
 *  · "caducada": el servidor ya no reconoce las acciones de este cliente. Todo
 *    lo que el jugador intente va a fallar hasta que recargue.
 */
type Motivo = "nueva" | "caducada";

/** Mínimo entre dos preguntas al servidor por su versión al volver a la app. */
const ENTRE_COMPROBACIONES_MS = 5 * 60_000;
/** La primera pregunta, poco después de arrancar. Existe por el plazo de las
 *  navegaciones del service worker: con mala cobertura la app arranca con la
 *  copia guardada, que puede ser de un despliegue anterior. */
const PRIMERA_COMPROBACION_MS = 8_000;
/** Lo que se deja pasar antes de pedir al service worker que guarde las
 *  pantallas fijas: que no compita con la carga de la que se está mirando. */
const ESPERA_CALENTAR_MS = 6_000;

/**
 * Cuándo se cargó este documento, por el reloj de pared. NO `performance.now()`:
 * ese reloj se detiene mientras iOS tiene la app suspendida, así que una PWA
 * usada veinte segundos y reanudada dos días después seguiría pareciendo
 * "recién cargada", que es justo el caso en el que el aviso hace falta.
 */
const DOCUMENTO_DESDE = Date.now();
/** Un relevo de service worker dentro de este margen es el del propio
 *  arranque: el navegador lo busca al registrar, a los pocos segundos de cargar. */
const ARRANQUE_RECIENTE_MS = 30_000;

const CLAVE_RECARGA = "tcg-recarga-version";
const ENTRE_RECARGAS_SOLAS_MS = 60_000;

/**
 * Freno de la recarga automática. Si recargar no cura la versión vieja (sin red
 * el service worker devuelve la copia guardada, que es la misma), sin esto cada
 * cambio de pantalla volvería a recargar. Como mucho una por minuto; el botón
 * "Actualizar" no pasa por aquí, porque ése lo pulsa una persona.
 */
function puedeRecargarSola(): boolean {
  try {
    const ultima = Number(window.sessionStorage.getItem(CLAVE_RECARGA)) || 0;
    if (Date.now() - ultima < ENTRE_RECARGAS_SOLAS_MS) return false;
    window.sessionStorage.setItem(CLAVE_RECARGA, String(Date.now()));
    return true;
  } catch {
    // Sin almacenamiento no hay memoria entre recargas: se permite, que es lo
    // que se hacía antes de que existiera el freno.
    return true;
  }
}

/**
 * Registra el service worker que da soporte offline y cachea las imágenes de
 * las cartas, y mantiene la app AL DÍA. En una PWA instalada la página puede
 * vivir días en memoria (iOS la suspende y la reanuda), así que sin esto el
 * usuario seguía ejecutando el JS de un despliegue antiguo: veía features
 * desaparecidas o a medias, o directamente una app en la que todo fallaba.
 *
 * TRES FORMAS DE ENTERARSE DE QUE HAY VERSIÓN NUEVA, de la más débil a la que
 * no falla:
 *
 *  1. El relevo del service worker (`controllerchange`). Es la que había, y
 *     sólo salta si ha cambiado un byte de public/sw.js: en un despliegue
 *     normal no cambia.
 *  2. Preguntar al servidor qué build sirve (`/api/version`) y compararlo con
 *     el que se compiló aquí. Al arrancar y al volver a primer plano, como
 *     mucho cada cinco minutos. Detecta CUALQUIER despliegue. Si este
 *     JavaScript no sabe su propio build, esta vía se queda apagada.
 *  3. Que una server action vuelva como "desconocida". Ya no es una sospecha:
 *     es el servidor diciendo que este cliente ha caducado. La detecta el
 *     vigilante de utils/versionApp.ts, sin que cada pantalla tenga que
 *     acordarse de preguntar, y es la que convierte el "Revisa tu conexión"
 *     con cobertura perfecta en un aviso que dice la verdad.
 *
 * POR QUÉ NO RECARGA EN EL ACTO. Cualquiera de las tres llega cuando la app
 * vuelve al primer plano o a mitad de un toque, y ése es justo el momento en
 * el que alguien puede estar a mitad de algo: un sobre rasgado con las cartas
 * sin dar la vuelta, una carta elegida en el selector de la vitrina, una oferta
 * a medio componer en el bazar. Un `location.reload()` ahí se lo llevaba todo
 * sin avisar. Se anuncia con un aviso que SE QUEDA en pantalla y ofrece
 * "Actualizar", y si el jugador no lo pulsa la recarga se APLAZA A LA
 * SIGUIENTE NAVEGACIÓN: el cambio de ruta es un momento en el que, por
 * definición, no hay nada a medias en la pantalla que se deja.
 *
 * POR QUÉ EL AVISO ES PROPIO Y NO UN TOAST. El toast dura 2,8 segundos: quien
 * no estuviera mirando no se enteraba, y la recarga posterior llegaba sin
 * explicación. Éste se queda hasta que se pulsa o se descarta, y lleva el
 * botón. Con la apertura de un sobre en pantalla no se pinta (no se pone nada
 * encima de las cartas); aparece al salir de ella.
 *
 * Vive dentro de AppShell porque necesita saber si hay una vista inmersiva.
 *
 * En desarrollo el service worker se desregistra para no servir chunks
 * obsoletos de Turbopack; el vigilante de acciones caducadas sí funciona.
 */
export default function ServiceWorkerRegister() {
  const pathname = usePathname();
  const { immersive } = useShell();

  const [aviso, setAviso] = useState<Motivo | null>(null);
  const [descartado, setDescartado] = useState(false);
  const [recargando, setRecargando] = useState(false);

  /* Ruta en la que se detectó la versión nueva, o null si no hay nada
   * pendiente. Es la ruta y no un booleano para poder distinguir "ha cambiado
   * de pantalla" de "sigue en la misma": el efecto de abajo se ejecuta también
   * con el pathname con el que se montó. */
  const pendienteDesdeRef = useRef<string | null>(null);

  const marcarPendiente = useCallback((motivo: Motivo) => {
    if (pendienteDesdeRef.current === null) {
      pendienteDesdeRef.current = window.location.pathname;
    }
    // "caducada" manda: una vez que el servidor ha rechazado a este cliente,
    // un "hay versión nueva" posterior no puede rebajar el aviso.
    setAviso((previo) => (previo === "caducada" ? previo : motivo));
    // Y vuelve a salir aunque se hubiera descartado: quien cerró "hay una
    // versión nueva" no ha dicho que le dé igual que todo falle.
    if (motivo === "caducada") setDescartado(false);
  }, []);

  // LA RECARGA APLAZADA: en cuanto la ruta cambia con una versión pendiente.
  useEffect(() => {
    const desde = pendienteDesdeRef.current;
    if (desde !== null && desde !== pathname && puedeRecargarSola()) {
      recargarApp();
    }
  }, [pathname]);

  // VÍA 3: el servidor no reconoce una acción de este cliente.
  useEffect(() => {
    const dejarDeVigilar = vigilarAccionesCaducadas();
    const alCaducar = () => marcarPendiente("caducada");
    window.addEventListener(EVENTO_VERSION_CADUCADA, alCaducar);
    return () => {
      window.removeEventListener(EVENTO_VERSION_CADUCADA, alCaducar);
      dejarDeVigilar();
    };
  }, [marcarPendiente]);

  // VÍA 2: el build del servidor contra el de aquí.
  const comprobarBuild = useCallback(() => {
    if (!BUILD_ID || process.env.NODE_ENV !== "production") return;
    if (pendienteDesdeRef.current !== null) return;
    buildDelServidor().then((build) => {
      if (build && build !== BUILD_ID) marcarPendiente("nueva");
    });
  }, [marcarPendiente]);
  useAlVolver(comprobarBuild, ENTRE_COMPROBACIONES_MS);
  useEffect(() => {
    const t = window.setTimeout(comprobarBuild, PRIMERA_COMPROBACION_MS);
    return () => window.clearTimeout(t);
  }, [comprobarBuild]);

  // VÍA 1 y el registro del service worker.
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {});
      return;
    }

    let disposed = false;
    let registration: ServiceWorkerRegistration | null = null;
    let temporizadorCalentar: number | undefined;

    /* Pide al service worker que guarde las pantallas fijas (ver `calentar` en
     * public/sw.js): es lo que evita que, sin red, tocar una pestaña acabe en
     * offline.html. Sólo en la app instalada —en una pestaña del navegador hay
     * barra y botón atrás, y no se gastan datos de nadie por si acaso— y nunca
     * con el ahorro de datos activado. Un service worker antiguo que no conozca
     * el mensaje lo ignora. */
    const pedirCalentado = () => {
      if (disposed || !isStandaloneDisplay()) return;
      const conexion = (
        navigator as unknown as { connection?: { saveData?: boolean } }
      ).connection;
      if (conexion?.saveData) return;
      try {
        navigator.serviceWorker.controller?.postMessage("CALENTAR");
      } catch {
        /* sin calentar la app queda como estaba */
      }
    };

    // La PRIMERA toma de control no es una actualización: en un usuario nuevo
    // (o tras un hard reload) la página llega sin controller, y el
    // clients.claim() de la primera instalación dispara controllerchange
    // igualmente — pero ese HTML/JS ya es el del despliegue vigente, no hay
    // nada viejo que refrescar. Sólo cuenta si otro service worker ya nos
    // servía al cargar.
    let hadController = !!navigator.serviceWorker.controller;
    const onControllerChange = () => {
      // El que acaba de tomar el control sí conoce "CALENTAR".
      pedirCalentado();
      if (!hadController) {
        // A partir de aquí la página sí está controlada: el siguiente relevo
        // (una actualización real) ya cuenta.
        hadController = true;
        return;
      }
      // Un solo aviso por relevo: un SW que llamara a clients.claim() en bucle
      // no puede llenar la pantalla de avisos ni recargar sin fin.
      if (pendienteDesdeRef.current !== null) return;
      /* EL FALSO POSITIVO DEL ARRANQUE EN FRÍO. Al abrir la app tras un
       * despliegue que también cambió sw.js, el HTML y el JS que acaban de
       * llegar YA son los nuevos (las navegaciones van a la red primero), y aun
       * así el relevo del service worker avisaba y recargaba para nada.
       *
       * Con identificador de build se pregunta al servidor: si dice el mismo
       * que el de aquí, no hay nada que refrescar; si no contesta, se avisa
       * como siempre (ante la duda, lo de antes).
       *
       * Sin identificador se mira cuánto lleva vivo el documento: si el relevo
       * llega recién cargada la página, la página es la nueva. Puede fallar
       * (una página servida desde la copia guardada a la que la red le vuelve
       * a los pocos segundos), y para ese caso queda la vía 3. */
      if (!BUILD_ID) {
        if (Date.now() - DOCUMENTO_DESDE < ARRANQUE_RECIENTE_MS) return;
        marcarPendiente("nueva");
        return;
      }
      buildDelServidor().then((build) => {
        if (disposed || build === BUILD_ID) return;
        marcarPendiente("nueva");
      });
    };
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange,
    );

    // Al volver la app al primer plano se comprueba si hay versión nueva:
    // es el momento en el que un usuario de PWA "vuelve a abrir" la app.
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        registration?.update().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then((reg) => {
          if (disposed) return;
          registration = reg;
          // Si ya hay una versión esperando, que tome el control al instante.
          if (reg.waiting) reg.waiting.postMessage("SKIP_WAITING");
          reg.addEventListener("updatefound", () => {
            const next = reg.installing;
            if (!next) return;
            next.addEventListener("statechange", () => {
              if (next.state === "installed" && navigator.serviceWorker.controller) {
                next.postMessage("SKIP_WAITING");
              }
            });
          });
          temporizadorCalentar = window.setTimeout(
            pedirCalentado,
            ESPERA_CALENTAR_MS,
          );
        })
        .catch(() => {
          /* sin service worker la app sigue funcionando online */
        });
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    return () => {
      disposed = true;
      window.clearTimeout(temporizadorCalentar);
      window.removeEventListener("load", register);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange,
      );
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [marcarPendiente]);

  if (!aviso || descartado || immersive) return null;

  return (
    /* CAPA 60: por encima del cromo (barra superior 30, pestañas 40, aviso de
     * instalar 50) y por debajo de todo lo que cuelga de un Portal (100 o
     * más): con una hoja o la ficha de una carta abiertas, el aviso queda
     * detrás del velo en vez de pintarse encima.
     *
     * DEBAJO de la barra superior y no sobre ella: ahí están el saldo y el
     * botón de Ajustes, y los avisos de Toast salen justo en esa franja.
     *
     * Los lados respetan el recorte de la pantalla en apaisado, y en
     * escritorio el aviso se centra en la columna de contenido, no bajo el
     * menú lateral. El contenedor no recibe toques; sólo la tarjeta. */
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 z-[60] flex justify-center pr-[max(var(--sar),0.75rem)] pl-[max(var(--sal),0.75rem)] md:pl-[15.75rem]"
      style={{ top: "calc(var(--sat) + var(--topbar-h) + 8px)" }}
    >
      {/* `flex-wrap`: a 320 px el texto ocupa la primera fila y los botones
          bajan a la segunda; desde unos 360 px cabe todo en una. */}
      <div
        className="surface pointer-events-auto flex w-full max-w-md flex-wrap items-center gap-x-2 rounded-2xl py-1.5 pr-1.5 pl-4"
        style={{ boxShadow: "var(--shadow-lg)" }}
      >
        <p className="ink min-w-0 flex-1 basis-40 py-1.5 t-cuerpo-2 leading-snug font-medium">
          {aviso === "caducada"
            ? "Esta versión ha caducado. Actualiza para seguir jugando."
            : "Hay una versión nueva. Se aplicará al cambiar de pantalla."}
        </p>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={recargando}
            onClick={() => {
              setRecargando(true);
              recargarApp();
            }}
            className="btn-accent touch-target rounded-xl px-4 t-cuerpo disabled:opacity-60"
          >
            {recargando ? "Actualizando…" : "Actualizar"}
          </button>
          <button
            type="button"
            aria-label="Ahora no"
            onClick={() => setDescartado(true)}
            className="touch-target ink-soft flex items-center justify-center rounded-xl"
          >
            <IconoCerrar tam={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
