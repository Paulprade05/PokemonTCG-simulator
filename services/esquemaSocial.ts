// services/esquemaSocial.ts
//
// El esquema del flujo de amigos: UNA tabla nueva y ningún ALTER.
//
// POR QUÉ AQUÍ Y SIN IMPORTS: el mismo motivo que services/idiomaEsquema.ts. La
// sentencia la necesitan dos sitios —`app/migrate-social/route.ts`, que la
// aplica al desplegar, y `app/social.ts`, que se asegura de que la tabla existe
// antes de leer o crear un código— y dos copias que divergen son dos tablas
// distintas en dos despliegues.
//
// POR QUÉ NO SE AÑADE A `ensureSchema` DE app/action.ts: ese camino lanza
// cuatro `ALTER TABLE users` en cada arranque en frío, y cada uno toma un
// candado ACCESS EXCLUSIVE sobre la tabla más caliente de la aplicación. Esto
// es un `CREATE TABLE IF NOT EXISTS` de una tabla NUEVA con sus claves en
// línea: no bloquea `users` ni `friendships`, y sólo lo pagan las acciones que
// de verdad tocan `friend_codes`.

/* ==================================================================== *
 * friend_codes — el código de amigo de cada cuenta
 * ====================================================================
 *
 * UNA FILA POR USUARIO, Y EL USUARIO ES LA CLAVE: regenerar el código es un
 * UPDATE de su fila, no una fila más, así que el código viejo deja de existir
 * en el mismo instante (los enlaces y los QR ya compartidos dejan de valer, que
 * es justo para lo que alguien lo cambia).
 *
 * `code` ES ÚNICO Y ESE ÍNDICE ES EL ÁRBITRO: el código se sortea en JS
 * (utils/codigoAmigo.ts) sin mirar la base. Si dos cuentas sacan el mismo, la
 * segunda choca aquí (error 23505) y quien inserta sortea otro. Con 31⁸
 * combinaciones no pasa en la práctica, pero el índice es además lo que hace
 * que buscar un código sea una lectura de índice y no un recorrido.
 *
 * EL CHECK REPITE LA FORMA DE `FORMA_CODIGO_AMIGO` (utils/codigoAmigo.ts): ocho
 * caracteres de los dígitos 2-9 y las letras sin I, L ni O. Está aquí porque
 * la base es el último sitio donde un código mal formado puede pararse; si
 * entrara uno con una O, nadie podría teclearlo nunca. Las dos expresiones son
 * la misma regla escrita dos veces: si se cambia una, se cambian las dos.
 *
 * SIN FOREIGN KEY contra `users`, como el resto del esquema social
 * (`friendships` tampoco la tiene): la fila de `users` la crea `getUserData`
 * con un upsert, y un código pedido una fracción de segundo antes no debe
 * fallar por esa carrera.
 *
 * `created_at` es NOT NULL con DEFAULT porque esta tabla nace aquí y siempre
 * lo tiene. OJO, que no es el caso de `friendships.created_at` ni de
 * `users.created_at`: ésas sólo existen si la tabla nació con /migrate-core, y
 * por eso app/social.ts ordena por `id` y no las lee nunca.
 */
