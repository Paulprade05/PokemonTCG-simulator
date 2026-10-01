/**
 * LO QUE LA TIENDA RECUERDA ENTRE VISITAS.
 *
 * POR QUÉ EXISTE. `app/page.tsx` guarda todo su estado en el componente, y el
 * componente se desmonta cada vez que se cambia de pestaña: volver de Colección
 * a Inicio era empezar de cero —lista de expansiones, catálogo descargado otra
 * vez, carrusel en el primer sobre—, y un arranque sin red era una portada en
 * blanco porque no había nada guardado que pintar mientras tanto.
 *
 * Aquí viven las cosas que sobreviven a ese desmontaje, cada una con su clave y
 * su validación, para que la página no tenga que saber de localStorage:
 *
 *   · la última LISTA DE EXPANSIONES que contestó el servidor (se pinta al
 *     instante y se revalida detrás);
 *   · la última EXPANSIÓN y TIPO DE SOBRE que se compró ("seguir abriendo");
 *   · la preferencia de APERTURA RÁPIDA;
 *   · la COMPRA SIN CONFIRMAR, que es la que permite reintentar con la misma
 *     clave aunque iOS haya matado la aplicación entre medias;
 *   · y, sólo en memoria, los CATÁLOGOS de set ya descargados.
 *
 * TODO VA EN try/catch Y TODO SE VALIDA AL LEER. En el modo privado de iOS
 * localStorage existe pero lanza, y lo que hay dentro lo puede haber escrito
 * cualquiera con la consola abierta: una clave corrupta no puede tumbar la
 * portada ni colar una forma rara hasta una server action.
 *
 * NINGUNA FUNCIÓN DE AQUÍ SE LLAMA DURANTE EL RENDER. Se leen dentro de efectos
 * o de manejadores, igual que `leerSeriesAbiertas`: el componente se renderiza
 * también en el servidor y un valor distinto en los dos lados rompe la
 * hidratación.
 */
import type { Carta, Expansion } from "../../utils/tipos";

/** Los cuatro sobres que vende la tienda (el mismo vocabulario del servidor). */
export type TipoDeSobre = "STANDARD" | "PREMIUM" | "GOLDEN" | "SPECIAL";
const TIPOS: readonly string[] = ["STANDARD", "PREMIUM", "GOLDEN", "SPECIAL"];

/** La misma forma que exige `comprarSobreAction`: lo que no la cumpla no viaja. */
const ID_DE_SET = /^[a-z0-9._-]{1,40}$/i;
const CLAVE_DE_COMPRA = /^[A-Za-z0-9._:-]{8,64}$/;

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function leer(clave: string): unknown {
  try {
    const crudo = localStorage.getItem(clave);
    return crudo ? JSON.parse(crudo) : null;
  } catch {
    return null;
  }
}

/** Guardar es siempre opcional: sin sitio o sin permiso, sólo no se recuerda. */
function escribir(clave: string, valor: unknown): boolean {
  try {
    localStorage.setItem(clave, JSON.stringify(valor));
    return true;
  } catch {
    return false;
  }
}

function olvidar(clave: string): void {
  try {
    localStorage.removeItem(clave);
  } catch {
    /* almacenamiento inaccesible: no hay nada que olvidar */
  }
}

/* ------------------------------------------------------------------ *
 * LA ÚLTIMA LISTA DE EXPANSIONES
 * ------------------------------------------------------------------ *
 *
 * Con la PWA instalada no hay recarga ni barra de direcciones: si
 * `getSetsFromDB` fallaba al salir del metro, la portada se quedaba en blanco
 * hasta cerrar la aplicación desde el selector. Con la lista guardada se pinta
 * la de la última vez y se dice que es la guardada.
 *
 * SE GUARDA ADELGAZADA: sólo los campos que la portada y la tienda leen. Son
 * unos 300 bytes por expansión (~50 KB con las 171), en un almacén que comparte
 * cuota con la colección entera del invitado.
 *
 * EL IDIOMA VA PEGADO. Los nombres llegan ya traducidos del servidor; una lista
 * guardada en inglés pintada con la app en español se corregiría sola al
 * revalidar, pero sin red se quedaría así, y parecería que el idioma está roto.
 */
const CLAVE_SETS = "tcg-sets-cache";

