// components/PokemonCard.tsx
"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";

const CARD_BACK =
  "https://tcg.pokemon.com/assets/img/global/tcg-card-back-2x.jpg";

// <--- HOLO 1: Función auxiliar para decidir si una carta debe brillar
// Comprobamos si la rareza NO es una de las básicas.
const isHoloCard = (rarity: string | undefined) => {
  if (!rarity) return false;
  const nonHoloRarities = ["Common", "Uncommon", "Rare"];
  // Si la rareza NO está en la lista de "no holos", entonces ES holo.
  return !nonHoloRarities.includes(rarity);
};

interface PokemonCardProps {
  card: any;
  reveal?: boolean;
}

export default function PokemonCard({
  card,
  reveal = false,
}: PokemonCardProps) {
  const [isFlipped, setIsFlipped] = useState(!reveal);
  const [isAnimating, setIsAnimating] = useState(false);

  // <--- HOLO 2: Calculamos si esta carta específica es holo
  const hasHoloEffect = isHoloCard(card.rarity);

  useEffect(() => {
    setIsFlipped(!reveal);
  }, [reveal]);

  const handleFlip = () => {
    if (!isAnimating) {
      setIsFlipped(!isFlipped);
      setIsAnimating(true);
    }
  };

  return (
    <div
      // Añadimos 'group' aquí para poder detectar el hover en los hijos
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
        {/* --- CARA DELANTERA (La Imagen + El Holo) --- */}
        <div
          className="absolute w-full h-full rounded-xl overflow-hidden shadow-lg border border-gray-800 bg-gray-900"
          style={{ backfaceVisibility: "hidden" }}
        >
          {/* La imagen base de la carta */}
          <img
            src={card.images.small}
            alt={card.name}
            className="w-full h-full object-cover relative z-10" // Z-10 para estar abajo
          />

          {/* <--- HOLO 3: LA CAPA DE BRILLO */}
          {/* Solo se renderiza si hasHoloEffect es true */}
          {hasHoloEffect && (
            <div
              // Esta es la magia de Tailwind:
              // 1. Absolute inset-0: Cubre toda la carta.
              // 2. opacity-0 group-hover:opacity-100: Invisible hasta que pasas el ratón por el contenedor padre ('group').
              // 3. mix-blend-color-dodge: El modo de fusión que crea el efecto metálico.
              // 4. bg-[gradient...]: Un gradiente complejo que simula el reflejo.
              className="absolute inset-0 z-20 opacity-0 group-hover:opacity-60 transition-opacity duration-500 bg-gradient-to-tr from-transparent via-white/30 to-transparent bg-size-[200%_200%] bg-center mix-blend-color-dodge pointer-events-none" // Un estilo inline para un gradiente de arcoíris más complejo (opcional, el de Tailwind arriba es más sutil)
              style={{
                backgroundImage:
                  "linear-gradient(105deg, transparent 30%, rgba(255,219,112,0.4) 40%, rgba(132,50,255,0.4) 50%, rgba(0,200,255,0.4) 60%, transparent 70%)",
                backgroundSize: "200% 200%",
              }}
            ></div>
          )}

          {/* Badge de rareza (opcional, para ver si funciona la detección) */}
          {hasHoloEffect && (
            <span className="absolute top-2 right-2 z-30 text-[9px] bg-yellow-400/80 text-black font-bold px-1 rounded">
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
