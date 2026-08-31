// utils/bazar.ts
//
// LAS REGLAS DEL BAZAR ENTRE JUGADORES, en un fichero puro y sin imports para
// que scripts/test-invariantes.mjs pueda cargarlas y comprobarlas.
//
// ============================================================================
// POR QUÉ ESTE FICHERO ES CASI TODO DEFENSA
// ============================================================================
//
// Hasta ahora, en este juego las monedas NO SE PODÍAN MOVER entre cuentas. Se
// comprobó a mano: toda escritura sobre `users.coins` lleva `WHERE id =
// ${userId}` con el id sacado de la sesión, no hay acción de regalo ni de
// propina, y el intercambio (app/social.ts) es trueque puro carta por carta,
// sin ningún campo de monedas.
//
// Eso era lo único que hacía inofensivo el otro agujero, que sí existe: crear
// cuentas es gratis y cada cuenta nueva recibe 1.000 monedas de salida más
// 165-300 cada 20 horas, más 1.000 por cada expansión completada. Un bazar con
// precio libre convierte ese grifo en dinero para la cuenta principal: basta
// con publicar una carta a 10.000 y comprársela desde la otra cuenta.
//
// LAS CUATRO DEFENSAS. No son alternativas, van juntas:
//
//   1. BANDA DE PRECIO. El precio no lo pone del todo el vendedor: tiene que
//      caer entre el 50% y el 150% del valor real de la carta, que lo calcula
//      el servidor. Vender un Common por 10.000 no se rechaza al comprar — es
//      que la publicación no se llega a crear. Esto por sí solo convierte el
//      lavado en "mover como mucho el valor de una carta", que es lo mismo que
//      ya permitía el trueque.
//
//   2. COMISIÓN. El vendedor cobra menos de lo que paga el comprador y la
//      diferencia SE DESTRUYE, no va a nadie. Cada pase entre cuentas pierde
//      ese porcentaje, así que el ciclo de lavado se desangra en vez de ser
//      gratis. Es además el primer sumidero de monedas del juego aparte de la
//      compra de sobres.
//
//   3. ANTIGÜEDAD MEDIDA EN JUEGO, NO EN DÍAS. Para publicar hay que haber
//      abierto un mínimo de sobres. Una cuenta recién creada no puede vender, y
//      abrir sobres cuesta las monedas que la cuenta acaba de recibir: montar
//      una granja de cuentas deja de ser gratis y pasa a costar tiempo real y
//      monedas. Se apoya en `users.packs_opened`, que ya existe y que ya lleva
//      la cuenta.
//
//   4. LA COPIA RESERVADA SÍ APLICA, al revés que en el trueque. La asimetría
//      es deliberada y está razonada en app/social.ts:227-250: el trueque sólo
//      MUEVE cartas y su delta neto suma cero, así que reservar una copia
//      impediría intercambiar las cartas únicas, que son justo las que se
//      quieren intercambiar. El bazar, en cambio, SACA la carta a cambio de
//      monedas: es un mercado, y cae del lado de utils/mercado.ts.
//
// Ninguna de las cuatro se puede quitar sola sin reabrir el agujero.

/** Suelo de la banda: nadie puede publicar por debajo de esta fracción. */
export const PRECIO_MINIMO_FRACCION = 0.5;

/** Techo de la banda: ni por encima de ésta. */
export const PRECIO_MAXIMO_FRACCION = 1.5;

/**
 * Comisión del bazar, sobre el precio de venta. Se DESTRUYE.
 *
 * POR QUÉ 15% Y NO 5%: con el techo de la banda en 150%, el mejor caso para
 * quien intenta lavar es publicar al 150% del valor. Con comisión c, mover una
 * carta de valor V traslada 1,5·V monedas del comprador al vendedor, de las
 * que llegan 1,5·V·(1−c). Con c = 0,15 se pierde el 15% en cada pase, y una
 * granja de cuentas alternativas tiene que abrir sobres —a pérdida, porque el
 * retorno de reventa está calibrado por debajo del 100%— para tener algo que
 * vender. La suma de las dos pérdidas hace el ciclo claramente negativo.
 *
 * Y para el jugador honesto es una comisión de mercadillo, que se entiende sola.
 */
export const COMISION = 0.15;

/** Sobres abiertos que hay que llevar encima para poder publicar. */
export const SOBRES_PARA_VENDER = 25;

/**
 * Sobres abiertos que hacen falta para COMPRAR.
 *
 * POR QUÉ HAY UNA BARRERA TAMBIÉN AQUÍ, que es lo que no era obvio: la primera
 * versión sólo cerraba la venta, y eso protege la dirección equivocada.
 *
 * Recorriendo el lavado de verdad: la cuenta alternativa es la que TIENE las
 * monedas del grifo (1.000 de salida más 165-300 cada 20 horas) y quiere
 * pasárselas a la principal. Para eso la principal PUBLICA y la alternativa
 * COMPRA. O sea que quien tiene que atravesar la barrera es el comprador, y con
 * ella sólo en la venta una cuenta recién creada podía vaciar su cartera en la
 * principal el mismo día.
 *
 * Es más baja que la de vender —10 frente a 25— porque su función es distinta:
 * no busca impedir la compra, busca que montar una granja de cuentas cueste
 * tiempo real y monedas. Diez sobres estándar son 500 monedas de las 1.000 con
 * las que nace la cuenta, así que el propio peaje se lleva la mitad de lo que
 * se pretendía lavar, y encima hay que estar abriéndolos.
 *
 * Un jugador normal cruza las dos barreras sin enterarse: abrir sobres es
 * literalmente lo que se hace en este juego.
 */
export const SOBRES_PARA_COMPRAR = 10;

/** Publicaciones abiertas a la vez por usuario. Freno de spam, no de economía. */
export const MAX_ANUNCIOS_ABIERTOS = 20;

/** La banda de precio permitida para una carta que vale `valor` monedas. */
export function bandaDePrecio(valor: number): { min: number; max: number } {
  const v = Math.max(1, Math.round(Number(valor) || 0));
  return {
    min: Math.max(1, Math.round(v * PRECIO_MINIMO_FRACCION)),
    max: Math.max(2, Math.round(v * PRECIO_MAXIMO_FRACCION)),
  };
}

/** ¿Cabe este precio para una carta de este valor? */
export function precioValido(precio: number, valor: number): boolean {
  if (!Number.isInteger(precio) || precio <= 0) return false;
  const { min, max } = bandaDePrecio(valor);
  return precio >= min && precio <= max;
}

/**
 * Lo que se lleva la casa de una venta. Se redondea hacia arriba para que la
 * comisión nunca sea 0 en las ventas pequeñas: un bazar de cartas de 2 monedas
 * sin comisión sería otra vez un canal libre.
 */
export function comisionDe(precio: number): number {
  return Math.max(1, Math.ceil(precio * COMISION));
}

/** Lo que cobra de verdad el vendedor. */
export function pagoAlVendedor(precio: number): number {
  return Math.max(0, precio - comisionDe(precio));
}
