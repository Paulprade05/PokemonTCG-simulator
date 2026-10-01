"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import { getTradableCollection, createTradeOffer } from "../../app/social";
import { useToast } from "../ui/Toast";
import Portal from "../ui/Portal";
import CampoBusqueda from "../ui/CampoBusqueda";
import Segmentado from "../ui/Segmentado";
import { IconoCerrar } from "../icons";
import { useFondoQuieto } from "../../hooks/useBloqueoScroll";
import { useHaptics } from "../../hooks/useHaptics";
import { useKeyboardOpen } from "../../hooks/useViewport";
import { formatNumber } from "../../utils/format";
import { D, EASE_OUT } from "../../utils/motion";
import { esAccionCaducada } from "../../utils/versionApp";

interface Friend { friend_id: string; friend_name: string; }
interface TradeBuilderProps {
  friend: Friend | null;
  onClose: () => void;
  onSent: () => void;
}

interface TCard { id: string; name: string; rarity: string; quantity: number; images?: { small?: string }; }

type Lado = "offer" | "request";

/**
 * Los filtros de una columna. Son los mismos tres en los dos lados; lo que
 * cambia es contra qué colección se mira `faltan` y el rótulo que lleva:
 *
 *  · `faltan`    — la carta NO está en la colección de la otra parte. En
 *                  «Pides» son las que me faltan a mí; en «Ofreces», las que le
 *                  faltan al amigo (las que más le va a interesar recibir).
 *  · `repetidas` — hay más de una copia entregable. En «Ofreces» son las que me
 *                  sobran; en «Pides», las que le sobran a él (las que menos le
 *                  cuesta soltar).
 *  · `elegidas`  — sólo lo ya marcado, para repasar la oferta antes de enviarla.
 */
interface Filtros { faltan: boolean; repetidas: boolean; elegidas: boolean; }
const SIN_FILTROS: Filtros = { faltan: false, repetidas: false, elegidas: false };

// El servidor rechaza las ofertas que pasen de aquí, así que se avisa antes de enviarlas.
const MAX_PER_SIDE = 12;

/* Cartas que se pintan por tanda en cada columna. Dos amigos con 441 cartas
   eran 880 botones con imagen montados al abrir; con el tope son 60 por lado y
   el resto llega con «Ver más». Con la rejilla de 3 columnas del móvil, 60 son
   veinte filas: de sobra para elegir sin llegar a pedir la segunda tanda, y más
   aún con «Me faltan» activo, que es lo que suele dejar la lista corta. */
const TANDA = 60;

/* «Flabebe» tiene que encontrar a «Flabébé»: el teclado del móvil no pone la
   tilde sola y nadie la busca. Se quitan los diacríticos de los dos lados. */
const plano = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function filtrar(
  cartas: TCard[], q: string, f: Filtros,
  delOtro: Set<string>, elegidas: Record<string, number>,
): TCard[] {
  const texto = plano(q.trim());
  return cartas.filter((c) => {
    if (texto && !plano(c.name).includes(texto)) return false;
    // «Elegidas» manda sobre los otros dos (ver alternarFiltro): repasar la
    // oferta es ver TODO lo marcado, encaje o no con lo demás.
    if (f.elegidas) return (elegidas[c.id] || 0) > 0;
    if (f.faltan && delOtro.has(c.id)) return false;
    if (f.repetidas && c.quantity <= 1) return false;
    return true;
  });
}

const recuento = (cartas: TCard[], delOtro: Set<string>) => ({
  faltan: cartas.reduce((n, c) => n + (delOtro.has(c.id) ? 0 : 1), 0),
  repetidas: cartas.reduce((n, c) => n + (c.quantity > 1 ? 1 : 0), 0),
});

