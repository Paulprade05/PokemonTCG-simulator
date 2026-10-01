// utils/catalogoCliente.ts
//
// EL CATÁLOGO DE EXPANSIONES, PEDIDO UNA VEZ POR SESIÓN DE NAVEGADOR.
//
// EL PROBLEMA QUE RESUELVE: cinco pantallas —la portada, la colección, cada
// álbum, el perfil de un entrenador y la vitrina— llaman a `getSetsFromDB()` al
// montarse. Inicio → Colección → un álbum → Colección → Inicio son cinco
// peticiones POST para el mismo dato de unos 55 KB, que sólo cambia cuando pasa
// el cron de madrugada, y cada una con su esqueleto a pantalla completa
// mientras llega. Volver de un álbum a la colección tardaba lo mismo que la
// primera visita.
//
// El servidor ya no repite el trabajo (app/action.ts memoriza las filas un
// minuto por instancia); esto quita además el VIAJE: se guarda la PROMESA, así
// que dos pantallas que monten a la vez comparten una sola petición y las
// siguientes no hacen ninguna.
//
// CÓMO SE USA: donde una pantalla hace `getSetsFromDB()`, que haga
// `catalogoDeExpansiones()`. Devuelve lo mismo.
//
// LO QUE NO HACE, a propósito:
//   · No guarda nada en localStorage ni en ningún sitio que sobreviva a
//     recargar: es memoria del módulo. Recargar la página lo vacía, y el
//     cambio de idioma recarga la página, así que no hay que acordarse de
//     invalidarlo al cambiar de idioma (los nombres vienen ya traducidos del
//     servidor y se quedarían en el idioma anterior).
//   · No memoriza un fallo ni una respuesta vacía: si la petición falla, la
//     siguiente pantalla vuelve a intentarlo en vez de heredar el error.
//   · No es para decidir nada de dinero. Qué sobres se venden y cuántas cartas
//     tiene una expansión lo decide el servidor en cada compra; esto es para
//     pintar.
//
// Módulo de CLIENTE: importa una server action, y eso sólo tiene sentido desde
// un componente con "use client". No lo importes desde código de servidor.

import { getSetsFromDB } from "../app/action";
import type { Expansion } from "./tipos";

/** Cuánto vale una respuesta. El dato cambia una vez al día; diez minutos sobran. */
const CADUCIDAD_MS = 10 * 60 * 1000;

let enMemoria: { promesa: Promise<Expansion[]>; pedida: number } | null = null;

/**
 * Las expansiones, de la memoria si se pidieron hace poco.
 *
 * @param forzar true para saltarse la memoria (un «reintentar», o una pantalla
 *               que sabe que el catálogo acaba de cambiar).
 */
export function catalogoDeExpansiones(forzar = false): Promise<Expansion[]> {
  const ahora = Date.now();
  if (!forzar && enMemoria && ahora - enMemoria.pedida < CADUCIDAD_MS) {
    return enMemoria.promesa;
  }
  const promesa = (getSetsFromDB() as Promise<Expansion[]>).then((sets) => {
    // Vacío es "todavía no hay catálogo": que la próxima pantalla pregunte.
    if (!Array.isArray(sets) || sets.length === 0) olvidar(promesa);
    return sets;
  });
  // Un rechazo tampoco se queda: sin esto, un corte de red al entrar dejaría
  // todas las pantallas en error hasta que caducase.
  promesa.catch(() => olvidar(promesa));
  enMemoria = { promesa, pedida: ahora };
  return promesa;
}

/** Olvida una respuesta concreta, sin pisar otra más nueva que ya la sustituyó. */
function olvidar(promesa: Promise<Expansion[]>): void {
  if (enMemoria?.promesa === promesa) enMemoria = null;
}

/** Vacía la memoria. Para quien sepa que el catálogo ha cambiado. */
export function olvidarCatalogoDeExpansiones(): void {
  enMemoria = null;
}
