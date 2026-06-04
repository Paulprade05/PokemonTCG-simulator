"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import { getSetsFromDB, getFullCollection } from "../../action";
import { getCardsFromSet } from "../../../services/pokemon";
import { getCollection } from "../../../utils/storage";
import PokemonCard from "../../../components/PokemonCard";
import AppHeader from "../../../components/AppHeader";
import BackgroundParticles from "../../../components/BackgroundParticles";
import Loader from "../../../components/Loader";

export default function SetAlbumPage() {
  const params = useParams();
  const setId = params.setId as string;

  const { isSignedIn, isLoaded } = useUser();

  const [setInfo, setSetInfo] = useState<any>(null);
  const [allSetCards, setAllSetCards] = useState<any[]>([]);
  const [ownedCards, setOwnedCards] = useState<Map<string, any>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchAlbumData() {
      if (!isLoaded) return;
      setLoading(true);
      try {
        const sets = await getSetsFromDB();
        const currentSet = sets.find((s: any) => s.id === setId);
        if (currentSet) setSetInfo(currentSet);

        const blueprintCards = await getCardsFromSet(setId);
        setAllSetCards(blueprintCards);

        let userCards = [];
        if (isSignedIn) userCards = await getFullCollection();
        else userCards = getCollection();

        const ownedMap = new Map();
        userCards.forEach((card: any) => {
          if (card.id.startsWith(setId + "-")) ownedMap.set(card.id, card);
        });
        setOwnedCards(ownedMap);
      } catch (error) {
        console.error("Error cargando el álbum:", error);
      } finally {
        setLoading(false);
      }
    }
    fetchAlbumData();
  }, [setId, isSignedIn, isLoaded]);

  if (loading) return <Loader label="Abriendo álbum" />;

  const total = setInfo?.total || allSetCards.length || 1;
  const owned = ownedCards.size;
  const percent = Math.round((owned / total) * 100);

  // Sort blueprint by numeric card number when possible
  const sortedCards = [...allSetCards].sort((a, b) => {
    const na = parseInt(String(a.number).replace(/\D/g, ""), 10) || 0;
    const nb = parseInt(String(b.number).replace(/\D/g, ""), 10) || 0;
    return na - nb;
  });

  return (
    <main className="flex min-h-screen flex-col items-center p-4 md:p-8 ink select-none overflow-hidden">

      <AppHeader
        back={{ href: "/collection" }}
        centerLogo={setInfo?.images?.logo}
        title={setInfo ? undefined : "Álbum"}
      />

      <div className="w-full max-w-7xl flex flex-col gap-6 pb-24 relative z-10">
        {/* PROGRESS */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="surface rounded-2xl p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4"
        >
          <div>
            <h2 className="text-lg font-semibold text-white">{setInfo?.name || "Expansión"}</h2>
            <p className="text-xs text-gray-500 mt-1">
              {owned} de {total} cartas coleccionadas
              {setInfo?.releaseDate && <span className="ml-2">· {setInfo.releaseDate}</span>}
            </p>
          </div>
          <div className="flex items-center gap-4 w-full md:w-auto">
            <div className="flex-1 md:w-64 h-2 bg-white/5 rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${percent}%` }}
                transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                className={percent === 100 ? "progress-bar h-full" : "progress-bar-blue h-full"}
              />
            </div>
            <span className="text-2xl font-semibold text-white tabular-nums">{percent}%</span>
          </div>
        </motion.div>

        {/* GRID 3x3 BLUEPRINT */}
        <div className="grid grid-cols-3 md:grid-cols-3 lg:grid-cols-3 gap-3 md:gap-5 max-w-4xl mx-auto w-full">
          {sortedCards.map((blueprintCard) => {
            const ownedCard = ownedCards.get(blueprintCard.id);

            if (ownedCard) {
              return (
                <div
                  key={blueprintCard.id}
                  className="relative group"
                >
                  {ownedCard.quantity > 1 && (
                    <div className="absolute -top-2 -right-2 z-30 bg-white text-black text-[10px] font-bold w-6 h-6 flex items-center justify-center rounded-full border border-white/20 shadow-lg">
                      {ownedCard.quantity}
                    </div>
                  )}
                  <div className="transition transform group-hover:-translate-y-1 duration-300">
                    <PokemonCard card={ownedCard} reveal={true} interactive={false} />
                  </div>
                </div>
              );
            }

            return (
              <div
                key={blueprintCard.id}
                className="w-full aspect-[2.5/3.5] bg-black/[0.03] border border-dashed border-black/15 rounded-2xl flex items-center justify-center hover:bg-black/[0.06] transition"
              >
                <span className="ink-soft font-mono text-lg md:text-2xl tabular-nums">
                  {String(blueprintCard.number).padStart(3, "0")}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}
