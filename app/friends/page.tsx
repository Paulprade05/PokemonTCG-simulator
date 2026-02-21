"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useUser, SignedIn, UserButton } from "@clerk/nextjs";
import { getFriendsList, sendFriendRequest, acceptFriendRequest, removeFriend, syncUserName } from "../action";

export default function FriendsPage() {
  const { user, isLoaded, isSignedIn } = useUser();
  const [friends, setFriends] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [friendIdInput, setFriendIdInput] = useState("");

  const loadData = async () => {
    if (!isSignedIn) return;
    setLoading(true);
    
    // 👈 MAGIA AQUÍ: Primero sincronizamos tu propio nombre en la Base de Datos
    await syncUserName(); 

    const data = await getFriendsList();
    setFriends(data.accepted);
    setRequests(data.pendingRequests);
    setLoading(false);
  };

  useEffect(() => {
    if (isLoaded) loadData();
  }, [isLoaded, isSignedIn]);

  const handleAddFriend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!friendIdInput.trim()) return;
    
    const res = await sendFriendRequest(friendIdInput.trim());
    if (res.error) {
      alert(res.error);
    } else {
      alert("¡Petición enviada con éxito! 📨");
      setFriendIdInput("");
    }
  };

  const handleAccept = async (id: number) => {
    await acceptFriendRequest(id);
    loadData();
  };

  const handleRemove = async (id: number) => {
    if (!confirm("¿Seguro que quieres eliminar a este amigo/petición?")) return;
    await removeFriend(id);
    loadData();
  };

  if (!isLoaded || loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex flex-col items-center justify-center text-white">
        <div className="text-4xl animate-bounce mb-4">🌍</div>
        <p className="animate-pulse">Cargando Red de Entrenadores...</p>
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-8 text-center">
        <h2 className="text-2xl font-bold mb-4">Inicia sesión para tener amigos</h2>
        <Link href="/" className="bg-blue-600 px-6 py-2 rounded-full font-bold">Volver a Inicio</Link>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-gray-900 text-white p-8 pb-32">
      {/* CABECERA */}
      <div className="w-full max-w-4xl mx-auto bg-gray-800 p-4 rounded-xl shadow-xl border border-gray-700 mb-8 flex justify-between items-center">
        <div className="flex items-center gap-4">
          <Link href="/" className="bg-gray-700 hover:bg-gray-600 w-10 h-10 flex items-center justify-center rounded-lg border border-gray-600 transition shadow">🏠</Link>
          <h1 className="text-xl md:text-2xl font-bold text-white tracking-wide">Amigos</h1>
        </div>
        <SignedIn><UserButton /></SignedIn>
      </div>

      <div className="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-8">
        
        {/* COLUMNA IZQUIERDA */}
        <div className="md:col-span-1 space-y-6">
          <div className="bg-blue-900/30 border border-blue-500/50 p-6 rounded-2xl text-center shadow-lg">
            <p className="text-blue-300 text-sm font-bold uppercase mb-2">Tu ID de Entrenador</p>
            <div className="bg-gray-900 p-3 rounded-lg border border-gray-700 flex flex-col items-center gap-2">
              <span className="text-xs text-gray-400 break-all select-all font-mono">
                {user?.id}
              </span>
              <button 
                onClick={() => {navigator.clipboard.writeText(user?.id || ""); alert("ID Copiado!");}}
                className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded w-full transition"
              >
                📋 Copiar mi ID
              </button>
            </div>
            <p className="text-[10px] text-gray-400 mt-3">Tus amigos te verán como: <strong className="text-white">{user?.username || user?.firstName || "Entrenador"}</strong></p>
          </div>

          <form onSubmit={handleAddFriend} className="bg-gray-800 border border-gray-700 p-6 rounded-2xl shadow-lg flex flex-col gap-4">
            <h3 className="font-bold text-lg">Añadir Amigo</h3>
            <input 
              type="text" 
              placeholder="Pega su ID de Entrenador aquí..." 
              value={friendIdInput}
              onChange={(e) => setFriendIdInput(e.target.value)}
              className="bg-gray-900 text-sm text-white px-3 py-2 rounded-lg border border-gray-600 focus:border-blue-400 outline-none w-full"
            />
            <button type="submit" className="bg-green-600 hover:bg-green-500 text-white font-bold py-2 rounded-lg transition">
              ➕ Enviar Petición
            </button>
          </form>
        </div>

        {/* COLUMNA DERECHA */}
        <div className="md:col-span-2 space-y-8">
          
          {/* PETICIONES PENDIENTES */}
          {requests.length > 0 && (
            <div className="bg-yellow-900/20 border border-yellow-500/30 p-6 rounded-2xl">
              <h3 className="text-yellow-400 font-bold mb-4 flex items-center gap-2">
                <span>🔔</span> Peticiones Pendientes ({requests.length})
              </h3>
              <div className="flex flex-col gap-3">
                {requests.map(req => (
                  <div key={req.id} className="bg-gray-800 p-3 rounded-xl border border-gray-700 flex justify-between items-center">
                    <span className="text-sm font-bold text-white truncate w-1/2">
                      {req.requester_name} {/* 👈 MUESTRA SU NOMBRE */}
                    </span>
                    <div className="flex gap-2">
                      <button onClick={() => handleAccept(req.id)} className="bg-green-600 hover:bg-green-500 px-3 py-1 rounded text-xs font-bold transition">Aceptar</button>
                      <button onClick={() => handleRemove(req.id)} className="bg-red-600 hover:bg-red-500 px-3 py-1 rounded text-xs font-bold transition">✕</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* LISTA DE AMIGOS ACEPTADOS (RANKING) */}
          <div className="bg-gray-800 border border-gray-700 p-6 rounded-2xl shadow-lg">
            <h3 className="font-bold text-lg mb-6 border-b border-gray-700 pb-2 flex justify-between items-center">
              <span>Ranking de Colecciones 🏆</span>
              <span className="text-sm font-normal text-gray-400">{friends.length} Amigos</span>
            </h3>
            
            {friends.length === 0 ? (
              <p className="text-gray-500 text-center py-8">Aún no tienes amigos añadidos.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {friends.map((friend, index) => (
                  <div key={friend.friendship_id} className="bg-gray-900 p-5 rounded-2xl border border-gray-700 flex flex-col gap-4 relative overflow-hidden group hover:border-blue-500 transition shadow-md">
                    
                    {/* MEDALLAS PARA EL TOP 3 */}
                    {index === 0 && <div className="absolute top-0 right-0 bg-yellow-500 text-yellow-900 text-[10px] font-black px-3 py-1 rounded-bl-lg z-10 shadow">🥇 TOP 1</div>}
                    {index === 1 && <div className="absolute top-0 right-0 bg-gray-300 text-gray-800 text-[10px] font-black px-3 py-1 rounded-bl-lg z-10 shadow">🥈 TOP 2</div>}
                    {index === 2 && <div className="absolute top-0 right-0 bg-orange-700 text-orange-100 text-[10px] font-black px-3 py-1 rounded-bl-lg z-10 shadow">🥉 TOP 3</div>}

                    {/* PERFIL */}
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-blue-500 to-purple-600 flex items-center justify-center text-2xl shadow-lg border-2 border-gray-800">
                        🧑‍🎤
                      </div>
                      <div className="overflow-hidden flex-1 pr-10">
                        <p className="font-black text-lg text-white truncate leading-tight">{friend.friend_name}</p>
                        <p className="text-[10px] text-gray-500 font-mono truncate">{friend.friend_id}</p>
                      </div>
                    </div>

                    {/* ESTADÍSTICAS */}
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <div className="bg-gray-800 p-2 rounded-lg border border-gray-700 flex flex-col justify-center">
                        <p className="text-[9px] text-gray-400 font-bold uppercase mb-0.5">Valor Total</p>
                        <p className="text-yellow-400 font-black flex items-center gap-1">{friend.stats?.value || 0} 💰</p>
                      </div>
                      <div className="bg-gray-800 p-2 rounded-lg border border-gray-700 flex flex-col justify-center">
                        <p className="text-[9px] text-gray-400 font-bold uppercase mb-0.5">Progreso Único</p>
                        <p className="text-white font-black flex items-center gap-1">{friend.stats?.unique || 0} 🎴</p>
                      </div>
                      <div className="bg-gray-800 p-2 rounded-lg border border-gray-700 flex flex-col justify-center">
                        <p className="text-[9px] text-gray-400 font-bold uppercase mb-0.5">Cartas Totales</p>
                        <p className="text-gray-300 font-black flex items-center gap-1">{friend.stats?.cards || 0} 📦</p>
                      </div>
                      <div className="bg-gray-800 p-2 rounded-lg border border-gray-700 flex flex-col justify-center">
                        <p className="text-[9px] text-gray-400 font-bold uppercase mb-0.5">Favoritas</p>
                        <p className="text-red-400 font-black flex items-center gap-1">{friend.stats?.favs || 0} ❤️</p>
                      </div>
                    </div>
                    
                    {/* BOTONES */}
                    <div className="flex gap-2 mt-auto pt-2">
                      <Link 
                        href={`/trainer/${friend.friend_id}`}
                        className="flex-1 bg-blue-600 hover:bg-blue-500 text-center text-xs font-bold py-2.5 rounded-lg transition"
                      >
                        Inspeccionar Álbum 🔍
                      </Link>
                      <button 
                        onClick={() => handleRemove(friend.friendship_id || friend.id)}
                        className="bg-gray-800 hover:bg-red-600 border border-gray-700 text-gray-400 hover:text-white px-4 py-2.5 rounded-lg transition"
                        title="Eliminar amigo"
                      >
                        🗑️
                      </button>
                    </div>

                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </main>
  );
}