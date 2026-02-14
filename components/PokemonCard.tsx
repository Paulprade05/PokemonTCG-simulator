"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toggleFavorite } from "@/app/action";

const CARD_BACK = "https://tcg.pokemon.com/assets/img/global/tcg-card-back-2x.jpg";

const isHoloCard = (rarity: string | undefined) => {
  if (!rarity) return false;
  const nonHoloRarities = ["Common", "Uncommon", "Rare"];
  return !nonHoloRarities.includes(rarity);
};

interface PokemonCardProps {
  card: any;
  reveal?: boolean;
  isFavorite?: boolean;
}

export default function PokemonCard({
  card,
  reveal = false,
  isFavorite = false,
}: PokemonCardProps) {
  const [isFlipped, setIsFlipped] = useState(!reveal);
  const [isAnimating, setIsAnimating] = useState(false);
  const [fav, setFav] = useState(isFavorite);
  const hasHoloEffect = isHoloCard(card.rarity);

  useEffect(() => {
    setIsFlipped(!reveal);
  }, [reveal]);

  useEffect(() => {
    setFav(isFavorite);
  }, [isFavorite]);

  // 🧠 FUNCIÓN MAESTRA: Un solo clic para gobernarlos a todos
  const handleCardClick = async (e: React.MouseEvent) => {
    // 1. Identificamos si el usuario pulsó el corazón
    // (Buscamos si el elemento clickeado o sus padres son un botón)
    const target = e.target as HTMLElement;
    const isHeartClick = target.closest('button');

    if (isHeartClick) {
      // --- LÓGICA DE FAVORITO ---
      console.log("❤️ Click en corazón detectado");
      
      const previousState = fav;
      setFav(!fav); // Cambio visual inmediato

      const result = await toggleFavorite(card.id);

      if (result && result.error) {
        alert(result.error);
        setFav(previousState); // Revertimos si falla
      }
      return; // 🛑 IMPORTANTE: Aquí paramos para que NO gire
    }

    // --- LÓGICA DE GIRAR (FLIP) ---
    // Si no fue el corazón, entonces giramos la carta
    if (!isAnimating) {
      setIsFlipped(!isFlipped);
      setIsAnimating(true);
    }
  };

  return (
    <div
      className="relative w-full aspect-[2.5/3.5] cursor-pointer group perspective-1000"
      onClick={handleCardClick} // 👈 EL ÚNICO CLIC QUE NECESITAS
    >
      <motion.div
        className="w-full h-full relative preserve-3d"
        initial={false}
        animate={{ rotateY: isFlipped ? 180 : 0 }}
        transition={{ duration: 0.6, type: "spring", stiffness: 200, damping: 20 }}
        onAnimationComplete={() => setIsAnimating(false)}
        style={{ transformStyle: "preserve-3d" }}
      >
        {/* --- CARA DELANTERA --- */}
        <div
          className="absolute w-full h-full rounded-xl overflow-hidden shadow-lg border border-gray-800 bg-gray-900"
          style={{ backfaceVisibility: "hidden" }}
        >
          {/* ❤️ BOTÓN CORAZÓN */}
          {/* Lo ponemos DESPUÉS de la imagen en el código para que quede ENCIMA visualmente */}
          {/* Quitamos todos los onClicks de aquí, el padre se encarga */}
          {!isFlipped && (
            <button
              type="button"
              className="absolute top-2 left-2 z-50 p-2 rounded-full hover:scale-110 transition-transform active:scale-95"
            >
              <AnimatePresence mode="wait">
                {fav ? (
                  <motion.span
                    key="loved"
                    initial={{ scale: 0 }} animate={{ scale: 1 }}
                    className="text-2xl drop-shadow-md filter block"
                  >
                    ❤️
                  </motion.span>
                ) : (
                  <motion.span
                    key="unloved"
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    className="text-2xl opacity-70 hover:opacity-100 grayscale hover:grayscale-0 transition-all drop-shadow-md block"
                  >
                    🤍
                  </motion.span>
                )}
              </AnimatePresence>
            </button>
          )}

          {/* 🖼️ IMAGEN Y HOLO */}
          <div className="w-full h-full relative z-10 pointer-events-none">
             {/* pointer-events-none ayuda a que el clic atraviese hasta el padre si fuera necesario, 
                 pero con nuestro handleCardClick ya no es crítico. */}
            <img
              src={card.images.small}
              alt={card.name}
              className="w-full h-full object-cover"
            />
            
            {hasHoloEffect && (
              <div
                className="absolute inset-0 z-20 opacity-0 group-hover:opacity-60 transition-opacity duration-500 mix-blend-color-dodge"
                style={{
                  backgroundImage: "linear-gradient(105deg, transparent 30%, rgba(255,219,112,0.4) 40%, rgba(132,50,255,0.4) 50%, rgba(0,200,255,0.4) 60%, transparent 70%)",
                  backgroundSize: "200% 200%",
                }}
              />
            )}
          </div>
          
           {hasHoloEffect && (
              <span className="absolute top-2 right-2 z-30 text-[9px] bg-yellow-400/80 text-black font-bold px-1 rounded shadow-sm backdrop-blur-sm pointer-events-none">
                HOLO
              </span>
            )}
        </div>

        {/* --- CARA TRASERA --- */}
        <div
          className="absolute w-full h-full rounded-xl overflow-hidden shadow-lg backface-hidden"
          style={{ transform: "rotateY(180deg)", backfaceVisibility: "hidden" }}
        >
          <img src={CARD_BACK} alt="Card Back" className="w-full h-full object-cover" />
        </div>
      </motion.div>
    </div>
  );
}