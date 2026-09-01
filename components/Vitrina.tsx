"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import {
  getArchivador,
  getFullCollection,
  getSetsFromDB,
  ponerEnRanura,
  quitarDeRanura,
} from "../app/action";
import { getCollection } from "../utils/storage";
import {
  guardarArchivadorLocal,
  leerArchivadorLocal,
  ponerEnRanuraLocal,
  quitarDeRanuraLocal,
  type FundaLocal,
} from "../utils/archivadorLocal";
import { RARITY_RANK } from "../utils/constanst";
import { formatNumber } from "../utils/format";
import { useHaptics } from "../hooks/useHaptics";
import { useSwipe, touchActionFor } from "../hooks/useSwipe";
import PageHeader from "./PageHeader";
import Loader from "./Loader";
import CardDetailModal from "./CardDetailModal";
import { useToast } from "./ui/Toast";
import LibroArchivador, {
  DURACION_PASE_MS,
  type LibroHandle,
} from "./vitrina/LibroArchivador";
import PaginaArchivador from "./vitrina/PaginaArchivador";
import AnillasArchivador from "./vitrina/AnillasArchivador";
import SelectorCarta from "./vitrina/SelectorCarta";
import AccionesFunda from "./vitrina/AccionesFunda";
import { notaDeCarta, type NotasDeCarta } from "./vitrina/InsigniaNota";
import {
  MAX_HOJAS,
  RANURAS_POR_HOJA,
  claveFunda,
  colocadasPorCarta,
  enOrdenDeLectura,
  fundasDelInvitado,
  fundasDelServidor,
  hojasMontadas,
  huecosDeHoja,
  mapaDeFundas,
  type Destino,
  type FundaVitrina,
} from "./vitrina/modelo";
import type { CartaEnColeccion, Expansion } from "../utils/tipos";

/**
 * LA VITRINA — el archivador que el jugador monta a mano, funda a funda.
 *
 * NACE VACÍO, Y ESO ES EL ENCARGO ENTERO. La versión anterior rellenaba las
 * hojas sola con la colección ordenada por rareza: quien tenía 441 cartas se
 * encontraba 49 hojas que no había montado nadie, y eso no es un archivador
 * sino otra vista de /collection. Ahora la rejilla de nueve sale vacía y cada
 * funda se rellena tocándola y eligiendo una carta. La diferencia no es
 * estética: en un archivador de verdad el sitio de cada carta lo decide su
 * dueño, y ese acto de decidir es la pantalla.
 *
 * De ahí que aquí NO haya filtro por expansión ni orden por rareza (eso vive en
 * el selector, que es donde sirve para encontrar una carta) ni paginación
 * calculada a partir de la colección: las hojas son las que hagan falta para lo
 * que se ha colocado, más una vacía siempre al final (ver `hojasMontadas` en
 * components/vitrina/modelo.ts).
 *
 * ---------------------------------------------------------------------------
 * CUATRO TRAMPAS DEL REPOSITORIO QUE MANDAN SOBRE EL DISEÑO DE ESTA PANTALLA
 *
 * 1. NITIDEZ EN iPHONE. Las cartas se pintan con el camino rápido de
 *    PokemonCard (`interactive={false}` + `reveal`), que evita una capa
 *    compositada por carta. Ese camino se anula desde cualquier ancestro, así
 *    que en TODO el árbol de la vitrina no hay `filter`, `drop-shadow`,
 *    `backdrop-filter`, `mix-blend-mode`, ni un solo `transform` con `scale`.
 *    WebKit rasteriza esa capa a escala fija y la ilustración sale borrosa
 *    (PokemonCard.tsx:140-163 y 255-266).
 *    La perspectiva del pase de página es la ÚNICA excepción, y está acotada:
 *    components/vitrina/LibroArchivador.tsx monta el escenario 3D al empezar el
 *    giro y lo desmonta al acabarlo, así que en reposo —el 99% del tiempo que
 *    se pasa aquí— no queda nada promocionado. Por eso esta pantalla no puede
 *    añadir perspectivas por su cuenta: rompería esa cuenta.
 *
 * 2. EL ESTADO DEL PASE NO SE TOCA A MANO. `hoja` NO se cambia con setHoja
 *    desde un botón: todo pasa por `libroRef.pasar()`, y la hoja se fija sola
 *    en `onCambio`, cuando el giro TERMINA. Cambiarla a mano deja la animación
 *    fuera y la hoja aparece de golpe.
 *
 * 3. EL GESTO DEL BORDE. `components/ui/EdgeBackGesture.tsx` se lleva cualquier
 *    arrastre que empiece a menos de 26px del borde izquierdo cuando la app
 *    está instalada. La solución es geométrica y vive en el lomo: ver la
 *    cabecera de components/vitrina/AnillasArchivador.tsx. Se conserva intacta
 *    —la ventana que escucha el arrastre sigue empezando a la derecha de las
 *    anillas, sobre los ~50px— y además, mientras hay una hoja modal abierta
 *    (selector, menú de funda o detalle) ese oyente se rinde solo, porque
 *    comprueba si existe un `[role="dialog"]` en el DOM.
 *
 * 4. LAS ESCRITURAS SE SERIALIZAN. Colocar y quitar escriben en el servidor (o
 *    en localStorage). Dos toques rápidos cruzarían dos peticiones cuyo orden
 *    de respuesta decide qué acaba en la funda, así que hay un cerrojo de ref
 *    —el patrón `saleLockRef` de app/collection/page.tsx— y no un booleano de
 *    estado: setState no se ve hasta el siguiente render y los dos toques
 *    entrarían igual.
 *
 * ---------------------------------------------------------------------------
 * Y UNA MÁS, DE MAQUETACIÓN: `app/template.tsx` envuelve cada ruta en un
 * `motion.div` CON TRANSFORM, y un ancestro transformado se convierte en el
 * bloque contenedor de sus descendientes `position: fixed`. Aquí no hay
 * ninguna capa a pantalla completa propia justamente por eso; las que aparecen
 * —Sheet y CardDetailModal— ya se cuelgan de <body> con
 * components/ui/Portal.tsx.
 */

