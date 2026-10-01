import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Sin next/image en la app: las cartas se pintan con <img> a propósito
  // (presupuesto de datos, ver PokemonCard). El bloque images.remotePatterns
  // no autorizaba nada, así que se retira para no sugerir una optimización
  // de imágenes que no existe.
  poweredByHeader: false,
  // EL IDENTIFICADOR DEL DESPLIEGUE, escrito en el código al compilar para que
  // el JavaScript del teléfono y el servidor que le contesta puedan compararse
  // (utils/versionApp.ts y app/api/version). Una PWA instalada vive días en
  // memoria; si entre medias hay un despliegue, sus server actions ya no
  // existen en el servidor y todo falla pareciendo un problema de conexión.
  // Vacío fuera de Vercel o en desarrollo: entonces no se compara nada, que es
  // mejor que un valor inventado que no coincidiera nunca y dejara el aviso de
  // "hay una versión nueva" puesto para siempre.
  env: {
    NEXT_PUBLIC_BUILD_ID:
      process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "",
  },
};

export default nextConfig;
