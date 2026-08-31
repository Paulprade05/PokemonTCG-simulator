"use client";

import { useMemo, type RefObject } from "react";
import { touchActionFor } from "../hooks/useSwipe";
import { formatNumber } from "../utils/format";
import { arteDeSobre, selloCss } from "../utils/sobreArte";

export type FaseSobre = "sellado" | "rasgando" | "abriendo" | "cartas";

/* ------------------------------------------------------------------ */
/* ENVOLTORIO SORTEADO                                                 */
/*                                                                     */
/* Cada sobre trae sus propios pliegues, reflejos y sombras. El sorteo  */
/* es DETERMINISTA a partir de una semilla y se calcula una sola vez    */
/* (useMemo): BoosterPack se re-renderiza tres veces mientras está en   */
/* pantalla (los setFase de la coreografía), y con Math.random() en el  */
/* cuerpo los pliegues saltarían DURANTE el rasgado.                    */
/*                                                                     */
/* Lo de FÁBRICA no se sortea: crimpado, tira, banda y rayado           */
/* lenticular son impresión, idénticos en todos los sobres. La          */
/* variación sólo convence si hay una referencia regular contra la que  */
/* compararla.                                                          */
/*                                                                     */
/* MATIZ QUE AÑADE utils/sobreArte.ts: "idénticos en todos los sobres"  */
/* quiere decir idénticos en todos los sobres DE LA MISMA EXPANSIÓN.    */
/* El color y la textura de impresión son de la expansión y no del      */
/* sorteo: son constantes entre aperturas, y por eso viven en otro      */
/* useMemo con otra dependencia. Lo que se sortea son las arrugas y los */
/* reflejos —el manoseo—, que sí son de este sobre y de ningún otro.    */
/* ------------------------------------------------------------------ */

