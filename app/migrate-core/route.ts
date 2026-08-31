import { sql } from "@vercel/postgres";
import { NextResponse } from "next/server";
import { requireAdmin } from "../_admin-auth";
import { SENTENCIAS_IDIOMA } from "@/services/idiomaEsquema";

/* ==================================================================== *
 * EL ESQUEMA BASE
 * ====================================================================
 *
 * POR QUÉ EXISTE ESTE FICHERO: hasta ahora no había en todo el repositorio ni
 * un solo `CREATE TABLE` para `users`, `cards`, `sets`, `user_collection` ni
 * `friendships`. Las migraciones que sí existían —/migrate-schema y
 * /migrate-social— son todas `ALTER TABLE` sobre tablas que daban por hechas,
 * y `ensureSchema` (app/action.ts) sólo crea las cuatro auxiliares
 * (wishlist, set_rewards, market_claims, pack_purchases).
 *
 * Consecuencia: un despliegue nuevo no arrancaba, y la clave primaria
 * `(user_id, card_id)` de la que depende el `ON CONFLICT` de comprarSobreAction
 * —la sentencia que cobra y acredita en el mismo comando— no estaba escrita en
 * ningún sitio. Su corrección dependía de una base creada a mano que nadie
 * podía reproducir.
 *
 * ORDEN DE EJECUCIÓN EN UN DESPLIEGUE NUEVO:
 *   1. /migrate-core     <- este fichero: las cinco tablas base
 *   2. /migrate-schema      columnas ricas de `cards` e índices
 *   3. /migrate-social      `trade_offers` y los índices de usuario
 *   4. /seed-database       las cartas del repositorio
 * Las auxiliares las crea sola la app en la primera petición (`ensureSchema`).
 *
 * ES IDEMPOTENTE Y SEGURO SOBRE UNA BASE CON DATOS: todo va con
 * `IF NOT EXISTS`, así que sobre una base ya montada no toca ni una fila. OJO
 * con lo que eso implica: si una tabla YA existe con un tipo distinto al de
 * aquí, este fichero NO la corrige —sólo la deja como está—. Los tipos de abajo
 * están deducidos de cómo consulta el código, y el sitio donde se comprueban de
 * verdad es un despliegue nuevo.
 */

/**
 * Cada sentencia va con el porqué de sus claves, que es lo que no se puede
 * deducir leyendo sólo los nombres de las columnas.
 */
