"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useUser, SignedIn, UserButton } from "@clerk/nextjs";
import { AnimatePresence, motion } from "framer-motion";
import { 
  getFriendsList, 
  sendFriendRequest, 
  acceptFriendRequest, 
  removeFriend,
  syncUserName,
  getPendingTrades,
  acceptTrade,
  rejectTrade,
  sendTradeRequest,
  getFullCollection,
  getTrainerCollection
} from "../action";

export default function FriendsPage() {
  const { user, isLoaded, isSignedIn } = useUser();
  const [friends, setFriends] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [tradeRequests, setTradeRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [friendIdInput, setFriendIdInput] = useState("");
  const [expandedFriendId, setExpandedFriendId] = useState<string | null>(null);

  // --- ESTADOS DEL MODAL DE INTERCAMBIO ---
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
    
    // Cargamos todo en paralelo
    const [friendsData, tradesData] = await Promise.all([
      getFriendsList(),
      getPendingTrades()
    ]);

    setFriends(friendsData.accepted);
    setRequests(friendsData.pendingRequests);
    setTradeRequests(tradesData);
    setLoading(false);
  };

  useEffect(() => {
    if (isLoaded) loadData();
  }, [isLoaded, isSignedIn]);

  // --- LÓGICA DE AMIGOS NORMAL ---
  const handleAddFriend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!friendIdInput.trim()) return;
    const res = await sendFriendRequest(friendIdInput.trim());
    if (res.error) alert(res.error);
    else { alert("¡Petición enviada! 📨"); setFriendIdInput(""); }
  };

  const toggleExpand = (id: string) => setExpandedFriendId(expandedFriendId === id ? null : id);

  // --- LÓGICA DE INTERCAMBIOS ---
  const handleOpenTradeModal = async (friend: any) => {
    setTradeModalFriend(friend);
    setSelectedMyCard(null);
    setSelectedFriendCard(null);
    
    // Cargamos ambas colecciones
    const [mine, theirs] = await Promise.all([
      getFullCollection(),
      getTrainerCollection(friend.friend_id)
    ]);
    
    // Solo mostramos cartas que tengan copias (> 0)
    setMyCards(mine.filter(c => c.quantity > 0));
    setFriendCards(theirs.filter(c => c.quantity > 0));
  };

  const submitTradeOffer = async () => {
    if (!selectedMyCard || !selectedFriendCard) return;
    setIsSendingTrade(true);
    const res = await sendTradeRequest(tradeModalFriend.friend_id, selectedMyCard.id, selectedFriendCard.id);
    setIsSendingTrade(false);
    
    if (res.error) alert(res.error);
    else {
      alert("¡Oferta de intercambio enviada! 🚀");
      setTradeModalFriend(null);
    }
  };

 const handleAccept = async (id: any) => {
    await acceptFriendRequest(id);
    loadData();
  };

  const handleRemove = async (id: any) => {
    if (!confirm("¿Seguro que quieres eliminar a este amigo/petición?")) return;
    await removeFriend(id);
    loadData();
  };

  const handleCounterOffer = (trade: any) => {
    // Para contraofertar, cerramos la notificación y abrimos el modal de oferta hacia esa persona
    rejectTrade(trade.trade_id); // Rechazamos la actual automáticamente
    const friendData = friends.find(f => f.friend_id === trade.sender_id);
    if (friendData) handleOpenTradeModal(friendData);
    else alert("Este usuario ya no está en tu lista de amigos.");
  };

  if (!isLoaded || loading) return <div className="min-h-screen bg-gray-900 flex flex-col items-center justify-center text-white"><div className="text-4xl animate-bounce mb-4">🌍</div><p className="animate-pulse">Cargando Red de Entrenadores...</p></div>;
  if (!isSignedIn) return <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-8 text-center"><h2 className="text-2xl font-bold mb-4">Inicia sesión</h2><Link href="/" className="bg-blue-600 px-6 py-2 rounded-full font-bold">Volver</Link></div>;

  return (
    <main className="min-h-screen bg-gray-900 text-white p-4 sm:p-8 pb-32">
      <div className="w-full max-w-5xl mx-auto bg-gray-800 p-4 rounded-xl shadow-xl border border-gray-700 mb-8 flex justify-between items-center">
        <div className="flex items-center gap-4">
          <Link href="/" className="bg-gray-700 hover:bg-gray-600 w-10 h-10 flex items-center justify-center rounded-lg border border-gray-600 transition shadow">🏠</Link>
          <h1 className="text-xl md:text-2xl font-bold text-white tracking-wide">Centro de Amigos</h1>
        </div>
        <SignedIn><UserButton /></SignedIn>
      </div>

      <div className="max-w-5xl mx-auto space-y-8">
        
        {/* --- NOTIFICACIONES DE INTERCAMBIO RECIBIDAS --- */}
        {tradeRequests.length > 0 && (
          <div className="bg-purple-900/40 border-2 border-purple-500 shadow-purple-500/20 shadow-lg p-6 rounded-2xl animate-pulse-slow">
            <h3 className="text-purple-300 font-black text-xl mb-4 flex items-center gap-2"><span>🔄</span> ¡Tienes Ofertas de Intercambio! ({tradeRequests.length})</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {tradeRequests.map(trade => (
                <div key={trade.trade_id} className="bg-gray-900 p-4 rounded-xl border border-purple-700/50 flex flex-col">
                  <p className="text-sm text-gray-300 mb-3"><strong className="text-white">{trade.sender_name}</strong> te ofrece un trato:</p>
                  
                  <div className="flex justify-between items-center bg-gray-800 p-3 rounded-lg mb-4">
                    <div className="text-center w-1/3">
                      <p className="text-[10px] text-gray-500 font-bold mb-1">RECIBES</p>
                      <img src={trade.sender_card_image?.small} alt="Recibes" className="w-16 h-auto mx-auto drop-shadow-md rounded hover:scale-110 transition" />
                      <p className="text-[10px] text-green-400 font-bold mt-1 truncate">{trade.sender_card_name}</p>
                    </div>
                    <div className="text-2xl animate-bounce">➡️</div>
                    <div className="text-center w-1/3">
                      <p className="text-[10px] text-gray-500 font-bold mb-1">ENTREGAS</p>
                      <img src={trade.receiver_card_image?.small} alt="Entregas" className="w-16 h-auto mx-auto drop-shadow-md rounded opacity-80 hover:scale-110 transition" />
                      <p className="text-[10px] text-red-400 font-bold mt-1 truncate">{trade.receiver_card_name}</p>
                    </div>
                  </div>

                  <div className="flex gap-2 mt-auto">
                    <button onClick={() => handleAccept(trade.trade_id)} className="flex-1 bg-green-600 hover:bg-green-500 text-white text-xs font-bold py-2 rounded transition">Aceptar Trato</button>
                    <button onClick={() => handleCounterOffer(trade)} className="flex-1 bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold py-2 rounded transition">Cambiar Carta 🔄</button>
                    <button onClick={() => handleRemove(trade.trade_id)} className="bg-gray-700 hover:bg-red-600 text-white px-3 py-2 rounded transition text-xs font-bold">✕</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* CONTENIDO PRINCIPAL: DOS COLUMNAS */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          {/* PANEL IZQUIERDO */}
          <div className="lg:col-span-1 space-y-6">
            <div className="bg-blue-900/30 border border-blue-500/50 p-6 rounded-2xl text-center shadow-lg">
              <p className="text-blue-300 text-sm font-bold uppercase mb-2">Tu ID de Entrenador</p>
              <div className="bg-gray-900 p-3 rounded-lg border border-gray-700 flex flex-col gap-2">
                <span className="text-xs text-gray-400 break-all select-all font-mono">{user?.id}</span>
                <button onClick={() => {navigator.clipboard.writeText(user?.id || ""); alert("ID Copiado!");}} className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded w-full transition font-bold">📋 Copiar mi ID</button>
              </div>
            </div>

            <form onSubmit={handleAddFriend} className="bg-gray-800 border border-gray-700 p-6 rounded-2xl shadow-lg flex flex-col gap-4">
              <h3 className="font-bold text-lg">Añadir Amigo</h3>
              <input type="text" placeholder="Pega su ID aquí..." value={friendIdInput} onChange={(e) => setFriendIdInput(e.target.value)} className="bg-gray-900 text-sm text-white px-3 py-2 rounded-lg border border-gray-600 focus:border-blue-400 outline-none w-full" />
              <button type="submit" className="bg-green-600 hover:bg-green-500 text-white font-bold py-2 rounded-lg transition">➕ Enviar Petición</button>
            </form>

            {requests.length > 0 && (
              <div className="bg-yellow-900/20 border border-yellow-500/30 p-4 rounded-2xl">
                <h3 className="text-yellow-400 font-bold mb-3 flex items-center gap-2"><span>🔔</span> Peticiones Amistad</h3>
                <div className="flex flex-col gap-2">
                  {requests.map(req => (
                    <div key={req.id} className="bg-gray-800 p-3 rounded-xl border border-gray-700 flex justify-between items-center">
                      <span className="text-xs font-bold truncate w-1/2">{req.requester_name}</span>
                      <div className="flex gap-1">
                        <button onClick={() => handleAccept(req.id)} className="bg-green-600 px-2 py-1 rounded text-xs font-bold">✓</button>
                        <button onClick={() => handleRemove(req.id)} className="bg-red-600 px-2 py-1 rounded text-xs font-bold">✕</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* PANEL DERECHO: RANKING Y AMIGOS */}
          <div className="lg:col-span-2">
            <div className="bg-gray-800 border border-gray-700 p-4 sm:p-6 rounded-2xl shadow-lg">
              <h3 className="font-bold text-lg mb-6 border-b border-gray-700 pb-2 flex justify-between items-center">
                <span>Ranking de Entrenadores 🏆</span>
                <span className="text-sm font-normal text-gray-400">{friends.length} Jugadores</span>
              </h3>
              
              <div className="flex flex-col gap-3">
                {friends.map((friend, index) => {
                  const isMe = friend.friend_id === user?.id;
                  const isExpanded = expandedFriendId === friend.friend_id;

                  return (
                    <div key={friend.friend_id} className={`rounded-xl border flex flex-col relative overflow-hidden group transition shadow-md ${isMe ? "bg-blue-900/10 border-blue-500/50" : "bg-gray-900 border-gray-700 hover:border-gray-500"}`}>
                      {index === 0 && <div className="absolute top-0 right-0 bg-yellow-500 text-yellow-900 text-[10px] font-black px-3 py-1 rounded-bl-lg z-10 shadow">🥇 1º</div>}
                      {index === 1 && <div className="absolute top-0 right-0 bg-gray-300 text-gray-800 text-[10px] font-black px-3 py-1 rounded-bl-lg z-10 shadow">🥈 2º</div>}
                      {index === 2 && <div className="absolute top-0 right-0 bg-orange-700 text-orange-100 text-[10px] font-black px-3 py-1 rounded-bl-lg z-10 shadow">🥉 3º</div>}

                      <div onClick={() => toggleExpand(friend.friend_id)} className="p-4 flex items-center gap-4 cursor-pointer select-none">
                        <div className={`w-10 h-10 sm:w-12 sm:h-12 flex-shrink-0 rounded-full flex items-center justify-center text-xl shadow-lg border-2 ${isMe ? 'bg-gradient-to-tr from-yellow-400 to-orange-500 border-yellow-200' : 'bg-gradient-to-tr from-blue-500 to-purple-600 border-gray-800'}`}>
                          {isMe ? '👑' : '🧑‍🎤'}
                        </div>
                        <div className="overflow-hidden flex-1 pr-8">
                          <p className={`font-black text-base sm:text-lg truncate leading-tight ${isMe ? 'text-blue-400' : 'text-white'}`}>{friend.friend_name}</p>
                        </div>
                        <div className="flex items-center gap-3 text-right">
                           <p className="text-yellow-400 font-black text-sm hidden sm:block">{friend.stats?.value || 0} 💰</p>
                           <motion.div animate={{ rotate: isExpanded ? 180 : 0 }} className="text-gray-500 text-sm">▼</motion.div>
                        </div>
                      </div>

                      <AnimatePresence>
                        {isExpanded && (
                          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden bg-gray-950/50">
                            <div className="p-4 border-t border-gray-800/50">
                              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-4">
                                <div className="bg-gray-800/80 p-2 rounded-lg border border-gray-700/50 text-center"><p className="text-[9px] text-gray-400 font-bold uppercase">Valor</p><p className="text-yellow-400 font-black text-xs">{friend.stats?.value || 0}💰</p></div>
                                <div className="bg-gray-800/80 p-2 rounded-lg border border-gray-700/50 text-center"><p className="text-[9px] text-gray-400 font-bold uppercase">Progreso</p><p className="text-white font-black text-xs">{friend.stats?.unique || 0}🎴</p></div>
                                <div className="bg-gray-800/80 p-2 rounded-lg border border-gray-700/50 text-center"><p className="text-[9px] text-gray-400 font-bold uppercase">Cartas</p><p className="text-gray-300 font-black text-xs">{friend.stats?.cards || 0}📦</p></div>
                                <div className="bg-gray-800/80 p-2 rounded-lg border border-gray-700/50 text-center"><p className="text-[9px] text-gray-400 font-bold uppercase">Favs</p><p className="text-red-400 font-black text-xs">{friend.stats?.favs || 0}❤️</p></div>
                                <div className="bg-blue-900/30 p-2 rounded-lg border border-blue-800/50 text-center"><p className="text-[9px] text-blue-400 font-bold uppercase">Sobres</p><p className="text-blue-300 font-black text-xs">{friend.stats?.packs || 0}✉️</p></div>
                                <div className="bg-green-900/30 p-2 rounded-lg border border-green-800/50 text-center"><p className="text-[9px] text-green-400 font-bold uppercase">Gastado</p><p className="text-green-300 font-black text-xs">{friend.stats?.spent || 0}💸</p></div>
                              </div>
                              
                              <div className="flex flex-wrap gap-2">
                                <Link href={isMe ? "/collection" : `/trainer/${friend.friend_id}`} className="flex-1 bg-blue-600 hover:bg-blue-500 text-center text-xs font-bold py-2.5 px-3 rounded-lg transition min-w-[120px]">
                                  {isMe ? "Ir a mi Álbum 📒" : "Ver Álbum 🔍"}
                                </Link>
                                {!isMe && (
                                  <button onClick={() => handleOpenTradeModal(friend)} className="flex-1 bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold py-2.5 px-3 rounded-lg transition min-w-[120px]">
                                    Ofrecer Intercambio 🔄
                                  </button>
                                )}
                                {!isMe && (
                                  <button onClick={() => handleRemove(friend.friendship_id)} className="bg-gray-800 hover:bg-red-600 border border-gray-700 text-gray-400 hover:text-white px-4 py-2.5 rounded-lg transition" title="Eliminar amigo">🗑️</button>
                                )}
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* --- MODAL PARA CREAR UN INTERCAMBIO --- */}
      <AnimatePresence>
        {tradeModalFriend && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }} className="bg-gray-900 w-full max-w-4xl max-h-[90vh] rounded-2xl border border-purple-500/50 shadow-2xl shadow-purple-900/20 flex flex-col overflow-hidden">
              
              <div className="bg-gray-800 p-4 border-b border-gray-700 flex justify-between items-center">
                <h2 className="font-black text-lg text-purple-400">Trato con {tradeModalFriend.friend_name}</h2>
                <button onClick={() => setTradeModalFriend(null)} className="text-gray-400 hover:text-white font-bold text-xl">✕</button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 md:p-6 grid grid-cols-1 md:grid-cols-2 gap-6 custom-scrollbar">
                
                {/* LADO IZQUIERDO: TUS CARTAS */}
                <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4">
                  <h3 className="font-bold text-sm text-center mb-4 border-b border-gray-700 pb-2">1. Elige qué carta tuya OFRECES</h3>
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 h-64 overflow-y-auto custom-scrollbar pr-2">
                    {myCards.length === 0 ? <p className="col-span-full text-center text-xs text-gray-500">No tienes cartas</p> : 
                      myCards.map(c => (
                        <div key={c.id} onClick={() => setSelectedMyCard(c)} className={`cursor-pointer rounded-lg border-2 transition ${selectedMyCard?.id === c.id ? 'border-green-500 shadow-lg shadow-green-500/30 scale-105' : 'border-transparent hover:border-gray-500 opacity-70 hover:opacity-100'}`}>
                          <img src={c.images.small} alt={c.name} className="w-full h-auto rounded-md" />
                          <div className="text-center text-[9px] bg-gray-900/80 truncate px-1 rounded-b-md">{c.quantity} copias</div>
                        </div>
                      ))
                    }
                  </div>
                </div>

                {/* LADO DERECHO: SUS CARTAS */}
                <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4">
                  <h3 className="font-bold text-sm text-center mb-4 border-b border-gray-700 pb-2">2. Elige qué carta suya PIDES</h3>
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 h-64 overflow-y-auto custom-scrollbar pr-2">
                    {friendCards.length === 0 ? <p className="col-span-full text-center text-xs text-gray-500">Tu amigo no tiene cartas</p> : 
                      friendCards.map(c => (
                        <div key={c.id} onClick={() => setSelectedFriendCard(c)} className={`cursor-pointer rounded-lg border-2 transition ${selectedFriendCard?.id === c.id ? 'border-purple-500 shadow-lg shadow-purple-500/30 scale-105' : 'border-transparent hover:border-gray-500 opacity-70 hover:opacity-100'}`}>
                          <img src={c.images.small} alt={c.name} className="w-full h-auto rounded-md" />
                          <div className="text-center text-[9px] bg-gray-900/80 truncate px-1 rounded-b-md">{c.name}</div>
                        </div>
                      ))
                    }
                  </div>
                </div>

              </div>

              {/* BARRA INFERIOR DE CONFIRMACIÓN */}
              <div className="bg-gray-800 p-4 border-t border-gray-700 flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="flex items-center gap-4 text-sm font-bold bg-gray-900 px-4 py-2 rounded-lg border border-gray-700 flex-1 w-full justify-center">
                  <div className="flex flex-col items-center"><span className="text-[10px] text-gray-500">TÚ OFRECES</span><span className={selectedMyCard ? "text-green-400" : "text-gray-600"}>{selectedMyCard ? selectedMyCard.name : "Selecciona..."}</span></div>
                  <span className="text-xl">🔄</span>
                  <div className="flex flex-col items-center"><span className="text-[10px] text-gray-500">TÚ PIDES</span><span className={selectedFriendCard ? "text-purple-400" : "text-gray-600"}>{selectedFriendCard ? selectedFriendCard.name : "Selecciona..."}</span></div>
                </div>
                
                <button 
                  onClick={submitTradeOffer} 
                  disabled={!selectedMyCard || !selectedFriendCard || isSendingTrade}
                  className={`py-3 px-8 rounded-xl font-black transition w-full sm:w-auto ${(!selectedMyCard || !selectedFriendCard) ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white shadow-lg shadow-purple-500/30'}`}
                >
                  {isSendingTrade ? "Enviando..." : "Enviar Trato 🚀"}
                </button>
              </div>

            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}