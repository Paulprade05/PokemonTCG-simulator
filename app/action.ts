  // src/app/action.ts
  'use server'

  import { auth, currentUser } from "@clerk/nextjs/server";
  import { sql } from '@vercel/postgres';
  import { revalidatePath } from 'next/cache';
  import { AVAILABLE_SETS, SELL_PRICES, RARITY_RANK, STARTING_COINS, DAILY_BASE, DAILY_STREAK_STEP, DAILY_STREAK_CAP, SET_COMPLETION_BONUS } from "../utils/constanst";
  import { loadLocalSets, loadLocalCards } from "../services/localData";
  import {
    OFERTAS_ACTIVAS,
    caducidadDelCiclo,
    cumpleFiltro,
    generarOfertas,
    pagoDelLote,
    precioDeVenta,
    semillaDelCiclo,
    setDeCarta,
    type CartaMinima,
    type Requisito,
  } from "../utils/mercado";

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

  /**
   * Cobro atómico. Es la única forma correcta de gastar monedas.
   *
   * La alternativa que había (escribir un total absoluto calculado en el
   * cliente) tenía dos agujeros: se fiaba del saldo que dijera el navegador, y
   * pisaba cualquier ingreso que hubiera ocurrido entretanto —reclamas la
   * recompensa diaria (+100) y al comprar un sobre acto seguido el total viejo
   * borraba esos 100—. Aquí la resta la hace la base de datos, la condición
   * `coins >= price` impide saldos negativos y dobles cobros, y se devuelve el
   * saldo resultante para que el cliente adopte el del servidor.
   *
   * Devuelve el saldo tras el cobro, o null si no hay sesión, fondos o falla.
   */
  export async function spendCoinsAction(price: number): Promise<number | null> {
    const { userId } = await auth();
    if (!userId) return null;
    if (!Number.isFinite(price) || price <= 0) return null;

    try {
      const { rows } = await sql`
        UPDATE users
        SET coins = coins - ${price}
        WHERE id = ${userId} AND coins >= ${price}
        RETURNING coins
      `;
      if (rows.length === 0) return null; // fondos insuficientes
      revalidatePath('/');
      return Number(rows[0].coins);
    } catch (error) {
      console.error("❌ Error spendCoinsAction:", error);
      return null;
    }
  }

  // `updateCoins` se eliminó: escribía un total absoluto que llegaba del cliente
  // sin validar, así que cualquiera con sesión podía fijarse el saldo a voluntad
  // (era un endpoint POST vivo por estar exportada en un fichero 'use server').
  // No tenía consumidores. Para gastar monedas se usa `spendCoinsAction`, que
  // resta de forma atómica en la base de datos.

  // --- 2. GESTIÓN DE LA COLECCIÓN ---

 // --- 2. GESTIÓN DE LA COLECCIÓN ---