const SENTENCIAS: readonly string[] = [
  /* ---------------------------------------------------------------- *
   * users
   * ----------------------------------------------------------------
   * `id` es el id de Clerk (texto, "user_xxx"), y es la clave del
   * `ON CONFLICT (id)` de getUserData, syncUserName, setUserTheme y setUserLang.
   *
   * `coins` va SIN valor por defecto y aceptando NULL a propósito: el código lo
   * trata así en todas partes (`COALESCE(users.coins, STARTING_COINS)` al
   * crear/reparar la fila, `COALESCE(coins, 0)` al abonar). Un DEFAULT 0 sería
   * peor que NULL: un usuario nuevo nacería con cero monedas en vez de con su
   * saldo inicial, y el COALESCE de reparación ya no podría distinguirlo.
   *
   * `packs_opened` y `money_spent` los incrementa comprarSobreAction con
   * COALESCE, así que el DEFAULT 0 es sólo comodidad.
   */
  `CREATE TABLE IF NOT EXISTS users (
     id               TEXT PRIMARY KEY,
     username         TEXT,
     coins            INT,
     packs_opened     INT DEFAULT 0,
     money_spent      INT DEFAULT 0,
     last_daily_claim TIMESTAMP,
     streak           INT DEFAULT 0,
     theme            TEXT,
     lang             TEXT,
     created_at       TIMESTAMP DEFAULT NOW()
   )`,
  // searchUsersByName y addFriend buscan por nombre en minúsculas.
  `CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username))`,

  /* ---------------------------------------------------------------- *
   * sets
   * ----------------------------------------------------------------
   * Columnas y orden calcados de COLUMNAS_SETS (services/ingest.ts), que es
   * quien escribe aquí junto con /seed-database y /ingest-tcg. Los tres usan
   * `ON CONFLICT (id)`, de ahí la clave primaria.
   *
   * `release_date` es TEXT y no DATE porque la API sirve "2024/01/26" y tanto
   * la ingesta como el seed lo insertan tal cual. Ese formato ordena igual como
   * texto que como fecha, así que el `ORDER BY release_date DESC NULLS LAST` de
   * getSetsFromDB sale bien en ambos casos; el cliente lo vuelve a parsear con
   * `new Date()` (app/page.tsx), que también acepta la cadena.
   */
  `CREATE TABLE IF NOT EXISTS sets (
     id            TEXT PRIMARY KEY,
     name          TEXT NOT NULL,
     series        TEXT,
     printed_total INT,
     total         INT,
     legalities    JSONB,
     ptcgo_code    TEXT,
     release_date  TEXT,
     images        JSONB,
     updated_at    TIMESTAMP DEFAULT NOW()
   )`,

  /* ---------------------------------------------------------------- *
   * cards
   * ----------------------------------------------------------------
   * El catálogo maestro. Las columnas son las de COLUMNAS_CARDS
   * (services/ingest.ts); /migrate-schema las añade una a una sobre una tabla
   * que ya existía, así que aquí van todas de golpe y aquella queda como lo que
   * es: la migración de las bases viejas.
   *
   * Todo lo que la ingesta escribe con `JSON.stringify(v ?? null)` es JSONB.
   * `hp` y `number` son TEXT y no números: la API sirve "120" pero también
   * números de carta como "GG01", "TG12" o "SV107", y services/pokemon.ts los
   * ordena con un CASE que ya cuenta con ello.
   *
   * El JOIN contra esta tabla es lo que valida que una carta existe de verdad
   * en comprarSobreAction, cumplirOferta y acceptTradeOffer.
   */
  `CREATE TABLE IF NOT EXISTS cards (
     id                       TEXT PRIMARY KEY,
     name                     TEXT NOT NULL,
     supertype                TEXT,
     subtypes                 JSONB,
     level                    TEXT,
     hp                       TEXT,
     types                    JSONB,
     evolves_from             TEXT,
     evolves_to               JSONB,
     rules                    JSONB,
     ancient_trait            JSONB,
     abilities                JSONB,
     attacks                  JSONB,
     weaknesses               JSONB,
     resistances              JSONB,
     retreat_cost             JSONB,
     converted_retreat_cost   INTEGER,
     set_id                   TEXT,
     number                   TEXT,
     artist                   TEXT,
     rarity                   TEXT,
     flavor_text              TEXT,
     national_pokedex_numbers JSONB,
     legalities               JSONB,
     regulation_mark          TEXT,
     images                   JSONB,
     tcgplayer                JSONB,
     cardmarket               JSONB,
     updated_at               TIMESTAMP DEFAULT NOW()
   )`,
  /* EL ÍNDICE MÁS IMPORTANTE DE LA APLICACIÓN, y por eso está aquí y no sólo en
   * /migrate-schema: por `set_id` entran el álbum, la tienda, la siembra, el
   * sorteo de CADA compra y los tres `sets LEFT JOIN cards GROUP BY` que
   * calculan el progreso. Sin él, un despliegue que se quedara sólo en
   * migrate-core haría barrido secuencial de la tabla entera en todos ellos. */
  `CREATE INDEX IF NOT EXISTS idx_cards_set_id ON cards (set_id)`,

  /* ---------------------------------------------------------------- *
   * user_collection
   * ----------------------------------------------------------------
   * LA CLAVE PRIMARIA COMPUESTA ES LO MÁS IMPORTANTE DE ESTE FICHERO. Sin ella
   * el `ON CONFLICT (user_id, card_id)` de comprarSobreAction y del CTE `suma`
   * de acceptTradeOffer no compila, y con ella es lo que hace que abrir el mismo
   * sobre dos veces sume cantidades en vez de duplicar filas.
   *
   * `quantity` puede quedarse a 0 y NO se borra: app/social.ts documenta por qué
   * (el DELETE de limpieza provocaba interbloqueos en el 11% de los
   * intercambios concurrentes). Todas las lecturas filtran `quantity > 0`, así
   * que una fila a cero es indistinguible de una ausente, y conservarla conserva
   * su `is_favorite` para cuando la carta vuelva.
   *
   * `is_favorite` se lee siempre con COALESCE(..., false), así que el DEFAULT es
   * comodidad, no un supuesto.
   */
  `CREATE TABLE IF NOT EXISTS user_collection (
     user_id     TEXT NOT NULL,
     card_id     TEXT NOT NULL,
     quantity    INT NOT NULL DEFAULT 0,
     is_favorite BOOLEAN DEFAULT FALSE,
     PRIMARY KEY (user_id, card_id)
   )`,
  // La consulta más caliente de la app: "las cartas de este usuario". El índice
  // parcial deja fuera las filas a cero, que son las que nunca se leen.
  `CREATE INDEX IF NOT EXISTS idx_user_collection_user
     ON user_collection (user_id) WHERE quantity > 0`,
  // getTrainerCollection y el JOIN de cumplirOferta entran por card_id.
  `CREATE INDEX IF NOT EXISTS idx_user_collection_card ON user_collection (card_id)`,

  /* ---------------------------------------------------------------- *
   * friendships
   * ----------------------------------------------------------------
   * `id` es SERIAL porque acceptFriend y removeFriendship reciben un número
   * desde el cliente y filtran por él (siempre junto al userId de la sesión,
   * que es lo que impide tocar la amistad de otro).
   */
  `CREATE TABLE IF NOT EXISTS friendships (
     id         SERIAL PRIMARY KEY,
     user_id    TEXT NOT NULL,
     friend_id  TEXT NOT NULL,
     status     TEXT NOT NULL DEFAULT 'pending',
     created_at TIMESTAMP DEFAULT NOW()
   )`,
  /* EL ÍNDICE SIMÉTRICO QUE FALTABA.
   *
   * La amistad no tiene sentido: (A,B) y (B,A) son la misma. Sin este índice,
   * dos peticiones cruzadas simultáneas (A pide a B mientras B pide a A) pasan
   * las dos la comprobación previa de `addFriend` —que es una lectura sin
   * bloqueo— y crean DOS filas: la pareja aparece dos veces en la lista.
   *
   * OJO: `addFriend` (app/social.ts) hace un INSERT pelado, sin ON CONFLICT, así
   * que con el índice puesto la perdedora de esa carrera recibe "Error al enviar
   * petición" en vez de "ya hay una petición pendiente". Es un mensaje peor,
   * pero el estado queda correcto, que es lo que importa; el mensaje se arregla
   * añadiendo allí un ON CONFLICT DO NOTHING.
   *
   * LEAST/GREATEST normalizan el par, así que el índice es el mismo se pida en
   * el orden que se pida. Puede fallar sobre una base que YA tenga duplicados:
   * por eso la ruta lo intenta aparte y sigue si no cuaja, en vez de abortar la
   * migración entera (ver más abajo).
   */
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_friendships_par
     ON friendships (LEAST(user_id, friend_id), GREATEST(user_id, friend_id))`,
  // Las dos direcciones de la consulta de getSocialOverview.
  `CREATE INDEX IF NOT EXISTS idx_friendships_user   ON friendships (user_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships (friend_id, status)`,

  /* ---------------------------------------------------------------- *
   * CAPA DE TRADUCCIONES
   * ----------------------------------------------------------------
   * Se importan en vez de copiarse: las mismas sentencias las usa el cron de
   * traducciones para asegurarse de que la tabla existe antes de escribir, y
   * dos declaraciones que divergen darían tablas distintas en dos despliegues.
   * Van al final porque no dependen de nada de arriba. */
  ...SENTENCIAS_IDIOMA,
];

export async function GET(request: Request) {
  const noAutorizado = requireAdmin(request);
  if (noAutorizado) return noAutorizado;

  const aplicadas: string[] = [];
  const fallidas: { sentencia: string; error: string }[] = [];

  for (const stmt of SENTENCIAS) {
    // Cada sentencia va por su cuenta y un fallo no aborta el resto: sobre una
    // base con datos, el único que puede fallar de verdad es el índice único de
    // `friendships` (si ya hay pares duplicados), y que eso impidiera crear las
    // tablas restantes sería el peor resultado posible de una migración.
    try {
      await sql.query(stmt);
      aplicadas.push(resumen(stmt));
    } catch (e: any) {
      console.error("migrate-core:", resumen(stmt), e?.message ?? e);
      fallidas.push({ sentencia: resumen(stmt), error: String(e?.message ?? e) });
    }
  }

  return NextResponse.json(
    {
      ok: fallidas.length === 0,
      aplicadas,
      fallidas,
      siguiente: "/migrate-schema, luego /migrate-social, luego /seed-database",
    },
    { status: fallidas.length === 0 ? 200 : 207 },
  );
}

/** "CREATE TABLE users" a partir de la sentencia, para el informe de salida. */
function resumen(stmt: string): string {
  return (
    stmt
      .trim()
      .split("\n")[0]
      .replace(/\s+/g, " ")
      .replace(/\s*\($/, "")
      .trim() || stmt.slice(0, 60)
  );
}
