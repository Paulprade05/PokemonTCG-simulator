  // src/app/action.ts
  'use server'

  import { auth, currentUser } from "@clerk/nextjs/server";
  import { sql } from '@vercel/postgres';
  // `revalidatePath` (next/cache) ya no se importa, y las 32 llamadas que había
  // repartidas por las acciones se han quitado: invalidaban '/', '/collection',
  // '/vitrina', '/bazar' y '/mercado', que son páginas 100 % de cliente —leen
  // sus datos llamando a estas acciones, no del render del servidor—, así que
  // invalidarlas no refrescaba nada. Lo que sí hacían era marcar esas páginas
  // estáticas para regenerarse y meter en la respuesta de CADA compra o venta un
  // render de la ruta en curso. Si algún día una página pasa a pintar datos en
  // el servidor, la invalidación vuelve con ella, en la acción que le toque.
  // SELL_PRICES ya no se importa a propósito: el valor de una colección se
  // calcula con `precioDeCartaSuelta` + `valorDeVenta`, que son la curva real
  // que paga la tienda. Multiplicar SELL_PRICES por la cantidad inflaba el
  // patrimonio y premiaba acaparar repetidas que valen la octava parte.
  import { AVAILABLE_SETS, RARITY_RANK, STARTING_COINS, DAILY_BASE, DAILY_STREAK_STEP, DAILY_STREAK_CAP, DAILY_ESPERA_H, DAILY_PLAZO_RACHA_H, SET_COMPLETION_BONUS, PACK_PRICES, valorDeVenta, precioDeCartaSuelta } from "../utils/constanst";
  import { loadLocalSets, loadLocalCards, loadLocalCardsCrudas } from "../services/localData";
  // Capa de presentación en español. Se aplica AQUÍ, en el servidor y en el
  // punto en el que las cartas salen hacia la interfaz, por dos razones: el
  // diccionario (724 KB en 39 ficheros) no baja al navegador, y las doce
  // pantallas que pintan cartas no tienen que saber que existe un idioma.
  // Nunca se aplica a las lecturas con las que el servidor DECIDE algo (sorteo
  // del sobre, validación del mercado): ésas siguen viendo el dato inglés.
  import { type Idioma } from "../services/idioma";
  // La capa de traducciones: estáticos MÁS lo que el cron haya escrito en
  // Postgres. Degrada exactamente a los ficheros estáticos si la base falla.
  import { capaEs, traducirCartasEs } from "../services/idiomaBD";
  import { idiomaActual, idsPorNombreEspanol } from "../services/idiomaServidor";
  // El sorteo del sobre vive aquí desde que el cliente dejó de generarlo: es la
  // misma economía calibrada que consume scripts/sim-economia.mjs.
  import {
    admiteSobreEstandar,
    admiteSobrePremium,
    composicionDelSobre,
    eraDeSerie,
    esColeccionEspecial,
    openGoldenPack,
    openPremiumPack,
    openStandardPack,
    type Era,
  } from "../utils/packLogic";
  // La graduación. El núcleo es PURO y sin imports (utils/graduacion.ts), igual
  // que packLogic: la nota de una copia no se sortea, se deriva de una semilla
  // estable, así que el servidor puede recalcularla en cualquier momento sin
  // guardar nada más que la propia nota.
  import {
    costeDeGraduar,
    descuentoPorVolumen,
    desgasteALaVista,
    desgasteEsVisible,
    desperfectosDeCopia,
    etiquetaNota,
    marcasDeCopia,
    notaDeCopia,
    seVeLimpia,
    semillaDeCopia,
    valorGraduado,
    type Desperfectos,
    type MarcasDeCarta,
  } from "../utils/graduacion";
  // Las reglas del bazar entre jugadores: banda de precio, comisión, antigüedad
  // mínima y tope de anuncios. Fichero puro y sin imports para que
  // scripts/test-invariantes.mjs pueda comprobarlas.
  import {
    MAX_ANUNCIOS_ABIERTOS,
    SOBRES_PARA_COMPRAR,
    SOBRES_PARA_VENDER,
    bandaDePrecio,
    comisionDe,
    pagoAlVendedor,
    precioValido,
  } from "../utils/bazar";
  // Las tablas nuevas. Se aseguran en ensureSchema (ver más abajo el porqué).
  // `objetoDeSentencia` dice qué tabla, índice o columna asegura cada sentencia:
  // con eso ensureSchema pregunta al catálogo antes de lanzar DDL.
  import {
    SENTENCIAS_ARCHIVADOR,
    SENTENCIAS_BAZAR,
    SENTENCIAS_GRADUACION,
    objetoDeSentencia,
  } from "../services/esquemaMejoras";
  // El escritor de `cards` del cron y de /seed-database. La siembra bajo
  // demanda (syncSetToDatabase) lo reutiliza en vez de llevar un INSERT propio.
  // Módulo SIN 'use server': aquí sólo se importa, no se reexporta nada.
  import { upsertCards } from "../services/ingest";
  // Tope de frecuencia en memoria, por instancia. Lo que promete y lo que no,
  // en la cabecera del módulo.
  import { LIMITES, dentroDelLimite } from "../services/limite";
  // Precios reales de Cardmarket. Degrada a "sin ajuste" si la tabla no existe
  // o si Postgres no responde: el juego se comporta como antes de que existiera.
  import { preciosEnEuros } from "../services/preciosBD";
  // Fotos de sobre que trajo el cron nocturno. Mismo contrato que la línea de
  // arriba: nunca lanza y devuelve vacío si la tabla no existe todavía.
  import { variantesDeSobre } from "../services/sobresBD";
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
    return [...(await traducirCartasEs(cartas, idioma))];
  }

  /* ==================================================================== *
   * EL ESQUEMA SE ASEGURA PREGUNTANDO, NO LANZANDO DDL
   * ====================================================================
   *
   * Las columnas y tablas auxiliares (recompensa diaria, tema, lista de deseos,
   * premios de set, recibos...) se aseguran una sola vez por instancia, no en
   * cada invocación: la promesa se memoiza y, si falla, se reintenta.
   *
   * EL AGUJERO QUE CIERRA. Hasta ahora "asegurar" era ejecutar las ~22
   * sentencias de DDL en serie en cada arranque en frío, existiera ya todo o
   * no, y eso tenía dos costes que nadie veía:
   *
   *   - `ALTER TABLE users ADD COLUMN IF NOT EXISTS` toma un candado ACCESS
   *     EXCLUSIVE sobre `users` AUNQUE LA COLUMNA EXISTA. Eran cuatro, sobre la
   *     tabla más caliente de la aplicación. Vercel levanta instancias nuevas
   *     justo en los picos: cada una lanzaba sus ALTER, y si en ese momento
   *     había una sentencia larga sobre `users` (un vaciado de duplicados,
   *     /db-stats), el ALTER se quedaba esperando en la cola de candados y
   *     TODAS las lecturas de saldo que llegaban después esperaban detrás de él.
   *     Medido contra PostgreSQL real con una transacción abierta que sólo
   *     había LEÍDO `users`: el arranque en frío se quedaba colgado hasta que
   *     esa transacción terminaba, y con él cualquier lectura de saldo que
   *     llegara después.
   *   - los `CREATE INDEX IF NOT EXISTS` toman SHARE sobre su tabla antes de
   *     descubrir que el índice ya existe, y los dos `ALTER TABLE graded_cards`
   *     de SENTENCIAS_GRADUACION, otro ACCESS EXCLUSIVE. El comentario que
   *     había aquí decía que las tablas nuevas "no bloquean nada": era cierto
   *     del CREATE TABLE y falso de lo que venía con él.
   *
   * AHORA se pregunta primero al catálogo (`pg_class` vía to_regclass y
   * `pg_attribute`), que es una lectura sin candados sobre las tablas del
   * juego, y sólo se ejecuta el DDL de lo que FALTA. En una base ya montada
   * —el caso de todos los arranques menos el primero— son cero sentencias de
   * DDL y un solo viaje en vez de veintidós.
   *
   * POR QUÉ NO SE QUITAN LOS ALTER SIN MÁS, aunque /migrate-core ya crea
   * `users` con esas columnas: desde el código no se puede saber si producción
   * ejecutó esa ruta. Comprobar y lanzar sólo si falta vale para las dos bases.
   *
   * QUÉ OBJETO ASEGURA CADA SENTENCIA se deduce de la propia sentencia
   * (`objetoDeSentencia`, en services/esquemaMejoras.ts), no de una lista
   * aparte que habría que mantener a mano y que un día dejaría de coincidir.
   * Una sentencia que esa función no sepa leer se ejecuta siempre, que es lo
   * que se hacía antes con todas.
   */
  let schemaReady: Promise<void> | null = null;

  /** De estas sentencias de esquema, las que hace falta ejecutar en ESTA base. */
  async function sentenciasQueFaltan(sentencias: readonly string[]): Promise<readonly string[]> {
    const pendientes = new Set<number>();
    const indices: number[] = [];
    const relaciones: string[] = [];
    const columnas: (string | null)[] = [];
    sentencias.forEach((stmt, i) => {
      const objeto = objetoDeSentencia(stmt);
      if (!objeto) {
        pendientes.add(i);
        return;
      }
      indices.push(i);
      relaciones.push(objeto.relacion);
      columnas.push(objeto.columna);
    });
    if (indices.length === 0) return sentencias;

    try {
      /* UNA lectura para todo. to_regclass devuelve NULL si la tabla o el
       * indice no existen (y no lanza, a diferencia del cast ::regclass); para
       * una columna se mira pg_attribute de esa tabla. Nada de esto toma
       * candados sobre users ni sobre ninguna tabla del juego. */
      const { rows } = await sql.query(
        `SELECT o.i
           FROM unnest($1::int[], $2::text[], $3::text[]) AS o(i, relacion, columna)
          WHERE CASE
                  WHEN o.columna IS NULL THEN to_regclass(o.relacion) IS NULL
                  ELSE NOT EXISTS (
                         SELECT 1 FROM pg_attribute a
                          WHERE a.attrelid = to_regclass(o.relacion)
                            AND a.attname = o.columna
                            AND a.attnum > 0
                            AND NOT a.attisdropped
                       )
                END`,
        [indices, relaciones, columnas],
      );
      for (const fila of rows) pendientes.add(Number(fila.i));
    } catch (e) {
      // Si el catálogo no se deja leer, lo de siempre: se lanza todo el DDL,
      // que es idempotente. Peor rendimiento, mismo resultado.
      console.error("ensureSchema: no se pudo consultar el catálogo; se ejecuta todo el DDL:", e);
      return sentencias;
    }
    // En el orden original: una tabla va siempre delante de sus índices y de
    // sus ALTER.
    return sentencias.filter((_, i) => pendientes.has(i));
  }

  /**
   * ¿Este fallo de DDL es sólo que OTRA instancia creó lo mismo a la vez?
   *
   * EL AGUJERO QUE CIERRA: `IF NOT EXISTS` no es atómico entre sesiones. Dos
   * instancias en frío que lanzan a la vez el mismo CREATE TABLE IF NOT EXISTS
   * pasan las dos la comprobación, y la que llega segunda choca en el índice
   * único del CATÁLOGO de Postgres (pg_type_typname_nsp_index o
   * pg_class_relname_nsp_index) con un 23505. Medido contra PostgreSQL real, en
   * el primer pico sobre una base sin las tablas auxiliares: de 30 instancias
   * en frío, 25 contestaban "servidor" a su primera acción. Se arreglaba solo
   * en la siguiente llamada, pero ese primer pico es justo después de
   * desplegar.
   *
   * SÓLO SE PERDONA LO QUE ES SEGURO PERDONAR:
   *  - la sentencia tiene que llevar IF NOT EXISTS (es idempotente por diseño);
   *  - 42P07 / 42701 / 42710: "ya existe" la tabla, la columna o el objeto;
   *  - 23505 SÓLO si el índice que chocó es del catálogo (empieza por pg_).
   *    Un 23505 al crear un índice ÚNICO sobre datos que ya tienen duplicados
   *    es otra cosa muy distinta —el índice NO se ha creado, y es el que impide
   *    reciclar notas o duplicar anuncios— y ése sigue lanzando, como antes.
   */
  function yaLoCreoOtraInstancia(sentencia: string, e: unknown): boolean {
    if (!/\bIF\s+NOT\s+EXISTS\b/i.test(sentencia)) return false;
    const error = e as { code?: unknown; constraint?: unknown; message?: unknown } | null;
    const codigo = String(error?.code ?? "");
    if (codigo === "42P07" || codigo === "42701" || codigo === "42710") return true;
    if (codigo !== "23505") return false;
    const indice = String(error?.constraint ?? "");
    const texto = String(error?.message ?? "");
    return /^pg_/.test(indice) || /"pg_(type|class)_[a-z_]+_index"/.test(texto);
  }

  function ensureSchema(): Promise<void> {
    if (!schemaReady) {
      schemaReady = (async () => {
        const sentencias: string[] = [
          `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_daily_claim TIMESTAMP`,
          `ALTER TABLE users ADD COLUMN IF NOT EXISTS streak INT DEFAULT 0`,
          `ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT`,
          // Idioma de las cartas ("en" | "es"). Igual que theme: preferencia de
          // la CUENTA, que pisa a la del dispositivo cuando hay sesión.
          `ALTER TABLE users ADD COLUMN IF NOT EXISTS lang TEXT`,
          `
          CREATE TABLE IF NOT EXISTS wishlist (
            user_id TEXT NOT NULL,
            card_id TEXT NOT NULL,
            added_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (user_id, card_id)
          )
        `,
          `
          CREATE TABLE IF NOT EXISTS set_rewards (
            user_id TEXT NOT NULL,
            set_id TEXT NOT NULL,
            rewarded_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (user_id, set_id)
          )
        `,
          // Ofertas del mercado ya cobradas. La PK (usuario, ciclo, oferta) es
          // quien arbitra la carrera: dos pestañas cobrando la misma oferta a la
          // vez chocan en el índice único y sólo una inserta, así que sólo una
          // cobra. El ciclo es la semilla de mercado.ts, no una fecha: el tablón
          // se deriva de ella y no hace falta guardarlo.
          `
          CREATE TABLE IF NOT EXISTS market_claims (
            user_id TEXT NOT NULL,
            ciclo BIGINT NOT NULL,
            oferta_id TEXT NOT NULL,
            pago INT NOT NULL DEFAULT 0,
            claimed_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (user_id, ciclo, oferta_id)
          )
        `,
          // Recibos de compra de sobres. La PK (usuario, clave) es lo que hace
          // idempotente la compra: la clave la genera el cliente por intento, así
          // que un reenvío choca aquí y no vuelve a cobrar. La columna cartas
          // guarda los ids EN ORDEN para poder devolver el mismo sobre en el
          // reenvío.
          `
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
        `,
          /* GRADUACIÓN, ARCHIVADOR Y BAZAR.
           *
           * Van aquí y no sólo en /migrate-mejoras porque las tocan acciones del
           * jugador —graduar, publicar, comprar— y una acción no puede fallar
           * porque a alguien se le olvidara ejecutar una ruta a mano. Es el
           * mismo criterio por el que ya están aquí wishlist, set_rewards,
           * market_claims y pack_purchases.
           *
           * La tabla card_prices NO está aquí a propósito: sólo la escribe el
           * cron de precios, y el criterio del repositorio
           * (services/idiomaIngest.ts) es que ésa se asegure en su propio
           * módulo.
           */
          ...SENTENCIAS_GRADUACION,
          ...SENTENCIAS_ARCHIVADOR,
          ...SENTENCIAS_BAZAR,
        ];
        for (const stmt of await sentenciasQueFaltan(sentencias)) {
          try {
            await sql.query(stmt);
          } catch (e) {
            if (!yaLoCreoOtraInstancia(stmt, e)) throw e;
          }
        }
      })().catch((e) => {
        // No cachear el fallo: la próxima llamada vuelve a intentar la creación.
        schemaReady = null;
        throw e;
      });
    }
    return schemaReady;
  }

  // --- 1. GESTIÓN DE USUARIO Y MONEDAS ---

  /* A quién se le ha intentado ya poner nombre en ESTA instancia (ver
   * `getUserData`). Es lo que hace que el intento sea UNO: la portada, la
   * cabecera y la diaria llaman a `getUserData` a la vez, y sin esto un usuario
   * nuevo lanzaría tres consultas a Clerk; y si Clerk falla, cada lectura de
   * saldo volvería a intentarlo. El tope es sólo para que el conjunto no
   * crezca sin fin en una instancia longeva. */
  const nombreIntentado = new Set<string>();

  /* ¿FALTA `users.username` EN ESTA BASE? La columna no la crea `ensureSchema`
   * (sólo /migrate-core y /migrate-social), y `getUserData` la lee para saber
   * si hay que sincronizar el nombre. En una base donde no se hubiera aplicado
   * ninguna de las dos migraciones esa lectura fallaba con 42703, y con ella
   * EL SALDO de todo el mundo: la acción más llamada de la aplicación colgando
   * de una columna que sólo le importa a Social. Si falta, se apunta aquí una
   * vez por instancia y se sigue sin nombre: lo que se pierde es que el jugador
   * salga en la búsqueda de amigos, no su saldo. */
  let sinColumnaNombre = false;

  /** Saldo y nombre de la fila de `users`, o null si la fila no existe. */
  async function leerSaldoYNombre(
    userId: string,
  ): Promise<{ coins: unknown; username: unknown } | null> {
    if (!sinColumnaNombre) {
      try {
        const { rows } = await sql`SELECT coins, username FROM users WHERE id = ${userId}`;
        return rows.length > 0 ? { coins: rows[0].coins, username: rows[0].username } : null;
      } catch (error) {
        // 42703 = undefined_column. Cualquier otra cosa es un fallo de verdad.
        if ((error as { code?: string } | null)?.code !== "42703") throw error;
        sinColumnaNombre = true;
        console.error("getUserData: falta users.username; ejecuta /migrate-social");
      }
    }
    const { rows } = await sql`SELECT coins FROM users WHERE id = ${userId}`;
    return rows.length > 0 ? { coins: rows[0].coins, username: null } : null;
  }

  export async function getUserData() {
    const { userId } = await auth();
    if (!userId) return null;

    try {
      /* PRIMERO SE LEE, Y SÓLO SE ESCRIBE SI HACE FALTA.
       *
       * Esto era un upsert en cada llamada: una ESCRITURA en la fila de `users`
       * —con su candado y su entrada en el registro— para leer un número. Era
       * asumible cuando sólo lo pedían la portada y Graduación al montar; desde
       * que el proveedor del saldo lo pide al resolverse la sesión y en cada
       * vuelta a primer plano (hooks/useGameCurrency.tsx), es la acción más
       * llamada de la aplicación. Y cada una de esas escrituras hace cola con
       * las que sí importan sobre la misma fila: la compra de un sobre, una
       * venta, la diaria.
       *
       * Ahora el caso normal —la fila existe y tiene saldo— es un SELECT por
       * clave primaria. El upsert se queda para lo que de verdad necesita
       * escribir: el usuario nuevo y la fila que `syncUserName` pudiera haber
       * creado sin `coins`. Sigue siendo un upsert idempotente y no un INSERT,
       * por lo que ya resolvía: la portada, la cabecera y la diaria de un
       * usuario nuevo arrancan a la vez, las tres leen "no hay fila", y con un
       * INSERT a secas dos de ellas reventaban con clave duplicada. */
      let fila = await leerSaldoYNombre(userId);
      if (!fila || fila.coins == null) {
        const { rows } = await sql`
          INSERT INTO users (id, coins) VALUES (${userId}, ${STARTING_COINS})
          ON CONFLICT (id) DO UPDATE SET coins = COALESCE(users.coins, ${STARTING_COINS})
          RETURNING coins
        `;
        fila = { coins: rows[0].coins, username: fila?.username ?? null };
      }
      // EL NOMBRE, SIN TENER QUE ABRIR SOCIAL. `username` sólo lo escribía
      // `syncUserName`, y a `syncUserName` sólo la llamaba la pantalla de
      // amigos: quien instalaba la app y se quedaba abriendo sobres tenía la
      // fila sin nombre y era INVISIBLE para la búsqueda de sus amigos. La
      // lectura de arriba ya trae la columna en el mismo viaje, así que saber si
      // falta no cuesta nada; sólo cuando falta se pregunta a Clerk, y una vez.
      // Va dentro de su propio try: el saldo no puede fallar por un nombre.
      if (!sinColumnaNombre && fila.username == null && !nombreIntentado.has(userId)) {
        if (nombreIntentado.size > 5000) nombreIntentado.clear();
        nombreIntentado.add(userId);
        try {
          await syncUserName();
        } catch (error) {
          console.error("getUserData: no se pudo sincronizar el nombre:", error);
        }
      }
      return { coins: Number(fila.coins) };
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

  /* ==================================================================== *
   * EL ESTADO FÍSICO DE UNA CARTA QUE YA SE TIENE
   * ====================================================================
   *
   * En la colección, en el álbum y en el archivador se ve UNA miniatura por
   * carta, pero de esa carta se pueden tener quince copias con quince estados
   * distintos. ¿Cuál se pinta?
   *
   * LA QUE MEJOR SE VE. Es lo que hace cualquiera con una carpeta delante: si
   * tienes una machacada y una impecable, enseñas la impecable y la otra se
   * queda en la caja. Pintar la peor sería mentir sobre lo que tienes, y pintar
   * "la primera" sería un número de serie que no significa nada para nadie.
   *
   * ------------------------------------------------------------------
   * "LA QUE MEJOR SE VE" NO ES "LA DE MEJOR NOTA", Y ESA DIFERENCIA ERA UNA FUGA
   * ------------------------------------------------------------------
   *
   * Esto elegía la copia de MEJOR NOTA entre las que se tienen. Parece lo
   * mismo y no lo es: la nota es justo lo que el jugador paga por saber, y
   * elegir con ella convertía la miniatura en un oráculo.
   *
   * EL CASO: dos copias con desgaste distinto. El jugador vio el de las dos al
   * abrir los sobres, así que sabe a cuál de ellas corresponde la miniatura de
   * la colección; y como la miniatura era la de MEJOR NOTA, eso le dice cuál
   * de las dos tiene la nota más alta sin pagar por saberlo. Si además tiene
   * una graduada, peor: con un 9 con un pique en la vitrina, que la miniatura
   * salga sin el pique significa que la otra copia es un 10.
   *
   * MEDIDO sobre 200.000 parejas: graduando sólo la copia que la miniatura
   * señala como la mejor de las dos, y sólo cuando además se ve limpia, esas
   * copias dan ×1,488 de media contra un techo de ×1,40 (utils/graduacion.ts).
   * Es justo el "elegir en vez de tirar" que la tabla de notas existe para
   * impedir.
   *
   * AHORA ELIGE POR LO QUE SE VE (`desgasteALaVista`), sin mirar la nota para
   * ordenar. Lo que la miniatura enseña es función del desgaste de cada copia,
   * que el jugador ya tiene delante desde que la sacó del sobre: no puede
   * decirle nada que no supiera. Con la misma medida, lo mejor que puede hacer
   * es graduar "la copia que se ve limpia", y eso da ×1,345: el grupo limpio de
   * siempre, que está por debajo del techo a propósito.
   *
   * Y SI LA ELEGIDA SE VE LIMPIA NO VIAJA NADA (`seVeLimpia`). Con el umbral de
   * desgaste visible en 10 se calcula el desgaste de TODAS las notas, así que
   * la rama "copia sana, no se pinta nada" que había aquí no se cumplía nunca:
   * la colección entera viajaba con sus desperfectos y sus marcas, casi siempre
   * todo a cero, y se recorrían hasta sesenta copias por carta para mandarlo.
   * Ahora una carta con alguna copia limpia —la mayoría— no manda nada, que es
   * lo que las pantallas ya entendían por "se ve bien".
   *
   * EL TOPE DE COPIAS QUE SE MIRAN. Cuatro de cada diez copias se ven limpias,
   * así que la probabilidad de que doce seguidas tengan todas alguna marca es
   * 0,6^12, un 0,2 %. Mirar más casi nunca cambia la respuesta y sí multiplica
   * el trabajo en la colección de quien acumula cientos de repetidas. Cuando
   * pasa, se enseña la menos gastada de esas doce.
   *
   * ------------------------------------------------------------------
   * ESTO RECORRE 1..CANTIDAD Y ESE RANGO NO ES EXACTO. POR QUÉ SE DEJA ASÍ
   * ------------------------------------------------------------------
   *
   * Los índices de copia no se reparten al comprar: se reparten al GRADUAR, y
   * el que se usa es el más bajo que esté libre (graduarCartasAction). Cuando
   * una copia graduada se vende, su fila se queda marcada 'vendida' ocupando su
   * índice para siempre —es lo que impide repetir su nota— pero `quantity`
   * baja. A partir de ahí, los índices de las copias que quedan ya no son
   * 1..cantidad: son los `cantidad` índices LIBRES más bajos, que pueden estar
   * más arriba.
   *
   * O sea que este bucle puede estar pintando el desgaste de una copia que ya
   * no está, y dejando fuera el de una que sí. Se deja así, con tres razones y
   * una condición:
   *
   *   1. NO AFECTA A NINGÚN NÚMERO. De aquí no sale dinero ni notas: sale el
   *      aspecto de la miniatura, y encima el de la que mejor se ve, que es un
   *      resumen de varias y no la promesa de ninguna en concreto.
   *   2. NO DELATA NADA. La copia se elige por su desgaste, y el desgaste de un
   *      índice es el mismo lo tenga el jugador o lo haya vendido: ya lo vio.
   *   3. ARREGLARLO CUESTA CARO Y EN EL SITIO MALO. Haría falta traerse los
   *      índices ocupados (array_agg sobre graded_cards, SIN filtrar por estado)
   *      carta a carta, y el sitio donde se llama esto es `getFullCollection`,
   *      que lee la colección ENTERA en cada visita a la portada y al álbum.
   *      Pagar eso en la consulta más caliente de la aplicación para mover unos
   *      píxeles no sale a cuenta.
   *
   * LA CONDICIÓN: esto vale mientras de aquí siga sin salir ni una cifra. El
   * día que la miniatura enseñe la nota, el valor o cualquier cosa que se pueda
   * cobrar, el rango tiene que dejar de ser 1..cantidad y pasar a ser "los
   * índices libres más bajos", que es lo que de verdad tiene el jugador.
   *
   * Lo mismo vale para `conEstadoFisico`, aquí abajo: deduce el número de copia
   * contando hacia atrás desde la cantidad resultante de la compra, así que
   * hereda el mismo desajuste y por las mismas razones se queda igual.
   */
  const COPIAS_QUE_SE_MIRAN = 12;

  function estadoDeLaMejorCopia(
    userId: string,
    cardId: string,
    cantidad: number,
    secreto: string,
  ): { desperfectos: Desperfectos; marcas: MarcasDeCarta } | null {
    const tope = Math.min(Math.max(1, Math.floor(cantidad) || 1), COPIAS_QUE_SE_MIRAN);
    let mejorSemilla = "";
    let mejor: Desperfectos | null = null;
    let menorDesgaste = Infinity;
    for (let copia = 1; copia <= tope; copia++) {
      const semilla = semillaDeCopia(userId, cardId, copia, secreto);
      const nota = notaDeCopia(semilla);
      // Una copia cuyo desgaste no se enseña (por encima del umbral) se ve sana,
      // y con una sana la carta se ve sana. Con el umbral en 10 esta rama no se
      // cumple; se conserva porque es lo correcto si el umbral vuelve a bajar.
      if (!desgasteEsVisible(nota)) return null;
      const desperfectos = desperfectosDeCopia(semilla, nota);
      // En cuanto aparece una copia que se ve limpia, la carta se ve limpia: no
      // hace falta seguir mirando ni mandar nada.
      if (seVeLimpia(desperfectos)) return null;
      // LA NOTA NO ENTRA EN LA COMPARACIÓN (ver arriba): sólo lo que se ve. Con
      // `<` estricto, a igual desgaste gana el índice más bajo.
      const desgaste = desgasteALaVista(desperfectos);
      if (desgaste < menorDesgaste) {
        menorDesgaste = desgaste;
        mejor = desperfectos;
        mejorSemilla = semilla;
      }
    }
    if (!mejor) return null;
    return { desperfectos: mejor, marcas: marcasDeCopia(mejorSemilla, mejor) };
  }

  /* ==================================================================== *
   * EL ESTADO FÍSICO DE LO QUE SALE DEL SOBRE
   * ====================================================================
   *
   * Una carta sale del sobre con el estado que tiene esa COPIA concreta: si te
   * toca una machacada, se ve machacada desde el primer momento. Lo que no se
   * ve es la nota, que es justo lo que se paga al graduar.
   *
   * QUÉ COPIA ES CADA UNA. El desgaste depende del número de copia, así que hay
   * que saber cuál acaba de tocar. La sentencia de la compra devuelve la
   * cantidad RESULTANTE de cada carta (ver el RETURNING del CTE abono), y de
   * ahí se cuenta hacia atrás: si el sobre trae dos Pikachu y acabas con cinco,
   * son la cuarta y la quinta. Contar hacia atrás y no hacia delante importa
   * porque lo que se conoce es el final, no el principio.
   *
   * POR QUÉ NO SE VUELVE A LEER LA COLECCIÓN: entre la compra y esa lectura
   * cabe otra compra —el botón ×10, dos pestañas— y el número de copia saldría
   * movido. La cantidad viene de la MISMA sentencia que la escribió.
   *
   * QUÉ VIAJA Y QUÉ NO. El desgaste se calcula para todas las notas que el
   * umbral deja ver (utils/graduacion.ts, UMBRAL_DESGASTE_VISIBLE; hoy, todas)
   * y viaja SÓLO el de las copias a las que se les ve algo. De una copia que
   * se ve limpia no viaja nada (`seVeLimpia`), y no es por ahorrar bytes: el
   * dato lleva el descentrado con dos decimales, y "todo a cero exacto" es un
   * grupo más fino que "se ve limpia" —deja fuera a casi todos los sietes— que
   * la pantalla no enseña pero la respuesta sí. Medido: ese grupo da ×1,3955,
   * a tres milésimas del techo; el que se VE limpio, ×1,3465. Sin mandarlo, lo
   * que sabe quien lee la respuesta es lo que sabe quien mira la carta, que es
   * lo que mide el invariante "ningún estado visible delata una nota".
   */
  function conEstadoFisico(
    userId: string,
    sobre: CartaDeSobre[],
    resultantes: unknown,
  ): CartaDeSobre[] {
    let finales: Map<string, number>;
    try {
      const lista = Array.isArray(resultantes)
        ? (resultantes as { id?: unknown; cantidad?: unknown }[])
        : [];
      finales = new Map(
        lista
          .filter((r) => typeof r?.id === "string")
          .map((r) => [String(r.id), Math.floor(Number(r.cantidad) || 0)]),
      );
    } catch {
      // Sin el dato no se pinta desgaste. La carta se ve limpia, que es lo que
      // hacía antes de que esto existiera: nunca se rompe la apertura por esto.
      return sobre;
    }
    if (finales.size === 0) return sobre;

    const secreto = secretoDeNotas();
    /* Se recorre AL REVÉS: la última aparición de una carta en el sobre es la
     * copia más alta. Recorriendo hacia delante habría que saber de cuántas se
     * parte, que es justo lo que no se sabe. */
    const restantes = new Map(finales);
    const estados = new Map<number, { desperfectos: Desperfectos; marcas: MarcasDeCarta }>();
    for (let i = sobre.length - 1; i >= 0; i--) {
      const id = sobre[i].id;
      const copia = restantes.get(id);
      if (copia === undefined || copia < 1) continue;
      restantes.set(id, copia - 1);

      const semilla = semillaDeCopia(userId, id, copia, secreto);
      const nota = notaDeCopia(semilla);
      // AQUÍ ESTÁ EL FILTRO QUE PROTEGE LA ECONOMÍA: por encima del umbral no
      // viaja nada, y de lo que queda tampoco viaja lo que se ve limpio, así
      // que todas las que parecen buenas llegan exactamente igual: sin nada.
      if (!desgasteEsVisible(nota)) continue;
      const desperfectos = desperfectosDeCopia(semilla, nota);
      if (seVeLimpia(desperfectos)) continue;
      estados.set(i, { desperfectos, marcas: marcasDeCopia(semilla, desperfectos) });
    }
    if (estados.size === 0) return sobre;

    return sobre.map((c, i) => {
      const e = estados.get(i);
      return e ? { ...c, desperfectos: e.desperfectos, marcas: e.marcas } : c;
    });
  }

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
    /**
     * Precio real de Cardmarket en euros, si el cron de precios ya pasó por la
     * carta. Va con el catálogo del sorteo A PROPÓSITO: packLogic calibra el
     * sobre con los MISMOS precios que la tienda va a pagar, así que si aquí
     * faltara, el sobre se calibraría contra un precio que ya no existe y el
     * ajuste podría reabrir la fuga que "calibrar" tiene cerrada.
     */
    precioEur?: number | null;
    /**
     * Estado físico de ESTA copia, si se le ve algo. Opcional: ausente en las
     * copias que se ven limpias (unas cuatro de cada diez), porque mandarlo
     * siempre daría más detalle del que enseña la pantalla (ver
     * conEstadoFisico).
     */
    desperfectos?: Desperfectos;
    marcas?: MarcasDeCarta;
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

  /* ==================================================================== *
   * CUÁNDO UN CATÁLOGO ESTÁ A MEDIAS
   * ====================================================================
   *
   * EL AGUJERO QUE CIERRA: el cron escribe una expansión por páginas de 250
   * cartas ordenadas por número y, si se queda sin tiempo, sigue al día
   * siguiente. Mientras tanto la expansión ya estaba en la tienda, y cada sobre
   * se sorteaba —y se CALIBRABA— contra un catálogo sin sus números altos, que
   * son justo las Hyper Rare y las Special Illustration Rare: se cobraban 50
   * monedas por un sobre en el que el premio gordo no podía salir. Para las
   * expansiones sin JSON local (las ~133 que sólo trae el cron) ese catálogo
   * cojo se cacheaba además diez minutos, porque la única comprobación era
   * contra `loadLocalCards`, que para ellas devuelve cero.
   *
   * LA REGLA ES LA MISMA que ya usaba `claimSetCompletionBonuses` para no pagar
   * el bono de un set a medias, y ahora vive en un solo sitio: si la ficha
   * declara un total y en `cards` hay menos del 90 %, la descarga no ha
   * terminado. El 90 % deja pasar el desajuste normal de la API (declarar dos
   * o tres cartas de más) y corta la descarga a medias, que siempre va mucho
   * más lejos. Con ese catálogo no se vende, no se anuncia y no se cachea.
   */
  const CATALOGO_FIABLE = 0.9;
  const catalogoIncompleto = (enBase: number, totalDeclarado: unknown): boolean => {
    const total = Number(totalDeclarado);
    return Number.isFinite(total) && total > 0 && enBase < total * CATALOGO_FIABLE;
  };

  /**
   * @param sembrarSiFalta true (lo de siempre, y lo que necesita la COMPRA):
   *   si al set le faltan cartas en `cards`, se siembran antes de sortear. Se
   *   pasa false desde lecturas que sólo ANUNCIAN —`getComposicionDeSobres`,
   *   que no exige sesión—: una lectura abierta que escriba en la base es
   *   exactamente el endpoint que app/page.tsx dejó de llamar a propósito
   *   cuando la siembra se movió aquí. Sin sembrar, la lectura devuelve lo que
   *   haya y quien llama decide con qué respalda.
   * @param totalDeclarado el `total` de la ficha del set, si quien llama ya la
   *   tiene: con él, un catálogo a medias NO se cachea (ver arriba). Decidir si
   *   se vende con ese catálogo sigue siendo cosa de quien llama.
   */
  async function cartasDelSet(
    setId: string,
    sembrarSiFalta = true,
    totalDeclarado: unknown = 0,
  ): Promise<CartaDeSobre[]> {
    const guardado = catalogoDeSet.get(setId);
    if (guardado && guardado.expira > Date.now()) return guardado.cartas;

    const leer = async (): Promise<CartaDeSobre[]> => {
      const { rows } = await sql`
        SELECT id, name, rarity, images FROM cards WHERE set_id = ${setId}
      `;
      return rows.map(aCartaDeSobre);
    };

    let cartas = await leer();
    const locales = (await loadLocalCards(setId)) as any[];
    /* SE SIEMBRA CUANDO FALTAN, NO SÓLO CUANDO NO HAY NINGUNA. Antes la
     * condición era `cartas.length === 0`, así que una siembra cortada a mitad
     * —esto corre DENTRO de la compra, con su límite de tiempo— dejaba el set
     * con un catálogo parcial que ninguna compra posterior completaba: la
     * siembra sabía reanudarse (`syncSetToDatabase` compara contra el
     * catálogo) pero nadie volvía a llamarla. */
    if (cartas.length < locales.length && sembrarSiFalta) {
      // Se siembra AQUÍ y no se sortea contra el JSON local: el abono hace JOIN
      // contra `cards`, así que un sobre generado con ids que aún no están en
      // la tabla se cobraría y no acreditaría nada.
      await syncSetToDatabase(setId);
      cartas = await leer();
    }
    // SÓLO SE CACHEA UN CATÁLOGO COMPLETO (la condición está al final). Tanto
    // la siembra como el cron escriben por lotes ordenados por número, así que
    // una compra que caiga en mitad lee un set a medias y sin sus cartas de
    // número alto, que son las mejores. Sortear con eso es un mal sobre;
    // cachearlo son diez minutos de malos sobres para todo el que abra esa
    // expansión en esta instancia.
    /* EL PRECIO REAL SE PEGA AQUÍ, antes de cachear y antes de que nadie mire
     * el catálogo. Es el único punto por el que pasan a la vez el sorteo del
     * sobre (openStandardPack y compañía) y el calibrado que decide si ese
     * sobre se puede vender (admiteSobreEstandar), y las dos cosas TIENEN que
     * ver el mismo precio o la calibración mentiría.
     *
     * "preciosEnEuros" nunca lanza: si la tabla no existe todavía o Postgres no
     * responde, devuelve un mapa vacío y todo se comporta igual que antes de
     * que existiera el ajuste. El try/catch de fuera es cinturón sobre tirantes.
     */
    if (cartas.length > 0) {
      try {
        const euros = await preciosEnEuros(cartas.map((c) => c.id));
        if (euros.size > 0) {
          cartas = cartas.map((c) => {
            const eur = euros.get(c.id);
            return eur ? { ...c, precioEur: eur } : c;
          });
        }
      } catch (e) {
        console.warn("Precios reales no disponibles, se sortea sin ajuste:", e);
      }
    }

    // Completo contra los DOS patrones: el JSON del repositorio (las 38
    // expansiones sembradas) y el total que declara la ficha (las que sólo trae
    // el cron, para las que `locales` está vacío y la primera condición no
    // decía nada).
    if (
      cartas.length > 0 &&
      cartas.length >= locales.length &&
      !catalogoIncompleto(cartas.length, totalDeclarado)
    ) {
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

  /* LA REGLA DE "COLECCIÓN ESPECIAL" YA NO SE ESCRIBE AQUÍ. Vivía copiada a
   * mano en este fichero y en app/page.tsx, y las dos copias ya se separaron
   * una vez (ver el comentario del total, más abajo). Ahora los dos lados
   * importan `esColeccionEspecial` de utils/packLogic.ts; lo que cambia de un
   * lado a otro son las CARTAS con las que se mide: aquí las de la base de
   * datos, que es lo único que el usuario no puede tocar. */

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
    era?: Era,
  ): Set<TipoSobre> {
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
     * El cliente aplica ahora exactamente esta misma condición, y no una copia:
     * la misma función (`esColeccionEspecial`, utils/packLogic.ts).
     */
    const especial = esColeccionEspecial(ficha, cartas);

    if (especial) return new Set<TipoSobre>(["SPECIAL"]);

    /* LA ERA ENTRA TAMBIÉN AQUÍ, y no sólo en el sorteo. Las dos funciones
     * "admiteSobre*" calibran el sobre contra su precio, y una era que reparte
     * mejores premios sube el valor esperado: si el filtro midiera con una era
     * y el sorteo repartiera con otra, la tienda ofrecería sobres que el
     * calibrado ya había rechazado. Medido sobre las 38 expansiones del
     * repositorio con estos perfiles: no se cae ninguna de la tienda y ninguna
     * pasa de su precio.
     */
    const permitidos = new Set<TipoSobre>(["GOLDEN"]);
    if (admiteSobreEstandar(cartas, era)) permitidos.add("STANDARD");
    if (admiteSobrePremium(cartas, era)) permitidos.add("PREMIUM");
    return permitidos;
  }

  /* ==================================================================== *
   * LO QUE LA TIENDA ANUNCIA SE CALCULA DONDE SE SORTEA
   * ====================================================================
   *
   * EL PROBLEMA QUE CIERRA: app/page.tsx llamaba a `composicionDelSobre(cartas,
   * tipo)` SIN el tercer argumento, la era. La era no es un adorno: es la tabla
   * con la que se reparte el hueco de premio del sobre PREMIUM, y son tres
   * tablas distintas (utils/packLogic.ts, PREMIO_PREMIUM_POR_ERA):
   *
   *     moderna  8 / 15 / 30 / 47      <- Escarlata y Púrpura, Mega Evolución
   *     media    5 / 10 / 25 / 60      <- lo que anunciaba la tienda SIEMPRE
   *     clasica  3 /  7 / 20 / 70      <- XY hacia atrás
   *
   * O sea: en una expansión moderna la tienda prometía un 5% de dorada y el
   * servidor repartía un 8%; en una clásica prometía 5% y repartía 3%. Sólo el
   * Premium —en el Estándar las tres eras comparten tabla— y sólo la tabla de
   * probabilidades, no el número de cartas.
   *
   * Y NO SE ARREGLA PASÁNDOLE LA ERA AL CLIENTE. El calibrado que decide cuántas
   * cartas trae el sobre entra por `precioDeCartaSuelta(rareza, precioEur)`, y
   * `precioEur` —el precio real de Cardmarket que trae el cron— NO baja al
   * navegador: vive en `card_prices` y se lo pega `cartasDelSet` al catálogo con
   * el que el servidor sortea. El cliente no puede reproducir el número por más
   * datos que se le manden; lo que puede es PEDIRLO. Es el mismo patrón que ya
   * usa PublicarSheet con la banda del bazar: el servidor manda el número ya
   * hecho y la pantalla lo pinta.
   *
   * ESTA ACCIÓN NO EXIGE SESIÓN, y es deliberado: el invitado ya llama a
   * `getCardsFromSet` (services/pokemon.ts), que también lee la base, y aquí no
   * sale ni un dato de nadie — es la ficha pública de un producto de la tienda.
   * Lo que sí cambia con la sesión es CUÁL ES LA VERDAD, porque el sobre lo
   * reparte otro:
   *
   *   · CON sesión reparte `comprarSobreAction` con la era de la ficha y con los
   *     precios reales pegados al catálogo. Eso es lo que se anuncia.
   *   · SIN sesión el sobre lo sortea el propio navegador (app/page.tsx llama a
   *     openStandardPack(allCards) a secas), sin era y sin precios en euros. Su
   *     verdad es la tabla 'media' sin ajuste, así que eso es lo que se le
   *     anuncia al invitado — que es exactamente lo que ve hoy. Anunciarle la
   *     era sería cambiar una mentira por otra.
   *
   * `reparto` en la respuesta dice cuál de los dos casos es, para que la
   * pantalla no tenga que deducirlo.
   */

  /** Una rama del hueco de premio, ya resuelta contra los pools del set. */
  interface RamaAnunciada {
    /** Escalón que promete el sobre ("Ultra Rare"). */
    etiqueta: string;
    /** % de sobres que caen en esta rama, con la era que de verdad reparte. */
    prob: number;
    /** false = esta expansión no tiene ese escalón y la rama cae al respaldo. */
    disponible: boolean;
    /** Escalón del que sale DE VERDAD cuando no está disponible. */
    etiquetaReal: string;
  }

  /** Un hueco fijo del sobre: no es una probabilidad, es una promesa. */
  interface HuecoAnunciado {
    /** Identificador del escalón, por si la pantalla quiere distinguirlo. */
    pool: string;
    etiqueta: string;
    cantidad: number;
    disponible: boolean;
    etiquetaReal: string;
  }

  /** La ficha completa de un tipo de sobre en una expansión concreta. */
  interface SobreAnunciado {
    tipo: TipoSobre;
    /** Precio en monedas: el MISMO que cobra `comprarSobreAction`. */
    precio: number;
    /** Cartas que trae de verdad, ya calibrado (swsh35 trae 9, no 10). */
    cartas: number;
    /** ¿Se vende este sobre en esta expansión? Mismo filtro que la compra. */
    disponible: boolean;
    /** Todos los huecos fijos, morralla incluida. */
    garantias: HuecoAnunciado[];
    /** Raras aseguradas, que es el número que la tienda rotula. 0 si no hay. */
    rarasGarantizadas: number;
    /** Reparto del hueco de premio. Vacío en Leyenda y Promo, que no tienen. */
    premio: RamaAnunciada[];
    /** Huecos de relleno que la calibración retiró para no pasar del precio. */
    retirados: number;
    /**
     * La tabla desplegable YA MONTADA, en el orden en que se pinta: primero el
     * premio (de mejor a peor) y luego los huecos que no son morralla. Va aquí
     * y no en la pantalla para que "cuál es el rótulo de una rama que no existe
     * en este set" se decida una sola vez y en el sitio que lo sabe.
     */
    filas: [string, string][];
  }

  /**
   * Rótulo de la carta garantizada del Leyenda y del Promo. No sale de
   * ETIQUETA_POOL porque no es un escalón de rareza: es la promesa de que la
   * carta que toca es una que NO tienes (ver openGoldenPack).
   */
  const NUEVA_GARANTIZADA = "Carta nueva";

  /** Monta la ficha de UN tipo de sobre a partir de la composición calibrada. */
  const fichaDeSobre = (
    tipo: TipoSobre,
    cartas: CartaDeSobre[],
    era: Era,
    disponible: boolean,
  ): SobreAnunciado => {
    const comp = composicionDelSobre(cartas, tipo, era);
    const pct = (n: number) => `${Number(n.toFixed(2))}%`;

    const premio: RamaAnunciada[] = comp.premio.map((r) => ({
      etiqueta: r.etiqueta,
      prob: r.prob,
      disponible: r.disponible,
      etiquetaReal: r.etiquetaReal,
    }));
    const garantias: HuecoAnunciado[] = comp.huecos.map((h) => ({
      pool: h.pool,
      etiqueta: h.etiqueta,
      cantidad: h.cantidad,
      disponible: h.disponible,
      etiquetaReal: h.etiquetaReal,
    }));

    /* Las filas del desplegable. Un porcentaje sólo se anuncia si su escalón
     * EXISTE en la expansión; si no, se dice a dónde cae de verdad, que es más
     * honesto que enseñar una probabilidad inalcanzable (en toda la era Espada
     * y Escudo no hay ni Illustration Rare ni Ultra Rare). */
    const filaPremio: [string, string][] = premio.map((r) =>
      r.disponible
        ? [r.etiqueta, pct(r.prob)]
        : [`${r.etiqueta} (no hay)`, `→ ${r.etiquetaReal}`],
    );
    const filaHuecos: [string, string][] = garantias
      .filter((h) => h.pool !== "common" && h.pool !== "uncommon")
      .map((h) =>
        h.disponible
          ? [h.etiqueta, `${h.cantidad}×`]
          : [`${h.etiqueta} (no hay)`, `→ ${h.etiquetaReal}`],
      );
    // El Leyenda y el Promo no tienen hueco de premio: su promesa es la carta
    // que te falta, y eso no es una probabilidad.
    const filas: [string, string][] =
      tipo === "GOLDEN" || tipo === "SPECIAL"
        ? [[NUEVA_GARANTIZADA, "1×"], ...filaHuecos]
        : [...filaPremio, ...filaHuecos];

    return {
      tipo,
      precio: PACK_PRICES[tipo],
      cartas: comp.cartas,
      disponible,
      garantias,
      rarasGarantizadas: garantias.find((h) => h.pool === "rare")?.cantidad ?? 0,
      premio,
      retirados: comp.retirados,
      filas,
    };
  };

  /**
   * Qué reparte de verdad cada sobre de esta expansión, ya calculado.
   *
   * Lee el porqué en el bloque de arriba. Resumen para quien pinta: esto no se
   * recalcula en la pantalla, se pinta. Devuelve los cuatro tipos SIEMPRE, con
   * `disponible` diciendo cuáles se pueden comprar aquí.
   */
  export async function getComposicionDeSobres(setId: string) {
    // Misma validación de forma que la compra: lo que llega del cliente es un
    // deseo, no un dato, aunque esta acción sólo lea.
    if (typeof setId !== "string" || !/^[a-z0-9._-]{1,40}$/i.test(setId)) {
      return { ok: false as const, motivo: "set-invalido" as const };
    }

    try {
      const { userId } = await auth();
      const conSesion = Boolean(userId);

      /* EL CATÁLOGO, POR EL MISMO SITIO QUE EL SORTEO. `cartasDelSet` es lo que
       * le da a esto su razón de ser: trae `precioEur` pegado y comparte la
       * caché de instancia con la compra, así que lo que se anuncia y lo que se
       * reparte salen de la MISMA lista de cartas.
       *
       * SIN SEMBRAR (segundo argumento): esta acción no exige sesión y sembrar
       * son ~250 INSERT. Si el set aún no está en la base se cae al catálogo
       * local, que es EXACTAMENTE lo que `syncSetToDatabase` sembraría (lee de
       * loadLocalCards), así que la respuesta no cambia por eso; y las
       * expansiones que sólo existen en la base —las que trae el cron y no
       * están en los 38 JSON— ya están sembradas por definición. */
      // La ficha va PRIMERO: su `total` es lo que le dice a `cartasDelSet` si
      // el catálogo que ha leído está entero o a medio ingerir.
      const ficha = await fichaDelSet(setId);
      let fuente: "bd" | "local" = "bd";
      let cartas = await cartasDelSet(setId, false, ficha?.total);
      const locales = await loadLocalCards(setId);
      // `<` y no `=== 0`: a una siembra cortada a mitad le faltan cartas que la
      // compra va a sembrar antes de sortear (`cartasDelSet` con siembra), así
      // que lo que se anuncia es el catálogo local entero, igual que con cero.
      if (cartas.length < locales.length) {
        fuente = "local";
        cartas = locales.map(aCartaDeSobre);
        if (cartas.length > 0) {
          // El precio real también aquí: si no, el respaldo local anunciaría un
          // sobre calibrado con otros precios que el que se va a repartir.
          try {
            const euros = await preciosEnEuros(cartas.map((c) => c.id));
            if (euros.size > 0) {
              cartas = cartas.map((c) => {
                const eur = euros.get(c.id);
                return eur ? { ...c, precioEur: eur } : c;
              });
            }
          } catch (e) {
            console.warn("Precios reales no disponibles al anunciar el sobre:", e);
          }
        }
      }
      if (cartas.length === 0) {
        return { ok: false as const, motivo: "sin-catalogo" as const };
      }

      if (!ficha) return { ok: false as const, motivo: "set-invalido" as const };

      /* LA ERA Y LOS PRECIOS, LOS DE QUIEN VA A REPARTIR DE VERDAD, y las dos
       * mitades ya no van juntas.
       *
       * LA ERA ES LA MISMA PARA TODOS. Aquí había un `conSesion ? ... : null`
       * porque el navegador del invitado repartía sin era, y anunciarle la del
       * servidor habría sido cambiar una mentira por otra. Desde que el invitado
       * reparte con la era de la expansión (app/page.tsx, `eraDelReparto`), esa
       * excepción decía justo lo contrario de lo que pasa: le habría prometido
       * 5/10/25/60 en un Escarlata y Púrpura donde su navegador le da 8/15/30/47.
       * No llegaba a nadie —hoy sólo pregunta quien tiene sesión— pero era una
       * trampa esperando al primero que abriera esta acción al invitado.
       *
       * LOS PRECIOS EN EUROS SÍ SIGUEN SIENDO DISTINTOS, y no es un descuido:
       * el precio real de Cardmarket vive en la base y no baja al navegador, así
       * que el invitado no puede reproducir una calibración que le quite un
       * hueco. Anunciárselo le prometería un número de cartas que no va a
       * recibir. Por eso el catálogo del invitado va con `precioEur` anulado:
       * esta respuesta calcula exactamente lo que calcula su navegador. */
      const era = eraDeSerie(ficha.series);
      const catalogo = conSesion
        ? cartas
        : cartas.map((c) => ({ ...c, precioEur: null }));

      /* UNA EXPANSIÓN A MEDIO INGERIR NO VENDE NINGÚN SOBRE, y se anuncia así:
       * es el mismo corte que aplica `comprarSobreAction` (ver
       * `catalogoIncompleto`). Sólo puede pasar con el catálogo de la base: el
       * del repositorio está entero por definición. */
      const incompleto = fuente === "bd" && catalogoIncompleto(cartas.length, ficha.total);
      const permitidos = incompleto
        ? new Set<TipoSobre>()
        : sobresPermitidos(ficha, catalogo, era);
      const sobres = {} as Record<TipoSobre, SobreAnunciado>;
      for (const tipo of TIPOS_DE_SOBRE) {
        sobres[tipo] = fichaDeSobre(tipo, catalogo, era, permitidos.has(tipo));
      }

      return {
        ok: true as const,
        setId,
        /** true = la expansión aún se está descargando y no vende ningún sobre. */
        incompleto,
        /** La era con la que se reparte de verdad el hueco de premio. */
        era,
        /** Quién sortea el sobre de quien está preguntando. */
        reparto: conSesion ? ("servidor" as const) : ("navegador" as const),
        /** De dónde salió el catálogo con el que se ha calculado todo esto. */
        fuente,
        sobres,
      };
    } catch (e) {
      console.error("getComposicionDeSobres error:", e);
      return { ok: false as const, motivo: "error" as const };
    }
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
    era?: Era,
  ): CartaDeSobre[] {
    const combinado: CartaDeSobre[] = [];
    const mias = new Set(poseidas);
    for (let i = 0; i < cantidad; i++) {
      let sobre: CartaDeSobre[];
      if (tipo === "STANDARD") sobre = openStandardPack(cartas, era);
      else if (tipo === "PREMIUM") sobre = openPremiumPack(cartas, era);
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

    /* TOPE DE FRECUENCIA, antes de tocar la base. Una compra legítima va detrás
     * de una animación de apertura; veinte en diez segundos sólo las manda un
     * script. Es una negativa FIRME y con motivo propio —no "error"— porque el
     * cliente reintenta los "error" y da la compra por dudosa
     * (components/tienda/compra.ts), y aquí no hay duda: no se ha hecho nada.
     * Ver services/limite.ts para lo que este tope puede y no puede prometer. */
    if (!dentroDelLimite("sobre:" + userId, LIMITES.comprarSobre)) {
      /* PERO ANTES SE MIRA SI ESTA CLAVE YA SE COBRÓ. El reenvío de una compra
       * cuya respuesta se perdió llega con la misma clave; si para entonces el
       * tope está gastado (otras pestañas, un doble toque insistente), la
       * negativa firme de abajo le decía al cliente "no se ha hecho nada" de un
       * sobre que SÍ se había cobrado, y el jugador no veía las cartas que
       * pagó. Es una lectura por clave primaria: no reabre lo que el tope
       * protege, que es el catálogo, el sorteo y el cobro. Si esa lectura
       * falla, se contesta lo de siempre. */
      try {
        await ensureSchema();
        const servido = await sobreYaServido(userId, clave);
        if (servido) return servido;
      } catch (e) {
        console.error("comprarSobreAction: no se pudo mirar el recibo con el tope gastado:", e);
      }
      return { ok: false as const, motivo: "demasiadas-peticiones" as const };
    }

    try {
      await ensureSchema();

      /* LA FICHA Y EL SALDO, A LA VEZ Y ANTES QUE NADA.
       *
       * EL AGUJERO QUE CIERRA: sin saldo, esta acción leía el catálogo, la
       * ficha y las cartas poseídas, sorteaba hasta diez sobres, lanzaba la
       * sentencia de cobro y, al no cobrar, aún consultaba el recibo: cuatro o
       * cinco viajes a Postgres y el sorteo entero por cada POST de una cuenta
       * a cero. Ahora quien no puede pagar se queda en dos lecturas por clave
       * primaria.
       *
       * NO ES EL GUARD DEL DINERO: el saldo se vuelve a comprobar dentro del
       * UPDATE del cobro, sobre la fila bloqueada. Esto sólo evita trabajar
       * para una compra que no va a ocurrir. Y van en paralelo para que la
       * compra legítima no pague un viaje de más: la ficha ya se leía.
       *
       * EL REENVÍO SIGUE FUNCIONANDO IGUAL: si no llega el saldo se mira antes
       * si esa clave ya se sirvió, que es lo que pasa cuando el reintento llega
       * después de un cobro que dejó la cuenta por debajo del precio. */
      const [ficha, previo] = await Promise.all([
        fichaDelSet(setId),
        sql`SELECT coins FROM users WHERE id = ${userId}`,
      ]);
      if (!ficha) return { ok: false as const, motivo: "set-invalido" as const };
      if (Number(previo.rows[0]?.coins ?? 0) < precio) {
        const servido = await sobreYaServido(userId, clave);
        return servido ?? { ok: false as const, motivo: "sin-saldo" as const };
      }

      const cartas = await cartasDelSet(setId, true, ficha.total);
      if (cartas.length === 0) return { ok: false as const, motivo: "set-invalido" as const };

      /* EXPANSIÓN A MEDIO INGERIR: no se vende. Ver `catalogoIncompleto`. El
       * motivo es el que la tienda ya sabe decir ("ese sobre no está a la venta
       * en esta expansión"), y `detalle` cuenta por qué a quien quiera pintarlo
       * mejor. No se cobra ni se sortea nada. */
      if (catalogoIncompleto(cartas.length, ficha.total)) {
        return {
          ok: false as const,
          motivo: "sobre-no-disponible" as const,
          detalle: "set-incompleto" as const,
        };
      }

      /* LA ERA DE LA EXPANSIÓN, que decide con qué probabilidades se reparte el
       * hueco de premio. Sale de `series`, que ya venía en la ficha y que hasta
       * ahora sólo se usaba para el filtro de colecciones especiales.
       *
       * Una expansión sin serie —recién ingerida, o servida por el respaldo
       * local— cae en la era 'media', que es EXACTAMENTE el reparto que tenía
       * el juego antes de que existieran las eras. No saber la era nunca cambia
       * el comportamiento de siempre.
       *
       * Se calcula UNA vez y se pasa a los dos sitios que la necesitan: el
       * filtro que decide qué sobres se venden y el sorteo que los reparte. Si
       * cada uno la dedujera por su cuenta, un día divergirían. */
      const era = eraDeSerie(ficha.series);

      if (!sobresPermitidos(ficha, cartas, era).has(tipoSobre)) {
        return { ok: false as const, motivo: "sobre-no-disponible" as const };
      }

      // La lista de "las que ya tengo" sale de la BD, no del navegador: si la
      // pusiera el cliente, mandar una lista vacía convertiría cada Leyenda en
      // una carta nueva garantizada aunque tuviera la colección completa.
      const poseidas =
        tipoSobre === "GOLDEN" || tipoSobre === "SPECIAL"
          ? await idsPoseidosDelSet(userId, setId)
          : [];

      const sobre = sortearSobres(tipoSobre, cantidad, cartas, poseidas, era);
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
        `WITH bloqueo AS MATERIALIZED (
           /* EL CANDADO DE LA COLECCIÓN VA DELANTE DEL DE users, Y ESTO NO ES
            * UNA MEJORA: ES CERRAR UNA INVERSIÓN QUE YA HACÍA DAÑO.
            *
            * Ésta era la ÚNICA sentencia del repositorio que pedía los dos
            * candados al revés: primero la fila de users (en 'cobro') y después
            * las de user_collection (en 'abono'). Todas las demás que tocan las
            * dos tablas —graduarCartasAction, venderGraduadaAction,
            * comprarEnBazarAction, sellPackDuplicates— bloquean user_collection
            * primero. Mientras la graduación tomaba la fila de users en su
            * ÚLTIMO CTE, la inversión casi no se notaba; desde que el CTE
            * 'solvente' la toma antes de insertar —que es justo lo que impide
            * graduar sin pagar— se abrazan de verdad.
            *
            * MEDIDO contra PostgreSQL 18 real, con el mismo usuario graduando y
            * comprando sobres a la vez (8 sesiones, 2.700 operaciones por
            * variante, deadlock_timeout por defecto, nueve vueltas rotando el
            * orden de medida): 13,6 % de las operaciones morían con 40P01. Sin
            * el candado de 'solvente' ya morían el 4,5 %, o sea que la inversión
            * hacía daño por su cuenta. Con este CTE delante: 0 de 2.700, las
            * nueve vueltas, y el duelo pasa de 318 s a 10 s.
            *
            * NO CAMBIA LO QUE HACE LA SENTENCIA. Toma antes las MISMAS filas que
            * 'abono' va a tocar de todos modos, y en el orden (user_id, card_id)
            * que es el invariante global del repositorio. Una carta que el
            * usuario todavía no tiene no tiene fila que bloquear, y de ésa se
            * sigue encargando el ON CONFLICT de 'abono'. */
           SELECT uc.user_id, uc.card_id
           FROM user_collection uc
           WHERE uc.user_id = $1 AND uc.card_id = ANY($8::text[])
           ORDER BY uc.user_id, uc.card_id
           FOR UPDATE OF uc
         ),
         cobro AS (
           UPDATE users
              SET coins        = coins - $3,
                  packs_opened = COALESCE(packs_opened, 0) + $4,
                  money_spent  = COALESCE(money_spent, 0) + $3
            WHERE id = $1
              /* LA REFERENCIA A 'bloqueo' ES LO QUE FUERZA EL ORDEN, y por eso
               * está aquí una condición que siempre es cierta: un count(*) nunca
               * es negativo. Un CTE que nadie lee no se ejecuta, así que sin esta
               * línea el candado de la colección ni se pediría antes ni se
               * pediría. Al ser parte del filtro del escaneo se evalúa por debajo
               * del nodo que bloquea la fila de users, que es exactamente la
               * garantía que hace falta. Si el saldo o el recibo ya fallan, el
               * CTE no llega a ejecutarse y no se bloquea nada: tampoco hace
               * falta, porque la compra no ocurre. */
              AND (SELECT count(*) FROM bloqueo) >= 0
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
           -- El RETURNING trae ademas la cantidad RESULTANTE de cada carta, que
           -- es lo que dice que numero de copia acaba de tocar. De ahi sale el
           -- estado fisico que se pinta al abrir el sobre: la copia numero N de
           -- una carta tiene su propio desgaste, y sin este dato habria que
           -- volver a leer la coleccion despues y arriesgarse a que otra
           -- compra concurrente la hubiera movido entre medias.
           RETURNING user_collection.card_id AS card_id,
                     user_collection.quantity AS cantidad
         )
         -- Sin FROM: la sentencia devuelve siempre exactamente una fila, con
         -- coins a NULL si no hubo cobro. Y cobro toca como mucho una fila
         -- (filtra por la clave primaria de users), asi que la subconsulta
         -- escalar no puede reventar por devolver de mas.
         SELECT (SELECT coins FROM cobro)         AS coins,
                (SELECT count(*)::int FROM abono) AS abonadas,
                COALESCE(
                  (SELECT json_agg(json_build_object(
                     'id', card_id, 'cantidad', cantidad)) FROM abono),
                  '[]'::json
                ) AS resultantes`,
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
      return {
        ok: true as const,
        cartas: conEstadoFisico(userId, sobre, rows[0]?.resultantes),
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
      cartas: await conEstadoFisicoDeAhora(userId, await cartasPorId(ids)),
      coins: Number(rows[0].coins ?? 0),
      precio: Number(rows[0].precio ?? 0),
      reenvio: true,
    };
  }

  /**
   * El desgaste de un sobre que se vuelve a servir.
   *
   * La compra pinta cada carta con el estado de SU copia, y lo saca de la
   * cantidad resultante que devuelve la propia sentencia (ver
   * `conEstadoFisico`). El reenvío no tenía ese dato y devolvía las cartas
   * limpias: el sobre que se reintentaba tras perder la respuesta —que es el
   * mismo sobre— salía sin la carta machacada que le había tocado, y la carta
   * aparecía marcada después en la colección.
   *
   * Aquí se usa la cantidad que hay AHORA. En el caso que importa, el reintento
   * a los pocos segundos, es la misma que dejó la compra y el resultado es
   * idéntico. Si entre medias se compró o se vendió algo de esa carta, el
   * número de copia sale movido y se pinta el desgaste de otra copia: es el
   * mismo desajuste que ya se acepta más arriba (ESTO RECORRE 1..CANTIDAD…), y
   * por la misma razón: de aquí no sale ni una moneda ni una nota. El filtro
   * que protege la economía es el de `conEstadoFisico` y se aplica igual.
   *
   * Si la lectura falla, el sobre se sirve limpio, como hasta ahora.
   */
  async function conEstadoFisicoDeAhora(
    userId: string,
    sobre: CartaDeSobre[],
  ): Promise<CartaDeSobre[]> {
    if (sobre.length === 0) return sobre;
    try {
      const { rows } = await sql.query(
        `SELECT card_id, quantity
           FROM user_collection
          WHERE user_id = $1 AND card_id = ANY($2::text[])`,
        [userId, Array.from(new Set(sobre.map((c) => c.id)))],
      );
      return conEstadoFisico(
        userId,
        sobre,
        rows.map((r: { card_id: unknown; quantity: unknown }) => ({
          id: String(r.card_id),
          cantidad: Number(r.quantity),
        })),
      );
    } catch (e) {
      console.error("No se pudo leer el estado de un sobre ya servido:", e);
      return sobre;
    }
  }

  /**
   * Devuelve un sobre YA COBRADO por su clave. SÓLO LEE: no puede comprar.
   *
   * POR QUÉ EXISTE, si `comprarSobreAction` con la misma clave ya devuelve el
   * sobre servido. Porque sólo lo devuelve si el recibo sigue ahí. El aviso
   * «Tienes un sobre sin terminar de ver» ofrece «Ver sobre» sobre una compra
   * que el cliente tiene apuntada como cobrada; si ese recibo ya no existiera
   * —la poda de `podarRecibosViejos`, un apunte manipulado—, reenviar la clave
   * por la acción de compra sería una compra NUEVA que nadie ha pedido, hecha
   * al pulsar un botón que dice «ver». Un botón que dice ver no puede cobrar.
   *
   * La compra en duda («no sabemos si llegó») sigue yendo por
   * `comprarSobreAction`: ahí reintentar ES comprar si no había llegado, y es
   * lo que el jugador pidió.
   */
  export async function recuperarSobreAction(clave: string) {
    const { userId } = await auth();
    if (!userId) return { ok: false as const, motivo: "sin-sesion" as const };
    if (typeof clave !== "string" || !/^[A-Za-z0-9._:-]{8,64}$/.test(clave)) {
      return { ok: false as const, motivo: "clave-invalida" as const };
    }
    try {
      await ensureSchema();
      const servido = await sobreYaServido(userId, clave);
      return servido ?? { ok: false as const, motivo: "no-encontrado" as const };
    } catch (e) {
      console.error("Error recuperando un sobre ya cobrado:", e);
      return { ok: false as const, motivo: "error" as const };
    }
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

  /* ==================================================================== *
   * LOS DOS IMPORTES QUE LA COLECCIÓN PROMETE, Y POR QUÉ LOS CALCULA EL
   * SERVIDOR
   * ====================================================================
   *
   * EL FALLO QUE CIERRA ESTO, MEDIDO: el botón "Vender +X" de la colección
   * llamaba a `valorDeVenta(rareza, copias, 1)` SIN el cuarto argumento —el
   * precio real de Cardmarket— porque `getFullCollection` no devolvía nada de
   * euros. El servidor sí lo aplica. Con una Hyper Rare y 3 copias: sin precio
   * conocido decía 214 y pagaba 214; con la carta a 50 € decía 214 y abonaba
   * 225; con 200 €, decía 214 y abonaba 257. Siempre a favor del jugador, y
   * siempre una promesa que no era la que se cumplía.
   *
   * Y NO SE ARREGLA MANDANDO `precioEur` PARA QUE LA PANTALLA REHAGA LA CUENTA:
   * eso es la misma fórmula escrita en dos sitios, que es exactamente como nació
   * el "Vender por 488" que abonaba 417 de la vitrina. Viajan los IMPORTES ya
   * hechos, igual que `getVitrina` manda `valorDeVentaAhora`, y la pantalla
   * pinta lo que le dan.
   *
   * SON DOS NÚMEROS Y NO UNO PORQUE HAY DOS BOTONES, y cada uno vende una
   * cantidad distinta de copias sobre la MISMA curva:
   *
   *   · `valorDeVentaAhora`      UNA copia (rejilla y hoja de acciones)
   *                              = lo que abona `sellCardAction`.
   *   · `valorDeVentaRepetidas`  TODAS las repetidas libres (el botón del
   *                              detalle y cada sumando del total de "Limpiar
   *                              duplicados") = lo que abonan
   *                              `sellAllDuplicatesAction` y, carta a carta,
   *                              `sellAllDuplicatesBulkAction`.
   *
   * No son derivables el uno del otro sin volver a aplicar la curva, que es
   * justo lo que la pantalla deja de hacer.
   *
   * LA CURVA VA SOBRE EL MONTÓN ENTERO Y LAS GRADUADAS SÓLO ACOTAN CUÁNTAS SE
   * VENDEN. Es la misma regla que ya sostienen las tres rutas de venta: una
   * copia graduada sigue ocupando su sitio en el montón —por eso `copiasQueTengo`
   * es `quantity` a secas— pero sale por la vitrina, así que no entra en el
   * recuento de lo vendible.
   *
   * Y LAS ANUNCIADAS EN EL BAZAR, IGUAL QUE LAS GRADUADAS: siguen en el montón
   * y tampoco se venden por aquí (ver `copiasComprometidas`). Por eso el tercer
   * argumento es la SUMA de las dos, aunque conserve el nombre: el cuerpo de la
   * función está amarrado carácter a carácter a su réplica de
   * scripts/test-invariantes.mjs, y la cuenta es la misma para las dos clases
   * de copia comprometida.
   *
   * @param copiasQueTengo copias en propiedad AHORA, graduadas incluidas.
   * @param graduadas      cuántas de ellas están COMPROMETIDAS: las de la
   *                       vitrina más las de anuncios sueltos abiertos.
   */
  function valoresDeVentaDelMonton(
    rareza: string | null | undefined,
    copiasQueTengo: number,
    graduadas: number,
    euros?: number | null,
  ) {
    const repetidasLibres = Math.max(0, copiasQueTengo - graduadas - 1);
    return {
      /* `Math.min(1, ...)` y no un 1 fijo: con 3 copias y 2 graduadas queda UNA
       * copia libre, `sellCardAction` contesta que no, y el número tiene que ser
       * 0 para que el botón no prometa un pago que la acción va a rechazar. Es
       * el mismo criterio que el "el botón enseña 0 donde la venta se niega" de
       * la vitrina. */
      valorDeVentaAhora: valorDeVenta(rareza, copiasQueTengo, Math.min(1, repetidasLibres), euros),
      valorDeVentaRepetidas: valorDeVenta(rareza, copiasQueTengo, repetidasLibres, euros),
    };
  }

  /**
   * @param setId OPCIONAL. Con él, sólo las cartas de ESA expansión. Lo pide el
   *   álbum, que antes se bajaba la colección entera —441 cartas con ataques,
   *   legalidades y precios— para filtrarla por prefijo en el navegador y
   *   quedarse con las 30 de una expansión. La forma de cada carta es
   *   exactamente la misma con y sin él; sin él (lo de siempre), todo.
   */
  export async function getFullCollection(setId?: string) {
    const { userId } = await auth();
    if (!userId) return [];
    /* Lo que llega del cliente es un deseo, no un dato. Y un argumento que no
     * sea un id de expansión se IGNORA en vez de rechazarse: esta acción se
     * llamaba sin argumentos, y quien la pase como manejador de un evento le
     * estará mandando el evento. Lo peor que puede pasar así es lo de siempre,
     * la colección entera. */
    const soloSet =
      typeof setId === "string" && /^[a-z0-9._-]{1,40}$/i.test(setId) ? setId : null;

    try {
      // La consulta lee graded_cards y bazar_listings: tienen que existir aunque
      // ésta sea la primera acción de la instancia (y casi siempre lo es: la
      // portada pide la colección antes que nada). Con `catch`: si asegurar el
      // esquema falla pero las tablas están, la colección se sirve igual; y si
      // no están, la consulta de abajo ya falla por su cuenta.
      await ensureSchema().catch((e) => console.error("getFullCollection: esquema:", e));
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
        /* LAS NOTAS VIAJAN CON LA COLECCION.
         *
         * Se pidio que graduar quedara REFLEJADO en la coleccion y en el
         * archivador, no solo en la pantalla de graduacion. Van dos datos por
         * carta: cuantas copias tiene graduadas y cual es la MEJOR nota, que es
         * la que un coleccionista ensena.
         *
         * Con LEFT JOIN a una agregacion y no con subconsultas correlacionadas:
         * esto lo lee la coleccion entera —cientos de filas— y una subconsulta
         * por carta seria un escaneo por carta. El indice
         * idx_graded_cards_user_card existe justo para este agrupado.
         *
         * Solo las ACTIVAS: una copia vendida conserva su fila para que su
         * indice no se recicle (ver services/esquemaMejoras.ts), pero ya no
         * esta en la coleccion y no debe pintar insignia.
         *
         * Y LAS ANUNCIADAS EN EL BAZAR, con el mismo LEFT JOIN agregado: son
         * copias comprometidas que no se venden por la via normal, asi que
         * entran en lo que la pantalla ofrece vender. Solo los anuncios
         * SUELTOS: la copia de un anuncio de graduada ya va en "graduadas". */
        `SELECT c.*, uc.quantity, uc.is_favorite,
                COALESCE(g.n, 0)::int AS graduadas,
                g.mejor_nota,
                COALESCE(z.n, 0)::int AS anunciadas
           FROM user_collection uc
           JOIN cards c ON uc.card_id = c.id
           LEFT JOIN unnest($2::text[], $3::int[]) AS rk(rareza, rango)
             ON rk.rareza = c.rarity
           LEFT JOIN (
             SELECT card_id, count(*)::int AS n, MAX(nota)::int AS mejor_nota
               FROM graded_cards
              WHERE user_id = $1 AND estado = 'activa'
              GROUP BY card_id
           ) g ON g.card_id = uc.card_id
           LEFT JOIN (
             SELECT card_id, count(*)::int AS n
               FROM bazar_listings
              WHERE seller_id = $1 AND estado = 'activa' AND graded_id IS NULL
              GROUP BY card_id
           ) z ON z.card_id = uc.card_id
          WHERE uc.user_id = $1 AND uc.quantity > 0
            AND ($4::text IS NULL OR c.set_id = $4::text)
          ORDER BY
            COALESCE(uc.is_favorite, false) DESC,
            COALESCE(rk.rango, 0) DESC,
            c.name ASC`,
        [userId, rarezas, rangos, soloSet],
      );
      
      const parse = (v: any, fb: any = null) => {
        if (v == null) return fb;
        return typeof v === 'string' ? JSON.parse(v) : v;
      };
      // El álbum, la colección y el buscador local de la colección leen `name`
      // e `images` de aquí: traducir en este `return` los pone en español de
      // una vez. `id`, `rarity` y `quantity` salen intactos, que es lo que
      // miran la venta y los bonos de expansión.
      /* El estado físico de la MEJOR copia de cada carta. Se calcula una vez
       * aquí y no en cada pantalla: la colección, el álbum y el detalle lo
       * pintan todos, y derivarlo en el cliente sería devolverle la semilla
       * —que es lo que delata la nota— justo lo que se acaba de cerrar. */
      const secretoNotas = secretoDeNotas();

      /* LOS PRECIOS REALES, EN UNA SOLA CONSULTA PARA LA COLECCIÓN ENTERA.
       *
       * Es el mismo patrón que `sellAllDuplicatesBulkAction`, que puede tocar
       * cientos de cartas: `preciosEnEuros` trocea de 900 en 900 ids y cachea
       * diez minutos por carta, así que esto son cero o una idas y vueltas más
       * —tres con una colección de 2.500 cartas recién arrancado el proceso—, no
       * una por carta. Y nunca lanza: sin tabla de precios devuelve un mapa
       * vacío y todos los importes salen a tarifa por rareza, que es el
       * comportamiento de siempre. */
      const euros = await preciosEnEuros(rows.map((r) => String(r.id)));

      return enIdiomaUsuario(
        rows.map((row: any) => {
          const estado = estadoDeLaMejorCopia(
            userId,
            String(row.id),
            Number(row.quantity) || 1,
            secretoNotas,
          );
          const eur = euros.get(String(row.id));
          const copias = Number(row.quantity) || 0;
          // Copias que NO se venden por la vía normal: las de la vitrina más
          // las de anuncios sueltos abiertos en el bazar.
          const comprometidas = (Number(row.graduadas) || 0) + (Number(row.anunciadas) || 0);
          return {
            ...row,
            images: parse(row.images),
            tcgplayer: parse(row.tcgplayer),
            types: parse(row.types, []),
            attacks: parse(row.attacks, []),
            weaknesses: parse(row.weaknesses, []),
            retreatCost: parse(row.retreat_cost, []),
            flavorText: row.flavor_text,
            /**
             * COPIAS QUE SE PUEDEN VENDER O ENTREGAR: las que se tienen menos
             * las graduadas y menos las anunciadas en el bazar. Es el número
             * con el que deciden las tres rutas de venta (de éstas, una se
             * queda siempre en el álbum). Viaja hecho por lo mismo que los
             * importes: la pantalla lo calculaba como `quantity - graduadas`, y
             * desde que una copia anunciada tampoco se vende esa cuenta ofrece
             * copias que el servidor ya no deja vender.
             */
            copiasLibres: Math.max(0, copias - comprometidas),
            /* LO QUE ABONAN LAS DOS RUTAS DE VENTA, YA CALCULADO. Ver el bloque
             * de `valoresDeVentaDelMonton`: la pantalla no vuelve a aplicar la
             * curva ni el ajuste por euros, pinta estos números. */
            ...valoresDeVentaDelMonton(row.rarity, copias, comprometidas, eur),
            /**
             * Tarifa plana de la carta con su ajuste por precio real: lo que
             * VALE, no lo que se cobra por una repetida. Es la casilla "Valor de
             * la carta" del detalle, y es el mismo número —y el mismo nombre—
             * que mandan `getVitrina` y `getCartasGraduables` para la banda del
             * bazar. La curva NO entra aquí a propósito.
             */
            valorDeReferencia: precioDeCartaSuelta(row.rarity, eur),
            // Ausente cuando la carta se ve bien, que es lo normal.
            ...(estado ?? {}),
          };
        }),
      );
    } catch (error) {
      console.error("❌ Error cargando colección:", error);
      return [];
    }
  }

  /**
   * La colección EN LIGERO: de cada carta, sólo lo que hace falta para saber
   * qué se tiene y cuánto darían sus repetidas.
   *
   * POR QUÉ EXISTE. La portada pide `getFullCollection()` al entrar y después
   * de cada sobre, y de todo lo que baja —unos 800 bytes por carta: ataques,
   * debilidades, legalidades, precios de tcgplayer, el estado físico de la
   * mejor copia calculado fila a fila— usa el id, la rareza, las cantidades y
   * el importe de las repetidas (components/tienda/repetidas.ts). Con 441
   * cartas son unos 350 KB para pintar una insignia de "Nueva" y un botón.
   *
   * Los campos se llaman IGUAL que en `getFullCollection` y significan lo
   * mismo, así que quien ya lee aquéllos puede cambiar de acción sin tocar
   * nada más. Los importes salen de la misma función (`valoresDeVentaDelMonton`)
   * y con el mismo precio real, por lo que no pueden discrepar.
   *
   * Sólo lee datos de quien llama y no recibe argumentos: no hay nada que
   * validar ni que falsificar.
   */
  export async function getInventarioColeccion() {
    const { userId } = await auth();
    if (!userId) return [];
    try {
      await ensureSchema().catch((e) => console.error("getInventarioColeccion: esquema:", e));
      const { rows } = await sql.query(
        `SELECT uc.card_id AS id, c.rarity, uc.quantity, uc.is_favorite,
                COALESCE(g.n, 0)::int AS graduadas,
                COALESCE(z.n, 0)::int AS anunciadas
           FROM user_collection uc
           JOIN cards c ON uc.card_id = c.id
           LEFT JOIN (
             SELECT card_id, count(*)::int AS n
               FROM graded_cards
              WHERE user_id = $1 AND estado = 'activa'
              GROUP BY card_id
           ) g ON g.card_id = uc.card_id
           LEFT JOIN (
             SELECT card_id, count(*)::int AS n
               FROM bazar_listings
              WHERE seller_id = $1 AND estado = 'activa' AND graded_id IS NULL
              GROUP BY card_id
           ) z ON z.card_id = uc.card_id
          WHERE uc.user_id = $1 AND uc.quantity > 0`,
        [userId],
      );
      const euros = await preciosEnEuros(rows.map((r) => String(r.id)));
      return rows.map((r) => {
        const copias = Number(r.quantity) || 0;
        const graduadas = Number(r.graduadas) || 0;
        const anunciadas = Number(r.anunciadas) || 0;
        return {
          id: String(r.id),
          rarity: String(r.rarity ?? "Common"),
          quantity: copias,
          is_favorite: r.is_favorite === true,
          graduadas,
          anunciadas,
          copiasLibres: Math.max(0, copias - graduadas - anunciadas),
          ...valoresDeVentaDelMonton(
            r.rarity,
            copias,
            graduadas + anunciadas,
            euros.get(String(r.id)),
          ),
        };
      });
    } catch (error) {
      console.error("❌ Error cargando el inventario de la colección:", error);
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
  /* ==================================================================== *
   * LAS COPIAS QUE NO SE PUEDEN VENDER
   * ====================================================================
   *
   * Una copia graduada está en la vitrina, no en el montón de repetidas: no se
   * puede vender por la vía normal ni entregar en el mercado. Para venderla hay
   * que pasar por venderGraduadaAction, que además cobra el multiplicador de su
   * nota.
   *
   * POR QUÉ ESTO ES OBLIGATORIO EN LAS CINCO RUTAS DE VENTA Y NO SÓLO EN UNA:
   * la tabla graded_cards apunta a (usuario, carta) pero user_collection sólo
   * lleva un CONTADOR. Si una ruta de venta bajase quantity por debajo del
   * número de filas graduadas, esas filas quedarían apuntando a copias que ya
   * no existen: cartas graduadas fantasma, que la vitrina pintaría y que al
   * venderse pagarían por algo que el jugador ya cobró. El invariante que hay
   * que sostener en TODAS es
   *
   *     copias_graduadas(usuario, carta)  <=  quantity resultante
   *
   * y la forma de sostenerlo es tratar las graduadas como copias protegidas,
   * exactamente igual que COPIAS_PROTEGIDAS protege la última.
   *
   * SE CONSULTA DENTRO DE LA MISMA SENTENCIA que descuenta, además de aquí:
   * este número sirve para calcular el precio, pero quien impide de verdad la
   * venta es el guard SQL, que se evalúa sobre la fila ya bloqueada. Leerlo
   * aquí y confiar en él sería la misma ventana de carrera que el repositorio
   * ya cerró en sellPackDuplicates.
   */
  /* POR QUÉ DEVOLVER 0 ANTE UN ERROR NO ES PELIGROSO AQUÍ, aunque lo parezca.
   *
   * Una revisión marcó esto como "falla abierto": si la consulta revienta, el
   * número sale 0, que significa "ninguna copia bloqueada" y por tanto el más
   * permisivo. Es cierto, y aun así es lo correcto, porque este número NO ES EL
   * GUARD. Se usa sólo para calcular el precio; quien de verdad impide vender
   * una copia graduada es la condición SQL que va DENTRO de la sentencia que
   * descuenta, sobre la fila ya bloqueada.
   *
   * Y esa condición falla CERRADA: si graded_cards no existiera, la sentencia
   * entera lanzaría y la venta no ocurriría. Además el error por el lado del
   * precio es conservador — con 0 se supone que hay más copias vendibles de las
   * que hay, y la curva paga MENOS por copia, no más.
   *
   * Lo que sí compra este catch es que un despliegue sin migrar siga vendiendo
   * cartas con normalidad en vez de romperse. */
  /* ==================================================================== *
   * Y LAS COPIAS ANUNCIADAS EN EL BAZAR TAMPOCO
   * ====================================================================
   *
   * EL AGUJERO QUE CIERRA (anuncios zombi): el bazar no aparta la carta al
   * publicarla —el anuncio es una fila y `quantity` no se mueve—, y la copia
   * anunciada sólo se contaba AL PUBLICAR. Las demás rutas la ignoraban: con 2
   * copias y una anunciada, "vender todas las repetidas" cobraba la copia
   * anunciada y dejaba `quantity = 1`. El anuncio seguía 'activa' en el
   * escaparate, todo comprador leía "o se la ha llevado otro, o no te llega el
   * saldo", no caducaba nunca y ocupaba uno de los 20 huecos del vendedor.
   *
   * LA REGLA, que es la misma que ya protegía a las graduadas: UNA COPIA
   * ANUNCIADA ESTÁ COMPROMETIDA. No se vende a la tienda, no se entrega en el
   * mercado, no se gradúa y no se da en un trueque mientras su anuncio siga
   * abierto; para usarla en otra cosa hay que retirar el anuncio. El invariante
   * que sostienen TODAS las rutas que gastan copias es
   *
   *     quantity resultante  >=  graduadas + anunciadas sueltas + 1
   *
   * (el +1 es la copia libre que `comprarEnBazarAction` exige que le quede al
   * vendedor: sin ella la compra se niega aunque el anuncio exista).
   *
   * POR QUÉ ASÍ Y NO RETIRANDO EL ANUNCIO DESDE CADA VENTA, que era la otra
   * salida:
   *   - publicar es una decisión del jugador (quiere por esa copia más de lo
   *     que paga la tienda); que el botón "vender repetidas" se la vendiera a
   *     la tienda y le retirase el anuncio sin decir nada sería deshacérsela;
   *   - retirar desde la venta obligaría a escribir en bazar_listings DESPUÉS
   *     de bloquear user_collection, y la compra bloquea al revés (primero el
   *     anuncio, luego la colección): interbloqueo nuevo entre el vendedor que
   *     vende y el comprador que compra;
   *   - contar es lo que ya hacen estas sentencias con las graduadas: un
   *     recuento más en el mismo guard, sin candados ni tablas nuevas.
   *
   * COMO EL DE LAS GRADUADAS, ESTE NÚMERO NO ES EL GUARD: sirve para el precio
   * y para decir que no con un mensaje; quien lo impide es la condición SQL de
   * la sentencia que descuenta.
   *
   * LO QUE EL RECUENTO NO PUEDE CERRAR, dicho claro: sale de la instantánea de
   * la sentencia, así que una publicación y una venta de la MISMA carta que se
   * crucen en el mismo instante pueden pasar las dos. Queda entonces un anuncio
   * sin respaldo, que ya no es un zombi eterno: `getBazar` no lo enseña y
   * `retirarAnunciosSinRespaldo` lo cierra (ver el bloque del bazar).
   */
  async function copiasComprometidas(
    userId: string,
    cardId: string,
  ): Promise<{ graduadas: number; anunciadas: number }> {
    try {
      const { rows } = await sql`
        SELECT
          (SELECT count(*)::int FROM graded_cards
            WHERE user_id = ${userId} AND card_id = ${cardId} AND estado = 'activa') AS graduadas,
          (SELECT count(*)::int FROM bazar_listings
            WHERE seller_id = ${userId} AND card_id = ${cardId}
              AND estado = 'activa' AND graded_id IS NULL) AS anunciadas
      `;
      return {
        graduadas: Number(rows[0]?.graduadas ?? 0),
        anunciadas: Number(rows[0]?.anunciadas ?? 0),
      };
    } catch {
      // Las tablas pueden no existir todavía en un despliegue sin migrar. Sin
      // graduaciones ni bazar, cero copias bloqueadas: el comportamiento de
      // siempre.
      return { graduadas: 0, anunciadas: 0 };
    }
  }

  /**
   * El precio real en euros de UNA carta, o undefined. Envoltorio de
   * preciosEnEuros para las rutas de venta, que van de una en una.
   *
   * TIENE QUE USARSE EN TODAS LAS RUTAS DE VENTA. El ajuste por precio real ya
   * entra en el calibrado del sobre (cartasDelSet se lo pega al catálogo); si
   * la venta NO lo aplicara, la tienda pagaría menos de lo que el calibrado dio
   * por supuesto y el jugador cobraría de menos por sus cartas caras. Y al
   * revés sería peor: una fuga.
   */
  async function euroDeCarta(cardId: string): Promise<number | undefined> {
    try {
      const m = await preciosEnEuros([cardId]);
      return m.get(cardId);
    } catch {
      return undefined;
    }
  }

  /**
   * Forma MÍNIMA de un id de carta que llega del cliente: una cadena corta.
   *
   * Para las rutas en las que el id sólo se usa para BUSCAR una fila que ya
   * existe (vender, marcar como deseada): ahí lo que valida de verdad es que la
   * fila esté, y esto sólo evita que un objeto o una cadena de kilobytes lleguen
   * hasta Postgres.
   *
   * NO ES `ID_CARTA` A PROPÓSITO. Aquel patrón sólo admite letras, cifras,
   * punto, guion y guion bajo, y el id de una carta es "expansión-número" con
   * el número IMPRESO, que no siempre es un número: Unseen Forces (ex10) trae
   * Unown numerados "!" y "?". En los 38 JSON del repositorio no hay ninguno
   * así —comprobado: los 6.779 ids pasan el patrón—, pero la base de producción
   * tiene las 171 expansiones. Usar `ID_CARTA` aquí sería dejar sin poder
   * venderse una carta que hasta hoy se vendía, por un patrón que estas rutas no
   * necesitan.
   */
  function esIdPlausible(valor: unknown): valor is string {
    return typeof valor === "string" && valor.length > 0 && valor.length <= 64;
  }

  export async function sellCardAction(cardId: string) {
    const { userId } = await auth();
    if (!userId) return null;
    // Lo que llega es el cuerpo de un POST, no un dato comprobado.
    if (!esIdPlausible(cardId)) return null;

    try {
      // El guard de la venta lee graded_cards y bazar_listings: tienen que
      // existir aunque ésta sea la primera acción de la instancia.
      await ensureSchema();
      const { rows: info } = await sql`
        SELECT uc.quantity, c.rarity
        FROM user_collection uc JOIN cards c ON c.id = uc.card_id
        WHERE uc.user_id = ${userId} AND uc.card_id = ${cardId}
      `;
      if (info.length === 0) return null;
      const cantidad = Number(info[0].quantity);
      // Las graduadas salen del montón de repetidas: están en la vitrina. Y las
      // anunciadas en el bazar también: están apalabradas (ver el bloque de
      // `copiasComprometidas`).
      const { graduadas, anunciadas } = await copiasComprometidas(userId, cardId);
      const comprometidas = graduadas + anunciadas;
      const vendibles = cantidad - comprometidas;
      // Sin una copia LIBRE de sobra no hay nada que vender por aquí.
      if (vendibles <= 1) return null;
      /* La curva se aplica sobre el montón ENTERO (ver el bloque de arriba):
       * las graduadas siguen siendo copias en propiedad y ocupan su sitio en la
       * curva. Lo único que hacen es no poder venderse por esta vía. */
      const eur = await euroDeCarta(cardId);
      const price = valorDeVenta(info[0].rarity, cantidad, 1, eur);
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
            -- El guard de verdad de las graduadas, sobre la fila ya bloqueada:
            -- vender no puede dejar quantity por debajo de lo que hay graduado.
            -- Y tampoco por debajo de las copias anunciadas en el bazar: la
            -- copia de un anuncio abierto no se vende por otra via.
            AND quantity - 1 >= (
              SELECT count(*) FROM graded_cards
              WHERE user_id = ${userId} AND card_id = ${cardId} AND estado = 'activa'
            ) + (
              SELECT count(*) FROM bazar_listings
              WHERE seller_id = ${userId} AND card_id = ${cardId}
                AND estado = 'activa' AND graded_id IS NULL
            ) + 1
          RETURNING 1
        )
        /* COALESCE, como el vaciado, el bono, el mercado y la graduada. Con
         * users.coins a NULL (que el esquema admite: es "sin saldo inicial"),
         * NULL + importe es NULL: la copia se descontaba y el saldo seguia
         * NULL. Carta perdida sin cobrar, y la respuesta decia que se habia
         * cobrado. */
        UPDATE users SET coins = COALESCE(coins, 0) + ${price}
        WHERE id = ${userId} AND EXISTS (SELECT 1 FROM venta)
        RETURNING coins
      `;
      if (rows.length === 0) return null;

      /* Y SE DEVUELVEN LOS IMPORTES DEL MONTÓN QUE QUEDA.
       *
       * Sin esto, el arreglo de arriba traía un fallo nuevo: la colección pinta
       * ahora números del servidor, y tras esta venta la pantalla se queda con
       * el montón viejo en la mano. Vender de una en una enseñaría en el segundo
       * toque el precio del primero —y la curva SUBE al menguar el montón, así
       * que volvería a prometer de menos—. Con esto la pantalla parchea la carta
       * y el número sigue siendo el del servidor, no una cuenta suya.
       *
       * No cuesta ni una consulta: la rareza, el recuento de graduadas y el euro
       * ya están leídos aquí arriba. Y es lo mismo que hace la pantalla de
       * graduación, que tras cada venta RE-ADOPTA el `valorDeVentaAhora` de la
       * vitrina en vez de recalcularlo (components/graduacion/Graduacion.tsx):
       * el número lo pone siempre quien cobra.
       *
       * Las otras dos rutas de venta NO lo necesitan: las dos dejan el montón en
       * "una copia libre más las graduadas", o sea sin nada que vender, y ahí los
       * dos importes son 0 por definición. */
      return {
        earned: price,
        coins: Number(rows[0]?.coins ?? 0),
        ...valoresDeVentaDelMonton(info[0].rarity, cantidad - 1, comprometidas, eur),
      };
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
   * (Se llama desde arriba, en `cartasDelSet`: las declaraciones de función se
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

      /* SE COMPARA CONTRA EL CATÁLOGO, CARTA A CARTA, y no contra cero ni
       * contra un recuento.
       *
       * Antes bastaba `count > 0` para darlo por sembrado, y eso convertía
       * cualquier siembra interrumpida en permanente: si la escritura se corta
       * a mitad (esto corre DENTRO de la compra de un sobre, con su límite de
       * tiempo), el set se queda con un catálogo parcial —y sesgado, porque
       * loadLocalCards devuelve ordenado por número— contra el que se
       * sortearían todos los sobres siguientes.
       *
       * Ahora se leen los ids que ya están y se escriben SÓLO los que faltan:
       * la siembra es reanudable y, sobre todo, una compra nunca reescribe una
       * carta que ya existía (la pudo traer el cron con datos más completos que
       * los del JSON local).
       */
      const { rows: yaEstan } = await sql`SELECT id FROM cards WHERE set_id = ${setId}`;
      const enBase = new Set(yaEstan.map((r) => String(r.id)));
      const faltan = cards.filter((card) => card?.id && !enBase.has(String(card.id)));
      if (faltan.length === 0) return { status: 'already_synced' };

      /* POR EL MISMO ESCRITOR QUE EL CRON Y QUE /seed-database (`upsertCards`).
       *
       * EL AGUJERO QUE CIERRA: aquí vivía un tercer INSERT propio que escribía
       * 9 de las 28 columnas de `cards`, con sus propios rellenos ('???',
       * 'Artista Desconocido') y de una en una: ~250 sentencias dentro de una
       * compra. En un despliegue donde alguien comprase un sobre antes de
       * ejecutar /seed-database, la expansión se quedaba con `supertype`,
       * `subtypes` y `evolves_from` en NULL —la siembra posterior la salta
       * porque el recuento ya cuadra— y los filtros del mercado por supertipo,
       * etapa y evolución no casaban con ninguna de sus cartas.
       *
       * `upsertCards` escribe las 28 columnas en lotes de 100 (tres sentencias
       * para una expansión) y es el mismo código que ya está probado contra la
       * tabla. El `set` se inyecta porque `valoresCarta` lo lee de `c.set.id` y
       * el nombre del fichero es la fuente de la verdad del set, igual que hace
       * la ruta de siembra.
       *
       * Y SE ESCRIBE LA CARTA CRUDA DEL JSON, no la que devuelve
       * `loadLocalCards`. Aquélla es la forma que pintan las pantallas: no trae
       * abilities, rules, resistances, legalities ni regulationMark, y esas
       * columnas se quedaban en NULL —/seed-database salta luego la expansión
       * porque el recuento ya cuadra—. Con la cruda, comprar un sobre antes de
       * sembrar deja la expansión igual que si se hubiera sembrado. Si la
       * lectura cruda fallara, se cae a la de siempre: menos columnas, mismas
       * cartas.
       */
      let crudas = new Map<string, Record<string, unknown>>();
      try {
        crudas = new Map((await loadLocalCardsCrudas(setId)).map((c) => [String(c.id), c]));
      } catch (e) {
        console.error("syncSetToDatabase: sin JSON crudo, se siembra con la forma recortada:", e);
      }
      await upsertCards(
        faltan.map((card) => ({ ...(crudas.get(String(card.id)) ?? card), set: { id: setId } })),
      );
      // El recuento de cartas de esta expansión acaba de cambiar: que la lista
      // memorizada de `getSetsFromDB` no enseñe el viejo durante un minuto.
      setsEnMemoria = null;

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
    if (!esIdPlausible(cardId)) {
      return { success: false, error: "No tienes la carta" };
    }

    try {
      // Mismo motivo que en sellCardAction: el guard lee las dos tablas.
      await ensureSchema();
      const { rows: info } = await sql`
        SELECT uc.quantity, c.rarity
        FROM user_collection uc JOIN cards c ON c.id = uc.card_id
        WHERE uc.user_id = ${userId} AND uc.card_id = ${cardId}
      `;
      if (info.length === 0) return { success: false, error: "No tienes la carta" };

      // Las graduadas no cuentan como duplicados vendibles: están en la vitrina.
      // Las anunciadas en el bazar tampoco: están apalabradas con su comprador.
      const { graduadas, anunciadas } = await copiasComprometidas(userId, cardId);
      const vendibles = Number(info[0].quantity) - graduadas - anunciadas;
      const duplicates = vendibles - 1;
      if (duplicates <= 0) {
        return {
          success: false,
          error:
            anunciadas > 0
              ? "Las copias que te sobran están anunciadas en el bazar: retira el anuncio para venderlas aquí"
              : graduadas > 0
                ? "Sólo te quedan copias graduadas"
                : "No tienes duplicados",
        };
      }

      /* No es duplicados × precio: cada copia vale menos que la anterior. Y la
       * curva va sobre el montón ENTERO —"cantidad", no "vendibles"— porque las
       * graduadas siguen ocupando su sitio en él; lo que se acota es CUÁNTAS se
       * venden, que son sólo las libres. */
      const totalEarned = valorDeVenta(
        info[0].rarity,
        Number(info[0].quantity),
        duplicates,
        await euroDeCarta(cardId),
      );

      // Descuento y abono en una sola sentencia (CTE): la venta se condiciona a
      // la cantidad leída (si otra pestaña vendió entretanto, no toca fila) y el
      // abono sólo ocurre si la venta tocó una fila. Así no se paga dos veces ni
      // se pierde la carta si el proceso muere entre ambas escrituras.
      const { rows } = await sql`
        WITH venta AS (
          /* Se deja UNA copia libre más todas las graduadas, no una a secas:
           * bajar a 1 con dos graduadas dejaría dos filas de graded_cards
           * apuntando a copias que ya no existen.
           *
           * LAS DOS CONDICIONES DE ABAJO NO SON ADORNO:
           *
           *  - "quantity > 1 + graduadas" impide que este UPDATE SUBA quantity.
           *    Sin ella, con 3 copias y 3 graduadas la subconsulta daba 4 y la
           *    sentencia CREABA una copia de la nada mientras cobraba por
           *    venderla. El guard de cantidad no lo detectaba porque graduar no
           *    toca user_collection.
           *
           *  - la igualdad del recuento con el que trae JavaScript (la ultima
           *    condicion) ata el recuento al que se usó para calcular el
           *    importe unas líneas más arriba. Si cambió entretanto —otra
           *    pestaña graduando—, no se vende nada, igual que cuando cambia la
           *    cantidad. Cobrar el importe de un montón que ya no existe es
           *    pagar de más.
           *
           * OJO: ESTE COMENTARIO VIVE DENTRO DE LA PLANTILLA sql, y ahi dentro
           * un dolar-llave ES UN PARAMETRO aunque este en un comentario. Aqui
           * hubo uno citando esa condicion: Postgres no ve los comentarios, se
           * encontraba con un parametro que nadie usaba y rechazaba la
           * sentencia ENTERA con 42P18 ("could not determine data type of
           * parameter"). Este boton no vendio nada desde que se escribio.
           *
           * LAS ANUNCIADAS EN EL BAZAR VAN EN LOS TRES SITIOS, por lo mismo que
           * las graduadas: se quedan (1 + graduadas + anunciadas), no se vende
           * si no sobra nada por encima de eso, y el recuento tiene que ser el
           * que se usó para el importe. Sin esto, este botón vendía la copia
           * anunciada y dejaba el anuncio abierto sin nada detrás. */
          UPDATE user_collection SET quantity = 1 + (
            SELECT count(*) FROM graded_cards
            WHERE user_id = ${userId} AND card_id = ${cardId} AND estado = 'activa'
          ) + (
            SELECT count(*) FROM bazar_listings
            WHERE seller_id = ${userId} AND card_id = ${cardId}
              AND estado = 'activa' AND graded_id IS NULL
          )
          WHERE user_id = ${userId} AND card_id = ${cardId}
            AND quantity = ${info[0].quantity}
            AND quantity > 1 + (
              SELECT count(*) FROM graded_cards
              WHERE user_id = ${userId} AND card_id = ${cardId} AND estado = 'activa'
            ) + (
              SELECT count(*) FROM bazar_listings
              WHERE seller_id = ${userId} AND card_id = ${cardId}
                AND estado = 'activa' AND graded_id IS NULL
            )
            AND (
              SELECT count(*) FROM graded_cards
              WHERE user_id = ${userId} AND card_id = ${cardId} AND estado = 'activa'
            ) = ${graduadas}
            AND (
              SELECT count(*) FROM bazar_listings
              WHERE seller_id = ${userId} AND card_id = ${cardId}
                AND estado = 'activa' AND graded_id IS NULL
            ) = ${anunciadas}
          RETURNING 1
        )
        -- COALESCE: con el saldo a NULL, NULL + importe es NULL y las copias
        -- se iban sin cobrar. Ver sellCardAction.
        UPDATE users SET coins = COALESCE(coins, 0) + ${totalEarned}
        WHERE id = ${userId} AND EXISTS (SELECT 1 FROM venta)
        RETURNING coins
      `;
      if (rows.length === 0) return { success: false, error: "La carta cambió, inténtalo de nuevo" };

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
    // Tope de frecuencia (services/limite.ts): este botón recorre la colección
    // entera, y nadie lo pulsa ocho veces en diez segundos.
    if (!dentroDelLimite("vaciado:" + userId, LIMITES.ventaEnLote)) {
      return {
        success: false as const,
        error: "Demasiadas ventas seguidas. Espera unos segundos.",
      };
    }

    try {
      // Sólo lo que sobra y no está protegido. El ORDER BY es para que la
      // lista (y por tanto el `ids` que se devuelve) salga siempre igual, no
      // para ordenar candados: dos vaciados simultáneos del mismo usuario los
      // impide el cerrojo del cliente, y si aun así se cruzaran, el guard de
      // cantidad deja al segundo sin vender nada en vez de cobrar dos veces.
      /* LAS GRADUADAS SALEN EN EL MISMO SELECT, con un LEFT JOIN agregado y no
       * con una subconsulta por fila: este vaciado recorre la colección entera
       * —cientos de cartas— y una subconsulta correlacionada por cada una sería
       * un escaneo por carta. El índice idx_graded_cards_user_card es justo
       * para esto.
       *
       * El filtro pasa de "quantity > 1" a "quantity > 1 + graduadas": una
       * carta con 3 copias y 2 graduadas tiene UNA copia libre, o sea ningún
       * duplicado que vender, y no debe ni aparecer en la lista.
       *
       * Y LAS ANUNCIADAS EN EL BAZAR, con otro LEFT JOIN agregado igual: este
       * botón era el camino más corto al anuncio zombi —con 2 copias y una
       * anunciada dejaba quantity en 1 y el anuncio abierto sin nada detrás—.
       * Ver `copiasComprometidas`. */
      await ensureSchema();
      const { rows } = await sql`
        SELECT uc.card_id, uc.quantity, c.rarity,
               COALESCE(g.n, 0)::int AS graduadas,
               COALESCE(a.n, 0)::int AS anunciadas
        FROM user_collection uc
        JOIN cards c ON c.id = uc.card_id
        LEFT JOIN (
          SELECT card_id, count(*)::int AS n
          FROM graded_cards
          WHERE user_id = ${userId} AND estado = 'activa'
          GROUP BY card_id
        ) g ON g.card_id = uc.card_id
        LEFT JOIN (
          SELECT card_id, count(*)::int AS n
          FROM bazar_listings
          WHERE seller_id = ${userId} AND estado = 'activa' AND graded_id IS NULL
          GROUP BY card_id
        ) a ON a.card_id = uc.card_id
        WHERE uc.user_id = ${userId}
          AND uc.quantity > 1 + COALESCE(g.n, 0) + COALESCE(a.n, 0)
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

      /* Los precios reales en UNA sola consulta para toda la colección, no una
       * por carta: este botón puede tocar cientos de cartas y euroDeCarta en
       * bucle serían cientos de idas y vueltas. preciosEnEuros ya trocea y
       * cachea, y devuelve un mapa vacío si la tabla no existe. */
      const euros = await preciosEnEuros(rows.map((r: any) => String(r.card_id)));

      const ids: string[] = [];
      const cantidades: number[] = [];
      const valores: number[] = [];
      const graduadasPorId: number[] = [];
      const anunciadasPorId: number[] = [];
      for (const row of rows) {
        const cantidad = Number(row.quantity);
        const graduadas = Number(row.graduadas ?? 0);
        const anunciadas = Number(row.anunciadas ?? 0);
        /* Curva sobre el montón ENTERO y número de copias acotado a las libres.
         * Pasar "cantidad - graduadas" como montón reiniciaba la curva y hacía
         * que graduar parte del montón fuese la forma de cobrar tarifa de
         * primera copia por copias profundas: medido, +785 monedas con 300
         * copias de una Hyper Rare. */
        const valor = valorDeVenta(
          row.rarity,
          cantidad,
          cantidad - 1 - graduadas - anunciadas,
          euros.get(String(row.card_id)),
        );
        if (valor <= 0) continue;
        ids.push(row.card_id);
        cantidades.push(cantidad);
        valores.push(valor);
        graduadasPorId.push(graduadas);
        anunciadasPorId.push(anunciadas);
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
           SELECT * FROM unnest($2::text[], $3::int[], $4::int[], $5::int[], $6::int[])
             AS t(card_id, cantidad, valor, graduadas, anunciadas)
         ),
         /* EL RECUENTO DE GRADUADAS SE HACE AQUÍ DENTRO, no fuera.
          *
          * Antes viajaba por unnest desde el SELECT de arriba, y eso era una
          * ventana de carrera que el guard de cantidad NO puede tapar: graduar
          * no escribe en user_collection, así que uc.quantity no cambia al
          * graduar y "uc.quantity = e.cantidad" sigue cumpliéndose. Con una
          * pestaña graduando mientras otra vacía duplicados, este UPDATE
          * dejaba quantity por debajo del número de filas de graded_cards:
          * cartas graduadas fantasma, que la vitrina pinta y que al venderse
          * pagan por algo que ya no está.
          *
          * La ventana no era teórica: entre aquel SELECT y esta sentencia hay
          * un preciosEnEuros sobre la colección entera.
          *
          * LO QUE ESTO NO CIERRA, Y HAY QUE DECIRLO: el recuento de aqui dentro
          * sale de la INSTANTANEA de esta sentencia. Graduar bloquea la fila de
          * la coleccion pero no la modifica, asi que si este vaciado estaba
          * esperando ese candado, al despertar sigue adelante sin releer nada
          * (Postgres solo reevalua filas MODIFICADAS, y aun entonces relee la
          * fila, no las subconsultas): vende contando cero graduadas y deja mas
          * graduadas activas que copias. Lo mismo vale para la venta suelta,
          * vender todas y las repetidas del sobre. Medido contra PostgreSQL
          * real con carga mezclada: aparece en 13 de 101 pasadas.
          *
          * NO IMPRIME DINERO: la graduada fantasma no se puede vender ni
          * anunciar hasta que el jugador vuelva a tener otra copia (las dos
          * rutas exigen que sobre una). Cerrarlo de verdad pide que el numero
          * de copias comprometidas viva en la propia fila de user_collection,
          * que es la que Postgres relee: una columna nueva que escribirian
          * graduar, publicar, retirar, comprar y vender graduada. Es una
          * migracion con relleno y es decision del dueno; ver el bloque de
          * carreras conocidas, mas abajo. */
         graduadasAhora AS (
           SELECT card_id, count(*)::int AS n
           FROM graded_cards
           WHERE user_id = $1 AND estado = 'activa' AND card_id = ANY($2::text[])
           GROUP BY card_id
         ),
         /* Y EL DE LAS ANUNCIADAS EN EL BAZAR, aqui dentro por el mismo motivo:
          * publicar tampoco escribe en user_collection, asi que el guard de
          * cantidad no ve un anuncio que se haya abierto entre el SELECT de
          * arriba y esta sentencia. Solo los anuncios SUELTOS: la copia de un
          * anuncio de graduada ya va contada en graduadasAhora. */
         anunciadasAhora AS (
           SELECT card_id, count(*)::int AS n
           FROM bazar_listings
           WHERE seller_id = $1 AND estado = 'activa' AND graded_id IS NULL
             AND card_id = ANY($2::text[])
           GROUP BY card_id
         ),
         /* LAS FILAS QUE SE VAN A VENDER, BLOQUEADAS EN EL ORDEN GLOBAL.
          *
          * El UPDATE de abajo tocaba sus filas en el orden que le diera el plan
          * (el del join con esperado), y todas las demas sentencias que cogen
          * varias filas de user_collection lo hacen por (user_id, card_id): la
          * compra de un sobre, el trueque, el mercado, la graduacion. Un sobre
          * comprado en otra pestana mientras se vaciaban duplicados, o dos
          * vaciados a la vez, se abrazaban. Con este CTE delante las filas se
          * piden ordenadas y el que llega segundo espera sin tener ninguna.
          *
          * No cambia lo que hace la venta: son las MISMAS filas, y el guard de
          * cantidad sigue evaluandose sobre la version confirmada. El count del
          * WHERE de venta es lo que obliga a que esto se ejecute antes. */
         bloqueo AS MATERIALIZED (
           SELECT uc.card_id
           FROM user_collection uc
           WHERE uc.user_id = $1 AND uc.card_id = ANY($2::text[])
           ORDER BY uc.user_id, uc.card_id
           FOR UPDATE OF uc
         ),
         venta AS (
           UPDATE user_collection uc
           -- Se deja UNA copia libre MÁS las graduadas y las anunciadas, que no
           -- se venden aquí.
           SET quantity = 1 + COALESCE(g.n, 0) + COALESCE(a.n, 0)
           FROM esperado e
           LEFT JOIN graduadasAhora g ON g.card_id = e.card_id
           LEFT JOIN anunciadasAhora a ON a.card_id = e.card_id
           WHERE uc.user_id = $1
             AND uc.card_id = e.card_id
             AND (SELECT count(*) FROM bloqueo) >= 0
             AND uc.quantity = e.cantidad
             AND uc.quantity > 1 + COALESCE(g.n, 0) + COALESCE(a.n, 0)
             /* Y EL RECUENTO TIENE QUE SER EL MISMO con el que se calculó el
              * precio. Si cambió, esta carta no se vende y ya está: pagarle el
              * importe de otra cantidad de copias sería pagar de más o de
              * menos. Es el mismo criterio que el guard de cantidad. */
             AND COALESCE(g.n, 0) = e.graduadas
             AND COALESCE(a.n, 0) = e.anunciadas
             AND COALESCE(uc.is_favorite, false) = false
             -- Sin fila en users el abono no tocaría nada y las cartas
             -- desaparecerían gratis.
             AND EXISTS (SELECT 1 FROM users WHERE id = $1)
           RETURNING e.card_id AS card_id, e.valor AS valor,
                     e.cantidad - 1 - COALESCE(g.n, 0) - COALESCE(a.n, 0) AS copias
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
        [userId, ids, cantidades, valores, graduadasPorId, anunciadasPorId],
      );
      if (resultado.length === 0) return { success: false as const, error: "Error en servidor" };

      const vendidas = Number(resultado[0].copias ?? 0);
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

  /* ==================================================================== *
   * EL CATÁLOGO DE EXPANSIONES, MEMORIZADO POR INSTANCIA
   * ====================================================================
   *
   * EL AGUJERO QUE CIERRA: `getSetsFromDB` agrupa `sets LEFT JOIN cards` —toda
   * la tabla de cartas, decenas de miles de filas con 171 expansiones— y lo
   * hacía en CADA llamada. La piden al montar la portada, la colección, cada
   * álbum, el perfil de un entrenador y la vitrina, así que abrir un sobre,
   * mirar el álbum y volver a la tienda eran tres agregados completos para un
   * dato que sólo cambia cuando pasa el cron de las 05:00. Y no exige sesión:
   * cualquiera podía pedirlo en bucle.
   *
   * Se guardan las filas CRUDAS, antes de la capa de idioma (que depende de la
   * petición), con el mismo patrón que `catalogoDeSet`: un valor con caducidad
   * en la memoria de la instancia. Es más simple que `unstable_cache` y no
   * depende de `revalidateTag`.
   *
   * UN MINUTO, y no los diez del catálogo de un set: aquí el dato que envejece
   * es `cards_count`, que sube mientras una expansión se está sembrando o
   * ingiriendo, y es el denominador del progreso que ve el jugador. Con un
   * minuto el ahorro es el mismo —de un agregado por visita a uno por minuto e
   * instancia— y lo viejo no dura. La siembra bajo demanda lo vacía además.
   *
   * `setsEnVuelo` evita la estampida: si llegan diez peticiones con la memoria
   * caducada, lanzan UNA consulta y esperan las diez a la misma promesa.
   *
   * DE AQUÍ NO SALE DINERO, y por eso `claimSetCompletionBonuses` NO lo usa:
   * el bono de expansión cuenta las cartas en el momento de pagar, no las de
   * hace un minuto.
   */
  const SETS_TTL_MS = 60 * 1000;
  type FilaDeSet = Record<string, unknown>;
  let setsEnMemoria: { filas: FilaDeSet[]; expira: number } | null = null;
  let setsEnVuelo: Promise<FilaDeSet[]> | null = null;

  /** Las filas de expansiones ya montadas (sin idioma). Vacío = tabla sin sembrar. */
  function filasDeSets(): Promise<FilaDeSet[]> {
    if (setsEnMemoria && setsEnMemoria.expira > Date.now()) {
      return Promise.resolve(setsEnMemoria.filas);
    }
    if (!setsEnVuelo) {
      setsEnVuelo = leerFilasDeSets().finally(() => {
        setsEnVuelo = null;
      });
    }
    return setsEnVuelo;
  }

  async function leerFilasDeSets(): Promise<FilaDeSet[]> {
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

      // Si la tabla está vacía todavía no se ha ejecutado el seed: no se
      // memoriza nada, y quien llama cae al catálogo del repositorio.
      if (rows.length === 0) return [];

      /* CUÁNTAS FOTOS DE SOBRE TIENE CADA EXPANSIÓN EN POSTGRES.
       *
       * VA EN UNA CONSULTA APARTE Y NO EN UN JOIN DE LA DE ARRIBA, y esto no es
       * gusto: si `set_pack_art` no existe todavía —la migración /migrate-sobres
       * se ejecuta a mano— un LEFT JOIN contra ella haría lanzar la consulta
       * ENTERA, el catch de aquí abajo se lo tragaría y devolvería
       * `loadLocalSets()`, que sólo conoce las expansiones con fichero de cartas
       * en el repositorio: 38 de 171. O sea que una tabla que falta convertiría
       * la tienda en una octava parte de sí misma, en silencio y sin que nadie
       * relacionase una cosa con la otra.
       *
       * `variantesDeSobre` no lanza nunca y devuelve un mapa vacío ante
       * cualquier fallo, que es el mismo contrato de services/preciosBD.ts y de
       * services/idiomaBD.ts. Con el mapa vacío, `variantesSobre` queda
       * `undefined` en todas y el sobre se pinta como se ha pintado siempre. */
      const variantesSobre = await variantesDeSobre();

      const filas = rows.map(set => ({
        ...set,
        releaseDate: set.release_date,
        cardsCount: Number(set.cards_count) || 0,
        // El id va CRUDO, que es la clave de la tabla y la que compone la URL.
        variantesSobre: variantesSobre.get(String(set.id)),
        images: typeof set.images === 'string' ? JSON.parse(set.images) : set.images
      }));
      setsEnMemoria = { filas, expira: Date.now() + SETS_TTL_MS };
      return filas;
  }

  export async function getSetsFromDB() {
    try {
      const filas = await filasDeSets();
      // Si la tabla está vacía todavía no se ha ejecutado el seed.
      if (filas.length === 0) return setsEnIdioma(await loadLocalSets());
      // COPIAS, no las filas memorizadas: lo que sale de aquí lo retoca la capa
      // de idioma y lo serializa Next, y la memoria la comparten todas las
      // peticiones de la instancia.
      return setsEnIdioma(filas.map((fila) => ({ ...fila })));
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
    const capa = await capaEs(idioma);
    /* `tieneEs` marca las expansiones SIN diccionario, que se ven en inglés.
     *
     * Hace falta porque el cron trae expansiones a `sets` mucho antes de que
     * exista su diccionario, y la lista va por fecha descendente: salen LAS
     * PRIMERAS. Sin este aviso el idioma parece roto cuando no lo está —pasó, y
     * costó una tarde de diagnóstico—.
     *
     * SÓLO SE AÑADE EN ESPAÑOL, a propósito: así `tieneEs === false` significa
     * una única cosa y la pantalla no tiene que consultar además el idioma. Es
     * un `Set.has` sobre el índice estático, no toca Postgres.
     */
    return capa.traducirSets(sets).map((s: any) => ({
      ...s,
      tieneEs: capa.tieneEspanol(s.id),
    }));
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

    /* UN BLOQUEO CIERRA EL ÁLBUM, EN LOS DOS SENTIDOS.
     *
     * Bloquear a alguien le sacaba de la búsqueda, cortaba la amistad y
     * cancelaba sus ofertas, pero quien conservara el enlace /trainer/<id>
     * —un ex amigo lo tiene— seguía abriendo el álbum entero, con cantidades
     * y favoritas. Esta acción sólo pedía sesión y un id.
     *
     * Se contesta con la lista vacía, igual que a un id que no existe: no se
     * le dice al bloqueado por qué. Los tres estados son los que
     * services/esquemaSocial.ts documenta como bloqueo.
     *
     * Va en su propio try y, si la consulta falla (una base sin
     * `friendships`), el álbum se sirve como hasta ahora: un fallo de esta
     * comprobación no puede dejar a todo el mundo sin ver ningún álbum. */
    if (trainerId !== userId) {
      try {
        const { rows: bloqueo } = await sql`
          SELECT 1
          FROM friendships
          WHERE status IN ('blocked', 'blocked_both', 'blocked_declined')
            AND ((user_id = ${userId} AND friend_id = ${trainerId})
              OR (user_id = ${trainerId} AND friend_id = ${userId}))
          LIMIT 1
        `;
        if (bloqueo.length > 0) return [];
      } catch (error) {
        console.error("getTrainerCollection: no se pudo comprobar el bloqueo:", error);
      }
    }

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
      const capa = await capaEs(idioma);
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
            name: capa.nombreSet(row.set_id) ?? row.set_name,
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
      //
      // Y SÓLO ESCRIBE SI CAMBIA ALGO (el WHERE del DO UPDATE). La pantalla de
      // amigos llama a esto en cada visita, y sin él cada visita era una versión
      // nueva de la fila de `users` —la más caliente de la aplicación— para
      // volver a guardar el mismo nombre. Con el WHERE, cuando el nombre es el
      // mismo y el saldo existe no se reescribe nada.
      await sql`
        INSERT INTO users (id, username, coins)
        VALUES (${user.id}, ${displayName}, ${STARTING_COINS})
        ON CONFLICT (id)
        DO UPDATE SET username = ${displayName},
                      coins = COALESCE(users.coins, ${STARTING_COINS})
        WHERE users.username IS DISTINCT FROM EXCLUDED.username
           OR users.coins IS NULL
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
  // `removeFriend` duplicaban lo que ya hacía app/social.ts, que es lo que usa
  // app/friends/page.tsx (hoy `enviarPeticion`, `getSocialOverview`,
  // `aceptarPeticion` y `eliminarAmigo`). Ninguna de las cuatro tenía un solo
  // consumidor.
  //
  // No era código muerto inocuo: toda función exportada de un fichero
  // 'use server' es un endpoint POST vivo, así que eran cuatro endpoints
  // mantenidos por nadie —y ya habían divergido, porque `sendFriendRequest`
  // comprobaba que el destinatario existiera y su gemela de social no—. Cada
  // arreglo había que hacerlo dos veces o quedaba a medias.
  //
  // `syncUserName` se queda: la llaman app/friends/page.tsx y, una vez por
  // usuario sin nombre, `getUserData`. No está duplicada.

// --- DAILY REWARD ---
export async function claimDailyReward() {
  const { userId } = await auth();
  if (!userId) return { error: "No autorizado" };
  try {
    await ensureSchema();

    // EL TIEMPO TRANSCURRIDO LO CALCULA POSTGRES, no `new Date(last)`.
    // `last_daily_claim` es un TIMESTAMP sin zona: el driver lo convierte a
    // Date suponiendo la zona del proceso de Node, y si no es la de la sesión
    // de Postgres el instante sale desplazado (con Postgres en Europe/Paris y
    // Node en UTC, a 19 h de la reclamación esto decía «lista en ~3h»). El
    // `NOW() - last_daily_claim` de aquí usa la misma zona que el `NOW()` que
    // la escribió y que el WHERE del UPDATE de más abajo: los tres coinciden.
    const { rows } = await sql`
      SELECT streak,
             EXTRACT(EPOCH FROM (NOW() - last_daily_claim))::float8 AS segundos
      FROM users WHERE id = ${userId}
    `;
    if (rows.length === 0) return { error: "Usuario no existe" };

    const streak: number = rows[0].streak || 0;
    // Horas desde la última reclamación; null si no ha reclamado nunca.
    const hours: number | null =
      rows[0].segundos === null || rows[0].segundos === undefined
        ? null
        : Number(rows[0].segundos) / 3600;

    if (hours !== null && hours < DAILY_ESPERA_H) {
      const remaining = Math.ceil(DAILY_ESPERA_H - hours);
      return { error: `Recompensa lista en ~${remaining}h` };
    }

    const wasYesterday = hours !== null && hours < DAILY_PLAZO_RACHA_H;
    const newStreak = wasYesterday ? streak + 1 : 1;
    const baseReward = DAILY_BASE;
    const bonus = Math.min(newStreak * DAILY_STREAK_STEP, DAILY_STREAK_CAP);
    const totalReward = baseReward + bonus;

    // La condición de las 20h se repite AQUÍ, dentro del propio UPDATE.
    // Comprobarla sólo en JavaScript dejaba una ventana entre el SELECT y el
    // UPDATE: con dos pestañas, ambas leían la misma fecha antigua, ambas
    // pasaban el `if` y ambas cobraban. Al ponerla en el WHERE, la segunda no
    // afecta a ninguna fila y se rechaza. El '20 hours' es DAILY_ESPERA_H
    // escrito a mano: va como literal porque es parte del SQL.
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
    // Los segundos transcurridos salen de Postgres, igual que en
    // `claimDailyReward` y por lo mismo: convertir el TIMESTAMP sin zona a
    // Date en Node desplazaba `nextAt` tantas horas como separen la zona del
    // proceso de la de la sesión, y `nextAt` es una hora que la pantalla enseña.
    const { rows } = await sql`
      SELECT streak,
             EXTRACT(EPOCH FROM (NOW() - last_daily_claim))::float8 AS segundos
      FROM users WHERE id = ${userId}
    `;
    if (rows.length === 0) return { available: true, streak: 0 };
    const streak = rows[0].streak || 0;
    if (rows[0].segundos === null || rows[0].segundos === undefined) return { available: true, streak };
    const segundos = Number(rows[0].segundos);
    if (!Number.isFinite(segundos)) return { available: false };
    const hours = segundos / 3600;
    return {
      available: hours >= DAILY_ESPERA_H,
      streak,
      hoursLeft: Math.max(0, Math.ceil(DAILY_ESPERA_H - hours)),
      // EL INSTANTE, además de las horas redondeadas. Con sólo `hoursLeft` la
      // hoja de la recompensa decía «en unas 7 h» y no podía dar ni la hora a
      // la que vuelve ni cuándo se pierde la racha: una cota con una hora de
      // holgura, puesta como plazo, haría perderla a quien se fiara. Es un
      // dato de sólo lectura que sale de la misma cuenta que el `available` de
      // arriba; no decide nada (eso lo hace el WHERE de claimDailyReward).
      // «Ahora + lo que falta», con el reloj de Node sólo para el «ahora»: lo
      // que falta es una duración y no depende de ninguna zona horaria.
      nextAt: Math.round(Date.now() + (DAILY_ESPERA_H * 3600 - segundos) * 1000),
    };
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
      // Propiedad propia y número: una rareza que se llame como un método de
      // Object no puede colarse en la comparación.
      const rango = RARITY_RANK[String(row.rarity ?? "")];
      if (typeof rango === "number" && rango >= 70) rareHits += 1; // Illustration Rare+
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
    const capa = await capaEs(idioma);
    let setObj: any = { id: row.set_id };
    const { rows: setRows } = await sql`SELECT * FROM sets WHERE id = ${row.set_id} LIMIT 1`;
    if (setRows.length > 0) {
      const s: any = setRows[0];
      setObj = capa.traducirSet({
        id: s.id, name: s.name, series: s.series,
        printedTotal: s.printed_total, total: s.total,
        ptcgoCode: s.ptcgo_code, releaseDate: s.release_date,
        legalities: parse(s.legalities, {}),
        images: parse(s.images, {}),
      });
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
      const capa = await capaEs(idioma);
      setRows.forEach((s: any) => {
        setMap[s.id] = { ...s, name: capa.nombreSet(s.id) ?? s.name };
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
    /* SE RELANZA, Y ES LA DIFERENCIA ENTRE "NO HAY" Y "NO SÉ".
     *
     * Antes este catch devolvía `{ data: [], total: 0 }`: la misma respuesta
     * exacta que una búsqueda sin coincidencias. GlobalSearch no tenía forma de
     * distinguirlas y pintaba "Sin resultados" con la base de datos caída, sin
     * conexión o —como se midió en desarrollo— sin `POSTGRES_URL` en el
     * entorno: ahí `sql.query` lanza `missing_connection_string` antes de
     * consultar nada, y "pikachu" salía como si no existiera ninguna carta.
     * La consulta en sí es correcta (LOWER(name) LIKE '%pikachu%'); lo que
     * mentía era esta rama.
     *
     * Rechazando, el `catch` de GlobalSearch enciende su estado de error
     * ("No se pudo buscar"), que es lo que ya hace con un fallo de transporte.
     * Next no filtra al navegador el mensaje de un error lanzado en una server
     * action en producción (llega un texto genérico con su digest), así que
     * el detalle se queda en el log del servidor, que es donde sirve. */
    throw new Error("busqueda-fallida");
  }
}

// --- SET COMPLETION BONUS ---
// Grants one-time coin reward when user completes a full set.
/* RIESGO CONOCIDO Y ACEPTADO (decisión del dueño, no un descuido): el bono
 * sólo comprueba que el jugador TIENE todas las cartas de la expansión, no de
 * dónde vienen. Como el trueque mueve cartas entre amigos sin barrera, una
 * cuenta puede prestarle la expansión completa a otra, que cobra el bono y la
 * devuelve. Se deja así a sabiendas: cerrarlo pide marcar la procedencia de
 * cada copia (una columna en user_collection y tocar la compra, el trueque y el
 * bazar) y cambia quién cobra el bono, que es una decisión de economía.
 *
 * @param setId OPCIONAL. Con él, sólo se mira ESA expansión: es lo que pide la
 *   tienda después de abrir un sobre, que sólo puede completar la expansión que
 *   se acaba de abrir. Sin él (lo de siempre), todas las del jugador.
 */
export async function claimSetCompletionBonuses(setId?: string) {
  const { userId } = await auth();
  if (!userId) return { granted: 0, sets: [] };
  // Un argumento que no sea un id de expansión se ignora (se mira todo), por el
  // mismo motivo que en getFullCollection: esta acción se llamaba sin ninguno.
  const soloSet =
    typeof setId === "string" && /^[a-z0-9._-]{1,40}$/i.test(setId) ? setId : null;
  try {
    await ensureSchema();
    // Unique owned cards per set
    const { rows: owned } = await sql.query(
      `SELECT c.set_id, COUNT(*)::int AS owned
         FROM user_collection uc
         JOIN cards c ON uc.card_id = c.id
        WHERE uc.user_id = $1 AND uc.quantity > 0
          AND ($2::text IS NULL OR c.set_id = $2::text)
        GROUP BY c.set_id`,
      [userId, soloSet],
    );

    const { rows: already } = await sql`SELECT set_id FROM set_rewards WHERE user_id = ${userId}`;
    const rewarded = new Set(already.map((r: any) => r.set_id));

    const BONUS = SET_COMPLETION_BONUS;
    /* SÓLO SE CUENTAN LAS EXPANSIONES QUE PUEDEN COBRAR: aquéllas en las que el
     * jugador tiene alguna carta y cuyo bono no ha cobrado ya. Antes se
     * agrupaba `sets LEFT JOIN cards` ENTERO —171 expansiones y decenas de
     * miles de cartas— en cada llamada, y la tienda llama a esto después de
     * CADA sobre abierto, casi siempre para descubrir que no hay nada que
     * pagar. Si no queda ninguna candidata, ni se pregunta. */
    const candidatas = owned
      .map((r) => String(r.set_id))
      .filter((id) => !rewarded.has(id));
    if (candidatas.length === 0) return { granted: 0, sets: [], bonusPerSet: BONUS };

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
    const { rows: setsRows } = await sql.query(
      `SELECT s.id, s.total, s.name, COUNT(c.id)::int AS reales
         FROM sets s
         LEFT JOIN cards c ON c.set_id = s.id
        WHERE s.id = ANY($1::text[])
        GROUP BY s.id, s.total, s.name`,
      [candidatas],
    );
    const totals: Record<string, { total: number; reales: number; name: string }> = {};
    setsRows.forEach((s: any) => {
      totals[s.id] = { total: Number(s.total), reales: Number(s.reales), name: s.name };
    });

    // El aviso de "¡has completado X!" nombra la expansión: en español también.
    // La fila de set_rewards se sigue escribiendo con el id canónico.
    const idioma = await idiomaActual();
    const capa = await capaEs(idioma);
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
     *
     * La regla vive en `catalogoIncompleto`, junto a `cartasDelSet`: es la
     * misma con la que la tienda deja de vender sobres de una expansión a
     * medias, y tenía que ser UNA.
     */
    for (const row of owned) {
      const meta = totals[row.set_id];
      if (!meta || !meta.reales) continue;
      // Siembra a medias: ni se paga ni se quema la fila de set_rewards.
      if (catalogoIncompleto(meta.reales, meta.total)) continue;
      if (row.owned >= meta.reales && !rewarded.has(row.set_id)) {
        /* MARCA Y ABONO EN UNA SOLA SENTENCIA, Y ESTO ERA UNA FUGA.
         *
         * El INSERT ya arbitraba la carrera —la clave primaria (user_id,
         * set_id) sólo deja pasar a uno, así que dos pestañas completando el set
         * a la vez no cobran dos veces— pero el pago iba en OTRA sentencia, al
         * final del bucle. Entre una y otra no hay transacción: si la petición
         * moría ahí (timeout, deploy, corte de red), la fila del premio quedaba
         * escrita y las 1.000 monedas no se pagaban nunca. Y como esa fila es la
         * que impide cobrarlo dos veces, el bono se perdía PARA SIEMPRE — el
         * jugador no tenía forma de volver a completar la expansión.
         *
         * Ahora el INSERT es el árbitro y el UPDATE cuelga de él por EXISTS,
         * dentro de la misma sentencia: es el patrón que ya usan el `cobro` de
         * comprarSobreAction y la `marca` de cumplirOferta. O se queman las dos
         * filas o no se quema ninguna.
         *
         * El guard de `users` va DENTRO del INSERT por el mismo motivo que en
         * cumplirOferta: sin fila en users el UPDATE no tocaría nada y la marca
         * dejaría el premio quemado sin haberlo pagado.
         *
         * COALESCE en el abono porque `users.coins` admite NULL a propósito
         * (app/migrate-core lo documenta): `coins + 1000` sobre NULL da NULL, o
         * sea borrarle el saldo al jugador al pagarle el bono. */
        const { rows: pagado } = await sql`
          WITH premio AS (
            INSERT INTO set_rewards (user_id, set_id)
            SELECT ${userId}, ${row.set_id}
            WHERE EXISTS (SELECT 1 FROM users WHERE id = ${userId})
            ON CONFLICT DO NOTHING
            RETURNING 1
          )
          UPDATE users SET coins = COALESCE(coins, 0) + ${BONUS}
          WHERE id = ${userId} AND EXISTS (SELECT 1 FROM premio)
          RETURNING coins
        `;
        if (pagado.length > 0) {
          granted += BONUS;
          completedSets.push(capa.nombreSet(row.set_id) ?? meta.name);
        }
      }
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
/* LAS LECTURAS VAN FUERA DEL BUCLE.
 *
 * Antes, por CADA id distinto se hacían en serie tres lecturas (cantidad y
 * rareza, copias graduadas, precio real) y la sentencia de venta: con las ~60
 * repetidas distintas del resumen de un ×10 eran unos 240 viajes a Postgres
 * dentro de una sola acción, con el botón en "vendiendo" varios segundos. Y los
 * ids no se validaban: 200 cadenas inventadas eran 200 SELECT vacíos.
 *
 * Ahora son DOS lecturas para el lote entero —los montones con sus copias
 * comprometidas, y los precios— y una sentencia de venta por carta que de
 * verdad se vende. Esa sentencia se queda como estaba a propósito: descuento y
 * abono en un solo comando, atada a la cantidad leída. Lo que se ha movido es
 * lo que no decide nada.
 *
 * Devuelve además `coins`, el saldo tras la última venta, para que la pantalla
 * no tenga que sumar por su cuenta ni volver a preguntar. Sólo viene cuando se
 * ha vendido algo.
 */
export async function sellPackDuplicates(cardIds: string[]) {
  const { userId } = await auth();
  if (!userId || !Array.isArray(cardIds) || cardIds.length === 0) return { earned: 0, sold: 0 };
  // Tope de entrada: un ×10 trae como mucho ~100 cartas. Un array mayor sólo
  // puede ser abuso, y cada id son un par de consultas.
  if (cardIds.length > 200) return { earned: 0, sold: 0 };
  // Y cada elemento tiene que ser una cadena corta: lo que llega es un array de
  // un POST, no una lista que haya montado nuestra pantalla. Que el id sea de
  // una carta que se tiene lo decide la lectura de abajo (ver `esIdPlausible`).
  if (!cardIds.every(esIdPlausible)) {
    return { earned: 0, sold: 0 };
  }
  // Tope de frecuencia (services/limite.ts).
  if (!dentroDelLimite("repes:" + userId, LIMITES.ventaEnLote)) {
    return { earned: 0, sold: 0, limitado: true as const };
  }
  /* LO ACUMULADO VIVE FUERA DEL try. Cada carta es su propia sentencia, ya
   * confirmada cuando se pasa a la siguiente: si la tercera falla (un corte,
   * un interbloqueo), las dos primeras ESTÁN vendidas y abonadas. El catch
   * devolvía ceros, y la pantalla se quedaba con el saldo viejo y diciendo
   * "no había repetidas que vender" con 60 monedas más en la cuenta. */
  let earned = 0;
  let sold = 0;
  let coins: number | undefined;
  try {
    // El guard de la venta lee graded_cards y bazar_listings.
    await ensureSchema();

    // Contar cuántas veces aparece cada id en el sobre
    const counts = new Map<string, number>();
    for (const id of cardIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    const ids = Array.from(counts.keys());

    /* Los montones de TODAS las cartas pedidas en una consulta, con las copias
     * comprometidas ya contadas: las graduadas (en la vitrina) y las anunciadas
     * en el bazar. Es el mismo patrón de LEFT JOIN agregado que el vaciado en
     * lote, acotado a los ids recibidos. */
    const { rows: montones } = await sql.query(
      `SELECT uc.card_id, uc.quantity, c.rarity,
              COALESCE(g.n, 0)::int AS graduadas,
              COALESCE(a.n, 0)::int AS anunciadas
         FROM user_collection uc
         JOIN cards c ON uc.card_id = c.id
         LEFT JOIN (
           SELECT card_id, count(*)::int AS n FROM graded_cards
            WHERE user_id = $1 AND estado = 'activa' AND card_id = ANY($2::text[])
            GROUP BY card_id
         ) g ON g.card_id = uc.card_id
         LEFT JOIN (
           SELECT card_id, count(*)::int AS n FROM bazar_listings
            WHERE seller_id = $1 AND estado = 'activa' AND graded_id IS NULL
              AND card_id = ANY($2::text[])
            GROUP BY card_id
         ) a ON a.card_id = uc.card_id
        WHERE uc.user_id = $1 AND uc.card_id = ANY($2::text[]) AND uc.quantity > 0
        ORDER BY uc.card_id`,
      [userId, ids],
    );
    if (montones.length === 0) return { earned: 0, sold: 0 };

    // Los precios reales de todas, también de una vez (trocea y cachea solo).
    const euros = await preciosEnEuros(montones.map((m) => String(m.card_id)));

    for (const m of montones) {
      const cardId = String(m.card_id);
      const qtyToSell = counts.get(cardId) ?? 0;
      const have = Number(m.quantity);
      const rarity = m.rarity;
      // No bajar de 1 copia LIBRE: las graduadas están en la vitrina, las
      // anunciadas están apalabradas en el bazar, y ninguna de las dos entra en
      // el montón que vacía este botón.
      const comprometidas = Number(m.graduadas ?? 0) + Number(m.anunciadas ?? 0);
      const libres = have - comprometidas;
      const sellable = Math.min(qtyToSell, Math.max(0, libres - 1));
      if (sellable <= 0) continue;
      // Precio decreciente: se van las copias de índice más alto. Con una copia
      // repetida es la tarifa de siempre; con cincuenta, la del suelo.
      // Curva sobre el montón entero ("have"), y sólo el número de copias que
      // se venden sale de las libres. Ver el bloque de sellCardAction.
      const importe = valorDeVenta(rarity, have, sellable, euros.get(cardId));
      if (importe <= 0) continue;

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
            -- Guard de graduadas y de anunciadas sobre la fila ya bloqueada:
            -- lo que queda no puede bajar de las copias comprometidas mas una.
            AND quantity - ${sellable} >= (
              SELECT count(*) FROM graded_cards
              WHERE user_id = ${userId} AND card_id = ${cardId} AND estado = 'activa'
            ) + (
              SELECT count(*) FROM bazar_listings
              WHERE seller_id = ${userId} AND card_id = ${cardId}
                AND estado = 'activa' AND graded_id IS NULL
            ) + 1
          RETURNING 1
        )
        -- COALESCE: con el saldo a NULL, NULL + importe es NULL y la copia se
        -- iba sin cobrar. Ver sellCardAction.
        UPDATE users SET coins = COALESCE(coins, 0) + ${importe}
        WHERE id = ${userId} AND EXISTS (SELECT 1 FROM venta)
        RETURNING coins
      `;
      if (upd.rows.length === 0) continue; // otra pestaña se adelantó: no se cobra
      earned += importe;
      sold += sellable;
      coins = Number(upd.rows[0]?.coins ?? 0);
    }
    return coins === undefined ? { earned, sold } : { earned, sold, coins };
  } catch (e) {
    console.error("sellPackDuplicates error:", e);
    // Lo que ya se vendió, vendido está: se cuenta. `parcial` avisa de que el
    // lote no se recorrió entero, por si la pantalla quiere decirlo.
    return coins === undefined
      ? { earned, sold }
      : { earned, sold, coins, parcial: true as const };
  }
}

// --- WISHLIST ---
/** Tope de cartas deseadas por usuario. Ver `toggleWishlist`. */
const MAX_DESEADAS = 500;

/* MARCAR Y DESMARCAR UNA CARTA DESEADA.
 *
 * LOS TRES AGUJEROS QUE CIERRA:
 *
 *  1. `cardId` se insertaba TAL CUAL: ni pasaba por ID_CARTA ni se contrastaba
 *     con `cards`. La clave primaria admite claves de unos 2,7 KB, así que un
 *     usuario con sesión podía repetir la llamada con cadenas aleatorias de
 *     2.600 caracteres y cada una era una fila nueva. Un millón de llamadas son
 *     unos 2,7 GB en `wishlist`: suficiente para agotar la cuota de la base y
 *     dejar sin escrituras —compras, ventas— a todos los jugadores. Nadie lo
 *     notaba antes, porque `getWishlistCards` hace JOIN con `cards` y no
 *     enseña la basura.
 *  2. No había tope de filas por usuario.
 *  3. El alternado era leer y luego escribir, en dos sentencias: un doble toque
 *     leía dos veces "no está" y dejaba la carta añadida en vez de alternar.
 *
 * AHORA ES UNA SENTENCIA. Primero intenta QUITAR (`borrada`); sólo si no había
 * nada que quitar intenta PONER (`puesta`), y la fila sale de `cards` —una
 * carta inventada no existe y no se inserta— y sólo entra si el usuario está
 * por debajo del tope. El tope va DENTRO del INSERT, que cierra el agujero que
 * importaba —crecer sin límite, petición tras petición—.
 *
 * LO QUE NO ES: un tope exacto. El recuento sale de la instantánea de cada
 * sentencia, así que las altas que se SOLAPEN ven todas el mismo número y
 * entran todas. Medido contra PostgreSQL real: con 499 filas, 40 altas a la
 * vez dejan 504; con 495 y 30, 520. El exceso está acotado por lo que se
 * pueda solapar —y por el tope de frecuencia de arriba— y no crece después:
 * la siguiente petición ya ve más de 500 y no entra. Es la misma holgura que
 * el tope de anuncios del bazar, que sí se recorta con un barrido porque allí
 * hay algo que cerrar; aquí cinco deseadas de más no son un problema.
 *
 * La forma de la respuesta no cambia: `{ wishlisted }` o `{ error }`.
 */
export async function toggleWishlist(cardId: string) {
  const { userId } = await auth();
  if (!userId) return { error: "No logueado" };
  if (!esIdPlausible(cardId)) {
    return { error: "Carta no válida" };
  }
  // Tope de frecuencia (services/limite.ts).
  if (!dentroDelLimite("deseos:" + userId, LIMITES.deseos)) {
    return { error: "Demasiados cambios seguidos. Espera unos segundos." };
  }
  try {
    await ensureSchema();
    const { rows } = await sql.query(
      `WITH borrada AS (
         DELETE FROM wishlist WHERE user_id = $1 AND card_id = $2
         RETURNING 1
       ),
       puesta AS (
         INSERT INTO wishlist (user_id, card_id)
         SELECT $1::text, c.id
           FROM cards c
          WHERE c.id = $2
            AND NOT EXISTS (SELECT 1 FROM borrada)
            AND (SELECT count(*) FROM wishlist WHERE user_id = $1) < $3::int
         ON CONFLICT DO NOTHING
         RETURNING 1
       )
       SELECT (SELECT count(*)::int FROM borrada) AS borradas,
              (SELECT count(*)::int FROM puesta)  AS puestas,
              EXISTS (SELECT 1 FROM cards WHERE id = $2) AS existe,
              (SELECT count(*)::int FROM wishlist WHERE user_id = $1) AS tenia`,
      [userId, cardId, MAX_DESEADAS],
    );
    const r = rows[0] ?? {};
    if (Number(r.borradas) > 0) {
      return { wishlisted: false };
    }
    if (Number(r.puestas) > 0) {
      return { wishlisted: true };
    }
    // Ni se quitó ni se puso, y la sentencia dice por qué.
    if (!r.existe) return { error: "Esa carta no existe" };
    if (Number(r.tenia) >= MAX_DESEADAS) {
      return { error: `Tu lista de deseos está llena (${MAX_DESEADAS} cartas). Quita alguna para añadir otra.` };
    }
    // Sólo queda la carrera: dos toques a la vez sobre una carta que no estaba.
    // Las dos sentencias ven "no está", una inserta y la otra choca en la clave
    // primaria y no hace nada. La carta HA QUEDADO marcada, y eso se contesta.
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
    const traducidas = await traducirCartasEs(
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
  const traducidas = await traducirCartasEs(
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
      // `typeof … === "number"` y no `?? 1`: la rareza viene de datos, y con
      // una llamada "constructor" el índice devuelve una función heredada de
      // Object.prototype, que no es null: el `??` no saltaba y la carta no
      // contaba ni como morralla ni como rara. Una rareza desconocida es
      // morralla (rango 1), como en `rangoDeRareza` de utils/mercado.ts.
      const rango = RARITY_RANK[c.rarity ?? ""];
      const r = typeof rango === "number" ? rango : 1;
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

/* AQUÍ VIVÍA `combinaciones` (subconjuntos de k elementos con un tope de 200),
 * con la que `entregaValida` resolvía el arcoíris. Ese tope era un fallo —un
 * lote válido se rechazaba según el orden de las filas— y la función dejó de
 * usarse cuando el arcoíris pasó al emparejamiento. Se conservó mientras
 * scripts/test-invariantes.mjs la sacaba de este fichero por nombre; ya la
 * trata como opcional, así que se ha quitado. */

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
 *
 * EL ARCOÍRIS YA NO SE ENUMERA, Y ERA UN FALSO NEGATIVO. Antes se probaban
 * combinaciones de N tipos entre los que hubiera en el lote, como mucho 200 y
 * en el orden en que Postgres devolviera las filas. Con 10 tipos y un arcoíris
 * de 5 son C(10,5) = 252: las 52 últimas no se probaban nunca. Si la única
 * buena caía ahí, el servidor contestaba "requisitos" a un lote correcto que la
 * pantalla seguía pintando completo, y reintentar no servía porque las filas
 * volvían en el mismo orden. Medido por scripts/test-invariantes.mjs con el
 * tablón y el catálogo reales: 16 lotes válidos rechazados de 2.724.
 *
 * AHORA ENTRA ENTERO EN EL EMPAREJAMIENTO, sin elegir tipos por adelantado. Se
 * pone un hueco por CADA tipo presente (no sólo N) y, para que sobren
 * exactamente los que tienen que sobrar, se añaden tantos COMODINES como tipos
 * hay de más: un comodín sólo cabe en los huecos de tipo de su arcoíris. Con
 * T tipos y un arcoíris de N, T − N huecos se los llevan los comodines y los N
 * restantes tienen que llenarse con N cartas de verdad, cada una en un tipo
 * distinto. Es exacto, no depende del orden de las filas y no tiene tope que
 * alcanzar: un solo emparejamiento por reparto, haya los tipos que haya.
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

  /** ¿Caben estas cartas, todas, entre los requisitos simples y los arcoíris? */
  const encajaElResto = (restantes: number[]): boolean => {
    if (presupuesto-- <= 0) return false;
    // Comodín → índice de su arcoíris. Los comodines no son cartas: son el
    // relleno de los huecos de tipo que sobran (ver la cabecera).
    const arcoirisDeComodin = new Map<CartaMinima, number>();
    const comodines: CartaMinima[] = [];
    const huecos: Hueco[] = [];
    for (const r of simples) {
      for (let i = 0; i < r.cantidad; i++) {
        huecos.push((c) => !arcoirisDeComodin.has(c) && sirveParaRequisito(c, r));
      }
    }
    for (let k = 0; k < arcoiris.length; k++) {
      const r = arcoiris[k];
      const tipos = Array.from(
        new Set(
          restantes
            .filter((i) => sirveParaRequisito(cartas[i], r))
            .flatMap((i) => listaSegura(cartas[i].types).map(enMinusculas)),
        ),
      );
      // Con menos tipos que cartas pide el arcoíris, no hay reparto posible.
      if (tipos.length < r.cantidad) return false;
      for (const tipo of tipos) {
        huecos.push(
          (c) =>
            arcoirisDeComodin.get(c) === k ||
            (!arcoirisDeComodin.has(c) &&
              sirveParaRequisito(c, r) &&
              listaSegura(c.types).map(enMinusculas).includes(tipo)),
        );
      }
      for (let sobran = tipos.length - r.cantidad; sobran > 0; sobran--) {
        const comodin: CartaMinima = { id: "", name: "" };
        arcoirisDeComodin.set(comodin, k);
        comodines.push(comodin);
      }
    }
    // `emparejaHuecos` exige tantos huecos como cartas y los llena todos, así
    // que los comodines ocupan exactamente los huecos de tipo que sobran y cada
    // carta de verdad acaba en un hueco que la acepta.
    return emparejaHuecos(
      cartas.concat(comodines),
      restantes.concat(comodines.map((_, j) => cartas.length + j)),
      huecos,
    );
  };

  const explorar = (k: number, usadas: Set<number>): boolean => {
    if (presupuesto <= 0) return false;
    if (k === enumerables.length) {
      return encajaElResto(todos.filter((i) => !usadas.has(i)));
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
  const capa = await capaEs(idioma);
  const { nombres: nombresEn } = await catalogoDelMercado();
  const nombresSet: Record<string, string> = {};
  for (const o of ofertas) {
    for (const id of [o.setId, ...o.requisitos.map((r) => r.setId)]) {
      if (!id || nombresSet[id]) continue;
      const nombre = (idioma === "es" ? capa.nombreSet(id) : null) ?? nombresEn[id];
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
      /* LAS GRADUADAS NO SE ENTREGAN AL MERCADO: están en la vitrina. Se
       * descuentan AQUÍ, en la cantidad que se reporta, y no en un filtro
       * aparte, para que "copiasEntregables" —que es la única definición de la
       * regla y la aplican cliente y servidor— siga recibiendo un número que
       * ya significa "copias libres". Si se restaran sólo en el cobro, la
       * pantalla pintaría la barra en verde y el servidor rechazaría: es
       * exactamente el fallo contra el que avisa el comentario de más abajo.
       *
       * LAS ANUNCIADAS EN EL BAZAR TAMPOCO, y se restan en el mismo sitio y por
       * el mismo motivo: entregar la copia de un anuncio abierto dejaba el
       * anuncio sin nada detrás (ver `copiasComprometidas`). */
      // Con `catch`, como en getFullCollection: esto es una lectura y no puede
      // fallar por no poder asegurar un esquema que casi siempre ya está.
      await ensureSchema().catch((e) => console.error("getCartasMercado: esquema:", e));
      const { rows } = await sql.query(
        `SELECT ${COLUMNAS_MERCADO},
                uc.quantity - COALESCE(g.n, 0) - COALESCE(a.n, 0) AS quantity
         FROM user_collection uc
         JOIN cards c ON c.id = uc.card_id
         LEFT JOIN (
           SELECT card_id, count(*)::int AS n FROM graded_cards
           WHERE user_id = $1 AND estado = 'activa' GROUP BY card_id
         ) g ON g.card_id = uc.card_id
         LEFT JOIN (
           SELECT card_id, count(*)::int AS n FROM bazar_listings
           WHERE seller_id = $1 AND estado = 'activa' AND graded_id IS NULL
           GROUP BY card_id
         ) a ON a.card_id = uc.card_id
         WHERE uc.user_id = $1
           AND uc.quantity - COALESCE(g.n, 0) - COALESCE(a.n, 0) > 0`,
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
  // Tope de frecuencia (services/limite.ts): validar un lote contra el tablón
  // es la acción con más CPU del fichero.
  if (!dentroDelLimite("oferta:" + userId, LIMITES.cumplirOferta)) {
    return { ok: false as const, error: "servidor" as const, limitado: true as const };
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
    // Misma resta de graduadas y de anunciadas que en getCartasMercado, y por
    // el mismo motivo: las dos tienen que ver el mismo número de copias libres.
    const { rows } = await sql.query(
      `SELECT ${COLUMNAS_MERCADO},
              uc.quantity - COALESCE(g.n, 0) - COALESCE(a.n, 0) AS quantity
       FROM user_collection uc
       JOIN cards c ON c.id = uc.card_id
       LEFT JOIN (
         SELECT card_id, count(*)::int AS n FROM graded_cards
         WHERE user_id = $1 AND estado = 'activa' GROUP BY card_id
       ) g ON g.card_id = uc.card_id
       LEFT JOIN (
         SELECT card_id, count(*)::int AS n FROM bazar_listings
         WHERE seller_id = $1 AND estado = 'activa' AND graded_id IS NULL
         GROUP BY card_id
       ) a ON a.card_id = uc.card_id
       WHERE uc.user_id = $1 AND uc.card_id = ANY($2::text[])
         AND uc.quantity - COALESCE(g.n, 0) - COALESCE(a.n, 0) > 0`,
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
       /* Las copias graduadas de las cartas implicadas. Se cuentan DENTRO de la
        * misma sentencia que descuenta —no fuera— porque el número tiene que
        * evaluarse sobre el mismo estado que ven los candados: leerlo antes y
        * confiar en él dejaría abierta la ventana entre lectura y escritura que
        * el resto de esta sentencia se toma tantas molestias en cerrar. */
       graduadas AS (
         SELECT card_id, count(*)::int AS n
         FROM graded_cards
         WHERE user_id = $1 AND card_id = ANY($3::text[]) AND estado = 'activa'
         GROUP BY card_id
       ),
       /* Y las anunciadas en el bazar (anuncios SUELTOS abiertos): la copia de
        * un anuncio no se entrega aqui, igual que no se vende a la tienda. Sin
        * esto, cumplir un encargo con ella dejaba el anuncio abierto y sin nada
        * detras. Se restan donde las graduadas: en lo que ve la puerta
        * (bloqueo), que es quien decide. */
       anunciadas AS (
         SELECT card_id, count(*)::int AS n
         FROM bazar_listings
         WHERE seller_id = $1 AND card_id = ANY($3::text[])
           AND estado = 'activa' AND graded_id IS NULL
         GROUP BY card_id
       ),
       bloqueo AS (
         SELECT uc.card_id,
                uc.quantity - COALESCE(g.n, 0) - COALESCE(z.n, 0) AS quantity
         FROM user_collection uc
         JOIN entregas e ON e.card_id = uc.card_id
         LEFT JOIN graduadas g ON g.card_id = uc.card_id
         LEFT JOIN anunciadas z ON z.card_id = uc.card_id
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
           /* SIN GUARD DE CANTIDAD PROPIO, Y ES A PROPOSITO. Aqui se repetia
            * la cuenta de suficiente (reservada mas graduadas mas anunciadas),
            * y esa repeticion era un agujero: un UPDATE busca sus filas en la
            * INSTANTANEA de la sentencia, y si la version vieja de una fila no
            * cumple el guard ni la mira, aunque la version confirmada que
            * devolvio el FOR UPDATE de bloqueo si lo cumpla. Con una carta que
            * baja y vuelve a subir alrededor de la instantanea (otra pestana la
            * vende y la recompra), suficiente decia que si, el encargo se
            * pagaba ENTERO y esa carta no salia de la coleccion. Medido contra
            * PostgreSQL real: 103 monedas cobradas y 2 cartas entregadas de 3.
            *
            * Quien decide es suficiente, sobre las filas BLOQUEADAS, que siguen
            * bloqueadas por esta sentencia hasta el final. Aqui solo se
            * descuenta lo que ya se decidio. Y el SELECT final cuadra pago y
            * consumo: una entrega parcial ya no se apunta en el log, aborta. */
           AND EXISTS (SELECT 1 FROM abono)
         RETURNING 1
       )
       SELECT (SELECT coins FROM abono) AS coins,
              (SELECT count(*) FROM consumo) AS consumidas,
              -- EL CUADRE: si se pago, se ha consumido una fila por cada carta
              -- distinta del lote. Si no, division por cero y la sentencia
              -- entera se deshace: ni marca, ni abono, ni cartas.
              1 / (CASE WHEN (SELECT count(*) FROM abono) = 0
                          OR (SELECT count(*) FROM consumo) = (SELECT count(*) FROM entregas)
                        THEN 1 ELSE 0 END) AS cuadra`,
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
      // YA NO PUEDE PASAR: el cuadre del SELECT final aborta la sentencia si se
      // paga sin consumir todas las cartas (antes pasaba, y sólo se anotaba
      // aquí, con el encargo ya pagado). Se deja la línea como testigo: si
      // algún día vuelve a escribirse, es que alguien ha quitado el cuadre.
      console.error(
        `mercado: entrega parcial usuario=${userId} oferta=${oferta.id} ${consumidas}/${ids.length}`,
      );
    }

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

/* ==================================================================== *
 * GRADUACIÓN
 * ====================================================================
 *
 * CÓMO FUNCIONA, en una frase: mandas una copia a graduar, pagas, y te
 * devuelven la nota que ESA copia ya tenía desde que entró en tu colección.
 *
 * LA NOTA NO SE SORTEA AQUÍ. Sale de utils/graduacion.ts, que la deriva de una
 * semilla (usuario, carta, nº de copia) con un generador determinista. Eso es
 * lo que impide la tragaperras: si la nota se tirase al pulsar el botón, quien
 * no quedara contento vendería la carta, la volvería a conseguir y volvería a
 * tirar. Así, volver a intentarlo con la MISMA copia da siempre lo mismo.
 *
 * EL SERVIDOR NO SE FÍA DEL CLIENTE PARA NADA DE ESTO: el navegador dice qué
 * cartas quiere graduar y cuántas copias, y ya. Qué copia toca, qué nota sale,
 * cuánto cuesta y si hay saldo lo decide todo el servidor contra la base de
 * datos. Es la misma regla que comprarSobreAction.
 *
 * POR QUÉ EL COSTE NO ES 100 A SECAS. El multiplicador de un diez es x1,95
 * (la media de la tabla es x1,048; utils/graduacion.ts lo documenta y
 * scripts/test-invariantes.mjs lo comprueba). Con un coste FIJO, graduar lo que
 * tiene mejor pinta sería beneficio garantizado en
 * cuanto la carta pasara de cierto valor —y como se pueden graduar las
 * repetidas, un bucle infinito—. El coste lleva por eso un tramo proporcional:
 * max(100, 40% del valor). Por debajo de 250 monedas, que es la carta más cara
 * del catálogo, se pagan los 100 de siempre.
 */

/** Tope de copias por tacada. Cada una es una fila y un cálculo de nota. */
const MAX_GRADUAR_DE_UNA_VEZ = 40;

/* ==================================================================== *
 * EL SECRETO DE LAS NOTAS
 * ====================================================================
 *
 * LEE EL COMENTARIO LARGO DE utils/graduacion.ts ANTES DE TOCAR ESTO.
 *
 * En corto: sin este secreto, la semilla de una copia sería
 * `idUsuario|idCarta|indice`, y los tres los conoce el navegador. Como
 * `notaDeCopia` viaja en el paquete del cliente —la pantalla de graduación
 * importa de ese mismo fichero la tabla de probabilidades—, cualquiera podría
 * calcular la nota de todas sus copias sin graduar y mandar sólo los dieces.
 * Graduar pasaría de perder 12,5 monedas de media a ser beneficio garantizado.
 *
 * SI LA VARIABLE NO ESTÁ, la aplicación NO se rompe: se usa el respaldo de
 * abajo y las notas siguen siendo estables y deterministas. Lo que se pierde es
 * el secreto, así que se avisa UNA vez por instancia, fuerte, en el registro.
 *
 * PONERLA O ROTARLA ES SEGURO EN CUALQUIER MOMENTO: las notas ya asignadas
 * están guardadas en `graded_cards.nota` y no se recalculan al leerlas. Sólo
 * cambia lo que les tocará a las copias que nadie ha graduado todavía.
 */
const RESPALDO_SECRETO_NOTAS = "tcg-notas-sin-configurar";
let avisadoSinSecreto = false;

function secretoDeNotas(): string {
  /* SE LIMPIA ANTES DE MIRAR NADA. Copiar y pegar en el panel de Vercel arrastra
   * saltos de línea y espacios con una facilidad pasmosa, y un secreto con un
   * "\n" al final SÍ pasaría el corte de longitud pero sería otro secreto
   * distinto del que se pegó — o sea, notas distintas entre despliegues sin que
   * nadie entienda por qué. Mejor recortarlo aquí. */
  const bruto = process.env.GRADING_SECRET;
  const s = typeof bruto === "string" ? bruto.trim() : "";
  if (s.length >= 16) return s;

  if (!avisadoSinSecreto) {
    avisadoSinSecreto = true;
    /* EL AVISO DICE QUÉ CASO ES, y no es un lujo: la primera versión decía "no
     * está configurada (o es demasiado corta)" y con eso no se puede
     * diagnosticar nada. Los tres casos se arreglan de forma distinta —falta la
     * variable, está puesta en el entorno equivocado, o se pegó mal— y la
     * diferencia entre ellos es justamente si la variable llega y con qué
     * longitud.
     *
     * SE PUBLICA LA LONGITUD, NUNCA EL VALOR. Saber que mide 64 caracteres no
     * ayuda a adivinarlo; verlo escrito en un registro sí lo quema. */
    const diagnostico =
      bruto === undefined
        ? "la variable NO LLEGA a este despliegue (no está definida). Si la" +
          " acabas de crear en Vercel: comprueba que esté marcada para" +
          " *Production* y no sólo para Preview/Development, y RECUERDA que las" +
          " variables sólo entran en despliegues NUEVOS — hay que redesplegar" +
          " después de guardarla."
        : s.length === 0
          ? "la variable llega VACÍA. Se guardó sin valor, o con sólo espacios."
          : `la variable llega pero mide ${s.length} caracteres y hacen falta 16` +
            " o más. Probablemente se pegó a medias.";

    console.warn(
      "[graduacion] GRADING_SECRET: " +
        diagnostico +
        " · MIENTRAS TANTO las notas usan el respaldo público, así que un" +
        " jugador podría calcularlas antes de pagar y quedarse sólo con los" +
        " dieces. Genera una con" +
        " node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"." +
        " Ponerla o cambiarla es seguro en caliente: las notas ya asignadas" +
        " están guardadas en graded_cards.nota y no se recalculan.",
    );
  }
  return RESPALDO_SECRETO_NOTAS;
}

/* ==================================================================== *
 * UNA CARTA TIENE DOS VALORES Y NO SON EL MISMO NÚMERO
 * ====================================================================
 *
 * EL FALLO QUE CIERRA ESTE BLOQUE: el botón de la vitrina decía "Vender por
 * 488" y el servidor abonaba 417. No era un redondeo, eran dos fórmulas
 * distintas viviendo en dos funciones distintas:
 *
 *   · `getVitrina` pintaba valorGraduado(precioDeCartaSuelta(...), nota), la
 *     TARIFA PLANA — lo que paga la primera copia repetida;
 *   · `venderGraduadaAction` abonaba valorGraduado(valorDeVenta(...), nota), la
 *     CURVA de repetidas, que es lo que de verdad se cobra.
 *
 * Medido sobre una Hyper Rare (tarifa 250) con un 10: con 3 copias el botón
 * decía 488 y pagaba 417; con 20 copias decía 488 y pagaba 123. Coincidían
 * exactamente con 2 copias, que es el único caso en que la curva no ha empezado
 * a bajar. Y no es que una de las dos esté mal: LAS DOS HACEN FALTA, porque
 * responden a preguntas distintas y hay una pantalla detrás de cada una.
 *
 *   · LO QUE SE COBRA AL VENDER AHORA (la curva). Tiene que llevar las copias
 *     que se tienen, porque la curva anti-acaparamiento existe justo para que
 *     la copia número veinte no pague como la primera. Es la cifra del botón.
 *   · EL VALOR DE REFERENCIA (la tarifa plana). Es el que `publicarEnBazarAction`
 *     usa para calcular la banda de precio del anuncio, y el que
 *     `graduarCartasAction` usa para cobrar la graduación. Tiene que ser plano a
 *     propósito: si la banda del bazar dependiera de cuántas copias tiene el
 *     vendedor, la misma carta valdría cosas distintas según quién la publique,
 *     y el comprador no tiene forma de saberlo.
 *
 * POR QUÉ DOS FUNCIONES Y NO DOS EXPRESIONES COPIADAS: porque copiadas ya se
 * separaron una vez. Cada número sale ahora de UN sitio, y quien lo pinta y
 * quien lo paga llaman al mismo.
 */

/**
 * Lo que abona la tienda HOY por vender una copia YA GRADUADA. Es la curva de
 * repetidas (la copia más alta del montón, la más barata) con el multiplicador
 * de la nota encima, en ese orden.
 *
 * EL ORDEN IMPORTA y está explicado en utils/graduacion.ts (valorGraduado): si
 * se multiplicara la tarifa y luego se aplicase la curva, graduar sería la
 * forma de esquivar la curva y 400 repetidas graduadas cobrarían como la
 * primera.
 *
 * @param copiasQueTengo copias en propiedad AHORA, graduadas incluidas: ocupan
 *                       su sitio en la curva aunque no se vendan por esta vía.
 */
function valorDeVenderGraduada(
  rareza: string | null | undefined,
  copiasQueTengo: number,
  nota: number,
  euros?: number | null,
): number {
  return valorGraduado(valorDeVenta(rareza, copiasQueTengo, 1, euros), nota);
}

/**
 * Valor de REFERENCIA de una copia graduada: la tarifa plana de la carta por el
 * multiplicador de su nota, sin la curva de repetidas.
 *
 * No es lo que se cobra al venderla (para eso está la de arriba): es el número
 * contra el que `publicarEnBazarAction` mide la banda de precio del anuncio, y
 * por eso la pantalla de publicar necesita EXACTAMENTE éste — si pintara otro,
 * ofrecería un precio que el servidor rechaza.
 */
function valorDeReferenciaGraduada(
  rareza: string | null | undefined,
  nota: number,
  euros?: number | null,
): number {
  return valorGraduado(precioDeCartaSuelta(rareza, euros), nota);
}

/**
 * Qué se puede graduar de la colección y cuánto costaría.
 *
 * Devuelve, por carta con copias libres, cuántas quedan sin graduar y el coste
 * unitario. NO devuelve la nota: eso es justo lo que se paga por saber.
 */
export async function getCartasGraduables() {
  const { userId } = await auth();
  if (!userId) return { ok: false as const, error: "no-autorizado" as const };

  try {
    await ensureSchema();
    /* LO QUE EL BAZAR TIENE APALABRADO TAMPOCO SE GRADÚA.
     *
     * Graduar no gasta la copia, pero la saca del montón de sueltas, y un
     * anuncio abierto necesita detrás una copia suelta MÁS la reservada del
     * álbum (es lo que exige la puerta de `comprarEnBazarAction`). Con 2 copias
     * y una anunciada, graduar las dos dejaba el anuncio abierto y sin compra
     * posible para siempre. Así que, mientras haya algún anuncio abierto de la
     * carta, no se gradúan ni las copias de los anuncios sueltos ni esa
     * reservada:
     *
     *     en_bazar = anuncios sueltos + 1      (0 si no hay ningún anuncio)
     *
     * El +1 cuenta también cuando el único anuncio es de una graduada: su copia
     * ya va en `graduadas`, pero la compra le sigue exigiendo al vendedor una
     * copia libre. Es EXACTAMENTE la cuenta del CTE `posibles` de
     * `graduarCartasAction`: lo que aquí se ofrece es lo que allí entra. */
    const { rows } = await sql`
      SELECT uc.card_id, uc.quantity, c.name, c.rarity, c.images, c.set_id,
             COALESCE(g.n, 0)::int AS graduadas,
             COALESCE(z.sueltos, 0)::int AS anunciadas,
             COALESCE(z.sueltos + 1, 0)::int AS en_bazar
      FROM user_collection uc
      JOIN cards c ON c.id = uc.card_id
      LEFT JOIN (
        SELECT card_id, count(*)::int AS n FROM graded_cards
        WHERE user_id = ${userId} AND estado = 'activa' GROUP BY card_id
      ) g ON g.card_id = uc.card_id
      LEFT JOIN (
        SELECT card_id,
               (count(*) FILTER (WHERE graded_id IS NULL))::int AS sueltos
        FROM bazar_listings
        WHERE seller_id = ${userId} AND estado = 'activa'
        GROUP BY card_id
      ) z ON z.card_id = uc.card_id
      WHERE uc.user_id = ${userId}
        AND uc.quantity - COALESCE(g.n, 0) - COALESCE(z.sueltos + 1, 0) > 0
      ORDER BY c.rarity, c.name
    `;

    const euros = await preciosEnEuros(rows.map((r: any) => String(r.card_id)));
    const cartas = rows.map((r: any) => {
      const cantidad = Number(r.quantity);
      const graduadas = Number(r.graduadas ?? 0);
      const anunciadas = Number(r.anunciadas ?? 0);
      const enBazar = Number(r.en_bazar ?? 0);
      const eur = euros.get(String(r.card_id));
      /* LOS DOS VALORES, cada uno con su nombre. Ver el bloque largo de arriba:
       * el plano es el de la banda del bazar y el del coste de graduar, y la
       * curva es lo que la tienda paga hoy por una copia sobrante. Antes iba
       * sólo el plano, con el rótulo "vale X", y ese X no lo pagaba nadie. */
      const valorDeReferencia = precioDeCartaSuelta(r.rarity, eur);
      return {
        id: String(r.card_id),
        name: String(r.name ?? ""),
        rarity: String(r.rarity ?? "Common"),
        images: aImagenes(r.images),
        setId: String(r.set_id ?? ""),
        cantidad,
        graduadas,
        /** Copias con un anuncio suelto abierto en el bazar. */
        anunciadas,
        /**
         * Copias que se pueden mandar a graduar: las que no tienen nota ni
         * están apalabradas en el bazar (ver el comentario de la consulta).
         */
        libres: cantidad - graduadas - enBazar,
        /**
         * Lo que la tienda paga HOY por UNA copia sobrante sin graduar: el
         * mismo número que cobra `sellCardAction`, sacado de la misma función
         * que usa la colección. Es 0 cuando no sobra ninguna copia libre —las
         * graduadas y las anunciadas no se venden por esa vía y la última libre
         * se queda en el álbum—, que es justo cuando la venta se niega.
         */
        valorDeVentaAhora: valoresDeVentaDelMonton(
          r.rarity,
          cantidad,
          graduadas + anunciadas,
          eur,
        ).valorDeVentaAhora,
        /**
         * Tarifa plana de la carta. Es la base del coste de graduar (lo que
         * cobra `graduarCartasAction`) y del valor con el que
         * `publicarEnBazarAction` calcula la banda del anuncio.
         */
        valorDeReferencia,
        /**
         * Alias de `valorDeReferencia`, que es lo que este campo siempre fue.
         * Sigue aquí porque lo leen pantallas que no son de este cambio
         * (PublicarSheet para la banda, ListaGraduables para el coste); el
         * rótulo "vale X" es el que tiene que pasarse a `valorDeVentaAhora`.
         */
        valor: valorDeReferencia,
        coste: costeDeGraduar(valorDeReferencia),
      };
    });

    return { ok: true as const, cartas: await enIdiomaUsuario(cartas) };
  } catch (e) {
    console.error("getCartasGraduables error:", e);
    return { ok: false as const, error: "servidor" as const };
  }
}

/**
 * Gradúa copias. El cliente manda [{cardId, copias}] y NADA MÁS.
 *
 * ATOMICIDAD, y es la parte delicada: el cobro y el alta van en UNA sentencia,
 * y el importe NO se calcula antes y se confía — se calcula DENTRO, sumando
 * sólo las copias que de verdad se pueden graduar en ese instante. Así, si
 * entre la lectura y la escritura otra pestaña gradúa una copia o vende la
 * carta, se cobra por lo que se hizo y no por lo que se pidió.
 *
 * EL ÍNDICE DE COPIA se elige aquí: la más baja que aún no tenga nota. Es
 * determinista, así que dos peticiones iguales piden las mismas copias y el
 * índice único (user_id, card_id, copia) arbitra la carrera — la segunda choca
 * y no inserta, en vez de duplicar.
 */
export async function graduarCartasAction(
  peticiones: { cardId: string; copias: number }[],
) {
  const { userId } = await auth();
  if (!userId) return { ok: false as const, error: "no-autorizado" as const };
  if (!Array.isArray(peticiones) || peticiones.length === 0) {
    return { ok: false as const, error: "peticion" as const };
  }

  // Validación de forma, con los mismos criterios que el resto del fichero.
  const pedidas = new Map<string, number>();
  for (const p of peticiones) {
    if (!p || typeof p.cardId !== "string" || !ID_CARTA.test(p.cardId)) {
      return { ok: false as const, error: "peticion" as const };
    }
    const n = Math.floor(Number(p.copias));
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false as const, error: "peticion" as const };
    }
    pedidas.set(p.cardId, (pedidas.get(p.cardId) ?? 0) + n);
  }
  const totalPedido = Array.from(pedidas.values()).reduce((a, b) => a + b, 0);
  if (totalPedido > MAX_GRADUAR_DE_UNA_VEZ) {
    return { ok: false as const, error: "demasiadas" as const };
  }
  // Tope de frecuencia (services/limite.ts).
  if (!dentroDelLimite("graduar:" + userId, LIMITES.graduar)) {
    return { ok: false as const, error: "servidor" as const, limitado: true as const };
  }

  const ids = Array.from(pedidas.keys());

  try {
    await ensureSchema();

    // Estado real: cuántas copias hay y qué índices ya tienen nota.
    const { rows: estado } = await sql.query(
      `SELECT uc.card_id, uc.quantity, c.rarity
         FROM user_collection uc
         JOIN cards c ON c.id = uc.card_id
        WHERE uc.user_id = $1 AND uc.card_id = ANY($2::text[]) AND uc.quantity > 0`,
      [userId, ids],
    );
    if (estado.length === 0) return { ok: false as const, error: "posesion" as const };

    const { rows: yaGraduadas } = await sql.query(
      `SELECT card_id, copia FROM graded_cards
        WHERE user_id = $1 AND card_id = ANY($2::text[])`,
      [userId, ids],
    );
    const ocupadas = new Map<string, Set<number>>();
    for (const g of yaGraduadas) {
      const k = String(g.card_id);
      if (!ocupadas.has(k)) ocupadas.set(k, new Set());
      ocupadas.get(k)!.add(Number(g.copia));
    }

    const euros = await preciosEnEuros(ids);

    const secreto = secretoDeNotas();

    /* PRIMERA PASADA: qué copias se pueden graduar de verdad.
     *
     * Se recorre el estado REAL de la colección, no lo que pidió el cliente:
     * de cada carta se toman los índices libres MÁS BAJOS, en orden, hasta
     * llegar a los que pidió o quedarse sin. Determinista a propósito — dos
     * peticiones iguales apuntan a las mismas copias, y de la carrera entre
     * ellas se encarga el índice único (user_id, card_id, copia).
     *
     * ------------------------------------------------------------------
     * EL TOPE DEL BUCLE ERA `copia <= cantidad` Y DEJABA AL JUGADOR ATASCADO
     * ------------------------------------------------------------------
     *
     * `tomadas` incluye las filas 'vendida' a propósito: su hueco no se suelta
     * jamás porque el hueco ES la nota (ver el índice único de graded_cards en
     * services/esquemaMejoras.ts). Pero al vender una graduada, `quantity` BAJA
     * y su índice se queda dentro de 1..quantity, así que cada venta se come un
     * índice del rango que el bucle miraba. Con dos ventas y una copia restante
     * el rango era {1} y estaba ocupado: la pantalla ofrecía la copia
     * —getCartasGraduables cuenta `quantity - activas`, y las vendidas no son
     * activas— y la acción contestaba "nada-que-graduar". Sin salida: ni
     * graduando más ni vendiendo más se recupera un índice, porque no se
     * recupera nunca ninguno.
     *
     * AHORA NO HAY TOPE ARTIFICIAL: se sube por los enteros saltando los
     * ocupados hasta reunir los que se piden. El índice deja de significar
     * "posición física dentro de las que tengo" —que nunca fue verdad, sólo lo
     * parecía— y significa lo único que siempre significó: qué tirada le toca a
     * esta copia. El bazar ya hacía esto mismo desde el otro lado: al comprador
     * se le da MAX(copia) + 1 (CTE 'entrega' de comprarEnBazarAction), que
     * también puede pasarse de sus copias.
     *
     * CUÁNTAS SE GRADÚAN LO SIGUE DECIDIENDO LA BASE, no este bucle: el CTE
     * 'posibles' corta por `c.puesto <= b.quantity - activas` sobre la fila ya
     * bloqueada. El invariante que hay que sostener es de RECUENTO
     * (graduadas + nuevas <= quantity) y ése no lo toca cambiar el tope: esto
     * sólo propone candidatas, y de más nunca entran.
     *
     * Y NO RECICLA NOTAS: `ocupadas` se llena con TODAS las filas de
     * graded_cards de esas cartas, sin filtrar por estado, así que un índice
     * usado no vuelve a salir de aquí; el `NOT EXISTS` de 'posibles' tampoco
     * filtra por estado, y el índice único (user_id, card_id, copia) tampoco.
     * Tres cerraduras, ninguna mira el estado, que es justo el punto.
     *
     * EL BUCLE TERMINA SIEMPRE: entre 1 y `tomadas.size + quiere` hay como
     * mucho `tomadas.size` ocupados, así que quedan al menos `quiere` libres.
     * El tope está escrito y no es un `while (true)` con fe. */
    const cCard: string[] = [];
    const cCopia: number[] = [];
    const cNota: number[] = [];

    for (const fila of estado) {
      const cardId = String(fila.card_id);
      const quiere = pedidas.get(cardId) ?? 0;
      const tomadas = ocupadas.get(cardId) ?? new Set<number>();
      const tope = tomadas.size + quiere;

      let puestas = 0;
      for (let copia = 1; copia <= tope && puestas < quiere; copia++) {
        if (tomadas.has(copia)) continue;
        cCard.push(cardId);
        cCopia.push(copia);
        cNota.push(notaDeCopia(semillaDeCopia(userId, cardId, copia, secreto)));
        puestas++;
      }
    }

    if (cCard.length === 0) return { ok: false as const, error: "nada-que-graduar" as const };

    /* EL DESCUENTO SALE DE LO QUE SE VA A GRADUAR, NO DE LO QUE SE PIDIÓ.
     *
     * Parece un matiz y no lo es. `pedidas` viene del cliente, y el cliente
     * puede pedir veinticinco copias de cartas que no tiene: los ids pasan la
     * validación de forma y sólo se caen después, al cruzarlos con la
     * colección. Con el descuento calculado sobre lo pedido, mandar una carta
     * de verdad y veinticuatro inventadas daba el descuento máximo SIEMPRE, y
     * el escalón dejaba de significar nada.
     *
     * No abría una fuga —el suelo con descuento nunca baja del tramo
     * proporcional, y el invariante de scripts/test-invariantes.mjs lo
     * comprueba hasta el 75%—, pero regalaba treinta monedas por carta a quien
     * mirase la petición. Ahora el descuento es el de las copias que de verdad
     * se van a graduar. */
    const descuento = descuentoPorVolumen(cCard.length);

    /* SEGUNDA PASADA: el precio, ya con el descuento que toca. El valor lo pone
     * la rareza de la BASE DE DATOS y el precio real del día, nunca el cliente. */
    const rarezaDe = new Map<string, string>(
      estado.map((f) => [String(f.card_id), String(f.rarity ?? "Common")]),
    );
    const cCoste: number[] = cCard.map((cardId) =>
      costeDeGraduar(precioDeCartaSuelta(rarezaDe.get(cardId), euros.get(cardId)), cCard.length),
    );

    /* COBRO Y ALTA EN UNA SOLA SENTENCIA.
     *
     * `posibles` vuelve a comprobar contra la base —posesión y que la copia
     * siga libre— para que el importe salga de lo que se puede hacer AHORA y no
     * de lo que se leyó hace dos consultas. Y el ON CONFLICT DO NOTHING cubre
     * la carrera entre dos pestañas: la perdedora no duplica.
     *
     * QUIÉN ARBITRA QUÉ, porque aquí hay dos puertas y no una. Este párrafo
     * decía que el árbitro era `cobro`, y dejó de ser verdad cuando se invirtió
     * el orden: hoy el árbitro del ALTA es `solvente` —la puerta del saldo, con
     * su FOR UPDATE— y `cobro` va detrás, colgado de `facturado`, cobrando
     * exactamente las filas que entraron. El porqué de cada una está en su
     * propio CTE.
     */
    const { rows: res } = await sql.query(
      `WITH candidatas AS (
         SELECT * FROM unnest($2::text[], $3::int[], $4::int[], $5::int[])
           AS t(card_id, copia, nota, coste)
       ),
       /* CUÁNTAS HAY YA GRADUADAS DE CADA CARTA, sobre las filas bloqueadas.
        * Va aquí dentro y no en JavaScript: el recuento decide cuántas caben
        * todavía, y leerlo antes de la sentencia dejaría abierta la ventana
        * entre lectura y escritura.
        *
        * MATERIALIZED no es cosmético desde que solvente bloquea users: el
        * argumento de por qué esta sentencia no se abraza con las demás
        * descansa en que estas filas se tomen ANTES, y en el orden global que
        * da el ORDER BY. Sin MATERIALIZED, el planificador puede incrustar este
        * CTE en el nested loop de posibles y reescanearlo, y entonces el
        * ORDER BY sólo ordena dentro de cada reescaneo: el orden global se
        * pierde justo en el caso que importa, dos graduaciones a la vez sobre
        * las mismas cartas. Es una palabra y quita la dependencia del plan.
        *
        * (Sin acentos graves aquí dentro: este comentario vive DENTRO del
        * literal de plantilla del SQL y uno solo lo cerraría.) */
       bloqueo AS MATERIALIZED (
         SELECT uc.card_id, uc.quantity
         FROM user_collection uc
         WHERE uc.user_id = $1
           AND uc.card_id IN (SELECT DISTINCT card_id FROM candidatas)
         ORDER BY uc.card_id
         FOR UPDATE OF uc
       ),
       yaGraduadas AS (
         SELECT card_id, count(*)::int AS n
         FROM graded_cards
         WHERE user_id = $1 AND estado = 'activa'
           AND card_id IN (SELECT DISTINCT card_id FROM candidatas)
         GROUP BY card_id
       ),
       /* LO QUE EL BAZAR TIENE APALABRADO DE CADA CARTA: las copias de sus
        * anuncios sueltos MAS una, la que la compra exige que le quede libre al
        * vendedor. Solo hay fila si la carta tiene algun anuncio abierto (de
        * suelta o de graduada), asi que sin anuncios no se resta nada.
        *
        * Graduar no baja quantity, pero SI saca la copia del monton de sueltas:
        * con 2 copias y una anunciada, graduar las dos dejaba el anuncio
        * abierto y sin compra posible. Es la misma cuenta que anuncia
        * getCartasGraduables (libres), que es lo que hace que la pantalla no
        * ofrezca copias que esta sentencia va a dejar fuera. */
       enBazar AS (
         SELECT card_id,
                (count(*) FILTER (WHERE graded_id IS NULL) + 1)::int AS n
         FROM bazar_listings
         WHERE seller_id = $1 AND estado = 'activa'
           AND card_id IN (SELECT DISTINCT card_id FROM candidatas)
         GROUP BY card_id
       ),
       /* LAS QUE DE VERDAD CABEN.
        *
        * EL GUARD ERA POR ÍNDICE Y TENÍA QUE SER POR RECUENTO. Antes exigía
        * sólo "uc.quantity >= c.copia", o sea que el índice de la copia cupiera
        * dentro de las que se tienen. Eso no es lo mismo que "no graduar más
        * copias de las que hay": con 3 copias y las copias 1 y 2 ya graduadas,
        * una petición de la copia 3 pasaba el guard aunque otra sentencia
        * concurrente hubiera bajado quantity entretanto. El invariante que hay
        * que sostener es el RECUENTO:
        *
        *     graduadas(usuario, carta) + las nuevas  <=  quantity
        *
        * row_number() numera las candidatas de cada carta y se corta por el
        * hueco que de verdad queda. Así, si caben dos y se piden cinco, entran
        * dos y se cobran dos. */
       posibles AS (
         SELECT c.*
         FROM (
           SELECT c.*,
                  row_number() OVER (PARTITION BY c.card_id ORDER BY c.copia) AS puesto
           FROM candidatas c
           WHERE NOT EXISTS (
             SELECT 1 FROM graded_cards g
             WHERE g.user_id = $1 AND g.card_id = c.card_id AND g.copia = c.copia
           )
         ) c
         JOIN bloqueo b ON b.card_id = c.card_id
         LEFT JOIN yaGraduadas y ON y.card_id = c.card_id
         LEFT JOIN enBazar z ON z.card_id = c.card_id
         WHERE c.puesto <= b.quantity - COALESCE(y.n, 0) - COALESCE(z.n, 0)
       ),
       total AS (
         SELECT COALESCE(SUM(coste), 0)::int AS coste, count(*)::int AS n FROM posibles
       ),
       /* EL ALTA VA ANTES QUE EL COBRO, y el orden importa.
        *
        * Antes el cobro era el árbitro y el INSERT colgaba de él. Pero el
        * INSERT lleva ON CONFLICT DO NOTHING, así que podía dar de alta MENOS
        * filas de las que el cobro había pagado —dos pestañas pidiendo la misma
        * copia— y el jugador pagaba por notas que no recibía. Ahora se inserta
        * primero, se cuenta lo que de verdad entró y se cobra EXACTAMENTE eso.
        *
        * El riesgo inverso —dar cartas sin cobrar— lo cierra 'solvente', pero
        * SÓLO desde que lleva FOR UPDATE. Lo que decía aquí antes era falso y
        * lo aprovechaba una fuga: ver el comentario del propio CTE. */
       /* EL CANDADO DEL SALDO, Y NO ES DECORACIÓN.
        *
        * Esto era un SELECT a secas, o sea la INSTANTÁNEA del principio de la
        * sentencia. Con dos peticiones simultáneas (dos pestañas o dos
        * dispositivos; desde la misma pestaña no, porque el router de Next
        * serializa las server actions de un cliente), las dos leían el mismo
        * saldo, las dos daban por bueno el alta, y el 'cobro' —que sí releía la
        * fila ya bloqueada— sólo cobraba a una. La otra graduaba gratis: el
        * INSERT ya estaba hecho y la sentencia se confirmaba igual.
        *
        * Con FOR UPDATE la fila de users se bloquea y, si otra transacción la
        * cambió, Postgres reevalúa la condición sobre la versión CONFIRMADA
        * (EvalPlanQual): la segunda petición ve el saldo ya gastado, 'solvente'
        * no devuelve fila y el alta no ocurre. Que es justo lo que el comentario
        * de arriba llevaba prometiendo sin cumplirlo.
        *
        * MATERIALIZED para que el planificador no lo meta dentro del EXISTS de
        * 'alta' y acabe ejecutando el bloqueo más de una vez o fuera de orden.
        * Es el mismo motivo por el que lo llevan los 'bloqueo' de
        * venderGraduadaAction y comprarEnBazarAction.
        *
        * ORDEN DE CANDADOS: user_collection ANTES que users, que es el orden que
        * siguen las tres sentencias que bloquean las dos tablas
        * (comprarEnBazarAction, venderGraduadaAction y cumplirOferta). Aquí sale
        * solo y no por casualidad: para decidir si devuelve fila, este CTE tiene
        * que evaluar antes 'total', que cuelga de 'posibles', que cuelga de
        * 'bloqueo' —el FOR UPDATE sobre user_collection—. El filtro se evalúa en
        * el escaneo y el bloqueo de users va por encima de él, así que las filas
        * de la colección están tomadas antes de pedir la de users. Invertirlo
        * abrazaría esta sentencia con una compra en el bazar del mismo usuario
        * sobre una carta que estuviera graduando. */
       solvente AS MATERIALIZED (
         SELECT 1 FROM users u
         WHERE u.id = $1
           AND (SELECT n FROM total) > 0
           AND COALESCE(u.coins, 0) >= (SELECT coste FROM total)
         FOR UPDATE OF u
       ),
       alta AS (
         INSERT INTO graded_cards (user_id, card_id, copia, nota, coste)
         SELECT $1, p.card_id, p.copia, p.nota, p.coste
         FROM posibles p
         WHERE EXISTS (SELECT 1 FROM solvente)
         ON CONFLICT (user_id, card_id, copia) DO NOTHING
         RETURNING card_id, copia, nota, coste
       ),
       facturado AS (
         SELECT COALESCE(SUM(coste), 0)::int AS coste FROM alta
       ),
       cobro AS (
         UPDATE users
         SET coins = COALESCE(coins, 0) - (SELECT coste FROM facturado)
         WHERE id = $1
           AND (SELECT coste FROM facturado) > 0
           AND COALESCE(coins, 0) >= (SELECT coste FROM facturado)
         RETURNING coins
       )
       SELECT (SELECT coins FROM cobro) AS coins,
              (SELECT coste FROM facturado) AS cobrado,
              -- Cuantas copias cabian (posibles): el diagnostico de por que no
              -- se cobro, sacado de las mismas filas bloqueadas que decidieron.
              (SELECT n FROM total) AS caben,
              COALESCE(
                (SELECT json_agg(json_build_object(
                   'cardId', card_id, 'copia', copia, 'nota', nota)) FROM alta),
                '[]'::json
              ) AS graduadas`,
      [userId, cCard, cCopia, cNota, cCoste],
    );

    const coins = res[0]?.coins;
    // coins NULL significa que el cobro no tocó fila: o no había saldo, o no
    // quedaba nada que graduar. Es el mismo convenio que comprarSobreAction.
    if (coins === null || coins === undefined) {
      /* Y SE DICE CUÁL DE LAS DOS. Desde que 'posibles' resta lo apalabrado en
       * el bazar, "no cabe ninguna" es alcanzable con saldo de sobra: con 2
       * copias, una anunciada y 5.000 monedas esto contestaba "saldo" y la
       * pantalla le decía al jugador que no le llegaban las monedas. Llega aquí
       * quien tiene la lista de graduables vieja (anunció en otra pestaña). */
      if (Number(res[0]?.caben ?? 0) === 0) {
        return { ok: false as const, error: "nada-que-graduar" as const };
      }
      return { ok: false as const, error: "saldo" as const };
    }

    const crudas = (res[0]?.graduadas ?? []) as {
      cardId: string;
      copia: number;
      nota: number;
    }[];

    /* LOS DESPERFECTOS VIAJAN YA CALCULADOS, igual que en getVitrina y por el
     * mismo motivo: la semilla lleva dentro el secreto de las notas y no puede
     * salir del servidor. Antes el cliente la recomponía para pintar la
     * ceremonia de revelado; ahora recibe el resultado y no necesita saber cómo
     * se llegó a él. */
    const graduadas = crudas.map((g) => {
      const semillaG = semillaDeCopia(userId, g.cardId, g.copia, secreto);
      const desperfectos = desperfectosDeCopia(semillaG, g.nota);
      return { ...g, desperfectos, marcas: marcasDeCopia(semillaG, desperfectos) };
    });

    return {
      ok: true as const,
      coins: Number(coins),
      cobrado: Number(res[0]?.cobrado ?? 0),
      descuento,
      graduadas,
    };
  } catch (e) {
    console.error("graduarCartasAction error:", e);
    return { ok: false as const, error: "servidor" as const };
  }
}

/**
 * La vitrina: las cartas graduadas del usuario, con su nota y lo que valen.
 *
 * El valor se calcula AQUÍ y no se guarda: depende de la rareza, del precio
 * real del día y del multiplicador de la nota, y guardarlo sería una copia del
 * dato que se quedaría vieja.
 */
export async function getVitrina() {
  const { userId } = await auth();
  if (!userId) return { ok: false as const, error: "no-autorizado" as const };

  try {
    await ensureSchema();
    const { rows } = await sql`
      SELECT g.id, g.card_id, g.copia, g.nota, g.coste, g.graded_at,
             c.name, c.rarity, c.images, c.set_id,
             COALESCE(uc.quantity, 0) AS quantity
      FROM graded_cards g
      JOIN cards c ON c.id = g.card_id
      LEFT JOIN user_collection uc
        ON uc.user_id = g.user_id AND uc.card_id = g.card_id
      WHERE g.user_id = ${userId} AND g.estado = 'activa'
      ORDER BY g.nota DESC, c.name ASC
    `;

    const euros = await preciosEnEuros(rows.map((r: any) => String(r.card_id)));
    const secreto = secretoDeNotas();
    const cartas = rows.map((r: any) => {
      const nota = Number(r.nota);
      const eur = euros.get(String(r.card_id));
      /* LOS DESPERFECTOS SE CALCULAN AQUÍ Y VIAJAN YA HECHOS.
       *
       * La semilla NO sale del servidor, ni siquiera la de una copia ya
       * graduada: lleva dentro el secreto de las notas, y con él en la mano
       * cualquiera podría calcular la nota de TODAS sus copias sin graduar.
       * Mandar el resultado en vez de la receta cuesta un puñado de bytes y
       * cierra el agujero entero. */
      const semilla = semillaDeCopia(userId, String(r.card_id), Number(r.copia), secreto);
      const desperfectos = desperfectosDeCopia(semilla, nota);
      const marcas = marcasDeCopia(semilla, desperfectos);
      const copiasTotales = Number(r.quantity ?? 0);
      /* LOS DOS VALORES, cada uno con su nombre y su pantalla. Ver el bloque
       * largo de arriba: aquí vivía la mentira del botón "Vender por 488" que
       * abonaba 417, porque este cálculo era el plano y el de
       * venderGraduadaAction era la curva. */
      const valorDeReferencia = valorDeReferenciaGraduada(r.rarity, nota, eur);
      return {
        gradedId: Number(r.id),
        id: String(r.card_id),
        name: String(r.name ?? ""),
        rarity: String(r.rarity ?? "Common"),
        images: aImagenes(r.images),
        setId: String(r.set_id ?? ""),
        copia: Number(r.copia),
        nota,
        etiqueta: etiquetaNota(nota),
        /* Ya calculados. Ver el comentario de arriba: la semilla no viaja. */
        desperfectos,
        marcas,
        /**
         * LO QUE ABONA `venderGraduadaAction` SI SE VENDE AHORA. Sale de la
         * misma función que el abono, así que el botón no puede volver a
         * prometer una cifra distinta de la que se cobra. Es 0 cuando sólo
         * queda una copia: entonces la acción responde "ultima-copia".
         */
        valorDeVentaAhora: valorDeVenderGraduada(r.rarity, copiasTotales, nota, eur),
        /**
         * Valor de referencia (tarifa plana × nota). Es el que
         * `publicarEnBazarAction` usa para la banda del anuncio, así que es el
         * que tiene que pintar la hoja de publicar en el bazar.
         */
        valorDeReferencia,
        /**
         * Alias de `valorDeReferencia`, que es lo que este campo siempre fue.
         * Se mantiene porque PublicarSheet lo lee para la banda; el botón
         * "Vender por X" de la vitrina es el que tiene que pasarse a
         * `valorDeVentaAhora`.
         */
        valor: valorDeReferencia,
        coste: Number(r.coste ?? 0),
        copiasTotales,
      };
    });

    return { ok: true as const, cartas: await enIdiomaUsuario(cartas) };
  } catch (e) {
    console.error("getVitrina error:", e);
    return { ok: false as const, error: "servidor" as const };
  }
}

/**
 * Vende una carta graduada. Se cobra el valor de UNA copia suelta multiplicado
 * por su nota, y la copia sale de la colección.
 *
 * POR QUÉ AQUÍ SÍ SE RESTA DE quantity y en el resto del fichero las graduadas
 * se protegían: porque ésta es la única puerta por la que una copia graduada
 * puede irse, y se va entera — la fila de graded_cards y la unidad de
 * user_collection en la MISMA sentencia. Las demás rutas la protegían justo
 * para que no se fuera por ninguna otra parte.
 *
 * NO SE PUEDE VENDER LA ÚLTIMA COPIA: la promesa de que el álbum nunca se vacía
 * (COPIAS_PROTEGIDAS) vale también aquí. Si la graduada es la única copia que
 * queda, hay que conseguir otra antes de venderla. Es exactamente lo que se
 * pidió: se puede vender o guardar, pero hay que quedarse con una.
 */
export async function venderGraduadaAction(gradedId: number) {
  const { userId } = await auth();
  if (!userId) return { ok: false as const, error: "no-autorizado" as const };
  if (!Number.isInteger(gradedId) || gradedId <= 0) {
    return { ok: false as const, error: "peticion" as const };
  }

  try {
    await ensureSchema();

    const { rows: info } = await sql`
      SELECT g.card_id, g.nota, c.rarity, COALESCE(uc.quantity, 0) AS quantity
      FROM graded_cards g
      JOIN cards c ON c.id = g.card_id
      LEFT JOIN user_collection uc
        ON uc.user_id = g.user_id AND uc.card_id = g.card_id
      WHERE g.id = ${gradedId} AND g.user_id = ${userId} AND g.estado = 'activa'
    `;
    if (info.length === 0) return { ok: false as const, error: "no-existe" as const };

    const cardId = String(info[0].card_id);
    const cantidad = Number(info[0].quantity);
    if (cantidad <= 1) return { ok: false as const, error: "ultima-copia" as const };

    const nota = Number(info[0].nota);

    /* EL PRECIO SALE DE LA CURVA, NO DE LA TARIFA PLANA. Esto era una fuga.
     *
     * Antes la base era precioDeCartaSuelta(rareza), o sea lo que vale la
     * PRIMERA copia. Pero utils/constanst.ts documenta que la copia repetida
     * número 43 vale el 12,5% de la primera, y esa curva existe justo para que
     * acaparar miles de repetidas no sea una imprenta. Pagando siempre la
     * tarifa de la primera, GRADUAR ERA LA FORMA DE ESQUIVARLA.
     *
     * MEDIDO sobre una Hyper Rare (tarifa 250): con 50 copias, vender una por
     * la vía normal paga 31 monedas; graduarla (coste 100) y venderla con un 7
     * pagaba 175, o sea +44 limpias por copia, repetible hasta vaciar el
     * montón. Con un 10 eran +619.
     *
     * Ahora la base es lo que de VERDAD pagaría esa copia hoy —valorDeVenta con
     * las copias que se tienen— y el multiplicador de la nota se aplica encima.
     * Una copia profunda graduada sigue valiendo más que sin graduar, pero ya
     * no vale más que la primera.
     *
     * Y LA EXPRESIÓN YA NO VIVE AQUÍ: es `valorDeVenderGraduada`, la misma que
     * llama `getVitrina` para pintar el botón. Mientras fueron dos expresiones
     * —ésta la curva, la de la vitrina la tarifa plana— el botón decía 488 y
     * esto abonaba 417. Separadas se separan; compartidas, no pueden. */
    const importe = valorDeVenderGraduada(
      info[0].rarity,
      cantidad,
      nota,
      await euroDeCarta(cardId),
    );
    if (importe <= 0) {
      // Un 1 vale x0: la carta no se vende, se tira. Mejor decirlo que cobrar 0.
      return { ok: false as const, error: "sin-valor" as const };
    }

    /* BAJA, DESCUENTO Y ABONO EN UNA SENTENCIA. `baja` es el árbitro: el DELETE
     * sólo toca fila si la graduación sigue siendo suya y sigue existiendo, así
     * que dos pestañas vendiendo la misma sólo cobran una vez. Y el anuncio del
     * bazar, si lo hubiera, se retira en la misma tacada: una carta que ya no
     * está no puede seguir publicada. */
    const { rows } = await sql`
      /* EL ORDEN DE LOS CTE IMPORTA, Y AQUÍ ESTABA MAL.
       *
       * En Postgres, TODOS los CTE que escriben se ejecutan, se referencien o
       * no. La versión anterior ponía la baja de la graduada la primera y el
       * cobro al final colgando de ella: si el descuento de la copia no llegaba
       * a tocar fila —porque otra pestaña vendió entretanto—, la baja YA ESTABA
       * HECHA y el jugador se quedaba sin la carta graduada y sin cobrar.
       *
       * Ahora la puerta va delante. el CTE via no escribe nada: sólo comprueba, sobre
       * la fila de la colección YA BLOQUEADA, que la graduada sigue siendo suya
       * y activa y que queda más de una copia. Todo lo que escribe cuelga de
       * ella, así que o pasa entero o no pasa nada.
       *
       * El FOR UPDATE es lo que hace que la comprobación valga: sin él, via
       * leería la instantánea del principio de la sentencia y volveríamos a
       * tener la ventana que se intentaba cerrar.
       *
       * Y EL ANUNCIO DE ESTA GRADUADA, SI LO TIENE, SE BLOQUEA ANTES QUE LA
       * COLECCION. Esta sentencia tomaba primero la fila de la coleccion y al
       * final, en retirada, la del anuncio; la compra del bazar los toma al
       * reves (anuncio, luego coleccion). Vender a la tienda una graduada que
       * alguien estaba comprando en ese instante era un abrazo seguro, y con
       * carga mezclada era la pareja de interbloqueos mas repetida. Ahora las
       * dos piden anuncio y despues coleccion: la que llega segunda espera en
       * el anuncio sin tener nada cogido. El count de bloqueo es lo que fuerza
       * el orden (se evalua en el filtro, por debajo del nodo que bloquea la
       * fila de la coleccion), igual que en comprarSobreAction. */
      WITH anuncioPropio AS MATERIALIZED (
        SELECT b.id
        FROM bazar_listings b
        WHERE b.graded_id = ${gradedId} AND b.seller_id = ${userId}
          AND b.estado = 'activa'
        FOR UPDATE OF b
      ),
      bloqueo AS MATERIALIZED (
        SELECT uc.user_id, uc.card_id, uc.quantity
        FROM user_collection uc
        WHERE uc.user_id = ${userId} AND uc.card_id = ${cardId}
          AND (SELECT count(*) FROM anuncioPropio) >= 0
        FOR UPDATE OF uc
      ),
      via AS MATERIALIZED (
        SELECT 1
        WHERE EXISTS (
          SELECT 1 FROM graded_cards
          WHERE id = ${gradedId} AND user_id = ${userId} AND estado = 'activa'
        )
        AND EXISTS (SELECT 1 FROM bloqueo WHERE quantity > 1)
      ),
      baja AS (
        /* NO SE BORRA: SE MARCA. Y no es por conservar historia, es una guardia.
         *
         * La nota de una copia se deriva de su ÍNDICE, así que si la fila
         * desapareciera al venderse, ese índice quedaría libre y volver a
         * graduarlo daría OTRA VEZ LA MISMA NOTA. Quien sacara un 10 podría
         * venderlo, conseguir otra copia y repetir el mismo 10 sin límite. La
         * fila se queda ocupando su índice para siempre, y el índice único de
         * graded_cards —que no filtra por estado a propósito— es lo que lo
         * impide. */
        UPDATE graded_cards
        SET estado = 'vendida', closed_at = NOW()
        WHERE id = ${gradedId} AND user_id = ${userId} AND estado = 'activa'
          AND EXISTS (SELECT 1 FROM via)
        RETURNING card_id
      ),
      retirada AS (
        /* El anuncio del bazar, si lo hubiera: una carta que ya no está no
         * puede seguir publicada. */
        UPDATE bazar_listings SET estado = 'retirada', closed_at = NOW()
        WHERE graded_id = ${gradedId} AND estado = 'activa'
          AND EXISTS (SELECT 1 FROM baja)
        RETURNING 1
      ),
      consumo AS (
        /* SIN LA CONDICION DE CANTIDAD AQUI, a proposito. Que quede mas de una
         * copia ya lo decidio via sobre la fila BLOQUEADA; repetido aqui se
         * evaluaba contra la version de la INSTANTANEA (un UPDATE no relee las
         * filas que no casaban al empezar), y si la cantidad subia entre medias
         * (la copia suelta se va en un trueque y entra otra por el bazar) via
         * pasaba, la baja de la graduada se hacia y este descuento no tocaba
         * fila: graduada vendida y cero monedas. Era justo el fallo que el
         * comentario de arriba dice haber cerrado. Medido contra PostgreSQL
         * real. */
        UPDATE user_collection
        SET quantity = quantity - 1
        WHERE user_id = ${userId} AND card_id = ${cardId}
          AND EXISTS (SELECT 1 FROM baja)
        RETURNING 1
      )
      UPDATE users SET coins = COALESCE(coins, 0) + ${importe}
      WHERE id = ${userId}
        /* EL CUADRE, EN UNA SOLA EXPRESION (dos condiciones unidas por AND no
         * garantizan el orden en que se evaluan). Si la graduada se dio de baja
         * y la copia no se desconto, el divisor es cero: division por cero, la
         * sentencia entera se deshace y no pasa nada. Si cuadran, vale lo que
         * valia el EXISTS de antes: se abona solo si hubo descuento. */
        AND (SELECT count(*) FROM consumo)
            / (CASE WHEN (SELECT count(*) FROM baja) = (SELECT count(*) FROM consumo)
                    THEN 1 ELSE 0 END) > 0
      RETURNING coins
    `;
    if (rows.length === 0) return { ok: false as const, error: "cambio" as const };

    return { ok: true as const, earned: importe, nota, coins: Number(rows[0]?.coins ?? 0) };
  } catch (e) {
    console.error("venderGraduadaAction error:", e);
    return { ok: false as const, error: "servidor" as const };
  }
}

/* ==================================================================== *
 * BAZAR ENTRE JUGADORES
 * ====================================================================
 *
 * Un jugador publica una carta suya a un precio y otro la compra. Es lo que no
 * existía: el "mercado" de app/mercado (utils/mercado.ts) es un tablón de
 * encargos contra la máquina, sin contraparte humana.
 *
 * TODAS LAS DEFENSAS ANTI-MULTICUENTA ESTÁN EN utils/bazar.ts, con el porqué
 * medido. Aquí sólo se aplican. Lo que NO se puede hacer nunca:
 *   - aceptar el precio sin comprobarlo contra la banda del servidor;
 *   - pagar al vendedor el precio íntegro (la comisión es lo que desangra el
 *     ciclo de lavado);
 *   - dejar publicar a una cuenta recién creada.
 *
 * EL PATRÓN DE DINERO ES EL DEL RESTO DEL FICHERO: cobro, abono y traspaso en
 * UNA sola sentencia, con un CTE árbitro del que cuelgan los demás por EXISTS.
 * Y el candado de user_collection se pide SIEMPRE en el orden (user_id,
 * card_id), que es un invariante global de este repositorio: acceptTradeOffer
 * ordena así y una sentencia que bloqueara al revés se abrazaría con ella.
 */

/**
 * Traduce los rótulos de una lista de ANUNCIOS.
 *
 * POR QUÉ NO VALE `enIdiomaUsuario` A SECAS, y es un fallo que reventaba el
 * bazar entero en español: la capa de traducción agrupa las cartas por
 * expansión, y cuando una carta no trae `set.id` lo deduce partiendo su
 * PROPIO id por el guion (`c.id.indexOf("-")`). Un anuncio tiene `id` de
 * anuncio —un NÚMERO de la secuencia de Postgres—, así que esa línea llamaba a
 * `indexOf` sobre un número y lanzaba TypeError. En inglés no se notaba porque
 * la traducción sale antes de llegar ahí.
 *
 * La salida es proyectar cada anuncio a la forma que la capa espera —id de
 * CARTA y su expansión—, traducir eso, y devolver los rótulos a su sitio. El
 * anuncio conserva su identidad y sus precios intactos.
 */
async function anunciosEnIdiomaUsuario<
  T extends {
    cardId: string;
    setId?: string;
    name: string;
    images: { small: string; large: string };
  },
>(anuncios: T[]): Promise<T[]> {
  if (anuncios.length === 0) return anuncios;
  const comoCartas = anuncios.map((a) => ({
    id: a.cardId,
    name: a.name,
    images: a.images,
    set: { id: a.setId ?? "" },
  }));
  const traducidas = await enIdiomaUsuario(comoCartas);
  return anuncios.map((a, i) => ({
    ...a,
    name: String(traducidas[i]?.name ?? a.name),
    images: traducidas[i]?.images ?? a.images,
  }));
}

/* ==================================================================== *
 * LAS CARRERAS CONOCIDAS QUE NO SE CIERRAN, Y POR QUÉ
 * ====================================================================
 *
 * 1. INTERBLOQUEOS QUE POSTGRES CORTA. Con carga mezclada quedan abrazos que
 *    ninguna ordenación puede evitar, porque nacen de filas que todavía NO
 *    EXISTEN cuando la sentencia toma sus candados: dos sobres del mismo
 *    jugador que estrenan la misma carta, o un sobre y otra escritura que crea
 *    la fila entre medias. Una fila que no existe no se puede bloquear por
 *    adelantado.
 *
 *    SE DEJA ASÍ A SABIENDAS: Postgres DETECTA el interbloqueo y aborta una de
 *    las dos transacciones —no se queda colgado—, el catch de la acción lo
 *    convierte en "servidor" y el jugador vuelve a pulsar. Ninguna de las dos
 *    operaciones se queda a medias, que es lo único que importaba.
 *
 *    (Los abrazos que SÍ eran de orden están cerrados: la compra cruzada —A
 *    compra a B mientras B compra a A— pide ahora las dos filas de `users`
 *    ordenadas por id (CTE `cuentas`); la fila de colección del comprador se
 *    quedaba sin bloquear cuando el vendedor ordenaba antes (CTE `bloqueo`);
 *    `venderGraduadaAction` tomaba colección y anuncio al revés que la compra;
 *    y el vaciado de duplicados tocaba sus filas en el orden que le diera el
 *    plan, no en el de (user_id, card_id). Medido contra PostgreSQL real con
 *    la carga mezclada de siempre.)
 *
 * 2. GRADUAR MIENTRAS SE ACEPTA UN INTERCAMBIO. El CTE `saldo` de
 *    `acceptTradeOffer` resta las copias graduadas, pero ese recuento sale de
 *    la instantánea de la sentencia, no de las filas bloqueadas. Si alguien
 *    gradúa una copia justo mientras acepta un intercambio que regala esa misma
 *    carta, puede quedar una graduada apuntando a una copia que ya no está.
 *
 *    SE DEJA ASÍ A SABIENDAS, y por un motivo concreto: el arreglo obvio —un
 *    guard por fila en el CTE `resta`— convertiría el intercambio en PARCIAL
 *    cuando saltara, y un intercambio a medias crea o destruye cartas. Eso es
 *    peor que el problema. Además `graduarCartasAction` ya bloquea las filas de
 *    user_collection antes de insertar, así que las dos sentencias se serializan
 *    y la ventana es sólo la del recuento. El daño máximo es una carta graduada
 *    fantasma en la vitrina del propio jugador: no imprime dinero.
 *
 * 3. PUBLICAR Y GASTAR LA MISMA CARTA EN EL MISMO INSTANTE. Todas las rutas que
 *    gastan copias cuentan los anuncios abiertos (ver `copiasComprometidas`),
 *    y publicar bloquea la fila de la colección antes de contar. Pero los
 *    RECUENTOS —anuncios y graduadas— salen de la instantánea de cada
 *    sentencia: una venta que arrancó antes de confirmarse la publicación no
 *    ve el anuncio, y dos publicaciones simultáneas de la misma carta suelta no
 *    se ven entre sí. El tope de 20 anuncios tenía la misma holgura; ése sí se
 *    recorta ahora, con `retirarAnunciosPorEncimaDelTope` tras publicar.
 *
 *    SE DEJA ASÍ A SABIENDAS, y con red: cerrarlo de verdad pide que el número
 *    de copias anunciadas viva en la propia fila de user_collection (una
 *    columna nueva que escribirían la publicación, la retirada, la compra y
 *    todas las ventas), que es la fila que Postgres sí relee tras esperar un
 *    candado. Es una migración y media docena de sentencias de dinero más
 *    largas para una ventana de milisegundos cuyo daño máximo es un anuncio que
 *    nadie puede comprar. Ese anuncio ya no es eterno: el escaparate no lo
 *    enseña y `retirarAnunciosSinRespaldo` lo cierra (el barrido de después de
 *    publicar es, de hecho, lo que cierra la doble publicación).
 *
 *    LO QUE SE HA MEDIDO, sin redondear a favor. En 60 carreras
 *    publicar-contra-vender y 60 dobles publicaciones lanzadas sin más, no
 *    quedó ningún anuncio sin respaldo. Pero eso es por el orden natural de
 *    llegada: forzando el entrelazado (la venta con instantánea vieja se
 *    confirma DESPUÉS del barrido de publicar) el anuncio sobrevive 'activa'
 *    con una sola copia, y publicar ya ha contestado ok:true. Lo prometido se
 *    cumple igual —no sale en el escaparate, comprarlo por id no mueve nada y
 *    esa compra lo cierra—, pero hasta que el vendedor abre "mis ventas" ese
 *    anuncio ocupa uno de sus 20 huecos.
 *
 * 4. GRADUAR Y VENDER LA MISMA CARTA EN EL MISMO INSTANTE. Las cuatro ventas a
 *    la tienda cuentan las graduadas con una subconsulta, o sea con la
 *    instantánea de su sentencia, y graduar bloquea la fila de la colección sin
 *    modificarla: la venta que estaba esperando ese candado sigue adelante sin
 *    releer nada y puede dejar más graduadas activas que copias (2 graduadas,
 *    quantity 1). Con carga mezclada aparece en 13 de 101 pasadas.
 *
 *    SE DEJA ASÍ HASTA QUE EL DUEÑO DECIDA, y no imprime dinero: la graduada
 *    fantasma no se puede vender ni anunciar mientras no haya otra copia. El
 *    arreglo es el mismo de la carrera 3 —el recuento de comprometidas en la
 *    fila de user_collection, que escribirían graduar, publicar, retirar,
 *    comprar y vender graduada— y pide una migración con relleno: no es algo
 *    que se cuele en una corrección. Probado en pequeño contra PostgreSQL real:
 *    tocar la fila sin cambiarla NO basta (la relectura es de la fila, no de
 *    las subconsultas); con el recuento en la fila, la venta se rechaza.
 */

/* ==================================================================== *
 * ANUNCIOS SIN RESPALDO: NO SE ENSEÑAN Y SE CIERRAN SOLOS
 * ====================================================================
 *
 * Un anuncio tiene respaldo si `comprarEnBazarAction` lo cobraría AHORA: al
 * vendedor le sobra la copia después de descontar la reservada del álbum y las
 * que tiene en la vitrina. Es, literalmente, la condición de la puerta `via`.
 *
 * DE DÓNDE SALEN LOS QUE NO LO TIENEN:
 *   - de antes de este arreglo: hasta ahora vender, entregar, graduar o
 *     intercambiar la copia anunciada dejaba el anuncio abierto sin nada detrás
 *     (ver `copiasComprometidas`). En producción puede haber de ésos;
 *   - de una carrera que el recuento no puede cerrar: una publicación y una
 *     venta de la misma carta en el mismo instante ven cada una la instantánea
 *     de antes de la otra, y dos publicaciones simultáneas de la misma carta
 *     suelta pasan las dos el guard.
 *
 * QUÉ SE HACE CON ELLOS, en tres sitios y todos baratos:
 *   1. `getBazar` no los enseña: nadie llega a pulsar "Pagar" sobre un anuncio
 *      que va a contestar que no;
 *   2. `retirarAnunciosSinRespaldo` los marca 'retirada'. La llaman
 *      `publicarEnBazarAction` (después de publicar, que es lo que cierra la
 *      doble publicación; y antes, si el vendedor está en el tope de anuncios),
 *      `getMisAnunciosBazar` (el vendedor abre "mis ventas" y sus huecos del
 *      tope de 20 quedan libres) y `comprarEnBazarAction` cuando una compra
 *      descubre que el anuncio no tenía nada detrás;
 *   3. la compra lo dice con `motivo: "sin-respaldo"`, en vez del "o se la ha
 *      llevado otro o no te llega el saldo" que no era ninguna de las dos cosas.
 *
 * DE VARIOS ANUNCIOS SUELTOS DE LA MISMA CARTA SE CIERRAN LOS MÁS NUEVOS: con
 * dos anuncios y respaldo para uno, se queda el primero que se publicó.
 *
 * ES UNA SENTENCIA APARTE Y NO UN CTE DE CADA VENTA, a propósito. Lee una
 * instantánea coherente (cantidad, graduadas y anuncios del mismo instante) y
 * sólo bloquea filas de bazar_listings, en orden de id: no puede abrazarse con
 * la compra, que toma primero el anuncio y luego la colección. Un cierre de
 * más por una instantánea vieja es inofensivo —el vendedor vuelve a publicar—;
 * lo que no puede pasar es que mueva una moneda o una carta, y no toca ninguna.
 */
async function retirarAnunciosSinRespaldo(
  sellerId: string,
  cardId: string | null = null,
): Promise<number[]> {
  const { rows } = await sql.query(
    `WITH abiertos AS (
       /* puesto: que numero de anuncio SUELTO es este entre los de su carta,
        * del mas viejo al mas nuevo. Para un anuncio de graduada no se usa. */
       SELECT b.id, b.card_id, b.graded_id,
              count(*) FILTER (WHERE b.graded_id IS NULL)
                OVER (PARTITION BY b.card_id ORDER BY b.created_at, b.id) AS puesto
       FROM bazar_listings b
       WHERE b.seller_id = $1 AND b.estado = 'activa'
         AND ($2::text IS NULL OR b.card_id = $2::text)
     ),
     estado AS (
       SELECT x.card_id,
              COALESCE((SELECT uc.quantity FROM user_collection uc
                         WHERE uc.user_id = $1 AND uc.card_id = x.card_id), 0) AS quantity,
              (SELECT count(*)::int FROM graded_cards g
                WHERE g.user_id = $1 AND g.card_id = x.card_id
                  AND g.estado = 'activa') AS graduadas
       FROM (SELECT DISTINCT card_id FROM abiertos) x
     ),
     sobran AS (
       SELECT a.id
       FROM abiertos a
       JOIN estado e ON e.card_id = a.card_id
       WHERE CASE
               WHEN a.graded_id IS NULL THEN
                 /* El anuncio suelto numero p necesita su copia, las p-1 de los
                  * anuncios anteriores, la reservada y las de la vitrina. */
                 e.quantity < a.puesto + $3::int + e.graduadas
               ELSE
                 /* El de una graduada: su copia ya va contada en graduadas, y
                  * tiene que quedar ademas la reservada. Y la graduada tiene
                  * que seguir en la vitrina del vendedor. */
                 e.quantity < e.graduadas + $3::int
                 OR NOT EXISTS (
                      SELECT 1 FROM graded_cards g
                       WHERE g.id = a.graded_id AND g.user_id = $1
                         AND g.estado = 'activa')
             END
     ),
     bloqueo AS MATERIALIZED (
       /* En orden de id: dos barridos del mismo vendedor a la vez piden los
        * candados en la misma secuencia y no se abrazan. */
       SELECT b.id
       FROM bazar_listings b
       WHERE b.id IN (SELECT id FROM sobran) AND b.estado = 'activa'
       ORDER BY b.id
       FOR UPDATE OF b
     )
     UPDATE bazar_listings b
        SET estado = 'retirada', closed_at = NOW()
      WHERE b.id IN (SELECT id FROM bloqueo) AND b.estado = 'activa'
     RETURNING b.id`,
    [sellerId, cardId, COPIAS_RESERVADAS],
  );
  return rows.map((r) => Number(r.id));
}

/**
 * Cierra los anuncios MÁS NUEVOS de un vendedor que pasan del tope.
 *
 * EL AGUJERO QUE CIERRA: el tope de MAX_ANUNCIOS_ABIERTOS va dentro del INSERT
 * de `publicarEnBazarAction`, pero el recuento de ese INSERT sale de la
 * instantánea de su sentencia. Varias publicaciones lanzadas a la vez ven
 * todas el mismo número de anuncios abiertos y entran todas: con 15 abiertos
 * y 12 publicaciones simultáneas quedaban 27.
 *
 * Esto se ejecuta DESPUÉS de publicar, en otra sentencia, así que ya ve los
 * anuncios confirmados de las demás. De dos barridos que se crucen, el que
 * tiene la instantánea más nueva ve un superconjunto de lo que ve el otro, y
 * lo que cierra el primero está siempre dentro de lo que cerraría el segundo:
 * entre los dos dejan exactamente el tope, nunca menos.
 *
 * SE QUEDAN LOS MÁS VIEJOS, como en `retirarAnunciosSinRespaldo`. Sólo toca
 * filas de bazar_listings y las bloquea en orden de id, igual que aquél: no
 * puede abrazarse con la compra ni con el otro barrido. No mueve ni una moneda
 * ni una carta: un anuncio es una fila, la copia nunca salió de la colección.
 */
async function retirarAnunciosPorEncimaDelTope(sellerId: string): Promise<number[]> {
  const { rows } = await sql.query(
    `WITH sobran AS (
       SELECT b.id
       FROM bazar_listings b
       WHERE b.seller_id = $1 AND b.estado = 'activa'
       ORDER BY b.created_at, b.id
       OFFSET $2::int
     ),
     bloqueo AS MATERIALIZED (
       SELECT b.id
       FROM bazar_listings b
       WHERE b.id IN (SELECT id FROM sobran) AND b.estado = 'activa'
       ORDER BY b.id
       FOR UPDATE OF b
     )
     UPDATE bazar_listings b
        SET estado = 'retirada', closed_at = NOW()
      WHERE b.id IN (SELECT id FROM bloqueo) AND b.estado = 'activa'
     RETURNING b.id`,
    [sellerId, MAX_ANUNCIOS_ABIERTOS],
  );
  return rows.map((r) => Number(r.id));
}

/** Escaparate: lo que hay a la venta ahora mismo. Funciona sin sesión. */
export async function getBazar(pagina = 0) {
  const POR_PAGINA = 40;
  const desde = Math.max(0, Math.floor(Number(pagina) || 0)) * POR_PAGINA;

  try {
    await ensureSchema();
    const { userId } = await auth();

    const { rows } = await sql`
      SELECT b.id, b.seller_id, b.card_id, b.precio, b.nota, b.graded_id, b.created_at,
             c.name, c.rarity, c.images, c.set_id,
             COALESCE(u.username, 'Entrenador') AS vendedor
      FROM bazar_listings b
      JOIN cards c ON c.id = b.card_id
      LEFT JOIN users u ON u.id = b.seller_id
      WHERE b.estado = 'activa'
        /* SOLO LOS QUE SE PUEDEN COMPRAR. Es la condicion de la puerta de
         * comprarEnBazarAction escrita aqui: al vendedor le sobra la copia
         * despues de la reservada y de las que tiene en la vitrina (la suya no
         * cuenta si lo que se anuncia ES una graduada). Sin esto, el escaparate
         * ensenaba anuncios a los que toda compra contestaba que no. */
        AND EXISTS (
          SELECT 1 FROM user_collection uc
          WHERE uc.user_id = b.seller_id AND uc.card_id = b.card_id
            AND uc.quantity > ${COPIAS_RESERVADAS} + (
              SELECT count(*) FROM graded_cards g
              WHERE g.user_id = b.seller_id AND g.card_id = b.card_id
                AND g.estado = 'activa'
                AND (b.graded_id IS NULL OR g.id <> b.graded_id)
            )
        )
        AND (
          b.graded_id IS NULL
          OR EXISTS (
            SELECT 1 FROM graded_cards g
            WHERE g.id = b.graded_id AND g.user_id = b.seller_id AND g.estado = 'activa'
          )
        )
      ORDER BY b.created_at DESC
      LIMIT ${POR_PAGINA} OFFSET ${desde}
    `;

    const anuncios = rows.map((r: any) => ({
      id: Number(r.id),
      cardId: String(r.card_id),
      name: String(r.name ?? ""),
      rarity: String(r.rarity ?? "Common"),
      images: aImagenes(r.images),
      setId: String(r.set_id ?? ""),
      precio: Number(r.precio),
      nota: r.nota === null || r.nota === undefined ? null : Number(r.nota),
      graduada: r.graded_id !== null && r.graded_id !== undefined,
      /* EL NOMBRE DEL VENDEDOR SÓLO VIAJA CON SESIÓN. El escaparate funciona
       * sin cuenta, y sin esto cualquier visitante leía los nombres (el
       * username o el nombre de pila de Clerk) de quienes venden, cuando la
       * búsqueda de entrenadores —que da ese mismo dato— exige sesión. El campo
       * se conserva con el rótulo genérico para que la tarjeta se pinte igual. */
      vendedor: userId ? String(r.vendedor ?? "Entrenador") : "Entrenador",
      // Para que la pantalla pueda pintar "tuyo" y no ofrecer comprarte a ti
      // mismo. La comprobación de verdad está en comprarEnBazarAction.
      esMio: Boolean(userId) && String(r.seller_id) === userId,
      comision: comisionDe(Number(r.precio)),
    }));

    return {
      ok: true as const,
      anuncios: await anunciosEnIdiomaUsuario(anuncios),
      pagina: Math.floor(Number(pagina) || 0),
    };
  } catch (e) {
    console.error("getBazar error:", e);
    return { ok: false as const, error: "servidor" as const };
  }
}

/**
 * Publica una carta en el bazar.
 *
 * `gradedId` opcional: publicar una carta graduada en vez de una suelta. Es la
 * segunda mitad de "el jugador decide si vende o guarda" — puede quedársela en
 * la vitrina, venderla a la tienda por su multiplicador, o ponerla aquí y que
 * otro pague lo que crea que vale.
 */
export async function publicarEnBazarAction(
  cardId: string,
  precio: number,
  gradedId?: number | null,
) {
  const { userId } = await auth();
  if (!userId) return { ok: false as const, error: "no-autorizado" as const };
  if (typeof cardId !== "string" || !ID_CARTA.test(cardId)) {
    return { ok: false as const, error: "peticion" as const };
  }
  const precioPedido = Math.floor(Number(precio));
  if (!Number.isInteger(precioPedido) || precioPedido <= 0) {
    return { ok: false as const, error: "precio" as const };
  }
  const idGraduada =
    gradedId === null || gradedId === undefined ? null : Math.floor(Number(gradedId));
  if (idGraduada !== null && (!Number.isInteger(idGraduada) || idGraduada <= 0)) {
    return { ok: false as const, error: "peticion" as const };
  }
  // Tope de frecuencia (services/limite.ts). Con el error que la pantalla ya
  // sabe pintar ("inténtalo de nuevo") y un campo opcional que dice por qué.
  if (!dentroDelLimite("publicar:" + userId, LIMITES.publicarEnBazar)) {
    return { ok: false as const, error: "servidor" as const, limitado: true as const };
  }

  try {
    await ensureSchema();

    // ANTIGÜEDAD: una cuenta recién creada no vende. Ver utils/bazar.ts.
    const { rows: quien } = await sql`
      SELECT COALESCE(packs_opened, 0) AS sobres,
             (SELECT count(*) FROM bazar_listings
               WHERE seller_id = ${userId} AND estado = 'activa') AS abiertos
      FROM users WHERE id = ${userId}
    `;
    if (quien.length === 0) return { ok: false as const, error: "no-autorizado" as const };
    if (Number(quien[0].sobres) < SOBRES_PARA_VENDER) {
      return {
        ok: false as const,
        error: "novato" as const,
        faltan: SOBRES_PARA_VENDER - Number(quien[0].sobres),
      };
    }
    if (Number(quien[0].abiertos) >= MAX_ANUNCIOS_ABIERTOS) {
      /* EN EL TOPE: antes de decir que no, se cierran los anuncios que ya no
       * tienen nada detrás (ver `retirarAnunciosSinRespaldo`). Un anuncio que
       * nadie puede comprar no puede seguir ocupando uno de los 20 huecos: era
       * la otra mitad del anuncio zombi, y sin esto quien tuviera veinte de
       * antes del arreglo no podría volver a publicar hasta retirarlos a mano
       * uno a uno. Esto sólo es el aviso temprano; el tope que decide va dentro
       * del INSERT de más abajo. */
      let liberados = 0;
      try {
        liberados = (await retirarAnunciosSinRespaldo(userId)).length;
      } catch (e) {
        console.error("publicarEnBazarAction: no se pudieron cerrar anuncios sin respaldo:", e);
      }
      if (Number(quien[0].abiertos) - liberados >= MAX_ANUNCIOS_ABIERTOS) {
        return { ok: false as const, error: "demasiados-anuncios" as const };
      }
    }

    // El VALOR lo calcula el servidor contra la rareza de la base de datos y el
    // precio real del día. El cliente no puede sugerirlo ni influir en él.
    const { rows: info } = await sql`
      SELECT c.rarity, COALESCE(uc.quantity, 0) AS quantity
      FROM cards c
      LEFT JOIN user_collection uc ON uc.card_id = c.id AND uc.user_id = ${userId}
      WHERE c.id = ${cardId}
    `;
    if (info.length === 0) return { ok: false as const, error: "no-existe" as const };

    const eur = await euroDeCarta(cardId);
    let valor = precioDeCartaSuelta(info[0].rarity, eur);
    let nota: number | null = null;

    if (idGraduada !== null) {
      // Publicar una graduada: tiene que ser suya y estar libre.
      const { rows: g } = await sql`
        SELECT nota FROM graded_cards
         WHERE id = ${idGraduada} AND user_id = ${userId} AND card_id = ${cardId}
           -- Una copia ya vendida conserva su fila (para que su indice no se
           -- recicle) pero no se puede volver a publicar.
           AND estado = 'activa'
      `;
      if (g.length === 0) return { ok: false as const, error: "no-existe" as const };
      nota = Number(g[0].nota);
      // El valor de referencia de la banda es el YA multiplicado por la nota:
      // un 10 vale casi el doble (×1,95), y si la banda se calculase sobre el valor sin
      // graduar, publicar un 10 al precio que le corresponde sería imposible.
      //
      // Sale de la MISMA función que pinta la hoja de publicar (getVitrina
      // devuelve `valorDeReferencia`), que es lo que garantiza que el precio
      // que ofrece el deslizador caiga siempre dentro de la banda que se
      // comprueba aquí. Con la fórmula escrita dos veces, bastaba con que una
      // de las dos cambiara para que el jugador viera "ese precio no vale".
      valor = valorDeReferenciaGraduada(info[0].rarity, nota, eur);
      if (valor <= 0) return { ok: false as const, error: "sin-valor" as const };
    }

    if (!precioValido(precioPedido, valor)) {
      const banda = bandaDePrecio(valor);
      return { ok: false as const, error: "precio" as const, banda };
    }

    /* LA COPIA RESERVADA, en el guard del INSERT y no antes: publicar una carta
     * exige que SOBRE una copia, igual que en el mercado. Para las graduadas la
     * cuenta ya la lleva el índice único parcial de bazar_listings, que impide
     * que una misma copia graduada esté en dos anuncios a la vez. */
    const { rows } = await sql`
      /* LA FILA DE LA COLECCION SE BLOQUEA ANTES DE CONTAR.
       *
       * El guard de abajo era un EXISTS a secas, o sea la instantanea del
       * principio de la sentencia: una venta de esa misma carta que se
       * confirmase mientras tanto no se veia, y el anuncio se creaba sobre una
       * copia que ya no estaba. Con FOR UPDATE esta sentencia espera a la venta
       * y lee la cantidad YA descontada (Postgres relee la fila bloqueada).
       *
       * Es el mismo candado, sobre la misma fila, que toman las ventas, la
       * graduacion y la compra del bazar: publicar entra en esa cola en vez de
       * colarse. Y es el UNICO candado de la sentencia, asi que no puede
       * abrazarse con nadie.
       *
       * Lo que NO cierra, y por eso existe retirarAnunciosSinRespaldo: el
       * recuento de anuncios y de graduadas sigue saliendo de la instantanea.
       * Dos publicaciones simultaneas de la misma carta se ponen en fila aqui,
       * pero la segunda no ve el anuncio de la primera; lo ve el barrido que se
       * lanza justo despues, en otra sentencia. */
      WITH bloqueo AS MATERIALIZED (
        SELECT uc.quantity
        FROM user_collection uc
        WHERE uc.user_id = ${userId} AND uc.card_id = ${cardId}
        FOR UPDATE OF uc
      )
      INSERT INTO bazar_listings (seller_id, card_id, graded_id, nota, precio, comision)
      SELECT ${userId}, ${cardId}, ${idGraduada}, ${nota}, ${precioPedido}, ${comisionDe(precioPedido)}
      /* LO QUE TIENE QUE SOBRAR, y el recuento es más largo de lo que parece.
       *
       * Una copia sólo se puede publicar si NO está comprometida en otro sitio.
       * Están comprometidas: la copia protegida del álbum, las que ya tienen
       * otro anuncio abierto, y —esto faltaba y era una fuga— LAS GRADUADAS,
       * que viven en la vitrina. Sin restarlas, un jugador con dos copias, una
       * de ellas graduada, podía publicar la otra, venderla, y dejar quantity
       * en 1 con una fila de graded_cards apuntándola: la carta quedaba a la
       * vez en la vitrina y vendida.
       *
       * EXCEPCIÓN: si lo que se publica ES la copia graduada (graded_id no es
       * nulo), esa copia sí está disponible — es justo la que se vende. Por eso
       * se descuenta una del recuento de graduadas en ese caso. Que no esté ya
       * publicada lo impide el índice único parcial de bazar_listings. */
      WHERE EXISTS (
        SELECT 1 FROM bloqueo uc
        WHERE uc.quantity > (
            SELECT count(*) FROM bazar_listings
            WHERE seller_id = ${userId} AND card_id = ${cardId}
              AND estado = 'activa' AND graded_id IS NULL
          ) + (
            SELECT count(*) FROM graded_cards
            WHERE user_id = ${userId} AND card_id = ${cardId} AND estado = 'activa'
          ) - CASE WHEN ${idGraduada}::int IS NULL THEN 0 ELSE 1 END
          + ${COPIAS_RESERVADAS}
      )
      /* EL TOPE DE ANUNCIOS, DENTRO DEL INSERT. Antes solo se leia arriba, en
       * otra sentencia: entre aquella lectura y este INSERT cabian todas las
       * publicaciones que se quisieran lanzar en paralelo, y las veinte que
       * pasaban la lectura con 19 abiertos entraban todas. */
      AND (
        SELECT count(*) FROM bazar_listings
        WHERE seller_id = ${userId} AND estado = 'activa'
      ) < ${MAX_ANUNCIOS_ABIERTOS}
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    if (rows.length === 0) {
      // No entró: o no sobraba copia, o el vendedor ya está en el tope. Se
      // pregunta cuál de las dos para no decirle "no te sobran copias" a quien
      // lo que tiene son veinte anuncios abiertos.
      const { rows: tope } = await sql`
        SELECT count(*)::int AS n FROM bazar_listings
        WHERE seller_id = ${userId} AND estado = 'activa'
      `;
      if (Number(tope[0]?.n ?? 0) >= MAX_ANUNCIOS_ABIERTOS) {
        return { ok: false as const, error: "demasiados-anuncios" as const };
      }
      return { ok: false as const, error: "sin-copias" as const };
    }

    /* Y DESPUÉS DE PUBLICAR, LOS DOS BARRIDOS. Son lo que cierra la doble
     * publicación: dos peticiones a la vez pasan las dos el guard (cada una
     * cuenta los anuncios de ANTES de la otra), pero la que barra en segundo
     * lugar ya ve los dos anuncios confirmados y cierra el que sobra.
     *
     *  - el de la carta (`retirarAnunciosSinRespaldo`): dos publicaciones de la
     *    MISMA copia suelta;
     *  - el del tope (`retirarAnunciosPorEncimaDelTope`): publicaciones de
     *    cartas DISTINTAS lanzadas a la vez con el vendedor a punto de llenar
     *    sus huecos. El recuento del INSERT sale de su instantánea, así que
     *    todas veían "19 abiertos" y entraban todas (medido: 27 anuncios con un
     *    tope de 20).
     *
     * Y LA RESPUESTA SALE DE CÓMO HA QUEDADO EL ANUNCIO, NO DE LO QUE CERRÓ ESTE
     * BARRIDO. Antes se miraba si el id propio estaba en la lista de cerrados
     * de la llamada de aquí; pero si lo había cerrado el barrido de la OTRA
     * publicación (o una compra fallida), esa lista venía vacía y se contestaba
     * ok:true con el id de un anuncio ya retirado: en 49 de 60 dobles
     * publicaciones contra PostgreSQL real. Ahora se lee el estado, que no
     * depende de quién barrió.
     *
     * Un fallo aquí no deshace la publicación; el anuncio sin respaldo, si lo
     * hubiera, no se enseña y se cierra en el siguiente barrido. */
    try {
      await retirarAnunciosSinRespaldo(userId, cardId);
      const porTope = await retirarAnunciosPorEncimaDelTope(userId);
      const { rows: comoQuedo } = await sql`
        SELECT estado FROM bazar_listings WHERE id = ${Number(rows[0].id)}
      `;
      if (comoQuedo[0]?.estado === "retirada") {
        return porTope.includes(Number(rows[0].id))
          ? { ok: false as const, error: "demasiados-anuncios" as const }
          : { ok: false as const, error: "sin-copias" as const };
      }
    } catch (e) {
      console.error("publicarEnBazarAction: barrido tras publicar:", e);
    }

    return {
      ok: true as const,
      id: Number(rows[0].id),
      precio: precioPedido,
      cobrarias: pagoAlVendedor(precioPedido),
      comision: comisionDe(precioPedido),
    };
  } catch (e) {
    console.error("publicarEnBazarAction error:", e);
    return { ok: false as const, error: "servidor" as const };
  }
}

/** Retira un anuncio propio. La carta nunca se movió: sólo se cierra la fila. */
export async function retirarDelBazarAction(anuncioId: number) {
  const { userId } = await auth();
  if (!userId) return { ok: false as const, error: "no-autorizado" as const };
  if (!Number.isInteger(anuncioId) || anuncioId <= 0) {
    return { ok: false as const, error: "peticion" as const };
  }
  try {
    await ensureSchema();
    const { rowCount } = await sql`
      UPDATE bazar_listings SET estado = 'retirada', closed_at = NOW()
      WHERE id = ${anuncioId} AND seller_id = ${userId} AND estado = 'activa'
    `;
    // rowCount 0 significa que no era suyo o que ya estaba cerrado. Se dice, en
    // vez de cantar éxito sobre algo que no ocurrió.
    if (!rowCount) return { ok: false as const, error: "no-existe" as const };
    return { ok: true as const };
  } catch (e) {
    console.error("retirarDelBazarAction error:", e);
    return { ok: false as const, error: "servidor" as const };
  }
}

/**
 * Compra un anuncio del bazar.
 *
 * TODO EN UNA SENTENCIA, y el orden de los CTE importa:
 *   `anuncio`  toma el anuncio con FOR UPDATE — es el cerrojo: dos compradores
 *              simultáneos se serializan aquí y sólo uno lo ve 'activa'.
 *   `bloqueo`  bloquea las filas de user_collection de LOS DOS usuarios, en
 *              orden (user_id, card_id), que es el orden global del repositorio.
 *   `respaldo` ¿le sobra la copia al vendedor? Va aparte de `via` para poder
 *              decir POR QUÉ no se vendió (ver `motivo` más abajo).
 *   `via`      la puerta: anuncio vivo, vendedor con copia y comprador con saldo.
 *   `cobro`    EL ÁRBITRO. Es el primer CTE que escribe y cuelga de `via`: relee
 *              el saldo sobre la fila que bloquea, así que si el dinero ya no
 *              está no toca fila y NADA de lo que sigue ocurre.
 *   el resto   cierre del anuncio (cuelga de `cobro`), abono al vendedor
 *              (cuelga de `cierre`), traspaso de la carta y —si era graduada—
 *              baja de la fila del vendedor y alta de una NUEVA para el
 *              comprador (la fila no se mueve nunca: ver el CTE `traspaso`).
 *
 * EL ORDEN cobro → cierre → abono ES EL ARREGLO DE UN FALLO: antes el cierre
 * iba delante y colgaba sólo de `via`, que lee el saldo de la instantánea. Un
 * comprador con saldo para UN anuncio que lanzase varias compras a la vez las
 * pasaba todas por `via`; las que perdían el cobro dejaban anuncios AJENOS
 * marcados 'vendida' a su nombre sin mover ni una carta ni una moneda, y el
 * vendedor leía "Cobraste X" en sus ventas. Ahora el anuncio sólo se cierra si
 * se cobró.
 *
 * SI NO SE VENDE, la respuesta sigue siendo `error: "no-disponible"` y lleva
 * además `motivo`: "vendido" (ya no está activo: se lo llevó otro o se retiró),
 * "sin-respaldo" (el vendedor ya no tiene la copia; el anuncio se cierra en ese
 * mismo momento) o "sin-saldo".
 *
 * LA COMISIÓN SE DESTRUYE: al vendedor se le abona `pagoAlVendedor(precio)` y al
 * comprador se le cobra `precio`. La diferencia no va a ninguna cuenta. Es
 * intencionado y es la defensa nº 2 de utils/bazar.ts.
 */
export async function comprarEnBazarAction(anuncioId: number) {
  const { userId } = await auth();
  if (!userId) return { ok: false as const, error: "no-autorizado" as const };
  if (!Number.isInteger(anuncioId) || anuncioId <= 0) {
    return { ok: false as const, error: "peticion" as const };
  }
  // Tope de frecuencia (services/limite.ts). "servidor" es el error que la
  // pantalla ya pinta como "no se ha movido nada", que aquí es verdad.
  if (!dentroDelLimite("comprar-bazar:" + userId, LIMITES.comprarEnBazar)) {
    return { ok: false as const, error: "servidor" as const, limitado: true as const };
  }

  try {
    await ensureSchema();

    /* LA BARRERA DEL COMPRADOR. Ver SOBRES_PARA_COMPRAR en utils/bazar.ts: es
     * el comprador, y no el vendedor, quien recorre la dirección por la que se
     * lavarían monedas entre dos cuentas de la misma persona. La barrera de
     * vender, sola, protegía la dirección equivocada. */
    const { rows: comprador } = await sql`
      SELECT COALESCE(packs_opened, 0) AS sobres FROM users WHERE id = ${userId}
    `;
    if (comprador.length === 0) return { ok: false as const, error: "no-autorizado" as const };
    if (Number(comprador[0].sobres) < SOBRES_PARA_COMPRAR) {
      return {
        ok: false as const,
        error: "novato" as const,
        faltan: SOBRES_PARA_COMPRAR - Number(comprador[0].sobres),
      };
    }

    const { rows: previo } = await sql`
      SELECT seller_id, precio, card_id FROM bazar_listings
      WHERE id = ${anuncioId} AND estado = 'activa'
    `;
    if (previo.length === 0) return { ok: false as const, error: "no-existe" as const };
    if (String(previo[0].seller_id) === userId) {
      return { ok: false as const, error: "es-tuyo" as const };
    }

    const precio = Number(previo[0].precio);
    const paga = pagoAlVendedor(precio);

    const { rows } = await sql.query(
      `WITH anuncio AS (
         /* EL CERROJO. Dos compradores simultáneos se serializan aquí: el
          * segundo espera, y al despertar la fila ya no está 'activa'. */
         SELECT id, seller_id, card_id, graded_id, precio
         FROM bazar_listings
         WHERE id = $1 AND estado = 'activa'
         FOR UPDATE
       ),
       /* CANDADOS SOBRE LAS FILAS DE LOS DOS USUARIOS, EN EL ORDEN GLOBAL.
        *
        * MATERIALIZED es obligatorio: sin él, Postgres puede meter este CTE
        * dentro de los que lo usan y ejecutar el FOR UPDATE más de una vez, o
        * en otro orden. El orden (user_id, card_id) es un invariante de todo el
        * repositorio —acceptTradeOffer bloquea igual— y una sentencia que
        * bloqueara al revés se abrazaría con ella.
        *
        * Y TIENE QUE LEERSE ENTERO, que no es lo mismo que estar escrito. Un
        * CTE con FOR UPDATE solo bloquea las filas que alguien llega a LEER, y
        * quien lo lee es respaldo, al que via pregunta con un EXISTS que para
        * en la primera fila. Cuando el vendedor ordena antes que el comprador,
        * esa primera fila es la suya y la del comprador se quedaba SIN
        * bloquear: la tomaba pon al final, DESPUES de users, o sea en el orden
        * contrario al de todas las ventas. Una venta del comprador de esa misma
        * carta en otra pestana (coleccion y luego users) se abrazaba con su
        * compra siempre, no a veces. Por eso respaldo lleva un count(*) de este
        * CTE: lo recorre hasta el final antes de que nadie toque users. Es el
        * mismo truco que el cobro de comprarSobreAction. */
       bloqueo AS MATERIALIZED (
         SELECT uc.user_id, uc.card_id, uc.quantity
         FROM user_collection uc
         JOIN anuncio a ON a.card_id = uc.card_id
         WHERE uc.user_id IN ($2, (SELECT seller_id FROM anuncio))
         ORDER BY uc.user_id, uc.card_id
         FOR UPDATE OF uc
       ),
       /* CUÁNTAS COPIAS TIENE EL VENDEDOR COMPROMETIDAS EN LA VITRINA.
        *
        * Esto faltaba y era una fuga: sin restarlas, vender un anuncio normal
        * podía dejar quantity por debajo del número de filas de graded_cards,
        * y las graduadas quedaban apuntando a copias que ya no existen.
        *
        * La copia que se vende NO cuenta si el anuncio ES de una graduada: en
        * ese caso la copia comprometida es justo la que cambia de manos. */
       comprometidas AS (
         SELECT COALESCE(count(*), 0)::int AS n
         FROM graded_cards g, anuncio a
         WHERE g.user_id = a.seller_id AND g.card_id = a.card_id
           AND g.estado = 'activa'
           AND (a.graded_id IS NULL OR g.id <> a.graded_id)
       ),
       /* EL RESPALDO: al vendedor le tiene que sobrar la copia DESPUÉS de
        * descontar la reservada y las que están en su vitrina, sobre la fila ya
        * bloqueada. Va en su propio CTE, y no dentro de via, para que la
        * respuesta pueda distinguir "el vendedor ya no la tiene" de "no te
        * llega el saldo": con las dos cosas en la misma puerta, el comprador de
        * un anuncio sin nada detras leia que le faltaba dinero.
        *
        * Y si lo anunciado es una graduada, su fila tiene que seguir activa y
        * ser del vendedor. Hoy no hay camino que la cierre dejando el anuncio
        * abierto (venderGraduadaAction lo retira en la misma sentencia), pero
        * sin esta linea, el dia que lo hubiera, la compra cobraria el precio de
        * una graduada y entregaria una copia suelta: traspaso no tocaria fila
        * y todo lo demas seguiria adelante. */
       respaldo AS MATERIALIZED (
         SELECT 1
         FROM bloqueo b, anuncio a
         WHERE b.user_id = a.seller_id AND b.card_id = a.card_id
           -- Siempre cierto (un recuento no es negativo): esta aqui para que
           -- bloqueo se lea ENTERO antes de cobrar. Ver su comentario.
           AND (SELECT count(*) FROM bloqueo) >= 0
           AND b.quantity > $4::int + (SELECT n FROM comprometidas)
           AND (
             a.graded_id IS NULL
             OR EXISTS (
               SELECT 1 FROM graded_cards g
               WHERE g.id = a.graded_id AND g.user_id = a.seller_id
                 AND g.estado = 'activa'
             )
           )
       ),
       /* LAS DOS FILAS DE users, EN ORDEN DE id Y ANTES DE ESCRIBIR NADA.
        *
        * EL ABRAZO QUE CIERRA: cobro toca la fila del comprador y abono, mas
        * abajo, la del vendedor. Si A le compra a B y B le compra a A en el
        * mismo instante, cada sentencia tenia la suya y pedia la del otro:
        * interbloqueo, y una de las dos compras contestaba servidor. Estaba
        * documentado como carrera conocida con el argumento de que no se podia
        * ordenar por id porque quien vende no se sabe hasta leer el anuncio.
        * Pero aqui el anuncio YA esta leido y bloqueado: se piden las dos filas
        * juntas, ordenadas, y las dos compras cruzadas las piden en el mismo
        * orden. La segunda espera a la primera sin tener cogida ninguna.
        *
        * SOLO SI HAY RESPALDO: sin anuncio vivo o sin copia detras no se va a
        * cobrar, y no hace falta bloquear a nadie. Y ese EXISTS es ademas lo
        * que fuerza el orden global: respaldo recorre bloqueo entero, asi que
        * las filas de user_collection estan tomadas antes que estas.
        *
        * MATERIALIZED, como los demas candados, y via lo lee ENTERO (count)
        * antes de preguntarle nada: un EXISTS a secas pararia en la primera
        * fila y dejaria la otra sin bloquear, que es exactamente el fallo que
        * tenia bloqueo. */
       cuentas AS MATERIALIZED (
         SELECT u.id, u.coins
         FROM users u
         WHERE u.id IN ($2, (SELECT seller_id FROM anuncio))
           AND EXISTS (SELECT 1 FROM respaldo)
         ORDER BY u.id
         FOR UPDATE OF u
       ),
       via AS MATERIALIZED (
         /* LA PUERTA ÚNICA: anuncio vivo, vendedor con copia y con fila en
          * users (sin ella el abono no tocaria nada y el comprador pagaria por
          * una carta que no se mueve), y comprador con saldo. Las dos cosas de
          * users se miran en cuentas, o sea sobre las filas ya bloqueadas. */
         SELECT 1
         WHERE EXISTS (SELECT 1 FROM anuncio)
           AND EXISTS (SELECT 1 FROM respaldo)
           AND (SELECT count(*) FROM cuentas) >= 0
           AND EXISTS (
             SELECT 1 FROM cuentas c, anuncio a WHERE c.id = a.seller_id
           )
           AND EXISTS (
             SELECT 1 FROM cuentas c
             WHERE c.id = $2 AND COALESCE(c.coins, 0) >= $3::int
           )
       ),
       cobro AS (
         /* EL ÁRBITRO, Y POR ESO VA EL PRIMERO DE LOS QUE ESCRIBEN.
          *
          * LA COMPROBACIÓN DE SALDO SE REPITE AQUÍ, Y SE QUEDA. Desde que
          * 'cuentas' bloquea la fila, 'via' ya mira el saldo confirmado y no
          * una instantánea vieja; pero este guard es el que hace que el cobro
          * no pueda dejar un saldo negativo pase lo que pase con los CTE de
          * arriba, y falla CERRADO: si no casa, este UPDATE no toca fila, y
          * como todo lo demás cuelga de él no se mueve nada.
          *
          * Y TODO LO DEMAS CUELGA DE AQUI. Antes el cierre del anuncio iba
          * delante, colgando solo de 'via': cuando el cobro no tocaba fila, el
          * anuncio YA estaba marcado 'vendida' a nombre del comprador, sin
          * pago ni traspaso, y no se podia volver a comprar. En Postgres todos
          * los CTE que escriben se ejecutan aunque nadie los lea, asi que el
          * unico orden seguro es que cada escritura cuelgue de la anterior. */
         UPDATE users SET coins = COALESCE(coins, 0) - $3::int
         WHERE id = $2
           AND COALESCE(coins, 0) >= $3::int
           AND EXISTS (SELECT 1 FROM via)
         RETURNING coins
       ),
       cierre AS (
         /* Solo si se cobró. La fila del anuncio la tiene bloqueada esta misma
          * sentencia (CTE anuncio) y sigue 'activa', asi que si hubo cobro este
          * UPDATE toca fila siempre: no añade ningun candado nuevo. */
         UPDATE bazar_listings
         SET estado = 'vendida', buyer_id = $2, closed_at = NOW()
         WHERE id = $1 AND estado = 'activa' AND EXISTS (SELECT 1 FROM cobro)
         RETURNING card_id, graded_id
       ),
       abono AS (
         UPDATE users SET coins = COALESCE(coins, 0) + $5::int
         WHERE id = (SELECT seller_id FROM anuncio) AND EXISTS (SELECT 1 FROM cierre)
         RETURNING 1
       ),
       quita AS (
         UPDATE user_collection uc
         SET quantity = uc.quantity - 1
         FROM anuncio a
         WHERE uc.user_id = a.seller_id AND uc.card_id = a.card_id
           /* SIN GUARD DE CANTIDAD PROPIO, Y ES A PROPOSITO. Aqui hubo uno
            * (el mismo quantity mayor que reservada mas comprometidas de
            * respaldo), con un comentario que decia que se evaluaba sobre la
            * fila que este UPDATE bloquea. No era verdad, y costaba dinero.
            *
            * Un UPDATE busca sus filas en la INSTANTANEA de la sentencia y solo
            * relee la version nueva de las que ya casaban con la vieja. Si la
            * cantidad SUBE entre la instantanea y el candado (al vendedor le
            * entra otra copia justo entonces), respaldo decide que si sobre la
            * version confirmada que devuelve el FOR UPDATE, pero la version
            * vieja no cumple el guard y este UPDATE ni la mira: no toca fila.
            * Para entonces el comprador ya ha pagado, el anuncio ya esta
            * vendida y el vendedor ya ha cobrado. Medido contra PostgreSQL real:
            * comprador 1000 a 930 monedas y 0 copias, vendedor +59 y 2 copias.
            *
            * La decision ya esta tomada, y bien tomada: respaldo miro la fila
            * BLOQUEADA, que sigue bloqueada por esta misma sentencia hasta el
            * final, asi que entre aquella comprobacion y este descuento nadie
            * puede cambiarla. Repetir el guard no anadia nada y quitaba la
            * carta de la operacion. Y por si algun dia otra cosa dejara este
            * UPDATE sin fila, el SELECT final lleva un cuadre que deshace la
            * sentencia entera. */
           AND EXISTS (SELECT 1 FROM abono)
         RETURNING 1
       ),
       pon AS (
         INSERT INTO user_collection (user_id, card_id, quantity)
         SELECT $2, a.card_id, 1 FROM anuncio a
         WHERE EXISTS (SELECT 1 FROM quita)
         ON CONFLICT (user_id, card_id) DO UPDATE
           SET quantity = user_collection.quantity + EXCLUDED.quantity
         RETURNING 1
       ),
       traspaso AS (
         /* SI ERA UNA GRADUADA, SU NOTA VIAJA CON ELLA, PERO LA FILA NO SE MUEVE.
          *
          * ESTO ERA UNA IMPRENTA DE NOTAS. Antes esta fila se MOVÍA: se le
          * cambiaba el user_id al comprador y se le recalculaba la copia. Al
          * hacerlo, el hueco (vendedor, carta, copia) quedaba LIBRE — y ese
          * hueco es exactamente lo que el índice único de graded_cards existe
          * para no soltar jamás (services/esquemaMejoras.ts lo documenta junto a idx_graded_cards_copia,
          * y por eso el índice NO filtra por estado). Como la nota es
          * determinista a partir del índice (semilla secreto|usuario|carta|copia),
          * con el hueco libre el vendedor volvía a graduar, el bucle de
          * graduarCartasAction volvía a tomar el índice más bajo libre y salía
          * OTRA VEZ LA MISMA NOTA: un 10 se repetía indefinidamente vendiéndolo
          * en el bazar y consiguiendo otra copia. Es la misma fuga que
          * venderGraduadaAction ya cerraba marcando en vez de borrar; por el
          * bazar seguía abierta.
          *
          * AHORA SE CIERRA IGUAL QUE UNA VENTA A LA TIENDA: la fila del vendedor
          * se marca 'vendida' CONSERVANDO su user_id y su copia, así que su
          * hueco queda ocupado para siempre, y al comprador se le da una fila
          * NUEVA (CTE 'entrega').
          *
          * bazar_listings.graded_id SIGUE APUNTANDO A LA FILA DEL VENDEDOR, que
          * ya está 'vendida', y es lo correcto: ese campo dice QUÉ COPIA se
          * publicó, no quién la tiene hoy. Ninguna consulta se rompe —getBazar
          * sólo mira si es NULL para pintar "graduada", el índice único parcial
          * de bazar_listings sólo cubre anuncios 'activa' (y éste queda
          * 'vendida'), el 'retirada' de venderGraduadaAction busca anuncios
          * activos y aquí no queda ninguno, y publicarEnBazarAction exige
          * estado='activa' en la graduada, así que el vendedor no puede
          * republicar la que acaba de vender.
          *
          * El guard de propiedad va aquí dentro: si la fila ya no fuera del
          * vendedor, no se traspasa nada. */
         UPDATE graded_cards g
         SET estado = 'vendida', closed_at = NOW()
         FROM anuncio a
         WHERE g.id = a.graded_id
           AND g.user_id = a.seller_id
           AND g.estado = 'activa'
           AND EXISTS (SELECT 1 FROM pon)
         RETURNING g.card_id, g.nota, g.coste
       ),
       entrega AS (
         /* LA COPIA DEL COMPRADOR. Lee de 'traspaso', así que cuelga de él: si
          * la baja del vendedor no tocó fila, aquí no se inserta nada. Una nota
          * no puede duplicarse ni aparecer de la nada.
          *
          * NOTA Y COSTE SE COPIAN TAL CUAL: es la misma carta física, sería
          * absurdo que cambiara de estado al cambiar de dueño, y la nota está
          * guardada en la fila justo para no recalcularla (recalcularla con la
          * semilla del COMPRADOR daría otra nota distinta de la que compró).
          *
          * EL ÍNDICE DE COPIA ES EL SIGUIENTE POR ENCIMA DE TODOS LOS DEL
          * COMPRADOR para esa carta —activos y vendidos, porque el índice único
          * no distingue— y no un MAX de los activos, que sí podría colisionar.
          *
          * Y NO LLEVA ON CONFLICT A PROPÓSITO: si otra sentencia concurrente le
          * hubiera dado al comprador ese mismo índice entre medias, el choque
          * revienta la sentencia ENTERA y no se mueve ni una moneda. Un
          * DO NOTHING haría lo contrario: cobrar la compra y dejar al comprador
          * sin la nota que pagó. Mejor una compra que falla y se reintenta.
          *
          * graded_at se queda en su DEFAULT NOW(): es cuándo entró en ESTA
          * vitrina, y no lo lee nadie para calcular dinero. */
         INSERT INTO graded_cards (user_id, card_id, copia, nota, coste)
         SELECT $2, t.card_id,
                (SELECT COALESCE(MAX(g2.copia), 0) + 1
                   FROM graded_cards g2
                  WHERE g2.user_id = $2 AND g2.card_id = t.card_id),
                t.nota, t.coste
         FROM traspaso t
         RETURNING 1
       )
       -- vivo y respaldado son el diagnostico de por que NO se vendio, sacado
       -- de las mismas filas bloqueadas que decidieron: no hay que volver a
       -- consultar nada para decirselo al comprador.
       SELECT (SELECT coins FROM cobro) AS coins,
              (SELECT count(*) FROM pon) AS recibidas,
              EXISTS (SELECT 1 FROM anuncio)  AS vivo,
              EXISTS (SELECT 1 FROM respaldo) AS respaldado,
              -- EL CUADRE. Si hubo cobro tiene que haber traspaso de la carta, y
              -- de la nota si el anuncio era de una graduada. Si no cuadra,
              -- division por cero: Postgres aborta la sentencia ENTERA y no se
              -- mueve ni una moneda (el catch contesta servidor, que es verdad:
              -- no ha pasado nada). Es la red de las tres escrituras de arriba:
              -- todos los CTE que escriben se ejecutan, y uno que no toque fila
              -- no deshace a los anteriores por si solo.
              1 / (CASE WHEN (SELECT count(*) FROM cobro) = (SELECT count(*) FROM pon)
                         AND (SELECT count(*) FROM entrega)
                             = (SELECT count(*) FROM cobro)
                               * (SELECT count(*) FROM anuncio WHERE graded_id IS NOT NULL)
                        THEN 1 ELSE 0 END) AS cuadra`,
      [anuncioId, userId, precio, COPIAS_RESERVADAS, paga],
    );

    const coins = rows[0]?.coins;
    if (coins === null || coins === undefined) {
      /* NO SE VENDIÓ, Y SE DICE POR QUÉ. El error sigue siendo el de siempre
       * —la pantalla ya lo conoce— y `motivo` lo afina. */
      if (!rows[0]?.vivo) {
        // Entre la lectura de arriba y la sentencia, otro lo compró o se retiró.
        return {
          ok: false as const,
          error: "no-disponible" as const,
          motivo: "vendido" as const,
        };
      }
      if (!rows[0]?.respaldado) {
        /* EL ANUNCIO NO TENÍA NADA DETRÁS. Se cierra ahora (retirada perezosa),
         * para que no lo intente nadie más ni siga ocupando hueco del tope del
         * vendedor. Es otra sentencia y puede fallar sin consecuencias: aquí no
         * se ha movido nada, y `getBazar` ya no lo enseña de todos modos. */
        try {
          await retirarAnunciosSinRespaldo(
            String(previo[0].seller_id),
            String(previo[0].card_id),
          );
        } catch (e) {
          console.error("comprarEnBazarAction: no se pudo cerrar el anuncio sin respaldo:", e);
        }
        return {
          ok: false as const,
          error: "no-disponible" as const,
          motivo: "sin-respaldo" as const,
        };
      }
      return {
        ok: false as const,
        error: "no-disponible" as const,
        motivo: "sin-saldo" as const,
      };
    }

    return { ok: true as const, precio, coins: Number(coins) };
  } catch (e) {
    console.error("comprarEnBazarAction error:", e);
    return { ok: false as const, error: "servidor" as const };
  }
}

/** Mis anuncios, abiertos y cerrados. Para la pantalla de "mis ventas". */
export async function getMisAnunciosBazar() {
  const { userId } = await auth();
  if (!userId) return { ok: false as const, error: "no-autorizado" as const };
  try {
    await ensureSchema();
    /* ANTES DE LEER, SE CIERRAN LOS QUE YA NO TIENEN NADA DETRÁS (ver
     * `retirarAnunciosSinRespaldo`). Es el sitio natural: quien abre "mis
     * ventas" es el único que puede hacer algo con un anuncio muerto, y hasta
     * ahora lo veía 'activa' para siempre, ocupándole un hueco del tope. Sólo
     * toca filas del propio usuario, es idempotente y, si falla, se lee igual:
     * por eso va en su propio try. */
    try {
      await retirarAnunciosSinRespaldo(userId);
    } catch (e) {
      console.error("getMisAnunciosBazar: barrido de anuncios sin respaldo:", e);
    }
    const { rows } = await sql`
      SELECT b.id, b.card_id, b.precio, b.nota, b.estado, b.created_at, b.closed_at,
             c.name, c.rarity, c.images, c.set_id,
             /* La misma condicion que el escaparate y que la puerta de la
              * compra: se podria comprar ahora mismo? */
             (
               b.estado = 'activa'
               AND EXISTS (
                 SELECT 1 FROM user_collection uc
                 WHERE uc.user_id = b.seller_id AND uc.card_id = b.card_id
                   AND uc.quantity > ${COPIAS_RESERVADAS} + (
                     SELECT count(*) FROM graded_cards g
                     WHERE g.user_id = b.seller_id AND g.card_id = b.card_id
                       AND g.estado = 'activa'
                       AND (b.graded_id IS NULL OR g.id <> b.graded_id)
                   )
               )
             ) AS respaldado
      FROM bazar_listings b
      JOIN cards c ON c.id = b.card_id
      WHERE b.seller_id = ${userId}
      ORDER BY (b.estado = 'activa') DESC, b.created_at DESC
      LIMIT 100
    `;
    const anuncios = rows.map((r: any) => ({
      id: Number(r.id),
      cardId: String(r.card_id),
      name: String(r.name ?? ""),
      rarity: String(r.rarity ?? "Common"),
      images: aImagenes(r.images),
      setId: String(r.set_id ?? ""),
      precio: Number(r.precio),
      cobrarias: pagoAlVendedor(Number(r.precio)),
      nota: r.nota === null || r.nota === undefined ? null : Number(r.nota),
      estado: String(r.estado),
      /**
       * Sólo dice algo de los anuncios 'activa': false = sigue abierto pero
       * ahora mismo nadie podría comprarlo (al vendedor ya no le sobra la
       * copia). Tras el barrido de arriba lo normal es que no quede ninguno; si
       * queda —se coló entre el barrido y esta lectura—, la pantalla puede
       * avisarlo. En los cerrados no significa nada.
       */
      respaldado: String(r.estado) === "activa" ? Boolean(r.respaldado) : true,
    }));
    return { ok: true as const, anuncios: await anunciosEnIdiomaUsuario(anuncios) };
  } catch (e) {
    console.error("getMisAnunciosBazar error:", e);
    return { ok: false as const, error: "servidor" as const };
  }
}

/* ==================================================================== *
 * EL ARCHIVADOR (la vitrina)
 * ====================================================================
 *
 * Nueve fundas por hoja, y en cada funda va lo que el jugador ponga. Nace
 * VACÍO: la versión anterior lo rellenaba con la colección entera ordenada por
 * rareza, y eso no es un archivador — es otra vista de la colección. Quien
 * tenía 441 cartas se encontraba 49 hojas que no había montado nadie.
 *
 * LO QUE EL SERVIDOR NO SE CREE: qué carta va en cada funda lo dice el cliente,
 * pero que esa carta EXISTA y sea SUYA lo comprueba aquí. Es la misma regla que
 * el resto del fichero, y aquí hace falta igual aunque no se mueva dinero:
 * `getArchivador` devuelve nombre e ilustración de lo que haya guardado, así
 * que sin la comprobación cualquiera podría meter en su archivador una carta
 * que no tiene y enseñarla en su perfil.
 */

/** Fundas por hoja. Es la rejilla 3x3 de un archivador de verdad. */
const RANURAS_POR_HOJA = 9;

/**
 * Tope de hojas. 60 hojas son 540 fundas, más que la colección de casi nadie.
 *
 * Existe por dos motivos y ninguno es estético: el archivador se lee ENTERO en
 * una consulta (no está paginado en el servidor), y sin tope una petición
 * repetida con hoja = 2.000.000 llenaría la tabla de filas que nadie va a mirar.
 */
const MAX_HOJAS = 60;

/**
 * El archivador entero: qué carta hay en cada funda.
 *
 * Devuelve las fundas OCUPADAS, no la rejilla completa. Las vacías no se
 * guardan ni se transmiten; la pantalla dibuja la rejilla y coloca en ella lo
 * que reciba. Con el archivador recién estrenado esto devuelve una lista vacía,
 * que es exactamente lo que tiene que pasar.
 */
export async function getArchivador() {
  const { userId } = await auth();
  if (!userId) return { ok: false as const, error: "no-autorizado" as const };

  try {
    await ensureSchema();
    const { rows } = await sql`
      SELECT b.hoja, b.ranura, b.card_id,
             c.name, c.rarity, c.images, c.set_id,
             COALESCE(uc.quantity, 0) AS quantity
      FROM binder_slots b
      JOIN cards c ON c.id = b.card_id
      LEFT JOIN user_collection uc
        ON uc.user_id = b.user_id AND uc.card_id = b.card_id
      WHERE b.user_id = ${userId}
      ORDER BY b.hoja ASC, b.ranura ASC
    `;

    const fundas = rows.map((r: any) => ({
      hoja: Number(r.hoja),
      ranura: Number(r.ranura),
      id: String(r.card_id),
      name: String(r.name ?? ""),
      rarity: String(r.rarity ?? "Common"),
      images: aImagenes(r.images),
      setId: String(r.set_id ?? ""),
      /* Copias que se tienen HOY. Puede ser 0 si la carta se vendió después de
       * colocarla: la funda no se vacía sola —sería borrarle al jugador algo
       * que él puso— pero la pantalla la marca para que se entienda por qué
       * está ahí una carta que ya no está en la colección. */
      copias: Number(r.quantity ?? 0),
    }));

    /* Mismo estado físico que en la colección, y por el mismo motivo: una
     * funda enseña una carta y esa carta puede estar machacada. */
    const secretoNotas = secretoDeNotas();
    const conEstado = fundas.map((f) => {
      const estado = estadoDeLaMejorCopia(userId, f.id, Math.max(1, f.copias), secretoNotas);
      return estado ? { ...f, ...estado } : f;
    });

    return {
      ok: true as const,
      fundas: await enIdiomaUsuario(conEstado),
      maxHojas: MAX_HOJAS,
    };
  } catch (e) {
    console.error("getArchivador error:", e);
    return { ok: false as const, error: "servidor" as const };
  }
}

/**
 * Pone una carta en una funda. Si la funda ya tenía otra, la sustituye.
 *
 * EL GUARD DE COPIAS, que es lo único con miga: la misma carta puede aparecer
 * en varias fundas —quien tiene tres Pikachu puede enseñar los tres— pero nunca
 * más veces que copias tenga. Se comprueba DENTRO de la sentencia y contando
 * las fundas que quedarán DESPUÉS, no las que hay: sin eso, dos pestañas
 * colocando la última copia en dos fundas distintas pasarían las dos.
 *
 * El `ON CONFLICT ... DO UPDATE` sobre la clave primaria (usuario, hoja, ranura)
 * es lo que hace que colocar sobre una funda ocupada sustituya en vez de
 * fallar, que es lo que uno espera de un archivador de verdad.
 */
export async function ponerEnRanura(hoja: number, ranura: number, cardId: string) {
  const { userId } = await auth();
  if (!userId) return { ok: false as const, error: "no-autorizado" as const };

  const h = Math.floor(Number(hoja));
  const r = Math.floor(Number(ranura));
  if (!Number.isInteger(h) || h < 0 || h >= MAX_HOJAS) {
    return { ok: false as const, error: "hoja-invalida" as const };
  }
  if (!Number.isInteger(r) || r < 0 || r >= RANURAS_POR_HOJA) {
    return { ok: false as const, error: "ranura-invalida" as const };
  }
  if (typeof cardId !== "string" || !ID_CARTA.test(cardId)) {
    return { ok: false as const, error: "peticion" as const };
  }

  try {
    await ensureSchema();

    const { rows } = await sql`
      WITH mia AS (
        /* La carta tiene que existir y ser suya. Se comprueba con un JOIN
         * contra la tabla cards —igual que hace el abono de comprarSobreAction—
         * para que un id inventado no llegue nunca a la tabla del archivador. */
        SELECT uc.card_id, uc.quantity
        FROM user_collection uc
        JOIN cards c ON c.id = uc.card_id
        WHERE uc.user_id = ${userId} AND uc.card_id = ${cardId} AND uc.quantity > 0
      ),
      /* Fundas que ya tienen ESTA carta, SIN CONTAR la que se está tocando: si
       * se está sustituyendo la misma carta por sí misma, no debe contarse dos
       * veces y bloquear una colocación que en realidad no cambia nada. */
      puestas AS (
        SELECT count(*)::int AS n
        FROM binder_slots
        WHERE user_id = ${userId} AND card_id = ${cardId}
          AND NOT (hoja = ${h} AND ranura = ${r})
      )
      INSERT INTO binder_slots (user_id, hoja, ranura, card_id)
      SELECT ${userId}, ${h}, ${r}, ${cardId}
      WHERE EXISTS (SELECT 1 FROM mia)
        AND (SELECT n FROM puestas) < (SELECT quantity FROM mia)
      ON CONFLICT (user_id, hoja, ranura)
        DO UPDATE SET card_id = EXCLUDED.card_id, placed_at = NOW()
      RETURNING card_id
    `;

    if (rows.length === 0) {
      /* Sin fila puede ser por dos motivos y merecen mensajes distintos: o no
       * tiene la carta, o la tiene toda ya colocada. Se distingue con una
       * consulta de más SÓLO en el camino de error, que es el raro. */
      const { rows: diag } = await sql`
        SELECT COALESCE((SELECT quantity FROM user_collection
                          WHERE user_id = ${userId} AND card_id = ${cardId}), 0) AS copias,
               (SELECT count(*)::int FROM binder_slots
                 WHERE user_id = ${userId} AND card_id = ${cardId}) AS puestas
      `;
      const copias = Number(diag[0]?.copias ?? 0);
      const puestas = Number(diag[0]?.puestas ?? 0);
      if (copias === 0) return { ok: false as const, error: "no-la-tienes" as const };
      return {
        ok: false as const,
        error: "sin-copias-libres" as const,
        copias,
        puestas,
      };
    }

    return { ok: true as const };
  } catch (e) {
    console.error("ponerEnRanura error:", e);
    return { ok: false as const, error: "servidor" as const };
  }
}

/**
 * Vacía una funda. La carta no se toca: sigue en la colección, sólo deja de
 * estar expuesta.
 */
export async function quitarDeRanura(hoja: number, ranura: number) {
  const { userId } = await auth();
  if (!userId) return { ok: false as const, error: "no-autorizado" as const };

  const h = Math.floor(Number(hoja));
  const r = Math.floor(Number(ranura));
  if (!Number.isInteger(h) || h < 0 || !Number.isInteger(r) || r < 0) {
    return { ok: false as const, error: "peticion" as const };
  }

  try {
    await ensureSchema();
    /* AQUÍ SÍ SE BORRA LA FILA, y no contradice la regla de graded_cards: allí
     * la fila se conserva porque su ÍNDICE de copia decide una nota y reciclarlo
     * sería una fuga. Una funda vacía no decide nada; conservarla sólo sería
     * basura que habría que filtrar en cada lectura. */
    const { rowCount } = await sql`
      DELETE FROM binder_slots
      WHERE user_id = ${userId} AND hoja = ${h} AND ranura = ${r}
    `;
    if (!rowCount) return { ok: false as const, error: "vacia" as const };
    return { ok: true as const };
  } catch (e) {
    console.error("quitarDeRanura error:", e);
    return { ok: false as const, error: "servidor" as const };
  }
}
