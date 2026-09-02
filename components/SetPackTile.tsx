"use client";

import { motion } from "framer-motion";
import { useMemo } from "react";
import { arteDeSobre, ilustracionDeSobre, normalizarId } from "../utils/sobreArte";
import type { Expansion } from "../utils/tipos";

/* =====================================================================
 * LA TESELA DE UNA EXPANSIÓN EN LA PORTADA
 * =====================================================================
 *
 * POR QUÉ EXISTE ESTE FICHERO. La rejilla de expansiones es la pantalla que
 * más se mira de la aplicación y hasta ahora pintaba, para las 171 expansiones,
 * el MISMO rectángulo gris con el logo del set centrado encima. Un catálogo de
 * sobres que no enseña ni un sobre. Y no era por falta de material: el
 * repositorio ya tenía 131 fotografías reales de sobre en public/sobres y una
 * identidad visual completa por expansión en utils/sobreArte.ts, y las dos
 * cosas se usaban sólo dentro de components/BoosterPack.tsx, o sea a dos
 * toques de distancia.
 *
 * LO QUE SE PINTA, EN ORDEN DE PREFERENCIA
 *
 *  1. LA FOTO DEL SOBRE, a sangre, cuando la expansión tiene una. Son 130 de
 *     171 en producción y 29 de las 38 que sirve el respaldo local.
 *  2. EL SOBRE DIBUJADO cuando no la hay. Las 41 restantes son promos,
 *     Trainer Gallery, Shiny Vault, kits y energías: productos que nunca se
 *     vendieron en sobre, así que no hay foto que buscar y la lista no va a
 *     bajar mucho de 41. En vez del gris común se usa el color y la textura de
 *     era que `arteDeSobre` ya calcula para el sobre de verdad, de modo que la
 *     rejilla no queda a dos velocidades: una tesela sin foto sigue siendo la
 *     tesela de ESA expansión y no un hueco.
 *
 * EL PESO, DICHO ENTERO Y SIN TRAMPA. Son dos cuentas distintas y las dos
 * hacen falta:
 *
 *  · POR SERIE DESPLEGADA el peso BAJA. Medido con curl sobre las 38
 *    expansiones del respaldo local: los logos remotos que se pintaban antes
 *    suman 5 269,4 KB y lo que se pinta ahora (29 fotos locales + 9 símbolos)
 *    suma 2 760,4 KB, un 47,6% menos. Los logos de pokemontcg.io son PNG sin
 *    optimizar —`sve` pesa 427,7 KB él solo, `swsh12` y `swsh12tg` 385,6 KB
 *    cada uno— y cada subset tiene su URL propia aunque devuelva bytes
 *    idénticos, así que la caché HTTP no comparte ni uno.
 *
 *  · POR ABRIR LA APLICACIÓN el peso SUBE, y ese número no puede faltar aquí.
 *    Antes la portada arrancaba con todas las series plegadas, o sea CERO
 *    imágenes de expansión; ahora arranca con una serie abierta (ver la
 *    siembra en app/page.tsx) y eso son 14 fotos y 1 340,9 KB medidos en el
 *    respaldo local, 3 fotos y 259 KB en producción, donde la serie más
 *    reciente es Mega Evolution y tiene tres expansiones. El 47,6% de arriba
 *    es real para el mismo gesto, pero nadie hacía ese gesto: por eso la
 *    portada recuerda como mucho UNA serie desplegada, y por eso importa que
 *    lo de aquí abajo no pida ni un byte de más.
 *
 * NO SE PIDE EL LOGO ADEMÁS DE LA FOTO. Es la tentación evidente —"la foto de
 * fondo y el logo delante"— y sería 7 944,9 KB, medio mega más que las dos
 * cosas por separado.
 *
 * Cuando no hay foto se usa el SÍMBOLO del set (`images.symbol`: 9,4 KB de
 * media en esas nueve expansiones, contra los 168,9 KB que pesa de media el
 * logo de esas mismas nueve), que además es la única imagen que la capa de
 * idioma deja siempre apuntando a pokemontcg.io.
 *
 * NADA DE `filter`, `drop-shadow` NI `transform: scale`, y aquí importa más
 * que en ningún otro sitio. La regla está medida y documentada en
 * components/PokemonCard.tsx y en la cabecera de components/BoosterPack.tsx:
 * WebKit promociona a capa cualquier elemento con esas propiedades y lo
 * rasteriza a una escala fija, así que la ilustración sale BORROSA en el
 * iPhone. La tesela de antes tenía DOS infracciones sobre el logo —un
 * `group-hover:scale-110` y un `drop-shadow-lg`— más un `whileTap` de escala
 * en la tarjeta entera, o sea en un ANCESTRO. Sobre un logo de 58px eso se
 * venía tolerando; sobre una fotografía a sangre no. Aquí el hover levanta con
 * `translate`, el toque hunde con `translate` y el resto es `background`,
 * `box-shadow` y `opacity`.
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

/**
 * La variante de foto que le toca a la tesela es SIEMPRE la misma.
 *
 * `ilustracionDeSobre` sortea entre las variantes de la expansión con la
 * semilla que se le pase, y en la apertura eso es lo que hace que dos sobres
 * seguidos del mismo set salgan distintos. Aquí sería un defecto: la tesela se
 * re-renderiza cada vez que cambia la colección o se pliega una serie, y con
 * una semilla viva cambiaría de fotografía delante de los ojos de quien está
 * mirando la rejilla. Con una constante, la expansión tiene una cara y una
 * sola, y además el navegador reutiliza la imagen ya cacheada al replegar y
 * volver a desplegar la serie.
 */
