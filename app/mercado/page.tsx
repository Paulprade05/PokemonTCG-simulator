"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { cumplirOferta, getCartasMercado, getMercado } from "../action";
import {
  copiasEntregables,
  pagoDelLote,
  type Oferta,
  type Requisito,
} from "../../utils/mercado";
// EL REPARTO DEL LOTE VIVE EN utils/repartoMercado.ts, fuera del componente,
// para que scripts/test-invariantes.mjs pueda cargarlo (la cabecera de ese
// módulo explica por qué no puede volver aquí). Los comentarios de más abajo
// siguen nombrando `normalizarFijadas`, que se quedó allí y aquí no se importa:
// es en ese fichero donde hay que buscarla, no en éste.
import {
  candidatasPara,
  esFijable,
  podarFijadas,
  repartir,
  type CartaMercado,
  type FijadasPorOferta,
  type Opcion,
  type ParteReparto,
  type Reparto,
} from "../../utils/repartoMercado";
import { AVAILABLE_SETS } from "../../utils/constanst";
import { formatNumber } from "../../utils/format";
import { getCollection } from "../../utils/storage";
import { useCurrency } from "../../hooks/useGameCurrency";
import { useHaptics } from "../../hooks/useHaptics";
import { useToast } from "../../components/ui/Toast";
import Sheet from "../../components/ui/Sheet";
import PageHeader from "../../components/PageHeader";
import Loader from "../../components/Loader";

/* ------------------------------------------------------------------ *
 * RÓTULOS
 * ------------------------------------------------------------------ */

/**
 * Rótulo de la expansión que exige un requisito. El nombre español lo manda
 * `getMercado` en un mapa de una docena de entradas: el índice de idioma vive
 * en el servidor y traerlo al navegador para dos rótulos no sale a cuenta.
 */
const nombreDeSet = (setId: string | null, nombresEs: Record<string, string>): string =>
  setId
    ? nombresEs[setId] ?? AVAILABLE_SETS.find((s) => s.id === setId)?.name ?? setId.toUpperCase()
    : "Cualquier expansión";

/* ------------------------------------------------------------------ *
 * PANTALLA
 * ------------------------------------------------------------------ */

const ERRORES: Record<string, string> = {
  sesion: "Inicia sesión para cobrar en el mercado.",
  peticion: "Esa entrega no es válida.",
  caducada: "El tablón ha cambiado. Recarga para ver las ofertas nuevas.",
  posesion: "Ya no te sobran algunas de esas cartas. Recarga y vuelve a intentarlo.",
  duplicados: "Sólo se entregan duplicados: de cada carta tiene que quedarte una copia.",
  requisitos: "Ese lote no cumple lo que pide la oferta.",
  repetida: "Esa oferta ya la habías cobrado.",
  pago: "El comprador no paga nada por ese lote.",
  servidor: "No se pudo cobrar. Inténtalo de nuevo.",
};

