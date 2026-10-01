# Simulador de Pokémon TCG

Colección, apertura de sobres e intercambios, con una economía de monedas:
sobres, venta de repetidas, mercado de encargos, graduación, bazar entre
jugadores y trueque. PWA instalable, pensada sobre todo para iPhone.

- **Stack:** Next.js 16 (App Router) · React 19 · Vercel Postgres · Clerk · Tailwind 4
- **Idiomas:** inglés y español (la traducción ocurre en el servidor; ver
  `services/idioma.ts`)

**Si vienes a desplegar,** ve directo a [Despliegue](#despliegue): ahí están los
pasos pendientes, la puerta de CI y la lista de qué probar en el iPhone.
**Si vienes a tocar la economía,** lee antes
[Graduación](#graduación-de-cartas), [Tests](#tests) y
[Riesgos conocidos](#riesgos-conocidos-y-decisiones-del-dueño).

---

## Puesta en marcha

```bash
npm install
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000). Hace falta **Node 22.18 o
posterior** para los scripts y los tests (se desarrolla y se prueba con Node 24,
que es también el que usa el CI).

La aplicación funciona sin base de datos: sirve el catálogo de `src/data` y
guarda la colección de invitado en `localStorage`.

## Variables de entorno

| Variable | ¿Obligatoria? | Para qué |
|---|---|---|
| `POSTGRES_URL` | Sí | Base de datos (la pone Vercel Postgres). |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Sí | Inicio de sesión. |
| `CRON_SECRET` | Sí para la sincronización | Vercel la envía como `Authorization: Bearer` al ejecutar los crons. Sin ella, o si mide menos de 16 caracteres, `/api/cron/sync-sets`, `/api/cron/sync-es` y `/api/cron/sync-precios` responden 503 y no sincronizan nada. |
| `ADMIN_SECRET` | Sí para administrar | Protege `/migrate-core`, `/migrate-schema`, `/migrate-social`, `/migrate-mejoras`, `/migrate-sobres`, `/ingest-tcg`, `/seed-database` y `/db-stats`. Sin ella, o si mide menos de 16 caracteres, esas rutas responden 503 (y el mensaje dice por qué). |
| `GRADING_SECRET` | Sí en cuanto se use la graduación | Entra en la semilla de la que sale la nota de cada copia. Tiene que medir **16 caracteres o más**; si falta o es más corta se usa un respaldo público. **Sin ella el juego funciona, pero un jugador puede calcular la nota de sus copias antes de pagar** y graduar sólo los dieces (×1,95, contra un techo de ×1,40): graduar pasaría de perder dinero de media a ser beneficio garantizado. Se avisa en el registro si falta. Ponerla o rotarla es seguro en caliente: las notas ya asignadas están guardadas y no se recalculan. |
| `POKEMONTCG_API_KEY` | No, pero recomendable | Sin clave, los límites de api.pokemontcg.io son bajos y los reintentos por 429 se comen el presupuesto de tiempo del cron. |

Los tres secretos se leen recortados (un espacio o un salto de línea pegado al
final no cuenta) y **tienen que medir 16 caracteres o más**: uno más corto vale
lo mismo que no ponerlo. Genéralos con:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Importante:** en Vercel las variables sólo llegan a los despliegues NUEVOS.
Después de crear o cambiar una hay que redesplegar; si no, la aplicación sigue
ejecutándose con el valor anterior. Para saber si una variable llega de verdad
a un despliegue sin abrir los registros, `/db-stats` responde, además del
recuento de la base, qué variables llegan y cuánto miden (nunca su valor).

`/db-stats` trae también tres listas para mirar después de cada despliegue:
`rarezas_fuera_de_tabla` (rarezas que el cron ha traído y que el juego no tiene
en su tabla de precios), `precios_sospechosos` (ver «Precios reales») y
`expansiones_a_medias` (las que tienen en `cards` menos del 90 % de las cartas
que declara su ficha: **no venden sobres** hasta completarse, ver «Sets
nuevos»).

---

## Montar la base de datos desde cero

Las rutas van en este orden y **todas** piden `Authorization: Bearer $ADMIN_SECRET`:

| Orden | Ruta | Qué hace |
|---|---|---|
| 1 | `/migrate-core` | Crea las cinco tablas base (`users`, `sets`, `cards`, `user_collection`, `friendships`) más `set_translations`, con sus claves e índices. Entre ellos `idx_friendships_par`, el índice único que impide dos filas por pareja. |
| 2 | `/migrate-schema` | Añade a `cards` las columnas ricas (ataques, legalidades, precios…) e índices. |
| 3 | `/migrate-social` | Crea `trade_offers`, los índices de usuario y `friend_codes` (el código de amigo). Su respuesta dice si existe el índice de pareja (`indiceDePareja`) y si la base pasa a minúscula las letras con tilde (`minusculasUnicode`); ver «Amigos». |
| 4 | `/migrate-mejoras` | Crea `graded_cards` (graduación), `binder_slots` (el archivador de la vitrina), `card_prices` (precios reales de Cardmarket) y `bazar_listings` (bazar entre jugadores). |
| 5 | `/migrate-sobres` | Crea `set_pack_art` y `set_pack_art_estado`, el almacén de las fotos de sobre que trae el cron. **Si se salta, nada falla a la vista:** las expansiones con foto en el repositorio la siguen enseñando, pero `/api/arte-sobre/…` responde 503 y las fotos nuevas no aparecen hasta que el propio cron crea las tablas en su primera pasada. |
| 6 | `/seed-database` | Siembra las expansiones de `src/data`. Con `?force=true` reescribe las que ya estén. |

```bash
for ruta in migrate-core migrate-schema migrate-social migrate-mejoras migrate-sobres seed-database; do
  curl -H "Authorization: Bearer $ADMIN_SECRET" "https://TU-APP/$ruta"; echo
done
```

Lee cada respuesta. `/migrate-core`, `/migrate-mejoras` y `/migrate-sobres`
aplican sus sentencias una a una y, si alguna no cuaja, la devuelven en
`fallidas` (código 207) en vez de pararse.

Además, la aplicación crea sola en la primera petición (`ensureSchema`, en
`app/action.ts`) las tablas `wishlist`, `set_rewards`, `market_claims` y
`pack_purchases`, cuatro columnas de `users` (`last_daily_claim`, `streak`,
`theme`, `lang`) y, con ellas, `graded_cards`, `binder_slots` y
`bazar_listings`: las tocan acciones del jugador y no pueden depender de que
alguien se acuerde de ejecutar una ruta. `card_prices` NO está ahí a propósito
—sólo la escribe su cron— y la asegura `services/preciosIngest.ts` por su
cuenta.

> Las seis rutas son idempotentes: se pueden repetir sobre una base con datos
> sin tocar ni una fila (todo va con `IF NOT EXISTS`).

**Opcional: `/migrate-mejoras?guardas=1`.** Añade tres `CHECK` a la propia base
(saldo no negativo, cantidad no negativa, comisión coherente con el precio)
como última red por debajo de las sentencias. Mira antes si ya están y si hay
filas que los incumplan: si las hay **no pone ninguno** y dice cuántas son
(`hay-filas-que-la-incumplen`), para arreglarlas a mano. Sin el parámetro la
ruta hace lo de siempre.

`/ingest-tcg` descarga expansiones de api.pokemontcg.io a mano (`?setId=`,
`?setsOnly=true`, `?onlyMissing=true`); en el día a día lo hace el cron.

---

## Despliegue

Se despliega en Vercel como cualquier proyecto Next.js. Vercel sólo ejecuta
`next build`: no pasa ni el typecheck ni los tests (para eso está el CI, más
abajo). Tras el primer despliegue hay que ejecutar las seis rutas de migración
de arriba, en orden.

**Versión de Node.** `package.json` NO declara `engines` a propósito: Vercel lee
ese campo y manda sobre lo que diga el panel, así que añadirlo cambiaría el Node
de producción sin que nadie lo decida. El despliegue usa la versión elegida en
el panel de Vercel; el CI y el desarrollo local usan Node 24. Si algún día se
quiere fijar desde el repositorio, se añade `engines.node` sabiendo que eso
mueve producción.

### Pasos pendientes tras el commit d4d558e (amigos por código, PWA)

Se hacen **una vez**, justo después de desplegar ese commit o cualquiera
posterior. Antes de empezar, pide `/db-stats`: si responde 503 es que
`ADMIN_SECRET` no llega o mide menos de 16 caracteres, y entonces tampoco
responderá ninguna migración.

1. Ejecuta `/migrate-core` y después `/migrate-social` (crean `friend_codes` y
   el índice de pareja; no tocan datos).
2. En la respuesta de `/migrate-social`, **exige `"indiceDePareja": true`.** Si
   es `false` falta `idx_friendships_par`: sin él, dos peticiones de amistad
   cruzadas a la vez dejan dos filas para la misma pareja. Suele faltar porque
   la base ya trae duplicados y el índice no se deja crear: `/migrate-core` lo
   devuelve en `fallidas`, `parejasDuplicadas` dice cuántas hay y la consulta
   de «Amigos» las enseña. Se resuelven a mano (decidir qué fila de cada pareja
   se queda) y se repite `/migrate-core`.
3. En la misma respuesta, comprueba `"minusculasUnicode": true`. Si es `false`,
   la búsqueda por nombre no encuentra a «Álvaro» escribiendo «álvaro» (ver
   «Amigos»). No impide desplegar.
4. Si la base no ha pasado nunca por `/migrate-sobres`, ejecútala también.
5. Recorre la lista de [qué probar en el iPhone](#qué-probar-en-el-iphone-tras-desplegar).

### Pasos de la revisión posterior a d4d558e (servidor, bazar y CI)

No hay migración obligatoria: no cambia el esquema.

1. **Al hacer el commit, añade los ficheros nuevos a mano.** Un `git commit -a`
   sólo recoge los que git ya seguía, y el código importa tres que no:
   `services/limite.ts`, `utils/catalogoCliente.ts` y `.github/workflows/ci.yml`.
   Sin ellos `next build` falla por módulo no encontrado.
2. **Antes de desplegar**, comprueba que `CRON_SECRET` y `ADMIN_SECRET` miden 16
   caracteres o más (si no, los crons y las rutas de administración pasan a
   responder 503), y mira qué expansiones dejarían de vender sobres:

   ```sql
   SELECT s.id, s.total, count(c.id) FROM sets s LEFT JOIN cards c ON c.set_id = s.id
   GROUP BY 1, 2 HAVING s.total > 0 AND count(c.id) < s.total * 0.9;
   ```

   Lo que salga, o se está descargando (se arregla solo) o tiene el `total`
   inflado: corrígelo en `sets` antes de subir. Después del despliegue la misma
   lista está en `expansiones_a_medias` de `/db-stats`.
3. Tras desplegar, mira en `/db-stats` `rarezas_fuera_de_tabla`,
   `precios_sospechosos` y `expansiones_a_medias`.
4. El service worker sube de versión (v11): las PWA instaladas verán el aviso de
   «hay una versión nueva» una vez.
5. Opcional: `/migrate-mejoras?guardas=1` (ver «Montar la base de datos») y
   `/seed-database?force=true` para rellenar columnas de las expansiones que se
   sembraron comprando un sobre con el código anterior.

### CI y puerta de despliegue

`.github/workflows/ci.yml` se ejecuta en cada push y en cada pull request, con
Node 24 y `npm ci`, sin ningún secreto:

| Trabajo | Qué ejecuta | ¿Bloquea? |
|---|---|---|
| **Typecheck e invariantes** | `npm run typecheck`, `npm test`, `npm run test:idioma` | Sí: es la puerta. |
| ESLint (aviso, no bloquea) | `npm run lint` | No, mientras queden errores heredados. |

En local, `npm run comprobar` ejecuta lo mismo que la puerta.

**El CI por sí solo no impide desplegar:** sólo dice si el commit está sano.
Que Vercel espere a esa respuesta se configura en los paneles, no en el código.
Hay dos formas y se pueden poner las dos:

1. **En GitHub (protege `main`).** *Settings → Rules → Rulesets* (o *Branches →
   Branch protection rules*) → regla para `main` → *Require status checks to
   pass* → añadir **Typecheck e invariantes**, y *Require a pull request before
   merging*. A partir de ahí ningún commit entra en `main` sin haber pasado la
   puerta —tampoco los que se hacen desde el editor web de GitHub—, y como
   producción se despliega desde `main`, a producción sólo llega lo que está en
   verde. Obliga a trabajar con ramas y pull request: ya no vale el push directo
   a `main`.
2. **En Vercel (retiene el despliegue).** *Project → Settings → Deployment
   Checks* → añadir como obligatoria la comprobación de GitHub **Typecheck e
   invariantes**. Vercel sigue construyendo, pero no asigna el dominio de
   producción hasta que la comprobación termina en verde. Permite seguir
   empujando a `main`. (Es el nombre del apartado tal como se conocía al
   escribir esto; si el panel ha cambiado, busca «checks» en los ajustes del
   proyecto.)

El nombre que hay que elegir en las dos listas es el `name` del trabajo en
`ci.yml`, y aparece en ellas después de la primera ejecución del flujo.

Si ninguna de las dos está disponible, hay una puerta de una línea en el
código: cambiar el script `build` de `package.json` a
`node scripts/test-invariantes.mjs && next build`. No está puesta porque no se
ha podido probar en la máquina de construcción de Vercel, y un falso rojo ahí
bloquearía todos los despliegues, también el de un arreglo urgente.

**El lint, y cómo endurecerlo.** `eslint.config.mjs` apaga
`@next/next/no-img-element` (las cartas usan `<img>` a propósito), acepta el
prefijo `_` para lo que no se usa y deja `no-explicit-any` en aviso. Con eso
sólo quedan como ERROR los que avisan de un fallo: al escribir esto, cinco
(tres `react-hooks/set-state-in-effect` y dos `@ts-ignore`). Cuando
`npm run lint` salga con 0 errores, quita `continue-on-error: true` del trabajo
`lint` en `ci.yml` y márcalo también como obligatorio. Después, para que la
deuda de `any` no crezca, el script puede pasar a
`eslint --max-warnings <los avisos que haya ese día>`.

### El aviso de «hay una versión nueva»

La app instalada puede llevar días abierta cuando llega un despliegue, y
entonces sus server actions ya no existen en el servidor. Lo detecta por tres
vías: el service worker nuevo, una server action que el servidor ya no
reconoce, y la comparación del build del cliente con el de `/api/version` al
volver a primer plano. La tercera se apoya en `NEXT_PUBLIC_BUILD_ID`, que
`next.config.ts` rellena en Vercel con el id del despliegue; fuera de Vercel
queda vacía y esa comparación no se hace. No hay que definirla en ningún otro
sitio.

### Las imágenes de la app instalada

Las pantallas de arranque de iOS van por pares, oscura y clara
(`public/splash/splash-<tamaño>.png` y `-claro.png`), y el icono de la pantalla
de inicio es `public/icons/apple-touch-icon-v2.png`, a sangre. Las claras y el
icono salen de las que ya hay:

```bash
npm run pwa:imagenes
```

No pisa lo que ya existe. Para un iPhone con otra resolución: se añade su
arranque oscuro a `public/splash/`, su fila a `STARTUP_IMAGES` en
`app/layout.tsx` y se vuelve a pasar el script.

### Qué probar en el iPhone tras desplegar

La tanda del commit d4d558e se verificó en Chromium como invitado. **Quedó sin
probar en un teléfono de verdad** todo lo de Social con sesión, el QR con la
cámara y lo que sólo ocurre en WebKit. Esta lista es para recorrerla en diez
minutos; hacen falta el iPhone, una segunda cuenta (otro teléfono o un
navegador de escritorio) y haber hecho antes los pasos de arriba.

**1 · En Safari, con sesión (2 min)**

- [ ] Colección y Álbum: al desplazar, las insignias de las cartas (copias,
      favorita, nota, desgaste) pasan **por debajo** de la barra superior, y el
      saldo sigue respondiendo al toque.
- [ ] Tienda y Graduación: el aviso de instalar no tapa los botones de comprar
      ni el de pagar; sólo sale en las raíces de pestaña y nunca con el teclado
      abierto.
- [ ] Vitrina: los mandos del archivador se ven enteros; la ficha de una carta
      no se desborda; las pestañas de Social caben.
- [ ] La pantalla de inicio de sesión de Clerk sale en español.

**2 · Instalada en la pantalla de inicio (3 min)**

- [ ] Compartir → «Añadir a pantalla de inicio»: el icono sale a sangre, sin
      una ficha dentro de otra.
- [ ] Al abrirla, la pantalla de arranque es clara con el teléfono en tema
      claro y oscura en oscuro, y la barra de estado se lee en los dos.
- [ ] Al tirar hacia abajo en lo alto de una página, la barra superior no baja
      con el contenido.
- [ ] Modo avión y abrir la app: a los 4 segundos dice «Sin conexión» en vez de
      quedarse en el esqueleto, y quien tiene cuenta no aparece como invitado.
- [ ] Sin red, una pantalla que no estaba guardada enseña la página de «Sin
      conexión» con salida («Reintentar», «Ir al inicio») y se recarga sola al
      volver la señal.
- [ ] Con la app abierta, haz un despliegue nuevo y vuelve a ella: ofrece
      actualizar en vez de fallar en todo culpando a la conexión.

**3 · Social, con dos cuentas (3 min)**

- [ ] Social → Añadir: aparece tu código (`ABCD-2345`). «Compartir» abre la
      hoja de iOS con el enlace `/invitar/CODIGO`; «Copiar» lo copia.
- [ ] El QR, leído **con la cámara de otro teléfono**, abre la ficha del
      entrenador; hace falta un toque para enviar la petición (abrir el enlace
      no envía nada).
- [ ] El enlace abierto sin sesión recuerda la invitación y la retoma después
      de entrar o de crear la cuenta.
- [ ] En el mismo campo, buscar por nombre y por código (también pegando el
      mensaje entero de «Compartir»).
- [ ] La pestaña Social enseña la insignia de pendientes al recibir una
      petición; aceptar, rechazar, cancelar una enviada y bloquear funcionan.
- [ ] Dos cuentas que se piden amistad la una a la otra acaban como amigas.
- [ ] Proponer un intercambio: las cartas se ven a su tamaño y la rejilla se
      desplaza.
- [ ] Bazar: se puede añadir a un vendedor como amigo desde su anuncio.

**4 · Tienda y calidad de vida (2 min)**

- [ ] Compra un sobre y pon el modo avión nada más tocar: al volver la red se
      reintenta con la misma clave y **se cobra una sola vez**; «Ver sobre»
      enseña el sobre sin volver a cobrar.
- [ ] «Saltar» corta la animación; el resumen dice cuánto falta de la
      expansión.
- [ ] La Colección recuerda filtros y posición al volver de una carta.
- [ ] La recompensa diaria dice cuándo vuelve y cuándo se pierde la racha.
- [ ] Vender una carta graduada pide confirmación, y el Bazar avisa de los 10
      sobres que hacen falta para comprar.

Si algo falla, lo que más ayuda es una captura, el modelo de iPhone y la
versión de iOS.

---

## Tareas automáticas

El plan Hobby de Vercel permite **dos** crons, y `vercel.json` declara los dos
que hay. Un tercero hace **fallar el despliegue**: por eso las fotos de sobre y
los precios no tienen cron propio y van encadenados dentro de `sync-es`.

| Hora (UTC) | Ruta | Qué hace |
|---|---|---|
| 05:00 | `/api/cron/sync-sets` | Expansiones nuevas e incompletas. |
| 07:00 | `/api/cron/sync-es` | Traducciones, y con lo que sobre de sus 45 s: fotos de sobre (hasta 10 s) y precios (lo que quede). |

Las dos, y también `/api/cron/sync-precios`, se pueden disparar a mano con
`Authorization: Bearer $CRON_SECRET`.

### Sets nuevos

`sync-sets` compara el catálogo de api.pokemontcg.io con la base de datos, y
descarga los sets que falten y los incompletos, empezando por los más
recientes. Está pensado para el tope de 60 segundos del plan Hobby: trabaja con
un presupuesto de tiempo y es reanudable, así que un set grande que no quepa en
una ejecución lo termina la siguiente. Se puede forzar un set concreto con
`?setId=me5`.

La aplicación no necesita ningún cambio para mostrarlos: lee los sets de la
base de datos, y las probabilidades de sobre se calculan por **rareza y era**,
no por id de set: una expansión nueva hereda el perfil de tiradas de su serie
sin que nadie tenga que configurar nada (`eraDeSerie` en `utils/packLogic.ts`).

**Una expansión a medio descargar no vende sobres.** Si en `cards` hay menos
del 90 % de las cartas que declara la ficha (`sets.total`), la tienda no la
ofrece, la compra contesta `sobre-no-disponible` (`detalle: "set-incompleto"`)
y tampoco paga el bono de expansión completa. Es para no sortear —ni calibrar
el precio del sobre— contra un catálogo sin sus números altos, que son las
mejores cartas. Se arregla sola cuando el cron termina. El falso positivo
posible es una expansión completa cuya ficha declare un total inflado más de un
10 %: saldría en `expansiones_a_medias` de `/db-stats`, y se corrige poniendo el
`total` bueno en `sets`.

### Traducciones

`sync-es` va dos horas después del de expansiones, que es de donde saca los
nombres ingleses contra los que empareja. Comprueba si TCGdex ya tiene en
español alguna de las expansiones que la app enseña en inglés y guarda su
diccionario en la tabla `set_translations`. **No hace falta desplegar:**
`services/idiomaBD.ts` lo aplica encima de los ficheros de `src/data/es`, que
siguen siendo la base (se regeneran en local con `npm run es:generar`). Si
Postgres falla o la tabla está vacía, el español sigue funcionando con esos
ficheros.

**Cómo saber por qué una expansión sigue en inglés:** mira su `estado` en
`set_translations`. `sin_fuente` o `404` significan que el id de TCGdex se
adivinó mal y hay que ponerlo a mano en `src/data/es/mapa-sets.json`; `guardia`
significa que el emparejamiento no superó las comprobaciones antimapeo y **no
se ha escrito nada**, que es lo correcto: es lo que impide que una expansión
salga traducida con los nombres de otra. Para reintentar una suelta sin esperar
a mañana: `/api/cron/sync-es?setId=me6` (con `?setId=` se encadenan las fotos
de sobre de esa expansión, pero no los precios).

### Precios reales de Cardmarket

`sync-precios` baja a `card_prices` el precio en euros de las cartas caras,
desde TCGdex. Con eso, el precio de venta de una carta deja de depender sólo de
su rareza:

    precio = tarifa + tarifa × (euros / 1000)

Para que un dato roto de Cardmarket no fabrique una carta de miles de monedas,
un precio ya guardado que de una pasada a la siguiente se multiplica por más de
5 (y pasa de 50 €) **no se guarda**: la carta conserva el que tenía y queda en
estado `sospechoso`. Si la subida era de verdad se confirma a mano con
`/api/cron/sync-precios?setId=<expansión>`; `/db-stats` dice cuántos hay.

**Lo que esa cerradura no cubre** es la primera vez que se guarda un precio,
que no tiene con qué compararse. Para ese caso hay un techo PROPUESTO y
**desactivado** (`TECHO_AJUSTE_PRECIO_REAL`, en `utils/constanst.ts`, hoy
`null`): con un 5, ninguna carta valdría más de cinco veces su tarifa. No está
puesto porque cambia la fórmula del precio por encima de 4.000 € —una Special
Illustration Rare con 12.000 € pasaría de 1.950 a 750 monedas— y eso lo decide
el dueño. Activarlo es cambiar ese `null` por un `5` y pasar `npm test` y
`npm run sim:economia`.

**Sólo se piden las cartas que mueven la aguja** (tarifa de 35 monedas o más,
Double Rare para arriba): en el resto el ajuste cambia el precio menos de un
1 %, y pedir el precio de una Common es tirar una petición. Si algún día hay
plan Pro, se le da su hora en `vercel.json` y se quita el encadenado.

---

## Graduación de cartas

Mandas a graduar una copia que aún no tenga nota, pagas, y te devuelven una
nota del 1 al 10 que multiplica lo que vale. La copia se queda en la vitrina con
sus desperfectos a la vista: piques en los cantos, arañazos, manchas,
descentrado y decoloración, todo coherente con la nota.

**La nota no se sortea al pulsar el botón: se revela.** Estaba decidida desde
que la carta entró en la colección, porque sale de una semilla estable
`(secreto, usuario, carta, nº de copia)` y no de `Math.random()`. Sin eso,
graduar sería una tragaperras: quien no quedara contento vendería la carta, la
volvería a conseguir y volvería a tirar.

| nota | 10 | 9 | 8 | 7 | 6 | 5 | 4 | 3 | 2 | 1 |
|---|---|---|---|---|---|---|---|---|---|---|
| probabilidad | 14,25% | 38% | 19% | 23,75% | 1,4% | 1,1% | 1% | 0,75% | 0,5% | 0,25% |
| multiplicador | ×1,95 | ×1,1 | ×0,9 | ×0,7 | ×0,55 | ×0,3 | ×0,25 | ×0,18 | ×0,08 | ×0 |

Las cifras de esta sección son las de `PROBABILIDAD_NOTA`, `MULTIPLICADOR_NOTA`,
`COSTE_BASE` y `COSTE_FRACCION` en `utils/graduacion.ts`. **Si un comentario del
código o una versión vieja de este README dicen otra cosa (×3, ×1,8, ×1,5,
×1,35, «pierde 12,5 de media»), son restos de tablas anteriores: mandan las
constantes y lo que imprime `npm test`.**

**Lo que cuesta:** `max(100, 40 % del valor de la carta)`. Graduando varias de
una vez baja el suelo de 100 (10 % con 5 o más, 20 % con 10, 30 % con 25); el
tramo proporcional no se rebaja nunca.

**Lo que da de media: ×1,048** (lo imprime `npm test`). Graduar es un sumidero,
no una apuesta neutral:

| Valor de la carta | Coste | Resultado esperado por copia |
|---|---|---|
| 100 | 100 | −95 |
| 250 (Hyper Rare, la tarifa más alta) | 100 | −88 |
| 500 (sólo con el ajuste por precio real) | 200 | −176 |

**Por qué el techo es ×1,40 y por qué la tabla se queda tan lejos de él.** Con
coste **fijo** C sobre una carta de valor V, graduar es neutral cuando el
multiplicador medio vale `1 + C/V`: eso pide ×1,67 a 150 monedas y ×1,40 a 250,
y una sola tabla no puede ser neutral a los dos valores. Por eso el coste lleva
un tramo proporcional: con coste = 40 % del valor, la neutralidad deja de
depender de V y el techo es **×1,40** para todo el catálogo. Cualquier cosa que
el jugador pueda elegir graduar y que dé más de ×1,40 de media imprime monedas,
porque se pueden graduar las repetidas sin fin.

Y lo que el jugador puede elegir no es «una copia al azar», porque **el
desgaste se ve antes de pagar, en todas las notas**
(`UMBRAL_DESGASTE_VISIBLE = 10`): al abrir el sobre y en la colección. Así que
gradúa lo que parece bueno, y lo que tiene que quedar por debajo del techo no
es la media de la tabla sino la media de **cada aspecto que se distingue a
ojo**. El aspecto más limpio (sin una marca y bien centrada: el 41 % de las
copias, con todos los dieces dentro) da **×1,34**. Ése es el margen real: unos
6 puntos, no los 35 que sugiere la media. Subir el multiplicador del 10 o del
9, o hacer que el desgaste delate más la nota, se lo come; el invariante
«ningún estado visible de la carta delata una nota que compense graduar» de
`npm test` es el que lo vigila.

Se vende o se guarda, pero **hay que quedarse con una copia**: la promesa de
que el álbum nunca se vacía vale también aquí.

> ⚠️ **`GRADING_SECRET` no es opcional en la práctica.** `notaDeCopia` viaja en
> el paquete del cliente, así que con una semilla pública cualquiera calcularía
> sus notas en la consola y graduaría sólo los dieces. Por eso la semilla lleva
> un secreto de servidor y **el servidor nunca la manda al cliente.** Manda el
> desgaste ya calculado —de cualquier copia, también sin graduar— y la nota
> **sólo** de las copias que ya se han pagado.

## Bazar entre jugadores

Un jugador publica una carta suya a un precio y otro la compra. Es distinto del
Mercado, que es un tablón de encargos contra la máquina: aquí hay una persona al
otro lado.

**Todo el diseño gira alrededor de un problema.** Fuera del bazar las monedas no
se pueden mover entre cuentas por ninguna vía —toda escritura sobre
`users.coins` filtra por el id de la sesión, y el trueque es carta por carta sin
dinero—, y eso es lo que hace inofensivo el grifo de las cuentas nuevas: crear
una es gratis y recibe 1.000 monedas más 165-300 cada 20 horas. Un bazar con
precio libre convertiría ese grifo en dinero para la cuenta principal.

Las cuatro defensas, que van juntas o no van (`utils/bazar.ts`):

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

Además hay un tope de 20 anuncios abiertos por jugador, que es freno de spam y
no de economía.

**Una copia anunciada está comprometida.** Publicar no aparta la carta —el
anuncio es una fila y la cantidad no se mueve—, así que todas las rutas que
gastan copias cuentan los anuncios abiertos: mientras el anuncio siga abierto,
esa copia **no se vende a la tienda, no se entrega en el mercado, no se gradúa
y no se da en un trueque**. Para usarla en otra cosa hay que retirar el
anuncio. La colección la rotula «En el bazar» y el selector de intercambio no
la ofrece.

Un anuncio que se quede sin copia detrás (los hay de antes de esta regla, y
puede nacer alguno si se publica y se vende la misma carta en el mismo
instante) no sale en el escaparate, no cobra a nadie si se intenta comprar por
su id —la compra contesta `motivo: "sin-respaldo"` y lo cierra— y se retira
solo cuando el vendedor abre «mis ventas» o vuelve a publicar esa carta.

## Vitrina

Un archivador de anillas de verdad: hojas de nueve fundas en 3×3 que se pasan
**girando el papel sobre el lomo**, con botones, con las flechas o arrastrando.

**Nace VACÍO y se monta a mano.** Cada funda guarda lo que el jugador ponga en
ella —tabla `binder_slots`, o `localStorage` si juega sin cuenta— y la misma
carta puede ir en varias fundas, pero nunca más veces que copias tenga.

**El giro monta el 3D y lo desmonta.** `perspective` y `preserve-3d` están
prohibidos en este repositorio sobre cualquier ancestro de una carta: WebKit
rasteriza esa capa a escala fija y la ilustración sale borrosa en iPhone. La
salida es la que ya usaba `PokemonCard` para su propio giro —volumen mientras se
mueve, plano en reposo—, así que fuera del pase de página no queda ni una
perspectiva, ni un `preserve-3d`, ni un `will-change`. En el inspector: durante
el giro hay dos hojas y `perspective: 3000px`
(`components/vitrina/LibroArchivador.tsx` explica por qué 3000 y no menos);
520 ms después, una hoja y sin perspectiva.

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

**El índice de pareja.** `idx_friendships_par` (lo crea `/migrate-core`) es lo
que impide dos filas por pareja cuando dos peticiones se cruzan: sin él, entre
la mitad y dos tercios de las peticiones simultáneas dejan la pareja duplicada.
`/migrate-social` dice si está (`indiceDePareja`) y, si falta, cuántas parejas
duplicadas impiden crearlo (`parejasDuplicadas`). Para verlas:

```sql
SELECT LEAST(user_id, friend_id) AS a, GREATEST(user_id, friend_id) AS b,
       array_agg(id ORDER BY id) AS ids, array_agg(status ORDER BY id) AS estados
  FROM friendships
 GROUP BY 1, 2 HAVING count(*) > 1;
```

**Las minúsculas.** La misma respuesta trae `minusculasUnicode`. Si es `false`,
la base se creó con `LC_CTYPE = C` y su `LOWER()` no pasa a minúscula la Ñ ni
las vocales acentuadas: la búsqueda de entrenadores por nombre no encuentra a
«Álvaro» escribiendo «álvaro» (la respuesta trae además `avisoBusqueda`). La
aplicación sólo lo detecta, no lo arregla: el arreglo es comparar con una
colación que entienda Unicode, o buscar por una columna con el nombre ya
normalizado.

`/migrate-social?relleno=1` crea de una vez el código de quien aún no lo tenga
(en tandas; se puede repetir). No hace falta: se crean solos al primer uso.

## Ilustraciones reales de sobre

Al abrir un sobre de una expansión que tenga foto, se ve el sobre de verdad; el
resto usa el sobre compuesto en CSS (`utils/sobreArte.ts`), que además es lo que
viste a toda expansión recién llegada. Hoy tienen foto en el repositorio **131
de las 171 expansiones** (367 imágenes); las que faltan son casi todas promos,
Trainer Gallery, kits y energías, que nunca tuvieron sobre suelto.

Las fotos llegan por dos caminos:

- **En el repositorio:** `public/sobres/<id>/<n>.webp` y el manifiesto
  `src/data/sobres.json`, que la aplicación importa al compilar. Los escriben
  dos scripts, y da igual en qué orden se ejecuten porque el manifiesto se
  reconstruye de lo que hay en disco:

  ```bash
  npm run sobres:bajar                       # SIMULA: dice qué haría y no escribe nada
  npm run sobres:bajar -- --aplicar          # las saca de Bulbapedia y las escribe
  npm run sobres:bajar -- --solo-informe     # no baja ni escribe nada
  npm run sobres:preparar -- --origen "C:/ruta/a/los/PNG"   # las traídas a mano
  ```

  El resultado se commitea y llega con el siguiente despliegue. Los dos usan
  `sharp`, que **no está declarado** en `package.json`: hoy llega como
  dependencia opcional de `next`.
- **En Postgres:** en Vercel `public/` es de sólo lectura, así que lo que trae
  el cron (el tramo de sobres de `sync-es`) se guarda en `set_pack_art` y sale
  por la ruta pública `/api/arte-sobre/<id>/<variante>`, cacheada un año en el
  CDN. Por eso el cron no reescribe lo que ya está publicado. Si una expansión
  se llama distinto en Bulbapedia, se le pone la página a mano en
  `src/data/sobres-bulbapedia.json`; para forzar una ahora:
  `/api/cron/sync-es?setId=<id>`.

Las ilustraciones son de Nintendo / Creatures / GAME FREAK / The Pokémon
Company y se usan sin ánimo de lucro: **no valen para un uso comercial** del
repositorio (`scripts/bajar-sobres-bulbapedia.mjs` lo explica).

---

## Tests

```bash
npm test             # los invariantes de la economía (segundos)
npm run test:idioma  # la capa de español no cambia id, rareza ni expansión
npm run typecheck
npm run comprobar    # las tres cosas seguidas: lo mismo que la puerta del CI
```

`npm test` sale con código distinto de cero si algo se rompe, y su última línea
dice cuántos invariantes se mantienen (166 en el commit d4d558e, 198 con los de
la última revisión). Si algún día imprime una línea `AVISO`, es un hallazgo
abierto que el test mide pero todavía no exige: no cuenta como fallo y hoy no
hay ninguno. Comprueba, sobre las cartas reales de `src/data`:

- **Sobres:** el número de cartas y las probabilidades que anuncia la tienda
  son las que reparte de verdad el generador, en todas las expansiones y en
  cada era; ningún sobre a la venta vale más de lo que cuesta (cálculo cerrado).
- **Repetidas y rarezas:** la curva de precios no premia trocear la venta, no
  sube nunca y no regala ninguna carta; toda rareza de los datos tiene precio y
  rango.
- **Mercado:** el tablón es determinista y **ninguna oferta es imposible de
  cumplir**; el reparto del lote entre requisitos siempre da un lote válido (es
  el bloque más largo de la salida).
- **Graduación: no imprime dinero.** El multiplicador medio no pasa del techo, a
  la fuerza bruta sobre todo el rango de valores y descuentos; la nota es
  determinista y depende del secreto; **ningún aspecto visible de la carta
  delata una nota que compense graduar**.
- **Bazar:** mover monedas siempre cuesta la comisión, a cualquier valor y con
  el precio en el techo de su banda; hay barrera en las dos direcciones.
- **Eras:** ninguna tira una expansión fuera de la tienda ni deja un sobre por
  encima de su precio, y una serie desconocida usa el reparto de siempre.
- **Estado físico y fotos de sobre:** el desgaste que calcula el servidor llega
  a la pantalla, y el emparejamiento de cada expansión con su foto de
  Bulbapedia no confunde un sobre con otro.
- **Servidor:** un escáner lee el SQL del repositorio y comprueba que ninguna
  sentencia cambia el dueño ni la copia de una graduada, ni borra su fila, y que
  el bono de expansión se paga en la misma sentencia en la que se marca.
- **Dinero:** en la compra del bazar todo cuelga del cobro; el descuento de la
  copia no repite el guard que ya decidió la puerta, y las tres sentencias que
  cobran y entregan cuadran lo uno con lo otro o se deshacen enteras; la venta
  de una graduada pide los candados en el mismo orden que la compra; ningún
  parámetro se queda dentro de un comentario SQL.
- **Bazar, copias comprometidas:** toda sentencia que gasta copias cuenta los
  anuncios abiertos, las lecturas que dicen cuántas se pueden dar restan lo
  mismo, y la colección, el detalle y la tienda cuentan las vendibles igual.
- **Anuncio contra realidad:** el botón enseña lo que cobra la venta; las
  fórmulas replicadas en la interfaz son las del servidor.
- **Amigos:** el código que se sortea, se teclea y se guarda es el mismo; el QR
  se lee; el id de Clerk de un desconocido no sale del servidor.
- **iPhone y PWA:** las barras confinan el apilado, las zonas seguras sólo se
  leen en un sitio, y el service worker no guarda ni toca lo que no debe.

Es todo **determinista**: mismas entradas, mismo resultado. Esa es la condición
para que sirva de puerta en CI.

**Lo que NO hace: ejecutar SQL.** El escáner lee el texto de las sentencias, no
las lanza. Las que mueven monedas y cartas se han ejecutado a mano contra
PostgreSQL real en cada tanda, con bancos de prueba que no están en el
repositorio. Un cambio en el `WHERE` de una venta puede pasar `npm test` en
verde: ver «Riesgos conocidos».

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
  en versión exacta. Si señala que un sobre «se ha movido» quedándose por debajo
  de su precio, comprueba el número CERRADO (`valorEsperadoEstandar`) antes de
  tocar nada.
- **`sim:mercado`** es informativo y no falla nunca: imprime el calibrado del
  mercado de lotes.

**Cualquier cambio en `SELL_PRICES`, `PACK_PRICES`, `categorizeCards`, las
tablas de premio o los perfiles de era de `utils/packLogic.ts`,
`MULTIPLICADOR_NOTA`, `COSTE_FRACCION` o `UMBRAL_DESGASTE_VISIBLE` de
`utils/graduacion.ts`, o la banda y la comisión de `utils/bazar.ts`, exige pasar
`npm test` antes de subir**, y conviene pasar también `npm run sim:economia`. El
CI lo ejecuta en cada push, pero sólo bloquea el despliegue si se ha configurado
la puerta (ver «CI y puerta de despliegue»).

---

## Riesgos conocidos y decisiones del dueño

Lo que sigue **no son descuidos**: está visto, medido y decidido. Se escribe
aquí para que nadie lo «arregle» sin saberlo ni lo redescubra como si fuera
nuevo.

**Decisiones tomadas**

- **El bono de expansión completada se puede cobrar con cartas prestadas.**
  `claimSetCompletionBonuses` paga 1.000 monedas, una vez por cuenta y
  expansión, a quien tenga todas las cartas; no mira de dónde han salido. Y el
  trueque mueve cartas entre amigos sin exigir sobres abiertos. Una cuenta
  principal puede prestar una expansión completa a una cuenta alternativa, que
  cobra el bono y devuelve las cartas, y repetirlo con otra cuenta. Para que
  esas monedas vuelvan a la principal tienen que pasar por el bazar, con su
  comisión, su banda y sus 10 sobres abiertos. **El dueño ha decidido dejarlo
  como está.** Si algún día se cierra, el arreglo es marcar la procedencia de
  cada carta (de sobre propio o recibida) y exigir una parte de sobre propio
  para el bono.
- **El álbum de otro entrenador se ve con sólo tener sesión.**
  `getTrainerCollection` pide sesión y un id; no pide ser amigo. Quien tenga el
  enlace `/trainer/<id>` ve la colección, las cantidades y las favoritas. El id
  no se reparte —sólo sale del servidor hacia un amigo ya aceptado—, pero un ex
  amigo lo conserva. **Es decisión del dueño:** los álbumes son para enseñarlos.
- **Un bloqueo cierra el álbum en los dos sentidos.** Ni el bloqueado ve el del
  que bloquea ni al revés, y se contesta con el álbum vacío, igual que a un id
  que no existe: no se le dice por qué. Si la comprobación del bloqueo falla
  (una base sin `friendships`), el álbum se sirve.
- **El rechazo de una petición de amistad es silencioso** y definitivo para
  quien fue rechazado (ver «Amigos»).

**Riesgos abiertos**

- **Dependencias con avisos de seguridad:** `next` 16.1.6 y `@clerk/nextjs`
  6.37.3. Ver [la sección siguiente](#actualizaciones-de-seguridad-pendientes).
- **`npm test` no ejecuta el SQL** que mueve monedas y cartas (ver «Tests»). No
  hay todavía un `npm run test:sql` contra PostgreSQL en el repositorio.
- **Sin `GRADING_SECRET`** las notas salen de un respaldo público y se pueden
  calcular antes de pagar. El registro lo avisa; `/db-stats` dice si llega.
- **Los topes sociales no son exactos** bajo ráfagas simultáneas (ver «Amigos»).
  Están para cortar el goteo masivo; no hay que apoyar nada en la cifra. Lo
  mismo vale para el de 500 cartas deseadas (40 altas a la vez desde 499 dejan
  504). El de 20 anuncios sí se recorta: tras publicar se cierran los más
  nuevos que pasen del tope.
- **Graduar y vender la misma carta en el mismo instante** puede dejar más
  graduadas activas que copias (2 graduadas, 1 copia). Las ventas cuentan las
  graduadas con la instantánea de su sentencia y no ven una graduación que se
  confirma mientras esperan el candado. **No imprime dinero** —la graduada de
  más no se puede vender ni anunciar hasta tener otra copia—, y cerrarlo pide
  llevar el recuento de copias comprometidas en la propia fila de
  `user_collection` (una columna nueva con su relleno): es una migración y está
  pendiente de que el dueño la decida. La misma columna cerraría el anuncio que
  nace sin copia cuando se publica y se vende a la vez.
- **El ajuste por precio real no tiene techo** (ver «Precios reales»): la
  primera vez que entra un precio roto de Cardmarket no hay nada que lo pare.
  El techo está escrito y apagado, a la espera de decisión.
- **El tope de frecuencia es por instancia y en memoria** (`services/limite.ts`):
  corta un bucle contra una instancia, no es un limitador exacto entre varias
  ni cubre las lecturas sin sesión. Uno de verdad pide Redis o el cortafuegos
  de Vercel. Cuando salta, la pantalla dice «demasiadas … seguidas» y no se ha
  movido nada.
- **Quedan interbloqueos que Postgres corta** con carga muy alta (dos sobres
  del mismo jugador que estrenan la misma carta a la vez): una de las dos
  operaciones contesta «inténtalo de nuevo» y ninguna se queda a medias. Los
  que eran de orden —compras cruzadas, venta de una graduada contra su compra,
  vaciado de duplicados contra un sobre— están cerrados.
- **`sharp` no está declarado** y los scripts transpilan TypeScript con una API
  interna de Next (`next/dist/build/swc`), sin garantía entre versiones: si al
  subir Next `npm test` revienta antes del primer invariante, es el cargador y
  no un invariante roto.
- **`middleware.ts` está obsoleto en Next 16**, que pide `proxy.ts` y avisa en
  cada build. La cabecera del fichero explica cómo y cuándo renombrarlo (un
  `git mv` con `npm run build` detrás: Next falla si existen los dos a la vez).
  Los crons y `/api/arte-sobre/` ya no pasan por él.
- **Las fotos de sobre son de terceros** y no admiten uso comercial.

## Actualizaciones de seguridad pendientes

**Pendiente de que el dueño autorice un `npm install`.** No se ha tocado
ninguna versión.

La auditoría de septiembre de 2026 (`npm audit --omit=dev`) daba 11 avisos: 1
moderado, 7 altos y 3 críticos. Los que importan:

- **`next` 16.1.6** (fijado exacto, igual que `eslint-config-next`) acumula
  avisos que tocan las Server Actions, que es por donde pasa todo el dinero del
  juego. El más serio, GHSA-mq59-m269-xvcx: una petición con `Origin: null` se
  salta la comprobación CSRF del framework. Hoy lo que frena ese ataque es la
  cookie `SameSite=Lax` de Clerk, no Next.
- **`@clerk/nextjs` 6.37.3** tiene dos avisos (saltarse la protección de rutas
  del middleware y `has()`) que aquí apenas afectan: no se usa
  `createRouteMatcher`, `auth.protect` ni organizaciones, y cada acción llama a
  `auth()`.
- Transitivas: `js-cookie`, `nanoid`, `ws`, `postcss`, `sharp`.

Cuando se autorice son cinco minutos. Las versiones de abajo son las que daba
la auditoría; **confirma primero cuál es la última parcheada**:

```bash
# 1. Qué hay publicado (la última línea de cada una es la más reciente).
npm view next@16 version
npm view @clerk/nextjs@6 version

# 2. Subir. next y eslint-config-next van SIEMPRE a la misma versión, exacta.
npm install --save-exact next@16.3.5
npm install --save-dev --save-exact eslint-config-next@16.3.5
npm install @clerk/nextjs@^6.39.6

# 3. Las transitivas: sólo lo que cabe en rango. SIN --force.
npm audit fix
npm audit --omit=dev      # no debe quedar ninguno alto ni crítico

# 4. Comprobar antes de subir.
npm run comprobar         # typecheck + invariantes + idioma
npm run lint
npm run build             # con las variables de Clerk puestas
```

Se suben `package.json` y `package-lock.json` juntos: el CI instala con
`npm ci` y falla si no cuadran. Después merece la pena añadir al trabajo de la
puerta en `ci.yml` un paso `npm audit --omit=dev --audit-level=high`; hoy
estaría siempre en rojo.

---

## Ideas que siguen abiertas

- Historial de sobres abiertos (`pack_purchases` ya lo guarda dos días).
- Contador de sequía: cuántos sobres llevas sin un hit de rango alto.
- Exportar e importar la partida de invitado (hoy vive sólo en el navegador, y
  Safari sin instalar la borra a los siete días sin uso; Ajustes lo avisa).
- Un ajuste «Tamaño del texto»: el enchufe está en `app/globals.css`
  (`--escala-texto` y `html[data-texto="grande"]`), sin interruptor todavía.

La lista original de «mejoras para la web» (botones de 44 px, porcentaje de
colección medido contra las cartas que existen, sets por fecha, huecos
numerados en el álbum, insignia «nueva»…) está cerrada entera; el detalle queda
en el historial de git.

---

## Cómo está organizado

| Carpeta | Qué hay |
|---|---|
| `app/` | Rutas, pantallas y las server actions del juego (`action.ts`) y de lo social (`social.ts`). También las rutas de migración, los crons (`app/api/cron`) y `/api/version`. |
| `components/` | Interfaz. `BoosterPack` y `MazoCartas` son la apertura del sobre. |
| `hooks/` | Estado compartido del cliente (saldo, identidad, gestos, bloqueo de scroll). |
| `utils/` | Reglas del juego sin React: `packLogic.ts` (qué cae en un sobre), `constanst.ts` (precios y curva de repetidas), `mercado.ts` (tablón de lotes), `graduacion.ts`, `bazar.ts`. |
| `services/` | Acceso a datos, esquemas de las tablas, ingestas de los crons, capa de idioma y el tope de frecuencia (`limite.ts`). Sólo `pokemon.ts` es `"use server"` (sus funciones exportadas son endpoints); `localData.ts` y `pokemonApi.ts` dejaron de serlo a propósito. |
| `src/data/` | Catálogo de cartas del repositorio (respaldo cuando no hay Postgres), diccionarios en español y manifiesto de fotos de sobre. |
| `public/` | Service worker, página sin conexión, iconos, pantallas de arranque y fotos de sobre. |
| `scripts/` | `npm test` y las dos simulaciones, más los scripts de datos de ejecución manual (ver `scripts` en `package.json`). |
| `.github/` | El flujo de CI. |

**Dónde vive el dinero:** todo movimiento de monedas ocurre en el servidor y en
una sola sentencia SQL. El navegador no manda importes, con una excepción: el
precio de un anuncio del bazar, que el servidor valida contra la banda antes de
crear nada. Si tocas `comprarSobreAction`, `sellCardAction`,
`sellAllDuplicatesBulkAction`, `cumplirOferta`, `graduarCartasAction`,
`venderGraduadaAction`, `publicarEnBazarAction`, `comprarEnBazarAction`,
`claimSetCompletionBonuses` o `acceptTradeOffer`, lee antes los comentarios que
llevan encima: explican qué agujero cerró cada uno.
