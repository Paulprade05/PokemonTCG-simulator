// services/esquemaMejoras.ts
//
// Las tablas que añaden las tres funciones nuevas: graduación de cartas,
// precios reales de Cardmarket y bazar entre jugadores.
//
// POR QUÉ AQUÍ Y NO SUELTAS EN LA RUTA DE MIGRACIÓN: es el mismo motivo que
// documenta services/idiomaEsquema.ts. Los módulos que escriben en estas tablas
// (el cron de precios, sobre todo) necesitan asegurarse de que existen antes de
// escribir, y si la declaración se copiase en dos sitios acabaríamos con dos
// tablas distintas en dos despliegues. Una sola declaración, dos consumidores.
//
// TODO CON `IF NOT EXISTS`: la ruta de migración se ejecuta a mano y puede
// repetirse sin miedo. Ojo a la advertencia de app/migrate-core: idempotente NO
// significa correctivo. Si una de estas tablas ya existiera con otros tipos,
// esto la deja como está.
//
// TIMESTAMP SIN ZONA, como todo el esquema: las funciones de Vercel corren en
// UTC y el repositorio es coherente en esto.

/* ==================================================================== *
 * GRADUACIÓN
 * ====================================================================
 *
 * EL PROBLEMA QUE RESUELVE ESTA TABLA: `user_collection` guarda UNA fila por
 * (usuario, carta) con un contador `quantity`. Tres copias son una fila con
 * quantity=3, nunca tres filas — y de esa clave primaria dependen los
 * `ON CONFLICT (user_id, card_id) DO UPDATE` de comprarSobreAction y de
 * acceptTradeOffer, que son las dos sentencias que mueven bienes. O sea: NO
 * EXISTE identidad por copia en ningún sitio, y tocar la forma de esa tabla
 * para dársela rompería las dos sentencias de dinero del juego.
 *
 * Por eso la identidad de copia vive AQUÍ, en una tabla aparte que referencia
 * (user_id, card_id) lógicamente y lleva su propio índice de copia.
 *
 * `copia` NO ES UN ADORNO: es lo que entra en la semilla de la nota
 * (utils/graduacion.ts, semillaDeCopia). Dos copias de la misma carta del mismo
 * usuario tienen notas distintas porque tienen índices distintos, y esa nota
 * estaba decidida desde que la carta entró en la colección. El índice único de
 * abajo es lo que impide graduar dos veces la misma copia para buscar otra nota.
 *
 * `quantity` SIGUE CONTANDO LAS COPIAS GRADUADAS. Es deliberado: si graduar
 * restase de quantity, un usuario que graduara su única copia dejaría de
 * "tener" la carta y perdería el bono de expansión completada. Lo que hace la
 * graduación es PROTEGER la copia, igual que COPIAS_PROTEGIDAS protege la
 * última: las rutas de venta descuentan las graduadas de lo vendible.
 */
