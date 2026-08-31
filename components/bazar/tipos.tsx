/**
 * Los tipos que cruzan la pantalla del bazar.
 *
 * POR QUÉ EXISTEN, si las server actions ya devuelven objetos: porque los
 * devuelven como `any[]`. Todo lo que sale de `app/action.ts` hacia una pantalla
 * pasa por `enIdiomaUsuario`, que está tipada `Promise<any[]>` para poder
 * traducir cartas de cuatro formas distintas; el `strict: true` del proyecto no
 * vigila nada al otro lado de ese `any`. Estos tipos son el contrato que la
 * pantalla asume, escrito UNA vez, para que un cambio de nombre de campo en el
 * servidor salga aquí como error de compilación y no como un `undefined`
 * pintado en medio de un precio.
 *
 * No son "el tipo completo del anuncio": son exactamente los campos que
 * `getBazar` y `getMisAnunciosBazar` documentan. Si algún día devuelven más, se
 * añaden aquí; copiar la fila de la base de datos entera sólo conseguiría que
 * la pantalla se creyera dueña de campos que nadie le garantiza.
 */

/** Una carta puesta a la venta por alguien, tal y como la sirve `getBazar`. */
export interface AnuncioBazar {
  id: number;
  cardId: string;
  name: string;
  rarity: string;
  images: { small: string; large: string };
  setId: string;
  /** Lo que paga el comprador. La comisión ya va DENTRO de esta cifra. */
  precio: number;
  /** Nota de graduación, o null si es una copia suelta. */
  nota: number | null;
  graduada: boolean;
  vendedor: string;
  /** Lo calcula el servidor con la sesión; sin sesión es siempre false. */
  esMio: boolean;
  /** Lo que se queda la casa. `precio - comision` es lo que cobra el vendedor. */
  comision: number;
}

/** Estados que puede tener un anuncio propio. Los escribe `bazar_listings`. */
export type EstadoAnuncio = "activa" | "vendida" | "retirada";

/** Un anuncio propio, tal y como lo sirve `getMisAnunciosBazar`. */
export interface MiAnuncio {
  id: number;
  cardId: string;
  name: string;
  rarity: string;
  images: { small: string; large: string };
  precio: number;
  /** Lo que cobras tú: `precio` menos la comisión. Lo calcula el servidor. */
  cobrarias: number;
  nota: number | null;
  /* Se tipa como string y no como EstadoAnuncio a propósito: el servidor lo
   * saca de una columna de texto libre y la pantalla tiene que saber pintar un
   * estado que todavía no conoce sin romperse. El rótulo cae a "Cerrada". */
  estado: string;
}

/**
 * Una carta que el jugador PUEDE publicar ahora mismo, ya normalizada.
 *
 * Une las dos procedencias —copias sueltas y copias graduadas— en una sola
 * forma para que el selector y el paso de precio no tengan que preguntar de
 * dónde vino cada una. La diferencia se guarda en `gradedId`: si es null es una
 * copia suelta, y si no, la fila de `graded_cards` que viaja en la publicación.
 */
export interface Publicable {
  /** Identidad dentro del selector: "suelta:sv8-1" o "graduada:37". */
  clave: string;
  cardId: string;
  gradedId: number | null;
  name: string;
  rarity: string;
  images: { small: string; large: string };
  /** Nota (1-10) si está graduada. */
  nota: number | null;
  /** Rótulo de la nota ("Impecable"...). Lo manda ya hecho `getVitrina`. */
  etiqueta: string | null;
  /**
   * EL VALOR QUE USA EL SERVIDOR PARA LA BANDA, no una estimación de la
   * pantalla. Ver el comentario largo de PublicarSheet.tsx: si esta cifra no es
   * exactamente la del servidor, el extremo bajo del deslizador queda fuera de
   * la banda real y la publicación se rechaza después de haberla ofrecido.
   */
  valor: number;
  /** Copias de esa carta en la colección (las graduadas también cuentan). */
  copias: number;
  /** Copias que de verdad puede publicar ahora, ya descontada la reservada. */
  sobrantes: number;
}
