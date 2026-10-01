"use client";

import { useCallback, useEffect, useState, useMemo, useRef } from "react";
import { useUser } from "@clerk/nextjs";
import { AnimatePresence, motion } from "framer-motion";
import {
  getFullCollection,
  sellCardAction,
  toggleFavorite,
  sellAllDuplicatesAction,
  sellAllDuplicatesBulkAction,
  nombresDeCartas,
} from "../action";
// El catálogo de expansiones, pedido una vez por sesión de navegador y
// compartido entre pantallas (ver utils/catalogoCliente.ts).
import { catalogoDeExpansiones } from "../../utils/catalogoCliente";
import {
  COLLECTION_STORAGE_KEY,
  ajustarCopiasEnLocal,
  getCollection,
  venderCopiasEnLocal,
} from "../../utils/storage";
import { useCurrency } from "../../hooks/useGameCurrency";
import { useHaptics } from "../../hooks/useHaptics";
import { useToast } from "../../components/ui/Toast";
import ConfirmSheet from "../../components/ui/ConfirmSheet";
import Sheet from "../../components/ui/Sheet";
import { copiasLibresDe, rangoParaOrdenar, valorDeVenta } from "../../utils/constanst";
import { cifraCorta, formatNumber } from "../../utils/format";
import { D, EASE_OUT } from "../../utils/motion";
import PokemonCard from "../../components/PokemonCard";
// El estado físico de la copia. Se pinta también en la rejilla: sin esto, una
// carta que en su detalle decía «ESTADO: DAÑADA» salía impecable aquí.
import DesperfectosCarta, {
  estadoDeCopia,
  estiloDescentrado,
} from "../../components/DesperfectosCarta";
import InsigniaNota, { notaDeCarta } from "../../components/vitrina/InsigniaNota";
import PageHeader from "../../components/PageHeader";
import Loader from "../../components/Loader";
import CardDetailModal from "../../components/CardDetailModal";
import CampoBusqueda from "../../components/ui/CampoBusqueda";
import EstadoError from "../../components/ui/EstadoError";
import EstadoVacio from "../../components/ui/EstadoVacio";
import { IconoAvanzar, IconoDesplegar, IconoMoneda, IconoPapelera, IconoVolver } from "../../components/icons";
import Link from "next/link";
import type { CartaEnColeccion, Expansion } from "../../utils/tipos";
import { conteoPorExpansion, progresoPorExpansion } from "../../utils/progresoPorExpansion";
import { useIdentidad } from "../../hooks/useIdentidad";
import SinConexion from "../../components/ui/SinConexion";
import FilaAccesos from "../../components/ui/FilaAccesos";

/**
 * Cartas del invitado con el rótulo y la ilustración del idioma ACTUAL.
 *
 * Su colección vive en localStorage y guarda el nombre y la imagen con los que
 * se abrió el sobre; ese almacén es su partida y no se reescribe. Al cambiar de
 * idioma, entonces, las cartas viejas seguirían con el nombre viejo: aquí se
 * repinta lo guardado pidiendo al servidor sólo el rótulo por id (unos pocos KB
 * y una única petición), sin tocar ni una clave del almacenamiento.
 *
 * Funciona en los dos sentidos: en español el rótulo sale del diccionario (sin
 * consultas), y en inglés del catálogo, que es el único sitio donde está el
 * nombre inglés de una carta que se guardó traducida.
 *
 * VA PARTIDO EN DOS —pedir los rótulos y aplicarlos— desde que la colección
 * del invitado se pinta sin esperar a la red (ver `loadCollection`): si los
 * rótulos llegan tarde hay que ponerlos sobre las cartas que haya EN ESE
 * MOMENTO, no sobre la lista con la que se pidieron, o una venta hecha
 * entretanto volvería atrás al llegar la respuesta.
 */
type Rotulos = Awaited<ReturnType<typeof nombresDeCartas>>;

/** Los rótulos del idioma actual. Nunca lanza: sin cobertura, ninguno. */
async function rotulosEnIdiomaLocal(cartas: CartaEnColeccion[]): Promise<Rotulos> {
  if (cartas.length === 0) return {};
  try {
    return await nombresDeCartas(cartas.map((c) => c.id));
  } catch {
    // Sin cobertura la colección local se pinta igual, con lo que hay guardado.
    return {};
  }
}

/**
 * La lista recién leída de localStorage, conservando de lo ya pintado lo que
 * el almacén no trae: el nombre y la ilustración en el idioma actual. De la
 * lectura nueva sólo se toman las cantidades y las cartas que no estaban.
 */
function conLoPintado(pintadas: CartaEnColeccion[], frescas: CartaEnColeccion[]): CartaEnColeccion[] {
  const porId = new Map(pintadas.map((c) => [c.id, c]));
  return frescas.map((f) => {
    const p = porId.get(f.id);
    return p ? { ...p, quantity: f.quantity } : f;
  });
}

function conRotulos(cartas: CartaEnColeccion[], rotulos: Rotulos): CartaEnColeccion[] {
  if (Object.keys(rotulos).length === 0) return cartas;
  return cartas.map((c) => {
    const t = rotulos[c.id];
    // Sin ilustración española (promos, Galerías...) se conserva la guardada.
    return t?.name ? { ...c, name: t.name, images: t.images ?? c.images } : c;
  });
}

/**
 * Cuánto se espera a los rótulos y a las expansiones antes de pintar la
 * colección del invitado con lo que hay guardado. Con red llegan en unas
 * décimas y no se ve el cambio de idioma; sin red la petición falla al
 * instante y ni se espera; el plazo sólo cuenta con cobertura mala, que es
 * cuando una petición ni llega ni falla.
 */
const ESPERA_ROTULOS_MS = 2500;

/**
 * COPIAS QUE SE PUEDEN VENDER POR AQUÍ, que no son todas las que se tienen.
 *
 * Las graduadas siguen contando como copias en propiedad —ocupan su sitio en la
 * curva de precios— pero salen de la colección por otra puerta, la de
 * Graduación («Mis graduadas»): `sellCardAction` y `sellAllDuplicatesAction` descuentan las graduadas
 * antes de decidir, y `sellAllDuplicatesBulkAction` ni siquiera selecciona las
 * cartas cuyo `quantity` no supera `1 + graduadas`.
 *
 * Esta pantalla decidía con `quantity` a secas, y el desajuste lo pagaba el
 * jugador: con 2 copias y 1 graduada la rejilla ofrecía "Vender", el servidor
 * devolvía null y salía «No se pudo vender la carta. Nada ha cambiado.» una y
 * otra vez, sin explicar nunca por qué.
 *
 * `graduadas` viaja con la colección desde `getFullCollection` (LEFT JOIN a
 * graded_cards, sólo las activas) y falta en el modo invitado, donde no hay
 * graduación: ahí el `|| 0` deja el comportamiento de siempre.
 *
 * Y LAS ANUNCIADAS EN EL BAZAR, QUE ES EL MISMO DESAJUSTE OTRA VEZ. El servidor
 * pasó a tratar la copia anunciada como comprometida —no se vende a la tienda
 * mientras su anuncio siga abierto— y esta cuenta se quedó en
 * `quantity - graduadas`: con 2 copias y una anunciada la rejilla enseñaba
 * «Vender +0» (el importe sí era del servidor) y `sellCardAction` devolvía
 * null; la hoja de vaciado anunciaba 6 copias y se vendían 4. `anunciadas`
 * viaja también con la colección, y la resta es `copiasLibresDe`
 * (utils/constanst.ts), la misma para la colección, el detalle y la tienda.
 *
 * Fuera del componente porque es pura y la lee un `useMemo`: dentro habría que
 * declararla como dependencia o mentirle al linter de hooks.
 */
function copiasLibres(card: {
  quantity: number;
  graduadas?: number | null;
  anunciadas?: number | null;
}): number {
  return copiasLibresDe(card);
}

/* ==================================================================== *
 * EL DINERO QUE PROMETE ESTA PANTALLA LO CALCULA QUIEN LO PAGA
 * ====================================================================
 *
 * EL FALLO QUE CIERRA ESTO, MEDIDO: aquí se llamaba a `valorDeVenta(rareza,
 * copias, n)` SIN el cuarto argumento —el precio real de Cardmarket—, porque
 * `getFullCollection` no devolvía nada de euros; el servidor sí lo aplica. Con
 * una Hyper Rare y 3 copias: con la carta a 50 € el botón decía 214 y la tienda
 * abonaba 225, y con 200 €, 214 contra 257.
 *
 * AHORA LOS IMPORTES LLEGAN HECHOS, uno por botón, calculados por las mismas
 * funciones que cobran (app/action.ts, `valoresDeVentaDelMonton`). Esta pantalla
 * ya no aplica la curva: la lee. Es lo mismo que hacen la hoja de publicar con
 * la banda del bazar y el botón "Vender por X" de «Mis graduadas».
 *
 * POR QUÉ SIGUE HABIENDO UNA FÓRMULA AQUÍ ABAJO: por el MODO INVITADO, que no
 * tiene servidor. Su colección vive en localStorage, no tiene cartas graduadas y
 * NUNCA tiene precio en euros —ese dato sólo existe en Postgres—, así que para
 * él la cuenta del cliente no es una estimación: es la misma que haría el
 * servidor con los mismos datos, y es exacta. El respaldo cubre también a las
 * cartas que llegan de otras pantallas (álbum, bazar) sin estos campos.
 *
 * SE MIRA `typeof === "number"` Y NO SI ES VERDADERO: 0 es un valor legítimo
 * —significa "no queda nada que vender por esta puerta"— y con un `??` o un `||`
 * caería al respaldo justo donde el servidor está diciendo que no paga nada.
 */
type ValoresDelServidor = {
  valorDeVentaAhora?: number | null;
  valorDeVentaRepetidas?: number | null;
};

const importeDelServidor = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Lo que abona `sellCardAction` por UNA copia sobrante. 0 si se negaría. */
function ventaDeUnaCopia(card: CartaEnColeccion): number {
  const delServidor = importeDelServidor((card as ValoresDelServidor).valorDeVentaAhora);
  if (delServidor !== null) return delServidor;
  // Invitado: la curva sobre el montón entero, vendiendo una sola copia libre.
  return valorDeVenta(card.rarity, card.quantity, Math.min(1, Math.max(0, copiasLibres(card) - 1)));
}

/** Lo que abona `sellAllDuplicatesAction` por TODAS las repetidas libres. */
function ventaDeRepetidas(card: CartaEnColeccion): number {
  const delServidor = importeDelServidor((card as ValoresDelServidor).valorDeVentaRepetidas);
  if (delServidor !== null) return delServidor;
  return valorDeVenta(card.rarity, card.quantity, Math.max(0, copiasLibres(card) - 1));
}

/**
 * La carta tal y como queda cuando se le han vendido TODAS las repetidas: una
 * copia libre más las graduadas y las anunciadas en el bazar, y por tanto nada
 * que vender. Es lo que escribe el servidor (`SET quantity = 1 + graduadas +
 * anunciadas`); con `1 + graduadas` a secas la rejilla pintaba una copia de
 * una carta que en la base seguía teniendo dos.
 *
 * Los dos importes se ponen a 0 y no se recalculan, y eso no es volver a hacer
 * la cuenta del servidor: es la MISMA afirmación que ya hace la línea de al lado
 * al dejar `quantity` en lo comprometido más una. Sin ellos, el botón seguiría
 * prometiendo el importe del montón que acaba de venderse.
 */
function sinRepetidas(card: CartaEnColeccion): CartaEnColeccion & ValoresDelServidor {
  return {
    ...card,
    quantity: 1 + (Number(card.graduadas) || 0) + (Number(card.anunciadas) || 0),
    valorDeVentaAhora: 0,
    valorDeVentaRepetidas: 0,
  };
}

/* ==================================================================== *
 * LA VISTA SE RECUERDA
 * ====================================================================
 *
 * EL FALLO: orden, filtros, búsqueda y página eran `useState` sueltos. Poner
 * "Orden: nombre", filtrar una expansión, ir a la página 3, tocar una
 * expansión del progreso (que lleva a /album/…) y volver devolvía rareza,
 * todas las expansiones y página 1. Lo mismo al pasar por el Mercado. Quien
 * ordena su colección de una manera la quiere así hasta que diga otra cosa.
 *
 * DOS MEMORIAS, PORQUE SON DOS PREGUNTAS:
 *
 *  · `vistaDeSesion`, un objeto de módulo: dura lo que dura la app abierta y
 *    lo guarda TODO, también la búsqueda y la página. Es lo que hace que
 *    volver del álbum deje la rejilla donde estaba. Se usa como valor INICIAL
 *    del estado, y eso no rompe la hidratación: en una carga completa el
 *    módulo acaba de nacer y vale lo mismo que en el servidor, que nunca lo
 *    modifica (sólo se escribe desde efectos).
 *  · localStorage (`tcg:coleccion-vista`): sobrevive a cerrar la app, y por
 *    eso guarda sólo lo que es una PREFERENCIA —orden, los dos filtros y si el
 *    progreso está desplegado—. La búsqueda y la página no: abrir la app al
 *    día siguiente en la página 3 de "pika" sería encontrarse la colección
 *    recortada sin haber hecho nada. Se lee en un efecto, como
 *    CLAVE_SERIES_ABIERTAS en la portada.
 */
