/**
 * EL REPARTO DEL MERCADO: qué copias del álbum van a cada requisito de una
 * oferta, y qué se le puede ofrecer al jugador cuando quiere cambiar una.
 *
 * ESTO SALIÓ ENTERO DE app/mercado/page.tsx Y NO SE HA TOCADO POR EL CAMINO.
 * Está aquí por una razón muy concreta: scripts/test-invariantes.mjs carga los
 * módulos con un `require` de juguete que sólo sabe resolver ficheros .ts sin
 * dependencias de fuera (ver `cargarModulo` al principio de ese script), y la
 * pantalla importa React, Clerk y framer-motion. Mientras esto vivió dentro del
 * componente, la parte más delicada del mercado —la que decide si una oferta se
 * ve completa o incompleta, y que existe justamente para evitar que se vea
 * incompleta teniéndolo todo— era la única de la que ningún invariante podía
 * decir nada.
 *
 * De ahí la regla de la casa de este fichero: aquí NO entra nada de app/, de
 * components/ ni de react. En cuanto entre, el cargador de los invariantes deja
 * de poder abrirlo y volvemos al punto de partida.
 */
import {
  copiasEntregables,
  cumpleFiltro,
  setDeCarta,
  type CartaMinima,
  type Categoria,
  type Oferta,
  type Requisito,
} from "./mercado";

/* ------------------------------------------------------------------ *
 * DATOS
 * ------------------------------------------------------------------ */

export interface CartaMercado extends CartaMinima {
  /**
   * Copias que tiene el jugador EN TOTAL. Las entregables son
   * `copiasEntregables(cantidad)`, nunca `cantidad`: ver la nota de `repartir`.
   */
  cantidad: number;
  /** SELL_PRICES de su rareza (lo calcula el servidor). */
  precio: number;
  /** Rótulo español, sólo para pintar. El emparejamiento usa `name` (inglés). */
  nombreEs?: string;
}

export interface ParteReparto {
  requisito: Requisito;
  /**
   * Copias apartadas para este requisito (una entrada por copia entregada), EN
   * EL ORDEN EN QUE SE PINTAN. Las que el jugador clavó se quedan en su hueco:
   * antes iban todas delante y soltar una reordenaba la fila entera, así que el
   * alfiler acababa en un chip distinto del que se había tocado.
   */
  elegidas: CartaMercado[];
  /**
   * Paralelo a `elegidas`: qué copias clavó el jugador. Es un array y no una
   * cuenta justamente porque lo clavado ya no va todo al principio.
   */
  fijas: boolean[];
  /** Unidades conseguidas (tipos para el arcoíris, copias para el playset...). */
  progreso: number;
  /**
   * ¿Este requisito está servido de verdad?
   *
   * NO es `elegidas.length === cantidad` y ésa es la razón de que exista el
   * campo: desde que se puede elegir a mano, un arcoíris puede llegar a tener
   * sus N cartas con menos de N COLORES distintos (el jugador clava dos del
   * mismo tipo). Con la cuenta vieja la tarjeta se pondría verde y el servidor
   * rechazaría el lote con `requisitos` — el peor fallo de esta pantalla, y
   * encima pareciendo culpa suya. Cada rama decide su propia respuesta.
   */
  completo: boolean;
}

export interface Reparto {
  partes: ParteReparto[];
  completa: boolean;
  ids: string[];
  /** Precio suelto del lote: lo que darían las cartas vendidas una a una. */
  valor: number;
}

/**
 * Lo que el jugador ha CLAVADO en una oferta: por índice de requisito, una
 * entrada POR HUECO del lote (el playset guarda sus N copias repetidas, ver
 * `normalizarFijadas`).
 *
 * `null` significa "este hueco lo elige la pantalla", y por eso la lista es
 * posicional en vez de una lista de ids a secas: soltar una copia deja un hueco
 * EN SU SITIO y el relleno automático cae ahí, así que la fila de chips no se
 * reordena bajo el dedo y el alfiler no se muda al chip de al lado.
 *
 * Vive en el estado de la pantalla y NO se persiste: el tablón caduca solo cada
 * ciclo y guardar la elección en la base de datos obligaría a validarla contra
 * un tablón que ya no existe. Recargar vuelve a la propuesta automática, que es
 * exactamente lo que se pidió.
 */
