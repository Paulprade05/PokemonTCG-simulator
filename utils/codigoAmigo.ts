// utils/codigoAmigo.ts
//
// EL CÓDIGO DE AMIGO: ocho caracteres que se dictan, se teclean y caben en un
// enlace. Fichero puro y SIN IMPORTS, como utils/bazar.ts, para que lo carguen
// igual el servidor (app/social.ts), las pantallas y scripts/test-invariantes.mjs.
//
// POR QUÉ EXISTE. Hasta ahora el único identificador de un jugador era su id de
// Clerk (`user_…`, unos 32 caracteres): imposible de dictar, y además abría el
// álbum de quien lo tuviera (getTrainerCollection sólo pide sesión y un id). La
// pantalla lo enseñaba como «Tu ID» con un botón de copiar, pero no había
// ningún campo donde pegarlo: añadir a alguien dependía de acertar con su
// nombre, que ni es único ni existe hasta que esa persona abre Social.
//
// POR QUÉ ES ALEATORIO Y NO SE DERIVA DEL ID. Un código derivado no se podría
// buscar sin recorrer todos los usuarios, dos ids que chocaran no tendrían
// arreglo y no se podría cambiar. Aleatorio y guardado en `friend_codes`
// (services/esquemaSocial.ts) se busca por índice, la colisión se resuelve
// sorteando otro, y quien lo haya compartido donde no debía pide uno nuevo.

/**
 * 31 símbolos: los dígitos 2-9 y las letras sin I, L ni O. Fuera quedan justo
 * los que se confunden al leerlos en voz alta o en una captura (0/O, 1/I/L).
 * 31⁸ ≈ 8,5·10¹¹ códigos: acertar uno a ciegas no es un ataque, y lo único que
 * da acertarlo es poder enviar una petición que el otro tiene que aceptar.
 *
 * NO SE PUEDE CAMBIAR SIN MIGRAR: es la misma clase de caracteres que el CHECK
 * de `friend_codes` y que `FORMA_CODIGO_AMIGO`. Las tres van juntas.
 */
export const ALFABETO_CODIGO_AMIGO = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export const LONGITUD_CODIGO_AMIGO = 8;

/**
 * La forma CANÓNICA, la que se guarda y la que viaja en el enlace: ocho
 * caracteres en mayúsculas y sin guion. El guion de `ABCD-2345` es sólo de
 * pantalla (ver `formatearCodigoAmigo`).
 */
export const FORMA_CODIGO_AMIGO = /^[2-9A-HJKMNP-Z]{8}$/;

/** Tope de lo que se acepta leer. Un mensaje compartido entero ronda los 120. */
const MAX_ENTRADA = 400;

export function esCodigoAmigo(valor: unknown): valor is string {
  return typeof valor === "string" && FORMA_CODIGO_AMIGO.test(valor);
}

/**
 * Entero uniforme en [0, tope) con el generador criptográfico de la plataforma.
 *
 * `globalThis.crypto` y no `node:crypto` porque este módulo no puede importar
 * nada (lo cargan el navegador y el cargador de los invariantes). Y con
 * RECHAZO, no con `% tope` a secas: 256 no es múltiplo de 31, así que el resto
 * directo haría un poco más probables los ocho primeros símbolos.
 */
function azarSeguro(tope: number): number {
  const limite = 256 - (256 % tope);
  const cubo = new Uint8Array(16);
  for (;;) {
    globalThis.crypto.getRandomValues(cubo);
    for (let i = 0; i < cubo.length; i++) {
      if (cubo[i] < limite) return cubo[i] % tope;
    }
  }
}

/**
 * Un código nuevo. `azar` se puede inyectar: el servidor pasa `randomInt` de
 * `node:crypto` y los invariantes un generador determinista. Que el código no
 * esté ya cogido NO se sabe aquí: lo decide el índice único de `friend_codes`,
 * y quien llama reintenta si choca.
 */
export function generarCodigoAmigo(azar: (tope: number) => number = azarSeguro): string {
  let codigo = "";
  for (let i = 0; i < LONGITUD_CODIGO_AMIGO; i++) {
    const n = azar(ALFABETO_CODIGO_AMIGO.length);
    // Un `azar` inyectado que se salga del rango daría `undefined` pegado a la
    // cadena; mejor fallar aquí que guardar un código que el CHECK rechaza.
    if (!Number.isInteger(n) || n < 0 || n >= ALFABETO_CODIGO_AMIGO.length) {
      throw new Error("generarCodigoAmigo: el generador devolvió un valor fuera de rango");
    }
    codigo += ALFABETO_CODIGO_AMIGO[n];
  }
  return codigo;
}

