// src/utils/storage.ts

const STORAGE_KEY = 'pokemon-tcg-collection';

/**
 * La clave, expuesta para quien sólo necesita saber SI la colección ha
 * cambiado sin pagar el JSON.parse de la colección entera (la barra lateral
 * compara la cadena cruda contra la de la última lectura). Sin esto, ese
 * consumidor tendría que repetir el literal aquí y quedarse desincronizado el
 * día que cambie.
 */
export const COLLECTION_STORAGE_KEY = STORAGE_KEY;

/**
 * AVISO DE ESCRITURA PARA QUIEN PINTE LA COLECCIÓN LOCAL.
 *
 * El evento `storage` del navegador NO se dispara en la pestaña que escribe:
 * sólo en las demás. Así que cualquier componente que enseñe el recuento se
 * quedaba con el número viejo justo en el caso que importa —se abre un sobre
 * en `/`, la barra lateral está a la vista todo el rato y no hay cambio de ruta
 * que la obligue a releer—. Un número obsoleto no es un dato: es un dato falso.
 *
 * Es puramente ADITIVO: quien no escuche este evento sigue funcionando
 * exactamente igual que antes.
 */
export const COLLECTION_CHANGED_EVENT = 'coleccion-local:cambio';

const avisarDeCambio = () => {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new Event(COLLECTION_CHANGED_EVENT));
  } catch {
    /* el aviso es un extra: si el entorno no deja despacharlo, guardar ya se
       ha hecho y nada de lo que había antes deja de funcionar. */
  }
};

export interface CollectionCard {
  id: string;
  name: string;
  rarity: string;
  images: { small: string; large: string };
  quantity: number; // <--- NUEVA PROPIEDAD
}

/**
 * Lectura saneada de la colección local. Un valor corrupto o que no sea un
 * array (JSON inválido, un `localStorage` manipulado, `"null"`) haría lanzar a
 * los `.map`/`.findIndex` de los consumidores y a la propia `saveToCollection`,
 * dejando la colección de invitado inservible. Ante datos ilegibles se descarta
 * la clave y se arranca de cero, igual que hace useGameCurrency con el saldo.
 */
const leerColeccion = (): CollectionCard[] => {
  if (typeof window === 'undefined') return [];
  // El getItem también va protegido: con el almacenamiento bloqueado (Safari
  // con "Bloquear todas las cookies") el propio acceso lanza SecurityError, y
  // esta función se llama desde efectos de pantallas enteras. Sin
  // almacenamiento no hay colección local que leer: lista vacía.
  let data: string | null = null;
  try {
    data = localStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (!data) return [];
  try {
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // JSON corrupto: mejor limpiar y empezar de cero que arrastrar el fallo en
    // cada lectura.
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* almacenamiento inaccesible: nada más que hacer */
    }
    return [];
  }
};

/**
 * Añade un sobre a la colección de invitado. Devuelve `false` si la escritura
 * falla (cuota de localStorage agotada, típico en iOS): así el llamador puede
 * reembolsar las monedas ya cobradas en vez de dejar al usuario sin cartas y
 * sin saldo.
 */
export const saveToCollection = (newPack: any[]): boolean => {
  // 1. Recuperamos la colección actual (saneada)
  const collection = leerColeccion();

  // 2. Procesamos cada carta nueva del sobre
  newPack.forEach((newCard) => {
    // Buscamos si ya existe esa ID en tu álbum
    const existingIndex = collection.findIndex((c) => c.id === newCard.id);

    if (existingIndex >= 0) {
      // SI YA EXISTE: Solo aumentamos la cantidad
      collection[existingIndex].quantity = (collection[existingIndex].quantity || 1) + 1;
    } else {
      // SI ES NUEVA: guardamos SÓLO lo imprescindible. Las cartas de
      // getCardsFromSet traen attacks, weaknesses, tcgplayer (precios),
      // flavorText, etc.; persistirlas enteras multiplica por diez el peso y con
      // unos cientos de cartas agota la cuota de localStorage. El resto de datos
      // se hidrata por id desde el catálogo del set en cada consumidor (el álbum
      // cruza contra getCardsFromSet y el detalle contra getCardFromDB).
      collection.push({
        id: newCard.id,
        name: newCard.name,
        rarity: newCard.rarity,
        images: newCard.images,
        quantity: 1,
      });
    }
  });

  // 3. Guardamos la colección actualizada. setItem puede lanzar por cuota: se
  //    informa del resultado en vez de propagar la excepción.
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collection));
    avisarDeCambio();
    return true;
  } catch (e) {
    console.error('No se pudo guardar la colección local:', e);
    return false;
  }
};

