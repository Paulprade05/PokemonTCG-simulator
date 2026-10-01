import { randomInt } from "node:crypto";
import { sql } from "@vercel/postgres";
import { NextResponse } from "next/server";
import { requireAdmin } from "../_admin-auth";
import { SENTENCIAS_CODIGOS_AMIGO } from "../../services/esquemaSocial";
import { generarCodigoAmigo } from "../../utils/codigoAmigo";

/** Usuarios por tanda del relleno de códigos. */
const TANDA_RELLENO = 500;

/**
 * Tiempo que el relleno se permite antes de cortar y devolver lo que lleva. Las
 * funciones de Vercel tienen un límite, y una migración que muere a medias sin
 * decir cuánto hizo es peor que una que para a tiempo y se vuelve a llamar.
 */
const PRESUPUESTO_RELLENO_MS = 20000;

/**
 * Da código de amigo a los usuarios que aún no lo tienen. OPCIONAL: sólo corre
 * con `?relleno=1`, y la aplicación funciona igual sin él, porque el código se
 * crea solo la primera vez que hace falta (`codigosDe` en app/social.ts). Sirve
 * para que nadie pague ese primer INSERT en mitad de una búsqueda.
 *
 * REANUDABLE SIN CURSOR: cada tanda pide «usuarios sin código», así que la
 * propia tabla es la cola. Si se corta por tiempo, la siguiente llamada sigue
 * donde quedó; y si un código sorteado choca con otro, el ON CONFLICT lo deja
 * sin insertar y ese usuario vuelve a salir en la tanda siguiente con otro.
 *
 * Para si una tanda entera no consigue insertar nada: con 31⁸ códigos no puede
 * pasar por colisiones, así que sería otra cosa y repetirla no la arreglaría.
 */
async function rellenarCodigos(): Promise<{ creados: number; pendientes: number }> {
  const inicio = Date.now();
  let creados = 0;
  while (Date.now() - inicio < PRESUPUESTO_RELLENO_MS) {
    const { rows } = await sql.query(
      `SELECT u.id
         FROM users u
         LEFT JOIN friend_codes fc ON fc.user_id = u.id
        WHERE fc.user_id IS NULL
        ORDER BY u.id
        LIMIT $1::int`,
      [TANDA_RELLENO],
    );
    if (rows.length === 0) break;
    const ids = rows.map((r: { id: unknown }) => String(r.id));
    const { rowCount } = await sql.query(
      `INSERT INTO friend_codes (user_id, code)
       SELECT t.user_id, t.code
         FROM unnest($1::text[], $2::text[]) AS t(user_id, code)
       ON CONFLICT DO NOTHING`,
      [ids, ids.map(() => generarCodigoAmigo((tope) => randomInt(tope)))],
    );
    if (!rowCount) break;
    creados += rowCount;
  }
  const { rows: resto } = await sql.query(
    `SELECT count(*)::int AS n
       FROM users u
       LEFT JOIN friend_codes fc ON fc.user_id = u.id
      WHERE fc.user_id IS NULL`,
  );
  return { creados, pendientes: Number(resto[0]?.n) || 0 };
}

