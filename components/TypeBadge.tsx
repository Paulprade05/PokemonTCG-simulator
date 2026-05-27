"use client";

const TYPE_STYLES: Record<string, { bg: string; text: string; border: string; emoji: string }> = {
  Grass:     { bg: "bg-emerald-500/15", text: "text-emerald-300", border: "border-emerald-500/30", emoji: "🌿" },
  Fire:      { bg: "bg-orange-500/15",  text: "text-orange-300",  border: "border-orange-500/30",  emoji: "🔥" },
  Water:     { bg: "bg-blue-500/15",    text: "text-blue-300",    border: "border-blue-500/30",    emoji: "💧" },
  Lightning: { bg: "bg-yellow-500/15",  text: "text-yellow-300",  border: "border-yellow-500/30",  emoji: "⚡" },
  Psychic:   { bg: "bg-purple-500/15",  text: "text-purple-300",  border: "border-purple-500/30",  emoji: "🔮" },
  Fighting:  { bg: "bg-red-700/15",     text: "text-red-300",     border: "border-red-700/30",     emoji: "👊" },
  Darkness:  { bg: "bg-zinc-700/30",    text: "text-zinc-300",    border: "border-zinc-600/40",    emoji: "🌑" },
  Metal:     { bg: "bg-slate-500/15",   text: "text-slate-300",   border: "border-slate-500/30",   emoji: "⚙️" },
  Fairy:     { bg: "bg-pink-500/15",    text: "text-pink-300",    border: "border-pink-500/30",    emoji: "✨" },
  Dragon:    { bg: "bg-amber-500/15",   text: "text-amber-300",   border: "border-amber-500/30",   emoji: "🐉" },
  Colorless: { bg: "bg-gray-500/15",    text: "text-gray-300",    border: "border-gray-500/30",    emoji: "⚪" },
};

export default function TypeBadge({ type, size = "sm" }: { type: string; size?: "xs" | "sm" }) {
  const style = TYPE_STYLES[type] || TYPE_STYLES.Colorless;
  const cls = size === "xs" ? "text-[9px] px-1.5 py-0.5" : "text-[10px] px-2 py-0.5";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border ${cls} ${style.bg} ${style.text} ${style.border} font-medium`}>
      <span className="leading-none">{style.emoji}</span>
      {type}
    </span>
  );
}

export function EnergyCost({ cost }: { cost: string[] }) {
  if (!cost || cost.length === 0) return <span className="text-gray-600 text-xs">—</span>;
  return (
    <div className="flex gap-1 flex-wrap">
      {cost.map((c, i) => {
        const s = TYPE_STYLES[c] || TYPE_STYLES.Colorless;
        return (
          <span key={i} className={`w-5 h-5 rounded-full border ${s.bg} ${s.border} flex items-center justify-center text-[10px]`}>
            {s.emoji}
          </span>
        );
      })}
    </div>
  );
}
