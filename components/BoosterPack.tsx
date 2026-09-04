"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { touchActionFor } from "../hooks/useSwipe";
import { formatNumber } from "../utils/format";
import {
  PREFIJO_ARTE_REMOTO,
  arteDeSobre,
  ilustracionDeSobre,
  selloCss,
} from "../utils/sobreArte";
// El recorte de una foto cruda se calcula con la MISMA función que usan el cron
// y el script para decidir qué fotos valen. Que la forma de la imagen y la
// forma que le da el CSS salgan del mismo sitio es lo que impide que un día
// dejen de cuadrar.
import { tamanoDeFondo } from "../services/sobresEmparejar";

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

/* ------------------------------------------------------------------ */
/* LA FOTO DEL SOBRE: DÓNDE SE RASGA Y CÓMO ENCAJA                     */
/*                                                                     */
/* Estas tres constantes son TODO lo que hay que mover si un día las    */
/* ilustraciones cambian de proporción o de encuadre. Están juntas y    */
/* con nombre a propósito: repartidas por el CSS, la línea de rasgado   */
/* acabaría escrita en dos sitios que un día no cuadran.                */
/* ------------------------------------------------------------------ */

/**
 * DÓNDE SE RASGA. Es el alto de la tapa en modo foto, o sea la línea por la
 * que se parte la ilustración: lo de arriba vuela y lo de abajo cae.
 *
 * El número sale de MIRAR la imagen (public/sobres/me5/1.webp, 780x1426), no
 * de copiar los 48px del sobre dibujado:
 *
 *     0,0% -  1,3%   franja negra del sellado
 *     1,3% -  4,7%   crimpado: la banda estriada, en relieve
 *     5,4% -  9,5%   la insignia "6+"
 *    11,9%           empiezan las letras amarillas de POKÉMON
 *
 * O sea que la única franja limpia del sobre está entre el crimpado y la
 * insignia, y ahí es donde se corta: 5,2% cae a 74px del borde, siete píxeles
 * por debajo del crimpado y tres por encima de la insignia. Es además donde se
 * rasga un sobre de verdad —por el sellado, no por la mitad del logo—, y por
 * eso generaliza a las expansiones que vengan: el crimpado está en el mismo
 * sitio en todos los sobres de Pokémon, mientras que la insignia y la posición
 * del logo cambian por época.
 *
 * OJO: la tapa del sobre dibujado (0,168 del ancho: 48px en el dibujo
 * original de 286, un 9% del alto de hoy) cae EN MITAD del logo. No es un
 * descuido de aquel diseño —allí no hay logo impreso, el logo es un <img>
 * centrado más abajo—, pero copiarla aquí partiría POKÉMON por la mitad.
 *
 * Va en porcentaje y no en px porque el alto del sobre depende del viewport:
 * con 48px fijos la tapa se lleva el 9,5% de la ilustración en una tablet y el
 * 13% en un móvil estrecho, y la línea de rasgado se pasearía por encima del
 * dibujo. `--tapa-h` admite porcentaje sin tocar nada: sus dos usos
 * (`.sobre__tapa` y `.sobre__boca`) cuelgan de cajas con alto definido.
 */
const CORTE_ARTE = "5.2%";

/**
 * Proporción del sobre (780x1426 = 1,8282 de alto por ancho). Es la de las
 * fotos de public/sobres, recortadas a ese tamaño exacto por sharp, y la
 * mediana de las 367 del manifiesto cae en 1,8286: la misma a tres decimales.
 * Se le da al CONTENEDOR para que el hueco y la foto sean la misma caja: así
 * no hay ni bandas vacías a los lados ni recorte por abajo.
 *
 * Y ES LA MISMA EN LOS DOS MODOS, foto y dibujado. Hasta ahora el mismo objeto
 * tenía tres proporciones distintas (2,5/3,76 dibujado, 780/1426 con foto, y
 * la de la carta cuando la foto fallaba) y cambiaba de forma al llegar la
 * imagen. Ahora la caja se sabe sin red y no vuelve a cambiar.
 */
const RATIO_SOBRE = "780 / 1426";

