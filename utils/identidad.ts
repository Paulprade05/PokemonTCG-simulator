// utils/identidad.ts
//
// QUIÉN ESTÁ MIRANDO, TAMBIÉN CUANDO CLERK NO CONTESTA.
//
// EL FALLO QUE CIERRA. Las pantallas empezaban su carga con `if (!isLoaded)
// return`. Sin red —la PWA instalada abierta en el metro— clerk-js no resuelve
// la sesión y `isLoaded` se queda en false para siempre: el esqueleto giraba
// sin fin con la página entera servida desde la caché. El proveedor del saldo
// (hooks/useGameCurrency.tsx) pone un plazo de cuatro segundos; lo que el plazo
// NO dice es a quién se deja de esperar. Vencido, `isSignedIn` es `undefined`,
// y tratar eso como "invitado" le enseña a un jugador con cuenta una colección
// vacía y un "Abre tu primer sobre", o le deja abrir sobres con el saldo de
// invitado.
//
// Por eso hay CUATRO respuestas y no un booleano:
//
//   "resolviendo"          todavía se espera a Clerk: se pinta el esqueleto.
//   "cuenta"               Clerk lo ha dicho: se carga del servidor.
//   "invitado"             Clerk lo ha dicho, O no ha contestado y nada indica
//                          que haya una cuenta: se pinta lo de este dispositivo.
//   "cuenta-sin-conexion"  Clerk no ha contestado y lo último que se supo es
//                          que había una sesión. Ni datos de invitado ni
//                          "Inicia sesión": se dice que no hay conexión
//                          (components/ui/SinConexion.tsx).
//
// POR QUÉ VIVE AQUÍ Y NO EN UN HOOK POR PANTALLA. Nació en
// app/collection/useIdentidad.ts y sólo lo usaban Colección, Álbum, Mercado y
// Vitrina: con cuenta y sin red, Colección decía «Sin conexión» mientras la
// portada dejaba abrir sobres como invitado y Social pedía iniciar sesión. La
// respuesta tiene que ser UNA para toda la app, así que la calcula el proveedor
// del saldo —que ya era quien ponía el plazo— y las pantallas la leen con
// `useIdentidad` (hooks/useIdentidad.ts). Aquí queda lo que no es React: leer
// el rastro que dejó la última sesión.

import { COLLECTION_STORAGE_KEY } from "./storage";

export type Identidad = "resolviendo" | "cuenta" | "invitado" | "cuenta-sin-conexion";

/** Última identidad que Clerk confirmó en este dispositivo: un id o "guest". */
export const CLAVE_ULTIMA_IDENTIDAD = "tcg-ultima-identidad";

/**
 * Lo que la app recuerda DE QUIEN JUEGA y no del dispositivo: las búsquedas
 * recientes del buscador, y los filtros de la colección y del álbum.
 *
 * Estas claves no llevan usuario. En un teléfono compartido, quien entraba con
 * otra cuenta abría el buscador y veía las búsquedas del anterior. En vez de
 * ponerle sufijo a cada una (y dejar las antiguas huérfanas), se vacían cuando
 * cambia la identidad: lo hace el proveedor del saldo, que es quien se entera
 * (hooks/useGameCurrency.tsx), y "Borrar datos de este dispositivo" en Ajustes.
 *
 * Los nombres están escritos aquí A MANO y son los mismos que declaran
 * components/GlobalSearch.tsx, app/collection/page.tsx y
 * app/album/[setId]/page.tsx. Una clave nueva de esta clase hay que añadirla.
 */
export const CLAVES_DE_QUIEN_JUEGA: readonly string[] = [
  "tcg:busquedas",
  "tcg:coleccion-vista",
  "tcg:album-filtro",
];

/** Prefijo de las claves de saldo: `coins:<id de la cuenta>` y `coins:guest`. */
const PREFIJO_SALDO = "coins:";
const CLAVE_SALDO_INVITADO = "coins:guest";

/**
 * Lo que se sabía de la sesión antes de este arranque.
 *
 * `id` es el de la cuenta cuando se puede saber cuál era: sirve para leer su
 * saldo guardado (`coins:<id>`) sin conexión. `null` es «había una cuenta, pero
 * no se sabe cuál».
 */
