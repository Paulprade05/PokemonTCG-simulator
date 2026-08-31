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
// iPhone (components/PokemonCard.tsx:140-163). El sello de la nota SÍ se anima
// con muelle y escala, y es correcto: vive fuera del contenedor de la carta, no
// es ancestro suyo. Ese es el único sitio de esta pantalla donde hay un `scale`
// y por eso está aquí escrito.

import { useMemo, useState } from "react";
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

interface Props {
  resultados: Resultado[];
  /** Qué se ha hecho ya con cada copia, por `claveCopia`. */
  decisiones: Record<string, Decision>;
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
  copias,
  vendiendo,
  compacto,
  onVender,
  onGuardar,
}: {
  resultado: Resultado;
  abierto: boolean;
  decision: Decision | undefined;
  copias: number;
  vendiendo: boolean;
  compacto: boolean;
  onVender: () => void;
  onGuardar: () => void;
}) {
  const [verLimpia, setVerLimpia] = useState(false);
  const { carta, nota, desperfectos, marcas: marcasVisuales, valor } = resultado;
  const marcas = abierto && !verLimpia;

  /* LAS DOS RAZONES POR LAS QUE NO SE PUEDE VENDER, dichas antes de tocar nada.
   * El servidor las comprueba igual y devuelve "ultima-copia" o "sin-valor",
   * pero un botón que sólo sirve para enseñar un error no es un botón. */
  const esUltimaCopia = copias <= 1;
  const noValeNada = valor <= 0;
  /* Y la tercera, que es momentánea: `venderGraduadaAction` sólo acepta el id
   * de la fila de graded_cards, y ese id llega con la vitrina, un instante
   * después que la nota. Ver la cabecera de Graduacion.tsx. */
  const sinFicha = resultado.gradedId === undefined;
  const sePuedeVender = !esUltimaCopia && !noValeNada && !sinFicha && !decision;

  return (
    <div className={compacto ? "surface rounded-2xl p-3 flex flex-col gap-3" : "flex flex-col items-center gap-4"}>
      {/* La carta y, mientras está sellada, la banda que lo dice. El envoltorio
          es `relative` a secas: sin transform, sin filtro, sin nada que promueva
          la carta a capa compositada. */}
      <div className={compacto ? "relative w-full" : "relative w-[min(62vw,230px)]"}>
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
              transition={{ duration: 0.3 }}
              className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 z-40 py-2 text-center"
              style={{
                background: "color-mix(in srgb, var(--ink) 82%, transparent)",
                color: "var(--bg)",
              }}
            >
              <span className="text-[10px] font-bold uppercase tracking-[0.28em]">Sellado</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className={compacto ? "min-w-0" : "text-center min-w-0 w-full"}>
        <p className={`font-semibold truncate ${compacto ? "text-[13px]" : "text-base"}`}>
          {carta.name}
        </p>
        <p className="text-[11px] ink-faint truncate">
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
            initial={{ opacity: 0, scale: 0.82 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 420, damping: 24 }}
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
          transition={{ duration: 0.4, delay: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className={compacto ? "flex flex-col gap-2" : "flex flex-col items-center gap-3 w-full"}
        >
          <p className={`text-[11px] ink-soft leading-snug ${compacto ? "" : "text-center max-w-xs"}`}>
            {enPalabras(desperfectos).join(" · ")}
          </p>

          {/* LO QUE VALE AHORA. Se dice el multiplicador y el valor anterior
              porque un "vale 38" a secas no informa: lo que se está juzgando es
              si la graduación ha subido o hundido la carta. */}
          <div
            className="rounded-xl px-3 py-2 flex items-baseline gap-2 tnum"
            style={{ background: "var(--surface-2)" }}
          >
            <span className="text-[11px] ink-soft">Ahora vale</span>
            <span className="text-lg font-bold" style={{ color: tintaDeNota(nota) }}>
              {formatNumber(valor)}
            </span>
            <span className="text-[11px] ink-faint">
              {multiplicador(MULTIPLICADOR_NOTA[nota] ?? 0)} sobre {formatNumber(carta.valor)}
            </span>
          </div>

          {/* El "antes y después": la misma copia sin las marcas encima. */}
          <button
            type="button"
            onClick={() => setVerLimpia((v) => !v)}
            aria-pressed={verLimpia}
            className="chip ink-soft text-[11px] px-3 py-1.5 press"
          >
            {verLimpia ? "Ver los desperfectos" : "Ver la carta limpia"}
          </button>

          {/* DECIDIR */}
          {decision === "vendida" ? (
            <p className="text-[11px] font-semibold" style={{ color: "var(--ok)" }}>
              Vendida por {formatNumber(valor)} monedas
            </p>
          ) : decision === "guardada" ? (
            <p className="text-[11px] ink-soft">Guardada en la vitrina</p>
          ) : (
            <div className={`flex gap-2 ${compacto ? "" : "w-full max-w-xs"}`}>
              <button
                type="button"
                onClick={onGuardar}
                disabled={vendiendo}
                className="btn-ghost press touch-target flex-1 rounded-xl text-[12px] font-medium px-3 disabled:opacity-40"
              >
                Guardar
              </button>
              <button
                type="button"
                onClick={onVender}
                disabled={!sePuedeVender || vendiendo}
                aria-busy={vendiendo}
                className="btn-accent press touch-target flex-1 rounded-xl text-[12px] font-semibold px-3 flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {vendiendo ? (
                  <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                ) : (
                  <>Vender · {formatNumber(valor)}</>
                )}
              </button>
            </div>
          )}

          {/* LA ÚLTIMA COPIA, explicada donde se toma la decisión y no en un
              aviso que salta después. Es la misma regla que protege el álbum en
              el resto del juego: nunca te quedas sin la carta. */}
          {!decision && esUltimaCopia && (
            <p className="text-[11px] ink-faint leading-snug max-w-xs">
              Es la última copia que te queda de esta carta: hay que quedarse con una. Consigue otra
              copia y entonces podrás venderla.
            </p>
          )}
          {!decision && !esUltimaCopia && noValeNada && (
            <p className="text-[11px] ink-faint leading-snug max-w-xs">
              Un {nota} multiplica por cero: nadie paga por ella. Se queda en tu vitrina como
              recuerdo.
            </p>
          )}
          {!decision && !esUltimaCopia && !noValeNada && sinFicha && (
            <p className="text-[11px] ink-faint leading-snug max-w-xs">
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
            <h2 className="text-sm font-semibold">
              {formatNumber(total)} {total === 1 ? "copia graduada" : "copias graduadas"}
            </h2>
            <p className="text-[11px] ink-soft tnum mt-0.5">
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
            className="btn-ghost press touch-target px-4 rounded-xl text-xs font-medium shrink-0"
          >
            {sinDecidir > 0 ? "Guardar el resto y salir" : "Volver a graduar"}
          </button>
        </div>

        {sinDecidir > 0 && (
          <p className="text-[11px] ink-faint text-center">
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
        <p className="text-[11px] ink-soft tnum uppercase tracking-[0.16em]">
          Informe {indice + 1} de {total}
        </p>
        {total > 1 && (
          <button
            type="button"
            onClick={revelarTodas}
            className="chip ink-soft text-[11px] px-3 py-2 press touch-target"
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
        copias={copiasPorCarta[actual.cardId] ?? 0}
        vendiendo={actual.gradedId !== undefined && actual.gradedId === vendiendoId}
        onVender={() => onVender(actual)}
        onGuardar={() => onGuardar(actual)}
      />

      <div className="flex justify-center">
        {!abierto ? (
          <button
            type="button"
            onClick={abrir}
            className="btn-accent press touch-target w-full max-w-xs rounded-2xl py-3.5 text-sm font-semibold"
          >
            Abrir el informe
          </button>
        ) : (
          <button
            type="button"
            onClick={siguiente}
            className="btn-ghost press touch-target w-full max-w-xs rounded-2xl py-3.5 text-sm font-medium"
          >
            {indice + 1 >= total ? "Ver el resumen" : "Siguiente copia"}
          </button>
        )}
      </div>
    </div>
  );
}
