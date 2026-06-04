// src/components/PokemonCard.tsx
"use client";

import { useState, useEffect, useRef } from "react";
import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";

const CARD_BACK = "https://tcg.pokemon.com/assets/img/global/tcg-card-back-2x.jpg";

const isHoloCard = (rarity: string | undefined) => {
  if (!rarity) return false;
  const nonHoloRarities = ["Common", "Uncommon", "Rare"];
  return !nonHoloRarities.includes(rarity);
};

const RARITY_GLOW: Record<string, string> = {
  "Hyper Rare": "rgba(250, 204, 21, 0.55)",
  "Rare Secret": "rgba(250, 204, 21, 0.5)",
  "Rare Rainbow": "rgba(244, 114, 182, 0.5)",
  "Special Illustration Rare": "rgba(217, 70, 239, 0.5)",
  "Illustration Rare": "rgba(168, 85, 247, 0.45)",
  "Shiny Ultra Rare": "rgba(56, 189, 248, 0.45)",
  "Ultra Rare": "rgba(99, 102, 241, 0.45)",
  "Rare Ultra": "rgba(99, 102, 241, 0.45)",
  "Rare Holo VSTAR": "rgba(34, 211, 238, 0.4)",
  "Rare Holo VMAX": "rgba(244, 63, 94, 0.4)",
  "Double Rare": "rgba(96, 165, 250, 0.35)",
  "Rare Holo V": "rgba(96, 165, 250, 0.35)",
  "Trainer Gallery Rare Holo": "rgba(192, 132, 252, 0.35)",
  "Radiant Rare": "rgba(251, 146, 60, 0.4)",
  "Amazing Rare": "rgba(167, 243, 208, 0.4)",
  "Rare Holo": "rgba(250, 204, 21, 0.25)",
};
const getRarityGlow = (rarity?: string) => (rarity && RARITY_GLOW[rarity]) || null;

interface PokemonCardProps {
  card: any;
  reveal?: boolean;
  useHighRes?: boolean;
  interactive?: boolean; // tilt 3D + tracking — desactivar en grids
}

export default function PokemonCard({
  card,
  reveal = false,
  useHighRes = false,
  interactive = true,
}: PokemonCardProps) {
  const [isFlipped, setIsFlipped] = useState(!reveal);
  const [isHovered, setIsHovered] = useState(false);
  const hasHoloEffect = isHoloCard(card.rarity);
  const rarityGlow = getRarityGlow(card.rarity);
  const cardRef = useRef<HTMLDivElement>(null);

  // Mouse Position for 3D Tilt (solo si interactivo)
  const x = useMotionValue(0);
  const y = useMotionValue(0);

  const mouseXSpring = useSpring(x, { stiffness: 300, damping: 40 });
  const mouseYSpring = useSpring(y, { stiffness: 300, damping: 40 });

  const rotateX = useTransform(mouseYSpring, [-0.5, 0.5], ["15deg", "-15deg"]);
  const rotateYFront = useTransform(mouseXSpring, [-0.5, 0.5], ["-15deg", "15deg"]);

  useEffect(() => {
    setIsFlipped(!reveal);
  }, [reveal]);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!interactive || !cardRef.current || isFlipped) return;
    const rect = cardRef.current.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const xPct = mouseX / width - 0.5;
    const yPct = mouseY / height - 0.5;
    x.set(xPct);
    y.set(yPct);
  };

  const handleMouseLeave = () => {
    if (!interactive) return;
    x.set(0);
    y.set(0);
    setIsHovered(false);
  };

  const imageUrl = useHighRes ? card.images?.large : card.images?.small;

  const getPrice = (tcgplayer: any) => {
    if(!tcgplayer || !tcgplayer.prices) return null;
    const p = tcgplayer.prices;
    if(p.holofoil?.mid) return p.holofoil.mid;
    if(p.normal?.mid) return p.normal.mid;
    if(p.reverseHolofoil?.mid) return p.reverseHolofoil.mid;
    const firstKey = Object.keys(p)[0];
    if(firstKey && p[firstKey]?.mid) return p[firstKey].mid;
    return null;
  };

  const price = getPrice(card.tcgplayer);

  return (
    <div 
      className="relative w-full aspect-[2.5/3.5] group perspective-1000"
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onMouseEnter={() => setIsHovered(true)}
    >
      <motion.div
        className="w-full h-full relative preserve-3d"
        initial={false}
        animate={{ rotateY: isFlipped ? 180 : 0 }}
        transition={{ duration: 0.8, type: "spring", stiffness: 100, damping: 20 }}
        style={{
          transformStyle: "preserve-3d",
          rotateX: interactive && !isFlipped ? rotateX : 0,
          rotateY: interactive && !isFlipped ? rotateYFront : undefined,
          filter: interactive && !isFlipped && rarityGlow
            ? `drop-shadow(0px 0px ${isHovered ? 30 : 18}px ${rarityGlow}) drop-shadow(0px 12px 18px rgba(0,0,0,0.5))`
            : "drop-shadow(0px 8px 18px rgba(0,0,0,0.45))"
        }}
      >
        {/* --- FRONT FACE --- */}
        <div
          className="absolute w-full h-full rounded-[4.5%] overflow-hidden bg-[#0a0a0a] border border-white/10"
          style={{ backfaceVisibility: "hidden" }}
        >
          {imageUrl && (
            <img
              src={imageUrl} 
              alt={card.name}
              className="w-full h-full object-contain drop-shadow-xl"
            />
          )}
          
          {hasHoloEffect && interactive && (
            <motion.div
              className="absolute inset-0 z-20 mix-blend-color-dodge transition-opacity duration-300 pointer-events-none"
              style={{
                backgroundImage: `linear-gradient(115deg, transparent 20%, rgba(255,255,255,0.4) 45%, rgba(255,200,255,0.4) 50%, rgba(200,255,255,0.4) 55%, transparent 80%)`,
                backgroundSize: '200% 200%',
                backgroundPosition: useTransform(
                  mouseXSpring,
                  [-0.5, 0.5],
                  ["100% 100%", "0% 0%"]
                ),
                opacity: isHovered ? 0.8 : 0
              }}
            />
          )}

          {/* CARD INFO OVERLAY (Mobile Friendly) */}
          {!isFlipped && (
            <div 
              className="absolute bottom-0 left-0 w-full p-3 bg-black/70 backdrop-blur-md border-t border-white/10 z-30 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
            >
              <div className="flex flex-col gap-1 text-xs">
                <div className="flex justify-between items-center">
                  <span className="text-white/90 font-bold truncate mr-2">{card.name}</span>
                  {price && <span className="text-emerald-400 font-bold shrink-0">${price.toFixed(2)}</span>}
                </div>
                <div className="flex justify-between items-center text-[10px] text-gray-400">
                  <span className="truncate mr-2">{card.artist || "Unknown Artist"}</span>
                  <span className="text-white/70 bg-white/10 px-1.5 py-0.5 rounded shrink-0">{card.rarity || "Unknown"}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* --- BACK FACE --- */}
        <div
          className="absolute w-full h-full rounded-[4.5%] overflow-hidden shadow-xl backface-hidden border border-white/10"
          style={{ transform: "rotateY(180deg)", backfaceVisibility: "hidden" }}
        >
          <img src={CARD_BACK} alt="Card Back" className="w-full h-full object-cover" />
        </div>
      </motion.div>
    </div>
  );
}