const SEMILLA_TESELA = 0;

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
   * LA FOTO, Y SÓLO DEL MANIFIESTO ESTÁTICO.
   *
   * `ilustracionDeSobre` acepta un tercer argumento `remoto` que resuelve
   * contra `set_pack_art` (las fotos que baja el cron para las expansiones
   * salidas después del último despliegue) y devuelve una URL de
   * /api/arte-sobre/…, que es UNA CONSULTA A POSTGRES POR IMAGEN. En la
   * apertura eso es una consulta; aquí serían hasta 38 en la misma pantalla,
   * sólo por desplegar una serie. Así que aquí no se pasa: el manifiesto viaja
   * en el bundle (4,6 KB) y contesta en el primer render sin red.
   *
   * La consecuencia hay que decirla: una expansión recién ingerida por el cron
   * enseña en la portada el sobre dibujado y al abrirla enseña la foto. Es el
   * intercambio correcto —una expansión, dos días, contra 38 consultas cada vez
   * que alguien despliega una serie— y se corrige solo en el siguiente
   * despliegue, cuando la foto entra en el manifiesto.
   *
   * EL ID VA NORMALIZADO. El manifiesto se indexa por el id normalizado
   * ("sv3pt5" y "sv03.5" son la misma expansión y las dos caen en "sv3.5"), y
   * pasarlo en crudo es el fallo que ya se pagó una vez en app/page.tsx: ocho
   * expansiones con foto se quedaban sin ella en silencio.
   */
  const foto = useMemo(() => ilustracionDeSobre(normalizarId(set.id), SEMILLA_TESELA), [set.id]);

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
         sobre la tarjeta entera, o sea un transform de escala en un ancestro
         de la ilustración: exactamente lo que deja la foto borrosa en iOS. Un
         hundimiento de 2px da el mismo acuse de recibo y no cambia la escala a
         la que se rasteriza nada. */
      whileHover={{ y: -4 }}
      whileTap={{ y: 2 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      onClick={() => onSelect(set.id)}
      title={set.name}
      className="group surface surface-hover relative flex aspect-[3/4] w-full flex-col justify-end overflow-hidden rounded-2xl md:rounded-3xl"
      /* Las custom properties de la expansión heredan a las capas de fondo.
         No son propiedades de caja: no pueden pisar nada del layout. */
      style={arte.vars}
    >
      {/* EL SOBRE DIBUJADO VA SIEMPRE, Y DEBAJO DE TODO.
          Antes vivía en la rama `else` —sólo se pintaba en las expansiones sin
          foto— y eso dejaba a las 130 CON foto sin nada debajo: mientras la
          fotografía viajaba, la tesela era el panel de `.surface` (crema en
          claro, casi negro en oscuro) con la banda del velo abajo y el nombre
          encima. Se ve de sobra en la primera captura de cada carga: una
          rejilla de rectángulos vacíos con el nombre debajo. Y no era sólo el
          rato de la descarga: era también lo que quedaba PARA SIEMPRE si la
          foto daba 404 o si el jugador entraba sin cobertura antes de que el
          service worker tuviera el fichero. O sea el rectángulo gris que este
          fichero venía a matar, otra vez.
          Ponerlo siempre cuesta CERO BYTES —son dos `background` constantes,
          ninguna petición— y lo que se ve mientras la foto llega ya no es un
          hueco: es el sobre de ESA expansión, con sus colores y el rayado de
          su era. */}
      <div className="tesela-fondo pointer-events-none absolute inset-0" />
      <div className="tesela-rayado pointer-events-none absolute inset-0" />

      {foto ? (
        /* A SANGRE Y ANCLADA ARRIBA. La foto es 1:1,83 (más estrecha y alta
           que la tesela), así que `object-cover` recorta por abajo y
           `object-top` conserva la mitad que identifica el sobre: el logo de
           la expansión y el arranque de la ilustración. Anclarla al centro
           dejaba fuera el logo en los sobres altos.
           `alt=""` porque es decorativa: el nombre accesible del botón sale
           del texto de abajo, y repetirlo aquí lo diría dos veces.
           OPACA DEL TODO, y esto cambió con lo de arriba: antes iba al 94% y
           dejaba pasar un 6% de lo que hubiera detrás, que era `.surface`, o
           sea que la MISMA fotografía salía con un tinte distinto en el modo
           claro y en el oscuro. Ahora detrás hay un degradado de colores y el
           tinte sería peor. El realce del puntero no se pierde: lo hace
           `.tesela-lustre`, que es una capa aparte. */
        <img
          src={foto}
          alt=""
          aria-hidden="true"
          /* `lazy` + prioridad baja: no cuesta nada y en la serie más larga
             (Espada y Escudo, 25 expansiones) la rejilla mide más de 3 000px
             en un móvil, así que la última fila sí queda fuera del margen de
             precarga. MEDIDO, para que nadie le atribuya más de lo que hace:
             con la serie sembrada (16 expansiones, rejilla de 1 858px a
             375px de ancho) el navegador pide las 14 fotos con scrollY 0, o
             sea que ahí NO difiere nada — el margen de precarga de Chrome es
             mayor que la rejilla entera, y encima crece cuando la conexión
             empeora. Diferir de verdad exigiría IntersectionObserver propio o
             `content-visibility`, y lo segundo es una propiedad de
             contención sobre una fotografía: no se mete sin poder medirla en
             un iPhone de verdad. */
          loading="lazy"
          decoding="async"
          fetchPriority="low"
          className="absolute inset-0 h-full w-full object-cover object-top"
        />
      ) : (
        set.images?.symbol && (
          /* EL SÍMBOLO, SOBRE UNA CHAPA CLARA.
              El símbolo, no el logo: 9,4 KB contra 168,9 KB de media, y es la
              única imagen que la capa de idioma no reescribe. Va centrado en
              el tercio superior, donde la foto tendría el logo impreso.
              La chapa no es adorno. Sin ella el símbolo se pintaba directo
              sobre el degradado y NO SE VEÍA. Medidos con canvas píxel a
              píxel, los símbolos de set son gris medio —sv3.5 rgb(106,105,
              106), swsh3.5tg rgb(108,120,133), base1 rgb(144,116,103),
              swshp rgb(89,89,89)— y el fondo de la familia Espada y Escudo en
              ese punto es rgb(112,72,120). Los cinco daban entre 1,04:1 y
              1,69:1, cuando un gráfico que porta significado necesita 3:1.
              Sobre la chapa dan entre 3,82:1 y 6,21:1.
              Y aquí el símbolo porta TODO el significado: las expansiones de
              una familia comparten colores, ángulo y textura —las siete de
              Espada y Escudo reciben el mismo #1f66b0/#c22a41 a 106deg, o sea
              fondos idénticos píxel a píxel—, así que el símbolo y el nombre
              son literalmente lo único que las distingue. El color no se puede
              variar desde aquí sin tocar `arteDeSobre`, que no se toca.
              Es `background` y `box-shadow`: nada que promocione capa. */
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
        )
      )}

      {/* EL VELO, QUE ES LO QUE HACE QUE EL NOMBRE SE LEA.
          Una foto de sobre es colorida y trae su propio texto impreso; el
          nombre de la expansión encima, a pelo, se pierde contra los claros.
          El velo es un degradado negro que sólo cubre la mitad inferior, así
          que la ilustración se ve entera y el texto cae siempre sobre un fondo
          oscuro conocido: blanco puro sobre rgba(6,5,3,.92) da 18,9:1 pase lo
          que pase debajo, y en el punto más claro del degradado (68% de alto,
          alfa .18) el texto ya no llega. Es `background`, no `backdrop-filter`:
          lo segundo no existe en Chrome con el prefijo y además promociona la
          capa de la foto. */}
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

      {/* El nombre en blanco fijo y no con la tinta del tema: debajo hay una
          fotografía, no la superficie de papel, así que el color que garantiza
          contraste es el del velo, no el del modo claro/oscuro. */}
      <span className="relative z-10 w-full truncate px-2.5 pb-2.5 text-left text-[11px] font-semibold tracking-wide text-white md:px-3.5 md:pb-3 md:text-xs">
        {set.name}
      </span>
    </motion.button>
  );
}
