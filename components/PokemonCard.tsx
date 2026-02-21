// src/components/PokemonCard.tsx
"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";

const CARD_BACK = "https://tcg.pokemon.com/assets/img/global/tcg-card-back-2x.jpg";

const isHoloCard = (rarity: string | undefined) => {
  if (!rarity) return false;
  const nonHoloRarities = ["Common", "Uncommon", "Rare"];
  return !nonHoloRarities.includes(rarity);
};

interface PokemonCardProps {
  card: any;
  reveal?: boolean;
  useHighRes?: boolean;
  // Ya no necesitamos isFavorite aquí para nada visual
}

export default function PokemonCard({ 
  card, 
  reveal = false, 
  useHighRes = false // 👈 Por defecto es false (usará la pequeña)
}: PokemonCardProps) {
  const [isFlipped, setIsFlipped] = useState(!reveal);
  const hasHoloEffect = isHoloCard(card.rarity);

  useEffect(() => {
    setIsFlipped(!reveal);
  }, [reveal]);
const imageUrl = useHighRes ? card.images.large : card.images.small;
  return (
    <div className="relative w-full aspect-[2.5/3.5] group perspective-1000">
      <motion.div
        className="w-full h-full relative preserve-3d"
        initial={false}
        animate={{ rotateY: isFlipped ? 180 : 0 }}
        transition={{ duration: 0.6, type: "spring", stiffness: 200, damping: 20 }}
        style={{ transformStyle: "preserve-3d" }}
      >
        {/* --- CARA DELANTERA --- */}
        <div
          className="absolute w-full h-full rounded-xl overflow-hidden shadow-lg border border-gray-800 bg-gray-900"
          style={{ backfaceVisibility: "hidden" }}
        >
          {/* IMAGEN LIMPIA (Sin botones encima) */}
          <img
        src={imageUrl} 
        alt={card.name}
        className="..."
      />
          
          {/* EFECTO HOLO */}
          {hasHoloEffect && (
            <div
              className="absolute inset-0 z-20 opacity-0 group-hover:opacity-60 transition-opacity duration-500 mix-blend-color-dodge pointer-events-none"
              style={{
                backgroundImage: "linear-gradient(105deg, transparent 30%, rgba(255,219,112,0.4) 40%, rgba(132,50,255,0.4) 50%, rgba(0,200,255,0.4) 60%, transparent 70%)",
                backgroundSize: "200% 200%",
              }}
            />
          )}
          
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