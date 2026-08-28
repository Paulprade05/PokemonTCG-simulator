// src/components/PokemonCard.tsx
"use client";

import { useState, useEffect, useRef, memo } from "react";
import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import { RARITY_GLOW } from "../utils/rarityGlow";

const CARD_BACK = "https://tcg.pokemon.com/assets/img/global/tcg-card-back-2x.jpg";

const isHoloCard = (rarity: string | undefined) => {
  if (!rarity) return false;
  const nonHoloRarities = ["Common", "Uncommon", "Rare"];
  return !nonHoloRarities.includes(rarity);
};

const getRarityGlow = (rarity?: string) => (rarity && RARITY_GLOW[rarity]) || null;

interface PokemonCardProps {
  card: any;
  reveal?: boolean;
  useHighRes?: boolean;
  interactive?: boolean; // tilt 3D + tracking — desactivar en grids
}

// Sin srcSet a propósito. Sólo hay dos variantes (245w y 734w) y en un iPhone
// la celda pide ~386px físicos, así que el navegador elegiría SIEMPRE la
// grande: recorrer un álbum de 258 cartas pasaría de 45 MB a 151 MB de
// descarga. En rejilla mandan los datos; la nitidez la gana el camino rápido,
// que pinta la carta sin capa compositada y por tanto a resolución nativa.
function pickImageUrl(card: any, useHighRes: boolean): string | undefined {
  const smallUrl: string | undefined = card.images?.small;
  const largeUrl: string | undefined = card.images?.large;
  return useHighRes ? largeUrl || smallUrl : smallUrl || largeUrl;
}

/** La ilustración o, si la carta no trae imágenes, el hueco con su nombre. */
function CardFace({
  card,
  useHighRes,
  loading,
}: {
  card: any;
  useHighRes: boolean;
  loading: "eager" | "lazy";
}) {
  const imageUrl = pickImageUrl(card, useHighRes);
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={card.name}
        // La carta grande es el contenido principal de la pantalla: no
        // debe esperar al observer de lazy-loading.
        loading={loading}
        decoding="async"
        className="w-full h-full object-contain"
      />
    );
  }
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-2 text-center">
      {card.number && (
        <span className="text-xs font-semibold tnum ink-soft">#{card.number}</span>
      )}
      {/* El nombre es la única información útil del hueco: ink-soft (>=5,5:1),
          no ink-faint (~3,7:1), que a ~11px no llega al mínimo de texto. */}
      <span className="text-[0.7rem] leading-tight ink-soft line-clamp-3">
        {card.name || "Carta sin imagen"}
      </span>
    </div>
  );
}

/**
 * Camino rápido de las rejillas (colección, álbum, entrenador, resumen).
 *
 * Sin perspectiva, sin `preserve-3d`, sin reverso y sin motion: un álbum de
 * 258 cartas creaba 258 capas compositadas y el scroll iba a tirones. Aquí
 * la carta es una imagen y ya.
 *
 * Es un componente propio y sin hooks a propósito: así esas mismas 258 cartas
 * no instancian motion values, springs ni un timeout de 900ms por carta que
 * jamás usarían.
 */
function PokemonCardStatic({
  card,
  useHighRes,
}: {
  card: any;
  useHighRes: boolean;
}) {
  return (
    <div
      className="relative w-full aspect-[2.5/3.5] overflow-hidden rounded-[4.5%] border border-[var(--border)] bg-[var(--surface-2)]"
      style={{ boxShadow: "var(--shadow-md)" }}
    >
      {/* `loading` sigue a useHighRes, igual que en la variante interactiva.
          Estaba clavado en "lazy" y eso anulaba la precarga del mazo de la
          apertura: MazoCartas pide la variante grande para las ranuras vecinas
          justo para tenerla decodificada cuando entren, pero esas ranuras están
          trasladadas FUERA del viewport, así que con lazy el navegador podía no
          descargarlas hasta que ya estaban en pantalla.
          Las rejillas (colección, álbum, entrenador, resumen) no se enteran:
          pasan useHighRes = false y siguen siendo lazy, que es lo que mantiene
          un álbum de 258 cartas en 45 MB y no en 151. */}
      <CardFace card={card} useHighRes={useHighRes} loading={useHighRes ? "eager" : "lazy"} />
    </div>
  );
}

function PokemonCardInteractive({
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
                : "var(--shadow-md)",
          }}
        >
          <CardFace
            card={card}
            useHighRes={useHighRes}
            loading={useHighRes ? "eager" : "lazy"}
          />

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
            boxShadow: "var(--shadow-md)",
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

/**
 * Decide qué carta renderizar. No llama a ningún hook, así que el return
 * condicional es válido: cada componente hijo llama SIEMPRE a los suyos.
 */
function PokemonCardInner(props: PokemonCardProps) {
  if (!props.interactive && props.reveal) {
    return (
      <PokemonCardStatic card={props.card} useHighRes={props.useHighRes ?? false} />
    );
  }
  return <PokemonCardInteractive {...props} />;
}

const PokemonCard = memo(PokemonCardInner, (a, b) =>
  a.card?.id === b.card?.id &&
  a.card?.quantity === b.card?.quantity &&
  a.reveal === b.reveal &&
  a.useHighRes === b.useHighRes &&
  a.interactive === b.interactive,
);
export default PokemonCard;