export const SENTENCIAS_CODIGOS_AMIGO: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS friend_codes (
     user_id    TEXT PRIMARY KEY,
     code       TEXT NOT NULL,
     created_at TIMESTAMP NOT NULL DEFAULT NOW(),
     CONSTRAINT friend_codes_code_unico UNIQUE (code),
     CONSTRAINT friend_codes_code_forma CHECK (code ~ '^[2-9A-HJKMNP-Z]{8}$')
   )`,
];

/* ==================================================================== *
 * friendships.status — los valores que existen
 * ====================================================================
 *
 * La columna es TEXT SIN CHECK, así que añadir estados no pide migración. Las
 * consultas anteriores a este flujo sólo conocen 'pending' y 'accepted' y
 * filtran por ellos de forma explícita, de modo que los nuevos les son
 * invisibles: una fila 'declined' o 'blocked' no aparece como amigo ni como
 * petición en ningún sitio viejo.
 *
 * SIEMPRE HAY COMO MUCHO UNA FILA POR PAREJA (la garantiza `idx_friendships_par`
 * de /migrate-core), y por eso el estado tiene que decir también QUIÉN hizo
 * qué: lo dice la dirección de la fila.
 *
 *   pending       user_id pidió amistad a friend_id y éste no ha contestado.
 *   accepted      son amigos. La dirección ya no significa nada.
 *   declined      friend_id rechazó la petición de user_id. La fila SE QUEDA:
 *                 es lo que impide que el rechazado reenvíe sin límite (antes
 *                 «Ignorar» la borraba). El rechazo es silencioso: user_id la
 *                 sigue viendo como enviada.
 *   withdrawn     una 'declined' que su emisor (user_id) ha cancelado. Existe
 *                 para que «Cancelar» haga algo visible —la petición sale de
 *                 su lista— sin devolverle la posibilidad de volver a molestar:
 *                 si reenvía, la fila vuelve a 'declined' sin que friend_id se
 *                 entere.
 *   blocked       user_id ha bloqueado a friend_id.
 *   blocked_both  se han bloqueado los dos. Hace falta porque sólo hay una
 *                 fila por pareja: sin él, el bloqueo del segundo se perdería
 *                 en cuanto el primero levantara el suyo.
 *   blocked_declined
 *                 user_id ha bloqueado a friend_id, y ANTES friend_id le había
 *                 rechazado una petición (la fila venía de 'declined' o de
 *                 'withdrawn'). Hace falta por lo mismo: el bloqueo reutiliza
 *                 la fila y al pasarla a 'blocked' se perdía el rechazo, de
 *                 modo que el rechazado podía bloquear, desbloquear (la fila
 *                 se borraba) y volver a pedir, sin límite. Al desbloquear,
 *                 esta fila no se borra: vuelve a 'withdrawn'. Para todo lo
 *                 demás se comporta como 'blocked'.
 */
export const ESTADOS_AMISTAD = {
  PENDIENTE: "pending",
  ACEPTADA: "accepted",
  RECHAZADA: "declined",
  RETIRADA: "withdrawn",
  BLOQUEO: "blocked",
  BLOQUEO_MUTUO: "blocked_both",
  BLOQUEO_TRAS_RECHAZO: "blocked_declined",
} as const;

export type EstadoAmistad = (typeof ESTADOS_AMISTAD)[keyof typeof ESTADOS_AMISTAD];

/**
 * Los topes del flujo de amigos. No son límites de producto finos: antes no
 * había NINGUNO, y una sola cuenta podía pedir amistad a todo el directorio o
 * llenarle la bandeja a alguien.
 *
 *  · PETICIONES_ENVIADAS: pendientes a la vez por emisor. Sólo cuentan las
 *    'pending' de verdad; las rechazadas en silencio no, porque el emisor no
 *    puede hacer nada con ellas y se quedaría atascado sin saber por qué.
 *  · PETICIONES_RECIBIDAS: pendientes a la vez por receptor. Es el tope que
 *    protege la bandeja ajena.
 *  · AMIGOS: se comprueba al aceptar, en los dos lados. Acota además lo que
 *    agrega `getSocialOverview` (la colección de todos los amigos, de golpe).
 *
 * NINGUNO ES EXACTO BAJO CONCURRENCIA, igual que el tope de ofertas de
 * `createTradeOffer`: están para cortar el goteo masivo, no para contar. El
 * recuento va en la misma sentencia que escribe, pero cada sentencia cuenta
 * sobre su propia instantánea y no ve lo que otra está insertando a la vez.
 * Medido contra PostgreSQL, uno a uno los tres son exactos. Con ráfagas
 * simultáneas se pasan, y CUÁNTO cambia de una tanda a otra (depende de
 * cuántas sentencias coincidan): lo más que se ha visto en varias tandas es
 * 30 enviadas (100 envíos a la vez), 60 recibidas (150 emisores a la vez) y
 * 140 amigos (45 aceptaciones a la vez sobre 95, es decir, todas). Son
 * medidas, no cotas: no hay que apoyar nada en esas cifras. El de amigos
 * queda acotado por las recibidas, y `getSocialOverview` lleva su propio
 * LIMIT. Hacerlos exactos pide un candado de aviso por usuario
 * (`pg_advisory_xact_lock`) delante de la misma sentencia y dentro de una
 * transacción —medido: 20 / 50 / 100 exactos—, que sería la primera del
 * repositorio: no compensa.
 */
export const LIMITES_SOCIALES = {
  PETICIONES_ENVIADAS: 20,
  PETICIONES_RECIBIDAS: 50,
  AMIGOS: 100,
} as const;
