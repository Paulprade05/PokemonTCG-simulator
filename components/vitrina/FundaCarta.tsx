"use client";

import PokemonCard from "../PokemonCard";
import DesperfectosCarta, {
  estadoDeCopia,
  estiloDescentrado,
} from "../DesperfectosCarta";
import type { CartaEnColeccion } from "../../utils/tipos";

/**
 * UNA FUNDA del archivador: el bolsillo de plástico con (o sin) su carta.
 *
 * ES LA PIEZA QUE MÁS FÁCIL SE ROMPE, así que conviene decir de entrada qué NO
 * puede llevar. La carta se pinta con PokemonCard en su camino rápido
 * (`interactive={false}` + `reveal`), que existe justamente para que una
 * rejilla no cree una capa compositada por carta. Ese camino se anula si
 * ALGÚN ancestro promociona la capa, y aquí hay tres ancestros muy cerca (la
 * funda, la hoja y la ventana del pase de página). Por eso en todo este árbol
 * no hay `filter`, ni `drop-shadow`, ni `backdrop-filter`, ni `mix-blend-mode`,
 * ni `perspective`, ni `preserve-3d`, ni un solo `transform` con `scale`:
 * WebKit rasteriza esa capa a una escala fija y la ilustración sale borrosa en
 * iPhone (está documentado en components/PokemonCard.tsx:140-163 y en la
 * cabecera de components/MazoCartas.tsx).
 *
 * De ahí dos decisiones que parecen caprichos y no lo son:
 *  · El brillo del plástico es un `linear-gradient` con alfa, NO un
 *    `mix-blend-mode: overlay` —que es como se hace normalmente un reflejo—.
 *    Se pierde algo de riqueza y se gana que la carta se dibuje a resolución
 *    nativa.
 *  · El realce al pasar el ratón es `translate`, no `scale`. La rejilla de la
 *    colección hace exactamente lo mismo y por el mismo motivo; la clase
 *    `press` del tema, que sí escala, queda descartada para cualquier cosa que
 *    envuelva una carta.
 *  · Cuando la copia está dañada aparece un CUARTO ancestro (el marco que
 *    recorta el descentrado), y por eso su desplazamiento también es un
 *    `translate` puro. Ese marco no se monta si la copia se ve limpia, que es
 *    el caso de ~19 de cada 20.
 *
 * ---------------------------------------------------------------------------
 * LA FUNDA VACÍA ES LA MITAD DE ESTA PANTALLA
 *
 * El archivador nace vacío y se monta a mano, así que el hueco NO es el resto
 * que sobra al final: es el botón con el que se construye la vitrina entera.
 * Por eso la funda vacía es interactiva, se anuncia al lector de pantalla y
 * lleva un "+" visible. Cuando NO se le pasa `onTocar` vuelve a ser el hueco
 * decorativo de antes, y eso tiene un uso concreto: la hoja que gira durante el
 * pase de página se pinta dos veces (la que gira y la de debajo), y sus fundas
 * no deben poder tocarse ni duplicar nada en el árbol de accesibilidad.
 */

interface FundaCartaProps {
  /** `null` es un hueco: en un archivador de verdad la funda vacía se ve. */
  carta: CartaEnColeccion | null;
  /**
   * Toque sobre la funda. Vacía, abre el selector de carta; ocupada, el menú
   * de la funda. Sin él la funda es DECORATIVA (la hoja que gira).
   */
  onTocar?: () => void;
  /** Posición 1..9 dentro de la hoja. Para el rótulo del lector. */
  posicion: number;
  /**
   * Escribe la invitación entera ("Coloca tu primera carta") dentro del hueco.
   * La pone sólo una funda de todo el archivador —la primera de la primera hoja
   * cuando aún no hay nada— porque nueve veces la misma frase por hoja es ruido
   * y una sola es una instrucción.
   */
  invita?: boolean;
}

/* ------------------------------------------------------------------ */
/* ESTADO FÍSICO DE LA COPIA                                           */
/* ------------------------------------------------------------------ */

/**
 * El estado de la copia colocada en la funda, y SÓLO si viene con ella.
 *
 * La nota larga está sobre la función gemela de components/MazoCartas.tsx. El
 * resumen, que es lo que no se puede olvidar: el desgaste es coherente con la
 * nota de graduación, así que el servidor sólo lo manda en las copias que de
 * verdad se ven mal. AQUÍ NO SE DEDUCE NADA — nada de `desperfectosDeCopia` ni
 * de `notaDeCopia`—, y la ausencia del dato significa "se ve limpia".
 *
 * El archivador se guarda en el navegador y lo puede haber montado un invitado,
 * así que lo que llegue puede ser de una versión anterior: por eso `unknown` en
 * utils/tipos.ts y por eso se comprueba la forma antes de pintar. Una funda que
 * revienta se lleva por delante la hoja entera.
 */

