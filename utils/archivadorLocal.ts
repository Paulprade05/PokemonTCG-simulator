// utils/archivadorLocal.ts
//
// EL ARCHIVADOR DEL INVITADO.
//
// Quien juega sin cuenta guarda su colección en localStorage (utils/storage.ts)
// y su archivador también tiene que vivir ahí: montar una vitrina y perderla al
// recargar sería peor que no ofrecerla.
//
// LA FORMA ES LA MISMA QUE LA DEL SERVIDOR a propósito —{hoja, ranura, cardId}—
// para que la pantalla no tenga dos modelos de datos. Lo único que cambia es de
// dónde salen las filas; todo lo que hay encima es idéntico.
//
// LO QUE ESTE FICHERO NO HACE: comprobar que la carta sea suya. No puede, y
// tampoco importa: el archivador del invitado sólo lo ve el invitado, en su
// propio navegador. En el servidor esa comprobación SÍ existe (ponerEnRanura),
// porque allí lo que se guarda se le puede enseñar a otra persona.

const CLAVE = "tcg-archivador-invitado";

/** Una funda ocupada. Vacías no se guardan. */
export interface FundaLocal {
  hoja: number;
  ranura: number;
  cardId: string;
}

/** Fundas por hoja. Tiene que coincidir con RANURAS_POR_HOJA del servidor. */
export const RANURAS_POR_HOJA = 9;

/** Tope de hojas, el mismo que el servidor. */
export const MAX_HOJAS = 60;

/**
 * Lectura tolerante, calcada del criterio de utils/storage.ts: cualquier cosa
 * que no sea una lista de fundas con forma buena se descarta en silencio y se
 * empieza de cero. Un localStorage manipulado a mano, un JSON a medio escribir
 * por una pestaña que se cerró, o un formato viejo no pueden dejar la pantalla
 * en blanco.
 */
export function leerArchivadorLocal(): FundaLocal[] {
  if (typeof window === "undefined") return [];
  try {
    const crudo = localStorage.getItem(CLAVE);
    if (!crudo) return [];
    const datos = JSON.parse(crudo);
    if (!Array.isArray(datos)) return [];
    return datos.filter(
      (f): f is FundaLocal =>
        f &&
        typeof f.cardId === "string" &&
        Number.isInteger(f.hoja) &&
        Number.isInteger(f.ranura) &&
        f.hoja >= 0 &&
        f.hoja < MAX_HOJAS &&
        f.ranura >= 0 &&
        f.ranura < RANURAS_POR_HOJA,
    );
  } catch {
    return [];
  }
}

/**
 * Escritura. Devuelve false si no cupo (cuota agotada, típico en iOS con una
 * colección grande), para que quien llame pueda avisar en vez de dar por hecho
 * que se guardó.
 */
export function guardarArchivadorLocal(fundas: FundaLocal[]): boolean {
  if (typeof window === "undefined") return false;
  try {
    localStorage.setItem(CLAVE, JSON.stringify(fundas));
    return true;
  } catch {
    return false;
  }
}

/**
 * Pone una carta en una funda, sustituyendo lo que hubiera.
 *
 * `copiasDisponibles` es cuántas tiene el jugador de esa carta: la misma puede
 * ir en varias fundas, pero no más veces que copias. Es la misma regla que
 * aplica el servidor, escrita aquí otra vez porque el invitado no pasa por él.
 */
export function ponerEnRanuraLocal(
  fundas: FundaLocal[],
  hoja: number,
  ranura: number,
  cardId: string,
  copiasDisponibles: number,
): { fundas: FundaLocal[]; ok: boolean; motivo?: "sin-copias-libres" } {
  const yaPuestas = fundas.filter(
    (f) => f.cardId === cardId && !(f.hoja === hoja && f.ranura === ranura),
  ).length;
  if (yaPuestas >= copiasDisponibles) {
    return { fundas, ok: false, motivo: "sin-copias-libres" };
  }
  const resto = fundas.filter((f) => !(f.hoja === hoja && f.ranura === ranura));
  return { fundas: [...resto, { hoja, ranura, cardId }], ok: true };
}

/** Vacía una funda. La carta sigue en la colección. */
export function quitarDeRanuraLocal(
  fundas: FundaLocal[],
  hoja: number,
  ranura: number,
): FundaLocal[] {
  return fundas.filter((f) => !(f.hoja === hoja && f.ranura === ranura));
}
