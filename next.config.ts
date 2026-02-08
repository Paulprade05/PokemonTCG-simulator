/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Esto permite que Next.js acepte peticiones desde tu IP local en desarrollo
    allowedOrigins: ['192.168.1.140:3000'],
  },
  images: {
    // Esto es vital para que las imágenes de la API de Pokémon carguen correctamente
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'images.pokemontcg.io',
        port: '',
        pathname: '/**',
      },
    ],
  },
};

export default nextConfig;