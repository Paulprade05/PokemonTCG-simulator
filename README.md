# Simulador de Pokémon TCG

Colección, apertura de sobres e intercambios. PWA instalable, pensada sobre todo
para iPhone.

- **Stack:** Next.js 16 (App Router) · React 19 · Vercel Postgres · Clerk · Tailwind 4
- **Idiomas:** inglés y español (la traducción ocurre en el servidor; ver
  `services/idioma.ts`)

---

## Puesta en marcha

```bash
npm install
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000). La aplicación funciona sin
base de datos: sirve el catálogo de `src/data` y guarda la colección de invitado
en `localStorage`.

## Variables de entorno

| Variable | ¿Obligatoria? | Para qué |
|---|---|---|
| `POSTGRES_URL` | Sí | Base de datos (la pone Vercel Postgres). |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Sí | Inicio de sesión. |
| `CRON_SECRET` | Sí para la sincronización | Vercel la envía como `Authorization: Bearer` al ejecutar el cron. Sin ella, `/api/cron/sync-sets` responde 503 y no sincroniza nada. |
| `ADMIN_SECRET` | Sí para administrar | Protege `/migrate-core`, `/migrate-schema`, `/migrate-social`, `/ingest-tcg`, `/seed-database` y `/db-stats`. Sin ella, esas rutas responden 503. |
| `POKEMONTCG_API_KEY` | No, pero recomendable | Sin clave, los límites de api.pokemontcg.io son bajos y los reintentos por 429 se comen el presupuesto de tiempo del cron. |

Genera los secretos con:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Importante:** en Vercel las variables sólo llegan a los despliegues NUEVOS.
Después de crear o cambiar una hay que redesplegar; si no, la aplicación sigue
ejecutándose con el valor anterior.

---

## Montar la base de datos desde cero

Las rutas van en este orden y **todas** piden `Authorization: Bearer $ADMIN_SECRET`:

| Orden | Ruta | Qué hace |
|---|---|---|
| 1 | `/migrate-core` | Crea las cinco tablas base (`users`, `sets`, `cards`, `user_collection`, `friendships`) más `set_translations`, con sus claves e índices. |
| 2 | `/migrate-schema` | Añade a `cards` las columnas ricas (ataques, legalidades, precios…) e índices. |
| 3 | `/migrate-social` | Crea `trade_offers` y los índices de usuario. |
| 4 | `/seed-database` | Siembra las expansiones de `src/data`. Con `?force=true` reescribe las que ya estén. |

Las tablas auxiliares (`wishlist`, `set_rewards`, `market_claims`,
`pack_purchases`) las crea sola la aplicación en la primera petición
(`ensureSchema`, en `app/action.ts`).

```bash
curl -H "Authorization: Bearer $ADMIN_SECRET" https://TU-APP/migrate-core
```

`/db-stats` responde con un recuento de lo que hay en la base, para comprobar
que la ingesta va bien.

> Los pasos 1-3 son idempotentes: se pueden repetir sobre una base con datos sin
> tocar ni una fila.

---

## Traducciones automáticas

`vercel.json` programa un segundo cron, `/api/cron/sync-es`, a las 07:00 UTC
(dos horas después del de expansiones, que es de donde saca los nombres ingleses
contra los que empareja).

Comprueba si TCGdex ya tiene en español alguna de las expansiones que la app
enseña en inglés y guarda su diccionario en la tabla `set_translations`. **No
hace falta desplegar:** `services/idiomaBD.ts` lo aplica encima de los ficheros
de `src/data/es`, que siguen siendo la base. Si Postgres falla o la tabla está
vacía, el español sigue funcionando exactamente como antes.

Hacía falta porque en Vercel el sistema de ficheros es de sólo lectura: el
generador de `src/data/es` sólo se puede ejecutar en local, y hasta ahora cada
expansión nueva se quedaba en inglés hasta que alguien se acordaba.

**Cómo saber por qué una expansión sigue en inglés:** mira su `estado` en
`set_translations`. `sin_fuente` o `404` significan que el id de TCGdex se
adivinó mal y hay que ponerlo a mano en `src/data/es/mapa-sets.json`;
`guardia` significa que el emparejamiento no superó las comprobaciones
antimapeo y **no se ha escrito nada**, que es lo correcto: es lo que impide que
una expansión salga traducida con los nombres de otra. Para reintentar una suelta
sin esperar a mañana: `/api/cron/sync-es?setId=me6`.

## Sets nuevos automáticos

`vercel.json` programa `/api/cron/sync-sets` una vez al día (05:00 UTC; el plan
Hobby de Vercel no permite más). Compara el catálogo de api.pokemontcg.io con la
base de datos, y descarga los sets que falten y los incompletos, empezando por
los más recientes.

Está pensado para el tope de 60 segundos del plan Hobby: trabaja con un
presupuesto de tiempo y es reanudable, así que un set grande que no quepa en una
ejecución lo termina la siguiente. Se puede forzar un set concreto con
`?setId=me5`.

La aplicación no necesita ningún cambio para mostrarlos: lee los sets de la base
de datos, y las probabilidades de sobre se calculan por rareza, no por id de set.

---

## Tests

```bash
npm test
```

Tarda segundos y sale con código distinto de cero si algo se rompe. Comprueba
sobre las cartas reales que:

- el número de cartas y las probabilidades que anuncia la tienda son las que
  reparte de verdad el generador, en las 38 expansiones;
- ningún sobre a la venta vale más de lo que cuesta (cálculo cerrado);
- la curva de precios de las repetidas no premia trocear la venta, no sube nunca
  y no regala ninguna carta;
- toda rareza tiene precio y rango, y ninguna de las que existen en los datos se
  queda fuera de las tablas;
- el tablón del mercado es determinista y **ninguna oferta es imposible de
  cumplir**.

Es todo **determinista**: mismas entradas, mismo resultado. Esa es la condición
para que sirva de puerta en CI.

### Las dos simulaciones grandes

```bash
npm run sim:economia   # minutos
npm run sim:mercado
```

Son de ejecución manual, para cuando se toca la economía:

- **`sim:economia`** abre 20.000 sobres por expansión y mide el vaciado de
  duplicados y el retorno de completar una colección desde cero. **No está en
  `npm test` a propósito:** contrasta ~90 filas de Montecarlo contra el cálculo
  cerrado con márgenes en σ, así que puede saltar por azar (su propio comentario
  lo dice). La parte que importa —el guardián del precio— ya está en `npm test`
  en versión exacta.
- **`sim:mercado`** es informativo y no falla nunca: imprime el calibrado del
  mercado de lotes.

**Cualquier cambio en `SELL_PRICES`, `categorizeCards` o las tablas de premio de
`utils/packLogic.ts` exige pasar `npm test` antes de subir**, y conviene pasar
también `npm run sim:economia`. Es lo único que impide reabrir una fuga de
monedas sin enterarse.

---

## Estado de las mejoras pendientes

La lista original de "MEJORAS PARA LA WEB", con dónde está cada una:

| Mejora | Estado | Dónde |
|---|---|---|
| Cambiar el tamaño de los botones | **Hecho** | Clase `touch-target` (44 px) en `app/globals.css`; aplicada también al botón de vender repetidas del resumen. |
| Arreglar el porcentaje de colección de los sets | **Hecho** | El progreso se mide contra las cartas que existen (`cardsCount`), no contra el `total` declarado, que viene inflado. `app/collection/page.tsx` y `app/album/[setId]/page.tsx`. |
| Ordenar los sets por fecha de salida | **Hecho** | `ORDER BY release_date DESC NULLS LAST` en `getSetsFromDB`. |
| Guardar lo que falta para terminar un set | **Hecho** | `getSetsFromDB` devuelve `cardsCount`; la tarjeta de cada expansión pinta `conseguidas/total` y las que faltan. |
| Que la primera carta salga del revés | **Descartado** | Se quitó el volteo entero: ahora las cartas emergen de cara desde el sobre. El momento que se celebra es la llegada, no el giro. Ver `components/MazoCartas.tsx`. |
| Decir cuántas cartas nuevas se han añadido | **Hecho** | Cabecera del resumen del sobre (`app/page.tsx`, VIEW 4). |
| Etiqueta "nueva" sobre la carta al abrirla | **Hecho** | Insignia arriba a la izquierda durante la apertura. |
| Cuadrícula del álbum con huecos numerados | **Hecho** | `app/album/[setId]/page.tsx`: las que faltan salen como hueco punteado con su número. |

### Ideas que siguen abiertas

- Reintentar el sobre cuando falla la red, en vez de cerrar la vista (la clave de
  idempotencia de `pack_purchases` ya permite reenviar sin cobrar dos veces).
- Cuánto falta para completar la expansión, en el resumen del sobre.
- Historial de sobres abiertos (`pack_purchases` ya lo guarda dos días).
- Contador de sequía: cuántos sobres llevas sin un hit de rango alto.
- Interruptor de "saltar animación" dentro de la propia apertura.
- Precargar el catálogo de la expansión al pasar el dedo por su tarjeta.

---

## Cómo está organizado

| Carpeta | Qué hay |
|---|---|
| `app/` | Rutas, pantallas y **todas** las server actions (`action.ts`, `social.ts`). |
| `components/` | Interfaz. `BoosterPack` y `MazoCartas` son la apertura del sobre. |
| `utils/` | Reglas del juego sin React: `packLogic.ts` (qué cae en un sobre), `constanst.ts` (precios y curva de repetidas), `mercado.ts` (tablón de lotes). |
| `services/` | Acceso a datos y capa de idioma. |
| `src/data/` | Catálogo de cartas del repositorio: respaldo cuando no hay Postgres. |
| `scripts/` | Simulaciones y tests de la economía. |

**Dónde vive el dinero:** todo movimiento de monedas ocurre en el servidor y en
una sola sentencia SQL. El navegador nunca manda un importe. Si tocas
`comprarSobreAction`, `sellCardAction`, `sellAllDuplicatesBulkAction`,
`cumplirOferta` o `acceptTradeOffer`, lee antes los comentarios que llevan
encima: explican qué agujero cerró cada uno.

---

## Despliegue

Se despliega en Vercel como cualquier proyecto Next.js. Tras el primer
despliegue hay que ejecutar las cuatro rutas de migración de arriba, en orden.