/**
 * El desgaste en palabras. QUÉ HAY, NUNCA CUÁNTO.
 *
 * `firmaVisible` (utils/graduacion.ts) describe lo que el jugador puede
 * distinguir de una copia sin graduarla, y el invariante de
 * scripts/test-invariantes.mjs agrupa por esa descripción para exigir que
 * ningún estado visible compense graduarlo. Allí los recuentos van por tramos,
 * así que escribir "6 piques" enseñaría más de lo que el invariante protege.
 * El 1,5 % del descentrado es su mismo umbral para llamar "torcida" a una copia.
 */

/* El bolsillo: papel de la hoja visto a través del plástico. El `inset` de
 * arriba es el canto iluminado del plástico y el de abajo la sombra que
 * proyecta la carta dentro de la funda; los dos con box-shadow, que pinta sin
 * rasterizar el contenido. */
const FUNDA: React.CSSProperties = {
  background:
    "linear-gradient(158deg, color-mix(in srgb, var(--ink) 5%, transparent) 0%, transparent 38%), var(--surface-2)",
  border: "1px solid var(--border)",
  boxShadow:
    "inset 0 1px 0 color-mix(in srgb, #fff 20%, transparent), inset 0 -7px 12px -9px rgba(0,0,0,0.45)",
};

/* Reflejo del plástico. Sólo cubre la esquina superior izquierda (se apaga al
 * 34% del recorrido) para no lavar la ilustración: un velo blanco sobre toda
 * la carta se nota mucho más de lo que aporta, sobre todo en tema claro. */
const BRILLO: React.CSSProperties = {
  background:
    "linear-gradient(118deg, rgba(255,255,255,0.20) 0%, rgba(255,255,255,0.07) 17%, rgba(255,255,255,0) 34%)",
};

/* El interior del hueco: el rectángulo de papel que se ve por el plástico
 * cuando no hay carta. Mantiene el mismo `aspect-[2.5/3.5]` que tendría la
 * carta para que una fila entera de huecos —en un archivador recién estrenado,
 * las nueve— mida exactamente igual que una fila llena y la hoja no cambie de
 * alto al pasar de página.
 *
 * El BORDE no está aquí sino en clases, aunque el resto del fichero pinte con
 * `style`: un `border` en línea gana siempre a cualquier clase, y el realce al
 * pasar el ratón sobre el hueco es justamente cambiarle el color al borde. */
const HUECO: React.CSSProperties = {
  background:
    "linear-gradient(150deg, color-mix(in srgb, var(--ink) 3%, transparent), transparent 60%)",
};