export const SENTENCIAS_GRADUACION: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS graded_cards (
     id        SERIAL PRIMARY KEY,
     user_id   TEXT NOT NULL,
     card_id   TEXT NOT NULL,
     copia     INT  NOT NULL,
     nota      INT  NOT NULL,
     coste     INT  NOT NULL DEFAULT 0,
     estado    TEXT NOT NULL DEFAULT 'activa',
     graded_at TIMESTAMP NOT NULL DEFAULT NOW(),
     closed_at TIMESTAMP,
     CONSTRAINT graded_cards_nota_valida CHECK (nota BETWEEN 1 AND 10),
     CONSTRAINT graded_cards_copia_valida CHECK (copia >= 1),
     CONSTRAINT graded_cards_estado_valido CHECK (estado IN ('activa','vendida'))
   )`,

  /* Por si la tabla ya existía sin estas dos columnas (se creó antes de que se
   * descubriera el reciclaje de índices). `CREATE TABLE IF NOT EXISTS` NO
   * corrige una tabla que ya está: eso lo avisa app/migrate-core en su
   * cabecera, y por eso hacen falta estos dos ALTER. */
  `ALTER TABLE graded_cards ADD COLUMN IF NOT EXISTS estado TEXT NOT NULL DEFAULT 'activa'`,
  `ALTER TABLE graded_cards ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP`,

  /* LA GUARDIA CONTRA REPETIR LA TIRADA, y es más importante de lo que parecía.
   *
   * La primera lectura era: "sin este índice, graduar la copia nº2 dos veces
   * insertaría dos filas". Cierto, pero lo pequeño. Lo GRANDE es el reciclaje
   * de índices, que encontró la revisión: como la nota de una copia es
   * determinista y sale de su índice, si una copia graduada desapareciera de
   * esta tabla al venderse, su índice quedaría libre y volver a graduarlo daría
   * OTRA VEZ LA MISMA NOTA. Un jugador que sacara un 10 podría venderlo,
   * conseguir otra copia y volver a sacar el mismo 10, indefinidamente: una
   * imprenta con dos clics.
   *
   * Por eso las copias vendidas NO SE BORRAN: se marcan con estado='vendida' y
   * la fila se queda para siempre ocupando su índice. Este índice, que NO
   * filtra por estado a propósito, es lo que hace que un índice usado no vuelva
   * jamás. Si alguien le añade un `WHERE estado = 'activa'`, reabre la fuga. */
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_graded_cards_copia
     ON graded_cards (user_id, card_id, copia)`,

  // "las graduadas de este usuario", que es lo que pinta la vitrina.
  `CREATE INDEX IF NOT EXISTS idx_graded_cards_user ON graded_cards (user_id)`,

  // El contador que necesitan las rutas de venta: cuántas hay graduadas de ESTA
  // carta de ESTE usuario. Va en su propio índice porque se consulta dentro de
  // sentencias que ya están bloqueando filas y no puede permitirse un escaneo.
  `CREATE INDEX IF NOT EXISTS idx_graded_cards_user_card
     ON graded_cards (user_id, card_id)`,
];

/* ==================================================================== *
 * EL ARCHIVADOR (la vitrina)
 * ====================================================================
 *
 * QUÉ CAMBIA RESPECTO A LA PRIMERA VERSIÓN: la vitrina se llenaba sola con la
 * colección entera, ordenada como la ordena el servidor. Eso no es un
 * archivador, es otra vista de la colección — y quien tiene 441 cartas se
 * encontraba 49 hojas montadas por nadie.
 *
 * Ahora nace VACÍO y cada funda guarda lo que el jugador ponga en ella. Esta
 * tabla es esa decisión: una fila por funda ocupada, y nada más.
 *
 * LA CLAVE PRIMARIA ES (usuario, hoja, ranura) Y NO INCLUYE LA CARTA. Es lo que
 * hace que una funda tenga UNA carta: poner otra encima sustituye, no apila.
 * Sin eso, dos toques seguidos dejarían dos cartas en la misma funda y la hoja
 * pintaría una de las dos según el orden en que Postgres las devolviera.
 *
 * NO HAY TOPE DE HOJAS EN EL ESQUEMA, a propósito: el límite es del código,
 * que es donde se puede cambiar sin migrar. Lo que sí hay es un CHECK de que la
 * ranura cae dentro de la rejilla de nueve, porque una ranura fuera de rango
 * sería una carta invisible: guardada y sin pintar nunca.
 *
 * LA MISMA CARTA PUEDE ESTAR EN VARIAS FUNDAS, pero nunca más veces que copias
 * se tengan. Eso lo comprueba la acción que escribe y no la tabla, porque el
 * número de copias vive en user_collection y una constraint no puede mirar otra
 * tabla.
 */