/** Era `Expansion` más `serieEs`, cuando el tipo compartido no lo declaraba.
 *  Ya lo declara (utils/tipos.ts); el nombre se queda para quien lo importa. */
export type ExpansionConSerie = Expansion;

const texto = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 && v.length <= 300 ? v : undefined;
const numero = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function adelgazar(crudo: unknown): ExpansionConSerie | null {
  if (!esObjeto(crudo)) return null;
  const id = texto(crudo.id);
  const name = texto(crudo.name);
  if (!id || !name || !ID_DE_SET.test(id)) return null;
  const imagenes = esObjeto(crudo.images) ? crudo.images : {};
  const limpia: ExpansionConSerie = { id, name };
  const nameEn = texto(crudo.nameEn);
  if (nameEn) limpia.nameEn = nameEn;
  const series = texto(crudo.series);
  if (series) limpia.series = series;
  const serieEs = texto(crudo.serieEs);
  if (serieEs) limpia.serieEs = serieEs;
  const logo = texto(imagenes.logo);
  const symbol = texto(imagenes.symbol);
  if (logo || symbol) {
    limpia.images = { ...(logo ? { logo } : {}), ...(symbol ? { symbol } : {}) };
  }
  // Los dos totales pueden llegar como texto desde Postgres: se guardan ya
  // como número, que es como los lee todo el que los usa (`Number(set.total)`).
  const total = numero(Number(crudo.total));
  if (total !== undefined && crudo.total != null) limpia.total = total;
  const cardsCount = numero(Number(crudo.cardsCount));
  if (cardsCount !== undefined && crudo.cardsCount != null) limpia.cardsCount = cardsCount;
  if (typeof crudo.tieneEs === "boolean") limpia.tieneEs = crudo.tieneEs;
  const variantesSobre = numero(crudo.variantesSobre);
  if (variantesSobre !== undefined) limpia.variantesSobre = variantesSobre;
  const releaseDate = texto(crudo.releaseDate);
  if (releaseDate) limpia.releaseDate = releaseDate;
  return limpia;
}

export function leerSetsGuardados(idioma: string): Expansion[] | null {
  const dato = leer(CLAVE_SETS);
  if (!esObjeto(dato) || dato.v !== 1 || dato.idioma !== idioma || !Array.isArray(dato.sets)) {
    return null;
  }
  const sets = dato.sets.map(adelgazar).filter((s): s is ExpansionConSerie => s !== null);
  return sets.length > 0 ? sets : null;
}

export function guardarSets(sets: readonly unknown[], idioma: string): void {
  const limpios = sets.map(adelgazar).filter((s) => s !== null);
  if (limpios.length === 0) return;
  escribir(CLAVE_SETS, { v: 1, idioma, sets: limpios });
}

/* ------------------------------------------------------------------ *
 * LA ÚLTIMA EXPANSIÓN Y EL ÚLTIMO TIPO DE SOBRE
 * ------------------------------------------------------------------ *
 *
 * Quien abre siempre la misma expansión tenía que buscarla en la lista,
 * esperar al catálogo y deslizar el carrusel hasta su sobre en CADA visita a
 * Inicio. Se guarda al COMPRAR y no al entrar: curiosear una expansión no la
 * convierte en "la mía".
 */
const CLAVE_ULTIMA = "tcg:ultima-expansion";

export interface UltimaExpansion {
  setId: string;
  tipo: TipoDeSobre | null;
}

export function leerUltimaExpansion(): UltimaExpansion | null {
  const dato = leer(CLAVE_ULTIMA);
  if (!esObjeto(dato)) return null;
  const setId = texto(dato.setId);
  if (!setId || !ID_DE_SET.test(setId)) return null;
  const tipo =
    typeof dato.tipo === "string" && TIPOS.includes(dato.tipo) ? (dato.tipo as TipoDeSobre) : null;
  return { setId, tipo };
}

export function guardarUltimaExpansion(setId: string, tipo: TipoDeSobre): void {
  if (!ID_DE_SET.test(setId)) return;
  escribir(CLAVE_ULTIMA, { setId, tipo });
}

/* ------------------------------------------------------------------ *
 * APERTURA RÁPIDA
 * ------------------------------------------------------------------ *
 *
 * Con ella un sobre suelto va directo al resumen, como ya hacía el ×10. Vive
 * con clave propia y no dentro de `tcg-ajustes` porque utils/settings.ts sanea
 * su objeto campo a campo y descarta lo que no conoce: un campo nuevo escrito
 * desde aquí se perdería en la siguiente escritura de cualquier otro ajuste.
 * La hoja de Ajustes puede enseñar el mismo interruptor importando estas dos
 * funciones y escuchando el evento.
 */
