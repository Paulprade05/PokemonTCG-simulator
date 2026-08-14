"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import { cumplirOferta, getCartasMercado, getMercado } from "../action";
import {
  copiasEntregables,
  cumpleFiltro,
  pagoDelLote,
  setDeCarta,
  type CartaMinima,
  type Categoria,
  type Oferta,
  type Requisito,
} from "../../utils/mercado";
import { AVAILABLE_SETS } from "../../utils/constanst";
import { formatNumber } from "../../utils/format";
import { getCollection } from "../../utils/storage";
import { useCurrency } from "../../hooks/useGameCurrency";
import { useHaptics } from "../../hooks/useHaptics";
import { useToast } from "../../components/ui/Toast";
import PageHeader from "../../components/PageHeader";
import Loader from "../../components/Loader";

/* ------------------------------------------------------------------ *
 * DATOS
 * ------------------------------------------------------------------ */

interface CartaMercado extends CartaMinima {
  /**
   * Copias que tiene el jugador EN TOTAL. Las entregables son
   * `copiasEntregables(cantidad)`, nunca `cantidad`: ver la nota de `repartir`.
   */
  cantidad: number;
  /** SELL_PRICES de su rareza (lo calcula el servidor). */
  precio: number;
}

interface ParteReparto {
  requisito: Requisito;
  /** Copias apartadas para este requisito (una entrada por copia entregada). */
  elegidas: CartaMercado[];
  /** Unidades conseguidas (tipos para el arcoíris, copias para el playset...). */
  progreso: number;
}

interface Reparto {
  partes: ParteReparto[];
  completa: boolean;
  ids: string[];
  /** Precio suelto del lote: lo que darían las cartas vendidas una a una. */
  valor: number;
}

/**
 * Orden en que se reparten las cartas entre requisitos: primero los que casi no
 * admiten alternativas y al final el "cartas cualesquiera de la expansión", que
 * acepta todo. Al revés, el requisito comodín se llevaría las cartas que el
 * exigente necesitaba y la oferta parecería incompleta teniéndolo todo.
 */
const PRIORIDAD: Record<Categoria, number> = {
  evolucion: 0,
  playset: 1,
  arcoiris: 2,
  artista: 3,
  pokedex: 3,
  etapa: 3,
  hp: 3,
  rareza: 3,
  supertipo: 3,
  numero: 3,
  inicial: 3,
  tipo: 4,
  set: 5,
};

const nombreDeSet = (setId: string | null): string =>
  setId ? AVAILABLE_SETS.find((s) => s.id === setId)?.name ?? setId.toUpperCase() : "Cualquier expansión";

const clave = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** Misma comprobación que hace el servidor: el set va aparte del filtro. */
const sirve = (c: CartaMinima, r: Requisito): boolean =>
  (r.setId === null || setDeCarta(c) === r.setId) && cumpleFiltro(c, r.filtro);

/** Barata primero y, a igual precio, la que tiene más copias de sobra. */
const comparar = (a: CartaMercado, b: CartaMercado) =>
  a.precio - b.precio || b.cantidad - a.cantidad || a.id.localeCompare(b.id);

/**
 * Elige, para cada requisito, las cartas MÁS BARATAS que lo cumplen, contando
 * SÓLO DUPLICADOS.
 *
 * POR QUÉ SÓLO DUPLICADOS, Y POR QUÉ AQUÍ Y NO AL FINAL: el mercado sólo compra
 * las copias que sobran, y el servidor exige tener `entregadas + 1` de cada
 * carta. Si esta función repartiera sobre las copias POSEÍDAS y el filtro se
 * aplicara después, el progreso diría "5/5", el botón se pondría verde y el
 * cobro fallaría: el peor fallo posible en esta pantalla. Por eso el fondo
 * común del que se reparte ya son los duplicados —`copiasEntregables`, la misma
 * función que usa el servidor— y todo lo que sale de aquí (progreso, barra,
 * lote, valor) está medido en duplicados por construcción.
 *
 * POR QUÉ LO MÁS BARATO: el pago es multiplicador × precio de venta del lote, y
 * el multiplicador ya está fijado en la oferta. Entregar la carta cara que
 * también cumple sube el cobro unas monedas y regala la carta buena; el
 * requisito lleva banda de rareza, así que lo barato cumple igual.
 *
 * Esta propuesta es sólo eso, una propuesta: el servidor vuelve a comprobar
 * posesión, duplicados y requisitos con los datos de la base de datos.
 */