export type Fijadas = ReadonlyMap<number, (string | null)[]>;

/**
 * Orden en que se reparten las cartas entre requisitos: primero los que casi no
 * admiten alternativas y al final el "cartas cualesquiera de la expansión", que
 * acepta todo. Al revés, el requisito comodín se llevaría las cartas que el
 * exigente necesitaba y la oferta parecería incompleta teniéndolo todo.
 */
export const PRIORIDAD: Record<Categoria, number> = {
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

const clave = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** Misma comprobación que hace el servidor: el set va aparte del filtro. */
export const sirve = (c: CartaMinima, r: Requisito): boolean =>
  (r.setId === null || setDeCarta(c) === r.setId) && cumpleFiltro(c, r.filtro);

/** Barata primero y, a igual precio, la que tiene más copias de sobra. */
export const comparar = (a: CartaMercado, b: CartaMercado) =>
  a.precio - b.precio || b.cantidad - a.cantidad || a.id.localeCompare(b.id);

/**
 * Requisitos ordenados por PRIORIDAD, con su índice original a cuestas.
 *
 * Se saca a función porque lo usan DOS sitios que tienen que coincidir: el
 * reparto automático y el selector manual. El "utilidad" con el que se ordenan
 * las candidatas depende de qué requisitos quedan DETRÁS en esta cola, así que
 * si el selector la calculara por su cuenta la primera opción de la lista
 * dejaría de ser la que habría elegido el algoritmo — que es justo la promesa
 * que se le hace al jugador al enseñársela arriba del todo.
 */
export function ordenDeRequisitos(oferta: Oferta): { requisito: Requisito; indice: number }[] {
  return oferta.requisitos
    .map((requisito, indice) => ({ requisito, indice }))
    .sort(
      (a, b) =>
        (PRIORIDAD[a.requisito.filtro.categoria] ?? 3) -
          (PRIORIDAD[b.requisito.filtro.categoria] ?? 3) || a.indice - b.indice,
    );
}

/**
 * CUÁNTOS COLORES DISTINTOS cubre un grupo de cartas en un arcoíris, dándole a
 * cada carta uno de SUS tipos y sin repetir ninguno.
 *
 * Es un emparejamiento máximo (cartas ↔ tipos) por caminos aumentantes, el
 * mismo algoritmo que `emparejaHuecos` en app/action.ts, y eso NO es un lujo:
 * aquí antes había un voraz que le daba a cada carta su primer tipo libre, y
 * con cartas de DOBLE TIPO se quedaba corto. El caso, reproducido:
 *
 *     Machop [Lucha]  ·  Riolu [Lucha, Planta]
 *     Exeggcute [Planta, Psíquico]  ·  Chikorita [Planta, Rayo]
 *
 * las cuatro tienen cuatro colores repartibles (Lucha, Planta, Psíquico, Rayo)
 * y el servidor las acepta; el voraz, si Exeggcute entraba la primera, se
 * llevaba Planta y dejaba a Riolu sin color: 3/4. Con el reparto automático eso
 * sólo era una oferta que se veía incompleta teniéndolo todo. Desde que se
 * puede elegir a mano es peor: el selector ofrecía la carta diciendo "ésta
 * aporta un color nuevo", el jugador la tocaba, el conteo la repartía de otra
 * forma y la oferta caía de 4/4 a 3/4 CULPANDO A SU ELECCIÓN — que además era
 * la carta que ya estaba puesta.
 *
 * Lo llaman los TRES sitios que tienen que estar de acuerdo (progreso del
 * requisito, relleno automático y filtro del selector). Si alguno vuelve a
 * contar colores por su cuenta, vuelve el desacuerdo.
 */
export function coloresDistintos(cartas: CartaMercado[]): number {
  const tiposDe = cartas.map((c) =>
    Array.from(new Set((c.types ?? []).map(clave))).filter(Boolean),
  );
  // tipo -> índice de la carta que lo tiene asignado ahora mismo.
  const duenoDelTipo = new Map<string, number>();

  const buscar = (i: number, vistos: Set<string>): boolean => {
    for (const t of tiposDe[i]) {
      if (vistos.has(t)) continue;
      vistos.add(t);
      const dueno = duenoDelTipo.get(t);
      // Libre, o su dueño actual puede mudarse a otro color: en los dos casos
      // esta carta se queda con el tipo y el emparejamiento crece.
      if (dueno === undefined || buscar(dueno, vistos)) {
        duenoDelTipo.set(t, i);
        return true;
      }
    }
    return false;
  };

  let total = 0;
  for (let i = 0; i < cartas.length; i++) if (buscar(i, new Set<string>())) total++;
  return total;
}

/**
 * ¿Añadir esta carta al grupo aporta un color que el grupo no podía cubrir?
 *
 * Es la pregunta que se hacen el relleno del arcoíris y el selector, y se
 * responde con `coloresDistintos` para que las dos den lo mismo: no basta con
 * mirar si la carta tiene un tipo "sin usar", porque el reparto de colores del
 * resto del grupo se rehace al meterla.
 */
const aportaColor = (grupo: CartaMercado[], colores: number, c: CartaMercado): boolean =>
  coloresDistintos([...grupo, c]) > colores;

/**
 * Traduce lo que el jugador clavó (ids sueltos) a cartas de verdad, tirando lo
 * que ya no se sostiene.
 *
 * Es una RED, no la comprobación principal: quien pinta el selector ya ofrece
 * sólo lo que cabe. Pero entre que se clava una carta y se vuelve a repartir
 * puede haberse recargado la colección (otra pestaña vendió duplicados, una
 * copia se fue a graduar), y una elección que ya no existe tiene que
 * evaporarse sola en vez de dejar un lote imposible que el servidor rechaza.
 *
 * Tres reglas, y las tres importan:
 *  - `evolucion` NO admite elección pieza a pieza (ver `repartir`), así que sus
 *    fijadas se ignoran aunque alguien las meta.
 *  - el PLAYSET es indivisible: son N copias de la MISMA carta y o caben las N
 *    o no hay playset clavado. Media docena de copias sueltas no es un playset,
 *    y dejar tres de cuatro serviría un lote que el servidor no empareja.
 *  - una copia no se puede clavar dos veces: `gastadas` lleva la cuenta por
 *    carta a lo largo de TODOS los requisitos, no dentro de cada uno.
 *
 * Devuelve una lista POSICIONAL por requisito: `null` en los huecos que elige la
 * pantalla, y también en los que traían una elección que ya no se sostiene — así
 * el hueco se queda donde estaba y el relleno automático cae exactamente ahí.
 */
export function normalizarFijadas(
  oferta: Oferta,
  cartas: CartaMercado[],
  fijadas: Fijadas | undefined,
): Map<number, (CartaMercado | null)[]> {
  const salida = new Map<number, (CartaMercado | null)[]>();
  if (!fijadas || fijadas.size === 0) return salida;

  const porId = new Map(cartas.map((c) => [c.id, c]));
  const gastadas = new Map<string, number>();

  oferta.requisitos.forEach((r, indice) => {
    if (r.filtro.categoria === "evolucion") return;
    const ids = fijadas.get(indice);
    if (!ids || ids.every((id) => id === null)) return;

    const playset = r.filtro.categoria === "playset";
    // El playset se guarda como N copias del mismo id, pero se lee de la primera
    // entrada que haya: es UNA decisión y no N huecos independientes.
    const base = ids.find((id) => id !== null) ?? null;
    const pedidas = playset
      ? Array.from({ length: r.cantidad }, () => base)
      : ids.slice(0, r.cantidad);

    const validas: (CartaMercado | null)[] = [];
    let cuantas = 0;
    for (const id of pedidas) {
      const c = id === null ? undefined : porId.get(id);
      // `sirve` es la misma comprobación que hace el servidor: una carta que no
      // cumple el requisito no se clava ni aunque venga en el estado.
      if (!c || !sirve(c, r)) {
        validas.push(null);
        continue;
      }
      const usadas = gastadas.get(c.id) ?? 0;
      if (usadas >= copiasEntregables(c.cantidad)) {
        validas.push(null);
        continue;
      }
      gastadas.set(c.id, usadas + 1);
      validas.push(c);
      cuantas += 1;
    }

    if (playset && cuantas < r.cantidad) {
      for (const c of validas) if (c) gastadas.set(c.id, (gastadas.get(c.id) ?? 0) - 1);
      return;
    }
    if (cuantas > 0) salida.set(indice, validas);
  });

  return salida;
}

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
 *
 * ---------------------------------------------------------------------------
 * `fijadas`: LO QUE EL JUGADOR HA ELEGIDO A MANO
 * ---------------------------------------------------------------------------
 * La pantalla deja cambiar cualquier copia del lote, y lo cambiado llega aquí.
 * La forma de respetarlo es EXTENDER esta función, no duplicarla, y por una
 * razón concreta: si el trozo elegido a mano se resolviera por fuera, el
 * algoritmo repartiría el resto sin saber qué copias ya no están, volvería a
 * gastar las que sólo sirven para el requisito exigente y reaparecería el
 * atasco que documenta el párrafo de arriba ("8 de Fuego o Lucha" + "3 de
 * Kalos") — pero ahora pareciendo culpa del jugador.
 *
 * Se hace en tres pasos, y el ORDEN de los tres es lo único delicado:
 *  1. se apartan TODAS las fijadas de golpe ANTES del bucle. De golpe y no
 *     requisito a requisito: si se apartaran sobre la marcha, un requisito de
 *     prioridad alta se llevaría una copia que el jugador clavó para uno de
 *     prioridad baja y la elección se evaporaría sin que él tocara nada.
 *  2. cada requisito ARRANCA con lo suyo ya puesto y el bucle sólo rellena los
 *     huecos que quedan, con el mismo criterio de siempre.
 *  3. cuando un requisito no se completa, al fondo común vuelve SÓLO lo
 *     automático. Lo clavado se queda donde está aunque el requisito quede a
 *     medias: si se devolviera, otro requisito se lo comería y el jugador se
 *     quedaría sin chip que tocar para soltarlo, atascado y sin salida.
 */
export function repartir(oferta: Oferta, cartas: CartaMercado[], fijadas?: Fijadas): Reparto {
  // Copias ENTREGABLES sin apartar, por id (la copia del álbum nunca entra en
  // este fondo). Una carta no puede valer para dos requisitos.
  const libres = new Map<string, number>();
  for (const c of cartas) libres.set(c.id, copiasEntregables(c.cantidad));
  const libre = (c: CartaMercado) => libres.get(c.id) ?? 0;
  const apartar = (c: CartaMercado, n = 1) => libres.set(c.id, libre(c) - n);

  // Paso 1: lo clavado sale del fondo común antes de repartir nada. A partir de
  // aquí el resto del algoritmo no se entera de que existe, porque `candidatas`
  // filtra por `libre(c) > 0` y esas copias ya no lo están.
  const clavadas = normalizarFijadas(oferta, cartas, fijadas);
  for (const lista of clavadas.values()) for (const c of lista) if (c) apartar(c);

  const orden = ordenDeRequisitos(oferta);

  const porIndice = new Map<
    number,
    { elegidas: CartaMercado[]; progreso: number; completo: boolean; fijas: boolean[] }
  >();

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
    // Paso 2: el requisito arranca con lo que el jugador clavó. Dentro del
    // algoritmo las clavadas van delante (es lo que hace que `elegidas.slice`
    // separe lo automático en una línea); el orden con el que se PINTAN se
    // rehace al final, para devolver cada clavada a su hueco.
    const ranuras = clavadas.get(indice) ?? [];
    const clavadasAqui = ranuras.filter((c): c is CartaMercado => c !== null);
    const nFijadas = clavadasAqui.length;
    let elegidas: CartaMercado[] = [...clavadasAqui];
    let progreso = 0;
    let completo = false;
    // Paso 3: sólo vuelve al fondo lo que puso el algoritmo.
    const devolverAutomaticas = () => {
      elegidas.slice(nFijadas).forEach((c) => apartar(c, -1));
      elegidas = elegidas.slice(0, nFijadas);
    };

    if (r.filtro.categoria === "playset") {
      if (nFijadas > 0) {
        // El playset clavado ya viene entero y ya está apartado en el paso 1
        // (`normalizarFijadas` lo garantiza o no lo deja pasar). Por eso el
        // descuento de las `cantidad` copias vive dentro de la rama automática
        // y no fuera: aquí volver a restarlas se comería el fondo dos veces.
        progreso = r.cantidad;
      } else {
        // `cantidad` copias de LA MISMA carta: la más barata que llegue.
        const suficientes = candidatas.filter((c) => libre(c) >= r.cantidad);
        progreso = candidatas.reduce((mejor, c) => Math.max(mejor, Math.min(libre(c), r.cantidad)), 0);
        if (suficientes.length > 0) {
          elegidas = Array.from({ length: r.cantidad }, () => suficientes[0]);
          progreso = r.cantidad;
          apartar(suficientes[0], r.cantidad);
        }
      }
      completo = elegidas.length === r.cantidad;
    } else if (r.filtro.categoria === "arcoiris") {
      // Una carta por TIPO distinto, empezando por las baratas. Los colores que
      // ya traen las clavadas cuentan desde el principio, o el relleno
      // automático repetiría uno y el requisito saldría con N cartas y N-1
      // colores: completo para la pantalla, inválido para el servidor.
      let colores = coloresDistintos(elegidas);
      for (const c of candidatas) {
        if (elegidas.length >= r.cantidad) break;
        if (libre(c) <= 0) continue;
        if (!aportaColor(elegidas, colores, c)) continue;
        colores += 1;
        elegidas.push(c);
        apartar(c);
      }
      // El progreso son COLORES, no cartas: dos copias del mismo tipo valen una.
      progreso = colores;
      // Las dos condiciones, y las dos hacen falta: el servidor pide N cartas
      // Y N colores repartibles entre ellas.
      completo = elegidas.length === r.cantidad && colores >= r.cantidad;
      // Incompleta: lo automático vuelve al fondo común para el siguiente
      // requisito; lo clavado se queda para que el jugador pueda soltarlo.
      if (!completo) devolverAutomaticas();
    } else if (r.filtro.categoria === "evolucion") {
      // SIN ELECCIÓN MANUAL, a propósito: ver la nota de `esFijable`.
      const cadena = mejorCadena(candidatas, r.cantidad, libre);
      if (cadena) {
        elegidas = cadena;
        progreso = r.cantidad;
      } else {
        // Para la barra: si pedían 3 eslabones, enseñar si al menos hay 2.
        progreso = r.cantidad === 3 && mejorCadena(candidatas, 2, libre) ? 2 : 0;
      }
      elegidas.forEach((c) => apartar(c));
      completo = elegidas.length === r.cantidad;
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
      completo = elegidas.length === r.cantidad;
      if (!completo) devolverAutomaticas();
    }

    // CADA CLAVADA, A SU HUECO. El algoritmo trabaja con las clavadas delante,
    // pero pintarlas así reordenaba la fila entera cada vez que el jugador
    // soltaba una copia: el chip que tocaba dejaba de estar donde lo tocó y el
    // alfiler saltaba a otro. Aquí se recorren las ranuras en su orden y el
    // relleno automático cae en los huecos vacíos, que es lo que él ve.
    const automaticas = elegidas.slice(nFijadas);
    const pintadas: CartaMercado[] = [];
    const fijas: boolean[] = [];
    let siguiente = 0;
    for (let s = 0; s < Math.max(ranuras.length, elegidas.length); s++) {
      const clavada = ranuras[s] ?? null;
      if (clavada) {
        pintadas.push(clavada);
        fijas.push(true);
      } else if (siguiente < automaticas.length) {
        pintadas.push(automaticas[siguiente++]);
        fijas.push(false);
      }
    }
    // Las automáticas que sobran (ranuras más cortas que el lote) van al final.
    while (siguiente < automaticas.length) {
      pintadas.push(automaticas[siguiente++]);
      fijas.push(false);
    }

    porIndice.set(indice, { elegidas: pintadas, progreso, completo, fijas });
  }

  const partes: ParteReparto[] = oferta.requisitos.map((requisito, indice) => {
    const parte =
      porIndice.get(indice) ?? { elegidas: [], progreso: 0, completo: false, fijas: [] };
    return { requisito, ...parte };
  });

  const todas = partes.flatMap((p) => p.elegidas);
  const completa = partes.every((p) => p.completo);

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
export function mejorCadena(
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
 * ELECCIÓN A MANO
 * ------------------------------------------------------------------ */

/**
 * ¿Se puede cambiar carta por carta en este requisito?
 *
 * En TODOS menos en `evolucion`, y no por falta de ganas: una cadena es un
 * conjunto encadenado (B.evolvesFrom === A.name), así que clavar el eslabón de
 * en medio no es "una carta menos que buscar", es una restricción que obliga a
 * los otros dos. `mejorCadena` no sabe resolver cadenas con un eslabón impuesto
 * —indexa una carta por nombre y busca la más barata— y enseñarle al jugador un
 * botón que a veces deja la cadena rota sería peor que no enseñarle ninguno. La
 * unidad natural ahí es la CADENA ENTERA (elegir entre las cadenas posibles), y
 * eso es otro encargo, no éste. Mientras tanto la cadena se sigue proponiendo
 * sola y se pinta como texto, igual que antes.
 */
export const esFijable = (r: Requisito): boolean => r.filtro.categoria !== "evolucion";

/** Una carta ofrecible en el selector, con lo que hace falta para decidir. */
export interface Opcion {
  carta: CartaMercado;
  /** Copias que le sobran y que este lote no está usando ya en otro sitio. */
  libres: number;
}

/**
 * Qué cartas se le pueden ofrecer al jugador para el hueco (`indice`,
 * `posicion`) del lote que hay pintado.
 *
 * LAS TRES EXCLUSIONES, que son el punto delicado: ofrecer una carta que no
 * cabe es peor que no ofrecer nada, porque el jugador la elige, el lote sale
 * mal y el error llega del servidor.
 *  1. sin copias ENTREGABLES no hay nada que dar (`copiasEntregables`, que deja
 *     siempre la copia del álbum);
 *  2. las copias que YA está usando el resto del lote no están libres, ni
 *     aunque las use otro requisito de la misma oferta — de ahí que se cuente
 *     sobre `reparto.partes` entero y no sobre este requisito;
 *  3. en el arcoíris hace falta además aportar un COLOR que las demás cartas
 *     del requisito no cubran ya.
 * La copia que ocupa ahora el hueco se devuelve a la cuenta (`devuelve`):
 * cambiar una carta por sí misma no consume una copia de más, y en el playset
 * devuelve las N de golpe porque el playset es una sola decisión.
 *
 * El ORDEN es el mismo del algoritmo (utilidad y luego precio), así que la
 * primera opción de la lista es la que él habría elegido solo.
 */
export function candidatasPara(
  oferta: Oferta,
  cartas: CartaMercado[],
  reparto: Reparto,
  indice: number,
  posicion: number,
): Opcion[] {
  const r = oferta.requisitos[indice];
  const parte = reparto.partes[indice];
  if (!r || !parte || !esFijable(r)) return [];

  const playset = r.filtro.categoria === "playset";
  const necesita = playset ? r.cantidad : 1;
  const actual = parte.elegidas[posicion];

  const comprometidas = new Map<string, number>();
  for (const p of reparto.partes) {
    for (const c of p.elegidas) comprometidas.set(c.id, (comprometidas.get(c.id) ?? 0) + 1);
  }

  // Arcoíris: el hueco que se cambia sale del grupo, y lo que se ofrece es lo
  // que le devuelve un color al resto. Se mide con `coloresDistintos` —el mismo
  // emparejamiento que usa el reparto— y no contando "tipos ya usados": si cada
  // sitio reparte los colores a su manera, el selector ofrece cartas que luego
  // el reparto no sabe colocar.
  const otrasDelArcoiris =
    r.filtro.categoria === "arcoiris"
      ? parte.elegidas.filter((_, j) => j !== posicion)
      : null;
  const coloresOtras = otrasDelArcoiris ? coloresDistintos(otrasDelArcoiris) : 0;

  const orden = ordenDeRequisitos(oferta);
  const k = orden.findIndex((x) => x.indice === indice);
  const pendientes = k < 0 ? [] : orden.slice(k + 1).map((x) => x.requisito);

  const opciones: Opcion[] = [];
  for (const c of cartas) {
    if (!sirve(c, r)) continue;
    const devuelve = actual && c.id === actual.id ? necesita : 0;
    const libres = copiasEntregables(c.cantidad) - (comprometidas.get(c.id) ?? 0) + devuelve;
    if (libres < necesita) continue;
    if (otrasDelArcoiris && !aportaColor(otrasDelArcoiris, coloresOtras, c)) continue;
    opciones.push({ carta: c, libres });
  }

  const utilidad = new Map<string, number>();
  for (const o of opciones) {
    utilidad.set(o.carta.id, pendientes.filter((p) => sirve(o.carta, p)).length);
  }
  opciones.sort(
    (a, b) =>
      (utilidad.get(a.carta.id) ?? 0) - (utilidad.get(b.carta.id) ?? 0) ||
      comparar(a.carta, b.carta),
  );
  return opciones;
}

/** Todas las elecciones a mano de la pantalla: por oferta y por requisito. */
export type FijadasPorOferta = Map<string, Map<number, (string | null)[]>>;

const mismaLista = (a: (string | null)[], b: (string | null)[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * PODA las elecciones a mano contra el tablón y la colección recién leídos.
 *
 * Hace falta porque `normalizarFijadas` descarta lo que ya no se sostiene pero
 * NO limpia el estado, y un estado sucio miente por partida doble: la oferta se
 * queda con una entrada que ya no clava nada (el botón de "volver a la propuesta
 * automática" aparece sin nada que soltar y no hace nada al pulsarlo), y si más
 * adelante el jugador vuelve a tener duplicados de esa carta —abre sobres y se
 * refresca la colección— la elección MUERTA RESUCITA sin que él la haya vuelto a
 * hacer.
 *
 * Se poda al cargar y no en cada reparto porque es aquí donde cambia el suelo:
 * ofertas nuevas de un ciclo nuevo y cantidades nuevas de la colección.
 */
export function podarFijadas(
  previas: FijadasPorOferta,
  ofertas: Oferta[],
  cartas: CartaMercado[],
): FijadasPorOferta {
  if (previas.size === 0) return previas;

  const salida: FijadasPorOferta = new Map();
  for (const oferta of ofertas) {
    const deOferta = previas.get(oferta.id);
    if (!deOferta) continue;
    const viva = new Map<number, (string | null)[]>();
    for (const [indice, cartasDelHueco] of normalizarFijadas(oferta, cartas, deOferta)) {
      viva.set(indice, cartasDelHueco.map((c) => c?.id ?? null));
    }
    if (viva.size > 0) salida.set(oferta.id, viva);
  }

  // Misma referencia si no ha cambiado nada: el reparto vive en un useMemo que
  // depende de este mapa y repintar el tablón entero en cada cuenta atrás sería
  // tirar trabajo.
  const igual =
    salida.size === previas.size &&
    [...salida].every(([id, viva]) => {
      const antes = previas.get(id);
      return (
        antes !== undefined &&
        antes.size === viva.size &&
        [...viva].every(([i, lista]) => {
          const listaAntes = antes.get(i);
          return listaAntes !== undefined && mismaLista(listaAntes, lista);
        })
      );
    });
  return igual ? previas : salida;
}