export default function MercadoPage() {
  const { isSignedIn, isLoaded } = useUser();
  const { setCoins } = useCurrency();
  const toast = useToast();
  const haptic = useHaptics();

  const [estado, setEstado] = useState<"cargando" | "listo" | "error">("cargando");
  const [ofertas, setOfertas] = useState<Oferta[]>([]);
  const [cartas, setCartas] = useState<CartaMercado[]>([]);
  const [cumplidas, setCumplidas] = useState<string[]>([]);
  const [nombresSet, setNombresSet] = useState<Record<string, string>>({});
  const [caduca, setCaduca] = useState(0);
  const [ahora, setAhora] = useState(0);
  const [enCurso, setEnCurso] = useState<string | null>(null);

  /**
   * LO QUE EL JUGADOR HA CLAVADO, por oferta y por requisito.
   *
   * En memoria y nada más: se pierde al recargar y eso es lo pedido. Persistirlo
   * obligaría a revalidarlo contra un tablón que caduca cada 24 h y a inventar
   * qué hacer cuando la carta clavada ya no está — dos problemas nuevos a cambio
   * de conservar una elección de treinta segundos.
   */
  const [fijadas, setFijadas] = useState<FijadasPorOferta>(() => new Map());
  /** Hueco del lote que se está cambiando; `null` cierra el selector. */
  const [destino, setDestino] = useState<
    { ofertaId: string; indice: number; posicion: number } | null
  >(null);

  const cargar = useCallback(
    async (conSpinner = true) => {
      if (!isLoaded) return;
      if (conSpinner) setEstado("cargando");
      try {
        // El invitado guarda su colección en este dispositivo: se mandan los
        // ids para que el servidor los hidrate y pueda ver su progreso. Sólo
        // los de las cartas de las que le SOBRA alguna copia: de las demás no
        // hay nada que entregar, así que hidratarlas sería payload tirado.
        const idsInvitado = isSignedIn
          ? undefined
          : getCollection()
              .filter((c) => Boolean(c.id) && copiasEntregables(c.quantity || 1) > 0)
              .map((c) => c.id);
        const [tablon, coleccion] = await Promise.all([
          getMercado(),
          getCartasMercado(idsInvitado),
        ]);

        let lista = coleccion.cartas as CartaMercado[];
        if (!isSignedIn) {
          // Las cantidades del invitado sólo las sabe el navegador: el servidor
          // devuelve 1 de relleno y aquí se pone la real, que es la que decide
          // cuántos duplicados hay.
          const copias = new Map(getCollection().map((c) => [c.id, c.quantity || 1]));
          lista = lista.map((c) => ({ ...c, cantidad: copias.get(c.id) ?? 1 }));
        }

        // Las elecciones a mano caducan con el tablón —cuando entra un ciclo
        // nuevo, las de las ofertas que ya no están sobran— y además se podan
        // contra la colección recién leída: ver `podarFijadas`.
        setFijadas((prev) => podarFijadas(prev, tablon.ofertas, lista));
        // Y EL SELECTOR SE CIERRA. Es la única hoja de la app que puede
        // sobrevivir a que desaparezca lo que está editando: al entrar un ciclo
        // nuevo los ids de oferta cambian, la hoja se queda con el subtítulo
        // vacío y afirmando "no te sobra ninguna otra carta que valga para este
        // requisito" sobre un requisito que ya no existe. Se cierra siempre y no
        // sólo cuando la oferta se va, porque una recarga también puede mover
        // las cantidades bajo el hueco que se estaba cambiando.
        setDestino(null);

        setOfertas(tablon.ofertas);
        setNombresSet(tablon.nombresSet ?? {});
        setCumplidas(tablon.cumplidas);
        setCaduca(tablon.caduca);
        setCartas(lista);
        setAhora(Date.now());
        setEstado("listo");
      } catch (e) {
        console.error("Error cargando el mercado:", e);
        setEstado("error");
      }
    },
    [isLoaded, isSignedIn],
  );

  useEffect(() => {
    cargar();
  }, [cargar]);

  // Cuenta atrás del ciclo. Al llegar a cero se recarga sola: el tablón de
  // ofertas caducado ya no se puede cobrar y sería un engaño dejarlo pintado.
  useEffect(() => {
    if (estado !== "listo") return;
    const t = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(t);
  }, [estado]);

  const caducado = estado === "listo" && ahora > 0 && caduca > 0 && ahora >= caduca;
  useEffect(() => {
    if (caducado) cargar(false);
  }, [caducado, cargar]);

  const repartos = useMemo(() => {
    const mapa = new Map<string, Reparto>();
    for (const o of ofertas) mapa.set(o.id, repartir(o, cartas, fijadas.get(o.id)));
    return mapa;
  }, [ofertas, cartas, fijadas]);

  /**
   * ¿La oferta se completaría SOLA, sin lo que el jugador ha clavado?
   *
   * Es lo único que distingue "tus cambios dejan el lote incompleto" de "te
   * faltan duplicados", y sin ello el botón acusa al jugador de romper una
   * oferta que era imposible antes de que tocara nada: le basta con clavar algo
   * en un requisito que sí cumple para que el rótulo cambie, y el botón de
   * emergencia que le ofrece a cambio no arregla nada porque no hay nada roto.
   *
   * Se reparte una segunda vez y sólo para las ofertas que el jugador ha tocado,
   * que son una o dos: repartir es barato y adivinarlo no se puede.
   */
  const automaticaCompleta = useMemo(() => {
    const mapa = new Map<string, boolean>();
    for (const o of ofertas) {
      if (!fijadas.has(o.id)) continue;
      mapa.set(o.id, repartir(o, cartas).completa);
    }
    return mapa;
  }, [ofertas, cartas, fijadas]);

  /* ---------------------------------------------------------------- *
   * ELEGIR A MANO
   * ---------------------------------------------------------------- */

  const ofertaDestino = destino ? ofertas.find((o) => o.id === destino.ofertaId) : undefined;
  const repartoDestino = destino ? repartos.get(destino.ofertaId) : undefined;
  const parteDestino =
    destino && repartoDestino ? repartoDestino.partes[destino.indice] : undefined;

  const opcionesDestino = useMemo(() => {
    if (!destino || !ofertaDestino || !repartoDestino) return [];
    return candidatasPara(
      ofertaDestino,
      cartas,
      repartoDestino,
      destino.indice,
      destino.posicion,
    );
  }, [destino, ofertaDestino, repartoDestino, cartas]);

  /**
   * Reescribe la lista de clavadas de un requisito.
   *
   * LA RECETA TRABAJA SOBRE EL LOTE PINTADO ENTERO, no sólo sobre lo que ya
   * estaba clavado, y ésa es la corrección que hace que tocar un chip cambie EL
   * CHIP QUE SE HA TOCADO. Antes se partía de `elegidas.slice(0, nFijadas)` y
   * elegir en un hueco automático AÑADÍA la carta nueva al final; el algoritmo
   * rellenaba los huecos restantes con lo más barato, que es justo la carta que
   * el jugador acababa de intentar quitar, así que volvía a entrar:
   *
   *     requisito "3 cartas", libres A(10) B(20) C(30) D(40) E(50)
   *     automático  [A, B, C]
   *     toca "A", elige E  →  [E, A, B]   ← A sigue, y se ha ido C, que ni miró
   *
   * Es el fallo más grave posible en una pantalla que se usa con el pulgar: el
   * objeto que tocas no es el que cambia. Y rompía el motivo del encargo —
   * "quiero mandar la basura y quedarme la buena"— porque para sacar de verdad
   * una carta había que clavar los N huecos uno a uno.
   *
   * La consecuencia, buscada: tocar UNA copia clava el lote entero DE ESE
   * REQUISITO tal y como se ve. Los demás requisitos los sigue repartiendo el
   * algoritmo, así que la protección contra el atasco sigue en pie; y lo que se
   * clava de propina es exactamente lo que el algoritmo ya había elegido, o sea
   * que el lote no cambia por debajo de sus pies. "Lo que veo es lo que mando".
   *
   * Se parte SIEMPRE de lo pintado (`parte.elegidas`) y no del estado crudo: el
   * estado puede llevar ids que `normalizarFijadas` ya descartó (una copia que
   * se vendió en otra pestaña), y si se editara sobre él volverían a la vida al
   * primer cambio.
   */
  const escribirFijadas = useCallback(
    (
      ofertaId: string,
      indice: number,
      receta: (lote: { ids: string[]; fijas: boolean[] }) => (string | null)[],
    ) => {
      setFijadas((prev) => {
        const parte = repartos.get(ofertaId)?.partes[indice];
        const nuevas = receta({
          ids: parte ? parte.elegidas.map((c) => c.id) : [],
          fijas: parte ? parte.fijas : [],
        });

        const deOferta = new Map(prev.get(ofertaId) ?? []);
        // Una lista de puros huecos vacíos es "aquí no hay nada clavado": se
        // borra la entrada en vez de guardarla, o la oferta se quedaría marcada
        // como tocada para siempre después de soltar la última copia.
        if (nuevas.every((id) => id === null)) deOferta.delete(indice);
        else deOferta.set(indice, nuevas);

        const copia = new Map(prev);
        if (deOferta.size === 0) copia.delete(ofertaId);
        else copia.set(ofertaId, deOferta);
        return copia;
      });
    },
    [repartos],
  );

  const onElegirCarta = useCallback(
    (carta: CartaMercado) => {
      if (!destino || !ofertaDestino) return;
      const { ofertaId, indice, posicion } = destino;
      const r = ofertaDestino.requisitos[indice];
      haptic("select");
      escribirFijadas(ofertaId, indice, ({ ids }) => {
        // El playset es UNA decisión: cambiar la carta cambia sus N copias.
        if (r.filtro.categoria === "playset") {
          return Array.from({ length: r.cantidad }, () => carta.id);
        }
        // Sustituir EN SU SITIO la copia que se tocó y dejar el resto del lote
        // tal y como está pintado (ver la cabecera de `escribirFijadas`).
        const lote =
          posicion < ids.length
            ? ids.map((id, j) => (j === posicion ? carta.id : id))
            : [...ids, carta.id];
        return lote.slice(0, r.cantidad);
      });
      setDestino(null);
    },
    [destino, ofertaDestino, haptic, escribirFijadas],
  );

  /**
   * Soltar la copia que se está mirando: ese hueco vuelve a elegirlo la pantalla
   * y el resto del requisito se queda como está.
   *
   * Que el resto se quede clavado no es un descuido: si soltar una copia
   * devolviera el requisito entero al automático, el jugador perdería de golpe
   * las demás elecciones que sí quería. Para eso está el botón de la tarjeta.
   */
  const onSoltarCopia = useCallback(() => {
    if (!destino || !ofertaDestino) return;
    const { ofertaId, indice, posicion } = destino;
    const r = ofertaDestino.requisitos[indice];
    haptic("tap");
    escribirFijadas(ofertaId, indice, ({ ids, fijas }) =>
      // Soltar un playset los suelta todos: sus N copias son la misma decisión.
      //
      // SOLTAR NO AGARRA NADA. A diferencia de elegir, aquí se parte de lo que
      // YA estaba clavado (`fijas`) y no del lote pintado: si se partiera del
      // lote, devolverle un hueco a la pantalla le quitaría de paso otro que
      // ella estaba eligiendo sola, y el jugador acabaría con más copias
      // clavadas de las que ha elegido en su vida.
      r.filtro.categoria === "playset"
        ? []
        : ids.map((id, j) => (fijas[j] && j !== posicion ? id : null)),
    );
    setDestino(null);
  }, [destino, ofertaDestino, haptic, escribirFijadas]);

  /** La salida de emergencia: toda la oferta vuelve a la propuesta automática. */
  const onSoltarTodo = useCallback(
    (ofertaId: string) => {
      haptic("tap");
      setDestino(null);
      setFijadas((prev) => {
        if (!prev.has(ofertaId)) return prev;
        const copia = new Map(prev);
        copia.delete(ofertaId);
        return copia;
      });
    },
    [haptic],
  );

  const onCumplir = useCallback(
    async (oferta: Oferta) => {
      const reparto = repartos.get(oferta.id);
      if (!reparto?.completa || enCurso) return;
      setEnCurso(oferta.id);
      try {
        const res = await cumplirOferta(oferta.id, reparto.ids);
        if (!res.ok) {
          haptic("warning");
          toast(ERRORES[res.error] ?? "No se pudo cobrar.", "error");
          // Cualquier desajuste (tablón caducado, cartas vendidas en otra
          // pestaña) se arregla releyendo el estado real del servidor.
          if (res.error !== "peticion") cargar(false);
          return;
        }
        haptic("success");
        setCoins(res.coins);
        setCumplidas((prev) => [...prev, oferta.id]);
        // El lote ya se fue: las copias clavadas ya no existen y arrastrarlas
        // sólo serviría para que `normalizarFijadas` las tirara una a una.
        onSoltarTodo(oferta.id);
        toast(`Lote entregado: +${formatNumber(res.pago)} monedas`, "success");
        cargar(false);
      } catch (e) {
        console.error("Error cumpliendo la oferta:", e);
        haptic("warning");
        toast("No se pudo cobrar. Revisa tu conexión.", "error");
      } finally {
        setEnCurso(null);
      }
    },
    [repartos, enCurso, haptic, toast, setCoins, cargar, onSoltarTodo],
  );

  if (estado === "cargando") return <Loader label="Abriendo el mercado" />;

  if (estado === "error") {
    return (
      <>
        <PageHeader title="Mercado" subtitle="Lotes que alguien paga por encima de su precio" />
        <div className="surface rounded-2xl py-16 px-6 flex flex-col items-center text-center gap-4">
          <p className="text-sm ink-soft">No se pudo cargar el tablón de ofertas.</p>
          <button
            onClick={() => cargar()}
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
        title="Mercado"
        subtitle={restante(caduca - ahora)}
        actions={
          <>
          {/* LA PUERTA AL BAZAR ENTRE JUGADORES.
              Cuelga del Mercado y no de una pestaña propia porque son las dos
              mitades de lo mismo: aquí se le vende a la máquina, allí a otras
              personas. La pestaña de Mercado cubre ya la ruta /bazar (ver
              components/nav-items.tsx), así que la barra inferior no se apaga
              al entrar. */}
          <Link
            href="/bazar"
            aria-label="Ir al bazar entre jugadores"
            className="flex items-center gap-2 chip ink-soft hover:ink px-3 py-2 rounded-xl text-xs font-medium transition press touch-target justify-center"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path d="M3 21h18M5 21V10l7-5 7 5v11" />
              <path d="M9 21v-6h6v6" />
            </svg>
            <span className="hidden sm:inline">Bazar</span>
          </Link>
          <button
            onClick={() => cargar(false)}
            aria-label="Actualizar el tablón"
            className="touch-target w-11 h-11 rounded-xl btn-ghost press flex items-center justify-center"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="w-4 h-4">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
          </>
        }
      />

      {!isSignedIn && (
        <div
          className="surface rounded-2xl p-4 mb-5 flex items-start gap-3"
          style={{ borderColor: "color-mix(in srgb, var(--warn) 40%, transparent)" }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="w-5 h-5 shrink-0 mt-0.5" style={{ color: "var(--warn)" }} aria-hidden="true">
            <path d="M12 9v4" /><path d="M12 17h.01" /><circle cx="12" cy="12" r="9" />
          </svg>
          <div className="min-w-0">
            <p className="text-sm font-semibold">Estás jugando como invitado</p>
            <p className="text-xs ink-soft mt-1">
              Puedes ver el tablón y comprobar tu progreso, pero el cobro se hace en el servidor:
              tus monedas y tus cartas viven sólo en este dispositivo. Inicia sesión para entregar
              lotes.{" "}
              <Link href="/" className="accent font-medium underline underline-offset-2">
                Ir al inicio
              </Link>
            </p>
          </div>
        </div>
      )}

      {ofertas.length === 0 ? (
        <div className="surface rounded-2xl py-16 px-6 flex flex-col items-center text-center gap-3">
          <p className="text-sm font-semibold">Hoy no hay encargos</p>
          <p className="text-xs ink-soft max-w-xs">
            El comprador no ha dejado ninguna lista. Vuelve en el próximo ciclo.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {ofertas.map((oferta) => (
            <TarjetaOferta
              key={oferta.id}
              oferta={oferta}
              reparto={repartos.get(oferta.id)}
              cumplida={cumplidas.includes(oferta.id)}
              puedeCobrar={Boolean(isSignedIn)}
              enCurso={enCurso === oferta.id}
              bloqueada={enCurso !== null && enCurso !== oferta.id}
              nombresSet={nombresSet}
              autoCompleta={automaticaCompleta.get(oferta.id) ?? true}
              onCumplir={() => onCumplir(oferta)}
              onTocarCopia={(indice, posicion) => {
                haptic("tap");
                setDestino({ ofertaId: oferta.id, indice, posicion });
              }}
              onSoltarTodo={() => onSoltarTodo(oferta.id)}
            />
          ))}
        </div>
      )}

      <p className="text-[11px] ink-faint text-center mt-6 mb-2 max-w-lg mx-auto leading-relaxed">
        Al mercado sólo van duplicados: de cada carta que entregues te queda siempre una copia en
        el álbum, así que ningún encargo te deja un hueco. El comprador paga su cuota entera sobre
        el precio de venta del lote, sin topes, y se proponen las cartas más baratas que cumplan
        — pero la última palabra la tienes tú: toca cualquier carta del lote para cambiarla.
      </p>

      <SelectorEntrega
        destino={destino}
        requisito={
          destino && ofertaDestino ? ofertaDestino.requisitos[destino.indice] : undefined
        }
        opciones={opcionesDestino}
        actual={destino && parteDestino ? parteDestino.elegidas[destino.posicion] : undefined}
        posicion={destino ? destino.posicion : 0}
        copiasDelRequisito={destino && parteDestino ? parteDestino.elegidas.length : 0}
        fijada={Boolean(destino && parteDestino && parteDestino.fijas[destino.posicion])}
        onElegir={onElegirCarta}
        onSoltar={onSoltarCopia}
        onCerrar={() => setDestino(null)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * TARJETA
 * ------------------------------------------------------------------ */

const COLOR_DIFICULTAD: Record<Oferta["dificultad"], string> = {
  facil: "var(--accent)",
  media: "var(--warn)",
  dificil: "var(--danger)",
};

const ETIQUETA_DIFICULTAD: Record<Oferta["dificultad"], string> = {
  facil: "Fácil",
  media: "Media",
  dificil: "Difícil",
};

function TarjetaOferta({
  oferta,
  reparto,
  cumplida,
  puedeCobrar,
  enCurso,
  bloqueada,
  nombresSet,
  autoCompleta,
  onCumplir,
  onTocarCopia,
  onSoltarTodo,
}: {
  oferta: Oferta;
  reparto?: Reparto;
  cumplida: boolean;
  puedeCobrar: boolean;
  enCurso: boolean;
  bloqueada: boolean;
  nombresSet: Record<string, string>;
  /**
   * ¿La oferta se completaría sin lo que el jugador ha clavado? Sólo se usa para
   * decidir a quién se le echa la culpa cuando el lote no cuadra.
   */
  autoCompleta: boolean;
  onCumplir: () => void;
  onTocarCopia: (indice: number, posicion: number) => void;
  onSoltarTodo: () => void;
}) {
  const color = COLOR_DIFICULTAD[oferta.dificultad];
  const completa = Boolean(reparto?.completa);
  const pago = completa && reparto ? pagoDelLote(oferta, reparto.valor) : 0;
  const prima = completa && reparto ? pago - reparto.valor : 0;
  /**
   * Se lee DEL REPARTO y no del estado crudo de la pantalla. El estado conserva
   * elecciones que `normalizarFijadas` ya descartó —una copia vendida en otra
   * pestaña—, y con él la tarjeta ofrecía "volver a la propuesta automática" sin
   * nada que soltar (pulsarlo no cambiaba el lote) y le echaba la culpa al
   * jugador de unos cambios que ya no existían. Clavado de verdad es lo pintado.
   */
  const hayFijadas = reparto?.partes.some((p) => p.fijas.some(Boolean)) ?? false;

  return (
    /* SIN ENTRADA PROPIA. Cada tarjeta traía su fundido con 10px de subida y
     * un retardo escalonado (i × 0,04 s) ADEMÁS de la entrada de la pantalla
     * que ya pone app/template.tsx: la doctrina está en PageHeader.tsx ("una
     * pantalla, una entrada"). Y aquí costaba más que en la cabecera: framer
     * escribe `opacity:0` en línea en el HTML servido y sólo lo enciende en su
     * primer requestAnimationFrame, así que con la pestaña en segundo plano
     * las tarjetas seguían invisibles cuatro segundos después de llegar. Un
     * <article> normal se pinta cuando llega, que es lo que hace el resto de
     * rejillas de la app (colección, álbum, bazar). */
    <article
      className={`surface rounded-3xl p-5 flex flex-col gap-4 ${cumplida ? "opacity-60" : ""}`}
    >
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span
              className="chip text-[10px] font-semibold px-2 py-0.5 uppercase tracking-wide"
              style={{
                color,
                borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
                background: `color-mix(in srgb, ${color} 12%, transparent)`,
              }}
            >
              {ETIQUETA_DIFICULTAD[oferta.dificultad]}
            </span>
            <span className="chip text-[10px] px-2 py-0.5 ink-soft truncate max-w-[60%]">
              {nombreDeSet(oferta.setId, nombresSet)}
            </span>
            {cumplida && (
              <span className="chip text-[10px] px-2 py-0.5 accent font-semibold">Cumplida</span>
            )}
          </div>
          <h2 className="text-base font-bold tracking-tight">{oferta.titulo}</h2>
        </div>
        <div className="text-right shrink-0">
          <p className="text-xl font-bold tnum" style={{ color }}>
            ×{oferta.multiplicador.toFixed(2).replace(".", ",")}
          </p>
          {/* Ya no hay presupuesto máximo: la cuota se aplica entera a todo el
              lote, así que lo que hay que explicar es sobre qué se aplica. */}
          <p className="text-[10px] ink-faint">sobre el precio suelto</p>
        </div>
      </header>

      <p className="text-xs ink-soft leading-relaxed">{oferta.descripcion}</p>

      <ul className="flex flex-col gap-2.5">
        {(reparto?.partes ?? []).map((parte, i) => (
          <li key={i} className="surface-2 rounded-2xl px-3.5 py-3">
            <div className="flex items-start justify-between gap-3 mb-2">
              <p className="text-xs leading-snug flex-1">{parte.requisito.descripcion}</p>
              <span
                // El progreso está medido en DUPLICADOS, no en cartas poseídas:
                // es la única cifra que casa con lo que el servidor aceptará.
                title="Contando sólo las copias que te sobran"
                className={`text-xs font-semibold tnum shrink-0 ${
                  parte.completo ? "accent" : "ink-faint"
                }`}
              >
                {parte.progreso}/{parte.requisito.cantidad}
              </span>
            </div>
            <div className="h-1 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--ink) 10%, transparent)" }}>
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{
                  width: `${Math.min(100, (parte.progreso / Math.max(1, parte.requisito.cantidad)) * 100)}%`,
                  background: parte.completo ? "var(--accent)" : "var(--ink-faint)",
                }}
              />
            </div>
            {/* La regla no se repite aquí a propósito: ya la dice la descripción
                de cada oferta y el botón ("Te faltan duplicados"). Repetirla en
                cada requisito son catorce líneas iguales en una pantalla. */}
            {esFijable(parte.requisito) ? (
              <CopiasDeParte parte={parte} onTocar={(pos) => onTocarCopia(i, pos)} />
            ) : (
              parte.elegidas.length > 0 && (
                <p className="text-[10px] ink-faint mt-2 leading-relaxed">
                  Entregarías: {resumirCartas(parte.elegidas)}
                </p>
              )
            )}
          </li>
        ))}
      </ul>

      <div className="mt-auto flex flex-col gap-2">
        {completa && reparto && (
          // El desglose completo: qué valen las cartas sueltas, qué cuota paga
          // el comprador y qué sale al final. Sin topes que explicar, las tres
          // cifras encajan y el jugador puede comprobar la cuenta.
          <div className="surface-2 rounded-2xl px-3.5 py-3 flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="ink-soft">Precio suelto del lote</span>
              <span className="tnum">{formatNumber(reparto.valor)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="ink-soft">Cuota del comprador</span>
              <span className="tnum" style={{ color }}>
                ×{oferta.multiplicador.toFixed(2).replace(".", ",")}
              </span>
            </div>
            <div
              className="flex items-baseline justify-between gap-2 pt-1.5 mt-0.5"
              style={{ borderTop: "1px solid color-mix(in srgb, var(--ink) 10%, transparent)" }}
            >
              <span className="text-xs font-semibold">
                Total{" "}
                <span className="ink-faint font-normal">(+{formatNumber(prima)} de prima)</span>
              </span>
              <span className="text-base font-bold accent tnum">
                {formatNumber(pago)} monedas
              </span>
            </div>
          </div>
        )}

        {completa && reparto && (
          <p className="text-[10px] ink-faint leading-relaxed">
            Entregas duplicados: de cada carta del lote te queda una copia en el álbum.
          </p>
        )}

        {/* LA SALIDA DE EMERGENCIA. Aparece en cuanto se toca algo y no sólo
            cuando el lote queda incompleto: quien clava cuatro cartas y luego se
            arrepiente no tiene por qué soltarlas de una en una, y quien se ha
            atascado necesita ver la salida SIN tener que deducir cuál de sus
            elecciones sobra. Va encima del botón de cobrar, que es donde va a
            mirar cuando algo no cuadre. */}
        {hayFijadas && !cumplida && (
          <button
            type="button"
            onClick={onSoltarTodo}
            className="w-full touch-target py-2.5 rounded-xl text-xs font-medium btn-ghost ink-soft press flex items-center justify-center gap-2"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="w-3.5 h-3.5 shrink-0" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
            Volver a la propuesta automática
          </button>
        )}

        <button
          onClick={onCumplir}
          disabled={!completa || cumplida || !puedeCobrar || enCurso || bloqueada}
          className={`w-full touch-target py-3 rounded-xl text-sm font-semibold press flex items-center justify-center gap-2 disabled:cursor-not-allowed ${
            completa && !cumplida && puedeCobrar ? "btn-accent" : "btn-ghost ink-soft"
          } ${!completa || cumplida || !puedeCobrar ? "opacity-60" : ""}`}
        >
          {enCurso
            ? "Entregando…"
            : cumplida
              ? "Ya cobrada"
              : !puedeCobrar
                ? "Inicia sesión para cobrar"
                : completa
                  ? "Cumplir encargo"
                  : hayFijadas && autoCompleta
                    ? // TERCER CASO, y existe porque desde que se puede elegir a
                      // mano "Te faltan duplicados" puede ser MENTIRA: el jugador
                      // los tiene y los ha colocado de forma que no cuadran. Decirle
                      // que le faltan cartas lo mandaría a abrir sobres para
                      // arreglar algo que se arregla con el botón de aquí arriba.
                      //
                      // Hacen falta LAS DOS condiciones. Con sólo `hayFijadas`,
                      // una oferta que el jugador NO PUEDE cumplir (no tiene los
                      // duplicados) pasaba a acusarle en cuanto tocaba un chip de
                      // otro requisito que sí cumplía: el botón de emergencia no
                      // arreglaba nada porque no había nada que arreglar, y el
                      // rótulo volvía solo a "Te faltan duplicados" al pulsarlo.
                      "Tus cambios dejan el lote incompleto"
                    : // "Duplicados" y no "cartas": es la respuesta a por qué el
                      // progreso dice 3/5 con cinco cartas que encajan en el álbum.
                      "Te faltan duplicados"}
        </button>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ *
 * LAS COPIAS DEL LOTE, UNA A UNA
 * ------------------------------------------------------------------ */

const nombreDe = (c: CartaMercado) => String(c.nombreEs ?? c.name ?? c.id);

/** Chips que se pintan antes de plegar el resto. Dos filas en un iPhone. */
const TOPE_CHIPS = 6;

/**
 * La fila de copias que se van a entregar por este requisito, cada una tocable.
 *
 * SUSTITUYE al viejo "Entregarías: Pikachu ×2 (de 3)…", que era texto plano.
 * Aquí cada chip es un botón porque es la única forma de que "quiero mandar la
 * basura y quedarme la buena" se pueda hacer, y por eso el PRECIO va en el chip
 * y no escondido en el selector: la decisión se toma mirando esta fila.
 *
 * UN CHIP POR COPIA, con una excepción: el PLAYSET son N copias de la MISMA
 * carta y una sola decisión, así que se pinta un chip con "×N". Cuatro chips
 * idénticos que hacen los cuatro lo mismo mentirían sobre lo que se puede
 * cambiar.
 *
 * Nada de `scale` ni de filtros aquí ni en el selector: aunque en esta pantalla
 * no haya ilustraciones que emborronar (el mercado no las recibe del servidor,
 * ver la cabecera de SelectorEntrega), el día que las haya el realce ya es un
 * BORDE y no hay que reescribir nada.
 */
function CopiasDeParte({
  parte,
  onTocar,
}: {
  parte: ParteReparto;
  onTocar: (posicion: number) => void;
}) {
  const [desplegado, setDesplegado] = useState(false);
  const playset = parte.requisito.filtro.categoria === "playset";
  const huecos = playset ? parte.elegidas.slice(0, 1) : parte.elegidas;

  /* SIN CHIPS NO SE CALLA. Un requisito que no se llena se queda sin copias
     (`devolverAutomaticas` las devuelve al fondo común para que las use el
     siguiente requisito), y antes eso era un `return null`: el jugador veía
     "1/5", media barra y NINGUNA superficie que tocar, justo donde más querría
     meter mano, mientras los requisitos que sí funcionaban se llenaban de chips.
     Eso es el reparto de afordancias exactamente al revés, así que al menos hay
     que decir por qué aquí no hay nada. */
  if (huecos.length === 0) {
    return (
      <p className="text-[10px] ink-faint mt-2 leading-relaxed">
        Con los duplicados que te sobran no se llena este requisito, así que
        todavía no hay copias que elegir.
      </p>
    );
  }

  /* UN CHIP POR COPIA NO ESCALA A 20 COPIAS, y las hay: la morralla a granel
     pide hasta 20 cartas (utils/mercado.ts, REJILLA_BANDAS), y casi un tercio
     de los requisitos del tablón piden 8 o más. A 44px de alto y dos o tres por
     fila eso son 350-500px de chips en una tarjeta que antes resolvía lo mismo
     con una línea de texto, y el desglose de pago y el botón de cobrar se van
     debajo del pliegue. Se pliega a una fila y media y se despliega a mano; el
     que quiere cambiar una copia suelta casi nunca necesita verlas las 20. */
  const visibles = desplegado ? huecos : huecos.slice(0, TOPE_CHIPS);
  const ocultas = huecos.length - visibles.length;

  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {visibles.map((c, posicion) => {
        const fija = parte.fijas[posicion] ?? false;
        const copias = playset ? parte.requisito.cantidad : 1;
        return (
          <button
            key={`${posicion}-${c.id}`}
            type="button"
            onClick={() => onTocar(posicion)}
            aria-label={`Cambiar ${nombreDe(c)}${fija ? " (la elegiste tú)" : ""}`}
            /* `min-h-11` son los 44px de zona táctil: esto se toca con el
               pulgar y una fila de chips finos se falla la mitad de las veces.
               `rounded-xl` sobreescribe el 999px de `.chip` —que va en un
               `:where()` de especificidad cero justo para esto— porque una
               píldora de 44px de alto parece un botón de acción y aquí lo que
               hay es una lista de cartas. */
            className="chip press-flat min-h-11 rounded-xl px-2.5 py-1 flex items-center gap-1.5 text-[10px] max-w-full transition-colors hover:border-[var(--border-strong)]"
            style={fija ? { borderColor: "var(--accent)" } : undefined}
          >
            {fija && (
              // El alfiler distingue "esto lo he puesto yo" de "esto lo propuso
              // la pantalla", que es lo único que hay que saber para decidir si
              // soltarlo. Un color no basta: se lee mal en la tarjeta cumplida.
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3 h-3 shrink-0" style={{ color: "var(--accent)" }} aria-hidden="true">
                <path d="M12 17v5" />
                <path d="M9 10.76V5h6v5.76l2 2.24v2H7v-2z" />
              </svg>
            )}
            <span className="truncate max-w-[9rem]">{nombreDe(c)}</span>
            {copias > 1 && <span className="tnum ink-faint">×{copias}</span>}
            <span className="tnum ink-faint">{formatNumber(c.precio * copias)}</span>
          </button>
        );
      })}
      {(ocultas > 0 || desplegado) && (
        <button
          type="button"
          onClick={() => setDesplegado((v) => !v)}
          className="chip press-flat min-h-11 rounded-xl px-2.5 py-1 flex items-center text-[10px] ink-soft transition-colors hover:border-[var(--border-strong)]"
        >
          {desplegado ? "Ver menos" : `y ${ocultas} más`}
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * EL SELECTOR
 * ------------------------------------------------------------------ */

/** Opciones por tanda. Una tanda llena unas tres pantallas de la hoja. */
const TANDA_OPCIONES = 30;

/**
 * Qué carta mando en este hueco.
 *
 * ---------------------------------------------------------------------------
 * POR QUÉ NO SE REUTILIZA components/vitrina/SelectorCarta.tsx
 * ---------------------------------------------------------------------------
 * Resuelve el mismo problema (elegir una carta con el pulgar) y de ahí sale el
 * ESQUELETO: hoja inferior arrastrable, buscador, lista por tandas y zonas
 * táctiles de 44px. Pero pide `CartaEnColeccion` —con `images` y `rarity`
 * obligatorios— y habla de fundas y de copias colocadas, que es la cuenta del
 * archivador y no la del mercado ("copias entregables que este lote no está
 * usando ya"). Generalizarlo habría metido el vocabulario del mercado en un
 * fichero de la vitrina para no repetir cuarenta líneas de maquetación.
 *
 * ---------------------------------------------------------------------------
 * POR QUÉ NO HAY ILUSTRACIONES, que es lo que primero se echa en falta
 * ---------------------------------------------------------------------------
 * El mercado NO recibe imágenes: `COLUMNAS_MERCADO` (app/action.ts) trae id,
 * nombre, rareza, tipos, PS, ilustrador, Pokédex y set, y ni una URL. Pintar
 * `PokemonCard` aquí daría una rejilla de huecos grises con el nombre dentro,
 * que es peor que una lista honesta. Se arregla con una línea en esa consulta
 * (añadir `c.images` y pasarla en `cartaDesdeFila`), pero ese fichero está
 * tomado por otro trabajo. Cuando esté, esta lista se convierte en la rejilla
 * de tres columnas del selector de la vitrina y el resto no se toca.
 *
 * Mientras tanto se enseña lo que de verdad decide: NOMBRE, RAREZA, COPIAS
 * LIBRES y PRECIO SUELTO. El precio va en la fila y no detrás de un toque
 * porque el motivo de abrir esto casi siempre es "mandar la basura y quedarme
 * la buena", y el orden es el mismo del algoritmo, así que la primera opción es
 * la que la pantalla habría elegido sola.
 */
function SelectorEntrega({
  destino,
  requisito,
  opciones,
  actual,
  posicion,
  copiasDelRequisito,
  fijada,
  onElegir,
  onSoltar,
  onCerrar,
}: {
  destino: { ofertaId: string; indice: number; posicion: number } | null;
  requisito?: Requisito;
  opciones: Opcion[];
  /** La copia que ocupa ahora el hueco. */
  actual?: CartaMercado;
  /** Qué hueco del requisito se está cambiando, contando desde 0. */
  posicion: number;
  /** Cuántas copias tiene ahora mismo el lote de este requisito. */
  copiasDelRequisito: number;
  /** ¿Esa copia la clavó el jugador? Entonces se puede soltar. */
  fijada: boolean;
  onElegir: (carta: CartaMercado) => void;
  onSoltar: () => void;
  onCerrar: () => void;
}) {
  const [busqueda, setBusqueda] = useState("");
  const [tope, setTope] = useState(TANDA_OPCIONES);

  /* CADA HUECO EMPIEZA LIMPIO. El buscador de la copia anterior no tiene nada
   * que ver con ésta —a diferencia del selector de la vitrina, donde el filtro
   * de expansión se conserva a propósito porque una hoja se monta con cartas
   * del mismo set— y arrastrarlo escondería media lista sin que se note.
   *
   * Se ajusta DURANTE EL RENDER y no en un efecto: es el patrón que documenta
   * React para "estado que depende de una prop" y evita el fotograma con la
   * búsqueda vieja que deja el efecto.
   *
   * AL CERRAR SE OLVIDA EL HUECO, y esa línea es la que faltaba: la guarda
   * comparaba con el último hueco PINTADO, que no se borraba nunca, así que
   * reabrir EL MISMO hueco conservaba la búsqueda y el "ver más" de la vez
   * anterior. El jugador escribía "pika", elegía, volvía a abrir el mismo chip y
   * se encontraba "Ninguna de las que valen aquí encaja con esa búsqueda" sobre
   * una lista que él no había filtrado en esta apertura. Sólo se borra el hueco
   * —no la búsqueda—, o la lista se repintaría entera bajo la animación
   * de salida de la hoja. */
  const huecoActual = destino
    ? `${destino.ofertaId}:${destino.indice}:${destino.posicion}`
    : null;
  const [huecoPintado, setHuecoPintado] = useState<string | null>(null);
  if (huecoActual !== null && huecoActual !== huecoPintado) {
    setHuecoPintado(huecoActual);
    setBusqueda("");
    setTope(TANDA_OPCIONES);
  } else if (huecoActual === null && huecoPintado !== null) {
    setHuecoPintado(null);
  }

  const texto = busqueda.trim().toLowerCase();
  const filtradas = texto
    ? opciones.filter(
        (o) =>
          nombreDe(o.carta).toLowerCase().includes(texto) ||
          String(o.carta.name ?? "").toLowerCase().includes(texto),
      )
    : opciones;
  const visibles = filtradas.slice(0, tope);
  const playset = requisito?.filtro.categoria === "playset";

  return (
    <Sheet open={destino !== null} onClose={onCerrar} label="Elegir qué carta entregas">
      <div className="px-4 pt-1 pb-6 sm:px-5">
        <h2 className="ink text-center text-[17px] font-semibold">
          {playset ? "Elegir el playset" : "Elegir la carta que entregas"}
        </h2>
        <p aria-live="polite" className="ink-soft mt-1.5 text-center text-[12px] leading-relaxed">
          {requisito?.descripcion ?? ""}
        </p>
        {/* QUÉ COPIA SE ESTÁ CAMBIANDO, con su nombre y su precio.
            Antes el único subtítulo era la descripción del requisito, que dice
            lo mismo para los ocho chips: fallar el chip de al lado con el pulgar
            es normal en una fila de ocho, y la hoja no daba NINGUNA forma de
            darse cuenta. El otro selector de la app lo resuelve igual
            (components/vitrina/SelectorCarta.tsx dice "Hoja 1, funda 3").

            El nombre además hace de rescate: la lista va ordenada como ordena el
            algoritmo (lo barato primero) y se pinta por tandas de 30, así que la
            copia cara que el jugador clavó puede estar fuera de la primera
            tanda. Sabiendo cómo se llama la encuentra con el buscador. */}
        {actual && (
          <p className="ink-faint mt-1 text-center text-[11px] leading-relaxed">
            Cambias <span className="ink-soft font-medium">{nombreDe(actual)}</span>
            {playset ? ` ×${requisito?.cantidad ?? 1}` : ""} ·{" "}
            {formatNumber(actual.precio * (playset ? (requisito?.cantidad ?? 1) : 1))} monedas
            {!playset && copiasDelRequisito > 1
              ? ` · copia ${posicion + 1} de ${copiasDelRequisito}`
              : ""}
          </p>
        )}

        {/* SOLTAR DE UNA EN UNA. La otra mitad ("volver a la propuesta
            automática") vive en la tarjeta: quien se atasca necesita las dos,
            porque soltar la carta equivocada no siempre desatasca. */}
        {fijada && (
          <button
            type="button"
            onClick={onSoltar}
            className="btn-ghost press touch-target mx-auto mt-3 flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[12px] font-medium"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-3.5 w-3.5 shrink-0" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
            {playset ? "Que lo elija la pantalla" : "Que esta copia la elija la pantalla"}
          </button>
        )}

        {opciones.length === 0 ? (
          /* SIN OPCIONES no se dice "no hay resultados": el jugador se pondría
             a buscar un filtro inexistente. Lo que pasa es que no le sobra
             ninguna otra carta que valga aquí, y eso hay que decirlo. */
          <p className="ink-soft py-12 text-center text-[12px] leading-relaxed">
            No te sobra ninguna otra carta que valga para este requisito. Sólo se pueden
            entregar duplicados, y las que ya está usando el resto del lote no cuentan.
          </p>
        ) : (
          <>
            <label className="input-field mt-4 flex min-h-11 items-center gap-2 rounded-xl px-3 py-2">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ink-faint h-4 w-4 shrink-0" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                type="search"
                inputMode="search"
                enterKeyHint="search"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-label="Buscar entre las cartas que valen"
                placeholder="Buscar una carta…"
                value={busqueda}
                onChange={(e) => {
                  setBusqueda(e.target.value);
                  setTope(TANDA_OPCIONES);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:opacity-50 [&::-webkit-search-cancel-button]:hidden"
              />
            </label>

            {filtradas.length === 0 ? (
              <p className="ink-soft py-12 text-center text-[12px] leading-relaxed">
                Ninguna de las que valen aquí encaja con esa búsqueda.
              </p>
            ) : (
              <>
                <ul className="mt-3 flex flex-col gap-1.5">
                  {visibles.map(({ carta, libres }) => {
                    const esLaDeAhora = carta.id === actual?.id;
                    // El playset se lleva `cantidad` copias de golpe: lo que se
                    // entrega —y lo que se cobra— es ese múltiplo, no una carta.
                    const copias = playset ? (requisito?.cantidad ?? 1) : 1;
                    return (
                      <li key={carta.id}>
                        <button
                          type="button"
                          onClick={() => onElegir(carta)}
                          /* El precio del rótulo es el MISMO que se pinta. En un
                             playset la fila enseña el precio de las N copias y
                             este `aria-label` cantaba el de una sola: con
                             VoiceOver el número leído no era el número escrito. */
                          aria-label={
                            copias > 1
                              ? `Entregar ${copias} copias de ${nombreDe(carta)}, precio ${carta.precio * copias}`
                              : `Entregar ${nombreDe(carta)}, precio ${carta.precio}`
                          }
                          className="surface-2 press-flat min-h-11 w-full rounded-xl px-3 py-2.5 text-left transition-colors hover:border-[var(--border-strong)]"
                          style={esLaDeAhora ? { borderColor: "var(--accent)" } : undefined}
                        >
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="truncate text-[13px] font-medium">
                              {nombreDe(carta)}
                            </span>
                            <span className="tnum accent shrink-0 text-[13px] font-semibold">
                              {/* El "×N" del playset va aquí y no sólo en el chip:
                                  sin él la fila enseña un número cuatro veces
                                  mayor que el precio de la carta y nada que los
                                  relacione. */}
                              {copias > 1 && (
                                <span className="ink-faint font-normal">×{copias} </span>
                              )}
                              {formatNumber(carta.precio * copias)}
                            </span>
                          </div>
                          <div className="mt-0.5 flex items-baseline justify-between gap-3">
                            <span className="ink-faint truncate text-[10px]">
                              {carta.rarity ?? "Sin rareza"}
                              {esLaDeAhora ? " · la de ahora" : ""}
                            </span>
                            <span className="tnum ink-faint shrink-0 text-[10px]">
                              {/* "Libres" y no "copias": son las que sobran
                                  DESPUÉS de dejar la del álbum y de descontar
                                  las que ya usa el resto del lote. */}
                              {libres} {libres === 1 ? "libre" : "libres"} de {carta.cantidad}
                            </span>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>

                {filtradas.length > visibles.length && (
                  <button
                    type="button"
                    onClick={() => setTope((t) => t + TANDA_OPCIONES)}
                    className="btn-ghost press touch-target mx-auto mt-4 block rounded-xl px-5 py-2.5 text-[12px] font-medium"
                  >
                    Ver más ({formatNumber(filtradas.length - visibles.length)} restantes)
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ *
 * FORMATO
 * ------------------------------------------------------------------ */

/**
 * "Pikachu ×2 (de 3), Bulbasaur (de 2)" — agrupa las copias repetidas y dice de
 * cuántas salen, que es lo que responde a la pregunta de siempre: "¿me quedo
 * sin la carta?". Nunca: por construcción se entrega como mucho `cantidad - 1`.
 */
function resumirCartas(elegidas: CartaMercado[]): string {
  // Se agrupa por ID, no por nombre: dos ediciones distintas del mismo Pokémon
  // son dos cartas con dos cantidades, y mezclarlas mentiría en el "(de N)".
  const cuenta = new Map<string, { nombre: string; copias: number; total: number }>();
  for (const c of elegidas) {
    const actual = cuenta.get(c.id);
    if (actual) actual.copias += 1;
    // `nombreEs` es el rótulo; `name` sigue en inglés porque con él empareja el
    // servidor (ver la nota de CartaMercado en app/action.ts).
    else cuenta.set(c.id, { nombre: String(c.nombreEs ?? c.name ?? ""), copias: 1, total: c.cantidad });
  }
  return Array.from(cuenta.values())
    .map(({ nombre, copias, total }) =>
      copias > 1 ? `${nombre} ×${copias} (de ${total})` : `${nombre} (de ${total})`,
    )
    .join(", ");
}

/** Cuenta atrás del ciclo, sin segundos: es un plazo de horas. */
function restante(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "Sorteando encargos nuevos…";
  const minutos = Math.floor(ms / 60000);
  const horas = Math.floor(minutos / 60);
  if (horas >= 1) return `Encargos nuevos en ${horas} h ${minutos % 60} min`;
  if (minutos >= 1) return `Encargos nuevos en ${minutos} min`;
  return "Encargos nuevos en menos de un minuto";
}