export const SENTENCIAS_ARCHIVADOR: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS binder_slots (
     user_id   TEXT NOT NULL,
     hoja      INT  NOT NULL,
     ranura    INT  NOT NULL,
     card_id   TEXT NOT NULL,
     placed_at TIMESTAMP NOT NULL DEFAULT NOW(),
     PRIMARY KEY (user_id, hoja, ranura),
     CONSTRAINT binder_slots_hoja_valida CHECK (hoja >= 0),
     CONSTRAINT binder_slots_ranura_valida CHECK (ranura BETWEEN 0 AND 8)
   )`,

  // "el archivador de este usuario": la única consulta que hace la pantalla.
  // Se lee entero de una vez y se pagina en el cliente, que es barato — son
  // como mucho unos cientos de filas y caben de sobra en una respuesta.
  `CREATE INDEX IF NOT EXISTS idx_binder_slots_user
     ON binder_slots (user_id, hoja, ranura)`,

  // "¿en cuántas fundas está ya esta carta?", que es el guard de las copias.
  `CREATE INDEX IF NOT EXISTS idx_binder_slots_carta
     ON binder_slots (user_id, card_id)`,
];

/* ==================================================================== *
 * PRECIOS REALES DE CARDMARKET
 * ====================================================================
 *
 * POR QUÉ UNA TABLA APARTE Y NO UNA COLUMNA EN `cards`: la regla dura del
 * repositorio (services/idiomaEsquema.ts) es que ninguna capa añadida toque
 * nada de lo que dependa la economía. `cards` la escriben la ingesta,
 * /seed-database y syncSetToDatabase, cada una con un juego distinto de
 * columnas y con `DO NOTHING` o `DO UPDATE` parciales: meter aquí un precio
 * que se refresca a diario significaría que una resiembra lo borra.
 *
 * Además `cards.cardmarket` ya existe y viene de pokemontcg.io, que a día de
 * hoy responde 502 y que en los 38 JSON del repositorio está VACÍA en las
 * 252 de 252 cartas comprobadas. La fuente de esta tabla es TCGdex, que sí
 * responde y sirve precios en euros actualizados a diario.
 *
 * `eur` es NUMERIC y NO se mezcla jamás con `users.coins`, que es INT y es
 * moneda del juego. Lo único que cruza la frontera es el ajuste calculado en
 * utils/constanst.ts (ajustePorPrecioReal), que devuelve monedas.
 *
 * `revisado_en` es la cola del cron, igual que en set_translations: se visita
 * siempre lo más viejo primero, así la sincronización es reanudable y no
 * necesita saber por dónde iba.
 */
export const SENTENCIAS_PRECIOS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS card_prices (
     card_id        TEXT PRIMARY KEY,
     eur            NUMERIC(10,2),
     fuente         TEXT NOT NULL DEFAULT 'tcgdex',
     estado         TEXT NOT NULL DEFAULT 'pendiente',
     revisado_en    TIMESTAMP NOT NULL DEFAULT '1970-01-01 00:00:00',
     cambiado_en    TIMESTAMP
   )`,

  // La cola del cron: lo más viejo primero.
  `CREATE INDEX IF NOT EXISTS idx_card_prices_cola ON card_prices (revisado_en)`,
];

/* ==================================================================== *
 * BAZAR ENTRE JUGADORES
 * ====================================================================
 *
 * QUÉ ES: un jugador publica una carta suya a un precio y otro la compra.
 * Es lo que NO existía: el "mercado" que ya había (utils/mercado.ts) es un
 * tablón de encargos contra la máquina, sin contraparte humana.
 *
 * EL RIESGO QUE OBLIGA A CASI TODAS LAS DECISIONES DE AQUÍ: en cuanto dos
 * jugadores pueden ponerse el precio, dos cuentas de la MISMA persona pueden
 * transferirse dinero. Crear cuentas es gratis y cada una recibe 1.000
 * monedas de salida más 165-300 diarias; hasta ahora eso no se podía sacar de
 * la cuenta porque las monedas no se mueven entre usuarios por ninguna vía y
 * el trueque es carta por carta. Un bazar con precio libre rompe justo eso.
 *
 * LAS TRES DEFENSAS, y ninguna se puede quitar sola:
 *   1. `precio` está ACOTADO por el servidor a una banda alrededor del valor
 *      real de la carta (ver LIMITES_BAZAR en services/bazar.ts). Vender un
 *      Common por 10.000 es imposible: no es que se rechace la compra, es que
 *      la publicación no se llega a crear.
 *   2. COMISIÓN sobre la venta: el vendedor cobra menos de lo que paga el
 *      comprador, así que cada pase entre cuentas DESTRUYE monedas. El ciclo
 *      de lavado pierde valor en cada vuelta en vez de ser gratis.
 *   3. La copia protegida SÍ aplica, al contrario que en el trueque. El bazar
 *      saca cartas del juego a cambio de monedas —es un mercado, no un
 *      movimiento— y por eso cae del lado de utils/mercado.ts y no del de
 *      app/social.ts. El porqué de esa asimetría está en social.ts:227-250.
 *
 * `estado` toma 'activa', 'vendida' y 'retirada'. No se borra ninguna fila:
 * el histórico es lo que permite ver un patrón de lavado si alguna vez hace
 * falta mirarlo.
 */
