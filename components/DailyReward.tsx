"use client";

import { useEffect, useState } from "react";
import { claimDailyReward, getDailyStatus } from "../app/action";
import { useCurrency } from "../hooks/useGameCurrency";
import { useToast } from "./ui/Toast";
import { formatNumber } from "../utils/format";

/**
 * LA RECOMPENSA DIARIA: un botón en la barra superior y nada más.
 *
 * LO QUE HABÍA Y POR QUÉ SE HA IDO:
 *
 *  · `alert(res.error)` para los fallos. En una PWA instalada el alert enseña
 *    el nombre del dominio y corta la interacción (components/ui/Toast.tsx lo
 *    dice en su cabecera: existe justamente para sustituirlo). Ahora es un
 *    aviso más de la app, con el mismo tono que los del bazar o la colección.
 *
 *  · Un cartel propio "+N monedas reclamadas" montado AQUÍ, con `fixed` y
 *    z-[200]. Este componente vive dentro de la cabecera, que es `sticky` con
 *    z-30 y —cuando framer la desplaza— un ancestro transformado, o sea el
 *    bloque contenedor de cualquier `fixed` que cuelgue de ella: el cartel
 *    quedaba con z efectivo 30 y anclado a la barra, no a la ventana. El
 *    aviso de Toast ya vive fuera de la cabecera (lo monta ToastProvider como
 *    hermano del árbol entero, en AppShell), así que la recompensa se anuncia
 *    por ahí y no hay portal que inventar.
 *
 *  · Paleta literal de Tailwind (text-amber-300, text-emerald-200,
 *    text-gray-600). Están pensadas para fondo negro: sobre el papel claro del
 *    tema medían 1,26:1 y 1,12:1 de contraste, o sea invisibles. Los colores
 *    salen ahora de los tokens del tema: `--warn`/`--warn-ink` para "hay
 *    recompensa" (es un aviso que pide acción) y `--ink-faint` sobre `--border`
 *    para el botón agotado, que es como se apagan el resto de botones de la app.
 */
/** Lo que devuelven las dos acciones, en lo que aquí se lee. */
type EstadoDiario = { available?: boolean; streak?: number; hoursLeft?: number } | null;
type RespuestaReclamo = {
  success?: boolean;
  reward?: number;
  streak?: number;
  error?: string;
} | null;

export default function DailyReward() {
  const [available, setAvailable] = useState(false);
  const [streak, setStreak] = useState(0);
  const [hoursLeft, setHoursLeft] = useState(0);
  const [claiming, setClaiming] = useState(false);
  const { addCoins } = useCurrency();
  const toast = useToast();

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const s = (await getDailyStatus()) as EstadoDiario;
        if (cancelado) return;
        setAvailable(!!s?.available);
        setStreak(s?.streak || 0);
        setHoursLeft(s?.hoursLeft || 0);
      } catch {
        // Sin respuesta (sin conexión) el botón se queda apagado, que es el
        // estado que no promete nada.
      }
    })();
    return () => {
      cancelado = true;
    };
  }, []);

  const handleClaim = async () => {
    if (!available || claiming) return;
    setClaiming(true);
    try {
      const res = (await claimDailyReward()) as RespuestaReclamo;
      if (res?.success) {
        const premio = res.reward ?? 0;
        addCoins(premio);
        setStreak(res.streak ?? 0);
        setAvailable(false);
        setHoursLeft(20);
        toast(`+${formatNumber(premio)} monedas reclamadas`, "success");
      } else if (res?.error) {
        toast(res.error, "error");
      }
    } catch (e) {
      // La acción rechaza sin conexión o con el despliegue caducado: antes esto
      // dejaba el botón en "reclamando" para siempre.
      console.error("Error reclamando la recompensa diaria:", e);
      toast("No se pudo reclamar la recompensa. Revisa tu conexión.", "error");
    } finally {
      setClaiming(false);
    }
  };

  const rotulo = available
    ? `Reclama la recompensa diaria · racha ${streak}`
    : `Recompensa diaria disponible en ~${hoursLeft}h`;

  return (
    <button
      type="button"
      onClick={handleClaim}
      disabled={!available || claiming}
      aria-busy={claiming}
      // El texto va oculto en móvil (`hidden md:inline`), así que sin esto el
      // botón se quedaría sin nombre para un lector de pantalla.
      aria-label={rotulo}
      title={rotulo}
      className={`press flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium transition ${
        available ? "" : "cursor-not-allowed"
      }`}
      style={
        available
          ? {
              background: "color-mix(in srgb, var(--warn) 14%, transparent)",
              borderColor: "color-mix(in srgb, var(--warn) 38%, transparent)",
              color: "var(--warn-ink)",
            }
          : {
              background: "color-mix(in srgb, var(--ink) 4%, transparent)",
              borderColor: "var(--border)",
              color: "var(--ink-faint)",
            }
      }
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4" aria-hidden="true">
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </svg>
      <span className="hidden md:inline">
        {claiming ? "Reclamando…" : available ? "Diaria" : `${hoursLeft}h`}
      </span>
      {streak > 0 && (
        <span
          className="tnum rounded-full px-1.5 py-0.5 text-[10px]"
          style={{ background: "color-mix(in srgb, var(--ink) 10%, transparent)" }}
        >
          ×{streak}
        </span>
      )}
    </button>
  );
}
