  // src/app/action.ts
  'use server'

  import { auth, currentUser } from "@clerk/nextjs/server";
  import { sql } from '@vercel/postgres';
  import { revalidatePath } from 'next/cache';
  // SELL_PRICES ya no se importa a propósito: el valor de una colección se
  // calcula con `precioDeCartaSuelta` + `valorDeVenta`, que son la curva real
  // que paga la tienda. Multiplicar SELL_PRICES por la cantidad inflaba el
  // patrimonio y premiaba acaparar repetidas que valen la octava parte.
  import { AVAILABLE_SETS, RARITY_RANK, STARTING_COINS, DAILY_BASE, DAILY_STREAK_STEP, DAILY_STREAK_CAP, SET_COMPLETION_BONUS, PACK_PRICES, valorDeVenta, precioDeCartaSuelta } from "../utils/constanst";
  import { loadLocalSets, loadLocalCards } from "../services/localData";
  // Capa de presentación en español. Se aplica AQUÍ, en el servidor y en el
  // punto en el que las cartas salen hacia la interfaz, por dos razones: el
  // diccionario (724 KB en 39 ficheros) no baja al navegador, y las doce
  // pantallas que pintan cartas no tienen que saber que existe un idioma.
  // Nunca se aplica a las lecturas con las que el servidor DECIDE algo (sorteo
  // del sobre, validación del mercado): ésas siguen viendo el dato inglés.
  import {
    nombreSetEs,
    traducirCartas,
    traducirSet,
    traducirSets,
    type Idioma,
  } from "../services/idioma";
  import { idiomaActual, idsPorNombreEspanol } from "../services/idiomaServidor";
  // El sorteo del sobre vive aquí desde que el cliente dejó de generarlo: es la
  // misma economía calibrada que consume scripts/sim-economia.mjs.
  import {
    admiteSobreEstandar,
    admiteSobrePremium,
    openGoldenPack,
    openPremiumPack,
    openStandardPack,
  } from "../utils/packLogic";
  import {
    COPIAS_RESERVADAS,
    OFERTAS_ACTIVAS,
    caducidadDelCiclo,
    copiasEntregables,
    cumpleFiltro,
    generarOfertas,
    pagoDelLote,
    precioDeVenta,
    semillaDelCiclo,
    setDeCarta,
    type CartaMinima,
    type Requisito,
  } from "../utils/mercado";

  /**
   * Traduce al idioma de ESTA petición la lista de cartas que va a salir hacia
   * la interfaz. Único punto donde se resuelve el idioma en este fichero.
   *
   * Devuelve un array MUTABLE: `traducirCartas` devuelve `readonly` para que
   * React no repinte de balde, pero las pantallas ordenan y filtran en sitio.
   * Con idioma inglés devuelve la misma lista sin cargar ningún diccionario.
   */
  async function enIdiomaUsuario(cartas: any[]): Promise<any[]> {
    const idioma = await idiomaActual();
    if (idioma !== "es") return cartas;
    return [...(await traducirCartas(cartas, idioma))];
  }

  // Las columnas y tablas auxiliares (recompensa diaria, tema, lista de deseos y
  // premios de set) se crean una sola vez por instancia, no en cada invocación.
  // Un ALTER TABLE ... ADD COLUMN IF NOT EXISTS toma un candado ACCESS EXCLUSIVE
  // sobre `users` —la tabla más caliente de la app— aunque la columna ya exista;
  // repetirlo en cada cobro, venta o lectura de saldo serializaba todo el tráfico
  // contra ella. Se memoiza en una promesa: si la creación falla, se reintenta.
  let schemaReady: Promise<void> | null = null;
  function ensureSchema(): Promise<void> {
    if (!schemaReady) {
      schemaReady = (async () => {
        await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_daily_claim TIMESTAMP`;
        await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS streak INT DEFAULT 0`;
        await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT`;
        // Idioma de las cartas ("en" | "es"). Igual que `theme`: preferencia de
        // la CUENTA, que pisa a la del dispositivo cuando hay sesión.
        await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS lang TEXT`;
        await sql`
          CREATE TABLE IF NOT EXISTS wishlist (
            user_id TEXT NOT NULL,
            card_id TEXT NOT NULL,
            added_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (user_id, card_id)
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS set_rewards (
            user_id TEXT NOT NULL,
            set_id TEXT NOT NULL,
            rewarded_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (user_id, set_id)
          )
        `;
        // Ofertas del mercado ya cobradas. La PK (usuario, ciclo, oferta) es
        // quien arbitra la carrera: dos pestañas cobrando la misma oferta a la
        // vez chocan en el índice único y sólo una inserta, así que sólo una
        // cobra. `ciclo` es la semilla de mercado.ts, no una fecha: el tablón
        // se deriva de ella y no hace falta guardarlo.
        await sql`
          CREATE TABLE IF NOT EXISTS market_claims (
            user_id TEXT NOT NULL,
            ciclo BIGINT NOT NULL,
            oferta_id TEXT NOT NULL,
            pago INT NOT NULL DEFAULT 0,
            claimed_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (user_id, ciclo, oferta_id)
          )
        `;
        // Recibos de compra de sobres. La PK (usuario, clave) es lo que hace
        // idempotente la compra: la clave la genera el cliente por intento, así
        // que un reenvío choca aquí y no vuelve a cobrar. `cartas` guarda los
        // ids EN ORDEN para poder devolver el mismo sobre en el reenvío.
        await sql`
          CREATE TABLE IF NOT EXISTS pack_purchases (
            user_id TEXT NOT NULL,
            clave TEXT NOT NULL,
            set_id TEXT NOT NULL,
            tipo TEXT NOT NULL,
            cantidad INT NOT NULL DEFAULT 1,
            precio INT NOT NULL DEFAULT 0,
            cartas JSONB NOT NULL DEFAULT '[]'::jsonb,
            bought_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (user_id, clave)
          )
        `;
      })().catch((e) => {
        // No cachear el fallo: la próxima llamada vuelve a intentar la creación.
        schemaReady = null;
        throw e;
      });
    }
    return schemaReady;
  }

  // --- 1. GESTIÓN DE USUARIO Y MONEDAS ---

  export async function getUserData() {
    const { userId } = await auth();
    if (!userId) return null;

    try {
      // Un único upsert idempotente hace de lectura, de creación y de reparación
      // a la vez. Antes eran un SELECT y, si faltaba, un INSERT: dos peticiones
      // simultáneas de un usuario nuevo (home + cabecera + diaria arrancan a la
      // vez) pasaban ambas el SELECT vacío y la segunda reventaba con clave
      // duplicada, devolviendo saldo vacío. El COALESCE además repara filas que
      // syncUserName pudiera haber creado sin `coins`.
      const { rows } = await sql`
        INSERT INTO users (id, coins) VALUES (${userId}, ${STARTING_COINS})
        ON CONFLICT (id) DO UPDATE SET coins = COALESCE(users.coins, ${STARTING_COINS})
        RETURNING coins
      `;
      return { coins: Number(rows[0].coins) };
    } catch (error) {
      console.error("❌ Error getUserData:", error);
      return null;
    }
  }

  // `updateCoins` se eliminó: escribía un total absoluto que llegaba del cliente
  // sin validar, así que cualquiera con sesión podía fijarse el saldo a voluntad
  // (era un endpoint POST vivo por estar exportada en un fichero 'use server').
  //
  // `spendCoinsAction(price)` se eliminó también, y por la misma razón de fondo:
  // era la ÚLTIMA acción que aceptaba un importe de dinero venido del navegador.
  // Restaba de forma atómica, así que lo peor que permitía era que alguien se
  // vaciara su propio saldo —no un robo—, pero desde que la compra del sobre la
  // cobra `comprarSobreAction` ya no tenía ni un consumidor, y un endpoint POST
  // vivo que se fía de una cifra del cliente es exactamente lo que este fichero
  // no puede volver a tener. El dinero sale de aquí sólo por el `coins - $3` de
  // la compra, con el precio calculado en el servidor.

  // --- 2. COMPRA DE SOBRES ---

  /* ==================================================================== *
   * UNA SOLA ACCIÓN PARA COMPRAR UN SOBRE
   * ====================================================================
   *
   * EL AGUJERO QUE CIERRA: antes el navegador sorteaba el sobre con
   * utils/packLogic y llamaba a DOS acciones independientes,
   * `spendCoinsAction(precio)` y `savePackToCollection(cartas)`. Como una
   * server action es un endpoint POST invocable a mano, bastaba con no llamar
   * a la primera. Y la segunda validaba la forma del array y que los ids
   * existieran en `cards`, pero NO que se hubiera pagado, ni que las cartas
   * fueran del set comprado, ni que la composición correspondiera al precio.
   * El retorno del abuso no era un porcentaje: era infinito, y en cualquier
   * expansión. Los filtros que impedían comprar sobres baratos de las
   * colecciones sin morralla (`composicionEspecial` e `isSpecialSet` en
   * app/page.tsx) eran, además, un cinturón de navegador.
   *
   * LO QUE HACE AHORA: el cliente sólo dice QUÉ quiere comprar (set, tipo,
   * cuántos). El precio, el sorteo, el filtro de qué sobres admite el set y el
   * abono los hace el servidor. El dinero y las cartas se mueven en UNA sola
   * sentencia SQL: o se cobra y se entrega, o no pasa nada.
   *
   * IDEMPOTENCIA: cada compra viaja con una clave del cliente y queda anotada
   * en `pack_purchases`, cuya clave primaria (usuario, clave) arbitra la
   * carrera. Un reenvío —doble toque, reintento de red, un POST repetido a
   * mano— no vuelve a cobrar ni a acreditar: devuelve el MISMO sobre.
   */

  /** Los cuatro sobres de la tienda. El cliente sólo puede pedir uno de éstos. */
  const TIPOS_DE_SOBRE = ["STANDARD", "PREMIUM", "GOLDEN", "SPECIAL"] as const;
  type TipoSobre = (typeof TIPOS_DE_SOBRE)[number];

  /** Tope de sobres por compra: la tienda ofrece x1, x5 y x10. */
  const MAX_SOBRES_POR_COMPRA = 10;

  /** Lo mínimo que necesita packLogic para sortear y el cliente para pintar. */
  interface CartaDeSobre {
    id: string;
    name: string;
    rarity: string;
    images: { small: string; large: string };
  }

  /** La columna `images` es JSONB, pero la ingesta antigua guardó cadenas. */
  const aImagenes = (valor: unknown): { small: string; large: string } => {
    let o: any = valor;
    if (typeof o === "string") {
      try {
        o = JSON.parse(o);
      } catch {
        o = null;
      }
    }
    return { small: String(o?.small ?? ""), large: String(o?.large ?? "") };
  };

  const aCartaDeSobre = (fila: any): CartaDeSobre => ({
    id: String(fila.id),
    name: String(fila.name ?? ""),
    // packLogic clasifica por rareza exacta: una rareza nula la dejaría fuera
    // de todos los cubos y la carta sólo saldría por la rama de respaldo.
    rarity: String(fila.rarity ?? "Common"),
    images: aImagenes(fila.images),
  });

  /**
   * Catálogo del set con el que se sortea, cacheado por instancia.
   *
   * Sin caché, cada compra leería las ~250 filas del set, y esa consulta va por
   * delante de la animación de apertura. Las cartas de un set no cambian salvo
   * resiembra, así que un TTL corto basta y de paso recoge solo una resiembra.
   */
  const CATALOGO_TTL_MS = 10 * 60 * 1000;
  const catalogoDeSet = new Map<string, { cartas: CartaDeSobre[]; expira: number }>();

  async function cartasDelSet(setId: string): Promise<CartaDeSobre[]> {
    const guardado = catalogoDeSet.get(setId);
    if (guardado && guardado.expira > Date.now()) return guardado.cartas;

    const leer = async (): Promise<CartaDeSobre[]> => {
      const { rows } = await sql`
        SELECT id, name, rarity, images FROM cards WHERE set_id = ${setId}
      `;
      return rows.map(aCartaDeSobre);
    };

    let cartas = await leer();
    if (cartas.length === 0) {
      // Set todavía sin sembrar. Se siembra AQUÍ y no se sortea contra el JSON
      // local: el abono hace JOIN contra `cards`, así que un sobre generado con
      // ids que aún no están en la tabla se cobraría y no acreditaría nada.
      await syncSetToDatabase(setId);
      cartas = await leer();
    }
    // SÓLO SE CACHEA UN CATÁLOGO COMPLETO. `syncSetToDatabase` inserta las
    // cartas de una en una y ordenadas por número, así que una compra que caiga
    // en mitad de la siembra lee un set a medias y sesgado hacia las comunes.
    // Sortear con eso es un mal sobre; cachearlo son diez minutos de malos
    // sobres para todo el que abra esa expansión en esta instancia.
    const locales = (await loadLocalCards(setId)) as any[];
    if (cartas.length > 0 && cartas.length >= locales.length) {
      catalogoDeSet.set(setId, { cartas, expira: Date.now() + CATALOGO_TTL_MS });
    }
    return cartas;
  }

  /** Nombre, serie y total del set: los tres datos del filtro de la tienda. */
  async function fichaDelSet(
    setId: string,
  ): Promise<{ name: string; series: string | null; total: number } | null> {
    try {
      const { rows } = await sql`SELECT name, series, total FROM sets WHERE id = ${setId}`;
      if (rows.length > 0) {
        return {
          name: String(rows[0].name ?? ""),
          series: rows[0].series ?? null,
          total: Number(rows[0].total),
        };
      }
    } catch (error) {
      console.error("Error leyendo la ficha del set:", error);
    }
    // Mismo respaldo que getSetsFromDB: sin Postgres sembrado, el catálogo del
    // repositorio.
    const locales = (await loadLocalSets()) as any[];
    const local = locales.find((s: any) => s?.id === setId);
    return local
      ? { name: String(local.name ?? ""), series: local.series ?? null, total: Number(local.total) }
      : null;
  }

  /**
   * Colección "sin morralla". Es `composicionEspecial` de app/page.tsx palabra
   * por palabra, pero medida contra las cartas de la BASE DE DATOS, que es lo
   * único que el usuario no puede tocar.
   */
  const composicionEspecial = (cartas: CartaDeSobre[]): boolean => {
    if (cartas.length === 0) return false;
    const comunes = cartas.filter((c) => c.rarity === "Common").length;
    const relleno = cartas.filter(
      (c) => c.rarity === "Common" || c.rarity === "Uncommon",
    ).length;
    return comunes < 8 || relleno / cartas.length < 0.2;
  };

  /**
   * Qué sobres se pueden vender de este set. Es el `isSpecialSet` de la tienda
   * (nombre, serie, total y composición) MÁS la comprobación medida de
   * packLogic, que calibra el sobre contra su propio precio.
   *
   * POR QUÉ LOS DOS Y NO SÓLO UNO: `isSpecialSet` es el que decide qué pinta la
   * tienda, y si el servidor fuera más estricto habría botones que fallan al
   * pulsarlos; `admiteSobreEstandar`/`admiteSobrePremium` son una MEDIDA y no
   * dependen de que el nombre lleve la palabra "gallery". Comprobado sobre los
   * 39 sets del repositorio: no hay ni un desacuerdo en la dirección peligrosa
   * (ningún set que la tienda ofrezca a 50 lo rechaza packLogic), así que
   * sumarlos no rompe ninguna compra legítima y cada uno tapa el hueco del otro.
   */
  function sobresPermitidos(
    ficha: { name: string; series: string | null; total: number },
    cartas: CartaDeSobre[],
  ): Set<TipoSobre> {
    const nombre = ficha.name.toLowerCase();
    /* OJO AL TOTAL, que es un `> 0 &&` y no un `Number.isFinite`.
     *
     * `fichaDelSet` hace `Number(rows[0].total)`, y `Number(null)` es 0, no NaN:
     * `Number.isFinite(0)` es true, así que el guard anterior NO protegía de lo
     * que su propio comentario decía proteger. Una columna `total` vacía —que
     * la ingesta puede dejar así, escribe `s.total ?? null`— caía en `0 < 69` y
     * la expansión quedaba marcada de especial.
     *
     * Y eso rompía la tienda de la peor manera posible: en el cliente
     * `typeof null === "object"`, así que allí NO se marcaba de especial y se
     * pintaban los tres sobres normales... que aquí se rechazaban uno por uno
     * con "ese sobre no está a la venta". Botones que fallan al pulsarlos.
     * El cliente aplica ahora exactamente esta misma condición.
     */
    const especial =
      nombre.includes("promos") ||
      nombre.includes("gallery") ||
      ficha.series === "POP" ||
      ficha.series === "Other" ||
      (ficha.total > 0 && ficha.total < 69) ||
      composicionEspecial(cartas);

    if (especial) return new Set<TipoSobre>(["SPECIAL"]);

    const permitidos = new Set<TipoSobre>(["GOLDEN"]);
    if (admiteSobreEstandar(cartas)) permitidos.add("STANDARD");
    if (admiteSobrePremium(cartas)) permitidos.add("PREMIUM");
    return permitidos;
  }

  /** Ids del set que el usuario YA tiene: la garantía del Leyenda sale de aquí. */
  async function idsPoseidosDelSet(userId: string, setId: string): Promise<string[]> {
    const { rows } = await sql`
      SELECT uc.card_id
      FROM user_collection uc
      JOIN cards c ON c.id = uc.card_id
      WHERE uc.user_id = ${userId} AND uc.quantity > 0 AND c.set_id = ${setId}
    `;
    return rows.map((r: any) => String(r.card_id));
  }

  /**
   * Sortea `cantidad` sobres seguidos. El acumulador de poseídas es el mismo
   * truco del x10 del cliente: sin él, diez sobres Leyenda garantizarían diez
   * veces la MISMA carta nueva.
   */
  function sortearSobres(
    tipo: TipoSobre,
    cantidad: number,
    cartas: CartaDeSobre[],
    poseidas: string[],
  ): CartaDeSobre[] {
    const combinado: CartaDeSobre[] = [];
    const mias = new Set(poseidas);
    for (let i = 0; i < cantidad; i++) {
      let sobre: CartaDeSobre[];
      if (tipo === "STANDARD") sobre = openStandardPack(cartas);
      else if (tipo === "PREMIUM") sobre = openPremiumPack(cartas);
      // El Promo Pack (SPECIAL) es el mismo sorteo que el Leyenda a otro precio.
      else sobre = openGoldenPack(cartas, Array.from(mias));
      combinado.push(...sobre);
      sobre.forEach((c) => mias.add(c.id));
    }
    return combinado;
  }

  /** Rehidrata por id un sobre ya servido (reenvío) desde el catálogo maestro. */
  async function cartasPorId(ids: string[]): Promise<CartaDeSobre[]> {
    if (ids.length === 0) return [];
    const unicos = Array.from(new Set(ids));
    const { rows } = await sql.query(
      `SELECT id, name, rarity, images FROM cards WHERE id = ANY($1::text[])`,
      [unicos],
    );
    const porId = new Map<string, CartaDeSobre>();
    rows.forEach((r: any) => porId.set(String(r.id), aCartaDeSobre(r)));
    // Se respeta el ORDEN guardado: la carta garantizada del Leyenda va al
    // final y la vista la anuncia por su posición.
    return ids
      .map((id) => porId.get(id))
      .filter((c): c is CartaDeSobre => c !== undefined);
  }

  /**
   * Compra un sobre (o `cantidad` de golpe): cobra, sortea, guarda y devuelve
   * las cartas y el saldo resultante. Es la ÚNICA forma de conseguir cartas con
   * sesión iniciada.
   *
   * @param clave identificador de ESTE intento de compra, generado por el
   *              cliente. Dos envíos con la misma clave cobran una sola vez.
   */
  export async function comprarSobreAction(
    setId: string,
    tipo: string,
    cantidad: number,
    clave: string,
  ) {
    const { userId } = await auth();
    if (!userId) return { ok: false as const, motivo: "sin-sesion" as const };

    // Todo lo que llega del cliente es un deseo, no un dato: se valida la forma
    // antes de tocar nada.
    if (typeof setId !== "string" || !/^[a-z0-9._-]{1,40}$/i.test(setId)) {
      return { ok: false as const, motivo: "set-invalido" as const };
    }
    if (!TIPOS_DE_SOBRE.includes(tipo as TipoSobre)) {
      return { ok: false as const, motivo: "tipo-invalido" as const };
    }
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_SOBRES_POR_COMPRA) {
      return { ok: false as const, motivo: "cantidad-invalida" as const };
    }
    if (typeof clave !== "string" || !/^[A-Za-z0-9._:-]{8,64}$/.test(clave)) {
      return { ok: false as const, motivo: "clave-invalida" as const };
    }

    const tipoSobre = tipo as TipoSobre;
    // EL PRECIO SE CALCULA AQUÍ. El cliente no lo manda ni lo puede sugerir.
    const precio = PACK_PRICES[tipoSobre] * cantidad;

    try {
      await ensureSchema();

      const cartas = await cartasDelSet(setId);
      if (cartas.length === 0) return { ok: false as const, motivo: "set-invalido" as const };

      const ficha = await fichaDelSet(setId);
      if (!ficha) return { ok: false as const, motivo: "set-invalido" as const };
      if (!sobresPermitidos(ficha, cartas).has(tipoSobre)) {
        return { ok: false as const, motivo: "sobre-no-disponible" as const };
      }

      // La lista de "las que ya tengo" sale de la BD, no del navegador: si la
      // pusiera el cliente, mandar una lista vacía convertiría cada Leyenda en
      // una carta nueva garantizada aunque tuviera la colección completa.
      const poseidas =
        tipoSobre === "GOLDEN" || tipoSobre === "SPECIAL"
          ? await idsPoseidosDelSet(userId, setId)
          : [];

      const sobre = sortearSobres(tipoSobre, cantidad, cartas, poseidas);
      // draw() devuelve un centinela 'MissingNo' si se quedara sin cartas. No
      // debería pasar con el catálogo cargado, pero si pasara el JOIN del abono
      // lo descartaría y el usuario pagaría por menos cartas de las que ve.
      if (sobre.length === 0 || sobre.some((c) => c.id === "error")) {
        console.error("Sorteo inválido para", setId, tipoSobre);
        return { ok: false as const, motivo: "error" as const };
      }

      // Repeticiones por id: un sobre puede traer la misma carta dos veces.
      const porCarta = new Map<string, number>();
      for (const c of sobre) porCarta.set(c.id, (porCarta.get(c.id) ?? 0) + 1);
      const ids = Array.from(porCarta.keys());
      const cuentas = ids.map((id) => porCarta.get(id)!);
      const orden = sobre.map((c) => c.id);

      /* ---------------------------------------------------------------- *
       * EL COBRO, EL RECIBO Y EL ABONO, EN UNA SOLA SENTENCIA
       * ----------------------------------------------------------------
       * Las tres partes son CTE de la misma sentencia, así que comparten
       * transacción implícita: o cuajan las tres o no cuaja ninguna. Si el
       * proceso muere a mitad (timeout, deploy, corte) no queda ni un cobro sin
       * cartas ni unas cartas sin cobro.
       *
       * `cobro` es el árbitro y lleva las tres condiciones:
       *   - `coins >= precio` impide saldos negativos y compras sin fondos;
       *   - `NOT EXISTS ... pack_purchases` impide cobrar dos veces la misma
       *     clave. Los CTE ven la instantánea PREVIA a la sentencia, así que
       *     esta comprobación no ve el INSERT de `recibo`, que es justo lo que
       *     hace falta;
       *   - el propio UPDATE relee la fila ya bloqueada, así que dos compras
       *     simultáneas no pueden leer las dos el mismo saldo.
       *
       * `recibo` y `abono` cuelgan de `cobro` con un EXISTS: sin cobro no se
       * anota el sobre ni se acredita nada. Y como `recibo` no lleva ON
       * CONFLICT, dos peticiones IDÉNTICAS a la vez (que ambas pasan el NOT
       * EXISTS por ver la misma instantánea) chocan en la clave primaria: la
       * perdedora aborta la sentencia ENTERA y su cobro se deshace. Ese choque
       * se recoge abajo y se responde como reenvío.
       *
       * El JOIN contra `cards` del abono sigue siendo la validación de que la
       * carta existe de verdad; aquí no puede fallar porque el sobre se sorteó
       * con filas de esa misma tabla, pero se comprueba el recuento por si acaso.
       * ---------------------------------------------------------------- */
      const { rows } = await sql.query(
        `WITH cobro AS (
           UPDATE users
              SET coins        = coins - $3,
                  packs_opened = COALESCE(packs_opened, 0) + $4,
                  money_spent  = COALESCE(money_spent, 0) + $3
            WHERE id = $1
              AND coins >= $3
              AND NOT EXISTS (
                    SELECT 1 FROM pack_purchases WHERE user_id = $1 AND clave = $2
                  )
           RETURNING coins
         ),
         recibo AS (
           INSERT INTO pack_purchases (user_id, clave, set_id, tipo, cantidad, precio, cartas)
           SELECT $1::text, $2::text, $5::text, $6::text, $4::int, $3::int, $7::jsonb
            WHERE EXISTS (SELECT 1 FROM cobro)
           RETURNING 1
         ),
         abono AS (
           INSERT INTO user_collection (user_id, card_id, quantity)
           SELECT $1::text, x.id, x.cnt
             FROM unnest($8::text[], $9::int[]) AS x(id, cnt)
             JOIN cards c ON c.id = x.id
            WHERE EXISTS (SELECT 1 FROM cobro)
           ON CONFLICT (user_id, card_id)
           DO UPDATE SET quantity = user_collection.quantity + EXCLUDED.quantity
           RETURNING 1
         )
         -- Sin FROM: la sentencia devuelve siempre exactamente una fila, con
         -- coins a NULL si no hubo cobro. Y cobro toca como mucho una fila
         -- (filtra por la clave primaria de users), asi que la subconsulta
         -- escalar no puede reventar por devolver de mas.
         SELECT (SELECT coins FROM cobro)         AS coins,
                (SELECT count(*)::int FROM abono) AS abonadas`,
        [userId, clave, precio, cantidad, setId, tipoSobre, JSON.stringify(orden), ids, cuentas],
      );

      const saldo = rows[0]?.coins;
      if (saldo === null || saldo === undefined) {
        // No hubo cobro: o la clave ya se sirvió (reenvío) o no había saldo.
        const servido = await sobreYaServido(userId, clave);
        return servido ?? { ok: false as const, motivo: "sin-saldo" as const };
      }

      if (Number(rows[0]?.abonadas ?? 0) !== ids.length) {
        // Sólo puede pasar si alguien borra cartas del catálogo entre el sorteo
        // y el abono. No se deshace nada (el usuario tiene el resto), pero deja
        // rastro: significa que el catálogo se está moviendo bajo los pies.
        console.error(
          "Abono incompleto del sobre",
          setId,
          tipoSobre,
          ids.length,
          rows[0]?.abonadas,
        );
      }

      await podarRecibosViejos(userId);
      revalidatePath('/');
      revalidatePath('/collection');
      return {
        ok: true as const,
        cartas: sobre,
        coins: Number(saldo),
        precio,
        reenvio: false,
      };
    } catch (error: any) {
      // 23505 = clave duplicada en pack_purchases: dos envíos idénticos a la
      // vez. La sentencia entera se deshizo, así que el cobro de ESTA petición
      // no ocurrió; el sobre bueno es el que anotó la que ganó. Se mira también
      // el texto porque no todos los controladores propagan el `code`, y mirar
      // de más no hace daño: si no hay recibo, se cae al error genérico.
      const duplicada =
        error?.code === "23505" || /duplicate key|pack_purchases/i.test(String(error?.message ?? ""));
      if (duplicada) {
        try {
          const servido = await sobreYaServido(userId, clave);
          if (servido) return servido;
        } catch (e) {
          console.error("Error recuperando el sobre ya servido:", e);
        }
      }
      console.error("Error comprando el sobre:", error);
      return { ok: false as const, motivo: "error" as const };
    }
  }

  /** El sobre de esta clave ya se cobró: se devuelve tal cual, sin cobrar más. */
  async function sobreYaServido(userId: string, clave: string) {
    const { rows } = await sql`
      SELECT p.cartas, p.precio, u.coins
      FROM pack_purchases p
      JOIN users u ON u.id = p.user_id
      WHERE p.user_id = ${userId} AND p.clave = ${clave}
    `;
    if (rows.length === 0) return null;
    const guardadas = rows[0].cartas;
    const ids: string[] = Array.isArray(guardadas)
      ? guardadas.map((x: unknown) => String(x))
      : (JSON.parse(String(guardadas ?? "[]")) as string[]);
    return {
      ok: true as const,
      cartas: await cartasPorId(ids),
      coins: Number(rows[0].coins ?? 0),
      precio: Number(rows[0].precio ?? 0),
      reenvio: true,
    };
  }

  /**
   * Los recibos sólo hacen falta mientras un reenvío sea plausible (segundos).
   * Se podan de vez en cuando, y sólo los del propio usuario, para que la tabla
   * no crezca sin fin.
   *
   * SE ESPERA, aunque no sea parte de la compra. Antes se lanzaba sin `await`
   * confiando en que la consulta viajara sola, pero en serverless la función se
   * congela en cuanto devuelve la respuesta: la promesa quedaba a medias y la
   * poda no llegaba a ejecutarse casi nunca, así que `pack_purchases` —que
   * guarda las cartas de cada sobre en JSONB— crecía sin límite. Cuesta un
   * viaje el 2% de las compras, y el fallo no puede tumbarla.
   */
  async function podarRecibosViejos(userId: string) {
    if (Math.random() > 0.02) return;
    try {
      await sql`
        DELETE FROM pack_purchases
        WHERE user_id = ${userId} AND bought_at < NOW() - INTERVAL '2 days'
      `;
    } catch (e) {
      console.error("poda de recibos:", e);
    }
  }

  // `savePackToCollection` se eliminó: acreditaba en la colección cualquier
  // lista de ids que existiera en `cards` SIN comprobar que se hubiera pagado
  // por ellos, y como toda función exportada de un fichero 'use server' es un
  // endpoint POST vivo, eso eran cartas gratis e ilimitadas para cualquiera con
  // sesión. Las cartas se consiguen ahora por `comprarSobreAction`, que cobra y
  // acredita en la misma sentencia.

  // --- 3. GESTIÓN DE LA COLECCIÓN ---

  export async function getFullCollection() {
    const { userId } = await auth();
    if (!userId) return [];

    try {
      /* ORDEN: favoritas, luego rareza de mejor a peor, luego nombre.
       *
       * `ORDER BY c.rarity DESC` ordenaba CADENAS, no rarezas: "Uncommon"
       * acababa por encima de "Special Illustration Rare" porque la U va
       * después de la S. La pantalla de colección lo disimulaba reordenando en
       * el cliente con RARITY_RANK, pero quien lee esto sin reordenar —y el
       * selector de intercambio, que hace lo mismo en app/social.ts— se
       * encontraba una lista aparentemente aleatoria.
       *
       * El rango viaja como tabla parametrizada (unnest) en vez de un CASE
       * concatenado: RARITY_RANK es la única fuente del criterio y así no hay
       * que reescribirlo en SQL cada vez que se toca.
       *
       * COALESCE en is_favorite: la columna admite NULL y `NULL DESC` va
       * PRIMERO en Postgres, así que sin esto las cartas que nunca han pasado
       * por el botón de favorito se colaban por delante de las favoritas.
       */
      const rarezas = Object.keys(RARITY_RANK);
      const rangos = rarezas.map((r) => RARITY_RANK[r]);
      const { rows } = await sql.query(
        `SELECT c.*, uc.quantity, uc.is_favorite
           FROM user_collection uc
           JOIN cards c ON uc.card_id = c.id
           LEFT JOIN unnest($2::text[], $3::int[]) AS rk(rareza, rango)
             ON rk.rareza = c.rarity
          WHERE uc.user_id = $1 AND uc.quantity > 0
          ORDER BY
            COALESCE(uc.is_favorite, false) DESC,
            COALESCE(rk.rango, 0) DESC,
            c.name ASC`,
        [userId, rarezas, rangos],
      );
      
      const parse = (v: any, fb: any = null) => {
        if (v == null) return fb;
        return typeof v === 'string' ? JSON.parse(v) : v;
      };
      // El álbum, la colección y el buscador local de la colección leen `name`
      // e `images` de aquí: traducir en este `return` los pone en español de
      // una vez. `id`, `rarity` y `quantity` salen intactos, que es lo que
      // miran la venta y los bonos de expansión.
      return enIdiomaUsuario(
        rows.map((row: any) => ({
          ...row,
          images: parse(row.images),
          tcgplayer: parse(row.tcgplayer),
          types: parse(row.types, []),
          attacks: parse(row.attacks, []),
          weaknesses: parse(row.weaknesses, []),
          retreatCost: parse(row.retreat_cost, []),
          flavorText: row.flavor_text,
        })),
      );
    } catch (error) {
      console.error("❌ Error cargando colección:", error);
      return [];
    }
  }

  // --- 3. ACCIONES DE JUEGO (Vender / Favoritos) ---

  /**
   * Vende una copia sobrante. El precio lo calcula el SERVIDOR a partir de la
   * rareza guardada en la base de datos.
   *
   * Antes llegaba como parámetro desde el navegador y se acreditaba tal cual:
   * como las server actions son endpoints POST, cualquiera con sesión podía
   * pedir `coins + 999999999` (o negativo, y dejar el saldo bajo cero). El
   * cliente ya no decide cuánto vale una carta.
   *
   * El precio depende ahora de CUÁNTAS copias hay (valorDeVenta), así que la
   * cantidad se lee de la colección y no basta con la rareza. Se vende siempre
   * la copia de índice más alto, la más barata.
   *
   * Devuelve lo ganado y el saldo resultante, o null si no había copia sobrante.
   */
  export async function sellCardAction(cardId: string) {
    const { userId } = await auth();
    if (!userId) return null;

    try {
      const { rows: info } = await sql`
        SELECT uc.quantity, c.rarity
        FROM user_collection uc JOIN cards c ON c.id = uc.card_id
        WHERE uc.user_id = ${userId} AND uc.card_id = ${cardId}
      `;
      if (info.length === 0) return null;
      const cantidad = Number(info[0].quantity);
      const price = valorDeVenta(info[0].rarity, cantidad, 1);
      if (price <= 0) return null; // copia única: no hay nada que vender

      // Descuento y abono en UNA sola sentencia (CTE): o pasan los dos o ninguno.
      // En dos sentencias separadas, si el proceso moría entre medias (timeout,
      // deploy, corte) la copia desaparecía sin abono. El abono sólo ocurre si la
      // venta tocó una fila (EXISTS), y la condición `quantity > 1` protege la
      // última copia sin ventana entre lectura y escritura.
      //
      // El guard es `quantity = ${cantidad}` y no `> 1` porque el precio se
      // calculó CON esa cantidad: si otra pestaña vendió entretanto, la copia
      // que queda vale otra cosa y pagar la tarifa vieja sería pagar de más.
      const { rows } = await sql`
        WITH venta AS (
          UPDATE user_collection
          SET quantity = quantity - 1
          WHERE user_id = ${userId} AND card_id = ${cardId}
            AND quantity = ${cantidad} AND quantity > 1
          RETURNING 1
        )
        UPDATE users SET coins = coins + ${price}
        WHERE id = ${userId} AND EXISTS (SELECT 1 FROM venta)
        RETURNING coins
      `;
      if (rows.length === 0) return null;

      revalidatePath('/');
      revalidatePath('/collection');
      return { earned: price, coins: Number(rows[0]?.coins ?? 0) };
    } catch (error) {
      console.error("Error vendiendo carta:", error);
      return null;
    }
  }

  // En src/app/action.ts

  export async function toggleFavorite(cardId: string) {
    // 🔴 ¡IMPORTANTE! El 'await' aquí es OBLIGATORIO en versiones nuevas
    const { userId } = await auth(); 
    
    if (!userId) return { error: "No estás logueado" };

    try {
      // 1. Verificamos estado actual
      const currentStatus = await sql`
        SELECT is_favorite FROM user_collection
        WHERE user_id = ${userId} AND card_id = ${cardId} AND quantity > 0
      `;

      // Si no encuentra la carta, es que no la tienes
      if (currentStatus.rowCount === 0) return { error: "No tienes esta carta" };

      const isFav = currentStatus.rows[0]?.is_favorite || false;

      if (!isFav) {
        // Al ACTIVAR, el límite de 10 va dentro del propio UPDATE: comprobarlo
        // antes en una consulta aparte dejaba una ventana en la que dos pestañas
        // pasaban el recuento con 9 favoritos y acababan en 11. La subconsulta se
        // evalúa de forma atómica con la escritura; si ya hay 10, no toca fila.
        const upd = await sql`
          UPDATE user_collection
          SET is_favorite = true
          WHERE user_id = ${userId} AND card_id = ${cardId} AND quantity > 0
            AND 10 > (
              SELECT count(*) FROM user_collection
              WHERE user_id = ${userId} AND is_favorite = true AND quantity > 0
            )
        `;
        if (upd.rowCount === 0) return { error: "¡Límite de 10 favoritos alcanzado!" };
      } else {
        await sql`
          UPDATE user_collection
          SET is_favorite = false
          WHERE user_id = ${userId} AND card_id = ${cardId}
        `;
      }

      revalidatePath('/collection');
      return { success: true, isFavorite: !isFav };

    } catch (error) {
      console.error("Error toggleFavorite:", error); // 👈 Mira la terminal de VSCode si falla
      return { error: "Error interno del servidor" };
    }
  }

  // --- 4. HERRAMIENTAS DE SINCRONIZACIÓN (Opcional si usas JSON local) ---

  /**
   * Siembra las cartas de una expansión desde el catálogo del repositorio.
   *
   * YA NO SE EXPORTA, Y ESO ES EL ARREGLO. Toda función exportada de un fichero
   * 'use server' es un endpoint POST vivo, así que mientras lo estuvo cualquiera
   * con una cuenta podía pedir la siembra de un set a voluntad: ~250 INSERT de
   * uno en uno por llamada. Su único llamador del navegador era `loadAndSync`
   * en app/page.tsx, que la disparaba en CADA cambio de expansión aunque el set
   * ya estuviera sembrado; se ha retirado de allí, y el único que la necesita de
   * verdad es `cartasDelSet`, aquí mismo, justo antes de sortear un sobre.
   *
   * (Se llama desde arriba, en la línea ~264: las declaraciones de función se
   * elevan, así que el orden en el fichero da igual.)
   *
   * Nunca se fía de lo que le manden: reconstruye las cartas desde el catálogo
   * local, que valida el setId contra el directorio de datos. Un setId inventado
   * no casa con ningún fichero y no siembra nada.
   */
  async function syncSetToDatabase(setId: string) {
    try {
      const cards = (await loadLocalCards(setId)) as any[];
      if (cards.length === 0) return { status: 'unknown_set' };

      const { count } = (await sql`SELECT count(*) FROM cards WHERE set_id = ${setId}`).rows[0];

      /* SE COMPARA CONTRA EL CATÁLOGO, NO CONTRA CERO.
       *
       * Antes bastaba `count > 0` para darlo por sembrado, y eso convertía
       * cualquier siembra interrumpida en permanente: si los ~250 INSERT de
       * abajo se cortan a mitad (esto corre DENTRO de la compra de un sobre, con
       * su límite de tiempo), el set se queda con un catálogo parcial —y
       * sesgado, porque loadLocalCards devuelve ordenado por número— contra el
       * que se sortearían todos los sobres siguientes. Ningún reintento lo
       * completaba: el primer `count > 0` lo daba por bueno.
       *
       * Con la comparación contra `cards.length` la siembra es reanudable: cada
       * intento rellena lo que falte y el ON CONFLICT DO NOTHING hace que
       * repetir no cueste nada.
       */
      if (parseInt(count) >= cards.length) return { status: 'already_synced' };

      for (const card of cards) {
        await sql`
          INSERT INTO cards (id, name, rarity, images, set_id, number, artist, flavor_text, tcgplayer)
          VALUES (
            ${card.id}, ${card.name}, ${card.rarity || 'Common'},
            ${JSON.stringify(card.images)}, ${setId}, ${card.number || '???'},
            ${card.artist || 'Artista Desconocido'}, ${card.flavorText || ''},
            ${JSON.stringify(card.tcgplayer || {})}
          ) ON CONFLICT (id) DO NOTHING;
        `;
      }

      return { status: 'success' };
    } catch (error) {
      console.error("Error sincronizando set:", error);
      return { status: 'error' };
    }
  }
  /**
   * Vende TODAS las copias sobrantes de UNA carta, dejando una. El importe sale
   * de la rareza y la cantidad guardadas en la base de datos, no del cliente.
   *
   * Para vaciar los duplicados de la colección entera está
   * `sellAllDuplicatesBulkAction`: llamar a ésta en bucle son cientos de
   * peticiones simultáneas y cuelga el navegador.
   */
  export async function sellAllDuplicatesAction(cardId: string) {
    const { userId } = await auth();
    if (!userId) return { success: false, error: "No autorizado" };

    try {
      const { rows: info } = await sql`
        SELECT uc.quantity, c.rarity
        FROM user_collection uc JOIN cards c ON c.id = uc.card_id
        WHERE uc.user_id = ${userId} AND uc.card_id = ${cardId}
      `;
      if (info.length === 0) return { success: false, error: "No tienes la carta" };

      const duplicates = Number(info[0].quantity) - 1;
      if (duplicates <= 0) return { success: false, error: "No tienes duplicados" };

      // No es duplicados × precio: cada copia vale menos que la anterior.
      const totalEarned = valorDeVenta(info[0].rarity, Number(info[0].quantity));

      // Descuento y abono en una sola sentencia (CTE): la venta se condiciona a
      // la cantidad leída (si otra pestaña vendió entretanto, no toca fila) y el
      // abono sólo ocurre si la venta tocó una fila. Así no se paga dos veces ni
      // se pierde la carta si el proceso muere entre ambas escrituras.
      const { rows } = await sql`
        WITH venta AS (
          UPDATE user_collection SET quantity = 1
          WHERE user_id = ${userId} AND card_id = ${cardId} AND quantity = ${info[0].quantity}
          RETURNING 1
        )
        UPDATE users SET coins = coins + ${totalEarned}
        WHERE id = ${userId} AND EXISTS (SELECT 1 FROM venta)
        RETURNING coins
      `;
      if (rows.length === 0) return { success: false, error: "La carta cambió, inténtalo de nuevo" };

      revalidatePath('/');
      revalidatePath('/collection');
      return { success: true, sold: duplicates, earned: totalEarned, coins: Number(rows[0]?.coins ?? 0) };
    } catch (error) {
      console.error("Error vendiendo todo:", error);
      return { success: false, error: "Error en servidor" };
    }
  }

  /**
   * VACÍA LOS DUPLICADOS DE TODA LA COLECCIÓN de una vez.
   *
   * POR QUÉ EXISTE: la pantalla de colección hacía
   * `Promise.all(duplicados.map((c) => sellAllDuplicatesAction(c.id)))`, o sea
   * UNA server action por carta lanzadas todas a la vez. Con una expansión
   * completa son cientos de POST simultáneos: el navegador los encola de seis
   * en seis, el pool de Postgres se satura y la interfaz se queda congelada
   * varios minutos. Ahora es una sola petición y UNA sola sentencia.
   *
   * QUÉ SE PROTEGE (y se protege AQUÍ, no en el cliente, que es quien no manda):
   *  - favoritas: no se tocan (`is_favorite`), igual que antes;
   *  - la última copia: `quantity = 1` deja siempre una en el álbum;
   *  - el importe: lo calcula valorDeVenta contra la rareza y la cantidad de la
   *    BD. El cliente no manda ni ids ni precios, así que no hay nada que
   *    falsificar: la lista de cartas a vender sale del propio SELECT.
   *
   * POR QUÉ NO PUEDE COBRAR DOS VECES: el descuento y el abono van en la misma
   * sentencia, y cada fila sólo se vende si su `quantity` sigue siendo la que
   * se leyó (`uc.quantity = e.cantidad`). Dos toques seguidos: el segundo llega
   * cuando las filas ya valen 1, no casa ninguna, la suma es 0 y se abona 0. Si
   * los dos entran a la vez, el segundo se bloquea en el candado de fila del
   * primero y al despertar reevalúa la condición contra la fila YA actualizada
   * (READ COMMITTED), así que tampoco casa. El abono es exactamente la suma de
   * los valores de las filas que DE VERDAD se descontaron, ni una moneda más.
   */
  export async function sellAllDuplicatesBulkAction() {
    const { userId } = await auth();
    if (!userId) return { success: false as const, error: "No autorizado" };

    try {
      // Sólo lo que sobra y no está protegido. El ORDER BY es para que la
      // lista (y por tanto el `ids` que se devuelve) salga siempre igual, no
      // para ordenar candados: dos vaciados simultáneos del mismo usuario los
      // impide el cerrojo del cliente, y si aun así se cruzaran, el guard de
      // cantidad deja al segundo sin vender nada en vez de cobrar dos veces.
      const { rows } = await sql`
        SELECT uc.card_id, uc.quantity, c.rarity
        FROM user_collection uc
        JOIN cards c ON c.id = uc.card_id
        WHERE uc.user_id = ${userId}
          AND uc.quantity > 1
          AND COALESCE(uc.is_favorite, false) = false
        ORDER BY uc.card_id
      `;
      if (rows.length === 0) {
        const { rows: saldo } = await sql`SELECT coins FROM users WHERE id = ${userId}`;
        return {
          success: true as const,
          sold: 0,
          earned: 0,
          ids: [] as string[],
          coins: Number(saldo[0]?.coins ?? 0),
        };
      }

      const ids: string[] = [];
      const cantidades: number[] = [];
      const valores: number[] = [];
      for (const row of rows) {
        const cantidad = Number(row.quantity);
        const valor = valorDeVenta(row.rarity, cantidad);
        if (valor <= 0) continue;
        ids.push(row.card_id);
        cantidades.push(cantidad);
        valores.push(valor);
      }
      if (ids.length === 0) {
        const { rows: saldo } = await sql`SELECT coins FROM users WHERE id = ${userId}`;
        return {
          success: true as const,
          sold: 0,
          earned: 0,
          ids: [] as string[],
          coins: Number(saldo[0]?.coins ?? 0),
        };
      }

      // UNA sentencia: venta, suma y abono. `esperado` viaja parametrizado con
      // unnest (nada concatenado en la cadena). `venta` devuelve el valor de
      // cada fila que realmente se descontó —de `esperado`, porque en un
      // UPDATE ... FROM el RETURNING de la tabla actualizada ya trae los
      // valores NUEVOS y `uc.quantity` valdría 1— y `total` los suma. El abono
      // va después y no puede desviarse de esa suma.
      const { rows: resultado } = await sql.query(
        `WITH esperado AS (
           SELECT * FROM unnest($2::text[], $3::int[], $4::int[]) AS t(card_id, cantidad, valor)
         ),
         venta AS (
           UPDATE user_collection uc
           SET quantity = 1
           FROM esperado e
           WHERE uc.user_id = $1
             AND uc.card_id = e.card_id
             AND uc.quantity = e.cantidad
             AND uc.quantity > 1
             AND COALESCE(uc.is_favorite, false) = false
             -- Sin fila en users el abono no tocaría nada y las cartas
             -- desaparecerían gratis.
             AND EXISTS (SELECT 1 FROM users WHERE id = $1)
           RETURNING e.card_id AS card_id, e.valor AS valor, e.cantidad - 1 AS copias
         ),
         total AS (
           SELECT
             COALESCE(SUM(valor), 0)::int AS ganado,
             COALESCE(SUM(copias), 0)::int AS copias,
             COALESCE(array_agg(card_id), ARRAY[]::text[]) AS ids
           FROM venta
         )
         UPDATE users
         SET coins = COALESCE(coins, 0) + (SELECT ganado FROM total)
         WHERE id = $1
         RETURNING
           coins,
           (SELECT ganado FROM total) AS ganado,
           (SELECT copias FROM total) AS copias,
           (SELECT ids FROM total) AS ids`,
        [userId, ids, cantidades, valores],
      );
      if (resultado.length === 0) return { success: false as const, error: "Error en servidor" };

      const vendidas = Number(resultado[0].copias ?? 0);
      if (vendidas > 0) {
        revalidatePath('/');
        revalidatePath('/collection');
      }
      return {
        success: true as const,
        sold: vendidas,
        earned: Number(resultado[0].ganado ?? 0),
        ids: (resultado[0].ids ?? []) as string[],
        coins: Number(resultado[0].coins ?? 0),
      };
    } catch (error) {
      console.error("Error vendiendo duplicados en lote:", error);
      return { success: false as const, error: "Error en servidor" };
    }
  }
  // src/app/action.ts
  // src/app/action.ts

  export async function getSetsFromDB() {
    try {
      // `cardsCount` es el número de cartas que EXISTEN de la expansión, que es
      // contra lo que se colecciona. `total` es lo que el set DICE tener y no
      // coincide: viene inflado de la API y además la ingesta es reanudable, así
      // que un set a medio descargar tiene menos filas que su total declarado.
      // Midiendo el progreso contra el declarado, esas expansiones no llegaban
      // al 100% ni consiguiéndolas todas.
      //
      // Se devuelven LOS DOS: `total` sigue haciendo falta tal cual en la tienda
      // (`isSpecialSet` decide con él si la expansión sólo vende Promo Pack, y
      // ahí un conteo a medias la marcaría de especial por error).
      const { rows } = await sql`
        SELECT s.id, s.name, s.series, s.images, s.total, s.release_date,
               COUNT(c.id)::int AS cards_count
        FROM sets s
        LEFT JOIN cards c ON c.set_id = s.id
        GROUP BY s.id, s.name, s.series, s.images, s.total, s.release_date
        ORDER BY s.release_date DESC NULLS LAST
      `;

      // Si la tabla está vacía todavía no se ha ejecutado el seed.
      if (rows.length === 0) return setsEnIdioma(await loadLocalSets());

      return setsEnIdioma(rows.map(set => ({
        ...set,
        releaseDate: set.release_date,
        cardsCount: Number(set.cards_count) || 0,
        images: typeof set.images === 'string' ? JSON.parse(set.images) : set.images
      })));
    } catch (error) {
      // Sin Postgres configurado servimos el catálogo del repositorio.
      console.error("Error al obtener sets, uso el JSON local:", error);
      return setsEnIdioma(await loadLocalSets());
    }
  }

  /**
   * Nombre y logo españoles de una lista de expansiones. `traducirSets` es
   * SÍNCRONA (el nombre y el logo viven en el índice estático, no en el
   * diccionario de cartas), así que traducir las 39 no descarga nada.
   *
   * Conserva `nameEn`: la tienda de la portada decide con el NOMBRE INGLÉS qué
   * sobres ofrece ("promos", "gallery"), y ese filtro no puede depender del
   * idioma en el que el usuario esté mirando la app.
   */
  async function setsEnIdioma(sets: any[]): Promise<any[]> {
    const idioma = await idiomaActual();
    if (idioma !== "es") return sets;
    return [...traducirSets(sets, idioma)];
  }
  // Añade esto al final de tu src/app/action.ts

  export async function getTrainerCollection(trainerId: string) {
    // El perfil de entrenador es visible entre usuarios de la app (se comparte
    // por enlace /trainer/[id]), pero no debe quedar abierto a cualquiera sin
    // sesión: antes bastaba conocer un id de Clerk para volcar la colección,
    // cantidades y favoritos de otra persona sin siquiera iniciar sesión.
    const { userId } = await auth();
    if (!userId) return [];
    if (!trainerId || typeof trainerId !== "string") return [];

    try {
      // JOIN a `sets` para traer el nombre del set: antes se leía row.set_name,
      // que la consulta no seleccionaba, así que set.name salía siempre undefined.
      // LEFT JOIN para no descartar cartas cuyo set no esté todavía en `sets`.
      const { rows } = await sql`
        SELECT
          c.*,
          uc.quantity,
          uc.is_favorite,
          s.name AS set_name
        FROM user_collection uc
        JOIN cards c ON uc.card_id = c.id
        LEFT JOIN sets s ON s.id = c.set_id
        WHERE uc.user_id = ${trainerId} AND uc.quantity > 0
      `;

      // Formateamos los datos para que tu página los entienda perfectamente
      const parse = (v: any, fb: any = null) => {
        if (v == null) return fb;
        return typeof v === 'string' ? JSON.parse(v) : v;
      };
      // El nombre de la expansión también se traduce: el perfil del entrenador
      // lo pinta junto al logo y quedaría a medias en inglés.
      const idioma = await idiomaActual();
      return enIdiomaUsuario(
        rows.map((row: any) => ({
          ...row,
          images: parse(row.images),
          tcgplayer: parse(row.tcgplayer),
          types: parse(row.types, []),
          attacks: parse(row.attacks, []),
          weaknesses: parse(row.weaknesses, []),
          retreatCost: parse(row.retreat_cost, []),
          flavorText: row.flavor_text,
          set: {
            id: row.set_id,
            name: nombreSetEs(row.set_id, idioma) ?? row.set_name,
          },
        })),
      );
      
    } catch (error) {
      console.error("❌ Error leyendo colección del entrenador:", error);
      return [];
    }
  }

  // --- NUEVA FUNCIÓN: Guarda tu nombre de Clerk en la BD ---
  export async function syncUserName() {
    const user = await currentUser();
    if (!user) return;

    // Intentamos coger tu nombre de usuario, si no, tu nombre de pila, y si no, "Entrenador"
    const displayName = user.username || user.firstName || "Entrenador";

    try {
      // Incluimos `coins` con COALESCE: si esta función gana la carrera de
      // creación frente a getUserData, el usuario nace con su saldo inicial en
      // vez de con coins NULL (que dejaba el saldo vacío y bloqueaba spendCoins).
      await sql`
        INSERT INTO users (id, username, coins)
        VALUES (${user.id}, ${displayName}, ${STARTING_COINS})
        ON CONFLICT (id)
        DO UPDATE SET username = ${displayName},
                      coins = COALESCE(users.coins, ${STARTING_COINS})
      `;
    } catch (error) {
      console.error("Error sincronizando nombre de usuario:", error);
    }
  }


  // El sistema de intercambios antiguo (tabla `trades`) vivía aquí. Se retiró:
  // ninguna migración crea esa tabla y no quedaba ningún consumidor. El sistema
  // vigente es app/social.ts, sobre la tabla `trade_offers`.
  //
  // Y por la misma razón se ha retirado el SISTEMA DE AMIGOS que también vivía
  // aquí: `sendFriendRequest`, `getFriendsList`, `acceptFriendRequest` y
  // `removeFriend` duplicaban a `addFriend`, `getSocialOverview`,
  // `acceptFriend` y `removeFriendship` de app/social.ts, que son las que usa
  // app/friends/page.tsx. Ninguna de las cuatro tenía un solo consumidor.
  //
  // No era código muerto inocuo: toda función exportada de un fichero
  // 'use server' es un endpoint POST vivo, así que eran cuatro endpoints
  // mantenidos por nadie —y ya habían divergido, porque `sendFriendRequest`
  // comprobaba que el destinatario existiera y `addFriend` no—. Cada arreglo
  // había que hacerlo dos veces o quedaba a medias.
  //
  // `syncUserName` se queda: la llama app/friends/page.tsx y no está duplicada.

