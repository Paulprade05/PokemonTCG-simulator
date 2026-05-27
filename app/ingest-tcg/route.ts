import { sql } from "@vercel/postgres";
import { NextResponse } from "next/server";

const API = "https://api.pokemontcg.io/v2";
const PAGE_SIZE = 250;

function headers(): HeadersInit {
  const h: Record<string, string> = { Accept: "application/json" };
  if (process.env.POKEMONTCG_API_KEY) h["X-Api-Key"] = process.env.POKEMONTCG_API_KEY;
  return h;
}

async function fetchJson(url: string, retries = 6): Promise<any> {
  for (let i = 0; i < retries; i++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: headers(), cache: "no-store" });
    } catch (e) {
      const wait = 2000 * (i + 1);
      console.warn(`network err, retry in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (res.ok) return res.json();
    if ([429, 500, 502, 503, 504].includes(res.status)) {
      const wait = Math.min(60000, 3000 * Math.pow(2, i));
      console.warn(`${res.status}, retry in ${wait}ms (${i + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`fetch ${url} -> ${res.status}: ${await res.text()}`);
  }
  throw new Error(`exhausted retries: ${url}`);
}

async function upsertSet(s: any) {
  await sql`
    INSERT INTO sets (id, name, series, printed_total, total, legalities, ptcgo_code, release_date, images)
    VALUES (${s.id}, ${s.name}, ${s.series}, ${s.printedTotal}, ${s.total},
            ${JSON.stringify(s.legalities || {})}, ${s.ptcgoCode || null},
            ${s.releaseDate || null}, ${JSON.stringify(s.images || {})})
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      series = EXCLUDED.series,
      printed_total = EXCLUDED.printed_total,
      total = EXCLUDED.total,
      legalities = EXCLUDED.legalities,
      ptcgo_code = EXCLUDED.ptcgo_code,
      release_date = EXCLUDED.release_date,
      images = EXCLUDED.images,
      updated_at = NOW()
  `;
}

async function upsertCard(c: any) {
  const j = (v: any) => JSON.stringify(v ?? null);
  await sql`
    INSERT INTO cards (
      id, name, supertype, subtypes, level, hp, types,
      evolves_from, evolves_to, rules, ancient_trait,
      abilities, attacks, weaknesses, resistances,
      retreat_cost, converted_retreat_cost,
      set_id, number, artist, rarity, flavor_text,
      national_pokedex_numbers, legalities, regulation_mark,
      images, tcgplayer, cardmarket
    )
    VALUES (
      ${c.id}, ${c.name}, ${c.supertype || null}, ${j(c.subtypes)}, ${c.level || null},
      ${c.hp || null}, ${j(c.types)},
      ${c.evolvesFrom || null}, ${j(c.evolvesTo)}, ${j(c.rules)}, ${j(c.ancientTrait)},
      ${j(c.abilities)}, ${j(c.attacks)}, ${j(c.weaknesses)}, ${j(c.resistances)},
      ${j(c.retreatCost)}, ${c.convertedRetreatCost ?? null},
      ${c.set?.id || null}, ${c.number || null}, ${c.artist || null},
      ${c.rarity || 'Common'}, ${c.flavorText || null},
      ${j(c.nationalPokedexNumbers)}, ${j(c.legalities)}, ${c.regulationMark || null},
      ${j(c.images)}, ${j(c.tcgplayer)}, ${j(c.cardmarket)}
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      supertype = EXCLUDED.supertype,
      subtypes = EXCLUDED.subtypes,
      level = EXCLUDED.level,
      hp = EXCLUDED.hp,
      types = EXCLUDED.types,
      evolves_from = EXCLUDED.evolves_from,
      evolves_to = EXCLUDED.evolves_to,
      rules = EXCLUDED.rules,
      ancient_trait = EXCLUDED.ancient_trait,
      abilities = EXCLUDED.abilities,
      attacks = EXCLUDED.attacks,
      weaknesses = EXCLUDED.weaknesses,
      resistances = EXCLUDED.resistances,
      retreat_cost = EXCLUDED.retreat_cost,
      converted_retreat_cost = EXCLUDED.converted_retreat_cost,
      set_id = EXCLUDED.set_id,
      number = EXCLUDED.number,
      artist = EXCLUDED.artist,
      rarity = EXCLUDED.rarity,
      flavor_text = EXCLUDED.flavor_text,
      national_pokedex_numbers = EXCLUDED.national_pokedex_numbers,
      legalities = EXCLUDED.legalities,
      regulation_mark = EXCLUDED.regulation_mark,
      images = EXCLUDED.images,
      tcgplayer = EXCLUDED.tcgplayer,
      cardmarket = EXCLUDED.cardmarket,
      updated_at = NOW()
  `;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const onlySetId = searchParams.get("setId"); // ingest one set only
    const skipCards = searchParams.get("setsOnly") === "true";
    const onlyMissing = searchParams.get("onlyMissing") === "true";

    // 1. SETS
    const setsRes = await fetchJson(`${API}/sets?pageSize=250`);
    const allSets: any[] = setsRes.data || [];
    console.log(`Sets API: ${allSets.length}`);
    for (const s of allSets) {
      if (onlySetId && s.id !== onlySetId) continue;
      await upsertSet(s);
    }

    if (skipCards) {
      return NextResponse.json({ setsProcessed: allSets.length, cardsProcessed: 0 });
    }

    // 2. CARDS per set
    let totalCards = 0;
    const targets = onlySetId ? allSets.filter((s) => s.id === onlySetId) : allSets;

    for (const s of targets) {
      if (onlyMissing) {
        const { rows } = await sql`SELECT count(*)::int AS c FROM cards WHERE set_id = ${s.id}`;
        const have = rows[0].c;
        if (have >= s.total) {
          console.log(`Skip ${s.id} (${have}/${s.total})`);
          continue;
        }
      }
      let page = 1;
      let fetched = 0;
      console.log(`Ingest set ${s.id} (${s.total} cards expected)`);
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const url = `${API}/cards?q=set.id:${encodeURIComponent(s.id)}&page=${page}&pageSize=${PAGE_SIZE}&orderBy=number`;
        const data = await fetchJson(url);
        const cards: any[] = data.data || [];
        if (cards.length === 0) break;
        for (const c of cards) {
          await upsertCard(c);
          fetched++;
        }
        if (cards.length < PAGE_SIZE) break;
        page++;
      }
      console.log(`  -> ${s.id} done: ${fetched}`);
      totalCards += fetched;
    }

    return NextResponse.json({
      setsProcessed: targets.length,
      cardsProcessed: totalCards,
    });
  } catch (e: any) {
    console.error("ingest-tcg error:", e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

export const maxDuration = 300; // Vercel Pro max; Hobby caps at 60. Use ?setId= to chunk.
export const dynamic = "force-dynamic";
