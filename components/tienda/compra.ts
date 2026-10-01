"use client";

/**
 * LA COMPRA DE UN SOBRE, VISTA DESDE EL NAVEGADOR.
 *
 * Lo que hay aquí no depende del estado de la pantalla: enviar una compra con
 * su clave (y reenviarla con la misma), traducir una negativa del servidor y
 * dos precauciones del modo invitado. Vivía al principio de app/page.tsx; sale
 * a su fichero para que aquél no siga creciendo. Quién decide qué hacer con el
 * resultado —abrir el sobre, ofrecer reintentar, dejar el aviso en la tienda—
 * sigue siendo la página.
 */
import { comprarSobreAction, recuperarSobreAction } from "../../app/action";
import { getCollection } from "../../utils/storage";
import { esAccionCaducada } from "../../utils/versionApp";
import type { CompraPendiente } from "./memoria";

/* =====================================================================
 * COMPRAR CON UNA CLAVE, Y REINTENTAR CON LA MISMA
 * =====================================================================
 *
 * EL PROBLEMA QUE CIERRA. La clave de compra se generaba y se tiraba. Si la
 * respuesta de `comprarSobreAction` se perdía a la VUELTA —mala cobertura, una
 * llamada entrante, iOS suspendiendo la PWA al cambiar de aplicación— el
 * servidor ya había cobrado y acreditado las cartas, pero aquí saltaba el
 * `catch`, la vista se cerraba con "No se pudo completar la compra", el saldo
 * en pantalla quedaba sin el cobro y el jugador no llegaba a ver su sobre. Y
 * volver a pulsar generaba OTRA clave: otro cobro.
 *
 * LO QUE HACE. Envía, y si no hay respuesta útil vuelve a enviar UNA vez con la
 * MISMA clave: el servidor anota cada clave en `pack_purchases` y un reenvío
 * devuelve el sobre ya servido sin cobrar (app/action.ts, `sobreYaServido`). Si
 * tampoco, devuelve `null`, que significa exactamente "NO SE SABE si la compra
 * llegó", y quien llama ofrece reintentar más tarde con esa misma clave.
 *
 * QUÉ SE REINTENTA: un rechazo de la promesa (red), el motivo "error" (fallo de
 * base; la sentencia es atómica, así que no cobró) y una espera agotada. Lo
 * demás —sin saldo, sobre no disponible, sin sesión— es una negativa firme del
 * servidor y se devuelve tal cual: no hay nada que reintentar.
 *
 * LA ESPERA TIENE TOPE porque en iOS una petición colgada puede tardar un
 * minuto en rechazarse, y todo ese rato el sobre se quedaba mudo. Reintentar
 * con la primera aún viva es seguro por lo mismo que todo lo demás: es la misma
 * clave.
 *
 * LA VERSIÓN CADUCADA NO ES UNA DUDA. Tras un despliegue, el JavaScript que
 * sigue en pantalla llama a una acción cuyo identificador ya no existe y Next
 * la rechaza SIN EJECUTARLA. Eso caía en el mismo `catch` que un corte de red y
 * se anotaba como «compra sin confirmar» una compra que con toda seguridad no
 * había llegado —y con el aviso de versión nueva tapado por la apertura a
 * pantalla completa—. Si es la PRIMERA respuesta al PRIMER envío de esa clave,
 * es una negativa firme (`version-caducada`): no se ha cobrado nada y no hay
 * nada que guardar. En cualquier otro caso sigue siendo una duda: si antes hubo
 * un envío del que no se supo nada —el reintento de aquí dentro, o un
 * «Reintentar» del jugador sobre una compra ya anotada (`yaEnviada`)—, aquel
 * envío pudo cobrar contra el despliegue anterior, y con la clave guardada se
 * recupera tras actualizar.
 */
export type RespuestaDeCompra =
  | Awaited<ReturnType<typeof comprarSobreAction>>
  | Awaited<ReturnType<typeof recuperarSobreAction>>
  | { ok: false; motivo: "version-caducada" };
const ESPERA_DE_COMPRA_MS = 20_000;
const PAUSA_DE_REINTENTO_MS = 800;

/** Envía con plazo y reintenta una vez. `null` = no se sabe qué pasó. */
async function enviarConReintento(
  enviar: () => Promise<RespuestaDeCompra>,
  /** Es el primer envío de esta clave: un «acción desconocida» es un no firme. */
  primerEnvio: boolean,
): Promise<RespuestaDeCompra | null> {
  for (let vuelta = 0; vuelta < 2; vuelta++) {
    if (vuelta > 0) {
      await new Promise<void>((seguir) => window.setTimeout(seguir, PAUSA_DE_REINTENTO_MS));
    }
    try {
      const envio = enviar();
      // Si vence la espera, la petición sigue viva: que su rechazo tardío no
      // quede como un rechazo sin manejar.
      envio.catch(() => {});
      const res = await Promise.race([
        envio,
        new Promise<"tarde">((vencer) =>
          window.setTimeout(() => vencer("tarde"), ESPERA_DE_COMPRA_MS),
        ),
      ]);
      if (res === "tarde") continue;
      if (res?.ok) return res;
      if (res && res.motivo !== "error") return res;
    } catch (err) {
      if (esAccionCaducada(err)) {
        return primerEnvio && vuelta === 0 ? { ok: false, motivo: "version-caducada" } : null;
      }
      console.error("Error comprando el sobre:", err);
    }
  }
  return null;
}