// --- DAILY REWARD ---
export async function claimDailyReward() {
  const { userId } = await auth();
  if (!userId) return { error: "No autorizado" };
  try {
    await ensureSchema();

    const { rows } = await sql`SELECT last_daily_claim, streak FROM users WHERE id = ${userId}`;
    if (rows.length === 0) return { error: "Usuario no existe" };

    const last: Date | null = rows[0].last_daily_claim;
    const streak: number = rows[0].streak || 0;
    const now = new Date();

    if (last) {
      const diffMs = now.getTime() - new Date(last).getTime();
      const hours = diffMs / (1000 * 60 * 60);
      if (hours < 20) {
        const remaining = Math.ceil(20 - hours);
        return { error: `Recompensa lista en ~${remaining}h` };
      }
    }

    const wasYesterday = last
      ? (now.getTime() - new Date(last).getTime()) / (1000 * 60 * 60) < 48
      : false;
    const newStreak = wasYesterday ? streak + 1 : 1;
    const baseReward = DAILY_BASE;
    const bonus = Math.min(newStreak * DAILY_STREAK_STEP, DAILY_STREAK_CAP);
    const totalReward = baseReward + bonus;

    // La condición de las 20h se repite AQUÍ, dentro del propio UPDATE.
    // Comprobarla sólo en JavaScript dejaba una ventana entre el SELECT y el
    // UPDATE: con dos pestañas, ambas leían la misma fecha antigua, ambas
    // pasaban el `if` y ambas cobraban. Al ponerla en el WHERE, la segunda no
    // afecta a ninguna fila y se rechaza.
    const claim = await sql`
      UPDATE users
      SET coins = coins + ${totalReward},
          last_daily_claim = NOW(),
          streak = ${newStreak}
      WHERE id = ${userId}
        AND (last_daily_claim IS NULL
             OR last_daily_claim <= NOW() - INTERVAL '20 hours')
      RETURNING coins
    `;
    if (claim.rowCount === 0) {
      return { error: "Esa recompensa ya se ha reclamado" };
    }

    revalidatePath('/');
    return {
      success: true,
      reward: totalReward,
      streak: newStreak,
      coins: Number(claim.rows[0].coins),
    };
  } catch (e) {
    console.error("Error daily reward:", e);
    return { error: "Error servidor" };
  }
}

