"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { AnimatePresence, motion } from "framer-motion";
import {
  getFriendsList, sendFriendRequest, acceptFriendRequest, removeFriend,
  syncUserName, getPendingTrades, acceptTrade, rejectTrade, sendTradeRequest,
  getFullCollection, getTrainerCollection,
  getCompletedTrades, markTradeAsRead,
} from "../action";
import AppHeader from "../../components/AppHeader";
import BackgroundParticles from "../../components/BackgroundParticles";
import Loader from "../../components/Loader";

export default function FriendsPage() {
  const { user, isLoaded, isSignedIn } = useUser();
  const [friends, setFriends] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [tradeRequests, setTradeRequests] = useState<any[]>([]);
  const [completedTrades, setCompletedTrades] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [friendIdInput, setFriendIdInput] = useState("");
  const [expandedFriendId, setExpandedFriendId] = useState<string | null>(null);

  const [tradeModalFriend, setTradeModalFriend] = useState<any | null>(null);
  const [myCards, setMyCards] = useState<any[]>([]);
  const [friendCards, setFriendCards] = useState<any[]>([]);
  const [selectedMyCard, setSelectedMyCard] = useState<any | null>(null);
  const [selectedFriendCard, setSelectedFriendCard] = useState<any | null>(null);
  const [isSendingTrade, setIsSendingTrade] = useState(false);

  const loadData = async () => {
    if (!isSignedIn) return;
    setLoading(true);
    await syncUserName();
    const [friendsData, tradesData, completedData] = await Promise.all([
      getFriendsList(), getPendingTrades(), getCompletedTrades(),
    ]);
    setFriends(friendsData.accepted);
    setRequests(friendsData.pendingRequests);
    setTradeRequests(tradesData);
    setCompletedTrades(completedData);
    setLoading(false);
  };

  useEffect(() => { if (isLoaded) loadData(); }, [isLoaded, isSignedIn]);

  // Bloquear scroll del fondo con el modal de intercambio abierto
  useEffect(() => {
    if (!tradeModalFriend) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [tradeModalFriend]);

  const handleAddFriend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!friendIdInput.trim()) return;
    const res = await sendFriendRequest(friendIdInput.trim());
    if (res.error) alert(res.error);
    else { alert("Petición enviada"); setFriendIdInput(""); }
  };

  const handleAcceptFriend = async (id: any) => { await acceptFriendRequest(id); loadData(); };
  const handleRemoveFriend = async (id: any) => {
    if (!confirm("¿Eliminar este amigo o petición?")) return;
    await removeFriend(id); loadData();
  };
  const toggleExpand = (id: string) => setExpandedFriendId(expandedFriendId === id ? null : id);

  const handleOpenTradeModal = async (friend: any) => {
    setTradeModalFriend(friend);
    setSelectedMyCard(null);
    setSelectedFriendCard(null);
    const [mine, theirs] = await Promise.all([
      getFullCollection(), getTrainerCollection(friend.friend_id),
    ]);
    const sortCards = (cards: any[]) =>
      cards.filter((c) => c.quantity > 0).sort((a, b) => {
        if (a.quantity > 1 && b.quantity === 1) return -1;
        if (a.quantity === 1 && b.quantity > 1) return 1;
        if (b.quantity !== a.quantity) return b.quantity - a.quantity;
        return a.name.localeCompare(b.name);
      });
    setMyCards(sortCards(mine));
    setFriendCards(sortCards(theirs));
  };

  const submitTradeOffer = async () => {
    if (!selectedMyCard || !selectedFriendCard) return;
    setIsSendingTrade(true);
    const res = await sendTradeRequest(tradeModalFriend.friend_id, selectedMyCard.id, selectedFriendCard.id);
    setIsSendingTrade(false);
    if (res.error) alert(res.error);
    else { alert("Oferta enviada"); setTradeModalFriend(null); }
  };

  const handleAcceptTrade = async (tradeId: number) => {
    if (!confirm("¿Aceptar este intercambio?")) return;
    const res = await acceptTrade(tradeId);
    if (res.error) alert(res.error);
    else { alert("Intercambio completado"); loadData(); }
  };
  const handleRejectTrade = async (tradeId: number) => { await rejectTrade(tradeId); loadData(); };
  const handleCounterOffer = async (trade: any) => {
    await rejectTrade(trade.trade_id);
    const friendData = friends.find((f) => f.friend_id === trade.sender_id);
    if (friendData) handleOpenTradeModal(friendData);
    else alert("Este usuario ya no está en tu lista.");
  };
  const handleDismissTrade = async (tradeId: number) => {
    await markTradeAsRead(tradeId);
    setCompletedTrades((prev) => prev.filter((t) => t.trade_id !== tradeId));
  };

  if (!isLoaded || loading) return <Loader label="Red de entrenadores" />;
  if (!isSignedIn) {
    return (
      <main className="min-h-screen text-zinc-800 flex flex-col items-center justify-center p-8 text-center">
        <h2 className="text-xl font-semibold mb-4">Inicia sesión para ver amigos</h2>
        <Link href="/" className="btn-primary px-6 py-2.5 rounded-xl font-medium text-sm">Volver</Link>
      </main>
    );
  }

  const RankBadge = ({ index }: { index: number }) => {
    if (index > 2) return null;
    const styles = [
      "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
      "bg-gray-300/10 text-gray-200 border-gray-300/20",
      "bg-orange-500/15 text-orange-300 border-orange-500/30",
    ];
    return (
      <span className={`absolute top-3 right-3 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${styles[index]}`}>
        #{index + 1}
      </span>
    );
  };

  return (
    <main className="flex min-h-screen flex-col items-center p-4 md:p-8 text-zinc-800 select-none overflow-hidden">
      <BackgroundParticles />

      <AppHeader back={{ href: "/" }} title="Amigos" showFriendsLink={false} />

      <div className="w-full max-w-6xl flex flex-col gap-6 pb-24 relative z-10">
        {/* COMPLETED TRADE NOTIFICATIONS */}
        <AnimatePresence>
          {completedTrades.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="surface rounded-2xl p-5 border border-emerald-500/20"
            >
              <h3 className="text-emerald-400 font-medium text-sm mb-4 flex items-center gap-2 uppercase tracking-wider">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                Actualizaciones de ofertas
              </h3>
              <div className="flex flex-col gap-2">
                {completedTrades.map((trade) => (
                  <div key={trade.trade_id} className="bg-white/5 border border-white/5 p-4 rounded-xl flex flex-col sm:flex-row justify-between items-center gap-3">
                    <div className="flex-1 text-sm text-gray-300">
                      {trade.status === "accepted" && <p><strong className="text-white">{trade.receiver_name}</strong> aceptó. Recibiste <strong>{trade.receiver_card_name}</strong> por tu {trade.sender_card_name}.</p>}
                      {trade.status === "rejected" && <p><strong className="text-white">{trade.receiver_name}</strong> rechazó tu oferta por {trade.receiver_card_name}.</p>}
                      {trade.status === "failed" && <p>Intercambio con <strong className="text-white">{trade.receiver_name}</strong> falló (cartas vendidas).</p>}
                    </div>
                    <button onClick={() => handleDismissTrade(trade.trade_id)} className="btn-ghost text-white px-4 py-2 rounded-xl text-xs font-medium">Entendido</button>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* PENDING TRADE REQUESTS */}
        {tradeRequests.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="surface rounded-2xl p-5 border border-purple-500/20"
          >
            <h3 className="text-purple-300 font-medium text-sm mb-4 flex items-center gap-2 uppercase tracking-wider">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                <path d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3" />
              </svg>
              Ofertas recibidas · {tradeRequests.length}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {tradeRequests.map((trade) => (
                <div key={trade.trade_id} className="bg-white/5 border border-white/5 p-4 rounded-xl flex flex-col">
                  <p className="text-xs text-gray-400 mb-3"><strong className="text-white">{trade.sender_name}</strong> propone:</p>
                  <div className="flex justify-between items-center bg-black/30 p-3 rounded-xl mb-4">
                    <div className="text-center w-1/3">
                      <p className="text-[9px] text-gray-500 font-medium mb-2 uppercase tracking-wider">Recibes</p>
                      <img src={trade.sender_card_image?.small} alt="" className="w-16 h-auto mx-auto rounded-md" />
                      <p className="text-[10px] text-emerald-400 font-medium mt-2 truncate">{trade.sender_card_name}</p>
                    </div>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5 text-gray-600">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                    <div className="text-center w-1/3">
                      <p className="text-[9px] text-gray-500 font-medium mb-2 uppercase tracking-wider">Entregas</p>
                      <img src={trade.receiver_card_image?.small} alt="" className="w-16 h-auto mx-auto rounded-md opacity-80" />
                      <p className="text-[10px] text-rose-400 font-medium mt-2 truncate">{trade.receiver_card_name}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-auto">
                    <button onClick={() => handleAcceptTrade(trade.trade_id)} className="flex-1 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 text-emerald-300 text-xs font-medium py-2 rounded-xl transition">Aceptar</button>
                    <button onClick={() => handleCounterOffer(trade)} className="flex-1 bg-white/5 hover:bg-white/10 border border-white/10 text-white text-xs font-medium py-2 rounded-xl transition">Contraoferta</button>
                    <button onClick={() => handleRejectTrade(trade.trade_id)} className="bg-white/5 hover:bg-rose-500/20 border border-white/10 hover:border-rose-500/30 text-gray-400 hover:text-rose-300 px-3 py-2 rounded-xl transition" aria-label="Rechazar">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}

        {/* MAIN GRID */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* LEFT: ID + add */}
          <div className="lg:col-span-1 space-y-4">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="surface rounded-2xl p-5"
            >
              <p className="text-gray-500 text-[10px] font-medium uppercase tracking-wider mb-3">Tu ID de entrenador</p>
              <div className="bg-black/30 p-3 rounded-xl border border-white/5 flex flex-col gap-2">
                <span className="text-xs text-gray-300 break-all select-all font-mono">{user?.id}</span>
                <button
                  onClick={() => { navigator.clipboard.writeText(user?.id || ""); alert("ID copiado"); }}
                  className="btn-ghost text-white text-xs px-3 py-2 rounded-lg w-full transition font-medium flex items-center justify-center gap-2"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                    <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  Copiar
                </button>
              </div>
            </motion.div>

            <motion.form
              onSubmit={handleAddFriend}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="surface rounded-2xl p-5 flex flex-col gap-3"
            >
              <h3 className="font-semibold text-sm text-white">Añadir amigo</h3>
              <input
                type="text"
                placeholder="Pega su ID..."
                value={friendIdInput}
                onChange={(e) => setFriendIdInput(e.target.value)}
                className="bg-white/5 text-sm text-white px-3 py-2.5 rounded-xl border border-white/5 focus:border-white/20 outline-none placeholder:text-gray-600 transition"
              />
              <button type="submit" className="btn-primary py-2.5 rounded-xl font-medium text-sm">Enviar petición</button>
            </motion.form>

            {requests.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="surface rounded-2xl p-5 border border-yellow-500/20"
              >
                <h3 className="text-yellow-300 font-medium text-xs uppercase tracking-wider mb-3">Peticiones · {requests.length}</h3>
                <div className="flex flex-col gap-2">
                  {requests.map((req) => (
                    <div key={req.id} className="bg-white/5 p-3 rounded-xl border border-white/5 flex justify-between items-center">
                      <span className="text-xs font-medium truncate flex-1">{req.requester_name}</span>
                      <div className="flex gap-1">
                        <button onClick={() => handleAcceptFriend(req.id)} className="bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 px-2.5 py-1 rounded-lg text-xs">✓</button>
                        <button onClick={() => handleRemoveFriend(req.id)} className="bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 px-2.5 py-1 rounded-lg text-xs">✕</button>
                      </div>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </div>

          {/* RIGHT: Ranking */}
          <div className="lg:col-span-2">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
              className="surface rounded-2xl p-5"
            >
              <div className="flex justify-between items-center mb-4">
                <h3 className="font-semibold text-sm text-white uppercase tracking-wider">Ranking de entrenadores</h3>
                <span className="text-xs text-gray-500">{friends.length} jugadores</span>
              </div>

              <div className="flex flex-col gap-2">
                {friends.map((friend, index) => {
                  const isMe = friend.friend_id === user?.id;
                  const isExpanded = expandedFriendId === friend.friend_id;
                  return (
                    <div
                      key={friend.friend_id}
                      className={`rounded-xl border flex flex-col relative overflow-hidden transition ${
                        isMe ? "bg-emerald-500/5 border-emerald-500/20" : "bg-white/[0.02] border-white/5 hover:border-white/10"
                      }`}
                    >
                      <RankBadge index={index} />
                      <div onClick={() => toggleExpand(friend.friend_id)} className="p-4 flex items-center gap-4 cursor-pointer">
                        <div className={`w-10 h-10 flex-shrink-0 rounded-xl flex items-center justify-center border ${
                          isMe ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : "bg-white/5 border-white/10 text-gray-400"
                        }`}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                          </svg>
                        </div>
                        <div className="flex-1 min-w-0 pr-12">
                          <p className={`font-medium text-sm truncate ${isMe ? "text-emerald-300" : "text-white"}`}>
                            {friend.friend_name}{isMe && <span className="ml-2 text-[10px] text-gray-500">(tú)</span>}
                          </p>
                          <p className="text-[11px] text-gray-500">{friend.stats?.value || 0} monedas · {friend.stats?.unique || 0} únicas</p>
                        </div>
                        <motion.svg
                          animate={{ rotate: isExpanded ? 180 : 0 }}
                          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                          className="w-4 h-4 text-gray-500"
                        >
                          <path d="m6 9 6 6 6-6" />
                        </motion.svg>
                      </div>

                      <AnimatePresence>
                        {isExpanded && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                            className="overflow-hidden bg-black/20"
                          >
                            <div className="p-4 border-t border-white/5">
                              <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-4">
                                {[
                                  { label: "Valor", v: friend.stats?.value || 0, color: "text-emerald-400" },
                                  { label: "Únicas", v: friend.stats?.unique || 0, color: "text-white" },
                                  { label: "Cartas", v: friend.stats?.cards || 0, color: "text-gray-300" },
                                  { label: "Favs", v: friend.stats?.favs || 0, color: "text-rose-400" },
                                  { label: "Sobres", v: friend.stats?.packs || 0, color: "text-blue-300" },
                                  { label: "Gastado", v: friend.stats?.spent || 0, color: "text-purple-300" },
                                ].map((stat) => (
                                  <div key={stat.label} className="bg-white/[0.03] border border-white/5 rounded-xl p-2 text-center">
                                    <p className="text-[9px] text-gray-500 uppercase tracking-wider mb-1">{stat.label}</p>
                                    <p className={`font-semibold text-sm ${stat.color} tabular-nums`}>{stat.v}</p>
                                  </div>
                                ))}
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <Link
                                  href={isMe ? "/collection" : `/trainer/${friend.friend_id}`}
                                  className="flex-1 btn-ghost text-center text-xs font-medium py-2.5 px-3 rounded-xl min-w-[120px]"
                                >
                                  {isMe ? "Mi álbum" : "Ver álbum"}
                                </Link>
                                {!isMe && (
                                  <button onClick={() => handleOpenTradeModal(friend)} className="flex-1 bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/20 text-purple-300 text-xs font-medium py-2.5 px-3 rounded-xl transition min-w-[120px]">
                                    Intercambiar
                                  </button>
                                )}
                                {!isMe && (
                                  <button onClick={() => handleRemoveFriend(friend.friendship_id)} className="bg-white/5 hover:bg-rose-500/20 border border-white/5 text-gray-500 hover:text-rose-300 px-3 py-2.5 rounded-xl transition" aria-label="Eliminar">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                                      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                    </svg>
                                  </button>
                                )}
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
                {friends.length === 0 && (
                  <p className="text-center text-gray-500 text-xs py-8">Aún no tienes amigos. Comparte tu ID.</p>
                )}
              </div>
            </motion.div>
          </div>
        </div>
      </div>

      {/* TRADE MODAL */}
      <AnimatePresence>
        {tradeModalFriend && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/85 backdrop-blur-xl"
          >
            <motion.div
              initial={{ scale: 0.96, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.96, opacity: 0 }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              className="bg-[#0a0a0a] w-full max-w-5xl max-h-[90vh] rounded-3xl border border-white/10 flex flex-col overflow-hidden"
            >
              <div className="px-5 py-4 border-b border-white/5 flex justify-between items-center">
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider">Intercambio</p>
                  <h2 className="font-semibold text-base text-white">{tradeModalFriend.friend_name}</h2>
                </div>
                <button onClick={() => setTradeModalFriend(null)} className="w-9 h-9 rounded-xl bg-white/5 hover:bg-white/10 border border-white/5 flex items-center justify-center transition">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-5 grid grid-cols-1 md:grid-cols-2 gap-4 custom-scrollbar">
                {[
                  { label: "Tu oferta", cards: myCards, selected: selectedMyCard, set: setSelectedMyCard, accent: "emerald", dupColor: "bg-emerald-500/15 text-emerald-300" },
                  { label: "Quieres", cards: friendCards, selected: selectedFriendCard, set: setSelectedFriendCard, accent: "purple", dupColor: "bg-purple-500/15 text-purple-300" },
                ].map((side, i) => (
                  <div key={i} className="bg-white/[0.02] border border-white/5 rounded-2xl p-4">
                    <h3 className="font-medium text-xs uppercase tracking-wider text-center mb-3 text-gray-400">{side.label}</h3>
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 h-72 overflow-y-auto custom-scrollbar pr-1">
                      {side.cards.length === 0 ? (
                        <p className="col-span-full text-center text-xs text-gray-600 py-12">Sin cartas</p>
                      ) : side.cards.map((c: any) => {
                        const isDuplicate = c.quantity > 1;
                        const isSelected = side.selected?.id === c.id;
                        const ring = side.accent === "emerald" ? "border-emerald-400 shadow-emerald-500/30" : "border-purple-400 shadow-purple-500/30";
                        return (
                          <div
                            key={c.id}
                            onClick={() => side.set(c)}
                            className={`relative cursor-pointer rounded-lg border-2 transition ${
                              isSelected ? `${ring} shadow-lg scale-[1.03] z-10` :
                              isDuplicate ? "border-transparent hover:border-white/20" :
                              "border-transparent hover:border-white/10 opacity-50 hover:opacity-90"
                            }`}
                          >
                            <div className={`absolute -top-1.5 -right-1.5 text-[9px] font-bold w-5 h-5 flex items-center justify-center rounded-full border border-black z-20 ${
                              isDuplicate ? side.dupColor : "bg-white/10 text-gray-400"
                            }`}>
                              {c.quantity}
                            </div>
                            <img src={c.images.small} alt={c.name} className="w-full h-auto rounded-md" />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              <div className="px-5 py-4 border-t border-white/5 flex flex-col sm:flex-row items-center gap-3">
                <div className="flex items-center gap-3 text-xs flex-1 w-full bg-white/[0.03] px-4 py-2.5 rounded-xl border border-white/5">
                  <div className="flex-1">
                    <p className="text-[9px] text-gray-500 uppercase tracking-wider">Ofreces</p>
                    <p className={selectedMyCard ? "text-emerald-300 truncate" : "text-gray-600"}>{selectedMyCard?.name || "—"}</p>
                  </div>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-gray-600">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                  <div className="flex-1">
                    <p className="text-[9px] text-gray-500 uppercase tracking-wider">Pides</p>
                    <p className={selectedFriendCard ? "text-purple-300 truncate" : "text-gray-600"}>{selectedFriendCard?.name || "—"}</p>
                  </div>
                </div>
                <button
                  onClick={submitTradeOffer}
                  disabled={!selectedMyCard || !selectedFriendCard || isSendingTrade}
                  className={`py-2.5 px-6 rounded-xl font-medium text-sm transition w-full sm:w-auto ${
                    !selectedMyCard || !selectedFriendCard
                      ? "bg-white/5 text-gray-600 cursor-not-allowed"
                      : "btn-primary"
                  }`}
                >
                  {isSendingTrade ? "Enviando..." : "Enviar oferta"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
