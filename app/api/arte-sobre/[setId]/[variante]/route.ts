// app/api/arte-sobre/[setId]/[variante]/route.ts
//
// SIRVE LA FOTO DE UN SOBRE GUARDADA EN POSTGRES.
//
// ====================================================================
// POR QUÉ ESTA RUTA EXISTE Y POR QUÉ NO CUELGA DE /sobres/
// ====================================================================
//
// Las 130 fotos que ya había son ficheros de `public/sobres`, servidos por el
// CDN de Vercel sin que ningún código nuestro se entere. Las que trae el cron
// nocturno no pueden serlo: en Vercel `public/` es de sólo lectura en ejecución
// y se hornea en el build, así que un cron no puede escribir un fichero ahí.
// Viven en `set_pack_art` (services/sobresEsquema.ts) y salen por aquí.
//
// LA RUTA NO SE PARECE A /sobres/ A PROPÓSITO. Poner esto en `/sobres/...`
// habría dejado en el aire quién gana cuando la ruta y el fichero estático
// coinciden —depende de cómo Vercel ordene sus reglas ese día, y eso no es una
// respuesta—. Con `/api/arte-sobre/` no hay solape posible: quien pide una
// existe y la otra no.
//
// ====================================================================
// LA CACHÉ ES LA MITAD DEL DISEÑO
// ====================================================================
//
// Sin caché, cada visita a la tienda leería de Postgres 100 KB de imagen por
// sobre. Con `s-maxage` de un año e `immutable`, el CDN se queda la foto y
// Postgres se lee UNA VEZ por imagen y por región, no una por visita.
//
// EL PRECIO DE `immutable`, QUE HAY QUE SABER ANTES DE TOCAR NADA: si algún día
// hay que CAMBIAR la foto de una expansión que ya se publicó, el CDN puede
// seguir sirviendo la vieja durante mucho tiempo, porque la URL no cambia. Se
// ha elegido a sabiendas, y por eso el cron NO REESCRIBE lo que ya está: sólo
// escribe expansiones que no tenían nada, salvo que una persona lo fuerce con
// `?setId=`. Quien fuerce una sustitución tiene que contar con eso; el arreglo
// limpio, si algún día hace falta, es meter en la ruta un trozo que cambie con
// el contenido, y entonces el número de variantes deja de bastar y hay que
// llevar también ese trozo hasta el componente.
//
// LOS 404 SE CACHEAN CINCO MINUTOS, NI MÁS NI MENOS, y el número no es un
// término medio cobarde: es el mismo TTL con el que services/sobresBD.ts cuenta
// las variantes. O sea que la aplicación no puede pedir una foto nueva antes de
// esos cinco minutos de todas formas, y cachear el 404 durante ese rato no
// retrasa nada que no estuviera ya retrasado.
//
// Estaba en `no-store` con un argumento correcto —una expansión que hoy no tiene
// foto la va a tener en cuanto pase el cron, y un 404 guardado un año la dejaría
// con el sobre dibujado para siempre— pero con una consecuencia que no se vio:
// esta ruta es PÚBLICA, sin sesión y sin límite de peticiones, y con `no-store`
// cada URL inventada era una consulta a Postgres que el CDN no absorbía. Veinte
// mil peticiones son veinte mil viajes al pool de Neon en el plan Hobby, y hoy
// casi cualquier id cae en esa rama porque la tabla arranca vacía. Con
// `s-maxage` de cinco minutos el CDN se come las repeticiones y la foto nueva
// sigue apareciendo a la vez que antes.
//
// SI ESTO FALLA NO PASA NADA. components/BoosterPack.tsx precarga la imagen y
// su `onerror` no hace absolutamente nada: sin foto se queda el sobre dibujado,
// que es exactamente lo que ven las 41 expansiones que nunca tuvieron sobre. No
// hay ningún camino por el que una respuesta de aquí deje un hueco en la
// pantalla ni tumbe la página.

import { sql } from "@vercel/postgres";
import { NextResponse } from "next/server";
import { MIMES_SOBRE } from "@/services/sobresEsquema";

