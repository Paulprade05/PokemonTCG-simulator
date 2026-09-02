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
  const data = localStorage.getItem(STORAGE_KEY);
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

export const saveCollectionRaw = (collection: any[]) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collection));
    // Después del setItem a propósito: si lanza por cuota no ha cambiado nada
    // y no hay nada de lo que avisar.
    avisarDeCambio();
}

export const getCollection = (): CollectionCard[] => leerColeccion();

export const clearCollection = () => {
    localStorage.removeItem(STORAGE_KEY);
    avisarDeCambio();
}