/**
 * EL ANCHO DEL SOBRE ES EL DE LA CARTA, y por qué eso es lo correcto.
 *
 * Un sobre de Pokémon de verdad mide 63 mm de ancho, EXACTAMENTE lo que mide
 * la carta que lleva dentro (63x88), y unos 110-115 mm de alto: 1,78-1,83 de
 * alto por ancho, que es la proporción de las fotos. El comentario que hubo
 * aquí decía que "un sobre es más estrecho que la carta" y era falso; con ese
 * criterio el sobre medía 0,765 anchos de carta (235 px en el iPhone contra
 * 307 de carta) y al emerger, la carta —un 30% MÁS ANCHA que el sobre— asomaba
 * 36 px por cada lado antes de que nadie la hubiera sacado. Con el ancho de la
 * carta, la carta sale de DENTRO del sobre.
 *
 * LO QUE LIMITA ES EL ALTO. Con 1,83 de proporción, un sobre tan ancho como la
 * carta mide 1,83 anchos de alto, y en un PC apaisado eso no cabe: la zona
 * central (app-height menos insets, cabecera de 56 px, pie de 96 px y 20 px de
 * aire: los MISMOS 172 px que descuenta CARD_WIDTH en app/page.tsx) mide 628 px
 * a 1280x800, y una carta de 360 pediría un sobre de 658. Así que el ancho es
 * el de la carta O el que quepa en el hueco vertical, lo que sea menor:
 *
 *     min(anchoCarta, (app-height - sat - sab - 172px) * 780 / 1426)
 *
 *   · iPhone 375x812 (sat 47, sab 34): 305,7 x 559. El hueco vertical manda
 *     por 2 px (la carta mide 307,5): el sobre es el 99,4% del ancho de la
 *     carta y deja los 20 px de aire de CARD_WIDTH, diez arriba y diez abajo.
 *   · PC 1280x800: 343,5 x 628, el 95% del ancho de la carta (360 x 504).
 *
 * Los 172 px se escriben aquí y no se importan de app/page.tsx porque allí no
 * están como constante: CARD_WIDTH es una cadena. Si un día cambian la
 * cabecera o el pie, hay que tocar los dos sitios; por eso el número va con
 * nombre y con su desglose.
 *
 * Es el mismo criterio que rige para la carta —ancho tope, y lo que quepa en
 * vertical— y por eso los dos objetos ocupan la misma ranura y se mueven con
 * la barra dinámica de Safari a la vez.
 */
