// src/services/pokemon.ts
'use server'

const MAX_RETRIES = 3; // Intentaremos 3 veces máximo
const TIMEOUT_MS = 20000; // 8 segundos de espera máximo por intento

export const getCardsFromSet = async (setId: string) => {
  console.log(`🦜 Servidor iniciando búsqueda para set: ${setId}`);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`... Intento ${attempt} de ${MAX_RETRIES}`);

      // Usamos AbortController para cortar la conexión si tarda mucho
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(
        `https://api.pokemontcg.io/v2/cards?q=set.id:${setId}&select=id,name,images,rarity`, 
        {
          // 🔴 ANTES: cache: 'no-store' (Esto era lo lento)
          
          // 🟢 AHORA: Guardamos los datos 1 día entero (86400 segundos)
          next: { revalidate: 86400 }, 
          
          signal: controller.signal,
          headers: {
            'X-Api-Key': 'TU_CLAVE_API_AQUI' 
          }
        }
      );

      clearTimeout(timeoutId); // Si responde rápido, cancelamos el timeout

      if (!response.ok) {
         // Si es un error 504 (Timeout) o 500, lanzamos error para reintentar
         if (response.status >= 500) {
             throw new Error(`Error servidor (${response.status})`);
         }
         // Si es otro error (ej: 404), paramos ya
         console.error(`Error API definitivo: ${response.status}`);
         return [];
      }

      const data = await response.json();
      console.log(`✅ ¡Éxito en el intento ${attempt}! ${data.data.length} cartas.`);
      return data.data;

    } catch (error: any) {
      console.error(`❌ Falló el intento ${attempt}:`, error.message);
      
      // Si es el último intento, nos rendimos
      if (attempt === MAX_RETRIES) {
          console.error("💀 Se acabaron los intentos. La API no responde.");
          return []; 
      }
      
      // Si falló, esperamos 1 segundo antes de reintentar (Backoff)
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return [];
};  