export const SENTENCIAS_BAZAR: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS bazar_listings (
     id         SERIAL PRIMARY KEY,
     seller_id  TEXT NOT NULL,
     card_id    TEXT NOT NULL,
     graded_id  INT,
     nota       INT,
     precio     INT  NOT NULL,
     comision   INT  NOT NULL DEFAULT 0,
     estado     TEXT NOT NULL DEFAULT 'activa',
     buyer_id   TEXT,
     created_at TIMESTAMP NOT NULL DEFAULT NOW(),
     closed_at  TIMESTAMP,
     CONSTRAINT bazar_precio_positivo CHECK (precio > 0),
     CONSTRAINT bazar_estado_valido CHECK (estado IN ('activa','vendida','retirada'))
   )`,

  // El escaparate: las activas, lo más nuevo primero.
  `CREATE INDEX IF NOT EXISTS idx_bazar_activas
     ON bazar_listings (created_at DESC) WHERE estado = 'activa'`,

  // "mis publicaciones" y el tope de publicaciones abiertas por usuario.
  `CREATE INDEX IF NOT EXISTS idx_bazar_vendedor
     ON bazar_listings (seller_id, estado)`,

  // Buscar una carta concreta en el escaparate.
  `CREATE INDEX IF NOT EXISTS idx_bazar_carta
     ON bazar_listings (card_id) WHERE estado = 'activa'`,

  /* UNA COPIA GRADUADA NO PUEDE ESTAR EN DOS ANUNCIOS A LA VEZ. Sin esto, dos
 * pestañas publicando la misma carta graduada crearían dos anuncios y la
 * segunda venta entregaría una carta que ya no está. */
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bazar_graduada_unica
     ON bazar_listings (graded_id) WHERE estado = 'activa' AND graded_id IS NOT NULL`,
];

/** Estados que puede tomar `card_prices.estado`. */
export const ESTADOS_PRECIO = {
  /** Se leyó y tiene precio. */
  ok: "ok",
  /** TCGdex respondió pero esa carta no trae precio de Cardmarket. */
  sinPrecio: "sin_precio",
  /** No hay id de TCGdex para esa carta: no se puede preguntar. */
  sinFuente: "sin_fuente",
  /** TCGdex devolvió 404 para ese id. */
  noEncontrada: "404",
} as const;

/**
 * Las tres tablas juntas, para /migrate-mejoras.
 *
 * EL REPARTO ENTRE LOS TRES ARRAYS NO ES COSMÉTICO, es el criterio que el
 * repositorio ya sigue (services/idiomaIngest.ts:59-78 lo documenta): una tabla
 * que sólo usa un cron se asegura en el módulo del cron, y una tabla que usa la
 * aplicación se asegura en `ensureSchema`. Por eso:
 *
 *   GRADUACION + ARCHIVADOR + BAZAR           ->  ensureSchema (app/action.ts),
 *       porque las tocan acciones del jugador y tienen que existir sí o sí.
 *   SENTENCIAS_PRECIOS                        ->  el propio cron de precios,
 *       porque nadie más escribe ahí y `ensureSchema` se espera antes de CADA
 *       compra de sobre: no se le carga trabajo que no le toca.
 *   las tres                                  ->  /migrate-mejoras, que es la
 *       vía explícita para dejar el esquema listo de una vez.
 */
export const SENTENCIAS_MEJORAS: readonly string[] = [
  ...SENTENCIAS_GRADUACION,
  ...SENTENCIAS_ARCHIVADOR,
  ...SENTENCIAS_PRECIOS,
  ...SENTENCIAS_BAZAR,
];