const CLAVE_RAPIDA = "tcg:apertura-rapida";
/** Se despacha en window al cambiar, para quien pinte el mismo interruptor. */
export const EVENTO_APERTURA_RAPIDA = "tcg:apertura-rapida-cambio";

export function leerAperturaRapida(): boolean {
  try {
    return localStorage.getItem(CLAVE_RAPIDA) === "1";
  } catch {
    return false;
  }
}

export function guardarAperturaRapida(activa: boolean): void {
  try {
    localStorage.setItem(CLAVE_RAPIDA, activa ? "1" : "0");
  } catch {
    /* sin almacenamiento: la preferencia vive lo que dure la visita */
  }
  try {
    window.dispatchEvent(new CustomEvent<boolean>(EVENTO_APERTURA_RAPIDA, { detail: activa }));
  } catch {
    /* el aviso es un extra: guardar ya se ha hecho */
  }
}

/* ------------------------------------------------------------------ *
 * LA COMPRA SIN CONFIRMAR
 * ------------------------------------------------------------------ *
 *
 * `comprarSobreAction` es idempotente por clave: un segundo envío con LA MISMA
 * clave devuelve el mismo sobre sin cobrar otra vez (app/action.ts,
 * `sobreYaServido`). Pero la clave se generaba y se tiraba: si la respuesta se
 * perdía —mala cobertura, una llamada, iOS suspendiendo la PWA— el servidor ya
 * había cobrado, la pantalla decía "no se pudo completar la compra" y volver a
 * pulsar creaba OTRA clave y cobraba otra vez.
 *
 * Se anota ANTES de enviar y se borra al llegar al resumen. `confirmada` separa
 * los dos casos que quedan a medias:
 *   · false: no se sabe si llegó. Reintentar o recupera el sobre o lo compra
 *     ahora, que es lo que el jugador había pedido; nunca dos veces.
 *   · true: llegó y se cobró, pero no se terminó de ver (iOS mató la app con el
 *     sobre a medio abrir). Reintentar sólo puede devolver el mismo sobre.
 *
 * CADUCA A LAS 24 HORAS, y el margen es deliberado: los recibos del servidor se
 * podan a los 2 días, y reenviar una clave ya podada sería una compra nueva que
 * nadie ha pedido. Con un día de vigencia el recibo sigue ahí seguro.
 *
 * LLEVA EL USUARIO. La clave sólo significa algo para quien la compró: con la
 * sesión de otra persona en el mismo teléfono sería, otra vez, una compra nueva.
 */
const CLAVE_COMPRA = "tcg:compra-pendiente";
const VIGENCIA_COMPRA_MS = 24 * 60 * 60 * 1000;
/** El tope del servidor (MAX_SOBRES_POR_COMPRA): más no es una compra de aquí. */
const MAX_SOBRES = 10;

export interface CompraPendiente {
  clave: string;
  setId: string;
  tipo: TipoDeSobre;
  cantidad: number;
  /** Momento del primer envío (Date.now()). */
  ts: number;
  /** Id de la cuenta que compró. */
  usuario: string;
  confirmada: boolean;
}

export function leerCompraPendiente(usuario: string): CompraPendiente | null {
  const dato = leer(CLAVE_COMPRA);
  if (!esObjeto(dato)) return null;
  const clave = texto(dato.clave);
  const setId = texto(dato.setId);
  const tipo = dato.tipo;
  const cantidad = numero(dato.cantidad);
  const ts = numero(dato.ts);
  if (!clave || !CLAVE_DE_COMPRA.test(clave)) return null;
  if (!setId || !ID_DE_SET.test(setId)) return null;
  if (typeof tipo !== "string" || !TIPOS.includes(tipo)) return null;
  if (cantidad === undefined || !Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_SOBRES) {
    return null;
  }
  // Ni caducada ni fechada en el futuro (reloj cambiado o dato manipulado).
  const ahora = Date.now();
  if (ts === undefined || ahora - ts > VIGENCIA_COMPRA_MS || ts > ahora + 60_000) return null;
  if (!usuario || dato.usuario !== usuario) return null;
  return {
    clave,
    setId,
    tipo: tipo as TipoDeSobre,
    cantidad,
    ts,
    usuario,
    confirmada: dato.confirmada === true,
  };
}