// Contrato compatible con el cliente (app/page.tsx): sigue recibiendo el array
// de cartas del sobre, pero de cada carta SÓLO se usa el `id`. El resto de los
// campos (nombre, rareza, imágenes...) se ignoran a propósito.
//
// Antes se insertaban esas cartas tal cual en la tabla maestra `cards` y se
// acreditaban en la colección. Como una server action es un endpoint POST
// invocable directamente, un cliente podía inventarse cartas Hyper Rare, meterlas
// en el catálogo de TODOS y luego revenderlas: monedas infinitas y catálogo
// contaminado. Ahora sólo se acreditan ids que YA existan en `cards`, y esta
// acción no escribe nunca en `cards`.
export async function savePackToCollection(cards: any[], packPrice: number = 100, packCount: number = 1) {
  const { userId } = await auth();
  if (!userId) return { success: false, error: "No logueado" };

  // Validación de las estadísticas que alimentan el ranking de amigos: sin
  // esto se podía pasar packCount = 1e9 o packPrice negativo y encabezar el
  // ranking de sobres abiertos sin abrir uno.
  if (!Number.isInteger(packCount) || packCount < 1 || packCount > 10) {
    return { success: false, error: "packCount inválido" };
  }
  if (!Number.isFinite(packPrice) || packPrice <= 0 || packPrice > 10000) {
    return { success: false, error: "packPrice inválido" };
  }
  // Tope de tamaño: un sobre legítimo trae ~10 cartas; con packCount<=10 eso son
  // ~100. Un array mucho mayor sólo puede ser un payload de abuso.
  if (!Array.isArray(cards) || cards.length > packCount * 20) {
    return { success: false, error: "Sobre inválido" };
  }

  try {
    // Contamos repeticiones por id: un sobre puede traer la misma carta varias
    // veces y así se acredita la cantidad correcta en un solo upsert.
    const porCarta = new Map<string, number>();
    for (const card of cards) {
      const id = card?.id;
      if (typeof id !== "string" || id.length === 0) continue;
      porCarta.set(id, (porCarta.get(id) || 0) + 1);
    }
    const ids = Array.from(porCarta.keys());
    const counts = ids.map((id) => porCarta.get(id)!);

    if (ids.length > 0) {
      // El JOIN contra `cards` es la validación: sólo se acreditan cartas que
      // existan de verdad en el catálogo maestro. Las cartas inventadas por el
      // cliente no casan y se descartan silenciosamente. Parametrizado con
      // unnest, sin concatenar datos en la cadena.
      await sql.query(
        `INSERT INTO user_collection (user_id, card_id, quantity)
         SELECT $1, x.id, x.cnt
         FROM unnest($2::text[], $3::int[]) AS x(id, cnt)
         JOIN cards c ON c.id = x.id
         ON CONFLICT (user_id, card_id)
         DO UPDATE SET quantity = user_collection.quantity + EXCLUDED.quantity`,
        [userId, ids, counts],
      );
    }

    // Estadísticas del jugador (ya validadas arriba).
    await sql`
      UPDATE users
      SET packs_opened = COALESCE(packs_opened, 0) + ${packCount},
          money_spent = COALESCE(money_spent, 0) + ${packPrice}
      WHERE id = ${userId}
    `;

    revalidatePath('/collection');
    return { success: true };
  } catch (error) {
    console.error("❌ Error guardando pack:", error);
    return { success: false, error: String(error) };
  }
}

  export async function getFullCollection() {
    const { userId } = await auth();
    if (!userId) return [];

    try {
      // ✅ CORRECCIÓN IMPORTANTE:
      // 1. Pedimos la columna 'is_favorite'
      // 2. Ordenamos primero por favoritos (DESC) y luego por cantidad
      const { rows } = await sql`
    SELECT c.*, uc.quantity, uc.is_favorite -- 👈 Asegúrate de pedir esta columna
    FROM user_collection uc
    JOIN cards c ON uc.card_id = c.id
    WHERE uc.user_id = ${userId} AND uc.quantity > 0
    ORDER BY
      uc.is_favorite DESC,  -- 👈 PRIMERO LAS FAVORITAS (True va antes que False)
      c.rarity DESC,        -- Luego por rareza
      c.name ASC            -- Luego por nombre
  `;
      
      const parse = (v: any, fb: any = null) => {
        if (v == null) return fb;
        return typeof v === 'string' ? JSON.parse(v) : v;
      };
      return rows.map((row: any) => ({
        ...row,
        images: parse(row.images),
        tcgplayer: parse(row.tcgplayer),
        types: parse(row.types, []),
        attacks: parse(row.attacks, []),
        weaknesses: parse(row.weaknesses, []),
        retreatCost: parse(row.retreat_cost, []),
        flavorText: row.flavor_text,
      }));
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
   * Devuelve lo ganado y el saldo resultante, o null si no había copia sobrante.
   */
  export async function sellCardAction(cardId: string) {
    const { userId } = await auth();
    if (!userId) return null;

    try {
      const { rows: cardRows } = await sql`SELECT rarity FROM cards WHERE id = ${cardId}`;
      if (cardRows.length === 0) return null;
      const price = SELL_PRICES[cardRows[0].rarity as keyof typeof SELL_PRICES] ?? 10;

      // Descuento y abono en UNA sola sentencia (CTE): o pasan los dos o ninguno.
      // En dos sentencias separadas, si el proceso moría entre medias (timeout,
      // deploy, corte) la copia desaparecía sin abono. El abono sólo ocurre si la
      // venta tocó una fila (EXISTS), y la condición `quantity > 1` protege la
      // última copia sin ventana entre lectura y escritura.
      const { rows } = await sql`
        WITH venta AS (
          UPDATE user_collection
          SET quantity = quantity - 1
          WHERE user_id = ${userId} AND card_id = ${cardId} AND quantity > 1
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

  // El segundo parámetro se conserva sólo por compatibilidad con la llamada del
  // cliente (app/page.tsx) y se IGNORA a propósito: no se puede fiar de las
  // cartas que le manden. En vez de insertar ese payload en la tabla maestra
  // `cards` (por donde se colaban cartas falsas visibles para todos), reconstruye
  // las cartas en el servidor desde el catálogo local, que valida el setId contra
  // el directorio de datos. Un setId inventado no casa con ningún fichero y no
  // siembra nada. Además exige sesión: era la única escritura del fichero sin
  // auth, invocable por cualquier anónimo. (requireAdmin no encaja aquí: espera
  // un Request de route handler, no una server action; y la siembra la disparan
  // usuarios normales al abrir un set, no sólo un administrador.)
  export async function syncSetToDatabase(setId: string, _clientCards?: unknown) {
    const { userId } = await auth();
    if (!userId) return { status: 'unauthorized' };
    try {
      const { count } = (await sql`SELECT count(*) FROM cards WHERE set_id = ${setId}`).rows[0];

      if (parseInt(count) > 0) return { status: 'already_synced' };

      const cards = (await loadLocalCards(setId)) as any[];
      if (cards.length === 0) return { status: 'unknown_set' };

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
   * Vende TODAS las copias sobrantes de una carta, dejando una. El precio
   * unitario sale de la rareza en la base de datos, no del cliente.
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

      const unitPrice = SELL_PRICES[info[0].rarity as keyof typeof SELL_PRICES] ?? 10;
      const totalEarned = duplicates * unitPrice;

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
  // src/app/action.ts
  // src/app/action.ts

  export async function getSetsFromDB() {
    try {
      const { rows } = await sql`
        SELECT id, name, series, images, total, release_date
        FROM sets
        ORDER BY release_date DESC NULLS LAST
      `;
      
      // Si la tabla está vacía todavía no se ha ejecutado el seed.
      if (rows.length === 0) return loadLocalSets();

      return rows.map(set => ({
        ...set,
        releaseDate: set.release_date,
        images: typeof set.images === 'string' ? JSON.parse(set.images) : set.images
      }));
    } catch (error) {
      // Sin Postgres configurado servimos el catálogo del repositorio.
      console.error("Error al obtener sets, uso el JSON local:", error);
      return loadLocalSets();
    }
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
      return rows.map((row: any) => ({
        ...row,
        images: parse(row.images),
        tcgplayer: parse(row.tcgplayer),
        types: parse(row.types, []),
        attacks: parse(row.attacks, []),
        weaknesses: parse(row.weaknesses, []),
        retreatCost: parse(row.retreat_cost, []),
        flavorText: row.flavor_text,
        set: { id: row.set_id, name: row.set_name },
      }));
      
    } catch (error) {
      console.error("❌ Error leyendo colección del entrenador:", error);
      return [];
    }
  }
  // --- SISTEMA DE AMIGOS ---

  // 1. Enviar petición de amistad
  export async function sendFriendRequest(friendId: string) {
    const { userId } = await auth();
    if (!userId) throw new Error("No autorizado");
    if (userId === friendId) return { error: "No puedes añadirte a ti mismo" };

    try {
      // El destinatario debe existir: sin esta comprobación, cualquier cadena
      // creaba una fila colgante que luego aparecía como "Entrenador" fantasma.
      const { rows: target } = await sql`SELECT 1 FROM users WHERE id = ${friendId}`;
      if (target.length === 0) {
        return { error: "Ese entrenador no existe." };
      }

      // Comprobar si ya existe la amistad o la petición
      const { rows: existing } = await sql`
        SELECT 1 FROM friendships
        WHERE (user_id = ${userId} AND friend_id = ${friendId})
          OR (user_id = ${friendId} AND friend_id = ${userId})
      `;

      if (existing.length > 0) {
        return { error: "Ya sois amigos o hay una petición pendiente." };
      }

      // ON CONFLICT DO NOTHING como red de seguridad: la dedupe real de peticiones
      // cruzadas simultáneas necesita un índice único simétrico en `friendships`
      // (LEAST/GREATEST de user_id y friend_id), que debe crear la migración —
      // aquí no se puede añadir el DDL sin afectar al camino caliente.
      await sql`
        INSERT INTO friendships (user_id, friend_id, status)
        VALUES (${userId}, ${friendId}, 'pending')
        ON CONFLICT DO NOTHING
      `;
      return { success: true };
    } catch (error) {
      console.error("Error enviando petición:", error);
      return { error: "Error de servidor al enviar petición." };
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

  // --- FUNCIÓN ACTUALIZADA: Obtener amigos + TÚ MISMO en el Ranking ---
  export async function getFriendsList() {
    const { userId } = await auth();
    if (!userId) return { accepted: [], pendingRequests: [] };

    try {
      const { rows: accepted } = await sql`
        SELECT 
          f.id as friendship_id, 
          CASE WHEN f.user_id = ${userId} THEN f.friend_id ELSE f.user_id END as friend_id,
          COALESCE(u.username, 'Entrenador') as friend_name,
          COALESCE(u.packs_opened, 0) as packs_opened,
          COALESCE(u.money_spent, 0) as money_spent
        FROM friendships f
        LEFT JOIN users u ON u.id = (CASE WHEN f.user_id = ${userId} THEN f.friend_id ELSE f.user_id END)
        WHERE (f.user_id = ${userId} OR f.friend_id = ${userId}) AND f.status = 'accepted'
      `;

      const { rows: pending } = await sql`
        SELECT 
          f.id, 
          f.user_id as requester_id,
          COALESCE(u.username, 'Entrenador') as requester_name
        FROM friendships f
        LEFT JOIN users u ON u.id = f.user_id
        WHERE f.friend_id = ${userId} AND f.status = 'pending'
      `;

      // === 🚨 NUEVO: Te añadimos a ti mismo a la lista del ranking ===
      const { rows: myData } = await sql`
        SELECT 
          id, 
          COALESCE(username, 'Entrenador') as username, 
          COALESCE(packs_opened, 0) as packs_opened, 
          COALESCE(money_spent, 0) as money_spent
        FROM users WHERE id = ${userId}
      `;

      if (myData.length > 0) {
        accepted.push({
          friendship_id: 'me', // Un ID ficticio para que React no se queje
          friend_id: myData[0].id,
          friend_name: myData[0].username + " (Tú)", // Destacamos que eres tú
          packs_opened: myData[0].packs_opened,
          money_spent: myData[0].money_spent
        });
      }
      // ===============================================================

      // Calcular estadísticas de todos (ahora te incluye a ti)
      for (const friend of accepted) {
        const { rows: friendCards } = await sql`
          SELECT uc.quantity, uc.is_favorite, c.rarity
          FROM user_collection uc
          JOIN cards c ON uc.card_id = c.id
          WHERE uc.user_id = ${friend.friend_id} AND uc.quantity > 0
        `;

        let totalValue = 0;
        let totalCards = 0;
        let totalUnique = 0;
        let totalFavs = 0;

        friendCards.forEach((row) => {
          totalUnique += 1;
          totalCards += row.quantity;
          if (row.is_favorite) totalFavs += 1;
          const price = SELL_PRICES[row.rarity as keyof typeof SELL_PRICES] || 10;
          totalValue += (price * row.quantity);
        });

        friend.stats = {
          value: totalValue,
          cards: totalCards,
          unique: totalUnique,
          favs: totalFavs,
          packs: friend.packs_opened,
          spent: friend.money_spent
        };
      }

      // Ordenamos de mayor a menor valor
      accepted.sort((a, b) => b.stats.value - a.stats.value);

      return { accepted, pendingRequests: pending };
    } catch (error) {
      console.error("Error obteniendo amigos:", error);
      return { accepted: [], pendingRequests: [] };
    }
  }

  // 3. Aceptar petición
  export async function acceptFriendRequest(friendshipId: number) {
    const { userId } = await auth();
    if (!userId) return { error: "No autorizado" };

    try {
      await sql`
        UPDATE friendships SET status = 'accepted'
        WHERE id = ${friendshipId} AND friend_id = ${userId}
      `;
      return { success: true };
    } catch (error) {
      return { error: "Error al aceptar petición" };
    }
  }

  // 4. Eliminar amigo o rechazar petición
  export async function removeFriend(friendshipId: number) {
    const { userId } = await auth();
    if (!userId) return { error: "No autorizado" };

    try {
      await sql`
        DELETE FROM friendships
        WHERE id = ${friendshipId} AND (user_id = ${userId} OR friend_id = ${userId})
      `;
      return { success: true };
    } catch (error) {
      return { error: "Error al eliminar amigo" };
    }
  }
  // El sistema de intercambios antiguo (tabla `trades`) vivía aquí. Se retiró:
  // ninguna migración crea esa tabla y no quedaba ningún consumidor. El sistema
  // vigente es app/social.ts, sobre la tabla `trade_offers`.

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
    const { rows: setsRows } = await sql`SELECT id, total FROM sets`;
    const { rows: userRows } = await sql`SELECT packs_opened, money_spent FROM users WHERE id = ${userId}`;
    const packsOpened = userRows[0]?.packs_opened || 0;
    const moneySpent = userRows[0]?.money_spent || 0;
    const totalsBySet: Record<string, number> = {};
    setsRows.forEach((s: any) => { totalsBySet[s.id] = s.total; });

    let totalValue = 0;
    let totalCards = 0;
    let totalUnique = 0;
    const uniquePerSet: Record<string, number> = {};

    cards.forEach((row: any) => {
      totalUnique += 1;
      totalCards += row.quantity;
      const price = SELL_PRICES[row.rarity as keyof typeof SELL_PRICES] || 10;
      totalValue += price * row.quantity;
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
    let setObj: any = { id: row.set_id };
    const { rows: setRows } = await sql`SELECT * FROM sets WHERE id = ${row.set_id} LIMIT 1`;
    if (setRows.length > 0) {
      const s: any = setRows[0];
      setObj = {
        id: s.id, name: s.name, series: s.series,
        printedTotal: s.printed_total, total: s.total,
        ptcgoCode: s.ptcgo_code, releaseDate: s.release_date,
        legalities: parse(s.legalities, {}),
        images: parse(s.images, {}),
      };
    }
    return {
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
    };
  } catch (e) {
    console.error("getCardFromDB error:", e);
    return null;
  }
}

// --- SEARCH CARDS IN DB (replaces live API in GlobalSearch) ---
export async function searchCardsInDB(query: string, page = 1, pageSize = 10) {
  try {
    const { userId } = await auth();

    // page y pageSize llegan del cliente: se acotan en el servidor. Sin esto,
    // pageSize = 1e9 volcaba la tabla `cards` entera en cada tecla del buscador,
    // y valores negativos o no numéricos rompían la consulta.
    const size = Math.min(50, Math.max(1, Math.trunc(Number(pageSize) || 10)));
    const p = Math.max(1, Math.trunc(Number(page) || 1));
    const offset = (p - 1) * size;

    // Escapamos los comodines de LIKE (%, _ y la propia barra de escape): sin
    // esto, buscar "%" o "_" devolvía el catálogo completo. Backslash es el
    // carácter de escape por defecto de LIKE en Postgres.
    const safeTerm = String(query ?? "").toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`);
    const term = `%${safeTerm}%`;

    // Total
    const { rows: countRows } = await sql`
      SELECT count(*)::int AS total FROM cards WHERE LOWER(name) LIKE ${term}
    `;
    const total = countRows[0]?.total || 0;

    let rows: any[];
    if (userId) {
      const res = await sql`
        SELECT c.id, c.name, c.rarity, c.images, c.set_id,
               EXISTS(SELECT 1 FROM user_collection uc WHERE uc.user_id = ${userId} AND uc.card_id = c.id AND uc.quantity > 0) AS owned
        FROM cards c
        WHERE LOWER(c.name) LIKE ${term}
        ORDER BY c.name ASC
        LIMIT ${size} OFFSET ${offset}
      `;
      rows = res.rows;
    } else {
      const res = await sql`
        SELECT id, name, rarity, images, set_id, false AS owned
        FROM cards
        WHERE LOWER(name) LIKE ${term}
        ORDER BY name ASC
        LIMIT ${size} OFFSET ${offset}
      `;
      rows = res.rows;
    }
    const setIds = Array.from(new Set(rows.map((r: any) => r.set_id)));
    const setMap: Record<string, any> = {};
    if (setIds.length > 0) {
      const { rows: setRows } = await sql.query(
        `SELECT id, name FROM sets WHERE id = ANY($1::text[])`,
        [setIds],
      );
      setRows.forEach((s: any) => { setMap[s.id] = s; });
    }
    const data = rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      rarity: r.rarity,
      images: typeof r.images === 'string' ? JSON.parse(r.images) : r.images,
      set: setMap[r.set_id] || { id: r.set_id },
      owned: r.owned,
    }));
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
    const { rows: setsRows } = await sql`SELECT id, total, name FROM sets`;
    const totals: Record<string, { total: number; name: string }> = {};
    setsRows.forEach((s: any) => { totals[s.id] = { total: s.total, name: s.name }; });

    const { rows: already } = await sql`SELECT set_id FROM set_rewards WHERE user_id = ${userId}`;
    const rewarded = new Set(already.map((r: any) => r.set_id));

    const BONUS = SET_COMPLETION_BONUS;
    let granted = 0;
    const completedSets: string[] = [];

    for (const row of owned) {
      const meta = totals[row.set_id];
      if (!meta || !meta.total) continue;
      if (row.owned >= meta.total && !rewarded.has(row.set_id)) {
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
          completedSets.push(meta.name);
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
      const have = rows[0].quantity;
      const rarity = rows[0].rarity;
      // No bajar de 1 copia
      const sellable = Math.min(qtyToSell, Math.max(0, have - 1));
      if (sellable <= 0) continue;
      const price = SELL_PRICES[rarity as keyof typeof SELL_PRICES] || 10;

      // Descuento y abono de esta carta en UNA sentencia (CTE) con la condición
      // de cantidad repetida DENTRO del UPDATE (quantity >= sellable + 1). Antes,
      // entre el SELECT y este UPDATE no se re-verificaba nada: dos pestañas
      // (o dos taps en "vender duplicados") leían ambas la misma cantidad y
      // restaban dos veces, dejando la fila negativa y pagando doble. El guard y
      // el EXISTS cierran la ventana y sólo abonan si de verdad se restó.
      const upd = await sql`
        WITH venta AS (
          UPDATE user_collection SET quantity = quantity - ${sellable}
          WHERE user_id = ${userId} AND card_id = ${cardId} AND quantity >= ${sellable + 1}
          RETURNING 1
        )
        UPDATE users SET coins = coins + ${price * sellable}
        WHERE id = ${userId} AND EXISTS (SELECT 1 FROM venta)
        RETURNING coins
      `;
      if (upd.rows.length === 0) continue; // otra pestaña se adelantó: no se cobra
      earned += price * sellable;
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
    return rows.map((r: any) => ({
      ...r,
      images: typeof r.images === 'string' ? JSON.parse(r.images) : r.images,
    }));
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

/* ==================================================================== *
 * MERCADO DE LOTES
 * ====================================================================
 *
 * REGLA DE ORO: del cliente sólo se acepta QUÉ oferta quiere cobrar y QUÉ
 * cartas entrega. Ni el pago, ni el multiplicador, ni la rareza, ni el valor
 * del lote: todo eso se recalcula aquí contra la tabla `cards`. Ver la nota
 * larga sobre por qué en la cabecera de `cumplirOferta`.
 * ==================================================================== */

/** Tope de cartas por entrega. La oferta más glotona pide 28 (12+10+6). */
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
let setsMercadoCache: string[] | null = null;
async function setsDelMercado(): Promise<string[]> {
  if (setsMercadoCache) return setsMercadoCache;
  const abribles = AVAILABLE_SETS.map((s) => s.id);
  try {
    const locales = (await loadLocalSets()) as { id: string }[];
    const conDatos = new Set(locales.map((s) => s.id));
    const ids = abribles.filter((id) => conDatos.has(id));
    // Sin respaldo legible preferimos el catálogo entero a un tablón vacío.
    setsMercadoCache = ids.length > 0 ? ids : abribles;
  } catch {
    setsMercadoCache = abribles;
  }
  return setsMercadoCache;
}

/** El tablón vigente. Puro: misma semilla ⇒ mismas ofertas, aquí y en el cliente. */
async function tablonVigente() {
  const ciclo = semillaDelCiclo(Date.now());
  const ofertas = generarOfertas(ciclo, await setsDelMercado(), OFERTAS_ACTIVAS);
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

  const { userId } = await auth();
  if (!userId) return { ciclo, caduca, ofertas, cumplidas: [] as string[], conSesion: false };

  try {
    await ensureSchema();
    const { rows } = await sql`
      SELECT oferta_id FROM market_claims
      WHERE user_id = ${userId} AND ciclo = ${ciclo}
    `;
    return {
      ciclo,
      caduca,
      ofertas,
      cumplidas: rows.map((r: any) => String(r.oferta_id)),
      conSesion: true,
    };
  } catch (e) {
    console.error("getMercado error:", e);
    // El tablón se puede pintar igual; lo que no se sabe es qué está cobrado.
    return { ciclo, caduca, ofertas, cumplidas: [] as string[], conSesion: true };
  }
}

/**
 * Cartas del usuario que sirven para ALGUNA oferta del ciclo, con su cantidad
 * y su precio de venta. Sólo se devuelve lo que el tablón necesita: mandar la
 * colección entera son cientos de kilobytes en móvil para nada.
 *
 * `idsInvitado` es el camino del invitado (colección en localStorage): sirve
 * para hidratar por id y enseñarle su progreso. Las cantidades que devuelve ese
 * camino son 1 y las corrige el cliente con las suyas; da igual, porque el
 * invitado no cobra y este dato no toca el dinero.
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
        .filter((c) => c.cantidad > 0 && relevante(c));
      return { ciclo, cartas, conSesion: true };
    }

    // --- invitado ---
    if (!Array.isArray(idsInvitado) || idsInvitado.length === 0) {
      return { ciclo, cartas: [] as CartaMercado[], conSesion: false };
    }
    const ids = Array.from(
      new Set(idsInvitado.filter((id) => typeof id === "string" && ID_CARTA.test(id))),
    ).slice(0, 1200);

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
      cartas: Array.from(encontradas.values()).filter(relevante),
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
 *     `user_collection` que el usuario las tiene. Rareza, tipo, PS, ilustrador
 *     y expansión salen de la BD, nunca del payload.
 *  4. El pago es pagoDelLote(oferta, Σ SELL_PRICES reales), con el techo de
 *     prima que fija utils/mercado.ts. Entregar Hyper Rares en vez de comunes
 *     no dispara el pago: la prima está topada por dificultad.
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
      if (Number(row.quantity) < piden) return { ok: false as const, error: "posesion" as const };
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
    //    quede corta; la marca sólo se inserta si el lote cuadra, para que un
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
           ON b.card_id = e.card_id AND b.quantity >= e.cantidad
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
         WHERE uc.user_id = $1 AND uc.card_id = e.card_id AND uc.quantity >= e.cantidad
           AND EXISTS (SELECT 1 FROM abono)
         RETURNING 1
       )
       SELECT (SELECT coins FROM abono) AS coins,
              (SELECT count(*) FROM consumo) AS consumidas`,
      [userId, ciclo, ids, cantidades, oferta.id, pago],
    );

    const coins = resultado[0]?.coins;
    if (coins === null || coins === undefined) {
      // No se pagó: o la oferta ya estaba cobrada, o la colección cambió entre
      // la lectura y la escritura (otra pestaña vendiendo las mismas cartas).
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