/** Mulberry32: un PRNG de 32 bits, sin estado global y reproducible. */
function prngSobre(semilla: number) {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Semilla de un sobre concreto (FNV-1a sobre "set#apertura"). El número de
 * apertura entra en la mezcla para que dos sobres seguidos del mismo set no
 * salgan clavados: "otro sobre" trae otro envoltorio.
 */
export function semillaDeSobre(setId: string | null | undefined, apertura: number): number {
  const s = `${setId ?? "?"}#${apertura}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Custom properties del envoltorio.
 *
 * La variable maestra es `--luz`: de dónde viene la luz (-1 izquierda, +1
 * derecha). Manda sobre la inclinación de las arrugas, la posición de los dos
 * reflejos, el peso de cada costura, el sentido del barrido y hacia dónde cae
 * la sombra propia. Dos luces contradictorias es exactamente lo que delata un
 * degradado como degradado.
 */
function derivarSobre(semilla: number): Record<string, string> {
  const r = prngSobre(semilla);
  const ent = (a: number, b: number) => a + r() * (b - a);
  const luz = ent(-1, 1);

  // Barrido: el ancho manda en el recorrido, para que el destello entre y
  // salga del todo sea cual sea. Con --br-w 36% salen -150% y 420%, que es
  // exactamente el recorrido de siempre.
  const brW = ent(30, 42);
  // Sentido del barrido: con la luz a la derecha, el reflejo cruza al revés.
  const x0 = -5400 / brW;
  const x1 = 15120 / brW;

  const vars: Record<string, string> = {
    "--luz": luz.toFixed(3),

    // Arrugas casi verticales: 4 cuartos, una arruga suelta en cada uno.
    "--pl-a1": `${(90 + luz * 5).toFixed(1)}deg`,
    // Familia cruzada a mitad de fuerza: una transversal marcada leería a
    // cartón, no a film.
    "--pl-a2": `${ent(172, 188).toFixed(1)}deg`,

    // Abolladura: el film hundido contra el taco de cartas.
    "--dt-x": `${ent(30, 70).toFixed(1)}%`,
    "--dt-y": `${ent(34, 66).toFixed(1)}%`,

    // Reflejos. Elipses muy aplastadas (el alto es un tercio del ancho): el
    // metalizado estira el reflejo a lo largo del rayado. Círculos = juguete.
    "--gl1-x": `${(50 + luz * 26).toFixed(1)}%`,
    "--gl1-y": `${ent(16, 34).toFixed(1)}%`,
    "--gl1-w": `${ent(28, 44).toFixed(1)}%`,
    "--gl1-h": `${ent(8, 15).toFixed(1)}%`,
    "--gl1-a": ent(0.1, 0.2).toFixed(3),
    "--gl2-x": `${(50 - luz * 20).toFixed(1)}%`,
    "--gl2-y": `${ent(58, 80).toFixed(1)}%`,
    "--gl2-w": `${ent(20, 34).toFixed(1)}%`,
    "--gl2-h": `${ent(6, 12).toFixed(1)}%`,
    "--gl2-a": ent(0.06, 0.13).toFixed(3),

    // Costuras laterales: pesa más la que queda a contraluz.
    "--sm-izq": (0.38 + luz * 0.12).toFixed(3),
    "--sm-der": (0.38 - luz * 0.12).toFixed(3),

    "--br-w": `${brW.toFixed(1)}%`,
    "--br-rot": `${ent(6, 12).toFixed(1)}deg`,
    "--br-dur": `${ent(4.6, 6.8).toFixed(2)}s`,
    // Sin este desfase el destello caería siempre en el mismo instante desde
    // que el sobre entra, que es lo que lo delata como bucle.
    "--br-delay": `${ent(0, 2.2).toFixed(2)}s`,
    "--br-x0": `${(luz >= 0 ? x0 : x1).toFixed(1)}%`,
    "--br-x1": `${(luz >= 0 ? x1 : x0).toFixed(1)}%`,
  };

  // Cada arruga ocupa [x-4, x+5] y los cuartos son 10-21 / 31-42 / 52-63 /
  // 73-84: el final máximo de una (26) queda por debajo del inicio mínimo de
  // la siguiente (27), así que los stops nunca se cruzan.
  for (let i = 0; i < 4; i++) {
    vars[`--pl-x${i + 1}`] = `${(10 + i * 21 + r() * 11).toFixed(1)}%`;
    vars[`--pl-v${i + 1}`] = ent(0.09, 0.2).toFixed(3);
    vars[`--pl-b${i + 1}`] = ent(0.1, 0.24).toFixed(3);
  }
  for (let i = 0; i < 2; i++) {
    vars[`--pl-y${i + 1}`] = `${(24 + i * 34 + r() * 14).toFixed(1)}%`;
    vars[`--pl-w${i + 1}`] = ent(0.05, 0.12).toFixed(3);
    vars[`--pl-z${i + 1}`] = ent(0.05, 0.14).toFixed(3);
  }
  return vars;
}

interface BoosterPackProps {
  fase: FaseSobre;
  /** +1 rasgado hacia la derecha, -1 hacia la izquierda: elige el arco de caída. */
  tearDir: number;
  efectosApagados: boolean;
  /** Sobre entero: recibe el gesto de rasgado y el foco de teclado. */
  sobreRef: RefObject<HTMLDivElement | null>;
  /** Tira: recibe el transform del dedo mientras se arrastra. */
  tiraRef: RefObject<HTMLDivElement | null>;
  /** CARD_WIDTH de la vista: el sobre ocupa la misma ranura que la carta. */
  anchoCarta: string;
  logo?: string;
  nombreSet?: string;
  /**
   * Id de la expansión ("swsh12pt5"). OPCIONAL y hoy nadie lo pasa: el color y
   * la textura del sobre se sacan del id que viene DENTRO de la URL del logo
   * (utils/sobreArte.ts). Existe porque app/page.tsx sí lo tiene a mano
   * (`currentSetObj.id`) y pasarlo convierte una deducción en un dato. Añadirlo
   * aquí no rompe la llamada actual, que es justo lo que se busca: esa pantalla
   * la está tocando otro agente.
   */
  setId?: string;
  /**
   * URL del símbolo del set para el sello impreso. También opcional y por la
   * misma razón: hoy se deriva del logo, pero eso SÓLO funciona cuando el logo
   * viene de pokemontcg.io. Con la app en español el logo lo sirve tcgdex y el
   * sobre se queda sin sello, aunque `currentSetObj.images.symbol` siga estando
   * ahí y siga siendo el inglés (services/idioma.ts `traducirSet` no lo toca).
   */
  simbolo?: string;
  cartas: number;
  /** true justo tras un arrastre: el click sintético que sigue no abre. */
  gestoRef: RefObject<boolean>;
  /** Sorteo del envoltorio: pliegues, reflejos y sombras de ESTE sobre. */
  semilla: number;
  onRasgar: () => void;
}

/**
 * SOBRE DE APERTURA (app/page.tsx, VIEW 3).
 *
 * La coreografía va en @keyframes CSS y no en framer-motion a propósito:
 * sobreviven a los re-renders que la propia secuencia provoca (setFase,
 * setMaxRevealed, fanfarriaEn), no heredan variantes de ningún ancestro y no
 * dependen del `exit` de AnimatePresence, que es exactamente lo que rompía la
 * animación anterior. Los tiempos están calibrados con T_CARTA y T_FIN de
 * app/page.tsx: si tocas uno, mira el otro.
 *
 * Sin filter, sin drop-shadow, sin backdrop-filter, sin mix-blend-mode y sin
 * will-change: el sobre comparte pantalla con la carta y cualquiera de ellos
 * rasterizaría su ilustración.
 *
 * El recorte vive SÓLO en .sobre__cuerpo. Si alguna vez vuelve a aparecer un
 * overflow en .sobre o en .sobre__tapa, la tira deja de verse volar: fue
 * exactamente el bug original.
 *
 * ESTA CADENA ES UNA CONSTANTE Y TIENE QUE SEGUIR SIÉNDOLO. El sobre se parece
 * al de SU expansión (utils/sobreArte.ts), pero eso entra entero por custom
 * properties inline en el elemento: `--sb-a`/`--sb-b` (los dos colores),
 * `--sb-ang`/`--sb-rayado`/`--sb-paso` (el rayado de su era),
 * `--sb-lustre` (cuánta luz devuelve el film) y `--sb-sello` (el símbolo del
 * set). Generar CSS distinto por expansión significaría una cadena nueva —y
 * un `<style>` nuevo que parsear— en cada apertura, con 171 expansiones y
 * subiendo. Si necesitas que algo varíe por set, añade una variable, no una
 * regla.
 */
const CSS = `
.sobre-capa { animation: sobre-entra .42s cubic-bezier(.16,1,.3,1) both; }

/* OJO AL EDITAR: este bloque es un template literal, así que aquí dentro no
   puede aparecer un acento grave ni un \${. Los comentarios de abajo citan
   variables sin comillar por eso, no por descuido.

   Los --sb-* son la IDENTIDAD DE LA EXPANSIÓN (utils/sobreArte.ts) y llegan
   inline en el elemento. Aquí van sus respaldos, y no son un valor cualquiera:
   son EXACTAMENTE los que estaban escritos a mano en las reglas de abajo antes
   de que el sobre se pareciese a su expansión. Un sobre del que no sepamos
   nada —sin logo del que sacar el id— se ve hoy igual que ayer, y eso es lo
   que permite comparar. */
.sobre {
  position: relative; border-radius: 14px; --tapa-h: 48px;
  --sb-a: var(--accent); --sb-b: var(--accent-2);
  --sb-ang: 102deg; --sb-rayado: .55; --sb-paso: 1; --sb-lustre: 1;
  --sb-t1: 30%; --sb-t2: 22%;
}
.sobre[data-fase="sellado"] { animation: sobre-flota 4.2s ease-in-out infinite; }
.sobre[data-fase="sellado"]:active { animation: none; transform: scale(.985); }
/* El balanceo es adorno: con efectos reducidos no se mueve nada. */
.sobre[data-quieto="si"] { animation: none; }

.sobre__cuerpo {
  position: absolute; inset: 0; overflow: hidden;
  border-radius: inherit; border: 1px solid var(--border-strong);
  /* Degradado HORIZONTAL con núcleo claro: es lo que hace que se lea como un
     cilindro de plástico y no como un rectángulo. Los extremos oscuros son
     las costuras laterales del envoltorio.
     El color ya no es el acento del tema sino el de la expansión (--sb-a y
     --sb-b). El NÚCLEO se queda en --surface pase lo que pase: los dos
     radiales tiñen sólo las esquinas (at 50% 0% y at 50% 112%, apagados
     antes del 62%) y el centro es donde va el nombre del set en --ink-soft.
     Si algún día alguien sube --sb-t1 por encima del 42%, ese texto deja de
     leerse; el tope está puesto en utils/sobreArte.ts y explicado allí. */
  background:
    var(--grain),
    radial-gradient(120% 62% at 50% 0%, color-mix(in srgb, var(--sb-a) var(--sb-t1,30%), transparent), transparent 58%),
    radial-gradient(140% 70% at 50% 112%, color-mix(in srgb, var(--sb-b) var(--sb-t2,22%), transparent), transparent 62%),
    linear-gradient(var(--sb-ang,102deg),
      color-mix(in srgb, var(--ink) 20%, var(--surface-2)) 0%,
      color-mix(in srgb, var(--sb-a) 18%, var(--surface)) 18%,
      var(--surface) 50%,
      color-mix(in srgb, var(--sb-b) 14%, var(--surface-2)) 80%,
      color-mix(in srgb, var(--ink) 18%, var(--surface-2)) 100%);
  box-shadow:
    /* Las dos costuras pesan distinto según de dónde venga la luz. */
    inset 12px 0 20px -14px rgba(0,0,0,var(--sm-izq,.45)),
    inset -12px 0 20px -14px rgba(0,0,0,var(--sm-der,.45)),
    inset 0 1px 0 rgba(255,255,255,.22),
    /* Sombra propia al lado CONTRARIO de la luz. El overflow:hidden de esta
       misma regla recorta a sus hijos, nunca a su propia sombra exterior. */
    calc(var(--luz,0) * -7px) 16px 26px -14px rgba(0,0,0,.42),
    var(--shadow-lg);
}
/* El cuerpo espera QUIETO a que la tira salga y la carta empiece a subir
   (0-620ms desde el rasgado); sólo entonces cae. El delay de 620ms casa con
   T_CARTA=420 de app/page.tsx: entre 620 y 1100 el cuerpo baja cruzándose
   con la carta que emerge. Va con forwards y sin both: durante el delay no
   se aplica ningún fotograma y el cuerpo no se mueve. */
.sobre[data-fase="rasgando"] .sobre__cuerpo,
.sobre[data-fase="abriendo"] .sobre__cuerpo { animation: sobre-cuerpo-cae 480ms linear 620ms forwards; }

/* Rayado lenticular: el arcoíris IMPRESO del envoltorio. No se sortea — es de
   fábrica, igual que el crimpado. Cuatro bandas por periodo (tinta, veta de
   acento, hueco y filo blanco) en vez de las dos rayitas grises de antes.
   Lo que SÍ cambia es la fábrica: un sobre de Base es cartón mate con trama
   gruesa (--sb-paso 1.8, --sb-rayado .16) y uno de Escarlata y Púrpura es film
   lenticular fino y brillante (.78 y .74). El periodo se escala entero con
   --sb-paso para que las cuatro bandas mantengan su proporción: multiplicar
   sólo algunas convierte el rayado en cebra. */
.sobre__rayas {
  position: absolute; inset: 0; pointer-events: none; opacity: var(--sb-rayado,.55);
  background: repeating-linear-gradient(var(--sb-ang,102deg),
    transparent 0 calc(var(--sb-paso,1) * 3px),
    color-mix(in srgb, var(--ink) 7%, transparent) calc(var(--sb-paso,1) * 3px) calc(var(--sb-paso,1) * 4px),
    color-mix(in srgb, var(--sb-b) 24%, transparent) calc(var(--sb-paso,1) * 4px) calc(var(--sb-paso,1) * 5px),
    transparent calc(var(--sb-paso,1) * 5px) calc(var(--sb-paso,1) * 6px),
    rgba(255,255,255,.16) calc(var(--sb-paso,1) * 6px) calc(var(--sb-paso,1) * 7px));
}
/* SELLO: el símbolo de la expansión, impreso pequeño en la esquina como en el
   sobre de verdad. Es la única imagen del sobre y ya la servimos (la misma
   carpeta de la que sale el logo, ver utils/sobreArte.ts): no añade ningún
   recurso nuevo al repositorio.

   Va como background-image y NO como <img> a propósito: los símbolos son de un
   host de terceros y, si uno falla, un background roto no pinta nada mientras
   que un <img> roto pinta el icono de imagen partida en mitad del sobre. El
   sello es adorno; su ausencia tiene que ser invisible.

   El disco claro de debajo no es decoración: casi todos los símbolos son
   siluetas negras con transparencia y en tema oscuro desaparecerían. Con
   mix-blend-mode se arreglaría en una línea, pero está prohibido en toda esta
   pantalla (WebKit rasteriza), así que se resuelve como en el sobre real: el
   símbolo va impreso sobre un medallón claro.

   Y va aquí, entre el rayado y los pliegues, porque es TINTA: los pliegues y
   los reflejos del film tienen que pasarle por encima. */
.sobre__sello {
  position: absolute; right: 6%; bottom: 44px; width: 13%; aspect-ratio: 1;
  pointer-events: none; opacity: .5;
  background-image: var(--sb-sello, none),
    radial-gradient(closest-side, rgba(255,255,255,.42), rgba(255,255,255,.10) 68%, transparent 100%);
  background-position: center, center;
  background-size: 66%, 100%;
  background-repeat: no-repeat, no-repeat;
}
html[data-theme="dark"] .sobre__sello { opacity: .66; }
/* PLIEGUES: cada arruga es un par valle (negro) + ceja (blanco) pegado a 1,2%
   del valle — un pliegue real es una sombra con un filo iluminado al lado, no
   una raya oscura. Los valles van en rgba(0,0,0,…) y NO en var(--ink): en
   oscuro --ink es marfil y el valle saldría claro. Una sombra es negra en los
   dos temas; lo único que cambia es cuánta cabe, y de eso se encarga el
   opacity de abajo.
   Escala: con W≈300 el sobre mide 279×419, así que 1% horizontal ≈ 2,8px —
   un valle de 0,5% son 1,4px y una ceja de 1,2% son 3,4px. */
.sobre__pliegues {
  position: absolute; inset: 0; pointer-events: none; opacity: .46;
  background:
    linear-gradient(var(--pl-a1,90deg),
      transparent calc(var(--pl-x1,16%) - 4%),
      rgba(0,0,0,var(--pl-v1,.14)) var(--pl-x1,16%),
      rgba(255,255,255,var(--pl-b1,.16)) calc(var(--pl-x1,16%) + 1.2%),
      transparent calc(var(--pl-x1,16%) + 5%),
      transparent calc(var(--pl-x2,37%) - 4%),
      rgba(0,0,0,var(--pl-v2,.14)) var(--pl-x2,37%),
      rgba(255,255,255,var(--pl-b2,.16)) calc(var(--pl-x2,37%) + 1.2%),
      transparent calc(var(--pl-x2,37%) + 5%),
      transparent calc(var(--pl-x3,58%) - 4%),
      rgba(0,0,0,var(--pl-v3,.14)) var(--pl-x3,58%),
      rgba(255,255,255,var(--pl-b3,.16)) calc(var(--pl-x3,58%) + 1.2%),
      transparent calc(var(--pl-x3,58%) + 5%),
      transparent calc(var(--pl-x4,79%) - 4%),
      rgba(0,0,0,var(--pl-v4,.14)) var(--pl-x4,79%),
      rgba(255,255,255,var(--pl-b4,.16)) calc(var(--pl-x4,79%) + 1.2%),
      transparent calc(var(--pl-x4,79%) + 5%)),
    linear-gradient(var(--pl-a2,180deg),
      transparent calc(var(--pl-y1,30%) - 5%),
      rgba(0,0,0,var(--pl-w1,.08)) var(--pl-y1,30%),
      rgba(255,255,255,var(--pl-z1,.09)) calc(var(--pl-y1,30%) + 1.2%),
      transparent calc(var(--pl-y1,30%) + 6%),
      transparent calc(var(--pl-y2,64%) - 5%),
      rgba(0,0,0,var(--pl-w2,.08)) var(--pl-y2,64%),
      rgba(255,255,255,var(--pl-z2,.09)) calc(var(--pl-y2,64%) + 1.2%),
      transparent calc(var(--pl-y2,64%) + 6%)),
    radial-gradient(58% 34% at var(--dt-x,50%) var(--dt-y,50%), rgba(0,0,0,.15), transparent 72%);
}
html[data-theme="dark"] .sobre__pliegues { opacity: .66; }
/* REFLEJOS: capa PROPIA y por ENCIMA del rayado. Meterlos en el background del
   cuerpo los dejaría DEBAJO de la impresión, que es al revés de como funciona
   un envoltorio: la tinta va bajo el film y el reflejo, sobre él. Y aparte de
   los pliegues, porque su opacity por tema los dejaría en nada.

   El sorteo decide DÓNDE caen los reflejos y la era decide CUÁNTO devuelven:
   --sb-lustre multiplica las dos alfas. Un sobre de cartón de 1999 no brilla
   como uno de film metalizado, y ésa es la diferencia que se ve antes que el
   color. El multiplicador va dentro del alfa con calc() y no en un opacity de
   la capa entera porque el opacity de .sobre__pliegues ya está repartido por
   tema y no quiero dos escalas peleándose sobre el mismo píxel. */
.sobre__luces {
  position: absolute; inset: 0; pointer-events: none;
  background:
    radial-gradient(var(--gl1-w,36%) var(--gl1-h,11%) at var(--gl1-x,50%) var(--gl1-y,24%),
      rgba(255,255,255,calc(var(--gl1-a,.15) * var(--sb-lustre,1))), transparent 70%),
    radial-gradient(var(--gl2-w,26%) var(--gl2-h,9%) at var(--gl2-x,50%) var(--gl2-y,70%),
      rgba(255,255,255,calc(var(--gl2-a,.09) * var(--sb-lustre,1))), transparent 72%);
}
/* Barrido de reflejo. transform, no background-position: lo lleva el
   compositor. Dos crestas y no una: un reflejo real sobre film metalizado
   rebota dos veces (el filo y el cuerpo del pliegue).
   El opacity por era es el mismo --sb-lustre de los reflejos fijos: si el
   sobre es mate, el barrido tiene que ser mate también. Por encima de 1 el
   navegador recorta a 1, así que las eras brillantes se quedan en el barrido
   de siempre y sólo las mates lo apagan — que es justo el reparto que se
   quiere: nadie echa de menos MÁS destello. */
.sobre__brillo {
  position: absolute; top: -25%; bottom: -25%; left: 0; width: var(--br-w,36%); pointer-events: none;
  opacity: var(--sb-lustre,1);
  background: linear-gradient(100deg, transparent 0%,
    rgba(255,255,255,.09) 30%,
    rgba(255,255,255,.30) 46%,
    rgba(255,255,255,.07) 53%,
    rgba(255,255,255,.20) 61%,
    transparent 100%);
  animation: sobre-brillo var(--br-dur,5.5s) cubic-bezier(.45,0,.2,1) var(--br-delay,0s) infinite;
}
/* Interior del sobre, a la vista en cuanto la tira empieza a despegarse. */
.sobre__boca {
  position: absolute; top: 0; left: 0; right: 0; height: var(--tapa-h);
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--bg) 92%, #000) 0%,
    color-mix(in srgb, var(--bg) 60%, transparent) 100%);
  box-shadow: inset 0 -10px 16px -6px rgba(0,0,0,.5);
}
/* Pie impreso del sobre. */
.sobre__banda {
  position: absolute; left: 0; right: 0; bottom: 0; padding: 9px 0; text-align: center;
  font-size: 10px; font-weight: 700; letter-spacing: .28em; text-transform: uppercase;
  color: var(--ink-soft); border-top: 1px solid var(--border);
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--ink) 10%, transparent),
    color-mix(in srgb, var(--ink) 4%, transparent));
}

