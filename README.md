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
| `ADMIN_SECRET` | Sí para administrar | Protege `/migrate-core`, `/migrate-schema`, `/migrate-social`, `/migrate-mejoras`, `/ingest-tcg`, `/seed-database` y `/db-stats`. Sin ella, esas rutas responden 503. |
| `GRADING_SECRET` | Sí en cuanto se use la graduación | Entra en la semilla de la que sale la nota de cada copia. **Sin ella el juego funciona, pero un jugador puede calcular la nota de sus copias antes de pagar** y graduar sólo los dieces, que valen el triple: graduar pasaría de perder dinero de media a ser beneficio garantizado. Se avisa en el registro si falta. Ponerla o rotarla es seguro en caliente: las notas ya asignadas están guardadas y no se recalculan. |
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
| 3 | `/migrate-social` | Crea `trade_offers`, los índices de usuario y `friend_codes` (el código de amigo). Su respuesta dice si existe el índice de pareja de `friendships` (`indiceDePareja`); ver «Amigos». |
| 4 | `/migrate-mejoras` | Crea `graded_cards` (graduación), `binder_slots` (el archivador de la vitrina), `card_prices` (precios reales de Cardmarket) y `bazar_listings` (bazar entre jugadores). |
| 5 | `/seed-database` | Siembra las expansiones de `src/data`. Con `?force=true` reescribe las que ya estén. |

Las tablas auxiliares (`wishlist`, `set_rewards`, `market_claims`,
`pack_purchases`) las crea sola la aplicación en la primera petición
(`ensureSchema`, en `app/action.ts`), y con ellas `graded_cards` y
`bazar_listings`: las tocan acciones del jugador y no pueden depender de que
alguien se acuerde de ejecutar una ruta. `card_prices` NO está ahí a propósito
—sólo la escribe su cron— y la asegura `services/preciosIngest.ts` por su
cuenta. Con `/migrate-mejoras` quedan las tres creadas de una vez.

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
de datos, y las probabilidades de sobre se calculan por **rareza y era**, no por
id de set: una expansión nueva hereda el perfil de tiradas de su serie sin que
nadie tenga que configurar nada (`eraDeSerie` en `utils/packLogic.ts`).

## Precios reales de Cardmarket

`/api/cron/sync-precios` baja a `card_prices` el precio en euros de las cartas
caras, desde TCGdex (pokemontcg.io lleva tiempo respondiendo 502 y sus precios
nunca se sembraron: las 252 cartas de sv08 del repositorio tienen `cardmarket`
vacío). Con eso, el precio de venta de una carta deja de depender sólo de su
rareza:

    precio = tarifa + tarifa × (euros / 1000)

**No es un tercer cron declarado, y no puede serlo:** el plan Hobby de Vercel
permite DOS, `vercel.json` ya declara los dos que hay, y un tercero hace
**fallar el despliegue**. Por eso los precios van encadenados al final de
`/api/cron/sync-es`, que le pasa lo que le sobre de sus 45 s — la mayoría de las
noches las traducciones no cambian y sobra casi todo. La ruta existe igualmente
y se puede disparar a mano con `Authorization: Bearer $CRON_SECRET`, y con
`?setId=` para una expansión concreta. Si algún día hay plan Pro, se le da su
hora en `vercel.json` y se quita el encadenado.

**Sólo se piden las cartas que mueven la aguja** (tarifa de 35 monedas o más,
Double Rare para arriba). Medido sobre las 252 cartas de sv08: el ajuste cambia
el precio menos de un 1% en Common, Uncommon, Rare y Double Rare, y 179 de esas
252 valen menos de 1 €. Pedir el precio de una Common es tirar una petición.

---

## Graduación de cartas

Mandas una copia repetida a graduar, pagas, y te devuelven una nota del 1 al 10
que multiplica lo que vale. La copia se queda en la vitrina con sus desperfectos
a la vista: piques en los cantos, arañazos, manchas, descentrado y decoloración,
todo coherente con la nota.

**La nota no se sortea al pulsar el botón: se revela.** Estaba decidida desde que
la carta entró en la colección, porque sale de una semilla estable
`(secreto, usuario, carta, nº de copia)` y no de `Math.random()`. Sin eso,
graduar sería una tragaperras: quien no quedara contento vendería la carta, la
volvería a conseguir y volvería a tirar.

| nota | 10 | 9 | 8 | 7 | 6 | 5 | 4 | 3 | 2 | 1 |
|---|---|---|---|---|---|---|---|---|---|---|
| probabilidad | 14,25% | 38% | 19% | 23,75% | 1,4% | 1,1% | 1% | 0,75% | 0,5% | 0,25% |
| multiplicador | ×3 | ×1,5 | ×0,9 | ×0,7 | ×0,55 | ×0,3 | ×0,25 | ×0,18 | ×0,08 | ×0 |