/** Tapa del archivador: cartón/piel a partir de los tokens del tema. */
const TAPA: React.CSSProperties = {
  background:
    "var(--grain), linear-gradient(145deg," +
    " color-mix(in srgb, var(--ink) 9%, var(--surface)) 0%," +
    " var(--surface) 38%," +
    " color-mix(in srgb, var(--ink) 6%, var(--surface)) 100%)",
  border: "1px solid var(--border-strong)",
  boxShadow: "var(--shadow-lg)",
};

/** Hojas de debajo. Sólo asoma su canto, que es lo que da grosor al bloque. */
const CANTO: React.CSSProperties = {
  background: "color-mix(in srgb, var(--ink) 8%, var(--surface))",
  border: "1px solid var(--border)",
};

/** Hoja fuera de rango: nueve huecos y ninguna interacción. Ver `renderHoja`. */
const HOJA_FANTASMA: (CartaEnColeccion | null)[] = Array.from(
  { length: RANURAS_POR_HOJA },
  () => null,
);

/**
 * Orden de la colección del invitado: favoritas, rareza y nombre.
 *
 * Es el orden en el que el SELECTOR ofrece las cartas, y por eso importa que
 * sea el mismo que el del usuario con sesión: `getFullCollection` ya devuelve
 * exactamente este orden hecho en SQL, así que esa lista NO se vuelve a
 * ordenar —repetirlo aquí con `localeCompare` cambiaría el desempate por
 * nombre respecto a la colación de Postgres y las cartas bailarían de sitio
 * entre una carga y otra—. Al invitado sí hay que ordenarlo: su colección vive
 * en localStorage en el orden en que fue abriendo sobres.
 */
function ordenarComoElServidor(cartas: CartaEnColeccion[]): CartaEnColeccion[] {
  return [...cartas].sort((a, b) => {
    const favA = a.is_favorite ? 1 : 0;
    const favB = b.is_favorite ? 1 : 0;
    if (favA !== favB) return favB - favA;
    const rangoA = RARITY_RANK[a.rarity] || 0;
    const rangoB = RARITY_RANK[b.rarity] || 0;
    if (rangoA !== rangoB) return rangoB - rangoA;
    return a.name.localeCompare(b.name);
  });
}

/**
 * LA NOTA DE GRADUACIÓN, PEGADA A LAS CARTAS DEL ARCHIVADOR.
 *
 * `getArchivador()` no la trae, y hace bien: esa consulta responde a "qué hay en
 * cada funda" y cruzarle además las copias graduadas sería otro agregado por
 * lectura para un dato que esta pantalla YA TIENE — la colección se carga aquí
 * al lado, en el mismo `Promise.all`, y viene con `graduadas` y `mejor_nota` por
 * carta desde que se pidió que graduar quedara reflejado fuera de /graduacion.
 * Así que el cruce se hace en memoria, con un índice por id, y cuesta un barrido
 * de la colección y otro de las fundas.
 *
 * SE PEGA A LA CARTA Y NO SE GUARDA APARTE porque `FundaCarta` recibe la carta y
 * nada más: un mapa paralelo habría que ir pasándolo por `PaginaArchivador`
 * hasta abajo, y esas dos piezas no tendrían por qué enterarse de que existe la
 * graduación. Los campos van con su nombre de columna (ver `NotasDeCarta`), que
 * es el mismo con el que la colección los pinta, así que abajo se leen con la
 * MISMA función en las dos pantallas y no hay dos formas del mismo dato.
 *
 * `fundasDelServidor` los quitaría —normaliza campo a campo, a propósito—, así
 * que este paso va SIEMPRE DESPUÉS de la normalización, nunca antes.
 */
function conNotas(
  fundas: FundaVitrina[],
  cartas: readonly CartaEnColeccion[],
): FundaVitrina[] {
  const porId = new Map<string, CartaEnColeccion>();
  for (const c of cartas) porId.set(c.id, c);

  return fundas.map((f) => {
    const graduada = notaDeCarta(porId.get(f.carta.id));
    // Sin copias graduadas se devuelve la MISMA funda y no una copia: son
    // casi todas, y clonar 531 objetos para no cambiar nada sería tirar
    // igualdades por referencia que a React le sirven.
    if (!graduada) return f;
    const carta: CartaEnColeccion & NotasDeCarta = {
      ...f.carta,
      graduadas: graduada.copias,
      mejor_nota: graduada.nota,
    };
    return { ...f, carta };
  });
}

/**
 * Qué decirle al jugador cuando `ponerEnRanura` dice que no.
 *
 * Los errores de la acción se traducen uno a uno y no a un "algo ha fallado":
 * `sin-copias-libres` trae los dos números justamente para poder decir "ya
 * tienes tus 2 copias colocadas", que es una frase que explica y no una que
 * culpa. El selector ya evita ese camino, pero dos pestañas abiertas a la vez
 * sí pueden llegar hasta aquí.
 */