export const runtime = "nodejs";

/**
 * Mismo patrón que ID_SANO en utils/sobreArte.ts, y no por casualidad: es el
 * mismo id el que compone la URL allí y el que se valida aquí. Si uno de los
 * dos se relaja, el otro sigue cerrado.
 */
const ID_SANO = /^[a-z0-9][a-z0-9.]{0,23}$/;
/** 1..99. Hoy el máximo son 3 (MAX_VARIANTES); dos dígitos sobran de largo. */
const VARIANTE_SANA = /^[1-9][0-9]?$/;

/** Un año, que es el máximo que admite `max-age` con sentido. */
const UN_ANO = 60 * 60 * 24 * 365;

/**
 * Lo que dura un 404 en el CDN. El mismo TTL con el que services/sobresBD.ts
 * cachea el recuento de variantes, y por eso no cuesta nada: la aplicación no
 * pediría la foto nueva antes de todas formas. El porqué largo, arriba.
 */
const CINCO_MINUTOS = 300;

function noHayFoto(): NextResponse {
  return new NextResponse(null, {
    status: 404,
    headers: {
      // `max-age=0` para el navegador (que sí tiene que preguntar de nuevo) y
      // `s-maxage` para el CDN, que es quien absorbe la repetición y protege al
      // pool de Postgres.
      "Cache-Control": `public, max-age=0, s-maxage=${CINCO_MINUTOS}`,
    },
  });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ setId: string; variante: string }> },
) {
  const { setId, variante } = await params;

  // Se valida ANTES de tocar Postgres. No es sólo por la consulta —va
  // parametrizada— sino porque estos dos valores vienen de la URL y no hay
  // ninguna razón para preguntarle a la base de datos por algo que no puede
  // existir.
  if (!ID_SANO.test(setId) || !VARIANTE_SANA.test(variante)) return noHayFoto();

  try {
    const { rows } = await sql.query(
      `SELECT mime, bytes FROM set_pack_art WHERE set_id = $1 AND variante = $2`,
      [setId, Number(variante)],
    );
    const fila = rows[0];
    if (!fila?.bytes) return noHayFoto();

    const mime = String(fila.mime ?? "");
    /* LISTA BLANCA, y es la última puerta. El cron ya mira los bytes de verdad
     * antes de guardar (`tipoDeImagen`), pero lo que sale de aquí es un
     * `Content-Type` para el navegador de quien visita la página, y esa
     * cabecera es una instrucción, no un dato. Una fila metida a mano con
     * "text/html" o "image/svg+xml" sería un documento con scripts servido
     * desde nuestro propio dominio. */
    if (!MIMES_SOBRE.has(mime)) {
      console.error(`arte-sobre: ${setId}/${variante} tiene un mime que no se sirve: ${mime}`);
      return noHayFoto();
    }

    const bytes: Buffer = Buffer.isBuffer(fila.bytes)
      ? fila.bytes
      : Buffer.from(fila.bytes as ArrayBuffer);

    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Length": String(bytes.length),
        // `max-age` corto para el navegador y `s-maxage` largo para el CDN: si
        // un día hay que sustituir una foto, purgar el CDN alcanza a todo el
        // mundo y el navegador se pone al día en un día.
        "Cache-Control": `public, max-age=86400, s-maxage=${UN_ANO}, immutable`,
        // El tipo lo decidimos nosotros y no lo adivina el navegador: es lo que
        // convierte la lista blanca de arriba en una garantía y no en un deseo.
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e: unknown) {
    /* 503 y NO 404: un fallo de Postgres o una tabla que todavía no existe
     * (la migración /migrate-sobres se ejecuta a mano) son transitorios, y un
     * 404 aquí es indistinguible de "esta expansión no tiene foto". La
     * pantalla se ve igual en los dos casos —sobre dibujado— pero el log no, y
     * el log es lo único que va a tener quien venga a mirar por qué. */
    console.error(
      `arte-sobre: no se pudo leer ${setId}/${variante}:`,
      e instanceof Error ? e.message : String(e),
    );
    return new NextResponse(null, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