**Por qué el 9 vale ×1,5 y no ×2**, que es lo primero que se pregunta cualquiera
al leer la tabla: con ×2 el multiplicador medio sale ×1,74, y ×1,74 con un coste
fijo de 100 monedas es una imprenta — graduar sale a cuenta en cuanto la carta
pasa de 135 monedas, y como se pueden graduar las repetidas, el bucle no termina
nunca. Una Hyper Rare daba +85 monedas de beneficio esperado por copia.

Y el arreglo no era sólo bajar números. Con coste **fijo** C sobre una carta de
valor V, graduar es neutral cuando el multiplicador medio vale `1 + C/V`: con
C=100 eso pide ×1,67 a 150 monedas y ×1,40 a 250. **Una sola tabla no puede ser
neutral a los dos valores.** Por eso el coste lleva un tramo proporcional —
`max(100, 40% del valor)` —, que hace que la neutralidad deje de depender de V.
Con esa fracción el techo es ×1,40 y la tabla da ×1,35: graduar pierde 12,5
monedas de media, que es la ventaja de la casa. `npm test` lo comprueba por
fuerza bruta sobre todo el rango de valores y todos los descuentos.

Se vende o se guarda, pero **hay que quedarse con una copia**: la promesa de que
el álbum nunca se vacía vale también aquí.

> ⚠️ **`GRADING_SECRET` no es opcional en la práctica.** La semilla llevaba al
> principio sólo `usuario|carta|copia`, y los tres los conoce el navegador. Como
> `notaDeCopia` viaja en el paquete del cliente, cualquiera podía abrir la
> consola y calcular la nota de todas sus copias sin graduar, mandar sólo los
> dieces y convertir una apuesta perdedora en beneficio garantizado. Ahora la
> semilla lleva un secreto de servidor y **el servidor nunca la manda al
> cliente**: manda la nota y los desperfectos ya calculados, y sólo de las
> copias que ya se han pagado.

## Bazar entre jugadores

Un jugador publica una carta suya a un precio y otro la compra. Es distinto del
Mercado, que es un tablón de encargos contra la máquina: aquí hay una persona al
otro lado.

**Todo el diseño gira alrededor de un problema.** Hasta ahora las monedas no se
podían mover entre cuentas por ninguna vía —toda escritura sobre `users.coins`
filtra por el id de la sesión, y el trueque es carta por carta sin dinero—, y eso
era lo único que hacía inofensivo el grifo de las cuentas nuevas: crear una es
gratis y recibe 1.000 monedas más 165-300 cada 20 horas. Un bazar con precio
libre convierte ese grifo en dinero para la cuenta principal.

Las cuatro defensas, que van juntas o no van:

1. **Banda de precio.** El precio tiene que caer entre el 50% y el 150% del
   valor real que calcula el servidor. Vender un Common por 10.000 no se rechaza
   al comprar: es que la publicación no se llega a crear.
2. **Comisión del 15%,** que se destruye. Cada pase entre cuentas pierde ese
   porcentaje, así que el ciclo de lavado se desangra en vez de ser gratis.
3. **Hay que haber abierto sobres para vender (25) y para comprar (10).** La
   barrera del comprador es la que de verdad importa y no era obvia: el lavado
   va de la cuenta alternativa —que es la que tiene las monedas del grifo— a la
   principal, así que la alternativa es la que *compra*. Con la barrera sólo en
   la venta se estaba protegiendo la dirección equivocada. Montar una granja de
   cuentas pasa a costar tiempo real y monedas.
4. **La copia reservada sí aplica,** al revés que en el trueque. El bazar saca
   cartas del juego a cambio de monedas: es un mercado, no un movimiento.

## Vitrina

Un archivador de anillas de verdad: hojas de nueve fundas en 3×3 que se pasan
**girando el papel sobre el lomo**, con botones, con las flechas o arrastrando.

**Nace VACÍO y se monta a mano.** La primera versión lo rellenaba solo con la
colección entera ordenada por rareza, y eso no es un archivador: es otra vista
de la colección. Quien tenía 441 cartas se encontraba 49 hojas que no había
montado nadie. Ahora cada funda guarda lo que el jugador ponga en ella —tabla
`binder_slots`, o `localStorage` si juega sin cuenta— y la misma carta puede ir
en varias fundas, pero nunca más veces que copias tenga.