/* --- TAPA: crimpado + tira + perforación. SIN overflow: tiene que salirse. --- */
.sobre__tapa { position: absolute; top: 0; left: 0; right: 0; height: var(--tapa-h); z-index: 2; }
.sobre[data-fase="rasgando"] .sobre__tapa,
.sobre[data-fase="abriendo"] .sobre__tapa { pointer-events: none; }
.sobre[data-fase="rasgando"] .sobre__tapa--der,
.sobre[data-fase="abriendo"] .sobre__tapa--der { animation: sobre-tapa-der 460ms linear forwards; }
.sobre[data-fase="rasgando"] .sobre__tapa--izq,
.sobre[data-fase="abriendo"] .sobre__tapa--izq { animation: sobre-tapa-izq 460ms linear forwards; }

.sobre__tapa-dedo {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  border-radius: 14px 14px 0 0; overflow: hidden; /* recorta SU contenido, no a sí misma */
}
/* Crimpado real: estrías verticales finas, no dientes de sierra. */
.sobre__crimpado {
  height: 7px; flex: none;
  background:
    repeating-linear-gradient(90deg, color-mix(in srgb, var(--ink) 22%, transparent) 0 2px, transparent 2px 5px),
    color-mix(in srgb, var(--surface-2) 90%, var(--ink));
}
/* La tira SÍ toma el color de la expansión y el crimpado de arriba NO: en un
   sobre real la tira de apertura va impresa con el mismo arte y el crimpado es
   el aluminio del sellado, plateado en todas las expansiones. Es la misma
   frontera que ya separaba lo sorteado de lo de fábrica. */
