"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import TypeBadge, { EnergyCost } from "./TypeBadge";
import { SELL_PRICES } from "../utils/constanst";
import { getCardFromDB } from "../app/action";
import { getCardByIdApi } from "../services/pokemonApi";

interface CardDetailModalProps {
  card: any | null;
  onClose: () => void;
  readOnly?: boolean;
  onToggleFavorite?: () => void;
  onSellAll?: () => void;
  onNavigateToCard?: (cardId: string) => void;
}

export default function CardDetailModal({
  card,
  onClose,
  readOnly,
  onToggleFavorite,
  onSellAll,
  onNavigateToCard,
}: CardDetailModalProps) {
  const [enriched, setEnriched] = useState<any | null>(null);
  const [loadingEnrich, setLoadingEnrich] = useState(false);

  useEffect(() => {
    setEnriched(null);
    if (!card?.id) return;
    setLoadingEnrich(true);
    // 1) BD local rápido. 2) Si carece de rich data, completar via API.
    (async () => {
      const db: any = await getCardFromDB(card.id);
      const dbHasRich =
        db && (
          (db.legalities && Object.keys(db.legalities).length > 0) ||
          (db.abilities && db.abilities.length > 0) ||
          (db.rules && db.rules.length > 0) ||
          (db.cardmarket && Object.keys(db.cardmarket || {}).length > 0)
        );
      if (db && dbHasRich) {
        setEnriched(db);
      } else {
        const api = await getCardByIdApi(card.id);
        if (api && db) {
          // Merge BD + API → API completa lo vacío.
          const merged: any = { ...db };
          Object.keys(api).forEach((k) => {
            const cur = (merged as any)[k];
            const empty = cur == null ||
              (Array.isArray(cur) && cur.length === 0) ||
              (typeof cur === "object" && !Array.isArray(cur) && Object.keys(cur || {}).length === 0);
            if (empty) (merged as any)[k] = (api as any)[k];
          });
          setEnriched(merged);
        } else if (api) {
          setEnriched(api);
        } else if (db) {
          setEnriched(db);
        }
      }
      setLoadingEnrich(false);
    })();
  }, [card?.id]);

  const isEmpty = (v: any) =>
    v == null ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) ||
    v === "";

  const mergeCard = (local: any, api: any) => {
    if (!api) return local;
    // Local wins for ownership state (quantity, is_favorite); API fills any empty rich field.
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

  const getMarketPrice = () => SELL_PRICES[c?.rarity as keyof typeof SELL_PRICES] || 10;
  const getTcgPrice = (): number | null => {
    const p = c?.tcgplayer?.prices;
    if (!p) return null;
    if (p.holofoil?.market) return p.holofoil.market;
    if (p.holofoil?.mid) return p.holofoil.mid;
    if (p.normal?.market) return p.normal.market;
    if (p.normal?.mid) return p.normal.mid;
    if (p.reverseHolofoil?.market) return p.reverseHolofoil.market;
    const first = Object.keys(p)[0];
    return first ? p[first]?.market ?? p[first]?.mid ?? null : null;
  };
  const getCardmarketPrice = (): number | null => {
    const p = c?.cardmarket?.prices;
    if (!p) return null;
    return p.trendPrice ?? p.averageSellPrice ?? p.lowPrice ?? null;
  };

  const legalityColor = (v?: string) => {
    if (v === "Legal") return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
    if (v === "Banned") return "bg-rose-500/15 text-rose-300 border-rose-500/30";
    return "bg-white/5 text-gray-500 border-white/10";
  };

  return (
    <AnimatePresence>
      {c && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-xl p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.96, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="relative w-full max-w-5xl bg-[#0a0a0a] rounded-3xl overflow-y-auto border border-white/10 flex flex-col md:flex-row max-h-[90vh] custom-scrollbar"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={onClose}
              className="absolute top-4 right-4 w-9 h-9 flex items-center justify-center text-white z-50 bg-white/5 hover:bg-white/15 border border-white/10 rounded-full transition"
              aria-label="Cerrar"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>

            <div className="w-full md:w-[42%] p-6 md:p-8 pt-14 md:pt-8 bg-[#111] flex items-center justify-center relative">
              {readOnly ? (
                c.is_favorite && (
                  <div className="absolute top-4 left-4 z-50 w-10 h-10 rounded-full bg-rose-500/20 border border-rose-500/40 text-rose-400 flex items-center justify-center">
                    <Heart filled />
                  </div>
                )
              ) : (
                onToggleFavorite && (
                  <button
                    onClick={onToggleFavorite}
                    className={`absolute top-4 left-4 z-50 w-10 h-10 rounded-full border transition flex items-center justify-center ${
                      c.is_favorite
                        ? "bg-rose-500/20 border-rose-500/40 text-rose-400"
                        : "bg-white/5 border-white/10 text-gray-500 hover:text-white"
                    }`}
                    aria-label="Favorito"
                  >
                    <Heart filled={c.is_favorite} />
                  </button>
                )
              )}
              {c.regulationMark && (
                <span className="absolute top-4 right-4 z-40 w-7 h-7 rounded-full bg-white/10 border border-white/10 text-white text-xs font-mono flex items-center justify-center">
                  {c.regulationMark}
                </span>
              )}
              <img
                src={c.images?.large}
                alt={c.name}
                className="object-contain max-h-[40vh] md:max-h-[65vh] drop-shadow-2xl"
              />
            </div>

            <div className="w-full md:w-[58%] flex flex-col p-6 md:p-8 gap-4">
              {/* HEADER */}
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-gray-500 text-[10px] font-medium uppercase tracking-[0.2em]">
                    {c.supertype || "Pokémon"}
                  </p>
                  {c.subtypes?.length > 0 && (
                    <p className="text-gray-600 text-[10px]">· {c.subtypes.join(" · ")}</p>
                  )}
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-2xl md:text-3xl font-semibold text-white">{c.name}</h2>
                  {c.hp && <span className="text-rose-300 font-mono text-sm font-semibold">HP {c.hp}</span>}
                </div>
                {c.types?.length > 0 && (
                  <div className="flex gap-1.5 mt-2 flex-wrap">
                    {c.types.map((t: string) => <TypeBadge key={t} type={t} />)}
                  </div>
                )}
              </div>

              {/* PRICES + ACTIONS */}
              <div className="bg-white/5 border border-white/5 p-4 rounded-2xl flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-gray-500 text-[9px] font-medium uppercase tracking-wider">Venta</p>
                  <p className="text-xl font-semibold text-emerald-400 tabular-nums">{getMarketPrice()}💰</p>
                </div>
                {(() => {
                  const tcg = getTcgPrice();
                  return tcg != null ? (
                    <div>
                      <p className="text-gray-500 text-[9px] font-medium uppercase tracking-wider">TCGplayer</p>
                      <p className="text-sm font-semibold text-blue-300 tabular-nums">${tcg.toFixed(2)}</p>
                    </div>
                  ) : null;
                })()}
                {(() => {
                  const cm = getCardmarketPrice();
                  return cm != null ? (
                    <div>
                      <p className="text-gray-500 text-[9px] font-medium uppercase tracking-wider">Cardmarket</p>
                      <p className="text-sm font-semibold text-purple-300 tabular-nums">€{cm.toFixed(2)}</p>
                    </div>
                  ) : null;
                })()}
                {!readOnly && c.quantity > 1 && onSellAll && (
                  <button onClick={onSellAll} className="btn-primary px-4 py-2.5 rounded-xl font-medium text-xs">
                    Vender {c.quantity - 1}
                  </button>
                )}
                {readOnly && c.quantity != null && (
                  <span className="text-[10px] text-gray-500 uppercase tracking-wider">
                    {c.quantity > 1 ? `${c.quantity} copias` : "Única"}
                  </span>
                )}
              </div>

              {/* LEGALITIES */}
              {c.legalities && (
                <div className="flex gap-1.5 flex-wrap">
                  {(["standard", "expanded", "unlimited"] as const).map((fmt) => {
                    const v = c.legalities[fmt];
                    if (!v) return null;
                    return (
                      <span key={fmt} className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded-full border font-medium ${legalityColor(v)}`}>
                        {fmt} · {v}
                      </span>
                    );
                  })}
                </div>
              )}

              {/* EVOLUTION CHAIN */}
              {(c.evolvesFrom || c.evolvesTo?.length > 0) && (
                <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-3 flex items-center gap-2 text-xs flex-wrap">
                  <span className="text-gray-500 uppercase tracking-wider text-[9px]">Evolución:</span>
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
                <div className="bg-purple-500/5 border border-purple-500/15 rounded-2xl p-3">
                  <p className="text-purple-300 text-[10px] font-medium uppercase tracking-wider mb-2">Habilidades</p>
                  <div className="flex flex-col gap-2">
                    {c.abilities.map((ab: any, i: number) => (
                      <div key={i}>
                        <div className="flex items-baseline gap-2">
                          <span className="text-purple-200 text-[10px] uppercase tracking-wider">{ab.type}</span>
                          <span className="text-sm font-medium text-white">{ab.name}</span>
                        </div>
                        <p className="text-[11px] text-gray-400 mt-0.5 leading-snug">{ab.text}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ATTACKS */}
              {c.attacks?.length > 0 && (
                <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-3">
                  <p className="text-gray-500 text-[10px] font-medium uppercase tracking-wider mb-2">Ataques</p>
                  <div className="flex flex-col gap-3">
                    {c.attacks.map((atk: any, i: number) => (
                      <div key={i} className="flex gap-3 items-start">
                        <EnergyCost cost={atk.cost || []} />
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-baseline gap-2">
                            <span className="text-sm font-medium text-white truncate">{atk.name}</span>
                            {atk.damage && <span className="text-sm font-mono text-rose-300">{atk.damage}</span>}
                          </div>
                          {atk.text && <p className="text-[11px] text-gray-500 mt-0.5 leading-snug">{atk.text}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* WEAK / RES / RETREAT */}
              <div className="grid grid-cols-3 gap-2">
                <Card3 label="Debilidad">
                  {c.weaknesses?.length > 0
                    ? c.weaknesses.map((w: any, i: number) => (
                        <div key={i} className="flex items-center gap-1">
                          <TypeBadge type={w.type} size="xs" />
                          <span className="text-[10px] text-rose-300">{w.value}</span>
                        </div>
                      ))
                    : <span className="text-gray-600 text-xs">—</span>}
                </Card3>
                <Card3 label="Resistencia">
                  {c.resistances?.length > 0
                    ? c.resistances.map((w: any, i: number) => (
                        <div key={i} className="flex items-center gap-1">
                          <TypeBadge type={w.type} size="xs" />
                          <span className="text-[10px] text-emerald-300">{w.value}</span>
                        </div>
                      ))
                    : <span className="text-gray-600 text-xs">—</span>}
                </Card3>
                <Card3 label="Retirada">
                  <EnergyCost cost={c.retreatCost || []} />
                </Card3>
              </div>

              {/* ANCIENT TRAIT */}
              {c.ancientTrait && (
                <div className="bg-amber-500/5 border border-amber-500/15 rounded-2xl p-3">
                  <p className="text-amber-300 text-[10px] font-medium uppercase tracking-wider mb-1">Rasgo Antiguo · {c.ancientTrait.name}</p>
                  <p className="text-[11px] text-gray-400 leading-snug">{c.ancientTrait.text}</p>
                </div>
              )}

              {/* RULES */}
              {c.rules?.length > 0 && (
                <div className="bg-amber-500/5 border border-amber-500/15 rounded-2xl p-3">
                  <p className="text-amber-300 text-[10px] font-medium uppercase tracking-wider mb-2">Reglas</p>
                  <div className="flex flex-col gap-1">
                    {c.rules.map((r: string, i: number) => (
                      <p key={i} className="text-[11px] text-gray-400 leading-snug">· {r}</p>
                    ))}
                  </div>
                </div>
              )}

              {/* FLAVOR */}
              {c.flavorText && (
                <p className="text-[11px] text-gray-500 italic leading-snug border-l-2 border-white/10 pl-3">
                  "{c.flavorText}"
                </p>
              )}

              {/* META */}
              <div className="mt-auto pt-2 grid grid-cols-3 gap-2 text-[10px]">
                <div className="text-gray-500">
                  <span className="uppercase tracking-wider">Artista</span>
                  <p className="text-gray-300 mt-0.5 truncate">{c.artist || "—"}</p>
                </div>
                <div className="text-gray-500 text-center">
                  <span className="uppercase tracking-wider">Rareza</span>
                  <p className="text-gray-300 mt-0.5 truncate">{c.rarity || "—"}</p>
                </div>
                <div className="text-gray-500 text-right">
                  <span className="uppercase tracking-wider">Número</span>
                  <p className="text-gray-300 mt-0.5 font-mono">#{c.number || "—"}{c.set?.printedTotal ? `/${c.set.printedTotal}` : ""}</p>
                </div>
                {c.nationalPokedexNumbers?.length > 0 && (
                  <div className="text-gray-500 col-span-3">
                    <span className="uppercase tracking-wider">Pokédex Nacional</span>
                    <p className="text-gray-300 mt-0.5 font-mono">
                      {c.nationalPokedexNumbers.map((n: number) => `#${n}`).join(" · ")}
                    </p>
                  </div>
                )}
                {c.level && (
                  <div className="text-gray-500">
                    <span className="uppercase tracking-wider">Nivel</span>
                    <p className="text-gray-300 mt-0.5">{c.level}</p>
                  </div>
                )}
                {c.convertedRetreatCost != null && (
                  <div className="text-gray-500 text-center">
                    <span className="uppercase tracking-wider">Retirada conv.</span>
                    <p className="text-gray-300 mt-0.5 font-mono">{c.convertedRetreatCost}</p>
                  </div>
                )}
                {c.set?.ptcgoCode && (
                  <div className="text-gray-500 text-right">
                    <span className="uppercase tracking-wider">PTCGO</span>
                    <p className="text-gray-300 mt-0.5 font-mono">{c.set.ptcgoCode}</p>
                  </div>
                )}
              </div>

              {/* SET FOOTER */}
              {c.set && (
                <div className="border-t border-white/5 pt-3 mt-1 flex items-center gap-3">
                  {c.set.images?.symbol && (
                    <img src={c.set.images.symbol} alt="" className="w-6 h-6 object-contain opacity-80" />
                  )}
                  {c.set.images?.logo && (
                    <img src={c.set.images.logo} alt="" className="h-7 object-contain opacity-90" />
                  )}
                  <div className="flex-1 min-w-0 text-[10px] text-gray-500">
                    <p className="text-gray-300 truncate">{c.set.name}</p>
                    <p className="font-mono">
                      {c.set.series}
                      {c.set.releaseDate && ` · ${c.set.releaseDate}`}
                      {c.set.total && ` · ${c.set.total} cartas`}
                    </p>
                  </div>
                </div>
              )}

              {/* TCGplayer external links */}
              {(c.tcgplayer?.url || c.cardmarket?.url) && (
                <div className="flex gap-2 text-[10px]">
                  {c.tcgplayer?.url && (
                    <a href={c.tcgplayer.url} target="_blank" rel="noreferrer"
                       className="flex-1 bg-white/5 hover:bg-white/10 border border-white/5 px-3 py-2 rounded-xl text-center text-blue-300 transition">
                      Ver en TCGplayer
                    </a>
                  )}
                  {c.cardmarket?.url && (
                    <a href={c.cardmarket.url} target="_blank" rel="noreferrer"
                       className="flex-1 bg-white/5 hover:bg-white/10 border border-white/5 px-3 py-2 rounded-xl text-center text-purple-300 transition">
                      Ver en Cardmarket
                    </a>
                  )}
                </div>
              )}

              {loadingEnrich && (
                <p className="text-[9px] text-gray-600 uppercase tracking-wider animate-pulse">Cargando detalles…</p>
              )}
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

function Card3({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-white/5 border border-white/5 p-3 rounded-xl">
      <p className="text-gray-500 text-[9px] font-medium uppercase tracking-wider mb-1">{label}</p>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}
