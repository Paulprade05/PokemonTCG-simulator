"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import { cumplirOferta, getCartasMercado, getMercado } from "../action";
import {
  TECHO_PRIMA,
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
  /** Copias que tiene el jugador. */
  cantidad: number;
  /** SELL_PRICES de su rareza (lo calcula el servidor). */
  precio: number;
}

/** Una copia concreta apartada para un requisito. */
interface Elegida {
  carta: CartaMercado;
  /** true si entregarla vacía esa carta del álbum. */
  vacia: boolean;
}

interface ParteReparto {
  requisito: Requisito;
  elegidas: Elegida[];
  /** Unidades conseguidas (tipos para el arcoíris, copias para el playset...). */
  progreso: number;
}

interface Reparto {
  partes: ParteReparto[];
  completa: boolean;
  ids: string[];
  valor: number;
  /** Cartas que desaparecerían del álbum al entregar el lote. */
  vaciadas: number;
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
 * Elige, para cada requisito, las cartas MÁS BARATAS que lo cumplen.
 *
 * POR QUÉ LO MÁS BARATO: el mercado paga multiplicador × precio de venta del
 * lote, con la prima topada. Entregar una Hyper Rare de 250 donde vale una
 * común de 2 no sube el cobro más que unas monedas y regala la carta buena.
 *
 * Esta propuesta es sólo eso, una propuesta: el servidor vuelve a comprobar
 * posesión y requisitos con los datos de la base de datos.
 */
function repartir(oferta: Oferta, cartas: CartaMercado[]): Reparto {
  // Copias sin apartar, por id. Una carta no puede valer para dos requisitos.
  const libres = new Map<string, number>();
  for (const c of cartas) libres.set(c.id, c.cantidad);
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

  for (const { requisito: r, indice } of orden) {
    const candidatas = cartas.filter((c) => libre(c) > 0 && sirve(c, r)).sort(comparar);
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

  // Cuántas copias se entregan de cada carta: sirve para avisar de las que
  // desaparecen del álbum.
  const entregadasPorId = new Map<string, number>();
  for (const { elegidas } of porIndice.values()) {
    for (const c of elegidas) entregadasPorId.set(c.id, (entregadasPorId.get(c.id) ?? 0) + 1);
  }

  const partes: ParteReparto[] = oferta.requisitos.map((requisito, indice) => {
    const { elegidas, progreso } = porIndice.get(indice) ?? { elegidas: [], progreso: 0 };
    return {
      requisito,
      progreso,
      elegidas: elegidas.map((carta) => ({
        carta,
        vacia: (entregadasPorId.get(carta.id) ?? 0) >= carta.cantidad,
      })),
    };
  });

  const todas = partes.flatMap((p) => p.elegidas);
  const completa = partes.every((p) => p.elegidas.length === p.requisito.cantidad);

  return {
    partes,
    completa,
    ids: todas.map((e) => e.carta.id),
    valor: todas.reduce((total, e) => total + e.carta.precio, 0),
    vaciadas: new Set(todas.filter((e) => e.vacia).map((e) => e.carta.id)).size,
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
  posesion: "Ya no tienes alguna de esas cartas. Recarga y vuelve a intentarlo.",
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
        // ids para que el servidor los hidrate y pueda ver su progreso.
        const idsInvitado = isSignedIn
          ? undefined
          : getCollection()
              .map((c) => c.id)
              .filter(Boolean);
        const [tablon, coleccion] = await Promise.all([
          getMercado(),
          getCartasMercado(idsInvitado),
        ]);

        let lista = coleccion.cartas as CartaMercado[];
        if (!isSignedIn) {
          // Las cantidades del invitado sólo las sabe el navegador.
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
        El comprador paga el precio de venta del lote multiplicado, con un presupuesto máximo de
        prima por encargo. Se entregan las cartas más baratas que cumplan: lo caro no se paga
        mejor.
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
          <p className="text-[10px] ink-faint">máx +{TECHO_PRIMA[oferta.dificultad]}</p>
        </div>
      </header>

      <p className="text-xs ink-soft leading-relaxed">{oferta.descripcion}</p>

      <ul className="flex flex-col gap-2.5">
        {(reparto?.partes ?? []).map((parte, i) => (
          <li key={i} className="surface-2 rounded-2xl px-3.5 py-3">
            <div className="flex items-start justify-between gap-3 mb-2">
              <p className="text-xs leading-snug flex-1">{parte.requisito.descripcion}</p>
              <span
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
            {parte.elegidas.length > 0 && (
              <p className="text-[10px] ink-faint mt-2 leading-relaxed">
                Entregarías:{" "}
                {resumirCartas(parte.elegidas)}
              </p>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-auto flex flex-col gap-2">
        {completa && reparto && (
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="ink-soft">
              Lote {formatNumber(reparto.valor)} + prima {formatNumber(prima)}
            </span>
            <span className="text-base font-bold accent tnum">
              {formatNumber(pago)} monedas
            </span>
          </div>
        )}

        {completa && reparto && reparto.vaciadas > 0 && (
          <p className="text-[10px]" style={{ color: "var(--warn)" }}>
            Ojo: {reparto.vaciadas === 1 ? "una carta saldría" : `${reparto.vaciadas} cartas saldrían`} de
            tu álbum (no te quedan más copias).
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
                  : "Te faltan cartas"}
        </button>
      </div>
    </motion.article>
  );
}

/* ------------------------------------------------------------------ *
 * FORMATO
 * ------------------------------------------------------------------ */

/** "Pikachu ×2, Bulbasaur" — agrupa las copias repetidas. */
function resumirCartas(elegidas: Elegida[]): string {
  const cuenta = new Map<string, number>();
  for (const e of elegidas) cuenta.set(e.carta.name, (cuenta.get(e.carta.name) ?? 0) + 1);
  return Array.from(cuenta.entries())
    .map(([nombre, n]) => (n > 1 ? `${nombre} ×${n}` : nombre))
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