const ORDENES = ["rarity_desc", "quantity_desc", "name_asc"] as const;
const CLAVE_VISTA = "tcg:coleccion-vista";

/** La vista con la que nace la pantalla, y a la que vuelve si cambia quién juega. */
const VISTA_POR_DEFECTO = {
  sortBy: "rarity_desc" as string,
  filterSet: "all",
  filterRarity: "all",
  showStats: false,
  searchTerm: "",
  page: 1,
};

const vistaDeSesion = {
  /** ¿Se ha leído ya localStorage en esta carga de la app? */
  restaurada: false,
  /**
   * DE QUIÉN es esta vista: el id de la cuenta o "guest", igual que
   * `coleccionDeSesion.de`. null mientras no se sepa quién mira.
   *
   * EL FALLO QUE CIERRA. Al cambiar de identidad el proveedor del saldo borra
   * `tcg:coleccion-vista`, pero este objeto vive en el módulo y no se enteraba:
   * en un teléfono compartido, A buscaba «charizard», cerraba sesión desde el
   * avatar (navegación de cliente, sin recarga) y quien abría Colección
   * después se encontraba la búsqueda y los filtros de A — y el efecto de
   * guardado los volvía a escribir en localStorage, ya a nombre del nuevo.
   */
  de: null as string | null,
  ...VISTA_POR_DEFECTO,
};

/** ¿La vista recordada es de otra identidad que la que mira ahora? */
const vistaEsDeOtro = (clave: string | null): boolean =>
  clave !== null && vistaDeSesion.de !== null && vistaDeSesion.de !== clave;

/**
 * LA ÚLTIMA COLECCIÓN PINTADA, mientras la app esté abierta.
 *
 * EL FALLO QUE CIERRA. Volver a Colección (desde el álbum, desde Mercado, con
 * el gesto de atrás) la remontaba vacía: esqueleto, petición y, un segundo
 * después, las cartas. El navegador restaura el desplazamiento al volver, pero
 * lo hace contra la página que hay EN ESE MOMENTO, y el esqueleto mide menos
 * que la rejilla: medido a 320 px, se salía de la posición 900 y se volvía a la
 * 594. Se recordaban el orden, los filtros y la página, y aun así se perdía el
 * sitio.
 *
 * Con esto la pantalla nace ya pintada con lo último que enseñó, a su altura
 * de verdad, y la carga de siempre corre por detrás y la pone al día (lo que
 * se haya abierto o vendido entre medias entra en cuanto contesta). Es el
 * mismo trato que `vistaDeSesion`: vive en el módulo y sólo se escribe desde
 * efectos, así que en una carga completa vale lo mismo que en el servidor.
 *
 * `de` dice DE QUIÉN es: el id de la cuenta o "guest". Si no coincide con
 * quien mira ahora, no se pinta: la colección de una cuenta no puede asomar,
 * ni un instante, en la sesión de otra.
 */
const coleccionDeSesion: {
  de: string | null;
  cards: CartaEnColeccion[];
  sets: Expansion[];
} = { de: null, cards: [], sets: [] };

/** La preferencia guardada, saneada campo a campo. null si no hay o no vale. */
function leerVistaGuardada() {
  try {
    const crudo = window.localStorage.getItem(CLAVE_VISTA);
    if (!crudo) return null;
    const v = JSON.parse(crudo) as Record<string, unknown> | null;
    if (!v || typeof v !== "object") return null;
    // Acotado en forma y longitud: es un almacenamiento que cualquiera puede
    // editar, y estos valores acaban en un `startsWith` por carta.
    const texto = (x: unknown) =>
      typeof x === "string" && x.length > 0 && x.length <= 80 ? x : "all";
    return {
      sortBy: (ORDENES as readonly string[]).includes(v.sortBy as string)
        ? (v.sortBy as string)
        : "rarity_desc",
      filterSet: texto(v.filterSet),
      filterRarity: texto(v.filterRarity),
      showStats: v.showStats === true,
    };
  } catch {
    return null;
  }
}

