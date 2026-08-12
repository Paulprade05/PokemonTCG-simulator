Simulador de Pokémon TCG: colección, apertura de sobres e intercambios. PWA
instalable, pensada sobre todo para iPhone.

## Variables de entorno

| Variable | ¿Obligatoria? | Para qué |
|---|---|---|
| `POSTGRES_URL` | Sí | Base de datos (la pone Vercel Postgres). |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Sí | Inicio de sesión. |
| `CRON_SECRET` | Sí para la sincronización | Vercel la envía como `Authorization: Bearer` al ejecutar el cron. Sin ella, `/api/cron/sync-sets` responde 503 y no sincroniza nada. |
| `ADMIN_SECRET` | Sí para administrar | Protege `/ingest-tcg`, `/seed-database`, `/migrate-schema`, `/migrate-social` y `/db-stats`. Sin ella, esas rutas responden 503. |
| `POKEMONTCG_API_KEY` | No, pero recomendable | Sin clave, los límites de api.pokemontcg.io son bajos y los reintentos por 429 se comen el presupuesto de tiempo del cron. |

Genera los secretos con:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Importante:** en Vercel las variables sólo llegan a los despliegues NUEVOS.
Después de crear o cambiar una hay que redesplegar; si no, la aplicación sigue
ejecutándose con el valor anterior.

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

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
------------------------------------------------------------------------------------------------------------------------------------
MEJORAS PARA LA WEB
- Cambiar tamaño de los botones.
- Arreglar el porcentaje de coleccion para los sets
- Ordenar los sets por fecha de salida
- Añadir en la base de datos lo que falta para terminar un set
- que la primera carta salga al reves pero el resto que salgan dadas directamente la vuelta.
- que al terminar de abrir un sobre salga cuantas cartas he añadido a la coleccion
- mientras se abre el sobre encima de la carta salga un recuadro pequeño diciendo new si es nueva, como cuando pone que es holo pero a la izquierda
- hacer que al puinchar a un set en la coleccion salga una cuadricula 3x3 en la que salgan las cartas que tengo de esa coleccion y las que no que salgan vacias pero que no ponga nada dentro solo el numero de la carta que va en ese sitio por ejemplo tengo la carta 40 y 42 pero la 41 sale vacia y pone solo 41


