function repartir(oferta: Oferta, cartas: CartaMercado[]): Reparto {
  // Copias ENTREGABLES sin apartar, por id (la copia del álbum nunca entra en
  // este fondo). Una carta no puede valer para dos requisitos.
  const libres = new Map<string, number>();
  for (const c of cartas) libres.set(c.id, copiasEntregables(c.cantidad));
  const libre = (c: CartaMercado) => libres.get(c.id) ?? 0;
  const apartar = (c: CartaMercado, n = 1) => libres.set(c.id, libre(c) - n);

  const orden = oferta.requisitos
    .map((requisito, indice) => ({ requisito, indice }))
    .sort(
      (a, b) =>
        (PRIORIDAD[a.requisito.filtro.categoria] ?? 3) -
          (PRIORIDAD[b.requisito.filtro.categoria] ?? 3) || a.indice - b.indice,
    );

  const porIndice = new Map<number, { elegidas: CartaMercado[]; progreso: number }>();

  for (let k = 0; k < orden.length; k++) {
    const { requisito: r, indice } = orden[k];
    // Requisitos que aún no se han servido: las cartas que también les valen
    // hay que gastarlas LO ÚLTIMO. Sin esto, "8 de tipo Fuego o Lucha" + "3 de
    // Kalos" se rompía en cuanto las tres cartas de Kalos más baratas eran
    // además de tipo Fuego: el requisito exigente se quedaba sin material que
    // sólo él podía usar y la oferta se veía incompleta teniéndolo todo. Es el
    // mismo criterio (`utilidadEnOtros`) con el que el servidor ordena sus
    // opciones, y por eso las dos partes convergen en el mismo lote.
    const pendientes = orden.slice(k + 1).map((x) => x.requisito);
    // La utilidad se calcula una vez por carta y no dentro del comparador: el
    // sort la pediría O(n log n) veces y cada una recorre los filtros.
    const utilidad = new Map<string, number>();
    const candidatas = cartas.filter((c) => libre(c) > 0 && sirve(c, r));
    for (const c of candidatas) {
      utilidad.set(c.id, pendientes.filter((p) => sirve(c, p)).length);
    }
    candidatas.sort(
      (a, b) => (utilidad.get(a.id) ?? 0) - (utilidad.get(b.id) ?? 0) || comparar(a, b),
    );
    let elegidas: CartaMercado[] = [];
    let progreso = 0;

    if (r.filtro.categoria === "playset") {
      // `cantidad` copias de LA MISMA carta: la más barata que llegue.
      const suficientes = candidatas.filter((c) => libre(c) >= r.cantidad);
      progreso = candidatas.reduce((mejor, c) => Math.max(mejor, Math.min(libre(c), r.cantidad)), 0);
      if (suficientes.length > 0) {
        elegidas = Array.from({ length: r.cantidad }, () => suficientes[0]);
        progreso = r.cantidad;
      }
    } else if (r.filtro.categoria === "arcoiris") {
      // Una carta por TIPO distinto, empezando por las baratas.
      const tipos = new Set<string>();
      for (const c of candidatas) {
        if (elegidas.length >= r.cantidad) break;
        if (libre(c) <= 0) continue;
        const tipo = (c.types ?? []).map(clave).find((t) => !tipos.has(t));
        if (!tipo) continue;
        tipos.add(tipo);
        elegidas.push(c);
        apartar(c);
      }
      progreso = elegidas.length;
      if (elegidas.length < r.cantidad) {
        // Incompleta: se devuelven al fondo común para el siguiente requisito.
        elegidas.forEach((c) => apartar(c, -1));
        elegidas = [];
      }
    } else if (r.filtro.categoria === "evolucion") {
      const cadena = mejorCadena(candidatas, r.cantidad, libre);
      if (cadena) {
        elegidas = cadena;
        progreso = r.cantidad;
      } else {
        // Para la barra: si pedían 3 eslabones, enseñar si al menos hay 2.
        progreso = r.cantidad === 3 && mejorCadena(candidatas, 2, libre) ? 2 : 0;
      }
      elegidas.forEach((c) => apartar(c));
    } else {
      for (const c of candidatas) {
        // Una carta con varias copias puede llenar varios huecos del requisito.
        while (libre(c) > 0 && elegidas.length < r.cantidad) {
          elegidas.push(c);
          apartar(c);
        }
        if (elegidas.length >= r.cantidad) break;
      }
      progreso = elegidas.length;
      if (elegidas.length < r.cantidad) {
        elegidas.forEach((c) => apartar(c, -1));
        elegidas = [];
      }
    }

    if (r.filtro.categoria === "playset" && elegidas.length > 0) apartar(elegidas[0], r.cantidad);

    porIndice.set(indice, { elegidas, progreso });
  }

  const partes: ParteReparto[] = oferta.requisitos.map((requisito, indice) => {
    const { elegidas, progreso } = porIndice.get(indice) ?? { elegidas: [], progreso: 0 };
    return { requisito, progreso, elegidas };
  });

  const todas = partes.flatMap((p) => p.elegidas);
  const completa = partes.every((p) => p.elegidas.length === p.requisito.cantidad);

  return {
    partes,
    completa,
    ids: todas.map((c) => c.id),
    valor: todas.reduce((total, c) => total + c.precio, 0),
  };
}

