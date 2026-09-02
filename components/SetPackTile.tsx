"use client";

import { motion } from "framer-motion";
import { useMemo } from "react";
import { arteDeSobre } from "../utils/sobreArte";
import type { Expansion } from "../utils/tipos";

/* =====================================================================
 * LA TESELA DE UNA EXPANSIÓN EN LA PORTADA
 * =====================================================================
 *
 * POR QUÉ EXISTE ESTE FICHERO. La rejilla de expansiones es la pantalla que
 * más se mira de la aplicación y hasta hace poco pintaba, para las 171
 * expansiones, el MISMO rectángulo gris con el logo del set centrado encima.
 * Un catálogo que no distingue un set de otro. El repositorio ya tenía una
 * identidad visual completa por expansión en utils/sobreArte.ts —dos colores,
 * un ángulo y el perfil de impresión de su era— y se usaba sólo dentro de
 * components/BoosterPack.tsx. Eso es lo que pinta esta tesela.
 *
 * LA FOTOGRAFÍA DEL SOBRE SE FUE DE AQUÍ, Y ES UNA DECISIÓN DEL DUEÑO, NO UN
 * DESCUIDO. Durante una tanda esta tesela pintó la foto real del sobre a
 * sangre. Ya no: las fotos viven ahora en el SELECTOR DE TIPO DE SOBRE
 * (app/page.tsx, la pantalla que sale al elegir una expansión), donde cada
 * tarjeta —Estándar, Premium, Leyenda— enseña una VARIANTE DISTINTA del sobre
 * real de esa expansión. Es el sitio donde la foto informa de algo: allí se
 * está eligiendo QUÉ SOBRE COMPRAR, y una foto de sobre responde exactamente a
 * esa pregunta. Aquí sólo se está eligiendo EXPANSIÓN, y para eso valen el
 * color de la familia, el símbolo y el nombre.
 *
 * Si alguien vuelve a meter la foto aquí, que sea sabiendo lo que cuesta:
 * son 14 peticiones y 1 340,9 KB en la serie que la portada abre por defecto
 * (respaldo local; 3 fotos y 259 KB en producción, donde la serie reciente es
 * Mega Evolution y tiene tres expansiones), contra los 150,4 KB que cuestan
 * ahora los 16 símbolos. Un 89% menos.
 *
 * LO QUE SE PINTA, EN ORDEN
 *
 *  1. EL SOBRE DIBUJADO, siempre y en las 171: el degradado de la familia y el
 *     rayado de impresión de su era, que `arteDeSobre` calcula para el sobre de
 *     verdad. Cuesta CERO PETICIONES —son dos `background`— y es lo que hace
 *     que la rejilla no sean 171 rectángulos iguales.
 *  2. EL SÍMBOLO del set encima (`images.symbol`), sobre una chapa clara.
 *
 * EL SÍMBOLO Y NO EL LOGO, y esto sigue siendo una cuenta, no un gusto. El
 * símbolo pesa 9,4 KB de media contra 168,9 KB del logo (medido sobre las
 * mismas expansiones), o sea 1/18, y es además la única imagen que la capa de
 * idioma deja siempre apuntando a pokemontcg.io —el logo se reescribe a
 * assets.tcgdex.net en español—. Y hay un motivo de forma además del peso: los
 * logos son APAISADOS y de proporción salvaje (medidos: de 1,32 en sv3pt5 a
 * 9,48 en bw1), así que no hay un hueco que les venga bien a todos. El símbolo
 * es cuadrado en las 171.
 *
 * LA PROPORCIÓN ES 4/3, O SEA APAISADA, Y CAMBIÓ AL IRSE LA FOTO. Era 3/4
 * —vertical— porque dentro había una fotografía vertical de sobre (1:1,83).
 * Sin ella, a 375px la tesela medía 166×221 y su contenido real son un sello de
 * 44px y una línea de nombre: quedaban ~147px de degradado vacío. Con 4/3 la
 * tesela mide 166×124,5 y la rejilla de la serie sembrada pasa de 1 852px a
 * 1 078px de alto, un 42% menos de scroll para ver las mismas 16 expansiones.
 * Lo que queda dentro —un gráfico cuadrado y una línea de texto— no pide alto.
 *
 * NADA DE `filter`, `drop-shadow` NI `transform: scale`. La regla está medida y
 * documentada en components/PokemonCard.tsx y en la cabecera de
 * components/BoosterPack.tsx: WebKit promociona a capa cualquier elemento con
 * esas propiedades y lo rasteriza a una escala fija, así que lo que haya debajo
 * sale BORROSO en el iPhone. La tesela de antes tenía DOS infracciones sobre el
 * logo —un `group-hover:scale-110` y un `drop-shadow-lg`— más un `whileTap` de
 * escala en la tarjeta entera, o sea en un ANCESTRO. Aquí el hover levanta con
 * `translate`, el toque hunde con `translate` y el resto es `background`,
 * `box-shadow` y `opacity`. NO SE REPONEN aunque ahora dentro sólo haya un
 * símbolo de 44px: el símbolo también se rasteriza, y la regla no se relaja por
 * pantallas.
 * ===================================================================== */

