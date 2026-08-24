"use server";

import { promises as fs } from "fs";
import path from "path";

/**
 * Respaldo local leído de `src/data`. Se usa cuando Postgres no está
 * configurado o la tabla todavía está vacía, para que la app siga siendo
 * navegable en lugar de mostrar pantallas en blanco.
 *
 * Todo ocurre en el servidor y queda cacheado en memoria, así que estos JSON
 * nunca llegan al bundle del cliente.
 *
 * IDIOMA — POR QUÉ AQUÍ NO SE TRADUCE NADA: este módulo es la FUENTE CRUDA, y
 * de ella beben dos clases de consumidor. Los que pintan (getCardsFromSet,
 * getSetsFromDB) aplican la capa española en su propio `return`; los que
 * DECIDEN no pueden verla:
 *   - `fichaDelSet` en app/action.ts mira si el nombre contiene "promos" o
 *     "gallery" para saber qué sobres se pueden vender en esa expansión. Con el
 *     nombre en español ("Promos Escarlata y Púrpura" no contiene "promos" en
 *     minúsculas... y "Galería de Entrenadores" tampoco contiene "gallery") esa
 *     comprobación dejaría de disparar y la tienda vendería sobres estándar en
 *     subsets que sólo tienen cartas caras.
 *   - el respaldo del mercado (`getCartasMercado` para invitados) empareja por
 *     nombre inglés: `evolvesFrom` -> `name` y la inicial del nombre. En
 *     español el cliente y el servidor dejarían de estar de acuerdo sobre qué
 *     cartas valen para una oferta, y el cobro fallaría después de decir que sí.
 * Traducir aquí sería tocar la economía; traducir en la frontera es aspecto.
 */

const DATA_DIR = path.join(process.cwd(), "src", "data");

interface RawSet {
  id: string;
  name: string;
  series?: string;
  images?: { logo?: string; symbol?: string };
  printedTotal?: number;
  total?: number;
  releaseDate?: string;
}

interface RawCard {
  id: string;
  name: string;
  rarity?: string;
  images?: { small?: string; large?: string };
  tcgplayer?: unknown;
  number?: string | number;
  artist?: string;
  flavorText?: string;
  supertype?: string;
  hp?: string | number;
  types?: unknown[];
  attacks?: unknown[];
  weaknesses?: unknown[];
  retreatCost?: unknown[];
  // Los usa el mercado (filtros de etapa, línea evolutiva y región). Están en
  // los JSON desde siempre; sólo faltaba servirlos.
  subtypes?: unknown[];
  evolvesFrom?: string;
  nationalPokedexNumbers?: number[];
}

let setsCache: unknown[] | null = null;
const cardsCache = new Map<string, unknown[]>();
let availableSetIds: Set<string> | null = null;

async function listSetFiles(): Promise<Set<string>> {
  if (availableSetIds) return availableSetIds;
  try {
    const files = await fs.readdir(DATA_DIR);
    availableSetIds = new Set(
      files
        .filter((f) => f.endsWith(".json") && f !== "all-sets.json")
        .map((f) => f.replace(/\.json$/, "")),
    );
  } catch {
    availableSetIds = new Set();
  }
  return availableSetIds;
}

export async function loadLocalSets() {
  if (setsCache) return setsCache;

  try {
    const raw = await fs.readFile(path.join(DATA_DIR, "all-sets.json"), "utf8");
    const all = JSON.parse(raw) as RawSet[];
    const withCards = await listSetFiles();

    setsCache = all
      // Sin fichero de cartas la expansión no se puede abrir: no la ofrecemos.
      .filter((s) => withCards.has(s.id))
      .map((s) => ({
        id: s.id,
        name: s.name,
        series: s.series,
        images: s.images,
        printed_total: s.printedTotal,
        total: s.total,
        release_date: s.releaseDate,
      }))
      .sort((a, b) =>
        String(b.release_date ?? "").localeCompare(String(a.release_date ?? "")),
      );
  } catch {
    setsCache = [];
  }

  return setsCache;
}

export async function loadLocalCards(setId: string) {
  const cached = cardsCache.get(setId);
  if (cached) return cached;

  // El id llega de la URL: nos aseguramos de que no escape del directorio.
  if (!/^[a-z0-9._-]+$/i.test(setId)) return [];

  try {
    const raw = await fs.readFile(path.join(DATA_DIR, `${setId}.json`), "utf8");
    const parsed = JSON.parse(raw);
    const list: RawCard[] = Array.isArray(parsed) ? parsed : parsed.data || [];

    const cards = list
      .map((card) => ({
        id: card.id,
        name: card.name,
        rarity: card.rarity || "Common",
        set: { id: setId },
        images: card.images,
        tcgplayer: card.tcgplayer ?? null,
        number: String(card.number ?? ""),
        artist: card.artist || "Desconocido",
        flavorText: card.flavorText || "",
        hp: card.hp ?? null,
        types: card.types ?? [],
        attacks: card.attacks ?? [],
        weaknesses: card.weaknesses ?? [],
        retreatCost: card.retreatCost ?? [],
        supertype: card.supertype,
        // Mismo trío que sirve la BD (services/pokemon.ts): sin ellos el
        // respaldo local dejaría el mercado ciego a etapa, evolución y región.
        subtypes: card.subtypes ?? [],
        evolvesFrom: card.evolvesFrom,
        nationalPokedexNumbers: card.nationalPokedexNumbers ?? [],
      }))
      .sort((a, b) => {
        const na = Number(a.number);
        const nb = Number(b.number);
        const aNum = Number.isFinite(na);
        const bNum = Number.isFinite(nb);
        if (aNum && bNum) return na - nb;
        if (aNum) return -1;
        if (bNum) return 1;
        return a.number.localeCompare(b.number);
      });

    cardsCache.set(setId, cards);
    return cards;
  } catch {
    return [];
  }
}
