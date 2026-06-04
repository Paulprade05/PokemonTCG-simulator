"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import TypeBadge, { EnergyCost } from "./TypeBadge";
import { SELL_PRICES } from "../utils/constanst";
import { getCardFromDB, toggleWishlist, getWishlistIds } from "../app/action";

interface CardDetailModalProps {
  card: any | null;
  onClose: () => void;
  readOnly?: boolean;
  onToggleFavorite?: () => void;
  onSellAll?: () => void;
  onNavigateToCard?: (cardId: string) => void;
}

// Halo / acento por rareza
const RARITY_AURA: Record<string, { halo: string; chip: string }> = {
  "Hyper Rare":               { halo: "rgba(250,204,21,0.55)",  chip: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30" },
  "Rare Secret":              { halo: "rgba(250,204,21,0.45)",  chip: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30" },
  "Rare Rainbow":             { halo: "rgba(244,114,182,0.55)", chip: "bg-pink-500/20 text-pink-300 border-pink-500/30" },
  "Special Illustration Rare":{ halo: "rgba(217,70,239,0.5)",   chip: "bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30" },
  "Illustration Rare":        { halo: "rgba(168,85,247,0.45)",  chip: "bg-purple-500/20 text-purple-300 border-purple-500/30" },
  "Shiny Ultra Rare":         { halo: "rgba(56,189,248,0.5)",   chip: "bg-sky-500/20 text-sky-300 border-sky-500/30" },
  "Ultra Rare":               { halo: "rgba(99,102,241,0.5)",   chip: "bg-indigo-500/20 text-indigo-300 border-indigo-500/30" },
  "Rare Ultra":               { halo: "rgba(99,102,241,0.5)",   chip: "bg-indigo-500/20 text-indigo-300 border-indigo-500/30" },
  "Rare Holo VSTAR":          { halo: "rgba(34,211,238,0.5)",   chip: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30" },
  "Rare Holo VMAX":           { halo: "rgba(244,63,94,0.5)",    chip: "bg-rose-500/20 text-rose-300 border-rose-500/30" },
  "Double Rare":              { halo: "rgba(96,165,250,0.4)",   chip: "bg-blue-500/20 text-blue-300 border-blue-500/30" },
  "Rare Holo V":              { halo: "rgba(96,165,250,0.4)",   chip: "bg-blue-500/20 text-blue-300 border-blue-500/30" },
  "Rare Holo":                { halo: "rgba(250,204,21,0.3)",   chip: "bg-yellow-500/15 text-yellow-300 border-yellow-500/25" },
  "Radiant Rare":             { halo: "rgba(251,146,60,0.4)",   chip: "bg-orange-500/20 text-orange-300 border-orange-500/30" },
};
const auraFor = (rarity?: string) => (rarity && RARITY_AURA[rarity]) || null;

export default function CardDetailModal({
  card,
  onClose,
  readOnly,
  onToggleFavorite,
  onSellAll,
}: CardDetailModalProps) {
  const { isSignedIn } = useUser();
  const [enriched, setEnriched] = useState<any | null>(null);
  const [loadingEnrich, setLoadingEnrich] = useState(false);
  const [wishlisted, setWishlisted] = useState(false);

  useEffect(() => {
    if (!card?.id || !isSignedIn) return;
    getWishlistIds().then((ids: string[]) => setWishlisted(ids.includes(card.id)));
  }, [card?.id, isSignedIn]);

  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [card, onClose]);

  const handleToggleWishlist = async () => {
    if (!card?.id) return;
    const prev = wishlisted;
    setWishlisted(!prev);
    const res: any = await toggleWishlist(card.id);
    if (res?.error) { setWishlisted(prev); alert(res.error); }
    else if (typeof res?.wishlisted === "boolean") setWishlisted(res.wishlisted);
  };

  useEffect(() => {
    setEnriched(null);
    if (!card?.id) return;
    setLoadingEnrich(true);
    getCardFromDB(card.id)
      .then((db) => { if (db) setEnriched(db); })
      .finally(() => setLoadingEnrich(false));
  }, [card?.id]);

  const isEmpty = (v: any) =>
    v == null ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) ||
    v === "";

  const mergeCard = (local: any, api: any) => {
    if (!api) return local;
    const out: any = { ...api, ...local };
    const richKeys = [
      "attacks", "weaknesses", "resistances", "retreatCost", "convertedRetreatCost",
      "types", "subtypes", "abilities", "rules", "ancientTrait",
      "legalities", "regulationMark", "cardmarket", "tcgplayer",
      "evolvesFrom", "evolvesTo", "nationalPokedexNumbers",
      "flavorText", "hp", "supertype", "level", "artist", "rarity", "number", "set", "images",
    ];
    richKeys.forEach((k) => {
      if (isEmpty(out[k]) && !isEmpty(api[k])) out[k] = api[k];
    });
    return out;
  };

  const c = card ? mergeCard(card, enriched) : null;
  const aura = auraFor(c?.rarity);

  const getMarketPrice = () => SELL_PRICES[c?.rarity as keyof typeof SELL_PRICES] || 10;
  const getTcgPrice = (): number | null => {
    const p = c?.tcgplayer?.prices;
    if (!p) return null;
    return p.holofoil?.market ?? p.holofoil?.mid ?? p.normal?.market ?? p.normal?.mid ?? p.reverseHolofoil?.market ?? p.reverseHolofoil?.mid
      ?? (Object.keys(p)[0] ? (p[Object.keys(p)[0]].market ?? p[Object.keys(p)[0]].mid) : null);
  };
  const getCardmarketPrice = (): number | null => {
    const p = c?.cardmarket?.prices;
    return p?.trendPrice ?? p?.averageSellPrice ?? p?.lowPrice ?? null;
  };

  const legalityColor = (v?: string) => {
    if (v === "Legal") return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
    if (v === "Banned") return "bg-rose-500/15 text-rose-300 border-rose-500/30";
    return "bg-white/5 text-gray-400 border-white/10";
  };

  return (
    <AnimatePresence>
      {c && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-md p-3 md:p-6"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.97, opacity: 0, y: 8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.97, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="relative w-full max-w-5xl bg-[#0a0a0e] rounded-3xl overflow-hidden border border-white/10 shadow-2xl flex flex-col md:flex-row max-h-[92vh]"
            data-lenis-prevent
            onClick={(e) => e.stopPropagation()}
          >
            {/* Ambient glow per rarity */}
            {aura && (
              <div
                className="absolute -top-32 -right-32 w-80 h-80 rounded-full pointer-events-none opacity-60 blur-3xl"
                style={{ background: `radial-gradient(circle, ${aura.halo}, transparent 70%)` }}
              />
            )}

            {/* CLOSE */}
            <button
              onClick={onClose}
              className="absolute top-3 right-3 md:top-4 md:right-4 w-9 h-9 flex items-center justify-center z-50 bg-white/5 hover:bg-white/15 border border-white/10 rounded-full transition press"
              aria-label="Cerrar"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-white">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>

            {/* LEFT — CARD IMAGE PANEL */}
            <div
              className="relative w-full md:w-[44%] p-5 md:p-8 pt-14 md:pt-10 flex items-center justify-center"
              style={{
                background: aura
                  ? `radial-gradient(circle at 50% 35%, ${aura.halo.replace(/[\d.]+\)$/, "0.18)")}, transparent 70%), #0e0d14`
                  : "#0e0d14",
              }}
            >
              {/* Floating action buttons */}
              <div className="absolute top-4 left-4 z-40 flex flex-col gap-2">
                {!readOnly && onToggleFavorite && (
                  <button
                    onClick={onToggleFavorite}
                    className={`w-10 h-10 rounded-full border transition flex items-center justify-center press ${
                      c.is_favorite
                        ? "bg-rose-500/25 border-rose-500/50 text-rose-300"
                        : "bg-white/5 border-white/10 text-gray-500 hover:text-white"
                    }`}
                    aria-label="Favorito"
                  >
                    <Heart filled={c.is_favorite} />
                  </button>
                )}
                {readOnly && c.is_favorite && (
                  <div className="w-10 h-10 rounded-full bg-rose-500/25 border border-rose-500/50 text-rose-300 flex items-center justify-center">
                    <Heart filled />
                  </div>
                )}
                {isSignedIn && (
                  <button
                    onClick={handleToggleWishlist}
                    className={`w-10 h-10 rounded-full border transition flex items-center justify-center press ${
                      wishlisted
                        ? "bg-pink-500/25 border-pink-500/50 text-pink-300"
                        : "bg-white/5 border-white/10 text-gray-500 hover:text-white"
                    }`}
                    aria-label="Deseos"
                    title={wishlisted ? "Quitar de deseos" : "Añadir a deseos"}
                  >
                    <svg viewBox="0 0 24 24" fill={wishlisted ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Regulation mark */}
              {c.regulationMark && (
                <span className="absolute top-4 right-4 z-40 w-7 h-7 rounded-full bg-white/10 border border-white/15 text-white text-xs font-mono flex items-center justify-center">
                  {c.regulationMark}
                </span>
              )}

              {/* Card image with halo */}
              <div className="relative">
                {aura && (
                  <div
                    className="absolute inset-0 -m-6 rounded-3xl blur-2xl opacity-70 pointer-events-none"
                    style={{ background: `radial-gradient(circle, ${aura.halo}, transparent 75%)` }}
                  />
                )}
                <motion.img
                  initial={{ scale: 0.96, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                  src={c.images?.large}
                  alt={c.name}
                  loading="eager"
                  className={`relative object-contain max-h-[40vh] md:max-h-[68vh] drop-shadow-[0_25px_50px_rgba(0,0,0,0.6)] ${c.owned === false ? "grayscale opacity-70" : ""}`}
                />
              </div>
            </div>

            {/* RIGHT — DETAILS */}
            <div className="w-full md:w-[56%] flex flex-col bg-[#0a0a0e] overflow-y-auto custom-scrollbar relative" data-lenis-prevent>
              <div className="p-5 md:p-7 flex flex-col gap-4 relative">
                {/* HEADER */}
                <div>
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-[10px] uppercase tracking-[0.25em] text-gray-500 font-semibold">{c.supertype || "Pokémon"}</span>
                    {c.subtypes?.slice(0, 3).map((s: string) => (
                      <span key={s} className="text-[10px] uppercase tracking-wider text-gray-400 chip px-2 py-0.5 border border-white/5">{s}</span>
                    ))}
                    {c.rarity && aura && (
                      <span className={`text-[10px] uppercase tracking-wider font-semibold border rounded-full px-2 py-0.5 ${aura.chip}`}>
                        {c.rarity}
                      </span>
                    )}
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="text-2xl md:text-4xl font-bold text-white tracking-tight">{c.name}</h2>
                    {c.hp && (
                      <span className="text-rose-300 font-mono text-base md:text-lg font-bold shrink-0">HP {c.hp}</span>
                    )}
                  </div>
                  {c.types?.length > 0 && (
                    <div className="flex gap-1.5 mt-3 flex-wrap">
                      {c.types.map((t: string) => <TypeBadge key={t} type={t} />)}
                    </div>
                  )}
                </div>

                {/* PRICES */}
                <div className="grid grid-cols-3 gap-2">
                  <PriceTile label="Venta" value={`${getMarketPrice()}`} unit="💰" accent="text-emerald-400" />
                  {(() => {
                    const tcg = getTcgPrice();
                    return tcg != null
                      ? <PriceTile label="TCGplayer" value={`$${tcg.toFixed(2)}`} accent="text-blue-300" />
                      : <PriceTile label="TCGplayer" value="—" accent="text-gray-500" />;
                  })()}
                  {(() => {
                    const cm = getCardmarketPrice();
                    return cm != null
                      ? <PriceTile label="Cardmarket" value={`€${cm.toFixed(2)}`} accent="text-purple-300" />
                      : <PriceTile label="Cardmarket" value="—" accent="text-gray-500" />;
                  })()}
                </div>

                {/* SELL CTA */}
                {!readOnly && c.quantity > 1 && onSellAll && (
                  <button
                    onClick={onSellAll}
                    className="btn-accent press w-full py-3 rounded-2xl font-semibold text-sm"
                  >
                    Vender {c.quantity - 1} repetida{c.quantity - 1 > 1 ? "s" : ""} · +{(c.quantity - 1) * getMarketPrice()} 💰
                  </button>
                )}
                {readOnly && c.quantity != null && (
                  <div className="text-center text-[11px] uppercase tracking-wider text-gray-500">
                    {c.quantity > 1 ? `Posee ${c.quantity} copias` : "Copia única"}
                  </div>
                )}

                {/* LEGALITIES */}
                {c.legalities && (
                  <div className="flex gap-1.5 flex-wrap">
                    {(["standard", "expanded", "unlimited"] as const).map((fmt) => {
                      const v = c.legalities[fmt];
                      if (!v) return null;
                      return (
                        <span key={fmt} className={`text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-full border font-semibold ${legalityColor(v)}`}>
                          {fmt} · {v}
                        </span>
                      );
                    })}
                  </div>
                )}

                {/* EVOLUTION */}
                {(c.evolvesFrom || c.evolvesTo?.length > 0) && (
                  <div className="bg-white/[0.03] border border-white/5 rounded-2xl p-3 flex items-center gap-2 text-xs flex-wrap">
                    <span className="text-gray-500 uppercase tracking-wider text-[9px] font-semibold mr-1">Evolución</span>
                    {c.evolvesFrom && (
                      <>
                        <span className="text-gray-300">{c.evolvesFrom}</span>
                        <Arrow />
                      </>
                    )}
                    <span className="text-white font-semibold">{c.name}</span>
                    {c.evolvesTo?.map((next: string, i: number) => (
                      <span key={i} className="flex items-center gap-2">
                        <Arrow />
                        <span className="text-gray-300">{next}</span>
                      </span>
                    ))}
                  </div>
                )}

                {/* ABILITIES */}
                {c.abilities?.length > 0 && (
                  <div className="bg-gradient-to-br from-purple-500/10 to-transparent border border-purple-500/20 rounded-2xl p-4">
                    <p className="text-purple-300 text-[10px] font-semibold uppercase tracking-wider mb-3 flex items-center gap-2">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                        <path d="M12 2 4 6v6c0 5 3.5 9 8 10 4.5-1 8-5 8-10V6l-8-4z" />
                      </svg>
                      Habilidades
                    </p>
                    <div className="flex flex-col gap-3">
                      {c.abilities.map((ab: any, i: number) => (
                        <div key={i}>
                          <div className="flex items-baseline gap-2 mb-1">
                            <span className="text-purple-200 text-[10px] uppercase tracking-wider chip px-1.5 py-0.5">{ab.type}</span>
                            <span className="text-sm font-semibold text-white">{ab.name}</span>
                          </div>
                          <p className="text-[12px] text-gray-300 leading-relaxed">{ab.text}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ATTACKS */}
                {c.attacks?.length > 0 && (
                  <div className="bg-white/[0.03] border border-white/5 rounded-2xl overflow-hidden">
                    <p className="text-gray-500 text-[10px] font-semibold uppercase tracking-wider px-4 pt-3">Ataques</p>
                    <div className="flex flex-col divide-y divide-white/5">
                      {c.attacks.map((atk: any, i: number) => (
                        <div key={i} className="p-4 flex flex-col gap-2">
                          <div className="flex items-center gap-3">
                            <div className="shrink-0">
                              <EnergyCost cost={atk.cost || []} />
                            </div>
                            <span className="text-sm font-semibold text-white truncate flex-1">{atk.name}</span>
                            {atk.damage && <span className="text-base font-mono font-bold text-rose-300 shrink-0">{atk.damage}</span>}
                          </div>
                          {atk.text && <p className="text-[12px] text-gray-400 leading-snug">{atk.text}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* WEAK / RES / RETREAT */}
                <div className="grid grid-cols-3 gap-2">
                  <StatTile label="Debilidad">
                    {c.weaknesses?.length > 0
                      ? c.weaknesses.map((w: any, i: number) => (
                          <div key={i} className="flex items-center gap-1">
                            <TypeBadge type={w.type} size="xs" />
                            <span className="text-[11px] text-rose-300 font-semibold">{w.value}</span>
                          </div>
                        ))
                      : <span className="text-gray-600 text-xs">—</span>}
                  </StatTile>
                  <StatTile label="Resistencia">
                    {c.resistances?.length > 0
                      ? c.resistances.map((w: any, i: number) => (
                          <div key={i} className="flex items-center gap-1">
                            <TypeBadge type={w.type} size="xs" />
                            <span className="text-[11px] text-emerald-300 font-semibold">{w.value}</span>
                          </div>
                        ))
                      : <span className="text-gray-600 text-xs">—</span>}
                  </StatTile>
                  <StatTile label="Retirada">
                    {c.retreatCost?.length > 0
                      ? <EnergyCost cost={c.retreatCost} />
                      : <span className="text-gray-600 text-xs">—</span>}
                  </StatTile>
                </div>

                {/* ANCIENT TRAIT */}
                {c.ancientTrait && (
                  <div className="bg-amber-500/10 border border-amber-500/25 rounded-2xl p-3">
                    <p className="text-amber-300 text-[10px] font-semibold uppercase tracking-wider mb-1">Rasgo Antiguo · {c.ancientTrait.name}</p>
                    <p className="text-[12px] text-gray-300 leading-snug">{c.ancientTrait.text}</p>
                  </div>
                )}

                {/* RULES */}
                {c.rules?.length > 0 && (
                  <div className="bg-amber-500/10 border border-amber-500/25 rounded-2xl p-3">
                    <p className="text-amber-300 text-[10px] font-semibold uppercase tracking-wider mb-2">Reglas</p>
                    {c.rules.map((r: string, i: number) => (
                      <p key={i} className="text-[12px] text-gray-300 leading-snug mb-1 last:mb-0">· {r}</p>
                    ))}
                  </div>
                )}

                {/* FLAVOR */}
                {c.flavorText && (
                  <p className="text-[12px] text-gray-400 italic leading-relaxed border-l-2 border-white/10 pl-3">
                    "{c.flavorText}"
                  </p>
                )}

                {/* META */}
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2 pt-2">
                  <Meta label="Artista" value={c.artist || "—"} />
                  <Meta label="Número" value={`#${c.number || "—"}${c.set?.printedTotal ? `/${c.set.printedTotal}` : ""}`} />
                  {c.set?.ptcgoCode && <Meta label="PTCGO" value={c.set.ptcgoCode} />}
                  {c.nationalPokedexNumbers?.length > 0 && (
                    <Meta className="col-span-2 md:col-span-3" label="Pokédex Nacional" value={c.nationalPokedexNumbers.map((n: number) => `#${n}`).join(" · ")} />
                  )}
                </div>

                {/* SET FOOTER */}
                {c.set && (
                  <div className="border-t border-white/5 pt-4 mt-1 flex items-center gap-3">
                    {c.set.images?.symbol && (
                      <img src={c.set.images.symbol} alt="" loading="lazy" className="w-7 h-7 object-contain opacity-80" />
                    )}
                    {c.set.images?.logo && (
                      <img src={c.set.images.logo} alt="" loading="lazy" className="h-8 object-contain opacity-90" />
                    )}
                    <div className="flex-1 min-w-0 text-[11px]">
                      <p className="text-white font-medium truncate">{c.set.name}</p>
                      <p className="text-gray-500 font-mono">
                        {c.set.series}
                        {c.set.releaseDate && ` · ${c.set.releaseDate}`}
                        {c.set.total && ` · ${c.set.total} cartas`}
                      </p>
                    </div>
                  </div>
                )}

                {/* EXTERNAL */}
                {(c.tcgplayer?.url || c.cardmarket?.url) && (
                  <div className="flex gap-2 text-[11px]">
                    {c.tcgplayer?.url && (
                      <a href={c.tcgplayer.url} target="_blank" rel="noreferrer"
                         className="flex-1 bg-white/5 hover:bg-white/10 border border-white/5 px-3 py-2.5 rounded-xl text-center text-blue-300 transition press font-medium">
                        TCGplayer ↗
                      </a>
                    )}
                    {c.cardmarket?.url && (
                      <a href={c.cardmarket.url} target="_blank" rel="noreferrer"
                         className="flex-1 bg-white/5 hover:bg-white/10 border border-white/5 px-3 py-2.5 rounded-xl text-center text-purple-300 transition press font-medium">
                        Cardmarket ↗
                      </a>
                    )}
                  </div>
                )}

                {loadingEnrich && (
                  <p className="text-[9px] text-gray-600 uppercase tracking-wider animate-pulse text-center">Cargando detalles…</p>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Heart({ filled }: { filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" className="w-4 h-4">
      <path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 5.5 5.5 5.5 0 0 1 21.5 12c-2.5 4.5-9.5 9-9.5 9z" />
    </svg>
  );
}

function Arrow() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3 text-gray-600">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function PriceTile({ label, value, unit, accent }: { label: string; value: string; unit?: string; accent: string }) {
  return (
    <div className="bg-white/[0.04] border border-white/5 rounded-2xl px-3 py-2.5">
      <p className="text-[9px] uppercase tracking-wider text-gray-500 font-semibold">{label}</p>
      <p className={`text-base md:text-lg font-bold ${accent} tabular-nums leading-tight mt-0.5`}>
        {value}{unit && <span className="text-xs ml-1">{unit}</span>}
      </p>
    </div>
  );
}

function StatTile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-white/[0.04] border border-white/5 rounded-2xl p-3">
      <p className="text-[9px] uppercase tracking-wider text-gray-500 font-semibold mb-1.5">{label}</p>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

function Meta({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return (
    <div className={className}>
      <p className="text-[9px] uppercase tracking-wider text-gray-500 font-semibold">{label}</p>
      <p className="text-[12px] text-gray-300 mt-0.5 truncate">{value}</p>
    </div>
  );
}