export function guardarCompraPendiente(compra: CompraPendiente): void {
  escribir(CLAVE_COMPRA, compra);
}

/**
 * Borra la anotación, pero SÓLO si sigue siendo la de esa clave: una respuesta
 * que llega tarde no puede llevarse por delante la anotación de una compra
 * posterior.
 */
export function olvidarCompraPendiente(clave: string): void {
  const dato = leer(CLAVE_COMPRA);
  if (esObjeto(dato) && dato.clave !== clave) return;
  olvidar(CLAVE_COMPRA);
}

/* ------------------------------------------------------------------ *
 * EL AVISO DE "TU PARTIDA DE INVITADO SIGUE AQUÍ"
 * ------------------------------------------------------------------ *
 *
 * Al iniciar sesión la cuenta empieza vacía —la colección del invitado no se
 * traspasa— y el jugador lo vive como haberlo perdido todo. No se ha perdido:
 * sigue en este dispositivo y vuelve al cerrar sesión. Se dice una vez.
 */
const CLAVE_AVISO_INVITADO = "tcg:aviso-partida-invitado";

export function avisoDeInvitadoVisto(): boolean {
  try {
    return localStorage.getItem(CLAVE_AVISO_INVITADO) === "1";
  } catch {
    // Sin poder leer tampoco se podría recordar el cierre: mejor no enseñarlo
    // que enseñarlo en cada visita.
    return true;
  }
}

export function marcarAvisoDeInvitado(): void {
  try {
    localStorage.setItem(CLAVE_AVISO_INVITADO, "1");
  } catch {
    /* no se recuerda: como mucho vuelve a salir */
  }
}

/* ------------------------------------------------------------------ *
 * LOS CATÁLOGOS YA DESCARGADOS (sólo en memoria)
 * ------------------------------------------------------------------ *
 *
 * `getCardsFromSet` se pedía entero en cada entrada a una expansión, también al
 * volver a la que se acababa de dejar: ~250 cartas con sus ataques y una capa
 * de "Preparando cartas" a pantalla completa mientras tanto.
 *
 * Es un Map a nivel de MÓDULO y no un ref: lo que hay que sobrevivir es
 * justamente el desmontaje de la página al cambiar de pestaña. Se guarda la
 * PROMESA, no el resultado, para que el precalentado (al tocar la tesela) y la
 * carga de verdad (al entrar) compartan una sola petición en vez de cruzar dos.
 *
 * TRES COMO MUCHO. Cada catálogo son unos cientos de KB de JSON vivo en un
 * teléfono; nadie alterna entre más de dos o tres expansiones en una visita.
 *
 * UN FALLO NO SE RECUERDA: ni un rechazo ni una lista vacía, que es lo que
 * devuelve el servidor cuando la expansión aún no tiene cartas. Si se guardara,
 * "Reintentar" devolvería el mismo fallo para siempre.
 */
const MAX_CATALOGOS = 3;
const catalogos = new Map<string, Promise<Carta[]>>();

export function catalogoDeSet(
  setId: string,
  idioma: string,
  pedir: (setId: string) => Promise<Carta[]>,
): Promise<Carta[]> {
  const llave = `${idioma}:${setId}`;
  const guardado = catalogos.get(llave);
  if (guardado) {
    // Se reinserta para que pase a ser el más reciente: el Map conserva el
    // orden de inserción y el que se desaloja es el primero.
    catalogos.delete(llave);
    catalogos.set(llave, guardado);
    return guardado;
  }
  const pedido: Promise<Carta[]> = pedir(setId).then(
    (cartas) => {
      if (!Array.isArray(cartas) || cartas.length === 0) {
        if (catalogos.get(llave) === pedido) catalogos.delete(llave);
        return [];
      }
      return cartas;
    },
    (error) => {
      if (catalogos.get(llave) === pedido) catalogos.delete(llave);
      throw error;
    },
  );
  catalogos.set(llave, pedido);
  while (catalogos.size > MAX_CATALOGOS) {
    const masViejo = catalogos.keys().next().value;
    if (masViejo === undefined) break;
    catalogos.delete(masViejo);
  }
  return pedido;
}
