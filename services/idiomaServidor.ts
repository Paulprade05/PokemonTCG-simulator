/**
 * Resolución del idioma EN EL SERVIDOR y búsqueda por nombre español.
 *
 * POR QUÉ EXISTE ESTE FICHERO Y NO SE TRADUCE EN EL NAVEGADOR: el diccionario
 * son 724 KB repartidos en 39 JSON. Si la traducción viviera en las pantallas,
 * cada una tendría que descargarse el diccionario de cada expansión que pinta
 * —la colección mezcla las 39— y además habría que repetir la misma llamada en
 * doce sitios. Traduciendo en el origen de los datos (las server actions y
 * services/pokemon.ts) el diccionario se queda en memoria del servidor, el
 * cliente recibe las cartas ya en español y las pantallas no se enteran.
 *
 * POR QUÉ UNA COOKIE Y NO LA COLUMNA DE `users`: hay que saber el idioma en
 * CADA lectura de cartas, y consultar `users.lang` en cada una sería una
 * consulta extra por pantalla. Además el invitado no tiene fila en `users` y
 * también elige idioma. La cookie la escribe el script antiparpadeo de
 * app/layout.tsx antes del primer pintado, así que ya viaja en la primera
 * server action; la preferencia de la CUENTA la sincroniza SettingsSheet sobre
 * esta misma cookie cuando Clerk confirma la sesión (igual que el tema).
 */

import { cookies } from "next/headers";
import { normalizarIdioma, type Idioma } from "./idioma";
import { diccionarioEs, setsConEspanol } from "./idiomaBD";

/** Nombre de la cookie. Lo comparte el script de arranque de app/layout.tsx. */
export const COOKIE_IDIOMA = "tcg-idioma";

export type { Idioma };

/**
 * Idioma de esta petición. Nunca lanza: fuera de un ámbito de petición
 * (prerender de build) `cookies()` revienta y el idioma correcto es el inglés,
 * que es el dato de partida.
 */
export async function idiomaActual(): Promise<Idioma> {
  try {
    const tarro = await cookies();
    return normalizarIdioma(tarro.get(COOKIE_IDIOMA)?.value);
  } catch {
    return "en";
  }
}

/* ------------------------------------------------------------------ *
 * BÚSQUEDA POR NOMBRE ESPAÑOL
 * ------------------------------------------------------------------ */

/** Sin tildes y en minúsculas: "Invitación" y "invitacion" son la misma búsqueda. */
function sinTildes(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

interface EntradaBusqueda {
  id: string;
  /** Nombre español tal cual, para poder ORDENAR por él. */
  nombre: string;
  /** El mismo nombre normalizado, para comparar. */
  clave: string;
}

// Índice inverso nombre español -> id, construido UNA vez por instancia y sólo
// si alguien busca en español. Son ~6.700 entradas: cabe de sobra en memoria y
// evita añadir una columna `name_es` a `cards` (que obligaría a resembrar la
// tabla y a mantenerla sincronizada con el diccionario).
/* CON CADUCIDAD, y hace falta desde que hay cron de traducciones: el índice se
 * construía UNA vez por instancia y para siempre, así que una instancia viva
 * jamás habría visto lo que el cron escribiera esta noche. Quince minutos es el
 * mismo compromiso que el resto de cachés del proyecto. */
const INDICE_TTL_MS = 15 * 60 * 1000;
let indiceEnCurso: { p: Promise<EntradaBusqueda[]>; expira: number } | null = null;

function construirIndice(): Promise<EntradaBusqueda[]> {
  const ahora = Date.now();
  if (indiceEnCurso && indiceEnCurso.expira > ahora) return indiceEnCurso.p;

  const entrada = {
    expira: ahora + INDICE_TTL_MS,
    p: null as unknown as Promise<EntradaBusqueda[]>,
  };
  entrada.p = (async () => {
    const salida: EntradaBusqueda[] = [];
    // La unión de las dos vías: los ficheros estáticos MÁS lo que haya escrito
    // el cron. Si Postgres falla, `setsConEspanol` devuelve sólo los estáticos y
    // el buscador funciona exactamente como el primer día.
    for (const setId of await setsConEspanol()) {
      const dicc = await diccionarioEs(setId);
      if (!dicc) continue;
      for (const [id, e] of Object.entries(dicc.cartas)) {
        if (!e) continue;
        salida.push({ id, nombre: e.n, clave: sinTildes(e.n) });
      }
    }
    return salida;
  })().catch((e) => {
    // No cachear el fallo: la próxima búsqueda vuelve a intentarlo.
    console.error("índice de búsqueda en español:", e);
    entrada.expira = 0;
    return [];
  });

  indiceEnCurso = entrada;
  return entrada.p;
}

/**
 * Ids de las cartas cuyo NOMBRE ESPAÑOL contiene `consulta`, con ese nombre al
 * lado para que quien consulta pueda ordenar alfabéticamente en español.
 *
 * `tope` acota el trabajo: buscar "a" casaría con media colección y el array
 * viajaría entero a Postgres. Con el buscador real (dos letras mínimo y diez
 * resultados por página) no se roza.
 */
export async function idsPorNombreEspanol(
  consulta: string,
  tope = 1500,
): Promise<{ ids: string[]; nombres: string[] }> {
  const termino = sinTildes(String(consulta ?? "").trim());
  if (termino === "") return { ids: [], nombres: [] };

  const indice = await construirIndice();
  const casan = indice.filter((e) => e.clave.includes(termino));
  casan.sort((a, b) => a.clave.localeCompare(b.clave));

  const recortadas = casan.slice(0, tope);
  return {
    ids: recortadas.map((e) => e.id),
    nombres: recortadas.map((e) => e.nombre),
  };
}