export function comprarConClave(
  intento: CompraPendiente,
  /** Esta clave ya se envió antes (es un «Reintentar»): ver la cabecera. */
  yaEnviada = false,
): Promise<RespuestaDeCompra | null> {
  return enviarConReintento(
    () => comprarSobreAction(intento.setId, intento.tipo, intento.cantidad, intento.clave),
    !yaEnviada,
  );
}

/**
 * «Ver sobre»: pide un sobre que ya consta como cobrado. Va por
 * `recuperarSobreAction`, que sólo lee: si el recibo ya no existe contesta
 * `no-encontrado` en vez de comprar otro (ver su cabecera en app/action.ts).
 * Con la versión caducada devuelve `null`, como cualquier otro «no se ha podido
 * preguntar»: quien llama deja el aviso donde está y, tras actualizar, el sobre
 * sigue pudiéndose ver.
 */
export function recuperarConClave(intento: CompraPendiente): Promise<RespuestaDeCompra | null> {
  return enviarConReintento(() => recuperarSobreAction(intento.clave), false);
}

/**
 * Por qué el servidor no ha vendido el sobre, dicho para el jugador.
 *
 * `detalle` afina el motivo cuando el servidor lo manda. Hoy sólo hay uno:
 * "set-incompleto", una expansión que el cron todavía está descargando y que
 * por eso no vende ningún sobre. Sin él se decía "ese sobre no está a la venta
 * en esta expansión", que suena a que hay otro sobre que sí.
 *
 * "demasiadas-peticiones" es el tope de frecuencia del servidor: caía en el
 * genérico "no se pudo completar la compra", que no dice ni que no se ha
 * cobrado ni que basta con esperar.
 */
export const textoDeRechazo = (motivo?: string, detalle?: string): string =>
  motivo === "sin-saldo"
    ? "No tienes suficientes monedas"
    : motivo === "sobre-no-disponible" && detalle === "set-incompleto"
      ? "Esta expansión todavía se está descargando y sus sobres aún no están a la venta. No se ha cobrado nada."
    : motivo === "demasiadas-peticiones"
      ? "Demasiadas compras seguidas. Espera unos segundos: no se ha cobrado nada."
    : motivo === "sobre-no-disponible"
      ? "Ese sobre no está a la venta en esta expansión"
      : motivo === "sin-sesion"
        ? "Tu sesión ha caducado. Vuelve a iniciar sesión."
        : motivo === "version-caducada"
          ? "Hay una versión nueva de la app. Actualízala para comprar: no se ha cobrado nada."
          : motivo === "no-encontrado"
            ? "Ese sobre ya no se puede volver a mostrar. Sus cartas están en tu colección."
            : "No se pudo completar la compra";

/**
 * Pide al navegador que no desaloje los datos de este sitio.
 *
 * La partida del invitado vive ENTERA en localStorage, y el navegador puede
 * borrarla cuando anda justo de espacio. `persist()` le dice que esto no es
 * caché prescindible. Se pide tras el primer sobre guardado, que es cuando hay
 * algo que perder, y una vez por visita.
 *
 * En Firefox se salta: allí la llamada abre un diálogo de permiso, y una
 * pregunta del navegador en mitad de abrir un sobre es peor que el riesgo que
 * cubre. Safari y Chrome deciden solos, sin preguntar.
 *
 * NO arregla los dos casos graves de iOS, que no dependen de esto: la app
 * instalada tiene un almacén distinto del de Safari, y Safari borra a los siete
 * días sin uso lo que escribe un sitio no instalado.
 */
let almacenPersistentePedido = false;
export function pedirAlmacenPersistente(): void {
  if (almacenPersistentePedido) return;
  almacenPersistentePedido = true;
  try {
    if (/firefox/i.test(navigator.userAgent)) return;
    navigator.storage?.persist?.()?.catch(() => {});
  } catch {
    /* sin API de almacenamiento: no hay nada que pedir */
  }
}

/** La colección del invitado, sin que un localStorage inaccesible (modo
 *  privado de iOS) tumbe a quien sólo venía a preguntar. */
export const coleccionLocalSegura = (): ReturnType<typeof getCollection> => {
  try {
    return getCollection();
  } catch {
    return [];
  }
};
