"use client";

// components/graduacion/Revelacion.tsx
//
// LA CEREMONIA. Es el momento de la función: las copias vuelven del graduador y
// se abren de una en una.
//
// ============================================================================
// POR QUÉ ESTO NO ES UNA TRAGAPERRAS AUNQUE LO PAREZCA
// ============================================================================
//
// La nota de cada copia estaba decidida desde que la carta entró en la
// colección (utils/graduacion.ts la deriva de una semilla estable). El servidor
// ya la ha devuelto entera antes de que aquí se pinte nada: todo lo que pasa en
// esta pantalla es TEATRO SOBRE UN DATO YA CERRADO. Por eso no hay contador que
// suba ni ruleta que gire —eso sugeriría que el número se está decidiendo
// mientras miras—, sino un sobre lacrado que se abre: primero la nota, y un
// instante después las marcas que la justifican apareciendo sobre la
// ilustración. La secuencia cuenta la verdad: "esto ya era así, mira por qué".
//
// EL BOTÓN DE "REVELAR TODAS" NO ES UNA CONCESIÓN, ES OBLIGATORIO. Se pueden
// mandar cuarenta copias de una tacada; cuarenta aperturas de tres toques cada
// una convierten la ceremonia en un peaje. Quien quiera el ritual lo tiene, y
// quien venga a limpiar repetidas se salta el ritual y decide en la rejilla.
//
// ============================================================================
// LO QUE NO SE PUEDE HACER AQUÍ
// ============================================================================
//
// Ninguna animación de las cartas puede llevar `scale`, `filter` ni
// `mix-blend-mode`: la carta se rasterizaría a escala fija y saldría borrosa en
// iPhone (el comentario de `settled` en components/PokemonCard.tsx). El sello
// de la nota SÍ se anima con muelle y escala, y es correcto: vive fuera del
// contenedor de la carta, no es ancestro suyo. Ese es el único sitio de esta
// pantalla donde hay un `scale` y por eso está aquí escrito.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AnimatePresence, motion } from "framer-motion";
import CartaConDesperfectos from "./CartaConDesperfectos";
import {
  SelloNota,
  claveCopia,
  multiplicador,
  tintaDeNota,
  type Decision,
  type Resultado,
} from "./Comun";
import {
  MULTIPLICADOR_NOTA,
  etiquetaNota,
  type Desperfectos,
} from "../../utils/graduacion";
import { formatNumber } from "../../utils/format";
import { useHaptics } from "../../hooks/useHaptics";
import { D, EASE_OUT, MUELLE_PILDORA } from "../../utils/motion";

interface Props {
  resultados: Resultado[];
  /** Qué se ha hecho ya con cada copia, por `claveCopia`. */
  decisiones: Record<string, Decision>;
  /**
   * Lo que el servidor abonó por cada copia vendida, por `claveCopia`. Es lo
   * que escribe el «Vendida por X»: si se recalculara, el rótulo podría decir
   * una cifra distinta de la del aviso que acaba de salir.
   */
  cobradoPorCopia: Record<string, number>;
  /** Copias de cada carta que quedan en la colección, para la última copia. */
  copiasPorCarta: Record<string, number>;
  /** `gradedId` de la venta en vuelo, o null. */
  vendiendoId: number | null;
  onVender: (resultado: Resultado) => void;
  onGuardar: (resultado: Resultado) => void;
  onTerminar: () => void;
  /** Lo que ha cobrado el servidor y con qué descuento, para el encabezado. */
  cobrado: number;
  descuento: number;
}

