"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useSyncExternalStore } from "react";
import {
  COLLECTION_CHANGED_EVENT,
  COLLECTION_STORAGE_KEY,
  getCollection,
} from "../utils/storage";
import { formatNumber } from "../utils/format";

/**
 * LOS 495 PÍXELES VACÍOS DE LA BARRA LATERAL.
 *
 * Medido a 1280x800: la navegación terminaba en y=222 y el bloque de Ajustes
 * empezaba en y=717 —es literalmente el `mt-auto` del pie—, así que entre las
 * cuatro pestañas y los ajustes había medio metro de nada.
 *
 * LO QUE VA AQUÍ NO SON PESTAÑAS NUEVAS. Las cuatro de components/nav-items.tsx
 * se quedan como están y por el motivo que allí se razona: Colección cubre
 * álbum, vitrina y graduación, y Mercado cubre el bazar. Lo que se añade son
 * ATAJOS a tres pantallas que hoy sólo tienen UNA puerta cada una, y todas
 * dentro de otra pantalla:
 *
 *   /vitrina     ← app/collection/page.tsx
 *   /graduacion  ← app/collection/page.tsx
 *   /bazar       ← app/mercado/page.tsx
 *
 * O sea que en escritorio, con media barra lateral vacía, para ver la vitrina
 * hay que entrar antes en la colección. Eso es lo que arregla este bloque.
 *
 * Van deliberadamente en otro registro visual que los enlaces de arriba —más
 * pequeños, con su rótulo de sección y sin el indicador de pestaña activa—
 * para que nadie los lea como una quinta y una sexta pestaña.
 */

const ATAJOS = [
  {
    href: "/vitrina",
    label: "Vitrina",
    icon: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
      </>
    ),
  },
  {
    href: "/graduacion",
    label: "Graduación",
    icon: <path d="M12 2 15 9l7 .6-5.3 4.6L18.2 21 12 17.3 5.8 21l1.5-6.8L2 9.6 9 9z" />,
  },
  {
    href: "/bazar",
    label: "Bazar",
    icon: (
      <>
        <path d="M3 9h18l-1.5 10.5a2 2 0 0 1-2 1.5H6.5a2 2 0 0 1-2-1.5z" />
        <path d="M8 9V6a4 4 0 0 1 8 0v3" />
      </>
    ),
  },
];

/**
 * DOS FUENTES DE AVISO, Y LAS DOS HACEN FALTA.
 *
 * `storage` cubre las OTRAS pestañas. Lo que NO cubre —y aquí estuvo el fallo—
 * es la propia: el navegador no se lo dispara a quien escribe. Y el caso que
 * importa es exactamente ese: los sobres se abren en `/` (app/page.tsx llama a
 * saveToCollection), sin cambiar de ruta y con esta barra a la vista todo el
 * rato. Fiarse de "la barra re-renderiza al cambiar de ruta" dejaba el número
 * clavado mientras se abrían diez sobres delante de él. Medido antes de
 * arreglarlo: escribir una carta y esperar 600 ms dejaba la tarjeta diciendo
 * "214 cartas · 543 copias" cuando ya eran 215 y 550.
 *
 * COLLECTION_CHANGED_EVENT lo despacha utils/storage.ts en cada escritura, así
 * que el aviso llega en el mismo tick que el guardado.
 *
 * La función vive fuera del componente porque useSyncExternalStore quiere una
 * referencia estable: una nueva en cada render la haría re-suscribirse siempre.
 */
const SUSCRIBIR_ALMACEN = (avisar: () => void) => {
  window.addEventListener("storage", avisar);
  window.addEventListener(COLLECTION_CHANGED_EVENT, avisar);
  return () => {
    window.removeEventListener("storage", avisar);
    window.removeEventListener(COLLECTION_CHANGED_EVENT, avisar);
  };
};