.sobre__tira {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 10px;
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--sb-a) 34%, var(--surface-2)),
    color-mix(in srgb, var(--sb-a) 14%, var(--surface-2)));
  border-bottom: 2px dashed var(--border-strong); /* la perforación */
  box-shadow: inset 0 1px 0 rgba(255,255,255,.2);
}

@keyframes sobre-entra  { from { opacity:0; transform: translate3d(0,16px,0) scale(.94); } to { opacity:1; transform:none; } }
@keyframes sobre-flota  { 0%,100% { transform: translate3d(0,0,0); } 50% { transform: translate3d(0,-5px,0); } }
/* El recorrido sale del ancho de la tira (--br-x0/x1 ya vienen calculados):
   entra y sale del sobre por completo sea cual sea el ancho sorteado, y con
   la luz a la derecha cruza en sentido contrario. */
@keyframes sobre-brillo {
  0%       { transform: translate3d(var(--br-x0,-150%),0,0) rotate(var(--br-rot,9deg)); }
  55%,100% { transform: translate3d(var(--br-x1,420%),0,0) rotate(var(--br-rot,9deg)); }
}

/* El "peso" va en la POSICIÓN de los fotogramas, no en curvas por tramo: con
   linear el arco sale idéntico en todos los motores. Sube corto (el impulso
   de la mano) y cae largo y acelerando (la gravedad). */