/* ==================================================================== *
 * EL ANCHO DE LA CARTA EN LA CEREMONIA SALE TAMBIÉN DEL ALTO DE LA PANTALLA
 * ====================================================================
 *
 * Era `min(62vw, 230px)`: sólo miraba el ancho. A 375 px eso son 230 de ancho
 * y 322 de alto, y con lo que la carta lleva encima y debajo «Abrir el
 * informe» caía en y=642-691 sin contar zonas seguras. Instalada en un iPhone
 * de 812 px hay que sumar 47 de barra de estado: el botón quedaba medio tapado
 * por la barra de pestañas, y en un SE (667 px) o en Safari con sus barras,
 * entero por debajo.
 *
 * Mismo remedio que la apertura de sobre (BoosterPack) y el archivador
 * (LibroArchivador): el ancho es el menor entre el de siempre y el que sale de
 * repartir el alto que queda. La reserva de 324 px es la suma de lo que rodea
 * a la carta dentro del <main>, medida con la tipografía de la casa:
 *
 *     24  relleno superior del <main>
 *     70  PageHeader con su margen
 *     44  fila «Informe N de M» + «Revelar todas»
 *     48  dos huecos de 20 y las tiras de progreso (4)
 *     55  hueco de 16 y el nombre con su línea de apoyo
 *     20  hueco hasta el pie
 *     61  el botón (49) y el aire de debajo (12)
 *    ---
 *    322, más 2 de holgura
 *
 * TopBar, zona segura superior y barra de pestañas van aparte, con sus
 * variables. 0,714 es la proporción de una carta (63 × 88 mm).
 *
 * EL SUELO DE 9,5rem: en una pantalla muy baja (un SE, o Safari con el teclado
 * o las barras fuera) la cuenta daría una carta de sello de correos. Antes que
 * eso se deja que el nombre quede unos píxeles bajo el pie pegado: el botón
 * sigue a la vista, que es lo que no podía fallar, y lo demás se desplaza.
 */
const ANCHO_CARTA_CEREMONIA =
  "max(9.5rem, min(62vw, 230px, calc((var(--app-height) - var(--sat) - var(--topbar-h) - var(--content-bottom) - 324px) * 0.714)))";

/** Aire que se deja entre el sello y el pie pegado al llevarlo a la vista. */
const AIRE_SOBRE_EL_PIE = 16;

/**
 * Los desperfectos en palabras. Es la parte del informe que explica la nota:
 * sin esto, un 6 es un número arbitrario; con esto, un 6 son cinco piques y un
 * descentrado del 1,1% que se pueden ver en la ilustración de al lado.
 */
function enPalabras(d: Desperfectos): string[] {
  const partes: string[] = [];
  if (d.piques > 0) {
    partes.push(`${d.piques} ${d.piques === 1 ? "pique" : "piques"} en los cantos`);
  }
  if (d.aranazos > 0) {
    partes.push(`${d.aranazos} ${d.aranazos === 1 ? "arañazo" : "arañazos"}`);
  }
  if (d.manchas > 0) {
    partes.push(`${d.manchas} ${d.manchas === 1 ? "mancha" : "manchas"}`);
  }
  const desvio = Math.max(Math.abs(d.descentrado.x), Math.abs(d.descentrado.y));
  if (desvio >= 0.1) {
    partes.push(
      `descentrada un ${desvio.toLocaleString("es-ES", { maximumFractionDigits: 1 })} %`,
    );
  }
  if (d.palidez > 0) partes.push("decolorada por el sol");
  if (partes.length === 0) partes.push("sin un solo defecto a la vista");
  return partes;
}

/* ==================================================================== *
 * EL INFORME DE UNA COPIA
 * ====================================================================
 *
 * Lo comparten la ceremonia (a tamaño grande, de una en una) y la rejilla del
 * resumen (pequeño, todas a la vez). Es el mismo bloque porque es la misma
 * información: la carta con sus marcas, la nota, lo que vale y qué hacer con
 * ella. Duplicarlo garantizaría que uno de los dos se quedara sin el aviso de
 * la última copia.
 */
