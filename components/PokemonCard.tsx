// src/components/PokemonCard.tsx
"use client";

import { useState, useEffect, useRef, memo } from "react";
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

function PokemonCardInner({
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
  // Se calcula siempre (aunque la carta no sea holo) para no llamar hooks
  // dentro de una rama del JSX: el orden de los hooks debe ser estable.
  const holoPosition = useTransform(
    mouseXSpring,
    [-0.5, 0.5],
    ["100% 100%", "0% 0%"],
  );

  /**
   * Con la carta ya girada y quieta, se abandona el contexto 3D.
   *
   * WebKit promociona a capa compositada todo lo que lleve
   * `backface-visibility: hidden` dentro de un `preserve-3d`, y esa capa se
   * rasteriza a una escala fija: en un iPhone la ilustración se ve blanda
   * aunque la fuente sea la de alta resolución. En reposo la carta no necesita
   * volumen, así que se pinta plana y el navegador la dibuja a resolución
   * nativa. Durante el giro sí hace falta el 3D, pero ahí el movimiento tapa
   * cualquier pérdida de nitidez.
   */
  const [settled, setSettled] = useState(reveal);

  useEffect(() => {
    setIsFlipped(!reveal);
    if (!reveal) {
      setSettled(false);
      return;
    }
    // Respaldo por si onAnimationComplete no llega (pestaña en segundo plano,
    // movimiento reducido): pasado el tiempo del giro, se asienta igualmente.
    const t = window.setTimeout(() => setSettled(true), 900);
    return () => window.clearTimeout(t);
  }, [reveal]);

  // --- A partir de aquí ya no hay hooks: se puede volver antes sin romper el
  // orden de llamada de React. ---

  // El volumen sólo se necesita al girar o mientras se inclina con el puntero.
  const flat = settled && !isFlipped && !isHovered;

  const smallUrl: string | undefined = card.images?.small;
  const largeUrl: string | undefined = card.images?.large;
  const imageUrl = useHighRes ? largeUrl || smallUrl : smallUrl || largeUrl;

  // Sin srcSet a propósito. Sólo hay dos variantes (245w y 734w) y en un iPhone
  // la celda pide ~386px físicos, así que el navegador elegiría SIEMPRE la
  // grande: recorrer un álbum de 258 cartas pasaría de 45 MB a 151 MB de
  // descarga. En rejilla mandan los datos; la nitidez la gana el camino rápido,
  // que pinta la carta sin capa compositada y por tanto a resolución nativa.

  /** Hueco cuando la carta no trae imágenes: mejor que un esqueleto eterno. */
  const placeholder = (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-2 text-center">
      {card.number && (
        <span className="text-xs font-semibold tnum ink-soft">#{card.number}</span>
      )}
      <span className="text-[0.7rem] leading-tight ink-faint line-clamp-3">
        {card.name || "Carta sin imagen"}
      </span>
    </div>
  );

  const image = (loading: "eager" | "lazy") =>
    imageUrl ? (
      <img
        src={imageUrl}
        alt={card.name}
        // La carta grande es el contenido principal de la pantalla: no
        // debe esperar al observer de lazy-loading.
        loading={loading}
        decoding="async"
        className="w-full h-full object-contain"
      />
    ) : (
      placeholder
    );

  /**
   * Camino rápido de las rejillas (colección, álbum, entrenador, resumen).
   *
   * Sin perspectiva, sin `preserve-3d`, sin reverso y sin motion: un álbum de
   * 258 cartas creaba 258 capas compositadas y el scroll iba a tirones. Aquí
   * la carta es una imagen y ya.
   */
  if (!interactive && reveal) {
    return (
      <div
        className="relative w-full aspect-[2.5/3.5] overflow-hidden rounded-[4.5%] border border-[var(--border)] bg-[var(--surface-2)]"
        style={{ boxShadow: "0 8px 18px rgba(0,0,0,0.45)" }}
      >
        {image("lazy")}
      </div>
    );
  }

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

  /**
   * En iOS no existe el hover: sin esto, ni el brillo holográfico ni la
   * inclinación llegan a verse nunca. Se enganchan también al puntero (dedo o
   * lápiz) mientras se mantiene pulsada la carta. El ratón ya va por los
   * eventos de arriba, así que aquí se ignora para no duplicar trabajo.
   * No se llama a preventDefault ni se fija touch-action: el pinch y el scroll
   * siguen funcionando igual.
   */
  const trackPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive || !cardRef.current || isFlipped) return;
    const rect = cardRef.current.getBoundingClientRect();
    x.set((e.clientX - rect.left) / rect.width - 0.5);
    y.set((e.clientY - rect.top) / rect.height - 0.5);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive || e.pointerType === "mouse") return;
    setIsHovered(true);
    trackPointer(e);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive || e.pointerType === "mouse" || !isHovered) return;
    trackPointer(e);
  };

  const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive || e.pointerType === "mouse") return;
    x.set(0);
    y.set(0);
    setIsHovered(false);
  };

  return (
    <div
      className={`relative w-full aspect-[2.5/3.5] group ${flat ? "" : "perspective-1000"}`}
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onMouseEnter={() => setIsHovered(true)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
    >
      <motion.div
        className="w-full h-full relative"
        initial={false}
        animate={{ rotateY: isFlipped ? 180 : 0 }}
        transition={{ duration: 0.8, type: "spring", stiffness: 100, damping: 20 }}
        onAnimationComplete={() => {
          if (!isFlipped) setSettled(true);
        }}
        style={{
          // En reposo se sale del 3D para que la carta no viva en una capa
          // compositada y se dibuje a resolución nativa.
          transformStyle: flat ? "flat" : "preserve-3d",
          rotateX: interactive && !isFlipped ? rotateX : 0,
          rotateY: interactive && !isFlipped ? rotateYFront : undefined,
        }}
      >
        {/* --- FRONT FACE --- */}
        <div
          className="absolute w-full h-full rounded-[4.5%] overflow-hidden bg-[var(--surface-2)] border border-[var(--border)]"
          style={{
            backfaceVisibility: flat ? "visible" : "hidden",
            // Sombra y halo con box-shadow y no con filter: un `filter` sobre un
            // elemento con preserve-3d obliga a WebKit a rasterizar la capa
            // entera —la imagen incluida— y la textura no siempre respeta la
            // densidad de pantalla del iPhone, lo que se ve como una carta
            // borrosa. box-shadow pinta igual sin rasterizar el contenido.
            boxShadow:
              interactive && !isFlipped && rarityGlow
                ? `0 0 ${isHovered ? 30 : 18}px ${rarityGlow}, 0 12px 18px rgba(0,0,0,0.5)`
                : "0 8px 18px rgba(0,0,0,0.45)",
          }}
        >
          {image(useHighRes ? "eager" : "lazy")}

          {hasHoloEffect && interactive && (
            <motion.div
              className="absolute inset-0 z-20 mix-blend-color-dodge transition-opacity duration-300 pointer-events-none"
              style={{
                backgroundImage: `linear-gradient(115deg, transparent 20%, rgba(255,255,255,0.4) 45%, rgba(255,200,255,0.4) 50%, rgba(200,255,255,0.4) 55%, transparent 80%)`,
                backgroundSize: '200% 200%',
                backgroundPosition: holoPosition,
                opacity: isHovered ? 0.8 : 0
              }}
            />
          )}

          {/* Sin franja de datos encima de la ilustración: tapaba el arte de la
              carta. Nombre, artista y rareza se leen en el detalle. */}
        </div>

        {/* --- BACK FACE ---
            Sólo existe cuando puede verse: en el camino rápido de las rejillas
            ni se monta. */}
        <div
          className="absolute w-full h-full rounded-[4.5%] overflow-hidden backface-hidden border border-[var(--border)]"
          style={{
            transform: "rotateY(180deg)",
            backfaceVisibility: "hidden",
            boxShadow: "0 8px 18px rgba(0,0,0,0.45)",
            // Fuera del contexto 3D el reverso ya no queda oculto por su cara
            // trasera, así que se retira del todo.
            display: flat ? "none" : "block",
          }}
        >
          <img
            src={CARD_BACK}
            alt="Card Back"
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover"
          />
        </div>
      </motion.div>
    </div>
  );
}

const PokemonCard = memo(PokemonCardInner, (a, b) =>
  a.card?.id === b.card?.id &&
  a.card?.quantity === b.card?.quantity &&
  a.reveal === b.reveal &&
  a.useHighRes === b.useHighRes &&
  a.interactive === b.interactive,
);
export default PokemonCard;
