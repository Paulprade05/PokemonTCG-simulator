// services/pokemonApi.ts
//
// SIN USO: a fecha del commit d4d558e no lo importa ningún fichero del
// repositorio (la app dejó de llamar a la API en ejecución en a407851 y lee de
// Postgres). Se conserva porque aquí no se borra nada sin el sí del dueño.
//
// Y SIN 'use server' A PROPÓSITO. Llevaba la directiva, y con ella cada función
// exportada es un endpoint POST público en cuanto un componente de cliente la
// importa. `searchCards(q)` reenvía cualquier consulta a pokemontcg.io con la
// X-Api-Key del servidor: un buscador montado deprisa habría publicado un
// endpoint anónimo que gasta la cuota de la clave con lo que le manden. Sin la
// directiva, esto sólo se puede llamar desde código de servidor.

const BASE = "https://api.pokemontcg.io/v2";

function buildHeaders(): HeadersInit {
  const h: Record<string, string> = { "Accept": "application/json" };
  const key = process.env.POKEMONTCG_API_KEY;
  if (key) h["X-Api-Key"] = key;
  return h;
}

async function apiFetch<T>(path: string, params: Record<string, any> = {}, revalidate = 3600): Promise<T> {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") qs.set(k, String(v));
  });
  const url = `${BASE}${path}${qs.toString() ? `?${qs.toString()}` : ""}`;
  const res = await fetch(url, { headers: buildHeaders(), next: { revalidate } });
  if (!res.ok) {
    throw new Error(`PokemonTCG API ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return res.json() as Promise<T>;
}

export interface ApiCard {
  id: string;
  name: string;
  supertype?: string;
  subtypes?: string[];
  hp?: string;
  types?: string[];
  evolvesFrom?: string;
  evolvesTo?: string[];
  rules?: string[];
  abilities?: { name: string; text: string; type: string }[];
  attacks?: { name: string; cost: string[]; damage: string; text: string; convertedEnergyCost: number }[];
  weaknesses?: { type: string; value: string }[];
  resistances?: { type: string; value: string }[];
  retreatCost?: string[];
  convertedRetreatCost?: number;
  set?: any;
  number?: string;
  artist?: string;
  rarity?: string;
  flavorText?: string;
  nationalPokedexNumbers?: number[];
  legalities?: { standard?: string; expanded?: string; unlimited?: string };
  regulationMark?: string;
  images?: { small?: string; large?: string };
  tcgplayer?: any;
  cardmarket?: any;
}

interface Paginated<T> {
  data: T[];
  page: number;
  pageSize: number;
  count: number;
  totalCount: number;
}

export async function searchCards(q: string, page = 1, pageSize = 24, orderBy = "-set.releaseDate") {
  try {
    const res = await apiFetch<Paginated<ApiCard>>("/cards", { q, page, pageSize, orderBy }, 600);
    return res;
  } catch (e) {
    console.error("searchCards error:", e);
    return { data: [], page, pageSize, count: 0, totalCount: 0 };
  }
}

export async function getCardByIdApi(id: string) {
  try {
    const res = await apiFetch<{ data: ApiCard }>(`/cards/${encodeURIComponent(id)}`, {}, 86400);
    return res.data;
  } catch (e) {
    console.error("getCardByIdApi error:", e);
    return null;
  }
}

export async function getTypesList() {
  try {
    return (await apiFetch<{ data: string[] }>("/types", {}, 86400)).data;
  } catch { return []; }
}

export async function getSubtypesList() {
  try {
    return (await apiFetch<{ data: string[] }>("/subtypes", {}, 86400)).data;
  } catch { return []; }
}

export async function getRaritiesList() {
  try {
    return (await apiFetch<{ data: string[] }>("/rarities", {}, 86400)).data;
  } catch { return []; }
}

export async function getRandomCard(setId?: string) {
  // No native random — pick random page within first 1000.
  const q = setId ? `set.id:${setId}` : "";
  const probe = await searchCards(q, 1, 1);
  if (probe.totalCount === 0) return null;
  const idx = Math.floor(Math.random() * Math.min(probe.totalCount, 5000));
  const page = Math.floor(idx) + 1;
  const res = await searchCards(q, page, 1);
  return res.data[0] || null;
}
