"use client";

import { useCallback } from "react";
import { leerAjustes } from "../utils/settings";

export type SoundName =
  | "rasgar"
  | "voltear"
  | "revelacion1"
  | "revelacion2"
  | "revelacion3"
  | "moneda"
  | "tap";

/**
 * Efectos de sonido sintetizados con WebAudio: cero assets que descargar y
 * latencia de milisegundos, que es lo que pide un gesto táctil.
 *
 * El AudioContext es un singleton perezoso que se crea (y se reanuda) DENTRO
 * de la llamada a play: iOS sólo desbloquea el audio si el contexto nace en un
 * gesto del usuario, así que crearlo al montar el hook lo dejaría mudo.
 */
let ctx: AudioContext | null = null;
let ruidoBlanco: AudioBuffer | null = null;

const obtenerCtx = (): AudioContext | null => {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  // Un contexto cerrado (interrupción larga de audio en iOS, error de hardware)
  // ya no reanuda: se descarta para recrearlo en el siguiente gesto. El buffer
  // de ruido va atado a su sampleRate, así que también se reinicia.
  if (ctx && ctx.state === "closed") {
    ctx = null;
    ruidoBlanco = null;
  }
  if (!ctx) {
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  // iOS lo suspende al bloquear la pantalla o al perder el foco.
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
};

/** Un segundo de ruido blanco reutilizable; generarlo por reproducción sería tirar CPU. */
const bufferRuido = (ac: AudioContext): AudioBuffer => {
  if (!ruidoBlanco) {
    const len = Math.floor(ac.sampleRate * 1);
    ruidoBlanco = ac.createBuffer(1, len, ac.sampleRate);
    const datos = ruidoBlanco.getChannelData(0);
    for (let i = 0; i < len; i++) datos[i] = Math.random() * 2 - 1;
  }
  return ruidoBlanco;
};

/**
 * Envolvente estándar: ataque lineal corto y caída exponencial hasta casi
 * cero. Las rampas son obligatorias: cortar una onda a mitad de ciclo mete un
 * click digital muy audible.
 */
const envolvente = (
  g: GainNode,
  t: number,
  dur: number,
  pico: number,
  ataque = 0.01,
) => {
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(pico, t + ataque);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
};

interface TonoOpts {
  tipo?: OscillatorType;
  freq: number;
  freqFin?: number;
  t: number;
  dur: number;
  pico: number;
  ataque?: number;
}

const tono = (ac: AudioContext, salida: AudioNode, o: TonoOpts) => {
  const osc = ac.createOscillator();
  osc.type = o.tipo ?? "sine";
  osc.frequency.setValueAtTime(o.freq, o.t);
  if (o.freqFin) osc.frequency.exponentialRampToValueAtTime(o.freqFin, o.t + o.dur);
  const g = ac.createGain();
  envolvente(g, o.t, o.dur, o.pico, o.ataque);
  osc.connect(g).connect(salida);
  osc.start(o.t);
  osc.stop(o.t + o.dur + 0.05);
};

interface RuidoOpts {
  t: number;
  dur: number;
  tipo?: BiquadFilterType;
  f0: number;
  f1?: number;
  q?: number;
  pico: number;
  ataque?: number;
}

const ruidoFiltrado = (ac: AudioContext, salida: AudioNode, o: RuidoOpts) => {
  const src = ac.createBufferSource();
  src.buffer = bufferRuido(ac);
  src.loop = true;
  const filtro = ac.createBiquadFilter();
  filtro.type = o.tipo ?? "bandpass";
  filtro.frequency.setValueAtTime(o.f0, o.t);
  if (o.f1) filtro.frequency.exponentialRampToValueAtTime(o.f1, o.t + o.dur);
  filtro.Q.value = o.q ?? 0.9;
  const g = ac.createGain();
  envolvente(g, o.t, o.dur, o.pico, o.ataque ?? 0.02);
  src.connect(filtro).connect(g).connect(salida);
  src.start(o.t);
  src.stop(o.t + o.dur + 0.05);
};

/** Nota de campana: fundamental más un armónico agudo apenas insinuado. */
const campanada = (
  ac: AudioContext,
  salida: AudioNode,
  freq: number,
  t: number,
  dur: number,
  pico: number,
  rica = false,
) => {
  tono(ac, salida, { freq, t, dur, pico });
  tono(ac, salida, { freq: freq * 2.005, t, dur: dur * 0.8, pico: pico * 0.28 });
  if (rica) {
    // El tercer parcial da el "cristal" de las revelaciones altas.
    tono(ac, salida, { freq: freq * 3.01, t, dur: dur * 0.6, pico: pico * 0.12 });
  }
};

// Notas de la escala de Do para las campanadas ascendentes.
const C5 = 523.25;
const E5 = 659.25;
const G5 = 783.99;
const C6 = 1046.5;

/**
 * Devuelve play(nombre). Los volúmenes están calibrados a la baja adrede:
 * estos sonidos suenan decenas de veces por sesión y tienen que seguir siendo
 * agradables a la vigésima, no espectaculares a la primera.
 */
export function useSound() {
  return useCallback((nombre: SoundName) => {
    // Los ajustes se leen en cada reproducción: así el silencio o el volumen
    // aplican al instante, sin re-render ni suscripción.
    const aj = leerAjustes();
    if (!aj.sonido || aj.volumen <= 0) return;
    const ac = obtenerCtx();
    if (!ac) return;

    try {
      const master = ac.createGain();
      master.gain.value = 0.9 * aj.volumen;
      master.connect(ac.destination);
      const t = ac.currentTime;

      switch (nombre) {
        case "tap":
          // Tick sutil de interfaz.
          tono(ac, master, { tipo: "triangle", freq: 1750, freqFin: 1400, t, dur: 0.04, pico: 0.08, ataque: 0.004 });
          break;

        case "voltear":
          // Whoosh corto de aire y un pequeño click de cartón al asentarse.
          ruidoFiltrado(ac, master, { t, dur: 0.16, f0: 420, f1: 1600, q: 0.8, pico: 0.22 });
          tono(ac, master, { tipo: "triangle", freq: 1900, t: t + 0.11, dur: 0.05, pico: 0.1, ataque: 0.004 });
          break;

        case "rasgar": {
          // Papel rasgándose: ruido con barrido ascendente y una capa aguda de
          // "grano" para las fibras. El pico llega pronto y decae despacio.
          ruidoFiltrado(ac, master, { t, dur: 0.5, f0: 650, f1: 2600, q: 0.7, pico: 0.4, ataque: 0.03 });
          ruidoFiltrado(ac, master, { t: t + 0.04, dur: 0.44, tipo: "highpass", f0: 2400, f1: 5200, q: 0.6, pico: 0.14 });
          break;
        }

        case "revelacion1":
          campanada(ac, master, C5, t, 0.4, 0.15);
          campanada(ac, master, G5, t + 0.1, 0.45, 0.16);
          break;

        case "revelacion2":
          campanada(ac, master, C5, t, 0.45, 0.15);
          campanada(ac, master, E5, t + 0.09, 0.48, 0.15);
          campanada(ac, master, G5, t + 0.18, 0.55, 0.17, true);
          break;

        case "revelacion3":
          campanada(ac, master, C5, t, 0.5, 0.15, true);
          campanada(ac, master, E5, t + 0.08, 0.5, 0.15, true);
          campanada(ac, master, G5, t + 0.16, 0.55, 0.16, true);
          campanada(ac, master, C6, t + 0.24, 0.55, 0.18, true);
          // Polvo de estrellas al final, casi subliminal.
          ruidoFiltrado(ac, master, { t: t + 0.26, dur: 0.3, tipo: "highpass", f0: 6500, pico: 0.05 });
          break;

        case "moneda":
          // Tintineo clásico en dos notas: golpe corto y resonancia aguda.
          tono(ac, master, { tipo: "triangle", freq: 987.77, t, dur: 0.08, pico: 0.16, ataque: 0.005 });
          tono(ac, master, { tipo: "triangle", freq: 1318.5, t: t + 0.075, dur: 0.38, pico: 0.18, ataque: 0.005 });
          tono(ac, master, { freq: 2637, t: t + 0.075, dur: 0.28, pico: 0.05, ataque: 0.005 });
          break;
      }
    } catch {
      // Un fallo de audio jamás debe romper el gesto que lo disparó.
    }
  }, []);
}