interface SetPackTileProps {
  set: Expansion;
  /**
   * Cartas DISTINTAS que el jugador ya tiene de esta expansión. Sale de
   * `userCollectionIds`, que app/page.tsx rellena tanto con sesión (colección
   * del servidor) como de invitado (localStorage), así que el dato es real en
   * los dos casos y no hay que inventarlo. Cero significa "no enseñes nada":
   * un "0/199" en las 38 teselas sería ruido, no información.
   */
  poseidas: number;
  onSelect: (id: string) => void;
}

export default function SetPackTile({ set, poseidas, onSelect }: SetPackTileProps) {
  /*
   * Identidad de la expansión: los dos colores, el ángulo y el perfil de
   * impresión de su era. Es pura, síncrona y total —para cualquier cadena
   * devuelve algo, así que NINGUNA expansión sale gris— y cuesta un hash FNV
   * por tesela. El memo es por consistencia con BoosterPack, no por coste.
   *
   * Se le pasa `set.id` EXPLÍCITO y no sólo la URL del logo: con el idioma en
   * español el logo pasa a apuntar a assets.tcgdex.net y la identificación por
   * URL se pierde, de modo que la misma expansión cambiaría de color según el
   * idioma. Con el id, el sobre de Escarlata y Púrpura es el mismo rojo en los
   * dos.
   */
  const arte = useMemo(
    () => arteDeSobre(set.images?.logo, set.name, set.id),
    [set.images?.logo, set.name, set.id],
  );

  /*
   * El progreso, con el mismo denominador que el álbum (app/collection):
   * `cardsCount` —las cartas que EXISTEN en la base— y `total` sólo de
   * respaldo, porque el declarado por la API viene inflado y hacía inalcanzable
   * el 100%. El numerador se acota al denominador: cuenta lo que hay en la
   * colección contra lo que existe hoy, y una resiembra puede descuadrarlos.
   */
  const total = Number(set.cardsCount) || Number(set.total) || 0;
  const tengo = total > 0 ? Math.min(poseidas, total) : poseidas;

  return (
    <motion.button
      /* Los dos gestos son TRANSLACIONES. El de antes era `whileTap: scale`
         sobre la tarjeta entera, o sea un transform de escala en un ancestro de
         todo lo que hay dentro: exactamente lo que rasteriza a escala fija y
         deja borroso en iOS lo que sea que se esté pintando ahí —fue la foto y
         hoy es el símbolo—. Un hundimiento de 2px da el mismo acuse de recibo
         sin cambiar la escala a la que se rasteriza nada. NO SE REPONE. */
      whileHover={{ y: -4 }}
      whileTap={{ y: 2 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      onClick={() => onSelect(set.id)}
      title={set.name}
      /* APAISADA (4/3), y el porqué está arriba en la cabecera: dentro ya no
         hay una fotografía vertical de sobre, sino un símbolo cuadrado y una
         línea de nombre. Con 3/4 sobraban ~147px de degradado vacío por tesela
         a 375px y la rejilla de la serie sembrada medía 1 852px; con 4/3 mide
         1 078px. */
      className="group surface surface-hover relative flex aspect-[4/3] w-full flex-col justify-end overflow-hidden rounded-2xl md:rounded-3xl"
      /* Las custom properties de la expansión heredan a las capas de fondo.
         No son propiedades de caja: no pueden pisar nada del layout. */
      style={arte.vars}
    >
      {/* EL SOBRE DIBUJADO, QUE AHORA ES EL FONDO Y NO UN RESPALDO.
          Cuando aquí había una fotografía, estas dos capas eran lo que se veía
          mientras viajaba —y lo que quedaba PARA SIEMPRE si daba 404 o si el
          jugador entraba sin cobertura antes de que el service worker tuviera
          el fichero—. Ahora son el único fondo, y siguen costando CERO
          PETICIONES: son dos `background` constantes con las custom properties
          de la expansión. Es lo que impide que la rejilla vuelva a ser 171
          rectángulos idénticos por haber quitado la foto. */}
      <div className="tesela-fondo pointer-events-none absolute inset-0" />
      <div className="tesela-rayado pointer-events-none absolute inset-0" />

      {set.images?.symbol && (
        /* EL SÍMBOLO, SOBRE UNA CHAPA CLARA.
            El símbolo, no el logo: 9,4 KB contra 168,9 KB de media, y es la
            única imagen que la capa de idioma no reescribe. Va centrado en
            el tercio superior, que es donde el ojo lo busca teniendo el
            nombre abajo.
            La chapa no es adorno. Sin ella el símbolo se pintaba directo
            sobre el degradado y NO SE VEÍA. Medidos con canvas píxel a
            píxel, los símbolos de set son gris medio —sv3.5 rgb(106,105,
            106), swsh3.5tg rgb(108,120,133), base1 rgb(144,116,103),
            swshp rgb(89,89,89)— y el fondo de la familia Espada y Escudo en
            ese punto es rgb(112,72,120). Los cinco daban entre 1,04:1 y
            1,69:1, cuando un gráfico que porta significado necesita 3:1.
            Sobre la chapa dan entre 3,82:1 y 6,21:1.
            Y aquí el símbolo porta TODO el significado, más que nunca desde
            que la foto se fue: las expansiones de una familia comparten
            colores, ángulo y textura —las siete de Espada y Escudo reciben el
            mismo #1f66b0/#c22a41 a 106deg, o sea fondos idénticos píxel a
            píxel—, así que el símbolo y el nombre son literalmente lo único
            que las distingue. El color no se puede variar desde aquí sin
            tocar `arteDeSobre`, que no se toca.
            Es `background` y `box-shadow`: nada que promocione capa.
            A 4/3 el sello sigue cabiendo entero sobre el velo: a 375px la
            tesela mide 124,5px de alto, el centro cae en 37,4 y el sello de
            44px ocupa de 15,4 a 59,4, con el velo empezando en 62,3. */
        <span className="tesela-sello pointer-events-none absolute left-1/2 top-[30%] flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full md:h-14 md:w-14">
          <img
            src={set.images.symbol}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            fetchPriority="low"
            className="h-6 w-6 object-contain md:h-8 md:w-8"
          />
        </span>
      )}

      {/* EL VELO, QUE ES LO QUE HACE QUE EL NOMBRE SE LEA.
          SE QUEDA AUNQUE LA FOTO SE HAYA IDO, y no por inercia: debajo sigue
          habiendo un degradado de dos colores libres —`arteDeSobre` da amarillos
          y cianes tan claros como cualquier fotografía— y el nombre va en blanco
          fijo. Sin el velo, el contraste dependería de la familia de la
          expansión, que es justo lo que no se puede dejar al azar.
          Es un degradado negro que sólo cubre la mitad inferior, así que el
          fondo de la expansión se ve entero y el texto cae siempre sobre un
          fondo oscuro conocido: blanco puro sobre rgba(6,5,3,.92) da 18,9:1 pase
          lo que pase debajo, y en el punto más claro del degradado (68% de alto,
          alfa .18) el texto ya no llega. Es `background`, no `backdrop-filter`:
          lo segundo no existe en Chrome con el prefijo y además promocionaría la
          capa de todo lo que tiene detrás. */}
      <div className="tesela-velo pointer-events-none absolute inset-x-0 bottom-0 h-1/2" />

      {/* Realce al pasar por encima: sólo opacidad sobre un degradado ya
          montado. Sustituye al velo radial de la tesela anterior. */}
      <div className="tesela-lustre pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100" />

      {/* PROGRESO REAL, NUNCA INVENTADO. Sólo aparece cuando el jugador tiene
          algo de esta expansión, de modo que un invitado recién llegado ve la
          rejilla limpia y quien lleva media colección ve de un vistazo por
          dónde va. El dato sale de la colección local o de la del servidor,
          según haya sesión o no. */}
      {tengo > 0 && (
        <span className="tesela-pastilla absolute left-2 top-2 z-10 rounded-full px-1.5 py-0.5 text-[9px] font-semibold leading-none tabular-nums md:left-3 md:top-3 md:px-2 md:py-1 md:text-[10px]">
          <span className="sr-only">Tienes </span>
          {total > 0 ? `${tengo}/${total}` : tengo}
          <span className="sr-only"> cartas de esta expansión</span>
        </span>
      )}

      {/* Esta expansión todavía no tiene diccionario español y se ve en
          inglés. El aviso existe porque el cron trae expansiones nuevas y la
          lista va por fecha descendente: salen las PRIMERAS, así que sin él
          parece que el idioma está roto.
          `=== false` y no `!set.tieneEs`: el servidor sólo añade el campo en
          español, así que en inglés es undefined y aquí no se pinta nada.
          Va como <span> y no como botón: la tesela ya es un botón y anidarlos
          es HTML inválido. */}
      {set.tieneEs === false && (
        <span className="tesela-pastilla absolute right-2 top-2 z-10 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-[0.12em] md:right-3 md:top-3 md:px-2 md:py-1 md:text-[10px]">
          EN
          <span className="sr-only"> · esta expansión todavía no está traducida al español</span>
        </span>
      )}

      {/* El nombre en blanco fijo y no con la tinta del tema: debajo hay el
          degradado de la expansión y el velo, no la superficie de papel, así
          que el color que garantiza contraste es el del velo y no el del modo
          claro/oscuro. */}
      <span className="relative z-10 w-full truncate px-2.5 pb-2.5 text-left text-[11px] font-semibold tracking-wide text-white md:px-3.5 md:pb-3 md:text-xs">
        {set.name}
      </span>
    </motion.button>
  );
}