function Informe({
  resultado,
  abierto,
  decision,
  cobrado,
  copias,
  vendiendo,
  compacto,
  onVender,
  onGuardar,
  selloRef,
}: {
  /** Sólo la ceremonia: le deja a la pantalla medir dónde ha caído el sello. */
  selloRef?: RefObject<HTMLDivElement | null>;
  resultado: Resultado;
  abierto: boolean;
  decision: Decision | undefined;
  /** Lo que el servidor pagó por esta copia, si ya se vendió. */
  cobrado: number | undefined;
  copias: number;
  vendiendo: boolean;
  compacto: boolean;
  onVender: () => void;
  onGuardar: () => void;
}) {
  const [verLimpia, setVerLimpia] = useState(false);
  const { carta, nota, desperfectos, marcas: marcasVisuales, valor } = resultado;
  const marcas = abierto && !verLimpia;

  /* ================================================================== *
   * LAS DOS CIFRAS DE ESTA FICHA, Y POR QUÉ NO SON LA MISMA
   * ==================================================================
   *
   * `valor` es lo que la copia VALE ya graduada: la tarifa de la carta por el
   * multiplicador de la nota. Es el número del "Ahora vale", que existe para
   * comparar con lo que valía antes, y es también el que el bazar usa para la
   * banda de precio de un anuncio.
   *
   * `venta` es lo que la TIENDA PAGA si se vende ahora mismo, y lo calcula el
   * servidor: la curva de repetidas (cada copia de más vale menos que la
   * anterior) con la nota encima. Con dos copias coinciden; a partir de la
   * tercera, no.
   *
   * El botón dice `venta` porque un botón es una promesa de pago, y hasta ahora
   * decía `valor`: prometía 488 y el aviso contestaba «+417».
   */
  const venta = resultado.valorDeVentaAhora;

  /* LAS DOS RAZONES POR LAS QUE NO SE PUEDE VENDER, dichas antes de tocar nada.
   * El servidor las comprueba igual y devuelve "ultima-copia" o "sin-valor",
   * pero un botón que sólo sirve para enseñar un error no es un botón.
   *
   * "No vale nada" se mide sobre `valor` y no sobre `venta`: lo que multiplica
   * por cero es LA NOTA, y ése es el motivo que se le explica al jugador. Una
   * `venta` a cero con copias de sobra no existe —la curva nunca baja de 1— y,
   * cuando la copia es la única que queda, manda el aviso de la última copia. */
  const esUltimaCopia = copias <= 1;
  const noValeNada = valor <= 0;
  /* Y la tercera, que es momentánea: `venderGraduadaAction` sólo acepta el id
   * de la fila de graded_cards, y ese id —junto con el importe que se va a
   * abonar— llega con la vitrina, un instante después que la nota. Ver la
   * cabecera de Graduacion.tsx. */
  const sinFicha = resultado.gradedId === undefined || venta === undefined;
  const sePuedeVender = !esUltimaCopia && !noValeNada && !sinFicha && !decision;

  return (
    <div className={compacto ? "surface rounded-2xl p-3 flex flex-col gap-3" : "flex flex-col items-center gap-4"}>
      {/* La carta y, mientras está sellada, la banda que lo dice. El envoltorio
          es `relative` a secas: sin transform, sin filtro, sin nada que promueva
          la carta a capa compositada. */}
      <div
        className={compacto ? "relative w-full" : "relative"}
        style={compacto ? undefined : { width: ANCHO_CARTA_CEREMONIA }}
      >
        <CartaConDesperfectos
          carta={carta}
          desperfectos={desperfectos}
          marcas={marcasVisuales}
          nota={nota}
          mostrarMarcas={marcas}
          altaResolucion={!compacto}
        />
        <AnimatePresence>
          {!abierto && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: D.base }}
              className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 z-40 py-2 text-center"
              style={{
                background: "color-mix(in srgb, var(--ink) 82%, transparent)",
                color: "var(--bg)",
              }}
            >
              <span className="t-etiqueta font-bold">Sellado</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className={compacto ? "min-w-0" : "text-center min-w-0 w-full"}>
        <p className={`font-semibold truncate ${compacto ? "t-cuerpo" : "t-base"}`}>
          {carta.name}
        </p>
        <p className="t-meta ink-soft truncate">
          {carta.rarity} · copia n.º {resultado.copia}
        </p>
      </div>

      {/* EL SELLO. Fuera del contenedor de la carta a propósito: es el único
          elemento de la pantalla que se anima con muelle y escala, y no puede
          ser ancestro de ninguna ilustración. */}
      <AnimatePresence mode="wait">
        {abierto && (
          <motion.div
            key="sello"
            ref={selloRef}
            initial={{ opacity: 0, scale: 0.82 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={MUELLE_PILDORA}
            className="flex flex-col items-center gap-2"
          >
            <SelloNota nota={nota} tamano={compacto ? "sm" : "lg"} />
          </motion.div>
        )}
      </AnimatePresence>

      {abierto && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          // Entra después del sello: primero el veredicto, luego el porqué.
          transition={{ duration: D.slow, delay: 0.35, ease: EASE_OUT }}
          className={compacto ? "flex flex-col gap-2" : "flex flex-col items-center gap-3 w-full"}
        >
          <p className={`t-meta ink-soft leading-snug ${compacto ? "" : "text-center max-w-xs"}`}>
            {enPalabras(desperfectos).join(" · ")}
          </p>

          {/* LO QUE VALE AHORA. Se dice el multiplicador y el valor anterior
              porque un "vale 38" a secas no informa: lo que se está juzgando es
              si la graduación ha subido o hundido la carta.

              LA PASTILLA PARTE POR DONDE SE LE DICE, no por donde le pilla. Era
              un `flex` sin `flex-wrap` con tres textos que se rompían palabra a
              palabra: en la rejilla de dos columnas del resumen, a 320 px, la
              pastilla medía 112 y su contenido 146, y «×1,5 sobre 823» se
              pintaba 9 px dentro de la ficha de al lado. Ahora el rótulo y la
              cifra no se parten nunca, saltan de línea enteros si no caben, y
              en la ficha pequeña la comparación va siempre en su propio
              renglón. Allí la cifra baja además un escalón (16 px y no 20): en
              112 px de caja, la de 20 no dejaba sitio ni al rótulo. */}
          <div
            className={`rounded-xl py-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 tnum ${
              compacto ? "px-2.5" : "px-3"
            }`}
            style={{ background: "var(--surface-2)" }}
          >
            <span className="t-meta ink-soft whitespace-nowrap">Ahora vale</span>
            <span
              className={`font-bold whitespace-nowrap ${compacto ? "t-base" : "t-titulo"}`}
              style={{ color: tintaDeNota(nota) }}
            >
              {formatNumber(valor)}
            </span>
            <span className={`t-meta ink-soft min-w-0 ${compacto ? "basis-full" : ""}`}>
              {multiplicador(MULTIPLICADOR_NOTA[nota] ?? 0)} sobre{" "}
              {formatNumber(carta.valorDeReferencia)}
            </span>
          </div>

          {/* El "antes y después": la misma copia sin las marcas encima.
              `touch-target`: medía 29 px de alto y en la ficha pequeña cae justo
              encima de «Vender», que es el botón que no se puede tocar sin
              querer. */}
          <button
            type="button"
            onClick={() => setVerLimpia((v) => !v)}
            aria-pressed={verLimpia}
            className="chip ink-soft t-meta px-3 py-1.5 press touch-target"
          >
            {verLimpia ? "Ver los desperfectos" : "Ver la carta limpia"}
          </button>

          {/* DECIDIR */}
          {decision === "vendida" ? (
            /* LO QUE SE COBRÓ, dicho por el servidor. Aquí ponía `valor` —la
               tarifa por la nota— mientras el aviso decía el importe real: la
               misma copia con dos precios a diez centímetros. El respaldo es
               `venta`, el precio que el propio botón acababa de prometer. */
            <p className="t-meta font-semibold" style={{ color: "var(--ok)" }}>
              Vendida por {formatNumber(cobrado ?? venta ?? 0)} monedas
            </p>
          ) : decision === "guardada" ? (
            <p className="t-meta ink-soft">Guardada en la vitrina</p>
          ) : (
            /* EN LA FICHA PEQUEÑA LOS DOS BOTONES VAN APILADOS, cada uno a todo
               el ancho. Lado a lado se repartían 112 px: «Guardar» medía 46 en
               un botón de 53 con relleno y asomaba 6 por la derecha, y «Vender
               · 1.050» se partía en dos líneas. «Vender» queda arriba —es el
               único de los dos que hace algo; guardar sólo anota la decisión—
               con `flex-col-reverse`, para no cambiar el orden del DOM (y con
               él el del foco) entre la ceremonia y el resumen. */
            <div className={`flex gap-2 ${compacto ? "flex-col-reverse" : "w-full max-w-xs"}`}>
              <button
                type="button"
                onClick={onGuardar}
                disabled={vendiendo}
                className={`btn-ghost press touch-target rounded-xl t-cuerpo-2 font-medium disabled:opacity-40 ${
                  compacto ? "w-full px-2" : "flex-1 px-3"
                }`}
              >
                Guardar
              </button>
              <button
                type="button"
                onClick={onVender}
                disabled={!sePuedeVender || vendiendo}
                aria-busy={vendiendo}
                className={`btn-accent press touch-target rounded-xl t-cuerpo-2 leading-tight font-semibold flex items-center justify-center gap-2 text-center disabled:opacity-40 disabled:cursor-not-allowed ${
                  compacto ? "w-full px-2" : "flex-1 px-3"
                }`}
              >
                {vendiendo ? (
                  <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                ) : venta === undefined ? (
                  // Sin el precio del servidor no se dice ninguna cifra: el
                  // botón está deshabilitado de todos modos (le falta la ficha).
                  <>Vender</>
                ) : (
                  <>Vender · {formatNumber(venta)}</>
                )}
              </button>
            </div>
          )}

          {/* POR QUÉ SE PAGA MENOS DE LO QUE "VALE". Sólo cuando las dos cifras
              se separan, que es a partir de la tercera copia: sin esta línea,
              "Ahora vale 488" encima de "Vender · 417" parece un error de la
              pantalla y es la regla que sostiene toda la economía de repetidas. */}
          {!decision && sePuedeVender && venta !== undefined && venta < valor && (
            <p className="t-meta ink-soft leading-snug max-w-xs">
              Te pagan menos porque es una repetida: cada copia de más de una misma carta vale
              menos que la anterior.
            </p>
          )}

          {/* LA ÚLTIMA COPIA, explicada donde se toma la decisión y no en un
              aviso que salta después. Es la misma regla que protege el álbum en
              el resto del juego: nunca te quedas sin la carta. */}
          {!decision && esUltimaCopia && (
            <p className="t-meta ink-soft leading-snug max-w-xs">
              Es la última copia que te queda de esta carta: hay que quedarse con una. Consigue otra
              copia y entonces podrás venderla.
            </p>
          )}
          {!decision && !esUltimaCopia && noValeNada && (
            <p className="t-meta ink-soft leading-snug max-w-xs">
              Un {nota} multiplica por cero: nadie paga por ella. Se queda en tu vitrina como
              recuerdo.
            </p>
          )}
          {!decision && !esUltimaCopia && !noValeNada && sinFicha && (
            <p className="t-meta ink-soft leading-snug max-w-xs">
              Esperando la ficha del graduador para poder venderla…
            </p>
          )}
        </motion.div>
      )}
    </div>
  );
}