export async function getDailyStatus() {
  const { userId } = await auth();
  if (!userId) return { available: false };
  try {
    await ensureSchema();
    const { rows } = await sql`SELECT last_daily_claim, streak FROM users WHERE id = ${userId}`;
    if (rows.length === 0) return { available: true, streak: 0 };
    const last = rows[0].last_daily_claim;
    const streak = rows[0].streak || 0;
    if (!last) return { available: true, streak };
    const hours = (Date.now() - new Date(last).getTime()) / (1000 * 60 * 60);
    return { available: hours >= 20, streak, hoursLeft: Math.max(0, Math.ceil(20 - hours)) };
  } catch (e) {
    return { available: false };
  }
}

// --- PROFILE STATS (for home hero) ---
export async function getProfileStats() {
  const { userId } = await auth();
  if (!userId) return null;
  try {
    const { rows: cards } = await sql`
      SELECT uc.quantity, uc.is_favorite, c.rarity, c.set_id
      FROM user_collection uc
      JOIN cards c ON uc.card_id = c.id
      WHERE uc.user_id = ${userId} AND uc.quantity > 0
    `;
    // Mismo motivo que en claimSetCompletionBonuses: el total que cuenta es el
    // de las cartas que EXISTEN, no el que declara el set.
    const { rows: setsRows } = await sql`
      SELECT s.id, COUNT(c.id)::int AS reales
      FROM sets s
      LEFT JOIN cards c ON c.set_id = s.id
      GROUP BY s.id
    `;
    const { rows: userRows } = await sql`SELECT packs_opened, money_spent FROM users WHERE id = ${userId}`;
    const packsOpened = userRows[0]?.packs_opened || 0;
    const moneySpent = userRows[0]?.money_spent || 0;
    const totalsBySet: Record<string, number> = {};
    setsRows.forEach((s: any) => { totalsBySet[s.id] = Number(s.reales); });

    let totalValue = 0;
    let totalCards = 0;
    let totalUnique = 0;
    const uniquePerSet: Record<string, number> = {};

    cards.forEach((row: any) => {
      totalUnique += 1;
      totalCards += row.quantity;
      // PATRIMONIO REAL, no `precio × copias`. El precio de una carta baja con
      // cada copia repetida (valorDeVenta), así que multiplicar por la cantidad
      // inflaba el valor y premiaba acaparar: 43 copias de una común puntuaban
      // 86 y se venden por 43. Lo que vale la fila es la copia protegida, que se
      // paga entera, más lo que dé la curva por las repetidas.
      totalValue += precioDeCartaSuelta(row.rarity) + valorDeVenta(row.rarity, row.quantity);
      uniquePerSet[row.set_id] = (uniquePerSet[row.set_id] || 0) + 1;
    });

    let setsCompleted = 0;
    Object.entries(uniquePerSet).forEach(([sid, owned]) => {
      const total = totalsBySet[sid];
      if (total && owned >= total) setsCompleted += 1;
    });

    // Conteo de rarezas tier alto para logros
    let rareHits = 0;
    cards.forEach((row: any) => {
      if ((RARITY_RANK[row.rarity] || 0) >= 70) rareHits += 1; // Illustration Rare+
    });

    return {
      totalValue,
      totalCards,
      totalUnique,
      setsCompleted,
      setsTotal: setsRows.length,
      packsOpened,
      moneySpent,
      rareHits,
    };
  } catch (e) {
    console.error("Error stats:", e);
    return null;
  }
}