/**
 * MEMORIA DE UNA SOLA ENTRADA, Y NO ES MICRO-OPTIMIZACIÓN.
 *
 * `getSnapshot` se ejecuta DURANTE el render y React lo llama varias veces por
 * render. La versión anterior hacía ahí un JSON.parse de la colección entera:
 * 202.733 bytes y 2,48 ms por lectura con la colección de prueba. Medido en el
 * navegador, una sola navegación de cliente costaba 12 lecturas atribuibles a
 * este componente (≈30 ms de hilo principal bloqueado)…
 *
 * …y se pagaban TAMBIÉN en el iPhone, que es el dispositivo principal del
 * proyecto: el <aside> es `hidden md:flex`, o sea que a 375px está montado y
 * sólo oculto por CSS. Comprobado a 375: display "none" y 8 lecturas por
 * navegación, ~20 ms tirados en un bloque que nadie puede ver, justo mientras
 * entra la transición de ruta de app/template.tsx.
 *
 * La clave del memo es la CADENA CRUDA de localStorage: leerla cuesta 0,004 ms
 * (medido) frente a los 2,48 del parse, así que comparar es 600 veces más
 * barato que recalcular. Sólo se vuelve a parsear cuando el contenido cambia
 * de verdad, que es una vez por sobre abierto.
 */
let crudoMemo: string | null | undefined;
let resumenMemo: string | null = null;

/**
 * Resumen de la colección LOCAL, ya formateado.
 *
 * Devuelve una cadena y no un objeto a propósito: useSyncExternalStore compara
 * el resultado con Object.is en cada render, y un objeto nuevo cada vez sería
 * un bucle infinito de renders. Con una cadena, dos lecturas iguales son
 * iguales.
 *
 * Devuelve null cuando no hay nada que contar, y quien lo pinta no enseña
 * entonces ni el bloque: un "0 cartas" a quien acaba de instalar la app es
 * exactamente el cero falso que no queremos.
 */
function leerResumenLocal(): string | null {
  let crudo: string | null;
  try {
    crudo = localStorage.getItem(COLLECTION_STORAGE_KEY);
  } catch {
    // localStorage inaccesible (modo privado de iOS, permisos): sin dato no se
    // pinta nada, que es mejor que pintar un número inventado.
    return null;
  }
  if (crudo === crudoMemo) return resumenMemo;
  crudoMemo = crudo;
  resumenMemo = calcularResumen();
  return resumenMemo;
}

function calcularResumen(): string | null {
  try {
    // getCollection y no un JSON.parse a pelo: es quien sanea la colección
    // corrupta (y la limpia). Si lo hace, la próxima lectura verá una cadena
    // distinta a la memorizada y recalculará sola.
    const cartas = getCollection();
    if (cartas.length === 0) return null;
    let copias = 0;
    for (const c of cartas) copias += Math.max(1, Number(c.quantity) || 1);
    return `${formatNumber(cartas.length)} cartas · ${formatNumber(copias)} copias`;
  } catch {
    return null;
  }
}

/* En el servidor no hay localStorage. Devolver null aquí es lo que mantiene
   idénticos el HTML del servidor y el del primer render del cliente: el bloque
   aparece después, ya hidratado, sin que React aborte nada. */
const SIN_RESUMEN = () => null;