@keyframes sobre-tapa-der {
  0%   { transform: translate3d(0,0,0) rotate(0deg);          opacity: 1; }
  22%  { transform: translate3d(24px,-28px,0) rotate(6deg);   opacity: 1; }
  55%  { transform: translate3d(74px,24px,0) rotate(19deg);   opacity: 1; }
  80%  { transform: translate3d(112px,110px,0) rotate(31deg); opacity: .8; }
  100% { transform: translate3d(140px,222px,0) rotate(44deg); opacity: 0; }
}
@keyframes sobre-tapa-izq {
  0%   { transform: translate3d(0,0,0) rotate(0deg);            opacity: 1; }
  22%  { transform: translate3d(-24px,-28px,0) rotate(-6deg);   opacity: 1; }
  55%  { transform: translate3d(-74px,24px,0) rotate(-19deg);   opacity: 1; }
  80%  { transform: translate3d(-112px,110px,0) rotate(-31deg); opacity: .8; }
  100% { transform: translate3d(-140px,222px,0) rotate(-44deg); opacity: 0; }
}
/* Respingo corto (el único: el cuerpo ya no se mueve en "rasgando") y caída
   acelerada dibujada en POSICIONES: cada tramo recorre más que el anterior.
   Mientras el cuerpo cae, la carta sube por la boca y vuelve a asentarse
   (keyframes y:[0,-90,0] en app/page.tsx): se cruzan y el relevo no deja
   hueco ni deja nunca a la carta asomando por debajo del sobre. */
