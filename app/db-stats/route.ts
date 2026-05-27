import { sql } from "@vercel/postgres";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const { rows } = await sql`
      SELECT
        (SELECT count(*)::int FROM cards) AS cards_total,
        (SELECT count(*)::int FROM cards WHERE abilities IS NULL OR abilities::text IN ('null','[]','{}')) AS cards_no_abilities,
        (SELECT count(*)::int FROM cards WHERE legalities IS NULL OR legalities::text IN ('null','[]','{}')) AS cards_no_legalities,
        (SELECT count(*)::int FROM cards WHERE cardmarket IS NULL OR cardmarket::text IN ('null','[]','{}')) AS cards_no_cardmarket,
        (SELECT count(*)::int FROM cards WHERE rules IS NULL OR rules::text IN ('null','[]','{}')) AS cards_no_rules,
        (SELECT count(*)::int FROM cards WHERE evolves_from IS NULL AND (evolves_to IS NULL OR evolves_to::text IN ('null','[]','{}'))) AS cards_no_evolution,
        (SELECT count(*)::int FROM cards WHERE attacks IS NULL OR attacks::text IN ('null','[]','{}')) AS cards_no_attacks,
        (SELECT count(*)::int FROM sets) AS sets_total
    `;
    return NextResponse.json(rows[0]);
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
