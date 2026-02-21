"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useUser, SignedIn, UserButton } from "@clerk/nextjs";
import { 
  getFriendsList, 
  sendFriendRequest, 
  acceptFriendRequest, 
  removeFriend 
} from "../action";

export default function FriendsPage() {
  const { user, isLoaded, isSignedIn } = useUser();
  const [friends, setFriends] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [friendIdInput, setFriendIdInput] = useState("");

  const loadData = async () => {
    if (!isSignedIn) return;
    setLoading(true);
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
    loadData(); // Recargar listas
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
        
        {/* COLUMNA IZQUIERDA: Añadir y Tu ID */}
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
            <p className="text-[10px] text-gray-400 mt-3">Pásale este ID a tus amigos para que te añadan.</p>
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

        {/* COLUMNA DERECHA: Listas de amigos */}
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
                    <span className="text-sm font-mono text-gray-300 truncate w-1/2">
                      {req.requester_id.substring(0, 15)}...
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

          {/* LISTA DE AMIGOS ACEPTADOS */}
          <div className="bg-gray-800 border border-gray-700 p-6 rounded-2xl shadow-lg">
            <h3 className="font-bold text-lg mb-6 border-b border-gray-700 pb-2">Mis Amigos ({friends.length})</h3>
            {friends.length === 0 ? (
              <p className="text-gray-500 text-center py-8">Aún no tienes amigos añadidos.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {friends.map(friend => (
                  <div key={friend.id} className="bg-gray-900 p-4 rounded-xl border border-gray-700 flex flex-col gap-4 hover:border-blue-500 transition group">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-blue-500 to-purple-500 flex items-center justify-center text-xl shadow">
                        🧑‍🎤
                      </div>
                      <div className="overflow-hidden">
                        <p className="font-bold text-sm text-gray-200">Entrenador</p>
                        <p className="text-[10px] text-gray-500 font-mono truncate">{friend.friend_id}</p>
                      </div>
                    </div>
                    
                    <div className="flex gap-2 mt-auto">
                      <Link 
                        href={`/trainer/${friend.friend_id}`}
                        className="flex-1 bg-blue-600 hover:bg-blue-500 text-center text-xs font-bold py-2 rounded transition"
                      >
                        Ver Álbum 📖
                      </Link>
                      <button 
                        onClick={() => handleRemove(friend.id)}
                        className="bg-gray-800 hover:bg-red-600 border border-gray-700 text-gray-400 hover:text-white px-3 py-2 rounded transition"
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