@keyframes sobre-cuerpo-cae {
  0%   { transform: translate3d(0,0,0) scale(1);         opacity: 1; }
  18%  { transform: translate3d(0,-6px,0) scale(1.01);   opacity: 1; }
  40%  { transform: translate3d(0,14px,0) scale(1);      opacity: 1; }
  62%  { transform: translate3d(0,56px,0) scale(.98);    opacity: .92; }
  82%  { transform: translate3d(0,112px,0) scale(.955);  opacity: .55; }
  100% { transform: translate3d(0,170px,0) scale(.93);   opacity: 0; }
}
`;

export default function BoosterPack({
  fase,
  tearDir,
  efectosApagados,
  sobreRef,
  tiraRef,
  anchoCarta,
  logo,
  nombreSet,
  setId,
  simbolo,
  cartas,
  gestoRef,
  semilla,
  onRasgar,
}: BoosterPackProps) {
  // Una sola vez por sobre: durante el rasgado hay tres re-renders (setFase) y
  // los pliegues no pueden re-sortearse a mitad de la coreografía.
  const film = useMemo(() => derivarSobre(semilla), [semilla]);
  /*
   * IDENTIDAD DE LA EXPANSIÓN: color, textura de impresión y sello.
   *
   * Depende del SET y no de la semilla, y por eso va en su propio useMemo: la
   * semilla cambia en cada apertura (lleva dentro el número de sobre) y el
   * sobre de Escarlata y Púrpura tiene que ser el mismo rojo en la apertura
   * número uno y en la número cuarenta. Abrir diez sobres seguidos del mismo
   * set recalcula esto UNA vez.
   */
  const arte = useMemo(() => arteDeSobre(logo, nombreSet, setId), [logo, nombreSet, setId]);
  /*
   * El símbolo explícito manda sobre el deducido de la URL del logo: cuando
   * page.tsx lo pase, esta línea deja de adivinar sin tocar nada más.
   *
   * Se guarda el VALOR CSS ya montado y no la URL, porque es el valor el que
   * decide si el sello se pinta: `selloCss` devuelve null para cualquier URL
   * que no se pueda meter en un url() sin riesgo, y montar el <div> con una
   * imagen que no va a cargar dejaría el medallón claro solo, flotando en una
   * esquina del sobre sin símbolo dentro.
   */
  const sello = useMemo(() => selloCss(simbolo ?? arte.sello), [simbolo, arte.sello]);
  return (
    <div
      // z-50 SIEMPRE (la carta va a z-40): durante la emergencia el sobre
      // pinta POR ENCIMA de la carta, que sube desde detrás del cuerpo — esa
      // oclusión ES el truco, sin clipping. Fijo y sin cambios por fase: un
      // salto de z a mitad de animación se nota. La capa vive en la zona
      // flex-1, así que no solapa cabecera ni pie; la tira al volar sí pasa
      // por encima del pie (z-20) y es deseable: es física.
      className={`absolute inset-0 z-50 flex items-center justify-center px-4${
        efectosApagados ? "" : " sobre-capa"
      }`}
      // Mientras el sobre cae ya no acepta toques: los tiene que recibir la
      // carta que está emergiendo detrás.
      style={{ pointerEvents: fase === "sellado" ? "auto" : "none" }}
    >
      {/* El bloque va aquí y no en globals.css porque estas reglas sólo existen
          mientras el sobre está en pantalla y no definen ningún token. */}
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <div
        ref={sobreRef}
        // Sólo es un control mientras se puede rasgar. Durante la caída sigue
        // en el DOM ~700ms y, con rol y etiqueta puestos, el lector de pantalla
        // anunciaba "Rasgar y abrir el sobre" a la vez que la carta que ya
        // había salido, sobre un botón que tornRef ya no deja disparar.
        role={fase === "sellado" ? "button" : undefined}
        tabIndex={fase === "sellado" ? 0 : -1}
        aria-label={fase === "sellado" ? "Rasgar y abrir el sobre" : undefined}
        onClick={() => {
          // El click sintético tras un arrastre de la tira no debe contar como
          // toque de apertura.
          if (gestoRef.current) return;
          onRasgar();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onRasgar();
          }
        }}
        className="sobre cursor-pointer select-none"
        data-fase={fase}
        data-quieto={efectosApagados ? "si" : undefined}
        style={{
          // El sorteo va PRIMERO: son custom properties que heredan todas las
          // capas del sobre, nunca propiedades de caja.
          ...film,
          // Y la identidad de la expansión detrás, por el mismo motivo. Las dos
          // familias de variables no se pisan (`--sb-*` contra `--pl-`/`--gl-`/
          // `--br-`/`--sm-`/`--dt-`/`--luz`) y esto es TODO lo que cambia entre
          // el sobre de una expansión y el de otra: el bloque CSS de arriba es
          // una constante, la misma cadena para las 171.
          ...arte.vars,
          ...(sello ? { "--sb-sello": sello } : null),
          // 0.93 con 2.5/3.76 da 1.399·W de alto = el alto exacto de la carta:
          // el sobre ocupa su misma ranura y la carta sale del mismo hueco.
          width: `calc(${anchoCarta} * 0.93)`,
          aspectRatio: "2.5 / 3.76",
          // El arrastre vale en TODO el sobre, no sólo en la tira: apuntar a
          // una franja de 48px con el dedo es puntería fina.
          touchAction: touchActionFor("x"),
        }}
      >
        {/* CUERPO — aquí vive el overflow-hidden, no en .sobre */}
        <div className="sobre__cuerpo">
          <div className="sobre__rayas" aria-hidden="true" />
          {/* El sello va pegado al rayado y por DEBAJO de pliegues y reflejos:
              es tinta impresa, no un adorno encima del film. Sólo se monta si
              hay símbolo con el que pintarlo (ver `sello` arriba). */}
          {sello && <div className="sobre__sello" aria-hidden="true" />}
          {/* Pliegues y reflejos NO se mueven: reducir efectos no es reducir
              detalle, así que se pintan también con efectosApagados. Se
              rasterizan una vez al montar y no cuestan nada después. */}
          <div className="sobre__pliegues" aria-hidden="true" />
          <div className="sobre__luces" aria-hidden="true" />
          {!efectosApagados && <div className="sobre__brillo" aria-hidden="true" />}
          {/* Boca: el interior que queda a la vista al despegarse la tira.
              Pintada siempre; mientras arrastras se va destapando por el borde. */}
          <div className="sobre__boca" aria-hidden="true" />

          <div className="absolute inset-x-0 top-12 bottom-9 flex flex-col items-center justify-center gap-3 px-6">
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logo}
                alt=""
                decoding="async"
                className="max-h-[46%] max-w-[86%] object-contain"
              />
            ) : (
              <span className="text-lg font-bold text-center">{nombreSet}</span>
            )}
            {logo && (
              <span className="text-xs font-semibold ink-soft text-center">{nombreSet}</span>
            )}
          </div>

          <div className="sobre__banda">{formatNumber(cartas)} cartas</div>
        </div>

        {/* TAPA — HERMANA del cuerpo. El vuelo va en .sobre__tapa (keyframe) y
            el desplazamiento del dedo en .sobre__tapa-dedo (transform inline):
            así la tira despega exactamente desde donde la dejó el dedo. */}
        <div className={`sobre__tapa ${tearDir < 0 ? "sobre__tapa--izq" : "sobre__tapa--der"}`}>
          <div ref={tiraRef} className="sobre__tapa-dedo touch-target">
            <div className="sobre__crimpado" aria-hidden="true" />
            <div className="sobre__tira">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 ink-faint shrink-0">
                <path d="m11 17-5-5 5-5M18 17l-5-5 5-5" />
              </svg>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 ink-faint shrink-0">
                <path d="m6 17 5-5-5-5M13 17l5-5-5-5" />
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
