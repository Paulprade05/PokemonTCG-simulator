  // src/app/action.ts
  'use server'

  import { auth, currentUser } from "@clerk/nextjs/server";
  import { sql } from '@vercel/postgres';
  import { revalidatePath } from 'next/cache';
  import { SELL_PRICES, RARITY_RANK, STARTING_COINS, DAILY_BASE, DAILY_STREAK_STEP, DAILY_STREAK_CAP, SET_COMPLETION_BONUS } from "../utils/constanst";
  import { loadLocalSets, loadLocalCards } from "../services/localData";

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