function porQueNoSePudo(
  fallo: Awaited<ReturnType<typeof ponerEnRanura>>,
): string {
  if (fallo.ok) return "";
  switch (fallo.error) {
    case "sin-copias-libres":
      return `Ya tienes ${fallo.copias === 1 ? "tu única copia" : `tus ${fallo.copias} copias`} de esa carta en el archivador.`;
    case "no-la-tienes":
      return "Esa carta ya no está en tu colección.";
    case "no-autorizado":
      return "Vuelve a iniciar sesión para tocar tu archivador.";
    case "hoja-invalida":
    case "ranura-invalida":
    case "peticion":
      return "Esa funda no existe en tu archivador.";
    default:
      return "No se pudo colocar la carta. Inténtalo otra vez.";
  }
}

export default function Vitrina() {
  const { isSignedIn, isLoaded } = useUser();
  const haptic = useHaptics();
  const toast = useToast();
  const reducido = useReducedMotion();

  /** La colección: sólo se usa para OFRECER cartas en el selector. */
  const [cartas, setCartas] = useState<CartaEnColeccion[]>([]);
  const [sets, setSets] = useState<Expansion[]>([]);
  /** Las fundas OCUPADAS. Las vacías no existen como dato: ver modelo.ts. */
  const [fundas, setFundas] = useState<FundaVitrina[]>([]);
  const [maxHojas, setMaxHojas] = useState(MAX_HOJAS);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState(false);

  const [hoja, setHoja] = useState(0);
  /** Funda cuyo menú está abierto. */
  const [menu, setMenu] = useState<Destino | null>(null);
  /** Funda que se está rellenando desde el selector. */
  const [eligiendo, setEligiendo] = useState<Destino | null>(null);
  /**
   * Carta abierta en el detalle, por POSICIÓN en el archivador y no por id.
   * La misma carta puede ocupar varias fundas, así que un id no identifica una
   * posición: buscar por id haría que deslizar en el detalle saltara siempre a
   * la primera funda que la tuviera.
   */
  const [detalleIdx, setDetalleIdx] = useState<number | null>(null);

  /* Cerrojo de escritura. El ref es el cerrojo REAL (se lee y se toma en el
   * mismo tick); el estado sólo existe para apagar los botones. Es el patrón de
   * `saleLockRef` en app/collection/page.tsx. */
  const escrituraRef = useRef(false);
  const [guardando, setGuardando] = useState(false);

  const libroRef = useRef<LibroHandle | null>(null);
  /**
   * Pase en curso: hacia dónde gira y en qué hoja hay que acabar.
   *
   * Vive en un REF y no en estado por dos motivos, los dos medidos:
   *  · `renderHoja` lo lee mientras el LIBRO se pinta, y el libro se re-pinta
   *    por su cuenta (su `girando` es estado suyo) sin que esta pantalla vuelva
   *    a renderizar: un valor de estado se quedaría congelado en el closure.
   *  · Con movimiento reducido, `pasar()` llama a `onCambio` en el MISMO tick,
   *    y ahí un setState todavía no se ve.
   */
  const paseRef = useRef<{ dir: 1 | -1; hasta: number } | null>(null);
  /** Espejo del anterior, sólo para deshabilitar los mandos mientras gira. */
  const [pasando, setPasando] = useState(false);

  /* ---------------------------------------------------------------- */
  /* CARGA                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Todo dentro de un try, igual que app/collection/page.tsx y por lo mismo:
   * una server action caída (PWA sin cobertura, 500, despliegue caducado) o un
   * localStorage corrupto tienen que acabar en "reintentar" y no en un
   * archivador en blanco, que aquí sería especialmente cruel — el archivador
   * vacío es un estado LEGÍTIMO, así que un fallo silencioso sería
   * indistinguible de "todavía no has colocado nada".
   */
  const cargar = useCallback(async () => {
    if (!isLoaded) return;
    setCargando(true);
    setErrorCarga(false);
    try {
      const expansiones = await getSetsFromDB();
      setSets(expansiones);

      if (isSignedIn) {
        // En paralelo: son dos lecturas independientes y encadenarlas duplica
        // la espera de la primera pantalla.
        const [coleccion, archivador] = await Promise.all([
          getFullCollection(),
          getArchivador(),
        ]);
        // Ya viene traducida y ordenada desde el servidor.
        setCartas(coleccion);
        if (!archivador.ok) throw new Error(archivador.error);
        setMaxHojas(archivador.maxHojas);
        setFundas(
          conNotas(
            fundasDelServidor(archivador.fundas, archivador.maxHojas),
            coleccion,
          ),
        );
      } else {
        const coleccion = ordenarComoElServidor(getCollection());
        setCartas(coleccion);
        setMaxHojas(MAX_HOJAS);
        // El archivador del invitado guarda sólo ids: el resto se cruza con su
        // colección de localStorage (ver `fundasDelInvitado`).
        //
        // `conNotas` también aquí, aunque HOY sea un no-op —graduar exige
        // cuenta, así que la colección de localStorage nunca trae notas—:
        // la regla de esta pantalla es que las dos rutas produzcan exactamente
        // la misma forma (ver la cabecera de components/vitrina/modelo.ts), y
        // ese es el motivo por el que nada de lo que hay debajo tiene que
        // preguntar si hay sesión.
        setFundas(
          conNotas(
            fundasDelInvitado(leerArchivadorLocal(), coleccion, MAX_HOJAS),
            coleccion,
          ),
        );
      }
    } catch (error) {
      console.error("Error cargando la vitrina:", error);
      setErrorCarga(true);
    } finally {
      setCargando(false);
    }
  }, [isSignedIn, isLoaded]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  /* ---------------------------------------------------------------- */
  /* LO QUE SE DERIVA DE LAS FUNDAS                                    */
  /* ---------------------------------------------------------------- */

  const mapa = useMemo(() => mapaDeFundas(fundas), [fundas]);
  const colocadas = useMemo(() => colocadasPorCarta(fundas), [fundas]);
  const ordenadas = useMemo(() => enOrdenDeLectura(fundas), [fundas]);
  const totalHojas = useMemo(
    () => hojasMontadas(fundas, maxHojas),
    [fundas, maxHojas],
  );

  /**
   * El recorte va aquí y no en un efecto porque un efecto corre DESPUÉS de
   * pintar: al quitar la última carta de la última hoja, quedaría un fotograma
   * con una hoja que ya no existe y el rótulo diciendo "5 de 3".
   */
  const hojaSegura = Math.min(hoja, totalHojas - 1);

  /** Devuelve el estado real al rango cuando el archivador encoge. */
  useEffect(() => {
    setHoja((h) => Math.min(h, totalHojas - 1));
  }, [totalHojas]);

  /* ---------------------------------------------------------------- */
  /* PASE DE PÁGINA                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Ir a una hoja cualquiera CON UN SOLO GIRO.
   *
   * `LibroArchivador.pasar()` sólo sabe moverse una hoja, que es lo que quiere
   * decir girar una página. Para "primera" y "última" se apunta el destino en
   * `paseRef` y se dispara un giro normal; `renderHoja` sustituye entonces la
   * hoja VECINA por la de destino, así que lo que aparece bajo la hoja que gira
   * ya es el sitio al que se va. Encadenar giros de uno en uno era la
   * alternativa y está descartada: sesenta hojas serían medio minuto de
   * animación para llegar al final.
   */
  const irAHoja = useCallback(
    (destino: number) => {
      const libro = libroRef.current;
      if (!libro || libro.girando || paseRef.current) return;
      const limpio = Math.max(0, Math.min(destino, totalHojas - 1));
      if (limpio === hojaSegura) return;
      const dir: 1 | -1 = limpio > hojaSegura ? 1 : -1;
      paseRef.current = { dir, hasta: limpio };
      setPasando(true);
      haptic("tap");
      libro.pasar(dir);
    },
    [hojaSegura, totalHojas, haptic],
  );

  /**
   * Red de seguridad del cerrojo del pase.
   *
   * `LibroArchivador` confirma el giro con un temporizador propio y eso ya es
   * a prueba de pestañas en segundo plano, pero si alguna vez `pasar()` se
   * volviera atrás sin avisar, `paseRef` se quedaría puesto y el archivador
   * entero se volvería intocable. Es el mismo respaldo por reloj que usa
   * PokemonCard para su `settled`: cuesta cuatro líneas y evita una pantalla
   * muerta.
   */
  useEffect(() => {
    if (!pasando) return;
    const t = window.setTimeout(() => {
      paseRef.current = null;
      setPasando(false);
    }, DURACION_PASE_MS + 240);
    return () => window.clearTimeout(t);
  }, [pasando]);

  /* ---------------------------------------------------------------- */
  /* GESTOS                                                            */
  /* ---------------------------------------------------------------- */

  /** Escucha el arrastre. Empieza a la derecha del lomo: ver el punto 3. */
  const ventanaRef = useRef<HTMLDivElement>(null);

  /** Hay una capa modal encima: el archivador de detrás no escucha nada. */
  const hayCapa = menu !== null || eligiendo !== null || detalleIdx !== null;

  /**
   * EL ARRASTRE SÓLO DECIDE LA DIRECCIÓN. `follow: false` a propósito.
   *
   * Antes la hoja acompañaba al dedo con un `translate` y el pase era un
   * desplazamiento lateral, así que seguir el dedo y la animación eran lo
   * mismo. Con el giro 3D ya no: el papel gira sobre el lomo, y arrastrarlo
   * lateralmente mientras tanto son dos movimientos distintos peleándose por el
   * mismo elemento (y encima useSwipe escribe el transform a mano, que es justo
   * lo que LibroArchivador anima). El gesto se queda con lo único que aporta:
   * decir hacia dónde. El giro lo hace el libro entero.
   *
   * Sin manejador en un extremo, useSwipe no dispara nada — y como aquí no hay
   * `follow`, tampoco hay tope elástico que enseñar: el rótulo "Hoja 1 de 3" y
   * los botones apagados son los que dicen dónde acaba el archivador.
   *
   * `enabled` NO mira si se está girando, aunque un arrastre a mitad de giro no
   * deba hacer nada. De eso se encarga `irAHoja`, que se desentiende solo. El
   * motivo es que useSwipe se suscribe y se desuscribe según esta bandera, y
   * apagarla a media animación arrancaría los oyentes por debajo de un gesto
   * que ya está en marcha: el hook limpia el transform al desmontar, pero no
   * el `will-change` que puso al empezar el arrastre — y un `will-change`
   * permanente sobre un ancestro de las cartas es exactamente lo que las deja
   * borrosas en iPhone.
   */
  const arrastroRef = useSwipe(ventanaRef, {
    axis: "x",
    follow: false,
    enabled: !hayCapa,
    onSwipeLeft:
      hojaSegura < totalHojas - 1 ? () => irAHoja(hojaSegura + 1) : undefined,
    onSwipeRight: hojaSegura > 0 ? () => irAHoja(hojaSegura - 1) : undefined,
  });

  /**
   * Teclado. En `window` y no en la vitrina para que funcione sin haber
   * enfocado nada, que es como se usa un archivador con las flechas.
   *
   * Tres exclusiones, y las tres han sido un fallo real en alguna app:
   *  · Campos de texto y desplegables — las flechas son suyas (mover el cursor,
   *    cambiar de opción); robárselas rompería el buscador del selector.
   *  · Modificadores — ⌘←/Alt← es "atrás" del navegador.
   *  · Con un `[role="dialog"]` montado, las flechas pertenecen al diálogo
   *    (CardDetailModal navega entre cartas con ellas, y el selector es una
   *    hoja modal). Es la misma condición que usa EdgeBackGesture para
   *    rendirse, y se comprueba igual.
   */
  useEffect(() => {
    const alPulsar = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const destino = e.target as HTMLElement | null;
      const etiqueta = destino?.tagName;
      if (
        etiqueta === "INPUT" ||
        etiqueta === "SELECT" ||
        etiqueta === "TEXTAREA" ||
        destino?.isContentEditable
      ) {
        return;
      }
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      irAHoja(hojaSegura + (e.key === "ArrowRight" ? 1 : -1));
    };
    window.addEventListener("keydown", alPulsar);
    return () => window.removeEventListener("keydown", alPulsar);
  }, [irAHoja, hojaSegura]);

  /* ---------------------------------------------------------------- */
  /* TOCAR UNA FUNDA                                                   */
  /* ---------------------------------------------------------------- */

  const abrirFunda = useCallback(
    (h: number, r: number) => {
      /**
       * EL ARRASTRE NO ABRE FUNDAS. Las nueve fundas son botones DENTRO de la
       * ventana que escucha el gesto, así que un arrastre para pasar de hoja
       * empieza y acaba encima de una: el navegador emite después su `click`
       * sintético y, sin este guardia, pasar la página abriría además el menú
       * de la funda que quedó bajo el dedo. `useSwipe` marca ese instante
       * durante 120 ms justamente para esto (su `didSwipeRef`), y también
       * cuenta como arrastre cualquier recorrido de más de 24px aunque no
       * llegue a disparar el pase — el dedo que resbala sobre el cristal.
       */
      if (arrastroRef.current) return;
      // Con una escritura en vuelo el contenido de la funda todavía no es
      // firme: abrir su menú enseñaría la carta vieja.
      if (escrituraRef.current) return;
      haptic("select");
      if (mapa.has(claveFunda(h, r))) setMenu({ hoja: h, ranura: r });
      else setEligiendo({ hoja: h, ranura: r });
    },
    [mapa, haptic, arrastroRef],
  );

  /**
   * Pinta una hoja para el libro.
   *
   * Dos avisos que vienen de LibroArchivador y que no se pueden ignorar:
   *  · Se llama con números FUERA DE RANGO durante el giro (hoja−1 o hoja+1),
   *    así que hay que devolver una hoja vacía y no reventar.
   *  · Se llama DOS VECES mientras dura el giro (la hoja que gira y la de
   *    debajo). Por eso, mientras hay pase, NINGUNA de las dos es interactiva:
   *    sin manejador, PaginaArchivador se retira del árbol de accesibilidad y
   *    no se puede colocar una carta en una hoja que está de perfil.
   */
  const renderHoja = useCallback(
    (n: number) => {
      const pase = paseRef.current;
      // La hoja vecina hacia la que se gira es, en un salto de varias, la de
      // destino: así el giro descubre ya el sitio al que se va.
      const numero = pase && n === hojaSegura + pase.dir ? pase.hasta : n;
      const fuera = numero < 0 || numero >= totalHojas;
      const viva = !pase && !fuera;
      return (
        <PaginaArchivador
          huecos={fuera ? HOJA_FANTASMA : huecosDeHoja(mapa, numero)}
          numero={numero + 1}
          total={totalHojas}
          /* La invitación escrita sólo en la primera funda de la primera hoja
             y sólo con el archivador entero vacío: es la frase que evita que
             una vitrina en blanco parezca una pantalla rota. */
          invitacion={viva && fundas.length === 0 && numero === 0 ? 0 : -1}
          onFunda={viva ? (r) => abrirFunda(numero, r) : undefined}
        />
      );
    },
    [hojaSegura, totalHojas, mapa, fundas.length, abrirFunda],
  );

  /* ---------------------------------------------------------------- */
  /* ESCRITURAS                                                        */
  /* ---------------------------------------------------------------- */

  /** Toma el cerrojo; devuelve false si ya hay una escritura en curso. */
  const tomarCerrojo = () => {
    if (escrituraRef.current) return false;
    escrituraRef.current = true;
    setGuardando(true);
    return true;
  };
  const soltarCerrojo = () => {
    escrituraRef.current = false;
    setGuardando(false);
  };

  /** Las fundas en la forma que espera utils/archivadorLocal.ts. */
  const aLocales = (lista: FundaVitrina[]): FundaLocal[] =>
    lista.map((f) => ({ hoja: f.hoja, ranura: f.ranura, cardId: f.carta.id }));

  const colocar = useCallback(
    async (destino: Destino, carta: CartaEnColeccion) => {
      if (!tomarCerrojo()) return;
      try {
        if (isSignedIn) {
          const r = await ponerEnRanura(destino.hoja, destino.ranura, carta.id);
          if (!r.ok) {
            haptic("warning");
            toast(porQueNoSePudo(r), "error");
            return;
          }
        } else {
          const res = ponerEnRanuraLocal(
            aLocales(fundas),
            destino.hoja,
            destino.ranura,
            carta.id,
            carta.quantity,
          );
          if (!res.ok) {
            haptic("warning");
            toast(
              `Ya tienes ${carta.quantity === 1 ? "tu única copia" : `tus ${carta.quantity} copias`} de esa carta en el archivador.`,
              "error",
            );
            return;
          }
          if (!guardarArchivadorLocal(res.fundas)) {
            haptic("warning");
            toast(
              "No hay sitio para guardar el archivador en este navegador.",
              "error",
            );
            return;
          }
        }

        /* Estado local en vez de volver a leer el archivador entero: la
         * respuesta ya confirma que la fila está escrita, y una relectura
         * completa por cada carta colocada convertiría montar una hoja en
         * nueve viajes de ida y vuelta.
         *
         * NO HACE FALTA PASAR ESTA CARTA POR `conNotas`: viene del selector, o
         * sea de `cartas`, o sea de `getFullCollection`, así que ya trae sus
         * `graduadas` y `mejor_nota` puestos. Una carta graduada enseña su nota
         * en cuanto se coloca, sin recargar la vitrina. */
        setFundas((prev) => [
          ...prev.filter(
            (f) => !(f.hoja === destino.hoja && f.ranura === destino.ranura),
          ),
          { hoja: destino.hoja, ranura: destino.ranura, carta },
        ]);
        haptic("success");
        setEligiendo(null);
        setMenu(null);
      } catch (error) {
        console.error("Error colocando en la funda:", error);
        toast("No se pudo colocar la carta. Inténtalo otra vez.", "error");
      } finally {
        soltarCerrojo();
      }
    },
    [isSignedIn, fundas, haptic, toast],
  );

  const quitar = useCallback(
    async (destino: Destino) => {
      if (!tomarCerrojo()) return;
      try {
        if (isSignedIn) {
          const r = await quitarDeRanura(destino.hoja, destino.ranura);
          /* "vacia" no es un error que merezca un aviso: significa que la funda
           * ya estaba libre (otra pestaña se adelantó), y el resultado que el
           * jugador quería —que no haya nada ahí— es exactamente el que hay. */
          if (!r.ok && r.error !== "vacia") {
            haptic("warning");
            toast("No se pudo vaciar la funda. Inténtalo otra vez.", "error");
            return;
          }
        } else {
          const restantes = quitarDeRanuraLocal(
            aLocales(fundas),
            destino.hoja,
            destino.ranura,
          );
          if (!guardarArchivadorLocal(restantes)) {
            haptic("warning");
            toast(
              "No se pudo guardar el archivador en este navegador.",
              "error",
            );
            return;
          }
        }

        setFundas((prev) =>
          prev.filter(
            (f) => !(f.hoja === destino.hoja && f.ranura === destino.ranura),
          ),
        );
        haptic("tap");
        setMenu(null);
      } catch (error) {
        console.error("Error vaciando la funda:", error);
        toast("No se pudo vaciar la funda. Inténtalo otra vez.", "error");
      } finally {
        soltarCerrojo();
      }
    },
    [isSignedIn, fundas, haptic, toast],
  );

  /* ---------------------------------------------------------------- */
  /* DETALLE                                                           */
  /* ---------------------------------------------------------------- */

  const idsNavegables = useMemo(
    () => ordenadas.map((f) => f.carta.id),
    [ordenadas],
  );
  const detalle =
    detalleIdx !== null ? (ordenadas[detalleIdx]?.carta ?? null) : null;

  /**
   * La carta que se le pasa al detalle, con una corrección pequeña y necesaria.
   *
   * CardDetailModal escribe "Copia única" en cuanto `quantity` no es nula, y
   * una carta con CERO copias no es una copia única: es una que ya no está en
   * la colección (se vendió después de colocarla). Quitando el campo, el modal
   * se salta esa línea en vez de mentir. Va memoizado porque un objeto nuevo en
   * cada render volvería a montar los oyentes de teclado del diálogo.
   */
  const cartaDelDetalle = useMemo(() => {
    if (!detalle) return null;
    return detalle.quantity > 0 ? detalle : { ...detalle, quantity: undefined };
  }, [detalle]);

  /**
   * Al deslizar dentro del detalle, el archivador de detrás pasa a la hoja de
   * esa funda. Así, al cerrar, el jugador se queda MIRANDO la funda de la que
   * acaba de salir en vez de volver a donde estaba hace diez cartas.
   *
   * Si el giro anterior todavía no ha terminado, `irAHoja` se desentiende: el
   * detalle sigue avanzando y el archivador se queda en la hoja anterior. Es
   * preferible a encolar giros, que dejaría el archivador dando vueltas solo
   * un buen rato después de cerrar el detalle.
   */
  const irACartaDelDetalle = (i: number) => {
    const funda = ordenadas[i];
    if (!funda) return;
    setDetalleIdx(i);
    irAHoja(funda.hoja);
  };

  /** "Ver la carta" desde el menú de la funda. */
  const verDesdeElMenu = () => {
    if (!menu) return;
    const i = ordenadas.findIndex(
      (f) => f.hoja === menu.hoja && f.ranura === menu.ranura,
    );
    setMenu(null);
    if (i >= 0) setDetalleIdx(i);
  };

  const fundaDelMenu = menu
    ? (mapa.get(claveFunda(menu.hoja, menu.ranura)) ?? null)
    : null;
  /** Carta que ocupa la funda que el selector va a rellenar, si la hay. */
  const cartaEnDestino = eligiendo
    ? (mapa.get(claveFunda(eligiendo.hoja, eligiendo.ranura))?.carta.id ?? null)
    : null;

  /* ---------------------------------------------------------------- */
  /* RENDER                                                            */
  /* ---------------------------------------------------------------- */

  if (cargando) return <Loader label="Abriendo la vitrina" />;

  if (errorCarga) {
    return (
      <div className="w-full">
        <PageHeader
          title="Vitrina"
          subtitle="El archivador que montas tú, funda a funda"
          back="/collection"
        />
        <div className="surface flex flex-col items-center gap-4 rounded-2xl px-6 py-16 text-center md:py-20">
          <div className="surface-2 flex h-14 w-14 items-center justify-center rounded-2xl">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="ink-faint h-7 w-7"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7.5v5.5M12 16.5h.01" />
            </svg>
          </div>
          <div>
            <p className="ink font-medium">No se pudo abrir la vitrina</p>
            <p className="ink-soft mt-1 text-sm">
              Comprueba tu conexión e inténtalo de nuevo.
            </p>
          </div>
          <button
            onClick={() => {
              haptic("tap");
              cargar();
            }}
            className="btn-primary press touch-target rounded-xl px-5 py-2.5 text-sm font-medium"
          >
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  const sinCartas = cartas.length === 0;
  const sinFundas = fundas.length === 0;

  return (
    <div className="w-full select-none">
      <PageHeader
        title="Vitrina"
        subtitle="El archivador que montas tú, funda a funda"
        back="/collection"
      />

      {/* TOPE DE ANCHO. Un archivador no es una rejilla fluida: nueve cartas
          en 3×3 miden 1,4 veces de alto lo que midan de ancho, así que dejarlo
          crecer hasta los 1280px del <main> daría cartas de 380px y un bloque
          de más de dos pantallas de alto — habría que hacer scroll para ver
          una sola hoja, que es justo lo contrario de lo que hace un
          archivador. A 672px las cartas salen a ~180px (algo mayores que en la
          rejilla de la colección) y la hoja entera se abarca de un vistazo. */}
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
        {/* LA BARRA DICE QUÉ HACER, no qué hay: un archivador vacío es un
            estado legítimo y sin una frase que lo explique parece una pantalla
            que no ha cargado. Es el aviso más importante de la pantalla la
            primera vez que se entra. */}
        <div className="surface flex flex-col gap-2 rounded-2xl px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="ink-soft text-[12px] leading-relaxed">
            {sinCartas
              ? "Todavía no tienes cartas que colocar. Abre un sobre y vuelve."
              : sinFundas
                ? "Tu archivador está vacío. Toca una funda y elige la carta que quieres enseñar."
                : "Toca una funda para colocar, cambiar o quitar su carta."}
          </p>
          {sinCartas ? (
            <Link
              href="/"
              className="btn-primary press shrink-0 rounded-xl px-4 py-2 text-center text-[12px] font-medium"
            >
              Abrir sobres
            </Link>
          ) : (
            <span className="chip ink-soft tnum shrink-0 px-3 py-2 text-center text-[11px] font-medium">
              {formatNumber(fundas.length)}{" "}
              {fundas.length === 1 ? "funda ocupada" : "fundas ocupadas"}
            </span>
          )}
        </div>

        {/* ARCHIVADOR */}
        <div className="rounded-3xl p-2.5 sm:p-4" style={TAPA}>
          <div className="flex items-stretch">
            <AnillasArchivador />

            {/* Bloque de hojas. `relative` y `min-w-0` (sin el segundo, un
                hijo de flex no baja de su ancho de contenido y la rejilla
                de tres columnas desbordaría en pantallas estrechas). */}
            <div className="relative min-w-0 flex-1">
              {/* GROSOR — cantos de las hojas que quedan debajo. Son
                  hermanos decorativos, nunca ancestros de una carta, así
                  que su `translate` no afecta a la nitidez. */}
              <div
                aria-hidden="true"
                className="absolute inset-0 rounded-2xl"
                style={{ ...CANTO, transform: "translate(6px, 7px)" }}
              />
              <div
                aria-hidden="true"
                className="absolute inset-0 rounded-2xl"
                style={{ ...CANTO, transform: "translate(3px, 3.5px)" }}
              />

              {/* VENTANA — el ÚNICO elemento que escucha el arrastre (ver el
                  punto 3 de la cabecera). `touch-action: pan-y` le devuelve al
                  navegador el desplazamiento vertical de la página: sin esto,
                  arrastrar hacia abajo sobre el archivador no haría scroll.

                  YA NO LLEVA `overflow-hidden`, y no es un descuido: lo tenía
                  cuando el pase era un desplazamiento lateral y hacía falta
                  recortar la hoja que entraba. Con el giro, la hoja pasa del
                  perfil y acaba a la IZQUIERDA del lomo —como el papel de un
                  archivador de verdad—, así que recortarla aquí la cortaría por
                  la mitad justo en el fotograma en el que se está mirando. Que
                  se salga no ensancha la página: `body` lleva
                  `overflow-x: hidden` (app/globals.css:132). */}
              <div
                ref={ventanaRef}
                className="relative z-10"
                style={{ touchAction: touchActionFor("x") }}
              >
                {/* El libro va en un BLOQUE normal y no en una rejilla: el
                    mínimo de una <img> es su ancho INTRÍNSECO (245px por
                    carta), y un contenedor de rejilla con pista implícita
                    `auto` respeta ese mínimo — tres columnas de eso son 735px
                    y la hoja desbordaba en cualquier móvil. Un bloque no tiene
                    ese problema, y dentro la hoja usa `grid-cols-3` de
                    Tailwind, que es `minmax(0, 1fr)` y sí puede encoger. */}
                <LibroArchivador
                  ref={libroRef}
                  hoja={hojaSegura}
                  total={totalHojas}
                  renderHoja={renderHoja}
                  /* El estado se fija AL TERMINAR el giro. `paseRef` manda
                     sobre `nueva` porque en un salto de varias hojas la vecina
                     que el libro conoce no es el destino. */
                  onCambio={(nueva) => {
                    const pase = paseRef.current;
                    paseRef.current = null;
                    setPasando(false);
                    setHoja(pase ? pase.hasta : nueva);
                  }}
                  efectosApagados={!!reducido}
                />
              </div>
            </div>
          </div>
        </div>

        {/* MANDOS — botones, además del gesto y del teclado. El gesto no
            puede ser el único camino: en escritorio no hay dedo, y en la
            PWA el arrastre convive con el gesto de retroceso del sistema. */}
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => irAHoja(0)}
            disabled={hojaSegura === 0 || pasando}
            aria-label="Primera hoja"
            className="btn-ghost press touch-target flex h-11 w-11 items-center justify-center rounded-xl disabled:cursor-not-allowed disabled:opacity-30"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
            >
              <path d="m17 18-6-6 6-6M7 18V6" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => irAHoja(hojaSegura - 1)}
            disabled={hojaSegura === 0 || pasando}
            aria-label="Hoja anterior"
            className="btn-ghost press touch-target flex h-11 w-11 items-center justify-center rounded-xl disabled:cursor-not-allowed disabled:opacity-30"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
            >
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>

          {/* `aria-live` para que el pase de hoja se anuncie: con lector de
              pantalla, el gesto y las flechas cambian nueve fundas sin
              mover el foco, y sin esto no habría ni rastro de que ha
              pasado algo. */}
          <span
            aria-live="polite"
            className="chip ink tnum min-w-[9.5rem] px-4 py-2 text-center text-sm font-medium"
          >
            Hoja {hojaSegura + 1} de {totalHojas}
          </span>

          <button
            type="button"
            onClick={() => irAHoja(hojaSegura + 1)}
            disabled={hojaSegura === totalHojas - 1 || pasando}
            aria-label="Hoja siguiente"
            className="btn-ghost press touch-target flex h-11 w-11 items-center justify-center rounded-xl disabled:cursor-not-allowed disabled:opacity-30"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => irAHoja(totalHojas - 1)}
            disabled={hojaSegura === totalHojas - 1 || pasando}
            aria-label="Última hoja"
            className="btn-ghost press touch-target flex h-11 w-11 items-center justify-center rounded-xl disabled:cursor-not-allowed disabled:opacity-30"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
            >
              <path d="m7 6 6 6-6 6M17 6v12" />
            </svg>
          </button>
        </div>

        {/* Por dónde va el archivador. Decorativo: el dato ya está escrito
            al lado, en texto, y anunciado por aria-live. */}
        <div
          aria-hidden="true"
          className="surface-2 mx-auto h-1 w-full max-w-sm overflow-hidden rounded-full"
        >
          <div
            className="progress-bar-blue h-full"
            style={{ width: `${((hojaSegura + 1) / totalHojas) * 100}%` }}
          />
        </div>

        <p className="ink-faint text-center text-[11px]">
          Desliza sobre las hojas o usa las flechas ← → para pasar de página.
          Siempre queda una hoja libre al final para seguir montando.
        </p>
      </div>

      {/* El selector escribe en el servidor (o en localStorage) y cierra solo
          al confirmar; si la escritura falla, se queda abierto con el aviso,
          que es lo que permite volver a intentarlo sin repetir la búsqueda. */}
      <SelectorCarta
        destino={eligiendo}
        onCerrar={() => setEligiendo(null)}
        cartas={cartas}
        sets={sets}
        colocadas={colocadas}
        actual={cartaEnDestino}
        guardando={guardando}
        onElegir={(carta) => {
          if (eligiendo) colocar(eligiendo, carta);
        }}
      />

      <AccionesFunda
        funda={fundaDelMenu}
        onCerrar={() => setMenu(null)}
        guardando={guardando}
        onVer={verDesdeElMenu}
        /* Cambiar es el mismo selector: `ponerEnRanura` sustituye lo que
           hubiera en la funda, así que no hace falta quitar primero (y de
           hacerlo habría un instante con la funda vacía si la segunda
           escritura fallara). */
        onCambiar={() => {
          if (!menu) return;
          setEligiendo(menu);
          setMenu(null);
        }}
        onQuitar={() => {
          if (menu) quitar(menu);
        }}
      />

      {/* El detalle va en modo lectura: la vitrina enseña la colección, y
          vender o marcar favoritas ya tiene su sitio en /collection. Añadirlo
          aquí duplicaría los cerrojos de venta y de favorito (y con ellos la
          posibilidad de que las dos pantallas se desincronicen) a cambio de
          nada que no se pueda hacer a un toque de distancia. */}
      <CardDetailModal
        card={cartaDelDetalle}
        readOnly
        onClose={() => setDetalleIdx(null)}
        cards={idsNavegables}
        index={detalleIdx ?? -1}
        onIndexChange={irACartaDelDetalle}
      />
    </div>
  );
}