export async function GET(request: Request) {
  const noAutorizado = requireAdmin(request);
  if (noAutorizado) return noAutorizado;

  try {
    const stmts = [
      // Multi-card trade offers
      `CREATE TABLE IF NOT EXISTS trade_offers (
        id SERIAL PRIMARY KEY,
        sender_id TEXT NOT NULL,
        receiver_id TEXT NOT NULL,
        offered_ids JSONB NOT NULL DEFAULT '[]',
        requested_ids JSONB NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        message TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        seen_by_sender BOOLEAN DEFAULT FALSE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_trade_offers_receiver ON trade_offers (receiver_id, status)`,
      `CREATE INDEX IF NOT EXISTS idx_trade_offers_sender ON trade_offers (sender_id, status)`,
      // users niceties
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username))`,
      // El código de amigo. Se importa en vez de copiarse: la misma sentencia
      // la usa app/social.ts para asegurarse de que la tabla existe.
      ...SENTENCIAS_CODIGOS_AMIGO,
    ];
    for (const s of stmts) {
      // DDL dinámico: por eso `sql.query` y no la plantilla etiquetada.
      await sql.query(s);
    }

    /* ¿ESTÁ EL ÍNDICE QUE IMPIDE DOS FILAS POR PAREJA?
     *
     * `idx_friendships_par` lo crea /migrate-core, y lo intenta aparte porque
     * falla si la base ya trae parejas duplicadas. El flujo de amigos funciona
     * sin él, pero sin él dos peticiones cruzadas simultáneas pueden dejar dos
     * filas. Aquí NO se crea —un CREATE UNIQUE INDEX bloquea las escrituras de
     * `friendships` mientras se construye, y si hay duplicados falla—: sólo se
     * mira y se dice, para que quien despliega lo sepa sin abrir la base. */
    const { rows: indice } = await sql.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'idx_friendships_par'`,
    );
    const indiceDePareja = indice.length > 0;

    /* SI FALTA, CUÁNTAS PAREJAS LO IMPIDEN. El índice no se deja crear mientras
     * haya una pareja con dos filas, y hasta ahora eso había que ir a contarlo
     * a mano a la base. Sólo se cuenta —limpiarlas es decisión de quien
     * administra— y sólo cuando el índice falta: es un recorrido entero de
     * `friendships`. Va en su propio try porque es un dato de ayuda y no puede
     * hacer fallar la migración que ya se ha aplicado. */
    let parejasDuplicadas: number | null = null;
    if (!indiceDePareja) {
      try {
        const { rows: dup } = await sql.query(
          `SELECT count(*)::int AS n
             FROM (SELECT 1
                     FROM friendships
                    GROUP BY LEAST(user_id, friend_id), GREATEST(user_id, friend_id)
                   HAVING count(*) > 1) d`,
        );
        parejasDuplicadas = Number(dup[0]?.n) || 0;
      } catch (e) {
        console.error("migrate-social: no se pudieron contar las parejas duplicadas:", e);
      }
    }

    /* ¿PASA `LOWER()` A MINÚSCULA LAS LETRAS QUE NO SON ASCII?
     *
     * La búsqueda por nombre (`buscarEntrenadores`) compara `LOWER(username)`
     * con lo tecleado, que JS ya ha pasado a minúsculas. En una base creada con
     * LC_CTYPE = 'C', `LOWER` sólo conoce el ASCII: «Ñandú» o «Álvaro» no se
     * encuentran escribiendo «ñandú» o «álvaro». Depende de cómo se creó la
     * base y desde el código no se puede saber, así que se PRUEBA aquí y se
     * dice, igual que con el índice: quien despliega lo ve sin abrir la base.
     * Las letras van como parámetros para que la comparación use la colación
     * por defecto de la base, la misma que usa la columna. En su propio try: es
     * un dato de ayuda y no puede hacer fallar la migración ya aplicada. */
    let minusculasUnicode: boolean | null = null;
    try {
      const { rows: prueba } = await sql.query(
        `SELECT LOWER($1::text) = $2::text AS coincide`,
        ["ÑÁÜ", "ñáü"],
      );
      minusculasUnicode = prueba[0]?.coincide === true;
    } catch (e) {
      console.error("migrate-social: no se pudo probar LOWER con letras no ASCII:", e);
    }

    const quiereRelleno = new URL(request.url).searchParams.get("relleno") === "1";
    const relleno = quiereRelleno ? await rellenarCodigos() : null;

    return NextResponse.json({
      ok: true,
      applied: stmts.length,
      indiceDePareja,
      ...(indiceDePareja
        ? {}
        : {
            aviso: "Falta idx_friendships_par: ejecuta /migrate-core y revisa si quedó en «fallidas» (parejas duplicadas en friendships).",
            parejasDuplicadas,
          }),
      minusculasUnicode,
      ...(minusculasUnicode === false
        ? {
            avisoBusqueda:
              "LOWER() de esta base no pasa a minúscula las letras no ASCII (LC_CTYPE = C): la búsqueda por nombre no encuentra nombres con Ñ o vocales acentuadas en mayúscula.",
          }
        : {}),
      ...(relleno
        ? { relleno }
        : { nota: "Los códigos de amigo se crean solos al primer uso. Para crearlos ya: /migrate-social?relleno=1 (se puede repetir)." }),
    });
  } catch (e: any) {
    console.error("migrate-social error:", e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
