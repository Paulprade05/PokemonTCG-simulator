// middleware.ts (en la raíz del proyecto; no hay carpeta src/)
//
// QUÉ HACE Y QUÉ NO. `clerkMiddleware()` sin argumentos NO PROTEGE NINGUNA
// RUTA, y es lo correcto: sólo deja preparada la sesión para que `auth()`
// funcione. La autorización vive en cada server action (app/action.ts,
// app/social.ts), que saca el `userId` de `auth()` y no se fía de nada más.
//
// PENDIENTE PARA EL DUEÑO: Next 16 da por obsoleto el nombre `middleware` y
// pide `proxy` (avisa en cada build). El cambio es renombrar este fichero a
// proxy.ts con `git mv`, y NO se puede adelantar dejando los dos: con
// middleware.ts y proxy.ts a la vez el build falla. Hay que hacerlo junto con
// la comprobación de que la versión de @clerk/nextjs instalada admite la
// convención nueva, y validarlo con `npm run build`.
import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware();

/* LAS DOS RUTAS QUE NO PASAN POR CLERK, y por qué: /api/cron/ y
 * /api/arte-sobre/.
 *
 * Ninguna de las dos llama a `auth()`. Los crons se autorizan con su propio
 * `Authorization: Bearer $CRON_SECRET` (app/_admin-auth.ts), y la de fotos de
 * sobre es pública. Aun así pasaban por aquí, porque el patrón de extensiones
 * no las excluía (/api/arte-sobre/sv8/1 no lleva extensión) y el segundo
 * patrón las incluía expresamente. Dos costes y un riesgo:
 *
 *  - Vercel ejecuta el middleware ANTES de mirar la caché del CDN. Cada foto
 *    de sobre, aunque estuviera cacheada un año, costaba una invocación; el
 *    selector de tipo de sobre pide tres.
 *  - Una ráfaga de URLs inventadas contra /api/arte-sobre pagaba además una
 *    ejecución de Clerk por petición.
 *  - Clerk mira la cabecera `Authorization: Bearer` por si es un token de
 *    sesión. El secreto del cron no lo es; si una versión futura decidiera
 *    tratar un Bearer inválido como error, rompería los dos crons a la vez.
 *
 * VAN CON LA BARRA FINAL A PROPÓSITO (`api/cron/`, no `api/cron`): así sólo
 * quedan fuera esas dos carpetas, y no una ruta futura que empiece igual.
 *
 * SI SE AÑADE UNA RUTA NUEVA bajo /api que use `auth()`, no hay que tocar
 * nada: todo lo demás de /api sigue pasando por Clerk (hoy, /api/version).
 * Lo que NO se puede hacer es llamar a `auth()` dentro de /api/cron o
 * /api/arte-sobre sin quitarlas antes de estas exclusiones.
 */
export const config = {
  matcher: [
    // Todo menos los ficheros estáticos, lo de Next y las dos rutas de arriba.
    '/((?!_next|api/cron/|api/arte-sobre/|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Y siempre las rutas de API (aunque lleven extensión), menos esas dos.
    '/(api(?!/cron/|/arte-sobre/)|trpc)(.*)',
  ],
};