// src/services/pokemon.ts

const API_KEY = process.env.NEXT_PUBLIC_POKEMON_API_KEY; 

export async function getCardsFromSet(setId: string) {
  // 1. 🕵️‍♂️ PRIMERO MIRAMOS EN LA "CACHÉ" LOCAL (Tu navegador)
  // Si ya hemos descargado este set antes, lo leemos de la memoria.
  if (typeof window !== 'undefined') {
    const cachedData = localStorage.getItem(`cache_set_${setId}`);
    if (cachedData) {
      console.log(`⚡ Cargando set ${setId} desde caché local...`);
      return JSON.parse(cachedData);
    }
  }

  // 2. 🌐 SI NO LO TENEMOS, LLAMAMOS A LA API
  try {
    console.log(`📡 Descargando set ${setId} de internet...`);
    const response = await fetch(
      `https://api.pokemontcg.io/v2/cards?q=set.id:${setId}&select=id,name,images,rarity,set,number,artist,flavorText,tcgplayer,types,subtypes,hp,supertype`, 
      {
        headers: {
          ...(API_KEY && { "3f05da5b-76ab-47ff-b319-44440619ffda": API_KEY }),
        }
      }
    );

    if (!response.ok) {
       if (response.status === 429) throw new Error("⚠️ Demasiadas peticiones. Espera un minuto.");
       throw new Error("Error de conexión con la API");
    }

    const data = await response.json();
    
    const cleanData = data.data.map((card: any) => ({
      id: card.id,
      name: card.name,
      images: card.images,
      rarity: card.rarity,
      set: card.set, 
      number: card.number,
      artist: card.artist,
      flavorText: card.flavorText,
      tcgplayer: card.tcgplayer,
      hp: card.hp,
      types: card.types,
      subtypes: card.subtypes,
      supertype: card.supertype
    }));

    // 3. 💾 ¡GUARDAMOS EN CACHÉ PARA SIEMPRE!
    // La próxima vez no hará falta internet
    if (typeof window !== 'undefined') {
        try {
            localStorage.setItem(`cache_set_${setId}`, JSON.stringify(cleanData));
        } catch (e) {
            console.warn("Memoria llena, no se pudo cachear el set.");
        }
    }

    return cleanData;

  } catch (error) {
    console.error(error);
    // Si falla, devolvemos array vacío para que la UI lo maneje
    throw error;
  }
}