/**
 * Cadena evolutiva más barata de `eslabones` cartas (B.evolvesFrom === A.name).
 * Se indexa por nombre con la copia más barata de cada uno: recorrer todas las
 * combinaciones sería cúbico sobre una colección de miles de cartas.
 */
function mejorCadena(
  candidatas: CartaMercado[],
  eslabones: number,
  libre: (c: CartaMercado) => number,
): CartaMercado[] | null {
  const porNombre = new Map<string, CartaMercado>();
  for (const c of candidatas) {
    if (libre(c) <= 0) continue;
    const k = clave(c.name);
    const actual = porNombre.get(k);
    if (!actual || comparar(c, actual) < 0) porNombre.set(k, c);
  }

  let mejor: CartaMercado[] | null = null;
  const precio = (cs: CartaMercado[]) => cs.reduce((t, c) => t + c.precio, 0);

  for (const fin of porNombre.values()) {
    if (!fin.evolvesFrom) continue;
    const medio = porNombre.get(clave(fin.evolvesFrom));
    if (!medio) continue;
    let cadena: CartaMercado[];
    if (eslabones === 2) {
      cadena = [medio, fin];
    } else {
      if (!medio.evolvesFrom) continue;
      const base = porNombre.get(clave(medio.evolvesFrom));
      if (!base) continue;
      cadena = [base, medio, fin];
    }
    if (!mejor || precio(cadena) < precio(mejor)) mejor = cadena;
  }

  return mejor;
}

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
  const [caduca, setCaduca] = useState(0);
  const [ahora, setAhora] = useState(0);
  const [enCurso, setEnCurso] = useState<string | null>(null);

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

        setOfertas(tablon.ofertas);
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
    for (const o of ofertas) mapa.set(o.id, repartir(o, cartas));
    return mapa;
  }, [ofertas, cartas]);

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
    [repartos, enCurso, haptic, toast, setCoins, cargar],
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
          {ofertas.map((oferta, i) => (
            <TarjetaOferta
              key={oferta.id}
              oferta={oferta}
              reparto={repartos.get(oferta.id)}
              cumplida={cumplidas.includes(oferta.id)}
              puedeCobrar={Boolean(isSignedIn)}
              enCurso={enCurso === oferta.id}
              bloqueada={enCurso !== null && enCurso !== oferta.id}
              retardo={i * 0.04}
              onCumplir={() => onCumplir(oferta)}
            />
          ))}
        </div>
      )}

      <p className="text-[11px] ink-faint text-center mt-6 mb-2 max-w-lg mx-auto leading-relaxed">
        Al mercado sólo van duplicados: de cada carta que entregues te queda siempre una copia en
        el álbum, así que ningún encargo te deja un hueco. El comprador paga su cuota entera sobre
        el precio de venta del lote, sin topes, y se proponen las cartas más baratas que cumplan.
      </p>
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
  retardo,
  onCumplir,
}: {
  oferta: Oferta;
  reparto?: Reparto;
  cumplida: boolean;
  puedeCobrar: boolean;
  enCurso: boolean;
  bloqueada: boolean;
  retardo: number;
  onCumplir: () => void;
}) {
  const color = COLOR_DIFICULTAD[oferta.dificultad];
  const completa = Boolean(reparto?.completa);
  const pago = completa && reparto ? pagoDelLote(oferta, reparto.valor) : 0;
  const prima = completa && reparto ? pago - reparto.valor : 0;

  return (
    <motion.article
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: retardo, ease: [0.16, 1, 0.3, 1] }}
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
              {nombreDeSet(oferta.setId)}
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
                  parte.progreso >= parte.requisito.cantidad ? "accent" : "ink-faint"
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
                  background: parte.progreso >= parte.requisito.cantidad ? "var(--accent)" : "var(--ink-faint)",
                }}
              />
            </div>
            {/* La regla no se repite aquí a propósito: ya la dice la descripción
                de cada oferta y el botón ("Te faltan duplicados"). Repetirla en
                cada requisito son catorce líneas iguales en una pantalla. */}
            {parte.elegidas.length > 0 && (
              <p className="text-[10px] ink-faint mt-2 leading-relaxed">
                Entregarías: {resumirCartas(parte.elegidas)}
              </p>
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
                  : // "Duplicados" y no "cartas": es la respuesta a por qué el
                    // progreso dice 3/5 con cinco cartas que encajan en el álbum.
                    "Te faltan duplicados"}
        </button>
      </div>
    </motion.article>
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
    else cuenta.set(c.id, { nombre: String(c.name ?? ""), copias: 1, total: c.cantidad });
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