export default function FundaCarta({
  carta,
  onTocar,
  posicion,
  invita = false,
}: FundaCartaProps) {
  /* ---------------------------------------------------------------- */
  /* FUNDA VACÍA                                                       */
  /* ---------------------------------------------------------------- */
  if (!carta) {
    const dentro = (
      <div
        className="flex w-full aspect-[2.5/3.5] flex-col items-center justify-center gap-1 rounded-[4.5%] border border-dashed border-[var(--border-strong)] p-[6%] text-center transition-colors md:group-hover/funda:border-[var(--accent)]"
        style={HUECO}
      >
        {/* El "+" va en un círculo con borde y no como signo suelto: sobre el
            papel tramado un glifo fino a 12px se pierde, y el círculo además
            marca dónde hay que tocar. */}
        <span
          aria-hidden="true"
          className="flex h-6 w-6 items-center justify-center rounded-full sm:h-7 sm:w-7"
          style={{
            border: "1px solid var(--border-strong)",
            color: "var(--ink-soft)",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="h-3.5 w-3.5"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </span>
        {invita && (
          <span className="ink-soft text-[9px] leading-tight sm:text-[11px]">
            Coloca aquí tu primera carta
          </span>
        )}
      </div>
    );

    /* Sin manejador el hueco es decoración pura (la hoja que gira). Se oculta
     * al lector: la hoja de debajo ya anuncia lo mismo y duplicarlo durante
     * medio segundo de animación sólo confundiría. */
    if (!onTocar) {
      return (
        <div aria-hidden="true" className="rounded-[6%] p-[4%]" style={FUNDA}>
          {dentro}
        </div>
      );
    }

    return (
      <div className="group/funda rounded-[6%] p-[4%]" style={FUNDA}>
        <button
          type="button"
          onClick={onTocar}
          aria-label={`Funda ${posicion} de 9, vacía. Colocar una carta`}
          /* Nada de `press`: esa clase escala, y aunque en el hueco no haya
             ilustración, la funda de al lado sí la tiene y el realce no puede
             comportarse distinto según lo que le hayan puesto dentro. El
             realce es el borde del hueco, como en el selector. */
          className="block w-full cursor-pointer rounded-[4.5%] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          {dentro}
        </button>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /* FUNDA OCUPADA                                                     */
  /* ---------------------------------------------------------------- */

  const copias = carta.quantity;
  /**
   * La carta está puesta pero ya no se tiene: se vendió (o se cambió) DESPUÉS
   * de colocarla. Ni el servidor ni el archivador local vacían la funda solos
   * —sería borrarle al jugador algo que él puso— así que hay que explicar por
   * qué sigue ahí, y hacerlo sin apagar la carta: `opacity` sobre un ancestro
   * de la ilustración crea contexto de apilamiento y nos devuelve al problema
   * de la capa compositada. Se marca con una insignia y con el rótulo.
   */
  const huerfana = copias <= 0;
  const nombre = carta.name || "carta sin datos";
  /* El desgaste que se pinta aquí NO ES NECESARIAMENTE EL DE ESTA COPIA, y hay
   * que saberlo antes de escribir nada sobre él.
   *
   * `binder_slots` guarda hoja, ranura y card_id: NO guarda qué copia se puso.
   * Y `getArchivador` rellena el estado con estadoDeLaMejorCopia(userId, id,
   * copias), que devuelve el desgaste de la MEJOR de las copias 1..N. Así que
   * con tres Pikachu y el primero en la funda, lo que se ve son los piques del
   * tercero.
   *
   * Aquí decía lo contrario —«la copia que hay EN ESTA FUNDA se ve como está:
   * si salió machacada del sobre, en el archivador sigue machacada»— y era
   * falso. Se corrige porque ese comentario era justamente el que invitaba a
   * escribir texto afirmando cosas de "esta copia": había un `title` y un
   * sufijo en el `aria-label` que decían «Copia dañada: se le ven piques en los
   * cantos», y describían una copia que la aplicación no sabe identificar.
   *
   * LOS DOS SE HAN QUITADO, y no sólo por esto: el dueño del juego pidió que no
   * se le informe por escrito del desgaste salvo en las cartas graduadas. Se le
   * preguntó si eran sólo los rótulos o también las marcas pintadas y eligió
   * expresamente sólo los rótulos, así que la capa de DesperfectosCarta sigue
   * ahí y el desgaste SE VE. Simplemente ya no se nombra, que además es lo
   * único honesto mientras no se sepa de qué copia es.
   *
   * SI ALGÚN DÍA SE QUIERE QUE LA FUNDA ENSEÑE SU COPIA DE VERDAD, el arreglo
   * no es volver a poner el texto: es guardar el índice de copia en
   * `binder_slots` al colocarla. Hasta entonces, esto es una aproximación y hay
   * que tratarla como tal.
   *
   * Sólo llega en las copias que de verdad se ven mal; en el resto es null y la
   * funda se pinta exactamente como siempre. */
  const estado = estadoDeCopia(carta);

  /* El realce va en un div interior y no en el <button> para que el transform
   * no arrastre el anillo de foco fuera de sitio. Sólo translate: ver la
   * cabecera. */
  const contenido = (
    <div className="transition-transform duration-300 md:group-hover/funda:-translate-y-1 pointer-events-none">
      {estado ? (
        /* Marco + tira, el mismo montaje que
           components/graduacion/CartaConDesperfectos.tsx: el descentrado de una
           carta mal cortada no se pinta, se MUEVE la ilustración dentro del
           marco y el marco recorta; por el lado del que se retira asoma el
           papel del cartón, que es el fondo. El marco es además el `relative` +
           `overflow-hidden` que DesperfectosCarta exige a su contenedor.

           El desplazamiento es `translate` y NUNCA `scale`, como el realce del
           ratón y por lo mismo: aquí hay tres ancestros muy cerca (la funda, la
           hoja y la ventana del pase de página) y basta que uno promocione la
           capa para que la ilustración salga borrosa en iPhone. Ver la
           cabecera. */
        <div
          className="relative w-full overflow-hidden rounded-[4.5%]"
          style={{ background: "var(--surface-2)" }}
        >
          <div style={estiloDescentrado(estado.desperfectos)}>
            <PokemonCard card={carta} reveal={true} interactive={false} />
          </div>
          <DesperfectosCarta
            desperfectos={estado.desperfectos}
            marcas={estado.marcas}
          />
        </div>
      ) : (
        <PokemonCard card={carta} reveal={true} interactive={false} />
      )}
    </div>
  );

  return (
    /* `group/funda` con nombre y no `group` a secas: la hoja y la vitrina
       también son contenedores, y un grupo anónimo dentro de otro engancha el
       hover al ancestro equivocado.

       EL DESGASTE NO LLEVA INSIGNIA, y es la única de las tres pantallas donde
       no la lleva. Las esquinas de la funda ya están repartidas entre la
       favorita, el aviso de huérfana y el contador de copias, y a nueve cartas
       por hoja una pastilla más taparía justo la ilustración que la vitrina
       existe para enseñar. Aquí las marcas SE VEN de sobra; lo que faltaba era
       poder preguntar por qué, y eso lo dan el `title` (puntero) y el rótulo
       del botón (lector de pantalla). */
    <div
      className="group/funda relative rounded-[6%] p-[4%]"
      style={FUNDA}
    >
      {onTocar ? (
        <button
          type="button"
          onClick={onTocar}
          /* El rótulo dice las copias, el aviso de huérfana y el estado de la
           * copia porque las tres cosas se pintan de forma decorativa: quien
           * navega con lector no ve ni el "×3", ni el aviso de la esquina, ni
           * los piques de los cantos. Y dice "opciones" y no "ver" porque el
           * toque ya no abre la carta: abre el menú de la funda (ver, cambiar
           * o quitar). */
          aria-label={
            `Funda ${posicion} de 9, ${nombre}` +
            (huerfana
              ? ", ya no la tienes en la colección"
              : copias > 1
                ? `, ${copias} copias`
                : "") +
            ". Abrir opciones"
          }
          className="block w-full cursor-pointer rounded-[4.5%] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          {contenido}
        </button>
      ) : (
        // Hoja que gira: se ve, no se toca ni se anuncia.
        <div aria-hidden="true">{contenido}</div>
      )}

      {/* Reflejo del plástico. Va POR ENCIMA de la carta (si no, no es un
          reflejo) y por debajo de las insignias, y con pointer-events-none
          para no tragarse el toque que abre el menú. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-10 rounded-[6%]"
        style={BRILLO}
      />

      {/* FAVORITA — arriba a la izquierda, que es la zona muerta del arte de
          casi toda carta (el nombre va arriba a la derecha o centrado). */}
      {carta.is_favorite && (
        <div
          aria-hidden="true"
          className="absolute left-[7%] top-[5%] z-20 flex h-5 w-5 items-center justify-center rounded-full bg-rose-500"
          style={{ boxShadow: "var(--shadow-sm)" }}
        >
          <svg viewBox="0 0 24 24" fill="white" className="h-3 w-3">
            <path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 5.5 5.5 5.5 0 0 1 21.5 12c-2.5 4.5-9.5 9-9.5 9z" />
          </svg>
        </div>
      )}

      {/* YA NO LA TIENES — arriba a la derecha, el único rincón que no se pelea
          con la favorita (izquierda) ni con las copias (abajo). Discreto a
          propósito: no es un error del jugador ni hay nada que arreglar, sólo
          hay que poder entender por qué está ahí una carta que ya no está en la
          colección. */}
      {huerfana && (
        <div
          aria-hidden="true"
          title="Ya no tienes esta carta"
          className="absolute right-[6%] top-[5%] z-20 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold leading-none"
          style={{
            background: "var(--surface)",
            color: "var(--warn-ink)",
            border: "1px solid var(--border-strong)",
            boxShadow: "var(--shadow-sm)",
          }}
        >
          !
        </div>
      )}

      {/* COPIAS — abajo a la derecha, encima del número impreso, que es la
          esquina de la carta con menos ilustración que tapar. Sólo si hay
          repetidas: un "×1" en las fundas de todo el archivador sería ruido
          puro. Cuentan las que se TIENEN, no las que hay en esta funda (en una
          funda cabe una); es el mismo número que gobierna cuántas veces se
          puede colocar la misma carta. */}
      {copias > 1 && (
        <div
          aria-hidden="true"
          className="tnum absolute bottom-[5%] right-[6%] z-20 rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none"
          style={{
            background: "var(--ink)",
            color: "var(--bg)",
            border: "1px solid var(--border-strong)",
            boxShadow: "var(--shadow-sm)",
          }}
        >
          ×{copias}
        </div>
      )}
    </div>
  );
}
