import { sql } from "@vercel/postgres";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    // CARDS — add missing rich columns (NULL-safe, JSONB).
    const cardAlters = [
      `ALTER TABLE cards ADD COLUMN IF NOT EXISTS supertype TEXT`,
      `ALTER TABLE cards ADD COLUMN IF NOT EXISTS subtypes JSONB`,
      `ALTER TABLE cards ADD COLUMN IF NOT EXISTS level TEXT`,
      `ALTER TABLE cards ADD COLUMN IF NOT EXISTS resistances JSONB`,
      `ALTER TABLE cards ADD COLUMN IF NOT EXISTS abilities JSONB`,
      `ALTER TABLE cards ADD COLUMN IF NOT EXISTS rules JSONB`,
      `ALTER TABLE cards ADD COLUMN IF NOT EXISTS ancient_trait JSONB`,
      `ALTER TABLE cards ADD COLUMN IF NOT EXISTS legalities JSONB`,
      `ALTER TABLE cards ADD COLUMN IF NOT EXISTS regulation_mark TEXT`,
      `ALTER TABLE cards ADD COLUMN IF NOT EXISTS national_pokedex_numbers JSONB`,
      `ALTER TABLE cards ADD COLUMN IF NOT EXISTS evolves_from TEXT`,
      `ALTER TABLE cards ADD COLUMN IF NOT EXISTS evolves_to JSONB`,
      `ALTER TABLE cards ADD COLUMN IF NOT EXISTS cardmarket JSONB`,
      `ALTER TABLE cards ADD COLUMN IF NOT EXISTS converted_retreat_cost INTEGER`,
      `ALTER TABLE cards ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`,
    ];

    const setAlters = [
      `ALTER TABLE sets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`,
    ];

    const idx = [
      `CREATE INDEX IF NOT EXISTS idx_cards_set_id ON cards (set_id)`,
      `CREATE INDEX IF NOT EXISTS idx_cards_rarity ON cards (rarity)`,
      `CREATE INDEX IF NOT EXISTS idx_cards_supertype ON cards (supertype)`,
      `CREATE INDEX IF NOT EXISTS idx_cards_name_lower ON cards (LOWER(name))`,
    ];

    for (const stmt of [...cardAlters, ...setAlters, ...idx]) {
      // @ts-ignore - dynamic SQL via tagged template requires unsafe; use sql.query
      await sql.query(stmt);
    }

    return NextResponse.json({ ok: true, applied: cardAlters.length + setAlters.length + idx.length });
  } catch (e) {
    console.error("migrate-schema error:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