export default function TradeBuilder({ friend, onClose, onSent }: TradeBuilderProps) {
  const { user } = useUser();
  const toast = useToast();
  const haptic = useHaptics();
  const teclado = useKeyboardOpen();
  const [mine, setMine] = useState<TCard[]>([]);
  const [theirs, setTheirs] = useState<TCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [offer, setOffer] = useState<Record<string, number>>({});   // myCardId -> qty
  const [request, setRequest] = useState<Record<string, number>>({}); // theirCardId -> qty
  const [sending, setSending] = useState(false);
  const [qMine, setQMine] = useState("");
  const [qTheirs, setQTheirs] = useState("");
  /* En móvil se ve UN lado cada vez (ver el cuerpo del panel). Se abre por
     «Pides» porque es por donde empieza un intercambio de verdad: uno entra a
     ver qué tiene el amigo que a él le falta, y sólo después decide qué da. */
  const [lado, setLado] = useState<Lado>("request");
  const [filtros, setFiltros] = useState<Record<Lado, Filtros>>({ offer: SIN_FILTROS, request: SIN_FILTROS });
  const [tope, setTope] = useState<Record<Lado, number>>({ offer: TANDA, request: TANDA });

  useEffect(() => {
    if (!friend || !user) return;
    /* Si se cierra y se abre con otro amigo antes de que llegue la respuesta,
       la carga vieja no puede pintar sus cartas en el panel nuevo ni, si
       falla, cerrarlo. */
    let vigente = true;
    setLoading(true);
    setOffer({}); setRequest({});
    // Sin vaciar aquí, si la carga falla quedan a la vista las cartas del amigo anterior.
    setMine([]); setTheirs([]);
    // El componente no se desmonta entre un amigo y el siguiente: sin esto se
    // heredaban la búsqueda y los filtros del intercambio anterior.
    setQMine(""); setQTheirs("");
    setLado("request");
    setFiltros({ offer: SIN_FILTROS, request: SIN_FILTROS });
    setTope({ offer: TANDA, request: TANDA });
    Promise.all([
      getTradableCollection(user.id),
      getTradableCollection(friend.friend_id),
    ]).then(([a, b]) => {
      if (!vigente) return;
      const mias = a as TCard[];
      const suyas = b as TCard[];
      setMine(mias);
      setTheirs(suyas);
      /* «Me faltan» arranca ACTIVO, que es la pregunta con la que se abre esto.
         Pero sólo si hay alguna: con un amigo que no tiene nada nuevo para mí,
         el filtro encendido enseñaría una rejilla vacía nada más entrar. */
      const tengo = new Set(mias.map((c) => c.id));
      if (suyas.some((c) => !tengo.has(c.id))) {
        setFiltros({ offer: SIN_FILTROS, request: { ...SIN_FILTROS, faltan: true } });
      }
    }).catch(() => {
      if (!vigente) return;
      toast("No se pudieron cargar las cartas", "error");
      onClose();
    }).finally(() => { if (vigente) setLoading(false); });
    return () => { vigente = false; };
    // onClose llega como función nueva en cada render del padre: incluirlo relanzaría la carga.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [friend, user]);

  // El fondo quieto, con el mismo mecanismo que las hojas, el buscador y la
  // ficha (hooks/useBloqueoScroll.ts). Esto escribía `body.style.overflow` a
  // mano, que en el iPhone no impide que un arrastre sobre la cabecera o el pie
  // del panel —que no tienen dónde desplazarse— acabe moviendo la página de
  // Social por detrás; y como guardaba y reponía su propio valor, quedaba fuera
  // del contador de capas de aquel hook.
  useFondoQuieto(!!friend);

  useEffect(() => {
    if (!friend) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [friend, onClose]);

  const offeredIds = useMemo(() => Object.entries(offer).flatMap(([id, q]) => Array(q).fill(id)), [offer]);
  const requestedIds = useMemo(() => Object.entries(request).flatMap(([id, q]) => Array(q).fill(id)), [request]);

  const toggle = (side: Lado, card: TCard) => {
    const total = side === "offer" ? offeredIds.length : requestedIds.length;
    const sel = (side === "offer" ? offer : request)[card.id] || 0;
    /* El tope se frena AL TOCAR y no al enviar. Antes se podía marcar la carta
       número trece: el pie se ponía rojo, el botón se apagaba y había que
       adivinar cuál quitar. Una carta nueva con el lado lleno no entra. */
    if (sel === 0 && total >= MAX_PER_SIDE) {
      haptic("warning");
      toast(`Máximo ${MAX_PER_SIDE} cartas por lado`, "info");
      return;
    }
    haptic("select");
    const setter = side === "offer" ? setOffer : setRequest;
    setter((cur) => {
      const next = { ...cur };
      const have = card.quantity;
      const n = (next[card.id] || 0) + 1;
      // ciclo: vuelve a 0 al pasar el máximo (el de copias o el del lado)
      if (n > have || total >= MAX_PER_SIDE) delete next[card.id];
      else next[card.id] = n;
      return next;
    });
  };

  /* Las dos colecciones ya están en memoria, así que saber qué le falta a cada
     uno es cruzar ids en el cliente, sin otra consulta.
     OJO con lo que significa «tener» aquí: getTradableCollection devuelve lo
     ENTREGABLE, y una carta de la que sólo queda la copia graduada no sale. Esa
     carta aparece como «nueva» aunque esté en la vitrina. Es un caso raro y el
     error cae del lado inofensivo (ofrece de más, no esconde nada). */
  const idsMios = useMemo(() => new Set(mine.map((c) => c.id)), [mine]);
  const idsSuyos = useMemo(() => new Set(theirs.map((c) => c.id)), [theirs]);
  const recuentoMine = useMemo(() => recuento(mine, idsSuyos), [mine, idsSuyos]);
  const recuentoTheirs = useMemo(() => recuento(theirs, idsMios), [theirs, idsMios]);

  const filteredMine = useMemo(
    () => filtrar(mine, qMine, filtros.offer, idsSuyos, offer),
    [mine, qMine, filtros.offer, idsSuyos, offer],
  );
  const filteredTheirs = useMemo(
    () => filtrar(theirs, qTheirs, filtros.request, idsMios, request),
    [theirs, qTheirs, filtros.request, idsMios, request],
  );

  // Cada búsqueda y cada filtro empiezan por su primera tanda: sin esto, filtrar
  // tras haber pedido tres tandas pintaría 180 cartas de golpe.
  const reiniciarTope = (side: Lado) => setTope((cur) => ({ ...cur, [side]: TANDA }));

  const alternarFiltro = (side: Lado, clave: keyof Filtros) => {
    haptic("select");
    setFiltros((cur) => {
      const activo = !cur[side][clave];
      /* «Elegidas» y los otros dos se excluyen. Con «Me faltan» y «Elegidas»
         encendidos a la vez, una carta marcada que no fuera de las que faltan
         no saldría en el repaso, y el repaso mentiría sobre lo que se envía. */
      const next: Filtros = clave === "elegidas"
        ? { faltan: false, repetidas: false, elegidas: activo }
        : { ...cur[side], [clave]: activo, elegidas: false };
      return { ...cur, [side]: next };
    });
    reiniciarTope(side);
  };

  const quitarFiltros = (side: Lado) => {
    setFiltros((cur) => ({ ...cur, [side]: SIN_FILTROS }));
    if (side === "offer") setQMine(""); else setQTheirs("");
    reiniciarTope(side);
  };

  const send = async () => {
    if (!friend || offeredIds.length === 0 || requestedIds.length === 0 || sending) return;
    setSending(true);
    try {
      const res: any = await createTradeOffer(friend.friend_id, offeredIds, requestedIds);
      if (res?.error) { toast(res.error, "error"); return; }
      onSent();
    } catch (e) {
      // Sin red la server action LANZA en vez de devolver {error}: el botón se
      // quedaba en «Enviando…» para siempre y había que cerrar y rehacer la oferta.
      if (!esAccionCaducada(e)) toast("No se pudo enviar la oferta. Revisa la conexión.", "error");
    } finally {
      setSending(false);
    }
  };

  // Render como función (NO como <Column/>) para evitar remontaje y pérdida de foco al filtrar.
  const renderColumn = (side: Lado, nombreAmigo: string) => {
    const esOferta = side === "offer";
    const title = esOferta ? "Ofreces" : "Pides";
    const accent = esOferta ? "var(--ok)" : "var(--warn-ink)";
    const cards = esOferta ? filteredMine : filteredTheirs;
    const hayCartas = (esOferta ? mine : theirs).length > 0;
    const selected = esOferta ? offer : request;
    const delOtro = esOferta ? idsSuyos : idsMios;
    const q = esOferta ? qMine : qTheirs;
    const setQ = esOferta ? setQMine : setQTheirs;
    const f = filtros[side];
    const rec = esOferta ? recuentoMine : recuentoTheirs;
    const copias = esOferta ? offeredIds.length : requestedIds.length;
    const distintas = Object.keys(selected).length;
    const visibles = cards.slice(0, tope[side]);
    const quedan = cards.length - visibles.length;

    // El orden pone primero el filtro que más se usa en cada lado.
    const chips: { clave: keyof Filtros; rotulo: string; n: number }[] = esOferta
      ? [
          { clave: "repetidas", rotulo: "Repetidas", n: rec.repetidas },
          { clave: "faltan", rotulo: "Le faltan", n: rec.faltan },
        ]
      : [
          { clave: "faltan", rotulo: "Me faltan", n: rec.faltan },
          { clave: "repetidas", rotulo: "Le sobran", n: rec.repetidas },
        ];
    // «Elegidas» sólo existe cuando hay algo que repasar (o mientras se está
    // repasando, para poder salir del repaso al quitar la última).
    if (distintas > 0 || f.elegidas) chips.push({ clave: "elegidas", rotulo: "Elegidas", n: distintas });

    return (
      /* EL ALTO BAJA POR UNA CADENA DE COLUMNAS FLEX, SIN FÓRMULAS.
         Antes la rejilla se topaba con un max-height calculado a ojo sobre
         --app-height (el alto menos 260px, partido entre los dos lados), y con
         el teclado abierto ese tope se quedaba en unos 9px. Ahora el panel tiene
         alto definido, el cuerpo se queda lo que sobra entre cabecera y pie, la
         columna lo que sobra bajo el interruptor y la zona de cartas lo que
         sobra bajo el buscador y los filtros. Cada eslabón lleva un mínimo
         EXPLÍCITO (nunca el automático, que en una columna flex vale «todo el
         contenido» y haría crecer esto con las 60 cartas).
         El suelo de 300px (180 con el teclado, que retira interruptor y
         filtros) sólo actúa en pantallas muy bajas —un móvil apaisado—: ahí es
         el cuerpo el que se desplaza, en vez de dejar la rejilla en una rendija. */
      <div
        role="group"
        aria-label={title}
        className={`surface-2 rounded-2xl p-2 md:p-3 flex-col gap-2 flex-1 ${teclado ? "min-h-[180px]" : "min-h-[300px]"} ${lado === side ? "flex" : "hidden md:flex"}`}
      >
        {/* En móvil el título y el recuento ya los lleva el interruptor de arriba. */}
        <div className="hidden md:flex items-center justify-between px-1 shrink-0">
          <h4 className="t-etiqueta ink-soft">{title}</h4>
          {/* `accent` es un color CSS del tema (--ok / --warn-ink), no una clase.
              Ni la clase de acento de la casa ni el cian de la paleta de Tailwind
              valían: daban 2,4:1 y 2,1:1 sobre el papel del tema claro.
              (El nombre del cian no se escribe aquí a propósito: Tailwind 4
              escanea estos ficheros como texto plano, comentarios incluidos, y
              emitiría la clase de verdad. Lo explica SidebarExtras.tsx.) */}
          <span className="t-micro font-bold tnum" style={{ color: accent }}>{copias}</span>
        </div>
        {/* El buscador común en vez de un <input> suelto: trae el aspa para
            limpiar, no deja que iOS «corrija» los nombres y con Intro retira el
            teclado, que aquí es lo que devuelve a la vista el resto del panel. */}
        <CampoBusqueda
          className="shrink-0"
          valor={q}
          onCambio={(v) => { setQ(v); reiniciarTope(side); }}
          etiqueta={esOferta ? "Buscar entre tus cartas" : `Buscar entre las cartas de ${nombreAmigo}`}
          marcador={esOferta ? "Buscar en tus cartas…" : `Buscar en las de ${nombreAmigo}…`}
        />
        {/* Con el teclado abierto, en un móvil quedan unos 300px entre la cabecera
            y el pie: los filtros se retiran mientras se escribe para que debajo
            del buscador quepa una fila entera de cartas. Vuelven al cerrarlo.
            La fila se desplaza de lado en vez de partirse en dos: a 320px los
            tres chips no caben y una segunda línea se comería media fila de
            cartas. El relleno inferior es el hueco para los 2px que baja un
            chip al pulsarlo; sin él asomaría un scroll vertical mientras dura. */}
        {hayCartas && (
          <div className={`scroll-x flex gap-1.5 shrink-0 pb-0.5 ${teclado ? "max-md:hidden" : ""}`}>
            {chips.map((ch) => {
              const activo = f[ch.clave];
              return (
                <button
                  key={ch.clave}
                  type="button"
                  aria-pressed={activo}
                  // Un filtro a cero sólo puede dejar la rejilla vacía; apagado
                  // no se ofrece, pero encendido tiene que poder quitarse.
                  disabled={ch.n === 0 && !activo}
                  onClick={() => alternarFiltro(side, ch.clave)}
                  /* Lo activo se dice como en el interruptor y en la barra de
                     pestañas: tinte de acento. Los 44px son de alto táctil. */
                  className={`press-flat shrink-0 min-h-11 px-3 rounded-full border whitespace-nowrap t-cuerpo-2 font-semibold disabled:opacity-40 disabled:cursor-not-allowed ${
                    activo
                      ? "ink bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] border-[color-mix(in_srgb,var(--accent)_30%,transparent)]"
                      : "chip ink-soft"
                  }`}
                >
                  {ch.rotulo} <span className="tnum font-normal opacity-70">{formatNumber(ch.n)}</span>
                </button>
              );
            })}
          </div>
        )}
        {/* LA ZONA QUE SE DESPLAZA ES ESTE ENVOLTORIO, NO LA REJILLA.
            Era la rejilla la que llevaba el alto (por `flex-1`) y el overflow, y
            ahí estaba el fallo: una rejilla con alto DEFINIDO reparte ese alto
            entre sus filas en vez de desbordar, y como cada celda llevaba
            overflow-hidden su mínimo era cero. Con 24 cartas en un iPhone cada
            una medía 98x19px —tiras— y no había nada que desplazar. Aquí la
            rejilla tiene alto automático (crece lo que pidan sus filas) y es el
            padre el que recorta y se desplaza. */}
        <div
          className="scroll-area custom-scrollbar flex-1 min-h-0 p-0.5 md:pr-1.5"
          data-lenis-prevent
        >
          {cards.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-3 py-8 text-center">
              <p className="t-cuerpo-2 ink-faint">
                {!hayCartas
                  ? (esOferta
                    ? "No tienes cartas que puedas intercambiar."
                    : `${nombreAmigo} no tiene cartas que pueda intercambiar.`)
                  : f.elegidas && distintas === 0
                    ? "Todavía no has elegido ninguna."
                    : "Ninguna carta encaja con lo que buscas."}
              </p>
              {hayCartas && (
                <button
                  type="button"
                  onClick={() => quitarFiltros(side)}
                  className="btn-ghost press-flat control-44 px-4 rounded-xl t-cuerpo-2 font-semibold"
                >
                  Ver todas
                </button>
              )}
            </div>
          ) : (
            <>
              {/* En el tramo de tableta las dos columnas van en paralelo y cada
                  una mide unos 310px: cuatro cartas por fila salían de 72px. */}
              <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-3 lg:grid-cols-4 gap-2 auto-rows-max content-start">
                {visibles.map((c) => {
                  const sel = selected[c.id] || 0;
                  const falta = !delOtro.has(c.id);
                  return (
                    // `press-flat` y no `press`: el botón es ancestro de la carta y
                    // `.press` escala, que la rasteriza y la deja borrosa en iPhone.
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggle(side, c)}
                      aria-pressed={sel > 0}
                      aria-label={`${c.name}${falta ? (esOferta ? ", le falta" : ", no la tienes") : ""}${c.quantity > 1 ? `, ${c.quantity} copias` : ""}${sel > 0 ? `, ${sel} en la oferta` : ""}`}
                      className={`relative block w-full rounded-lg border-2 transition press-flat ${sel > 0 ? "border-[var(--accent)] ring-accent" : "border-transparent hover:border-[var(--border-strong)]"}`}
                      title={c.name}
                    >
                      {/* EL HUECO DE LA CARTA SE RESERVA ANTES DE QUE LLEGUE.
                          La imagen iba con alto automático y sin proporción:
                          hasta cargar, cada celda medía lo que su borde, la
                          rejilla entera cabía en pantalla y el lazy-load pedía
                          decenas de miniaturas de golpe; al llegar, todo saltaba
                          bajo el dedo. Con la caja en proporción de carta (5:7)
                          cada celda mide lo mismo con imagen que sin ella, y
                          sólo se piden las que de verdad están a la vista.
                          El recorte redondeado va en esta caja y no en el botón:
                          así el botón conserva su mínimo de contenido. */}
                      <span className="block aspect-[5/7] overflow-hidden rounded-[6px] bg-[color-mix(in_srgb,var(--ink)_7%,transparent)]">
                        {c.images?.small ? (
                          <img
                            src={c.images.small}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            draggable={false}
                            className="block h-full w-full object-cover"
                          />
                        ) : (
                          // Sin ilustración el botón se quedaba en un cuadro
                          // vacío de 4px: al menos que diga qué carta es.
                          <span className="flex h-full items-center justify-center p-1 text-center t-micro ink-soft">{c.name}</span>
                        )}
                      </span>
                      {/* El contador va OPACO sobre la ilustración: llevaba un
                          backdrop-blur, y un backdrop-filter encima de la carta obliga
                          a leerla y desenfocarla en cada fotograma. Un relleno de
                          papel se lee igual y no cuesta nada. */}
                      {c.quantity > 1 && (
                        <span
                          className="absolute top-1 left-1 chip t-micro px-1.5 py-0.5 font-bold"
                          style={{ background: "var(--surface)" }}
                        >×{c.quantity}</span>
                      )}
                      {sel > 0 && (
                        <span className="absolute top-1 right-1 w-5 h-5 rounded-full btn-accent t-micro font-bold flex items-center justify-center">
                          {sel}
                        </span>
                      )}
                      {/* La marca de «no está en la otra colección». Con el
                          filtro encendido sobra: TODAS las que se ven lo son, y
                          sesenta etiquetas iguales no distinguen nada. Opaca y
                          sin filtros, por lo mismo que el contador de arriba. */}
                      {falta && !f.faltan && (
                        <span
                          className="absolute bottom-1 left-1 chip t-micro px-1.5 py-0.5 font-bold"
                          style={{ background: "var(--surface)", color: "var(--ok)" }}
                        >{esOferta ? "Le falta" : "Nueva"}</span>
                      )}
                    </button>
                  );
                })}
              </div>
              {quedan > 0 && (
                <button
                  type="button"
                  onClick={() => setTope((cur) => ({ ...cur, [side]: cur[side] + TANDA }))}
                  className="btn-ghost press-flat control-44 mt-2 w-full rounded-xl t-cuerpo-2 font-semibold"
                >
                  Ver más · quedan <span className="tnum ml-1">{formatNumber(quedan)}</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <Portal>
    <AnimatePresence>
      {friend && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          /* Los rellenos laterales son las zonas seguras: con el iPhone
             apaisado la isla queda a un lado y el panel se metía debajo. En
             vertical valen cero. */
          className="fixed inset-x-0 top-0 z-[100] flex items-end md:items-center justify-center pl-[var(--sal)] pr-[var(--sar)] md:p-6 md:pl-[max(1.5rem,var(--sal))] md:pr-[max(1.5rem,var(--sar))]"
          // En iOS el viewport de layout no encoge con el teclado: sin esto el panel
          // quedaría debajo de él.
          style={{ bottom: "var(--keyboard)" }}
          onClick={onClose}
        >
          {/* El telón con el desenfoque es HERMANO del panel y no este
              contenedor: dentro se pintan dos rejillas de cartas, y un
              backdrop-filter en un ancestro las rasteriza (borrosas en
              iPhone). Mismo --scrim que Sheet y que la ficha de carta. */}
          <div
            aria-hidden="true"
            className="absolute inset-0 backdrop-blur-md"
            // `touch-action: none`, como el telón de Sheet: un arrastre que
            // empieza en el telón no tiene nada que desplazar.
            style={{ background: "var(--scrim)", touchAction: "none" }}
          />
          {/* Entra con opacidad y desplazamiento, sin `scale`: el panel es
              ancestro de las cartas y una escala, aunque dure 0,3 s, las
              rasteriza a otro tamaño. `relative` para quedar sobre el telón.

              ALTO FIJO, no un máximo. Con un tope, el panel medía lo que su
              contenido y cambiaba de tamaño al pasar de un lado a otro o al
              filtrar (de 600 cartas a 3), con el pie —y el botón de enviar—
              subiendo y bajando bajo el dedo. Fijo, el pie no se mueve nunca, y
              además es lo que da un alto DEFINIDO a toda la cadena de columnas
              de dentro. --app-height ya descuenta el teclado, así que con él
              abierto el panel encoge por abajo y la cabecera se queda donde
              estaba. El tope del 100% es el cinturón: pase lo que pase con las
              variables, el panel no sale del hueco que hay sobre el teclado. */}
          <motion.div
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ duration: D.base, ease: EASE_OUT }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={`Nuevo intercambio con ${friend.friend_name}`}
            className="relative w-full max-w-4xl bg-[var(--surface)] border border-[var(--border)] rounded-t-3xl md:rounded-3xl shadow-[var(--shadow-lg)] flex flex-col h-[calc(var(--app-height)_-_var(--sat)_-_16px)] md:h-[min(780px,calc(var(--app-height)_-_64px))] max-h-full overflow-hidden"
          >
            {/* Header */}
            <div className="shrink-0 px-5 py-4 border-b border-[var(--border)] flex items-center justify-between">
              <div className="min-w-0">
                <p className="t-etiqueta ink-soft">Nuevo intercambio</p>
                <h3 className="t-titulo font-bold tracking-tight truncate">con {friend.friend_name}</h3>
              </div>
              <button onClick={onClose} aria-label="Cerrar" className="control-44 shrink-0 rounded-xl btn-ghost press">
                <IconoCerrar tam={16} />
              </button>
            </div>

            {loading ? (
              <div role="status" aria-label="Cargando las cartas" className="flex-1 min-h-0 flex items-center justify-center">
                <div className="w-8 h-8 border-2 border-[var(--border)] border-t-[var(--accent)] rounded-full animate-spin" />
              </div>
            ) : (
              /* UN LADO CADA VEZ EN MÓVIL, LOS DOS EN PARALELO DESDE `md`.
                 Apilados, cada lado se quedaba con fila y media de cartas: en un
                 iPhone no hay alto para dos rejillas, dos buscadores y un pie.
                 El interruptor lleva el recuento de cada lado, así que lo que no
                 se ve sigue a la vista como número.
                 El scroll de aquí es el último recurso (pantallas muy bajas, ver
                 el suelo de la columna); en un móvil en vertical no hay nada que
                 desplazar y la única zona que se mueve es la de cartas. */
              <div
                className="scroll-area flex-1 min-h-0 p-2 md:p-4 flex flex-col gap-2 md:grid md:grid-cols-2 md:grid-rows-[minmax(300px,1fr)] md:gap-3"
                data-lenis-prevent
              >
                {/* Se retira mientras se escribe, igual que los filtros: es alto
                    que hace falta para ver lo que la búsqueda va dejando. */}
                <div className={`shrink-0 md:hidden ${teclado ? "hidden" : ""}`}>
                  <Segmentado
                    id="intercambio-lado"
                    etiqueta="Lado del intercambio que se ve"
                    columnas
                    opciones={[
                      { id: "offer", rotulo: "Ofreces", detalle: offeredIds.length },
                      { id: "request", rotulo: "Pides", detalle: requestedIds.length },
                    ]}
                    valor={lado}
                    onCambio={setLado}
                  />
                </div>
                {renderColumn("offer", friend.friend_name)}
                {renderColumn("request", friend.friend_name)}
              </div>
            )}

            {/* Footer. No cede alto: es lo único del panel que tiene que estar
                siempre entero, porque aquí está el botón que cierra el intercambio. */}
            <div
              className="shrink-0 px-4 py-3 border-t border-[var(--border)] flex items-center gap-3"
              // Con el teclado desplegado ya no hay barra de gestos que esquivar.
              style={{ paddingBottom: "max(12px, calc(var(--sab) - var(--keyboard) + 12px))" }}
            >
              <div className="flex-1 min-w-0 t-cuerpo-2 ink-soft tnum">
                <span
                  className="font-semibold"
                  style={{ color: offeredIds.length > MAX_PER_SIDE ? "var(--danger-ink)" : "var(--ok)" }}
                >
                  {offeredIds.length}/{MAX_PER_SIDE}
                </span> ofrecidas ·{" "}
                <span
                  className="font-semibold"
                  style={{ color: requestedIds.length > MAX_PER_SIDE ? "var(--danger-ink)" : "var(--warn-ink)" }}
                >
                  {requestedIds.length}/{MAX_PER_SIDE}
                </span> pedidas
              </div>
              <button
                onClick={send}
                disabled={
                  offeredIds.length === 0 || requestedIds.length === 0 || sending ||
                  offeredIds.length > MAX_PER_SIDE || requestedIds.length > MAX_PER_SIDE
                }
                // `.control-44`: medía 38px y es el botón que cierra un
                // intercambio — el gesto más caro de esta pantalla.
                className="btn-accent press control-44 shrink-0 px-6 rounded-xl t-cuerpo font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {sending ? "Enviando…" : "Enviar oferta"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
    </Portal>
  );
}
