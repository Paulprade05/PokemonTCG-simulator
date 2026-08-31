"use client";

// components/graduacion/Graduacion.tsx
//
// EL GRADUADOR. Mandas copias repetidas, pagas por cada una, y te devuelven la
// nota que esa copia YA TENÍA desde que entró en tu colección.
//
// Esta pieza es la que orquesta: carga, dinero, cerrojos y el paso de una vista
// a otra. Lo que se pinta vive en los componentes de al lado (ListaGraduables,
// BarraEnvio, Revelacion, VitrinaGraduadas, ComoFunciona), y el estado del que
// dependen todos ellos está aquí y sólo aquí.
//
// ============================================================================
// EL DINERO SE MUEVE DOS VECES Y NINGUNA DE LAS DOS PUEDE DUPLICARSE
// ============================================================================
//
// Graduar cobra y vender abona. Las dos acciones son idempotentes en el
// servidor —graduarCartasAction se apoya en el índice único (user_id, card_id,
// copia) y venderGraduadaAction en que el DELETE sólo toca fila una vez—, pero
// la interfaz NO puede depender de eso: hay dos cerrojos de `ref`, uno por
// operación, con el mismo patrón que `saleLockRef` en app/collection/page.tsx.
// El ref y no el estado porque React no aplica un setState hasta el siguiente
// render, y dos toques dentro del mismo frame entrarían los dos.
//
// EL SALDO SE PIDE AL SERVIDOR AL ENTRAR. `useCurrency` guarda las monedas en
// localStorage, que es una caché por dispositivo: en un móvil recién estrenado
// diría el saldo inicial. Esta pantalla desactiva el botón de graduar cuando no
// llega el dinero, así que necesita el saldo de verdad o bloquearía a quien sí
// puede pagar. Es lo mismo que hace app/page.tsx antes de vender sobres.
//
// ============================================================================
// LO QUE LA RESPUESTA DE GRADUAR NO TRAE
// ============================================================================
//
// `graduarCartasAction` devuelve {cardId, copia, nota} y nada más: no trae el
// id de la fila de `graded_cards`, que es lo único que acepta
// `venderGraduadaAction`. Ese id llega con la vitrina, que se recarga justo
// detrás. Por eso la ceremonia empieza AL INSTANTE con los datos que el
// navegador ya tenía (nombre, ilustración, valor) y el botón de vender espera a
// tener ficha en vez de mentir. En la práctica la vitrina vuelve mucho antes de
// que nadie haya abierto el primer sobre.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import {
  getCartasGraduables,
  getUserData,
  getVitrina,
  graduarCartasAction,
  venderGraduadaAction,
} from "../../app/action";
import {
  costeDeGraduar,
  descuentoPorVolumen,
  valorGraduado,
} from "../../utils/graduacion";
import { formatNumber } from "../../utils/format";
import { useCurrency } from "../../hooks/useGameCurrency";
import { useHaptics } from "../../hooks/useHaptics";
import { useToast } from "../ui/Toast";
import PageHeader from "../PageHeader";
import Loader from "../Loader";
import ListaGraduables from "./ListaGraduables";
import BarraEnvio from "./BarraEnvio";
import Revelacion from "./Revelacion";
import VitrinaGraduadas from "./VitrinaGraduadas";
import ComoFunciona from "./ComoFunciona";
import {
  TOPE_POR_TACADA,
  claveCopia,
  escalonesDeDescuento,
  type CartaGraduable,
  type CopiaGraduada,
  type Decision,
  type Resultado,
} from "./Comun";

/* ==================================================================== *
 * LOS ERRORES, EN CASTELLANO
 * ====================================================================
 *
 * Uno por cada `error` que puede devolver cada acción. No hay un "ha ocurrido un
 * error" genérico porque cada uno de estos se arregla haciendo algo distinto, y
 * el jugador no puede adivinar cuál sin que se lo digan.
 */
const ERRORES_GRADUAR: Record<string, string> = {
  saldo: "No te llegan las monedas para este envío. No se ha cobrado nada.",
  peticion: "Ese envío no es válido. Vuelve a elegir las copias.",
  demasiadas: `No se pueden mandar más de ${TOPE_POR_TACADA} copias de una vez.`,
  posesion: "Ya no tienes esas cartas.",
  "nada-que-graduar": "No quedaba ninguna copia libre que graduar.",
  "no-autorizado": "Inicia sesión para poder graduar.",
  servidor: "El graduador no responde. No se ha cobrado nada.",
};

