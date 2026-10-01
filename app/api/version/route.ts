import { NextResponse } from "next/server";

/**
 * QUÉ BUILD ESTÁ SIRVIENDO AHORA EL SERVIDOR.
 *
 * Es la otra mitad de la comparación de versiones de utils/versionApp.ts
 * (`buildDelServidor`): el JavaScript que corre en el teléfono lleva dentro el
 * identificador con el que se compiló, y aquí se le dice el del despliegue que
 * contesta. Si no coinciden, la app instalada lleva abierta desde antes de un
 * despliegue y ServiceWorkerRegister ofrece actualizar ANTES de que el jugador
 * toque algo y le falle.
 *
 * LOS DOS LADOS LEEN LA MISMA VARIABLE, `NEXT_PUBLIC_BUILD_ID`, que Next deja
 * escrita en el código al compilar (también aquí, en el servidor). Es lo que
 * garantiza que cliente y servidor de un MISMO despliegue digan lo mismo: si
 * cada uno la leyera de un sitio distinto y un día no coincidieran, el aviso de
 * "hay una versión nueva" se quedaría puesto para siempre.
 *
 * LA DEFINE `env` DE next.config.ts, a partir de `VERCEL_DEPLOYMENT_ID` o, si
 * falta, de `VERCEL_GIT_COMMIT_SHA`. En Vercel la comparación está, por tanto,
 * ENCENDIDA. Fuera de Vercel y en desarrollo ninguna de las dos existe: la
 * variable queda vacía, esto devuelve "" y la comparación no se hace (el
 * cliente tampoco tiene con qué comparar). No hay que definirla en ningún otro
 * sitio: una segunda definición es la forma de que los dos lados discrepen.
 *
 * Sin un `Date.now()` de respaldo: tiene que ser un valor que salga igual en el
 * bundle del navegador y en el del servidor.
 *
 * `force-dynamic` y `no-store`: la respuesta no puede salir de ninguna caché,
 * o diría el build de cuando se guardó. El service worker no toca /api.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { build: process.env.NEXT_PUBLIC_BUILD_ID ?? "" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
