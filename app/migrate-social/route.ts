import { sql } from "@vercel/postgres";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const stmts = [
      // Multi-card trade offers
      `CREATE TABLE IF NOT EXISTS trade_offers (
        id SERIAL PRIMARY KEY,
        sender_id TEXT NOT NULL,
        receiver_id TEXT NOT NULL,
        offered_ids JSONB NOT NULL DEFAULT '[]',
        requested_ids JSONB NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        message TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        seen_by_sender BOOLEAN DEFAULT FALSE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_trade_offers_receiver ON trade_offers (receiver_id, status)`,
      `CREATE INDEX IF NOT EXISTS idx_trade_offers_sender ON trade_offers (sender_id, status)`,
      // users niceties
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username))`,
    ];
    for (const s of stmts) {
      // @ts-ignore dynamic ddl
      await sql.query(s);
    }
    return NextResponse.json({ ok: true, applied: stmts.length });
  } catch (e: any) {
    console.error("migrate-social error:", e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