export default function CollectionPage() {
  // `useIdentidad` y no `useUser().isLoaded`: sin conexión Clerk no resuelve
  // nunca, y esperarle a secas dejaba «Cargando Colección» girando para siempre
  // con la colección del invitado esperando en localStorage. El hook pone el
  // plazo y, además, distingue al invitado de quien tiene cuenta pero no red
  // (ver utils/identidad.ts).
  const identidad = useIdentidad();
  // Con cuenta CONFIRMADA por Clerk. Es lo que decide si una venta va al
  // servidor o a localStorage, así que no vale un "parece que tiene cuenta".
  const isSignedIn = identidad === "cuenta";
  // De quién es la colección que toca enseñar (ver `coleccionDeSesion`). Al
  // volver a esta pantalla dentro de la app la identidad ya está resuelta en
  // el primer render, así que lo recordado se puede pintar desde el principio.
  const { user } = useUser();
  const claveDeColeccion =
    identidad === "cuenta" ? (user?.id ?? null) : identidad === "invitado" ? "guest" : null;
  const enMemoria = claveDeColeccion !== null && coleccionDeSesion.de === claveDeColeccion;
  // Tipadas: son las dos listas de las que cuelga la pantalla entera.
  const [cards, setCards] = useState<CartaEnColeccion[]>(() =>
    enMemoria ? coleccionDeSesion.cards : [],
  );
  const [dbSets, setDbSets] = useState<Expansion[]>(() =>
    enMemoria ? coleccionDeSesion.sets : [],
  );
  const { coins, addCoins, setCoins } = useCurrency();
  // La vista recordada sólo vale si es de quien mira (ver `vistaDeSesion.de`).
  // Si es de otro, la pantalla nace con la de por defecto y el efecto de más
  // abajo reinicia la memoria.
  const vistaInicial = vistaEsDeOtro(claveDeColeccion) ? VISTA_POR_DEFECTO : vistaDeSesion;
  const [showStats, setShowStats] = useState(vistaInicial.showStats);
  const [loading, setLoading] = useState(() => !enMemoria);
  /** De quién es lo que hay pintado ahora mismo; null si todavía nada. */
  const pintadoDeRef = useRef<string | null>(enMemoria ? claveDeColeccion : null);
  const [loadError, setLoadError] = useState(false);
  const [searchTerm, setSearchTerm] = useState(vistaInicial.searchTerm);
  const [sortBy, setSortBy] = useState(vistaInicial.sortBy);
  const [filterSet, setFilterSet] = useState(vistaInicial.filterSet);
  const [filterRarity, setFilterRarity] = useState(vistaInicial.filterRarity);
  /** La preferencia guardada ya está aplicada: desde aquí se puede escribir. */
  const [vistaLista, setVistaLista] = useState(vistaDeSesion.restaurada);
  /**
   * Los tres desplegables, plegados de salida por debajo de `xl`.
   *
   * Arranca SIEMPRE en false, también en escritorio estrecho: si dependiera del
   * ancho habría que medirlo, y medir durante el render es exactamente lo que
   * revienta la hidratación (el servidor no tiene ventana). Por encima de
   * `xl` el CSS los enseña siempre y este estado deja de pintar nada.
   */
  const [filtrosAbiertos, setFiltrosAbiertos] = useState(false);
  const [selectedCard, setSelectedCard] = useState<CartaEnColeccion | null>(null);
  const [actionCard, setActionCard] = useState<CartaEnColeccion | null>(null);
  const [confirmDuplicates, setConfirmDuplicates] = useState(false);
  const [page, setPage] = useState(vistaInicial.page);
  const PAGE_SIZE = 24;

  // Restaurar la preferencia, UNA vez por carga de la app (las visitas
  // siguientes ya arrancan con `vistaDeSesion`, sin parpadeo).
  //
  // Y OLVIDARLA SI HA CAMBIADO QUIÉN JUEGA. Depende de `claveDeColeccion` para
  // enterarse cuando la identidad se resuelve o cambia: la primera vez que se
  // sabe quién mira, la vista queda a su nombre; si ya era de otro, se vuelve a
  // la de por defecto. En ese caso NO se lee localStorage: el proveedor ya ha
  // borrado la clave o está a punto (su efecto corre después que éste), y lo
  // que quedara ahí sería del anterior.
  useEffect(() => {
    const ajena = vistaEsDeOtro(claveDeColeccion);
    if (claveDeColeccion !== null) vistaDeSesion.de = claveDeColeccion;
    if (ajena) {
      Object.assign(vistaDeSesion, VISTA_POR_DEFECTO, { restaurada: true });
      setSortBy(VISTA_POR_DEFECTO.sortBy);
      setFilterSet(VISTA_POR_DEFECTO.filterSet);
      setFilterRarity(VISTA_POR_DEFECTO.filterRarity);
      setShowStats(VISTA_POR_DEFECTO.showStats);
      setSearchTerm(VISTA_POR_DEFECTO.searchTerm);
      setPage(VISTA_POR_DEFECTO.page);
      setVistaLista(true);
      return;
    }
    if (vistaDeSesion.restaurada) return;
    vistaDeSesion.restaurada = true;
    const guardada = leerVistaGuardada();
    if (guardada) {
      setSortBy(guardada.sortBy);
      setFilterSet(guardada.filterSet);
      setFilterRarity(guardada.filterRarity);
      setShowStats(guardada.showStats);
    }
    setVistaLista(true);
  }, [claveDeColeccion]);

  // Guardar. Espera a `vistaLista`: sin esa guarda, el primer render escribiría
  // los valores por defecto ENCIMA de la preferencia antes de haberla leído.
  useEffect(() => {
    if (!vistaLista) return;
    Object.assign(vistaDeSesion, { sortBy, filterSet, filterRarity, showStats, searchTerm, page });
  }, [vistaLista, sortBy, filterSet, filterRarity, showStats, searchTerm, page]);
  useEffect(() => {
    if (!vistaLista) return;
    try {
      window.localStorage.setItem(
        CLAVE_VISTA,
        JSON.stringify({ sortBy, filterSet, filterRarity, showStats }),
      );
    } catch {
      /* sin almacenamiento la vista dura lo que dure la sesión */
    }
  }, [vistaLista, sortBy, filterSet, filterRarity, showStats]);

  /**
   * Venta en vuelo. `pendingSale` guarda el id de la carta (o "duplicates"
   * para el lote) y sirve para deshabilitar los botones; el ref es el cerrojo
   * real, porque setState no se ve hasta el siguiente render y dos toques
   * seguidos entrarían los dos.
   */
  const [pendingSale, setPendingSale] = useState<string | null>(null);
  const saleLockRef = useRef(false);
  const isSelling = pendingSale !== null;

  /** Toma el cerrojo; devuelve false si ya hay una venta en curso. */
  const beginSale = (key: string) => {
    if (saleLockRef.current) return false;
    saleLockRef.current = true;
    setPendingSale(key);
    return true;
  };
  const endSale = () => {
    saleLockRef.current = false;
    setPendingSale(null);
  };

  /** Mismo cerrojo para el favorito: evita dos peticiones cruzadas. */
  const favLockRef = useRef<Set<string>>(new Set());

  // Estado de la pulsación larga sobre la rejilla. En un ref para no
  // re-renderizar 24 cartas en cada movimiento del dedo.
  const longPressRef = useRef<{ timer: number | null; x: number; y: number; fired: boolean }>({
    timer: null,
    x: 0,
    y: 0,
    fired: false,
  });
  const LONG_PRESS_MS = 450;
  const LONG_PRESS_SLOP = 10;

  const haptic = useHaptics();
  const toast = useToast();

  const rarityOptions = useMemo(() => {
    const set = new Set<string>();
    cards.forEach((c) => c.rarity && set.add(c.rarity));
    return Array.from(set).sort((a, b) => rangoParaOrdenar(b) - rangoParaOrdenar(a));
  }, [cards]);

  /**
   * Carga inicial. Todo va dentro del mismo try: si se cae el transporte de una
   * server action (sin cobertura, 500, despliegue caducado) o el JSON del modo
   * invitado está corrupto, el `finally` apaga el spinner y `loadError` ofrece
   * reintentar, en vez de dejar la pantalla girando o fingir una colección
   * vacía a quien tiene cientos de cartas.
   *
   * EL INVITADO NO DEPENDE DE LA RED PARA VER SUS CARTAS. Antes `getSetsFromDB`
   * iba delante de todo: sin cobertura lanzaba y la pantalla acababa en "No se
   * pudo cargar tu colección" con la colección entera en localStorage. Ahora
   * sus cartas se leen primero y lo que viene del servidor —el nombre en el
   * idioma actual y la lista de expansiones— es un añadido que puede faltar:
   * sin él se pinta lo guardado y el progreso por expansión sale vacío.
   *
   * `cargaRef` numera las cargas: una respuesta que llega cuando ya hay otra
   * carga en marcha (cambio de sesión, reintento) no pinta nada.
   */
  const cargaRef = useRef(0);
  const loadCollection = useCallback(async () => {
    // "resolviendo" deja el esqueleto; "cuenta-sin-conexion" tiene su propia
    // pantalla más abajo y aquí no hay nada que pedir.
    if (identidad !== "cuenta" && identidad !== "invitado") return;
    if (claveDeColeccion === null) return;
    const turno = ++cargaRef.current;
    // Con la colección de ESTA identidad ya en pantalla (la recordada, o la de
    // una carga anterior) no se vuelve al esqueleto: se refresca por detrás.
    const yaPintado = pintadoDeRef.current === claveDeColeccion;
    if (!yaPintado) setLoading(true);
    setLoadError(false);
    try {
      if (identidad === "cuenta") {
        // En paralelo: son dos lecturas independientes y encadenarlas sumaba
        // sus dos esperas. La colección ya viene traducida: la capa de idioma
        // se aplica en el servidor.
        const [sets, coleccion] = await Promise.all([catalogoDeExpansiones(), getFullCollection()]);
        if (turno !== cargaRef.current) return;
        setDbSets(sets);
        setCards(coleccion);
        pintadoDeRef.current = claveDeColeccion;
      } else {
        const locales = getCollection() as CartaEnColeccion[];
        const delServidor = Promise.all([
          rotulosEnIdiomaLocal(locales),
          catalogoDeExpansiones().catch(() => null),
        ]);
        const aTiempo = await Promise.race([
          delServidor,
          new Promise<null>((resolver) => window.setTimeout(() => resolver(null), ESPERA_ROTULOS_MS)),
        ]);
        if (turno !== cargaRef.current) return;
        if (aTiempo) {
          const [rotulos, sets] = aTiempo;
          if (sets) setDbSets(sets);
          setCards(conRotulos(locales, rotulos));
        } else {
          // Venció el plazo: se pinta lo guardado y, si la respuesta acaba
          // llegando, se aplica sobre las cartas que haya entonces.
          setCards(yaPintado ? (prev) => conLoPintado(prev, locales) : locales);
          delServidor.then(([rotulos, sets]) => {
            if (turno !== cargaRef.current) return;
            if (sets) setDbSets(sets);
            setCards((prev) => conRotulos(prev, rotulos));
          });
        }
        pintadoDeRef.current = claveDeColeccion;
      }
    } catch (error) {
      if (turno !== cargaRef.current) return;
      console.error("Error cargando colección:", error);
      // Si ya hay una colección en pantalla, un refresco que falla no la
      // cambia por un error: se queda lo que había, que sigue siendo cierto
      // salvo por lo último que haya pasado en otra pantalla.
      if (!yaPintado) setLoadError(true);
    } finally {
      if (turno === cargaRef.current) setLoading(false);
    }
  }, [identidad, claveDeColeccion]);

  // Se recuerda lo pintado (ver `coleccionDeSesion`): cada carga y cada venta
  // dejan aquí la lista tal como queda, para la próxima vez que se vuelva.
  useEffect(() => {
    if (loading || loadError || claveDeColeccion === null) return;
    if (pintadoDeRef.current !== claveDeColeccion) return;
    coleccionDeSesion.de = claveDeColeccion;
    coleccionDeSesion.cards = cards;
    coleccionDeSesion.sets = dbSets;
  }, [loading, loadError, claveDeColeccion, cards, dbSets]);

  useEffect(() => {
    loadCollection();
  }, [loadCollection]);

  /**
   * LA COLECCIÓN DEL INVITADO PUEDE CAMBIAR DESDE OTRA PESTAÑA.
   *
   * Esta pantalla la lee una vez. Con ella abierta en una pestaña y cinco
   * sobres abiertos en otra, lo pintado se queda viejo, y antes era peor que
   * viejo: cada venta grababa ENTERA la lista de esta pantalla y las cartas de
   * esos cinco sobres desaparecían. Las ventas ya no escriben la lista (ver
   * `venderCopiasEnLocal` en utils/storage.ts), y aquí se cierra la otra mitad:
   * cuando otra pestaña escribe, se releen las cantidades.
   *
   * Sin esqueleto y conservando el rótulo ya traducido de lo que hay pintado:
   * sólo cambian las copias, y lo que sea nuevo entra con el nombre guardado.
   */
  const refrescarDeLocal = useCallback(() => {
    const frescas = getCollection() as CartaEnColeccion[];
    setCards((prev) => conLoPintado(prev, frescas));
  }, []);
  useEffect(() => {
    if (identidad !== "invitado") return;
    // `storage` sólo se dispara en las OTRAS pestañas, que es justo el caso.
    const alEscribirOtra = (e: StorageEvent) => {
      if (e.key === COLLECTION_STORAGE_KEY) refrescarDeLocal();
    };
    window.addEventListener("storage", alEscribirOtra);
    return () => window.removeEventListener("storage", alEscribirOtra);
  }, [identidad, refrescarDeLocal]);

  /**
   * Progreso por expansión.
   *
   * DOS ARREGLOS AQUÍ:
   *
   * 1. EL DENOMINADOR. Era `set.total`, el que declara el set, que viene de la
   *    API y no coincide con las cartas que existen (la ingesta lo documenta y
   *    además es reanudable: un set a medio descargar declara de más). En esas
   *    expansiones el 100% era inalcanzable. Ahora manda `cardsCount`, el
   *    conteo real que devuelve getSetsFromDB; `total` queda de respaldo para
   *    el modo local, donde loadLocalSets no lo trae.
   *
   * 2. LA LISTA. Se mapeaba `dbSets` ENTERO. Con la base sincronizada por el
   *    cron son 171 tarjetas con 171 logos remotos, casi todas a 0%: la sección
   *    que debería decir "cómo voy" se convertía en un catálogo. Ahora sólo
   *    salen las expansiones en las que hay algo, ordenadas por progreso, y el
   *    resto queda tras el botón de "ver todas".
   *
   * `totalInSet` se calcula una vez y lo usan el porcentaje, el "n/N" y las que
   * faltan: antes el rótulo pintaba `set.total` crudo mientras el porcentaje
   * usaba el respaldo `|| 1`, así que un set sin total decía "5/" y un 100%.
   *
   * LA CUENTA VIVE AHORA EN utils/progresoPorExpansion.ts, con estas mismas
   * reglas, para que el álbum de otro entrenador —que tenía su copia, más
   * vieja y sin el primer arreglo— pueda dar el mismo número.
   */
  const setStats = useMemo(() => progresoPorExpansion(cards, dbSets), [cards, dbSets]);

  /** Sólo las expansiones en las que el jugador tiene algo. */
  const setStatsEmpezados = useMemo(
    () => setStats.filter((s) => s.owned > 0),
    [setStats],
  );

  /**
   * EL RECUENTO, ARRIBA Y NO A DOS MIL PÍXELES DE SCROLL.
   *
   * La única cifra que decía cuántas cartas hay vivía en la paginación, o sea
   * al final de la rejilla y sólo si había más de 24 resultados: en un iPhone
   * quedaba a 1.379px por debajo del pliegue. Mientras tanto la cabecera
   * prometía "progreso y estadísticas" y no daba ni un número.
   *
   * Ahora el número lo dice el propio acordeón de progreso, que es donde se
   * viene a mirar "cómo voy", y no cuesta ni un píxel de alto porque ocupa el
   * renglón que ya había ("Ver progreso por expansión"). Sale de `cards`, que
   * es la colección real ya cargada: no hay consulta nueva ni cero inventado.
   */
  const resumenCartas = useMemo(() => {
    let copias = 0;
    for (const c of cards) copias += Math.max(1, Number(c.quantity) || 1);
    return { unicas: cards.length, copias };
  }, [cards]);

  /**
   * Cuántos controles del panel están tocados. Es lo que lleva la insignia del
   * botón de filtros: plegados, hay que poder saber DESDE FUERA que la rejilla
   * está recortada, o el jugador cree que ha perdido cartas.
   */
  const filtrosActivos =
    (filterSet !== "all" ? 1 : 0) +
    (filterRarity !== "all" ? 1 : 0) +
    (sortBy !== "rarity_desc" ? 1 : 0);
  /** El resto sólo se monta si se piden expresamente. */
  const [verTodasLasExpansiones, setVerTodasLasExpansiones] = useState(false);
  const setStatsVisibles = verTodasLasExpansiones ? setStats : setStatsEmpezados;

  /**
   * LAS EXPANSIONES DEL FILTRO: sólo aquellas de las que hay cartas, con su
   * recuento.
   *
   * El desplegable listaba `dbSets` entero —171 con la base sincronizada—
   * aunque el jugador tuviera cartas de seis: en la rueda de iOS, casi todas
   * las opciones llevaban a "Sin resultados". Es lo que ya hace el selector
   * del archivador (components/vitrina/SelectorCarta.tsx), y por el mismo
   * motivo: ofrecer ciento sesenta expansiones vacías no es filtrar.
   *
   * El orden es el de `getSetsFromDB` (lanzamiento descendente). Las cartas
   * cuya expansión no está en la lista —el invitado sin red, que no ha podido
   * pedirla— salen al final con el id por nombre, para que el filtro siga
   * existiendo aunque no sepa cómo se llama.
   */
  const opcionesExpansion = useMemo(() => {
    const conteo = conteoPorExpansion(cards);
    const lista = dbSets
      .filter((s) => conteo.has(s.id))
      .map((s) => ({ id: s.id, nombre: s.name, cartas: conteo.get(s.id) ?? 0 }));
    const conNombre = new Set(lista.map((o) => o.id));
    for (const [id, n] of conteo) {
      if (!conNombre.has(id)) lista.push({ id, nombre: id.toUpperCase(), cartas: n });
    }
    return lista;
  }, [cards, dbSets]);

  /**
   * Un filtro recordado que ya no encaja con nada se suelta solo.
   *
   * Recordar los filtros tiene esta trampa: la preferencia puede venir de otra
   * identidad (se guardó como invitado y ahora hay sesión) o de una colección
   * que ha cambiado, y entonces la rejilla abriría en "Sin resultados" con un
   * filtro que ni siquiera aparece en el desplegable. Sólo se comprueba con la
   * colección ya cargada: antes no se sabe qué hay.
   */
  useEffect(() => {
    if (loading || loadError || !vistaLista) return;
    if (filterSet !== "all" && !cards.some((c) => c.id.startsWith(filterSet + "-"))) {
      setFilterSet("all");
    }
    if (filterRarity !== "all" && !cards.some((c) => c.rarity === filterRarity)) {
      setFilterRarity("all");
    }
  }, [loading, loadError, vistaLista, cards, filterSet, filterRarity]);

  const processedCards = useMemo(() => {
    let result = [...cards];
    if (searchTerm) result = result.filter((c) => c.name.toLowerCase().includes(searchTerm.toLowerCase()));
    // Con el guion: los ids son `set-numero` y sin él "sv8" se llevaría también
    // las de "sv8pt5" (y "swsh1" las de swsh10/11/12).
    if (filterSet !== "all") result = result.filter((c) => c.id.startsWith(filterSet + "-"));
    if (filterRarity !== "all") result = result.filter((c) => c.rarity === filterRarity);

    result.sort((a, b) => {
      if (a.is_favorite && !b.is_favorite) return -1;
      if (!a.is_favorite && b.is_favorite) return 1;
      switch (sortBy) {
        case "name_asc": return a.name.localeCompare(b.name);
        case "quantity_desc": return (b.quantity || 1) - (a.quantity || 1);
        case "rarity_desc": return rangoParaOrdenar(b.rarity) - rangoParaOrdenar(a.rarity);
        default: return 0;
      }
    });
    return result;
  }, [cards, searchTerm, filterSet, filterRarity, sortBy]);

  const totalPages = Math.max(1, Math.ceil(processedCards.length / PAGE_SIZE));
  // El reajuste de `page` vive en un efecto, que corre tras el pintado: sin
  // acotar aquí, escribir en el buscador desde la página 4 deja un frame con la
  // rejilla vacía y "4 / 2" en la paginación.
  const safePage = Math.min(page, totalPages);
  const pagedCards = useMemo(
    () => processedCards.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [processedCards, safePage],
  );

  /* LA VUELTA A LA PÁGINA 1 YA NO ES UN EFECTO. Lo era, con búsqueda, filtros
   * y orden de dependencias, y un efecto así corre también AL MONTAR: recordar
   * la página no servía de nada porque la primera pasada la devolvía a 1 (y la
   * restauración de la preferencia, otra vez). Ahora la reinicia quien cambia
   * la búsqueda, un filtro o el orden —`alCambiarVista`—, que es cuando de
   * verdad la página vieja deja de significar algo. */
  const alCambiarVista = () => setPage(1);
  /** Hay búsqueda o filtro puestos: el vacío de la rejilla ofrece quitarlos. */
  const hayRecorte = searchTerm !== "" || filterSet !== "all" || filterRarity !== "all";
  const quitarRecorte = () => {
    haptic("tap");
    setSearchTerm("");
    setFilterSet("all");
    setFilterRarity("all");
    setPage(1);
  };

  /**
   * Duplicados vendibles (las favoritas quedan protegidas) y su valor.
   *
   * EL TOTAL CUADRA CON `sellAllDuplicatesBulkAction` CARTA A CARTA, y no por
   * casualidad: el filtro es el mismo —`copiasLibres > 1` es `quantity > 1 +
   * graduadas`, que es literalmente la condición del SELECT del servidor, y las
   * favoritas se excluyen en los dos lados— y cada sumando es el importe que ese
   * mismo servidor calculó para esa carta. La suma de los sumandos es la suma
   * que abona el lote.
   *
   * LO QUE NO PUEDE GARANTIZAR NINGÚN NÚMERO DE AQUÍ: que la colección no haya
   * cambiado entre esta pantalla y la sentencia. Si otra pestaña vende o gradúa,
   * el guard de cantidad del servidor deja esa carta fuera del lote, y entonces
   * se cobra MENOS de lo que decía la hoja. Eso ya está dicho en voz alta: el
   * aviso del final compara `res.sold` con `units` y cuenta cuántas cambiaron.
   */
  const duplicateInfo = useMemo(() => {
    // Con las LIBRES: una carta con 3 copias y 2 graduadas no tiene ningún
    // duplicado que vender y el servidor ni la selecciona (su filtro es
    // `quantity > 1 + graduadas`). Contándola, la hoja de confirmación prometía
    // un importe que no llegaba y el aviso del final decía que "cambiaron"
    // cartas que en realidad nunca habían entrado en el lote.
    const list = cards.filter((card) => copiasLibres(card) > 1 && !card.is_favorite);
    let total = 0;
    let units = 0;
    list.forEach((card) => {
      const sobrantes = copiasLibres(card) - 1;
      // No es (copias − 1) × precio: cada copia vale menos que la anterior. El
      // importe lo trae ya hecho la colección (ver `ventaDeRepetidas`).
      total += ventaDeRepetidas(card);
      units += sobrantes;
    });
    return { list, total, units };
  }, [cards]);

  /**
   * Vende una copia suelta. La comparte el botón de la rejilla y la hoja de
   * acciones. La actualización es optimista pero con red: si el servidor
   * rechaza o revienta se devuelven la carta y las monedas.
   * Devuelve las monedas COBRADAS POR EL SERVIDOR, o 0 si la venta no se
   * consolidó (quien avisa al jugador necesita el importe, y tras vender ya no
   * se puede recalcular: la carta tiene una copia menos y la tarifa ha
   * cambiado).
   */
  /* YA NO RECIBE LA RAREZA: el importe no se calcula aquí, se lee de la carta
   * (ver `ventaDeUnaCopia`), y la rareza sólo servía para recalcularlo. */
  const sellOneCopy = async (cardId: string) => {
    const card = cards.find((c) => c.id === cardId);
    // Con las LIBRES y no con las copias: sin una copia sin graduar de sobra,
    // `sellCardAction` devuelve null y lo único que se consigue es el aviso de
    // error. Ver `copiasLibres`.
    if (!card || copiasLibres(card) <= 1) return 0;
    if (!beginSale(cardId)) return 0;

    // Lo que el servidor abonará por la copia más profunda del montón de hoy.
    const price = ventaDeUnaCopia(card);
    haptic("success");
    const updatedCards = cards.map((c) => (c.id === cardId ? { ...c, quantity: c.quantity - 1 } : c));
    setCards(updatedCards);
    setSelectedCard((prev: any) =>
      prev && prev.id === cardId ? { ...prev, quantity: prev.quantity - 1 } : prev,
    );
    addCoins(price);

    try {
      if (isSignedIn) {
        // El precio lo pone el servidor; el cliente adopta el saldo real que
        // devuelve, en vez de fiarse de su propia suma optimista.
        const res = await sellCardAction(cardId);
        if (!res) throw new Error("venta rechazada");
        setCoins(res.coins);
        /* Y LOS IMPORTES DEL MONTÓN QUE QUEDA, que la respuesta trae hechos.
         *
         * Sin esto, el botón se quedaría enseñando el precio del montón de antes
         * de esta venta: la curva SUBE al menguar el montón (la copia que queda
         * es menos profunda), así que el segundo toque prometería de menos. Se
         * adopta el número del servidor en vez de recalcularlo, que es la regla
         * entera de este cambio. */
        const importes: ValoresDelServidor = {
          valorDeVentaAhora: res.valorDeVentaAhora,
          valorDeVentaRepetidas: res.valorDeVentaRepetidas,
        };
        setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, ...importes } : c)));
        setSelectedCard((prev) => (prev && prev.id === cardId ? { ...prev, ...importes } : prev));
        // Se devuelve LO COBRADO, que es lo que va a decir el aviso.
        return res.earned;
      }
      /* INVITADO: se quita UNA copia de lo que hay guardado AHORA, no se graba
       * la lista de esta pantalla. `venderCopiasEnLocal` lee, comprueba y
       * escribe en la misma operación y sólo toca `quantity`: lo que otra
       * pestaña haya añadido se conserva y los nombres traducidos que se ven
       * aquí no pisan los guardados. Devuelve false sin haber escrito nada (la
       * copia ya no está, o el almacenamiento no deja), y entonces el catch de
       * abajo deshace lo optimista. */
      if (!venderCopiasEnLocal(cardId, 1)) throw new Error("venta local rechazada");
      return price;
    } catch {
      // Revertimos por id (no restaurando la instantánea) para no pisar otros
      // cambios que hayan ocurrido mientras tanto, como marcar una favorita.
      setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, quantity: c.quantity + 1 } : c)));
      setSelectedCard((prev: any) =>
        prev && prev.id === cardId ? { ...prev, quantity: prev.quantity + 1 } : prev,
      );
      addCoins(-price);
      // Nada que restaurar en el almacén del invitado: la venta local es de
      // todo o nada y, si falló, no llegó a escribir. Lo que sí puede pasar es
      // que lo pintado estuviera viejo (otra pestaña vendió esa copia).
      if (!isSignedIn) refrescarDeLocal();
      toast("No se pudo vender la carta. Nada ha cambiado.", "error");
      return 0;
    } finally {
      endSale();
    }
  };

  const handleSellCard = async (e: React.MouseEvent, cardId: string) => {
    e.stopPropagation();
    await sellOneCopy(cardId);
  };

  /** Abre la hoja de confirmación (sustituye a confirm()). */
  const requestSellAllDuplicates = () => {
    haptic("tap");
    if (duplicateInfo.list.length === 0) {
      toast("No tienes duplicados (o están protegidos como favoritas).", "info");
      return;
    }
    setConfirmDuplicates(true);
  };

  /**
   * Vacía TODOS los duplicados con UNA sola petición.
   *
   * ANTES: `Promise.all(duplicates.map((c) => sellAllDuplicatesAction(c.id)))`,
   * una server action por carta lanzadas a la vez. Con una expansión completa
   * son cientos de POST simultáneos; el navegador sólo abre seis conexiones por
   * origen y encola el resto, así que la pantalla se quedaba colgada minutos
   * enteros y el saldo iba llegando a trompicones. Ahora es un único `await`
   * contra `sellAllDuplicatesBulkAction`, que vende todo en una sentencia
   * atómica y devuelve cuánto, cuáles y el saldo final.
   *
   * La lista NO se toca hasta que contesta el servidor: sin actualización
   * optimista no hay nada que deshacer si falla, y como el servidor dice
   * EXACTAMENTE qué ids vendió, lo que queda pintado es la verdad (si alguna
   * carta cambió entretanto, sigue con sus copias en vez de aparecer vaciada).
   */
  const handleSellAllDuplicates = async () => {
    const duplicates = duplicateInfo.list;
    if (duplicates.length === 0) return;
    if (!beginSale("duplicates")) return;

    const estimado = duplicateInfo.total;
    const units = duplicateInfo.units;

    try {
      if (!isSignedIn) {
        // Invitado: la colección vive en localStorage y el importe se calcula
        // con la misma función que usaría el servidor. El invitado no tiene
        // graduadas, así que `1 + graduadas` vale 1 aquí; se escribe igual que
        // en la rama con sesión para que las dos digan la misma regla.
        const newCollection = cards.map((card) =>
          copiasLibres(card) > 1 && !card.is_favorite ? sinRepetidas(card) : card,
        );
        /* PRIMERO SE ESCRIBE, Y SÓLO SI SE PUDO SE PINTA Y SE ABONA. Antes iba
         * al revés (pintar, grabar la lista entera, abonar) y un fallo de
         * escritura dejaba la rejilla diciendo "vendido" sin haber vendido. La
         * escritura es de todo o nada sobre lo guardado AHORA: si otra pestaña
         * cambió alguna de estas cartas no se vende ninguna y se relee. */
        const cambios: Record<string, number> = {};
        for (const card of duplicates) cambios[card.id] = -(copiasLibres(card) - 1);
        if (!ajustarCopiasEnLocal(cambios)) {
          refrescarDeLocal();
          toast("No se pudo completar la venta. Nada ha cambiado.", "error");
          return;
        }
        setCards(newCollection);
        addCoins(estimado);
        toast(`+${formatNumber(estimado)} monedas por ${formatNumber(units)} cartas`, "success");
        return;
      }

      const res = await sellAllDuplicatesBulkAction();
      if (!res.success) {
        toast("No se pudo completar la venta. Nada ha cambiado.", "error");
        return;
      }
      if (res.sold === 0) {
        toast("No había duplicados que vender.", "info");
        return;
      }

      // El saldo es el que devuelve el servidor, no una suma optimista.
      setCoins(res.coins);
      const vendidas = new Set(res.ids);
      /* SE QUEDA `1 + graduadas`, NO 1. La sentencia del servidor deja
       * exactamente eso (`SET quantity = 1 + COALESCE(g.n, 0)`), porque las
       * copias graduadas no se venden por esta puerta. Poniendo 1
       * a secas, la rejilla decía "Única" de una carta que seguía teniendo tres
       * copias y el jugador perdía de vista sus graduadas hasta recargar. */
      setCards((prev) => prev.map((c) => (vendidas.has(c.id) ? sinRepetidas(c) : c)));
      setSelectedCard((prev: any) =>
        prev && vendidas.has(prev.id) ? sinRepetidas(prev) : prev,
      );
      haptic("success");

      if (res.sold < units) {
        toast(
          `Vendidas ${formatNumber(res.sold)} cartas por ${formatNumber(res.earned)} monedas · ${formatNumber(units - res.sold)} cambiaron y siguen en el álbum`,
          "info",
        );
      } else {
        toast(`+${formatNumber(res.earned)} monedas por ${formatNumber(res.sold)} cartas`, "success");
      }
    } catch {
      toast("No se pudo completar la venta. Nada ha cambiado.", "error");
    } finally {
      endSale();
    }
  };

  const handleSellAllFromModal = async () => {
    if (!selectedCard) return;
    // Las libres mandan: con 4 copias y 2 graduadas sólo sobra UNA, no tres.
    const libres = copiasLibres(selectedCard);
    if (libres <= 1) return;
    const { id } = selectedCard;
    const prevQuantity = selectedCard.quantity;
    if (!beginSale(id)) return;

    const duplicates = libres - 1;
    /* LO QUE QUEDA NO ES 1: es una copia libre MÁS las graduadas. Es lo que
     * escribe la sentencia del servidor, y poner 1 aquí dejaba la rejilla
     * diciendo "Única" con tres copias en la mano (y el aviso celebrando el
     * importe de tres ventas cuando el servidor sólo había hecho una). */
    const restantes = prevQuantity - duplicates;
    // El importe lo trae hecho la colección: es el que abona
    // `sellAllDuplicatesAction` por estas mismas copias (ver `ventaDeRepetidas`).
    const totalValue = ventaDeRepetidas(selectedCard);
    const updatedCards = cards.map((c) => (c.id === id ? { ...c, quantity: restantes } : c));
    addCoins(totalValue);
    setSelectedCard((prev: any) => (prev && prev.id === id ? { ...prev, quantity: restantes } : prev));
    setCards(updatedCards);

    try {
      if (isSignedIn) {
        const res: any = await sellAllDuplicatesAction(id);
        if (!res?.success) throw new Error(res?.error || "venta rechazada");
        if (typeof res.coins === "number") setCoins(res.coins);
        /* RECONCILIACIÓN CON LO QUE DICE EL SERVIDOR, no con la suposición
         * optimista: `sold` son las copias que de verdad se fueron y `earned` lo
         * que de verdad se abonó. Si el servidor vendió menos de lo previsto, la
         * carta se queda con las copias que le quedan de verdad. */
        const vendidas = Number(res.sold) || 0;
        const quedan = Math.max(1, prevQuantity - vendidas);
        /* Y LOS DOS IMPORTES A CERO. Esta acción es de todo o nada —o vende las
         * `duplicates` que se le pidieron o falla—, así que tras ella el montón
         * es una copia libre más las graduadas: no queda nada que vender por
         * ninguna de las dos puertas, y el 0 es la misma afirmación que el
         * `quedan` de la línea de arriba, no una cuenta de precios. */
        const agotada: ValoresDelServidor = { valorDeVentaAhora: 0, valorDeVentaRepetidas: 0 };
        setCards((prev) =>
          prev.map((c) => (c.id === id ? { ...c, quantity: quedan, ...agotada } : c)),
        );
        setSelectedCard((prev) =>
          prev && prev.id === id ? { ...prev, quantity: quedan, ...agotada } : prev,
        );
        toast(
          `+${formatNumber(Number(res.earned) || 0)} monedas por ${formatNumber(vendidas)} duplicadas`,
          "success",
        );
      } else {
        // Igual que al vender una: se quitan las copias de lo guardado ahora,
        // no se graba la lista de esta pantalla (ver `sellOneCopy`).
        if (!venderCopiasEnLocal(id, duplicates)) throw new Error("venta local rechazada");
        toast(`+${formatNumber(totalValue)} monedas por ${formatNumber(duplicates)} duplicadas`, "success");
      }
    } catch {
      setCards((prev) => prev.map((c) => (c.id === id ? { ...c, quantity: prevQuantity } : c)));
      setSelectedCard((prev: any) =>
        prev && prev.id === id ? { ...prev, quantity: prevQuantity } : prev,
      );
      addCoins(-totalValue);
      if (!isSignedIn) refrescarDeLocal();
      toast("No se pudieron vender las duplicadas. Nada ha cambiado.", "error");
    } finally {
      endSale();
    }
  };

  /**
   * Alterna la FAVORITA (`is_favorite`: corazón, sube arriba, tope de 10 y
   * queda fuera de "Limpiar duplicados"). La comparten el modal y la hoja de
   * acciones. No es la lista de DESEOS, que es otra cosa —cartas que se
   * quieren conseguir, el marcador de la ficha— y no pasa por aquí.
   */
  const applyToggleFavorite = async (cardId: string, current: boolean) => {
    // Sin cerrojo, dos toques seguidos lanzan dos peticiones que se pisan y el
    // corazón acaba en el estado contrario al del servidor.
    if (favLockRef.current.has(cardId)) return;
    favLockRef.current.add(cardId);
    const newStatus = !current;
    haptic("select");
    setSelectedCard((prev: any) => (prev && prev.id === cardId ? { ...prev, is_favorite: newStatus } : prev));
    setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, is_favorite: newStatus } : c)));
    try {
      const res = await toggleFavorite(cardId);
      if (res?.error) {
        // Deshacemos el cambio optimista para no mentir sobre el estado real.
        setSelectedCard((prev: any) => (prev && prev.id === cardId ? { ...prev, is_favorite: !newStatus } : prev));
        setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, is_favorite: !newStatus } : c)));
        toast(res.error, "error");
      }
    } catch {
      setSelectedCard((prev: any) => (prev && prev.id === cardId ? { ...prev, is_favorite: !newStatus } : prev));
      setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, is_favorite: !newStatus } : c)));
      toast("No se pudo actualizar el favorito", "error");
    } finally {
      favLockRef.current.delete(cardId);
    }
  };

  const handleToggleFavInModal = async () => {
    if (!selectedCard) return;
    // !! porque la columna is_favorite admite NULL: el resto del código ya la
    // lee con COALESCE(..., false) y aquí tiene que valer lo mismo.
    await applyToggleFavorite(selectedCard.id, !!selectedCard.is_favorite);
  };

  // ── Pulsación larga en la rejilla ───────────────────────────────────────
  const cancelLongPress = () => {
    const lp = longPressRef.current;
    if (lp.timer != null) {
      window.clearTimeout(lp.timer);
      lp.timer = null;
    }
  };

  const startLongPress = (e: React.PointerEvent, card: CartaEnColeccion) => {
    if (e.button !== 0) return;
    const lp = longPressRef.current;
    cancelLongPress();
    lp.fired = false;
    lp.x = e.clientX;
    lp.y = e.clientY;
    lp.timer = window.setTimeout(() => {
      lp.timer = null;
      lp.fired = true;
      haptic("heavy");
      setActionCard(card);
    }, LONG_PRESS_MS);
  };

  /** Más de 10px de recorrido es un scroll, no una pulsación. */
  const moveLongPress = (e: React.PointerEvent) => {
    const lp = longPressRef.current;
    if (lp.timer == null) return;
    if (Math.abs(e.clientX - lp.x) > LONG_PRESS_SLOP || Math.abs(e.clientY - lp.y) > LONG_PRESS_SLOP) {
      cancelLongPress();
    }
  };

  const openDetail = (card: CartaEnColeccion) => {
    // Tras una pulsación larga el navegador emite un click: lo ignoramos para
    // no abrir el detalle por debajo de la hoja de acciones.
    if (longPressRef.current.fired) {
      longPressRef.current.fired = false;
      return;
    }
    haptic("select");
    openCardDetail(card);
  };

  useEffect(() => () => cancelLongPress(), []);

  /**
   * Recorrido del modal: se congela al abrirlo. Si se leyera de processedCards
   * en vivo, marcar una favorita reordenaría la lista (las favoritas van
   * primero) y el gesto saltaría a una carta cualquiera. Se guardan sólo los
   * ids; la carta se re-lee de la colección viva al navegar.
   */
  const [navIds, setNavIds] = useState<string[]>([]);

  const openCardDetail = (card: CartaEnColeccion) => {
    setNavIds(processedCards.map((c) => c.id));
    setSelectedCard(card);
  };

  const selectedIndex = selectedCard ? navIds.indexOf(selectedCard.id) : -1;

  const goToNavIndex = (i: number) => {
    const id = navIds[i];
    if (!id) return;
    const live = cards.find((c) => c.id === id);
    if (live) setSelectedCard(live);
  };

  // La carta de la hoja de acciones se lee de la colección viva, para que
  // vender o marcar favorita se refleje sin cerrarla.
  const actionCardLive = actionCard
    ? cards.find((c) => c.id === actionCard.id) || actionCard
    : null;

  /**
   * La nota de la carta de la hoja de acciones, si tiene copias graduadas.
   *
   * Se calcula aquí y no dentro del JSX porque la hoja se pinta detrás de una
   * condición y no hay dónde declarar una constante ahí dentro; y se calcula
   * sobre `actionCardLive` —la carta VIVA— para que, si se gradúa o se vende
   * mientras la hoja está abierta, lo que diga sea lo que hay.
   */
  const notaDeAcciones = notaDeCarta(actionCardLive);

  const goToPage = (next: number) => {
    haptic("tap");
    setPage(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // ANTES que el esqueleto, porque `loading` sigue en true (no se ha cargado
  // nada): quien tiene cuenta y no tiene red no ve ni un giro sin fin ni la
  // colección de invitado. Ver utils/identidad.ts.
  if (identidad === "cuenta-sin-conexion") {
    return (
      <div className="w-full">
        <PageHeader title="Mi Colección" />
        <SinConexion detalle="No se ha podido comprobar tu sesión y tu colección está guardada en tu cuenta. Se reintentará en cuanto vuelva la conexión." />
      </div>
    );
  }

  if (loading) return <Loader label="Cargando Colección" />;

  // Sin esto, un fallo de carga se presentaba como "Aún no tienes cartas" y se
  // invitaba a gastar monedas a quien ya tiene la colección llena.
  if (loadError) {
    return (
      <div className="w-full">
        {/* Sin subtítulo, por lo mismo que el de la rama buena (ver la nota
            larga de abajo): prometía "progreso y estadísticas" en una pantalla
            que precisamente no ha podido cargar ninguna de las dos cosas. Aquí
            no se recortaba —esta cabecera no lleva acciones, así que le sobra
            hueco—, pero dejarlo era dejar puesta la trampa para el día que
            alguien le añada un botón. */}
        <PageHeader title="Mi Colección" />
        <EstadoError
          titulo="No se pudo cargar tu colección"
          onReintentar={() => { haptic("tap"); loadCollection(); }}
        />
      </div>
    );
  }

  return (
    <div className="select-none w-full">
      {/* SIN SUBTÍTULO: SE CORTABA, Y ADEMÁS NO DECÍA NADA.
       *
       * "Tus cartas, progreso y estadísticas" mide 199px y el hueco que le deja
       * PageHeader al lado de las tres acciones es de 183px a 375 y de 128px a
       * 320, así que se leía "Tus cartas, progreso y estadís…".
       *
       * (Eran tres acciones cuando se midió; desde que la vitrina y la
       * graduación bajaron a la fila de accesos queda una y el rótulo cabría.
       * Sigue fuera por la razón de abajo, que no era de píxeles.)
       *
       * Acortarlo era posible —"Cartas y progreso" mide 121px y entra en los
       * dos anchos—, así que la razón para quitarlo NO es que no cupiera nada:
       * es que un subtítulo que promete "progreso y estadísticas" y no da
       * ninguna de las dos ocupa un renglón para no decir nada. La versión
       * corta lo empeora: dice todavía menos.
       *
       * Tampoco vale ensanchar el hueco desde aquí: PageHeader lo comparte toda
       * la app —incluida la vitrina, que está congelada— y tocarlo movería
       * pantallas que nadie ha pedido tocar.
       *
       * Así que el rótulo se va y su contenido se muda al renglón del acordeón
       * de progreso, que tiene 227px libres a 375 y 168px a 320 y donde además
       * deja de ser una promesa ("progreso y estadísticas") para ser el dato:
       * cuántas cartas distintas y cuántas copias hay. Cero elementos
       * recortados, y ni un píxel más de cabecera. */}
      <PageHeader
        title="Mi Colección"
        actions={
          <>
          {/* AQUÍ YA NO ESTÁN LAS PUERTAS A LA VITRINA Y A LA GRADUACIÓN.
              Eran dos iconos sin texto —una rejilla y una estrella que se leía
              como "favoritos"— y en un móvil el `title` no existe: dos
              pantallas enteras del juego sólo las encontraba quien tocaba por
              probar. Han bajado a la fila de accesos de debajo de la cabecera
              (FilaAccesos.tsx), con su nombre escrito.
              Siguen sin ir en la barra inferior, y por lo de siempre: cuatro
              pestañas ya la llenan en un móvil estrecho, y las dos cuelgan de
              la colección, cuya pestaña cubre sus rutas (ver
              components/nav-items.tsx).

              ── POR QUÉ EL RÓTULO DE ESTE BOTÓN ENCIENDE EN `lg` Y NO EN `sm` ──
              La barra lateral aparece en `md` (768px) y le quita 240px a la
              cabecera: con el rótulo encendido desde `sm`, entre 768 y ~834 el
              <h1> se leía "Mi C…". Con `lg` vuelve cuando hay sitio, y hasta
              entonces el `title` da la pista a quien llega con ratón. */}
          <button
            onClick={requestSellAllDuplicates}
            disabled={isSelling}
            aria-busy={pendingSale === "duplicates"}
            // En móvil el texto va oculto con `hidden` (display:none), que lo
            // saca del árbol de accesibilidad: sin esta etiqueta el botón
            // quedaría sin nombre para un lector de pantalla.
            aria-label={
              pendingSale === "duplicates"
                ? "Vendiendo duplicados"
                : duplicateInfo.units > 0
                  ? `Limpiar duplicados: ${formatNumber(duplicateInfo.units)} repetidas por ${formatNumber(duplicateInfo.total)} monedas`
                  : "Limpiar duplicados"
            }
            title={pendingSale === "duplicates" ? "Vendiendo duplicados" : "Limpiar duplicados"}
            className="flex items-center gap-2 chip ink-soft hover:ink px-3 py-2 rounded-xl t-cuerpo-2 font-medium transition press touch-target justify-center disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {/* El vaciado es una sola petición, pero puede tardar un segundo
                largo con una colección enorme: sin un "Vendiendo…" visible el
                jugador vuelve a pulsar creyendo que no ha pasado nada. */}
            {pendingSale === "duplicates" ? (
              <span className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
            ) : (
              <IconoPapelera tam={16} />
            )}
            {/* LO QUE DAN LAS REPETIDAS, A LA VISTA. En móvil el botón era una
                papelera sin texto: no decía ni que hubiera repetidas ni cuánto
                valían, y eso sólo se descubría dentro de la hoja de confirmar.
                Es justo el dato que busca quien se ha quedado sin monedas en
                la tienda. La cifra es la misma que enseña esa hoja
                (`duplicateInfo`), abreviada para no quitarle sitio al título:
                a 320 px la cabecera no admite más que el icono y un número. */}
            {duplicateInfo.units > 0 && pendingSale !== "duplicates" && (
              <span className="tnum lg:hidden">+{cifraCorta(duplicateInfo.total)}</span>
            )}
            <span className="hidden lg:inline">
              {pendingSale === "duplicates"
                ? "Vendiendo…"
                : duplicateInfo.units > 0
                  ? `Limpiar duplicados · +${formatNumber(duplicateInfo.total)}`
                  : "Limpiar duplicados"}
            </span>
          </button>
          </>
        }
      />

      {/* El margen negativo recoge parte del `mb-6` de la cabecera: la fila es
          su segundo renglón, no un bloque aparte, y cada píxel de alto que
          gaste aquí lo paga la primera fila de cartas. */}
      <FilaAccesos grupo="coleccion" className="-mt-2 mb-4 md:-mt-3 md:mb-6" />

      <div className="w-full flex flex-col gap-6">
        {/* PROGRESS PANEL */}
        <div>
          <button
            onClick={() => { haptic("tap"); setShowStats(!showStats); }}
            aria-expanded={showStats}
            // El relleno se aprieta sólo en móvil: en escritorio no sobra
            // pantalla que recuperar y el bloque ya estaba bien proporcionado.
            className="w-full surface surface-hover rounded-2xl px-4 py-3 sm:px-5 sm:py-4 flex justify-between items-center group"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl surface-2 flex items-center justify-center shrink-0">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="w-5 h-5 accent">
                  <path d="M3 3v18h18" />
                  <path d="M7 14l4-4 4 4 6-6" />
                </svg>
              </div>
              <div className="text-left min-w-0">
                <h3 className="font-semibold t-cuerpo">Progreso de colección</h3>
                {/* El renglón que antes decía "Ver progreso por expansión" (una
                    instrucción que el chevrón ya da) ahora dice el recuento. Es
                    el hueco donde se ha mudado el subtítulo de la cabecera. */}
                <p className="t-cuerpo-2 ink-soft tnum">
                  {resumenCartas.unicas === 0
                    ? "Aún no tienes cartas"
                    : `${formatNumber(resumenCartas.unicas)} cartas · ${formatNumber(resumenCartas.copias)} copias`}
                </p>
              </div>
            </div>
            {/* El giro va en un envoltorio y no en el propio SVG: el dibujo
                sale del vocabulario común (components/icons.tsx) y aquí sólo
                queda lo que es de esta pantalla, que es el que gire. */}
            <motion.span
              animate={{ rotate: showStats ? 180 : 0 }}
              className="ink-soft flex shrink-0"
              aria-hidden="true"
            >
              <IconoDesplegar tam={16} />
            </motion.span>
          </button>

          <AnimatePresence>
            {showStats && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: D.slow, ease: EASE_OUT }}
                className="overflow-hidden"
              >
                {setStatsVisibles.length === 0 ? (
                  /* Dos vacíos distintos. Con cartas y sin lista de
                     expansiones —el invitado sin red, que pinta lo guardado sin
                     haber podido pedirla— decir "aún no tienes cartas" sería
                     mentirle con sus cartas a la vista veinte píxeles más
                     abajo. `ink-soft` y no `ink-faint`: es texto de lectura. */
                  <p className="t-cuerpo-2 ink-soft text-center py-8">
                    {cards.length > 0 && dbSets.length === 0
                      ? "No se ha podido cargar la lista de expansiones. Tus cartas están aquí abajo; el progreso volverá con la conexión."
                      : "Aún no tienes cartas de ninguna expansión. Abre un sobre para empezar."}
                  </p>
                ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
                  {setStatsVisibles.map((stat, idx) => (
                    <motion.div
                      key={stat.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      // Con tope, como en el resumen del sobre: sin él, la
                      // expansión número 60 no aparecía hasta los dos segundos.
                      transition={{ delay: Math.min(idx, 12) * 0.03 }}
                    >
                      <Link href={`/album/${stat.id}`} className="block surface surface-hover rounded-2xl p-4 h-full">
                        <div className="flex items-center gap-3 mb-3">
                          {stat.logo && <img src={stat.logo} alt={stat.name} loading="lazy" decoding="async" className="h-7 object-contain opacity-90" />}
                          <div className="flex-1 min-w-0">
                            <h3 className="font-medium t-cuerpo truncate">{stat.name}</h3>
                            <p className="t-micro ink-soft tnum">{stat.owned}/{stat.totalInSet}</p>
                          </div>
                          <span className="t-cuerpo-2 font-semibold ink-soft tnum">{stat.percentage}%</span>
                        </div>
                        <div className="w-full h-1.5 surface-2 rounded-full overflow-hidden">
                          <div
                            className={stat.percentage === 100 ? "progress-bar h-full" : "progress-bar-blue h-full"}
                            style={{ width: `${stat.percentage}%` }}
                          />
                        </div>
                      </Link>
                    </motion.div>
                  ))}
                </div>
                )}

                {/* Las expansiones a cero no entran salvo que se pidan: con la
                    base sincronizada por el cron son más de ciento cincuenta
                    tarjetas con su logo remoto, y la sección dejaba de responder
                    a "cómo voy" para convertirse en un catálogo. */}
                {setStats.length > setStatsEmpezados.length && (
                  <button
                    type="button"
                    onClick={() => setVerTodasLasExpansiones((v) => !v)}
                    className="btn-ghost press touch-target mt-3 w-full rounded-xl t-cuerpo-2 font-medium"
                  >
                    {verTodasLasExpansiones
                      ? "Ver sólo las empezadas"
                      : `Ver las ${formatNumber(setStats.length - setStatsEmpezados.length)} expansiones sin empezar`}
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* TOOLBAR — SE VA CON EL SCROLL. NO ES PEGAJOSA, Y ES A PROPÓSITO.
         *
         * Aquí ha habido dos versiones equivocadas, así que conviene dejarlo
         * escrito para que nadie lo "arregle" otra vez:
         *
         *  1. Era `sticky` y se quedaba clavada bajo la TopBar.
         *  2. Se intentó mejorar ESO —un envoltorio a sangre y opaco, pegado
         *     sin hueco— porque las cartas se veían pasar por detrás.
         *
         * Las dos partían de leer mal lo que se pedía. Lo que molestaba no era
         * CÓMO se pegaba: era que se pegara. En un móvil, la TopBar ya ocupa
         * 64px fijos; sumarle una barra de búsqueda y tres desplegables se come
         * casi un tercio de la pantalla de forma permanente, justo cuando lo
         * que se está haciendo es mirar cartas.
         *
         * Así que la barra vive en el flujo normal: está arriba cuando llegas,
         * y desaparece en cuanto bajas. Para volver a ella se sube, que es
         * exactamente el gesto que ya hace todo el mundo.
         *
         * SI ALGÚN DÍA SE QUIERE RECUPERAR EL ACCESO RÁPIDO sin gastar espacio,
         * la salida NO es volver a `sticky`: es el buscador global que ya
         * existe en la TopBar (la lupa), que busca en todo el catálogo y no
         * ocupa nada.
         *
         * ── LO QUE SÍ SE HA HECHO (y por qué no contradice nada de arriba) ──
         *
         * El problema que quedaba no era el posicionamiento sino el ALTO: este
         * panel medía 174px por debajo de 1280 (buscador + tres desplegables
         * apilados) y empujaba la primera carta hasta y=464 en un iPhone, el
         * 57% del viewport. Los tres desplegables se han plegado tras un botón.
         *
         * La barra sigue EXACTAMENTE donde estaba: en el flujo, sin `sticky` ni
         * `fixed`, y se va con el scroll igual que antes. Plegar cambia cuánto
         * ocupa, no dónde vive; son dos cosas distintas y sólo la segunda es la
         * que se pidió no tocar.
         *
         * EL BUSCADOR NO SE PLIEGA. Es lo que más se usa y se queda siempre
         * visible; lo que se guarda son los filtros, que se tocan una vez y se
         * dejan puestos. Y para que plegarlos no esconda que la rejilla está
         * recortada, el botón lleva la cuenta de los que están activos.
         *
         * A partir de `xl` (1280px, el escritorio del encargo) no se pliega
         * nada: ahí los tres caben en la misma fila que el buscador y el panel
         * mide 70px, que ya estaba bien. El corte es `xl` y no `sm` porque
         * entre 640 y 1280 la fila NO cabía —a 768, con la barra lateral
         * comiendo 240px, el panel seguía midiendo 174px y la primera carta
         * caía en y=476, peor que en el móvil—. */}
        <div
          className="surface rounded-2xl px-3 py-3 flex flex-col xl:flex-row xl:flex-wrap gap-2 xl:items-center"
        >
          {/* El buscador y el botón de filtros comparten renglón: así plegar no
              cuesta ni un píxel de alto (el botón cabe dentro de los 44px que
              ya medía el campo). En `xl` este envoltorio pasa a `contents` y el
              campo vuelve a ser hijo directo del flex, o sea que la fila de
              escritorio queda exactamente como estaba. */}
          <div className="flex items-center gap-2 xl:contents">
          {/* Ésta era la copia más completa de las siete —etiqueta envolvente,
              atributos de teclado completos y aspa de 44px con los márgenes
              negativos que evitan el salto de la barra— y es la que se llevó a
              components/ui/CampoBusqueda. */}
          <CampoBusqueda
            className="flex-1 min-w-0 xl:min-w-[180px]"
            etiqueta="Buscar en tu colección"
            marcador="Buscar..."
            valor={searchTerm}
            onCambio={(v) => { setSearchTerm(v); alCambiarVista(); }}
          />

          {/* EL BOTÓN QUE PLIEGA LOS FILTROS. Sólo existe por debajo de `xl`;
              a partir de ahí los tres desplegables están siempre a la vista y
              este botón sería un rodeo para nada.
              La insignia es lo que impide el fallo clásico de los filtros
              plegables: la rejilla enseña 12 cartas de 214 y no se ve por qué.
              Con la cuenta encima del botón, se ve. */}
          <button
            type="button"
            onClick={() => { haptic("tap"); setFiltrosAbiertos((v) => !v); }}
            aria-expanded={filtrosAbiertos}
            aria-controls="filtros-coleccion"
            aria-label={
              filtrosActivos > 0
                ? `Filtros y orden, ${filtrosActivos} ${filtrosActivos === 1 ? "activo" : "activos"}`
                : "Filtros y orden"
            }
            // El `title` no es un duplicado ocioso del aria-label: este botón
            // existe hasta 1279px, o sea también en un portátil con ratón, y
            // ahí el aria-label no produce ninguna pista al pasar por encima.
            // Sin él, entre 768 y 1279 los tres desplegables desaparecen tras
            // un icono de tres rayas que no dice qué hace hasta que se pulsa.
            title={
              filtrosActivos > 0
                ? `Filtros y orden (${filtrosActivos} ${filtrosActivos === 1 ? "activo" : "activos"})`
                : "Filtros y orden"
            }
            className="btn-ghost press touch-target relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl xl:hidden"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true">
              <path d="M4 6h16M7 12h10M10 18h4" />
            </svg>
            {filtrosActivos > 0 && (
              <span
                aria-hidden="true"
                className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 t-micro font-bold tnum"
                style={{ background: "var(--accent)", color: "#04110c" }}
              >
                {filtrosActivos}
              </span>
            )}
          </button>
          </div>

          {/* LOS TRES DESPLEGABLES.
              Apilados a lo ancho y no en rejilla de dos columnas, y esto arregla
              de paso el problema de que "rareza" y "orden" pareciesen el mismo
              control: iban lado a lado, con el MISMO ancho exacto (155px a 375,
              127px a 320), uno diciendo "Toda rareza" y el otro "Rareza". Lo
              único que los distinguía era el aria-label, que no se ve.
              Ahora van uno debajo de otro, a ancho completo —así ninguno se
              recorta ni siquiera a 320px, donde un "Orden: rar…" habría dejado
              el arreglo a medias— y el de ordenar dice en voz alta lo que hace.
              Como el panel arranca plegado, estos 148px sólo se pagan cuando se
              van a usar.
              En `xl` el envoltorio pasa a `contents` y los tres vuelven a ser
              hijos del flex del panel, con su ancho automático de siempre. */}
          <div
            id="filtros-coleccion"
            className={`grid grid-cols-1 gap-2 xl:contents ${filtrosAbiertos ? "" : "max-xl:hidden"}`}
          >
            <select
              value={filterSet}
              onChange={(e) => { haptic("select"); setFilterSet(e.target.value); alCambiarVista(); }}
              aria-label="Filtrar por expansión"
              // TOPE DE ANCHO EN ESCRITORIO: 320 Y NO 260.
              //
              // Un <select> con ancho automático se estira hasta su opción más
              // larga, y aquí las opciones son nombres de expansión. Sin tope,
              // un nombre desmedido empujaría la fila de cuatro controles a
              // partirse en dos y el panel pasaría de 70px a ~124.
              //
              // Pero el tope estaba en 260 y eso SÍ recortaba algo real: la
              // opción más larga del catálogo ("Scarlet & Violet Black Star
              // Promos") mide 305px, así que al seleccionarla se leía a medias
              // en escritorio, donde antes se leía entera. Y no compraba nada:
              // comprobado en vivo a 1280 quitando el tope, el select sube a
              // 305 y los cuatro controles SIGUEN en la misma fila (los cuatro
              // con top=285, panel 70px). Con el tope en 320 caben los 305 sin
              // recortar y queda el seguro puesto para un nombre más largo.
              //
              // (Y no, este tope no decide ningún punto de ruptura: sólo existe
              // a partir de `xl`, que es justo donde la fila ya cabía. Por
              // debajo los tres desplegables son `w-full` y van apilados.)
              // `min-h-11`: con `py-2.5` y la letra a 16 px (la fuerza
              // globals.css para que iOS no amplíe) el desplegable se quedaba
              // en 42,4 px, por debajo de los 44 del resto de controles.
              className="input-field w-full min-h-11 min-w-0 px-3 py-2.5 rounded-xl t-cuerpo-2 cursor-pointer truncate xl:w-auto xl:max-w-[320px]"
            >
              <option value="all">Todas las expansiones</option>
              {/* Sólo las expansiones con cartas, y cuántas: ver
                  `opcionesExpansion`. */}
              {opcionesExpansion.map((o) => (
                <option key={o.id} value={o.id}>{o.nombre} · {formatNumber(o.cartas)}</option>
              ))}
            </select>
            <select
              value={filterRarity}
              onChange={(e) => { haptic("select"); setFilterRarity(e.target.value); alCambiarVista(); }}
              aria-label="Filtrar por rareza"
              className="input-field w-full min-h-11 min-w-0 px-3 py-2.5 rounded-xl t-cuerpo-2 cursor-pointer truncate xl:w-auto"
            >
              {/* "Todas las rarezas" y no "Toda rareza": el paralelo con "Todas
                  las expansiones" deja claro de un vistazo que este es un filtro
                  y no un criterio de orden. No cuesta ancho, porque el del
                  select lo fija la opción más larga de la lista de rarezas. */}
              <option value="all">Todas las rarezas</option>
              {rarityOptions.map((r) => (<option key={r} value={r}>{r}</option>))}
            </select>
            <select
              value={sortBy}
              onChange={(e) => { haptic("select"); setSortBy(e.target.value); alCambiarVista(); }}
              aria-label="Ordenar por"
              className="input-field w-full min-h-11 min-w-0 px-3 py-2.5 rounded-xl t-cuerpo-2 cursor-pointer truncate xl:w-auto"
            >
              {/* El prefijo "Orden:" va DENTRO de las opciones, no en un rótulo
                  al lado: un <select> nativo no admite nada antes de su texto
                  sin envolverlo, y envolverlo es perder la rueda nativa de iOS.
                  Es el mismo recurso que ya usa ListaGraduables, donde las
                  opciones se describen solas. Así el valor cerrado se lee
                  "Orden: rareza" y deja de ser el gemelo del filtro de al lado.
                  Ojo con alargarlas: los <select> se pintan a 16px (lo fuerza
                  globals.css para que iOS no haga zoom), así que cada palabra
                  aquí cuesta ancho de verdad en la fila de escritorio. */}
              <option value="rarity_desc">Orden: rareza</option>
              <option value="quantity_desc">Orden: cantidad</option>
              <option value="name_asc">Orden: nombre</option>
            </select>
          </div>
        </div>

        {/* GRID */}
        {processedCards.length === 0 ? (
          <EstadoVacio
            titulo={cards.length === 0 ? "Aún no tienes cartas" : "Sin resultados"}
            detalle={
              cards.length === 0
                ? "Abre tu primer sobre para empezar"
                : "Ninguna carta encaja con la búsqueda y los filtros puestos"
            }
            /* El álbum abierto: es el icono de esta pestaña en la barra de
               navegación, así que el vacío enseña el dibujo del sitio en el que
               se está. Sólo sale aquí, por eso se queda escrito aquí. */
            icono={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width={24} height={24} aria-hidden="true">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
            }
            accion={
              cards.length === 0 ? (
                // `.control-44`: medía 40px y es el único camino de salida de
                // una colección vacía, o sea la primera pantalla del juego.
                <Link href="/" className="btn-primary press control-44 t-cuerpo rounded-xl px-5 font-medium">Abrir sobres</Link>
              ) : hayRecorte ? (
                // La salida del "Sin resultados". Desde que la vista se
                // recuerda, se puede LLEGAR a este vacío con un filtro puesto
                // en otra visita y los desplegables plegados: sin un botón
                // aquí habría que adivinar que la rejilla está recortada.
                <button
                  type="button"
                  onClick={quitarRecorte}
                  className="btn-ghost press control-44 t-cuerpo rounded-xl px-5 font-medium"
                >
                  Quitar búsqueda y filtros
                </button>
              ) : undefined
            }
          />
        ) : (
          // 3 columnas en móvil: a 2 las cartas salían enormes y apenas cabían
          // dos filas en pantalla.
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:gap-4 lg:grid-cols-6">
            {pagedCards.map((card) => {
              /* La nota viaja YA con la colección: `getFullCollection` devuelve
               * por carta cuántas copias tiene graduadas y cuál es la mejor
               * nota, así que la insignia no cuesta ni una petición más.
               * Devuelve null cuando no hay ninguna graduada, que es el caso de
               * casi todas las cartas y el del invitado entero (graduar pide
               * cuenta). */
              const graduada = notaDeCarta(card);
              /* Las copias que se pueden vender por aquí. No es `quantity`:
               * las graduadas salen por Graduación y el servidor no las toca.
               * Ver `copiasLibres`. */
              const libres = copiasLibres(card);
              return (
              <div key={card.id} className="relative group">
                {/* LAS DOS CHAPAS SOBRESALEN 4 px POR SU LADO, NO 8. En móvil
                    el hueco entre cartas es de 10 px (`gap-2.5`): con 8 por
                    cada lado, la chapa de copias de una carta y el corazón de
                    la siguiente sumaban 16 y se montaban una sobre otra en la
                    rejilla de tres columnas. Es el mismo arreglo que ya lleva
                    el álbum de entrenador. */}
                {card.quantity > 1 && (
                  <div
                    className="absolute -top-2 -right-1 z-30 t-micro font-bold w-6 h-6 flex items-center justify-center rounded-full tnum"
                    style={{
                      background: "var(--ink)",
                      color: "var(--bg)",
                      border: "1px solid var(--border-strong)",
                      boxShadow: "var(--shadow-sm)",
                    }}
                  >
                    {card.quantity}
                  </div>
                )}
                {card.is_favorite && (
                  <div
                    className="absolute -top-2 -left-1 z-30 w-5 h-5 rounded-full flex items-center justify-center"
                    style={{ background: "var(--danger)", color: "#fff", boxShadow: "var(--shadow-sm)" }}
                  >
                    {/* 12px: es el glifo de una insignia de 20, no un icono de
                        control, y comparte esquina con el contador de copias,
                        que también es un glifo pequeño. Misma insignia que la
                        de components/vitrina/FundaCarta.tsx. */}
                    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="w-3 h-3">
                      <path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 5.5 5.5 5.5 0 0 1 21.5 12c-2.5 4.5-9.5 9-9.5 9z" />
                    </svg>
                  </div>
                )}
                {/* ENVOLTORIO SÓLO PARA ANCLAR LA INSIGNIA DE LA NOTA.
                    El contenedor de fuera llega hasta el botón de vender, así
                    que un `bottom-0` colgado de él caería debajo de la carta y
                    no sobre ella. Este div mide exactamente lo que la carta.
                    Es `relative` a secas —sin transform, sin filtro y sin
                    opacidad—: cualquiera de esas tres promocionaría la capa y
                    devolvería la ilustración borrosa en iPhone. */}
                <div className="relative">
                {/* <button> y no un <div tabIndex>: aria-label no se anuncia en
                    un elemento de rol genérico, y así Enter y Espacio abren el
                    detalle por el mismo camino que el toque (que es quien
                    congela navIds), sin duplicar el manejo de teclado. */}
                <button
                  type="button"
                  aria-label={`Ver ${card.name}`}
                  className="block w-full cursor-zoom-in"
                  onClick={() => openDetail(card)}
                  onPointerDown={(e) => startLongPress(e, card)}
                  onPointerMove={moveLongPress}
                  onPointerUp={cancelLongPress}
                  onPointerCancel={cancelLongPress}
                  onContextMenu={(e) => {
                    // Sólo tapamos el menú nativo cuando la pulsación larga es
                    // nuestra; con el ratón el menú del navegador sigue saliendo.
                    const lp = longPressRef.current;
                    if (lp.timer != null || lp.fired) e.preventDefault();
                  }}
                  onKeyDown={(e) => {
                    // Equivalente de teclado a la pulsación larga.
                    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                      e.preventDefault();
                      haptic("heavy");
                      setActionCard(card);
                    }
                  }}
                >
                  {/* EL ESTADO FÍSICO TAMBIÉN AQUÍ.
                   *
                   * Faltaba, y se notaba: una carta que en su detalle decía
                   * «ESTADO: DAÑADA» aparecía impecable en la rejilla. La misma
                   * copia contando dos cosas distintas según dónde la mires es
                   * peor que no enseñar el desgaste en ningún sitio.
                   *
                   * El montaje es el mismo de las otras tres pantallas: marco
                   * con overflow-hidden, la carta desplazada por el descentrado
                   * y las marcas por encima. `estadoDeCopia` devuelve null en el
                   * caso normal, y entonces esto es exactamente el árbol de
                   * antes — la rejilla monta 24 cartas y no puede pagar dos
                   * nodos de más por cada una que está bien. */}
                  <div className="transition transform group-hover:-translate-y-1 duration-[var(--d-base)] pointer-events-none">
                    {(() => {
                      const estado = estadoDeCopia(card);
                      if (!estado) {
                        return <PokemonCard card={card} reveal={true} interactive={false} />;
                      }
                      return (
                        <div className="relative overflow-hidden rounded-[4.5%]">
                          <div style={estiloDescentrado(estado.desperfectos)}>
                            <PokemonCard card={card} reveal={true} interactive={false} />
                          </div>
                          <DesperfectosCarta
                            desperfectos={estado.desperfectos}
                            marcas={estado.marcas}
                          />
                        </div>
                      );
                    })()}
                  </div>
                </button>
                {/* LA NOTA — abajo a la izquierda, la única esquina libre: las
                    copias van arriba a la derecha y la favorita arriba a la
                    izquierda (y en la funda del archivador, igual). Además es
                    la zona de la carta que menos ilustración tapa, porque ahí
                    va el texto impreso.
                    FUERA del <button> a propósito: dentro, su `aria-label`
                    quedaría tapado por el del botón ("Ver Pikachu") y el lector
                    no diría la nota en ninguna parte. */}
                {graduada && (
                  <InsigniaNota
                    nota={graduada.nota}
                    copias={graduada.copias}
                    className="absolute bottom-1.5 left-1.5 z-30"
                  />
                )}
                </div>
                {/* En táctil no hay hover: la acción se muestra siempre en móvil */}
                <div className="mt-2 flex justify-center opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 transition-opacity duration-[var(--d-base)]">
                  {libres > 1 ? (
                    <button
                      onClick={(e) => handleSellCard(e, card.id)}
                      // Deshabilitado mientras hay una venta en vuelo: dos
                      // toques seguidos vendían dos copias con una sola
                      // confirmación del servidor.
                      disabled={isSelling}
                      aria-busy={pendingSale === card.id}
                      /* EL NOMBRE COMPLETO VA AQUÍ porque lo pintado se acorta
                         en los móviles estrechos (ver abajo) y, mientras se
                         vende, es sólo un giro. */
                      aria-label={
                        pendingSale === card.id
                          ? `Vendiendo una copia de ${card.name}`
                          : `Vender una copia de ${card.name} por ${formatNumber(ventaDeUnaCopia(card))} monedas`
                      }
                      /* UNA LÍNEA, SIEMPRE, Y DENTRO DE SU COLUMNA.
                         A 320 px la columna mide 89 px. "Vender +14" partía en
                         dos líneas mientras "Vender +3" cabía en una —botones
                         de distinto alto en la misma fila— y "Vendiendo…"
                         (99 px) se salía por los dos lados. Tres cambios:
                          · `whitespace-nowrap`, y `px-3` en vez de `px-4`;
                          · por debajo de 360 px el rótulo es el importe con la
                            moneda ("+14 ◎"), que cabe hasta con cuatro cifras;
                            de 360 en adelante la columna pasa de 102 px y
                            vuelve la palabra (medido: "Vender +14" son 89 px);
                          · el estado ocupado es un giro y no un texto más
                            largo que el que sustituye.
                         `min-w-11` mantiene los 44 px también con "+3". */
                      className="chip ink t-meta tnum min-h-11 min-w-11 px-3 rounded-full press hover:brightness-110 inline-flex items-center justify-center gap-1 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100"
                    >
                      {pendingSale === card.id ? (
                        <span aria-hidden="true" className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                      ) : (
                        <>
                          <span className="hidden min-[360px]:inline">Vender</span>
                          <span>+{formatNumber(ventaDeUnaCopia(card))}</span>
                          <IconoMoneda className="min-[360px]:hidden" />
                        </>
                      )}
                    </button>
                  ) : (card.anunciadas ?? 0) > 0 ? (
                    /* LA COPIA QUE SOBRA ESTÁ ANUNCIADA EN EL BAZAR, y mientras
                       su anuncio siga abierto no se vende a la tienda: el
                       servidor la cuenta como comprometida. Antes aquí salía
                       "Vender +0" y la venta fallaba sin explicar por qué. Se
                       dice dónde está la copia, que es lo que le falta saber a
                       quien quiera venderla aquí: tiene que retirar el anuncio. */
                    <span
                      className="chip ink-soft t-micro px-2 py-1 rounded-full"
                      title={`${card.quantity} copias · ${card.anunciadas} anunciada${card.anunciadas === 1 ? "" : "s"} en el bazar. Retira el anuncio para venderla aquí.`}
                    >
                      En el bazar
                    </span>
                  ) : (card.graduadas ?? 0) > 0 ? (
                    /* NI "Vender" NI "Única": las dos mentirían. Aquí hay más de
                       una copia —el contador de la esquina lo dice— pero las que
                       sobran están graduadas, y ésas se venden desde Graduación
                       («Mis graduadas»). Antes salía el botón y el servidor
                       contestaba que no. */
                    <span
                      className="chip ink-soft t-micro px-2 py-1 rounded-full"
                      title={`${card.quantity} copias · ${card.graduadas} graduadas`}
                    >
                      Sin repetidas
                    </span>
                  ) : (
                    <span className="chip ink-soft t-micro px-2 py-1 rounded-full">Única</span>
                  )}
                </div>
              </div>
              );
            })}
          </div>
        )}

        {/* PAGINACIÓN */}
        {processedCards.length > PAGE_SIZE && (
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              onClick={() => goToPage(Math.max(1, safePage - 1))}
              disabled={safePage === 1}
              className="btn-ghost press touch-target w-11 h-11 rounded-xl flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label="Anterior"
            >
              <IconoVolver tam={16} />
            </button>
            <span className="chip ink px-4 py-2 t-cuerpo font-medium tnum">
              {safePage} / {totalPages}
              <span className="ink-soft t-cuerpo-2 ml-2">· {formatNumber(processedCards.length)} cartas</span>
            </span>
            <button
              onClick={() => goToPage(Math.min(totalPages, safePage + 1))}
              disabled={safePage === totalPages}
              className="btn-ghost press touch-target w-11 h-11 rounded-xl flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label="Siguiente"
            >
              <IconoAvanzar tam={16} />
            </button>
          </div>
        )}
      </div>

      <ConfirmSheet
        open={confirmDuplicates}
        title="Vender duplicados"
        // El importe se calcula con la misma función que cobra el servidor, y
        // se dice en voz alta por qué no es "repetidas × tarifa": si no, quien
        // haga la multiplicación de cabeza creerá que le han pagado de menos.
        /* Y se dice que las graduadas no entran SÓLO si el jugador tiene
           alguna: es la otra razón por la que el recuento puede salir más bajo
           de lo que el contador de copias hace pensar, y sin decirlo parece que
           el lote se ha dejado cartas. A quien no ha graduado nada no se le
           cuenta una regla que no le afecta. */
        description={`Se venderán ${formatNumber(duplicateInfo.units)} cartas repetidas por ${formatNumber(duplicateInfo.total)} monedas. Cada copia extra de una misma carta vale menos que la anterior. Las favoritas no se tocan.${
          cards.some((c) => (c.graduadas ?? 0) > 0)
            ? " Las copias graduadas tampoco: ésas se venden en Graduación, pestaña «Mis graduadas»."
            : ""
        }${
          /* Y lo mismo con las anunciadas, y sólo a quien tenga alguna: es la
             otra razón por la que el recuento sale más bajo que el contador. */
          cards.some((c) => (c.anunciadas ?? 0) > 0)
            ? " Las anunciadas en el bazar tampoco: para venderlas aquí hay que retirar el anuncio."
            : ""
        }`}
        confirmLabel={`Vender por ${formatNumber(duplicateInfo.total)}`}
        destructive
        onConfirm={handleSellAllDuplicates}
        onClose={() => setConfirmDuplicates(false)}
      />

      {/* ACCIONES RÁPIDAS (pulsación larga sobre una carta) */}
      <Sheet
        open={!!actionCardLive}
        onClose={() => setActionCard(null)}
        label={actionCardLive ? `Acciones para ${actionCardLive.name}` : "Acciones"}
      >
        {actionCardLive && (
          <div className="px-5 pt-1 pb-6">
            <div className="flex items-center gap-3">
              {actionCardLive.images?.small && (
                <img
                  src={actionCardLive.images.small}
                  alt=""
                  className="w-12 rounded-lg shrink-0"
                  style={{ boxShadow: "var(--shadow-sm)" }}
                />
              )}
              <div className="min-w-0">
                <p className="ink font-semibold t-cuerpo truncate">{actionCardLive.name}</p>
                <p className="ink-soft t-meta truncate">
                  {actionCardLive.rarity || "Sin rareza"}
                  {actionCardLive.quantity > 1 ? ` · ${actionCardLive.quantity} copias` : " · copia única"}
                </p>
              </div>
              {/* La nota, también aquí. Va como insignia y NO como un tercer
                  trozo de la línea de rareza: esa línea lleva `truncate`, así
                  que en un móvil estrecho la nota sería justo lo que se
                  recortaría — desaparecería precisamente donde hay menos sitio
                  para verla en la rejilla. */}
              {notaDeAcciones && (
                <InsigniaNota
                  nota={notaDeAcciones.nota}
                  copias={notaDeAcciones.copias}
                  tamano="md"
                  className="ml-auto shrink-0"
                />
              )}
            </div>

            <div className="mt-5 flex flex-col gap-2.5">
              <button
                onClick={() => {
                  haptic("select");
                  setActionCard(null);
                  openCardDetail(actionCardLive);
                }}
                className="btn-ghost press rounded-2xl py-3.5 t-cuerpo font-medium flex items-center justify-center gap-2 touch-target"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="w-4 h-4">
                  <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3M11 8v6M8 11h6" />
                </svg>
                Ver detalle
              </button>

              {/* Con las LIBRES: ofrecer vender una copia que el servidor no
                  puede vender sólo sirve para enseñar un error. */}
              {copiasLibres(actionCardLive) > 1 && (
                <button
                  onClick={async () => {
                    const { id, name } = actionCardLive;
                    setActionCard(null);
                    // Sólo celebramos si el servidor aceptó la venta.
                    const cobrado = await sellOneCopy(id);
                    if (cobrado > 0) toast(`+${formatNumber(cobrado)} monedas por ${name}`, "success");
                  }}
                  disabled={isSelling}
                  className="btn-ghost press rounded-2xl py-3.5 t-cuerpo font-medium flex items-center justify-center gap-2 touch-target disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="w-4 h-4">
                    <circle cx="12" cy="12" r="9" /><path d="M12 7v10M9.5 9.5h4a1.8 1.8 0 0 1 0 3.5h-3a1.8 1.8 0 0 0 0 3.5h4" />
                  </svg>
                  Vender una copia · +{ventaDeUnaCopia(actionCardLive)}
                </button>
              )}

              {copiasLibres(actionCardLive) <= 1 && (actionCardLive.anunciadas ?? 0) > 0 && (
                <p className="t-etiqueta ink-soft text-center px-2">
                  La copia que te sobra está anunciada en el bazar. Retira el anuncio para venderla aquí.
                </p>
              )}

              {/* Favorita sólo con sesión: al invitado la acción le fallaría
                  siempre («No estás logueado»), así que no se le ofrece.

                  SE LLAMA "FAVORITA", que es lo que hace. Decía "Añadir a
                  deseados", pero el botón marca `is_favorite`: sale un corazón,
                  la carta sube arriba y queda fuera de "Limpiar duplicados"; con
                  diez marcadas el aviso hablaba de "favoritos" tras pulsar algo
                  que hablaba de deseados. La lista de deseos es el marcador de
                  la ficha. La línea pequeña dice para qué sirve, que es lo que
                  no se deduce del corazón. */}
              {isSignedIn && (
                <button
                  onClick={() => {
                    const { id, is_favorite } = actionCardLive;
                    setActionCard(null);
                    applyToggleFavorite(id, !!is_favorite);
                  }}
                  className="btn-ghost press rounded-2xl py-3.5 t-cuerpo font-medium flex items-center justify-center gap-2 touch-target"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill={actionCardLive.is_favorite ? "currentColor" : "none"}
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    className="w-4 h-4"
                  >
                    <path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 5.5 5.5 5.5 0 0 1 21.5 12c-2.5 4.5-9.5 9-9.5 9z" />
                  </svg>
                  {actionCardLive.is_favorite ? "Quitar de favoritas" : "Marcar como favorita"}
                </button>
              )}
              {isSignedIn && !actionCardLive.is_favorite && (
                <p className="t-meta ink-soft text-center -mt-1">
                  Las favoritas no se venden al limpiar duplicados (máximo 10).
                </p>
              )}

              <button
                onClick={() => setActionCard(null)}
                className="btn-ghost press rounded-2xl py-3.5 t-cuerpo font-medium ink-soft touch-target"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}
      </Sheet>

      <CardDetailModal
        card={selectedCard}
        onClose={() => setSelectedCard(null)}
        // El favorito vive en el servidor: al invitado (localStorage) le
        // fallaría siempre con «No estás logueado», así que se le oculta el
        // corazón, igual que ya se oculta el botón de deseos del modal.
        onToggleFavorite={isSignedIn ? handleToggleFavInModal : undefined}
        onSellAll={handleSellAllFromModal}
        cards={navIds}
        index={selectedIndex}
        onIndexChange={goToNavIndex}
      />
    </div>
  );
}