// --- CARD DETAIL FROM DB (replaces live API for modal) ---
export async function getCardFromDB(cardId: string) {
  try {
    const { rows } = await sql`SELECT * FROM cards WHERE id = ${cardId} LIMIT 1`;
    if (rows.length === 0) return null;
    const row: any = rows[0];
    const parse = (v: any, fb: any = null) => {
      if (v == null) return fb;
      return typeof v === 'string' ? JSON.parse(v) : v;
    };
    // Get set info too
    const idioma = await idiomaActual();
    let setObj: any = { id: row.set_id };
    const { rows: setRows } = await sql`SELECT * FROM sets WHERE id = ${row.set_id} LIMIT 1`;
    if (setRows.length > 0) {
      const s: any = setRows[0];
      setObj = traducirSet({
        id: s.id, name: s.name, series: s.series,
        printedTotal: s.printed_total, total: s.total,
        ptcgoCode: s.ptcgo_code, releaseDate: s.release_date,
        legalities: parse(s.legalities, {}),
        images: parse(s.images, {}),
      }, idioma);
    }
    // El detalle es la única pantalla que enseña el texto de ambientación, y
    // las cartas españolas de TCGdex no lo traen: se queda en inglés (igual que
    // el ilustrador y las rarezas, que son datos, no interfaz).
    const [carta] = await enIdiomaUsuario([{
      id: row.id,
      name: row.name,
      supertype: row.supertype,
      subtypes: parse(row.subtypes, []),
      level: row.level,
      hp: row.hp,
      types: parse(row.types, []),
      evolvesFrom: row.evolves_from,
      evolvesTo: parse(row.evolves_to, []),
      rules: parse(row.rules, []),
      ancientTrait: parse(row.ancient_trait, null),
      abilities: parse(row.abilities, []),
      attacks: parse(row.attacks, []),
      weaknesses: parse(row.weaknesses, []),
      resistances: parse(row.resistances, []),
      retreatCost: parse(row.retreat_cost, []),
      convertedRetreatCost: row.converted_retreat_cost,
      set: setObj,
      number: row.number,
      artist: row.artist,
      rarity: row.rarity,
      flavorText: row.flavor_text,
      nationalPokedexNumbers: parse(row.national_pokedex_numbers, []),
      legalities: parse(row.legalities, null),
      regulationMark: row.regulation_mark,
      images: parse(row.images, {}),
      tcgplayer: parse(row.tcgplayer, null),
      cardmarket: parse(row.cardmarket, null),
    }]);
    return carta;
  } catch (e) {
    console.error("getCardFromDB error:", e);
    return null;
  }
}

