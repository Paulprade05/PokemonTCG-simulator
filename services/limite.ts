// services/limite.ts
//
// TOPE DE FRECUENCIA EN MEMORIA, POR INSTANCIA. Módulo puro, sin imports y SIN
// 'use server': en un fichero 'use server' cada función exportada es un
// endpoint POST, y esto es una pieza interna que sólo llaman las acciones.
//
// ============================================================================
// EL AGUJERO QUE CIERRA, Y HASTA DÓNDE
// ============================================================================
//
// Ninguna acción tenía límite de frecuencia. `comprarSobreAction`, incluso con
// la cuenta a cero, leía el catálogo, la ficha y la colección, sorteaba hasta
// diez sobres y lanzaba la sentencia de cobro: un script con una cuenta
// gratuita mandando 50 POST por segundo eran unas 200 consultas por segundo
// contra Postgres y la CPU del sorteo, sin cobrar nada.
//
// ESTO ES UNA MITIGACIÓN, NO UN LIMITADOR DE VERDAD, y conviene no creerse más
// de lo que es:
//
//   · La cuenta vive en la memoria de UNA instancia. Vercel reparte las
//     peticiones entre varias y las crea y destruye cuando quiere, así que el
//     tope real es (este tope) × (instancias vivas). Lo que sí garantiza es
//     que NINGUNA instancia trabaje sin freno para un mismo usuario, que es lo
//     que convertía un bucle de un script en carga sostenida sobre la base.
//   · Se pierde en cada arranque en frío. Da igual: la ventana es de segundos.
//   · Va por USUARIO (el id de la sesión), no por IP. No protege las lecturas
//     sin sesión; para ésas la defensa es no hacer trabajo caro (la caché de
//     `getSetsFromDB` en app/action.ts) o una regla en el borde.
//
// POR QUÉ NO UNA TABLA EN POSTGRES, que sería exacta entre instancias: cada
// petición pasaría a costar una ESCRITURA más justo en las acciones que se
// quiere abaratar, y bajo ataque esa escritura es carga añadida sobre la misma
// base que se intenta proteger. Un limitador exacto pide algo fuera de la base
// (Redis, o el cortafuegos de Vercel) y eso es infraestructura nueva: decisión
// del dueño, no de este módulo.
//
// VENTANA FIJA y no deslizante: en el peor caso deja pasar el doble del tope a
// caballo entre dos ventanas. Para lo que es —cortar un bucle— sobra, y a
// cambio son dos números por clave y ninguna lista de marcas de tiempo.

/** Cuántas llamadas (`max`) se admiten en cada ventana de `ventanaMs`. */
export interface ReglaDeLimite {
  max: number;
  ventanaMs: number;
}

/**
 * Los topes de cada acción cara. Están MUY por encima de lo que hace una
 * persona —cada una de estas acciones va detrás de un toque y casi siempre de
 * una animación— para que ningún jugador se los encuentre jamás: quien los
 * alcanza es un bucle.
 */
export const LIMITES = {
  /** Un ×10 es UNA llamada. Veinte compras en diez segundos no las hace nadie. */
  comprarSobre: { max: 20, ventanaMs: 10_000 },
  /** Hasta 40 copias por llamada; cada una calcula notas y bloquea filas. */
  graduar: { max: 10, ventanaMs: 10_000 },
  publicarEnBazar: { max: 12, ventanaMs: 10_000 },
  comprarEnBazar: { max: 12, ventanaMs: 10_000 },
  /** Cada entrega valida el lote contra el tablón: es la acción con más CPU. */
  cumplirOferta: { max: 10, ventanaMs: 10_000 },
  /** Vaciados y ventas en lote: recorren la colección entera. */
  ventaEnLote: { max: 8, ventanaMs: 10_000 },
  /** Marcar y desmarcar deseadas es un toque rápido: tope holgado. */
  deseos: { max: 40, ventanaMs: 10_000 },
} as const satisfies Record<string, ReglaDeLimite>;

interface Cubo {
  /** Cuándo empezó la ventana en curso (ms). */
  desde: number;
  /** Llamadas contadas en ella. */
  n: number;
}

const cubos = new Map<string, Cubo>();

/**
 * Tope de claves en memoria. Sin él, un atacante con muchas cuentas haría
 * crecer el mapa sin fin en una instancia longeva. Al llegar se tiran primero
 * las ventanas ya vencidas y, si aun así no cabe, todas: es preferible perdonar
 * una ventana a todo el mundo que quedarse sin memoria.
 */
const MAX_CLAVES = 20_000;

function podar(ahora: number, ventanaMs: number): void {
  for (const [clave, cubo] of cubos) {
    if (ahora - cubo.desde >= ventanaMs) cubos.delete(clave);
  }
  if (cubos.size >= MAX_CLAVES) cubos.clear();
}

/**
 * ¿Cabe esta llamada? Cuenta la llamada y devuelve `false` cuando la clave ya
 * ha gastado su tope en la ventana en curso.
 *
 * @param clave  quién y qué: "sobre:" + userId. El prefijo evita que dos
 *               acciones compartan cuenta.
 * @param regla  una de LIMITES.
 * @param ahora  sólo para poder probarlo sin esperar; por defecto, el reloj.
 */
export function dentroDelLimite(
  clave: string,
  regla: ReglaDeLimite,
  ahora: number = Date.now(),
): boolean {
  const cubo = cubos.get(clave);
  if (!cubo || ahora - cubo.desde >= regla.ventanaMs) {
    if (!cubo && cubos.size >= MAX_CLAVES) podar(ahora, regla.ventanaMs);
    cubos.set(clave, { desde: ahora, n: 1 });
    return true;
  }
  cubo.n += 1;
  return cubo.n <= regla.max;
}

/** Sólo para pruebas: cuántas claves hay en memoria. */
export function clavesEnMemoria(): number {
  return cubos.size;
}
