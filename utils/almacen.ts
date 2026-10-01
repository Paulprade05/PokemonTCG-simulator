// utils/almacen.ts
//
// localStorage QUE NO LANZA.
//
// Tocar `localStorage` puede lanzar, y no sólo al escribir: en un iPhone con
// "Bloquear todas las cookies" el mero acceso a `window.localStorage` da
// SecurityError, y con la cuota llena lo da `setItem`. El proveedor del saldo
// (hooks/useGameCurrency.tsx) lo leía y lo escribía sin guarda dentro de
// efectos, y como vive en AppShell —por encima de app/error.tsx— la excepción
// subía hasta global-error: "La aplicación no ha podido arrancar" en todas las
// rutas, y "Reintentar" volvía a caer en lo mismo. Una configuración rara, pero
// para quien la tiene la app entera era inutilizable.
//
// La regla de la casa ya era ésta (utils/settings.ts, utils/archivadorLocal.ts
// la cumplen a mano); aquí queda escrita una vez para quien no necesita nada
// más que leer o escribir una cadena.
//
// NO IMPORTA NADA, a propósito: lo pueden usar módulos que el cargador de
// scripts/test-invariantes.mjs abre sin resolver dependencias.

/** El valor guardado, o null si no existe O si el almacenamiento no deja. */
export function leerLocal(clave: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(clave);
  } catch {
    return null;
  }
}

/**
 * Guarda y dice si se pudo. `false` es "no hay almacenamiento o no cabe": quien
 * llama decide si avisa o si le basta con que el dato viva en memoria lo que
 * dure la sesión.
 */
export function escribirLocal(clave: string, valor: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(clave, valor);
    return true;
  } catch {
    return false;
  }
}

/** Retira la clave y dice si se pudo. */
export function borrarLocal(clave: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.removeItem(clave);
    return true;
  } catch {
    return false;
  }
}