// --- SEARCH CARDS IN DB (replaces live API in GlobalSearch) ---
/**
 * Buscador global. BILINGÜE cuando el idioma es español.
 *
 * EL PROBLEMA: en `cards` los nombres están en inglés ("Erika's Invitation").
 * Un usuario que ve la app en español teclea "Invitación de Erika" y el
 * `LIKE` sobre `c.name` no encuentra nada: el buscador parecería roto.
 *
 * CÓMO SE RESUELVE Y QUÉ CUESTA: `idsPorNombreEspanol` (services/idiomaServidor)
 * mantiene en memoria del servidor un índice inverso nombre español -> id,
 * construido una sola vez por instancia a partir de los diccionarios y sólo si
 * alguien busca en español (~6.700 entradas, sin tildes y en minúsculas). Los
 * ids que casan entran en la consulta junto al LIKE inglés de siempre, así que
 * se puede buscar en los dos idiomas a la vez. Coste: nada de esquema (ni una
 * columna `name_es` en `cards` que hubiera que resembrar y mantener), un
 * recorrido lineal en JS por búsqueda y un array de ids —acotado a 1.500— que
 * viaja a Postgres. En español el recorrido añade ~1 ms; en inglés no se toca.
 */
export async function searchCardsInDB(query: string, page = 1, pageSize = 10) {
  try {
    const { userId } = await auth();

    // page y pageSize llegan del cliente: se acotan en el servidor. Sin esto,
    // pageSize = 1e9 volcaba la tabla `cards` entera en cada tecla del buscador,
    // y valores negativos o no numéricos rompían la consulta.
    const size = Math.min(50, Math.max(1, Math.trunc(Number(pageSize) || 10)));
    const p = Math.max(1, Math.trunc(Number(page) || 1));
    const offset = (p - 1) * size;

    const crudo = String(query ?? "");
    // Escapamos los comodines de LIKE (%, _ y la propia barra de escape): sin
    // esto, buscar "%" o "_" devolvía el catálogo completo. Backslash es el
    // carácter de escape por defecto de LIKE en Postgres.
    const safeTerm = crudo.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`);
    const term = `%${safeTerm}%`;

    const idioma = await idiomaActual();
    // Al índice se le pasa el término SIN escapar: sus comodines son de LIKE,
    // no de una comparación de cadenas.
    const { ids, nombres } =
      idioma === "es" ? await idsPorNombreEspanol(crudo) : { ids: [], nombres: [] };

    // El LEFT JOIN contra el unnest hace dos cosas de una vez: mete en el
    // resultado las cartas que sólo casan por su nombre español, y da el nombre
    // español al ORDER BY. Ordenar por el inglés dejaría una lista que al
    // usuario le parecería desordenada.
    const desde = `
      FROM cards c
      LEFT JOIN unnest($2::text[], $3::text[]) AS t(id, nombre) ON t.id = c.id
      WHERE (LOWER(c.name) LIKE $1 OR t.id IS NOT NULL)`;

    const params: any[] = [term, ids, nombres];

    const { rows: countRows } = await sql.query(
      `SELECT count(*)::int AS total ${desde}`,
      params,
    );
    const total = countRows[0]?.total || 0;

    let owned = "false";
    if (userId) {
      params.push(userId);
      owned = `EXISTS(SELECT 1 FROM user_collection uc
                       WHERE uc.user_id = $${params.length}
                         AND uc.card_id = c.id AND uc.quantity > 0)`;
    }
    const pLimit = params.push(size);
    const pOffset = params.push(offset);

    const { rows } = await sql.query(
      `SELECT c.id, c.name, c.rarity, c.images, c.set_id, ${owned} AS owned
       ${desde}
       ORDER BY COALESCE(t.nombre, c.name) ASC
       LIMIT $${pLimit} OFFSET $${pOffset}`,
      params,
    );

    const setIds = Array.from(new Set(rows.map((r: any) => r.set_id)));
    const setMap: Record<string, any> = {};
    if (setIds.length > 0) {
      const { rows: setRows } = await sql.query(
        `SELECT id, name FROM sets WHERE id = ANY($1::text[])`,
        [setIds],
      );
      setRows.forEach((s: any) => {
        setMap[s.id] = { ...s, name: nombreSetEs(s.id, idioma) ?? s.name };
      });
    }
    const data = await enIdiomaUsuario(
      rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        rarity: r.rarity,
        images: typeof r.images === 'string' ? JSON.parse(r.images) : r.images,
        set: setMap[r.set_id] || { id: r.set_id },
        owned: r.owned,
      })),
    );
    return { data, total, page: p, pageSize: size };
  } catch (e) {
    console.error("searchCardsInDB error:", e);
    return { data: [], total: 0, page, pageSize };
  }
}

// --- SET COMPLETION BONUS ---
// Grants one-time coin reward when user completes a full set.
export async function claimSetCompletionBonuses() {
  const { userId } = await auth();
  if (!userId) return { granted: 0, sets: [] };
  try {
    await ensureSchema();
    // Unique owned cards per set
    const { rows: owned } = await sql`
      SELECT c.set_id, COUNT(*)::int AS owned
      FROM user_collection uc
      JOIN cards c ON uc.card_id = c.id
      WHERE uc.user_id = ${userId} AND uc.quantity > 0
      GROUP BY c.set_id
    `;
    /* EL TOTAL SON LAS CARTAS QUE HAY, NO LAS QUE EL SET DICE TENER.
     *
     * `sets.total` viene de la API y NO coincide con las filas de `cards`. La
     * propia ingesta lo documenta ("El `total` que declara un set no siempre
     * coincide con las cartas que la API devuelve", services/ingest.ts) y
     * además es REANUDABLE: un set a medio descargar tiene menos cartas que su
     * total declarado. Midiendo contra el declarado, en esas expansiones el
     * bono de 1.000 monedas no se podía cobrar NUNCA por muchas cartas que
     * consiguiera el jugador.
     *
     * `reales` es el conteo de `cards`, que es contra lo que de verdad se
     * colecciona. Se pide `total` igualmente para el guard de abajo.
     */
    const { rows: setsRows } = await sql`
      SELECT s.id, s.total, s.name, COUNT(c.id)::int AS reales
      FROM sets s
      LEFT JOIN cards c ON c.set_id = s.id
      GROUP BY s.id, s.total, s.name
    `;
    const totals: Record<string, { total: number; reales: number; name: string }> = {};
    setsRows.forEach((s: any) => {
      totals[s.id] = { total: Number(s.total), reales: Number(s.reales), name: s.name };
    });

    const { rows: already } = await sql`SELECT set_id FROM set_rewards WHERE user_id = ${userId}`;
    const rewarded = new Set(already.map((r: any) => r.set_id));

    const BONUS = SET_COMPLETION_BONUS;
    // El aviso de "¡has completado X!" nombra la expansión: en español también.
    // La fila de set_rewards se sigue escribiendo con el id canónico.
    const idioma = await idiomaActual();
    let granted = 0;
    const completedSets: string[] = [];

    /* CUÁNDO SE PUEDE FIAR UNO DEL CONTEO.
     *
     * Medir contra las cartas reales arregla el total inflado, pero abre un
     * riesgo nuevo: la ingesta es reanudable y `cartasDelSet` siembra DENTRO de
     * la compra, así que hay ventanas en las que `cards` tiene una expansión a
     * medias. Pagar el bono ahí sería pagarlo por un set incompleto, y como la
     * clave primaria (user_id, set_id) de `set_rewards` sólo deja cobrarlo una
     * vez, el jugador se quedaría SIN el bono de verdad para siempre.
     *
     * El guard: si el set declara un total y lo que hay en `cards` se queda muy
     * por debajo, es que la siembra no ha terminado y este ciclo no se cobra
     * nada; ya se cobrará cuando la base esté al día. El 90% deja pasar el
     * desajuste normal de la API (declarar dos o tres cartas de más) y corta la
     * descarga a medias, que siempre va mucho más lejos.
     */
    const CATALOGO_FIABLE = 0.9;

    for (const row of owned) {
      const meta = totals[row.set_id];
      if (!meta || !meta.reales) continue;
      // Siembra a medias: ni se paga ni se quema la fila de set_rewards.
      if (meta.total > 0 && meta.reales < meta.total * CATALOGO_FIABLE) continue;
      if (row.owned >= meta.reales && !rewarded.has(row.set_id)) {
        // El abono se condiciona a que el INSERT insertara DE VERDAD: la clave
        // primaria (user_id, set_id) arbitra la carrera. Antes se sumaba el bonus
        // aunque el ON CONFLICT DO NOTHING no tocara nada, así que dos pestañas
        // completando el set a la vez cobraban el bonus dos veces.
        const ins = await sql`
          INSERT INTO set_rewards (user_id, set_id) VALUES (${userId}, ${row.set_id})
          ON CONFLICT DO NOTHING
        `;
        if ((ins.rowCount ?? 0) > 0) {
          granted += BONUS;
          completedSets.push(nombreSetEs(row.set_id, idioma) ?? meta.name);
        }
      }
    }

    if (granted > 0) {
      await sql`UPDATE users SET coins = coins + ${granted} WHERE id = ${userId}`;
      revalidatePath('/');
    }
    return { granted, sets: completedSets, bonusPerSet: BONUS };
  } catch (e) {
    console.error("claimSetCompletionBonuses error:", e);
    return { granted: 0, sets: [] };
  }
}

// --- VENDER DUPLICADOS DE UN SOBRE (resumen) ---
// Recibe ids de cartas que YA poseías antes del sobre (los duplicados ganados).
// Vende 1 copia de cada (sin bajar de 1), acredita precio segun rareza.
export async function sellPackDuplicates(cardIds: string[]) {
  const { userId } = await auth();
  if (!userId || !Array.isArray(cardIds) || cardIds.length === 0) return { earned: 0, sold: 0 };
  // Tope de entrada: un ×10 trae como mucho ~100 cartas. Un array mayor sólo
  // puede ser abuso, y cada id son un par de consultas.
  if (cardIds.length > 200) return { earned: 0, sold: 0 };
  try {
    // Contar cuántas veces aparece cada id en el sobre
    const counts: Record<string, number> = {};
    cardIds.forEach((id) => { counts[id] = (counts[id] || 0) + 1; });

    let earned = 0;
    let sold = 0;
    for (const [cardId, qtyToSell] of Object.entries(counts)) {
      const { rows } = await sql`
        SELECT uc.quantity, c.rarity
        FROM user_collection uc JOIN cards c ON uc.card_id = c.id
        WHERE uc.user_id = ${userId} AND uc.card_id = ${cardId} AND uc.quantity > 0
      `;
      if (rows.length === 0) continue;
      const have = Number(rows[0].quantity);
      const rarity = rows[0].rarity;
      // No bajar de 1 copia
      const sellable = Math.min(qtyToSell, Math.max(0, have - 1));
      if (sellable <= 0) continue;
      // Precio decreciente: se van las copias de índice más alto. Con una copia
      // repetida es la tarifa de siempre; con cincuenta, la del suelo.
      const importe = valorDeVenta(rarity, have, sellable);

      // Descuento y abono de esta carta en UNA sentencia (CTE) con la condición
      // de cantidad repetida DENTRO del UPDATE. Antes,
      // entre el SELECT y este UPDATE no se re-verificaba nada: dos pestañas
      // (o dos taps en "vender duplicados") leían ambas la misma cantidad y
      // restaban dos veces, dejando la fila negativa y pagando doble. El guard y
      // el EXISTS cierran la ventana y sólo abonan si de verdad se restó.
      //
      // El guard es `quantity = have` (antes bastaba `>= sellable + 1`) porque
      // ahora el importe depende de la cantidad: si entretanto entrara otro
      // sobre con la misma carta, las copias que se van serían más profundas y
      // más baratas, y se estaría pagando la tarifa de una cantidad que ya no
      // existe.
      const upd = await sql`
        WITH venta AS (
          UPDATE user_collection SET quantity = quantity - ${sellable}
          WHERE user_id = ${userId} AND card_id = ${cardId} AND quantity = ${have}
          RETURNING 1
        )
        UPDATE users SET coins = coins + ${importe}
        WHERE id = ${userId} AND EXISTS (SELECT 1 FROM venta)
        RETURNING coins
      `;
      if (upd.rows.length === 0) continue; // otra pestaña se adelantó: no se cobra
      earned += importe;
      sold += sellable;
    }
    if (sold > 0) {
      revalidatePath('/');
      revalidatePath('/collection');
    }
    return { earned, sold };
  } catch (e) {
    console.error("sellPackDuplicates error:", e);
    return { earned: 0, sold: 0 };
  }
}

// --- WISHLIST ---
export async function toggleWishlist(cardId: string) {
  const { userId } = await auth();
  if (!userId) return { error: "No logueado" };
  try {
    await ensureSchema();
    const { rows } = await sql`SELECT 1 FROM wishlist WHERE user_id = ${userId} AND card_id = ${cardId}`;
    if (rows.length > 0) {
      await sql`DELETE FROM wishlist WHERE user_id = ${userId} AND card_id = ${cardId}`;
      revalidatePath('/collection');
      return { wishlisted: false };
    }
    await sql`INSERT INTO wishlist (user_id, card_id) VALUES (${userId}, ${cardId}) ON CONFLICT DO NOTHING`;
    revalidatePath('/collection');
    return { wishlisted: true };
  } catch (e) {
    console.error("toggleWishlist error:", e);
    return { error: "Error servidor" };
  }
}

export async function getWishlistIds() {
  const { userId } = await auth();
  if (!userId) return [];
  try {
    await ensureSchema();
    const { rows } = await sql`SELECT card_id FROM wishlist WHERE user_id = ${userId}`;
    return rows.map((r: any) => r.card_id);
  } catch (e) {
    return [];
  }
}

export async function getWishlistCards() {
  const { userId } = await auth();
  if (!userId) return [];
  try {
    const { rows } = await sql`
      SELECT c.id, c.name, c.rarity, c.images, c.set_id,
             EXISTS(SELECT 1 FROM user_collection uc WHERE uc.user_id = ${userId} AND uc.card_id = c.id AND uc.quantity > 0) AS owned
      FROM wishlist w JOIN cards c ON w.card_id = c.id
      WHERE w.user_id = ${userId}
      ORDER BY w.added_at DESC
    `;
    return enIdiomaUsuario(
      rows.map((r: any) => ({
        ...r,
        images: typeof r.images === 'string' ? JSON.parse(r.images) : r.images,
      })),
    );
  } catch (e) {
    return [];
  }
}

// --- USER THEME PREFERENCE (persistido por usuario) ---
export async function getUserTheme(): Promise<"light" | "dark" | null> {
  const { userId } = await auth();
  if (!userId) return null;
  try {
    await ensureSchema();
    const { rows } = await sql`SELECT theme FROM users WHERE id = ${userId}`;
    const t = rows[0]?.theme;
    if (t === "light" || t === "dark") return t;
    return null;
  } catch (e) {
    console.error("getUserTheme error:", e);
    return null;
  }
}

export async function setUserTheme(theme: "light" | "dark") {
  const { userId } = await auth();
  if (!userId) return { error: "No logueado" };
  if (theme !== "light" && theme !== "dark") return { error: "Tema inválido" };
  try {
    await ensureSchema();
    // Incluimos coins con COALESCE por el mismo motivo que syncUserName: si este
    // upsert llegara a crear la fila del usuario, que nazca con su saldo inicial
    // y no con coins NULL.
    await sql`
      INSERT INTO users (id, theme, coins) VALUES (${userId}, ${theme}, ${STARTING_COINS})
      ON CONFLICT (id) DO UPDATE SET theme = ${theme},
                                     coins = COALESCE(users.coins, ${STARTING_COINS})
    `;
    return { success: true };
  } catch (e) {
    console.error("setUserTheme error:", e);
    return { error: "Error servidor" };
  }
}

// --- USER LANGUAGE PREFERENCE (calcado de getUserTheme/setUserTheme) ---
/**
 * Idioma de la CUENTA. Es la preferencia que viaja con el usuario: la del
 * dispositivo vive en localStorage + cookie (ver services/idiomaServidor.ts) y
 * SettingsSheet deja que ésta la pise cuando Clerk confirma la sesión.
 *
 * El userId sale de auth(), nunca del cliente, y el valor se valida aquí: como
 * toda función exportada de un fichero 'use server' es un endpoint POST vivo,
 * un "idioma" arbitrario acabaría escrito en la columna.
 */
export async function getUserLang(): Promise<Idioma | null> {
  const { userId } = await auth();
  if (!userId) return null;
  try {
    await ensureSchema();
    const { rows } = await sql`SELECT lang FROM users WHERE id = ${userId}`;
    const l = rows[0]?.lang;
    if (l === "en" || l === "es") return l;
    return null;
  } catch (e) {
    console.error("getUserLang error:", e);
    return null;
  }
}

export async function setUserLang(lang: "en" | "es") {
  const { userId } = await auth();
  if (!userId) return { error: "No logueado" };
  if (lang !== "en" && lang !== "es") return { error: "Idioma inválido" };
  try {
    await ensureSchema();
    // Mismo COALESCE que setUserTheme: si este upsert llegara a crear la fila,
    // que nazca con su saldo inicial y no con coins NULL.
    await sql`
      INSERT INTO users (id, lang, coins) VALUES (${userId}, ${lang}, ${STARTING_COINS})
      ON CONFLICT (id) DO UPDATE SET lang = ${lang},
                                     coins = COALESCE(users.coins, ${STARTING_COINS})
    `;
    return { success: true };
  } catch (e) {
    console.error("setUserLang error:", e);
    return { error: "Error servidor" };
  }
}

/**
 * Nombre e ilustración españoles de una lista de ids. Es la única pieza de la
 * capa de idioma que el INVITADO necesita pedir aparte.
 *
 * POR QUÉ: su colección vive en localStorage y guarda el nombre y la imagen con
 * los que se abrió el sobre. Ese almacén no se toca (es su partida), así que al
 * cambiar de idioma sus cartas seguirían con el nombre viejo. Con esto la
 * pantalla de colección repinta lo guardado sin reescribirlo: puro aspecto.
 *
 * Sólo devuelve datos del catálogo público (nombre e imagen de cartas), así que
 * exponerlo como endpoint no filtra nada de nadie.
 */
export async function nombresDeCartas(ids: string[]) {
  if (!Array.isArray(ids) || ids.length === 0) return {};

  // Tope: un localStorage manipulado no puede convertir esto en un volcado.
  const limpios = Array.from(
    new Set(ids.filter((id) => typeof id === "string" && ID_CARTA.test(id))),
  ).slice(0, 1500);
  if (limpios.length === 0) return {};

  const salida: Record<string, { name?: string; images?: any }> = {};
  const idioma = await idiomaActual();

  if (idioma === "es") {
    // En español basta el diccionario: ni una consulta.
    const traducidas = await traducirCartas(
      limpios.map(
        (id) => ({ id }) as { id: string; name?: string; images?: { small?: string; large?: string } | null },
      ),
      idioma,
    );
    for (const c of traducidas) {
      // `traducirCartas` devuelve la misma referencia cuando no hay traducción
      // (311 cartas sin pareja): sin `name` no hay nada que decirle al cliente,
      // y lo que el invitado tenga guardado ya está en inglés.
      if (c.name) salida[c.id] = { name: c.name, images: c.images ?? undefined };
    }
    return salida;
  }

  // En inglés hay que DESHACER lo que se guardó en español, y el nombre inglés
  // sólo está en el catálogo. Una consulta por carga de la colección de
  // invitado, con los ids que ya tiene en la mano.
  try {
    const { rows } = await sql.query(
      `SELECT id, name, images FROM cards WHERE id = ANY($1::text[])`,
      [limpios],
    );
    for (const r of rows) {
      salida[String(r.id)] = {
        name: r.name,
        images: typeof r.images === "string" ? JSON.parse(r.images) : r.images,
      };
    }
  } catch (e) {
    // Sin Postgres, el invitado se queda con lo guardado: es sólo el rótulo.
    console.error("nombresDeCartas error:", e);
  }
  return salida;
}

/* ==================================================================== *
 * MERCADO DE LOTES
 * ====================================================================
 *
 * REGLA DE ORO: del cliente sólo se acepta QUÉ oferta quiere cobrar y QUÉ
 * cartas entrega. Ni el pago, ni el multiplicador, ni la rareza, ni el valor
 * del lote: todo eso se recalcula aquí contra la tabla `cards`. Ver la nota
 * larga sobre por qué en la cabecera de `cumplirOferta`.
 *
 * SÓLO DUPLICADOS: al mercado sólo van las copias que SOBRAN. De cada carta
 * entregada el jugador conserva COPIAS_RESERVADAS, así que entregar N copias
 * exige tener N + COPIAS_RESERVADAS. La regla vive en utils/mercado.ts
 * (`copiasEntregables`) y aquí no se reimplementa: se llama. El álbum nunca se
 * vacía, ni con dos pestañas a la vez (ver el CTE de `cumplirOferta`).
 * ==================================================================== */

/** Tope de cartas por entrega. La oferta más glotona pide 30 (MAX_CARTAS_OFERTA). */
const MAX_CARTAS_ENTREGA = 40;

/** Ids de carta plausibles ("sv3pt5-207", "swsh12pt5gg-GG01"). */
const ID_CARTA = /^[a-zA-Z0-9._-]{1,40}$/;

/** Categorías cuyo requisito mira el CONJUNTO, no cada carta por separado. */
const CATEGORIAS_DE_CONJUNTO = ["playset", "arcoiris", "evolucion"];

interface CartaMercado extends CartaMinima {
  /** Copias que posee el usuario (con sesión sale de user_collection). */
  cantidad: number;
  /** SELL_PRICES de su rareza, calculado en el servidor. */
  precio: number;
  /**
   * Nombre español, SÓLO para pintarlo. `name` se queda en inglés a propósito.
   *
   * POR QUÉ AQUÍ NO SE TRADUCE `name` COMO EN EL RESTO: el mercado empareja por
   * nombre. `cumpleFiltro` resuelve el requisito "empieza por E" con la inicial
   * del nombre, y `entregaValida` encadena evoluciones comparando `evolvesFrom`
   * (inglés, columna de `cards`) con el `name` del eslabón anterior. Si el
   * cliente repartiera con nombres españoles y `cumplirOferta` validara con los
   * ingleses, la pantalla pondría el botón en verde y el cobro lo rechazaría:
   * el peor fallo posible de esa pantalla. El idioma no puede mover ni una
   * moneda, así que sólo viaja el rótulo.
   */
  nombreEs?: string;
}

/** Añade el rótulo español a las cartas del mercado sin tocar `name`. */
async function conNombreEs(cartas: CartaMercado[]): Promise<CartaMercado[]> {
  const idioma = await idiomaActual();
  if (idioma !== "es" || cartas.length === 0) return cartas;
  const traducidas = await traducirCartas(
    cartas.map((c) => ({ id: c.id, name: c.name })),
    idioma,
  );
  return cartas.map((c, i) => {
    const nombre = traducidas[i]?.name;
    return nombre && nombre !== c.name ? { ...c, nombreEs: nombre } : c;
  });
}

/**
 * Expansiones que el mercado puede exigir: las que se pueden abrir con sobre
 * estándar (AVAILABLE_SETS) y además tienen datos en el repositorio.
 *
 * POR QUÉ NO SALE DE LA TABLA `sets`: el tablón se deriva de esta lista, así
 * que tiene que ser IDÉNTICA al pintarlo y al cobrarlo. Postgres no garantiza
 * el orden de los empates de `release_date`, y una ingesta a medias cambiaría
 * la lista a mitad de ciclo: en ambos casos la oferta que el jugador ve dejaría
 * de existir al pulsar "cumplir". Derivada del código desplegado es estable.
 */
interface CatalogoMercado {
  /** Ids que el tablón puede exigir, en orden ESTABLE. */
  ids: string[];
  /** Rótulo inglés de cada uno, para la prosa de las ofertas. */
  nombres: Record<string, string>;
}

let catalogoMercadoCache: CatalogoMercado | null = null;

/**
 * ¿Puede el tablón ATAR una oferta a esta expansión?
 *
 * NO BASTA CON QUE LA EXPANSIÓN EXISTA, y por no comprobarlo se coló el peor
 * efecto secundario de derivar la lista de los ficheros de datos: al pasar de
 * las 27 entradas curadas a mano a las 38 que hay en `src/data`, entraron nueve
 * subsets sin pirámide de rarezas —las Trainer Gallery, la Shiny Vault, las
 * Galarian Gallery y los sets de promos— y el 11,5% de las ofertas del tablón
 * pasó a ser IMPOSIBLE de cumplir: la barra clavada en 0 para siempre.
 *
 * POR QUÉ: `montarOferta` ata SIEMPRE el primer requisito a la expansión, y las
 * dos únicas bandas que se pueden atar son B_MORRALLA (rango 1-5: comunes e
 * infrecuentes) y B_RARA (rango 10-20: raras y raras holo). Un subset que no
 * imprime ninguna de las dos no puede satisfacer un requisito atado, se pida lo
 * que se pida.
 *
 * Se mide contra las cartas del repositorio, que es la misma fuente de la que
 * sale la lista, y el resultado se cachea con ella.
 */
async function admiteOfertaAtada(setId: string): Promise<boolean> {
  try {
    const cartas = (await loadLocalCards(setId)) as { rarity?: string }[];
    let morralla = false;
    let raras = false;
    for (const c of cartas) {
      const r = RARITY_RANK[c.rarity ?? ""] ?? 1;
      if (r >= 1 && r <= 5) morralla = true;
      else if (r >= 10 && r <= 20) raras = true;
      if (morralla && raras) return true;
    }
    return false;
  } catch {
    // Sin datos legibles no se ata nada a esa expansión: una oferta de menos es
    // mucho mejor que una oferta que no se puede cumplir.
    return false;
  }
}

/**
 * El catálogo del mercado, derivado de los ficheros de datos y NO de la lista
 * escrita a mano.
 *
 * QUÉ CAMBIA Y POR QUÉ: antes salía de `AVAILABLE_SETS` (utils/constanst.ts),
 * 28 entradas mantenidas a dedo. Se había quedado atrás: incluía `cel25`, que
 * no tiene fichero de cartas, y le faltaban sv9, sv10, sve, svp, swsh35,
 * swsh45sv, swshp y todos los subsets `*tg`/`gg`. Consecuencia doble: había
 * expansiones que el tablón no podía pedir JAMÁS, y las que sí entraban por
 * otra vía salían rotuladas "SV10" en mayúsculas porque `nombreDeSet` no las
 * encontraba.
 *
 * `loadLocalSets` ya filtra por "tiene fichero de cartas", que es exactamente
 * la condición que el mercado necesita: no se puede exigir una carta de una
 * expansión de la que no hay datos.
 *
 * EL ORDEN ES PARTE DEL CONTRATO. `generarOfertas` elige por índice, así que la
 * lista tiene que ser IDÉNTICA al pintar el tablón y al cobrarlo. Por eso se
 * ordena por id y no por fecha: el orden de `loadLocalSets` depende de
 * `release_date`, y dos expansiones del mismo día podrían intercambiarse entre
 * dos arranques del servidor y mover el tablón bajo los pies del jugador.
 */
async function catalogoDelMercado(): Promise<CatalogoMercado> {
  if (catalogoMercadoCache) return catalogoMercadoCache;

  const respaldo: CatalogoMercado = {
    ids: AVAILABLE_SETS.map((s) => s.id),
    nombres: Object.fromEntries(AVAILABLE_SETS.map((s) => [s.id, s.name])),
  };

  try {
    const locales = (await loadLocalSets()) as { id: string; name?: string }[];
    const candidatos = locales
      .map((s) => String(s.id))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    const ids: string[] = [];
    for (const id of candidatos) {
      if (await admiteOfertaAtada(id)) ids.push(id);
    }
    // Sin respaldo legible preferimos la lista vieja a un tablón vacío.
    catalogoMercadoCache =
      ids.length > 0
        ? {
            ids,
            nombres: Object.fromEntries(
              locales
                .filter((s) => s?.id && s?.name)
                .map((s) => [String(s.id), String(s.name)]),
            ),
          }
        : respaldo;
  } catch {
    catalogoMercadoCache = respaldo;
  }
  return catalogoMercadoCache;
}

/** El tablón vigente. Puro: misma semilla ⇒ mismas ofertas, aquí y en el cliente. */
async function tablonVigente() {
  const ciclo = semillaDelCiclo(Date.now());
  const { ids, nombres } = await catalogoDelMercado();
  // `nombres` sólo cambia TEXTO: el sorteo depende de la semilla, de los ids y
  // de cuántas ofertas se piden, así que el tablón es el mismo con y sin él.
  const ofertas = generarOfertas(ciclo, ids, OFERTAS_ACTIVAS, nombres);
  return { ciclo, ofertas };
}

const listaSegura = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/** JSONB de la BD → array. Un `null` guardado no puede llegar a un .some(). */
function comoLista(valor: unknown): any[] {
  if (typeof valor === "string") {
    try {
      return listaSegura(JSON.parse(valor));
    } catch {
      return [];
    }
  }
  return listaSegura(valor);
}

/** Fila de `cards` → carta que entienden cumpleFiltro y precioDeVenta. */
function cartaDesdeFila(row: any, cantidad: number): CartaMercado {
  const carta: CartaMinima = {
    id: row.id,
    name: row.name,
    rarity: row.rarity ?? undefined,
    supertype: row.supertype ?? undefined,
    subtypes: comoLista(row.subtypes),
    types: comoLista(row.types),
    evolvesFrom: row.evolves_from ?? undefined,
    hp: row.hp ?? undefined,
    artist: row.artist ?? undefined,
    nationalPokedexNumbers: comoLista(row.national_pokedex_numbers),
    set: { id: row.set_id },
  };
  return { ...carta, cantidad, precio: precioDeVenta(carta) };
}

/** Carta del respaldo local (camelCase) → la misma forma. */
function cartaDesdeLocal(c: any, cantidad: number): CartaMercado {
  const carta: CartaMinima = {
    id: c.id,
    name: c.name,
    rarity: c.rarity ?? undefined,
    supertype: c.supertype ?? undefined,
    subtypes: listaSegura(c.subtypes),
    types: listaSegura(c.types),
    evolvesFrom: c.evolvesFrom ?? undefined,
    hp: c.hp ?? undefined,
    artist: c.artist ?? undefined,
    nationalPokedexNumbers: listaSegura(c.nationalPokedexNumbers),
    set: { id: c.set?.id ?? undefined },
  };
  return { ...carta, cantidad, precio: precioDeVenta(carta) };
}

const COLUMNAS_MERCADO = `c.id, c.name, c.rarity, c.supertype, c.subtypes, c.types,
       c.evolves_from, c.hp, c.artist, c.national_pokedex_numbers, c.set_id`;

/**
 * ¿Esta carta suelta sirve para este requisito? El set se comprueba APARTE del
 * filtro, tal y como documenta utils/mercado.ts.
 */
function sirveParaRequisito(carta: CartaMinima, r: Requisito): boolean {
  if (r.setId !== null && setDeCarta(carta) !== r.setId) return false;
  return cumpleFiltro(carta, r.filtro);
}

const mismoNombre = (a: unknown, b: unknown): boolean =>
  String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

const enMinusculas = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** Qué cartas puede recibir un hueco del reparto. */
type Hueco = (carta: CartaMinima) => boolean;

/** Requisitos DISTINTOS de éste que también aceptarían la carta. */
function utilidadEnOtros(carta: CartaMinima, propio: Requisito, todos: Requisito[]): number {
  return todos.filter((r) => r !== propio && sirveParaRequisito(carta, r)).length;
}

/**
 * Conjuntos de cartas (por índice) que podrían satisfacer un requisito de
 * "playset" (N copias de la misma carta) o de "evolucion" (cadena encadenada
 * por evolvesFrom). Son enumerables de verdad: no hay heurística que sesgue el
 * resultado, sólo un orden para probar antes las opciones más prometedoras.
 */
function opcionesDeConjunto(
  cartas: CartaMinima[],
  r: Requisito,
  disponibles: number[],
  todosLosRequisitos: Requisito[],
): number[][] {
  const elegibles = disponibles.filter((i) => sirveParaRequisito(cartas[i], r));
  const opciones: number[][] = [];

  if (r.filtro.categoria === "playset") {
    // `cantidad` copias de LA MISMA carta: agrupar por id y coger un grupo.
    const porId = new Map<string, number[]>();
    for (const i of elegibles) {
      const grupo = porId.get(cartas[i].id) ?? [];
      grupo.push(i);
      porId.set(cartas[i].id, grupo);
    }
    for (const grupo of porId.values()) {
      if (grupo.length >= r.cantidad) opciones.push(grupo.slice(0, r.cantidad));
    }
  } else if (r.filtro.categoria === "evolucion") {
    // Cadena: B.evolvesFrom === A.name. El catálogo sólo pide 2 o 3 eslabones.
    if (r.cantidad !== 2 && r.cantidad !== 3) return [];
    for (const a of elegibles) {
      for (const b of elegibles) {
        if (b === a || !mismoNombre(cartas[b].evolvesFrom, cartas[a].name)) continue;
        if (r.cantidad === 2) {
          opciones.push([a, b]);
          continue;
        }
        for (const c of elegibles) {
          if (c === a || c === b) continue;
          if (mismoNombre(cartas[c].evolvesFrom, cartas[b].name)) opciones.push([a, b, c]);
        }
      }
    }
  }

  // Sin repetidas y probando primero las que menos falta hacen en los demás
  // requisitos: así la primera combinación que se prueba suele ser la buena.
  const vistas = new Set<string>();
  return opciones
    .filter((o) => {
      const clave = [...o].sort((x, y) => x - y).join(",");
      if (vistas.has(clave)) return false;
      vistas.add(clave);
      return true;
    })
    .map((o) => ({
      o,
      coste: o.reduce((t, i) => t + utilidadEnOtros(cartas[i], r, todosLosRequisitos), 0),
    }))
    .sort((a, b) => a.coste - b.coste)
    .slice(0, 24)
    .map((x) => x.o);
}

/** Subconjuntos de `k` elementos, hasta `tope`. */
function combinaciones<T>(lista: T[], k: number, tope: number): T[][] {
  const salida: T[][] = [];
  if (k <= 0 || lista.length < k) return salida;
  const actual: T[] = [];
  const bajar = (desde: number) => {
    if (salida.length >= tope) return;
    if (actual.length === k) {
      salida.push([...actual]);
      return;
    }
    for (let i = desde; i < lista.length; i++) {
      actual.push(lista[i]);
      bajar(i + 1);
      actual.pop();
    }
  };
  bajar(0);
  return salida;
}

/**
 * ¿Se pueden repartir EXACTAMENTE estas cartas entre estos huecos?
 *
 * Es un emparejamiento bipartito (cartas ↔ huecos) resuelto con caminos
 * aumentantes. Un voraz daría falsos negativos —bastaría que una carta valiera
 * para dos requisitos y se gastara en el que no tocaba para rechazar una
 * entrega legítima— y un falso negativo aquí es una oferta que el jugador ve
 * completa y no puede cobrar nunca.
 */
function emparejaHuecos(cartas: CartaMinima[], indices: number[], huecos: Hueco[]): boolean {
  if (huecos.length !== indices.length) return false;
  if (huecos.length === 0) return true;

  const compatible = huecos.map((acepta) => indices.map((i) => acepta(cartas[i])));
  const huecoDeCarta = new Array<number>(indices.length).fill(-1);

  const buscar = (hueco: number, visitadas: boolean[]): boolean => {
    for (let c = 0; c < indices.length; c++) {
      if (visitadas[c] || !compatible[hueco][c]) continue;
      visitadas[c] = true;
      if (huecoDeCarta[c] === -1 || buscar(huecoDeCarta[c], visitadas)) {
        huecoDeCarta[c] = hueco;
        return true;
      }
    }
    return false;
  };

  for (let h = 0; h < huecos.length; h++) {
    if (!buscar(h, new Array<boolean>(indices.length).fill(false))) return false;
  }
  return true;
}

/**
 * Validación de la entrega: ¿estas cartas cumplen TODOS los requisitos, sin
 * sobrar ninguna? Cada carta cuenta una sola vez (no se puede reutilizar la
 * misma copia para dos requisitos) y el total tiene que cuadrar al dedillo, así
 * que nadie puede colar cartas de más para inflar el valor del lote.
 *
 * Los tres requisitos "de conjunto" se tratan aparte porque el emparejamiento
 * no sabe expresarlos: playset y evolución se enumeran (son pocas opciones) y
 * el arcoíris se convierte en un hueco POR TIPO, que es exactamente lo que
 * pide ("N cartas de N tipos distintos") y vuelve a caber en el emparejamiento.
 */
function entregaValida(cartas: CartaMinima[], requisitos: Requisito[]): boolean {
  const pedidas = requisitos.reduce((t, r) => t + r.cantidad, 0);
  if (cartas.length !== pedidas) return false;

  const todos = cartas.map((_, i) => i);
  const enumerables = requisitos.filter(
    (r) => r.filtro.categoria === "playset" || r.filtro.categoria === "evolucion",
  );
  const arcoiris = requisitos.filter((r) => r.filtro.categoria === "arcoiris");
  const simples = requisitos.filter((r) => !CATEGORIAS_DE_CONJUNTO.includes(r.filtro.categoria));

  const opciones = enumerables.map((r) => opcionesDeConjunto(cartas, r, todos, requisitos));
  if (opciones.some((o) => o.length === 0)) return false;

  // Cortafuegos de CPU: esto corre en una server action, no en un batch.
  let presupuesto = 400;

  const conArcoiris = (k: number, restantes: number[], huecos: Hueco[]): boolean => {
    if (presupuesto-- <= 0) return false;
    if (k === arcoiris.length) return emparejaHuecos(cartas, restantes, huecos);
    const r = arcoiris[k];
    const tipos = Array.from(
      new Set(
        restantes
          .filter((i) => sirveParaRequisito(cartas[i], r))
          .flatMap((i) => listaSegura(cartas[i].types).map(enMinusculas)),
      ),
    );
    for (const combinacion of combinaciones(tipos, r.cantidad, 200)) {
      const conTipos = combinacion.map<Hueco>(
        (tipo) => (c) =>
          sirveParaRequisito(c, r) && listaSegura(c.types).map(enMinusculas).includes(tipo),
      );
      if (conArcoiris(k + 1, restantes, huecos.concat(conTipos))) return true;
    }
    return false;
  };

  const explorar = (k: number, usadas: Set<number>): boolean => {
    if (presupuesto <= 0) return false;
    if (k === enumerables.length) {
      const restantes = todos.filter((i) => !usadas.has(i));
      const huecos: Hueco[] = [];
      for (const r of simples) {
        for (let i = 0; i < r.cantidad; i++) huecos.push((c) => sirveParaRequisito(c, r));
      }
      return conArcoiris(0, restantes, huecos);
    }
    for (const opcion of opciones[k]) {
      if (opcion.some((i) => usadas.has(i))) continue;
      const siguientes = new Set(usadas);
      opcion.forEach((i) => siguientes.add(i));
      if (explorar(k + 1, siguientes)) return true;
    }
    return false;
  };

  return explorar(0, new Set<number>());
}

/**
 * Tablón vigente + qué ofertas ha cobrado ya este usuario en este ciclo.
 * Funciona sin sesión (el invitado ve el tablón; cobrar es otra cosa).
 */
export async function getMercado() {
  const { ciclo, ofertas } = await tablonVigente();
  const caduca = caducidadDelCiclo(ciclo);

  // Rótulos de expansión del tablón. Viajan como mapa (una docena de entradas)
  // en vez de importar el índice de idioma en el cliente: la pantalla del
  // mercado no necesita el diccionario para nada más.
  //
  // SE RELLENA TAMBIÉN EN INGLÉS. Antes sólo se hacía con idioma español, así
  // que en inglés la pantalla se quedaba con el respaldo de AVAILABLE_SETS y
  // las expansiones que trae el cron salían como "SV10" en mayúsculas.
  const idioma = await idiomaActual();
  const { nombres: nombresEn } = await catalogoDelMercado();
  const nombresSet: Record<string, string> = {};
  for (const o of ofertas) {
    for (const id of [o.setId, ...o.requisitos.map((r) => r.setId)]) {
      if (!id || nombresSet[id]) continue;
      const nombre = (idioma === "es" ? nombreSetEs(id, idioma) : null) ?? nombresEn[id];
      if (nombre) nombresSet[id] = nombre;
    }
  }

  // Y el mismo rótulo DENTRO de la prosa. utils/mercado.ts compone el gancho y
  // el requisito atado con el nombre inglés ("... de Shrouded Fable"), así que
  // sin esto la misma tarjeta decía "Fabula Sombría" en el chip y "Shrouded
  // Fable" tres líneas más abajo, y el jugador no sabe si son la misma
  // expansión. Se cambia SÓLO texto y sobre copias: `id`, `filtro` y `setId`
  // —lo único que compara cumplirOferta— salen intactos, y el tablón cacheado
  // de tablonVigente() no se toca.
  const visibles =
    idioma !== "es"
      ? ofertas
      : ofertas.map((o) => {
          const es = o.setId ? nombresSet[o.setId] : null;
          // El inglés sale del MISMO catálogo con el que se compuso la prosa,
          // no de AVAILABLE_SETS: si no coincidieran, el reemplazo no encontraría
          // la cadena y la tarjeta se quedaría a medio traducir.
          const en = o.setId ? nombresEn[o.setId] : null;
          if (!es || !en || es === en) return o;
          const cambia = (t: string) => t.split(en).join(es);
          return {
            ...o,
            descripcion: cambia(o.descripcion),
            requisitos: o.requisitos.map((r) =>
              r.setId === o.setId ? { ...r, descripcion: cambia(r.descripcion) } : r,
            ),
          };
        });

  const { userId } = await auth();
  if (!userId) {
    return { ciclo, caduca, ofertas: visibles, nombresSet, cumplidas: [] as string[], conSesion: false };
  }

  try {
    await ensureSchema();
    const { rows } = await sql`
      SELECT oferta_id FROM market_claims
      WHERE user_id = ${userId} AND ciclo = ${ciclo}
    `;
    return {
      ciclo,
      caduca,
      ofertas: visibles,
      nombresSet,
      cumplidas: rows.map((r: any) => String(r.oferta_id)),
      conSesion: true,
    };
  } catch (e) {
    console.error("getMercado error:", e);
    // El tablón se puede pintar igual; lo que no se sabe es qué está cobrado.
    return { ciclo, caduca, ofertas: visibles, nombresSet, cumplidas: [] as string[], conSesion: true };
  }
}

/**
 * Cartas del usuario que sirven para ALGUNA oferta del ciclo, con su CANTIDAD
 * REAL y su precio de venta. Sólo se devuelve lo que el tablón necesita: mandar
 * la colección entera son cientos de kilobytes en móvil para nada.
 *
 * POR QUÉ SE DEVUELVE LA CANTIDAD REAL Y NO LOS DUPLICADOS YA RESTADOS: la
 * pantalla necesita las dos cifras (entrega 2 de las 3 que tienes) y la regla
 * tiene una sola definición, `copiasEntregables`, que aplican cliente y servidor
 * por igual. Si aquí se restara la copia reservada, el cliente tendría que
 * "des-restarla" para pintar el total y habría dos versiones de la misma regla.
 *
 * Las cartas de las que sólo hay UNA copia no se mandan: con la regla de
 * duplicados no se pueden entregar, así que no aportan nada al progreso y
 * ocupan payload. Es un filtro de ancho de banda, no la regla: la regla la
 * vuelve a aplicar `cumplirOferta` sobre la BD.
 *
 * `idsInvitado` es el camino del invitado (colección en localStorage): sirve
 * para hidratar por id y enseñarle su progreso. Ahí el servidor NO conoce las
 * cantidades (devuelve 1 de relleno) y las corrige el cliente con las suyas; da
 * igual, porque el invitado no cobra y este dato no toca el dinero.
 */
export async function getCartasMercado(idsInvitado?: string[]) {
  const { ciclo, ofertas } = await tablonVigente();
  const requisitos = ofertas.flatMap((o) => o.requisitos);
  const relevante = (c: CartaMinima) => requisitos.some((r) => sirveParaRequisito(c, r));

  const { userId } = await auth();

  try {
    if (userId) {
      const { rows } = await sql.query(
        `SELECT ${COLUMNAS_MERCADO}, uc.quantity
         FROM user_collection uc
         JOIN cards c ON c.id = uc.card_id
         WHERE uc.user_id = $1 AND uc.quantity > 0`,
        [userId],
      );
      const cartas = rows
        .map((row: any) => cartaDesdeFila(row, Number(row.quantity) || 0))
        // `copiasEntregables > 0` es "tengo al menos un duplicado". Misma
        // función que usa el cobro, así que lo que la pantalla ve entregable y
        // lo que el servidor acepta no pueden discrepar.
        .filter((c) => copiasEntregables(c.cantidad) > 0 && relevante(c));
      return { ciclo, cartas: await conNombreEs(cartas), conSesion: true };
    }

    // --- invitado ---
    if (!Array.isArray(idsInvitado) || idsInvitado.length === 0) {
      return { ciclo, cartas: [] as CartaMercado[], conSesion: false };
    }
    const ids = Array.from(
      new Set(idsInvitado.filter((id) => typeof id === "string" && ID_CARTA.test(id))),
    ).slice(0, 1200);

    // Cantidad 1 = "no la sé". El cliente la sustituye por la de su
    // localStorage antes de repartir; si no lo hiciera, `copiasEntregables(1)`
    // es 0 y el invitado vería su progreso a cero, que es el fallo seguro.
    const encontradas = new Map<string, CartaMercado>();
    try {
      const { rows } = await sql.query(
        `SELECT ${COLUMNAS_MERCADO} FROM cards c WHERE c.id = ANY($1::text[])`,
        [ids],
      );
      for (const row of rows) encontradas.set(row.id, cartaDesdeFila(row, 1));
    } catch (e) {
      // Sin Postgres configurado el invitado sigue jugando: tira del JSON local.
      console.error("getCartasMercado (BD invitado):", e);
    }

    const faltan = ids.filter((id) => !encontradas.has(id));
    if (faltan.length > 0) {
      const porSet = new Map<string, string[]>();
      for (const id of faltan) {
        const corte = id.lastIndexOf("-");
        if (corte <= 0) continue;
        const setId = id.slice(0, corte);
        const lista = porSet.get(setId) ?? [];
        lista.push(id);
        porSet.set(setId, lista);
      }
      // Tope de expansiones a abrir: un localStorage manipulado no puede
      // convertir esta lectura en cien lecturas de disco.
      for (const [setId, pedidas] of Array.from(porSet.entries()).slice(0, 40)) {
        const locales = (await loadLocalCards(setId)) as any[];
        const porId = new Map(locales.map((c) => [c.id, c]));
        for (const id of pedidas) {
          const c = porId.get(id);
          if (c) encontradas.set(id, cartaDesdeLocal(c, 1));
        }
      }
    }

    return {
      ciclo,
      cartas: await conNombreEs(Array.from(encontradas.values()).filter(relevante)),
      conSesion: false,
    };
  } catch (e) {
    console.error("getCartasMercado error:", e);
    return { ciclo, cartas: [] as CartaMercado[], conSesion: Boolean(userId) };
  }
}

/**
 * Cumplir una oferta: entrega el lote y cobra.
 *
 * SEGURIDAD — por qué el cliente no puede inflar el pago:
 *  1. Del navegador sólo llegan el id de la oferta y los ids de las cartas. No
 *     hay parámetro de precio, de multiplicador ni de valor del lote que pudiera
 *     falsearse: como toda server action es un endpoint POST, cualquier campo
 *     de dinero que se aceptara sería un "ponme el saldo que yo diga".
 *  2. La oferta se REGENERA aquí con la semilla del ciclo vigente. Un id de
 *     oferta inventado (o el de ayer, más goloso) no aparece en el tablón y se
 *     rechaza: el multiplicador y la dificultad son los que dicta el generador.
 *  3. Las cartas se releen de `cards` por su id y se comprueba contra
 *     `user_collection` que el usuario las tiene, Y QUE LE SOBRAN: entregar N
 *     copias exige tener N + COPIAS_RESERVADAS (`copiasEntregables`). La
 *     comprobación está por triplicado y a propósito: aquí en JS (para dar un
 *     error legible), dentro del CTE sobre las filas ya bloqueadas con FOR
 *     UPDATE (para que dos pestañas no se salten la reserva entre la lectura y
 *     la escritura) y en el propio UPDATE del consumo (último cerrojo, por si
 *     alguien llegara a esa sentencia por otro camino). Rareza, tipo, PS,
 *     ilustrador y expansión salen de la BD, nunca del payload.
 *  4. El pago es pagoDelLote(oferta, Σ SELL_PRICES reales): multiplicador por
 *     valor, SIN TOPE. Lo que impide que entregar cartas caras dispare la prima
 *     no es un recorte al pago, son dos frenos de utils/mercado.ts: cada
 *     requisito lleva banda de rareza CERRADA (la carta más cara que puede
 *     entrar en un lote vale 70) y sólo se entregan duplicados (de las caras
 *     rara vez hay dos). Por eso aquí no hay ni puede haber un `Math.min`.
 *  5. Cobro y consumo van en UNA sentencia, y la PK de market_claims arbitra
 *     la carrera entre pestañas.
 */
export async function cumplirOferta(ofertaId: string, cardIds: string[]) {
  const { userId } = await auth();
  if (!userId) return { ok: false as const, error: "sesion" as const };

  if (typeof ofertaId !== "string" || ofertaId.length === 0 || ofertaId.length > 200) {
    return { ok: false as const, error: "peticion" as const };
  }
  if (
    !Array.isArray(cardIds) ||
    cardIds.length === 0 ||
    cardIds.length > MAX_CARTAS_ENTREGA ||
    !cardIds.every((id) => typeof id === "string" && ID_CARTA.test(id))
  ) {
    return { ok: false as const, error: "peticion" as const };
  }

  const { ciclo, ofertas } = await tablonVigente();
  const oferta = ofertas.find((o) => o.id === ofertaId);
  // Ni inventada ni de un ciclo anterior: sólo se cobra lo que está en el tablón.
  if (!oferta) return { ok: false as const, error: "caducada" as const };

  // Copias pedidas por id (un playset entrega el mismo id varias veces).
  const porId = new Map<string, number>();
  for (const id of cardIds) porId.set(id, (porId.get(id) ?? 0) + 1);
  const ids = Array.from(porId.keys());
  const cantidades = ids.map((id) => porId.get(id)!);

  try {
    await ensureSchema();

    // La colección manda: si no la tienes, no la entregas.
    const { rows } = await sql.query(
      `SELECT ${COLUMNAS_MERCADO}, uc.quantity
       FROM user_collection uc
       JOIN cards c ON c.id = uc.card_id
       WHERE uc.user_id = $1 AND uc.card_id = ANY($2::text[]) AND uc.quantity > 0`,
      [userId, ids],
    );
    if (rows.length !== ids.length) return { ok: false as const, error: "posesion" as const };

    // Se despliega el multiconjunto: una entrada por copia entregada, con los
    // datos de la BD. A partir de aquí el payload del cliente ya no pinta nada.
    const entregadas: CartaMercado[] = [];
    for (const row of rows) {
      const piden = porId.get(row.id) ?? 0;
      // SÓLO DUPLICADOS: no basta con tener `piden` copias, tienen que SOBRAR
      // `piden`. Una carta con una sola copia no se puede entregar jamás.
      if (copiasEntregables(Number(row.quantity)) < piden) {
        return { ok: false as const, error: "duplicados" as const };
      }
      const carta = cartaDesdeFila(row, Number(row.quantity));
      for (let i = 0; i < piden; i++) entregadas.push(carta);
    }

    if (!entregaValida(entregadas, oferta.requisitos)) {
      return { ok: false as const, error: "requisitos" as const };
    }

    const valorLote = entregadas.reduce((total, c) => total + c.precio, 0);
    const pago = pagoDelLote(oferta, valorLote);
    if (!Number.isFinite(pago) || pago <= 0) return { ok: false as const, error: "pago" as const };

    // Marca, abono y consumo en UNA sentencia:
    //  - `bloqueo` toma un FOR UPDATE sobre las filas de la colección que se van
    //    a gastar. Es lo que serializa DOS ENTREGAS DISTINTAS que comparten
    //    carta. La PK de market_claims sólo impide repetir la MISMA oferta: sin
    //    este bloqueo, dos pestañas cumpliendo ofertas DIFERENTES con las mismas
    //    cartas leían ambas la misma instantánea, insertaban cada una su marca
    //    (ids de oferta distintos, sin conflicto), cobraban las dos, y sólo la
    //    primera descontaba —el guard `quantity >= cantidad` del consumo hace
    //    que la segunda salte la fila—. Resultado: pagado dos veces, cartas
    //    gastadas una. Con FOR UPDATE la segunda espera aquí y, al despertar,
    //    lee la cantidad YA descontada, así que `suficiente` le sale falso.
    //    El ORDER BY fija el orden de bloqueo y evita interbloqueos entre dos
    //    entregas que compartan varias cartas en distinto orden.
    //  - `suficiente` mira, sobre esas filas bloqueadas, que ninguna carta se
    //    quede corta CONTANDO LA COPIA RESERVADA ($7): pide
    //    `quantity >= cantidad + COPIAS_RESERVADAS`, que es exactamente
    //    `copiasEntregables(quantity) >= cantidad` escrito en SQL. Esta es la
    //    comprobación que hace imposible vaciar el álbum con dos pestañas: la
    //    de JS lee una instantánea sin bloquear y podría quedarse vieja; ésta
    //    corre sobre las filas ya bloqueadas, dentro de la misma sentencia que
    //    descuenta. La marca sólo se inserta si el lote cuadra, para que un
    //    intento fallido no queme la oferta.
    //  - el abono depende de que la marca se insertara: si otra pestaña ya la
    //    tenía, el ON CONFLICT no devuelve fila y aquí no se paga nada.
    //  - el consumo depende del abono, así que las cartas nunca desaparecen sin
    //    que el dinero haya entrado (el orden inverso podía cobrar el sobre y
    //    dejar al jugador sin cartas si el abono no tocaba fila).
    const { rows: resultado } = await sql.query(
      `WITH entregas AS (
         SELECT * FROM unnest($3::text[], $4::int[]) AS t(card_id, cantidad)
       ),
       bloqueo AS (
         SELECT uc.card_id, uc.quantity
         FROM user_collection uc
         JOIN entregas e ON e.card_id = uc.card_id
         WHERE uc.user_id = $1
         ORDER BY uc.card_id
         FOR UPDATE OF uc
       ),
       suficiente AS (
         SELECT bool_and(b.card_id IS NOT NULL) AS ok
         FROM entregas e
         LEFT JOIN bloqueo b
           ON b.card_id = e.card_id AND b.quantity >= e.cantidad + $7::int
       ),
       marca AS (
         INSERT INTO market_claims (user_id, ciclo, oferta_id, pago)
         SELECT $1, $2, $5, $6
         WHERE (SELECT ok FROM suficiente)
           -- Sin fila en users el abono no tocaría nada y la marca dejaría la
           -- oferta quemada sin haber pagado: mejor no marcarla siquiera.
           AND EXISTS (SELECT 1 FROM users WHERE id = $1)
         ON CONFLICT DO NOTHING
         RETURNING 1
       ),
       abono AS (
         UPDATE users SET coins = COALESCE(coins, 0) + $6
         WHERE id = $1 AND EXISTS (SELECT 1 FROM marca)
         RETURNING coins
       ),
       consumo AS (
         UPDATE user_collection uc
         SET quantity = uc.quantity - e.cantidad
         FROM entregas e
         WHERE uc.user_id = $1 AND uc.card_id = e.card_id
           AND uc.quantity >= e.cantidad + $7::int
           AND EXISTS (SELECT 1 FROM abono)
         RETURNING 1
       )
       SELECT (SELECT coins FROM abono) AS coins,
              (SELECT count(*) FROM consumo) AS consumidas`,
      [userId, ciclo, ids, cantidades, oferta.id, pago, COPIAS_RESERVADAS],
    );

    const coins = resultado[0]?.coins;
    if (coins === null || coins === undefined) {
      // No se pagó: o la oferta ya estaba cobrada, o la colección cambió entre
      // la lectura y la escritura (otra pestaña vendiendo o entregando las
      // mismas cartas) y a alguna carta dejó de sobrarle la copia que se pedía.
      const { rows: yaEstaba } = await sql`
        SELECT 1 FROM market_claims
        WHERE user_id = ${userId} AND ciclo = ${ciclo} AND oferta_id = ${oferta.id}
      `;
      return {
        ok: false as const,
        error: (yaEstaba.length > 0 ? "repetida" : "posesion") as "repetida" | "posesion",
      };
    }

    const consumidas = Number(resultado[0]?.consumidas ?? 0);
    if (consumidas !== ids.length) {
      // No debería pasar (el guard `suficiente` va en la misma instantánea):
      // si pasa, alguien vendió una carta a la vez. Queda anotado.
      console.error(
        `mercado: entrega parcial usuario=${userId} oferta=${oferta.id} ${consumidas}/${ids.length}`,
      );
    }

    revalidatePath("/");
    revalidatePath("/collection");
    revalidatePath("/mercado");
    return {
      ok: true as const,
      pago,
      valorLote,
      coins: Number(coins),
      entregadas: cardIds.length,
    };
  } catch (e) {
    console.error("cumplirOferta error:", e);
    return { ok: false as const, error: "servidor" as const };
  }
}