/* ==================================================================== *
 * LA PANTALLA
 * ==================================================================== */

export default function Revelacion({
  resultados,
  decisiones,
  cobradoPorCopia,
  copiasPorCarta,
  vendiendoId,
  onVender,
  onGuardar,
  onTerminar,
  cobrado,
  descuento,
}: Props) {
  const [indice, setIndice] = useState(0);
  const [abierto, setAbierto] = useState(false);
  /** Con `true` se dejan de pasar copias y se enseñan todas a la vez. */
  const [resumen, setResumen] = useState(false);
  const haptic = useHaptics();
  const selloRef = useRef<HTMLDivElement>(null);
  const pieRef = useRef<HTMLDivElement>(null);

  /* AL ABRIR, EL SELLO TIENE QUE VERSE, y con el pie pegado ya no está
   * garantizado: la nota aparece justo debajo del nombre, que es donde ahora
   * se queda clavado el botón cuando la ficha crece. Sin esto, el instante por
   * el que se ha pagado —ver la nota— ocurriría tapado.
   *
   * Se desplaza LO JUSTO para que el sello asome por encima del pie, no hasta
   * centrarlo: así la carta sigue entera en pantalla y se ven a la vez la nota
   * y las marcas que la justifican, que es la secuencia que cuenta la cabecera
   * de este fichero. Si ya se ve (pantalla alta, escritorio), no se mueve nada.
   *
   * El sello entra con muelle desde escala 0,82, así que en este momento su
   * caja mide un poco menos de lo que acabará midiendo: AIRE_SOBRE_EL_PIE cubre
   * esa diferencia y deja además un respiro. */
  useEffect(() => {
    if (!abierto) return;
    const sello = selloRef.current;
    const pie = pieRef.current;
    if (!sello || !pie) return;
    const tapado =
      sello.getBoundingClientRect().bottom + AIRE_SOBRE_EL_PIE - pie.getBoundingClientRect().top;
    if (tapado > 0) window.scrollBy({ top: tapado, behavior: "smooth" });
  }, [abierto]);

  const total = resultados.length;
  const actual = resultados[indice];

  /** La mejor nota de la tacada. Es el titular del resumen. */
  const mejor = useMemo(
    () => resultados.reduce((m, r) => Math.max(m, r.nota), 0),
    [resultados],
  );

  const abrir = () => {
    // Golpe seco al abrir: es el instante en el que se sabe la nota.
    haptic(actual && actual.nota >= 9 ? "success" : "heavy");
    setAbierto(true);
  };

  const siguiente = () => {
    haptic("tap");
    if (indice + 1 >= total) {
      setResumen(true);
      return;
    }
    setIndice((i) => i + 1);
    setAbierto(false);
  };

  const revelarTodas = () => {
    haptic("select");
    setResumen(true);
  };

  /* ---------------- RESUMEN: TODAS A LA VEZ ----------------
   * También es la salida sin ceremonia posible: con la lista vacía no hay nada
   * que abrir de una en una. Se resuelve en el render y no con un efecto que
   * llame a setResumen, que provocaría un render en cascada por una condición
   * que ya se sabe aquí mismo. */
  if (resumen || total === 0) {
    const sinDecidir = resultados.filter((r) => !decisiones[claveCopia(r.cardId, r.copia)]).length;
    return (
      <div className="flex flex-col gap-5">
        <div className="surface rounded-2xl px-5 py-4 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="t-cuerpo font-semibold">
              {formatNumber(total)} {total === 1 ? "copia graduada" : "copias graduadas"}
            </h2>
            <p className="t-meta ink-soft tnum mt-0.5">
              {formatNumber(cobrado)} monedas de tasas
              {descuento > 0 && ` · con el descuento por volumen aplicado`}
              {mejor > 0 && ` · tu mejor nota: ${mejor} (${etiquetaNota(mejor)})`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              haptic("tap");
              onTerminar();
            }}
            className="btn-ghost press touch-target px-4 rounded-xl t-cuerpo-2 font-medium shrink-0"
          >
            {sinDecidir > 0 ? "Guardar el resto y salir" : "Volver a graduar"}
          </button>
        </div>

        {sinDecidir > 0 && (
          <p className="t-meta ink-soft text-center">
            Lo que no vendas se queda en tu vitrina: guardar no hay que confirmarlo.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {resultados.map((r) => {
            const clave = claveCopia(r.cardId, r.copia);
            return (
              <Informe
                key={clave}
                resultado={r}
                abierto
                compacto
                decision={decisiones[clave]}
                cobrado={cobradoPorCopia[clave]}
                copias={copiasPorCarta[r.cardId] ?? 0}
                vendiendo={r.gradedId !== undefined && r.gradedId === vendiendoId}
                onVender={() => onVender(r)}
                onGuardar={() => onGuardar(r)}
              />
            );
          })}
        </div>
      </div>
    );
  }

  /* ---------------- CEREMONIA: DE UNA EN UNA ---------------- */
  if (!actual) return null;
  const clave = claveCopia(actual.cardId, actual.copia);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <p className="t-etiqueta ink-soft tnum">
          Informe {indice + 1} de {total}
        </p>
        {total > 1 && (
          <button
            type="button"
            onClick={revelarTodas}
            className="chip ink-soft t-meta px-3 py-2 press touch-target"
          >
            Revelar todas
          </button>
        )}
      </div>

      {/* Progreso en tiras y no en barra: con cuarenta copias una barra no dice
          cuántas quedan, y aquí lo que importa es cuántos sobres faltan. */}
      {total > 1 && (
        <div className="flex gap-1" aria-hidden="true">
          {resultados.map((r, i) => (
            <div
              key={claveCopia(r.cardId, r.copia)}
              className="h-1 flex-1 rounded-full"
              style={{
                background:
                  i < indice
                    ? "color-mix(in srgb, var(--ink) 45%, transparent)"
                    : i === indice
                      ? "var(--accent)"
                      : "var(--border)",
              }}
            />
          ))}
        </div>
      )}

      {/* La clave fuerza el remontaje al pasar de copia: sin ella, React
          reutilizaría el mismo Informe y el "ver la carta limpia" de la copia
          anterior seguiría activo sobre la siguiente. */}
      <Informe
        key={clave}
        resultado={actual}
        abierto={abierto}
        compacto={false}
        decision={decisiones[clave]}
        cobrado={cobradoPorCopia[clave]}
        copias={copiasPorCarta[actual.cardId] ?? 0}
        vendiendo={actual.gradedId !== undefined && actual.gradedId === vendiendoId}
        onVender={() => onVender(actual)}
        onGuardar={() => onGuardar(actual)}
        selloRef={selloRef}
      />

      {/* EL PIE, PEGADO AL BORDE INFERIOR. «Abrir el informe» y «Siguiente
          copia» son el único camino hacia delante de esta pantalla, y al abrir
          una copia la ficha crece unos 350 px (sello, desperfectos, valor,
          decisión): «Siguiente copia» se iba fuera y había que desplazar en
          CADA copia, cuarenta veces en una tacada entera.

          `sticky` y no `fixed`, por lo mismo que BarraEnvio.tsx: app/template
          envuelve la ruta en un ancestro con transform. El fondo es el del
          papel, fundido hacia arriba, para que lo que pasa por debajo no se
          lea a través del hueco de los lados; es HERMANO de la ficha, no
          ancestro, y no lleva ni filtro ni transform, así que la carta no
          cambia de capa. Va por encima de la banda «Sellado» (z-40).

          La línea de pegado es el borde de la barra de pestañas y el aire lo
          pone el relleno: con `--content-bottom` a secas quedaban 12 px de
          rendija entre el pie y la barra por los que asomaba el contenido. El
          `-mt-4` compensa el relleno de arriba, para que con la copia sellada
          el botón siga a los 20 px de siempre bajo el nombre. */}
      <div
        ref={pieRef}
        className="sticky z-50 -mt-4 flex justify-center pt-4 pb-3"
        style={{
          bottom: "calc(var(--content-bottom) - 12px)",
          background: "linear-gradient(to top, var(--bg) 70%, transparent)",
        }}
      >
        {!abierto ? (
          <button
            type="button"
            onClick={abrir}
            className="btn-accent press touch-target w-full max-w-xs rounded-2xl py-3.5 t-cuerpo font-semibold"
          >
            Abrir el informe
          </button>
        ) : (
          <button
            type="button"
            onClick={siguiente}
            className="btn-ghost press touch-target w-full max-w-xs rounded-2xl py-3.5 t-cuerpo font-medium"
          >
            {indice + 1 >= total ? "Ver el resumen" : "Siguiente copia"}
          </button>
        )}
      </div>
    </div>
  );
}