export type RastroDeSesion = { tipo: "invitado" } | { tipo: "cuenta"; id: string | null };

/**
 * DE DÓNDE SALE "LO ÚLTIMO QUE SE SUPO", por orden de fiabilidad:
 *
 *  1. La cookie `__client_uat` de Clerk. Es suya, la escribe clerk-js en este
 *     mismo dominio y vale 0 sin sesión y una marca de tiempo con ella: es lo
 *     que usa su propio middleware para la misma pregunta. Se lee sólo como
 *     indicio y sólo cuando Clerk no ha llegado; si un día cambia de nombre,
 *     simplemente no se encuentra y manda el punto 2.
 *  2. `tcg-ultima-identidad`, que el proveedor apunta cada vez que Clerk SÍ
 *     resuelve: el id de la cuenta o "guest". Se guarda el id y no un sí/no
 *     para que el saldo pueda leer `coins:<id>` sin conexión.
 *  3. Sin ninguna de las dos (primera vez tras esta versión): si en este
 *     dispositivo hubo alguna vez una cuenta —queda su clave `coins:<id>`— y
 *     no hay colección de invitado que enseñar, se prefiere "sin conexión" a
 *     una colección vacía. Con cartas locales, se enseñan.
 *
 * Nunca lanza: cookies o almacenamiento inaccesibles cuentan como "sin
 * indicios", y sin indicios se es invitado. Sólo para el navegador, y siempre
 * desde un efecto o un temporizador: el servidor no tiene ni lo uno ni lo otro.
 */
export function rastroDeSesion(): RastroDeSesion {
  let cookie: "cuenta" | "invitado" | null = null;
  try {
    for (const par of document.cookie.split(";")) {
      const igual = par.indexOf("=");
      if (igual < 0) continue;
      if (!par.slice(0, igual).trim().startsWith("__client_uat")) continue;
      // Una marca de tiempo es una sesión; "0" es que se cerró. Clerk puede
      // escribir la cookie con y sin sufijo: basta con que UNA diga sesión.
      if (/^[1-9]\d*$/.test(par.slice(igual + 1).trim())) {
        cookie = "cuenta";
        break;
      }
      cookie = "invitado";
    }
  } catch {
    /* cookies inaccesibles: se sigue con el almacenamiento */
  }
  if (cookie === "invitado") return { tipo: "invitado" };

  try {
    const ultima = window.localStorage.getItem(CLAVE_ULTIMA_IDENTIDAD);
    const idApuntado = ultima && ultima !== "guest" ? ultima : null;
    if (cookie === "cuenta") return { tipo: "cuenta", id: idApuntado ?? unicaCuentaConSaldo() };
    if (ultima === "guest") return { tipo: "invitado" };
    if (idApuntado) return { tipo: "cuenta", id: idApuntado };

    const local = window.localStorage.getItem(COLLECTION_STORAGE_KEY);
    if (local && local !== "[]") return { tipo: "invitado" };
    if (hayAlgunaCuentaConSaldo()) return { tipo: "cuenta", id: unicaCuentaConSaldo() };
  } catch {
    /* almacenamiento bloqueado: manda lo que dijera la cookie */
  }
  return cookie === "cuenta" ? { tipo: "cuenta", id: null } : { tipo: "invitado" };
}

/** Ids de las cuentas que han dejado saldo guardado en este dispositivo. */
function cuentasConSaldo(): string[] {
  const ids: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const clave = window.localStorage.key(i) ?? "";
    if (clave.startsWith(PREFIJO_SALDO) && clave !== CLAVE_SALDO_INVITADO) {
      ids.push(clave.slice(PREFIJO_SALDO.length));
    }
  }
  return ids;
}

const hayAlgunaCuentaConSaldo = (): boolean => cuentasConSaldo().length > 0;

/**
 * Si sólo ha habido UNA cuenta en este dispositivo, ésa. Con dos no se puede
 * saber de cuál era la sesión, y enseñar el saldo de la otra sería peor que no
 * enseñar ninguno.
 */
function unicaCuentaConSaldo(): string | null {
  const ids = cuentasConSaldo();
  return ids.length === 1 ? ids[0] : null;
}
