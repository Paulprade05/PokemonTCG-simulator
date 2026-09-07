"use client";

/**
 * `ink` es el color base del tipo, no el color final del texto: se mezcla con
 * --ink para que la etiqueta se lea en los dos temas. Un tono fijo (los -300 de
 * antes) sólo funciona sobre fondo oscuro; sobre --surface blanco quedaba en
 * ~1,3:1 de contraste.
 *
 * `bg` y `border` SÍ se quedan en paleta literal de Tailwind, y no es un olvido
 * del barrido de color: el veto a la paleta cruda es para el TEXTO, y aquí el
 * verde de Planta o el rojo de Lucha son la identidad del tipo de Pokémon —no
 * salen del tema y no cambian con él—. Ningún token del proyecto los nombra, y
 * traducirlos a --accent/--warn borraría justo lo que distingue una etiqueta de
 * la de al lado. Al 15 % de alfa son un relleno, no un color de lectura.
 */
const TYPE_STYLES: Record<string, { bg: string; ink: string; border: string; emoji: string }> = {
  Grass:     { bg: "bg-emerald-500/15", ink: "#10b981", border: "border-emerald-500/30", emoji: "🌿" },
  Fire:      { bg: "bg-orange-500/15",  ink: "#f97316", border: "border-orange-500/30",  emoji: "🔥" },
  Water:     { bg: "bg-blue-500/15",    ink: "#3b82f6", border: "border-blue-500/30",    emoji: "💧" },
  Lightning: { bg: "bg-yellow-500/15",  ink: "#eab308", border: "border-yellow-500/30",  emoji: "⚡" },
  Psychic:   { bg: "bg-purple-500/15",  ink: "#a855f7", border: "border-purple-500/30",  emoji: "🔮" },
  Fighting:  { bg: "bg-red-700/15",     ink: "#b91c1c", border: "border-red-700/30",     emoji: "👊" },
  Darkness:  { bg: "bg-zinc-700/30",    ink: "#71717a", border: "border-zinc-600/40",    emoji: "🌑" },
  Metal:     { bg: "bg-slate-500/15",   ink: "#64748b", border: "border-slate-500/30",   emoji: "⚙️" },
  Fairy:     { bg: "bg-pink-500/15",    ink: "#ec4899", border: "border-pink-500/30",    emoji: "✨" },
  Dragon:    { bg: "bg-amber-500/15",   ink: "#f59e0b", border: "border-amber-500/30",   emoji: "🐉" },
  Colorless: { bg: "bg-gray-500/15",    ink: "#6b7280", border: "border-gray-500/30",    emoji: "⚪" },
};

const typeInk = (color: string) => `color-mix(in srgb, ${color} 55%, var(--ink))`;

export default function TypeBadge({ type, size = "sm" }: { type: string; size?: "xs" | "sm" }) {
  const style = TYPE_STYLES[type] || TYPE_STYLES.Colorless;
  // `size` YA NO CAMBIA EL TAMAÑO DE LETRA, sólo el aire lateral. Antes eran
  // 9px frente a 10px, y la escala funde los dos en `t-micro`: dejar el
  // ternario escrito con la misma clase en las dos ramas hacía creer que
  // seguían midiendo distinto. La chapa "xs" se sigue distinguiendo por ir
  // más apretada, que es para lo que la usa la rejilla densa.
  const cls = size === "xs" ? "px-1.5 py-0.5" : "px-2 py-0.5";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border t-micro ${cls} ${style.bg} ${style.border} font-medium`}
      style={{ color: typeInk(style.ink) }}
    >
      <span className="leading-none">{style.emoji}</span>
      {type}
    </span>
  );
}

export function EnergyCost({ cost }: { cost: string[] }) {
  if (!cost || cost.length === 0) return <span className="ink-faint t-cuerpo-2">—</span>;
  return (
    <div className="flex gap-1 flex-wrap">
      {cost.map((c, i) => {
        const s = TYPE_STYLES[c] || TYPE_STYLES.Colorless;
        return (
          <span key={i} className={`w-5 h-5 rounded-full border ${s.bg} ${s.border} flex items-center justify-center t-micro`}>
            {s.emoji}
          </span>
        );
      })}
    </div>
  );
}
