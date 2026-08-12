import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Sin next/image en la app: las cartas se pintan con <img> a propósito
  // (presupuesto de datos, ver PokemonCard). El bloque images.remotePatterns
  // no autorizaba nada, así que se retira para no sugerir una optimización
  // de imágenes que no existe.
  poweredByHeader: false,
};

export default nextConfig;