const ERRORES_VENDER: Record<string, string> = {
  // Con estas palabras exactas, y en los dos sitios donde se puede intentar:
  // es una regla del juego, no un fallo, y tiene que sonar igual siempre.
  "ultima-copia":
    "Es la última copia que te queda de esta carta: hay que quedarse con una. Consigue otra y podrás venderla.",
  "no-existe": "Esa copia graduada ya no está en tu vitrina.",
  "sin-valor": "Esa nota multiplica por cero: nadie paga por ella.",
  cambio: "Algo cambió mientras tanto y la venta no llegó a hacerse. Nada ha cambiado.",
  peticion: "Petición no válida.",
  "no-autorizado": "Inicia sesión para poder vender.",
  servidor: "No se pudo vender. Nada ha cambiado.",
};

type Estado = "cargando" | "listo" | "error" | "invitado";
type Pestana = "enviar" | "graduadas";

export default function Graduacion() {
  // Sólo la sesión: el `user` que se sacaba aquí era para recomponer semillas
  // en el cliente, y eso ya no se hace (el porqué, unas líneas más abajo).
  const { isSignedIn, isLoaded } = useUser();
  const { coins, setCoins } = useCurrency();
  const haptic = useHaptics();
  const toast = useToast();

  const [estado, setEstado] = useState<Estado>("cargando");
  const [pestana, setPestana] = useState<Pestana>("enviar");

  const [cartas, setCartas] = useState<CartaGraduable[]>([]);
  const [vitrina, setVitrina] = useState<CopiaGraduada[]>([]);
  /**
   * Copias VIVAS de cada carta en la colección, graduadas incluidas. Con una
   * sola no se puede vender la graduada (la promesa de que el álbum no se vacía
   * vale también aquí), así que este número decide si el botón existe. Se siembra
   * de las dos listas —una carta con todas sus copias graduadas ya no aparece
   * entre las graduables— y se ajusta a mano en cada venta.
   */
  const [copiasPorCarta, setCopiasPorCarta] = useState<Record<string, number>>({});

  /** cardId -> copias elegidas para esta tacada. */
  const [seleccion, setSeleccion] = useState<Record<string, number>>({});

  /** Lo que ha vuelto del graduador. Con algo aquí, manda la ceremonia. */
  const [resultados, setResultados] = useState<Resultado[]>([]);
  const [decisiones, setDecisiones] = useState<Record<string, Decision>>({});
  const [cobrado, setCobrado] = useState(0);
  const [descuentoCobrado, setDescuentoCobrado] = useState(0);

  const [enviando, setEnviando] = useState(false);
  const [vendiendoId, setVendiendoId] = useState<number | null>(null);

  // Los dos cerrojos. Ver la cabecera: el estado de arriba pinta, éstos mandan.
  const envioLockRef = useRef(false);
  const ventaLockRef = useRef(false);

  /* AQUÍ HABÍA UN `idUsuario` Y YA NO HACE FALTA, que es una buena noticia.
   *
   * Servía para recomponer en el cliente la semilla de cada copia
   * —`semillaDeCopia(idUsuario, cardId, copia)`— y derivar de ella los
   * desperfectos. Eso era justo el agujero: con esa semilla y `notaDeCopia`,
   * que viaja en este mismo paquete, cualquiera podía calcular la nota de sus
   * copias SIN GRADUAR y mandar sólo los dieces, que valen el triple.
   *
   * Ahora la semilla lleva un secreto de servidor y nunca sale de él: lo que
   * llega son la nota y los desperfectos ya calculados. Si vuelves a necesitar
   * el id del usuario aquí para algo relacionado con las notas, párate a
   * pensarlo — probablemente sea la señal de que se está reabriendo esto.
   */

  /* ------------------------------------------------------------------ *
   * CARGA
   * ------------------------------------------------------------------ */

  const cargar = useCallback(
    async (conSpinner = true) => {
      if (!isLoaded) return;
      if (!isSignedIn) {
        // La graduación vive entera en el servidor: la colección del invitado
        // está en localStorage y no tiene ni copias numeradas ni monedero real.
        setEstado("invitado");
        return;
      }
      if (conSpinner) setEstado("cargando");
      try {
        const [saldo, graduables, escaparate] = await Promise.all([
          getUserData(),
          getCartasGraduables(),
          getVitrina(),
        ]);

        // El saldo del servidor pisa a la caché de localStorage. Ver cabecera.
        if (saldo) setCoins(saldo.coins);

        if (!graduables.ok || !escaparate.ok) {
          setEstado("error");
          return;
        }

        const listaGraduables: CartaGraduable[] = graduables.cartas;
        const listaVitrina: CopiaGraduada[] = escaparate.cartas;

        const copias: Record<string, number> = {};
        for (const c of listaVitrina) copias[c.id] = c.copiasTotales;
        for (const c of listaGraduables) copias[c.id] = c.cantidad;

        setCartas(listaGraduables);
        setVitrina(listaVitrina);
        setCopiasPorCarta(copias);

        // La selección sobrevive a una recarga, pero acotada a lo que sigue
        // habiendo: si otra pestaña graduó o vendió copias, pedir las de antes
        // sería pedir copias que ya no están libres.
        setSeleccion((prev) => {
          const siguiente: Record<string, number> = {};
          let total = 0;
          for (const carta of listaGraduables) {
            const pedidas = prev[carta.id];
            if (!pedidas) continue;
            const n = Math.min(pedidas, carta.libres, TOPE_POR_TACADA - total);
            if (n > 0) {
              siguiente[carta.id] = n;
              total += n;
            }
          }
          return siguiente;
        });

        setEstado("listo");
      } catch (e) {
        console.error("Error cargando la graduación:", e);
        setEstado("error");
      }
    },
    [isLoaded, isSignedIn, setCoins],
  );

  useEffect(() => {
    cargar();
  }, [cargar]);

  /**
   * Cuando vuelve la vitrina, las copias recién reveladas adoptan su `gradedId`,
   * que es lo único que la respuesta de graduar no puede traer (la fila aún no
   * existía cuando se compuso) y sin lo cual no se puede vender.
   *
   * LOS DESPERFECTOS YA NO SE ADOPTAN: llegan con la propia respuesta de
   * graduar, calculados por el servidor. Antes se recomponían en el cliente a
   * partir de la semilla, y esa semilla era justo el agujero — con ella se
   * podía calcular la nota de las copias sin graduar (ver utils/graduacion.ts).
   *
   * Depende de `vitrina` y del NÚMERO de resultados, no de `resultados`: el
   * actualizador funcional devuelve la misma referencia cuando no hay nada que
   * cambiar, así que el efecto no se vuelve a disparar solo.
   */
  useEffect(() => {
    if (resultados.length === 0 || vitrina.length === 0) return;
    setResultados((prev) => {
      let cambia = false;
      const siguiente = prev.map((r) => {
        if (r.gradedId !== undefined) return r;
        const fila = vitrina.find((v) => v.id === r.cardId && v.copia === r.copia);
        if (!fila) return r;
        cambia = true;
        return { ...r, gradedId: fila.gradedId };
      });
      return cambia ? siguiente : prev;
    });
  }, [vitrina, resultados.length]);

  /* ------------------------------------------------------------------ *
   * LA CUENTA DEL ENVÍO
   * ------------------------------------------------------------------ */

  const totalCopias = useMemo(
    () => Object.values(seleccion).reduce((a, b) => a + b, 0),
    [seleccion],
  );
  const hueco = Math.max(0, TOPE_POR_TACADA - totalCopias);
  const descuento = descuentoPorVolumen(totalCopias);

  /**
   * Lo que cuesta la tacada, con y sin descuento.
   *
   * OJO: `costeDeGraduar` recibe el TOTAL de copias del envío, no las de cada
   * carta. El descuento por volumen es del conjunto —así lo calcula el
   * servidor—, y por eso añadir la quinta copia abarata también las cuatro
   * anteriores. `carta.coste` es la tarifa sin descuento que devolvió la acción,
   * y sirve de referencia tachada.
   */
  const { totalCoste, totalSinDescuento } = useMemo(() => {
    let con = 0;
    let sin = 0;
    for (const carta of cartas) {
      const n = seleccion[carta.id] ?? 0;
      if (n <= 0) continue;
      con += n * costeDeGraduar(carta.valor, totalCopias);
      sin += n * carta.coste;
    }
    return { totalCoste: con, totalSinDescuento: sin };
  }, [cartas, seleccion, totalCopias]);

  const escalones = useMemo(() => escalonesDeDescuento(TOPE_POR_TACADA), []);
  const siguienteEscalon = useMemo(
    () => escalones.find((e) => e.desde > totalCopias) ?? null,
    [escalones, totalCopias],
  );

  const fijar = useCallback(
    (cardId: string, copias: number) => {
      setSeleccion((prev) => {
        const carta = cartas.find((c) => c.id === cardId);
        if (!carta) return prev;
        const total = Object.values(prev).reduce((a, b) => a + b, 0);
        const actual = prev[cardId] ?? 0;
        // El techo de esta carta es lo menor entre sus copias libres y lo que
        // queda de tacada contando las suyas, que ya están dentro del total.
        const techo = Math.min(carta.libres, actual + Math.max(0, TOPE_POR_TACADA - total));
        const n = Math.max(0, Math.min(copias, techo));
        if (n === actual) return prev;
        const siguiente: Record<string, number> = {};
        for (const [id, valor] of Object.entries(prev)) {
          if (id !== cardId) siguiente[id] = valor;
        }
        if (n > 0) siguiente[cardId] = n;
        return siguiente;
      });
    },
    [cartas],
  );

  /* ------------------------------------------------------------------ *
   * GRADUAR
   * ------------------------------------------------------------------ */

  const enviar = useCallback(async () => {
    if (envioLockRef.current) return;
    const peticiones = Object.entries(seleccion)
      .filter(([, copias]) => copias > 0)
      .map(([cardId, copias]) => ({ cardId, copias }));
    if (peticiones.length === 0) return;

    envioLockRef.current = true;
    setEnviando(true);
    // Instantánea de las cartas ANTES de recargar: la ceremonia pinta con esto
    // (nombre, ilustración, valor sin graduar) y la recarga de después ya no
    // trae las copias que acaban de dejar de estar libres.
    const porId = new Map(cartas.map((c) => [c.id, c]));
    const pedidas = totalCopias;

    try {
      const res = await graduarCartasAction(peticiones);
      if (!res.ok) {
        haptic("warning");
        toast(ERRORES_GRADUAR[res.error] ?? "No se pudo graduar. Nada ha cambiado.", "error");
        // Cualquier desajuste con el servidor (copias vendidas en otra pestaña,
        // saldo distinto del que creíamos) se arregla releyendo el estado real.
        if (res.error !== "peticion") cargar(false);
        return;
      }

      setCoins(res.coins);
      setCobrado(res.cobrado);
      setDescuentoCobrado(res.descuento);

      /* EL ORDEN DE REVELADO ES EL QUE DEVUELVE EL SERVIDOR y no se toca.
       * La tentación es ordenar por nota ascendente para que la mejor caiga la
       * última, pero entonces el propio orden es un spoiler: a la segunda tacada
       * ya se sabe que la última carta es la buena y las anteriores dejan de
       * tener emoción. Sin reordenar, cada sobre es independiente. */
      const nuevos: Resultado[] = [];
      for (const g of res.graduadas) {
        const carta = porId.get(g.cardId);
        if (!carta) continue; // no debería pasar: sólo se piden cartas de la lista
        nuevos.push({
          cardId: g.cardId,
          copia: g.copia,
          nota: g.nota,
          carta,
          desperfectos: g.desperfectos,
          marcas: g.marcas,
          valor: valorGraduado(carta.valor, g.nota),
        });
      }

      setResultados(nuevos);
      setDecisiones({});
      setSeleccion({});
      haptic("success");

      if (nuevos.length < pedidas) {
        // El servidor cobra por lo que PUDO graduar, no por lo que se pidió. Si
        // no cuadra es que la colección cambió entre medias, y callarlo dejaría
        // al jugador contando copias que nunca salieron.
        toast(
          `Se graduaron ${formatNumber(nuevos.length)} de ${formatNumber(pedidas)} copias: el resto ya no estaba libre.`,
          "info",
        );
      }

      // La vitrina trae los gradedId que la respuesta de graduar no incluye, y
      // la lista de graduables se queda sin las copias que acaban de irse.
      cargar(false);
    } catch (e) {
      console.error("Error graduando:", e);
      haptic("warning");
      toast("El graduador no responde. No se ha cobrado nada.", "error");
    } finally {
      envioLockRef.current = false;
      setEnviando(false);
    }
  // Sin `idUsuario`: dejo de hacer falta cuando la semilla pasó a calcularse
  // sólo en el servidor (ver utils/graduacion.ts). Dejarlo en la lista hacía
  // que el linter avisara de una dependencia que ya no lee nadie.
  }, [seleccion, cartas, totalCopias, haptic, toast, setCoins, cargar]);

  /* ------------------------------------------------------------------ *
   * VENDER
   * ------------------------------------------------------------------ */

  const vender = useCallback(
    async (gradedId: number, cardId: string, copia: number) => {
      if (ventaLockRef.current) return;
      ventaLockRef.current = true;
      setVendiendoId(gradedId);
      try {
        const res = await venderGraduadaAction(gradedId);
        if (!res.ok) {
          haptic("warning");
          toast(ERRORES_VENDER[res.error] ?? "No se pudo vender. Nada ha cambiado.", "error");
          // Si el servidor dice que esa copia ya no existe o que la colección
          // cambió, lo pintado es mentira: se relee en vez de dejarlo ahí.
          if (res.error === "no-existe" || res.error === "cambio") cargar(false);
          return;
        }

        haptic("success");
        setCoins(res.coins);
        toast(`+${formatNumber(res.earned)} monedas por un ${res.nota}`, "success");

        /* BAJA LOCAL, SIN RECARGA.
         * El servidor ya ha dicho exactamente qué ha pasado y una recarga
         * completa aquí tiraría la ceremonia a medias (los resultados que
         * quedan por decidir viven en memoria). Se toca lo mismo que tocó la
         * sentencia: la fila se va de la vitrina, la carta pierde una copia y
         * una graduada, y la decisión queda anotada. */
        setVitrina((prev) => prev.filter((v) => v.gradedId !== gradedId));
        setCopiasPorCarta((prev) => ({
          ...prev,
          [cardId]: Math.max(0, (prev[cardId] ?? 1) - 1),
        }));
        setCartas((prev) =>
          prev.map((c) =>
            c.id === cardId
              ? {
                  ...c,
                  cantidad: Math.max(0, c.cantidad - 1),
                  graduadas: Math.max(0, c.graduadas - 1),
                }
              : c,
          ),
        );
        setDecisiones((prev) => ({ ...prev, [claveCopia(cardId, copia)]: "vendida" }));
      } catch (e) {
        console.error("Error vendiendo una graduada:", e);
        haptic("warning");
        toast("No se pudo vender. Nada ha cambiado.", "error");
      } finally {
        ventaLockRef.current = false;
        setVendiendoId(null);
      }
    },
    [haptic, toast, setCoins, cargar],
  );

  const guardar = useCallback(
    (resultado: Resultado) => {
      // Guardar no llama a nada: la copia ya está en la vitrina desde que se
      // graduó. Esto sólo anota que el jugador ya ha decidido, para que la
      // rejilla del resumen deje de preguntárselo.
      haptic("tap");
      setDecisiones((prev) => ({
        ...prev,
        [claveCopia(resultado.cardId, resultado.copia)]: "guardada",
      }));
    },
    [haptic],
  );

  /* ------------------------------------------------------------------ *
   * PINTADO
   * ------------------------------------------------------------------ */

  /* LA CEREMONIA MANDA SOBRE TODO LO DEMÁS, Y VA LA PRIMERA A PROPÓSITO.
   *
   * Mientras hay copias reveladas sin resolver, la pantalla es sólo eso: ni
   * pestañas ni lista, para que nadie se salga de un revelado a medias sin
   * querer. Y va por delante de los estados de carga y de error porque detrás de
   * ella corre una recarga en segundo plano (la que trae los gradedId): si esa
   * recarga fallara, el `estado: "error"` se comería la ceremonia y el jugador
   * perdería de vista unas notas por las que acaba de pagar. Las notas ya están
   * en su vitrina pase lo que pase, pero el momento no se repite.
   *
   * No se usa el modo inmersivo de AppShell: esconde la barra superior, que es
   * donde se ve el saldo, y aquí el dinero se mueve en cada decisión. */
  if (resultados.length > 0) {
    return (
      <>
        <PageHeader
          title="Han vuelto del graduador"
          subtitle="Cada copia con la nota que ya tenía"
        />
        <Revelacion
          resultados={resultados}
          decisiones={decisiones}
          copiasPorCarta={copiasPorCarta}
          vendiendoId={vendiendoId}
          onVender={(r) => {
            if (r.gradedId === undefined) return;
            vender(r.gradedId, r.cardId, r.copia);
          }}
          onGuardar={guardar}
          onTerminar={() => {
            setResultados([]);
            setDecisiones({});
            setPestana("enviar");
          }}
          cobrado={cobrado}
          descuento={descuentoCobrado}
        />
      </>
    );
  }

  if (estado === "cargando") return <Loader label="Abriendo el graduador" />;

  if (estado === "invitado") {
    return (
      <>
        <PageHeader
          title="Graduación"
          subtitle="La nota que tu copia ya tenía"
          back="/collection"
        />
        <div
          className="surface rounded-2xl p-5 flex items-start gap-3"
          style={{ borderColor: "color-mix(in srgb, var(--warn) 40%, transparent)" }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="w-5 h-5 shrink-0 mt-0.5" style={{ color: "var(--warn)" }} aria-hidden="true">
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
            <circle cx="12" cy="12" r="9" />
          </svg>
          <div className="min-w-0">
            <p className="text-sm font-semibold">Estás jugando como invitado</p>
            <p className="text-xs ink-soft mt-1 leading-relaxed">
              La nota de una copia se calcula a partir de tu cuenta y de qué número de copia es, y
              el cobro se hace en el servidor. Como invitado tus cartas viven sólo en este
              dispositivo, así que aquí no hay nada que graduar.{" "}
              <Link href="/" className="accent font-medium underline underline-offset-2">
                Ir al inicio
              </Link>
            </p>
          </div>
        </div>
      </>
    );
  }

  if (estado === "error") {
    return (
      <>
        <PageHeader
          title="Graduación"
          subtitle="La nota que tu copia ya tenía"
          back="/collection"
        />
        <div className="surface rounded-2xl py-16 px-6 flex flex-col items-center text-center gap-4">
          <p className="text-sm ink-soft">No se pudo abrir el graduador.</p>
          <button
            type="button"
            onClick={() => {
              haptic("tap");
              cargar();
            }}
            className="btn-accent press touch-target px-6 rounded-xl text-sm font-semibold flex items-center justify-center"
          >
            Reintentar
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Graduación"
        subtitle="La nota que tu copia ya tenía"
        back="/collection"
      />

      <div className="flex flex-col gap-4">
        {/* LAS DOS SECCIONES. Sin iconos: son dos sitios, no dos acciones.
            NO LLEVAN role="tab"/"tablist" A PROPÓSITO. Ese patrón de ARIA obliga
            a mover el foco con las flechas y a un tabindex rotatorio; anunciarse
            como pestañas sin implementar eso deja al lector de pantalla diciendo
            "pestaña 1 de 2" y esperando unas flechas que no hacen nada. Dos
            botones con `aria-pressed` describen exactamente lo que son. */}
        <div className="surface rounded-2xl p-1.5 flex gap-1.5">
          {([
            { id: "enviar" as const, rotulo: "Enviar a graduar" },
            { id: "graduadas" as const, rotulo: `Mis graduadas${vitrina.length ? ` · ${formatNumber(vitrina.length)}` : ""}` },
          ]).map(({ id, rotulo }) => {
            const activa = pestana === id;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={activa}
                onClick={() => {
                  haptic("select");
                  setPestana(id);
                }}
                className={`press touch-target flex-1 rounded-xl text-xs font-semibold px-3 ${activa ? "btn-primary" : "ink-soft"}`}
              >
                {rotulo}
              </button>
            );
          })}
        </div>

        {pestana === "enviar" ? (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="flex flex-col gap-4"
          >
            <ComoFunciona />

            <ListaGraduables
              cartas={cartas}
              seleccion={seleccion}
              onFijar={fijar}
              totalCopias={totalCopias}
              hueco={hueco}
              bloqueado={enviando}
            />

            {/* Aire por debajo para que la barra pegada no tape la última fila. */}
            <div aria-hidden="true" className="h-2" />

            <BarraEnvio
              totalCopias={totalCopias}
              totalCoste={totalCoste}
              totalSinDescuento={totalSinDescuento}
              descuento={descuento}
              siguienteEscalon={siguienteEscalon}
              monedas={coins}
              enCurso={enviando}
              onGraduar={enviar}
              onVaciar={() => {
                haptic("tap");
                setSeleccion({});
              }}
            />
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          >
            <VitrinaGraduadas
              cartas={vitrina}
              copiasPorCarta={copiasPorCarta}
              vendiendo={vendiendoId}
              onVender={(c) => vender(c.gradedId, c.id, c.copia)}
            />
          </motion.div>
        )}
      </div>
    </>
  );
}