/**
 * De lo que TECLEA O PEGA una persona al código canónico, o `null` si ahí no
 * hay ningún código.
 *
 * Acepta, a propósito, todo lo que sale de un uso normal:
 *   · `abcd-2345`, `ABCD 2345`, `abcd2345`  → lo que se dicta o se copia;
 *   · `#ABCD2345`                           → copiado de una etiqueta;
 *   · `https://…/invitar/ABCD2345`          → el enlace pegado en el campo;
 *   · el mensaje entero de «Compartir»      → trae el código con guion y el
 *     enlace; se saca del enlace y, si no hay, del `XXXX-XXXX` del texto.
 *
 * NO CORRIGE CARACTERES AMBIGUOS (una O por un 0, una I por un 1): el alfabeto
 * no tiene ninguno de los dos, así que no hay a qué corregirlos. Un código con
 * esos caracteres está mal copiado y se rechaza, que es lo que le hace
 * volver a mirarlo.
 *
 * Y NO DEVUELVE NADA A MEDIAS: o salen los ocho caracteres válidos o sale
 * `null`. Quien llama decide entonces si lo trata como un nombre.
 */
export function normalizarCodigoAmigo(entrada: unknown): string | null {
  if (typeof entrada !== "string") return null;
  if (entrada.length === 0 || entrada.length > MAX_ENTRADA) return null;
  const texto = entrada.trim();
  if (!texto) return null;

  // 1) Un enlace de invitación, esté solo o dentro de un mensaje.
  const enlace = /\/invitar\/([A-Za-z0-9-]{8,9})(?![A-Za-z0-9-])/.exec(texto);
  if (enlace) {
    const deEnlace = limpiar(enlace[1]);
    if (FORMA_CODIGO_AMIGO.test(deEnlace)) return deEnlace;
  }

  // 2) El texto entero es el código, con los adornos que se le ponen al
  //    escribirlo a mano.
  const directo = limpiar(texto);
  if (FORMA_CODIGO_AMIGO.test(directo)) return directo;

  // 3) Un `XXXX-XXXX` dentro de una frase. Sólo CON guion: sin él, cualquier
  //    palabra de ocho letras del alfabeto («SAMANTHA») pasaría por código.
  const enFrase = /(?:^|[^A-Za-z0-9])([2-9A-HJKMNP-Za-hjkmnp-z]{4})-([2-9A-HJKMNP-Za-hjkmnp-z]{4})(?![A-Za-z0-9])/.exec(texto);
  if (enFrase) {
    const deFrase = (enFrase[1] + enFrase[2]).toUpperCase();
    if (FORMA_CODIGO_AMIGO.test(deFrase)) return deFrase;
  }

  return null;
}

/** Mayúsculas y fuera separadores: espacios, la almohadilla y cualquier guion. */
function limpiar(texto: string): string {
  return texto.toUpperCase().replace(/[\s#._\-‐-―−]/g, "");
}

/**
 * Cómo se ENSEÑA: `ABCD-2345`. Dos grupos de cuatro se leen y se dictan mejor
 * que ocho caracteres seguidos. Lo que no sea un código se devuelve tal cual,
 * para que una pantalla nunca pinte un guion en medio de otra cosa.
 */
export function formatearCodigoAmigo(codigo: string): string {
  if (!esCodigoAmigo(codigo)) return typeof codigo === "string" ? codigo : "";
  return `${codigo.slice(0, 4)}-${codigo.slice(4)}`;
}

/**
 * Los cuatro últimos caracteres: lo que distingue a dos «Paul» en una lista
 * (`Paul #2345`). Es la mitad del código a propósito: basta para distinguir a
 * dos homónimos y no basta para añadir a nadie.
 */
export function etiquetaDeCodigo(codigo: string): string {
  return typeof codigo === "string" ? codigo.slice(-4) : "";
}

/**
 * Ruta de la invitación. Lleva el código canónico —sin guion— y NUNCA el id de
 * Clerk, que es lo que hoy basta para abrir el álbum de alguien.
 */
export function rutaDeInvitacion(codigo: string): string {
  return `/invitar/${codigo}`;
}

/**
 * Matiz (0-359) estable para el avatar de un entrenador.
 *
 * Se calcula SIEMPRE sobre los cuatro últimos caracteres, tanto si se le pasa
 * el código entero como si sólo se tiene la etiqueta: hay sitios (la ficha
 * abierta desde un anuncio del bazar) donde el código no se entrega, y la misma
 * persona tiene que salir del mismo color en todos.
 */
export function matizDeCodigo(codigoOEtiqueta: string): number {
  const cola = typeof codigoOEtiqueta === "string" ? codigoOEtiqueta.slice(-4).toUpperCase() : "";
  let h = 0;
  for (let i = 0; i < cola.length; i++) {
    h = (h * 31 + cola.charCodeAt(i)) % 360;
  }
  return h;
}