const RESERVA_VERTICAL = "172px";
function anchoDeSobre(anchoCarta: string): string {
  return `min(${anchoCarta}, calc((var(--app-height) - var(--sat) - var(--sab) - ${RESERVA_VERTICAL}) * 780 / 1426))`;
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
  /** CARD_WIDTH de la vista: el sobre es tan ancho como la carta, o lo que
   *  quepa en el hueco vertical si es menos (ver anchoDeSobre). */
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
   * Cuántas fotos de sobre tiene esta expansión en `set_pack_art`, la tabla que
   * llena el cron nocturno (services/sobresIngest.ts).
   *
   * ES LA PIEZA QUE VISTE A LA EXPANSIÓN RECIÉN SALIDA. El manifiesto estático
   * (src/data/sobres.json) viaja en el bundle y sólo puede saber de las
   * expansiones que existían al desplegar; el cron mete expansiones nuevas cada
   * noche, así que la más nueva —la que más se abre— llegaba SIEMPRE sin foto
   * hasta que una persona ejecutaba el script a mano. Con esto, deja de hacer
   * falta esa persona.
   *
   * VIAJA COMO PROP Y NO COMO OTRO IMPORT porque un import se resuelve al
   * compilar y esta tabla cambia después. Llega desde `getSetsFromDB`, que ya
   * pasaba por app/page.tsx, y sólo hace falta un entero: las URLs las compone
   * `ilustracionDeSobre` con `setId` y el número de variante.
   *
   * EL MANIFIESTO ESTÁTICO SIGUE MANDANDO cuando tiene entrada, así que las 130
   * expansiones que ya tenían foto no cambian de comportamiento por esto.
   */
  variantesSobre?: number;
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
 * `--sb-lustre` (cuánta luz devuelve el film), `--sb-sello` (el símbolo del
 * set) y `--sb-arte` (la foto del sobre real, si la hay: las reglas que la
 * usan están abajo y son también las mismas para todas, encendidas con
 * data-arte). Generar CSS distinto por expansión significaría una cadena nueva —y
 * un `<style>` nuevo que parsear— en cada apertura, con 171 expansiones y
 * subiendo. Si necesitas que algo varíe por set, añade una variable, no una
 * regla.
 */
const CSS = `
/* Entrada de la capa entera. Sólo opacity y translate: esta capa es ANCESTRO
   del sobre y de su foto, y un scale aquí —aunque dure 420 ms— la rasteriza
   justo mientras la foto llega (150-750 ms tras montar). */
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
/* LAS MEDIDAS DEL SOBRE DIBUJADO VAN EN FRACCIONES DE SU ANCHO (--sobre-w, la
   misma expresión que su width, puesta inline). El dibujo se hizo para un
   sobre de 286 px de ancho y llevaba sus medidas en px: 48 de tapa, 7 de
   crimpado, 10 de letra en la banda... Desde que el sobre mide lo que la carta
   (306 px en el iPhone, 343 en el PC) esos px fijos se quedaban pequeños y
   no crecían con él. Cada fracción de abajo es el px de entonces entre 286,
   así que en un sobre de 286 el dibujo sale clavado al de antes. */
.sobre {
  position: relative; border-radius: 14px; --tapa-h: calc(var(--sobre-w) * .168);
  --sb-a: var(--accent); --sb-b: var(--accent-2);
  --sb-ang: 102deg; --sb-rayado: .55; --sb-paso: 1; --sb-lustre: 1;
  --sb-t1: 30%; --sb-t2: 22%;
  transition: translate .16s ease-out;
}
.sobre[data-fase="sellado"] { animation: sobre-flota 4.2s ease-in-out infinite; }
/* Al agarrarlo el balanceo se PAUSA, no se corta: con animation:none el sobre
   saltaba en seco desde donde estuviera (hasta 4 px) a su sitio. Y el
   hundimiento es un translate de 2 px, no la escala a .985 que había: una
   escala sobre el sobre —y el arrastre de la tira lo mantiene :active todo el
   gesto— hace que WebKit rasterice la foto a otro tamaño y se vea borrosa
   justo mientras la miras. Va por la propiedad translate y no por transform
   porque transform lo tiene la animación, que manda sobre la regla aunque
   esté en pausa. */
.sobre[data-fase="sellado"]:active { animation-play-state: paused; translate: 0 2px; }
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
/* El cuerpo espera QUIETO mientras la tira sale (0-420 ms desde el rasgado) y
   empieza a bajar EN EL MISMO INSTANTE en que la carta monta y sube: el delay
   de 420 ms ES T_CARTA de app/page.tsx. Antes esperaba hasta 620 y caía en
   480; ahora arranca 200 ms antes y tarda 680, y termina donde terminaba
   (420 + 680 = 1100, que es lo que T_FIN espera). Los primeros 200 ms son un
   descenso lento —el sobre que baja en la mano mientras la otra tira de la
   carta— y el resto la caída de siempre. Ese descenso es lo que deja ver la
   carta: el sobre es ahora 130 px más alto que ella y, si se quedara quieto,
   una subida de 90 px sólo asomaría 26 (ver sobre-cuerpo-cae, abajo).
   Va con forwards y sin both: durante el delay no se aplica ningún fotograma
   y el cuerpo no se mueve. */
.sobre[data-fase="rasgando"] .sobre__cuerpo,
.sobre[data-fase="abriendo"] .sobre__cuerpo { animation: sobre-cuerpo-cae 680ms linear 420ms forwards; }

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
  position: absolute; right: 6%; bottom: calc(var(--sobre-w) * .154); width: 13%; aspect-ratio: 1;
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
   Escala: en el iPhone el sobre mide 306×559, así que 1% horizontal ≈ 3,1px —
   un valle de 0,5% son 1,5px y una ceja de 1,2% son 3,7px. */
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
  /* backwards ES LO QUE ARREGLA "el brillo sale estático y luego se anima".
     --br-delay sortea hasta 2,2 s de espera y, sin fill-mode, durante esa
     espera no se aplica NINGÚN fotograma: la banda se pintaba con su estilo
     base —left:0, quieta, a plena opacidad, encima del sobre— y al acabar el
     delay saltaba de golpe fuera del sobre para empezar el barrido. Con
     backwards, durante el delay se aplica el 0%, que ya está fuera. */
  animation: sobre-brillo var(--br-dur,5.5s) cubic-bezier(.45,0,.2,1) var(--br-delay,0s) infinite backwards;
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
  position: absolute; left: 0; right: 0; bottom: 0; padding: calc(var(--sobre-w) * .031) 0; text-align: center;
  font-size: calc(var(--sobre-w) * .035); font-weight: 700; letter-spacing: .28em; text-transform: uppercase;
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
  height: calc(var(--sobre-w) * .0245); flex: none;
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

/* ==================================================================
   LA FOTO DEL SOBRE

   Cuando la expansión tiene ilustración de verdad, estas reglas cambian
   el DIBUJO por la FOTO. No sustituyen a lo de arriba: lo apagan por
   encima. Se encienden con data-arte="si", que el componente sólo pone
   cuando la imagen ya está descargada y descomprimida, así que hasta
   ese momento —y en las ~170 expansiones que no tienen foto, que son el
   caso normal— no se aplica ni una sola de ellas.

   EL RASGADO ES EL PROBLEMA. La tapa vuela y el cuerpo cae, o sea que
   la ilustración tiene que vivir en DOS elementos que se separan. Se
   pinta la MISMA imagen en los dos, con la misma regla de tamaño
   (100% auto: el ancho es el del sobre y el alto el que le toque por su
   proporción) y anclada arriba en los dos (50% 0). Como la tapa y el
   cuerpo miden lo mismo de ancho y los dos arrancan en el borde de
   arriba del sobre, los dos trozos de imagen caen EN EL MISMO SITIO: la
   tapa enseña la tira de arriba, el cuerpo enseña la imagen entera y de
   ella sólo se ve lo que la tapa no tapa. Sellado se lee como una sola
   imagen; al rasgar, cada mitad se lleva su trozo.

   POR QUÉ auto Y NO UN PORCENTAJE en vertical: un porcentaje se
   calcularía contra el alto de CADA elemento, y el de la tapa (--tapa-h)
   no es el del cuerpo (el sobre entero), así que habría que escribir dos
   números distintos y mantenerlos a mano. Con auto manda la proporción
   del fichero, que es la misma imagen en los dos: si mañana una
   expansión trae una foto más alta, los dos elementos la escalan igual
   y la costura sigue sin verse.

   Y POR QUÉ EL ANCHO YA NO ES SIEMPRE 100%, que es lo único que ha
   cambiado aquí. Las fotos de public/sobres vienen recortadas a 780/1426
   EXACTOS por sharp, así que "100% auto" las encaja clavadas. Las que
   trae el cron nocturno NO: llegan crudas de la wiki con la proporción
   que tengan, y ahí sharp no está —no es dependencia de este proyecto y
   meter un binario nativo en una función serverless por un recorte es
   desproporcionado—. El recorte lo hace esta línea.

   LA TENTACIÓN ERA PONER "cover" EN LAS DOS REGLAS Y ES UN ERROR, porque
   "cover" se calcula POR ELEMENTO y estas dos cajas no tienen la misma
   proporción: el cuerpo mide W x 1,8282·W y la tapa W x 0,0951·W. Con una
   foto de r = alto/ancho, el cuerpo escala por ancho sólo si r >= 1,8282
   y la tapa escala por ancho SIEMPRE. O sea que con cualquier foto más
   chata que 1,8282 las dos mitades pintarían la misma imagen a DOS
   TAMAÑOS DISTINTOS, y el desajuste cae justo en la línea de rasgado, que
   es donde este comentario lleva quince líneas diciendo que la costura no
   se puede ver. Medido: a r = 1,75 son un 4,5% de diferencia; a r = 1,65
   —que el filtro de services/sobresEmparejar.ts ACEPTA— un 11%, con el
   crimpado descuadrado a ojo. Y no es un caso raro: de las 481 candidatas
   que hay hoy en la caché del script, 161 están por debajo de 1,8282 en
   crudo.

   Lo que sí vale es un ANCHO EXPLÍCITO, el mismo para las dos cajas —que
   miden lo mismo de ancho—, con el que las dos reproducen el resultado
   que "cover" daría en el cuerpo. Ese número lo calcula "tamanoDeFondo"
   (services/sobresEmparejar.ts) y llega por --sb-arte-size.

   EL VALOR POR DEFECTO ES LA REGLA DE SIEMPRE, literalmente la misma
   cadena. Las 130 expansiones con foto estática NO EMITEN la variable
   —el componente sólo la pone para las fotos crudas— así que su pintado
   no cambia ni en una milésima. Y una foto remota que ya venga con
   r >= 1,8282 tampoco la emite, porque en ese caso el cálculo da 100%.

   DÓNDE CORTA: en --tapa-h, que en modo foto vale CORTE_ARTE (la
   constante de arriba, con las mediciones). No hay una segunda constante
   de corte porque la línea de rasgado y el alto de la tapa SON la misma
   cosa; tenerlas separadas sería garantizar que un día no cuadran.
   ================================================================== */
.sobre[data-arte="si"] .sobre__cuerpo {
  /* Sin borde. background-origin es padding-box, así que 1px de borde
     mete la imagen 1px hacia dentro mientras la tapa —que no tiene
     borde— la pinta desde el 0: un píxel basta para que se vea la
     costura entre las dos mitades. */
  border: 0;
  background: var(--sb-arte) 50% 0 / var(--sb-arte-size, 100% auto) no-repeat;
  /* Se queda la sombra propia (la que sigue a la luz del sorteo) y se
     van las interiores: las costuras laterales del envoltorio ya están
     FOTOGRAFIADAS, y pintarlas encima las duplica. */
  box-shadow:
    calc(var(--luz,0) * -7px) 16px 26px -14px rgba(0,0,0,.42),
    var(--shadow-lg);
}
.sobre[data-arte="si"] .sobre__tapa-dedo {
  background: var(--sb-arte) 50% 0 / var(--sb-arte-size, 100% auto) no-repeat;
  /* El .touch-target de la tira reserva 44px de alto para el dedo, y la
     tapa en modo foto mide bastante menos (5,2% del sobre: 29px en el
     iPhone, 33 en el PC). Sin esto el dedo sobresale por debajo de la
     línea de rasgado y se lleva la perforación y las flechas con él,
     dibujadas donde el sobre NO se va a romper. Se puede quitar sin
     perder el gesto porque el arrastre no lo escucha la tira sino el
     sobre entero (ver el style inline de .sobre, touchAction): la tira
     es la PISTA de dónde se rasga, no el sitio al que hay que apuntar.
     Los 44px de zona tocable los devuelve el ::after de abajo. */
  min-height: 0;
}
/* LA ZONA TOCABLE DE LA TIRA VUELVE A MEDIR 44px sin que se vea. Con la
   tapa a 29px, el min-height:0 de arriba dejaba a la tira por debajo de los
   44px que .touch-target promete a todo lo que se toca en la app. Aquí se
   le devuelven con un pseudoelemento transparente y sin contenido, que no
   puede ir en .sobre__tapa-dedo —recorta a sus hijos, y overflow:hidden
   recorta también el hit-test— así que se cuelga de .sobre__tapa, que no
   recorta y ya está a z-index 2. Que quede claro lo que NO hace: hoy no
   cambia quién recibe el toque, porque el gesto lo escucha .sobre entero y
   los 15px que sobresalen caen sobre el cuerpo, que también es .sobre. Lo
   que hace es que la tira, POR SÍ MISMA, mida lo que dice que mide: si un
   día el arrastre vuelve a escucharse en la tira, la caja ya está. Hereda el
   pointer-events:none que la tapa recibe al rasgar, así que no estorba a la
   carta que emerge. */
.sobre[data-arte="si"] .sobre__tapa::after {
  content: ""; position: absolute; left: 0; right: 0; top: 0;
  height: max(100%, 44px);
}
/* El crimpado plateado se pliega a cero en vez de apagarse: el de la
   foto es el de SU expansión y está en su sitio, y esta franja sólo
   servía para reservarle hueco al dibujado. Con la tapa a 29px, dejarlo
   ocupando sitio dejaba la tira sin alto para las flechas. */
.sobre[data-arte="si"] .sobre__crimpado { height: 0; }
/* La tira deja de ser una banda impresa y pasa a ser SOMBRA: el film
   levantándose por el sellado. Así se ve la foto por debajo, y las
   flechas se leen encima de cualquier ilustración —clara u oscura, en
   los dos temas— porque van en blanco sobre ese velo. --ink-faint no
   sirve aquí: en tema claro es gris oscuro, y estas fotos también.
   La perforación se queda, y en modo foto es lo único que dice por
   dónde se va a romper. */
.sobre[data-arte="si"] .sobre__tira {
  background: linear-gradient(180deg, rgba(0,0,0,.38), rgba(0,0,0,.06));
  border-bottom-color: rgba(255,255,255,.5);
  box-shadow: none;
  color: rgba(255,255,255,.92);
}
/* La boca —el interior que asoma en cuanto la tira despega— se pinta con
   el fondo de la aplicación, y encima de una foto eso no vale: en tema
   claro --bg es crema y el sobre se quedaría con una franja CLARA justo
   donde acaba de romperse. El agujero de un envoltorio roto es una
   sombra, y una sombra es negra en los dos temas: el mismo argumento por
   el que los valles de .sobre__pliegues van en rgba y no en var(--ink).
   La sombra interior de abajo no se toca; sigue haciendo el pliegue. */
.sobre[data-arte="si"] .sobre__boca {
  background: linear-gradient(180deg, rgba(0,0,0,.82) 0%, rgba(0,0,0,.34) 100%);
}
/* Arrugas, reflejos y barrido SE QUEDAN: son lo que convierte una foto
   pegada en un envoltorio de plástico manoseado, y son justo lo que a
   una foto de catálogo le falta. Las arrugas sí pesan menos, porque
   debajo ya no hay un degradado liso sino un dibujo que compite. Esta
   regla gana a las dos de opacity de arriba —la de tema claro y la de
   oscuro— por especificidad: clase + atributo + clase. */
.sobre[data-arte="si"] .sobre__pliegues { opacity: .26; }

/* Sin scale (era .94): la capa es ancestro de la foto. Se sube un poco más
   de recorrido, 20px en vez de 16, para que la entrada siga teniendo peso. */
@keyframes sobre-entra  { from { opacity:0; transform: translate3d(0,20px,0); } to { opacity:1; transform:none; } }
/* 4px y no 5: el sobre mide ahora lo que la carta y deja sólo 10px de aire
   arriba; con 5 el balanceo se acercaba a la cabecera. */
@keyframes sobre-flota  { 0%,100% { transform: translate3d(0,0,0); } 50% { transform: translate3d(0,-4px,0); } }
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
/* LA CAÍDA DEL CUERPO, en 680 ms desde T_CARTA (420). Tres tramos, dibujados
   en POSICIONES con timing linear para que el arco salga igual en todos los
   motores:
     · 0-12% (420-500 ms): respingo de 5px, el tirón de la mano.
     · 12-57% (500-808 ms): DESCENSO. El cuerpo baja 60px mientras la carta
       sube 90 (keyframes y:[0,-90,0] de components/MazoCartas.tsx, que
       llega a su cima en 805 ms). Sumadas, la carta asoma unos 86px por la
       boca en el iPhone y 88 en el PC: la carta se SACA del sobre, y el sobre
       baja en la otra mano. Sin este tramo, con el sobre 130px más alto que
       la carta, sólo asomarían 26.
     · 57-100% (808-1100 ms): la caída acelerada de siempre, cada tramo
       recorre más que el anterior, y se apaga. Termina en 1100, como antes.
   SIN ESCALA. Había una de 1.01 → .93 que daba la sensación de alejarse,
   y .sobre__cuerpo es quien PINTA la foto: WebKit la rasteriza a otro
   tamaño justo en los fotogramas que se miran. El "alejarse" lo hacen ahora
   un giro de hasta 3° hacia el lado por el que salió la tira (--caida-dir,
   inline en .sobre: +1 derecha, -1 izquierda) y una deriva de 12px en ese
   sentido: un cuerpo que cae no baja en vertical perfecta. Los px de la
   caída no escalan con el sobre a propósito: son gravedad, no dibujo. */
@keyframes sobre-cuerpo-cae {
  0%   { transform: translate3d(0,0,0) rotate(0deg);   opacity: 1; }
  12%  { transform: translate3d(0,-5px,0) rotate(0deg); opacity: 1; }
  30%  { transform: translate3d(calc(var(--caida-dir,1) * 1px),12px,0) rotate(calc(var(--caida-dir,1) * .2deg)); opacity: 1; }
  45%  { transform: translate3d(calc(var(--caida-dir,1) * 2px),36px,0) rotate(calc(var(--caida-dir,1) * .5deg)); opacity: 1; }
  57%  { transform: translate3d(calc(var(--caida-dir,1) * 3px),60px,0) rotate(calc(var(--caida-dir,1) * .8deg)); opacity: .98; }
  72%  { transform: translate3d(calc(var(--caida-dir,1) * 6px),100px,0) rotate(calc(var(--caida-dir,1) * 1.5deg)); opacity: .85; }
  87%  { transform: translate3d(calc(var(--caida-dir,1) * 9px),150px,0) rotate(calc(var(--caida-dir,1) * 2.3deg)); opacity: .5; }
  100% { transform: translate3d(calc(var(--caida-dir,1) * 12px),200px,0) rotate(calc(var(--caida-dir,1) * 3deg)); opacity: 0; }
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
  variantesSobre,
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

  /*
   * LA FOTO DEL SOBRE, EN TRES PASOS SEPARADOS A PROPÓSITO.
   *
   * 1. QUÉ FOTO TOCA. Es SÍNCRONO: el manifiesto viaja en el bundle
   *    (utils/sobreArte.ts), así que en el primer render ya se sabe si esta
   *    expansión tiene ilustración y cuál de sus variantes le toca a ESTE
   *    sobre. Depende del id de la expansión y de la semilla, las dos estables
   *    mientras el sobre está en pantalla: la variante no puede cambiar a
   *    mitad del rasgado, que es lo mismo que se cuida en los otros dos
   *    useMemo de aquí arriba.
   *
   *    SIGUE SIENDO SÍNCRONO aunque ahora haya un segundo almacén en Postgres,
   *    y ésa es la razón de que `variantesSobre` sea una PROP y no una
   *    petición: el número llega con el resto de la expansión, en el mismo
   *    viaje, así que en el primer render se sabe igual de bien que antes si
   *    hay foto. Con un fetch aquí habría que pintar el sobre sin saberlo y
   *    cambiarle la cara después, que es justo lo que esta pantalla no puede
   *    hacer.
   *
   *    El id que se le pasa al manifiesto es el NORMALIZADO (`arte.id`) y el
   *    que se le pasa al almacén remoto es el CRUDO (`setId`). No son
   *    intercambiables y la función espera cada uno en su sitio; el porqué
   *    largo está allí.
   */
  const urlArte = useMemo(
    () =>
      ilustracionDeSobre(
        arte.id,
        semilla,
        setId && variantesSobre ? { setId, variantes: variantesSobre } : null,
      ),
    [arte.id, semilla, setId, variantesSobre],
  );

  /*
   * 2. SI YA ESTÁ CARGADA. La foto no puede llegar a medias: se pinta en el
   *    instante exacto del rasgado y un hueco a medio rellenar se ve. Se
   *    precarga AL MONTAR —el sobre se pasa un rato sellado esperando el
   *    toque— y no al rasgar, que es el único momento de la aplicación con
   *    presupuesto en milisegundos. Hasta que no esté, se enseña el sobre
   *    dibujado, que para eso está.
   *
   *    Es el mismo criterio que ya rige para el sello (utils/sobreArte.ts):
   *    las imágenes del sobre van como background y NUNCA como <img>, porque
   *    un <img> roto pinta el icono de imagen partida en mitad del sobre. La
   *    diferencia con el sello —que es un adorno de 40px y con no aparecer ya
   *    cumple— es que la foto ES el sobre: aquí no basta con que no falle,
   *    tiene que estar entera antes de enseñarse. De ahí la precarga.
   *
   *    Se guarda la URL puesta y no un booleano: con un `true` heredado, si
   *    cambiase la expansión se daría por buena una foto que aún no está.
   *
   * 3. Y SÓLO SE PONE SI EL SOBRE SIGUE SELLADO. Si llegara tarde —red lenta
   *    y toque rápido— cambiarle la cara al sobre a mitad del rasgado sería
   *    peor que no enseñarla nunca: la tapa ya está volando con su trozo de
   *    dibujo y se le cambiaría el suelo debajo. La condición se mira DENTRO
   *    de la descarga, cuando termina, y por eso la fase viaja en un ref: la
   *    fase que capturó el efecto al montar es "sellado" para siempre, y
   *    volver a lanzar la descarga en cada fase serían tres descodificaciones
   *    del WebP justo durante la coreografía. Una vez puesta ya no se quita:
   *    nadie vuelve a tocar este estado hasta que cambie la expansión.
   */
  const faseRef = useRef(fase);
  useEffect(() => {
    faseRef.current = fase;
  }, [fase]);

  const [arteEnUso, setArteEnUso] = useState<string | null>(null);
  /*
   * EL RECORTE DE LAS FOTOS CRUDAS, y por qué se mide aquí y no en el servidor.
   *
   * Las de public/sobres vienen recortadas a 780/1426 exactos por sharp. Las
   * que trae el cron llegan con la proporción que tuviera la wiki, y hay que
   * decirle a la hoja de estilos cuánto agrandarlas para que llenen el sobre
   * sin dejar una banda transparente al pie (el porqué, y por qué no vale
   * `cover`, está en el bloque CSS de arriba y en `tamanoDeFondo`).
   *
   * Ese cálculo necesita el ancho y el alto de LA FOTO CONCRETA que ha tocado.
   * Podrían viajar desde el servidor, pero costaría llevar una lista por
   * variante hasta aquí para un dato que el navegador YA TIENE: esta descarga
   * es la misma que ya se hacía, y al terminar `naturalWidth`/`naturalHeight`
   * están ahí. No hay ni una petición de más, ni un campo de más en la prop.
   *
   * Y NO SE TOCA A LAS ESTÁTICAS. Sólo se mide lo que viene de la ruta remota:
   * las 130 de siempre no emiten la variable, caen en el valor por defecto
   * ("100% auto", la regla literal de antes) y se pintan hasta la última
   * milésima como se pintaban ayer.
   */
  const [tamanoArte, setTamanoArte] = useState<string | null>(null);
  /*
   * LA FOTO NO HA LLEGADO Y NO VA A LLEGAR.
   *
   * Nació para devolverle al sobre la FORMA del dibujado cuando la foto fallaba
   * (los dos modos tenían cajas distintas). Ya no: la caja es la misma con foto
   * y sin ella (RATIO_SOBRE), así que un fallo no cambia ninguna medida. Lo que
   * sigue decidiendo es EL BARRIDO DE REFLEJO: mientras se espera una foto que
   * está de camino, el barrido no arranca (barrer sobre el dibujado para que
   * 150-750 ms después le cambie la cara al sobre debajo es justo el tipo de
   * "se queda pillado y luego se anima" que el dueño describía); pero si la
   * descarga ha fallado no va a llegar nada y el barrido tiene que empezar ya
   * sobre el dibujado, que es lo que se va a ver. Desde que la foto puede
   * venir de Postgres, basta un 503 de la ruta para que no llegue.
   *
   * SE GUARDA LA URL QUE FALLÓ Y NO UN `true`, por el mismo motivo que
   * `arteEnUso` guarda la que se puso: un booleano heredado seguiría diciendo
   * "esta expansión no tiene foto" después de cambiar de expansión.
   */
  const [urlFallida, setUrlFallida] = useState<string | null>(null);
  useEffect(() => {
    if (!urlArte) return;
    let vivo = true;
    const img = new Image();
    // No cuenta como avería —una expansión sin foto es el caso normal de 41 de
    // las 171— pero sí libera el barrido de reflejo: ver el bloque de arriba.
    img.onerror = () => {
      if (vivo) setUrlFallida(urlArte);
    };
    img.onload = () => {
      // decode() descomprime el WebP (780x1426) FUERA del hilo de pintado. Sin
      // él la descompresión cae en el primer fotograma que use la imagen, que
      // es justo el del rasgado. Si el navegador no lo trae o lo rechaza, se
      // sigue adelante: los bytes ya están, que es lo que preguntaba el onload.
      const decodificando = typeof img.decode === "function" ? img.decode() : null;
      const poner = () => {
        if (!vivo || faseRef.current !== "sellado") return;
        // Los dos estados se ponen juntos, en el mismo evento, para que React
        // los agrupe: la URL y su tamaño no pueden pintarse en dos fotogramas
        // distintos o se vería un salto de escala.
        setTamanoArte(
          urlArte.startsWith(PREFIJO_ARTE_REMOTO)
            ? tamanoDeFondo(img.naturalWidth, img.naturalHeight)
            : null,
        );
        setArteEnUso(urlArte);
      };
      if (decodificando) decodificando.then(poner, poner);
      else poner();
    };
    img.src = urlArte;
    return () => {
      vivo = false;
    };
  }, [urlArte]);

  const conArte = urlArte !== null && arteEnUso === urlArte;
  /* ¿Hay una foto de camino? Se sabe SIN RED en el caso normal —`urlArte` sale
   * del bundle— y sólo deja de esperarse si la descarga ha fallado de verdad. */
  const esperandoArte = urlArte !== null && !conArte && urlFallida !== urlArte;
  /* El barrido de reflejo espera a la foto (punto 1 del encargo del brillo):
   * si arrancara sobre el dibujado, la foto le cambiaría el sobre debajo a
   * mitad de barrido. Con fill-mode backwards (ver .sobre__brillo) el sorteo
   * de --br-delay lo deja quieto y FUERA del sobre hasta que le toca. */
  const conBrillo = !efectosApagados && !esperandoArte;

  /*
   * GEOMETRÍA Y CAÍDA, como custom properties. Van en un Record y no sueltas
   * en el style por lo mismo que `film` y `arte.vars`: CSSProperties no admite
   * claves `--x` escritas a mano en el literal, y un cast en cada línea es
   * peor que un objeto con nombre.
   *
   * --sobre-w es el ancho del sobre, la MISMA expresión que su width: el
   * dibujado mide su tapa, su crimpado y su banda como fracciones de él en
   * vez de en px que no crecen con el sobre (ver el CSS de .sobre).
   * --caida-dir es hacia qué lado se inclina el cuerpo al caer: el mismo por
   * el que salió la tira (sobre-cuerpo-cae).
   */
  const geometria: Record<string, string> = {
    "--sobre-w": anchoDeSobre(anchoCarta),
    "--caida-dir": tearDir < 0 ? "-1" : "1",
  };

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
        // El interruptor de todas las reglas de la foto. Va aquí y no en el
        // cuerpo porque la tapa también tiene que enterarse, y son hermanas.
        data-arte={conArte ? "si" : undefined}
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
          // La foto y su línea de rasgado entran por variable, como todo lo
          // demás: las reglas de arriba siguen siendo una cadena constante.
          // La URL sale de una carpeta validada más un entero, así que no hay
          // manera de que se cuele un carácter que cierre el url().
          ...(conArte && urlArte
            ? { "--sb-arte": `url("${urlArte}")`, "--tapa-h": CORTE_ARTE }
            : null),
          /* Y el recorte, SÓLO cuando hace falta. `tamanoArte` es null para las
             130 fotos estáticas (ya vienen a 780/1426) y también para una foto
             remota que ya venga alargada, así que en la inmensa mayoría de los
             casos esta variable no se emite y la regla CSS cae en su valor por
             defecto, que es la cadena "100% auto" de siempre. Es un `X% auto`
             con tres decimales: ni comillas ni paréntesis, nada que pueda
             cerrar la declaración. */
          ...(conArte && tamanoArte ? { "--sb-arte-size": tamanoArte } : null),
          // GEOMETRÍA. La misma caja con foto y sin ella, y la misma desde el
          // primer fotograma: no depende de nada que llegue por red (ver
          // RATIO_SOBRE y anchoDeSobre). El ancho va en --sobre-w (arriba,
          // `geometria`) y el width lo lee de ahí.
          ...geometria,
          width: "var(--sobre-w)",
          aspectRatio: RATIO_SOBRE,
          // El arrastre vale en TODO el sobre, no sólo en la tira: apuntar a
          // una franja de 48px con el dedo es puntería fina.
          touchAction: touchActionFor("x"),
        }}
      >
        {/* CUERPO — aquí vive el overflow-hidden, no en .sobre */}
        <div className="sobre__cuerpo">
          {/* RAYADO Y SELLO SON TINTA, y con foto la tinta ya está impresa: el
              rayado lenticular de esa expansión y su símbolo salen en la
              fotografía, en su sitio y con su tamaño. Pintar los nuestros
              encima los duplica y delata el montaje. No se montan en vez de
              apagarse por CSS porque no hay nada que apagar: son dos capas de
              gradientes que ya no dibujan nada útil.
              Lo que sí sigue montado son pliegues, reflejos y barrido: eso no
              es tinta, es el film por encima, y es justo lo que a una foto de
              catálogo le falta para parecer un sobre que alguien sostiene. */}
          {!conArte && <div className="sobre__rayas" aria-hidden="true" />}
          {/* El sello va pegado al rayado y por DEBAJO de pliegues y reflejos:
              es tinta impresa, no un adorno encima del film. Sólo se monta si
              hay símbolo con el que pintarlo (ver `sello` arriba). */}
          {!conArte && sello && <div className="sobre__sello" aria-hidden="true" />}
          {/* Pliegues y reflejos NO se mueven: reducir efectos no es reducir
              detalle, así que se pintan también con efectosApagados. Se
              rasterizan una vez al montar y no cuestan nada después. */}
          <div className="sobre__pliegues" aria-hidden="true" />
          <div className="sobre__luces" aria-hidden="true" />
          {conBrillo && <div className="sobre__brillo" aria-hidden="true" />}
          {/* Boca: el interior que queda a la vista al despegarse la tira.
              Pintada siempre; mientras arrastras se va destapando por el borde. */}
          <div className="sobre__boca" aria-hidden="true" />

          {/* LA CARA DEL SOBRE DIBUJADO: logo del set, nombre y banda de
              cartas. Con foto no se monta NADA de esto, y no es por ahorrar
              sino porque la fotografía ya lo trae impreso —el logo, el nombre
              de la expansión y su propia banda de "10 ADDITIONAL GAME
              CARDS"—, en su tipografía y en su sitio. Superponerle nuestro
              logo encima del suyo es la diferencia entre un sobre y una
              pegatina sobre un sobre.
              Lo que se pierde es el número de cartas de ESTE sobre cuando no
              coincide con el que trae impreso el sobre real (los premium no
              llevan diez). Se acepta: en cuanto se rasga, la vista enseña
              "1 / N" en la cabecera. */}
          {!conArte && (
            <>
              <div
                className="absolute inset-x-0 flex flex-col items-center justify-center gap-3 px-6"
                // Arriba empieza donde acaba la tapa y abajo deja el sitio de
                // la banda (36px en el dibujo de 286): en fracciones del ancho
                // del sobre, como el resto del dibujado (ver el CSS de .sobre).
                style={{ top: "var(--tapa-h)", bottom: "calc(var(--sobre-w) * .126)" }}
              >
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
            </>
          )}
        </div>

        {/* TAPA — HERMANA del cuerpo. El vuelo va en .sobre__tapa (keyframe) y
            el desplazamiento del dedo en .sobre__tapa-dedo (transform inline):
            así la tira despega exactamente desde donde la dejó el dedo. */}
        <div className={`sobre__tapa ${tearDir < 0 ? "sobre__tapa--izq" : "sobre__tapa--der"}`}>
          <div ref={tiraRef} className="sobre__tapa-dedo touch-target">
            <div className="sobre__crimpado" aria-hidden="true" />
            {/* Las flechas van con currentColor: con dibujo heredan
                --ink-faint de la clase, y con foto se quita la clase para que
                hereden el blanco que .sobre[data-arte] le pone a la tira. Es
                la única forma de que se lean sobre una ilustración cualquiera
                sin usar un mix-blend-mode, que está prohibido en esta
                pantalla. */}
            <div className="sobre__tira">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={`w-3.5 h-3.5 shrink-0${conArte ? "" : " ink-faint"}`}>
                <path d="m11 17-5-5 5-5M18 17l-5-5 5-5" />
              </svg>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={`w-3.5 h-3.5 shrink-0${conArte ? "" : " ink-faint"}`}>
                <path d="m6 17 5-5-5-5M13 17l5-5-5-5" />
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