export default function SidebarExtras() {
  const pathname = usePathname();
  const { isSignedIn, isLoaded } = useUser();

  /**
   * EL RECUENTO SÓLO SE ENSEÑA AL INVITADO, Y ESTO NO ES UN DESCUIDO.
   *
   * La colección de invitado vive en localStorage bajo UNA clave global
   * ('pokemon-tcg-collection'), sin separar por identidad —al revés que el
   * saldo, que sí guarda `coins:<userId>` / `coins:guest`—. Si esta barra
   * leyera el almacenamiento sin mirar la sesión, a un usuario con cuenta le
   * enseñaría, en su propia barra lateral, las cartas que dejó un invitado en
   * ese mismo dispositivo. Eso no es un dato: es el número de otro.
   *
   * ¿Y el número del que SÍ tiene cuenta? Su colección está en Postgres y la
   * única forma de contarla desde aquí es una server action con recorrido
   * completo (getFullCollection) o getProfileStats, que son tres consultas.
   * Esta barra se monta en TODAS las rutas: pagar eso por un renglón sería
   * caro y, sobre todo, no haría falta —el recuento con sesión ya se enseña
   * arriba del todo en la colección, en el acordeón de progreso—.
   *
   * Así que aquí: dato real o nada. Nunca un cero de relleno.
   *
   * LA PUERTA VA ANTES DE LA LECTURA, no después. Estaba después: con sesión se
   * leía y se parseaba la colección entera para tirar el resultado a la basura
   * tres líneas más abajo. Cambiar la función de lectura es legal en
   * useSyncExternalStore —React vuelve a leer cuando cambia— y es lo que hace
   * que con sesión el coste sea exactamente cero.
   *
   * CONSECUENCIA QUE CONVIENE TENER PRESENTE: esta tarjeta no existe para quien
   * tiene cuenta, así que el hueco de la barra lateral queda en 329px para él y
   * en 243px para el invitado. La alternativa —enseñarle un número— sería o el
   * del invitado del mismo dispositivo (el número de otro) o tres consultas a
   * Postgres en todas las rutas. Un hueco honesto es mejor que un dato falso.
   */
  const leerResumen = isLoaded && !isSignedIn ? leerResumenLocal : SIN_RESUMEN;
  const resumenLocal = useSyncExternalStore(SUSCRIBIR_ALMACEN, leerResumen, SIN_RESUMEN);
  const mostrarResumen = resumenLocal !== null;

  return (
    <div className="mt-7 flex flex-col gap-1">
      <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] ink-faint">
        Atajos
      </p>

      {ATAJOS.map((a) => {
        const activo = pathname.startsWith(a.href);
        return (
          <Link
            key={a.href}
            href={a.href}
            // "true" y no "page", aunque esta SEA la página actual: la pestaña
            // de Colección de la navegación de arriba ya se marca como "page"
            // en /vitrina y /graduacion (cubre esas rutas), así que con "page"
            // aquí el mismo <aside> devolvía DOS elementos con
            // aria-current="page" y un lector de pantalla anunciaba "página
            // actual" dos veces seguidas en la misma región. "true" mantiene el
            // estado —"actual" dentro de su grupo de atajos— sin repetir el
            // anuncio de la pestaña.
            aria-current={activo ? "true" : undefined}
            // touch-target son los 44px mínimos de la casa (globals.css). Sin
            // él, `px-3 py-2` sobre un texto de 13px daba 36px de alto: por
            // debajo del mínimo y 6px menos que los enlaces de navegación de
            // justo encima, en la única franja de anchos donde esta barra se
            // toca con el dedo (un iPad vertical de 768px ya la enciende).
            // press-flat y no press: el hundimiento no escala nada. Es la misma
            // regla que siguen los enlaces de navegación de esta barra.
            className="press-flat touch-target group flex items-center gap-3 rounded-xl px-3 py-2"
          >
            {/* OJO CON CÓMO SE ESCRIBEN LOS EJEMPLOS DE CLASE EN LOS
                COMENTARIOS: Tailwind 4 escanea estos ficheros como texto plano,
                comentarios incluidos, y genera la utilidad de cualquier cosa
                que parezca una clase. La versión anterior de esta nota traía un
                ejemplo con corchetes y puntos suspensivos, y Tailwind emitió
                una regla de color entera apuntando a una variable CSS que no
                existe, servida a todos los usuarios. Así que ningún ejemplo de
                clase entre corchetes en prosa: se nombra y ya.
                El fondo del asunto sí es cierto: .ink/.ink-soft son CSS a mano
                dentro de @layer utilities, no utilidades de Tailwind, así que
                la variante group-hover de esas clases no llega a generarse
                nunca y no pinta nada. Por eso aquí el color de hover se escribe
                con el valor arbitrario, que sí se emite. */}
            <span className={`transition-colors ${activo ? "accent" : "ink-faint group-hover:text-[var(--ink-soft)]"}`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" aria-hidden="true">
                {a.icon}
              </svg>
            </span>
            <span className={`text-[13px] transition-colors ${activo ? "ink font-medium" : "ink-soft group-hover:text-[var(--ink)]"}`}>
              {a.label}
            </span>
          </Link>
        );
      })}

      {mostrarResumen && (
        <Link
          href="/collection"
          className="press-flat surface surface-hover mt-6 block rounded-xl px-3 py-2.5"
        >
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] ink-faint">
            Tu colección
          </p>
          {/* tnum: las cifras no bailan de ancho cuando el número cambia al
              volver de abrir un sobre. */}
          <p className="mt-0.5 text-[13px] font-medium ink tnum">{resumenLocal}</p>
        </Link>
      )}
    </div>
  );
}
