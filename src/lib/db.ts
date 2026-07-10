import { Pool } from "pg";
import fs from "node:fs";
import path from "node:path";

const globalAny = global as unknown as {
  __pgPool?: Pool;
  __schemaReady?: Promise<boolean>;
  __hasVector?: boolean;
};

function makePool(): Pool {
  const url =
    process.env.DATABASE_URL || "postgres://rpg:rpg@localhost:5433/rpg";
  return new Pool({ connectionString: url, max: 10 });
}

export function pool(): Pool {
  if (!globalAny.__pgPool) globalAny.__pgPool = makePool();
  return globalAny.__pgPool;
}

/** Aplica o schema uma única vez por processo. Retorna se pgvector está disponível. */
async function applySchema(): Promise<boolean> {
  const p = pool();
  const client = await p.connect();
  try {
    await client.query("SELECT pg_advisory_lock(420042)");
    let hasVector = false;
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      hasVector = true;
    } catch {
      hasVector = false; // sem pgvector: retrieval cai para full-text search
    }
    const sql = fs.readFileSync(
      path.join(process.cwd(), "src/lib/schema.sql"),
      "utf-8"
    );
    await client.query(sql);
    if (hasVector) {
      // colunas de embedding sem dimensão fixa (dimensão vem do provedor configurado)
      await client.query(
        `ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding vector`
      );
      await client.query(
        `ALTER TABLE book_chunks ADD COLUMN IF NOT EXISTS embedding vector`
      );
    }
    globalAny.__hasVector = hasVector;
    return hasVector;
  } finally {
    await client.query("SELECT pg_advisory_unlock(420042)").catch(() => {});
    client.release();
  }
}

export async function db(): Promise<Pool> {
  if (!globalAny.__schemaReady) globalAny.__schemaReady = applySchema();
  await globalAny.__schemaReady;
  return pool();
}

export async function hasVector(): Promise<boolean> {
  await db();
  return !!globalAny.__hasVector;
}

export async function q<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const p = await db();
  const res = await p.query(text, params as never[]);
  return res.rows as T[];
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const rows = await q<{ value: T }>(
    "SELECT value FROM settings WHERE key = $1",
    [key]
  );
  return rows.length ? rows[0].value : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]
  );
}