/**
 * Escribe la colección entera tal cual se le da.
 *
 * ÉSTA SÍ LANZA SI NO PUEDE ESCRIBIR, Y TIENE QUE SEGUIR LANZANDO. Sus
 * llamadores (las ventas del invitado en app/collection/page.tsx y en
 * app/page.tsx) la llaman dentro de un try y deshacen la venta en el catch, o
 * la llaman ANTES de abonar las monedas contando con que una excepción corta
 * el abono. Convertirla en "devuelve false" sin tocar esos sitios regalaría
 * monedas por cartas que no han salido de la colección. Quien quiera un
 * booleano tiene `ajustarCopiasEnLocal`, más abajo.
 */
export const saveCollectionRaw = (collection: any[]) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collection));
    // Después del setItem a propósito: si lanza por cuota no ha cambiado nada
    // y no hay nada de lo que avisar.
    avisarDeCambio();
}

export const getCollection = (): CollectionCard[] => leerColeccion();

/**
 * CAMBIA CUÁNTAS COPIAS HAY DE UNAS CARTAS, LEYENDO LA COLECCIÓN EN EL MOMENTO.
 *
 * EL FALLO QUE CIERRA. La pantalla de colección carga la lista del invitado una
 * vez y, al vender, escribía con `saveCollectionRaw` SU copia en memoria. Con
 * /collection abierta en una pestaña y cinco sobres abiertos en otra, vender
 * una copia en la primera grababa la lista vieja menos una: las cartas de los
 * cinco sobres desaparecían. De paso grababa los nombres ya traducidos que
 * tenía en pantalla, cuando la colección guardada es la del idioma original.
 *
 * Aquí la lectura y la escritura son la misma operación, sobre lo que hay
 * guardado AHORA, y sólo se toca `quantity`: lo que otra pestaña haya añadido
 * se conserva, y de la carta no se reescribe ni el nombre ni la imagen.
 *
 * `cambios` va de id de carta a copias que se suman (positivo) o se quitan
 * (negativo). `minimo` es lo mínimo que puede quedar de una carta de la que se
 * QUITAN copias: 1 por defecto, la copia protegida que no se vende.
 *
 * ES TODO O NADA y no lanza: devuelve `false`, sin haber escrito, si alguna
 * carta no está, si de alguna quedarían menos de `minimo` (otra pestaña ya la
 * vendió) o si el almacenamiento no deja. Con `false` no ha cambiado nada, así
 * que quien llama no abona monedas. Deshacer una venta es la misma llamada con
 * el signo contrario.
 */
export const ajustarCopiasEnLocal = (
  cambios: Record<string, number>,
  minimo = 1,
): boolean => {
  if (typeof window === 'undefined') return false;
  const ids = Object.keys(cambios).filter((id) => cambios[id] !== 0);
  if (ids.length === 0) return true;

  const coleccion = leerColeccion();
  const porId = new Map(coleccion.map((c) => [c.id, c]));
  for (const id of ids) {
    const delta = cambios[id];
    const carta = porId.get(id);
    if (!carta || !Number.isInteger(delta)) return false;
    const quedan = (Number(carta.quantity) || 0) + delta;
    if (delta < 0 && quedan < minimo) return false;
  }
  // Validado todo, se aplica. Hasta aquí no se ha tocado ningún objeto.
  for (const id of ids) {
    const carta = porId.get(id)!;
    carta.quantity = (Number(carta.quantity) || 0) + cambios[id];
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(coleccion));
  } catch {
    return false;
  }
  avisarDeCambio();
  return true;
};

/** Quita `n` copias de una carta del invitado. Ver `ajustarCopiasEnLocal`. */
export const venderCopiasEnLocal = (cardId: string, n = 1): boolean =>
  Number.isInteger(n) && n > 0 ? ajustarCopiasEnLocal({ [cardId]: -n }) : false;

/** Devuelve `n` copias: lo contrario de `venderCopiasEnLocal`, para deshacer. */
export const devolverCopiasEnLocal = (cardId: string, n = 1): boolean =>
  Number.isInteger(n) && n > 0 ? ajustarCopiasEnLocal({ [cardId]: n }) : false;

/**
 * Vacía la colección local. No lanza: sin almacenamiento no hay nada que
 * vaciar. Devuelve si se pudo retirar la clave.
 */
export const clearCollection = (): boolean => {
    let hecho = true;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      hecho = false;
    }
    avisarDeCambio();
    return hecho;
}
