// components/PokemonCard.tsx
"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toggleFavorite } from "@/app/action"; // Asegúrate de que la ruta sea correcta

const CARD_BACK = "https://tcg.pokemon.com/assets/img/global/tcg-card-back-2x.jpg";

// <--- HOLO 1: Función auxiliar rareza
const isHoloCard = (rarity: string | undefined) => {
  if (!rarity) return false;
  const nonHoloRarities = ["Common", "Uncommon", "Rare"];
  return !nonHoloRarities.includes(rarity);
};

interface PokemonCardProps {
  card: any;
  reveal?: boolean;
  isFavorite?: boolean; // <--- Nueva prop recibida desde la DB
}

export default function PokemonCard({
  card,
  reveal = false,
  isFavorite = false,
}: PokemonCardProps) {
  const [isFlipped, setIsFlipped] = useState(!reveal);
  const [isAnimating, setIsAnimating] = useState(false);
  
  // <--- FAVORITOS: Estado local para respuesta inmediata
  const [fav, setFav] = useState(isFavorite);

  // <--- HOLO 2: Calculamos efecto
  const hasHoloEffect = isHoloCard(card.rarity);

  useEffect(() => {
    setIsFlipped(!reveal);
  }, [reveal]);

  // Sincronizar favorito si cambia desde fuera (ej: al cargar la colección)
  useEffect(() => {
    setFav(isFavorite);
  }, [isFavorite]);

  const handleFlip = () => {
    if (!isAnimating) {
      setIsFlipped(!isFlipped);
      setIsAnimating(true);
    }
  };

  // <--- FAVORITOS: Manejador del clic
  const handleFavClick = async (e: React.MouseEvent) => {
    e.stopPropagation(); // 🛑 EVITA QUE LA CARTA GIRE AL DARLE AL CORAZÓN
    
    // 1. Optimistic UI: Cambiamos visualmente ya
    const previousState = fav;
    setFav(!fav);

    // 2. Llamada al servidor
    const result = await toggleFavorite(card.id);

    // 3. Si hay error (ej: límite de 10 superado), revertimos
    if (result && result.error) {
      alert(result.error);
      setFav(previousState);
    }
  };

  return (
    <div
      className="relative w-full aspect-[2.5/3.5] cursor-pointer group perspective-1000"
      onClick={handleFlip}
    >
      <motion.div
        className="w-full h-full relative preserve-3d"
        initial={false}
        animate={{ rotateY: isFlipped ? 180 : 0 }}
        transition={{
          duration: 0.6,
          type: "spring",
          stiffness: 200,
          damping: 20,
        }}
        onAnimationComplete={() => setIsAnimating(false)}
        style={{ transformStyle: "preserve-3d" }}
      >
        {/* --- CARA DELANTERA --- */}
        <div
          className="absolute w-full h-full rounded-xl overflow-hidden shadow-lg border border-gray-800 bg-gray-900"
          style={{ backfaceVisibility: "hidden" }}
        >
          {/* BOTÓN DE FAVORITO (Solo visible si está revelada) */}
          {!isFlipped && (
            <button
              onClick={handleFavClick}
              className="absolute top-2 left-2 z-40 p-1 rounded-full hover:scale-110 transition-transform focus:outline-none drop-shadow-md"
              title={fav ? "Quitar de favoritos" : "Añadir a favoritos"}
            >
              <AnimatePresence mode="wait">
                {fav ? (
                  <motion.span
                    key="filled"
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    exit={{ scale: 0 }}
                    className="text-2xl"
                  >
                    ❤️
                  </motion.span>
                ) : (
                  <motion.span
                    key="outline"
                    className="text-2xl opacity-50 hover:opacity-100 grayscale hover:grayscale-0 transition-all"
                  >
                    🤍
                  </motion.span>
                )}
              </AnimatePresence>
            </button>
          )}

          <img
            src={card.images.small}
            alt={card.name}
            className="w-full h-full object-cover relative z-10"
          />

          {/* <--- HOLO 3: CAPA DE BRILLO --- */}
          {hasHoloEffect && (
            <div
              className="absolute inset-0 z-20 opacity-0 group-hover:opacity-60 transition-opacity duration-500 mix-blend-color-dodge pointer-events-none"
              style={{
                backgroundImage:
                  "linear-gradient(105deg, transparent 30%, rgba(255,219,112,0.4) 40%, rgba(132,50,255,0.4) 50%, rgba(0,200,255,0.4) 60%, transparent 70%)",
                backgroundSize: "200% 200%",
              }}
            ></div>
          )}

          {/* Badge de rareza */}
          {hasHoloEffect && (
            <span className="absolute top-2 right-2 z-30 text-[9px] bg-yellow-400/80 text-black font-bold px-1 rounded shadow-sm backdrop-blur-sm">
              HOLO
            </span>
          )}
        </div>

        {/* --- CARA TRASERA --- */}
        <div
          className="absolute w-full h-full rounded-xl overflow-hidden shadow-lg backface-hidden"
          style={{ transform: "rotateY(180deg)", backfaceVisibility: "hidden" }}
        >
          <img
            src={CARD_BACK}
            alt="Card Back"
            className="w-full h-full object-cover"
          />
        </div>
      </motion.div>
    </div>
  );
}