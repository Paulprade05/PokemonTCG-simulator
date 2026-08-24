import type { Metadata } from "next";
import { loadLocalSets } from "../../../services/localData";
import { nombreSetEs } from "../../../services/idioma";
import { idiomaActual } from "../../../services/idiomaServidor";

/**
 * page.tsx es "use client" y los componentes de cliente no pueden exportar
 * metadata: este layout mínimo existe sólo para dar título a la ruta.
 * Devuelve los children tal cual, así que no altera el árbol renderizado.
 */

/**
 * El nombre del set sale del catálogo local (src/data/all-sets.json), que ya se
 * cachea en memoria en el servidor y nunca lanza: si falla o el id no está,
 * se queda el título genérico. No se consulta Postgres sólo para la pestaña.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ setId: string }>;
}): Promise<Metadata> {
  const { setId } = await params;

  let name: string | undefined;
  try {
    // El título de la pestaña también sigue al idioma: el nombre español sale
    // del índice estático, sin abrir el diccionario de cartas de la expansión.
    const idioma = await idiomaActual();
    const sets = (await loadLocalSets()) as { id: string; name?: string }[];
    name = nombreSetEs(setId, idioma) ?? sets.find((s) => s.id === setId)?.name;
  } catch {
    name = undefined;
  }

  return {
    title: name ? `${name} · TCG Sim` : "Álbum de expansión · TCG Sim",
    description: name
      ? `Tu progreso en la expansión ${name}`
      : "Tu progreso en esta expansión",
  };
}

export default function SetAlbumLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