**El giro monta el 3D y lo desmonta.** `perspective` y `preserve-3d` están
prohibidos en este repositorio sobre cualquier ancestro de una carta: WebKit
rasteriza esa capa a escala fija y la ilustración sale borrosa en iPhone. La
salida es la que ya usaba `PokemonCard` para su propio giro — volumen mientras
se mueve, plano en reposo—, así que fuera del pase de página no queda ni una
perspectiva, ni un `preserve-3d`, ni un `will-change`. Comprobado en el
navegador: durante el giro hay dos hojas y `perspective: 1800px`; 520 ms
después, una hoja y `perspective: none`.

## Amigos

Añadir a alguien son tres caminos que acaban en el mismo sitio, una petición de
amistad que el otro acepta:

- **El código de amigo.** Ocho caracteres (`ABCD-2345`) sin 0, O, 1, I ni L,
  para que se pueda dictar. Cada cuenta tiene uno, se crea solo la primera vez
  que hace falta y se puede cambiar: el viejo deja de valer en el acto.
- **El enlace de invitación,** `/invitar/CODIGO`, que es lo que manda
  «Compartir» y lo que lleva dentro el **QR** (`utils/qr.ts`, generado en el
  propio navegador, sin dependencias). Abrir el enlace NO envía nada: enseña la
  ficha del entrenador y hace falta un toque. Sin sesión, la invitación se
  recuerda y se retoma al entrar o al crear la cuenta.
- **El nombre,** en el mismo campo que el código (Social → Añadir). Acepta
  también el enlace o el mensaje entero pegado.

**La regla de todo el bloque:** el id de Clerk de otra persona no sale del
servidor salvo hacia un amigo ya aceptado. A un entrenador se le nombra por su
código o por el id numérico de la fila de `friendships`.

**Hay una fila por pareja** y su `status` dice además quién hizo qué
(`services/esquemaSocial.ts` lo documenta estado a estado). Lo que conviene
saber sin abrir el código:

- Dos personas que se añaden a la vez acaban como amigas: la segunda petición
  acepta la primera.
- **El rechazo es silencioso.** La fila se queda en `declined`: quien fue
  rechazado sigue viendo su petición como enviada y no puede reenviarla. Ni
  cancelándola (pasa a `withdrawn`) ni bloqueando y desbloqueando (pasa por
  `blocked_declined` y vuelve a `withdrawn`).
- **Bloquear** corta la amistad, cancela las ofertas pendientes entre los dos,
  saca a cada uno de la búsqueda del otro y cierra el álbum en los dos sentidos.
- **Eliminar a un amigo** cancela también las ofertas pendientes entre los dos,
  y aceptar una oferta exige que la amistad siga viva.
- Topes: 20 peticiones enviadas sin contestar, 50 recibidas, 100 amigos. Están
  para cortar el goteo masivo, no para contar: uno a uno son exactos, y bajo
  ráfagas simultáneas se pasan (medido: hasta 30, 60 y 140).

**Al desplegar,** ejecuta `/migrate-core` y `/migrate-social` y mira la
respuesta de la segunda. Si `indiceDePareja` es `false`, falta
`idx_friendships_par`, que es lo que impide dos filas por pareja cuando dos
peticiones se cruzan: sin él, entre la mitad y dos tercios de las peticiones
simultáneas dejan la pareja duplicada. Suele faltar porque la base ya trae
duplicados y el índice no se deja crear; `parejasDuplicadas` dice cuántas hay.
Para verlas:

```sql
SELECT LEAST(user_id, friend_id) a, GREATEST(user_id, friend_id) b,
       array_agg(id ORDER BY id), array_agg(status ORDER BY id)
  FROM friendships
 GROUP BY 1, 2 HAVING count(*) > 1;
```

La misma respuesta trae `minusculasUnicode`. Si es `false`, la base se creó con
`LC_CTYPE = C` y su `LOWER()` no pasa a minúscula la Ñ ni las vocales
acentuadas: la búsqueda de entrenadores por nombre no encuentra a «Álvaro»
escribiendo «álvaro» (la respuesta trae además `avisoBusqueda`). La aplicación
sólo lo detecta, no lo arregla: el arreglo es comparar con una colación que
entienda Unicode, o buscar por una columna con el nombre ya normalizado.

`/migrate-social?relleno=1` crea de una vez el código de quien aún no lo tenga
(en tandas; se puede repetir). No hace falta: se crean solos al primer uso.

## Ilustraciones reales de sobre

Al abrir un sobre de una expansión que tenga foto, se ve el sobre de verdad; el
resto sigue con el sobre compuesto en CSS, que es el caso normal (hoy 1 de 171).
Las fotos se dejan en una carpeta por expansión y se preparan con:

```bash
node scripts/preparar-sobres.mjs
```

Eso las convierte a WebP del tamaño al que se pintan y escribe
`src/data/sobres.json`, el manifiesto que la aplicación consulta. Las cuatro de
Pitch Black pasaron de 6,01 MB a 0,52 MB (91% menos), que importa porque se
descargan justo en el momento de abrir el sobre. El mapa carpeta → id de
expansión vive dentro del propio script y es lo único que hay que tocar para
añadir una expansión nueva.


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
  cumplir**;
- **graduar no imprime dinero**: el multiplicador medio de la tabla de notas no
  pasa del techo que marca el coste, comprobado además a la fuerza bruta sobre
  todo el rango de valores y todos los descuentos por volumen;
- la nota de una copia es **determinista** y sus desperfectos visibles nunca la
  contradicen (un 10 no puede salir con un arañazo);
- **mover monedas por el bazar siempre cuesta la comisión**, a cualquier valor y
  con el precio en el techo de su banda;
- **ninguna era tira una expansión fuera de la tienda** ni deja un sobre por
  encima de su precio, y una serie desconocida usa el reparto de siempre.

Es todo **determinista**: mismas entradas, mismo resultado. Esa es la condición
para que sirva de puerta en CI.

> El invariante de eras ya se ganó el sueldo: cazó que `eraDeSerie` clasificaba
> "Una Serie Que No Existe" como clásica, porque buscaba la subcadena `ex` para
> la serie EX. Con nombres de serie que llegan de una API que no controlamos,
> eso habría hecho que una expansión moderna repartiera con las probabilidades
> de los sobres de 1999.

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

**Cualquier cambio en `SELL_PRICES`, `PACK_PRICES`, `categorizeCards`, las
tablas de premio o los perfiles de era de `utils/packLogic.ts`,
`MULTIPLICADOR_NOTA` o `COSTE_FRACCION` de `utils/graduacion.ts`, o la banda y
la comisión de `utils/bazar.ts`, exige pasar `npm test` antes de subir**, y
conviene pasar también `npm run sim:economia`. Es lo único que impide reabrir
una fuga de monedas sin enterarse.

Y un aviso sobre `sim:economia`, para no perder una tarde: su apartado de
"ANTES vs AHORA" contrasta Montecarlo contra Montecarlo con márgenes en σ y
**salta por azar de vez en cuando**. Si señala que un sobre "se ha movido"
quedándose por debajo de su precio, comprueba el número CERRADO
(`valorEsperadoEstandar`) antes de tocar nada: medido en swsh7, el cerrado da
49,25 y las dos muestras que lo hicieron saltar fueron 48,5 y 49,8.

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

- Historial de sobres abiertos (`pack_purchases` ya lo guarda dos días).
- Contador de sequía: cuántos sobres llevas sin un hit de rango alto.
- Exportar e importar la partida de invitado (hoy vive sólo en el navegador, y
  Safari sin instalar la borra a los siete días sin uso; Ajustes lo avisa).
- Un ajuste «Tamaño del texto»: el enchufe está en `app/globals.css`
  (`--escala-texto` y `html[data-texto="grande"]`), sin interruptor todavía.

Ya hechas, de las que estaban aquí: reintentar el sobre con la misma clave
cuando falla la red, el progreso de la expansión en el resumen, «Saltar» y la
apertura rápida (en la tienda y en Ajustes), y la precarga del catálogo.

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

**El aviso de «hay una versión nueva».** La app instalada puede llevar días
abierta cuando llega un despliegue. Lo detecta por dos vías que ya funcionan
solas (el service worker nuevo y una server action que el servidor ya no
reconoce) y por una tercera que está escrita pero apagada: comparar el build
del cliente con el de `/api/version` al volver a primer plano. Para encenderla
falta una línea en `next.config.ts`:

```ts
env: {
  NEXT_PUBLIC_BUILD_ID:
    process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "",
},
```

Sin ella no pasa nada malo: sólo se tarda un poco más en avisar.

**Las imágenes de la app instalada.** Las pantallas de arranque de iOS van por
pares, oscura y clara (`public/splash/splash-<tamaño>.png` y `-claro.png`), y
el icono de la pantalla de inicio es `public/icons/apple-touch-icon-v2.png`, a
sangre. Las claras y el icono salen de las que ya hay:

```bash
node scripts/generar-imagenes-pwa.mjs
```

No pisa lo que ya existe. Para un iPhone con otra resolución: se añade su
arranque oscuro a `public/splash/`, su fila a `STARTUP_IMAGES` en
`app/layout.tsx` y se vuelve a pasar el script.
